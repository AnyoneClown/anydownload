"use strict";

const assert = require("assert").strict;
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const Core = require("../extension/shared/core.js");
const YouTube = require("../extension/shared/youtube.js");

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
  const permissionRequests = [];
  const backgroundErrors = [];
  const fetchRequests = [];
  const fetchFixtures = new Map();
  const zipCalls = [];
  const createdObjectUrls = [];
  const revokedObjectUrls = [];
  const createdBlobs = [];
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
  let nextObjectUrl = 1;
  let activeFetches = 0;
  let maximumActiveFetches = 0;
  let nextDownloadState = "complete";
  let nextDownloadError = "";
  const timers = new Map();

  class BlobFixture {
    constructor(parts, options = {}) {
      this.parts = parts;
      this.type = options.type || "";
      createdBlobs.push(this);
    }
  }

  class AbortControllerFixture {
    constructor() {
      const listeners = new Set();
      this.signal = {
        aborted: false,
        addEventListener(type, listener) {
          if (type === "abort") {
            listeners.add(listener);
          }
        }
      };
      this.abortListeners = listeners;
    }

    abort() {
      this.signal.aborted = true;
      for (const listener of this.abortListeners) {
        listener();
      }
      this.abortListeners.clear();
    }
  }

  class URLFixture extends URL {}
  URLFixture.createObjectURL = (blob) => {
    const objectUrl = `blob:anydownload-${nextObjectUrl++}`;
    createdObjectUrls.push({ objectUrl, blob });
    return objectUrl;
  };
  URLFixture.revokeObjectURL = (objectUrl) => {
    revokedObjectUrls.push(objectUrl);
  };

  function httpFixture(bytes, options = {}) {
    const data = Uint8Array.from(bytes);
    const response = {
      ok: options.ok !== false,
      status: options.status || (options.ok === false ? 500 : 200),
      statusText: options.statusText || "",
      headers: {
        get(name) {
          const normalizedName = String(name).toLowerCase();
          if (normalizedName === "content-length") {
            return options.contentLength == null ? String(data.byteLength) : String(options.contentLength);
          }
          if (normalizedName === "content-type") {
            return options.contentType || "image/jpeg";
          }
          return null;
        }
      },
      async arrayBuffer() {
        return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      }
    };
    if (options.stream) {
      response.body = {
        getReader() {
          let consumed = false;
          return {
            async read() {
              if (consumed) {
                return { done: true, value: undefined };
              }
              consumed = true;
              return { done: false, value: data };
            },
            async cancel() {}
          };
        }
      };
    }
    return response;
  }

  async function fetchFixture(url, options) {
    fetchRequests.push({ url, options });
    activeFetches += 1;
    maximumActiveFetches = Math.max(maximumActiveFetches, activeFetches);
    await Promise.resolve();
    activeFetches -= 1;
    const fixture = fetchFixtures.get(url);
    if (fixture instanceof Error) {
      throw fixture;
    }
    if (typeof fixture === "function") {
      return fixture(options);
    }
    if (!fixture) {
      throw new Error(`Missing fetch fixture for ${url}`);
    }
    return fixture;
  }

  const Archive = {
    createStoredZip(entries, options) {
      zipCalls.push({ entries: entries.slice(), options });
      const parts = [Uint8Array.from([0x50, 0x4b, 0x05, 0x06])];
      return { parts, size: parts[0].byteLength, entryCount: entries.length };
    }
  };

  const youtubeDirectUrl = "https://rr1---sn-fixture.googlevideo.com/videoplayback?itag=18&expire=9999999999&token=keep";
  const youtubeResult = {
    handled: true,
    images: [{
      url: youtubeDirectUrl,
      previewUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg",
      filename: "Rick / Roll? - 360p.mp4",
      alt: "Fixture video — 360p",
      width: 640,
      height: 360,
      duration: 213.4,
      mimeType: "video/mp4",
      mediaType: "video",
      sourceProvider: "youtube",
      videoId: "dQw4w9WgXcQ",
      qualityLabel: "360p",
      hasAudio: true,
      itag: 18,
      kinds: ["YouTube direct file", "360p video + audio"]
    }],
    warnings: []
  };
  const collector = function contextCollectorFixture() {};
  const youtubeCollector = async function youtubeContextCollectorFixture() {
    return youtubeResult;
  };
  const instagramDirectUrl = "https://scontent.cdninstagram.com/o1/v/t16/reel.mp4?token=keep";
  const instagramResult = {
    handled: true,
    images: [{
      url: instagramDirectUrl,
      previewUrl: "https://scontent.cdninstagram.com/o1/v/t51/reel.jpg",
      alt: "Fixture reel",
      width: 1080,
      height: 1920,
      duration: 12.5,
      mimeType: "video/mp4",
      mediaType: "video",
      sourceProvider: "instagram",
      kinds: ["Instagram reel video"]
    }],
    warnings: []
  };
  const instagramCollector = async function instagramContextCollectorFixture() {
    return instagramResult;
  };
  const InstagramFixture = {
    isInstagramUrl(value) {
      try {
        return new URL(value).hostname === "www.instagram.com";
      } catch (_error) {
        return false;
      }
    },
    collectFromPage: instagramCollector
  };
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
        const item = { id: 91, state: nextDownloadState, error: nextDownloadError };
        nextDownloadState = "complete";
        nextDownloadError = "";
        return [item];
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
    permissions: {
      async request(details) {
        permissionRequests.push(details);
        return true;
      }
    },
    scripting: {
      async executeScript(details) {
        scriptingCalls.push(details);
        if (details.func === instagramCollector) {
          return [{ frameId: 0, result: instagramResult }];
        }
        if (details.func === youtubeCollector) {
          return [{
            frameId: 0,
            result: youtubeResult
          }];
        }
        if (details.args && details.args[0] && details.args[0].targetElementId === 75) {
          return [{ frameId: 0, result: { images: [] } }];
        }
        if (details.args && details.args[0] && details.args[0].targetElementId === 74) {
          return [{
            frameId: 0,
            result: {
              images: [{
                url: "https://media.example.test/direct/feature.mp4?token=keep",
                previewUrl: "https://example.test/posters/feature.jpg",
                alt: "Context video",
                width: 1920,
                height: 1080,
                duration: 91.5,
                mimeType: "video/mp4",
                mediaType: "video",
                kinds: ["Video"]
              }]
            }
          }];
        }
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
    AbortController: AbortControllerFixture,
    ImageDownloaderArchive: Archive,
    ImageDownloaderCore: Core,
    ImageDownloaderCollector: collector,
    ImageDownloaderInstagram: InstagramFixture,
    AnyDownloadYouTube: YouTube,
    AnyDownloadYouTubeCollector: youtubeCollector,
    Blob: BlobFixture,
    Date,
    TextEncoder,
    Uint8Array,
    URL: URLFixture,
    atob(value) {
      return Buffer.from(value, "base64").toString("binary");
    },
    browser,
    clearTimeout(timerId) {
      timers.delete(timerId);
    },
    console: {
      error(...args) {
        backgroundErrors.push(args);
      }
    },
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(nextUuid++).padStart(12, "0")}` },
    fetch: fetchFixture,
    setTimeout(callback, delay) {
      const timerId = nextTimer++;
      timers.set(timerId, { callback, delay });
      return timerId;
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
  assert.ok(menuEntries.every((entry) => entry.contexts.includes("video")));
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

  const videoContextInfo = {
    ...contextInfo,
    mediaType: "video",
    srcUrl: "https://example.test/player/opaque-source",
    targetElementId: 74
  };
  await menuClicked({ ...videoContextInfo, menuItemId: "anydownload-download-image" }, tab);
  assert.equal(scriptingCalls.length, 4);
  assert.equal(scriptingCalls[3].args[0].targetElementId, 74);
  assert.equal(downloadRequests.length, 2);
  assert.equal(
    downloadRequests[1].url,
    "https://media.example.test/direct/feature.mp4?token=keep",
    "A context video download must preserve the exposed direct URL"
  );
  assert.equal(downloadRequests[1].filename, "Context images/example.test/feature.mp4");

  await menuClicked({ ...videoContextInfo, menuItemId: "anydownload-preview-image" }, tab);
  assert.equal(createdTabs.length, 2);
  const videoPreviewKeys = Object.keys(session.data)
    .filter((key) => key.startsWith("imagePreview:"))
    .filter((key) => session.data[key].mediaType === "video");
  assert.equal(videoPreviewKeys.length, 1);
  const videoPreview = session.data[videoPreviewKeys[0]];
  assert.equal(videoPreview.url, "https://media.example.test/direct/feature.mp4?token=keep");
  assert.equal(videoPreview.previewUrl, "https://example.test/posters/feature.jpg");
  assert.equal(videoPreview.duration, 91.5);
  assert.equal(videoPreview.mediaType, "video");

  const instagramTab = {
    id: 46,
    incognito: false,
    url: "https://www.instagram.com/reel/AbCdEfGhIJK/",
    title: "Fixture reel • Instagram",
    windowId: 7
  };
  const instagramContextInfo = {
    frameId: 0,
    pageUrl: instagramTab.url,
    mediaType: "video",
    srcUrl: "blob:https://www.instagram.com/page-owned-player-source",
    targetElementId: 77
  };
  const callsBeforeInstagram = scriptingCalls.length;
  const downloadsBeforeInstagram = downloadRequests.length;
  await menuClicked({
    ...instagramContextInfo,
    menuItemId: "anydownload-download-image"
  }, instagramTab);
  assert.equal(scriptingCalls.length, callsBeforeInstagram + 1);
  assert.equal(scriptingCalls[callsBeforeInstagram].func, instagramCollector);
  assert.equal(downloadRequests.length, downloadsBeforeInstagram + 1);
  assert.equal(downloadRequests[downloadsBeforeInstagram].url, instagramDirectUrl);
  assert.equal(
    JSON.stringify(downloadRequests[downloadsBeforeInstagram].headers),
    JSON.stringify([{ name: "Referer", value: "https://www.instagram.com/" }])
  );

  const youtubeTab = {
    id: 45,
    incognito: false,
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    title: "Fixture video - YouTube",
    windowId: 7
  };
  sourceTabs.set(youtubeTab.id, youtubeTab);
  const youtubeContextInfo = {
    frameId: 0,
    pageUrl: youtubeTab.url,
    mediaType: "video",
    srcUrl: "blob:https://www.youtube.com/page-owned-player-source",
    targetElementId: 76
  };
  const callsBeforeYouTube = scriptingCalls.length;
  const downloadsBeforeYouTube = downloadRequests.length;
  await menuClicked({
    ...youtubeContextInfo,
    menuItemId: "anydownload-download-image"
  }, youtubeTab);
  assert.equal(scriptingCalls.length, callsBeforeYouTube + 1);
  assert.equal(scriptingCalls[callsBeforeYouTube].func, youtubeCollector);
  assert.equal(scriptingCalls[callsBeforeYouTube].target.tabId, youtubeTab.id);
  assert.equal(scriptingCalls[callsBeforeYouTube].target.frameIds, undefined);
  assert.equal(scriptingCalls[callsBeforeYouTube].args[0].includeVideoOnly, false);
  assert.equal(downloadRequests.length, downloadsBeforeYouTube + 1);
  assert.equal(
    JSON.stringify(permissionRequests[permissionRequests.length - 1]),
    JSON.stringify({ origins: ["https://www.youtube.com/*"] })
  );
  assert.equal(downloadRequests[downloadsBeforeYouTube].url, youtubeDirectUrl);
  assert.equal(
    downloadRequests[downloadsBeforeYouTube].filename,
    "Context images/example.test/Rick _ Roll_ - 360p.mp4",
    "The specialized YouTube filename must survive validation and reach the download path"
  );
  const tabsBeforeYouTubePreview = createdTabs.length;
  await menuClicked({
    ...youtubeContextInfo,
    menuItemId: "anydownload-preview-image"
  }, youtubeTab);
  assert.equal(createdTabs.length, tabsBeforeYouTubePreview + 1);
  const youtubeCalls = scriptingCalls.slice(callsBeforeYouTube);
  assert.equal(youtubeCalls.length, 2);
  assert.ok(
    youtubeCalls.every((call) => call.func === youtubeCollector),
    "A successful YouTube collection must not fall back to the generic blob collector"
  );
  const youtubePreview = Object.values(session.data).find((value) =>
    value && value.url === youtubeDirectUrl
  );
  assert.ok(youtubePreview, "The direct YouTube file must be stored for preview");
  assert.equal(youtubePreview.name, "Rick _ Roll_ - 360p.mp4");
  assert.equal(youtubePreview.previewUrl, "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg");
  assert.equal(youtubePreview.duration, 213.4);
  assert.equal(youtubePreview.mediaType, "video");

  const downloadsBeforeManifest = downloadRequests.length;
  const scriptingBeforeManifest = scriptingCalls.length;
  const queueStateBeforeManifest = local.data["downloadQueueState:v1"];
  const hlsContextInfo = {
    ...contextInfo,
    mediaType: "video",
    srcUrl: "https://media.example.test/streams/feature.m3u8?token=keep",
    targetElementId: 75
  };
  await menuClicked({ ...hlsContextInfo, menuItemId: "anydownload-download-image" }, tab);
  assert.equal(scriptingCalls.length, scriptingBeforeManifest + 1);
  assert.equal(
    downloadRequests.length,
    downloadsBeforeManifest,
    "An HLS context URL must not start a native download"
  );
  assert.deepEqual(
    local.data["downloadQueueState:v1"],
    queueStateBeforeManifest,
    "An HLS context URL must not change durable queue storage"
  );
  assert.ok(
    backgroundErrors.some((args) =>
      args.some((value) => /streaming manifest, not a standalone video file/i.test(
        value && value.message ? value.message : String(value)
      ))
    ),
    "The rejected HLS context must explain that a manifest is not a standalone file"
  );
  assert.ok(badgeCalls.some((call) => call.type === "text" && call.details.text === "!"));

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

  const reopenedResult = await runtimeMessage({
    type: "OPEN_MANAGER_WINDOW",
    sourceTabId: tab.id
  });
  assert.equal(reopenedResult.ok, true);
  assert.equal(reopenedResult.reused, true);
  assert.equal(createdWindows.length, 1, "Opening again must reuse an existing manager window");
  assert.equal(updatedTabs.length, 2);
  assert.equal(updatedTabs[1].tabId, normalManager.tabId);
  const reopenedManagerUrl = new URL(updatedTabs[1].details.url);
  assert.equal(reopenedManagerUrl.searchParams.get("sourceTabId"), "41");
  assert.equal(reopenedManagerUrl.searchParams.get("live"), null);
  assert.deepEqual(
    [...reopenedManagerUrl.searchParams.keys()].sort(),
    ["launch", "sourceTabId"]
  );
  assert.notEqual(
    reopenedManagerUrl.searchParams.get("launch"),
    reusedManagerUrl.searchParams.get("launch"),
    "Every reopen must reload the reused manager"
  );
  assert.equal(updatedWindows[1].windowId, normalManager.windowId);
  assert.equal(updatedWindows[1].details.focused, true);
  assert.equal(updatedWindows[1].details.width, undefined, "Reusing must preserve user-resized bounds");

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
  const tabsBeforeWindowFallback = createdTabs.length;
  const fallbackSourceTab = { ...tab, id: 44, windowId: 9 };
  sourceTabs.set(fallbackSourceTab.id, fallbackSourceTab);
  const fallbackResult = await runtimeMessage({
    type: "OPEN_MANAGER_WINDOW",
    sourceTabId: fallbackSourceTab.id
  });
  rejectWindowCreates = false;
  assert.equal(fallbackResult.ok, true);
  assert.equal(createdWindows.length, 4, "Firefox must first attempt a resizable popup window");
  assert.equal(
    createdTabs.length,
    tabsBeforeWindowFallback + 1,
    "A rejected popup window must fall back to a source-window tab"
  );
  const fallbackTab = createdTabs[tabsBeforeWindowFallback];
  assert.equal(fallbackTab.active, true);
  assert.equal(fallbackTab.windowId, 9);
  const fallbackUrl = new URL(fallbackTab.url);
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

  const downloadsBeforeRejectedVideoArchives = downloadRequests.length;
  const fetchesBeforeRejectedVideoArchives = fetchRequests.length;
  const explicitVideoArchive = await runtimeMessage({
    type: "DOWNLOAD_ARCHIVE",
    folder: "Archive tests/video",
    items: [{
      url: "https://media.example.test/direct/feature.mp4",
      filename: "feature.mp4",
      mediaType: "video"
    }]
  });
  assert.equal(explicitVideoArchive.ok, false);
  assert.match(explicitVideoArchive.error, /ZIP archives support images only/i);

  const embeddedVideoArchive = await runtimeMessage({
    type: "DOWNLOAD_ARCHIVE",
    folder: "Archive tests/video-data",
    items: [{ url: "data:video/mp4;base64,AQID" }]
  });
  assert.equal(embeddedVideoArchive.ok, false);
  assert.match(embeddedVideoArchive.error, /ZIP archives support images only/i);

  const inferredVideoArchive = await runtimeMessage({
    type: "DOWNLOAD_ARCHIVE",
    folder: "Archive tests/video-inferred",
    items: [{
      url: "https://media.example.test/direct/feature.mp4?token=keep",
      filename: "feature.mp4"
    }]
  });
  assert.equal(inferredVideoArchive.ok, false);
  assert.match(inferredVideoArchive.error, /ZIP archives support images only/i);
  assert.equal(downloadRequests.length, downloadsBeforeRejectedVideoArchives);
  assert.equal(fetchRequests.length, fetchesBeforeRejectedVideoArchives);

  const archiveUrls = [
    "https://assets.example.test/a/photo.jpg?size=full",
    "https://assets.example.test/b/photo.jpg?size=original",
    "https://assets.example.test/c/third.webp",
    "https://assets.example.test/d/four.png"
  ];
  archiveUrls.forEach((url, index) => {
    fetchFixtures.set(url, httpFixture(
      [index + 1, index + 2, index + 3],
      index === 3 ? { stream: true, contentLength: 65536 } : {}
    ));
  });
  const downloadsBeforeArchive = downloadRequests.length;
  const successfulArchive = await runtimeMessage({
    type: "DOWNLOAD_ARCHIVE",
    folder: "Archive tests/gallery",
    incognito: true,
    items: [
      ...archiveUrls.map((url, index) => ({
        url,
        ...(index < 2 ? { filename: "Summer/Gallery?.JPG" } : {})
      })),
      { url: "data:image/png;base64,AQID" }
    ]
  });
  assert.equal(successfulArchive.ok, true);
  assert.equal(successfulArchive.total, 5);
  assert.equal(successfulArchive.archived, 5);
  assert.equal(successfulArchive.failed, 0);
  assert.equal(successfulArchive.folder, "Archive tests/gallery");
  assert.equal(successfulArchive.filename, "gallery.zip");
  assert.equal(successfulArchive.errors.length, 0);
  assert.equal(downloadRequests.length, downloadsBeforeArchive + 1, "An archive must use one Firefox download");
  const archiveDownload = downloadRequests[downloadRequests.length - 1];
  assert.match(archiveDownload.url, /^blob:anydownload-/);
  assert.equal(archiveDownload.filename, "Archive tests/gallery/gallery.zip");
  assert.equal(archiveDownload.conflictAction, "uniquify");
  assert.equal(archiveDownload.saveAs, false);
  assert.equal(archiveDownload.incognito, true);
  assert.equal(fetchRequests.length, 4, "Embedded data images must be decoded without fetch");
  assert.ok(fetchRequests.every((request) => request.options.credentials === "include"));
  assert.ok(fetchRequests.every((request) => request.options.cache === "no-store"));
  assert.ok(fetchRequests.every((request) => request.options.signal && typeof request.options.signal.aborted === "boolean"));
  assert.equal(maximumActiveFetches, 2, "Archive fetching must never exceed two concurrent requests");
  assert.equal(zipCalls.length, 1);
  assert.ok(zipCalls[0].options.date instanceof Date);
  assert.deepEqual(
    Array.from(zipCalls[0].entries, (entry) => entry.name),
    ["Summer_Gallery_.JPG", "Summer_Gallery_-2.JPG", "third.webp", "four.png", "image-0005.png"]
  );
  assert.deepEqual(
    Array.from(zipCalls[0].entries[zipCalls[0].entries.length - 1].data),
    [1, 2, 3]
  );
  assert.equal(
    zipCalls[0].entries[3].data.buffer.byteLength,
    zipCalls[0].entries[3].data.byteLength,
    "A short body must not retain its oversized Content-Length allocation"
  );
  assert.equal(createdBlobs[createdBlobs.length - 1].type, "application/zip");
  assert.ok(
    revokedObjectUrls.includes(archiveDownload.url),
    "The ZIP object URL must be retained through completion and then revoked"
  );

  const partialGoodUrl = "https://assets.example.test/partial/kept.jpg";
  const partialDeniedUrl = "https://assets.example.test/partial/denied.jpg";
  const partialLargeUrl = "https://assets.example.test/partial/large.jpg";
  fetchFixtures.set(partialGoodUrl, httpFixture([9, 8, 7]));
  fetchFixtures.set(partialDeniedUrl, httpFixture([], {
    ok: false,
    status: 403,
    statusText: "Forbidden"
  }));
  fetchFixtures.set(partialLargeUrl, httpFixture([1], {
    contentLength: (64 * 1024 * 1024) + 1
  }));
  const downloadsBeforePartial = downloadRequests.length;
  const partialArchive = await runtimeMessage({
    type: "DOWNLOAD_ARCHIVE",
    folder: "Archive tests/partial",
    items: [
      { url: partialGoodUrl },
      { url: partialDeniedUrl },
      { url: partialLargeUrl }
    ]
  });
  assert.equal(partialArchive.ok, true, "One failed image must not discard successful images");
  assert.equal(partialArchive.total, 3);
  assert.equal(partialArchive.archived, 1);
  assert.equal(partialArchive.failed, 2);
  assert.equal(partialArchive.errors.length, 2);
  assert.match(partialArchive.errors[0].error, /HTTP 403 Forbidden/);
  assert.match(partialArchive.errors[1].error, /64 MiB/);
  assert.equal(downloadRequests.length, downloadsBeforePartial + 1);
  assert.equal(downloadRequests[downloadRequests.length - 1].filename, "Archive tests/partial/partial.zip");
  assert.equal(downloadRequests[downloadRequests.length - 1].saveAs, false);
  assert.equal(zipCalls.length, 2);
  assert.deepEqual(
    Array.from(zipCalls[1].entries, (entry) => entry.name),
    ["kept.jpg", "anydownload-errors.txt"]
  );
  const errorReport = Buffer.from(zipCalls[1].entries[1].data).toString("utf8");
  assert.match(errorReport, /Image 2 \(denied\.jpg\): Image request failed with HTTP 403 Forbidden\./);
  assert.match(errorReport, /Image 3 \(large\.jpg\): Image is larger than the 64 MiB per-file archive limit\./);

  const longArchiveBasename = "x".repeat(100);
  const longNameArchive = await runtimeMessage({
    type: "DOWNLOAD_ARCHIVE",
    folder: `Archive tests/${longArchiveBasename}`,
    items: [{ url: partialGoodUrl }]
  });
  const expectedLongArchiveFilename = `${"x".repeat(96)}.zip`;
  assert.equal(longNameArchive.ok, true);
  assert.equal(longNameArchive.filename, expectedLongArchiveFilename);
  assert.equal(
    downloadRequests[downloadRequests.length - 1].filename,
    `Archive tests/${longArchiveBasename}/${expectedLongArchiveFilename}`,
    "A 100-character folder basename must retain the .zip extension"
  );

  const failedNetworkUrl = "https://assets.example.test/all-fail/network.jpg";
  const failedHttpUrl = "https://assets.example.test/all-fail/missing.jpg";
  const failedHtmlUrl = "https://assets.example.test/all-fail/login.jpg";
  fetchFixtures.set(failedNetworkUrl, new Error("Network connection failed."));
  fetchFixtures.set(failedHttpUrl, httpFixture([], {
    ok: false,
    status: 404,
    statusText: "Not Found"
  }));
  fetchFixtures.set(failedHtmlUrl, httpFixture([60, 104, 116, 109, 108, 62], {
    contentType: "text/html; charset=utf-8"
  }));
  const downloadsBeforeFailure = downloadRequests.length;
  const zipsBeforeFailure = zipCalls.length;
  const failedArchive = await runtimeMessage({
    type: "DOWNLOAD_ARCHIVE",
    folder: "Archive tests/failed",
    items: [{ url: failedNetworkUrl }, { url: failedHttpUrl }, { url: failedHtmlUrl }]
  });
  assert.equal(failedArchive.ok, false);
  assert.equal(failedArchive.total, 3);
  assert.equal(failedArchive.archived, 0);
  assert.equal(failedArchive.failed, 3);
  assert.equal(failedArchive.errors.length, 3);
  assert.match(failedArchive.error, /Network connection failed/);
  assert.match(failedArchive.errors[2].error, /text\/html instead of an image/);
  assert.equal(downloadRequests.length, downloadsBeforeFailure, "A fully failed archive must not start a download");
  assert.equal(zipCalls.length, zipsBeforeFailure, "A fully failed archive must not build an empty ZIP");

  const timeoutUrl = "https://assets.example.test/timeout/stalled.jpg";
  fetchFixtures.set(timeoutUrl, (options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new Error("Synthetic aborted fetch.")));
  }));
  const downloadsBeforeTimeout = downloadRequests.length;
  const timeoutArchivePromise = runtimeMessage({
    type: "DOWNLOAD_ARCHIVE",
    folder: "Archive tests/timeout",
    items: [{ url: timeoutUrl }]
  });
  await Promise.resolve();
  await Promise.resolve();
  const archiveTimeout = Array.from(timers.values()).find((timer) => timer.delay === 120000);
  assert.ok(archiveTimeout, "Archive fetching must install a two-minute timeout");
  archiveTimeout.callback();
  const timeoutArchive = await timeoutArchivePromise;
  assert.equal(timeoutArchive.ok, false);
  assert.match(timeoutArchive.error, /timed out after 2 minutes/);
  assert.equal(downloadRequests.length, downloadsBeforeTimeout);

  const concurrentUrl = "https://assets.example.test/concurrent/photo.jpg";
  fetchFixtures.set(concurrentUrl, httpFixture([4, 5, 6]));
  const firstConcurrentArchive = runtimeMessage({
    type: "DOWNLOAD_ARCHIVE",
    folder: "Archive tests/concurrent-first",
    items: [{ url: concurrentUrl }]
  });
  const rejectedConcurrentArchive = await runtimeMessage({
    type: "DOWNLOAD_ARCHIVE",
    folder: "Archive tests/concurrent-second",
    items: [{ url: concurrentUrl }]
  });
  assert.equal(rejectedConcurrentArchive.ok, false);
  assert.match(rejectedConcurrentArchive.error, /Another ZIP archive is already being built/);
  assert.equal((await firstConcurrentArchive).ok, true);

  const fetchesBeforeOversizedBatch = fetchRequests.length;
  const oversizedArchive = await runtimeMessage({
    type: "DOWNLOAD_ARCHIVE",
    folder: "Archive tests/too-many",
    items: Array.from({ length: 2001 }, () => ({ url: partialGoodUrl }))
  });
  assert.equal(oversizedArchive.ok, false);
  assert.equal(oversizedArchive.total, 2001);
  assert.equal(oversizedArchive.failed, 2001);
  assert.equal(oversizedArchive.folder, "Archive tests/too-many");
  assert.equal(oversizedArchive.filename, "too-many.zip");
  assert.match(oversizedArchive.error, /at most 2000 images/);
  assert.equal(fetchRequests.length, fetchesBeforeOversizedBatch);

  const interruptedUrl = "https://assets.example.test/interrupted/photo.jpg";
  fetchFixtures.set(interruptedUrl, httpFixture([7, 8, 9]));
  nextDownloadState = "interrupted";
  nextDownloadError = "USER_CANCELED";
  const interruptedArchive = await runtimeMessage({
    type: "DOWNLOAD_ARCHIVE",
    folder: "Archive tests/interrupted",
    items: [{ url: interruptedUrl }]
  });
  assert.equal(interruptedArchive.ok, false);
  assert.match(interruptedArchive.error, /ZIP download was interrupted \(USER_CANCELED\)/);

  const polledCompletionUrl = "https://assets.example.test/polled/photo.jpg";
  fetchFixtures.set(polledCompletionUrl, httpFixture([10, 11, 12]));
  nextDownloadState = "in_progress";
  const polledCompletionPromise = runtimeMessage({
    type: "DOWNLOAD_ARCHIVE",
    folder: "Archive tests/polled-completion",
    items: [{ url: polledCompletionUrl }]
  });
  await new Promise((resolve) => setImmediate(resolve));
  const retentionPoll = Array.from(timers.values()).find((timer) => timer.delay === 1000);
  assert.ok(
    retentionPoll,
    "A non-terminal initial downloads.search result must schedule a completion poll"
  );
  await retentionPoll.callback();
  const polledCompletion = await polledCompletionPromise;
  assert.equal(polledCompletion.ok, true);
  assert.ok(
    revokedObjectUrls.includes(downloadRequests[downloadRequests.length - 1].url),
    "Polling must release the ZIP object URL even when downloads.onChanged is missed"
  );

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
