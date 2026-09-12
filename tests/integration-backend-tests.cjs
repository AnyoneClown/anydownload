"use strict";
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { stripTypeScriptTypes } = require("node:module");
const vm = require("node:vm");
const source = readFileSync(require("node:path").join(__dirname, "../supabase/functions/external-integrations/index.ts"), "utf8");
const handlerSource = stripTypeScriptTypes(source.replace("export async function handler", "async function handler")
  .replace("Deno.serve((request) => handler(request));", "globalThis.handler = handler;"));
const scope = { Request, Response, URL, TextDecoder, Uint8Array, AbortSignal, fetch };
vm.runInNewContext(handlerSource, scope);
const USER = "a11d0000-0000-4000-8000-000000000011";
const ID = "a11d0000-0000-4000-8000-000000000020";
const metadata = { id: ID, provider: "immich", serverUrl: "http://192.168.0.103:2283", defaultAlbumId: null };
const env = { get: key => ({ SUPABASE_URL: "https://project.supabase.co", SUPABASE_ANON_KEY: "public-project-key" })[key] };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
function request(body = { action: "list" }, headers = {}, method = "POST") {
  return new Request("https://project.supabase.co/functions/v1/external-integrations", {
    method, headers: { "Content-Type": "application/json", Authorization: "Bearer user-token", ...headers },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
}
async function run() {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    assert.equal(new URL(url).origin, "https://project.supabase.co", "Backend never contacts Immich");
    assert.equal(options.headers.Authorization, "Bearer user-token");
    assert.equal(options.cache, "no-store");
    assert.equal(options.redirect, "error");
    if (url.endsWith("/auth/v1/user")) return json({ id: USER });
    const body = JSON.parse(options.body);
    assert.deepEqual(Object.keys(body), ["request"]);
    assert.equal(body.request.userId, undefined, "Never accept or forward client authorization IDs");
    return json({ connection: { ...metadata, apiKey: "must-not-leak" }, apiKey: "owner-key", connections: [{ ...metadata, secret_id: "must-not-leak" }], deleted: true });
  };
  for (const action of ["list", "save", "credential", "delete", "defaultAlbum"]) {
    const body = action === "list" ? { action } : { action, connectionId: ID };
    if (action === "save") Object.assign(body, { provider: "immich", serverUrl: metadata.serverUrl, apiKey: "owner-key" });
    if (action === "defaultAlbum") body.defaultAlbumId = null;
    const response = await scope.handler(request(body), env, fetcher);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    const text = await response.text();
    assert.ok(!text.includes("must-not-leak"));
    assert.equal(text.includes("owner-key"), action === "credential");
    assert.equal(calls.at(-2).url.endsWith("/auth/v1/user"), true, "Verify current user before every operation");
  }
  const noFetch = () => { throw new Error("Must not contact backend"); };
  const invalid = [
    { action: "list", userId: USER }, { action: "credential", connectionId: "bad" },
    { action: "save", provider: "google-drive", serverUrl: metadata.serverUrl, apiKey: "key" },
    { action: "save", provider: "immich", serverUrl: "http://username:password@host.test", apiKey: "key" },
    { action: "save", provider: "immich", serverUrl: "http://host.test/albums", apiKey: "key" },
    { action: "save", provider: "immich", serverUrl: metadata.serverUrl, apiKey: "bad\r\nheader" },
    { action: "save", provider: "immich", serverUrl: metadata.serverUrl, apiKey: "x".repeat(20000) },
  ];
  for (const body of invalid) {
    const response = await scope.handler(request(body), env, noFetch);
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  }
  for (const [req, status] of [[request({}, {}, "GET"), 405], [request({}, { Authorization: "" }), 401], [request({}, {}, "OPTIONS"), 204]]) {
    const response = await scope.handler(req, env, noFetch);
    assert.equal(response.status, status);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  }
  for (const authValue of [json({ id: USER }, 401), json({ id: USER, is_anonymous: true }), json({ id: "malformed" })]) {
    let fetched = 0;
    const response = await scope.handler(request(), env, async () => { fetched++; return authValue; });
    assert.equal(response.status, 401);
    assert.equal(fetched, 1);
  }
  for (const status of [400, 401, 404, 500]) {
    const response = await scope.handler(request(), env, async url => url.endsWith("/user") ? json({ id: USER }) : json({ error: "do-not-leak-secret" }, status));
    assert.equal(response.status, status);
    assert.ok(!(await response.text()).includes("do-not-leak-secret"));
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  }
  const failed = await scope.handler(request(), env, async () => { throw new Error("secret-in-network-error"); });
  assert.equal(failed.status, 500);
  assert.ok(!(await failed.text()).includes("secret-in-network-error"));
  console.log("Integration backend checks passed (mocked Auth/Data API; no live Vault or Immich calls).");
}
run().catch(error => { console.error(error); process.exitCode = 1; });
