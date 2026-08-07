"use strict";

const assert = require("assert").strict;
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const Core = require("../extension/shared/core.js");

function storageArea(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(keys) {
      if (keys == null) {
        return { ...data };
      }
      const names = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(names.filter((name) => name in data).map((name) => [name, data[name]]));
    },
    async set(values) {
      Object.assign(data, values);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        delete data[key];
      }
    }
  };
}

(async () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../extension/background.js"), "utf8");
  const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../extension/manifest.json"), "utf8"));
  const menuEntries = [];
  const downloadRequests = [];
  const createdTabs = [];
  const updatedTabs = [];
  const createdWindows = [];
  const updatedWindows = [];
  const liveWindows = new Map();
  const managerTabs = new Map();
  const sourceTabs = new Map();
  const tabGets = [];
  const scriptingCalls = [];
  const badgeCalls = [];
  const local = storageArea({
    destinationFolder: "Context images/example.test",
    askForSingle: false
  });
  const session = storageArea();
  let menuClicked = null;
  let actionClicked = null;
  let installed = null;
  let runtimeMessage = null;
  let rejectWindowCreates = false;
  let nextWindowId = 81;
  let nextManagerTabId = 181;
  let nextUuid = 1;
  let nextTimer = 1;

  const collector = function contextCollectorFixture() {};
  const browser = {
    action: {
      onClicked: {
        addListener(listener) {
          actionClicked = listener;
        }
      },
      async setBadgeBackgroundColor(details) {
        badgeCalls.push({ type: "color", details });
      },
      async setBadgeText(details) {
        badgeCalls.push({ type: "text", details });
      }
    },
    downloads: {
      onChanged: { addListener() {} },
      async download(details) {
        downloadRequests.push(details);
        return 91;
      },
      async search() {
        return [];
      }
    },
    menus: {
      create(details, callback) {
        menuEntries.push(details);
        if (callback) {
          callback();
        }
        return details.id;
      },
      onClicked: {
        addListener(listener) {
          menuClicked = listener;
        }
      },
      async removeAll() {}
    },
    runtime: {
      lastError: null,
      getURL(relativePath) {
        return `moz-extension://fixture/${relativePath}`;
      },
      onInstalled: {
        addListener(listener) {
          installed = listener;
        }
      },
      onMessage: {
        addListener(listener) {
          runtimeMessage = listener;
        }
      }
    },
    scripting: {
      async executeScript(details) {
        scriptingCalls.push(details);
        return [{
          frameId: 0,
          result: {
            images: [{
              url: "https://cdn.example.test/full/photo.jpg",
              previewUrl: "https://example.test/thumb/photo.jpg",
              alt: "Context photo",
              width: 2400,
              height: 1600,
              kinds: ["Full-size image"]
            }]
          }
        }];
      }
    },
    storage: { local, session },
    tabs: {
      async get(tabId) {
        tabGets.push(tabId);
        const tab = sourceTabs.get(tabId);
        if (!tab) {
          throw new Error("Source tab is stale");
        }
        return tab;
      },
      async create(details) {
        createdTabs.push(details);
        return { id: 52, ...details };
      },
      async update(tabId, details) {
        const windowId = managerTabs.get(tabId);
        if (!Number.isInteger(windowId) || !liveWindows.has(windowId)) {
          throw new Error("Manager tab is stale");
        }
        updatedTabs.push({ tabId, details });
        return { id: tabId, windowId, ...details };
      }
    },
    windows: {
      async create(details) {
        createdWindows.push(details);
        if (rejectWindowCreates) {
          throw new Error("Popup windows are unavailable");
        }
        const windowId = nextWindowId++;
        const tabId = nextManagerTabId++;
        const managerWindow = {
          id: windowId,
          incognito: Boolean(details.incognito),
          type: details.type,
          tabs: [{ id: tabId, windowId }]
        };
        liveWindows.set(windowId, managerWindow);
        managerTabs.set(tabId, windowId);
        return managerWindow;
      },
      async get(windowId) {
        const managerWindow = liveWindows.get(windowId);
        if (!managerWindow) {
          throw new Error("Manager window is stale");
        }
        return managerWindow;
      },
      async update(windowId, details) {
        const managerWindow = liveWindows.get(windowId);
        if (!managerWindow) {
          throw new Error("Manager window is stale");
        }
        updatedWindows.push({ windowId, details });
        return { ...managerWindow, ...details };
      }
    }
  };

  const sandbox = {
    ImageDownloaderCore: Core,
    ImageDownloaderCollector: collector,
    Blob: class BlobFixture {},
    TextEncoder,
    Uint8Array,
    URL,
    atob(value) {
      return Buffer.from(value, "base64").toString("binary");
    },
    browser,
    clearTimeout() {},
    console,
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(nextUuid++).padStart(12, "0")}` },
    setTimeout() {
      return nextTimer++;
    }
  };
  vm.runInNewContext(source, sandbox, { filename: "background.js" });

  assert.equal(manifest.action.default_popup, "popup/popup.html", "Toolbar clicks must open the compact popup");
  assert.doesNotMatch(source, /browser\.action\.openPopup/, "The resizable window must replace action.openPopup");
  assert.equal(menuEntries.length, 0, "MV3 menus must be created from runtime.onInstalled");
  assert.equal(typeof installed, "function");
  await installed();
  assert.equal(menuEntries.length, 6);
  assert.equal(menuEntries[0].id, "anydownload-image-actions");
  assert.ok(menuEntries.every((entry) => entry.contexts.includes("image")));
  assert.equal(actionClicked, null, "A default popup suppresses action.onClicked, so the listener must not be registered");
  assert.equal(typeof menuClicked, "function");
  assert.equal(typeof runtimeMessage, "function");

  const contextInfo = {
    frameId: 0,
    pageUrl: "https://example.test/gallery",
    srcUrl: "https://example.test/thumb/photo.jpg",
    targetElementId: 73
  };
  const tab = {
    id: 41,
    incognito: false,
    url: contextInfo.pageUrl,
    windowId: 7
  };
  sourceTabs.set(tab.id, tab);

  await menuClicked({ ...contextInfo, menuItemId: "anydownload-download-image" }, tab);
  assert.equal(scriptingCalls.length, 1);
  assert.equal(scriptingCalls[0].func, collector);
  assert.equal(scriptingCalls[0].args[0].targetElementId, 73);
  assert.equal(downloadRequests.length, 1);
  assert.equal(downloadRequests[0].url, "https://cdn.example.test/full/photo.jpg");
  assert.equal(downloadRequests[0].filename, "Context images/example.test/photo.jpg");

  await menuClicked({ ...contextInfo, menuItemId: "anydownload-ignore-image" }, tab);
  const ignoredKeys = Object.keys(local.data).filter((key) => key.startsWith("ignoredImage:"));
  assert.equal(ignoredKeys.length, 1);
  assert.ok(ignoredKeys[0].includes(encodeURIComponent("https://example.test")));
  assert.ok(ignoredKeys[0].endsWith(Core.ignoreKeyForUrl("https://cdn.example.test/full/photo.jpg")));

  await menuClicked({ ...contextInfo, menuItemId: "anydownload-preview-image" }, tab);
  assert.equal(createdTabs.length, 1);
  assert.match(createdTabs[0].url, /^moz-extension:\/\/fixture\/preview\/preview\.html\?id=/);
  assert.equal(createdTabs[0].windowId, 7);
  const previewKeys = Object.keys(session.data).filter((key) => key.startsWith("imagePreview:"));
  assert.equal(previewKeys.length, 1);
  assert.equal(session.data[previewKeys[0]].url, "https://cdn.example.test/full/photo.jpg");

  const openResult = await runtimeMessage({
    type: "OPEN_MANAGER_WINDOW",
    sourceTabId: tab.id
  });
  assert.equal(openResult.ok, true);
  assert.deepEqual(tabGets, [41]);
  assert.equal(createdWindows.length, 1);
  assert.equal(createdWindows[0].type, "popup");
  assert.equal(createdWindows[0].width, 800);
  assert.equal(createdWindows[0].height, 720);
  assert.equal(createdWindows[0].focused, true);
  assert.equal(createdWindows[0].incognito, false);
  const firstManagerUrl = new URL(createdWindows[0].url);
  assert.equal(firstManagerUrl.pathname, "/popup/popup.html");
  assert.equal(firstManagerUrl.searchParams.get("sourceTabId"), "41");
  assert.ok(firstManagerUrl.searchParams.get("launch"));
  assert.deepEqual([...firstManagerUrl.searchParams.keys()].sort(), ["launch", "sourceTabId"]);
  assert.ok(!createdWindows[0].url.includes("example.test"), "Manager URLs must not expose source page data");
  const normalManager = session.data["imageManagerWindow:normal"];
  assert.equal(normalManager.incognito, false);
  assert.equal(normalManager.windowId, 81);
  assert.equal(normalManager.tabId, 181);

  await menuClicked({ ...contextInfo, menuItemId: "anydownload-open-popup" }, tab);
  assert.equal(createdWindows.length, 1, "The context menu must reuse the normal manager window");
  assert.equal(updatedTabs.length, 1);
  assert.equal(updatedTabs[0].tabId, normalManager.tabId);
  const reusedManagerUrl = new URL(updatedTabs[0].details.url);
  assert.equal(reusedManagerUrl.searchParams.get("sourceTabId"), "41");
  assert.notEqual(
    reusedManagerUrl.searchParams.get("launch"),
    firstManagerUrl.searchParams.get("launch"),
    "Every launch must reload the manager with a unique URL"
  );
  assert.equal(updatedWindows[0].windowId, normalManager.windowId);
  assert.equal(updatedWindows[0].details.focused, true);
  assert.equal(updatedWindows[0].details.width, undefined, "Reusing a manager must preserve user-resized bounds");
  assert.ok(badgeCalls.some((call) => call.type === "text" && call.details.text === "✓"));

  const privateTab = {
    id: 42,
    incognito: true,
    url: "https://private.example.test/gallery",
    windowId: 8
  };
  sourceTabs.set(privateTab.id, privateTab);
  const privateOpenResult = await runtimeMessage({
    type: "OPEN_MANAGER_WINDOW",
    sourceTabId: privateTab.id
  });
  assert.equal(privateOpenResult.ok, true);
  assert.equal(createdWindows.length, 2, "Private browsing needs a separate manager window");
  assert.equal(createdWindows[1].incognito, true);
  const privateManagerUrl = new URL(createdWindows[1].url);
  assert.equal(privateManagerUrl.searchParams.get("sourceTabId"), "42");
  assert.deepEqual([...privateManagerUrl.searchParams.keys()].sort(), ["launch", "sourceTabId"]);
  assert.ok(!createdWindows[1].url.includes("private.example.test"));
  const privateManager = session.data["imageManagerWindow:private"];
  assert.equal(privateManager.incognito, true);
  assert.notEqual(privateManager.windowId, normalManager.windowId);

  liveWindows.delete(normalManager.windowId);
  const replacementTab = { ...tab, id: 43 };
  sourceTabs.set(replacementTab.id, replacementTab);
  await runtimeMessage({ type: "OPEN_MANAGER_WINDOW", sourceTabId: replacementTab.id });
  assert.equal(createdWindows.length, 3, "A stale session record must be replaced cleanly");
  assert.equal(new URL(createdWindows[2].url).searchParams.get("sourceTabId"), "43");
  assert.notEqual(session.data["imageManagerWindow:normal"].windowId, normalManager.windowId);

  await session.remove("imageManagerWindow:normal");
  rejectWindowCreates = true;
  const fallbackSourceTab = { ...tab, id: 44, windowId: 9 };
  sourceTabs.set(fallbackSourceTab.id, fallbackSourceTab);
  const fallbackResult = await runtimeMessage({
    type: "OPEN_MANAGER_WINDOW",
    sourceTabId: fallbackSourceTab.id
  });
  rejectWindowCreates = false;
  assert.equal(fallbackResult.ok, true);
  assert.equal(createdWindows.length, 4, "Firefox must first attempt a resizable popup window");
  assert.equal(createdTabs.length, 2, "A rejected popup window must fall back to a source-window tab");
  assert.equal(createdTabs[1].active, true);
  assert.equal(createdTabs[1].windowId, 9);
  const fallbackUrl = new URL(createdTabs[1].url);
  assert.equal(fallbackUrl.searchParams.get("sourceTabId"), "44");
  assert.ok(fallbackUrl.searchParams.get("launch"));
  assert.equal(session.data["imageManagerWindow:normal"], undefined);

  const windowsBeforeInvalidRequests = createdWindows.length;
  const invalidResult = await runtimeMessage({
    type: "OPEN_MANAGER_WINDOW",
    sourceTabId: "41"
  });
  assert.equal(invalidResult.ok, false);
  assert.match(invalidResult.error, /invalid/i);
  assert.equal(createdWindows.length, windowsBeforeInvalidRequests);

  const staleResult = await runtimeMessage({
    type: "OPEN_MANAGER_WINDOW",
    sourceTabId: 999
  });
  assert.equal(staleResult.ok, false);
  assert.match(staleResult.error, /stale/i);
  assert.equal(createdWindows.length, windowsBeforeInvalidRequests);

  let androidInstalled = null;
  const browserWithoutMenus = {
    ...browser,
    menus: undefined,
    runtime: {
      ...browser.runtime,
      onInstalled: {
        addListener(listener) {
          androidInstalled = listener;
        }
      }
    }
  };
  assert.doesNotThrow(() => vm.runInNewContext(
    source,
    { ...sandbox, browser: browserWithoutMenus },
    { filename: "background-without-menus.js" }
  ));
  assert.equal(typeof androidInstalled, "function");
  await androidInstalled();

  console.log("All context-menu background checks passed.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
