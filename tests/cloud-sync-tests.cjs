"use strict";

const assert = require("assert").strict;
const Core = require("../extension/shared/core.js");
const Ledger = require("../extension/shared/download-ledger.js");
const Sync = require("../extension/shared/cloud-sync.js");

const site = "https://example.test";
const ignoreKey = `ignoredImage:${encodeURIComponent(site)}:${Core.ignoreKeyForUrl(`${site}/a.jpg`)}`;
const ledgerEntry = {
  siteKey: site,
  fingerprint: Ledger.mediaFingerprint({ url: `${site}/a.jpg` }),
  completedAt: 100,
  filename: "a.jpg",
  mediaType: "image"
};
const ledgerKey = `ledger:${encodeURIComponent(site)}:${ledgerEntry.fingerprint}`;
const local = {
  includeBackgrounds: true,
  filenameTemplate: " {index}-{filename} ",
  smartFilters: { photosOnly: "yes", format: "jpg" },
  mediaLayout: "grid",
  [ignoreKey]: 100,
  [Ledger.STORAGE_KEY]: { schemaVersion: 1, entries: [ledgerEntry] },
  destinationFolder: "device/path",
  askForSingle: true,
  "downloadQueue:v1": { privateInformation: "not uploaded" },
  "cloudSync:v1": { accessToken: "not uploaded" },
  "gallery:private": { url: "not uploaded" }
};
const clean = Sync.snapshot(local);
assert.deepEqual(clean, {
  filenameTemplate: "{index}-{filename}",
  [ignoreKey]: 100,
  includeBackgrounds: true,
  [ledgerKey]: ledgerEntry,
  mediaLayout: "grid",
  smartFilters: { mediaType: "any", photosOnly: true, format: "jpeg" }
});
assert.deepEqual(Sync.snapshot(Sync.toStorage(clean)), clean, "Snapshot round trips preserve allowed data only");
assert.deepEqual(Sync.toStorage({}), { [Ledger.STORAGE_KEY]: Ledger.emptyState() });
assert.equal(Sync.equal({ a: { b: 1 }, c: false }, { c: false, a: { b: 1 } }), true);
assert.equal(Sync.equal({}, { a: undefined }), false);

const base = { includeBackgrounds: true, filenameTemplate: "{filename}", [ignoreKey]: 100, [ledgerKey]: ledgerEntry };
const device = { includeBackgrounds: false, filenameTemplate: "{filename}", mediaLayout: "list" };
const remote = { includeBackgrounds: true, filenameTemplate: "{index}-{filename}", [ignoreKey]: 200, [ledgerKey]: ledgerEntry };
assert.deepEqual(Sync.merge(base, device, remote), {
  includeBackgrounds: false,
  filenameTemplate: "{index}-{filename}",
  mediaLayout: "list"
}, "Local edits and deletions win conflicts; untouched local fields accept remote changes");
assert.deepEqual(Sync.merge(base, base, {}), {}, "A remote deletion propagates when local data is unchanged");
assert.deepEqual(Sync.merge({}, { mediaLayout: "list" }, { includeBackgrounds: false }), {
  includeBackgrounds: false, mediaLayout: "list"
}, "First sync combines independent records");
assert.equal(Sync.merge({}, { mediaLayout: "list" }, { mediaLayout: "grid" }).mediaLayout, "list");

for (const bad of [
  null,
  [],
  { destinationFolder: "private" },
  { includeBackgrounds: "true" },
  { filenameTemplate: "../{filename}" },
  { filenameTemplate: " {filename}" },
  { mediaLayout: "unknown" },
  { smartFilters: { mediaType: "any", photosOnly: false, format: "jpeg", token: "secret" } },
  { smartFilters: { mediaType: "any", photosOnly: false, format: "jpg" } },
  { [ignoreKey]: "100" },
  { [ignoreKey]: -1 },
  { [ignoreKey]: Number.MAX_SAFE_INTEGER + 1 },
  { [ignoreKey.replace("%3A", "%3a")]: 100 },
  { [ignoreKey.replace("https%3A", "file%3A")]: 100 },
  { [ignoreKey.replace("https%3A", "https%3A%2F%2Fevil.test%2F")]: 100 },
  { [ignoreKey.replace(/:[0-9]+:/, ":01:")]: 100 },
  { [ledgerKey]: { ...ledgerEntry, siteKey: `${site}/path` } },
  { [ledgerKey]: { ...ledgerEntry, completedAt: "100" } },
  { [ledgerKey]: { ...ledgerEntry, fingerprint: "0000000000000000" } },
  { [ledgerKey]: { ...ledgerEntry, filename: "\u0000bad.jpg" } },
  { [ledgerKey]: { ...ledgerEntry, mediaType: "other" } },
  { [ledgerKey]: { ...ledgerEntry, url: "not allowed" } },
  JSON.parse('{"__proto__":{"polluted":true}}')
]) {
  assert.throws(() => Sync.normalizeSnapshot(bad), undefined, "Inbound malformed records must fail, never silently delete local data");
  assert.throws(() => Sync.merge({}, {}, bad));
}
assert.equal({}.polluted, undefined);
assert.throws(() => Sync.normalizeSnapshot({ extra: "é".repeat(Sync.MAX_BYTES / 2) }), /4 MiB/, "Payload limit counts UTF-8 bytes");
assert.throws(() => Sync.normalizeSnapshot(Object.fromEntries(Array.from({ length: 10005 }, (_value, index) => [index, 0]))), /record limit/);

function ignored(index, website = site) {
  return `ignoredImage:${encodeURIComponent(website)}:url:30:${index.toString(16).padStart(16, "0")}`;
}
const tooMany = Object.fromEntries(Array.from({ length: 501 }, (_value, index) => [ignored(index), index]));
assert.throws(() => Sync.normalizeSnapshot(tooMany), /excessive/);
const bounded = Sync.snapshot(tooMany);
assert.equal(Object.keys(bounded).length, 500);
assert.equal(bounded[ignored(0)], undefined, "Per-site pruning keeps the newest rules");
const mergedOverflow = Sync.merge({}, bounded, { [ignored(501)]: 501 });
assert.equal(Object.keys(mergedOverflow).length, 500);
assert.equal(mergedOverflow[ignored(1)], undefined);
assert.equal(mergedOverflow[ignored(501)], 501);

const manySites = Object.fromEntries(Array.from({ length: 5001 }, (_value, index) => [ignored(index, `https://site${Math.floor(index / 500)}.test`), index]));
assert.throws(() => Sync.normalizeSnapshot(manySites), /excessive/);
assert.equal(Object.keys(Sync.snapshot(manySites)).length, 5000);
const ledgerOverflow = Object.fromEntries(Array.from({ length: 501 }, (_value, index) => {
  const entry = { ...ledgerEntry, fingerprint: index.toString(16).padStart(16, "0"), completedAt: index };
  return [`ledger:${encodeURIComponent(site)}:${entry.fingerprint}`, entry];
}));
assert.throws(() => Sync.normalizeSnapshot(ledgerOverflow), /excessive/);
const ledgerBounded = Sync.snapshot({ [Ledger.STORAGE_KEY]: { schemaVersion: 1, entries: Object.values(ledgerOverflow) } });
assert.equal(Object.keys(ledgerBounded).length, 500);
assert.equal(Sync.toStorage(ledgerBounded)[Ledger.STORAGE_KEY].entries[0].completedAt, 500);

const fs = require("fs");
const vm = require("vm");
let callback;
vm.runInNewContext(fs.readFileSync(require.resolve("../supabase/functions/sync-callback/index.ts"), "utf8"), {
  Deno: { serve: (handler) => { callback = handler; } }, Response
});
async function checkCallback() {
  const response = callback(new Request("https://project.supabase.co/functions/v1/sync-callback?code=secret&state=secret"));
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
  assert.match(response.headers.get("Content-Security-Policy"), /default-src 'none'/);
  assert.equal(response.headers.get("Content-Type"), "text/plain; charset=utf-8");
  assert.doesNotMatch(await response.text(), /secret/);
  console.log("Cloud sync model and callback tests passed.");
}
checkCallback().catch((error) => { console.error(error); process.exitCode = 1; });
