(function attachAnyDownloadFapFolder(root) {
  "use strict";

  const HOSTS = new Set(["fapfolder.club", "www.fapfolder.club"]);

  function routeForUrl(rawUrl) {
    try {
      const parsed = new URL(String(rawUrl || ""));
      const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
      if (parsed.protocol !== "https:" || !HOSTS.has(hostname)) {
        return null;
      }
      const segments = parsed.pathname.split("/").filter(Boolean);
      if (
        segments.length === 3 &&
        segments[0].toLowerCase() === "groups" &&
        segments[2].toLowerCase() === "videos" &&
        /^[a-z0-9._-]{1,160}$/i.test(segments[1])
      ) {
        return { kind: "group-videos", id: segments[1].toLowerCase() };
      }
      if (
        segments.length === 2 &&
        segments[0].toLowerCase() === "posts" &&
        /^[a-z0-9_-]{1,160}$/i.test(segments[1])
      ) {
        return { kind: "post", id: segments[1].toLowerCase() };
      }
    } catch (_error) {
      // Unsupported URLs do not receive site-specific collection.
    }
    return null;
  }

  function isSupportedUrl(rawUrl) {
    return Boolean(routeForUrl(rawUrl));
  }

  function routeKeyForUrl(rawUrl) {
    const route = routeForUrl(rawUrl);
    return route ? `fapfolder:${route.kind}:${route.id}` : "";
  }

  // Firefox serializes this function for browser.scripting.executeScript().
  // Keep every helper it needs inside the function body.
  async function collectFromPage(rawOptions) {
    "use strict";

    const options = rawOptions && typeof rawOptions === "object" ? rawOptions : {};

    function boundedInteger(value, fallback, minimum, maximum) {
      const number = Number(value);
      if (!Number.isFinite(number)) {
        return fallback;
      }
      return Math.min(maximum, Math.max(minimum, Math.floor(number)));
    }

    const settings = {
      maxItems: boundedInteger(options.maxItems, 500, 1, 1500),
      maxPosts: boundedInteger(options.maxPosts, 48, 1, 128),
      maxConcurrency: boundedInteger(options.maxConcurrency, 3, 1, 6),
      maxDocumentBytes: boundedInteger(options.maxDocumentBytes, 2000000, 16384, 4000000),
      maxTotalDocumentBytes: boundedInteger(
        options.maxTotalDocumentBytes,
        16000000,
        16384,
        32000000
      ),
      maxPayloadLength: boundedInteger(options.maxPayloadLength, 2000000, 1024, 2000000),
      requestTimeoutMs: boundedInteger(options.requestTimeoutMs, 8000, 1000, 15000),
      successCacheTtlMs: boundedInteger(options.successCacheTtlMs, 300000, 0, 600000),
      emptyCacheTtlMs: boundedInteger(options.emptyCacheTtlMs, 30000, 0, 120000)
    };
    const supportedHosts = new Set(["fapfolder.club", "www.fapfolder.club"]);
    const supportedVideoExtensions = new Set(["m4v", "mkv", "mov", "mp4", "ogg", "ogv", "webm"]);
    const videoMimeExtensions = new Map([
      ["application/mp4", "mp4"],
      ["application/ogg", "ogv"],
      ["application/webm", "webm"],
      ["application/x-matroska", "mkv"],
      ["video/m4v", "m4v"],
      ["video/mp4", "mp4"],
      ["video/ogg", "ogv"],
      ["video/quicktime", "mov"],
      ["video/webm", "webm"],
      ["video/x-m4v", "m4v"],
      ["video/x-matroska", "mkv"]
    ]);
    const pageUrl = String(
      options.pageUrl ||
      (typeof location === "object" && location && location.href) ||
      ""
    ).slice(0, 16384);
    const pageDocument = typeof document === "object" && document ? document : null;
    const pageTitle = String(
      options.pageTitle || pageDocument && pageDocument.title || "FapFolder"
    ).slice(0, 300);
    const warnings = new Set();
    const found = new Map();
    let payloadLength = 0;
    let totalDocumentBytes = 0;
    let itemLimitReached = false;
    let payloadLimitReached = false;
    let documentLimitReached = false;
    let responseLimitReached = false;

    function supportedRoute(rawUrl) {
      try {
        const parsed = new URL(String(rawUrl || ""));
        const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
        if (parsed.protocol !== "https:" || !supportedHosts.has(hostname)) {
          return null;
        }
        const segments = parsed.pathname.split("/").filter(Boolean);
        if (
          segments.length === 3 &&
          segments[0].toLowerCase() === "groups" &&
          segments[2].toLowerCase() === "videos" &&
          /^[a-z0-9._-]{1,160}$/i.test(segments[1])
        ) {
          return { kind: "group-videos", id: segments[1].toLowerCase() };
        }
        if (
          segments.length === 2 &&
          segments[0].toLowerCase() === "posts" &&
          /^[a-z0-9_-]{1,160}$/i.test(segments[1])
        ) {
          return { kind: "post", id: segments[1].toLowerCase() };
        }
      } catch (_error) {
        return null;
      }
      return null;
    }

    const route = supportedRoute(pageUrl);
    if (!route) {
      return {
        handled: false,
        pageUrl,
        pageTitle,
        embeddedFrameCount: 0,
        images: [],
        warnings: []
      };
    }

    function safeText(value, maximum) {
      if (typeof value !== "string") {
        return "";
      }
      return value.trim().slice(0, maximum || 500);
    }

    function getAttribute(element, name) {
      try {
        return element && typeof element.getAttribute === "function"
          ? safeText(element.getAttribute(name), 16384)
          : "";
      } catch (_error) {
        return "";
      }
    }

    function queryAll(scope, selector) {
      try {
        return scope && typeof scope.querySelectorAll === "function"
          ? Array.from(scope.querySelectorAll(selector))
          : [];
      } catch (_error) {
        return [];
      }
    }

    function queryOne(scope, selector) {
      try {
        return scope && typeof scope.querySelector === "function"
          ? scope.querySelector(selector)
          : null;
      } catch (_error) {
        return null;
      }
    }

    function normalizedHttpUrl(rawUrl, baseUrl) {
      const value = safeText(rawUrl, 16384);
      if (!value) {
        return "";
      }
      try {
        const parsed = new URL(value, baseUrl);
        if (!["http:", "https:"].includes(parsed.protocol)) {
          return "";
        }
        parsed.hash = "";
        return parsed.href.slice(0, 16384);
      } catch (_error) {
        return "";
      }
    }

    function normalizedPostUrl(rawUrl, baseUrl) {
      const normalized = normalizedHttpUrl(rawUrl, baseUrl);
      if (!normalized) {
        return "";
      }
      const parsedRoute = supportedRoute(normalized);
      return parsedRoute && parsedRoute.kind === "post" ? normalized : "";
    }

    function extensionFromUrl(rawUrl) {
      try {
        const match = new URL(rawUrl).pathname.match(/\.([a-z0-9]{2,5})$/i);
        const extension = match ? match[1].toLowerCase() : "";
        return supportedVideoExtensions.has(extension) ? extension : "";
      } catch (_error) {
        return "";
      }
    }

    function videoMimeType(rawType, rawUrl) {
      const normalizedType = safeText(rawType, 100).split(";", 1)[0].toLowerCase();
      if (videoMimeExtensions.has(normalizedType)) {
        return normalizedType;
      }
      const extension = extensionFromUrl(rawUrl);
      if (extension === "mp4") {
        return "video/mp4";
      }
      if (extension === "webm") {
        return "video/webm";
      }
      if (["ogg", "ogv"].includes(extension)) {
        return "video/ogg";
      }
      if (extension === "mov") {
        return "video/quicktime";
      }
      if (extension === "m4v") {
        return "video/x-m4v";
      }
      if (extension === "mkv") {
        return "video/x-matroska";
      }
      return "video/mp4";
    }

    function normalizedVideoUrl(rawUrl, baseUrl, declaredType) {
      const normalized = normalizedHttpUrl(rawUrl, baseUrl);
      if (!normalized) {
        return "";
      }
      const mimeType = safeText(declaredType, 100).split(";", 1)[0].toLowerCase();
      if (/mpegurl|dash\+xml/.test(mimeType)) {
        return "";
      }
      try {
        if (/\.(?:m3u8|mpd)$/i.test(new URL(normalized).pathname)) {
          return "";
        }
      } catch (_error) {
        return "";
      }
      return normalized;
    }

    function positiveNumber(value) {
      const number = Number(value);
      return Number.isFinite(number) && number > 0 ? number : 0;
    }

    function documentTitle(doc) {
      const meta = queryOne(doc, 'meta[property="og:title"], meta[name="twitter:title"]');
      return safeText(getAttribute(meta, "content") || doc && doc.title, 500);
    }

    function documentNeedsLogin(doc) {
      const bodyText = safeText(doc && doc.body && doc.body.textContent, 20000).toLowerCase();
      return /must log in to watch|please log in to watch|login to watch/.test(bodyText);
    }

    function closestVideo(element) {
      try {
        return element && typeof element.closest === "function" ? element.closest("video") : null;
      } catch (_error) {
        return null;
      }
    }

    function extractVideos(doc, baseUrl, postUrl, fallbackPreview, fallbackTitle) {
      const extracted = [];
      const seen = new Set();
      const title = documentTitle(doc) || safeText(fallbackTitle, 500) || "FapFolder video";
      const candidates = queryAll(
        doc,
        "video[src], video source[src], .vid-placeholder[data-src], [data-video-src], [data-video-url]"
      ).slice(0, 128);

      for (const candidate of candidates) {
        const tagName = String(candidate && (candidate.localName || candidate.tagName) || "")
          .toLowerCase();
        const ownerVideo = tagName === "source" ? closestVideo(candidate) : tagName === "video" ? candidate : null;
        const declaredType = getAttribute(candidate, "type") || getAttribute(ownerVideo, "type");
        const rawUrl = tagName === "source"
          ? getAttribute(candidate, "src") || safeText(candidate && candidate.src, 16384)
          : tagName === "video"
            ? safeText(candidate && candidate.currentSrc, 16384) ||
              getAttribute(candidate, "src") ||
              safeText(candidate && candidate.src, 16384)
            : getAttribute(candidate, "data-src") ||
              getAttribute(candidate, "data-video-src") ||
              getAttribute(candidate, "data-video-url");
        const url = normalizedVideoUrl(rawUrl, baseUrl, declaredType);
        if (!url || seen.has(url)) {
          continue;
        }
        seen.add(url);
        const poster = normalizedHttpUrl(
          getAttribute(ownerVideo, "poster") ||
          safeText(ownerVideo && ownerVideo.poster, 16384) ||
          getAttribute(candidate, "poster") ||
          getAttribute(candidate, "data-poster") ||
          fallbackPreview,
          baseUrl
        );
        const width = positiveNumber(
          ownerVideo && ownerVideo.videoWidth ||
          getAttribute(ownerVideo, "width") ||
          getAttribute(candidate, "width") ||
          getAttribute(candidate, "data-width")
        );
        const height = positiveNumber(
          ownerVideo && ownerVideo.videoHeight ||
          getAttribute(ownerVideo, "height") ||
          getAttribute(candidate, "height") ||
          getAttribute(candidate, "data-height")
        );
        const duration = positiveNumber(
          ownerVideo && ownerVideo.duration ||
          getAttribute(candidate, "data-length") ||
          getAttribute(candidate, "data-duration")
        );
        extracted.push({
          url,
          previewUrl: poster,
          filename: safeText(
            getAttribute(candidate, "download") || getAttribute(candidate, "data-filename"),
            500
          ),
          alt: title,
          width,
          height,
          duration,
          mimeType: videoMimeType(declaredType, url),
          mediaType: "video",
          kinds: [tagName === "video" || tagName === "source"
            ? "FapFolder post video"
            : "FapFolder lazy post video"],
          sourceProvider: "fapfolder",
          sourcePostUrl: safeText(postUrl || baseUrl, 16384)
        });
      }
      return extracted;
    }

    function addVideo(video) {
      if (!video || !video.url || found.has(video.url)) {
        return;
      }
      if (found.size >= settings.maxItems) {
        itemLimitReached = true;
        return;
      }
      const addedLength = video.url.length + String(video.previewUrl || "").length;
      if (payloadLength + addedLength > settings.maxPayloadLength) {
        payloadLimitReached = true;
        return;
      }
      payloadLength += addedLength;
      found.set(video.url, video);
    }

    function previewForAnchor(anchor, baseUrl) {
      const image = queryOne(anchor, "img");
      const imageUrl = normalizedHttpUrl(
        safeText(image && image.currentSrc, 16384) ||
        getAttribute(image, "src") ||
        getAttribute(image, "data-src"),
        baseUrl
      );
      if (imageUrl) {
        return imageUrl;
      }
      const styled = queryOne(anchor, '[style*="background-image"]');
      const style = getAttribute(styled, "style");
      const match = style.match(/background-image\s*:\s*url\(\s*(["']?)(.*?)\1\s*\)/i);
      return match ? normalizedHttpUrl(match[2], baseUrl) : "";
    }

    function postDescriptors(doc, baseUrl) {
      const descriptors = [];
      const seen = new Set();
      const anchors = queryAll(doc, 'a.pg_video[href], a[href*="/posts/"]');
      for (const anchor of anchors) {
        const url = normalizedPostUrl(
          getAttribute(anchor, "href") || safeText(anchor && anchor.href, 16384),
          baseUrl
        );
        if (!url || seen.has(url)) {
          continue;
        }
        seen.add(url);
        const image = queryOne(anchor, "img");
        descriptors.push({
          url,
          previewUrl: previewForAnchor(anchor, baseUrl),
          title: safeText(
            getAttribute(image, "alt") ||
            getAttribute(anchor, "aria-label") ||
            getAttribute(anchor, "title"),
            500
          )
        });
      }
      return descriptors;
    }

    function reserveDocumentBytes(byteLength) {
      const nextTotal = totalDocumentBytes + byteLength;
      if (nextTotal > settings.maxTotalDocumentBytes) {
        responseLimitReached = true;
        const error = new Error("The combined FapFolder post response limit was reached.");
        error.code = "TOTAL_LIMIT";
        throw error;
      }
      totalDocumentBytes = nextTotal;
    }

    async function boundedResponseText(response) {
      const declaredLength = Number(response && response.headers && response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > settings.maxDocumentBytes) {
        responseLimitReached = true;
        const error = new Error("A FapFolder post response exceeded its size limit.");
        error.code = "DOCUMENT_LIMIT";
        throw error;
      }
      if (response && response.body && typeof response.body.getReader === "function") {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let text = "";
        let documentBytes = 0;
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) {
            break;
          }
          const value = chunk.value instanceof Uint8Array ? chunk.value : new Uint8Array(chunk.value || []);
          documentBytes += value.byteLength;
          if (documentBytes > settings.maxDocumentBytes) {
            responseLimitReached = true;
            await reader.cancel().catch(() => undefined);
            const error = new Error("A FapFolder post response exceeded its size limit.");
            error.code = "DOCUMENT_LIMIT";
            throw error;
          }
          reserveDocumentBytes(value.byteLength);
          text += decoder.decode(value, { stream: true });
        }
        return `${text}${decoder.decode()}`;
      }
      const text = await response.text();
      const bytes = typeof TextEncoder === "function"
        ? new TextEncoder().encode(text).byteLength
        : text.length * 2;
      if (bytes > settings.maxDocumentBytes) {
        responseLimitReached = true;
        const error = new Error("A FapFolder post response exceeded its size limit.");
        error.code = "DOCUMENT_LIMIT";
        throw error;
      }
      reserveDocumentBytes(bytes);
      return text;
    }

    function cacheForPage() {
      if (!settings.successCacheTtlMs && !settings.emptyCacheTtlMs) {
        return null;
      }
      try {
        const key = "__anyDownloadFapFolderPostCacheV1";
        if (!(globalThis[key] instanceof Map)) {
          globalThis[key] = new Map();
        }
        return globalThis[key];
      } catch (_error) {
        return null;
      }
    }

    const cache = cacheForPage();

    function cachedPost(descriptor) {
      if (!cache) {
        return null;
      }
      const cached = cache.get(descriptor.url);
      if (!cached || Date.now() - cached.createdAt > cached.ttlMs) {
        cache.delete(descriptor.url);
        return null;
      }
      return {
        images: cached.images.map((image) => Object.assign({}, image, {
          previewUrl: image.previewUrl || descriptor.previewUrl,
          alt: image.alt || descriptor.title
        })),
        loginRequired: cached.loginRequired,
        failed: false,
        cached: true
      };
    }

    function storeCachedPost(descriptor, result) {
      if (!cache || result.failed) {
        return;
      }
      const ttlMs = result.images.length
        ? settings.successCacheTtlMs
        : settings.emptyCacheTtlMs;
      if (!ttlMs) {
        return;
      }
      cache.set(descriptor.url, {
        createdAt: Date.now(),
        ttlMs,
        images: result.images.map((image) => Object.assign({}, image)),
        loginRequired: result.loginRequired
      });
      while (cache.size > 128) {
        cache.delete(cache.keys().next().value);
      }
    }

    async function collectPost(descriptor) {
      const cached = cachedPost(descriptor);
      if (cached) {
        return cached;
      }
      if (typeof fetch !== "function" || typeof DOMParser !== "function") {
        return { images: [], loginRequired: false, failed: true };
      }
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      const timer = controller
        ? setTimeout(() => controller.abort(), settings.requestTimeoutMs)
        : null;
      try {
        const response = await fetch(descriptor.url, {
          method: "GET",
          credentials: "include",
          redirect: "follow",
          headers: { Accept: "text/html,application/xhtml+xml" },
          signal: controller ? controller.signal : undefined
        });
        if (!response || !response.ok) {
          return { images: [], loginRequired: response && response.status === 401, failed: true };
        }
        const finalUrl = normalizedPostUrl(response.url || descriptor.url, descriptor.url);
        if (!finalUrl) {
          return { images: [], loginRequired: false, failed: true };
        }
        const contentType = safeText(response.headers && response.headers.get("content-type"), 100)
          .toLowerCase();
        if (contentType && !/(?:text\/html|application\/xhtml\+xml)/.test(contentType)) {
          return { images: [], loginRequired: false, failed: true };
        }
        const html = await boundedResponseText(response);
        const doc = new DOMParser().parseFromString(html, "text/html");
        const result = {
          images: extractVideos(
            doc,
            finalUrl,
            descriptor.url,
            descriptor.previewUrl,
            descriptor.title
          ),
          loginRequired: documentNeedsLogin(doc),
          failed: false,
          cached: false
        };
        storeCachedPost(descriptor, result);
        return result;
      } catch (_error) {
        return { images: [], loginRequired: false, failed: true };
      } finally {
        if (timer !== null) {
          clearTimeout(timer);
        }
      }
    }

    if (route.kind === "post") {
      const videos = extractVideos(pageDocument, pageUrl, pageUrl, "", pageTitle);
      for (const video of videos) {
        addVideo(video);
      }
      if (!found.size) {
        if (documentNeedsLogin(pageDocument)) {
          warnings.add("Sign in to FapFolder in this tab to expose the post's direct video file, then scan again.");
        } else {
          warnings.add("This FapFolder post did not expose a directly downloadable video file.");
        }
      }
    } else {
      const allPosts = postDescriptors(pageDocument, pageUrl);
      if (allPosts.length > settings.maxPosts) {
        documentLimitReached = true;
      }
      const posts = allPosts.slice(0, settings.maxPosts);
      const results = new Array(posts.length);
      let cursor = 0;

      async function worker() {
        while (cursor < posts.length) {
          const index = cursor;
          cursor += 1;
          results[index] = await collectPost(posts[index]);
        }
      }

      await Promise.all(Array.from(
        { length: Math.min(settings.maxConcurrency, posts.length) },
        () => worker()
      ));

      let failedPosts = 0;
      let loginRequiredPosts = 0;
      let emptyPosts = 0;
      for (const result of results) {
        if (!result || result.failed) {
          failedPosts += 1;
          continue;
        }
        if (result.loginRequired) {
          loginRequiredPosts += 1;
        } else if (!result.images.length) {
          emptyPosts += 1;
        }
        for (const video of result.images) {
          addVideo(video);
        }
      }

      if (!posts.length) {
        warnings.add("No FapFolder video-post links are currently loaded on this group page.");
      }
      if (loginRequiredPosts) {
        warnings.add(
          `${loginRequiredPosts.toLocaleString()} FapFolder post${loginRequiredPosts === 1 ? " requires" : "s require"} login before its video is exposed. Sign in in the source tab and scan again.`
        );
      }
      if (failedPosts) {
        warnings.add(
          `${failedPosts.toLocaleString()} FapFolder post${failedPosts === 1 ? " could" : "s could"} not be inspected with the current browser session.`
        );
      }
      if (emptyPosts) {
        warnings.add(
          `${emptyPosts.toLocaleString()} FapFolder post${emptyPosts === 1 ? " did" : "s did"} not expose a direct video file.`
        );
      }
      if (!found.size && posts.length && !warnings.size) {
        warnings.add("The loaded FapFolder posts did not expose directly downloadable video files.");
      }
    }

    if (documentLimitReached) {
      warnings.add(`FapFolder collection inspected only the first ${settings.maxPosts.toLocaleString()} loaded posts.`);
    }
    if (responseLimitReached) {
      warnings.add("FapFolder post inspection reached its bounded response-size limit; results may be partial.");
    }
    if (itemLimitReached) {
      warnings.add(`FapFolder collection reached the ${settings.maxItems.toLocaleString()}-item safety limit.`);
    }
    if (payloadLimitReached) {
      warnings.add("Some FapFolder videos were skipped because their combined URL data exceeded the 2 MB safety limit.");
    }

    return {
      handled: true,
      pageUrl,
      pageTitle,
      embeddedFrameCount: 0,
      images: Array.from(found.values()),
      warnings: Array.from(warnings).slice(0, 12)
    };
  }

  const api = Object.freeze({
    collectFromPage,
    isSupportedUrl,
    routeKeyForUrl
  });
  root.AnyDownloadFapFolder = api;
  root.AnyDownloadFapFolderCollector = collectFromPage;
  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
  }
})(typeof globalThis === "object" ? globalThis : this);
