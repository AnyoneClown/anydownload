"use strict";

const assert = require("assert").strict;
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const Duplicates = require("../extension/shared/duplicates.js");

const duplicateSource = fs.readFileSync(
  path.resolve(__dirname, "../extension/shared/duplicates.js"),
  "utf8"
);
const browserContext = { URL, URLSearchParams };
vm.createContext(browserContext);
vm.runInContext(duplicateSource, browserContext);
assert.equal(
  typeof browserContext.ImageDownloaderDuplicates.analyzeDuplicates,
  "function",
  "The browser build must expose ImageDownloaderDuplicates"
);
assert.deepEqual(Object.keys(Duplicates).sort(), [
  "analyzeDuplicates",
  "chooseBestRecord",
  "findDuplicateGroups",
  "normalizeImageUrl",
  "recommendedUrlsToDeselect",
  "scoreRecord",
  "variantDescriptor"
].sort());

assert.equal(
  Duplicates.normalizeImageUrl("https://EXAMPLE.test:443/photo.jpg#preview"),
  "https://example.test/photo.jpg"
);
assert.equal(Duplicates.normalizeImageUrl("javascript:alert(1)"), "");
assert.equal(Duplicates.normalizeImageUrl("data:image/png;base64,AA=="), "data:image/png;base64,AA==");

const variant = Duplicates.variantDescriptor(
  "https://cdn.test/gallery/sunset-77.jpg?id=asset-8&w=320&height=180&q=70&utm_source=feed"
);
assert.equal(variant.key, "https://cdn.test/gallery/sunset-77.jpg?id=asset-8");
assert.deepEqual(
  variant.strippedParameters.map((parameter) => parameter.name),
  ["w", "height", "q", "utm_source"]
);
assert.equal(
  Duplicates.variantDescriptor("https://cdn.test/image?id=first&w=200").key,
  "https://cdn.test/image?id=first"
);
assert.equal(
  Duplicates.variantDescriptor("https://cdn.test/image?id=second&w=200").key,
  "https://cdn.test/image?id=second",
  "identity-bearing query parameters must never be stripped"
);

const semanticResizeVariant = Duplicates.variantDescriptor(
  "https://cdn.test/image.jpg?w=1200&height=800&dpr=2.5&q=85&format=webp&fm=AVIF"
);
assert.equal(semanticResizeVariant.key, "https://cdn.test/image.jpg");
assert.deepEqual(
  semanticResizeVariant.strippedParameters.map((parameter) => parameter.name),
  ["w", "height", "dpr", "q", "format", "fm"]
);

for (const [parameter, value] of [
  ["w", "hero"],
  ["width", "0"],
  ["h", "320px"],
  ["height", "auto"],
  ["dpr", "retina"],
  ["dpr", "0"],
  ["q", "best"],
  ["quality", "101"],
  ["format", "campaign"],
  ["fm", "json"]
]) {
  const url = `https://cdn.test/image.jpg?${parameter}=${value}`;
  const descriptor = Duplicates.variantDescriptor(url);
  assert.equal(descriptor.key, url, `${parameter}=${value} must remain identity-bearing`);
  assert.deepEqual(descriptor.strippedParameters, []);
}

const invalidResizeValues = Duplicates.analyzeDuplicates([
  { url: "https://cdn.test/gallery/hero.jpg?w=wide", width: 1200, height: 800 },
  { url: "https://cdn.test/gallery/hero.jpg?w=sidebar", width: 600, height: 400 }
]);
assert.equal(
  invalidResizeValues.groups.length,
  0,
  "resize-named parameters with non-resize values must distinguish images"
);

const resizedRecords = [
  {
    url: "https://cdn.test/gallery/sunset-77.jpg?w=320&h=180&q=55&utm_source=feed",
    width: 320,
    height: 180,
    kinds: ["Image"]
  },
  {
    url: "https://cdn.test/gallery/sunset-77.jpg?width=2560&height=1440&quality=92",
    width: 2560,
    height: 1440,
    kinds: ["Largest responsive image"]
  }
];
const resizedResult = Duplicates.analyzeDuplicates(resizedRecords);
assert.equal(resizedResult.groups.length, 1);
assert.equal(resizedResult.groups[0].kind, "likely");
assert.deepEqual(resizedResult.groups[0].indexes, [0, 1]);
assert.equal(resizedResult.groups[0].bestRecord, resizedRecords[1]);
assert.deepEqual(resizedResult.groups[0].reasons, ["resized-url-variant"]);
assert.ok(resizedResult.groups[0].corroboration.includes("matching-aspect-ratio"));
assert.ok(resizedResult.groups[0].corroboration.includes("matching-filename"));
assert.deepEqual(resizedResult.recommendedUrlsToDeselect, [resizedRecords[0].url]);
assert.deepEqual(resizedResult.recommendedIndexesToDeselect, [0]);

const distinctQueryIds = Duplicates.analyzeDuplicates([
  { url: "https://cdn.test/gallery/photo-99.jpg?id=one&w=300", width: 300, height: 200 },
  { url: "https://cdn.test/gallery/photo-99.jpg?id=two&w=1200", width: 1200, height: 800 }
]);
assert.equal(distinctQueryIds.groups.length, 0, "different query IDs must remain distinct images");

const genericEndpoint = Duplicates.analyzeDuplicates([
  { url: "https://cdn.test/image?w=300", width: 0, height: 0 },
  { url: "https://cdn.test/image?w=1200", width: 0, height: 0 }
]);
assert.equal(
  genericEndpoint.groups.length,
  0,
  "a generic endpoint without dimensions, filename, or source corroboration is unsafe to merge"
);

const previewUrl = "https://cdn.test/previews/cat-42.jpg";
const fullRecord = {
  url: "https://cdn.test/original/cat-42.jpg",
  previewUrl,
  width: 0,
  height: 0,
  kinds: ["Original image"]
};
const previewRecord = {
  url: previewUrl,
  width: 640,
  height: 480,
  kinds: ["Image"]
};
const linkedResult = Duplicates.analyzeDuplicates([previewRecord, fullRecord]);
assert.equal(linkedResult.groups.length, 1);
assert.equal(linkedResult.groups[0].kind, "exact");
assert.deepEqual(linkedResult.groups[0].indexes, [0, 1], "record order must remain stable");
assert.equal(linkedResult.groups[0].bestRecord, fullRecord, "an unknown-size original must beat its known-size preview");
assert.deepEqual(linkedResult.groups[0].recommendedUrlsToDeselect, [previewUrl]);
assert.ok(linkedResult.groups[0].reasons.includes("preview-full-link"));

const fallbackPreview = "https://cdn.test/fallback/no-image.png";
const fallbackPreviewResult = Duplicates.analyzeDuplicates([
  {
    url: "https://cdn.test/full/product-alpha.jpg",
    previewUrl: fallbackPreview,
    sourceId: "shared-placeholder-source",
    width: 1200,
    height: 800
  },
  {
    url: "https://cdn.test/full/product-beta.jpg",
    previewUrl: fallbackPreview,
    sourceId: "shared-placeholder-source",
    width: 600,
    height: 400
  }
]);
assert.equal(
  fallbackPreviewResult.groups.length,
  0,
  "shared fallback/no-image previews must never be duplicate hubs"
);

const fallbackPrimaryResult = Duplicates.analyzeDuplicates([
  { url: fallbackPreview, width: 64, height: 64 },
  {
    url: "https://cdn.test/full/product-gamma.jpg",
    previewUrl: fallbackPreview,
    width: 1200,
    height: 800
  }
]);
assert.equal(
  fallbackPrimaryResult.groups.length,
  0,
  "a fallback preview must not form an exact preview-to-primary link"
);

const ambiguousPreview = "https://cdn.test/previews/shared-card.jpg";
const ambiguousPreviewResult = Duplicates.analyzeDuplicates([
  { url: ambiguousPreview, width: 320, height: 180 },
  {
    url: "https://cdn.test/full/card-alpha.jpg",
    previewUrl: ambiguousPreview,
    width: 1280,
    height: 720
  },
  {
    url: "https://cdn.test/full/card-beta.jpg",
    previewUrl: ambiguousPreview,
    width: 1920,
    height: 1080
  }
]);
assert.equal(
  ambiguousPreviewResult.groups.length,
  0,
  "an exact preview link must not fan one preview into multiple primary records"
);

const repeatedPreviewPrimaryResult = Duplicates.analyzeDuplicates([
  { url: ambiguousPreview, width: 320, height: 180 },
  { url: ambiguousPreview, width: 640, height: 360 },
  {
    url: "https://cdn.test/full/card-gamma.jpg",
    previewUrl: ambiguousPreview,
    width: 1920,
    height: 1080
  }
]);
assert.equal(repeatedPreviewPrimaryResult.groups.length, 1);
assert.deepEqual(repeatedPreviewPrimaryResult.groups[0].indexes, [0, 1]);
assert.deepEqual(repeatedPreviewPrimaryResult.groups[0].reasons, ["same-url"]);

const sharedPreview = "https://cdn.test/previews/event-main.jpg";
const sharedPreviewRecords = [
  {
    url: "https://cdn.test/full/event-main.jpg?width=800",
    previewUrl: sharedPreview,
    width: 800,
    height: 600,
    sourceId: "gallery-item-14"
  },
  {
    url: "https://cdn.test/full/event-main.jpg?width=2400",
    previewUrl: sharedPreview,
    width: 2400,
    height: 1800,
    sourceId: "gallery-item-14"
  }
];
const sharedPreviewResult = Duplicates.analyzeDuplicates(sharedPreviewRecords);
assert.equal(sharedPreviewResult.groups.length, 1);
assert.equal(sharedPreviewResult.groups[0].kind, "likely");
assert.equal(sharedPreviewResult.groups[0].bestRecord, sharedPreviewRecords[1]);
assert.ok(sharedPreviewResult.groups[0].reasons.includes("same-preview"));

const weakSharedPreview = "https://cdn.test/previews/layout.jpg";
const weakSharedPreviewResult = Duplicates.analyzeDuplicates([
  {
    url: "https://cdn.test/full/article-alpha.jpg",
    previewUrl: weakSharedPreview,
    width: 800,
    height: 600,
    alt: "The same generic gallery preview"
  },
  {
    url: "https://images.test/full/article-beta.jpg",
    previewUrl: weakSharedPreview,
    width: 1600,
    height: 1200,
    alt: "The same generic gallery preview"
  }
]);
assert.equal(
  weakSharedPreviewResult.groups.length,
  0,
  "aspect ratio and alt text alone are too weak to merge records sharing a preview"
);

const filenameCorroboratedPreviewResult = Duplicates.analyzeDuplicates([
  {
    url: "https://cdn.test/full/launch-story-large.jpg",
    previewUrl: weakSharedPreview,
    width: 1600,
    height: 900
  },
  {
    url: "https://images.test/originals/launch-story-thumbnail.webp",
    previewUrl: weakSharedPreview,
    width: 400,
    height: 300
  }
]);
assert.equal(filenameCorroboratedPreviewResult.groups.length, 1);
assert.deepEqual(filenameCorroboratedPreviewResult.groups[0].reasons, ["same-preview"]);
assert.ok(filenameCorroboratedPreviewResult.groups[0].corroboration.includes("matching-filename"));

const filenameVariants = [
  { url: "https://images.test/set/mountain-view-320x180.jpg", width: 320, height: 180 },
  { url: "https://images.test/set/mountain-view-1920x1080.webp", width: 1920, height: 1080 }
];
const filenameResult = Duplicates.analyzeDuplicates(filenameVariants);
assert.equal(filenameResult.groups.length, 1);
assert.equal(filenameResult.groups[0].kind, "likely");
assert.ok(filenameResult.groups[0].reasons.includes("filename-dimension-match"));
assert.equal(filenameResult.groups[0].bestRecord, filenameVariants[1]);

const explicitFilenameVariants = [
  { url: "https://images.test/set/city-320x180.jpg", width: 320, height: 180 },
  { url: "https://images.test/set/city-w1280.webp", width: 1280, height: 720 },
  { url: "https://images.test/set/city-h1080.png", width: 1920, height: 1080 },
  { url: "https://images.test/set/city-full.jpeg", width: 3840, height: 2160 }
];
const explicitFilenameResult = Duplicates.analyzeDuplicates(explicitFilenameVariants);
assert.equal(explicitFilenameResult.groups.length, 1);
assert.deepEqual(explicitFilenameResult.groups[0].indexes, [0, 1, 2, 3]);

for (const records of [
  [
    { url: "https://images.test/set/annual-report-2023.jpg", width: 1200, height: 800 },
    { url: "https://images.test/set/annual-report-2024.jpg", width: 1200, height: 800 }
  ],
  [
    { url: "https://images.test/set/product-1042.jpg", width: 1200, height: 800 },
    { url: "https://images.test/set/product-1043.jpg", width: 600, height: 400 }
  ]
]) {
  assert.equal(
    Duplicates.analyzeDuplicates(records).groups.length,
    0,
    "plain numeric filename suffixes must remain identity-bearing years or IDs"
  );
}

const poorAspectMatch = Duplicates.analyzeDuplicates([
  { url: "https://images.test/set/mountain-view-320x180.jpg", width: 320, height: 180 },
  { url: "https://images.test/set/mountain-view-800x800.jpg", width: 800, height: 800 }
]);
assert.equal(poorAspectMatch.groups.length, 0, "similar filenames with incompatible ratios stay distinct");

const qualityRecords = [
  { url: "https://cdn.test/photos/portrait-12.jpg?w=1200&q=70", width: 1200, height: 800 },
  { url: "https://cdn.test/photos/portrait-12.jpg?w=1200&q=95", width: 1200, height: 800 }
];
assert.equal(Duplicates.chooseBestRecord(qualityRecords), qualityRecords[1]);
assert.equal(Duplicates.chooseBestRecord([]), null);
assert.equal(Duplicates.chooseBestRecord(null), null);

const orderedRecords = [
  { url: "https://ordered.test/first/story-one.jpg?w=200", width: 200, height: 100 },
  { url: "https://ordered.test/single.jpg", width: 500, height: 500 },
  { url: "https://ordered.test/second/story-two.jpg?w=300", width: 300, height: 200 },
  { url: "https://ordered.test/first/story-one.jpg?w=800", width: 800, height: 400 },
  { url: "https://ordered.test/second/story-two.jpg?w=1200", width: 1200, height: 800 }
];
const snapshot = JSON.stringify(orderedRecords);
const orderedResult = Duplicates.analyzeDuplicates(orderedRecords);
assert.equal(JSON.stringify(orderedRecords), snapshot, "analysis must not mutate image records");
assert.deepEqual(orderedResult.groups.map((group) => group.indexes), [[0, 3], [2, 4]]);
assert.deepEqual(orderedResult.groups.map((group) => group.bestIndex), [3, 4]);
assert.deepEqual(orderedResult.recommendedIndexesToDeselect, [0, 2]);
assert.deepEqual(Duplicates.recommendedUrlsToDeselect(orderedRecords), [
  orderedRecords[0].url,
  orderedRecords[2].url
]);
assert.deepEqual(
  Duplicates.findDuplicateGroups(orderedRecords).map((group) => group.id),
  ["duplicate-1", "duplicate-2"]
);

const exactSameUrl = { url: "https://same.test/photo.jpg", width: 900, height: 600 };
const exactResult = Duplicates.analyzeDuplicates([
  exactSameUrl,
  { url: exactSameUrl.url, width: 1800, height: 1200 }
]);
assert.equal(exactResult.groups[0].kind, "exact");
assert.equal(exactResult.groups[0].bestIndex, 1);
assert.deepEqual(
  exactResult.groups[0].recommendedUrlsToDeselect,
  [],
  "identical URL records are addressable by index, not by a URL that would also match the keeper"
);
assert.deepEqual(exactResult.groups[0].recommendedIndexesToDeselect, [0]);

console.log("All local duplicate-detection checks passed.");
