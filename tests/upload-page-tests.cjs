"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const { File } = require("node:buffer");
const Page = require("../extension/upload/upload.js");
const Uploads = require("../extension/shared/uploads.js");
const Immich = require("../extension/shared/immich.js");
const Sync = require("../extension/shared/cloud-sync.js");
const OWNER = "11111111-1111-4111-8111-111111111111";
const CONNECTION = "22222222-2222-4222-8222-222222222222";
const ASSET = "33333333-3333-4333-8333-333333333333";
const ALBUM = "44444444-4444-4444-8444-444444444444";
const SECRET = "never-save-this-api-key";
const connection = { id: CONNECTION, provider: "immich", serverUrl: "http://192.168.0.103:2283", defaultAlbumId: null };
const sourceItems = [{ url: "https://images.example/original.png", filename: "original.png" }];
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const mp4 = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]);
const clone = value => structuredClone(value);
const jobKey = id => `${Page.JOB_KEY_PREFIX}${id}`;
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, removeListener(fn) { this.listeners = this.listeners.filter(item => item !== fn); } });

class Element {
  constructor(id = "") { this.id = id; this.children = []; this.listeners = {}; this.dataset = {}; this.value = ""; this.files = []; this.hidden = false; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  append(...items) { this.children.push(...items); if (!this.value && this.children.length) this.value = this.children[0].value; }
  replaceChildren(...items) { this.children = []; this.value = ""; this.append(...items); }
  remove(index) { this.children.splice(index, 1); }
  scrollIntoView() { this.scrollCount = (this.scrollCount || 0) + 1; }
  get options() { return this.children; }
}

function harness({ privateWindow = false, href = "moz-extension://test/upload/upload.html?request=request-123", stored, failAlbum = false } = {}) {
  const html = fs.readFileSync("extension/upload/upload.html", "utf8");
  const elements = Object.fromEntries([...html.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], new Element(match[1])]));
  const document = { querySelectorAll: selector => selector === "[id]" ? Object.values(elements) : [], createElement: () => new Element() };
  const local = clone(stored || { "downloadLedger:v1": { unchanged: true } });
  const session = { "uploadJobRequest:request-123": { createdAt: Date.now(), incognito: false, items: sourceItems } };
  const calls = [];
  const workspaceCalls = [];
  const held = new Set();
  const chains = new Map();
  const locks = { async request(name, options, fn) {
    if (typeof options === "function") { fn = options; options = {}; }
    if (options.ifAvailable && held.has(name)) return fn(null);
    const previous = chains.get(name) || Promise.resolve();
    const work = previous.catch(() => undefined).then(async () => {
      held.add(name);
      try { return await fn({ name }); } finally { held.delete(name); }
    });
    chains.set(name, work);
    return work;
  } };
  const area = data => ({
    async get(key) {
      calls.push(["get", key]);
      const keys = Array.isArray(key) ? key : [key];
      return Object.fromEntries(keys.filter(item => Object.hasOwn(data, item)).map(item => [item, clone(data[item])]));
    },
    async set(values) { calls.push(["set", Object.keys(values)]); Object.assign(data, clone(values)); },
    async remove(key) { delete data[key]; }
  });
  const browser = {
    extension: { inIncognitoContext: privateWindow },
    tabs: { getCurrent: async () => ({ incognito: privateWindow }), create: async () => {} },
    storage: { local: area(local), session: area(session), onChanged: event() },
    runtime: { id: "test", onMessage: event() },
    permissions: { request: async value => { calls.push(["permission", value]); return true; }, contains: async () => true }
  };
  let account = { signedIn: true, ownerId: OWNER, email: "owner@example.com" };
  const scopes = new Set();
  const client = {
    status: async () => clone(account), list: async () => [connection],
    defaultAlbum: async (id, albumId) => { calls.push(["default", id, albumId]); },
    async withCredential(saved, callback) {
      assert.equal(saved.id, CONNECTION);
      const credential = { serverUrl: saved.serverUrl, apiKey: SECRET };
      const controller = new AbortController(); scopes.add(controller);
      try { return await callback(credential, { signal: controller.signal }); }
      finally { credential.apiKey = ""; scopes.delete(controller); }
    },
    cancel() { for (const controller of scopes) controller.abort(); },
    dispose() { this.cancel(); }
  };
  const provider = {
    permissionPattern: Immich.permissionPattern,
    async uploadAsset(credential, value) {
      assert.equal(credential.apiKey, SECRET);
      calls.push(["upload", value.filename]);
      return { assetId: ASSET, duplicate: false };
    },
    async addToAlbum(credential, albumId, assetId) {
      assert.equal(credential.apiKey, SECRET);
      calls.push(["album", albumId, assetId]);
      if (failAlbum) throw Object.assign(new Error("not persisted"), { code: "album_failed" });
    },
    async listAlbums() { return [{ id: ALBUM, name: "Writable album" }]; }
  };
  const imageFetch = { async fetchMediaBytes(url, mediaType, signal, options) {
    const parsed = new URL(url);
    assert.equal(await options.permissionContains(`${parsed.protocol}//${parsed.hostname}/*`), true);
    assert.equal(signal.aborted, false);
    calls.push(["fetch", url]);
    return mediaType === "video" ? { bytes: mp4, contentType: "video/mp4" } : { bytes: png, contentType: "image/png" };
  } };
  const workspace = { open: (view, route) => workspaceCalls.push([view, route]) };
  return { browser, document, elements, local, session, calls, workspaceCalls, held, locks, client, provider, imageFetch,
    setAccount: value => { account = value; }, setAlbumFailure: value => { failAlbum = value; },
    start: () => Page.initialize({ browser, document, location: { href }, locks, client, provider, imageFetch, workspace }) };
}

(async () => {
  let h = harness({ privateWindow: true });
  assert.equal(await h.start(), undefined);
  assert.equal(h.elements["private-notice"].hidden, false);
  assert.equal(h.calls.length, 0, "Private windows do not read normal upload storage or request credentials");

  h = harness();
  h.client.list = async () => [];
  await h.start();
  assert.equal(h.elements["connection-select"].children[0].textContent, "No connected servers");
  assert.equal(h.elements["connection-select"].disabled, true);
  assert.equal(h.elements["album-select"].disabled, true);
  assert.equal(h.elements["start-button"].disabled, true);

  h = harness();
  let page = await h.start();
  assert.equal(h.calls.some(call => call[0] === "fetch"), false, "Opening the tab never starts a transfer");
  assert.equal(h.elements["selection-count"].textContent, "1 image");
  assert.equal(h.elements["progress-empty"].hidden, false);
  assert.equal(h.elements["history-empty"].hidden, false);
  const fetchMediaBytes = h.imageFetch.fetchMediaBytes;
  h.imageFetch.fetchMediaBytes = async (...args) => {
    assert.equal(h.local[jobKey(page.job.id)].items[0].uploadStatus, "pending",
      "Reading source bytes does not need a durable checkpoint before the remote upload");
    assert.match(h.elements["results-list"].children[0].children[1].textContent, /Reading image/);
    return fetchMediaBytes(...args);
  };
  const uploadAsset = h.provider.uploadAsset;
  let activeResultRow;
  h.provider.uploadAsset = async (...args) => {
    activeResultRow = h.elements["results-list"].children[0];
    assert.equal(h.elements["retry-button"].textContent, "Uploading…");
    assert.equal(h.elements["retry-button"].disabled, true);
    assert.equal(h.elements["selection-note"].textContent, "Uploading 1 image. Keep this view open.");
    return uploadAsset(...args);
  };
  await page.begin(false);
  assert.equal(page.job.status, "complete");
  assert.equal(h.elements["progress-panel"].scrollCount, 1, "Starting shows progress once, not on every checkpoint");
  assert.equal(h.elements["retry-button"].textContent, "Retry unfinished images");
  assert.equal(h.elements["progress-empty"].hidden, true);
  assert.equal(h.elements["history-empty"].hidden, true);
  assert.equal(h.elements["results-list"].children[0].children[1].textContent, "Uploaded to Immich");
  assert.equal(h.elements["results-list"].children[0], activeResultRow,
    "Progress updates reuse the existing result row");
  assert.equal(h.elements["history-list"].children[0].children[1].textContent, "Complete");
  assert.deepEqual(h.calls.find(call => call[0] === "permission")[1].origins, ["http://192.168.0.103/*", "https://images.example/*"]);
  assert.equal(h.calls.filter(call => call[0] === "upload").length, 1);
  assert.equal(h.calls.filter(call => call[0] === "album").length, 0);
  assert.deepEqual(h.local["downloadLedger:v1"], { unchanged: true });
  assert.ok(!JSON.stringify(h.local).includes(SECRET));
  assert.deepEqual(Sync.snapshot(h.local), {}, "Upload results never enter general sync");
  assert.equal(h.local[Page.STORE_KEY], undefined, "New jobs use per-job storage");
  assert.equal(h.local[Page.INDEX_KEY].jobs.length, 1);
  for (const [status, label] of [["running", "Uploading"], ["queued", "Ready"], ["partial", "Needs attention"]]) {
    await page.store.save({ ...h.local[jobKey(page.job.id)], status });
    await page.refresh();
    assert.equal(h.elements["history-list"].children[0].children[1].textContent, label);
  }
  const otherJob = Uploads.createJob(sourceItems, { ownerId: OWNER, connectionId: CONNECTION,
    serverUrl: connection.serverUrl, id: "another-job" });
  await page.store.save(otherJob);
  const callsBeforeCheckpoint = h.calls.length;
  await page.store.save(page.job);
  const checkpointWrites = h.calls.slice(callsBeforeCheckpoint).filter(call => call[0] === "set");
  assert.deepEqual(checkpointWrites.map(call => call[1]), [[jobKey(page.job.id), Page.INDEX_KEY]],
    "A checkpoint writes only its job and the small index");
  assert.deepEqual(h.local[jobKey(otherJob.id)], otherJob, "Other saved uploads stay untouched");

  h = harness({ failAlbum: true });
  page = await h.start();
  h.elements["album-select"].value = ALBUM;
  await page.begin(false);
  assert.equal(page.job.status, "partial");
  assert.equal(page.job.items[0].assetId, ASSET);
  assert.equal(page.job.items[0].albumStatus, "failed");
  assert.match(h.elements["results-list"].children[0].children[1].textContent, /Uploaded to Immich · Album step failed/);
  assert.equal(h.elements["results-list"].children[0].dataset.error, "true");
  h.setAlbumFailure(false);
  await page.begin(true);
  assert.equal(page.job.status, "complete");
  assert.equal(h.calls.filter(call => call[0] === "fetch").length, 1, "Album retry does not fetch source bytes");
  assert.equal(h.calls.filter(call => call[0] === "upload").length, 1, "Album retry does not upload the asset again");
  assert.equal(h.calls.filter(call => call[0] === "album").length, 2);
  assert.equal(h.elements["progress-panel"].scrollCount, 2, "Retry returns to progress once more");

  h = harness();
  page = await h.start();
  h.elements["album-select"].value = ALBUM;
  const saveCheckpoint = h.browser.storage.local.set;
  let rejectAssetCheckpoint = true;
  h.browser.storage.local.set = async values => {
    if (rejectAssetCheckpoint && Object.entries(values).some(([key, entry]) =>
      key.startsWith(Page.JOB_KEY_PREFIX) && entry.items[0].assetId)) {
      rejectAssetCheckpoint = false;
      throw new Error("Disk unavailable");
    }
    return saveCheckpoint(values);
  };
  await page.begin(false);
  assert.equal(page.job.items[0].assetId, ASSET, "Confirmed asset survives a failed checkpoint in memory");
  assert.equal(h.local[jobKey(page.job.id)].items[0].assetId, null);
  await page.begin(true);
  assert.equal(page.job.status, "complete");
  assert.equal(h.calls.filter(call => call[0] === "upload").length, 1, "Checkpoint retry saves the known asset instead of uploading it again");
  assert.equal(h.calls.filter(call => call[0] === "album").length, 1);

  h = harness();
  page = await h.start();
  const saveInitial = h.browser.storage.local.set;
  h.browser.storage.local.set = async () => { throw new Error("Disk unavailable"); };
  await page.begin(false);
  assert.equal(page.job, null, "Failed initial persistence keeps the selection ready to start");
  assert.equal(h.elements["start-button"].hidden, false);
  h.browser.storage.local.set = saveInitial;
  await page.begin(false);
  assert.equal(page.job.status, "complete");

  h = harness();
  page = await h.start();
  h.elements["album-select"].value = ALBUM;
  let finishPermission;
  h.browser.permissions.request = () => new Promise(resolve => { finishPermission = resolve; });
  const pendingUpload = page.begin(false);
  await page.refresh(); // A token rotation or ordinary cloud sync may refresh this tab while permission is pending.
  assert.equal(h.elements["album-select"].value, ALBUM);
  finishPermission(true);
  await pendingUpload;
  assert.equal(page.job.albumId, ALBUM, "Sync refresh cannot change the album chosen at the Upload click");

  h = harness();
  h.setAccount({ signedIn: false, ownerId: "", email: "" });
  page = await h.start();
  assert.equal(h.elements["signin-card"].hidden, false);
  assert.ok(h.session["uploadJobRequest:request-123"], "Selected images wait for account sign-in");
  h.setAccount({ signedIn: true, ownerId: OWNER, email: "owner@example.com" });
  await page.refresh();
  assert.equal(h.elements["signin-card"].hidden, true);
  assert.equal(h.session["uploadJobRequest:request-123"], undefined);
  await page.begin(false);
  assert.equal(page.job.status, "complete", "The pending selection loads when the user returns after sign-in");
  const libraryJob = clone(page.job);
  connection.defaultAlbumId = ALBUM;
  h = harness({ href: `moz-extension://test/upload/upload.html?job=${libraryJob.id}`, stored: { [Page.STORE_KEY]: [libraryJob] } });
  page = await h.start();
  assert.equal(h.elements["album-select"].value, "", "Library-only history stays library-only when the connection default changes");
  assert.equal(h.local[Page.STORE_KEY], undefined, "Legacy upload history migrates after the new index is saved");
  assert.deepEqual(h.local[jobKey(libraryJob.id)], libraryJob);
  connection.defaultAlbumId = null;

  const migrationOne = Uploads.createJob(sourceItems, { ownerId: OWNER, connectionId: CONNECTION,
    serverUrl: connection.serverUrl, id: "migrate-one" });
  const migrationTwo = Uploads.createJob(sourceItems, { ownerId: OWNER, connectionId: CONNECTION,
    serverUrl: connection.serverUrl, id: "migrate-two" });
  h = harness({ stored: { [Page.STORE_KEY]: [migrationOne, migrationTwo] } });
  const migrationSet = h.browser.storage.local.set;
  let migrationWrites = 0;
  h.browser.storage.local.set = async values => {
    if (Object.hasOwn(values, Page.STORE_KEY) && ++migrationWrites === 2) throw new Error("Disk unavailable");
    return migrationSet(values);
  };
  await assert.rejects(Page.createStore(h.browser, h.locks).list(OWNER), /Disk unavailable/);
  assert.deepEqual(h.local[Page.STORE_KEY], [migrationTwo], "An interrupted migration keeps the remaining legacy job");
  h.browser.storage.local.set = migrationSet;
  assert.deepEqual(await Page.createStore(h.browser, h.locks).list(OWNER), [migrationOne, migrationTwo],
    "A fresh page resumes an interrupted migration without losing either job");
  assert.equal(h.local[Page.STORE_KEY], undefined);

  h = harness({ href: "moz-extension://test/upload/upload.html?embedded=1", stored: { [Page.STORE_KEY]: [libraryJob] } });
  await h.start();
  let prevented = false;
  h.elements["history-list"].children[0].children[0].listeners.click({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true, "Saved uploads keep navigation inside an embedded workspace");
  assert.deepEqual(h.workspaceCalls, [["upload", `?job=${libraryJob.id}`]]);

  const interrupted = Uploads.createJob(sourceItems, { ownerId: OWNER, connectionId: CONNECTION, serverUrl: connection.serverUrl });
  interrupted.status = "running"; interrupted.items[0].uploadStatus = "uploading";
  h = harness({ href: `moz-extension://test/upload/upload.html?job=${interrupted.id}`, stored: { [Page.STORE_KEY]: [interrupted] } });
  page = await h.start();
  assert.equal(page.job.status, "interrupted");
  assert.equal(page.job.items[0].uploadStatus, "uncertain");
  assert.equal(h.calls.some(call => call[0] === "upload"), false);
  await page.begin(true);
  assert.equal(page.job.status, "complete");

  h = harness();
  page = await h.start();
  let grant;
  h.browser.permissions.request = () => new Promise(resolve => { grant = resolve; });
  const cancelled = page.begin(false);
  h.elements["cancel-button"].listeners.click();
  grant(true);
  await cancelled;
  assert.equal(h.calls.some(call => call[0] === "upload"), false, "Cancellation while permission is pending prevents upload");

  h = harness({ href: "moz-extension://test/upload/upload.html" });
  page = await h.start();
  h.elements["local-files"].files = [new File([png], "saved-photo.png", { type: "image/png", lastModified: 12345 })];
  h.elements["local-files"].listeners.change();
  await page.begin(false);
  assert.equal(page.job.status, "complete", "Images already downloaded locally can be uploaded");
  assert.equal(h.calls.some(call => call[0] === "fetch"), false);
  assert.equal(h.local[jobKey(page.job.id)].items[0].url, null);
  assert.ok(!JSON.stringify(h.local).includes("base64"));

  h = harness();
  h.session["uploadJobRequest:request-123"] = {
    createdAt: Date.now(), incognito: false, autoStart: true,
    connectionId: CONNECTION, albumId: ALBUM, albumName: "Selected album",
    items: [{ url: "https://videos.example/clip.mp4", filename: "clip.mp4", mediaType: "video" }]
  };
  page = await h.start();
  assert.equal(page.job.status, "complete", "A destination chosen in Media starts the embedded upload automatically");
  assert.equal(page.job.items[0].mediaType, "video");
  assert.equal(page.job.albumId, ALBUM);
  assert.equal(h.elements["selection-count"].textContent, "1 video");
  assert.equal(h.calls.filter(call => call[0] === "upload").length, 1, "Direct video bytes are uploaded to Immich");
  const oldJob = clone(page.job);
  h.setAccount({ signedIn: true, ownerId: "55555555-5555-4555-8555-555555555555", email: "second@example.com" });
  await page.refresh();
  assert.equal(page.job, null);
  assert.equal(h.elements["results-list"].children.length, 0);
  assert.equal(h.elements["progress-empty"].hidden, false);
  assert.equal(h.elements["history-empty"].hidden, false);
  assert.equal(h.elements["progress-summary"].textContent, "No upload started.");
  assert.equal((await page.store.list("55555555-5555-4555-8555-555555555555")).length, 0);
  assert.deepEqual((await page.store.list(OWNER))[0], oldJob);

  const fullStore = Page.createStore(h.browser, h.locks);
  for (let index = 0; index < 19; index++) await fullStore.save({ ...oldJob, id: `history-${index}` });
  await assert.rejects(fullStore.save({ ...oldJob, id: "one-too-many" }), /history is full/);
  assert.equal(h.local[Page.INDEX_KEY].jobs.length, 20);
  assert.throws(() => Page.validateRequest({ createdAt: Date.now(), incognito: true, items: sourceItems }), /invalid/);
  assert.throws(() => Page.validateRequest({ createdAt: 0, incognito: false, items: sourceItems }), /expired/);
  console.log("Upload Progress tests passed: permissions, separate ledger, local files, album-only retry, interruption, cancellation, account isolation, bounded history.");
})().catch(error => { console.error(error); process.exitCode = 1; });
