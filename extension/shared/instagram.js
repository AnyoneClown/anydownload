(function attachImageDownloaderInstagram(root) {
  "use strict";

  function isInstagramUrl(value) {
    try {
      const parsed = new URL(String(value || ""));
      const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
      return ["http:", "https:"].includes(parsed.protocol) &&
        ["instagram.com", "www.instagram.com", "m.instagram.com"].includes(hostname);
    } catch (_error) {
      return false;
    }
  }

  function routeKeyForUrl(value) {
    if (!isInstagramUrl(value)) {
      return "";
    }
    try {
      const parsed = new URL(String(value || ""));
      let segments;
      try {
        segments = parsed.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      } catch (_error) {
        segments = parsed.pathname.split("/").filter(Boolean);
      }
      const first = String(segments[0] || "").toLowerCase();
      const directKind = ["p", "reel", "reels", "tv"].includes(first) ? first : "";
      if (directKind && /^[a-z0-9_-]{3,80}$/i.test(segments[1] || "")) {
        const kind = directKind === "reel" || directKind === "reels" ? "reel" : "post";
        return `instagram:${kind}:${segments[1]}`;
      }
      const reserved = new Set([
        "", "about", "accounts", "api", "challenge", "developer", "direct", "directory",
        "emails", "explore", "legal", "p", "press", "privacy", "reel", "reels",
        "static", "stories", "terms", "tv", "web"
      ]);
      const prefixedKind = ["p", "reel", "reels", "tv"].includes(
        String(segments[1] || "").toLowerCase()
      ) ? String(segments[1]).toLowerCase() : "";
      if (/^[a-z0-9._]{1,80}$/i.test(segments[0] || "") && !reserved.has(first) && prefixedKind &&
        /^[a-z0-9_-]{3,80}$/i.test(segments[2] || "")) {
        const kind = prefixedKind === "reel" || prefixedKind === "reels" ? "reel" : "post";
        return `instagram:${kind}:${segments[2]}`;
      }
      if (first === "stories" && String(segments[1] || "").toLowerCase() === "highlights" &&
        /^[a-z0-9:_-]{2,100}$/i.test(segments[2] || "")) {
        const id = String(segments[2]).replace(/^highlight:/i, "");
        return id ? `instagram:highlight:${id}` : "";
      }
      if (first === "stories" && /^[a-z0-9._]{1,80}$/i.test(segments[1] || "")) {
        const username = String(segments[1]).toLowerCase();
        const id = String(segments[2] || "")
          .replace(/^highlight:/i, "");
        return `instagram:story:${username}${id ? `:${id}` : ""}`;
      }
      if (segments.length === 1 && /^[a-z0-9._]{1,80}$/i.test(segments[0] || "") &&
        !reserved.has(first)) {
        return `instagram:profile:${first}`;
      }
    } catch (_error) {
      // Unsupported routes do not receive a live-collection scope key.
    }
    return "";
  }

  function canCollectRelated(value) {
    return routeKeyForUrl(value).startsWith("instagram:profile:");
  }

  // This function is passed directly to browser.scripting.executeScript(). Keep
  // every helper inside its body: Firefox serializes the function and does not
  // carry this module's outer closure into the source tab.
  async function collectFromPage(rawOptions) {
    "use strict";

    const options = rawOptions && typeof rawOptions === "object" ? rawOptions : {};

    function boundedInteger(value, fallback, minimum, maximum) {
      const number = Number(value);
      if (!Number.isSafeInteger(number)) {
        return fallback;
      }
      return Math.min(maximum, Math.max(minimum, number));
    }

    const settings = {
      includeProfilePosts: options.includeProfilePosts !== false,
      includeProfileReels: options.includeProfileReels !== false,
      includeStories: options.includeStories === true || options.includeRelated === true,
      includeHighlights: options.includeHighlights === true || options.includeRelated === true,
      maxItems: boundedInteger(options.maxItems, 500, 1, 1500),
      maxDocuments: boundedInteger(options.maxDocuments, 16, 1, 32),
      maxDocumentBytes: boundedInteger(options.maxDocumentBytes, 4000000, 16384, 4000000),
      maxTotalDocumentBytes: boundedInteger(
        options.maxTotalDocumentBytes,
        16000000,
        16384,
        32000000
      ),
      maxPayloadLength: boundedInteger(options.maxPayloadLength, 2000000, 1024, 2000000)
    };
    const MAX_JSON_DEPTH = 48;
    const MAX_JSON_NODES = 180000;
    const MAX_JSON_VALUES_PER_SCRIPT = 128;
    const MAX_SCRIPTS_PER_DOCUMENT = 256;
    const MAX_RELATED_LINKS = 128;
    const FETCH_TIMEOUT_MS = 12000;
    const EXACT_FETCH_TIMEOUT_MS = 5000;
    const INSTAGRAM_WEB_APP_ID = "936619743392459";
    // Instagram rotates persisted GraphQL operation IDs. This is a bounded
    // fallback after the canonical post document and media-info endpoint.
    const INSTAGRAM_POST_QUERY_DOC_ID = "27852811784380813";
    const INSTAGRAM_PROFILE_QUERY_DOC_ID = "7898261790222653";
    const INSTAGRAM_REELS_QUERY_DOC_ID = "7845543455542541";
    const MAX_COLLECTION_MEMBERSHIPS = 16;
    const MAX_FETCH_CONCURRENCY = 3;
    const INSTAGRAM_SCRIPT_MARKER = /["'](?:carousel_media|carouselMedia|contentUrl|content_url|display_resources|display_uri|displayUri|display_url|edge_owner_to_timeline_media|edge_sidecar_to_children|image_url|image_versions2|is_video|media_code|media_type|playback_url|polaris_ordered_timeline_connection|polarisOrderedTimelineConnection|reel_id|reels_media|shortcode|shortcode_media|thumbnailUrl|timeline_media|video_url|video_versions|xdt_[a-z0-9_]+)["']\s*:/i;
    const PROFILE_SCRIPT_MARKER = /["']username["']\s*:/i;
    const childMediaCache = new WeakMap();
    const dimensionCache = new WeakMap();
    const domMediaCache = new WeakMap();
    const exactRouteStatusCache = new WeakMap();
    const ownerCache = new WeakMap();
    const warnings = new Set();
    const found = new Map();
    const foundRecordKeysByUrl = new Map();
    const owners = new Set();
    const profilePks = new Set();
    const profilePosts = new Map();
    const highlightDescriptors = new Map();
    const visitedDocuments = new Set();
    const queuedDocuments = [];
    const queuedDocumentUrls = new Set();
    let totalPayloadLength = 0;
    let totalDocumentBytes = 0;
    let fetchedDocumentCount = 0;
    let jsonNodeLimitReached = false;
    let itemLimitReached = false;
    let payloadLimitReached = false;
    let documentLimitReached = false;
    let unsupportedVideoCount = 0;
    let needsStoryMetadata = false;
    let inaccessibleRelatedCount = 0;
    let exactStructuredPostComplete = false;
    let profileAnchorCache = null;
    let profileTimelineComplete = false;
    let profileReelsComplete = !settings.includeProfileReels;
    let utf8Encoder = null;
    try {
      utf8Encoder = typeof TextEncoder === "function" ? new TextEncoder() : null;
    } catch (_error) {
      utf8Encoder = null;
    }

    function safeText(value, maximum) {
      let text = "";
      try {
        if (typeof value === "string") {
          text = value;
        } else if (["number", "bigint", "boolean"].includes(typeof value)) {
          text = String(value);
        }
      } catch (_error) {
        text = "";
      }
      return text.slice(0, maximum || 500);
    }

    function safeProperty(object, key) {
      if (!object || (typeof object !== "object" && typeof object !== "function")) {
        return undefined;
      }
      try {
        return object[key];
      } catch (_error) {
        return undefined;
      }
    }

    function positiveNumber(value) {
      const number = Number(value);
      return Number.isFinite(number) && number > 0 && number <= 1000000 ? number : 0;
    }

    function byteLength(value) {
      const text = safeText(value, settings.maxDocumentBytes + 1);
      if (!/[^\x00-\x7f]/.test(text)) {
        return text.length;
      }
      try {
        if (utf8Encoder) {
          return utf8Encoder.encode(text).byteLength;
        }
      } catch (_error) {
        // UTF-16 length is a conservative-enough fallback for bounding page data.
      }
      return text.length;
    }

    async function mapWithConcurrency(values, worker, rawConcurrency) {
      const items = Array.isArray(values) ? values : [];
      const results = new Array(items.length);
      let cursor = 0;

      async function runWorker() {
        while (cursor < items.length) {
          const index = cursor;
          cursor += 1;
          results[index] = await worker(items[index], index);
        }
      }

      const concurrency = Math.min(
        items.length,
        boundedInteger(rawConcurrency, MAX_FETCH_CONCURRENCY, 1, MAX_FETCH_CONCURRENCY)
      );
      await Promise.all(Array.from({ length: concurrency }, () => runWorker()));
      return results;
    }

    function instagramHttpUrl(value, baseUrl) {
      const raw = safeText(value, 16384).trim();
      if (!raw) {
        return "";
      }
      try {
        const parsed = new URL(raw, baseUrl);
        const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
        if (!["http:", "https:"].includes(parsed.protocol)) {
          return "";
        }
        if (!["instagram.com", "www.instagram.com", "m.instagram.com"].includes(hostname)) {
          return "";
        }
        parsed.hash = "";
        return parsed.href;
      } catch (_error) {
        return "";
      }
    }

    function mediaHttpUrl(value, baseUrl, mediaType) {
      const raw = safeText(value, 16384).trim();
      if (!raw || /^(?:blob|data|filesystem):/i.test(raw)) {
        return "";
      }
      try {
        const parsed = new URL(raw, baseUrl);
        if (!["http:", "https:"].includes(parsed.protocol)) {
          return "";
        }
        parsed.hash = "";
        if (mediaType === "video") {
          const pathname = parsed.pathname.toLowerCase();
          const format = safeText(
            parsed.searchParams.get("format") || parsed.searchParams.get("fm"),
            100
          ).toLowerCase();
          if (/\.(?:m3u8|mpd)$/.test(pathname) ||
            /(?:mpegurl|dash|m3u8|mpd)/.test(format)) {
            return "";
          }
        }
        return parsed.href;
      } catch (_error) {
        return "";
      }
    }

    function normalizedIdentifier(value) {
      return safeText(value, 200)
        .trim()
        .replace(/^highlight:/i, "")
        .replace(/_\d+$/, "");
    }

    function parseRoute(value) {
      const page = instagramHttpUrl(value, value);
      if (!page) {
        return { kind: "unsupported", pageUrl: "" };
      }
      let parsed;
      try {
        parsed = new URL(page);
      } catch (_error) {
        return { kind: "unsupported", pageUrl: page };
      }
      let segments;
      try {
        segments = parsed.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      } catch (_error) {
        segments = parsed.pathname.split("/").filter(Boolean);
      }
      const first = safeText(segments[0], 80).toLowerCase();
      if (["p", "reel", "reels", "tv"].includes(first) && /^[a-z0-9_-]{3,80}$/i.test(segments[1] || "")) {
        return {
          kind: first === "p" || first === "tv" ? "post" : "reel",
          shortcode: segments[1],
          pageUrl: page
        };
      }
      const reserved = new Set([
        "", "about", "accounts", "api", "challenge", "developer", "direct", "directory",
        "emails", "explore", "legal", "p", "press", "privacy", "reel", "reels",
        "static", "stories", "terms", "tv", "web"
      ]);
      const prefixedKind = safeText(segments[1], 80).toLowerCase();
      if (/^[a-z0-9._]{1,80}$/i.test(segments[0] || "") &&
        !reserved.has(first) &&
        ["p", "reel", "reels", "tv"].includes(prefixedKind) &&
        /^[a-z0-9_-]{3,80}$/i.test(segments[2] || "")) {
        return {
          kind: prefixedKind === "p" || prefixedKind === "tv" ? "post" : "reel",
          shortcode: segments[2],
          username: segments[0].toLowerCase(),
          pageUrl: page
        };
      }
      if (first === "stories" && safeText(segments[1], 80).toLowerCase() === "highlights" &&
        /^[a-z0-9:_-]{2,100}$/i.test(segments[2] || "")) {
        return {
          kind: "highlight",
          highlightId: normalizedIdentifier(segments[2]),
          pageUrl: page
        };
      }
      if (first === "stories" && /^[a-z0-9._]{1,80}$/i.test(segments[1] || "")) {
        return {
          kind: "story",
          username: segments[1].toLowerCase(),
          storyId: normalizedIdentifier(segments[2] || ""),
          pageUrl: page
        };
      }
      if (segments.length === 1 && /^[a-z0-9._]{1,80}$/i.test(segments[0] || "") &&
        !reserved.has(first)) {
        return { kind: "profile", username: segments[0].toLowerCase(), pageUrl: page };
      }
      return { kind: "unsupported", pageUrl: page };
    }

    let pageUrl = "";
    try {
      pageUrl = safeText(location && location.href, 16384);
    } catch (_error) {
      pageUrl = "";
    }
    const route = parseRoute(pageUrl);
    const routeShortcodeAliases = new Set();
    let queryShortcode = safeText(route.shortcode, 80).trim();
    if (route.kind === "post" || route.kind === "reel") {
      routeShortcodeAliases.add(queryShortcode);
      // New private/share permalinks may append an opaque capability suffix to
      // the conventional 11-character media shortcode. Instagram's structured
      // response and first-party query still identify that post by the prefix.
      if (queryShortcode.length === 39 && /^[a-z0-9_-]{39}$/i.test(queryShortcode)) {
        queryShortcode = queryShortcode.slice(0, 11);
        routeShortcodeAliases.add(queryShortcode);
      }
    }
    function exactShortcodeMatches(value) {
      return routeShortcodeAliases.has(safeText(value, 80).trim());
    }
    function hasCompleteExactCollection(sourceRoute) {
      return exactStructuredPostComplete &&
        ["post", "reel"].includes(sourceRoute && sourceRoute.kind) &&
        exactShortcodeMatches(sourceRoute && sourceRoute.shortcode);
    }
    function mediaIdFromShortcode(shortcode) {
      const value = safeText(shortcode, 80).trim();
      // Conventional Instagram shortcodes encode the numeric media pk in a
      // base64url alphabet. Newer opaque share codes can be much longer and
      // must use the shortcode/HTML fallbacks instead.
      if (!value || value.length > 16 || typeof BigInt !== "function") {
        return "";
      }
      const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
      let mediaId = BigInt(0);
      try {
        for (const character of value) {
          const digit = alphabet.indexOf(character);
          if (digit < 0) {
            return "";
          }
          mediaId = mediaId * BigInt(64) + BigInt(digit);
        }
      } catch (_error) {
        return "";
      }
      const normalized = mediaId.toString();
      return /^\d{1,30}$/.test(normalized) ? normalized : "";
    }
    const routeMediaId = (route.kind === "post" || route.kind === "reel")
      ? mediaIdFromShortcode(queryShortcode)
      : "";
    let pageTitle = "Instagram";
    try {
      pageTitle = safeText(document && document.title, 300) || "Instagram";
    } catch (_error) {
      pageTitle = "Instagram";
    }

    const emptyResult = (handled, extraWarnings) => ({
      handled,
      pageUrl: route.pageUrl || pageUrl,
      pageTitle,
      embeddedFrameCount: 0,
      images: [],
      warnings: Array.from(extraWarnings || warnings)
    });

    if (!route.pageUrl) {
      return emptyResult(false);
    }
    try {
      if (typeof window === "object" && window && window.top && window.self !== window.top) {
        return emptyResult(false);
      }
    } catch (_error) {
      return emptyResult(false);
    }
    if (route.kind === "unsupported") {
      return emptyResult(false);
    }

    function usernameFrom(value) {
      const username = safeText(
        safeProperty(value, "username") || safeProperty(value, "user_name") ||
          safeProperty(value, "owner_username"),
        80
      ).trim().toLowerCase();
      return /^[a-z0-9._]{1,80}$/i.test(username) ? username : "";
    }

    function ownerFromObject(object) {
      const cacheable = Boolean(object) &&
        (typeof object === "object" || typeof object === "function");
      if (cacheable && ownerCache.has(object)) {
        return ownerCache.get(object);
      }
      let result = usernameFrom(object);
      if (!result) {
        for (const key of ["owner", "user", "owner_user", "author"]) {
          const owner = safeProperty(object, key);
          const username = usernameFrom(owner) || safeText(safeProperty(owner, "alternateName"), 80)
            .replace(/^@/, "").toLowerCase();
          if (/^[a-z0-9._]{1,80}$/i.test(username)) {
            result = username;
            break;
          }
        }
      }
      if (cacheable) {
        ownerCache.set(object, result);
      }
      return result;
    }

    function matchesExpectedOwner(object, expectedOwner) {
      const expected = safeText(expectedOwner, 80).trim().toLowerCase();
      const actual = ownerFromObject(object);
      return !expected || !actual || actual === expected;
    }

    function normalizedProfilePk(value) {
      const pk = safeText(value, 80).trim();
      return /^\d{1,40}$/.test(pk) ? pk : "";
    }

    function profilePkFromObject(object) {
      return normalizedProfilePk(
        safeProperty(object, "pk") || safeProperty(object, "user_id") ||
          safeProperty(object, "userId") || safeProperty(object, "userID") ||
          safeProperty(object, "id")
      );
    }

    function registerMatchingProfile(object, expectedUsername) {
      const username = usernameFrom(object);
      if (!username || username !== safeText(expectedUsername, 80).toLowerCase()) {
        return "";
      }
      const pk = profilePkFromObject(object);
      if (pk) {
        profilePks.add(pk);
        owners.add(username);
      }
      return pk;
    }

    function registerHighlight(rawId, rawTitle, rawOwner) {
      const id = normalizedIdentifier(rawId);
      if (!id || !/^[a-z0-9:_-]{1,100}$/i.test(id)) {
        return;
      }
      const title = safeText(rawTitle, 100).trim();
      const owner = safeText(rawOwner, 80).trim().toLowerCase();
      const existing = highlightDescriptors.get(id);
      if (!existing) {
        if (highlightDescriptors.size >= MAX_RELATED_LINKS) {
          documentLimitReached = true;
          return;
        }
        highlightDescriptors.set(id, {
          id,
          title,
          owner: /^[a-z0-9._]{1,80}$/i.test(owner) ? owner : ""
        });
        return;
      }
      existing.title = existing.title || title;
      if (!existing.owner && /^[a-z0-9._]{1,80}$/i.test(owner)) {
        existing.owner = owner;
      }
    }

    function registerHighlightObject(object, parentKey, expectedOwner) {
      const directId = safeText(
        safeProperty(object, "reel_id") || safeProperty(object, "reelId") ||
          safeProperty(object, "id"),
        200
      );
      const parentId = safeText(parentKey, 200);
      const rawId = /^highlight:/i.test(directId)
        ? directId
        : /^highlight:/i.test(parentId)
          ? parentId
          : "";
      if (!rawId) {
        return;
      }
      const actualOwner = ownerFromObject(object);
      const normalizedExpectedOwner = safeText(expectedOwner, 80).trim().toLowerCase();
      if (actualOwner && normalizedExpectedOwner && actualOwner !== normalizedExpectedOwner) {
        return;
      }
      registerHighlight(
        rawId,
        safeProperty(object, "title") || safeProperty(object, "name"),
        actualOwner || normalizedExpectedOwner
      );
    }

    function dimensionsFrom(object) {
      const cacheable = Boolean(object) &&
        (typeof object === "object" || typeof object === "function");
      if (cacheable && dimensionCache.has(object)) {
        return dimensionCache.get(object);
      }
      const dimensions = safeProperty(object, "dimensions");
      const result = {
        width: positiveNumber(
          safeProperty(object, "width") || safeProperty(object, "original_width") ||
            safeProperty(object, "video_width") || safeProperty(object, "config_width") ||
            safeProperty(object, "candidate_width") || safeProperty(dimensions, "width")
        ),
        height: positiveNumber(
          safeProperty(object, "height") || safeProperty(object, "original_height") ||
            safeProperty(object, "video_height") || safeProperty(object, "config_height") ||
            safeProperty(object, "candidate_height") || safeProperty(dimensions, "height")
        )
      };
      if (cacheable) {
        dimensionCache.set(object, result);
      }
      return result;
    }

    function pushVariant(target, rawUrl, candidate, baseUrl, mediaType, priority) {
      const url = mediaHttpUrl(rawUrl, baseUrl, mediaType);
      if (!url) {
        if (mediaType === "video" && safeText(rawUrl, 16384).trim()) {
          unsupportedVideoCount += 1;
        }
        return;
      }
      const dimensions = dimensionsFrom(candidate || {});
      const bitrate = positiveNumber(
        safeProperty(candidate, "bitrate") || safeProperty(candidate, "bit_rate")
      );
      target.push({
        url,
        width: dimensions.width,
        height: dimensions.height,
        bitrate,
        priority: Number(priority) || 0
      });
    }

    function objectList(value) {
      return Array.isArray(value) ? value.filter((item) => item && typeof item === "object") : [];
    }

    function imageVariants(object, baseUrl) {
      const variants = [];
      const versions = safeProperty(object, "image_versions2");
      for (const candidate of objectList(safeProperty(versions, "candidates"))) {
        pushVariant(variants, safeProperty(candidate, "url"), candidate, baseUrl, "image", 80);
      }
      for (const key of ["display_resources", "displayResources", "thumbnail_resources"] ) {
        for (const candidate of objectList(safeProperty(object, key))) {
          pushVariant(
            variants,
            safeProperty(candidate, "src") || safeProperty(candidate, "url"),
            candidate,
            baseUrl,
            "image",
            key === "thumbnail_resources" ? 20 : 70
          );
        }
      }
      const image = safeProperty(object, "image");
      if (image && typeof image === "object") {
        pushVariant(
          variants,
          safeProperty(image, "url") || safeProperty(image, "contentUrl"),
          image,
          baseUrl,
          "image",
          65
        );
      }
      const thumbnail = safeProperty(object, "thumbnail");
      if (thumbnail && typeof thumbnail === "object") {
        pushVariant(
          variants,
          safeProperty(thumbnail, "url") || safeProperty(thumbnail, "contentUrl"),
          thumbnail,
          baseUrl,
          "image",
          15
        );
      }
      const directKeys = [
        ["display_url", 60], ["displayUrl", 60], ["display_uri", 60], ["displayUri", 60],
        ["image_url", 55], ["imageUrl", 55],
        ["thumbnail_src", 15], ["thumbnail_url", 15], ["thumbnailUrl", 15]
      ];
      for (const [key, priority] of directKeys) {
        pushVariant(variants, safeProperty(object, key), object, baseUrl, "image", priority);
      }
      const schemaType = safeText(safeProperty(object, "@type"), 100).toLowerCase();
      if (schemaType.includes("image")) {
        pushVariant(
          variants,
          safeProperty(object, "contentUrl") || safeProperty(object, "content_url") ||
            safeProperty(object, "url"),
          object,
          baseUrl,
          "image",
          75
        );
      }
      const byUrl = new Map();
      for (const variant of variants) {
        const existing = byUrl.get(variant.url);
        const score = variant.width * variant.height * 100 + variant.priority;
        const existingScore = existing
          ? existing.width * existing.height * 100 + existing.priority
          : -1;
        if (!existing || score > existingScore) {
          byUrl.set(variant.url, variant);
        }
      }
      return Array.from(byUrl.values());
    }

    function videoVariants(object, baseUrl) {
      const variants = [];
      for (const key of ["video_versions", "videoVersions", "progressive_video"] ) {
        for (const candidate of objectList(safeProperty(object, key))) {
          pushVariant(
            variants,
            safeProperty(candidate, "url") || safeProperty(candidate, "src"),
            candidate,
            baseUrl,
            "video",
            90
          );
        }
      }
      for (const key of ["video_url", "videoUrl", "playback_url", "playbackUrl"] ) {
        pushVariant(variants, safeProperty(object, key), object, baseUrl, "video", 75);
      }
      const schemaType = safeText(safeProperty(object, "@type"), 100).toLowerCase();
      if (schemaType.includes("video")) {
        pushVariant(
          variants,
          safeProperty(object, "contentUrl") || safeProperty(object, "content_url") ||
            safeProperty(object, "url"),
          object,
          baseUrl,
          "video",
          85
        );
      }
      const byUrl = new Map();
      for (const variant of variants) {
        const existing = byUrl.get(variant.url);
        const score = variant.width * variant.height * 1000000 + variant.bitrate * 10 + variant.priority;
        const existingScore = existing
          ? existing.width * existing.height * 1000000 + existing.bitrate * 10 + existing.priority
          : -1;
        if (!existing || score > existingScore) {
          byUrl.set(variant.url, variant);
        }
      }
      return Array.from(byUrl.values());
    }

    function bestVariant(variants) {
      let best = null;
      let bestScore = -1;
      for (const variant of variants) {
        const score = variant.width * variant.height * 1000000 +
          variant.bitrate * 10 + variant.priority;
        if (!best || score > bestScore) {
          best = variant;
          bestScore = score;
        }
      }
      return best;
    }

    function smallestVariant(variants, excludedUrl) {
      let best = null;
      let bestScore = Infinity;
      for (const variant of variants) {
        if (variant.url === excludedUrl) {
          continue;
        }
        const area = variant.width && variant.height ? variant.width * variant.height : Number.MAX_SAFE_INTEGER;
        const score = area * 100 + variant.priority;
        if (!best || score < bestScore) {
          best = variant;
          bestScore = score;
        }
      }
      return best;
    }

    function mediaCaption(object) {
      for (const value of [
        safeProperty(object, "accessibility_caption"), safeProperty(object, "accessibilityCaption"),
        safeProperty(object, "alt"), safeProperty(object, "headline"), safeProperty(object, "description")
      ]) {
        const text = safeText(value, 500).trim();
        if (text) {
          return text;
        }
      }
      const caption = safeProperty(object, "caption");
      const captionText = safeText(
        typeof caption === "string" ? caption : safeProperty(caption, "text"),
        500
      ).trim();
      if (captionText) {
        return captionText;
      }
      const edgeCaption = safeProperty(object, "edge_media_to_caption");
      const edges = objectList(safeProperty(edgeCaption, "edges"));
      return safeText(safeProperty(safeProperty(edges[0], "node"), "text"), 500).trim();
    }

    function isVideoObject(object, variants) {
      const mediaType = Number(safeProperty(object, "media_type"));
      const typename = safeText(
        safeProperty(object, "__typename") || safeProperty(object, "typename") ||
          safeProperty(object, "@type"),
        100
      ).toLowerCase();
      return safeProperty(object, "is_video") === true || mediaType === 2 ||
        typename.includes("video") || variants.length > 0;
    }

    function safeCollectionMembership(value) {
      const type = safeText(safeProperty(value, "type"), 20).toLowerCase();
      if (!["post", "story", "highlight"].includes(type)) {
        return null;
      }
      const id = safeText(safeProperty(value, "id"), 200).trim();
      const title = safeText(safeProperty(value, "title"), 100).trim();
      const rawOwner = safeText(safeProperty(value, "owner"), 80).trim().toLowerCase();
      const owner = /^[a-z0-9._]{1,80}$/i.test(rawOwner) ? rawOwner : "";
      if (!id && !owner) {
        return null;
      }
      return { type, id, title, owner };
    }

    function addCollectionMembership(target, value) {
      const membership = safeCollectionMembership(value);
      if (!membership) {
        return;
      }
      const key = `${membership.type}\n${membership.id}\n${membership.owner}`;
      const existing = target.find((candidate) =>
        `${candidate.type}\n${candidate.id}\n${candidate.owner}` === key
      );
      if (existing) {
        existing.title = existing.title || membership.title;
        return;
      }
      if (target.length >= MAX_COLLECTION_MEMBERSHIPS) {
        return;
      }
      target.push(membership);
    }

    function collectionMembershipFor(object, sourceRoute, collectionKind, collectionTitle) {
      const type = collectionKind === "story"
        ? "story"
        : collectionKind === "highlight"
          ? "highlight"
          : "post";
      const owner = ownerFromObject(object) || safeText(sourceRoute && sourceRoute.username, 80)
        .toLowerCase();
      let id = "";
      let title = "";
      if (type === "post") {
        id = objectIdentifier(object) || safeText(sourceRoute && sourceRoute.shortcode, 100) ||
          objectId(object);
      } else if (type === "story") {
        id = safeText(sourceRoute && sourceRoute.storyId, 200) || owner || objectId(object);
      } else {
        id = safeText(sourceRoute && sourceRoute.highlightId, 200) || objectId(object);
        const descriptor = highlightDescriptors.get(normalizedIdentifier(id));
        title = safeText(
          collectionTitle || sourceRoute && sourceRoute.collectionTitle ||
            descriptor && descriptor.title || safeProperty(object, "title") ||
            safeProperty(object, "name"),
          100
        ).trim();
      }
      const collectionId = type === "post" ? safeText(id, 200).trim() : normalizedIdentifier(id);
      return safeCollectionMembership({ type, id: collectionId, title, owner });
    }

    function mediaIdentityForCollection(object, membership, position) {
      const collection = safeCollectionMembership(membership);
      if (!collection || !collection.id) {
        return "";
      }
      const owner = ownerFromObject(object) || collection.owner;
      if (!owner) {
        return "";
      }
      // Carousel order is stable for a post and lets a visible grid cover
      // merge with the first structured carousel item when the session later
      // exposes the feed API. Stories/highlights use their media IDs when the
      // response exposes one because their order can change over time.
      const index = Math.max(1, Number(position) || 1);
      const item = collection.type === "post"
        ? String(index)
        : mediaItemIdentifier(object) || String(index);
      return `instagram:${collection.type}:${owner}:${collection.id}:${item}`;
    }

    function addRecord(url, details) {
      if (!url) {
        return;
      }
      details = details && typeof details === "object" ? details : {};
      const identityKey = safeText(details.identityKey, 300).trim();
      const recordKey = identityKey ? `identity:${identityKey}` : `url:${url}`;
      const existingRecordKey = found.has(recordKey)
        ? recordKey
        : foundRecordKeysByUrl.get(url);
      const existing = existingRecordKey ? found.get(existingRecordKey) : null;
      if (existing) {
        if (existing.originalMediaType === 1 && details.originalMediaType !== 1) {
          for (const membership of details.instagramCollections || []) {
            addCollectionMembership(existing.instagramCollections, membership);
          }
          return;
        }
        const photoUpgrade = details.originalMediaType === 1 && existing.originalMediaType !== 1;
        const currentArea = (Number(existing.width) || 0) * (Number(existing.height) || 0);
        const nextArea = (Number(details.width) || 0) * (Number(details.height) || 0);
        if ((photoUpgrade || nextArea >= currentArea) && existing.url !== url) {
          const nextPreviewUrl = details.previewUrl && details.previewUrl !== url
            ? details.previewUrl
            : "";
          const oldPayloadLength = existing.url.length + String(existing.previewUrl || "").length;
          const nextPayloadLength = url.length + nextPreviewUrl.length;
          if (totalPayloadLength - oldPayloadLength + nextPayloadLength <= settings.maxPayloadLength) {
            foundRecordKeysByUrl.delete(existing.url);
            totalPayloadLength += nextPayloadLength - oldPayloadLength;
            existing.url = url;
            existing.previewUrl = nextPreviewUrl;
            foundRecordKeysByUrl.set(url, existingRecordKey);
          }
        }
        if (photoUpgrade) {
          if (existing.url !== url) {
            return;
          }
          existing.originalMediaType = 1;
          existing.mediaType = "image";
          existing.width = 0;
          existing.height = 0;
          existing.kinds = [];
          delete existing.mimeType;
          delete existing.duration;
        }
        if (details.mediaType === "video") {
          existing.mediaType = "video";
          existing.mimeType = "video/mp4";
        }
        existing.width = Math.max(existing.width || 0, details.width || 0);
        existing.height = Math.max(existing.height || 0, details.height || 0);
        existing.alt = existing.alt || details.alt || "";
        if (!existing.previewUrl && details.previewUrl &&
          totalPayloadLength + details.previewUrl.length <= settings.maxPayloadLength) {
          existing.previewUrl = details.previewUrl;
          totalPayloadLength += details.previewUrl.length;
        }
        if (details.duration) {
          existing.duration = Math.max(existing.duration || 0, details.duration);
        }
        for (const kind of details.kinds || []) {
          if (existing.kinds.length < 8 && !existing.kinds.includes(kind)) {
            existing.kinds.push(kind);
          }
        }
        for (const membership of details.instagramCollections || []) {
          addCollectionMembership(existing.instagramCollections, membership);
        }
        return;
      }
      if (found.size >= settings.maxItems) {
        itemLimitReached = true;
        return;
      }
      if (totalPayloadLength + url.length > settings.maxPayloadLength) {
        payloadLimitReached = true;
        return;
      }
      totalPayloadLength += url.length;
      let previewUrl = details.previewUrl && details.previewUrl !== url ? details.previewUrl : "";
      if (previewUrl && totalPayloadLength + previewUrl.length > settings.maxPayloadLength) {
        previewUrl = "";
        payloadLimitReached = true;
      } else {
        totalPayloadLength += previewUrl.length;
      }
      const record = {
        url,
        identityKey,
        previewUrl,
        sourceProvider: "instagram",
        alt: safeText(details.alt, 500),
        width: Math.max(0, Number(details.width) || 0),
        height: Math.max(0, Number(details.height) || 0),
        kinds: (details.kinds || ["Instagram media"]).map((kind) => safeText(kind, 50)).slice(0, 8),
        instagramCollections: [],
        mediaType: details.mediaType === "video" ? "video" : "image"
      };
      if (details.originalMediaType === 1 && record.mediaType === "image") {
        record.originalMediaType = 1;
      }
      for (const membership of details.instagramCollections || []) {
        addCollectionMembership(record.instagramCollections, membership);
      }
      if (record.mediaType === "video") {
        record.mimeType = "video/mp4";
        const duration = positiveNumber(details.duration);
        if (duration) {
          record.duration = duration;
        }
      }
      found.set(recordKey, record);
      foundRecordKeysByUrl.set(url, recordKey);
    }

    function clearIncompleteExactRecords() {
      found.clear();
      foundRecordKeysByUrl.clear();
      totalPayloadLength = 0;
      itemLimitReached = false;
      payloadLimitReached = false;
    }

    function addMediaObject(
      object,
      baseUrl,
      collectionKind,
      position,
      total,
      collectionTitle,
      membership
    ) {
      if (!object || typeof object !== "object") {
        return;
      }
      const videoOptions = videoVariants(object, baseUrl);
      const imageOptions = imageVariants(object, baseUrl);
      const video = bestVariant(videoOptions);
      const image = bestVariant(imageOptions);
      const owner = ownerFromObject(object);
      if (owner) {
        owners.add(owner);
      }
      // Music/effects can turn a photo story into a video delivery format.
      // Only prefer its image when Instagram explicitly identifies a photo source.
      const photoStory = image && ["story", "highlight"].includes(collectionKind) &&
        [1, "1"].includes(safeProperty(object, "original_media_type"));
      const mediaType = !photoStory && isVideoObject(object, videoOptions) ? "video" : "image";
      if (["story", "highlight"].includes(collectionKind) && mediaType === "video" &&
        ![2, "2"].includes(safeProperty(object, "original_media_type"))) {
        needsStoryMetadata = true;
      }
      const identityKey = mediaIdentityForCollection(object, membership, position);
      const numberedKind = total > 1 ? `${collectionKind} ${position}/${total}` : collectionKind;
      const title = collectionKind === "highlight" ? safeText(collectionTitle, 20).trim() : "";
      const recordKind = `Instagram ${numberedKind}${title ? ` (${title})` : ""}`;
      if (mediaType === "video") {
        if (!video) {
          if (safeProperty(object, "is_video") === true || Number(safeProperty(object, "media_type")) === 2) {
            unsupportedVideoCount += 1;
          }
          return;
        }
        const poster = smallestVariant(imageOptions, "") || image;
        const objectDimensions = dimensionsFrom(object);
        addRecord(video.url, {
          previewUrl: poster ? poster.url : "",
          alt: mediaCaption(object),
          width: video.width || objectDimensions.width,
          height: video.height || objectDimensions.height,
          duration: safeProperty(object, "video_duration") || safeProperty(object, "duration"),
          kinds: [`${recordKind} video`],
          instagramCollections: membership ? [membership] : [],
          mediaType: "video",
          identityKey
        });
        return;
      }
      if (!image) {
        return;
      }
      const preview = smallestVariant(imageOptions, image.url);
      const objectDimensions = dimensionsFrom(object);
      addRecord(image.url, {
        previewUrl: preview ? preview.url : "",
        alt: mediaCaption(object),
        width: image.width || objectDimensions.width,
        height: image.height || objectDimensions.height,
        kinds: [`${recordKind} image`],
        instagramCollections: membership ? [membership] : [],
        mediaType: "image",
        originalMediaType: photoStory ? 1 : undefined,
        identityKey
      });
    }

    function childMedia(object) {
      if (!object || typeof object !== "object") {
        return [];
      }
      if (childMediaCache.has(object)) {
        return childMediaCache.get(object);
      }
      const sidecar = safeProperty(object, "edge_sidecar_to_children");
      const sidecarEdges = objectList(safeProperty(sidecar, "edges"))
        .map((edge) => safeProperty(edge, "node"))
        .filter((item) => item && typeof item === "object");
      if (sidecarEdges.length) {
        childMediaCache.set(object, sidecarEdges);
        return sidecarEdges;
      }
      for (const key of ["carousel_media", "carouselMedia"] ) {
        const carousel = objectList(safeProperty(object, key));
        if (carousel.length) {
          childMediaCache.set(object, carousel);
          return carousel;
        }
      }
      const children = safeProperty(object, "children");
      if (Array.isArray(children)) {
        const list = objectList(children);
        if (list.length) {
          childMediaCache.set(object, list);
          return list;
        }
      }
      const childEdges = objectList(safeProperty(children, "edges"))
        .map((edge) => safeProperty(edge, "node"))
        .filter((item) => item && typeof item === "object");
      childMediaCache.set(object, childEdges);
      return childEdges;
    }

    function hasDownloadableMedia(object) {
      const videos = videoVariants(object, route.pageUrl);
      return isVideoObject(object, videos)
        ? videos.length > 0 : imageVariants(object, route.pageUrl).length > 0;
    }

    function carouselCount(object) {
      return positiveNumber(safeProperty(object, "carousel_media_count") ||
        safeProperty(object, "carouselMediaCount") ||
        safeProperty(safeProperty(object, "edge_sidecar_to_children"), "count"));
    }

    function isCarouselObject(object) {
      return Number(safeProperty(object, "media_type")) === 8 || carouselCount(object) > 1 ||
        Boolean(safeProperty(object, "edge_sidecar_to_children")) ||
        Array.isArray(safeProperty(object, "carousel_media")) ||
        Array.isArray(safeProperty(object, "carouselMedia")) ||
        /sidecar|carousel/i.test(safeText(safeProperty(object, "__typename"), 100));
    }

    function exactContainerIsComplete(object) {
      const children = childMedia(object);
      const sidecar = safeProperty(object, "edge_sidecar_to_children");
      const declaredCount = positiveNumber(
        safeProperty(object, "carousel_media_count") ||
          safeProperty(object, "carouselMediaCount") || safeProperty(sidecar, "count")
      );
      if (children.length) {
        return (!declaredCount || children.length >= declaredCount) &&
          children.every(hasDownloadableMedia);
      }
      const mediaType = Number(safeProperty(object, "media_type"));
      const typename = safeText(
        safeProperty(object, "__typename") || safeProperty(object, "typename") ||
          safeProperty(object, "@type"),
        100
      ).toLowerCase();
      const declaresCarousel = mediaType === 8 || declaredCount > 1 ||
        Boolean(sidecar) || Array.isArray(safeProperty(object, "carousel_media")) ||
        Array.isArray(safeProperty(object, "carouselMedia")) ||
        /(?:sidecar|carousel)/.test(typename);
      if (declaresCarousel) {
        return false;
      }
      return (mediaType === 1 || mediaType === 2 ||
        /(?:image|video)/.test(typename) && hasMediaShape(object)) && hasDownloadableMedia(object);
    }

    function addMediaContainer(
      object,
      baseUrl,
      collectionKind,
      forceItems,
      sourceRoute,
      explicitMembership
    ) {
      const children = childMedia(object);
      const containerTitle = safeText(
        safeProperty(object, "title") || safeProperty(object, "name"),
        100
      ).trim();
      const membership = safeCollectionMembership(explicitMembership) ||
        collectionMembershipFor(object, sourceRoute, collectionKind, containerTitle);
      if (children.length) {
        const label = (collectionKind === "post" || collectionKind === "reel")
          ? "carousel"
          : collectionKind;
        for (let index = 0; index < children.length; index += 1) {
          addMediaObject(
            children[index],
            baseUrl,
            label,
            index + 1,
            children.length,
            containerTitle,
            membership
          );
        }
        return;
      }
      if (forceItems) {
        const expectedOwner = sourceRoute && sourceRoute.username;
        const items = objectList(safeProperty(object, "items")).filter((item) =>
          !["story", "highlight"].includes(collectionKind) ||
          matchesExpectedOwner(item, expectedOwner)
        );
        if (items.length) {
          const title = safeProperty(object, "title") || safeProperty(object, "name");
          const itemMembership = safeCollectionMembership({
            ...(membership || {}),
            title: membership && membership.title || safeText(title, 100)
          });
          for (let index = 0; index < items.length; index += 1) {
            addMediaObject(
              items[index],
              baseUrl,
              collectionKind,
              index + 1,
              items.length,
              title,
              itemMembership
            );
          }
          return;
        }
      }
      addMediaObject(
        object,
        baseUrl,
        collectionKind,
        1,
        1,
        safeProperty(object, "title"),
        membership
      );
    }

    function objectIdentifier(object) {
      return safeText(
        safeProperty(object, "shortcode") || safeProperty(object, "code") ||
          safeProperty(object, "media_code"),
        100
      );
    }

    function objectId(object) {
      return normalizedIdentifier(
        // Modern carousel IDs are often `POLARIS_<media pk>`. Prefer the
        // numeric pk so stripping legacy `<media>_<owner>` suffixes cannot
        // collapse every item to the shared `POLARIS` prefix.
        safeProperty(object, "pk") || safeProperty(object, "id") ||
          safeProperty(object, "media_id") || safeProperty(object, "reel_id")
      );
    }

    function mediaItemIdentifier(object) {
      return safeText(
        safeProperty(object, "pk") || safeProperty(object, "id") ||
          safeProperty(object, "media_id") || safeProperty(object, "reel_id"),
        200
      ).trim().replace(/^highlight:/i, "");
    }

    function objectUrlMatches(object, expectedRoute, baseUrl) {
      for (const key of ["url", "mainEntityOfPage", "main_entity_of_page"] ) {
        let value = safeProperty(object, key);
        if (value && typeof value === "object") {
          value = safeProperty(value, "@id") || safeProperty(value, "url");
        }
        const candidate = instagramHttpUrl(value, baseUrl);
        if (!candidate) {
          continue;
        }
        const candidateRoute = parseRoute(candidate);
        if ((expectedRoute.kind === "post" || expectedRoute.kind === "reel") &&
          (candidateRoute.kind === "post" || candidateRoute.kind === "reel") &&
          exactShortcodeMatches(candidateRoute.shortcode)) {
          return true;
        }
        if (expectedRoute.kind === "story" && candidateRoute.kind === "story" &&
          candidateRoute.username === expectedRoute.username) {
          return true;
        }
        if (expectedRoute.kind === "highlight" && candidateRoute.kind === "highlight" &&
          candidateRoute.highlightId === expectedRoute.highlightId) {
          return true;
        }
      }
      return false;
    }

    function hasMediaShape(object) {
      return Boolean(
        safeProperty(object, "display_url") || safeProperty(object, "display_uri") ||
        safeProperty(object, "displayUri") ||
        safeProperty(object, "image_versions2") ||
        safeProperty(object, "video_url") || safeProperty(object, "video_versions") ||
        safeProperty(object, "edge_sidecar_to_children") || safeProperty(object, "carousel_media") ||
        safeProperty(object, "contentUrl") || safeProperty(object, "content_url")
      );
    }

    function postMatches(object, parentKey, sourceRoute, baseUrl) {
      const identifier = objectIdentifier(object);
      if (identifier) {
        return exactShortcodeMatches(identifier);
      }
      return objectUrlMatches(object, sourceRoute, baseUrl);
    }

    function reelOwnerMatches(object, sourceRoute) {
      const owner = ownerFromObject(object);
      return Boolean(owner && sourceRoute.username && owner === sourceRoute.username);
    }

    function storyContainerMatches(object, parentKey, sourceRoute) {
      if (!Array.isArray(safeProperty(object, "items"))) {
        return false;
      }
      if (!matchesExpectedOwner(object, sourceRoute.username)) {
        return false;
      }
      if (reelOwnerMatches(object, sourceRoute)) {
        return true;
      }
      const id = objectId(object);
      if (sourceRoute.storyId && id === sourceRoute.storyId) {
        return true;
      }
      const parent = safeText(parentKey, 200).toLowerCase();
      return parent === sourceRoute.username || parent === `reel:${sourceRoute.username}`;
    }

    function highlightContainerMatches(object, parentKey, sourceRoute) {
      if (!Array.isArray(safeProperty(object, "items"))) {
        return false;
      }
      if (!matchesExpectedOwner(object, sourceRoute.username)) {
        return false;
      }
      const id = objectId(object);
      const parentId = normalizedIdentifier(parentKey);
      return id === sourceRoute.highlightId || parentId === sourceRoute.highlightId;
    }

    function timelineItems(value) {
      const direct = objectList(safeProperty(value, "items"));
      if (direct.length) {
        return direct;
      }
      return objectList(safeProperty(value, "edges"))
        .map((edge) => safeProperty(edge, "node"))
        .filter((item) => item && typeof item === "object");
    }

    function addProfilePost(object, baseUrl, expectedUsername) {
      if (!settings.includeProfilePosts || !object || typeof object !== "object") {
        return;
      }
      const owner = ownerFromObject(object);
      if (!owner || owner !== expectedUsername) {
        return;
      }
      registerMatchingProfile(safeProperty(object, "user") || safeProperty(object, "owner"), expectedUsername);
      const id = objectIdentifier(object) || objectId(object);
      const shortcode = objectIdentifier(object);
      const declaredCount = carouselCount(object);
      const children = childMedia(object);
      const carousel = isCarouselObject(object) || children.length > 0;
      const previous = profilePosts.get(shortcode);
      const count = Math.min(settings.maxItems + 1,
        Math.max(1, declaredCount, children.length, previous && previous.count || 0));
      const complete = carousel
        ? children.length >= count && children.every(hasDownloadableMedia)
        : hasDownloadableMedia(object);
      if (shortcode && (profilePosts.has(shortcode) || profilePosts.size < settings.maxItems)) {
        profilePosts.set(shortcode, {
          shortcode, count, carousel: carousel || Boolean(previous && previous.carousel),
          kind: previous && previous.kind || (Number(safeProperty(object, "media_type")) === 2 ? "reel" : "post"),
          complete: complete || Boolean(previous && previous.complete && previous.count >= count)
        });
      }
      addMediaContainer(object, baseUrl, "post", false, {
        kind: "profile",
        username: expectedUsername,
        shortcode: objectIdentifier(object),
        pageUrl: baseUrl
      }, {
        type: "post",
        id,
        title: "",
        owner
      });
    }

    function processMatchingProfileObject(object, baseUrl, expectedUsername) {
      const directMatch = usernameFrom(object) === expectedUsername;
      const timelineItemsForProfile = [];
      for (const key of [
        "edge_owner_to_timeline_media", "edgeOwnerToTimelineMedia",
        "timeline_media", "timelineMedia",
        "polaris_ordered_timeline_connection", "polarisOrderedTimelineConnection"
      ]) {
        timelineItemsForProfile.push(...timelineItems(safeProperty(object, key)));
      }
      const matchingItems = timelineItemsForProfile.filter((item) =>
        ownerFromObject(item) === expectedUsername
      );
      if (!directMatch && !matchingItems.length) {
        return;
      }
      if (directMatch) {
        registerMatchingProfile(object, expectedUsername);
      } else {
        // Current Relay profile payloads put the profile pk beside
        // polaris_ordered_timeline_connection, but omit the username on that
        // wrapper. The child posts still identify the requested profile.
        const pk = profilePkFromObject(object);
        if (pk) {
          profilePks.add(pk);
          owners.add(expectedUsername);
        }
      }
      if (!settings.includeProfilePosts) {
        return;
      }
      for (const item of matchingItems) {
        addProfilePost(item, baseUrl, expectedUsername);
      }
    }

    function processJson(rootValue, sourceRoute, baseUrl, trustedLdRoot) {
      let visitedNodes = 0;
      const seen = typeof WeakSet === "function" ? new WeakSet() : null;
      const processedContainers = typeof WeakSet === "function" ? new WeakSet() : null;

      function processContainer(object, parentKey, depth, isRoot) {
        if (sourceRoute.kind === "story") {
          registerMatchingProfile(object, sourceRoute.username);
        }
        registerHighlightObject(object, parentKey, sourceRoute.username || route.username);
        let matched = false;
        let kind = sourceRoute.kind;
        let forceItems = false;
        if (sourceRoute.kind === "post" || sourceRoute.kind === "reel") {
          matched = postMatches(object, parentKey, sourceRoute, baseUrl);
          kind = sourceRoute.kind;
          forceItems = ["items", "media"].includes(parentKey) && Array.isArray(safeProperty(object, "items"));
        } else if (sourceRoute.kind === "story") {
          matched = storyContainerMatches(object, parentKey, sourceRoute);
          kind = "story";
          forceItems = true;
          if (!matched && sourceRoute.storyId && objectId(object) === sourceRoute.storyId &&
            matchesExpectedOwner(object, sourceRoute.username) && hasMediaShape(object)) {
            matched = true;
            forceItems = false;
          }
        } else if (sourceRoute.kind === "highlight") {
          matched = highlightContainerMatches(object, parentKey, sourceRoute);
          kind = "highlight";
          forceItems = true;
          if (!matched && objectId(object) === sourceRoute.highlightId &&
            matchesExpectedOwner(object, sourceRoute.username) && hasMediaShape(object)) {
            matched = true;
            forceItems = false;
          }
        } else if (sourceRoute.kind === "profile") {
          processMatchingProfileObject(object, baseUrl, sourceRoute.username);
        }
        if (matched && (!processedContainers || !processedContainers.has(object))) {
          if (processedContainers) {
            processedContainers.add(object);
          }
          const owner = ownerFromObject(object);
          if (owner) {
            owners.add(owner);
          }
          const completeExactContainer = (sourceRoute.kind === "post" ||
            sourceRoute.kind === "reel") && exactShortcodeMatches(sourceRoute.shortcode) &&
            exactContainerIsComplete(object);
          if (completeExactContainer && !exactStructuredPostComplete) {
            clearIncompleteExactRecords();
          }
          const countBefore = found.size;
          addMediaContainer(object, baseUrl, kind, forceItems, sourceRoute);
          if ((sourceRoute.kind === "post" || sourceRoute.kind === "reel") &&
            exactShortcodeMatches(sourceRoute.shortcode) && found.size > countBefore) {
            exactStructuredPostComplete = exactStructuredPostComplete ||
              completeExactContainer;
          }
        }
        if (depth >= MAX_JSON_DEPTH) {
          return;
        }
      }

      function walk(value, depth, parentKey, isRoot) {
        if (
          jsonNodeLimitReached ||
          hasCompleteExactCollection(sourceRoute) ||
          depth > MAX_JSON_DEPTH ||
          value == null
        ) {
          return;
        }
        if (typeof value === "string") {
          const trimmed = value.trim();
          if (depth < 8 && trimmed.length >= 2 && trimmed.length <= settings.maxDocumentBytes &&
            ((trimmed[0] === "{" && trimmed.endsWith("}")) ||
              (trimmed[0] === "[" && trimmed.endsWith("]")))) {
            try {
              walk(JSON.parse(trimmed), depth + 1, parentKey, false);
            } catch (_error) {
              // Serialized JSON strings are optional; malformed strings are ignored.
            }
          }
          return;
        }
        if (typeof value !== "object") {
          return;
        }
        visitedNodes += 1;
        if (visitedNodes > MAX_JSON_NODES) {
          jsonNodeLimitReached = true;
          return;
        }
        if (seen) {
          if (seen.has(value)) {
            return;
          }
          seen.add(value);
        }
        if (Array.isArray(value)) {
          const maximum = Math.min(value.length, settings.maxItems * 12 + 2048);
          for (let index = 0; index < maximum; index += 1) {
            walk(value[index], depth + 1, parentKey, false);
          }
          return;
        }
        processContainer(value, parentKey, depth, isRoot);
        if (hasCompleteExactCollection(sourceRoute)) {
          return;
        }
        let entries;
        try {
          entries = Object.entries(value);
        } catch (_error) {
          entries = [];
        }
        const maximum = Math.min(entries.length, 2048);
        for (let index = 0; index < maximum; index += 1) {
          const [key, child] = entries[index];
          walk(child, depth + 1, safeText(key, 200), false);
        }
      }

      walk(rootValue, 0, "", true);
    }

    function parseJsonValues(rawText) {
      const text = safeText(rawText, settings.maxDocumentBytes);
      const values = [];
      const trimmed = text.trim();
      if (!trimmed) {
        return values;
      }
      try {
        values.push(JSON.parse(trimmed));
        return values;
      } catch (_error) {
        // Instagram also embeds JSON after assignment/callback prefixes.
      }
      const stack = [];
      const outer = [];
      const nested = [];
      let quoted = false;
      let escaped = false;
      // Collect balanced spans in one pass. Malformed outer wrappers can still
      // expose a valid nested object, without rescanning a multi-megabyte tail.
      for (let index = 0; index < text.length; index += 1) {
        const character = text[index];
        if (quoted) {
          if (escaped) escaped = false;
          else if (character === "\\") escaped = true;
          else if (character === '"') quoted = false;
          continue;
        }
        if (character === '"') {
          quoted = true;
        } else if (character === "{" || character === "[") {
          if (stack.length >= MAX_JSON_DEPTH * 4) stack.length = 0;
          stack.push({ character, start: index });
        } else if (character === "}" || character === "]") {
          const expected = character === "}" ? "{" : "[";
          if (!stack.length || stack[stack.length - 1].character !== expected) {
            stack.length = 0;
            continue;
          }
          const start = stack.pop().start;
          const target = stack.length ? nested : outer;
          if (target.length < MAX_JSON_VALUES_PER_SCRIPT) target.push({ start, end: index + 1 });
        }
      }
      const candidates = [...outer, ...nested].sort((a, b) => a.start - b.start || b.end - a.end);
      let attempts = 0;
      let acceptedEnd = 0;
      for (const candidate of candidates) {
        if (attempts >= MAX_JSON_VALUES_PER_SCRIPT) break;
        if (candidate.start < acceptedEnd) continue;
        attempts += 1;
        try {
          values.push(JSON.parse(text.slice(candidate.start, candidate.end)));
          acceptedEnd = candidate.end;
        } catch (_error) {
          // Try a nested span or a later assignment without rescanning text.
        }
      }
      return values;
    }

    function attributeValue(attributes, name) {
      const pattern = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
      const match = safeText(attributes, 10000).match(pattern);
      return match ? safeText(match[1] || match[2] || match[3], 16384) : "";
    }

    function decodeHtmlAttribute(value) {
      return safeText(value, 16384)
        .replace(/&amp;/gi, "&")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">");
    }

    function metaMapFromHtml(html) {
      const values = new Map();
      const pattern = /<meta\b([^>]*)>/gi;
      let match;
      let count = 0;
      while ((match = pattern.exec(html)) && count < 256) {
        count += 1;
        const attributes = match[1];
        const key = (attributeValue(attributes, "property") || attributeValue(attributes, "name"))
          .toLowerCase();
        const content = decodeHtmlAttribute(attributeValue(attributes, "content"));
        if (key && content && !values.has(key)) {
          values.set(key, content);
        }
      }
      return values;
    }

    function currentMetaMap() {
      const values = new Map();
      let nodes = [];
      try {
        nodes = Array.from(document.querySelectorAll("meta[property], meta[name]")).slice(0, 256);
      } catch (_error) {
        nodes = [];
      }
      for (const node of nodes) {
        try {
          const key = safeText(node.getAttribute("property") || node.getAttribute("name"), 200)
            .toLowerCase();
          const content = safeText(node.getAttribute("content"), 16384);
          if (key && content && !values.has(key)) {
            values.set(key, content);
          }
        } catch (_error) {
          // Detached or page-overridden DOM nodes are ignored.
        }
      }
      return values;
    }

    function addMetaFallback(meta, sourceRoute, baseUrl, collectionKind) {
      if (!["post", "reel", "story", "highlight"].includes(sourceRoute.kind)) {
        return;
      }
      const canonical = meta.get("og:url");
      if ((sourceRoute.kind === "post" || sourceRoute.kind === "reel") && !canonical) {
        return;
      }
      if (canonical) {
        const canonicalRoute = parseRoute(canonical);
        const samePost = (sourceRoute.kind === "post" || sourceRoute.kind === "reel") &&
          exactShortcodeMatches(canonicalRoute.shortcode);
        const sameStory = sourceRoute.kind === "story" &&
          canonicalRoute.kind === "story" && canonicalRoute.username === sourceRoute.username;
        const sameHighlight = sourceRoute.kind === "highlight" &&
          canonicalRoute.kind === "highlight" && canonicalRoute.highlightId === sourceRoute.highlightId;
        if (!samePost && !sameStory && !sameHighlight) {
          return;
        }
      }
      const videoRaw = meta.get("og:video:secure_url") || meta.get("og:video:url") ||
        meta.get("og:video") || meta.get("twitter:player:stream");
      const imageRaw = meta.get("og:image:secure_url") || meta.get("og:image") ||
        meta.get("twitter:image");
      const video = mediaHttpUrl(videoRaw, baseUrl, "video");
      const image = mediaHttpUrl(imageRaw, baseUrl, "image");
      const width = positiveNumber(meta.get("og:video:width") || meta.get("og:image:width"));
      const height = positiveNumber(meta.get("og:video:height") || meta.get("og:image:height"));
      const alt = meta.get("og:description") || meta.get("twitter:description") || "";
      const membership = collectionMembershipFor({}, sourceRoute, collectionKind, "");
      const identityKey = mediaIdentityForCollection({}, membership, 1);
      if (video) {
        addRecord(video, {
          previewUrl: image,
          alt,
          width,
          height,
          mediaType: "video",
          identityKey,
          instagramCollections: membership ? [membership] : [],
          kinds: [`Instagram ${collectionKind} video`]
        });
      } else if (videoRaw) {
        unsupportedVideoCount += 1;
      } else if (image) {
        addRecord(image, {
          previewUrl: "",
          alt,
          width,
          height,
          mediaType: "image",
          identityKey,
          instagramCollections: membership ? [membership] : [],
          kinds: [`Instagram ${collectionKind} image`]
        });
      }
    }

    function scriptMayContainInstagramData(script) {
      const type = safeText(script && script.type, 100).toLowerCase();
      const text = safeText(script && script.text, settings.maxDocumentBytes);
      if (!text) {
        return false;
      }
      if (type.includes("json")) {
        return true;
      }
      const firstContentIndex = text.search(/\S/);
      if (firstContentIndex >= 0 && ["{", "["].includes(text[firstContentIndex])) {
        return true;
      }
      return INSTAGRAM_SCRIPT_MARKER.test(text) || PROFILE_SCRIPT_MARKER.test(text);
    }

    function currentScripts() {
      let scripts = [];
      try {
        scripts = Array.from(document.querySelectorAll("script")).slice(0, MAX_SCRIPTS_PER_DOCUMENT);
      } catch (_error) {
        scripts = [];
      }
      const candidates = [];
      for (const script of scripts) {
        let candidate;
        try {
          candidate = {
            type: safeText(script.getAttribute && script.getAttribute("type"), 100).toLowerCase(),
            text: safeText(script.textContent || script.innerText, settings.maxDocumentBytes)
          };
        } catch (_error) {
          candidate = { type: "", text: "" };
        }
        if (scriptMayContainInstagramData(candidate)) {
          candidates.push(candidate);
        }
      }
      return candidates;
    }

    function scriptsFromHtml(html) {
      const scripts = [];
      const pattern = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
      let match;
      let inspected = 0;
      while ((match = pattern.exec(html)) && inspected < MAX_SCRIPTS_PER_DOCUMENT) {
        inspected += 1;
        const candidate = {
          type: attributeValue(match[1], "type").toLowerCase(),
          text: safeText(match[2], settings.maxDocumentBytes)
        };
        if (scriptMayContainInstagramData(candidate)) {
          scripts.push(candidate);
        }
      }
      return scripts;
    }

    function currentLinks() {
      const links = [];
      const seen = new Set();
      let anchors = [];
      try {
        anchors = Array.from(document.querySelectorAll("a[href]")).slice(0, MAX_RELATED_LINKS * 8);
      } catch (_error) {
        anchors = [];
      }
      for (const anchor of anchors) {
        try {
          const url = instagramHttpUrl(anchor.getAttribute("href") || anchor.href, route.pageUrl);
          if (url && !seen.has(url)) {
            seen.add(url);
            links.push(url);
          }
        } catch (_error) {
          // Ignore page-overridden anchor accessors.
        }
        if (links.length >= MAX_RELATED_LINKS) {
          break;
        }
      }
      return links;
    }

    function linksFromHtml(html, baseUrl) {
      const links = [];
      const seen = new Set();
      const pattern = /<a\b([^>]*)>/gi;
      let match;
      while ((match = pattern.exec(html)) && links.length < MAX_RELATED_LINKS) {
        const url = instagramHttpUrl(
          decodeHtmlAttribute(attributeValue(match[1], "href")),
          baseUrl
        );
        if (url && !seen.has(url)) {
          seen.add(url);
          links.push(url);
        }
      }
      return links;
    }

    function queueDocument(url, purpose, expectedOwner) {
      const normalized = instagramHttpUrl(url, route.pageUrl);
      if (!normalized || queuedDocumentUrls.has(normalized) || visitedDocuments.has(normalized)) {
        return;
      }
      if (queuedDocuments.length >= MAX_RELATED_LINKS) {
        documentLimitReached = true;
        return;
      }
      const expectedRoute = parseRoute(normalized);
      const normalizedOwner = safeText(expectedOwner, 80).trim().toLowerCase();
      queuedDocumentUrls.add(normalized);
      queuedDocuments.push({
        url: normalized,
        purpose: safeText(purpose, 40),
        expectedUsername: expectedRoute.username || normalizedOwner,
        expectedStoryId: expectedRoute.storyId || "",
        expectedHighlightId: expectedRoute.highlightId || "",
        expectedOwner: normalizedOwner
      });
    }

    function preferredOwner(sourceRoute) {
      if (sourceRoute.username) {
        return sourceRoute.username;
      }
      return owners.values().next().value || "";
    }

    function discoverRelatedLinks(links, sourceRoute) {
      if (sourceRoute.kind !== "profile" || (!settings.includeStories && !settings.includeHighlights)) {
        return;
      }
      const owner = preferredOwner(sourceRoute) || preferredOwner(route);
      for (const link of links) {
        const linkedRoute = parseRoute(link);
        if (settings.includeStories && linkedRoute.kind === "story" && owner &&
          linkedRoute.username === owner) {
          queueDocument(link, "story", owner);
          continue;
        }
        if (settings.includeHighlights && linkedRoute.kind === "highlight" &&
          (!owner || sourceRoute.username === owner)) {
          registerHighlight(linkedRoute.highlightId, "", owner || sourceRoute.username);
          queueDocument(link, "highlight", owner || sourceRoute.username);
        }
      }
    }

    function processScripts(scripts, sourceRoute, baseUrl) {
      const countBefore = found.size;
      for (const script of scripts.slice(0, MAX_SCRIPTS_PER_DOCUMENT)) {
        const scriptBytes = byteLength(script.text);
        if (scriptBytes > settings.maxDocumentBytes) {
          documentLimitReached = true;
          continue;
        }
        if (totalDocumentBytes + scriptBytes > settings.maxTotalDocumentBytes) {
          documentLimitReached = true;
          break;
        }
        totalDocumentBytes += scriptBytes;
        const values = parseJsonValues(script.text);
        for (let index = 0; index < values.length; index += 1) {
          processJson(
            values[index],
            sourceRoute,
            baseUrl,
            script.type === "application/ld+json" && index === 0
          );
          if (hasCompleteExactCollection(sourceRoute)) {
            break;
          }
        }
        if (hasCompleteExactCollection(sourceRoute)) {
          break;
        }
      }
      return found.size - countBefore;
    }

    function processCurrentDocument() {
      const added = processScripts(currentScripts(), route, route.pageUrl);
      if (!added) {
        addMetaFallback(currentMetaMap(), route, route.pageUrl, route.kind);
      }
      if (route.kind === "profile") {
        owners.add(route.username);
        if (settings.includeStories || settings.includeHighlights) {
          discoverRelatedLinks(currentLinks(), route);
        }
      }
    }

    async function readResponseText(response) {
      let announcedLength = 0;
      try {
        announcedLength = Number(response.headers && response.headers.get("content-length")) || 0;
      } catch (_error) {
        announcedLength = 0;
      }
      if (announcedLength > settings.maxDocumentBytes ||
        totalDocumentBytes + announcedLength > settings.maxTotalDocumentBytes) {
        return { ok: false, tooLarge: true, text: "" };
      }
      if (response.body && typeof response.body.getReader === "function" &&
        typeof TextDecoder === "function") {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const chunks = [];
        let bytes = 0;
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) {
              break;
            }
            bytes += part.value && Number(part.value.byteLength) || 0;
            if (bytes > settings.maxDocumentBytes ||
              totalDocumentBytes + bytes > settings.maxTotalDocumentBytes) {
              if (typeof reader.cancel === "function") {
                await reader.cancel().catch(() => undefined);
              }
              return { ok: false, tooLarge: true, text: "" };
            }
            chunks.push(decoder.decode(part.value, { stream: true }));
          }
          chunks.push(decoder.decode());
          return { ok: true, text: chunks.join(""), bytes };
        } finally {
          try {
            reader.releaseLock();
          } catch (_error) {
            // Some response body readers do not expose releaseLock().
          }
        }
      }
      const text = await response.text();
      const bytes = byteLength(text);
      if (bytes > settings.maxDocumentBytes || totalDocumentBytes + bytes > settings.maxTotalDocumentBytes) {
        return { ok: false, tooLarge: true, text: "" };
      }
      return { ok: true, text, bytes };
    }

    async function fetchHtmlDocument(entry, reportAsRelated, rawTimeoutMs) {
      const timeoutMs = boundedInteger(rawTimeoutMs, FETCH_TIMEOUT_MS, 1000, FETCH_TIMEOUT_MS);
      const shouldReportAsRelated = reportAsRelated !== false;
      const noteUnavailable = () => {
        if (shouldReportAsRelated) {
          inaccessibleRelatedCount += 1;
        }
      };
      if (typeof fetch !== "function") {
        noteUnavailable();
        return null;
      }
      let controller = null;
      let timer = null;
      try {
        controller = typeof AbortController === "function" ? new AbortController() : null;
        if (controller && typeof setTimeout === "function") {
          timer = setTimeout(() => controller.abort(), timeoutMs);
        }
        const response = await fetch(entry.url, {
          method: "GET",
          credentials: "include",
          cache: "no-store",
          redirect: "follow",
          signal: controller ? controller.signal : undefined,
          headers: { Accept: "text/html,application/xhtml+xml" }
        });
        if (!response || !response.ok) {
          noteUnavailable();
          return null;
        }
        const finalUrl = instagramHttpUrl(response.url || entry.url, entry.url);
        if (!finalUrl) {
          noteUnavailable();
          return null;
        }
        const contentType = safeText(
          response.headers && response.headers.get && response.headers.get("content-type"),
          200
        ).toLowerCase();
        if (contentType && !/(?:text\/html|application\/xhtml\+xml)/.test(contentType)) {
          noteUnavailable();
          return null;
        }
        const body = await readResponseText(response);
        if (!body.ok) {
          documentLimitReached = documentLimitReached || body.tooLarge;
          return null;
        }
        totalDocumentBytes += body.bytes || byteLength(body.text);
        return { url: finalUrl, text: body.text };
      } catch (_error) {
        noteUnavailable();
        return null;
      } finally {
        if (timer !== null && typeof clearTimeout === "function") {
          clearTimeout(timer);
        }
      }
    }

    async function fetchInstagramJson(rawUrl, purpose, reportAsRelated, rawTimeoutMs, graphQuery) {
      const timeoutMs = boundedInteger(rawTimeoutMs, FETCH_TIMEOUT_MS, 1000, FETCH_TIMEOUT_MS);
      const shouldReportAsRelated = reportAsRelated !== false;
      const noteUnavailable = () => {
        if (shouldReportAsRelated) {
          inaccessibleRelatedCount += 1;
        }
      };
      const url = instagramHttpUrl(rawUrl, route.pageUrl);
      const variables = graphQuery ? JSON.stringify(graphQuery.variables) : "";
      const requestKey = graphQuery ? `${url}\n${graphQuery.docId}\n${variables}` : url;
      if (!url || visitedDocuments.has(requestKey)) {
        return null;
      }
      if (fetchedDocumentCount >= settings.maxDocuments) {
        documentLimitReached = true;
        return null;
      }
      if (typeof fetch !== "function") {
        noteUnavailable();
        return null;
      }
      visitedDocuments.add(requestKey);
      fetchedDocumentCount += 1;
      let controller = null;
      let timer = null;
      try {
        controller = typeof AbortController === "function" ? new AbortController() : null;
        if (controller && typeof setTimeout === "function") {
          timer = setTimeout(() => controller.abort(), timeoutMs);
        }
        const headers = { Accept: "application/json", "X-IG-App-ID": INSTAGRAM_WEB_APP_ID };
        let body;
        if (graphQuery) {
          // The token stays in the page and is sent only to Instagram's own
          // read-only GraphQL endpoint with the existing browser session.
          const csrf = safeText(safeProperty(document, "cookie"), 65536)
            .match(/(?:^|;\s*)csrftoken=([a-z0-9_-]{1,256})(?:;|$)/i);
          if (csrf) headers["X-CSRFToken"] = csrf[1];
          body = new URLSearchParams({
            doc_id: graphQuery.docId, variables, server_timestamps: "true"
          }).toString();
          headers["Content-Type"] = "application/x-www-form-urlencoded";
        }
        const response = await fetch(url, {
          method: graphQuery ? "POST" : "GET",
          body,
          credentials: "include",
          cache: "no-store",
          redirect: graphQuery ? "error" : "follow",
          signal: controller ? controller.signal : undefined,
          headers
        });
        if (!response || !response.ok) {
          noteUnavailable();
          return null;
        }
        const finalUrl = instagramHttpUrl(response.url || url, url);
        if (!finalUrl) {
          noteUnavailable();
          return null;
        }
        const contentType = safeText(
          response.headers && response.headers.get && response.headers.get("content-type"),
          200
        ).toLowerCase();
        if (contentType && !/(?:application|text)\/[^;]*json/.test(contentType)) {
          noteUnavailable();
          return null;
        }
        const responseBody = await readResponseText(response);
        if (!responseBody.ok) {
          documentLimitReached = documentLimitReached || responseBody.tooLarge;
          return null;
        }
        totalDocumentBytes += responseBody.bytes || byteLength(responseBody.text);
        try {
          return {
            url: finalUrl,
            purpose: safeText(purpose, 40),
            value: JSON.parse(responseBody.text)
          };
        } catch (_error) {
          noteUnavailable();
          return null;
        }
      } catch (_error) {
        noteUnavailable();
        return null;
      } finally {
        if (timer !== null && typeof clearTimeout === "function") {
          clearTimeout(timer);
        }
      }
    }

    function exactItemMatches(object) {
      if (!object || typeof object !== "object") {
        return false;
      }
      const identifier = objectIdentifier(object);
      if (identifier) {
        return exactShortcodeMatches(identifier);
      }
      if (routeMediaId) {
        const mediaPk = safeText(
          safeProperty(object, "pk") || safeProperty(object, "media_id") ||
            safeProperty(object, "mediaId") || safeProperty(object, "id"),
          100
        ).trim().replace(/_\d+$/, "");
        if (mediaPk === routeMediaId) {
          return true;
        }
      }
      return objectUrlMatches(object, route, route.pageUrl);
    }

    function addExactItem(object, baseUrl) {
      if (!exactItemMatches(object)) {
        return false;
      }
      const completeExactContainer = exactContainerIsComplete(object);
      if (completeExactContainer && !exactStructuredPostComplete) {
        clearIncompleteExactRecords();
      }
      const before = found.size;
      addMediaContainer(object, baseUrl, route.kind, false, route);
      if (found.size > before) {
        exactStructuredPostComplete = exactStructuredPostComplete ||
          completeExactContainer;
      }
      return found.size > before;
    }

    function processExactPayload(value, baseUrl) {
      if (!value || typeof value !== "object") {
        return 0;
      }
      const before = found.size;
      const data = safeProperty(value, "data");
      const graph = safeProperty(value, "graphql");
      const groups = [
        safeProperty(value, "items"),
        safeProperty(data, "items"),
        safeProperty(safeProperty(data, "xdt_api__v1__media__shortcode__web_info"), "items"),
        safeProperty(safeProperty(data, "xdt_api__v1__media__media_id_web_info"), "items")
      ];
      for (const group of groups) {
        for (const item of objectList(group)) {
          addExactItem(item, baseUrl);
        }
      }
      addExactItem(safeProperty(graph, "shortcode_media"), baseUrl);
      addExactItem(safeProperty(data, "xdt_shortcode_media"), baseUrl);
      return found.size - before;
    }

    function canonicalExactPostUrl() {
      try {
        const exact = new URL(route.pageUrl);
        exact.search = "";
        exact.hash = "";
        return exact.href;
      } catch (_error) {
        return route.pageUrl;
      }
    }

    async function collectExactPostNetworkFallback() {
      if (exactStructuredPostComplete || !["post", "reel"].includes(route.kind)) {
        return;
      }

      if (routeMediaId) {
        const mediaInfo = new URL(
          `/api/v1/media/${encodeURIComponent(routeMediaId)}/info/`,
          route.pageUrl
        );
        const fetched = await fetchInstagramJson(
          mediaInfo.href,
          "exact-media-info",
          false,
          EXACT_FETCH_TIMEOUT_MS
        );
        if (fetched) {
          processExactPayload(fetched.value, fetched.url);
        }
      }
      if (exactStructuredPostComplete) {
        return;
      }

      const graphQuery = new URL("/graphql/query/", route.pageUrl);
      graphQuery.searchParams.set("doc_id", INSTAGRAM_POST_QUERY_DOC_ID);
      graphQuery.searchParams.set("variables", JSON.stringify({
        shortcode: queryShortcode,
        __relay_internal__pv__PolarisShortDramaEnabledrelayprovider: false,
        __relay_internal__pv__PolarisMultiCaptionCarouselEnabledrelayprovider: false
      }));
      const fetched = await fetchInstagramJson(
        graphQuery.href,
        "exact-post-query",
        false,
        EXACT_FETCH_TIMEOUT_MS
      );
      if (fetched) {
        processExactPayload(fetched.value, fetched.url);
      }
      if (exactStructuredPostComplete) {
        return;
      }

      const exactUrl = canonicalExactPostUrl();
      if (!visitedDocuments.has(exactUrl) && fetchedDocumentCount < settings.maxDocuments) {
        visitedDocuments.add(exactUrl);
        fetchedDocumentCount += 1;
        const exactDocument = await fetchHtmlDocument(
          { url: exactUrl },
          false,
          EXACT_FETCH_TIMEOUT_MS
        );
        if (exactDocument) {
          const finalRoute = parseRoute(exactDocument.url);
          if (["post", "reel"].includes(finalRoute.kind) &&
            exactShortcodeMatches(finalRoute.shortcode)) {
            const added = processScripts(
              scriptsFromHtml(exactDocument.text),
              route,
              exactDocument.url
            );
            if (!added) {
              addMetaFallback(
                metaMapFromHtml(exactDocument.text),
                route,
                exactDocument.url,
                route.kind
              );
            }
          }
        }
      }
    }

    function runtimeRoots() {
      const roots = [];
      const seen = new Set();
      const add = (node) => {
        if (node && !seen.has(node) && roots.length < 128) {
          seen.add(node);
          roots.push(node);
        }
      };
      try {
        add(document.body);
        add(document.documentElement);
      } catch (_error) {
        // Synthetic or partially loaded documents may omit these roots.
      }
      for (const selector of ["[role=\"dialog\"]", "main", "article", "body"]) {
        let nodes = [];
        try {
          nodes = Array.from(document.querySelectorAll(selector)).slice(0, 16);
        } catch (_error) {
          nodes = [];
        }
        for (const node of nodes) {
          add(node);
          let media = [];
          try {
            media = Array.from(node.querySelectorAll("img, video")).slice(0, 64);
          } catch (_error) {
            media = [];
          }
          for (const item of media) {
            add(item);
            let parent = safeProperty(item, "parentElement");
            for (let depth = 0; parent && depth < 8; depth += 1) {
              add(parent);
              parent = safeProperty(parent, "parentElement");
            }
          }
        }
      }
      try {
        if (typeof document.createTreeWalker === "function" && typeof NodeFilter !== "undefined") {
          const walker = document.createTreeWalker(document, NodeFilter.SHOW_ELEMENT);
          for (let index = 0; index < 128; index += 1) {
            const node = walker.nextNode();
            if (!node) break;
            add(node);
          }
        } else {
          const all = document.querySelectorAll("*");
          for (let index = 0; index < Math.min(Number(all && all.length) || 0, 128); index += 1) add(all[index]);
        }
      } catch (_error) {
        // Targeted runtime roots above are sufficient when broad traversal fails.
      }
      return roots;
    }

    function processRuntimeData() {
      const exactRoute = ["post", "reel"].includes(route.kind);
      const storyRoute = ["story", "highlight"].includes(route.kind);
      const complete = () => exactRoute ? exactStructuredPostComplete : !storyRoute && Boolean(profilePk());
      if ((!exactRoute && !storyRoute && route.kind !== "profile") || complete()) {
        return;
      }
      const values = [];
      const seenValues = typeof WeakSet === "function" ? new WeakSet() : null;
      for (const node of runtimeRoots()) {
        let pageNode = node;
        try {
          const unwrapped = safeProperty(node, "wrappedJSObject");
          if (unwrapped && typeof unwrapped === "object") {
            pageNode = unwrapped;
          }
        } catch (_error) {
          pageNode = node;
        }
        let keys = [];
        try {
          keys = Object.getOwnPropertyNames(pageNode).slice(0, 512);
        } catch (_error) {
          keys = [];
        }
        for (const key of keys) {
          if (!/^__react(?:Fiber|Props)\$.{1,100}$/i.test(key)) {
            continue;
          }
          const value = safeProperty(pageNode, key);
          if (!value || typeof value !== "object" || seenValues && seenValues.has(value)) {
            continue;
          }
          if (seenValues) {
            seenValues.add(value);
          }
          values.push(value);
          if (values.length >= 32) {
            break;
          }
        }
        if (values.length >= 32) {
          break;
        }
      }

      const visited = typeof WeakSet === "function" ? new WeakSet() : null;
      let visitedCount = 0;
      function walk(value, depth, parentKey = "") {
        if (complete() || !value || typeof value !== "object" || depth > 32 ||
          visitedCount >= 40000) {
          return;
        }
        if (visited) {
          if (visited.has(value)) {
            return;
          }
          visited.add(value);
        }
        visitedCount += 1;
        if (storyRoute) {
          registerMatchingProfile(value, route.username);
          const matches = route.kind === "story"
            ? storyContainerMatches(value, parentKey, route)
            : highlightContainerMatches(value, parentKey, route);
          const itemId = route.kind === "story" ? route.storyId : route.highlightId;
          if (matches || (itemId && objectId(value) === itemId &&
            matchesExpectedOwner(value, route.username) && hasMediaShape(value))) {
            registerMatchingProfile(safeProperty(value, "user") || safeProperty(value, "owner"), route.username);
            addMediaContainer(value, route.pageUrl, route.kind, matches, route);
            return;
          }
        } else if (route.kind === "profile") {
          registerMatchingProfile(value, route.username);
        } else if (exactItemMatches(value) && addExactItem(value, route.pageUrl)) {
          return;
        }
        let entries = [];
        try {
          entries = Array.isArray(value)
            ? value.slice(0, 2048).map((item, index) => [String(index), item])
            : Object.entries(value).slice(0, 512);
        } catch (_error) {
          entries = [];
        }
        for (const [key, child] of entries) {
          walk(child, depth + 1, key);
          if (complete()) {
            break;
          }
        }
      }
      for (const value of values) {
        walk(value, 0);
        if (complete()) {
          break;
        }
      }
    }

    function domAttribute(node, name) {
      try {
        return safeText(node && node.getAttribute && node.getAttribute(name), 16384);
      } catch (_error) {
        return "";
      }
    }

    function domMediaDetails(node) {
      const tag = safeText(
        safeProperty(node, "localName") || safeProperty(node, "tagName"),
        20
      ).toLowerCase();
      const mediaType = tag === "video" ? "video" : tag === "img" ? "image" : "";
      if (!mediaType) {
        return null;
      }
      let rawUrl = safeText(
        safeProperty(node, "currentSrc") || safeProperty(node, "src") ||
          domAttribute(node, "src"),
        16384
      );
      if (!rawUrl && mediaType === "image") {
        const srcset = domAttribute(node, "srcset");
        const candidates = srcset.split(",").map((entry) => entry.trim().split(/\s+/)[0])
          .filter(Boolean);
        rawUrl = candidates[candidates.length - 1] || "";
      }
      const url = mediaHttpUrl(rawUrl, route.pageUrl, mediaType);
      if (!url || /(?:t51\.2885-19|profile_pic|[\/_]s150x150[\/_])/i.test(url)) {
        return null;
      }
      const alt = safeText(safeProperty(node, "alt") || domAttribute(node, "alt"), 500);
      if (/profile (?:photo|picture)/i.test(alt)) {
        return null;
      }
      let box = null;
      try {
        box = node.getBoundingClientRect && node.getBoundingClientRect();
      } catch (_error) {
        box = null;
      }
      const width = positiveNumber(
        safeProperty(node, mediaType === "video" ? "videoWidth" : "naturalWidth") ||
          safeProperty(node, "width") || domAttribute(node, "width") || safeProperty(box, "width")
      );
      const height = positiveNumber(
        safeProperty(node, mediaType === "video" ? "videoHeight" : "naturalHeight") ||
          safeProperty(node, "height") || domAttribute(node, "height") || safeProperty(box, "height")
      );
      const renderedWidth = positiveNumber(safeProperty(box, "width"));
      const renderedHeight = positiveNumber(safeProperty(box, "height"));
      const intrinsicallyLarge = width >= 480 && height >= 240 || width >= 240 && height >= 480;
      const visiblyLarge = renderedWidth >= 280 && renderedHeight >= 180 ||
        renderedWidth >= 180 && renderedHeight >= 280;
      if (!intrinsicallyLarge && !visiblyLarge) {
        return null;
      }
      const poster = mediaType === "video"
        ? mediaHttpUrl(
          safeProperty(node, "poster") || domAttribute(node, "poster"),
          route.pageUrl,
          "image"
        )
        : "";
      return {
        url,
        previewUrl: poster,
        alt,
        width: width || renderedWidth,
        height: height || renderedHeight,
        mediaType,
        score: Math.max(width * height, renderedWidth * renderedHeight)
      };
    }

    function domMediaIn(root) {
      if (!root || (typeof root !== "object" && typeof root !== "function")) {
        return [];
      }
      if (domMediaCache.has(root)) {
        return domMediaCache.get(root);
      }
      let nodes = [];
      try {
        nodes = Array.from(root.querySelectorAll("img, video")).slice(0, 256);
      } catch (_error) {
        nodes = [];
      }
      const records = [];
      const seenUrls = new Set();
      const posters = new Set();
      for (const node of nodes) {
        const tag = safeText(safeProperty(node, "localName") || safeProperty(node, "tagName"), 20)
          .toLowerCase();
        if (tag !== "video") {
          continue;
        }
        const poster = mediaHttpUrl(
          safeProperty(node, "poster") || domAttribute(node, "poster"),
          route.pageUrl,
          "image"
        );
        if (poster) {
          posters.add(poster);
        }
      }
      for (const node of nodes) {
        const details = domMediaDetails(node);
        if (!details || seenUrls.has(details.url) ||
          details.mediaType === "image" && posters.has(details.url)) {
          continue;
        }
        seenUrls.add(details.url);
        records.push(details);
      }
      domMediaCache.set(root, records);
      return records;
    }

    function rootExactRouteStatus(root) {
      if (!root || (typeof root !== "object" && typeof root !== "function")) {
        return 0;
      }
      if (exactRouteStatusCache.has(root)) {
        return exactRouteStatusCache.get(root);
      }
      let sawExactPost = false;
      let sawOtherPost = false;
      for (const name of ["data-shortcode", "data-media-shortcode"]) {
        const shortcode = domAttribute(root, name);
        if (exactShortcodeMatches(shortcode)) {
          sawExactPost = true;
        } else {
          sawOtherPost = sawOtherPost || Boolean(shortcode);
        }
      }
      let anchors = [];
      try {
        anchors = Array.from(root.querySelectorAll("a[href]")).slice(0, 128);
      } catch (_error) {
        anchors = [];
      }
      for (const anchor of anchors) {
        const href = domAttribute(anchor, "href") || safeText(safeProperty(anchor, "href"), 16384);
        let linked = { kind: "unsupported" };
        try {
          linked = parseRoute(href ? new URL(href, route.pageUrl).href : "");
        } catch (_error) {
          linked = { kind: "unsupported" };
        }
        if ((linked.kind === "post" || linked.kind === "reel") &&
          exactShortcodeMatches(linked.shortcode)) {
          sawExactPost = true;
        } else if (linked.kind === "post" || linked.kind === "reel") {
          sawOtherPost = true;
        }
      }
      let status = 0;
      if (sawExactPost && sawOtherPost) {
        status = 2;
      } else if (sawExactPost) {
        status = 1;
      } else if (sawOtherPost) {
        status = -1;
      }
      exactRouteStatusCache.set(root, status);
      return status;
    }

    function processExactViewerDom() {
      if (exactStructuredPostComplete || !["post", "reel"].includes(route.kind)) {
        return;
      }
      const selectorGroups = [
        "[role=\"dialog\"] article",
        "[role=\"dialog\"]",
        "main article",
        "main",
        "article"
      ];
      let best = null;
      for (const selector of selectorGroups) {
        let roots = [];
        try {
          roots = Array.from(document.querySelectorAll(selector)).slice(0, 32);
        } catch (_error) {
          roots = [];
        }
        const candidates = [];
        let ambiguousNeutralRoot = false;
        for (const root of roots) {
          const rootRouteStatus = rootExactRouteStatus(root);
          let tracks = [];
          try {
            tracks = Array.from(root.querySelectorAll("ul")).slice(0, 64);
          } catch (_error) {
            tracks = [];
          }
          const rootCandidates = [];
          for (const candidate of tracks) {
            let routeStatus = rootExactRouteStatus(candidate);
            if (routeStatus === 0 && rootRouteStatus !== 2) {
              routeStatus = rootRouteStatus;
            }
            if (routeStatus === 2 || (rootRouteStatus === 2 && routeStatus === 0)) {
              continue;
            }
            const records = domMediaIn(candidate);
            if (!records.length) {
              continue;
            }
            const maxArea = Math.max(...records.map((item) => item.score || 0));
            const score = records.length * 1000000000000 + maxArea;
            rootCandidates.push({ records, score, routeStatus });
          }
          if (!rootCandidates.length && rootRouteStatus !== 2) {
            const records = domMediaIn(root);
            if (records.length) {
              const maxArea = Math.max(...records.map((item) => item.score || 0));
              rootCandidates.push({
                records,
                score: records.length * 1000000000000 + maxArea,
                routeStatus: rootRouteStatus
              });
            }
          }
          if (rootRouteStatus === 0 && rootCandidates.length !== 1) {
            ambiguousNeutralRoot = ambiguousNeutralRoot || rootCandidates.length > 1;
            continue;
          }
          if (rootRouteStatus === 2) {
            candidates.push(...rootCandidates);
            continue;
          }
          let bestForRoot = null;
          for (const candidate of rootCandidates) {
            if (!bestForRoot || candidate.score > bestForRoot.score) {
              bestForRoot = candidate;
            }
          }
          if (bestForRoot) {
            candidates.push(bestForRoot);
          }
        }
        const hasExactScope = candidates.some((item) => item.routeStatus === 1);
        const neutralCandidates = candidates.filter((item) => item.routeStatus === 0);
        if (!hasExactScope && (ambiguousNeutralRoot || neutralCandidates.length > 1)) {
          return;
        }
        let scoped = hasExactScope
          ? candidates.filter((item) => item.routeStatus === 1)
          : neutralCandidates;
        for (const candidate of scoped) {
          if (!best || candidate.score > best.score) {
            best = candidate;
          }
        }
        if (scoped.length) {
          break;
        }
      }
      if (!best) {
        return;
      }
      const membership = collectionMembershipFor({}, route, route.kind, "");
      const total = best.records.length;
      for (let index = 0; index < total; index += 1) {
        const item = best.records[index];
        const label = total > 1 ? `carousel ${index + 1}/${total}` : route.kind;
        addRecord(item.url, {
          previewUrl: item.previewUrl,
          alt: item.alt,
          width: item.width,
          height: item.height,
          mediaType: item.mediaType,
          identityKey: mediaIdentityForCollection({}, membership, index + 1),
          instagramCollections: membership ? [membership] : [],
          kinds: [`Instagram ${label} ${item.mediaType}`]
        });
      }
    }

    function profileAnchors() {
      if (profileAnchorCache) {
        return profileAnchorCache;
      }
      try {
        profileAnchorCache = Array.from(document.querySelectorAll("a[href]"))
          .slice(0, MAX_RELATED_LINKS * 16);
      } catch (_error) {
        profileAnchorCache = [];
      }
      return profileAnchorCache;
    }

    function profileGridPostRoute(anchor) {
      let href = "";
      try {
        href = instagramHttpUrl(anchor.getAttribute("href") || anchor.href, route.pageUrl);
      } catch (_error) {
        return null;
      }
      const postRoute = parseRoute(href);
      return ["post", "reel"].includes(postRoute.kind) && postRoute.shortcode &&
        (!postRoute.username || postRoute.username === route.username) ? postRoute : null;
    }

    function collectedProfilePostIds() {
      const ids = new Set();
      for (const record of found.values()) {
        for (const collection of record.instagramCollections) {
          if (collection.type === "post" && collection.owner === route.username) {
            ids.add(collection.id);
          }
        }
      }
      return ids;
    }

    function profilePostIsComplete(shortcode) {
      const post = profilePosts.get(shortcode);
      if (!post || !post.complete) return false;
      for (let index = 1; index <= post.count; index += 1) {
        if (!found.has(`identity:instagram:post:${route.username}:${shortcode}:${index}`)) return false;
      }
      return true;
    }

    function processProfileGridDom() {
      // Instagram can render a profile grid without exposing its feed data to
      // page-context API requests. Restrict this fallback to direct media in
      // canonical post/reel links, excluding avatars, highlight covers, and
      // navigation images. Fill gaps per post even when other lookups succeeded,
      // without replacing resolved media with a cropped cover or a reel poster.
      if (route.kind !== "profile" || !settings.includeProfilePosts) {
        return;
      }
      const visitedPosts = collectedProfilePostIds();
      for (const anchor of profileAnchors()) {
        if (itemLimitReached || payloadLimitReached) {
          break;
        }
        const postRoute = profileGridPostRoute(anchor);
        if (!postRoute || visitedPosts.has(postRoute.shortcode)) {
          continue;
        }
        const records = domMediaIn(anchor).filter((item) =>
          postRoute.kind !== "reel" || item.mediaType === "video"
        );
        if (!records.length) {
          continue;
        }
        visitedPosts.add(postRoute.shortcode);
        const membership = safeCollectionMembership({
          type: "post",
          id: postRoute.shortcode,
          title: "",
          owner: route.username
        });
        for (const item of records) {
          addRecord(item.url, {
            previewUrl: item.previewUrl,
            alt: item.alt,
            width: item.width,
            height: item.height,
            mediaType: item.mediaType,
            identityKey: mediaIdentityForCollection({}, membership, 1),
            instagramCollections: membership ? [membership] : [],
            kinds: [`Instagram visible profile ${postRoute.kind} ${item.mediaType}`]
          });
          if (itemLimitReached || payloadLimitReached) {
            break;
          }
        }
      }
    }

    async function collectProfileGridPosts() {
      if (route.kind !== "profile" || !settings.includeProfilePosts) {
        return;
      }
      const visitedPosts = new Set();
      const requests = [];
      function queuePost(shortcode, kind = "post") {
        const mediaId = mediaIdFromShortcode(shortcode);
        if (!mediaId || visitedPosts.has(shortcode) || profilePostIsComplete(shortcode)) {
          return;
        }
        visitedPosts.add(shortcode);
        requests.push({ shortcode, mediaId,
          endpoint: new URL(`/api/v1/media/${encodeURIComponent(mediaId)}/info/`, route.pageUrl).href,
          postUrl: new URL(`/${kind === "reel" ? "reel" : "p"}/${encodeURIComponent(shortcode)}/`,
            route.pageUrl).href });
      }
      for (const post of profilePosts.values()) {
        queuePost(post.shortcode, post.kind);
      }
      for (const anchor of profileAnchors()) {
        const postRoute = profileGridPostRoute(anchor);
        if (!postRoute) {
          continue;
        }
        let carousel = false;
        try {
          carousel = Array.from(anchor.querySelectorAll("[aria-label], title")).some((marker) =>
            /carousel/i.test(safeText(
              marker.getAttribute && marker.getAttribute("aria-label") || marker.textContent,
              100
            ))
          );
        } catch (_error) {
          carousel = false;
        }
        const shortcode = postRoute.shortcode;
        const known = profilePosts.get(shortcode);
        if (!known && profilePosts.size < settings.maxItems) {
          profilePosts.set(shortcode, { shortcode, count: carousel ? 0 : 1, carousel, complete: false });
        } else if (known && carousel && !known.carousel) {
          known.carousel = true;
          known.complete = false;
        }
        queuePost(shortcode, postRoute.kind);
      }

      function betterPostSource(candidate, current) {
        if (!current) return true;
        const candidateComplete = exactContainerIsComplete(candidate);
        const currentComplete = exactContainerIsComplete(current);
        if (candidateComplete !== currentComplete) return candidateComplete;
        const candidateChildren = childMedia(candidate);
        const currentChildren = childMedia(current);
        const available = (object, children) => children.length
          ? children.filter(hasDownloadableMedia).length : Number(hasDownloadableMedia(object));
        const candidateAvailable = available(candidate, candidateChildren);
        const currentAvailable = available(current, currentChildren);
        return candidateAvailable > currentAvailable || candidateAvailable === currentAvailable &&
          candidateChildren.length > currentChildren.length;
      }

      function exactPostFromHtml(html, request) {
        let best = null;
        let inspected = 0;
        const seen = new WeakSet();
        function walk(value, depth) {
          if (!value || depth > MAX_JSON_DEPTH || inspected >= 50000 ||
            best && exactContainerIsComplete(best) ||
            typeof value !== "object" || seen.has(value)) {
            return;
          }
          seen.add(value);
          inspected += 1;
          if (!Array.isArray(value) &&
            (objectIdentifier(value) === request.shortcode || objectId(value) === request.mediaId) &&
            ownerFromObject(value) === route.username) {
            const children = childMedia(value);
            if ((children.length || hasMediaShape(value) || imageVariants(value, request.postUrl).length) &&
              betterPostSource(value, best)) {
              best = value;
            }
          }
          const entries = Array.isArray(value) ? value.slice(0, 2048) : Object.values(value).slice(0, 512);
          for (const child of entries) {
            walk(child, depth + 1);
            if (best && exactContainerIsComplete(best)) break;
          }
        }
        for (const script of scriptsFromHtml(html)) {
          for (const value of parseJsonValues(script.text)) {
            walk(value, 0);
            if (best && exactContainerIsComplete(best)) break;
          }
          if (best && exactContainerIsComplete(best)) break;
        }
        return best;
      }
      async function fetchExactPost(request) {
        if (fetchedDocumentCount >= settings.maxDocuments || visitedDocuments.has(request.postUrl)) {
          documentLimitReached = true;
          return null;
        }
        visitedDocuments.add(request.postUrl);
        fetchedDocumentCount += 1;
        const fetched = await fetchHtmlDocument({ url: request.postUrl }, false, EXACT_FETCH_TIMEOUT_MS);
        const finalRoute = fetched && parseRoute(fetched.url);
        if (!fetched || !["post", "reel"].includes(finalRoute.kind) ||
          finalRoute.shortcode !== request.shortcode) {
          return null;
        }
        const item = exactPostFromHtml(fetched.text, request);
        return item ? { item, url: fetched.url } : null;
      }
      async function fetchPost(request) {
        let exact = null;
        const fetched = await fetchInstagramJson(
          request.endpoint, "profile-post", false, EXACT_FETCH_TIMEOUT_MS
        );
        const item = fetched && feedPageFrom(fetched.value).items.find((candidate) =>
          (objectIdentifier(candidate) === request.shortcode ||
          objectId(candidate) === request.mediaId) && ownerFromObject(candidate) === route.username
        );
        if (item) {
          exact = { item, url: fetched.url };
        }
        if (!exact || !exactContainerIsComplete(exact.item)) {
          const html = await fetchExactPost(request);
          if (html && betterPostSource(html.item, exact && exact.item)) {
            exact = html;
          }
        }
        return exact;
      }
      const availableDocuments = Math.max(0, settings.maxDocuments - fetchedDocumentCount);
      const boundedRequests = requests.slice(0, availableDocuments);
      if (boundedRequests.length < requests.length) {
        documentLimitReached = true;
      }
      const fetchedPosts = await mapWithConcurrency(
        boundedRequests,
        fetchPost,
        MAX_FETCH_CONCURRENCY
      );
      for (let index = 0; index < boundedRequests.length; index += 1) {
        const fetched = fetchedPosts[index];
        if (fetched) {
          addProfilePost(fetched.item, fetched.url, route.username);
        }
      }
    }

    function orderProfileCarouselRecords() {
      const entries = Array.from(found.entries());
      const groups = new Map();
      const prefix = `instagram:post:${route.username}:`;
      function groupFor(record) {
        const identity = safeText(record && record.identityKey, 300);
        if (!identity.startsWith(prefix)) return "";
        const separator = identity.lastIndexOf(":");
        return /^\d+$/.test(identity.slice(separator + 1))
          ? identity.slice(0, separator) : "";
      }
      for (const entry of entries) {
        const group = groupFor(entry[1]);
        if (group) {
          if (!groups.has(group)) groups.set(group, []);
          groups.get(group).push(entry);
        }
      }
      const ordered = [];
      const emitted = new Set();
      for (const entry of entries) {
        const group = groupFor(entry[1]);
        if (!group) {
          ordered.push(entry);
        } else if (!emitted.has(group)) {
          emitted.add(group);
          ordered.push(...groups.get(group).sort((left, right) =>
            Number(left[1].identityKey.slice(group.length + 1)) -
            Number(right[1].identityKey.slice(group.length + 1))
          ));
        }
      }
      found.clear();
      for (const [key, record] of ordered) found.set(key, record);
    }

    function profilePk() {
      return profilePks.values().next().value || "";
    }

    function feedPageFrom(value) {
      const candidates = [
        value,
        safeProperty(value, "data"),
        safeProperty(value, "feed"),
        safeProperty(safeProperty(value, "data"), "feed")
      ];
      for (const candidate of candidates) {
        if (!candidate || typeof candidate !== "object") {
          continue;
        }
        const items = objectList(safeProperty(candidate, "items"));
        if (!items.length && !Array.isArray(safeProperty(candidate, "items"))) {
          continue;
        }
        return {
          valid: true,
          items,
          paginationKnown: [true, false, 0, 1].includes(safeProperty(candidate, "more_available")) ||
            [true, false].includes(safeProperty(candidate, "moreAvailable")),
          moreAvailable: safeProperty(candidate, "more_available") === true ||
            safeProperty(candidate, "moreAvailable") === true ||
            Number(safeProperty(candidate, "more_available")) === 1,
          nextMaxId: safeText(
            safeProperty(candidate, "next_max_id") || safeProperty(candidate, "nextMaxId"),
            1000
          ).trim()
        };
      }
      return { valid: false, items: [], moreAvailable: false, nextMaxId: "" };
    }

    async function discoverProfilePk() {
      if (profilePk()) {
        return profilePk();
      }
      const endpoint = new URL("/api/v1/users/web_profile_info/", route.pageUrl);
      endpoint.searchParams.set("username", route.username);
      // This is the primary profile-data request, not a linked story or
      // highlight document. Do not report its rejection as a related page.
      const fetched = await fetchInstagramJson(endpoint.href, "profile-info", false);
      if (!fetched) {
        return "";
      }
      processJson(fetched.value, route, fetched.url, false);
      return profilePk();
    }

    async function collectProfileFeed(pk) {
      if (!settings.includeProfilePosts || !pk) {
        return false;
      }
      let maxId = "";
      const seenCursors = new Set();
      while (!itemLimitReached && !payloadLimitReached) {
        const endpoint = new URL(
          `/api/v1/feed/user/${encodeURIComponent(pk)}/`,
          route.pageUrl
        );
        endpoint.searchParams.set("count", "12");
        if (maxId) {
          endpoint.searchParams.set("max_id", maxId);
        }
        const fetched = await fetchInstagramJson(endpoint.href, "profile-feed", false);
        if (!fetched) {
          break;
        }
        const page = feedPageFrom(fetched.value);
        if (!page.valid) break;
        for (const item of page.items) {
          addProfilePost(item, fetched.url, route.username);
          if (itemLimitReached || payloadLimitReached) {
            break;
          }
        }
        const next = page.nextMaxId;
        if (!page.paginationKnown) return false;
        if (!page.moreAvailable) return !itemLimitReached && !payloadLimitReached;
        if (!next || seenCursors.has(next)) {
          break;
        }
        seenCursors.add(next);
        maxId = next;
      }
      return false;
    }

    async function collectProfileGraphql(kind, pk) {
      const reels = kind === "reels";
      if (reels && !pk) return false;
      const connectionKey = reels ? "xdt_api__v1__clips__user__connection_v2"
        : "xdt_api__v1__feed__user_timeline_graphql_connection";
      let after = "";
      const cursors = new Set();
      while (!itemLimitReached && !payloadLimitReached) {
        const variables = {
          data: reels
            ? { page_size: 12, include_feed_video: true, target_user_id: pk }
            : { count: 12, include_relationship_info: true,
              latest_besties_reel_media: true, latest_reel_media: true },
          first: 12, before: null, last: null,
          __relay_internal__pv__PolarisFeedShareMenurelayprovider: false
        };
        if (!reels) variables.username = route.username;
        if (after) variables.after = after;
        const fetched = await fetchInstagramJson(
          new URL("/graphql/query/", route.pageUrl).href,
          reels ? "profile-reels" : "profile-timeline", false, FETCH_TIMEOUT_MS,
          { docId: reels ? INSTAGRAM_REELS_QUERY_DOC_ID : INSTAGRAM_PROFILE_QUERY_DOC_ID, variables }
        );
        if (!fetched) return false;
        const connection = safeProperty(safeProperty(fetched.value, "data"), connectionKey);
        if (!Array.isArray(safeProperty(connection, "edges"))) return false;
        for (const node of timelineItems(connection)) {
          const item = reels ? safeProperty(node, "media") : node;
          // The reels connection can expose a shortcode and player sources
          // without its author. Resolve that exact post to verify ownership.
          const shortcode = objectIdentifier(item);
          const ownerPk = profilePkFromObject(safeProperty(item, "user") || safeProperty(item, "owner"));
          if (!ownerFromObject(item) && shortcode && (!ownerPk || !pk || ownerPk === pk) &&
            !profilePosts.has(shortcode) && profilePosts.size < settings.maxItems) {
            profilePosts.set(shortcode, {
              shortcode, count: 1, carousel: false, complete: false, kind: reels ? "reel" : "post"
            });
          }
          addProfilePost(item, fetched.url, route.username);
          if (itemLimitReached || payloadLimitReached) return false;
        }
        if (objectList(safeProperty(fetched.value, "errors")).length) return false;
        const page = safeProperty(connection, "page_info");
        if (safeProperty(page, "has_next_page") === false) return true;
        const cursor = safeText(safeProperty(page, "end_cursor"), 1000).trim();
        if (safeProperty(page, "has_next_page") !== true || !cursor || cursors.has(cursor)) return false;
        cursors.add(cursor);
        after = cursor;
      }
      return false;
    }

    async function fetchReelCollection(reelId, purpose) {
      const endpoint = new URL("/api/v1/feed/reels_media/", route.pageUrl);
      endpoint.searchParams.set("reel_ids", safeText(reelId, 200));
      return fetchInstagramJson(endpoint.href, purpose, false);
    }

    async function collectProfileStoriesAndHighlights(pk) {
      if (settings.includeHighlights && pk) {
        const trayEndpoint = new URL(
          `/api/v1/highlights/${encodeURIComponent(pk)}/highlights_tray/`,
          route.pageUrl
        );
        const tray = await fetchInstagramJson(trayEndpoint.href, "highlight-tray", false);
        if (tray) {
          processJson(tray.value, route, tray.url, false);
        }
      }

      const requests = [];
      if (settings.includeStories && pk) {
        requests.push({
          reelId: pk,
          purpose: "active-story",
          sourceRoute: {
            kind: "story",
            username: route.username,
            storyId: "",
            pageUrl: route.pageUrl
          }
        });
      }

      if (settings.includeHighlights) {
        for (const descriptor of highlightDescriptors.values()) {
          if (descriptor.owner && descriptor.owner !== route.username) {
            continue;
          }
          requests.push({
            reelId: `highlight:${descriptor.id}`,
            purpose: "highlight",
            sourceRoute: {
              kind: "highlight",
              username: route.username,
              highlightId: descriptor.id,
              collectionTitle: descriptor.title,
              pageUrl: route.pageUrl
            }
          });
        }
      }

      const availableDocuments = Math.max(0, settings.maxDocuments - fetchedDocumentCount);
      const boundedRequests = requests.slice(0, availableDocuments);
      if (boundedRequests.length < requests.length) {
        documentLimitReached = true;
      }
      const fetchedCollections = await mapWithConcurrency(
        boundedRequests,
        (request) => fetchReelCollection(request.reelId, request.purpose),
        MAX_FETCH_CONCURRENCY
      );
      for (let index = 0; index < boundedRequests.length; index += 1) {
        const fetched = fetchedCollections[index];
        if (fetched) {
          processJson(
            fetched.value,
            boundedRequests[index].sourceRoute,
            fetched.url,
            false
          );
        }
      }
    }

    processCurrentDocument();

    if (["story", "highlight"].includes(route.kind)) {
      processRuntimeData();
      if (needsStoryMetadata && Array.from(found.values()).some(item => item.mediaType === "video")) {
        const reelId = route.kind === "highlight"
          ? `highlight:${route.highlightId}` : await discoverProfilePk();
        if (reelId) {
          const fetched = await fetchReelCollection(reelId, "story-metadata");
          if (fetched) {
            processJson(fetched.value, route, fetched.url, false);
          }
        }
      }
    }

    if (route.kind === "post" || route.kind === "reel") {
      // SPA post modals do not replace the profile document's original
      // scripts. Recover the exact React item when exposed, otherwise request
      // only this canonical shortcode with the active Instagram session.
      processRuntimeData();
      await collectExactPostNetworkFallback();
      processExactViewerDom();
    }

    if (route.kind === "profile") {
      processRuntimeData();
      let pk = await discoverProfilePk();
      if (settings.includeProfilePosts) {
        profileTimelineComplete = await collectProfileFeed(pk);
        if (!profileTimelineComplete && !itemLimitReached && !payloadLimitReached) {
          profileTimelineComplete = await collectProfileGraphql("posts", pk);
        }
        pk = profilePk() || pk;
        if (settings.includeProfileReels) {
          profileReelsComplete = await collectProfileGraphql("reels", pk);
        }
      }
      await collectProfileGridPosts();
      processProfileGridDom();
      orderProfileCarouselRecords();
      if (settings.includeStories || settings.includeHighlights) {
        await collectProfileStoriesAndHighlights(pk);
      }
    }

    while (route.kind === "profile" &&
      (settings.includeStories || settings.includeHighlights) && queuedDocuments.length) {
      if (fetchedDocumentCount >= settings.maxDocuments) {
        documentLimitReached = true;
        break;
      }
      const entry = queuedDocuments.shift();
      queuedDocumentUrls.delete(entry.url);
      if (visitedDocuments.has(entry.url)) {
        continue;
      }
      visitedDocuments.add(entry.url);
      fetchedDocumentCount += 1;
      const fetched = await fetchHtmlDocument(entry, true);
      if (!fetched) {
        continue;
      }
      const fetchedRoute = parseRoute(fetched.url);
      const storyRouteMatches = entry.purpose === "story" &&
        fetchedRoute.kind === "story" &&
        fetchedRoute.username === entry.expectedUsername &&
        (!entry.expectedStoryId || !fetchedRoute.storyId ||
          fetchedRoute.storyId === entry.expectedStoryId);
      const highlightRouteMatches = entry.purpose === "highlight" &&
        fetchedRoute.kind === "highlight" &&
        fetchedRoute.highlightId === entry.expectedHighlightId;
      if (!storyRouteMatches && !highlightRouteMatches) {
        inaccessibleRelatedCount += 1;
        continue;
      }
      const relatedRoute = Object.assign({}, fetchedRoute, {
        username: entry.expectedOwner || fetchedRoute.username || ""
      });
      const added = processScripts(scriptsFromHtml(fetched.text), relatedRoute, fetched.url);
      if (!added) {
        addMetaFallback(metaMapFromHtml(fetched.text), relatedRoute, fetched.url, relatedRoute.kind);
      }
      discoverRelatedLinks(linksFromHtml(fetched.text, fetched.url), relatedRoute);
    }

    if (itemLimitReached) {
      warnings.add(`Instagram collection reached the ${settings.maxItems.toLocaleString()}-item safety limit.`);
    }
    if (payloadLimitReached) {
      warnings.add("Some Instagram media were skipped because their combined URL data exceeded the 2 MB safety limit.");
    }
    if (documentLimitReached) {
      warnings.add("Instagram collection stopped at its bounded document or response-size safety limit.");
    }
    if (jsonNodeLimitReached) {
      warnings.add("Instagram structured data reached its bounded traversal safety limit; results may be partial.");
    }
    const incompleteProfilePosts = Array.from(profilePosts.keys()).filter((id) => !profilePostIsComplete(id));
    const profileVideosResolved = route.kind === "profile" && settings.includeProfilePosts &&
      !settings.includeStories && !settings.includeHighlights && profilePosts.size > 0 &&
      !incompleteProfilePosts.length;
    if (unsupportedVideoCount && !profileVideosResolved) {
      warnings.add(
        `${unsupportedVideoCount.toLocaleString()} Instagram video source${unsupportedVideoCount === 1 ? " was" : "s were"} skipped because no direct progressive HTTP(S) file was exposed.`
      );
    }
    if (inaccessibleRelatedCount) {
      warnings.add(
        `${inaccessibleRelatedCount.toLocaleString()} related Instagram page${inaccessibleRelatedCount === 1 ? " was" : "s were"} unavailable to the current browser session.`
      );
    }
    let profileCollection = null;
    if (route.kind === "profile" && settings.includeProfilePosts) {
      if (!profileTimelineComplete) {
        warnings.add("Instagram profile collection is incomplete: the full post history could not be read.");
      }
      if (!profileReelsComplete) {
        warnings.add("Instagram profile collection is incomplete: the full reels history could not be read.");
      }
      if (incompleteProfilePosts.length) {
        warnings.add(`Instagram could not resolve every slide or direct video in ${incompleteProfilePosts.length} profile post(s).`);
      }
      profileCollection = {
        username: route.username,
        posts: collectedProfilePostIds().size,
        complete: profileTimelineComplete && profileReelsComplete && !incompleteProfilePosts.length &&
          !itemLimitReached && !payloadLimitReached && !documentLimitReached && !jsonNodeLimitReached
      };
    }
    if (!found.size) {
      let label = `${route.kind} media`;
      if (route.kind === "profile") {
        const requested = [];
        if (settings.includeProfilePosts) {
          requested.push("profile posts");
        }
        if (settings.includeStories) {
          requested.push("active story media");
        }
        if (settings.includeHighlights) {
          requested.push("highlight media");
        }
        label = requested.length ? requested.join(", ") : "profile media";
      }
      warnings.add(
        `Instagram did not expose downloadable ${label} to the current browser session; it may be private, restricted, expired, or stream-only.`
      );
    }

    return {
      handled: true,
      pageUrl: route.pageUrl,
      pageTitle,
      embeddedFrameCount: 0,
      images: Array.from(found.values()),
      warnings: Array.from(warnings),
      profileCollection
    };
  }

  const api = Object.freeze({
    isInstagramUrl,
    canCollectRelated,
    routeKeyForUrl,
    collectFromPage
  });
  root.ImageDownloaderInstagram = api;
  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
  }
})(typeof globalThis === "object" ? globalThis : this);
