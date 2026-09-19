(function attachImageDownloaderImmich(root) {
  "use strict";

  // Contract verified against immich-app/immich v3.2.0/open-api/immich-openapi-specs.json.
  const SUPPORTED_VERSION = "3.2.0";
  const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
  const MAX_MEDIA_BYTES = 64 * 1024 * 1024;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const ALBUM_PERMISSIONS = Object.freeze(["album.read", "albumAsset.create", "user.read"]);
  const MESSAGES = Object.freeze({
    invalid_server: "Enter an HTTP or HTTPS Immich server address, optionally ending in /albums, without a query, fragment, or login details.",
    invalid_key: "The Immich API key is missing or invalid. Replace the key in Integrations.",
    missing_upload_permission: "This Immich API key needs the asset.upload permission.",
    missing_album_permission: "Album selection needs album.read, albumAsset.create, and user.read API-key permissions. Library uploads need only asset.upload.",
    forbidden: "Immich denied this operation. Check the API-key permissions and album access.",
    unreachable: "Cannot reach Immich. Check the server address, Firefox site access, TLS certificate, and network; if you use Tailscale, check that it is connected.",
    timeout: "The Immich request timed out. Check the server and network, including Tailscale if used.",
    cancelled: "The operation was cancelled. A request already sent to Immich may still have been processed.",
    unsupported_api: "The Immich API endpoint was not found. Check the server address and use Immich 3.2.0.",
    invalid_response: "Immich returned an unexpected or oversized response. The remote result could not be confirmed.",
    server_error: "Immich could not finish the request. Check its availability and retry explicitly.",
    rejected: "Immich rejected this media file or operation. Check the file and server configuration.",
    album_failed: "The asset is available in Immich, but album attachment failed. Retry will only attach the existing asset.",
    invalid_asset: "The media file or remote asset identifier is invalid."
  });

  function errorMessage(code) { return MESSAGES[code] || MESSAGES.server_error; }

  class ImmichError extends Error {
    constructor(code, uncertain = false) {
      super(errorMessage(code));
      this.name = "ImmichError";
      this.code = Object.hasOwn(MESSAGES, code) ? code : "server_error";
      this.uncertain = Boolean(uncertain);
    }
  }

  function normalizeServerUrl(value) {
    try {
      if (typeof value !== "string" || value.length > 2048 || /[\s\\?#]/.test(value.trim())) throw new Error();
      const parsed = new URL(value.trim());
      if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname || parsed.hostname.includes("*") ||
          parsed.username || parsed.password || parsed.search || parsed.hash ||
          !["/", "/albums", "/albums/"].includes(parsed.pathname)) throw new Error();
      return parsed.origin;
    } catch (_error) { throw new ImmichError("invalid_server"); }
  }

  function permissionPattern(value) {
    const parsed = new URL(normalizeServerUrl(value));
    // Firefox match patterns grant a host across its ports; requests still bind to the saved origin.
    return `${parsed.protocol}//${parsed.hostname}/*`;
  }

  async function readJson(response, signal) {
    const length = Number(response.headers.get("content-length"));
    if (length > MAX_RESPONSE_BYTES || !response.body || typeof response.body.getReader !== "function") {
      throw new ImmichError("invalid_response");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    let text = "";
    try {
      while (true) {
        if (signal.aborted) throw new ImmichError("cancelled");
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_RESPONSE_BYTES) throw new ImmichError("invalid_response");
        text += decoder.decode(chunk.value, { stream: true });
      }
      return JSON.parse(text + decoder.decode());
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      if (error instanceof ImmichError) throw error;
      throw new ImmichError("invalid_response");
    } finally { reader.releaseLock(); }
  }

  async function request(connection, path, { signal, method = "GET", body } = {}) {
    const serverUrl = normalizeServerUrl(connection && connection.serverUrl);
    const apiKey = connection && connection.apiKey;
    if (typeof apiKey !== "string" || !apiKey || apiKey.length > 4096 || /[^\x21-\x7e]/.test(apiKey)) {
      throw new ImmichError("invalid_key");
    }
    if (signal && signal.aborted) throw new ImmichError("cancelled");
    const controller = new AbortController();
    const cancel = () => controller.abort();
    if (signal) signal.addEventListener("abort", cancel, { once: true });
    let timedOut = false;
    let sent = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, method === "POST" ? 120000 : 30000);
    try {
      const headers = { "x-api-key": apiKey, Accept: "application/json" };
      if (body && !(body instanceof FormData)) headers["Content-Type"] = "application/json";
      sent = true;
      const response = await root.fetch(`${serverUrl}/api${path}`, {
        method, headers, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
        credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer", signal: controller.signal
      });
      if (!response.ok) {
        if (response.body) await response.body.cancel().catch(() => undefined);
        const code = response.status === 401 ? "invalid_key" : response.status === 403 ? "forbidden" :
          response.status === 404 ? "unsupported_api" : response.status >= 500 ? "server_error" : "rejected";
        throw new ImmichError(code, method !== "GET" && response.status >= 500);
      }
      const result = await readJson(response, controller.signal);
      if (controller.signal.aborted) throw new ImmichError("cancelled");
      return result;
    } catch (error) {
      const uncertain = sent && method !== "GET";
      if (signal && signal.aborted) throw new ImmichError("cancelled", uncertain);
      if (timedOut) throw new ImmichError("timeout", uncertain);
      if (error instanceof ImmichError) {
        if (error.code === "invalid_response") error.uncertain = uncertain;
        throw error;
      }
      // Never expose response bodies, native fetch errors, or server-provided strings.
      throw new ImmichError("unreachable", uncertain);
    } finally {
      clearTimeout(timeout);
      controller.abort();
      if (signal) signal.removeEventListener("abort", cancel);
    }
  }

  async function testConnection(connection, options) {
    const result = await request(connection, "/api-keys/me", options);
    if (!result || !UUID.test(result.id) || !Array.isArray(result.permissions) || result.permissions.length > 500 ||
        result.permissions.some((value) => typeof value !== "string" || value.length > 100)) {
      throw new ImmichError("invalid_response");
    }
    const grants = (permission) => result.permissions.includes("all") || result.permissions.includes(permission);
    if (!grants("asset.upload")) throw new ImmichError("missing_upload_permission");
    // Return only understood permission names; never echo arbitrary server strings into status or storage.
    return { permissions: ["asset.upload", ...ALBUM_PERMISSIONS].filter(grants), canUseAlbums: ALBUM_PERMISSIONS.every(grants) };
  }

  async function listAlbums(connection, options) {
    const checked = await testConnection(connection, options);
    if (!checked.canUseAlbums) throw new ImmichError("missing_album_permission");
    const user = await request(connection, "/users/me", options);
    if (!user || !UUID.test(user.id)) throw new ImmichError("invalid_response");
    const albums = await request(connection, "/albums", options);
    if (!Array.isArray(albums) || albums.length > 5000) throw new ImmichError("invalid_response");
    return albums.filter((album) => album && UUID.test(album.id) && typeof album.albumName === "string" &&
      Array.isArray(album.albumUsers) && album.albumUsers.some((member) => member && member.user &&
        member.user.id === user.id && ["owner", "editor"].includes(member.role)))
      .map((album) => ({ id: album.id, name: album.albumName.slice(0, 200) }))
      .sort((first, second) => first.name.localeCompare(second.name));
  }

  async function uploadAsset(connection, { blob, filename, createdAt }, options) {
    if (!(blob instanceof Blob) || !blob.size || blob.size > MAX_MEDIA_BYTES ||
        !/^(?:image|video)\/[a-z0-9.+-]+$/i.test(blob.type) || typeof filename !== "string" ||
        !filename || filename.length > 180 || /[\x00-\x1f\x7f/\\]/.test(filename)) throw new ImmichError("invalid_asset");
    const date = new Date(createdAt);
    if (!Number.isFinite(date.getTime())) throw new ImmichError("invalid_asset");
    const body = new FormData();
    body.append("assetData", blob, filename);
    body.append("fileCreatedAt", date.toISOString());
    body.append("fileModifiedAt", date.toISOString());
    const result = await request(connection, "/assets", { ...options, method: "POST", body });
    if (!result || !UUID.test(result.id) || !["created", "duplicate"].includes(result.status)) {
      throw new ImmichError("invalid_response", true);
    }
    return { assetId: result.id, duplicate: result.status === "duplicate" };
  }

  async function addToAlbum(connection, albumId, assetId, options) {
    if (!UUID.test(albumId) || !UUID.test(assetId)) throw new ImmichError("invalid_asset");
    const result = await request(connection, `/albums/${albumId}/assets`, { ...options, method: "PUT", body: { ids: [assetId] } });
    if (!Array.isArray(result) || result.length !== 1 || !result[0] || result[0].id !== assetId ||
        !(result[0].success === true || result[0].success === false && result[0].error === "duplicate")) {
      throw new ImmichError("album_failed");
    }
    return { assetId, albumId, attached: true };
  }

  const api = Object.freeze({ SUPPORTED_VERSION, MAX_MEDIA_BYTES, ALBUM_PERMISSIONS, ImmichError, normalizeServerUrl, permissionPattern,
    errorMessage, testConnection, listAlbums, uploadAsset, addToAlbum });
  root.ImageDownloaderImmich = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis === "object" ? globalThis : this);
