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
    const INSTAGRAM_WEB_APP_ID = "936619743392459";
    const MAX_COLLECTION_MEMBERSHIPS = 16;
    const warnings = new Set();
    const found = new Map();
    const owners = new Set();
    const profilePks = new Set();
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
    let inaccessibleRelatedCount = 0;

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
      try {
        if (typeof TextEncoder === "function") {
          return new TextEncoder().encode(text).byteLength;
        }
      } catch (_error) {
        // UTF-16 length is a conservative-enough fallback for bounding page data.
      }
      return text.length;
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
      const direct = usernameFrom(object);
      if (direct) {
        return direct;
      }
      for (const key of ["owner", "user", "owner_user", "author"]) {
        const owner = safeProperty(object, key);
        const username = usernameFrom(owner) || safeText(safeProperty(owner, "alternateName"), 80)
          .replace(/^@/, "").toLowerCase();
        if (/^[a-z0-9._]{1,80}$/i.test(username)) {
          return username;
        }
      }
      return "";
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
          safeProperty(object, "userId") || safeProperty(object, "id")
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
      const dimensions = safeProperty(object, "dimensions");
      return {
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
        ["display_url", 60], ["displayUrl", 60], ["image_url", 55], ["imageUrl", 55],
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

    function addRecord(url, details) {
      if (!url) {
        return;
      }
      const existing = found.get(url);
      if (existing) {
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
        previewUrl,
        sourceProvider: "instagram",
        alt: safeText(details.alt, 500),
        width: Math.max(0, Number(details.width) || 0),
        height: Math.max(0, Number(details.height) || 0),
        kinds: (details.kinds || ["Instagram media"]).map((kind) => safeText(kind, 50)).slice(0, 8),
        instagramCollections: [],
        mediaType: details.mediaType === "video" ? "video" : "image"
      };
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
      found.set(url, record);
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
      const mediaType = isVideoObject(object, videoOptions) ? "video" : "image";
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
          mediaType: "video"
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
        mediaType: "image"
      });
    }

    function childMedia(object) {
      const sidecar = safeProperty(object, "edge_sidecar_to_children");
      const sidecarEdges = objectList(safeProperty(sidecar, "edges"))
        .map((edge) => safeProperty(edge, "node"))
        .filter((item) => item && typeof item === "object");
      if (sidecarEdges.length) {
        return sidecarEdges;
      }
      for (const key of ["carousel_media", "carouselMedia"] ) {
        const carousel = objectList(safeProperty(object, key));
        if (carousel.length) {
          return carousel;
        }
      }
      const children = safeProperty(object, "children");
      if (Array.isArray(children)) {
        const list = objectList(children);
        if (list.length) {
          return list;
        }
      }
      const childEdges = objectList(safeProperty(children, "edges"))
        .map((edge) => safeProperty(edge, "node"))
        .filter((item) => item && typeof item === "object");
      return childEdges;
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
          candidateRoute.shortcode === expectedRoute.shortcode) {
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
        safeProperty(object, "display_url") || safeProperty(object, "image_versions2") ||
        safeProperty(object, "video_url") || safeProperty(object, "video_versions") ||
        safeProperty(object, "edge_sidecar_to_children") || safeProperty(object, "carousel_media") ||
        safeProperty(object, "contentUrl") || safeProperty(object, "content_url")
      );
    }

    function postMatches(object, parentKey, sourceRoute, baseUrl, trustedLdRoot) {
      const identifier = objectIdentifier(object);
      if (identifier) {
        return identifier === sourceRoute.shortcode;
      }
      if (["shortcode_media", "xdt_shortcode_media"].includes(parentKey) && hasMediaShape(object)) {
        return true;
      }
      return objectUrlMatches(object, sourceRoute, baseUrl) ||
        (trustedLdRoot && hasMediaShape(object));
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
      const id = objectIdentifier(object) || objectId(object);
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
      if (usernameFrom(object) !== expectedUsername) {
        return;
      }
      registerMatchingProfile(object, expectedUsername);
      if (!settings.includeProfilePosts) {
        return;
      }
      for (const key of [
        "edge_owner_to_timeline_media", "edgeOwnerToTimelineMedia",
        "timeline_media", "timelineMedia"
      ]) {
        for (const item of timelineItems(safeProperty(object, key))) {
          addProfilePost(item, baseUrl, expectedUsername);
        }
      }
    }

    function processJson(rootValue, sourceRoute, baseUrl, trustedLdRoot) {
      let visitedNodes = 0;
      const seen = typeof WeakSet === "function" ? new WeakSet() : null;
      const processedContainers = typeof WeakSet === "function" ? new WeakSet() : null;

      function processContainer(object, parentKey, depth, isRoot) {
        registerHighlightObject(object, parentKey, sourceRoute.username || route.username);
        let matched = false;
        let kind = sourceRoute.kind;
        let forceItems = false;
        if (sourceRoute.kind === "post" || sourceRoute.kind === "reel") {
          matched = postMatches(object, parentKey, sourceRoute, baseUrl, trustedLdRoot && isRoot);
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
          addMediaContainer(object, baseUrl, kind, forceItems, sourceRoute);
        }
        if (depth >= MAX_JSON_DEPTH) {
          return;
        }
      }

      function walk(value, depth, parentKey, isRoot) {
        if (jsonNodeLimitReached || depth > MAX_JSON_DEPTH || value == null) {
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

    function balancedJsonAt(text, start) {
      const opening = text[start];
      if (opening !== "{" && opening !== "[") {
        return null;
      }
      const stack = [opening];
      let quoted = false;
      let escaped = false;
      for (let index = start + 1; index < text.length; index += 1) {
        const character = text[index];
        if (quoted) {
          if (escaped) {
            escaped = false;
          } else if (character === "\\") {
            escaped = true;
          } else if (character === '"') {
            quoted = false;
          }
          continue;
        }
        if (character === '"') {
          quoted = true;
          continue;
        }
        if (character === "{" || character === "[") {
          stack.push(character);
        } else if (character === "}" || character === "]") {
          const expected = character === "}" ? "{" : "[";
          if (stack[stack.length - 1] !== expected) {
            return null;
          }
          stack.pop();
          if (!stack.length) {
            return { text: text.slice(start, index + 1), end: index + 1 };
          }
        }
      }
      return null;
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
      let attempts = 0;
      for (let index = 0; index < text.length && attempts < MAX_JSON_VALUES_PER_SCRIPT; index += 1) {
        if (text[index] !== "{" && text[index] !== "[") {
          continue;
        }
        attempts += 1;
        const balanced = balancedJsonAt(text, index);
        if (!balanced) {
          continue;
        }
        try {
          values.push(JSON.parse(balanced.text));
          index = balanced.end - 1;
        } catch (_error) {
          // Move one character and try a nested object in the invalid wrapper.
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
      if (canonical) {
        const canonicalRoute = parseRoute(canonical);
        const samePost = (sourceRoute.kind === "post" || sourceRoute.kind === "reel") &&
          canonicalRoute.shortcode === sourceRoute.shortcode;
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
      if (video) {
        addRecord(video, {
          previewUrl: image,
          alt,
          width,
          height,
          mediaType: "video",
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
          instagramCollections: membership ? [membership] : [],
          kinds: [`Instagram ${collectionKind} image`]
        });
      }
    }

    function currentScripts() {
      let scripts = [];
      try {
        scripts = Array.from(document.querySelectorAll("script")).slice(0, MAX_SCRIPTS_PER_DOCUMENT);
      } catch (_error) {
        scripts = [];
      }
      return scripts.map((script) => {
        try {
          return {
            type: safeText(script.getAttribute && script.getAttribute("type"), 100).toLowerCase(),
            text: safeText(script.textContent || script.innerText, settings.maxDocumentBytes)
          };
        } catch (_error) {
          return { type: "", text: "" };
        }
      });
    }

    function scriptsFromHtml(html) {
      const scripts = [];
      const pattern = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
      let match;
      while ((match = pattern.exec(html)) && scripts.length < MAX_SCRIPTS_PER_DOCUMENT) {
        scripts.push({
          type: attributeValue(match[1], "type").toLowerCase(),
          text: safeText(match[2], settings.maxDocumentBytes)
        });
      }
      return scripts;
    }

    function currentLinks() {
      const links = [];
      let anchors = [];
      try {
        anchors = Array.from(document.querySelectorAll("a[href]")).slice(0, MAX_RELATED_LINKS * 8);
      } catch (_error) {
        anchors = [];
      }
      for (const anchor of anchors) {
        try {
          const url = instagramHttpUrl(anchor.getAttribute("href") || anchor.href, route.pageUrl);
          if (url && !links.includes(url)) {
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
      const pattern = /<a\b([^>]*)>/gi;
      let match;
      while ((match = pattern.exec(html)) && links.length < MAX_RELATED_LINKS) {
        const url = instagramHttpUrl(
          decodeHtmlAttribute(attributeValue(match[1], "href")),
          baseUrl
        );
        if (url && !links.includes(url)) {
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
      }
      discoverRelatedLinks(currentLinks(), route);
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

    async function fetchRelatedDocument(entry) {
      if (typeof fetch !== "function") {
        inaccessibleRelatedCount += 1;
        return null;
      }
      let controller = null;
      let timer = null;
      try {
        controller = typeof AbortController === "function" ? new AbortController() : null;
        if (controller && typeof setTimeout === "function") {
          timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
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
          inaccessibleRelatedCount += 1;
          return null;
        }
        const finalUrl = instagramHttpUrl(response.url || entry.url, entry.url);
        if (!finalUrl) {
          inaccessibleRelatedCount += 1;
          return null;
        }
        const contentType = safeText(
          response.headers && response.headers.get && response.headers.get("content-type"),
          200
        ).toLowerCase();
        if (contentType && !/(?:text\/html|application\/xhtml\+xml)/.test(contentType)) {
          inaccessibleRelatedCount += 1;
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
        inaccessibleRelatedCount += 1;
        return null;
      } finally {
        if (timer !== null && typeof clearTimeout === "function") {
          clearTimeout(timer);
        }
      }
    }

    async function fetchInstagramJson(rawUrl, purpose) {
      const url = instagramHttpUrl(rawUrl, route.pageUrl);
      if (!url || visitedDocuments.has(url)) {
        return null;
      }
      if (fetchedDocumentCount >= settings.maxDocuments) {
        documentLimitReached = true;
        return null;
      }
      if (typeof fetch !== "function") {
        inaccessibleRelatedCount += 1;
        return null;
      }
      visitedDocuments.add(url);
      fetchedDocumentCount += 1;
      let controller = null;
      let timer = null;
      try {
        controller = typeof AbortController === "function" ? new AbortController() : null;
        if (controller && typeof setTimeout === "function") {
          timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        }
        const response = await fetch(url, {
          method: "GET",
          credentials: "include",
          cache: "no-store",
          redirect: "follow",
          signal: controller ? controller.signal : undefined,
          headers: {
            Accept: "application/json",
            "X-IG-App-ID": INSTAGRAM_WEB_APP_ID
          }
        });
        if (!response || !response.ok) {
          inaccessibleRelatedCount += 1;
          return null;
        }
        const finalUrl = instagramHttpUrl(response.url || url, url);
        if (!finalUrl) {
          inaccessibleRelatedCount += 1;
          return null;
        }
        const contentType = safeText(
          response.headers && response.headers.get && response.headers.get("content-type"),
          200
        ).toLowerCase();
        if (contentType && !/(?:application|text)\/[^;]*json/.test(contentType)) {
          inaccessibleRelatedCount += 1;
          return null;
        }
        const body = await readResponseText(response);
        if (!body.ok) {
          documentLimitReached = documentLimitReached || body.tooLarge;
          return null;
        }
        totalDocumentBytes += body.bytes || byteLength(body.text);
        try {
          return {
            url: finalUrl,
            purpose: safeText(purpose, 40),
            value: JSON.parse(body.text)
          };
        } catch (_error) {
          inaccessibleRelatedCount += 1;
          return null;
        }
      } catch (_error) {
        inaccessibleRelatedCount += 1;
        return null;
      } finally {
        if (timer !== null && typeof clearTimeout === "function") {
          clearTimeout(timer);
        }
      }
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
          items,
          moreAvailable: safeProperty(candidate, "more_available") === true ||
            safeProperty(candidate, "moreAvailable") === true ||
            Number(safeProperty(candidate, "more_available")) === 1,
          nextMaxId: safeText(
            safeProperty(candidate, "next_max_id") || safeProperty(candidate, "nextMaxId"),
            1000
          ).trim()
        };
      }
      return { items: [], moreAvailable: false, nextMaxId: "" };
    }

    async function discoverProfilePk() {
      if (profilePk()) {
        return profilePk();
      }
      const endpoint = new URL("/api/v1/users/web_profile_info/", route.pageUrl);
      endpoint.searchParams.set("username", route.username);
      const fetched = await fetchInstagramJson(endpoint.href, "profile-info");
      if (!fetched) {
        return "";
      }
      processJson(fetched.value, route, fetched.url, false);
      return profilePk();
    }

    async function collectProfileFeed(pk) {
      if (!settings.includeProfilePosts || !pk) {
        return;
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
        const fetched = await fetchInstagramJson(endpoint.href, "profile-feed");
        if (!fetched) {
          break;
        }
        const page = feedPageFrom(fetched.value);
        for (const item of page.items) {
          addProfilePost(item, fetched.url, route.username);
          if (itemLimitReached || payloadLimitReached) {
            break;
          }
        }
        const next = page.nextMaxId;
        if (!page.moreAvailable || !next || seenCursors.has(next)) {
          break;
        }
        seenCursors.add(next);
        maxId = next;
      }
    }

    async function fetchReelCollection(reelId, sourceRoute, purpose) {
      const endpoint = new URL("/api/v1/feed/reels_media/", route.pageUrl);
      endpoint.searchParams.set("reel_ids", safeText(reelId, 200));
      const fetched = await fetchInstagramJson(endpoint.href, purpose);
      if (fetched) {
        processJson(fetched.value, sourceRoute, fetched.url, false);
      }
    }

    async function collectProfileStoriesAndHighlights(pk) {
      if (settings.includeHighlights && pk) {
        const trayEndpoint = new URL(
          `/api/v1/highlights/${encodeURIComponent(pk)}/highlights_tray/`,
          route.pageUrl
        );
        const tray = await fetchInstagramJson(trayEndpoint.href, "highlight-tray");
        if (tray) {
          processJson(tray.value, route, tray.url, false);
        }
      }

      if (settings.includeStories && pk) {
        await fetchReelCollection(pk, {
          kind: "story",
          username: route.username,
          storyId: "",
          pageUrl: route.pageUrl
        }, "active-story");
      }

      if (settings.includeHighlights) {
        for (const descriptor of highlightDescriptors.values()) {
          if (descriptor.owner && descriptor.owner !== route.username) {
            continue;
          }
          if (fetchedDocumentCount >= settings.maxDocuments) {
            documentLimitReached = true;
            break;
          }
          await fetchReelCollection(`highlight:${descriptor.id}`, {
            kind: "highlight",
            username: route.username,
            highlightId: descriptor.id,
            collectionTitle: descriptor.title,
            pageUrl: route.pageUrl
          }, "highlight");
        }
      }
    }

    processCurrentDocument();

    if (route.kind === "profile") {
      const pk = await discoverProfilePk();
      await collectProfileFeed(pk);
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
      const fetched = await fetchRelatedDocument(entry);
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
    if (unsupportedVideoCount) {
      warnings.add(
        `${unsupportedVideoCount.toLocaleString()} Instagram video source${unsupportedVideoCount === 1 ? " was" : "s were"} skipped because no direct progressive HTTP(S) file was exposed.`
      );
    }
    if (inaccessibleRelatedCount) {
      warnings.add(
        `${inaccessibleRelatedCount.toLocaleString()} related Instagram page${inaccessibleRelatedCount === 1 ? " was" : "s were"} unavailable to the current browser session.`
      );
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
      warnings: Array.from(warnings)
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
