"use strict";

const assert = require("assert").strict;
const fs = require("fs");
const vm = require("vm");
const Gallery = require("../extension/shared/gallery.js");
const Core = require("../extension/shared/core.js");
const siteKey = "https://gallery.test";
const photo = (name, selected = true) => ({
  url: `https://cdn.test/${name}.jpg`, pageUrl: `${siteKey}/${name}`,
  pageTitle: name, selected, width: 1200, height: 800
});

let saved = Gallery.updateSites([], { siteKey, epoch: 0, records: [photo("one", false)] });
saved = Gallery.updateSites(saved.sites, { siteKey, epoch: 0, records: [photo("two")] });
assert.deepEqual(saved.gallery.records.map((record) => [record.pageTitle, record.selected]), [["one", false], ["two", true]]);
saved = Gallery.updateSites(saved.sites, {
  siteKey, epoch: 0, records: [{ ...photo("one", false), url: "https://cdn.test/one.jpg?token=refreshed" }]
});
assert.equal(saved.gallery.records.length, 2);
assert.match(saved.gallery.records[0].url, /token=refreshed/);
assert.equal(Gallery.normalizeRecord({ ...photo("unsafe"), url: "javascript:alert(1)" }, siteKey), null);
assert.equal(Gallery.normalizeRecord({ ...photo("cross-site"), pageUrl: "https://other.test" }, siteKey), null);
assert.equal(Gallery.pageUrl("https://user:password@gallery.test/"), "");
const video = Gallery.normalizeRecord({
  ...photo("video"), mediaType: "video", sourceProvider: "youtube", videoId: "abcdefghijk", itag: 18,
  identityKey: "youtube:abcdefghijk:18", url: "https://r1.googlevideo.com/videoplayback?secret=123",
  previewUrl: "https://i.ytimg.com/vi/abcdefghijk/default.jpg"
}, siteKey);
assert.equal(video.url, "https://www.youtube.com/watch?v=abcdefghijk&anydownload_provider=youtube&anydownload_itag=18");
assert.doesNotMatch(JSON.stringify(video), /googlevideo|secret/);
assert.equal(Gallery.normalizeRecord({ ...photo("unknown-video"), url: "https://r1.googlevideo.com/videoplayback?secret=123" }, siteKey), null);
const full = Gallery.updateSites([], { siteKey, epoch: 0, records: Array.from({ length: 1500 }, (_, i) => photo(String(i))) });
const capped = Gallery.updateSites(full.sites, { siteKey, epoch: 0, records: [photo("overflow")] });
assert.equal(capped.gallery.records.length, 1500);
assert.equal(capped.gallery.trimmed, true);
const cleared = Gallery.updateSites(saved.sites, { siteKey, action: "clear" });
assert.equal(Gallery.updateSites(cleared.sites, { siteKey, epoch: 0, records: [photo("stale")] }).stale, true);
let sites = [];
for (let i = 0; i < 25; i += 1) {
  sites = Gallery.updateSites(sites, { siteKey: `https://site${i}.test`, epoch: 0, records: [] }, i + 1).sites;
}
assert.equal(sites.length, Gallery.MAX_SITES);
assert.equal(sites[0].siteKey, "https://site24.test");

// Exercise the actual popup state transitions with a small DOM and Firefox API stand-in.
class Element {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.value = "";
    this.checked = false;
    this.hidden = false;
    this.isConnected = true;
    this.attributes = new Map();
    this.listeners = new Map();
    this.classList = { add() {}, remove() {}, toggle() {} };
  }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  getAttribute(key) { return this.attributes.get(key) || ""; }
  removeAttribute(key) { this.attributes.delete(key); }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  append(...nodes) { this.children.push(...nodes); }
  appendChild(node) { this.append(node); return node; }
  replaceChildren(...nodes) { this.children = nodes; }
  contains() { return true; }
  matches(selector) { return selector === ":popover-open" && this.popoverOpen === true; }
  showPopover() { this.popoverOpen = true; }
  hidePopover() { this.popoverOpen = false; }
  showModal() { this.open = true; }
  close() { this.open = false; this.listeners.get("close")?.(); }
  focus() { this.focused = true; }
  querySelectorAll() { return []; }
  querySelector() { return null; }
  closest() { return this; }
}

function popupHarness(stored = { local: [], session: [] }) {
  const elements = new Map();
  const timers = new Map();
  let timerId = 0;
  let scrolls = 0;
  const fetchedPages = [];
  let continuePagination = false;
  let sourceImages = [photo("one")];
  let scanWait = null;
  let scanStarted = null;
  let statusWait = null;
  let statusStarted = null;
  let updatedListener = null;
  let clearError = false;
  let scanError = false;
  const tab = { id: 1, url: `${siteKey}/one`, title: "one", incognito: false, windowId: 1, active: true };
  const context = {
    URL, TextEncoder, TextDecoder, console, Date,
    location: { href: "moz-extension://test/popup/popup.html?sourceTabId=1" },
    addEventListener() {},
    document: {
      documentElement: new Element("html"),
      addEventListener() {},
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, new Element());
        return elements.get(id);
      },
      createElement(tag) { return new Element(tag); },
      createDocumentFragment() { return new Element(); }
    },
    setTimeout(callback, delay) {
      const id = ++timerId;
      if (delay === 1200) {
        timers.set(id, setTimeout(callback, 0));
      }
      return id;
    },
    clearTimeout(id) { clearTimeout(timers.get(id)); timers.delete(id); },
    Image: class extends Element {},
    DOMParser: class {
      parseFromString(html) {
        return {
          html, title: "page two", head: new Element("head"),
          createElement(tag) { return new Element(tag); },
          querySelector(selector) {
            if (continuePagination && selector === "a[rel~='next']") {
              return { getAttribute() { return `${siteKey}/page${Number(new URL(html).pathname.slice(5)) + 1}`; } };
            }
            return null;
          }
        };
      }
    },
    browser: {
      storage: {
        local: { async get() { return {}; }, async set() {}, async remove() {} },
        session: { async get() { return {}; }, async set() {}, async remove() {} }
      },
      tabs: {
        async get() { return { ...tab }; }, async query() { return [{ ...tab }]; },
        onUpdated: { addListener(listener) { updatedListener = listener; } }
      },
      runtime: {
        getURL: file => `moz-extension://test/${file}`,
        async sendMessage(message) {
          if (message.type === "SITE_GALLERY") {
            if (message.action === "clear" && clearError) return { ok: false, error: "Clear failed" };
            const area = message.incognito ? "session" : "local";
            if (message.action === "get") {
              return { ok: true, gallery: Gallery.getSite(stored[area], message.siteKey) };
            }
            const result = Gallery.updateSites(stored[area], message);
            stored[area] = result.sites;
            return { ok: true, gallery: result.gallery, stale: result.stale };
          }
          if (message.type === "GET_MEDIA_DOWNLOAD_STATUS") {
            if (statusWait) {
              const wait = statusWait;
              statusWait = null;
              statusStarted();
              await wait;
            }
            return { ok: true, statuses: message.items.map(() => ({ status: "new" })) };
          }
          return { ok: true, tracker: null };
        }
      },
      scripting: {
        async executeScript({ func, args }) {
          if (func.name === "scrollPage") {
            scrolls += 1;
            sourceImages = [photo("two")]; // A virtualized gallery removes the first image.
            return [{ result: { top: 1000, height: 1600, bottom: true, nextLinks: ["/page2"] } }];
          }
          if (func.name === "fetchPage") {
            fetchedPages.push(args[0]);
            return [{ result: { html: args[0], bytes: 20, url: args[0] } }];
          }
          if (func.name === "collectLiveGalleryFingerprint") {
            return [{ result: { fingerprint: "test", pageUrl: tab.url } }];
          }
          if (scanWait) {
            const wait = scanWait;
            scanWait = null;
            scanStarted?.();
            scanStarted = null;
            await wait;
          }
          if (scanError) throw new Error("Scan failed");
          return [{ frameId: 0, result: { images: sourceImages, pageUrl: tab.url, pageTitle: tab.title, warnings: [] } }];
        }
      }
    }
  };
  vm.createContext(context);
  for (const file of ["core", "filters", "templates", "tracker", "download-ledger", "gallery"]) {
    vm.runInContext(fs.readFileSync(`${__dirname}/../extension/shared/${file}.js`, "utf8"), context);
  }
  context.ImageDownloaderCollector = function collectImagesFromPage(options, parsed) {
    assert.ok(parsed);
    return { pageUrl: options.pageUrl, pageTitle: "page two", images: [photo("three")], warnings: [] };
  };
  const source = fs.readFileSync(`${__dirname}/../extension/popup/popup.js`, "utf8");
  vm.runInContext(source.replace('  document.addEventListener("DOMContentLoaded",', `
    globalThis.testPopup = {
      state, elements, scanPage, saveCurrentGallery, clearSiteGallery, undoClearSiteGallery, collectGallery,
      stopGalleryCollection, resetSidebarPageState, beginSidebarTransition, handleGalleryStorageChanges,
      renderedDownloadItems, wireSourceTabLifecycle, mergeScanResults, wireEvents, renderImages, makeImageRow, filteredImages,
      prepare() { cacheElements(); applySmartFiltersToControls(Filters.DEFAULT_FILTERS); }
    };
    document.addEventListener("DOMContentLoaded",`), context);
  const popup = context.testPopup;
  popup.prepare();
  popup.wireSourceTabLifecycle();
  elements.get("folder-input").value = "Website media";
  elements.get("filename-template-input").value = "{page-title}-{index}-{filename}";
  elements.get("backgrounds-input").checked = true;
  return {
    popup, tab, stored, elements, fetchedPages,
    enableNextPages() { continuePagination = true; },
    setImages(images) { sourceImages = images; },
    failClear() { clearError = true; },
    failScan() { scanError = true; },
    delayScan(promise) {
      scanWait = promise;
      return new Promise(resolve => { scanStarted = resolve; });
    },
    delayStatuses(promise) {
      statusWait = promise;
      return new Promise(resolve => { statusStarted = resolve; });
    },
    navigate(url) { tab.url = url; updatedListener(tab.id, { url, status: "loading" }, tab); },
    get scrolls() { return scrolls; }
  };
}

async function checkPopup() {
  const harness = popupHarness();
  const { popup, tab, stored } = harness;
  assert.equal(await popup.scanPage(), true);
  popup.state.selected.clear();
  await popup.saveCurrentGallery();
  popup.beginSidebarTransition(2, null);
  tab.id = 2;
  tab.url = "https://other.test/album";
  tab.title = "other";
  harness.setImages([{ ...photo("other"), pageUrl: tab.url }]);
  assert.equal(await popup.scanPage(), true);
  assert.equal(popup.state.images.length, 1);
  assert.equal(popup.state.images[0].pageTitle, "other");
  popup.beginSidebarTransition(1, null);
  tab.id = 1;
  tab.url = `${siteKey}/two`;
  tab.title = "two";
  harness.setImages([photo("two")]);
  assert.equal(await popup.scanPage(), true);
  assert.deepEqual(Array.from(popup.state.images, (record) => record.pageTitle), ["one", "two"]);
  assert.equal(popup.state.selected.has("https://cdn.test/one.jpg"), false);
  assert.equal(popup.state.selected.has("https://cdn.test/two.jpg"), true);
  assert.match(popup.renderedDownloadItems([popup.state.images[0]])[0].filename, /^one-/);

  const reopened = popupHarness(stored);
  assert.equal(await reopened.popup.scanPage(), true);
  assert.equal(reopened.popup.state.images.length, 2, "Closing/reopening the popup must retain the site's gallery");
  assert.equal(reopened.popup.state.selected.has("https://cdn.test/one.jpg"), false);
  reopened.navigate(`${siteKey}/next`);
  assert.equal(reopened.popup.state.images.length, 2, "Same-site navigation must keep the saved gallery visible");
  await reopened.popup.collectGallery();
  assert.ok(reopened.scrolls >= 4);
  assert.equal(reopened.popup.state.images.length, 3, "Scrolling and pagination must keep virtualized images");
  assert.equal(reopened.popup.state.selected.has("https://cdn.test/one.jpg"), false);

  let release;
  reopened.delayScan(new Promise((resolve) => { release = resolve; }));
  const scanning = reopened.popup.scanPage({ preserveSelection: true, live: true });
  await Promise.resolve();
  await Promise.resolve();
  reopened.popup.beginSidebarTransition(2, null);
  release();
  assert.equal(await scanning, false, "Navigation must invalidate an in-flight scan");
  assert.equal(reopened.popup.state.images.length, 0);

  const privateWindow = popupHarness(stored);
  privateWindow.tab.incognito = true;
  privateWindow.setImages([{ ...photo("private"), pageUrl: `${siteKey}/private` }]);
  assert.equal(await privateWindow.popup.scanPage(), true);
  assert.equal(privateWindow.popup.state.images.length, 1);
  assert.doesNotMatch(JSON.stringify(stored.local), /private\.jpg/);
  assert.match(JSON.stringify(stored.session), /private\.jpg/);
  await privateWindow.popup.clearSiteGallery();
  assert.equal(privateWindow.popup.state.images.length, 0);
  assert.ok(stored.local[0].records.length);

  const shared = popupHarness(stored);
  await shared.popup.scanPage();
  shared.popup.state.selected.delete("https://cdn.test/two.jpg");
  await shared.popup.saveCurrentGallery();
  popup.state.images.push(photo("from-second-tab"));
  popup.state.selected.add("https://cdn.test/from-second-tab.jpg");
  await popup.saveCurrentGallery();
  const combined = Gallery.getSite(stored.local, siteKey);
  assert.equal(combined.records.find((record) => record.pageTitle === "two").selected, false,
    "Saving another tab's new media must not overwrite an unchanged, stale selection");

  const clearing = popupHarness(stored);
  await clearing.popup.scanPage();
  const otherGallery = JSON.stringify(Gallery.getSite(stored.local, "https://other.test"));
  await clearing.popup.clearSiteGallery();
  assert.equal(clearing.popup.state.images.length, 0);
  assert.equal(clearing.popup.state.selected.size, 0);
  assert.equal(Gallery.getSite(stored.local, siteKey).records.length, 0);
  assert.equal(JSON.stringify(Gallery.getSite(stored.local, "https://other.test")), otherGallery);
  assert.equal(clearing.elements.get("clear-gallery-button").disabled, true);
  assert.equal(clearing.elements.get("undo-clear-button").focused, true);
  assert.match(clearing.elements.get("notice").textContent, /Downloaded files and history are kept/);
  const fresh = popupHarness(stored);
  fresh.setImages([photo("current-page")]);
  await fresh.popup.scanPage();
  assert.deepEqual(Array.from(fresh.popup.state.images, item => item.url), ["https://cdn.test/current-page.jpg"],
    "Reopening after Clear media must scan the current page without restoring the old gallery");
}

async function checkRefreshMedia() {
  for (const incognito of [false, true]) {
    const harness = popupHarness();
    const { popup, elements, stored } = harness;
    harness.tab.incognito = incognito;
    const area = incognito ? "session" : "local";
    const otherArea = incognito ? "local" : "session";
    stored[otherArea] = Gallery.updateSites([], { siteKey, epoch: 0, records: [photo("unrelated-context")] }).sites;
    stored[area] = Gallery.updateSites([], {
      siteKey: "https://other.test", epoch: 0,
      records: [{ ...photo("other-site"), pageUrl: "https://other.test/page" }]
    }).sites;
    const otherContext = JSON.stringify(stored[otherArea]);
    const otherSite = JSON.stringify(Gallery.getSite(stored[area], "https://other.test"));
    harness.setImages([photo("old"), photo("one")]);
    await popup.scanPage();
    popup.wireEvents();
    popup.state.showSelected = true;
    popup.state.explicitRedownloads.add("old-fingerprint");
    const epoch = Gallery.getSite(stored[area], siteKey).epoch;
    harness.setImages([photo("current")]);
    await elements.get("refresh-media-button").listeners.get("click")();
    assert.deepEqual(Array.from(popup.state.images, item => item.url), [photo("current").url]);
    assert.deepEqual(Array.from(popup.state.selected), [photo("current").url]);
    assert.equal(popup.state.explicitRedownloads.size, 0);
    assert.equal(popup.state.showSelected, false);
    assert.equal(popup.state.liveCapture, true, "Live updates resume after the fresh scan");
    assert.match(elements.get("notice").textContent, /Media refreshed/);
    assert.equal(harness.scrolls, 0, "Refresh must not auto-scroll");
    assert.equal(harness.fetchedPages.length, 0, "Refresh must not crawl linked pages");
    assert.deepEqual(Gallery.getSite(stored[area], siteKey).records.map(item => item.url), [photo("current").url]);
    assert.ok(Gallery.getSite(stored[area], siteKey).epoch > epoch);
    assert.equal(JSON.stringify(stored[otherArea]), otherContext);
    assert.equal(JSON.stringify(Gallery.getSite(stored[area], "https://other.test")), otherSite);

    const reopened = popupHarness(stored);
    reopened.tab.incognito = incognito;
    reopened.setImages([photo("current")]);
    await reopened.popup.scanPage();
    assert.deepEqual(Array.from(reopened.popup.state.images, item => item.url), [photo("current").url],
      "Reopening must not restore the discarded collection");

    harness.setImages([]);
    await elements.get("refresh-media-button").listeners.get("click")();
    assert.equal(popup.state.images.length, 0);
    assert.equal(elements.get("refresh-media-button").disabled, false, "An empty page can be refreshed again");
  }

  for (const failure of ["failClear", "failScan"]) {
    const harness = popupHarness();
    await harness.popup.scanPage();
    harness.popup.wireEvents();
    harness[failure]();
    await harness.elements.get("refresh-media-button").listeners.get("click")();
    assert.equal(harness.popup.state.images.length, failure === "failClear" ? 1 : 0,
      "A failed clear preserves media; a failed scan must not resurrect cleared media");
    assert.match(harness.elements.get("notice").textContent, /failed/);
    assert.equal(harness.popup.state.busy, false);
  }
}

async function checkSelectionDuringScan() {
  const harness = popupHarness();
  const { popup, elements } = harness;
  harness.setImages([photo("one"), photo("two")]);
  await popup.scanPage();
  popup.wireEvents();
  popup.state.selected.delete(photo("one").url);
  elements.get("filter-input").value = "one";
  popup.renderImages();

  let release;
  let started = harness.delayScan(new Promise(resolve => { release = resolve; }));
  let scanning = popup.scanPage({ preserveSelection: true, live: true });
  await started;
  assert.equal(elements.get("select-all-button").disabled, false,
    "Select matches must stay available while the library refreshes");
  assert.equal(elements.get("download-button").disabled, true, "Downloads still wait for the scan");
  elements.get("select-all-button").listeners.get("click")();
  assert.deepEqual(Array.from(popup.state.selected), [photo("one").url]);
  const refreshed = { ...photo("one"), url: `${photo("one").url}?token=refreshed` };
  harness.setImages([refreshed, photo("two")]);
  release();
  assert.equal(await scanning, true);
  assert.deepEqual(Array.from(popup.state.selected), [refreshed.url],
    "A finished scan must preserve bulk selection and follow refreshed media URLs");

  started = harness.delayScan(new Promise(resolve => { release = resolve; }));
  scanning = popup.scanPage({ preserveSelection: true, live: true });
  await started;
  const checkbox = popup.makeImageRow(popup.state.images[0]).children[0];
  assert.equal(checkbox.disabled, false, "Photos rendered during live scans must remain selectable");
  checkbox.checked = false;
  checkbox.listeners.get("change")();
  elements.get("filter-input").value = "two";
  popup.renderImages();
  const other = popup.makeImageRow(popup.state.images[1]).children[0];
  other.checked = true;
  other.listeners.get("change")();
  release();
  await scanning;
  assert.deepEqual(Array.from(popup.state.selected), [photo("two").url],
    "A finished scan must preserve individual photo selection and deselection");

  popup.state.selected.clear();
  popup.renderImages();
  const refreshedTwo = { ...photo("two"), url: `${photo("two").url}?token=refreshed` };
  harness.setImages([refreshed, refreshedTwo]);
  started = harness.delayStatuses(new Promise(resolve => { release = resolve; }));
  scanning = popup.scanPage({ preserveSelection: true, live: true });
  await started;
  const displayed = elements.get("image-list").children[0].children[0].children[0];
  displayed.checked = true;
  displayed.listeners.get("change")();
  assert.deepEqual(Array.from(popup.state.selected), [refreshedTwo.url],
    "Cards must use refreshed URLs while the scan waits for download statuses");
  release();
  await scanning;
  assert.deepEqual(Array.from(popup.state.selected), [refreshedTwo.url]);
  assert.equal(popup.state.liveScanning, false);
}

async function checkSavedCollectionView() {
  const first = popupHarness();
  await first.popup.scanPage();
  const urls = () => Array.from(first.popup.filteredImages(), (item) => item.url);
  const notify = () => first.popup.handleGalleryStorageChanges({ [Gallery.STORAGE_KEY]: { newValue: first.stored.local } }, "local");
  const second = popupHarness(first.stored);
  second.tab.url = `${siteKey}/other-page`;
  const shared = { ...photo("one"), pageUrl: second.tab.url, url: `${photo("one").url}?token=fresh` };
  second.setImages([shared, { ...photo("other-only"), pageUrl: second.tab.url }]);
  await second.popup.scanPage();
  notify();
  assert.deepEqual(urls(), [shared.url, photo("other-only").url],
    "The saved collection shows refreshed and newly discovered media from other pages");

  await first.popup.collectGallery();
  const collected = urls();
  assert.ok(collected.includes(photo("two").url), "Virtualized source-page discoveries remain visible");
  assert.ok(collected.includes(photo("three").url), "Fetched Next-page discoveries appear in the same collection");
  await first.popup.clearSiteGallery();
  assert.deepEqual(urls(), []);
  await first.popup.undoClearSiteGallery();
  assert.deepEqual(urls(), collected, "Undo restores every page's saved media");

  first.navigate(`${siteKey}/other-page`);
  assert.deepEqual(urls(), collected, "Same-site navigation preserves the entire collection");
  first.navigate(`${siteKey}/one`);
  assert.deepEqual(urls(), collected, "Returning to a page preserves the entire collection");

  first.setImages([photo("one")]);
  await first.popup.scanPage();
  let changed = Gallery.updateSites(first.stored.local, { siteKey, action: "clear" });
  changed = Gallery.updateSites(changed.sites, { siteKey, epoch: changed.gallery.epoch, records: [shared] });
  first.stored.local = changed.sites;
  notify();
  assert.deepEqual(urls(), [shared.url], "A newer clear epoch replaces old records with the current saved collection");

  const normalUrls = urls();
  first.popup.handleGalleryStorageChanges({ [Gallery.STORAGE_KEY]: { newValue: [] } }, "session");
  assert.deepEqual(urls(), normalUrls, "Private storage changes cannot replace the normal collection");
}

async function checkFixedPageLimit() {
  const harness = popupHarness();
  harness.enableNextPages();
  await harness.popup.scanPage();
  await harness.popup.collectGallery();
  assert.equal(harness.fetchedPages.length, Gallery.MAX_PAGES - 1,
    "A never-ending Next chain must stop at the fixed total page cap, including the source page");
  assert.equal(new Set(harness.fetchedPages).size, harness.fetchedPages.length);
  assert.match(harness.elements.get("notice").textContent, /Stopped at the 10-page limit/);
}

async function checkPhotoStory() {
  const still = { ...photo("story-photo"), identityKey: "instagram:story:alice:alice:102",
    sourceProvider: "instagram", mediaType: "image", originalMediaType: 1,
    previewUrl: "https://cdn.test/photo-preview.jpg",
    width: 640, height: 1136 };
  const video = { ...still, url: "https://cdn.test/story-video.mp4", originalMediaType: undefined,
    previewUrl: "https://cdn.test/video-preview.jpg",
    mediaType: "video", mimeType: "video/mp4", filename: "story-video.mp4",
    width: 1080, height: 1920, duration: 12.5 };
  const harness = popupHarness();
  for (const images of [[video, still], [still, video]]) {
    const result = harness.popup.mergeScanResults([{ frameId: 0, result: { pageUrl: `${siteKey}/one`, images } }]);
    assert.equal(result.images.length, 1);
    assert.equal(result.images[0].mediaType, "image");
    assert.equal(result.images[0].url, still.url);
    assert.equal(result.images[0].width, 640);
    assert.equal(result.images[0].previewUrl, still.previewUrl);
  }
  harness.setImages([video]);
  await harness.popup.scanPage();
  harness.setImages([still]);
  await harness.popup.scanPage({ preserveSelection: true, live: true });
  const result = harness.popup.state.images[0];
  assert.equal(result.mediaType, "image");
  assert.equal(result.url, still.url);
  assert.equal(result.mimeType, "");
  assert.equal(result.duration, 0);
  assert.equal(result.width, 640);
  assert.equal(harness.popup.state.selected.has(still.url), true);
  assert.match(harness.popup.renderedDownloadItems([result])[0].filename, /\.jpg$/);
  await harness.popup.saveCurrentGallery();
  const saved = Gallery.getSite(harness.stored.local, siteKey);
  assert.equal(saved.records[0].originalMediaType, 1);
  const staleWrite = Gallery.updateSites(harness.stored.local, { siteKey, epoch: saved.epoch, records: [video] });
  assert.equal(staleWrite.gallery.records[0].url, still.url, "A stale manager must not overwrite the confirmed photo");
  const reopened = popupHarness(harness.stored);
  reopened.setImages([video]);
  await reopened.popup.scanPage();
  assert.equal(reopened.popup.state.images[0].url, still.url);
  assert.equal(reopened.popup.state.images[0].mediaType, "image");
}

async function checkUndoAndFilteredScan() {
  const harness = popupHarness();
  const { popup, stored, elements } = harness;
  harness.setImages([photo("one"), photo("two")]);
  await popup.scanPage();
  popup.state.selected.delete(photo("one").url);
  await popup.saveCurrentGallery();
  const beforeClear = Gallery.getSite(stored.local, siteKey);
  await popup.clearSiteGallery();
  assert.equal(elements.get("gallery-undo").hidden, false);
  await popup.undoClearSiteGallery();
  assert.deepEqual(Array.from(popup.state.images, image => image.url), [photo("one").url, photo("two").url],
    "Undo restores the saved website collection");
  assert.deepEqual(Array.from(popup.state.selected), [photo("two").url], "Undo restores deliberate checked and unchecked states");
  assert.ok(Gallery.getSite(stored.local, siteKey).epoch > beforeClear.epoch,
    "Undo must use the post-clear epoch so stale managers cannot resurrect the old collection");
  assert.equal(elements.get("gallery-undo").hidden, true);

  await popup.clearSiteGallery();
  stored.local = Gallery.updateSites(stored.local, { siteKey, action: "clear" }).sites;
  await popup.undoClearSiteGallery();
  assert.equal(Gallery.getSite(stored.local, siteKey).records.length, 0,
    "An intervening clear from another manager must invalidate Undo");

  harness.setImages([photo("again")]);
  await popup.scanPage();
  await popup.clearSiteGallery();
  popup.beginSidebarTransition(2, null);
  await popup.undoClearSiteGallery();
  assert.equal(Gallery.getSite(stored.local, siteKey).records.length, 0,
    "Undo cannot restore into an abandoned source context");

  const privateWindow = popupHarness(stored);
  privateWindow.tab.incognito = true;
  privateWindow.setImages([photo("private-undo")]);
  await privateWindow.popup.scanPage();
  const normalBefore = JSON.stringify(stored.local);
  await privateWindow.popup.clearSiteGallery();
  await privateWindow.popup.undoClearSiteGallery();
  assert.equal(privateWindow.popup.state.images[0].url, photo("private-undo").url);
  assert.equal(JSON.stringify(stored.local), normalBefore, "Private Undo must never write normal storage");
  assert.equal(Gallery.getSite(stored.session, siteKey).records[0].url, photo("private-undo").url);

  const filtered = popupHarness();
  const clip = { ...photo("clip"), url: "https://cdn.test/clip.mp4", mediaType: "video" };
  filtered.setImages([photo("one"), clip]);
  await filtered.popup.scanPage();
  filtered.popup.wireEvents();
  filtered.elements.get("media-type-filter-select").value = "video";
  filtered.elements.get("media-type-filter-select").listeners.get("change")();
  assert.equal(filtered.popup.state.selected.has(photo("one").url), true);
  const addedClip = { ...clip, url: "https://cdn.test/added.mp4" };
  filtered.setImages([photo("one"), clip, photo("new-image"), addedClip]);
  await filtered.popup.scanPage({ preserveSelection: true, live: true });
  assert.deepEqual(Array.from(filtered.popup.state.selected), [photo("one").url, clip.url, addedClip.url],
    "Rescans preserve known hidden selections while only auto-selecting eligible new items");
}

async function checkFetch() {
  const context = {
    location: { href: `${siteKey}/one` }, URL, AbortController, TextDecoder, setTimeout, clearTimeout,
    async fetch(url, options) {
      assert.equal(options.credentials, "include");
      assert.equal(options.redirect, "error");
      return new Response("<img src='/full.jpg'>", { headers: { "content-type": "text/html" } });
    }
  };
  const fetchPage = vm.runInNewContext(`(${Gallery.fetchPage.toString()})`, context);
  assert.match((await fetchPage(`${siteKey}/two`, `${siteKey}/one`)).html, /full\.jpg/);
  await assert.rejects(fetchPage("https://other.test/", `${siteKey}/one`), /original website/);
  await assert.rejects(fetchPage(`${siteKey}/two`, `${siteKey}/changed`), /original website/);
  context.fetch = async () => new Response("too large", { headers: { "content-length": "5000000" } });
  await assert.rejects(fetchPage(`${siteKey}/two`, `${siteKey}/one`), /4 MB/);
  context.fetch = async () => new Response(new Uint8Array(4 * 1024 * 1024 + 1));
  await assert.rejects(fetchPage(`${siteKey}/two`, `${siteKey}/one`), /4 MB/);
  context.fetch = async () => new Response("unauthorized", { status: 403 });
  await assert.rejects(fetchPage(`${siteKey}/two`, `${siteKey}/one`), /HTTP 403/);
}

function checkScrolling() {
  const root = {
    scrollTop: 0, scrollHeight: 1600, clientHeight: 600,
    scrollTo({ top }) { this.scrollTop = Math.min(1000, top); }
  };
  let clicks = 0;
  let enclosingForm = null;
  let visible = true;
  const nextLink = {
    href: `${siteKey}/archive/page2`,
    getAttribute(name) { return name === "href" ? "page2" : null; }
  };
  const attributes = {};
  const more = {
    tagName: "BUTTON", className: "",
    textContent: "Load more photos", disabled: false, form: null,
    getAttribute(name) { return attributes[name] || null; },
    closest(selector) { assert.equal(selector, "form"); return enclosingForm; },
    getClientRects() { return visible ? [{}] : []; }, click() { clicks += 1; }
  };
  const scroll = vm.runInNewContext(`(${Gallery.scrollPage.toString()})`, {
    location: { href: `${siteKey}/one` }, window: { innerHeight: 600 },
    document: { scrollingElement: root, querySelectorAll(selector) {
      if (!selector.startsWith("button")) return [nextLink];
      return more.tagName === "BUTTON" || (
        selector.includes('.js_see-more[data-get="photos"][data-type="group"]') &&
        more.className === "js_see-more" && attributes["data-get"] === "photos" &&
        attributes["data-type"] === "group"
      ) ? [more] : [];
    } }
  });
  assert.equal(scroll(`${siteKey}/one`, true).bottom, false);
  assert.equal(clicks, 0);
  scroll(`${siteKey}/one`, true);
  assert.equal(scroll(`${siteKey}/one`, true).clickedMore, true);
  assert.equal(clicks, 1);
  more.textContent = "Load more videos";
  assert.equal(scroll(`${siteKey}/one`, true).clickedMore, true, "Video galleries must load their next batch");
  assert.equal(clicks, 2);
  assert.equal(scroll(`${siteKey}/one`, false).nextLinks[0], nextLink.href,
    "Live Next links must retain the browser's resolution of the page's base URL");
  more.form = {};
  assert.equal(scroll(`${siteKey}/one`, true).clickedMore, false, "Collection must never submit a form");
  more.form = null;
  more.tagName = "DIV";
  more.className = "js_see-more";
  more.textContent = " See More ";
  attributes["data-get"] = "photos";
  attributes["data-type"] = "group";
  assert.equal(scroll(`${siteKey}/one`, true).clickedMore, true, "FapFolder uses a JavaScript div for photo pagination");
  assert.equal(clicks, 3);
  enclosingForm = {};
  assert.equal(scroll(`${siteKey}/one`, true).clickedMore, false, "JavaScript controls inside forms must also be skipped");
  enclosingForm = null;
  attributes["aria-disabled"] = "true";
  assert.equal(scroll(`${siteKey}/one`, true).clickedMore, false);
  delete attributes["aria-disabled"];
  visible = false;
  assert.equal(scroll(`${siteKey}/one`, true).clickedMore, false);
  visible = true;
  assert.equal(scroll(`${siteKey}/one`, false).clickedMore, false, "The caller's load-more limit must still apply");
  more.className = "";
  assert.equal(scroll(`${siteKey}/one`, true).clickedMore, false, "Unrecognized divs must not be clicked based only on text");
  more.className = "js_see-more";
  attributes["data-get"] = "members";
  assert.equal(scroll(`${siteKey}/one`, true).clickedMore, false, "Only the known photo-pagination action is supported");
  assert.equal(scroll(`${siteKey}/one`, false, true).top, 0, "A complete collection must also visit content above the starting position");
  assert.throws(() => scroll(`${siteKey}/elsewhere`, true), /source page changed/);
}

(async () => {
  await checkPopup();
  await checkRefreshMedia();
  await checkSelectionDuringScan();
  await checkSavedCollectionView();
  await checkFixedPageLimit();
  await checkPhotoStory();
  await checkUndoAndFilteredScan();
  await checkFetch();
  checkScrolling();
  const stoppable = popupHarness();
  await stoppable.popup.scanPage();
  const collecting = stoppable.popup.collectGallery();
  await new Promise((resolve) => setTimeout(resolve, 1));
  stoppable.popup.stopGalleryCollection();
  await collecting;
  assert.ok(stoppable.popup.state.images.length > 0);
  assert.match(stoppable.elements.get("notice").textContent, /Scan stopped/);
  assert.ok(stoppable.scrolls < 10, "Stop must end automatic scrolling promptly");
  console.log("All saved-gallery and collection checks passed.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
