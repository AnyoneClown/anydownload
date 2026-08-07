"use strict";

const assert = require("assert").strict;
const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const Archive = require("../extension/shared/archive.js");

const archiveSource = fs.readFileSync(
  path.resolve(__dirname, "../extension/shared/archive.js"),
  "utf8"
);
const browserContext = {};
vm.createContext(browserContext);
vm.runInContext(archiveSource, browserContext);
assert.equal(
  typeof browserContext.ImageDownloaderArchive.createStoredZip,
  "function",
  "The browser build must expose ImageDownloaderArchive"
);
assert.deepEqual(Object.keys(Archive).sort(), ["crc32", "createStoredZip"]);

function concatenate(parts) {
  const size = parts.reduce((total, part) => total + part.byteLength, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function uint16(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function uint32(bytes, offset) {
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)
  ) >>> 0;
}

function bytesEqual(actual, expected, message) {
  assert.deepEqual(Array.from(actual), Array.from(expected), message);
}

const ascii = new TextEncoder().encode("123456789");
assert.equal(Archive.crc32(new Uint8Array()), 0);
assert.equal(Archive.crc32(ascii), 0xcbf43926);
assert.equal(Archive.crc32(ascii.buffer), 0xcbf43926);
assert.throws(() => Archive.crc32([1, 2, 3]), /Uint8Array or ArrayBuffer/);

const fixedDate = new Date(2024, 0, 2, 3, 4, 6);
const sourceEntries = [
  { name: "photo.jpg", data: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) },
  { name: "gallery/Київ 🐈.webp", data: new Uint8Array([1, 2, 3, 4, 5]).buffer },
  { name: "empty.png", data: new Uint8Array() }
];
const zip = Archive.createStoredZip(sourceEntries, { date: fixedDate });
assert.equal(zip.entryCount, sourceEntries.length);
assert.equal(zip.size, zip.parts.reduce((total, part) => total + part.byteLength, 0));
assert.ok(zip.parts.every((part) => part instanceof Uint8Array));

const bytes = concatenate(zip.parts);
assert.equal(bytes.byteLength, zip.size);
const endOffset = bytes.length - 22;
assert.equal(uint32(bytes, endOffset), 0x06054b50, "EOCD signature");
assert.equal(uint16(bytes, endOffset + 4), 0, "EOCD disk number");
assert.equal(uint16(bytes, endOffset + 6), 0, "EOCD central-directory disk");
assert.equal(uint16(bytes, endOffset + 8), sourceEntries.length);
assert.equal(uint16(bytes, endOffset + 10), sourceEntries.length);
assert.equal(uint16(bytes, endOffset + 20), 0, "EOCD comment length");

const centralSize = uint32(bytes, endOffset + 12);
const centralOffset = uint32(bytes, endOffset + 16);
assert.equal(centralOffset + centralSize, endOffset);

const expectedDosTime = (3 << 11) | (4 << 5) | 3;
const expectedDosDate = ((2024 - 1980) << 9) | (1 << 5) | 2;
const decoder = new TextDecoder();
const localRecords = [];
let cursor = 0;
for (let index = 0; index < sourceEntries.length; index += 1) {
  assert.equal(uint32(bytes, cursor), 0x04034b50, `local signature ${index + 1}`);
  assert.equal(uint16(bytes, cursor + 4), 20, "version needed");
  assert.equal(uint16(bytes, cursor + 6), 0x0800, "UTF-8 filename flag");
  assert.equal(uint16(bytes, cursor + 8), 0, "stored compression method");
  assert.equal(uint16(bytes, cursor + 10), expectedDosTime);
  assert.equal(uint16(bytes, cursor + 12), expectedDosDate);

  const checksum = uint32(bytes, cursor + 14);
  const compressedSize = uint32(bytes, cursor + 18);
  const uncompressedSize = uint32(bytes, cursor + 22);
  const nameLength = uint16(bytes, cursor + 26);
  const extraLength = uint16(bytes, cursor + 28);
  const nameStart = cursor + 30;
  const dataStart = nameStart + nameLength + extraLength;
  const entryData = bytes.subarray(dataStart, dataStart + compressedSize);
  const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength));

  assert.equal(name, sourceEntries[index].name);
  assert.equal(compressedSize, sourceEntries[index].data.byteLength);
  assert.equal(uncompressedSize, compressedSize);
  assert.equal(checksum, Archive.crc32(entryData));
  bytesEqual(entryData, new Uint8Array(sourceEntries[index].data), `entry data ${index + 1}`);
  localRecords.push({ name, offset: cursor, checksum, size: compressedSize });
  cursor = dataStart + compressedSize;
}
assert.equal(cursor, centralOffset, "local records must end at the central directory");

cursor = centralOffset;
for (let index = 0; index < sourceEntries.length; index += 1) {
  const local = localRecords[index];
  assert.equal(uint32(bytes, cursor), 0x02014b50, `central signature ${index + 1}`);
  assert.equal(uint16(bytes, cursor + 6), 20, "central version needed");
  assert.equal(uint16(bytes, cursor + 8), 0x0800, "central UTF-8 filename flag");
  assert.equal(uint16(bytes, cursor + 10), 0, "central stored method");
  assert.equal(uint32(bytes, cursor + 16), local.checksum);
  assert.equal(uint32(bytes, cursor + 20), local.size);
  assert.equal(uint32(bytes, cursor + 24), local.size);

  const nameLength = uint16(bytes, cursor + 28);
  const extraLength = uint16(bytes, cursor + 30);
  const commentLength = uint16(bytes, cursor + 32);
  const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
  assert.equal(name, local.name);
  assert.equal(uint32(bytes, cursor + 42), local.offset);
  cursor += 46 + nameLength + extraLength + commentLength;
}
assert.equal(cursor, endOffset, "central records must end at EOCD");

const emptyZip = Archive.createStoredZip([]);
assert.equal(emptyZip.entryCount, 0);
assert.equal(emptyZip.size, 22);
assert.equal(uint32(emptyZip.parts[0], 0), 0x06054b50);

for (const unsafeName of [
  "",
  "/absolute.jpg",
  "C:/absolute.jpg",
  "../escape.jpg",
  "folder/../escape.jpg",
  "folder/./photo.jpg",
  "folder//photo.jpg",
  "folder\\photo.jpg",
  "folder/",
  "control\u0000.jpg"
]) {
  assert.throws(
    () => Archive.createStoredZip([{ name: unsafeName, data: new Uint8Array() }]),
    /entry name|Unsafe/i,
    `${JSON.stringify(unsafeName)} must be rejected`
  );
}
assert.throws(
  () => Archive.createStoredZip([
    { name: "same.jpg", data: new Uint8Array() },
    { name: "same.jpg", data: new Uint8Array() }
  ]),
  /Duplicate ZIP entry name/
);
assert.throws(
  () => Archive.createStoredZip([
    { name: "é.jpg", data: new Uint8Array() },
    { name: "e\u0301.jpg", data: new Uint8Array() }
  ]),
  /Duplicate ZIP entry name/,
  "canonically equivalent names must not create ambiguous extracted files"
);
assert.throws(() => Archive.createStoredZip(null), /entries must be an array/i);
assert.throws(() => Archive.createStoredZip(new Array(65536)), /65535 entries/);
assert.throws(() => Archive.createStoredZip([null]), /must be an object/);
assert.throws(
  () => Archive.createStoredZip([{ name: "photo.jpg", data: [1, 2, 3] }]),
  /Uint8Array or ArrayBuffer/
);
assert.throws(() => Archive.createStoredZip([], null), /options must be an object/i);
assert.throws(() => Archive.createStoredZip([], { date: "2024-01-02" }), /valid Date/);
assert.throws(() => Archive.createStoredZip([], { date: new Date(NaN) }), /valid Date/);
assert.throws(
  () => Archive.createStoredZip([{ name: "a".repeat(65536), data: new Uint8Array() }]),
  /name is too long/
);
assert.throws(
  () => Archive.createStoredZip([{ name: "🐈".repeat(20000), data: new Uint8Array() }]),
  /UTF-8 ZIP entry name is too long/
);

const unzipProbe = childProcess.spawnSync("unzip", ["-v"], { encoding: "utf8" });
if (!unzipProbe.error) {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "anydownload-zip-test-"));
  const temporaryArchive = path.join(temporaryDirectory, "images.zip");
  try {
    fs.writeFileSync(temporaryArchive, bytes);
    const result = childProcess.spawnSync("unzip", ["-t", temporaryArchive], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

console.log("All stored-ZIP archive checks passed.");
