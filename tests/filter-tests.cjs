"use strict";

const assert = require("assert").strict;
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const Filters = require("../extension/shared/filters.js");

const filterSource = fs.readFileSync(
  path.resolve(__dirname, "../extension/shared/filters.js"),
  "utf8"
);
const browserContext = {};
vm.createContext(browserContext);
vm.runInContext(filterSource, browserContext);
assert.equal(
  typeof browserContext.ImageDownloaderFilters.matchesSmartFilters,
  "function",
  "The browser build must expose ImageDownloaderFilters"
);

assert.deepEqual(Object.keys(Filters).sort(), [
  "DEFAULT_FILTERS",
  "hasActiveSmartFilters",
  "imageFileType",
  "isLikelyPhoto",
  "matchesSmartFilters",
  "normalizeFilters"
].sort());
assert.ok(Object.isFrozen(Filters.DEFAULT_FILTERS));
assert.deepEqual(Filters.normalizeFilters(), Filters.DEFAULT_FILTERS);

assert.deepEqual(Filters.normalizeFilters({
  photosOnly: "yes",
  minWidth: "299.6",
  minHeight: -12,
  format: "JPG",
  orientation: "PORTRAIT",
  includeUnknown: "off"
}), {
  photosOnly: true,
  minWidth: 300,
  minHeight: 0,
  format: "jpeg",
  orientation: "portrait",
  includeUnknown: false
});
assert.deepEqual(Filters.normalizeFilters({
  minWidth: Infinity,
  minHeight: "99999999",
  format: "executable",
  orientation: "diagonal",
  photosOnly: "maybe",
  includeUnknown: null
}), {
  photosOnly: false,
  minWidth: 0,
  minHeight: 1000000,
  format: "any",
  orientation: "any",
  includeUnknown: true
});

const hostileFilters = {};
Object.defineProperty(hostileFilters, "minWidth", {
  get() {
    throw new Error("hostile getter");
  }
});
assert.doesNotThrow(() => Filters.normalizeFilters(hostileFilters));
assert.equal(Filters.normalizeFilters(hostileFilters).minWidth, 0);
assert.doesNotThrow(() => Filters.normalizeFilters({ minWidth: Symbol("unsafe") }));
assert.equal(Filters.normalizeFilters({
  minHeight: { valueOf() { throw new Error("unsafe coercion"); } }
}).minHeight, 0);

assert.equal(Filters.imageFileType({ url: "https://cdn.test/photo.JPG?size=large" }), "jpeg");
assert.equal(Filters.imageFileType({ url: "https://cdn.test/render?id=2&format=webp" }), "webp");
assert.equal(Filters.imageFileType({ url: "https://cdn.test/render?fm=avif" }), "avif");
assert.equal(Filters.imageFileType({ url: "data:image/svg+xml,%3Csvg%3E" }), "svg");
assert.equal(Filters.imageFileType({ url: "data:image/png;base64,AA==" }), "png");
assert.equal(Filters.imageFileType({ url: "https://cdn.test/no-extension", mimeType: "image/jpeg; charset=binary" }), "jpeg");
assert.equal(Filters.imageFileType({ url: "https://cdn.test/animation.apng" }), "png");
assert.equal(Filters.imageFileType({ url: "https://cdn.test/file.bmp" }), "unknown");
assert.equal(Filters.imageFileType(null), "unknown");

const normalPhoto = {
  url: "https://gallery.test/holidays/sunset-001.webp",
  alt: "Sunset over a lake",
  width: 1920,
  height: 1080
};
assert.equal(Filters.isLikelyPhoto(normalPhoto), true);
for (const url of [
  "https://site.test/assets/company-logo.png",
  "https://site.test/icons/menu.png",
  "https://site.test/avatar/user-42.jpg",
  "https://site.test/sprites/ui.webp",
  "https://site.test/emoji/smile.png",
  "https://metrics.test/tracking/pixel.gif",
  "https://site.test/transparent_spacer.png",
  "https://site.test/favicon.ico"
]) {
  assert.equal(
    Filters.isLikelyPhoto({ url, width: 1200, height: 800 }),
    false,
    `${url} should not be treated as a photo`
  );
}
assert.equal(Filters.isLikelyPhoto({
  url: "https://site.test/assets/brand.png",
  alt: "Company logo",
  width: 1200,
  height: 800
}), false);
assert.equal(Filters.isLikelyPhoto({ url: "https://site.test/art.svg", width: 1200, height: 800 }), false);
assert.equal(Filters.isLikelyPhoto({ url: "https://site.test/tiny.jpg", width: 120, height: 100 }), false);
assert.equal(Filters.isLikelyPhoto({ url: "https://site.test/strip.jpg", width: 1600, height: 50 }), false);
assert.equal(Filters.isLikelyPhoto({ url: "https://site.test/photo.jpg", width: 400, height: 300 }), true);
assert.equal(
  Filters.isLikelyPhoto({ url: "https://site.test/photo-with-unknown-size.jpg", width: 0, height: 0 }),
  true,
  "Unknown dimensions should not make a safe image fail the photo heuristic"
);

assert.equal(Filters.matchesSmartFilters(normalPhoto, {}), true);
assert.equal(Filters.matchesSmartFilters(normalPhoto, { minWidth: 2000 }), false);
assert.equal(Filters.matchesSmartFilters(normalPhoto, { minWidth: 1900, minHeight: 1000 }), true);
assert.equal(Filters.matchesSmartFilters(normalPhoto, { format: "webp" }), true);
assert.equal(Filters.matchesSmartFilters(normalPhoto, { format: "jpeg" }), false);
assert.equal(Filters.matchesSmartFilters(normalPhoto, { orientation: "landscape" }), true);
assert.equal(Filters.matchesSmartFilters(normalPhoto, { orientation: "portrait" }), false);
assert.equal(Filters.matchesSmartFilters({ ...normalPhoto, width: 900, height: 1200 }, { orientation: "portrait" }), true);
assert.equal(Filters.matchesSmartFilters({ ...normalPhoto, width: 900, height: 900 }, { orientation: "square" }), true);
assert.equal(Filters.matchesSmartFilters({ ...normalPhoto, width: 901, height: 900 }, { orientation: "square" }), false);

const unknownSize = { url: "https://gallery.test/full/photo-2.jpg", width: 0, height: 0 };
assert.equal(Filters.matchesSmartFilters(unknownSize, { minWidth: 2000, includeUnknown: true }), true);
assert.equal(Filters.matchesSmartFilters(unknownSize, { orientation: "portrait", includeUnknown: true }), true);
assert.equal(Filters.matchesSmartFilters(unknownSize, { includeUnknown: false }), false);
assert.equal(Filters.matchesSmartFilters(
  { url: "https://gallery.test/photo.jpg", width: 100, height: 0 },
  { minWidth: 500, includeUnknown: true }
), false);
assert.equal(Filters.matchesSmartFilters(
  { url: "https://site.test/logo.png", width: 0, height: 0 },
  { photosOnly: true, includeUnknown: true }
), false);
assert.equal(Filters.matchesSmartFilters(normalPhoto, { photosOnly: true }), true);
assert.equal(Filters.matchesSmartFilters(null, {}), false);

assert.equal(Filters.hasActiveSmartFilters(), false);
assert.equal(Filters.hasActiveSmartFilters({}), false);
assert.equal(Filters.hasActiveSmartFilters({ photosOnly: true }), true);
assert.equal(Filters.hasActiveSmartFilters({ minWidth: 1 }), true);
assert.equal(Filters.hasActiveSmartFilters({ minHeight: 1 }), true);
assert.equal(Filters.hasActiveSmartFilters({ format: "png" }), true);
assert.equal(Filters.hasActiveSmartFilters({ orientation: "square" }), true);
assert.equal(Filters.hasActiveSmartFilters({ includeUnknown: false }), true);
assert.equal(Filters.hasActiveSmartFilters({ format: "invalid", minWidth: -5 }), false);

console.log("All smart-filter checks passed.");
