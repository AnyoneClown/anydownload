(function attachTelegram(root) {
  "use strict";
  const MAX_BYTES = 64 * 1024 * 1024;
  const CHUNK_BYTES = 256 * 1024;

  function isMediaUrl(value) {
    return typeof value === "string" && value.length <= 16384 &&
      (/^blob:https:\/\/web\.telegram\.org\/[a-z0-9-]+$/i.test(value) ||
       /^https:\/\/web\.telegram\.org\/(?:k|a)\/(?:stream|document)\/[^/#]+$/i.test(value));
  }

  function repairDocumentUrl(value, task = {}) {
    try {
      const url = new URL(value);
      const match = /^\/(k|a)\/(?:stream|document)\/([^/#]+)$/i.exec(url.pathname);
      if (url.origin !== "https://web.telegram.org" || url.username || url.password ||
        url.search || url.hash || !match || value.length > 16384) return value;
      const options = JSON.parse(decodeURIComponent(match[2]));
      const location = options && options.location;
      const dcId = Number(options && options.dcId);
      const size = Number(options && options.size);
      const id = String(location && location.id || "");
      const accessHash = String(location && location.access_hash || "");
      const fileReference = Array.isArray(location && location.file_reference)
        ? location.file_reference.slice(0, 512) : [];
      if (!Number.isSafeInteger(dcId) || dcId <= 0 || dcId > 1000 ||
        !Number.isSafeInteger(size) || size <= 0 || size > MAX_BYTES ||
        !location || location._ !== "inputDocumentFileLocation" ||
        !/^\d{1,30}$/.test(id) || !/^-?\d{1,30}$/.test(accessHash) || !fileReference.length ||
        fileReference.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) return value;
      const filename = String(task.filename || options.fileName || "").slice(0, 180);
      let mimeType = String(options.mimeType || "").split(";", 1)[0].toLowerCase();
      const extensions = { mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime",
        webm: "video/webm", mkv: "video/x-matroska", ogv: "video/ogg",
        jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };
      const extension = /\.([a-z0-9]{2,5})$/i.exec(filename);
      if (!/^(?:image|video)\/[a-z0-9.+-]+$/i.test(mimeType)) {
        mimeType = extensions[String(extension && extension[1] || "").toLowerCase()] ||
          (task.mediaType === "video" ? "video/mp4" : task.mediaType === "image" ? "image/jpeg" : "");
      }
      if (!/^(?:image|video)\/[a-z0-9.+-]+$/i.test(mimeType)) return value;
      const repaired = new URL(`${match[1].toLowerCase()}/stream/${encodeURIComponent(JSON.stringify({
        dcId,
        location: { _: "inputDocumentFileLocation", id, access_hash: accessHash,
          file_reference: fileReference, thumb_size: "" },
        size, mimeType, ...(filename ? { fileName: filename } : {})
      }))}`, url.origin + "/").href;
      return repaired.length <= 16384 ? repaired : value;
    } catch (_error) {
      return value;
    }
  }

  function isReference(value) {
    try {
      const url = new URL(value);
      return url.origin === "https://web.telegram.org" && url.pathname === "/k/" &&
        !url.username && !url.password && !url.hash && value.length <= 1000 &&
        url.searchParams.get("anydownload_telegram") === "1" &&
        /^-?\d{1,20}$/.test(url.searchParams.get("peer")) &&
        /^\d{1,20}$/.test(url.searchParams.get("mid")) &&
        /^\d{1,30}$/.test(url.searchParams.get("id")) &&
        ["photo", "video", "image"].includes(url.searchParams.get("kind"));
    } catch (_error) { return false; }
  }

  // Serialized into Telegram's main world. Read only messages represented in
  // the loaded DOM; never enumerate chat history or access account credentials.
  async function pageMedia(options = {}) {
    const pageUrl = location.href;
    const result = { handled: true, pageUrl, pageTitle: document.title,
      embeddedFrameCount: 0, images: [], warnings: [] };
    const maximum = 64 * 1024 * 1024;
    if (!/^https:\/\/web\.telegram\.org\/k\//.test(pageUrl) ||
      options.expectedPage && options.expectedPage !== pageUrl) {
      throw new Error("The Telegram chat changed. Return to the source chat and rescan.");
    }
    const proxy = globalThis.apiManagerProxy;
    const downloads = globalThis.appDownloadManager;
    if (!proxy || typeof proxy.getMessageByPeer !== "function") {
      if (options.resolve) throw new Error("Telegram original media is unavailable. Reload Telegram and rescan.");
      result.warnings.push("Telegram original media is unavailable. Reload Telegram and rescan; chat thumbnails have not been substituted for originals.");
      return result;
    }
    function mediaCandidates(peer, mid) {
      const message = proxy.getMessageByPeer(Number(peer), Number(mid));
      const messageMedia = message && message.media;
      const candidates = [];
      let locked = 0;
      function add(container, paid) {
        const media = container && (container.photo || container.document ||
          (["photo", "document"].includes(container._) ? container : null));
        if (!media || !/^\d{1,30}$/.test(String(media.id)) ||
          candidates.some((item) => String(item.media.id) === String(media.id))) return;
        candidates.push({ media, paid });
      }
      add(messageMedia, false);
      const extendedMedia = Array.isArray(messageMedia && messageMedia.extended_media)
        ? messageMedia.extended_media
        : Array.isArray(messageMedia && messageMedia.extendedMedia) ? messageMedia.extendedMedia : [];
      for (const extended of extendedMedia.slice(0, 32)) {
        if (extended && extended._ === "messageExtendedMedia") add(extended.media, true);
        else if (extended && extended._ === "messageExtendedMediaPreview") locked++;
      }
      return { candidates, locked };
    }
    function details(candidate) {
      const media = candidate && candidate.media;
      if (!media) return null;
      const attributes = Array.isArray(media.attributes) ? media.attributes.slice(0, 30) : [];
      let thumb;
      let width = 0, height = 0, duration = 0;
      let size = Number(media.size) || 0;
      let mimeType = String(media.mime_type || "").split(";", 1)[0].toLowerCase();
      let kind;
      if (media._ === "photo") {
        const sizes = (Array.isArray(media.sizes) ? media.sizes : []).slice(0, 32)
          .filter((item) => ["photoSize", "photoSizeProgressive"].includes(item._) &&
            Number(item.w) > 0 && Number(item.h) > 0);
        thumb = sizes.sort((a, b) => Number(b.w) * Number(b.h) - Number(a.w) * Number(a.h))[0];
        if (!thumb) return null;
        width = Number(thumb.w); height = Number(thumb.h);
        size = Number(thumb.size) || Math.max(0, ...(Array.isArray(thumb.sizes) ? thumb.sizes.slice(0, 32).map(Number) : []));
        mimeType = "image/jpeg";
        kind = "photo";
      } else if (media._ === "document") {
        const video = attributes.find((item) => item._ === "documentAttributeVideo");
        const image = attributes.find((item) => item._ === "documentAttributeImageSize");
        if (video || /^video\//.test(mimeType)) {
          kind = "video";
          mimeType = /^video\//.test(mimeType) ? mimeType : "video/mp4";
          width = Number(video && video.w) || Number(media.w) || 0;
          height = Number(video && video.h) || Number(media.h) || 0;
          duration = Number(video && video.duration) || 0;
        } else if (/^image\//.test(mimeType)) {
          kind = "image";
          width = Number(image && image.w) || 0; height = Number(image && image.h) || 0;
        } else return null;
      } else return null;
      if (!Number.isSafeInteger(size) || size <= 0 || size > maximum) {
        throw new Error("A Telegram original has an unknown size or exceeds the 64 MiB per-file limit.");
      }
      const nameAttribute = attributes.find((item) => item._ === "documentAttributeFilename");
      let filename = String(media.file_name || nameAttribute && nameAttribute.file_name || "").slice(0, 180);
      const extensions = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp",
        "image/gif": "gif", "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "video/x-matroska": "mkv" };
      const extension = extensions[mimeType] || (kind === "video" ? "mp4" : "jpg");
      if (!filename) filename = `telegram-${kind}-${media.id}.${extension}`;
      else if (!/\.(?:jpe?g|png|gif|webp|mp4|webm|mov|mkv|m4v|ogv)$/i.test(filename)) filename += `.${extension}`;
      return { media, thumb, kind, width, height, duration, mimeType, filename,
        paid: candidate.paid === true };
    }
    if (options.resolve) {
      const reference = new URL(options.resolve);
      if (reference.origin !== "https://web.telegram.org" || reference.pathname !== "/k/" ||
        reference.username || reference.password || reference.hash || options.resolve.length > 1000 ||
        reference.searchParams.get("anydownload_telegram") !== "1" ||
        !/^-?\d{1,20}$/.test(reference.searchParams.get("peer")) ||
        !/^\d{1,20}$/.test(reference.searchParams.get("mid")) ||
        !/^\d{1,30}$/.test(reference.searchParams.get("id"))) throw new Error("Invalid Telegram media reference.");
      const requestedId = reference.searchParams.get("id");
      const match = mediaCandidates(reference.searchParams.get("peer"), reference.searchParams.get("mid"))
        .candidates.find((candidate) => String(candidate.media.id) === requestedId);
      const original = details(match);
      if (!original || original.kind !== reference.searchParams.get("kind")) throw new Error("Telegram original media expired. Rescan the chat.");
      if (original.media._ === "document") {
        const media = original.media;
        const dcId = Number(media.dc_id);
        const accessHash = String(media.access_hash || "");
        const fileReference = Array.isArray(media.file_reference) ? media.file_reference.slice(0, 512) : [];
        if (!Number.isSafeInteger(dcId) || dcId <= 0 || dcId > 1000 ||
          !/^-?\d{1,30}$/.test(accessHash) || !fileReference.length ||
          fileReference.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255) ||
          !/^(?:image|video)\/[a-z0-9.+-]+$/i.test(original.mimeType)) {
          throw new Error("Telegram's original-file metadata is incomplete. Reload Telegram and rescan.");
        }
        const stream = new URL(`stream/${encodeURIComponent(JSON.stringify({
          dcId,
          location: { _: "inputDocumentFileLocation", id: String(media.id), access_hash: accessHash,
            file_reference: fileReference, thumb_size: "" },
          size: Number(media.size), mimeType: original.mimeType, fileName: original.filename
        }))}`, location.href).href;
        if (stream.length > 16384 || !/^https:\/\/web\.telegram\.org\/k\/stream\/[^/#]+$/i.test(stream)) {
          throw new Error("Telegram did not expose a safe original-file stream.");
        }
        return { url: stream, mimeType: original.mimeType };
      }
      if (!downloads || typeof downloads.downloadMediaURL !== "function") throw new Error("Telegram's original-file downloader is unavailable.");
      const pending = downloads.downloadMediaURL({ media: original.media, thumb: original.thumb });
      let timer;
      try {
        const url = await Promise.race([pending, new Promise((_, reject) => {
          timer = setTimeout(() => { reject(new Error("Telegram original-file loading timed out.")); }, 60000);
        })]);
        if (location.href !== pageUrl) throw new Error("The Telegram chat changed while loading media.");
        if (typeof url !== "string" || !/^blob:https:\/\/web\.telegram\.org\/[a-z0-9-]+$/i.test(url)) {
          throw new Error("Telegram did not expose a complete original file.");
        }
        return { url, mimeType: original.mimeType };
      } finally { clearTimeout(timer); }
    }
    let payload = 0;
    const seen = new Set();
    let lockedPaidMedia = 0;
    const selector = ".bubble[data-mid], .grouped-item[data-mid], .document-container[data-mid]";
    let nodes = document.querySelectorAll(selector);
    if (options.targetUrl) {
      const target = Array.from(document.querySelectorAll("img, video")).slice(0, 2000)
        .find((element) => (element.currentSrc || element.src) === options.targetUrl);
      const messageNode = target && target.closest(selector);
      nodes = messageNode ? [messageNode] : [];
    }
    for (const node of Array.from(nodes).slice(0, 500)) {
      const peerNode = node.closest("[data-peer-id]");
      const peer = peerNode && peerNode.getAttribute("data-peer-id");
      const mid = node.getAttribute("data-mid");
      if (!/^-?\d{1,20}$/.test(peer) || !/^\d{1,20}$/.test(mid) || seen.has(`${peer}:${mid}`)) continue;
      seen.add(`${peer}:${mid}`);
      const messageMedia = mediaCandidates(peer, mid);
      lockedPaidMedia += messageMedia.locked;
      for (const candidate of messageMedia.candidates) try {
        const original = details(candidate);
        if (!original) continue;
        const reference = new URL("https://web.telegram.org/k/");
        reference.search = new URLSearchParams({ anydownload_telegram: "1", peer, mid,
          id: String(original.media.id), kind: original.kind }).toString();
        let previewUrl = "";
        try {
          const image = node.querySelector("img.media-photo:not(.thumbnail), .document-thumb img, video");
          const width = image && (image.videoWidth || image.naturalWidth);
          const height = image && (image.videoHeight || image.naturalHeight);
          if (width && height) {
            const canvas = document.createElement("canvas");
            const scale = Math.min(1, 240 / Math.max(width, height));
            canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
            canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
            const data = canvas.toDataURL("image/jpeg", 0.7);
            if (data.length <= 50000) previewUrl = data;
          }
        } catch (_error) { /* Unloaded thumbnails do not change the original. */ }
        if (payload + reference.href.length + previewUrl.length > 1800000) previewUrl = "";
        payload += reference.href.length + previewUrl.length;
        if (payload > 1900000 || result.images.length >= 300) break;
        result.images.push({ url: reference.href, previewUrl, filename: original.filename,
          width: original.width, height: original.height, duration: original.duration,
          mimeType: original.mimeType, mediaType: original.kind === "video" ? "video" : "image",
          sourceProvider: "telegram", identityKey: `telegram:${peer}:${mid}:${original.media.id}`,
          kinds: [original.paid
            ? original.kind === "photo" ? "Telegram Stars original photo" : "Telegram Stars original file"
            : original.kind === "photo" ? "Telegram original photo" : "Telegram original file"] });
      } catch (error) {
        if (result.warnings.length < 4) result.warnings.push(String(error.message || error).slice(0, 300));
      }
    }
    if (lockedPaidMedia) result.warnings.push(
      `${lockedPaidMedia.toLocaleString()} Telegram Stars item${lockedPaidMedia === 1 ? " is" : "s are"} still locked and cannot be downloaded.`
    );
    result.warnings.push("Telegram originals: scan covers loaded messages only (up to 300 files). Keep this chat open for previews and downloads. Original files load on demand, with a 64 MiB per-file limit.");
    return result;
  }

  // Serialized into MAIN: Firefox's extension fetch cannot use Telegram's SW.
  // No Telegram account state or internal APIs are read.
  async function readChunk(url, expectedPage, offset) {
    const maximum = 64 * 1024 * 1024;
    const chunkSize = 256 * 1024;
    if (location.href !== expectedPage ||
      !/^https:\/\/web\.telegram\.org\/(?:k|a)\//i.test(location.href) ||
      typeof url !== "string" || url.length > 16384 ||
      !(/^blob:https:\/\/web\.telegram\.org\/[a-z0-9-]+$/i.test(url) ||
        /^https:\/\/web\.telegram\.org\/(?:k|a)\/stream\/[^/#]+$/i.test(url)) ||
      !Number.isSafeInteger(offset) || offset < 0 || offset >= maximum) {
      throw new Error("The Telegram source changed. Return to the chat and rescan.");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, {
        headers: { Range: `bytes=${offset}-${offset + chunkSize - 1}` },
        credentials: "same-origin", redirect: "error", signal: controller.signal
      });
      if (!response.ok || !response.body) throw new Error("Telegram media expired or is not a complete file. Open it and rescan.");
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("content-range") || "");
      const total = range ? Number(range[3]) : Number(response.headers.get("content-length"));
      const length = range ? Number(range[2]) - Number(range[1]) + 1 : total;
      if (!Number.isSafeInteger(total) || total <= 0 || total > maximum) {
        throw new Error("Telegram media has an unknown size or exceeds the 64 MiB limit.");
      }
      if ((range && (response.status !== 206 || Number(range[1]) !== offset || length <= 0 ||
          length > chunkSize || Number(range[2]) >= total)) ||
        (!range && (response.status !== 200 || offset !== 0 || total > chunkSize))) {
        throw new Error("Telegram did not return the requested file range.");
      }
      const reader = response.body.getReader();
      const parts = [];
      let received = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          received += next.value.length;
          if (received > length || received > chunkSize) throw new Error("Telegram response exceeded its byte limit.");
          parts.push(next.value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      if (received !== length || !received) throw new Error("Telegram returned an incomplete file range.");
      let binary = "";
      for (const part of parts) {
        for (let i = 0; i < part.length; i += 8192) {
          binary += String.fromCharCode(...part.subarray(i, i + 8192));
        }
      }
      return { data: btoa(binary), total, type: String(response.headers.get("content-type") || "").slice(0, 100) };
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  async function transfer(api, task, incognito, validateBlob, signal) {
    const checkCancelled = () => { if (signal && signal.aborted) throw new Error("Telegram preview cancelled."); };
    checkCancelled();
    if (!/^https:\/\/web\.telegram\.org\/(?:k|a)\//i.test(task.source || "")) {
      throw new Error("Telegram downloads require their original chat. Rescan the open Telegram tab.");
    }
    const tabs = await api.tabs.query({ url: "https://web.telegram.org/*" });
    const candidates = tabs.filter((tab) => tab.url === task.source && Boolean(tab.incognito) === Boolean(incognito));
    if (candidates.length !== 1) throw new Error("Keep exactly one source Telegram tab open in the original chat and rescan.");
    const tabId = candidates[0].id;
    let sourceUrl = task.url;
    if (isReference(sourceUrl)) {
      const resolved = await api.scripting.executeScript({ target: { tabId }, world: "MAIN",
        func: pageMedia, args: [{ resolve: sourceUrl, expectedPage: task.source }] });
      const value = resolved && resolved[0] && resolved[0].result;
      if (!value || !isMediaUrl(value.url)) throw new Error("Telegram original-file resolution failed.");
      sourceUrl = value.url;
    }
    sourceUrl = repairDocumentUrl(sourceUrl, task);
    checkCancelled();
    const parts = [];
    let offset = 0;
    let total = 0;
    let type = "";
    const deadline = Date.now() + 120000;
    do {
      checkCancelled();
      if (Date.now() > deadline) throw new Error("Telegram transfer timed out. Open the media and retry.");
      const current = await api.tabs.get(tabId);
      if (current.url !== task.source || Boolean(current.incognito) !== Boolean(incognito)) {
        throw new Error("The Telegram source tab changed. Rescan the original chat.");
      }
      const results = await api.scripting.executeScript({
        target: { tabId }, world: "MAIN", func: readChunk, args: [sourceUrl, task.source, offset]
      });
      const result = results && results[0] && results[0].result;
      if (!result || typeof result.data !== "string" || result.data.length > Math.ceil(CHUNK_BYTES / 3) * 4 ||
        !Number.isSafeInteger(result.total) || result.total <= 0 || result.total > MAX_BYTES ||
        (total && total !== result.total)) throw new Error("Invalid Telegram file response.");
      const binary = atob(result.data);
      if (!binary.length || binary.length > CHUNK_BYTES || offset + binary.length > result.total) {
        throw new Error("Invalid Telegram file range.");
      }
      parts.push(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
      total = result.total;
      type = type || result.type;
      offset += binary.length;
    } while (offset < total);
    checkCancelled();
    const mediaType = task.mediaType === "video" ||
      /\.(?:mp4|m4v|mov|webm|mkv|ogv)$/i.test(String(task.filename || "")) ||
      (!task.mediaType && /^video\//i.test(type)) ? "video" : "image";
    return validateBlob(new Blob(parts, { type }), mediaType, task.filename);
  }

  const api = { isMediaUrl: (value) => isMediaUrl(value) || isReference(value), isReference,
    repairDocumentUrl, pageMedia, readChunk, transfer };
  root.AnyDownloadTelegram = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(globalThis);
