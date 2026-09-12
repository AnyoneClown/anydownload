"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Core = require("../extension/shared/core.js");
const Filters = require("../extension/shared/filters.js");
const Templates = require("../extension/shared/templates.js");

class Element {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.value = "";
    this.textContent = "";
    this.dataset = {};
    this.children = [];
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
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  append(...children) {
    this.children.push(...children);
    for (const child of children) child.parentElement = this;
  }
  appendChild(child) { this.append(child); }
  replaceChildren(...children) { this.children = children; }
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
  focus() { this.focused = true; }
  showPopover() { this.open = true; }
  hidePopover() { this.open = false; }
}

const html = fs.readFileSync(path.join(__dirname, "../extension/popup/popup.html"), "utf8");
const nodes = new Map();
for (const [tag, id] of Array.from(html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g), match => [match[0], match[1]])) {
  assert.ok(!nodes.has(id), `Duplicate popup ID: ${id}`);
  const node = new Element();
  node.value = /\bvalue="([^"]*)"/.exec(tag)?.[1] || "";
  node.hidden = /\bhidden\b/.test(tag);
  node.checked = /\bchecked\b/.test(tag);
  nodes.set(id, node);
}
const saved = {};
const previewSession = {};
const openedTabs = [];
const settingsMessages = [];
const context = vm.createContext({
  URL, URLSearchParams, console,
  crypto: require("node:crypto").webcrypto,
  location: { href: "moz-extension://test/popup/popup.html?sourceTabId=7" },
  ImageDownloaderCore: Core,
  ImageDownloaderFilters: Filters,
  ImageDownloaderTemplates: Templates,
  AnyDownloadTracker: require("../extension/shared/tracker.js"),
  AnyDownloadGallery: require("../extension/shared/gallery.js"),
  setTimeout: () => 1, clearTimeout() {}, addEventListener() {},
  browser: {
    storage: {
      local: { set: async value => Object.assign(saved, value) },
      session: { set: async value => Object.assign(previewSession, value) }
    },
    runtime: {
      getURL: file => `moz-extension://test/${file}`,
      sendMessage: async message => {
        settingsMessages.push(message);
        assert.equal(message.type, "CLOUD_LOCAL_WRITE");
        if (message.action === "set") Object.assign(saved, message.values);
        else for (const key of [].concat(message.keys)) delete saved[key];
        return { ok: true };
      }
    },
    tabs: { create: async properties => openedTabs.push(properties) }
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
    updateSummary, renderImages, makeImageRow, requireValidFilenameTemplate, requestDownloads, focusIgnoredToggle, persistSettings, ignoreStorageArea, handleSettingsStorageChanges, state, elements };
${entry}`);
vm.runInContext(source, context);
const ui = context.ui;
ui.cacheElements();
assert.equal(ui.state.incognito, true, "Settings writes start disabled until the source context is known");
ui.state.incognito = false;
ui.applySmartFiltersToControls(Filters.DEFAULT_FILTERS);
ui.wireEvents();
const get = id => nodes.get(id);

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
assert.match(get("action-detail").textContent, /includes files hidden/);
assert.equal(ui.state.selected.size, 2, "Searching must preserve existing selections");

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
get("select-none-button").click();
assert.equal(ui.state.selected.size, 0, "Deselect matches must work during a live scan");
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

previewButton.listeners.click().then(async () => {
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
  assert.deepEqual([...ui.state.selected], [first.url, second.url], "Preview must preserve download selection");
  console.log("Popup UI tests passed: card selection, preview buttons, layout, filters, validation, and navigation.");
}).catch(error => { console.error(error); process.exitCode = 1; });
