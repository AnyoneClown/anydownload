"use strict";

const assert = require("assert").strict;
const fs = require("fs");
const path = require("path");
const Core = require("../extension/shared/core.js");

const root = path.resolve(__dirname, "../extension");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const popupRelativePath = manifest.action && manifest.action.default_popup;
assert.equal(typeof popupRelativePath, "string", "manifest.action.default_popup must be set");
const popupPath = path.resolve(root, popupRelativePath);
assert.ok(
  popupPath.startsWith(`${root}${path.sep}`) && fs.existsSync(popupPath),
  `Manifest popup is missing: ${popupRelativePath}`
);
const popupCss = fs.readFileSync(path.join(root, "popup/popup.css"), "utf8");
const popupHtml = fs.readFileSync(popupPath, "utf8");
const popupJs = fs.readFileSync(path.join(root, "popup/popup.js"), "utf8");
const backgroundJs = fs.readFileSync(path.join(root, "background.js"), "utf8");
const previewHtml = fs.readFileSync(path.join(root, "preview/preview.html"), "utf8");
const previewJs = fs.readFileSync(path.join(root, "preview/preview.js"), "utf8");

assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.version, "1.3.0");
assert.equal(Core.MAX_BATCH_TOTAL_URL_LENGTH, 2000000);
assert.deepEqual(manifest.permissions.sort(), ["activeTab", "downloads", "menus", "scripting", "storage"]);
assert.deepEqual(manifest.background.scripts, ["shared/core.js", "shared/collector.js", "background.js"]);
assert.deepEqual(
  manifest.browser_specific_settings.gecko.data_collection_permissions.required,
  ["none"]
);
assert.equal(manifest.browser_specific_settings.gecko_android.strict_min_version, "142.0");
assert.match(popupHtml, /^<!doctype html>/i, "Popup must use standards mode for reliable Firefox sizing");
const popupScriptSources = Array.from(
  popupHtml.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*><\/script>/gi),
  (match) => match[1]
);
assert.deepEqual(
  popupScriptSources,
  ["../shared/core.js", "../shared/collector.js", "popup.js"],
  "Popup scripts must load in dependency order"
);
const popupResourcePaths = [
  ...popupScriptSources,
  ...Array.from(
    popupHtml.matchAll(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi),
    (match) => match[1]
  )
];
for (const resourcePath of popupResourcePaths) {
  assert.ok(!/^(?:[a-z]+:|\/\/|#)/i.test(resourcePath), `Popup resource must be local: ${resourcePath}`);
  const absoluteResourcePath = path.resolve(path.dirname(popupPath), resourcePath);
  assert.ok(
    absoluteResourcePath.startsWith(`${root}${path.sep}`) && fs.existsSync(absoluteResourcePath),
    `Popup resource is missing: ${resourcePath}`
  );
}
assert.match(popupCss, /body\s*\{[^}]*width:\s*470px;[^}]*min-width:\s*470px;/s);
assert.doesNotMatch(popupCss, /body\s*\{[^}]*width:\s*100vw;/s);
assert.match(popupHtml, /id="ignored-button"[^>]*aria-pressed="false"/);
assert.match(popupHtml, /id="clear-ignored-button"/);
assert.match(popupHtml, /src="\.\.\/shared\/collector\.js"/);
assert.match(popupJs, /browser\.tabs\.create\(createProperties\)/);
assert.match(popupJs, /browser\.storage\.session\.set\(\{ \[key\]: payload \}\)/);
assert.doesNotMatch(popupJs, /areaName\s*=\s*"local"/);
assert.match(popupJs, /ignoredImage:/);
assert.match(popupJs, /browser\.storage\.onChanged\.addListener\(handleIgnoredStorageChanges\)/);
assert.match(popupJs, /MAX_IGNORED_RULES\s*=\s*5000/);
assert.match(popupJs, /image\.previewUrl \|\| image\.url/);
assert.match(popupJs, /MAX_DIMENSION_PROBE_CONCURRENCY\s*=\s*3/);
assert.match(popupJs, /probeFullImageDimensions/);
assert.match(popupJs, /probe\.naturalWidth/);
assert.match(popupJs, /checking full size/);
assert.match(popupJs, /full size unavailable/);
assert.match(popupJs, /renderedMetaNodes/);
assert.match(popupJs, /dimensionProbeScheduler\.cancelQueued/);
assert.match(popupJs, /isPaused:\s*\(\)\s*=>\s*state\.busy/);
assert.match(popupJs, /rootMargin:\s*"0px"/);
assert.match(backgroundJs, /contexts:\s*\["image"\]/);
assert.match(backgroundJs, /browser\.menus\.onClicked\.addListener/);
assert.match(backgroundJs, /targetElementId/);
assert.match(backgroundJs, /browser\.action\.openPopup/);
assert.match(previewHtml, /id="image-button"[^>]*aria-pressed="false"/);
assert.match(previewJs, /browser\.storage\.session/);

for (const relativePath of [
  "background.js",
  "icons/image-downloader.svg",
  "popup/popup.css",
  "popup/popup.html",
  "popup/popup.js",
  "preview/preview.css",
  "preview/preview.html",
  "preview/preview.js",
  "shared/collector.js",
  "shared/core.js"
]) {
  assert.ok(fs.existsSync(path.join(root, relativePath)), `Missing ${relativePath}`);
}

assert.deepEqual(Core.validateFolderPath("Website images/example.com"), {
  ok: true,
  value: "Website images/example.com",
  changed: false
});
assert.equal(Core.validateFolderPath("../escape").ok, false);
assert.equal(Core.validateFolderPath("/Users/test/Pictures").ok, false);
assert.equal(Core.validateFolderPath("C:\\Pictures").ok, false);
assert.equal(Core.validateFolderPath("Pictures/CON").value, "Pictures/_CON");
assert.equal(Core.validateFolderPath("Pictures\\Summer").value, "Pictures/Summer");

assert.equal(
  Core.filenameForImage("https://example.com/assets/my%20photo.webp?width=900", 0),
  "my photo.webp"
);
assert.equal(
  Core.filenameForImage("https://example.com/render?id=42&format=avif", 1),
  "render.avif"
);
assert.equal(Core.filenameForImage("data:image/png;base64,AA==", 2), "image-0003.png");
assert.equal(Core.filenameForImage("https://example.com/payload.exe", 3), "payload_exe");
assert.equal(Core.sanitizeFilename("../CON?.jpg", "image"), "_CON_.jpg");

const used = new Set();
assert.equal(Core.uniquifyFilename("photo.jpg", used), "photo.jpg");
assert.equal(Core.uniquifyFilename("photo.jpg", used), "photo-2.jpg");
assert.equal(Core.uniquifyFilename("PHOTO.JPG", used), "PHOTO-3.JPG");

assert.equal(Core.validateDownloadUrl("javascript:alert(1)").ok, false);
assert.equal(Core.validateDownloadUrl("data:text/html,hello").ok, false);
assert.equal(Core.validateDownloadUrl("data:image/png;base64,AA==").ok, true);
assert.equal(Core.validateDownloadUrl("blob:https://example.com/id").ok, false);
assert.equal(Core.buildDownloadPath("Site/image", "photo.jpg"), "Site/image/photo.jpg");

assert.equal(Core.siteKeyForUrl("https://example.com/gallery?page=2"), "https://example.com");
assert.equal(Core.siteKeyForUrl("http://example.com:8080/path"), "http://example.com:8080");
assert.equal(Core.siteKeyForUrl("file:///tmp/image.html"), "");
assert.equal(Core.ignoreKeyForUrl("not a URL"), "");
assert.notEqual(
  Core.ignoreKeyForUrl("https://cdn.example/logo.png?v=1#top"),
  Core.ignoreKeyForUrl("https://cdn.example/logo.png?v=2")
);
assert.equal(
  Core.ignoreKeyForUrl("https://cdn.example/logo.png?v=1#top"),
  Core.ignoreKeyForUrl("https://cdn.example/logo.png?v=1#other")
);
assert.notEqual(
  Core.ignoreKeyForUrl("https://cdn.example/logo.png?v=1"),
  Core.ignoreKeyForUrl("https://cdn.example/header.png?v=1")
);
const dataIgnoreKey = Core.ignoreKeyForUrl("data:image/png;base64,AA==");
assert.match(Core.ignoreKeyForUrl("https://cdn.example/logo.png?v=1"), /^url:\d+:[a-f0-9]{16}$/);
assert.match(dataIgnoreKey, /^data:\d+:[a-f0-9]{16}$/);
assert.equal(dataIgnoreKey, Core.ignoreKeyForUrl("data:image/png;base64,AA=="));
assert.match(Core.ignoreKeyForUrl("data:IMAGE/PNG;base64,AA=="), /^data:\d+:[a-f0-9]{16}$/);

for (const relativePath of ["background.js", "popup/popup.js", "preview/preview.js", "shared/collector.js", "shared/core.js"]) {
  const source = fs.readFileSync(path.join(root, relativePath), "utf8");
  assert.doesNotThrow(() => new Function(source), `${relativePath} has a syntax error`);
}

console.log("All extension checks passed.");
