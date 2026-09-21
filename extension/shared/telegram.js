(function attachTelegram(root) {
  "use strict";
  const MAX_BYTES = 64 * 1024 * 1024;
  const CHUNK_BYTES = 256 * 1024;

  function isMediaUrl(value) {
    return typeof value === "string" && value.length <= 16384 &&
      (/^blob:https:\/\/web\.telegram\.org\/[a-z0-9-]+$/i.test(value) ||
       /^https:\/\/web\.telegram\.org\/(?:k|a)\/stream\/[^/#]+$/i.test(value));
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

  async function transfer(api, task, incognito, validateBlob) {
    if (!/^https:\/\/web\.telegram\.org\/(?:k|a)\//i.test(task.source || "")) {
      throw new Error("Telegram downloads require their original chat. Rescan the open Telegram tab.");
    }
    const tabs = await api.tabs.query({ url: "https://web.telegram.org/*" });
    const candidates = tabs.filter((tab) => tab.url === task.source && Boolean(tab.incognito) === Boolean(incognito));
    if (candidates.length !== 1) throw new Error("Keep exactly one source Telegram tab open in the original chat and rescan.");
    const tabId = candidates[0].id;
    const parts = [];
    let offset = 0;
    let total = 0;
    let type = "";
    const deadline = Date.now() + 120000;
    do {
      if (Date.now() > deadline) throw new Error("Telegram transfer timed out. Open the media and retry.");
      const current = await api.tabs.get(tabId);
      if (current.url !== task.source || Boolean(current.incognito) !== Boolean(incognito)) {
        throw new Error("The Telegram source tab changed. Rescan the original chat.");
      }
      const results = await api.scripting.executeScript({
        target: { tabId }, world: "MAIN", func: readChunk, args: [task.url, task.source, offset]
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
    return validateBlob(new Blob(parts, { type }), task.mediaType || "image", task.filename);
  }

  const api = { isMediaUrl, readChunk, transfer };
  root.AnyDownloadTelegram = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(globalThis);
