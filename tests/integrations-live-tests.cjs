"use strict";

// Opt-in: two fresh disposable user tokens in ANYDOWNLOAD_TEST_TOKEN_A/B.
// Run: node tests/integrations-live-tests.cjs
// Only the bundled Supabase project is contacted; .invalid Immich origins and
// synthetic keys are never tested against an Immich server. Delete test users afterwards.
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { CONFIG } = require("../extension/shared/cloud-sync-runtime.js");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENDPOINT = "/functions/v1/external-integrations";

async function main({ tokens = [process.env.ANYDOWNLOAD_TEST_TOKEN_A, process.env.ANYDOWNLOAD_TEST_TOKEN_B], fetcher = fetch } = {}) {
  assert.ok(tokens.length === 2 && tokens.every(token => typeof token === "string" && token), "Provide two disposable user access tokens in ANYDOWNLOAD_TEST_TOKEN_A/B.");
  for (const token of tokens) {
    let claims;
    try { claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url")); }
    catch { throw new Error("Provide valid user access tokens."); }
    assert.ok(claims.role === "authenticated" && UUID.test(claims.sub) && claims.is_anonymous !== true, "Use authenticated user tokens, never anonymous or privileged credentials.");
    assert.ok(claims.exp * 1000 > Date.now() + 300000, "Provide fresh user tokens with at least five minutes left.");
  }

  const created = new Map();
  const serverUrl = `https://anydownload-live-${randomUUID()}.invalid`;
  const keys = [0, 1].map(index => `synthetic-${index}-${randomUUID()}`);
  const replacements = [0, 1].map(index => `synthetic-replacement-${index}-${randomUUID()}`);
  async function api(index, path, { method = "GET", body, status = 200 } = {}) {
    let response;
    try {
      response = await fetcher(`${CONFIG.url}${path}`, {
        method, redirect: "error", credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(20000),
        headers: { apikey: CONFIG.publicKey, "Content-Type": "application/json",
          ...(index === null ? {} : { Authorization: `Bearer ${tokens[index]}` }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
    } catch { throw new Error(`Live integrations ${body?.action || "auth"} request failed.`); }
    let output;
    try { output = await response.json(); }
    catch { throw new Error(`Live integrations ${body?.action || "auth"} response was not JSON.`); }
    // Track successful creates before validating their response, so a failed
    // assertion still removes exactly the newly returned connection IDs.
    if (body?.action === "save" && !body.connectionId && response.status === 200 && UUID.test(output?.connection?.id)) {
      created.set(output.connection.id, index);
    }
    assert.ok((Array.isArray(status) ? status : [status]).includes(response.status), `${body?.action || "auth"} returned HTTP ${response.status}; expected ${status}.`);
    if (path === ENDPOINT) {
      assert.ok(/(?:^|,)\s*no-store\s*(?:,|$)/i.test(response.headers.get("Cache-Control") || ""), "Integration responses must use Cache-Control: no-store.");
      assert.ok(response.headers.get("Pragma") === "no-cache", "Integration responses must use Pragma: no-cache.");
    }
    return output;
  }
  const send = (index, action, fields = {}, status = 200) => api(index, ENDPOINT, { method: "POST", body: { action, ...fields }, status });
  function fields(value, names, message) {
    assert.ok(value && typeof value === "object" && !Array.isArray(value) &&
      JSON.stringify(Object.keys(value).sort()) === JSON.stringify(names.sort()), message);
  }
  function metadata(value, id, album = null) {
    fields(value, ["id", "provider", "serverUrl", "defaultAlbumId"], "Connection metadata contains unexpected fields.");
    assert.ok(UUID.test(value.id) && (!id || value.id === id) && value.provider === "immich" &&
      value.serverUrl === serverUrl && value.defaultAlbumId === album, "Connection metadata does not match the saved connection.");
    return value.id;
  }
  async function list(index, id, album = null) {
    const output = await send(index, "list");
    fields(output, ["connections"], "List response contains unexpected fields.");
    assert.ok(Array.isArray(output.connections) && output.connections.length === (id ? 1 : 0), "Unexpected connections; use empty disposable accounts only.");
    if (id) metadata(output.connections[0], id, album);
  }
  async function credential(index, id, key, album = null) {
    const output = await send(index, "credential", { connectionId: id });
    fields(output, ["connection", "apiKey"], "Credential response contains unexpected fields.");
    metadata(output.connection, id, album);
    assert.ok(output.apiKey === key, "Owner credential does not match the synthetic key.");
    delete output.apiKey;
  }
  function saved(output, id, album = null) {
    fields(output, ["connection"], "Save response leaked unexpected fields.");
    return metadata(output.connection, id, album);
  }
  function notFound(output) {
    fields(output, ["error"], "Rejected operation leaked unexpected fields.");
    assert.ok(output.error === "Connection not found.", "Cross-user or deleted connection access was not rejected.");
  }

  const users = await Promise.all(tokens.map((_token, index) => api(index, "/auth/v1/user")));
  assert.ok(users.every(user => UUID.test(user?.id) && user.is_anonymous !== true) && users[0].id !== users[1].id,
    "Use two distinct, verified, non-anonymous disposable accounts.");
  // Check both accounts before the first mutation; never overwrite existing data.
  await list(0);
  await list(1);
  let failure;
  let cleanupFailures = 0;
  try {
    await send(null, "list", {}, 401);
    const ids = [];
    for (let index = 0; index < 2; index++) {
      ids[index] = saved(await send(index, "save", { provider: "immich", serverUrl, apiKey: keys[index] }));
      await list(index, ids[index]);
      await credential(index, ids[index], keys[index]);
      const defaultAlbumId = randomUUID();
      saved(await send(index, "defaultAlbum", { connectionId: ids[index], defaultAlbumId }), ids[index], defaultAlbumId);
      await list(index, ids[index], defaultAlbumId);
      saved(await send(index, "save", { connectionId: ids[index], provider: "immich", serverUrl,
        apiKey: replacements[index], defaultAlbumId }), ids[index], defaultAlbumId);
      await credential(index, ids[index], replacements[index], defaultAlbumId);
      saved(await send(index, "defaultAlbum", { connectionId: ids[index], defaultAlbumId: null }), ids[index]);
    }
    assert.ok(ids[0] !== ids[1], "Different owners must have separate connections.");
    for (let index = 0; index < 2; index++) {
      const connectionId = ids[1 - index];
      for (const [action, extra] of [
        ["credential", {}], ["save", { provider: "immich", serverUrl, apiKey: keys[index] }],
        ["defaultAlbum", { defaultAlbumId: randomUUID() }], ["delete", {}]
      ]) notFound(await send(index, action, { connectionId, ...extra }, 404));
    }
    // Rejected cross-user mutations must leave both owners' metadata and keys intact.
    for (let index = 0; index < 2; index++) {
      await list(index, ids[index]);
      await credential(index, ids[index], replacements[index]);
      const output = await send(index, "delete", { connectionId: ids[index] });
      fields(output, ["deleted"], "Delete response contains unexpected fields.");
      assert.ok(output.deleted === true, "Owner connection deletion failed.");
      created.delete(ids[index]);
      notFound(await send(index, "credential", { connectionId: ids[index] }, 404));
      await list(index);
    }
  } catch (error) { failure = error; }
  finally {
    for (const [connectionId, index] of created) {
      try {
        // A test may have deleted the row before a response/header assertion failed.
        const output = await send(index, "delete", { connectionId }, [200, 404]);
        assert.ok(output.deleted === true || output.error === "Connection not found.", "Synthetic connection cleanup failed.");
        created.delete(connectionId);
      } catch { cleanupFailures++; }
    }
  }
  if (cleanupFailures) throw new Error("Synthetic connection cleanup failed; delete both disposable users before retrying.");
  if (failure) throw failure;
  console.log("Live integrations passed: list/save, Vault key retrieval/replacement, albums, no-store, metadata redaction, bidirectional ownership isolation and deletion. Synthetic connections cleaned up.");
}

module.exports = { main };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
