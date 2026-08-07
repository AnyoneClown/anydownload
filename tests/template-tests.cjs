"use strict";

const assert = require("assert").strict;
const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const Core = require("../extension/shared/core.js");
const Templates = require("../extension/shared/templates.js");

const browserContext = {};
vm.createContext(browserContext);
vm.runInContext(
  fs.readFileSync(path.resolve(__dirname, "../extension/shared/core.js"), "utf8"),
  browserContext
);
vm.runInContext(
  fs.readFileSync(path.resolve(__dirname, "../extension/shared/templates.js"), "utf8"),
  browserContext
);
assert.equal(
  typeof browserContext.ImageDownloaderTemplates.render,
  "function",
  "The browser build must expose ImageDownloaderTemplates after ImageDownloaderCore"
);

assert.deepEqual(Object.keys(Templates).sort(), [
  "DEFAULT_TEMPLATE",
  "MAX_FILENAME_LENGTH",
  "MAX_TEMPLATE_LENGTH",
  "TOKENS",
  "normalize",
  "preview",
  "render",
  "validate"
].sort());
assert.equal(Templates.DEFAULT_TEMPLATE, "{filename}");
assert.equal(Templates.MAX_FILENAME_LENGTH, 100);
assert.ok(Object.isFrozen(Templates));
assert.ok(Object.isFrozen(Templates.TOKENS));
assert.deepEqual(Templates.TOKENS, [
  "filename",
  "name",
  "ext",
  "index",
  "hostname",
  "page-title",
  "width",
  "height",
  "date"
]);

assert.equal(Templates.normalize("  ｛filename｝  "), "{filename}");
assert.equal(Templates.normalize(null), "");
assert.equal(Templates.normalize(Symbol("filename")), "");

const allTokens = "{filename}_{name}_{ext}_{index}_{hostname}_{page-title}_{width}_{height}_{date}";
const valid = Templates.validate(allTokens);
assert.equal(valid.ok, true);
assert.equal(valid.value, allTokens);
assert.deepEqual(valid.tokens, Templates.TOKENS);
assert.ok(Object.isFrozen(valid));
assert.ok(Object.isFrozen(valid.tokens));
assert.equal(Templates.validate("  {name}  ").changed, true);
assert.deepEqual(Templates.validate("{name}-{name}").tokens, ["name"]);

for (const [template, message] of [
  ["", /Enter a filename template/],
  ["   ", /Enter a filename template/],
  [null, /must be text/],
  ["{unknown}", /Unknown filename token/],
  ["{__proto__}", /Unknown filename token/],
  ["{}", /Unknown filename token/],
  ["{filename", /unmatched \{/],
  ["filename}", /unmatched }/],
  ["{{filename}}", /unmatched \{/],
  ["../{filename}", /folder separators/],
  ["folder\\{filename}", /folder separators/],
  ["hello\u0000{name}", /control or bidirectional/],
  ["safe\u202e{name}", /control or bidirectional/],
  ["...", /visible name/],
  ["a".repeat(Templates.MAX_TEMPLATE_LENGTH + 1), /240 characters or fewer/]
]) {
  const result = Templates.validate(template);
  assert.equal(result.ok, false, `${JSON.stringify(template)} must be invalid`);
  assert.match(result.error, message);
  assert.throws(() => Templates.render(template, {}), message);
}

const metadata = {
  filename: "summer-photo.JPG",
  url: "https://images.example/gallery/summer-photo.JPG",
  pageUrl: "https://www.example.com/gallery/42",
  pageTitle: "Summer Gallery",
  width: 1920,
  height: 1080,
  index: 7,
  date: "2026-08-07"
};
assert.equal(
  Templates.render("{page-title}_{index}_{width}x{height}_{name}.{ext}", metadata),
  "Summer Gallery_0007_1920x1080_summer-photo.jpg"
);
assert.equal(Templates.render("{filename}", metadata), "summer-photo.JPG");
assert.equal(Templates.render("{name}", metadata), "summer-photo.jpg");
assert.equal(Templates.render("{hostname}-{name}", metadata), "www.example.com-summer-photo.jpg");
assert.equal(
  Templates.render("{date}-{name}", { ...metadata, date: Date.UTC(2024, 1, 29) }),
  "2024-02-29-summer-photo.jpg"
);
assert.equal(
  Templates.render("{date}", { filename: "photo.jpg", date: 8.64e15 + 1 }),
  "unknown-date.jpg",
  "Out-of-range timestamps must never produce NaN filename fragments"
);
const timezoneProbe = childProcess.spawnSync(
  process.execPath,
  [
    "-e",
    `const T=require(${JSON.stringify(path.resolve(__dirname, "../extension/shared/templates.js"))});` +
      `process.stdout.write(T.render("{date}",{filename:"photo.jpg",date:Date.parse("2026-08-07T21:30:00Z")}));`
  ],
  {
    encoding: "utf8",
    env: { ...process.env, TZ: "Europe/Kiev" }
  }
);
assert.equal(timezoneProbe.status, 0, timezoneProbe.stderr);
assert.equal(
  timezoneProbe.stdout,
  "2026-08-08.jpg",
  "The batch-date token must use the user's local calendar date"
);
assert.equal(
  Templates.render("{name}.png", metadata),
  "summer-photo.jpg",
  "A filename template must not mislabel JPEG bytes as PNG"
);
assert.equal(
  Templates.render("{name}-copy", metadata),
  "summer-photo-copy.jpg",
  "The source extension must be preserved when the template omits it"
);

assert.equal(
  Templates.render("{page-title}-{name}", {
    filename: "Cafe\u0301.png",
    pageTitle: "Київ 🐈"
  }),
  "Київ 🐈-Café.png",
  "Unicode should be preserved and normalized safely"
);
assert.equal(
  Templates.render("{page-title}", {
    filename: "photo.jpg",
    pageTitle: "../../CON:<script>|?*"
  }),
  "_.._CON__script____.jpg"
);
assert.equal(Templates.render("CON", { filename: "photo.jpg" }), "_CON.jpg");
assert.equal(
  Templates.render("{page-title}", { filename: "photo.jpg", pageTitle: "...." }),
  "image-0001.jpg",
  "Metadata that sanitizes to an empty filename must use a safe fallback"
);

const missingMetadata = Templates.render(
  "{name}-{hostname}-{width}-{height}-{date}-{index}",
  {}
);
assert.equal(
  missingMetadata,
  "image-0001-unknown-host-unknown-unknown-unknown-date-0001"
);
assert.equal(Templates.render("{date}", { date: null }), "unknown-date");
assert.equal(
  Templates.render("{filename}", { url: "https://cdn.example/render?id=8&format=webp", index: 2 }),
  "render.webp"
);
assert.equal(
  Templates.render("{filename}", { filename: "download", mimeType: "image/png" }),
  "download.png"
);
assert.equal(
  Templates.render("{name}-{width}x{height}", { filename: "photo.avif", width: -1, height: NaN }),
  "photo-unknownxunknown.avif"
);

const usedNames = new Set();
assert.equal(Templates.render("{name}", { filename: "Photo.jpg" }, { usedNames }), "Photo.jpg");
assert.equal(Templates.render("{name}", { filename: "photo.jpg" }, { usedNames }), "photo-2.jpg");
assert.equal(Templates.render("{name}", { filename: "PHOTO.JPG" }, { usedNames }), "PHOTO-3.jpg");
assert.equal(usedNames.size, 3);

const prepopulatedNames = new Set(["holiday.png"]);
assert.equal(
  Templates.render("holiday", { filename: "source.png" }, { usedNames: prepopulatedNames }),
  "holiday-2.png",
  "Pre-populated sets may contain either output names or normalized keys"
);
assert.throws(
  () => Templates.render("{filename}", { filename: "photo.jpg" }, { usedNames: {} }),
  /usedNames must be a Set/
);

const veryLongName = Templates.render("{page-title}", {
  filename: "photo.webp",
  pageTitle: "猫".repeat(300)
});
assert.ok(veryLongName.length <= Templates.MAX_FILENAME_LENGTH);
assert.match(veryLongName, /\.webp$/);
const longUsed = new Set();
const firstLong = Templates.render("{page-title}", {
  filename: "photo.webp",
  pageTitle: "a".repeat(500)
}, { usedNames: longUsed });
const secondLong = Templates.render("{page-title}", {
  filename: "photo.webp",
  pageTitle: "a".repeat(500)
}, { usedNames: longUsed });
assert.ok(firstLong.length <= Templates.MAX_FILENAME_LENGTH);
assert.ok(secondLong.length <= Templates.MAX_FILENAME_LENGTH);
assert.notEqual(firstLong, secondLong);
assert.match(secondLong, /-2\.webp$/);
const emojiBoundary = Templates.render("{page-title}", {
  filename: "photo.jpg",
  pageTitle: `${"a".repeat(95)}😀${"b".repeat(20)}`
});
assert.doesNotMatch(
  emojiBoundary,
  /[\ud800-\udfff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/,
  "Template truncation must not split an emoji surrogate pair"
);
assert.match(emojiBoundary, /\.jpg$/);

const unsafeOutput = Templates.render("{page-title}_{filename}", {
  filename: "..\\..\\payload.exe",
  ext: "jpg",
  pageTitle: "/tmp/../\u202eimage"
});
assert.doesNotMatch(unsafeOutput, /[\\/\u202e]/);
assert.match(unsafeOutput, /\.jpg$/);
assert.ok(Core.buildDownloadPath("AnyDownload", unsafeOutput).startsWith("AnyDownload/"));

const hostileMetadata = {};
Object.defineProperty(hostileMetadata, "filename", {
  get() {
    throw new Error("hostile getter");
  }
});
assert.doesNotThrow(() => Templates.render("{filename}", hostileMetadata));
assert.equal(Templates.render("{filename}", hostileMetadata), "image-0001");

const previewNames = new Set(["photo.jpg"]);
const preview = Templates.preview("  {filename}  ", { filename: "photo.jpg" }, { usedNames: previewNames });
assert.deepEqual(preview, {
  ok: true,
  value: "photo-2.jpg",
  template: "{filename}",
  error: ""
});
assert.deepEqual(Array.from(previewNames), ["photo.jpg"], "Preview must not mutate the caller's usedNames set");
assert.deepEqual(Templates.preview("{wat}", {}), {
  ok: false,
  value: "",
  template: "{wat}",
  error: "Unknown filename token: {wat}."
});

console.log("All filename-template checks passed.");
