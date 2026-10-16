#!/usr/bin/env python3
"""Run the installed Firefox against isolated, instrumented extension copies.

Only test copies expose closed-over functions; production extension files and
permissions are unchanged. Firefox uses a new disposable profile for each build.
"""
import argparse
import base64
import io
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
ADDON_ID = 'page-image-downloader@local.invalid'
HOOK = '''
  const bench = { state, renderImages, scanPage, stopLiveCapture, startLiveCapture,
    applyDimensionResult, refreshDownloadStatuses, filteredImages,
    selectedDownloadableImages, renderedDownloadItems, resetMediaFilters,
    markFilenamePreviewsDirty, saveCurrentGallery,
    get generation() { return renderGeneration; }, renders: [], errors: [], openingStages: [] };
  const profileOpening = (name, original) => function(...args) {
    const started = performance.now();
    const record = () => bench.openingStages.push({name, startMs:started, durationMs:performance.now()-started});
    let result;
    try { result = original.apply(this, args); } catch(error) { record(); throw error; }
    if(result && typeof result.then === 'function') return result.then(value=>{record();return value;},error=>{record();throw error;});
    record(); return result;
  };
  initialize = profileOpening('initialize', initialize);
  scanPage = profileOpening('scanPage', scanPage);
  restoreSiteGallery = profileOpening('restoreSiteGallery', restoreSiteGallery);
  mergeScanResults = profileOpening('mergeScanResults', mergeScanResults);
  loadIgnoredKeys = profileOpening('loadIgnoredKeys', loadIgnoredKeys);
  updateFilenameTemplateUi = profileOpening('updateFilenameTemplateUi', updateFilenameTemplateUi);
  rebuildFilenamePreviews = profileOpening('rebuildFilenamePreviews', rebuildFilenamePreviews);
  renderedDownloadItems = profileOpening('renderedDownloadItems', renderedDownloadItems);
  refreshDownloadStatuses = profileOpening('refreshDownloadStatuses', refreshDownloadStatuses);
  saveCurrentGallery = profileOpening('saveCurrentGallery', saveCurrentGallery);
  startLiveCapture = profileOpening('startLiveCapture', startLiveCapture);
  const originalRender = renderImages;
  renderImages = function(...args) {
    const start = performance.now();
    try { return originalRender(...args); }
    finally {
      const duration=performance.now()-start;
      bench.renders.push(duration);
      bench.openingStages.push({name:'renderImages',startMs:start,durationMs:duration});
      if(!state.busy && state.images.length===5000 && !bench.firstReadyAt) {
        bench.firstReadyAt=performance.now();
        requestAnimationFrame(()=>requestAnimationFrame(()=>{bench.firstPaintAt=performance.now();}));
      }
    }
  };
  window.addEventListener('error', event => bench.errors.push(String(event.message)));
  window.addEventListener('unhandledrejection', event => bench.errors.push(String(event.reason)));
  globalThis.__anydownloadBench = bench;
'''


class Firefox:
    def __init__(self, binary, directory, port):
        self.directory = directory
        self.profile = directory / 'profile'
        self.profile.mkdir(parents=True)
        self.downloads = directory / 'downloads'
        self.downloads.mkdir()
        prefs = {
            'marionette.port': port,
            'browser.shell.checkDefaultBrowser': False,
            'browser.startup.homepage': 'about:blank',
            'browser.startup.firstrunSkipsHomepage': True,
            'browser.aboutwelcome.enabled': False,
            'datareporting.policy.dataSubmissionEnabled': False,
            'toolkit.telemetry.reportingpolicy.firstRun': False,
            'browser.download.folderList': 2,
            'browser.download.dir': str(self.downloads),
            'browser.download.useDownloadDir': True,
            'browser.download.always_ask_before_handling_new_types': False,
            'browser.tabs.warnOnClose': False,
            'browser.tabs.warnOnCloseOtherTabs': False,
        }
        (self.profile / 'user.js').write_text('\n'.join(
            'user_pref(%s, %s);' % (json.dumps(key), json.dumps(value)) for key, value in prefs.items()))
        self.log = open(directory / 'firefox.log', 'w')
        self.process = subprocess.Popen([
            binary, '--no-remote', '--profile', str(self.profile), '--marionette',
            '--width', '1280', '--height', '900', 'about:blank'
        ], stdout=self.log, stderr=self.log,
            env={**os.environ, 'MOZ_REMOTE_ALLOW_SYSTEM_ACCESS': '1'})
        self.socket = None
        for _ in range(150):
            try:
                self.socket = socket.create_connection(('127.0.0.1', port), timeout=2)
                break
            except OSError:
                if self.process.poll() is not None:
                    raise RuntimeError((directory / 'firefox.log').read_text())
                time.sleep(.2)
        if not self.socket:
            raise RuntimeError('Firefox automation port did not open')
        self.socket.settimeout(180)
        self.read()
        self.sequence = 0
        self.capabilities = self.command('WebDriver:NewSession', {'acceptInsecureCerts': True})['capabilities']
        if Path(self.capabilities['moz:profile']).resolve() != self.profile.resolve():
            self.socket.close()
            self.process.terminate()
            self.process.wait(timeout=10)
            self.log.close()
            raise RuntimeError('Automation connected to a different Firefox profile; refusing to continue')
        self.command('WebDriver:SetTimeouts', {'script': 120000, 'pageLoad': 120000})

    def read(self):
        length = b''
        while not length.endswith(b':'):
            chunk = self.socket.recv(1)
            if not chunk:
                raise RuntimeError('Firefox closed its automation connection')
            length += chunk
        length = int(length[:-1])
        data = b''
        while len(data) < length:
            chunk = self.socket.recv(length - len(data))
            if not chunk:
                raise RuntimeError('Firefox closed a partial response')
            data += chunk
        return json.loads(data)

    def command(self, method, params=None):
        self.sequence += 1
        body = json.dumps([0, self.sequence, method, params or {}]).encode()
        self.socket.sendall(str(len(body)).encode() + b':' + body)
        response = self.read()
        if response[2]:
            raise RuntimeError(f'{method}: {response[2]}')
        result = response[3]
        return result.get('value') if isinstance(result, dict) and set(result) == {'value'} else result

    def context(self, value):
        return self.command('Marionette:SetContext', {'value': value})

    def execute(self, script, *args):
        return self.command('WebDriver:ExecuteScript', {
            'script': script, 'args': list(args), 'newSandbox': False, 'sandbox': None})

    def async_execute(self, script, *args):
        wrapped = 'const done = arguments[arguments.length-1]; (async()=>{' + script + \
            '})().then(value=>done({ok:true,value}),error=>done({ok:false,error:String(error),stack:error.stack}));'
        result = self.command('WebDriver:ExecuteAsyncScript', {
            'script': wrapped, 'args': list(args), 'newSandbox': False, 'sandbox': None})
        if not result['ok']:
            raise RuntimeError(result)
        return result.get('value')

    def navigate(self, url):
        self.context('content')
        self.command('WebDriver:Navigate', {'url': url})

    def wait(self, script, timeout=90):
        start = time.monotonic()
        while time.monotonic() - start < timeout:
            result = self.execute(script)
            if result:
                return result
            time.sleep(.05)
        raise RuntimeError('Timeout waiting for: ' + script + '\n' + str(self.execute(
            'return {url:location.href,text:document.body.innerText.slice(0,2000)};')))

    def close(self):
        try:
            self.command('Marionette:Quit', {'flags': ['eForceQuit']})
        except Exception:
            pass
        if self.socket:
            self.socket.close()
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            self.process.wait(timeout=10)
        self.log.close()


def instrument(path):
    file = path / 'popup/popup.js'
    source = file.read_text()
    entry = '  document.addEventListener("DOMContentLoaded", () => {'
    assert source.count(entry) == 1
    source = source.replace(entry, HOOK + '\n' + entry)
    initialize = 'initialize().catch(handleInitializationError);'
    assert source.count(initialize) == 1
    source = source.replace(initialize,
        'initialize().then(() => { bench.stopLiveCapture(); bench.initialized = performance.now(); })'
        '.catch(error => { bench.errors.push(String(error)); handleInitializationError(error); });')
    file.write_text(source)


def prepare_copies(directory, baseline_ref, baseline_dir=None):
    baseline = directory / 'baseline'
    baseline.mkdir()
    if baseline_dir:
        shutil.copytree(baseline_dir, baseline / 'extension')
    else:
        archive = subprocess.check_output(['git', 'archive', '--format=zip', baseline_ref, 'extension'], cwd=ROOT)
        with zipfile.ZipFile(io.BytesIO(archive)) as zipped:
            zipped.extractall(baseline)
    current = directory / 'optimized' / 'extension'
    shutil.copytree(ROOT / 'extension', current)
    paths = {'baseline': baseline / 'extension', 'optimized': current}
    for extension in paths.values():
        instrument(extension)
    return paths


def extension_hash(directory):
    digest = hashlib.sha256()
    for path in sorted(Path(directory).rglob('*')):
        if path.is_file():
            digest.update(str(path.relative_to(directory)).encode())
            digest.update(b'\0')
            digest.update(path.read_bytes())
            digest.update(b'\0')
    return digest.hexdigest()


def run_variant(name, extension, firefox, directory, origin, port, opening_only=False, opening_samples=1):
    print(f'{name}: launch Firefox', flush=True)
    driver = Firefox(firefox, directory, port)
    try:
        driver.context('chrome')
        driver.command('Addon:Install', {'path': str(extension), 'temporary': True, 'allowPrivateBrowsing': True})
        uuid = driver.execute('return JSON.parse(Services.prefs.getStringPref("extensions.webextensions.uuids"))[arguments[0]];', ADDON_ID)
        driver.async_execute('''
          const {ExtensionPermissions} = ChromeUtils.importESModule('resource://gre/modules/ExtensionPermissions.sys.mjs');
          const extension = WebExtensionPolicy.getByID(arguments[0]).extension;
          await ExtensionPermissions.add(arguments[0], {permissions: [], origins: ['http://127.0.0.1/*']}, extension);
          return {origins: extension.allowedOrigins.patterns};
        ''', ADDON_ID, origin)
        driver.navigate(f'moz-extension://{uuid}/history/history.html')
        manager_handle = driver.command('WebDriver:GetWindowHandle')
        source = driver.async_execute('return await browser.tabs.create({url:arguments[0],active:false});', origin + '/gallery-5000')
        driver.async_execute('''
          for (let tries=0; tries<200; tries++) {
            if ((await browser.tabs.get(arguments[0])).status === 'complete') return true;
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          throw new Error('Source gallery did not finish loading');
        ''', source['id'])
        source_handle = next(handle for handle in driver.command('WebDriver:GetWindowHandles') if handle != manager_handle)
        driver.command('WebDriver:SwitchToWindow', {'handle': source_handle})
        collector_results = {}
        collector_source = (extension / 'shared/collector.js').read_text()
        collector_benchmark = (ROOT / 'scripts/firefox-collector-benchmark.js').read_text()
        for case in ([] if opening_only else ['gallery-1200', 'gallery-5000', 'long-dom']):
            driver.navigate(origin + '/' + case)
            driver.wait('return window.fixture && window.fixture.ready;')
            driver.async_execute('''
              await document.fonts.ready;
              await Promise.all([...document.querySelectorAll('video')].map(video => video.readyState >= 1 ? null : new Promise(resolve => {
                video.addEventListener('loadedmetadata', resolve, {once:true}); setTimeout(resolve, 3000);
              })));
              await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
              return true;
            ''')
            for backgrounds in [False, True]:
                key = case + ('-backgrounds' if backgrounds else '-media')
                measured = driver.execute(collector_source + '\n' + collector_benchmark +
                    '\nreturn runFirefoxCollectorBenchmark(arguments[0]);', {'includeBackgrounds': backgrounds})
                records = measured.pop('records')
                measured['recordsSha256'] = hashlib.sha256(json.dumps(records, sort_keys=True).encode()).hexdigest()
                measured['discoveryOrderSha256'] = hashlib.sha256(json.dumps(measured.pop('discoveryOrder')).encode()).hexdigest()
                collector_results[key] = measured
                print(name, key, measured.get('medianMs'), 'ms', flush=True)
            if case == 'long-dom':
                collector_results['edgeChecks'] = driver.execute(collector_source + '\n' + collector_benchmark +
                    '\nreturn runFirefoxCollectorEdgeChecks();')
        driver.navigate(origin + '/gallery-5000')
        driver.wait('return window.fixture && window.fixture.ready;')
        driver.command('WebDriver:SwitchToWindow', {'handle': manager_handle})
        driver.context('chrome')
        driver.execute('''
          const extension = WebExtensionPolicy.getByID(arguments[0]).extension;
          const tab = extension.tabManager.get(arguments[1]);
          extension.tabManager.addActiveTabPermission(tab.nativeTab);
          return true;
        ''', ADDON_ID, source['id'])
        manager_url = f'moz-extension://{uuid}/popup/popup.html?sourceTabId={source["id"]}'
        openings = []
        for sample in range(opening_samples):
            for mode in (['fresh', 'saved'] if opening_samples > 1 else ['fresh']):
                driver.navigate(f'moz-extension://{uuid}/history/history.html')
                if mode == 'fresh':
                    driver.async_execute("await browser.storage.local.remove('siteGalleries:v1'); return true;")
                driver.navigate(manager_url)
                ready = driver.wait('return window.__anydownloadBench && window.__anydownloadBench.initialized && window.__anydownloadBench.firstPaintAt && {count:window.__anydownloadBench.state.images.length,selected:window.__anydownloadBench.state.selected.size,ms:window.__anydownloadBench.initialized,firstReadyMs:window.__anydownloadBench.firstReadyAt,firstPaintMs:window.__anydownloadBench.firstPaintAt,stages:window.__anydownloadBench.openingStages,errors:window.__anydownloadBench.errors,notice:document.getElementById("notice").textContent};')
                assert ready['count'] == 5000 and ready['selected'] == 5000 and not ready['errors'], ready
                openings.append({'mode':mode,'sample':sample,**ready})
                print(name, mode, sample, 'ready',ready['ms'],'paint',ready['firstPaintMs'],'ms',flush=True)
                (directory / 'openings.json').write_text(json.dumps(openings, indent=2))
        print(name, 'manager ready', {key:ready[key] for key in ['count','selected','ms','firstPaintMs','errors']}, flush=True)
        assert ready['count'] == 5000, ready
        assert not ready['errors'], ready
        result = {'firefox': driver.capabilities, 'initialReady': ready, 'openings':openings, 'collector': collector_results}
        (directory / 'result.json').write_text(json.dumps(result, indent=2))
        if opening_only:
            return result
        manager_benchmark = (ROOT / 'scripts/firefox-manager-benchmark.js').read_text()
        result['manager'] = driver.async_execute(manager_benchmark + '\nreturn await runFirefoxManagerBenchmark();')
        (directory / 'result.json').write_text(json.dumps(result, indent=2))
        assert not result['manager']['errors'], result['manager']['errors']
        print(name, 'manager benchmarks completed', flush=True)
        result['download'] = driver.async_execute('''
          const bench = window.__anydownloadBench;
          bench.resetMediaFilters(); bench.state.galleryPage = 0; bench.renderImages();
          document.getElementById('select-none-button').click();
          document.getElementById('filename-template-input').value = '{index}-{filename}';
          document.getElementById('folder-input').value = 'AnyDownload/firefox-benchmark';
          document.getElementById('folder-input').dispatchEvent(new Event('input', {bubbles:true}));
          document.getElementById('ask-single-input').checked = false;
          document.querySelector('.image-row input[type=checkbox]').click();
          const url = bench.selectedDownloadableImages()[0].url;
          const start = performance.now(); document.getElementById('download-button').click();
          for (let tries=0; tries<400; tries++) {
            const matches = await browser.downloads.search({url});
            const complete = matches.find(item => item.state === 'complete');
            if (complete && !bench.state.busy) {
              await bench.refreshDownloadStatuses();
              const image = bench.state.images.find(item => item.url === url);
              if (image.downloadStatus !== 'downloaded') throw new Error('Completed download not shown as downloaded');
              if (bench.state.selected.has(url)) throw new Error('Completed download remained selected');
              return {url, filename:complete.filename, bytes:complete.fileSize, elapsedMs:performance.now()-start, status:image.downloadStatus};
            }
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          throw new Error('Native download did not complete: '+document.getElementById('notice').textContent);
        ''')
        download = result['download']
        downloaded_path = Path(download['filename']).resolve()
        assert downloaded_path.is_relative_to(driver.downloads.resolve()), download
        with urllib.request.urlopen(download['url']) as response:
            assert downloaded_path.read_bytes() == response.read(), 'Downloaded bytes differ from fixture'
        download['verifiedBytes'] = downloaded_path.stat().st_size
        (directory / 'result.json').write_text(json.dumps(result, indent=2))
        screenshot = driver.command('WebDriver:TakeScreenshot', {'id': None, 'full': False, 'scroll': False})
        (directory / 'manager.png').write_bytes(base64.b64decode(screenshot))
        private_window = driver.async_execute('''
          if (!await browser.extension.isAllowedIncognitoAccess()) throw new Error('Test addon has no private access');
          await window.__anydownloadBench.saveCurrentGallery();
          const before = await browser.storage.local.get('siteGalleries:v1');
          const win = await browser.windows.create({incognito:true, url:arguments[0]+'/gallery-1200'});
          const tab = win.tabs[0];
          for (let tries=0; tries<200; tries++) {
            if ((await browser.tabs.get(tab.id)).status === 'complete') break;
            await new Promise(resolve=>setTimeout(resolve,50));
          }
          const stable = sites => sites.map(({siteKey,epoch,records})=>({siteKey,epoch,records}));
          return {windowId:win.id, sourceTabId:tab.id, normalGallery:JSON.stringify(stable(before['siteGalleries:v1']))};
        ''', origin)
        driver.context('chrome')
        driver.execute('''
          const extension = WebExtensionPolicy.getByID(arguments[0]).extension;
          extension.tabManager.addActiveTabPermission(extension.tabManager.get(arguments[1]).nativeTab);
          return true;
        ''', ADDON_ID, private_window['sourceTabId'])
        driver.context('content')
        private_manager_url = f'moz-extension://{uuid}/popup/popup.html?sourceTabId={private_window["sourceTabId"]}'
        handles_before = set(driver.command('WebDriver:GetWindowHandles'))
        driver.async_execute('return await browser.tabs.create({windowId:arguments[0],url:arguments[1]});', private_window['windowId'], private_manager_url)
        new_handles = set(driver.command('WebDriver:GetWindowHandles')) - handles_before
        assert len(new_handles) == 1, new_handles
        driver.command('WebDriver:SwitchToWindow', {'handle': new_handles.pop()})
        private_ready = driver.wait('return window.__anydownloadBench && window.__anydownloadBench.initialized && {count:window.__anydownloadBench.state.images.length,incognito:window.__anydownloadBench.state.incognito,errors:window.__anydownloadBench.errors};')
        assert private_ready == {'count': 1200, 'incognito': True, 'errors': []}, private_ready
        result['private'] = driver.async_execute('''
          const local = await browser.storage.local.get('siteGalleries:v1');
          const session = await browser.storage.session.get('siteGalleries:v1');
          const stable = sites => sites.map(({siteKey,epoch,records})=>({siteKey,epoch,records}));
          if (JSON.stringify(stable(local['siteGalleries:v1'])) !== arguments[0]) throw new Error('Private scan modified normal saved gallery records; before='+JSON.parse(arguments[0]).flatMap(site=>site.records).length+', after='+local['siteGalleries:v1'].flatMap(site=>site.records).length);
          const privateRecords = session['siteGalleries:v1']?.flatMap(site=>site.records)||[];
          if (privateRecords.length !== 1200) throw new Error('Private collection was not saved in session storage');
          return {incognito:window.__anydownloadBench.state.incognito, privateRecords:privateRecords.length,
            normalRecords:local['siteGalleries:v1'].flatMap(site=>site.records).length, normalGalleryUnchanged:true,
            rows:document.querySelectorAll('.image-row').length, errors:window.__anydownloadBench.errors};
        ''', private_window['normalGallery'])
        result['liveCapture'] = driver.async_execute('''
          const bench = window.__anydownloadBench;
          document.getElementById('select-none-button').click();
          document.querySelector('.image-row input[type=checkbox]').click();
          const selectedUrl = [...bench.state.selected][0];
          await bench.startLiveCapture({skipInitialScan:true,quiet:true});
          const started = performance.now();
          await browser.scripting.executeScript({target:{tabId:bench.state.sourceTabId},func:()=>{
            const image=document.createElement('img');
            image.src='/media/long/live.svg'; image.width=1200; image.height=900;
            image.setAttribute('data-original',image.src);
            image.setAttribute('data-original-width','1200'); image.setAttribute('data-original-height','900');
            document.querySelector('.gallery').append(image);
          }});
          for(let tries=0;tries<400;tries++) {
            if(bench.state.images.length===1201&&!bench.state.busy) {
              bench.stopLiveCapture(); await bench.saveCurrentGallery();
              if(!bench.state.selected.has(selectedUrl)) throw new Error('Live scan lost existing selection');
              const local=await browser.storage.local.get('siteGalleries:v1');
              const stable=sites=>sites.map(({siteKey,epoch,records})=>({siteKey,epoch,records}));
              if(JSON.stringify(stable(local['siteGalleries:v1']))!==arguments[0]) throw new Error('Private live update modified normal gallery');
              return {count:bench.state.images.length,existingSelectionRetained:true,normalGalleryUnchanged:true,
                elapsedMs:performance.now()-started,errors:bench.errors};
            }
            await new Promise(resolve=>setTimeout(resolve,50));
          }
          bench.stopLiveCapture(); throw new Error('Live gallery did not discover appended image');
        ''', private_window['normalGallery'])
        assert not result['private']['errors'], result['private']['errors']
        assert not result['liveCapture']['errors'], result['liveCapture']['errors']
        driver.command('WebDriver:SwitchToWindow', {'handle': manager_handle})
        driver.async_execute('await browser.windows.remove(arguments[0]); return true;', private_window['windowId'])
        assert driver.execute('return window.__anydownloadBench.state.images.length;') == 5000
        result['postPhaseErrors'] = driver.execute('return window.__anydownloadBench.errors;')
        assert not result['postPhaseErrors'], result['postPhaseErrors']
        print(name, 'download and private-window regressions passed', flush=True)
        (directory / 'result.json').write_text(json.dumps(result, indent=2))
        return result
    finally:
        driver.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--firefox', default='/Applications/Firefox.app/Contents/MacOS/firefox')
    parser.add_argument('--baseline-ref', default='HEAD')
    parser.add_argument('--baseline-dir', help='Compare with an existing extension directory, including uncommitted changes')
    parser.add_argument('--opening-only', action='store_true')
    parser.add_argument('--opening-samples', type=int, default=1)
    parser.add_argument('--output-dir')
    parser.add_argument('--port', type=int, default=8189)
    parser.add_argument('--marionette-port', type=int, default=2839)
    parser.add_argument('--variants', default='baseline,optimized')
    args = parser.parse_args()
    if not 1 <= args.opening_samples <= 10:
        parser.error('--opening-samples must be between 1 and 10')
    variant_names = args.variants.split(',')
    if len(set(variant_names)) != len(variant_names) or any(name not in ('baseline', 'optimized') for name in variant_names):
        parser.error('--variants must contain baseline and/or optimized exactly once each')
    directory = Path(args.output_dir).resolve() if args.output_dir else Path(tempfile.mkdtemp(prefix='anydownload-firefox-'))
    directory.mkdir(parents=True, exist_ok=True)
    print('Artifacts:', directory, flush=True)
    copies = prepare_copies(directory, args.baseline_ref, args.baseline_dir)
    fixture_log = open(directory / 'fixture.log', 'w')
    server = subprocess.Popen(['node', str(ROOT / 'scripts/firefox-gallery-fixture.cjs'), f'--port={args.port}'], stdout=fixture_log, stderr=fixture_log)
    origin = f'http://127.0.0.1:{args.port}'
    try:
        for _ in range(100):
            try:
                with urllib.request.urlopen(origin + '/health', timeout=1) as response:
                    health = json.load(response)
                    assert health['ok'] and health['pid'] == server.pid, 'Fixture port belongs to another process'
                break
            except OSError:
                time.sleep(.1)
        else:
            raise RuntimeError('Local fixture did not start')
        results = {}
        for index, name in enumerate(variant_names):
            run_dir = directory / f'run-{index}-{name}'
            run_dir.mkdir()
            results[name] = run_variant(name, copies[name], args.firefox, run_dir, origin, args.marionette_port,
                opening_only=args.opening_only, opening_samples=args.opening_samples)
        results['metadata'] = {
            'baselineRef': args.baseline_ref,
            'baselineDir': args.baseline_dir,
            'baselineCommit': None if args.baseline_dir else subprocess.check_output(['git', 'rev-parse', args.baseline_ref], cwd=ROOT, text=True).strip(),
            'baselineExtensionSha256': extension_hash(args.baseline_dir) if args.baseline_dir else None,
            'optimizedExtensionSha256': extension_hash(ROOT / 'extension'),
            'productionDiffSha256': hashlib.sha256(subprocess.check_output(['git', 'diff', '--', 'extension'], cwd=ROOT)).hexdigest(),
            'variantOrder': args.variants.split(','),
            'method': 'Headed Firefox; identical temporary test-only instrumentation; loaded localhost SVG galleries; default timer precision',
            'openingSamplesPerMode': args.opening_samples,
            'openingModes': ['fresh', 'saved'] if args.opening_samples > 1 else ['fresh'],
            'openingWarmups': 0,
            'collectorAndInteractionWarmups': None if args.opening_only else 2,
            'collectorAndInteractionSamples': None if args.opening_only else 7,
            'firstPaintMeaning': 'Double-requestAnimationFrame visible-frame proxy after the first non-busy 5,000-item collection render; not compositor paint telemetry',
        }
        if 'baseline' in results and 'optimized' in results:
            for key, before in results['baseline']['collector'].items():
                after = results['optimized']['collector'][key]
                if key != 'edgeChecks':
                    assert before['recordsSha256'] == after['recordsSha256'], f'Media metadata changed: {key}'
                    assert before['discoveryOrderSha256'] == after['discoveryOrderSha256'], f'Discovery order changed: {key}'
                assert before['warnings'] == after['warnings'], f'Warnings changed: {key}'
            results['metadata']['collectorParity'] = not args.opening_only
            print('Manager event-handler medians (ms; below 1 ms may read as zero):', flush=True)
            for key, before in results['baseline'].get('manager',{}).get('metrics',{}).items():
                after = results['optimized']['manager']['metrics'][key]
                print(f'  {key}: {before["medianSyncMs"]} -> {after["medianSyncMs"]}; '
                      f'through next paint: {before["medianPaintedMs"]} -> {after["medianPaintedMs"]}', flush=True)
        (directory / 'results.json').write_text(json.dumps(results, indent=2))
        print('Results:', directory / 'results.json', flush=True)
    finally:
        server.terminate()
        server.wait(timeout=10)
        fixture_log.close()


if __name__ == '__main__':
    main()
