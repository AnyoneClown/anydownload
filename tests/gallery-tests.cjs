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
  focus() {}
  querySelectorAll() { return []; }
  querySelector() { return null; }
  closest() { return this; }
}

function popupHarness(stored = { local: [], session: [] }) {
  const elements = new Map();
  const timers = new Map();
  let timerId = 0;
  let scrolls = 0;
  let sourceImages = [photo("one")];
  let scanWait = null;
  let updatedListener = null;
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
          querySelector() { return null; }
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
        async sendMessage(message) {
          if (message.type === "SITE_GALLERY") {
            const area = message.incognito ? "session" : "local";
            if (message.action === "get") {
              return { ok: true, gallery: Gallery.getSite(stored[area], message.siteKey) };
            }
            const result = Gallery.updateSites(stored[area], message);
            stored[area] = result.sites;
            return { ok: true, gallery: result.gallery, stale: result.stale };
          }
          if (message.type === "GET_MEDIA_DOWNLOAD_STATUS") {
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
            return [{ result: { html: "second page", bytes: 20, url: args[0] } }];
          }
          if (func.name === "collectLiveGalleryFingerprint") {
            return [{ result: { fingerprint: "test", pageUrl: tab.url } }];
          }
          if (scanWait) {
            const wait = scanWait;
            scanWait = null;
            await wait;
          }
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
      state, elements, scanPage, saveCurrentGallery, clearSiteGallery, collectGallery,
      stopGalleryCollection, resetSidebarPageState, beginSidebarTransition, handleGalleryStorageChanges,
      renderedDownloadItems, wireSourceTabLifecycle,
      prepare() { cacheElements(); applySmartFiltersToControls(Filters.DEFAULT_FILTERS); }
    };
    document.addEventListener("DOMContentLoaded",`), context);
  const popup = context.testPopup;
  popup.prepare();
  popup.wireSourceTabLifecycle();
  elements.get("folder-input").value = "Website media";
  elements.get("filename-template-input").value = "{page-title}-{index}-{filename}";
  elements.get("gallery-pages-select").value = "3";
  elements.get("backgrounds-input").checked = true;
  return {
    popup, tab, stored, elements,
    setImages(images) { sourceImages = images; },
    delayScan(promise) { scanWait = promise; },
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
  const more = {
    textContent: "Load more photos", disabled: false, form: null,
    getAttribute() { return null; }, getClientRects() { return [{}]; }, click() { clicks += 1; }
  };
  const scroll = vm.runInNewContext(`(${Gallery.scrollPage.toString()})`, {
    location: { href: `${siteKey}/one` }, window: { innerHeight: 600 },
    document: { scrollingElement: root, querySelectorAll(selector) { return selector === "button" ? [more] : []; } }
  });
  assert.equal(scroll(`${siteKey}/one`, true).bottom, false);
  assert.equal(clicks, 0);
  scroll(`${siteKey}/one`, true);
  assert.equal(scroll(`${siteKey}/one`, true).clickedMore, true);
  assert.equal(clicks, 1);
  more.form = {};
  assert.equal(scroll(`${siteKey}/one`, true).clickedMore, false, "Collection must never submit a form");
  assert.equal(scroll(`${siteKey}/one`, false, true).top, 0, "A complete collection must also visit content above the starting position");
  assert.throws(() => scroll(`${siteKey}/elsewhere`, true), /source page changed/);
}

(async () => {
  await checkPopup();
  await checkFetch();
  checkScrolling();
  const stoppable = popupHarness();
  await stoppable.popup.scanPage();
  const collecting = stoppable.popup.collectGallery();
  await new Promise((resolve) => setTimeout(resolve, 1));
  stoppable.popup.stopGalleryCollection();
  await collecting;
  assert.ok(stoppable.popup.state.images.length > 0);
  assert.match(stoppable.elements.get("notice").textContent, /Collection stopped/);
  assert.ok(stoppable.scrolls < 10, "Stop must end automatic scrolling promptly");
  console.log("All saved-gallery and collection checks passed.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
