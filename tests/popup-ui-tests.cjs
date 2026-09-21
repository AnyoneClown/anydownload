"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Core = require("../extension/shared/core.js");
const Filters = require("../extension/shared/filters.js");
const Templates = require("../extension/shared/templates.js");
const Immich = require("../extension/shared/immich.js");
const Integrations = require("../extension/shared/integrations.js");
const integrationOwner = "11111111-1111-4111-8111-111111111111";
const integrationConnection = {
  id: "22222222-2222-4222-8222-222222222222", provider: "immich",
  serverUrl: "https://immich.example", defaultAlbumId: null
};
const integrationAlbum = "33333333-3333-4333-8333-333333333333";
const PickerImmich = { ...Immich, listAlbums: async () => [{ id: integrationAlbum, name: "Camera roll" }] };
const browserEvent = () => ({ addListener() {}, removeListener() {} });

class Element {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.value = "";
    this.textContent = "";
    this.dataset = {};
    this.children = [];
    this.isConnected = true;
    this.attributes = {};
    this.listeners = {};
    const classes = new Set();
    this.classList = {
      add: name => classes.add(name),
      remove: name => classes.delete(name),
      toggle(name, enabled) {
        if (enabled) classes.add(name);
        else classes.delete(name);
      }
    };
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  get src() { return this.attributes.src || ""; }
  set src(value) { this.attributes.src = value; this.srcWrites = (this.srcWrites || 0) + 1; }
  remove() { this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.isConnected = false; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  append(...children) {
    this.children.push(...children);
    for (const child of children) child.parentElement = this;
  }
  appendChild(child) { this.append(child); }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [
      ...(selector.split(",").map(tag => tag.trim().toUpperCase()).includes(child.tagName) ? [child] : []),
      ...child.querySelectorAll(selector)
    ]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  matches(selector) { return selector === ":popover-open" && this.open === true; }
  closest(selector) {
    return selector.split(", ").includes(this.tagName.toLowerCase())
      ? this : this.parentElement?.closest(selector) || null;
  }
  click() {
    if (this.disabled) return;
    if (this.type === "checkbox") this.checked = !this.checked;
    for (let node = this; node; node = node.parentElement) {
      node.listeners.click?.({ target: this });
    }
    if (this.type === "checkbox") this.listeners.change?.();
  }
  focus() { this.focused = true; context.document.activeElement = this; }
  showPopover() { this.open = true; }
  hidePopover() { this.open = false; }
  showModal() { this.open = true; }
  close() { this.open = false; this.listeners.close?.(); }
  pause() { this.paused = true; }
  load() { this.reloaded = true; }
}

const html = fs.readFileSync(path.join(__dirname, "../extension/popup/popup.html"), "utf8");
const nodes = new Map();
for (const [tag, id] of Array.from(html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g), match => [match[0], match[1]])) {
  assert.ok(!nodes.has(id), `Duplicate popup ID: ${id}`);
  const node = new Element(/^<(\w+)/.exec(tag)[1]);
  node.value = /\bvalue="([^"]*)"/.exec(tag)?.[1] || "";
  node.hidden = /\bhidden\b/.test(tag);
  node.checked = /\bchecked\b/.test(tag);
  nodes.set(id, node);
}
for (const match of html.matchAll(/<select[^>]+id="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
  const select = nodes.get(match[1]);
  select.options = Array.from(match[2].matchAll(/<option[^>]+value="([^"]*)"[^>]*>/g), option => ({ value: option[1] }));
  select.value = select.options[0]?.value || "";
}
const saved = {};
const previewSession = {};
const openedTabs = [];
const settingsMessages = [];
const downloadMessages = [];
const Telegram = require("../extension/shared/telegram.js");
const telegramTransfers = [];
const revokedPreviews = [];
class PreviewURL extends URL {}
PreviewURL.createObjectURL = () => "blob:extension-preview";
PreviewURL.revokeObjectURL = (url) => revokedPreviews.push(url);
const telegramApi = { ...Telegram, transfer: async (_browser, task, incognito, _validate, signal) => {
  telegramTransfers.push({ task, incognito, signal });
  if (signal.aborted) throw new Error("cancelled");
  return new Blob(["fixture"], { type: "video/mp4" });
} };
const context = vm.createContext({
  URL: PreviewURL, URLSearchParams, console, AbortController,
  AnyDownloadTelegram: telegramApi, ImageDownloaderImageFetch: { mediaBlob() {} },
  crypto: require("node:crypto").webcrypto,
  location: { href: "moz-extension://test/popup/popup.html?sourceTabId=7" },
  ImageDownloaderCore: Core,
  ImageDownloaderFilters: Filters,
  ImageDownloaderTemplates: Templates,
  ImageDownloaderImmich: PickerImmich,
  AnyDownloadIntegrations: Integrations,
  AnyDownloadTracker: require("../extension/shared/tracker.js"),
  AnyDownloadGallery: require("../extension/shared/gallery.js"),
  setTimeout: () => 1, clearTimeout() {}, addEventListener() {},
  browser: {
    storage: {
      local: { get: async () => saved, set: async value => Object.assign(saved, value) },
      session: { get: async () => previewSession, set: async value => Object.assign(previewSession, value),
        remove: async key => { delete previewSession[key]; } },
      onChanged: browserEvent()
    },
    runtime: {
      id: "test-extension",
      onMessage: browserEvent(),
      getURL: file => `moz-extension://test/${file}`,
      sendMessage: async message => {
        if (message.type === "INTEGRATIONS") {
          if (message.action === "status") return { ok: true, signedIn: true, ownerId: integrationOwner, email: "owner@example.com" };
          if (message.action === "list") return { ok: true, connections: [integrationConnection] };
          if (message.action === "credential") return { ok: true, ownerId: integrationOwner,
            connection: integrationConnection, apiKey: "test-key" };
        }
        if (message.type === "DOWNLOAD_BATCH") {
          downloadMessages.push(message);
          return { ok: true, queued: message.items.length, failed: 0, total: message.items.length };
        }
        if (message.type === "GET_MEDIA_DOWNLOAD_STATUS") return {
          ok: true, statuses: message.items.map(() => ({ status: "new" }))
        };
        if (message.type === "GET_DOWNLOAD_DASHBOARD") return { ok: true, snapshot: { summary: {} } };
        settingsMessages.push(message);
        assert.equal(message.type, "CLOUD_LOCAL_WRITE");
        if (message.action === "set") Object.assign(saved, message.values);
        else for (const key of [].concat(message.keys)) delete saved[key];
        return { ok: true };
      }
    },
    tabs: { create: async properties => openedTabs.push(properties), getCurrent: async () => ({ incognito: false }) },
    permissions: { request: async () => true, contains: async () => true, onRemoved: browserEvent() }
  },
  document: {
    documentElement: new Element(),
    getElementById(id) {
      assert.ok(nodes.has(id), `Missing popup element: ${id}`);
      return nodes.get(id);
    },
    createElement: tagName => new Element(tagName),
    createDocumentFragment: () => new Element(),
    addEventListener() {}
  }
});
let source = fs.readFileSync(path.join(__dirname, "../extension/popup/popup.js"), "utf8");
// Exercise the real UI functions without starting Firefox's page scanner.
const entry = '  document.addEventListener("DOMContentLoaded", () => {';
assert.ok(source.includes(entry));
source = source.replace(entry, `  globalThis.ui = { cacheElements, wireEvents, applyMediaView, applySmartFiltersToControls,
    updateSummary, renderImages, makeImageRow, requireValidFilenameTemplate, requestDownloads, finishArchiveDownload,
    filteredImages, selectedDownloadableImages, resetMediaFilters, openGalleryPreview, openImagePreview,
    moveGalleryPreview, initializeTrackerEditor, saveTracker, focusIgnoredToggle, persistSettings, ignoreStorageArea,
    handleSettingsStorageChanges, showWorkspace, setIncognitoContext, state, elements };
${entry}`);
vm.runInContext(source, context);
const ui = context.ui;
ui.cacheElements();
assert.equal(ui.state.incognito, true, "Settings writes start disabled until the source context is known");
ui.state.incognito = false;
ui.applySmartFiltersToControls(Filters.DEFAULT_FILTERS);
ui.wireEvents();
const get = id => nodes.get(id);

get("tracker-panel").showPopover();
get("tracker-panel").listeners.toggle();
assert.equal(get("tracker-interval-select").focused, true, "Opening tracking focuses the schedule");
assert.equal(get("tracker-button").attributes["aria-expanded"], "true");
get("tracker-panel").hidePopover();
get("tracker-panel").listeners.toggle();
assert.equal(get("tracker-button").attributes["aria-expanded"], "false", "Closing tracking resets its button");

get("list-view-button").listeners.click();
assert.equal(get("image-list").dataset.view, "list");
assert.equal(get("list-view-button").attributes["aria-pressed"], "true");
assert.equal(get("grid-view-button").attributes["aria-pressed"], "false");
assert.equal(saved.mediaLayout, "list");
ui.applyMediaView("unexpected stored value");
assert.equal(get("image-list").dataset.view, "grid");
assert.equal(get("grid-view-button").attributes["aria-pressed"], "true");

const first = { url: "https://photos.example/lake.jpg", width: 1000, height: 600, kinds: ["image"] };
const second = { url: "https://photos.example/forest.jpg", width: 1000, height: 600, kinds: ["image"] };
ui.state.images = [first, second];
ui.state.selected.add(first.url);
ui.state.selected.add(second.url);
get("filter-input").value = "lake";
ui.updateSummary();
assert.equal(get("selected-label").textContent, "2 selected · 1 hidden");
assert.equal(get("download-button").textContent, "Download 2 files");
assert.match(get("selection-warning").textContent, /includes 1 files hidden/);
assert.equal(ui.state.selected.size, 2, "Searching must preserve existing selections");

const workspaceButtons = {
  media: "media-button", history: "history-button", tracking: "tracking-dashboard-button",
  integrations: "integrations-button", sync: "sync-button"
};
const workspaceFrame = get("workspace-frame");
for (const view of ["history", "tracking", "integrations", "sync", "media"]) {
  get(workspaceButtons[view]).click();
  assert.equal(ui.state.workspace, view, `${view} opens in the popup workspace`);
  assert.equal(get("media-workspace").hidden, view !== "media");
  assert.equal(workspaceFrame.hidden, view === "media");
  for (const [name, id] of Object.entries(workspaceButtons)) {
    assert.equal(get(id).getAttribute("aria-current") === "page", name === view,
      "Only the visible workspace is marked current");
  }
  if (view === "media") {
    assert.equal(workspaceFrame.getAttribute("src"), null, "Returning to Media unloads the dashboard");
  } else {
    const url = new URL(workspaceFrame.src);
    assert.equal(url.pathname, `/${view}/${view}.html`);
    assert.equal(url.searchParams.get("embedded"), "1");
    assert.equal(url.searchParams.get("sourceTabId"), "7", "Dashboard navigation retains the scanned tab");
    const writes = workspaceFrame.srcWrites;
    get(workspaceButtons[view]).click();
    assert.equal(workspaceFrame.srcWrites, writes, "Clicking the current section preserves its form state");
  }
  assert.equal(openedTabs.length, 0, "Workspace navigation never opens an external tab");
  assert.deepEqual([...ui.state.selected], [first.url, second.url], "Switching workspaces preserves media selection");
  assert.equal(get("filter-input").value, "lake", "Switching workspaces preserves the media search");
}
context.AnyDownloadWorkspace.editTracker("tracker-7");
assert.equal(ui.state.workspace, "tracking", "Editing a tracker stays in its workspace");
assert.equal(new URL(workspaceFrame.src).pathname, "/popup/popup.html");
assert.equal(new URL(workspaceFrame.src).searchParams.get("editTrackerId"), "tracker-7");
get("tracking-dashboard-button").click();
assert.equal(new URL(workspaceFrame.src).pathname, "/tracking/tracking.html", "The Trackers button returns from its editor");
get("media-button").click();
for (const view of ["unexpected", "__proto__", "https://unexpected.example"]) {
  ui.showWorkspace(view);
  assert.equal(ui.state.workspace, "media", "Only known extension workspaces can be embedded");
}
get("integrations-button").click();
ui.setIncognitoContext(true);
assert.equal(ui.state.workspace, "media", "A private-context switch immediately closes account integrations");
assert.equal(workspaceFrame.getAttribute("src"), null, "Private browsing unloads the protected document");
for (const view of ["tracking", "sync", "integrations"]) {
  ui.showWorkspace(view);
  assert.equal(ui.state.workspace, "media", "Private restrictions cannot be bypassed by invoking navigation");
}
get("history-button").click();
assert.equal(ui.state.workspace, "history", "Private download history remains accessible");
const historyWrites = workspaceFrame.srcWrites;
ui.setIncognitoContext(false);
assert.ok(workspaceFrame.srcWrites > historyWrites, "Download history reloads when its privacy context changes");
get("media-button").click();

get("smart-filter-panel").open = true;
get("smart-filter-panel").listeners.toggle();
assert.equal(get("smart-filters-button").attributes["aria-expanded"], "true");
get("filter-input").value = "no matching media";
ui.renderImages();
const empty = get("image-list").children[0];
assert.equal(empty.children[0].textContent, "No matching media");
const reset = empty.children.find(child => child.textContent === "Clear filters");
assert.ok(reset, "An empty search must offer recovery");
reset.listeners.click();
assert.equal(get("filter-input").value, "");
assert.equal(get("filter-input").focused, true);
assert.equal(get("smart-filter-panel").open, false);
ui.focusIgnoredToggle();
assert.equal(get("smart-filters-button").focused, true, "Ignore actions must focus a visible control");
assert.equal(get("selected-label").textContent, "2 selected");
assert.equal(ui.state.selected.size, 2, "Resetting filters must not silently select or deselect media");

ui.state.selected.clear();
const row = ui.makeImageRow(first);
const [checkbox, thumbnail, copy, actions] = row.children;
thumbnail.children[0].click();
assert.equal(ui.state.selected.has(first.url), true, "Clicking the image selects it for download");
copy.children[0].children[0].click();
assert.equal(ui.state.selected.has(first.url), false, "Clicking card text toggles selection");
row.click();
assert.equal(checkbox.checked, true, "Clicking card whitespace toggles its checkbox");
checkbox.click();
assert.equal(ui.state.selected.has(first.url), false, "The checkbox must toggle only once");
for (const button of actions.children) {
  row.listeners.click({ target: button });
  assert.equal(checkbox.checked, false, "Card buttons must not toggle selection");
}
const previewButton = actions.children[0];
assert.equal(previewButton.tagName, "BUTTON");
assert.equal(previewButton.textContent, "Preview");
assert.equal(thumbnail.tagName, "DIV");
assert.equal(openedTabs.length, 0, "Card clicks must not open previews");

first.downloadStatus = "queued";
ui.makeImageRow(first).click();
assert.equal(ui.state.selected.size, 0, "Queued cards cannot be selected");
delete first.downloadStatus;
ui.state.busy = true;
row.click();
assert.equal(ui.state.selected.size, 0, "Cards rendered before a download starts must also refuse selection");
assert.equal(checkbox.checked, false, "A refused checkbox change must restore its checked state");
const busyRow = ui.makeImageRow(first);
busyRow.click();
assert.equal(ui.state.selected.size, 0, "Busy cards cannot be selected");
assert.equal(busyRow.children[3].children[0].disabled, true);
ui.state.liveScanning = true;
ui.state.selected.add(second.url);
get("filter-input").value = "lake";
ui.updateSummary();
assert.equal(get("select-all-button").textContent, "Select matches only");
get("select-all-button").click();
assert.deepEqual([...ui.state.selected], [first.url], "Select matches must work during a live scan and clear hidden selections");
assert.equal(get("download-button").disabled, true, "Downloads still wait for a live scan to finish");
ui.state.selected.add(second.url);
ui.updateSummary();
assert.equal(get("select-none-button").textContent, "Deselect");
get("select-none-button").click();
assert.equal(ui.state.selected.size, 0, "Deselect clears visible and filtered-out selections during a live scan");
const liveRow = ui.makeImageRow(first);
liveRow.click();
assert.equal(ui.state.selected.has(first.url), true, "Cards rendered during a live scan remain selectable");
liveRow.children[0].click();
assert.equal(ui.state.selected.size, 0);
get("filter-input").value = "";
ui.state.liveScanning = false;
ui.state.busy = false;
ui.state.ignoredKeys.add(Core.ignoreKeyForUrl(first.url));
const ignoredRow = ui.makeImageRow(first);
ignoredRow.click();
assert.equal(ui.state.selected.size, 0, "Ignored cards must be restored before selecting");
assert.equal(ignoredRow.children[2].children[0].textContent, "Preview");
ui.state.ignoredKeys.clear();
first.downloadStatus = "downloaded";
first.downloadFingerprint = "completed-image";
const completedRow = ui.makeImageRow(first);
completedRow.click();
assert.equal(ui.state.explicitRedownloads.has(first.downloadFingerprint), true);
completedRow.click();
assert.equal(ui.state.explicitRedownloads.size, 0);
assert.equal(ui.state.selected.size, 0);
delete first.downloadStatus;
delete first.downloadFingerprint;
ui.state.selected.add(first.url);
ui.state.selected.add(second.url);

get("filename-template-input").value = "{not-a-token}";
assert.equal(ui.requireValidFilenameTemplate(), null);
assert.equal(get("download-settings-panel").open, true, "Invalid settings must be revealed before focusing them");
assert.equal(get("filename-template-input").focused, true);
assert.equal(get("download-button").disabled, true);

get("filename-template-input").value = Templates.DEFAULT_TEMPLATE;
get("folder-input").value = "../outside";
get("download-settings-panel").open = false;
ui.requestDownloads([first]);
assert.equal(get("download-settings-panel").open, true);
assert.equal(get("folder-input").focused, true);
ui.updateSummary();
assert.equal(get("download-button").disabled, true);
assert.match(get("action-detail").textContent, /folder|path|\.\./i);

const navigation = fs.readFileSync(path.join(__dirname, "../extension/shared/navigation.js"), "utf8");
for (const sourceId of ["7", "", "-1", "3.5", "9007199254740992", "https://unexpected.example"]) {
  const link = { href: "moz-extension://test/popup/popup.html", hidden: true };
  vm.runInNewContext(navigation, {
    URL, location: { href: `moz-extension://test/history/history.html?sourceTabId=${encodeURIComponent(sourceId)}` },
    document: { querySelectorAll: () => [link] }
  });
  assert.equal(link.hidden, sourceId !== "7");
  assert.equal(new URL(link.href).searchParams.get("sourceTabId"), sourceId === "7" ? "7" : null);
}
for (const embedded of [false, true]) {
  const links = [
    ["moz-extension://test/popup/popup.html", "media"],
    ...["history", "tracking", "sync", "integrations"].map(view => [`moz-extension://test/${view}/${view}.html`, view]),
    ["moz-extension://test/upload/upload.html?job=job-12345", "upload"],
    ["moz-extension://test/tracking/history.html", null],
    ["moz-extension://another-extension/sync/sync.html", null],
    ["https://test/sync/sync.html", null]
  ].map(([href, view]) => Object.assign(new Element("a"), { href, view }));
  const classes = [];
  const opened = [];
  vm.runInNewContext(navigation, {
    URL, location: { href: `moz-extension://test/tracking/tracking.html?embedded=${Number(embedded)}` },
    parent: { AnyDownloadWorkspace: { open: (view, route) => opened.push([view, route]) } },
    document: { querySelectorAll: () => links, documentElement: { classList: { add: name => classes.push(name) } } }
  });
  assert.deepEqual(classes, embedded ? ["embedded-workspace"] : []);
  for (const link of links) {
    let prevented = false;
    link.listeners.click?.({ preventDefault() { prevented = true; } });
    assert.equal(prevented, embedded && Boolean(link.view),
      "Only known same-extension destinations may route through an embedded workspace");
  }
  assert.deepEqual(opened, embedded ? [
    ["media", ""], ["history", ""], ["tracking", ""], ["sync", ""], ["integrations", ""],
    ["upload", "?job=job-12345"]
  ] : [],
    "Embedded navigation works without a source tab and updates the persistent sidebar");
}

(async () => {
  previewButton.focus();
  previewButton.listeners.click();
  assert.equal(get("media-preview-dialog").open, true, "Preview opens inside the gallery");
  assert.equal(openedTabs.length, 0);
  assert.equal(get("media-preview-stage").children[0].src, first.url);
  get("media-preview-dialog").listeners.keydown({ key: "ArrowRight", target: get("preview-selected-input"), preventDefault() {} });
  assert.equal(get("media-preview-stage").children[0].src, first.url, "Arrow keys on form controls must keep their native behavior");
  assert.equal(get("media-preview-position").textContent, "1 of 2");
  assert.equal(get("preview-previous-button").disabled, true);
  get("preview-next-button").listeners.click();
  assert.equal(get("media-preview-stage").children[0].src, second.url);
  assert.equal(get("preview-next-button").disabled, true);
  get("media-preview-dialog").listeners.keydown({ key: "ArrowLeft", target: get("close-preview-button"), preventDefault() {} });
  assert.equal(get("media-preview-stage").children[0].src, first.url);
  get("preview-selected-input").checked = false;
  get("preview-selected-input").listeners.change();
  assert.equal(ui.state.selected.has(first.url), false);
  get("preview-selected-input").checked = true;
  get("preview-selected-input").listeners.change();
  assert.equal(ui.state.selected.has(first.url), true);
  get("close-preview-button").listeners.click();
  assert.equal(get("media-preview-dialog").open, false);
  assert.equal(context.document.activeElement, previewButton, "Closing preview restores keyboard focus to its opener");
  ui.state.pageUrl = "https://photos.example/gallery";
  await ui.openImagePreview(first);
  const writesBeforePrivate = settingsMessages.length;
  ui.state.incognito = true;
  await ui.persistSettings({ filenameTemplate: "private-{name}.{ext}", destinationFolder: "private" });
  get("list-view-button").listeners.click();
  get("ask-single-input").listeners.change();
  get("backgrounds-input").listeners.change();
  assert.equal(settingsMessages.length, writesBeforePrivate, "Private settings must never reach cloud/local persistence");
  await ui.ignoreStorageArea(true).set({ privateRule: 1 });
  assert.equal(previewSession.privateRule, 1);
  assert.equal(settingsMessages.length, writesBeforePrivate, "Private ignores must stay in session storage");
  ui.state.incognito = false;
  context.browser.extension = { inIncognitoContext: true };
  await ui.persistSettings({ filenameTemplate: "still-private-{name}.{ext}" });
  assert.equal(settingsMessages.length, writesBeforePrivate, "Firefox's private extension context also prevents persistence");
  context.browser.extension.inIncognitoContext = false;
  await ui.persistSettings({ filenameTemplate: Templates.DEFAULT_TEMPLATE });
  assert.equal(settingsMessages.at(-1).type, "CLOUD_LOCAL_WRITE");
  await ui.ignoreStorageArea(false).set({ normalRule: 1 });
  await ui.ignoreStorageArea(false).remove("normalRule");
  assert.equal(saved.normalRule, undefined);
  assert.equal(settingsMessages.at(-1).action, "remove", "Ignore removal must use the same background lock as sync");
  assert.deepEqual(Array.from(settingsMessages.at(-1).keys), ["normalRule"], "Single-item Restore sends the background's key-array format");
  get("filename-template-input").value = "edited-{name}.{ext}";
  ui.handleSettingsStorageChanges({ filenameTemplate: { oldValue: Templates.DEFAULT_TEMPLATE, newValue: "cloud-{name}.{ext}" } }, "local");
  assert.equal(get("filename-template-input").value, "edited-{name}.{ext}", "Incoming sync must preserve an unsaved template edit");
  get("filename-template-input").value = Templates.DEFAULT_TEMPLATE;
  ui.handleSettingsStorageChanges({ filenameTemplate: { oldValue: Templates.DEFAULT_TEMPLATE, newValue: "cloud-{name}.{ext}" } }, "local");
  assert.equal(get("filename-template-input").value, "cloud-{name}.{ext}", "Unedited settings update in open managers");
  assert.equal(openedTabs.length, 1);
  const id = new URL(openedTabs[0].url).searchParams.get("id");
  assert.equal(previewSession[`imagePreview:${id}`].url, first.url);
  assert.equal(previewSession[`imagePreview:${id}`].sourceUrl, ui.state.pageUrl);
  assert.equal(previewSession[`imagePreview:${id}`].sourceTabId, 7);
  assert.deepEqual(new Set(ui.state.selected), new Set([first.url, second.url]), "Preview must preserve download selection");

  const clip = { url: "https://photos.example/clip.mp4", width: 1920, height: 1080, mediaType: "video" };
  ui.state.images = [first, second, clip];
  ui.state.selected.clear();
  for (const image of ui.state.images) ui.state.selected.add(image.url);
  const selectedBeforeFilters = [...ui.state.selected];
  get("media-type-filter-select").value = "video";
  get("media-type-filter-select").listeners.change();
  assert.deepEqual(Array.from(ui.filteredImages(), item => item.url), [clip.url]);
  assert.deepEqual([...ui.state.selected], selectedBeforeFilters, "Media-type filters preserve hidden selections");
  get("min-width-input").value = "2500";
  get("min-width-input").listeners.change();
  assert.equal(ui.filteredImages().length, 0);
  assert.deepEqual(Array.from(ui.selectedDownloadableImages(), item => item.url), selectedBeforeFilters);
  get("selected-label").listeners.click();
  assert.equal(ui.state.showSelected, true);
  assert.equal(get("selected-label").attributes["aria-pressed"], "true");
  assert.equal(ui.filteredImages().length, 3, "Review selected must reveal every selected file despite the filters");
  get("back-to-collection-button").listeners.click();
  assert.equal(ui.state.showSelected, false);
  assert.equal(ui.filteredImages().length, 0, "Returning to the collection preserves its filters");
  ui.resetMediaFilters();

  first.instagramCollections = [{ type: "post", id: "post-one" }];
  second.instagramCollections = [{ type: "story", id: "story-two" }];
  get("instagram-collection-filter-select").value = "story";
  get("instagram-collection-filter-select").listeners.change();
  assert.deepEqual(Array.from(ui.filteredImages(), item => item.url), [second.url]);
  assert.deepEqual([...ui.state.selected], selectedBeforeFilters, "Instagram collection filters preserve selections");
  ui.resetMediaFilters();
  first.downloadStatus = "downloaded";
  first.downloadFingerprint = "completed-first";
  ui.state.explicitRedownloads.add(first.downloadFingerprint);
  get("downloaded-button").listeners.click();
  assert.equal(ui.filteredImages().some(item => item.url === first.url), false);
  assert.equal(ui.state.selected.has(first.url), true, "Hide downloaded must preserve deliberate redownload selections");
  assert.equal(ui.state.explicitRedownloads.has(first.downloadFingerprint), true);
  ui.resetMediaFilters();
  delete first.downloadStatus;
  delete first.downloadFingerprint;
  ui.state.explicitRedownloads.clear();

  ui.state.pageUrl = "https://photos.example/scope-gallery";
  first.pageUrl = `${ui.state.pageUrl}#photo-1`;
  second.pageUrl = "https://photos.example/older-gallery";
  clip.pageUrl = ui.state.pageUrl;
  assert.deepEqual(Array.from(ui.filteredImages(), item => item.url), [first.url, second.url, clip.url],
    "One collection retains media from this website's previous pages");
  assert.deepEqual([...ui.state.selected], selectedBeforeFilters);
  get("sort-select").value = "name";
  get("sort-select").listeners.change();
  assert.deepEqual(Array.from(ui.filteredImages(), item => item.url), [clip.url, second.url, first.url]);
  get("sort-select").value = "resolution";
  get("sort-select").listeners.change();
  assert.equal(ui.filteredImages()[0].url, clip.url);
  assert.deepEqual(Array.from(ui.state.images, item => item.url), [first.url, second.url, clip.url],
    "Sorting the view must not change page discovery order");

  ui.state.sort = "page";
  ui.state.images = Array.from({ length: 701 }, (_, index) => ({ ...first, url: `https://photos.example/${index}.jpg` }));
  ui.state.selected.clear();
  ui.state.galleryPage = 0;
  ui.renderImages();
  const rows = () => get("image-list").children.flatMap(node => node.tagName === "ARTICLE" ? [node] : node.children.filter(child => child.tagName === "ARTICLE"));
  assert.equal(rows().length, 350);
  assert.equal(get("gallery-pagination").hidden, false);
  assert.equal(get("previous-page-button").disabled, true);
  get("next-page-button").listeners.click();
  assert.equal(ui.state.galleryPage, 1);
  assert.equal(rows().length, 350);
  get("next-page-button").listeners.click();
  assert.equal(ui.state.galleryPage, 2);
  assert.equal(rows().length, 1, "The final page makes items beyond the rendering limit browsable");
  rows()[0].children[0].checked = true;
  rows()[0].children[0].listeners.change();
  assert.equal(ui.state.selected.has(ui.state.images[700].url), true);
  assert.equal(get("next-page-button").disabled, true);
  get("previous-page-button").listeners.click();
  assert.equal(ui.state.selected.size, 1, "Paging preserves selection");
  get("min-width-input").value = "1200";
  get("min-width-input").listeners.change();
  assert.equal(ui.state.galleryPage, 0, "Changing filters resets pagination");

  ui.resetMediaFilters();
  ui.state.images = [first, second];
  ui.state.selected.clear();
  ui.state.selected.add(first.url);
  ui.state.selected.add(second.url);
  get("folder-input").value = "Website media";
  get("filename-template-input").value = Templates.DEFAULT_TEMPLATE;
  get("media-type-filter-select").value = "video";
  get("media-type-filter-select").listeners.change();
  await ui.finishArchiveDownload(ui.selectedDownloadableImages(), { value: "Website media" }, Promise.resolve(true), Templates.DEFAULT_TEMPLATE);
  const archive = Object.entries(previewSession).find(([key]) => key.startsWith("archiveJobRequest:"))?.[1];
  assert.ok(archive, "Filtered selections must still create an archive");
  assert.deepEqual(Array.from(archive.items, item => item.url), [first.url, second.url]);
  await ui.requestDownloads(ui.selectedDownloadableImages());
  assert.deepEqual(Array.from(downloadMessages.at(-1).items, item => item.url), [first.url, second.url],
    "Downloads must enqueue selected files hidden by any view filter");
  ui.openGalleryPreview(first);
  get("preview-download-button").listeners.click();
  await new Promise(setImmediate);
  assert.equal(get("media-preview-dialog").open, false);
  assert.deepEqual(Array.from(downloadMessages.at(-1).items, item => item.url), [first.url],
    "The preview Download action queues its current media file");

  ui.state.images = [clip];
  ui.openGalleryPreview(clip);
  const playing = get("media-preview-stage").children[0];
  assert.equal(playing.tagName, "VIDEO");
  assert.equal(playing.controls, true);
  get("close-preview-button").listeners.click();
  assert.equal(playing.paused, true, "Closing an inline video must stop playback");
  assert.equal(playing.src, "");
  assert.equal(playing.reloaded, true, "Closing video must release its media connection");

  const telegramClip = { ...clip, url: "https://web.telegram.org/k/?anydownload_telegram=1&peer=-123&mid=2&id=777&kind=video",
    pageUrl: "https://web.telegram.org/k/#-123", filename: "holiday.mp4", mimeType: "video/mp4", sourceProvider: "telegram" };
  ui.state.images = [telegramClip];
  ui.openGalleryPreview(telegramClip);
  const telegramPlayer = get("media-preview-stage").children[0];
  assert.equal(telegramPlayer.tagName, "VIDEO", "Telegram files must use a playable video element");
  assert.equal(telegramPlayer.controls, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(telegramPlayer.src, "blob:extension-preview");
  assert.equal(telegramTransfers[0].task.source, telegramClip.pageUrl);
  get("close-preview-button").listeners.click();
  assert.equal(telegramPlayer.paused, true);
  assert.equal(telegramTransfers[0].signal.aborted, true);
  assert.deepEqual(revokedPreviews, ["blob:extension-preview"], "Closing Telegram preview must release transferred bytes");

  ui.resetMediaFilters();
  const signed = [
    { ...first, url: "https://photos.example/signed.jpg?token=old" },
    { ...second, identityKey: "carousel:item-2", url: "https://photos.example/old-path.jpg" }
  ];
  ui.state.images = signed;
  ui.state.selected.clear();
  ui.openGalleryPreview(signed[0]);
  const refreshed = [
    { ...signed[0], url: "https://photos.example/signed.jpg?token=new" },
    { ...signed[1], url: "https://photos.example/new-path.jpg" }
  ];
  ui.state.images = refreshed;
  ui.updateSummary();
  get("preview-selected-input").checked = true;
  get("preview-selected-input").listeners.change();
  assert.deepEqual([...ui.state.selected], [refreshed[0].url], "Preview selection follows a refreshed signed URL");
  await get("preview-tab-button").listeners.click();
  const refreshedPreviewId = new URL(openedTabs.at(-1).url).searchParams.get("id");
  assert.equal(previewSession[`imagePreview:${refreshedPreviewId}`].url, refreshed[0].url,
    "Opening the preview in a tab uses the current media URL");
  get("preview-next-button").listeners.click();
  assert.equal(get("media-preview-dialog").open, true);
  assert.equal(get("media-preview-stage").children[0].src, refreshed[1].url,
    "Next finds the refreshed adapter record by stable identity");
  get("preview-download-button").listeners.click();
  await new Promise(setImmediate);
  assert.deepEqual(Array.from(downloadMessages.at(-1).items, item => item.url), [refreshed[1].url],
    "Preview download uses the latest record after live URL rotation");

  ui.state.images = [clip];
  ui.openGalleryPreview(clip);
  const clearedVideo = get("media-preview-stage").children[0];
  ui.state.images = [];
  ui.renderImages();
  assert.equal(get("media-preview-dialog").open, false, "An external collection clear closes a preview whose record disappeared");
  assert.equal(clearedVideo.paused, true);
  assert.equal(clearedVideo.src, "", "Clearing the collection releases active video playback");

  ui.state.images = [first, clip];
  ui.state.incognito = false;
  first.downloadStatus = "downloaded";
  first.downloadFingerprint = "previous-local-download";
  ui.state.explicitRedownloads.add(first.downloadFingerprint);
  ui.state.selected.add(first.url);
  ui.state.selected.add(clip.url);
  get("filename-template-input").value = "{filename}";
  ui.updateSummary();
  assert.equal(get("upload-button").disabled, false, "Selected images and direct videos are eligible for Immich upload");
  const downloadsBeforeUpload = downloadMessages.length;
  const tabsBeforeUpload = openedTabs.length;
  await get("upload-button").listeners.click();
  assert.equal(get("upload-destination-dialog").open, true, "Upload selected opens an in-widget destination picker");
  assert.equal(ui.state.workspace, "media", "Choosing an album keeps Media selected");
  assert.equal(get("upload-album-select").value, "", "The Immich library is available without loading albums");
  assert.equal(get("upload-album-select").children.some(option => option.value === integrationAlbum), true,
    "Opening Upload selected automatically refreshes writable Immich albums");
  get("upload-album-select").value = integrationAlbum;
  await get("confirm-upload-destination-button").listeners.click();
  assert.equal(ui.state.workspace, "upload", "Confirming the album opens upload progress inside the widget");
  assert.equal(get("media-button").getAttribute("aria-current"), "page", "Upload progress keeps the Media tab selected");
  const uploadUrl = new URL(workspaceFrame.src);
  assert.equal(uploadUrl.pathname, "/upload/upload.html");
  assert.equal(uploadUrl.searchParams.get("embedded"), "1");
  const uploadId = uploadUrl.searchParams.get("request");
  assert.equal(previewSession[`uploadJobRequest:${uploadId}`].items[0].url, first.url);
  assert.equal(previewSession[`uploadJobRequest:${uploadId}`].items.find(item => item.mediaType === "video").url, clip.url);
  assert.equal(previewSession[`uploadJobRequest:${uploadId}`].connectionId, integrationConnection.id);
  assert.equal(previewSession[`uploadJobRequest:${uploadId}`].albumId, integrationAlbum);
  assert.equal(previewSession[`uploadJobRequest:${uploadId}`].autoStart, true);
  assert.equal(openedTabs.length, tabsBeforeUpload, "Upload selected does not open a browser tab");
  assert.equal(downloadMessages.length, downloadsBeforeUpload, "Upload does not enqueue a local download");
  assert.equal(first.downloadStatus, "downloaded", "Upload does not overwrite local completion state");
  const uploadSrcBeforePrivateUpload = workspaceFrame.src;
  ui.state.incognito = true;
  ui.updateSummary();
  assert.equal(get("upload-button").hidden, true);
  await get("upload-button").listeners.click();
  assert.equal(workspaceFrame.src, uploadSrcBeforePrivateUpload);
  ui.state.incognito = false;

  const tracker = context.AnyDownloadTracker.normalizeTracker({
    id: "tracker-editor-001", url: "https://tracked.example/album", pageTitle: "Tracked album",
    folder: "Tracked photos", filenameTemplate: "{filename}", intervalMinutes: 60,
    filters: { ...Filters.DEFAULT_FILTERS, minWidth: 1600, orientation: "landscape" },
    matching: { includeText: "keep", excludeText: "skip", includePatterns: ["*/full/*"], excludePatterns: [], maxDownloadsPerRun: 50 },
    action: "review", enabled: false
  });
  assert.ok(tracker);
  const trackerMessages = [];
  let availableTrackers = [tracker];
  const editorBrowser = {
    ...context.browser,
    extension: { inIncognitoContext: true },
    permissions: { request: async () => true },
    runtime: { ...context.browser.runtime, sendMessage: async message => {
      trackerMessages.push(message);
      if (message.type === "GET_TRACKERS") return { ok: true, trackers: availableTrackers };
      assert.equal(message.type, "UPSERT_TRACKER", "Editing a tracker must not overwrite gallery preferences");
      return { ok: true, tracker: { ...tracker, ...message.tracker } };
    } }
  };
  const editor = vm.createContext({ ...context, browser: editorBrowser,
    location: { href: `moz-extension://test/popup/popup.html?editTrackerId=${tracker.id}` } });
  vm.runInContext(source, editor);
  editor.ui.cacheElements();
  await assert.rejects(editor.ui.initializeTrackerEditor(), /private windows/);
  assert.equal(trackerMessages.length, 0, "Private edit links must not load normal trackers");
  editorBrowser.extension.inIncognitoContext = false;
  get("filter-input").value = "unrelated gallery search";
  await editor.ui.initializeTrackerEditor();
  assert.equal(editor.ui.state.tracker.id, tracker.id);
  assert.equal(editor.ui.state.pageUrl, tracker.url);
  assert.equal(get("folder-input").value, tracker.folder);
  assert.equal(get("min-width-input").value, "1600");
  assert.equal(get("orientation-filter-select").value, "landscape");
  assert.equal(get("tracker-include-text-input").value, "keep");
  get("tracker-interval-select").value = "360";
  await editor.ui.saveTracker();
  const updatedTracker = trackerMessages.find(message => message.type === "UPSERT_TRACKER").tracker;
  assert.equal(updatedTracker.url, tracker.url, "Editing must preserve the tracked page instead of using the current tab");
  assert.equal(updatedTracker.intervalMinutes, 360);
  assert.equal(updatedTracker.filters.minWidth, 1600);
  assert.equal(updatedTracker.filters.orientation, "landscape");
  assert.equal(updatedTracker.query, "keep");
  assert.equal(updatedTracker.matching.excludeText, "skip");
  assert.equal(editor.ui.state.tracker.enabled, false, "Updating a paused tracker must preserve its state");
  availableTrackers = [];
  await assert.rejects(editor.ui.initializeTrackerEditor(), /no longer exists/);
  console.log("Popup UI tests passed: card selection, preview buttons, layout, filters, validation, and navigation.");
})().catch(error => { console.error(error); process.exitCode = 1; });
