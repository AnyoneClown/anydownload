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
async function main() {
  for (const value of [URL_VALUE, STREAM]) assert(Telegram.isMediaUrl(value));
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
  const blobSource = URL.createObjectURL(new Blob([bytes], { type: "video/mp4" }));
  try {
    const blobRead = reader((_url, options) => fetch(blobSource, options));
    const blobOutput = await Telegram.transfer(browser(blobRead), { ...task, url: URL_VALUE }, false, Media.mediaBlob);
    assert.equal(blobOutput.size, bytes.length, "Real blob byte ranges must transfer completely");
  } finally { URL.revokeObjectURL(blobSource); }
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
