"use strict";

const assert = require("node:assert/strict");
const Gallery = require("../extension/shared/gallery.js");

const siteKey = "https://gallery.test";
const photo = {
  url: "https://cdn.test/photo.jpg#fragment",
  pageUrl: `${siteKey}/page#fragment`,
  previewUrl: "",
  selected: true
};

assert.equal(Gallery.pageUrl("https://user:pass@gallery.test/page"), "");
assert.equal(Gallery.pageUrl("ftp://gallery.test/page"), "");
assert.equal(Gallery.pageUrl(`${siteKey}/page#fragment`), `${siteKey}/page`);
assert.equal(Gallery.pageUrl("https://web.telegram.org/a/#session"), "https://web.telegram.org/a/#session");
assert.equal(Gallery.pageUrl(`${siteKey}/${"a".repeat(16384)}`), "");

const normalized = Gallery.normalizeRecord(photo, siteKey);
assert.equal(normalized.url, "https://cdn.test/photo.jpg");
assert.equal(normalized.pageUrl, `${siteKey}/page`);
assert.equal(normalized.previewUrl, "");
for (const url of [
  "https://googlevideo.com/videoplayback?sig=secret",
  "https://r1.googlevideo.com/videoplayback?sig=secret",
  "https://%67ooglevideo.com/videoplayback?sig=secret",
  "https://user:pass@cdn.test/photo.jpg",
  "blob:https://web.telegram.org/1234-abcd",
  "javascript:alert(1)"
]) {
  assert.equal(Gallery.normalizeRecord({ ...photo, url }, siteKey), null, url);
  assert.equal(Gallery.normalizeRecord({ ...photo, previewUrl: url }, siteKey).previewUrl, "", url);
}
assert.equal(Gallery.normalizeRecord({
  ...photo, url: "https://googlevideo.com.evil.test/photo.jpg"
}, siteKey).url, "https://googlevideo.com.evil.test/photo.jpg");
assert.equal(Gallery.normalizeRecord({
  ...photo, url: "data:image/png;base64,AAAA"
}, siteKey).url, "data:image/png;base64,AAAA");
assert.equal(Gallery.normalizeRecord({ ...photo, pageUrl: "https://other.test/page" }, siteKey), null);
assert.equal(Gallery.normalizeRecord({ ...photo, pageUrl: "https://user:pass@gallery.test/page" }, siteKey), null);
assert.equal(Gallery.normalizeRecord({
  ...photo, pageUrl: "https://web.telegram.org/a/#session"
}, "https://web.telegram.org"), null);

// A later normalization must revalidate source pages after the caller edits a
// record. Reuse is confined to the current bounded site normalization.
const mutable = { ...photo };
assert.equal(Gallery.normalizeSite({ siteKey, records: [mutable] }).records.length, 1);
mutable.pageUrl = "https://other.test/page";
assert.equal(Gallery.normalizeSite({ siteKey, records: [mutable] }).records.length, 0);
mutable.pageUrl = `${siteKey}/another-page`;
assert.equal(Gallery.normalizeSite({ siteKey, records: [mutable] }).records[0].pageUrl, mutable.pageUrl);

const records = Array.from({ length: 5000 }, (_, index) => ({
  ...photo, url: `https://cdn.test/${index}.jpg`
}));
const NativeURL = globalThis.URL;
let urlConstructions = 0;
let invalidUrlConstructions = 0;
globalThis.URL = class CountingURL extends NativeURL {
  constructor(...args) {
    urlConstructions += 1;
    try {
      super(...args);
    } catch (error) {
      invalidUrlConstructions += 1;
      throw error;
    }
  }
};
try {
  const gallery = Gallery.normalizeSite({ siteKey, records });
  assert.equal(gallery.records.length, records.length);
  assert.equal(gallery.trimmed, false);
} finally {
  globalThis.URL = NativeURL;
}
assert.equal(invalidUrlConstructions, 0, "Empty optional previews must not throw URL parse errors");
assert.ok(urlConstructions <= 16000,
  `A shared-page gallery should reuse source validation; constructed ${urlConstructions} URLs`);

console.log(`Gallery normalization checks passed (${urlConstructions.toLocaleString("en-US")} URL parses, no invalid parses).`);
