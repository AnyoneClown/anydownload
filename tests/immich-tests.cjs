"use strict";

const assert = require("assert").strict;
const Immich = require("../extension/shared/immich.js");
const Images = require("../extension/shared/image-fetch.js");
const key = "test-only-credential-never-display";
const connection = { serverUrl: "http://192.168.0.103:2283", apiKey: key };
const apiKeyId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000002";
const assetId = "00000000-0000-4000-8000-000000000003";
const albumId = "00000000-0000-4000-8000-000000000004";
const otherId = "00000000-0000-4000-8000-000000000005";
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const blob = new Blob([png], { type: "image/png" });
const asset = { blob, filename: "image.png", createdAt: "2026-09-12T00:00:00.000Z", deviceAssetId: "ignored-v3" };
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });

async function main() {
  assert.equal(Immich.SUPPORTED_VERSION, "3.2.0");
  assert.equal(Immich.normalizeServerUrl(" http://192.168.0.103:2283/albums/ "), connection.serverUrl);
  assert.equal(Immich.normalizeServerUrl("https://photos.tail123.ts.net/albums"), "https://photos.tail123.ts.net");
  assert.equal(Immich.permissionPattern(connection.serverUrl), "http://192.168.0.103/*");
  assert.equal(Immich.permissionPattern("https://[fd7a:115c:a1e0::1]:2283"), "https://[fd7a:115c:a1e0::1]/*");
  for (const url of ["ftp://photos", "http://user:password@photos", "http://photos/api", "https://photos/albums/123", "http://photos/?key=secret", "http://photos/#secret", "http://photos/?", "http://photos/#", "https://*.photos", "https://photos\\evil"]) {
    assert.throws(() => Immich.normalizeServerUrl(url), { code: "invalid_server" });
  }
  let requests = [];
  global.fetch = async (url, options) => { requests.push({ url, options }); return json({ id: apiKeyId, permissions: ["asset.upload", key] }); };
  assert.deepEqual(await Immich.testConnection(connection), { permissions: ["asset.upload"], canUseAlbums: false });
  assert.equal(requests[0].url, `${connection.serverUrl}/api/api-keys/me`);
  assert.equal(requests[0].options.headers["x-api-key"], key);
  assert.equal(requests[0].options.credentials, "omit");
  assert.equal(requests[0].options.redirect, "error");
  assert.equal(requests[0].options.cache, "no-store");
  assert.equal(requests[0].options.referrerPolicy, "no-referrer");
  assert.ok(!requests[0].url.includes(key));

  global.fetch = async () => json({ id: apiKeyId, permissions: ["album.read"] });
  await assert.rejects(Immich.testConnection(connection), { code: "missing_upload_permission" });
  global.fetch = async () => json({ id: apiKeyId, permissions: ["asset.upload"] });
  await assert.rejects(Immich.listAlbums(connection), { code: "missing_album_permission" });
  for (const [status, code] of [[401, "invalid_key"], [403, "forbidden"], [404, "unsupported_api"], [500, "server_error"]]) {
    global.fetch = async () => json({ error: key }, status);
    await assert.rejects(Immich.testConnection(connection), (error) => error.code === code && !error.message.includes(key));
  }
  global.fetch = async () => { throw new TypeError(`Rejected redirect with ${key}`); };
  await assert.rejects(Immich.testConnection(connection), (error) => error.code === "unreachable" && /Tailscale/.test(error.message) && !error.message.includes(key));
  await assert.rejects(Immich.uploadAsset(connection, asset), (error) => error.code === "unreachable" && error.uncertain === true);
  await assert.rejects(Immich.testConnection({ ...connection, apiKey: "bad\nkey" }), { code: "invalid_key" });

  const controller = new AbortController();
  global.fetch = async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error(key)), { once: true });
    controller.abort();
  });
  await assert.rejects(Immich.uploadAsset(connection, asset, { signal: controller.signal }), (error) => error.code === "cancelled" && error.uncertain === true && !error.message.includes(key));
  global.fetch = async () => { throw new Error("must not fetch"); };
  await assert.rejects(Immich.testConnection(connection, { signal: controller.signal }), { code: "cancelled" });

  const realSetTimeout = global.setTimeout;
  global.setTimeout = (callback) => realSetTimeout(callback, 1);
  global.fetch = async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error(key)), { once: true }));
  try { await assert.rejects(Immich.testConnection(connection), { code: "timeout" }); }
  finally { global.setTimeout = realSetTimeout; }

  for (const status of ["created", "duplicate"]) {
    global.fetch = async (url, options) => {
      assert.equal(url, `${connection.serverUrl}/api/assets`);
      assert.equal(options.method, "POST");
      assert.equal(options.headers["Content-Type"], undefined, "Browser supplies multipart boundary");
      assert.deepEqual([...options.body.keys()], ["assetData", "fileCreatedAt", "fileModifiedAt"]);
      assert.equal(options.body.get("assetData").name, "image.png");
      assert.deepEqual(new Uint8Array(await options.body.get("assetData").arrayBuffer()), png);
      assert.equal(options.body.get("fileCreatedAt"), asset.createdAt);
      return json({ id: assetId, status }, status === "created" ? 201 : 200);
    };
    assert.deepEqual(await Immich.uploadAsset(connection, asset), { assetId, duplicate: status === "duplicate" });
  }
  global.fetch = async () => json({ id: assetId, status: key });
  await assert.rejects(Immich.uploadAsset(connection, asset), (error) => error.code === "invalid_response" && error.uncertain && !error.message.includes(key));
  global.fetch = async () => json({ error: key }, 200, { "content-length": String(3 * 1024 * 1024) });
  await assert.rejects(Immich.testConnection(connection), { code: "invalid_response" });
  global.fetch = async () => new Response("x".repeat(2 * 1024 * 1024 + 1));
  await assert.rejects(Immich.testConnection(connection), { code: "invalid_response" });
  global.fetch = async () => new Response(`<html>${key}</html>`);
  await assert.rejects(Immich.testConnection(connection), (error) => error.code === "invalid_response" && !error.message.includes(key));

  requests = [];
  global.fetch = async (url) => {
    requests.push(url);
    if (url.endsWith("/api-keys/me")) return json({ id: apiKeyId, permissions: ["all"] });
    if (url.endsWith("/users/me")) return json({ id: userId });
    return json([
      { id: albumId, albumName: "Owned", albumUsers: [{ user: { id: userId }, role: "owner" }] },
      { id: otherId, albumName: "Shared", albumUsers: [{ user: { id: userId }, role: "editor" }] },
      { id: otherId, albumName: "Read only", albumUsers: [{ user: { id: userId }, role: "viewer" }] },
      { id: otherId, albumName: "Other account", albumUsers: [{ user: { id: otherId }, role: "owner" }] }
    ]);
  };
  assert.deepEqual(await Immich.listAlbums(connection), [{ id: albumId, name: "Owned" }, { id: otherId, name: "Shared" }]);
  assert.deepEqual(requests.map((url) => url.replace(connection.serverUrl, "")), ["/api/api-keys/me", "/api/users/me", "/api/albums"]);
  for (const response of [{ id: assetId, success: true }, { id: assetId, success: false, error: "duplicate" }]) {
    global.fetch = async (url, options) => {
      assert.equal(url, `${connection.serverUrl}/api/albums/${albumId}/assets`);
      assert.equal(options.method, "PUT");
      assert.deepEqual(JSON.parse(options.body), { ids: [assetId] });
      return json([response]);
    };
    assert.deepEqual(await Immich.addToAlbum(connection, albumId, assetId), { assetId, albumId, attached: true });
  }
  global.fetch = async () => json([{ id: assetId, success: false, error: "no_permission", errorMessage: key }]);
  await assert.rejects(Immich.addToAlbum(connection, albumId, assetId), (error) => error.code === "album_failed" && !error.message.includes(key));
  await assert.rejects(Immich.addToAlbum(connection, "../../evil", assetId), { code: "invalid_asset" });

  const sourceUrl = "https://source.example/photo.png";
  let calls = 0;
  global.fetch = async (url, options) => {
    calls += 1;
    assert.equal(url, sourceUrl);
    assert.equal(options.credentials, "include");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers, undefined, "Source media never receives an Immich API key");
    return new Response(png, { headers: { "content-type": "application/octet-stream" } });
  };
  await assert.rejects(Images.fetchImageBytes(sourceUrl), { code: "source_permission" });
  assert.equal(calls, 0);
  const fetched = await Images.fetchImageBytes(sourceUrl, undefined, { permissionContains: async (pattern) => pattern === "https://source.example/*" });
  assert.deepEqual(fetched.bytes, png);
  assert.equal(fetched.contentType, "image/png");
  assert.equal(calls, 1);
  const permitted = { permissionContains: async () => true };
  global.fetch = async () => { throw new Error(`source error ${key}`); };
  await assert.rejects(Images.fetchImageBytes(sourceUrl, undefined, permitted), (error) => error.code === "source_failed" && !error.message.includes(key));
  global.fetch = async () => new Response(png, { headers: { "content-length": String(Images.MAX_IMAGE_BYTES + 1) } });
  await assert.rejects(Images.fetchImageBytes(sourceUrl, undefined, permitted), { code: "image_too_large" });
  global.fetch = async () => new Response("<html>not an image</html>", { headers: { "content-type": "image/png" } });
  await assert.rejects(Images.fetchImageBytes(sourceUrl, undefined, permitted), { code: "invalid_image" });
  global.fetch = async () => new Response(png, { headers: { "content-type": "video/mp4" } });
  await assert.rejects(Images.fetchImageBytes(sourceUrl, undefined, permitted), { code: "invalid_image" });
  await assert.rejects(Images.fetchImageBytes("data:image/png;base64,AAAA", undefined, permitted), { code: "embedded_image" });
  await assert.rejects(Images.fetchImageBytes(sourceUrl, controller.signal, permitted), { code: "cancelled" });
  await assert.rejects(Images.imageBlob(new Blob(["bad image"], { type: "image/png" })), { code: "invalid_image" });
  assert.equal((await Images.imageBlob(new Blob([png]))).type, "image/png");
  console.log("Immich provider and bounded image-fetch tests passed.");
}

const realFetch = global.fetch;
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => { global.fetch = realFetch; });
