"use strict";

const assert = require("assert").strict;
const Ledger = require("../extension/shared/download-ledger.js");

const signed = {
  url: "https://cdn.example.test/photo.jpg?size=large&token=first&expires=100"
};
const refreshed = {
  url: "https://cdn.example.test/photo.jpg?expires=200&token=second&size=large"
};
assert.equal(
  Ledger.mediaFingerprint(signed),
  Ledger.mediaFingerprint(refreshed),
  "Rotating CDN credentials must retain downloaded identity"
);
assert.notEqual(
  Ledger.mediaFingerprint(signed),
  Ledger.mediaFingerprint({ url: "https://cdn.example.test/photo.jpg?size=small" }),
  "Content and transform parameters must remain part of downloaded identity"
);
assert.equal(
  Ledger.mediaFingerprint({ url: signed.url, identityKey: "instagram:post:1" }),
  Ledger.mediaFingerprint({ url: "https://other.test/changed.jpg", identityKey: "instagram:post:1" })
);
assert.equal(Ledger.siteKeyForUrl("https://example.test/gallery/path"), "https://example.test");
assert.equal(Ledger.siteKeyForUrl("data:image/png;base64,AA=="), "");

const fingerprint = Ledger.mediaFingerprint(signed);
const first = Ledger.recordCompletions(Ledger.emptyState(), [{
  siteKey: "https://example.test/gallery",
  fingerprint,
  completedAt: 100,
  filename: "photo.jpg",
  mediaType: "image"
}], { now: 100 });
assert.equal(first.entries.length, 1);
assert.deepEqual(
  Ledger.findEntry(first, "https://example.test/another-page", fingerprint),
  {
    siteKey: "https://example.test",
    fingerprint,
    completedAt: 100,
    filename: "photo.jpg",
    mediaType: "image"
  }
);
assert.equal(
  Ledger.findEntry(first, "https://different.test", fingerprint),
  null,
  "Completed identities must stay scoped to their source website"
);

const updated = Ledger.recordCompletions(first, [{
  siteKey: "https://example.test",
  fingerprint,
  completedAt: 200,
  filename: "renamed.jpg",
  mediaType: "image"
}], { now: 200 });
assert.equal(updated.entries.length, 1, "Repeated completions should update rather than duplicate the ledger entry");
assert.equal(updated.entries[0].completedAt, 200);
assert.equal(updated.entries[0].filename, "renamed.jpg");

const overflowing = Ledger.hydrate({
  schemaVersion: 1,
  entries: Array.from({ length: Ledger.MAX_ENTRIES_PER_SITE + 5 }, (_value, index) => ({
    siteKey: "https://bounded.test",
    fingerprint: index.toString(16).padStart(16, "0"),
    completedAt: index + 1,
    filename: `${index}.jpg`
  }))
});
assert.equal(overflowing.entries.length, Ledger.MAX_ENTRIES_PER_SITE);
assert.equal(overflowing.entries[0].completedAt, Ledger.MAX_ENTRIES_PER_SITE + 5);
assert.equal(
  overflowing.entries[overflowing.entries.length - 1].completedAt,
  6,
  "Per-site pruning should keep the newest completed records"
);
assert.deepEqual(Ledger.hydrate({ schemaVersion: 999, entries: first.entries }), Ledger.emptyState());

console.log("Download ledger model tests passed.");
