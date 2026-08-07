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
  const menuEntries = [];
  const downloadRequests = [];
  const createdTabs = [];
  const scriptingCalls = [];
  const badgeCalls = [];
  const local = storageArea({
    destinationFolder: "Context images/example.test",
    askForSingle: false
  });
  const session = storageArea();
  let menuClicked = null;
  let installed = null;
  let runtimeMessage = null;
  let openPopupCalls = 0;
  let nextTimer = 1;

  const collector = function contextCollectorFixture() {};
  const browser = {
    action: {
      async openPopup() {
        openPopupCalls += 1;
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
      async create(details) {
        createdTabs.push(details);
        return { id: 52, ...details };
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
    crypto: { randomUUID: () => "12345678-1234-1234-1234-123456789abc" },
    setTimeout() {
      return nextTimer++;
    }
  };
  vm.runInNewContext(source, sandbox, { filename: "background.js" });

  assert.equal(menuEntries.length, 0, "MV3 menus must be created from runtime.onInstalled");
  assert.equal(typeof installed, "function");
  await installed();
  assert.equal(menuEntries.length, 6);
  assert.equal(menuEntries[0].id, "anydownload-image-actions");
  assert.ok(menuEntries.every((entry) => entry.contexts.includes("image")));
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

  await menuClicked({ ...contextInfo, menuItemId: "anydownload-open-popup" }, tab);
  assert.equal(openPopupCalls, 1);
  assert.ok(badgeCalls.some((call) => call.type === "text" && call.details.text === "✓"));

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
