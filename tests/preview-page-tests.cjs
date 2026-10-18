"use strict";

const assert = require("assert").strict;
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const Core = require("../extension/shared/core.js");
const source = fs.readFileSync(path.join(__dirname, "../extension/preview/preview.js"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "../extension/preview/preview.html"), "utf8");
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
          const markup = html.match(new RegExp(`<[^>]+\\bid="${name}"[^>]*>`));
          assert.ok(markup, `The preview page must contain ${name}`);
          const attributes = Object.fromEntries([...markup[0].matchAll(/\s([\w-]+)="([^"]*)"/g)]
            .map((match) => [match[1], match[2]]));
          const classes = new Set((attributes.class || "").split(/\s+/).filter(Boolean));
          elements.set(name, {
            hidden: /\shidden(?=[\s>])/.test(markup[0]),
            disabled: /\sdisabled(?=[\s>])/.test(markup[0]),
            textContent: name === "size-toggle" ? html.match(/id="size-toggle"[^>]*>([^<]*)</)[1] : "",
            attributes,
            listeners: {},
            classList: {
              add(...names) { names.forEach((name) => classes.add(name)); },
              contains(name) { return classes.has(name); },
              toggle(name) {
                if (classes.has(name)) { classes.delete(name); return false; }
                classes.add(name);
                return true;
              }
            },
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

  const image = first.elements.get("preview-image");
  const imageButton = first.elements.get("image-button");
  const sizeToggle = first.elements.get("size-toggle");
  const stage = first.elements.get("preview-stage");
  const footer = first.elements.get("preview-footer");
  assert.equal(imageButton.disabled, true, "Image zoom is unavailable before the image loads");
  assert.equal(sizeToggle.disabled, true, "The toolbar zoom action is unavailable before the image loads");
  assert.equal(sizeToggle.hidden, false, "The disabled zoom action remains discoverable while loading");
  assert.equal(imageButton.attributes["aria-pressed"], "false");
  assert.equal(sizeToggle.textContent, "Actual size");
  assert.equal(stage.classList.contains("actual-size"), false);
  image.naturalWidth = 1800;
  image.naturalHeight = 1200;
  image.listeners.load();
  assert.equal(imageButton.disabled, false);
  assert.equal(sizeToggle.disabled, false, "The toolbar action must enable only after a usable image loads");
  assert.equal(stage.attributes["aria-busy"], "false");
  assert.equal(first.elements.get("loading-message").hidden, true);

  function assertZoomState(actualSize) {
    assert.equal(stage.classList.contains("actual-size"), actualSize, "The rendered image size must match the control state");
    assert.equal(imageButton.attributes["aria-pressed"], String(actualSize));
    assert.equal(imageButton.attributes["aria-label"], "Actual image size", "The toggle keeps a stable accessible name");
    assert.equal(sizeToggle.attributes["data-actual-size"], String(actualSize));
    assert.equal(sizeToggle.textContent, actualSize ? "Fit to window" : "Actual size", "The toolbar names the next zoom action");
    assert.match(footer.textContent, actualSize ? /Showing actual size/ : /Image fits the window/);
    assert.equal(sizeToggle.attributes["aria-pressed"], undefined,
      "The changing-label toolbar action must not also present itself as a pressed-state toggle");
  }
  sizeToggle.listeners.click();
  assertZoomState(true);
  imageButton.listeners.click();
  assertZoomState(false);
  imageButton.listeners.click();
  assertZoomState(true);
  sizeToggle.listeners.click();
  assertZoomState(false);

  const failedImage = await openPreview({ session: { [key]: payload } });
  assert.equal(failedImage.elements.get("size-toggle").hidden, false);
  failedImage.elements.get("preview-image").listeners.error();
  assert.equal(failedImage.elements.get("size-toggle").hidden, true, "An image error must remove its unavailable zoom action");
  assert.equal(failedImage.elements.get("image-button").hidden, true);
  assert.equal(failedImage.elements.get("preview-stage").attributes["aria-busy"], "false");
  assert.match(failedImage.elements.get("error-message").textContent, /could not load this image/);

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
  assert.equal(expired.elements.get("size-toggle").hidden, true, "An expired preview must not offer image zoom");

  const invalidSource = await openPreview({ session: { [key]: { ...payload, sourceUrl: "javascript:alert(1)" } } });
  assert.equal(invalidSource.elements.get("source-link").hidden, true);
  const wrongId = await openPreview({ cache: new Map([["imagePreview", JSON.stringify({ id: "other-preview", payload })]]) });
  assert.match(wrongId.elements.get("error-message").textContent, /expired/, "A tab cache must never serve a different preview id");
  const future = await openPreview({ session: { [key]: { ...payload, createdAt: now + 60001 } } });
  assert.match(future.elements.get("error-message").textContent, /expired/);

  const video = await openPreview({ session: { [key]: { ...payload, url: "https://cdn.example.test/clip.mp4", mediaType: "video" } } });
  assert.equal(video.elements.get("preview-video").src, "https://cdn.example.test/clip.mp4");
  assert.equal(video.elements.get("preview-video").hidden, false);
  assert.equal(video.elements.get("size-toggle").hidden, true, "Video previews use their native controls instead of image zoom");
  assert.equal(video.elements.get("image-button").hidden, true);
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
