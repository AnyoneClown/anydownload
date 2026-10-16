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
  "createUsedNames",
  "normalize",
  "preview",
  "render",
  "validate"
].sort());
assert.equal(Templates.DEFAULT_TEMPLATE, "{index}-{filename}");
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
  Templates.render(Templates.DEFAULT_TEMPLATE, metadata),
  "0007-summer-photo.JPG",
  "The default template must prefix the source filename with its padded batch position"
);
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
  Templates.render("{filename}", {
    url: "https://media.example/watch?id=1",
    mimeType: "video/webm",
    mediaType: "video",
    index: 3
  }),
  "watch.webm",
  "A direct video MIME type must supply a safe extension for an extensionless URL"
);
assert.equal(
  Templates.render("{filename}", {
    url: "data:video/mp4;base64,AA==",
    mediaType: "video",
    index: 2
  }),
  "video-0002.mp4"
);
assert.equal(
  Templates.render("{name}.png", { filename: "Trailer.MP4", mediaType: "video" }),
  "Trailer.mp4",
  "A template must not relabel MP4 bytes with an image extension"
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
const mutatedNames = new Set(["ＨＯＬＩＤＡＹ.png"]);
assert.equal(Templates.render("holiday", { filename: "source.png" }, { usedNames: mutatedNames }), "holiday-2.png");
mutatedNames.delete("ＨＯＬＩＤＡＹ.png");
assert.equal(Templates.render("holiday", { filename: "source.png" }, { usedNames: mutatedNames }), "holiday.png",
  "Caller-owned sets must reflect removed names between renders");
mutatedNames.add("HOLIDAY-3.PNG");
assert.equal(Templates.render("holiday", { filename: "source.png" }, { usedNames: mutatedNames }), "holiday-4.png",
  "Caller-owned sets must reflect mixed-case names added between renders");

const managedNames = Templates.createUsedNames(["ＨＯＬＩＤＡＹ.png"]);
assert.equal(Templates.render("holiday", { filename: "source.png" }, { usedNames: managedNames }), "holiday-2.png");
assert.equal(managedNames.add("HOLIDAY-3.PNG"), managedNames);
assert.equal(Templates.render("holiday", { filename: "source.png" }, { usedNames: managedNames }), "holiday-4.png");
assert.ok(managedNames.has("Ｈｏｌｉｄａｙ-３.png"));
assert.ok(managedNames.delete("HOLIDAY.PNG"));
assert.equal(Templates.render("holiday", { filename: "source.png" }, { usedNames: managedNames }), "holiday.png");
assert.equal(managedNames.size, 4);
managedNames.clear();
assert.equal(managedNames.size, 0);
assert.equal(Templates.render("holiday", { filename: "source.png" }, { usedNames: managedNames }), "holiday.png");

const sharedAliasNames = Templates.createUsedNames(["PHOTO.JPG", "photo.jpg"]);
assert.ok(sharedAliasNames.delete("PHOTO.JPG"));
assert.equal(Templates.render("{filename}", { filename: "photo.jpg" }, { usedNames: sharedAliasNames }), "photo-2.jpg",
  "Removing one spelling must retain folded aliases contributed by another stored name");
assert.ok(sharedAliasNames.delete("photo.jpg"));
assert.equal(Templates.render("{filename}", { filename: "photo.jpg" }, { usedNames: sharedAliasNames }), "photo.jpg");

const renderNameSequence = (filenames, names) => filenames.map(filename =>
  Templates.render("{filename}", { filename }, { usedNames: names }));
for (const [filenames, expected] of [
  [["J\u030c.jpg", "J\u030c.jpg"], ["J\u030c.jpg", "J\u030c-2.jpg"]],
  [["J\u030c.jpg", "ǰ.jpg"], ["J\u030c.jpg", "ǰ-2.jpg"]],
  [["ǰ.jpg", "J\u030c.jpg"], ["ǰ.jpg", "J\u030c.jpg"]],
  [["Ｊ\u030c.jpg", "J\u030c.jpg"], ["J\u030c.jpg", "J\u030c-2.jpg"]]
]) {
  assert.deepEqual(renderNameSequence(filenames, Templates.createUsedNames()), expected,
    "Managed collisions must preserve order-dependent legacy Unicode folding");
  assert.deepEqual(renderNameSequence(filenames, new Set()), expected);
}
assert.deepEqual(renderNameSequence(["ǰ.jpg"], Templates.createUsedNames(["J\u030c.jpg"])), ["ǰ.jpg"],
  "Pre-populated values must be indexed exactly as caller-owned Set entries");

// Compare the managed index with the compatibility Set path across deterministic
// Unicode inputs, existing entries, direct mutations, and collision suffixes.
const unicodeNames = [
  "J\u030c.jpg", "ǰ.jpg", "j\u030c.jpg", "Ｊ\u030c.jpg", "Photo.jpg", "Ｐｈｏｔｏ.jpg",
  "PHOTO.JPG", "ß.jpg", "ẞ.jpg", "İ.jpg", "i\u0307.jpg", "Σ.jpg", "ς.jpg", "σ.jpg",
  "K.jpg", "K.jpg", "𝐉\u030c.jpg", "ﬃ.jpg", "FFI.jpg", "ǰ-2.jpg", "J\u030c-2.jpg",
  "H\u0331.jpg", "ẖ.jpg", "T\u0308.jpg", "ẗ.jpg", "T\u0344.jpg", "ẗ\u0301.jpg",
  "W\u030a.jpg", "ẘ.jpg", "Y\u030a.jpg", "ẙ.jpg"
];
let randomState = 0x51f15e;
const randomIndex = length => {
  randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
  return randomState % length;
};
for (let batch = 0; batch < 200; batch += 1) {
  const seeds = Array.from({ length: randomIndex(5) }, () => unicodeNames[randomIndex(unicodeNames.length)]);
  const referenceNames = new Set(seeds);
  const indexedNames = Templates.createUsedNames(seeds);
  for (let step = 0; step < 35; step += 1) {
    const filename = unicodeNames[randomIndex(unicodeNames.length)];
    if (step % 11 === 0) {
      referenceNames.add(filename);
      indexedNames.add(filename);
    } else if (step % 13 === 0 && referenceNames.size) {
      const stored = Array.from(referenceNames)[randomIndex(referenceNames.size)];
      assert.equal(indexedNames.delete(stored), referenceNames.delete(stored));
    } else {
      assert.equal(
        Templates.render("{filename}", { filename }, { usedNames: indexedNames }),
        Templates.render("{filename}", { filename }, { usedNames: referenceNames }),
        `Unicode collision output must match the legacy Set in batch ${batch}, step ${step}`
      );
    }
    assert.deepEqual(Array.from(indexedNames), Array.from(referenceNames),
      "The managed registry must retain the exact stored values and insertion order");
  }
}

const setLikeValues = new Set(["PHOTO.JPG"]);
const setLikeNames = {
  has: value => setLikeValues.has(value),
  add: value => setLikeValues.add(value),
  [Symbol.iterator]: () => setLikeValues[Symbol.iterator]()
};
assert.equal(Templates.render("{filename}", { filename: "photo.jpg" }, { usedNames: setLikeNames }), "photo-2.jpg",
  "Existing iterable set-like collision registries remain supported");

const largeBatchNames = Templates.createUsedNames();
const originalCaseFold = String.prototype.toLocaleLowerCase;
let caseFolds = 0;
try {
  String.prototype.toLocaleLowerCase = function countedCaseFold(...args) {
    caseFolds += 1;
    return originalCaseFold.apply(this, args);
  };
  for (let index = 1; index <= 5000; index += 1) {
    assert.equal(Templates.render(Templates.DEFAULT_TEMPLATE, {
      filename: "Photo.jpg", index
    }, { usedNames: largeBatchNames }), `${String(index).padStart(4, "0")}-Photo.jpg`);
  }
} finally {
  String.prototype.toLocaleLowerCase = originalCaseFold;
}
assert.equal(largeBatchNames.size, 5000);
assert.ok(caseFolds <= 5000 * 4,
  `A 5,000-name batch must use a bounded number of case folds per item, saw ${caseFolds}`);
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
