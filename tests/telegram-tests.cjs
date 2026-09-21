"use strict";
const assert = require("node:assert/strict");
const vm = require("node:vm");
const Telegram = require("../extension/shared/telegram.js");
const Core = require("../extension/shared/core.js");
const Queue = require("../extension/shared/download-queue.js");
const Media = require("../extension/shared/image-fetch.js");
const PAGE = "https://web.telegram.org/k/#-123";
const URL_VALUE = "blob:https://web.telegram.org/01234567-abcd-1234-abcd-012345678901";
const STREAM = "https://web.telegram.org/k/stream/%7B%22id%22%3A1%7D";
const LEGACY_DOCUMENT = "https://web.telegram.org/k/document/" + encodeURIComponent(JSON.stringify({
  dcId: 2,
  location: { _: "inputDocumentFileLocation", id: "777", access_hash: "-987654321",
    file_reference: [5, 0, 17, 255] },
  size: 123456,
  mimeType: "application/octet-stream",
  fileName: "document"
}));
const CHUNK = 256 * 1024;

function reader(fetch, page = PAGE) {
  return vm.runInNewContext(`(${Telegram.readChunk.toString()})`, {
    location: { href: page }, fetch, AbortController, setTimeout, clearTimeout, btoa
  });
}
function fixture(bytes, override = {}) {
  return async (_url, options) => {
    const [, start, end] = /bytes=(\d+)-(\d+)/.exec(options.headers.Range).map(Number);
    const last = Math.min(end, bytes.length - 1);
    return new Response(bytes.slice(start, last + 1), {
      status: 206,
      headers: { "content-range": `bytes ${start}-${last}/${bytes.length}`, "content-type": "video/mp4", ...override }
    });
  };
}
function browser(read, privateTab = false) {
  const tab = { id: 4, url: PAGE, incognito: privateTab };
  return {
    tabs: { query: async () => [tab], get: async () => tab },
    scripting: { executeScript: async (options) => {
      assert.equal(options.world, "MAIN");
      assert.equal(options.target.tabId, 4);
      return [{ result: await read(...options.args) }];
    } }
  };
}
async function testOriginalMetadata() {
  const photo = { _: "photo", id: "555", sizes: [
    { _: "photoSize", type: "m", w: 320, h: 200, size: 12000 },
    { _: "photoSizeProgressive", type: "y", w: 2560, h: 1600, sizes: [20000, 300000] },
    { _: "photoStrippedSize", type: "i", bytes: [1, 2] }
  ] };
  const video = { _: "document", id: "777", dc_id: 2, access_hash: "-987654321",
    file_reference: [5, 0, 17, 255], size: 123456, mime_type: "video/mp4", attributes: [
    { _: "documentAttributeVideo", w: 1920, h: 1080, duration: 12 },
    { _: "documentAttributeFilename", file_name: "holiday.mp4" }
  ] };
  const messages = { 1: { media: { photo } }, 2: { media: { document: video } },
    3: { media: { document: { _: "document", id: "888", mime_type: "application/pdf", size: 500 } } } };
  const nodes = [1, 2, 3].map((mid) => ({
    getAttribute: () => String(mid),
    closest: () => ({ getAttribute: () => "-123" }),
    querySelector: () => ({ naturalWidth: 320, naturalHeight: 200 })
  }));
  const downloads = [];
  const context = { location: { href: PAGE }, URL, URLSearchParams, setTimeout, clearTimeout,
    document: { title: "Telegram", querySelectorAll: () => nodes,
      createElement: () => ({ getContext: () => ({ drawImage() {} }), toDataURL: () => "data:image/jpeg;base64,/9j/" }) },
    apiManagerProxy: { getMessageByPeer: (peer, mid) => { assert.equal(peer, -123); return messages[mid]; } },
    appDownloadManager: { downloadMediaURL: async (options) => { downloads.push(options); return URL_VALUE; } }
  };
  const scan = vm.runInNewContext(`(${Telegram.pageMedia.toString()})`, context);
  const result = await scan({ expectedPage: PAGE });
  assert.equal(result.images.length, 2, "Ignore non-media documents without requiring a video DOM element");
  assert.equal(downloads.length, 0, "Scanning must not fetch full originals");
  const original = result.images[0];
  assert.equal(original.width, 2560);
  assert.equal(original.height, 1600);
  assert(Telegram.isReference(original.url));
  assert(Telegram.isMediaUrl(original.url));
  assert.notEqual(original.url, original.previewUrl);
  const clip = result.images[1];
  assert.equal(clip.mediaType, "video");
  assert.equal(clip.filename, "holiday.mp4");
  assert.equal(clip.mimeType, "video/mp4");
  assert.equal(clip.width, 1920);
  assert.equal(clip.duration, 12);
  assert(clip.previewUrl.startsWith("data:image/"));
  await scan({ resolve: original.url, expectedPage: PAGE });
  assert.equal(downloads[0].thumb.type, "y", "Resolve largest progressive photo, not displayed m preview");
  const resolvedClip = await scan({ resolve: clip.url, expectedPage: PAGE });
  assert.equal(downloads.length, 1, "Document videos use Telegram's range stream instead of its broken blob downloader");
  assert(Telegram.isMediaUrl(resolvedClip.url));
  const streamOptions = JSON.parse(decodeURIComponent(new URL(resolvedClip.url).pathname.split("/stream/")[1]));
  assert.equal(streamOptions.location._, "inputDocumentFileLocation");
  assert.equal(streamOptions.location.id, "777");
  assert.equal(streamOptions.location.thumb_size, "", "Telegram requires the original-document thumb_size sentinel");
  assert.equal(streamOptions.mimeType, "video/mp4");
  assert.equal(streamOptions.size, 123456);
  await assert.rejects(scan({ resolve: clip.url.replace("id=777", "id=999"), expectedPage: PAGE }), /expired/);
  await assert.rejects(scan({ resolve: clip.url, expectedPage: PAGE + "other" }), /chat changed/);
  photo.sizes[1].sizes = [70000000];
  const oversized = await scan();
  assert.equal(oversized.images.length, 1, "Never silently substitute a small photo when the original exceeds the limit");
  const unavailable = vm.runInNewContext(`(${Telegram.pageMedia.toString()})`, { location: context.location, document: context.document });
  const failed = await unavailable();
  assert.equal(failed.images.length, 0);
  assert.match(failed.warnings[0], /thumbnails have not been substituted/);

  const api = browser(reader(fixture(Uint8Array.from([0xff, 0xd8, 0xff, 1]))));
  const read = api.scripting.executeScript;
  let resolutions = 0;
  api.scripting.executeScript = async (options) => {
    if (options.func === Telegram.pageMedia) {
      resolutions++;
      assert.equal(options.args[0].resolve, original.url);
      return [{ result: { url: URL_VALUE } }];
    }
    return read(options);
  };
  const blob = await Telegram.transfer(api, { url: original.url, source: PAGE, mediaType: "image" }, false, Media.mediaBlob);
  assert.equal(blob.type, "image/jpeg");
  assert.equal(resolutions, 1, "Resolve once before reading chunks");
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(Telegram.transfer(api, { url: original.url, source: PAGE }, false, Media.mediaBlob, cancelled.signal), /cancelled/);
}

async function main() {
  await testOriginalMetadata();
  for (const value of [URL_VALUE, STREAM, LEGACY_DOCUMENT]) assert(Telegram.isMediaUrl(value));
  for (const value of ["blob:https://evil.test/123", "blob:https://web.telegram.org.evil/123", "blob:null/123", "https://web.telegram.org/k/hls/file", "https://web.telegram.org/k/stream/a/b"]) {
    assert.equal(Telegram.isMediaUrl(value), false, value);
  }
  assert(Core.validateMediaUrl(URL_VALUE).ok);
  assert.equal(Core.validateMediaUrl("blob:https://other.test/id").ok, false);
  const queued = Queue.enqueueBatch(Queue.emptyState(), [{ url: URL_VALUE, filename: "photo.jpg" }], { source: PAGE });
  assert.equal(queued.state.jobs[0].tasks[0].url, URL_VALUE);
  const bytes = new Uint8Array(CHUNK + 73);
  bytes.set([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]);
  bytes[bytes.length - 1] = 42;
  const read = reader(fixture(bytes));
  const task = { url: STREAM, source: PAGE, mediaType: "video", filename: "test.mp4" };
  const output = await Telegram.transfer(browser(read), task, false, Media.mediaBlob);
  assert.equal(output.type, "video/mp4");
  assert.deepEqual(new Uint8Array(await output.arrayBuffer()), bytes);
  const repaired = Telegram.repairDocumentUrl(LEGACY_DOCUMENT, { filename: "0001-IMG_5767.MP4", mediaType: "video" });
  assert.match(repaired, /^https:\/\/web\.telegram\.org\/k\/stream\//);
  const repairedOptions = JSON.parse(decodeURIComponent(new URL(repaired).pathname.split("/stream/")[1]));
  assert.equal(repairedOptions.location.thumb_size, "");
  assert.equal(repairedOptions.mimeType, "video/mp4");
  assert.equal(repairedOptions.fileName, "0001-IMG_5767.MP4");
  const repairedStream = Telegram.repairDocumentUrl(LEGACY_DOCUMENT.replace("/document/", "/stream/"), {
    filename: "0001-IMG_5767.MP4", mediaType: "image"
  });
  const repairedStreamOptions = JSON.parse(decodeURIComponent(new URL(repairedStream).pathname.split("/stream/")[1]));
  assert.equal(repairedStreamOptions.location.thumb_size, "", "Repair pre-1.21.2 stream URLs as well as document URLs");
  assert.equal(repairedStreamOptions.mimeType, "video/mp4");
  let transferredUrl = "";
  const legacyRead = reader(async (url, options) => {
    transferredUrl = url;
    return fixture(bytes)(url, options);
  });
  const legacyOutput = await Telegram.transfer(browser(legacyRead), {
    ...task, url: LEGACY_DOCUMENT, filename: "0001-IMG_5767.MP4", mediaType: "image"
  }, false, Media.mediaBlob);
  assert.equal(legacyOutput.type, "video/mp4", "MP4 filenames repair legacy entries misclassified as images");
  assert.match(transferredUrl, /\/stream\//, "Legacy Telegram document URLs must transfer through a repaired range stream");
  // Model browser blob ranges explicitly. Node 22's blob: fetch drops the
  // inclusive final byte while advertising the full Content-Range; Node 24
  // fixes that Node-only behavior. Keep the production length check strict.
  const sourceBlob = new Blob([bytes], { type: "video/mp4" });
  const blobRead = reader(async (_url, options) => {
    const [, first, last] = /bytes=(\d+)-(\d+)/.exec(options.headers.Range).map(Number);
    const end = Math.min(last, sourceBlob.size - 1);
    return new Response(sourceBlob.slice(first, end + 1), {
      status: 206, headers: { "content-range": `bytes ${first}-${end}/${sourceBlob.size}`, "content-type": sourceBlob.type }
    });
  });
  const blobOutput = await Telegram.transfer(browser(blobRead), { ...task, url: URL_VALUE }, false, Media.mediaBlob);
  assert.deepEqual(new Uint8Array(await blobOutput.arrayBuffer()), bytes, "Blob byte ranges must transfer completely");
  await assert.rejects(Telegram.transfer(browser(read, true), task, false, Media.mediaBlob), /source Telegram tab/);
  await assert.rejects(read(STREAM, PAGE + "different", 0), /source changed/);
  await assert.rejects(reader(fixture(bytes, { "content-range": `bytes 1-${CHUNK}/${bytes.length}` }))(STREAM, PAGE, 0), /requested file range/);
  await assert.rejects(reader(fixture(bytes, { "content-range": "bytes 0-262143/999999999" }))(STREAM, PAGE, 0), /64 MiB/);
  await assert.rejects(reader(async () => new Response("not a video", { headers: { "content-length": "400000" } }))(STREAM, PAGE, 0), /requested file range/);
  await assert.rejects(reader(fixture(bytes, { "content-range": "bytes 0-1/3" }))(STREAM, PAGE, 0), /byte limit/);
  await assert.rejects(Telegram.transfer(browser(reader(fixture(new Uint8Array(10)))), task, false, Media.mediaBlob), /supported/);
  const changing = browser(read);
  changing.tabs.get = async () => ({ id: 4, url: PAGE + "new-chat", incognito: false });
  await assert.rejects(Telegram.transfer(changing, task, false, Media.mediaBlob), /source tab changed/);
  console.log("All Telegram transfer checks passed.");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
