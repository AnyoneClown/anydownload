"use strict";

const assert = require("assert").strict;
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const Core = require("../extension/shared/core.js");
const source = fs.readFileSync(path.join(__dirname, "../extension/preview/preview.js"), "utf8");
const id = "preview-test-1234";
const key = `imagePreview:${id}`;
const now = 1789228800000;

async function openPreview({ session = {}, cache = new Map(), clock = now, search = `?id=${id}`, missingTab = false, sourceTabUrl = "https://example.test/gallery" } = {}) {
  const elements = new Map();
  const updates = [];
  const navigations = [];
  const transfers = [];
  const revoked = [];
  const events = {};
  class PreviewURL extends URL {}
  PreviewURL.createObjectURL = () => "blob:preview-original";
  PreviewURL.revokeObjectURL = (url) => revoked.push(url);
  vm.runInNewContext(source, {
    ImageDownloaderCore: Core,
    URL: PreviewURL, AbortController,
    addEventListener: (type, callback) => { events[type] = callback; },
    ImageDownloaderImageFetch: { mediaBlob() {} },
    AnyDownloadTelegram: { ...require("../extension/shared/telegram.js"),
      transfer: async (_browser, task, incognito, _validate, signal) => {
        transfers.push({ task, incognito, signal });
        return new Blob(["fixture"]);
      } },
    URLSearchParams,
    Date: { now: () => clock },
    location: { search, assign: url => navigations.push(url) },
    document: {
      getElementById(name) {
        if (!elements.has(name)) {
          elements.set(name, {
            hidden: true,
            textContent: "",
            attributes: {},
            listeners: {},
            classList: { add() {}, toggle() { return true; } },
            addEventListener(type, listener) { this.listeners[type] = listener; },
            setAttribute(name, value) { this.attributes[name] = value; }
          });
        }
        return elements.get(name);
      }
    },
    sessionStorage: {
      getItem: key => cache.get(key) || null,
      setItem: (key, value) => cache.set(key, value),
      removeItem: key => cache.delete(key)
    },
    browser: {
      storage: { session: {
        get: async key => ({ [key]: session[key] }),
        remove: async key => { delete session[key]; }
      } },
      tabs: { get: async () => {
        if (missingTab) throw new Error("Source tab closed");
        return { url: sourceTabUrl };
      }, update: async (id, options) => {
        updates.push({ id, options });
        if (missingTab) throw new Error("Source tab closed");
      } }
    }
  });
  await new Promise(setImmediate);
  return { elements, updates, navigations, transfers, revoked, events };
}

(async () => {
  const payload = {
    url: "https://cdn.example.test/photo.jpg",
    name: "Photo",
    mediaType: "image",
    sourceUrl: "https://example.test/gallery",
    sourceTabId: 42,
    createdAt: now
  };
  const session = { [key]: payload };
  const cache = new Map();
  const first = await openPreview({ session, cache });
  assert.equal(first.elements.get("preview-image").src, payload.url);
  assert.equal(session[key], undefined, "The shared payload must be consumed after it moves into the preview tab");
  assert.equal(cache.size, 1, "Only one payload may be retained per tab");
  assert.equal(first.elements.get("source-link").href, payload.sourceUrl);

  const reloaded = await openPreview({ session, cache });
  assert.equal(reloaded.elements.get("preview-image").src, payload.url, "Reload must reuse the tab's unexpired payload");
  let prevented = false;
  reloaded.elements.get("source-link").listeners.click({ button: 0, preventDefault() { prevented = true; } });
  await new Promise(setImmediate);
  assert.equal(prevented, true);
  assert.equal(reloaded.updates[0].id, 42);
  assert.equal(reloaded.updates[0].options.active, true);

  const closedSource = await openPreview({ cache, missingTab: true });
  closedSource.elements.get("source-link").listeners.click({ button: 0, preventDefault() {} });
  await new Promise(setImmediate);
  assert.deepEqual(closedSource.navigations, [payload.sourceUrl], "A closed source tab must fall back to its page URL");

  const changedSource = await openPreview({ cache, sourceTabUrl: "https://example.test/later-page" });
  await changedSource.elements.get("source-link").listeners.click({ button: 0, preventDefault() {} });
  assert.deepEqual(changedSource.updates, [], "A tab that moved to another page must not be presented as the source");
  assert.deepEqual(changedSource.navigations, [payload.sourceUrl], "Saved collection previews must return to the item's original page");

  const expired = await openPreview({ cache, clock: now + 5 * 60 * 1000 + 1 });
  assert.match(expired.elements.get("error-message").textContent, /expired/);
  assert.equal(cache.size, 0, "Expired tab data must be removed");
  assert.equal(expired.elements.get("source-link").href, payload.sourceUrl, "Expired previews must still offer a way back");

  const invalidSource = await openPreview({ session: { [key]: { ...payload, sourceUrl: "javascript:alert(1)" } } });
  assert.equal(invalidSource.elements.get("source-link").hidden, true);
  const wrongId = await openPreview({ cache: new Map([["imagePreview", JSON.stringify({ id: "other-preview", payload })]]) });
  assert.match(wrongId.elements.get("error-message").textContent, /expired/, "A tab cache must never serve a different preview id");
  const future = await openPreview({ session: { [key]: { ...payload, createdAt: now + 60001 } } });
  assert.match(future.elements.get("error-message").textContent, /expired/);

  const video = await openPreview({ session: { [key]: { ...payload, url: "https://cdn.example.test/clip.mp4", mediaType: "video" } } });
  assert.equal(video.elements.get("preview-video").src, "https://cdn.example.test/clip.mp4");
  assert.equal(video.elements.get("preview-video").hidden, false);
  const telegramUrl = "https://web.telegram.org/k/?anydownload_telegram=1&peer=-123&mid=2&id=777&kind=video";
  const telegram = await openPreview({ session: { [key]: { ...payload, url: telegramUrl,
    sourceUrl: "https://web.telegram.org/k/#-123", mediaType: "video", incognito: true } } });
  assert.equal(telegram.elements.get("preview-video").src, "blob:preview-original");
  assert.equal(telegram.elements.get("source-link").href, "https://web.telegram.org/k/#-123");
  assert.equal(telegram.elements.get("original-link").hidden, true, "Do not navigate to a synthetic file reference");
  assert.equal(telegram.transfers[0].incognito, true);
  telegram.events.pagehide();
  assert.equal(telegram.transfers[0].signal.aborted, true);
  assert.deepEqual(telegram.revoked, ["blob:preview-original"]);
  console.log("Preview page checks passed.");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
