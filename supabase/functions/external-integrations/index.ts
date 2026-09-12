// No media leaves Firefox through this endpoint. No service key or SDK needed.
const HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "Pragma": "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIELDS: Record<string, string[]> = {
  list: [],
  save: ["connectionId", "provider", "serverUrl", "apiKey", "defaultAlbumId"],
  credential: ["connectionId"],
  delete: ["connectionId"],
  defaultAlbum: ["connectionId", "defaultAlbumId"],
};
const respond = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: HEADERS });

function validRequest(data: Record<string, unknown>): boolean {
  const fields = FIELDS[String(data.action)];
  if (!Object.hasOwn(FIELDS, String(data.action)) ||
    Object.keys(data).some((key) => key !== "action" && !fields.includes(key))) return false;
  if ((data.action !== "list" && data.action !== "save") || Object.hasOwn(data, "connectionId")) {
    if (typeof data.connectionId !== "string" || !UUID.test(data.connectionId)) return false;
  }
  if (Object.hasOwn(data, "defaultAlbumId") && data.defaultAlbumId !== null &&
    (typeof data.defaultAlbumId !== "string" || !UUID.test(data.defaultAlbumId))) return false;
  if (data.action === "defaultAlbum" && !Object.hasOwn(data, "defaultAlbumId")) return false;
  if (data.action === "save") {
    if (data.provider !== "immich" || typeof data.apiKey !== "string" ||
      !/^[!-~]{1,4096}$/.test(data.apiKey) || typeof data.serverUrl !== "string" ||
      data.serverUrl.length > 2048) return false;
    try {
      const url = new URL(data.serverUrl);
      if (!["http:", "https:"].includes(url.protocol) || url.origin !== data.serverUrl ||
        url.username || url.password) return false;
    } catch { return false; }
  }
  return true;
}

async function readRequest(req: Request): Promise<Record<string, unknown>> {
  if (!req.body) throw new Error();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16384) throw new Error();
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const data = JSON.parse(new TextDecoder().decode(bytes));
  if (!data || typeof data !== "object" || Array.isArray(data) || !validRequest(data)) throw new Error();
  return data;
}

export async function handler(
  req: Request,
  env = Deno.env,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: HEADERS });
  if (req.method !== "POST") return respond({ error: "Use POST for integration requests." }, 405);
  if (new URL(req.url).search || !/^application\/json(?:;|$)/i.test(req.headers.get("Content-Type") || "")) {
    return respond({ error: "Invalid integration request." }, 400);
  }
  const authorization = req.headers.get("Authorization") || "";
  if (!/^Bearer [A-Za-z0-9_.-]{1,16384}$/.test(authorization)) {
    return respond({ error: "Sign in to your AnyDownload account." }, 401);
  }
  let data: Record<string, unknown>;
  try { data = await readRequest(req); }
  catch { return respond({ error: "Invalid integration request." }, 400); }

  try {
    const project = env.get("SUPABASE_URL") || "";
    const publicKey = env.get("SUPABASE_ANON_KEY") || "";
    if (!project || !publicKey) return respond({ error: "Integrations are not configured." }, 503);
    const headers = { Authorization: authorization, apikey: publicKey };
    const options = { headers, redirect: "error" as const, credentials: "omit" as const, cache: "no-store" as const };
    // Auth's verified get-user operation; never decode an unverified JWT or accept a user ID.
    const auth = await fetcher(`${project}/auth/v1/user`, { ...options, signal: AbortSignal.timeout(15000) });
    if (!auth.ok) return respond({ error: "Sign in to your AnyDownload account." }, 401);
    const user = await auth.json();
    if (typeof user?.id !== "string" || !UUID.test(user.id) || user.is_anonymous === true) {
      return respond({ error: "Sign in to your AnyDownload account." }, 401);
    }
    const result = await fetcher(`${project}/rest/v1/rpc/anydownload_external_integrations`, {
      ...options, headers: { ...headers, "Content-Type": "application/json" },
      method: "POST", body: JSON.stringify({ request: data }), signal: AbortSignal.timeout(15000),
    });
    if (!result.ok) {
      const status = [400, 401, 404].includes(result.status) ? result.status : 500;
      const error = status === 404 ? "Connection not found." : status === 401
        ? "Sign in to your AnyDownload account." : status === 400
        ? "Invalid integration request or existing server connection." : "Integration operation failed. Try again.";
      return respond({ error }, status);
    }
    const output = await result.json();
    // Whitelist metadata even if the database response changes in a later release.
    const connection = (value: Record<string, unknown>) => ({
      id: value.id, provider: value.provider, serverUrl: value.serverUrl, defaultAlbumId: value.defaultAlbumId,
    });
    if (data.action === "list") return respond({ connections: output.connections.map(connection) });
    if (data.action === "delete") return respond({ deleted: output.deleted === true });
    if (data.action === "credential") return respond({ connection: connection(output.connection), apiKey: output.apiKey });
    return respond({ connection: connection(output.connection) });
  } catch {
    return respond({ error: "Integration operation failed. Try again." }, 500);
  } finally {
    delete data.apiKey;
  }
}

Deno.serve((request) => handler(request));
