"use strict";

const assert = require("assert").strict;
const fs = require("fs");
const path = require("path");
const Core = require("../extension/shared/core.js");

const root = path.resolve(__dirname, "../extension");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const popupCss = fs.readFileSync(path.join(root, "popup/popup.css"), "utf8");

assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.version, "1.0.1");
assert.equal(Core.MAX_BATCH_TOTAL_URL_LENGTH, 2000000);
assert.deepEqual(manifest.permissions.sort(), ["activeTab", "downloads", "scripting", "storage"]);
assert.deepEqual(
  manifest.browser_specific_settings.gecko.data_collection_permissions.required,
  ["none"]
);
assert.equal(manifest.browser_specific_settings.gecko_android.strict_min_version, "142.0");
assert.match(popupCss, /body\s*\{[^}]*width:\s*470px;[^}]*min-width:\s*470px;/s);
assert.doesNotMatch(popupCss, /body\s*\{[^}]*width:\s*100vw;/s);

for (const relativePath of [
  "background.js",
  "icons/image-downloader.svg",
  "popup/popup.css",
  "popup/popup.html",
  "popup/popup.js",
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

for (const relativePath of ["background.js", "popup/popup.js", "shared/core.js"]) {
  const source = fs.readFileSync(path.join(root, relativePath), "utf8");
  assert.doesNotThrow(() => new Function(source), `${relativePath} has a syntax error`);
}

console.log("All extension checks passed.");
