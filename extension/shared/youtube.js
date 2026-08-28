(function attachAnyDownloadYouTube(root) {
  "use strict";

  const YOUTUBE_HOST_PATTERN = /(?:^|\.)(?:youtube\.com|youtube-nocookie\.com)$/i;
  const SHORT_HOST_PATTERN = /(?:^|\.)youtu\.be$/i;
  const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

  function isYouTubeUrl(rawUrl) {
    try {
      const parsed = new URL(String(rawUrl || ""));
      return ["http:", "https:"].includes(parsed.protocol) &&
        (YOUTUBE_HOST_PATTERN.test(parsed.hostname) || SHORT_HOST_PATTERN.test(parsed.hostname));
    } catch (_error) {
      return false;
    }
  }

  /*
   * This function is intentionally self-contained. Firefox serializes `func`
   * values passed to scripting.executeScript, so it cannot depend on helpers in
   * this module's outer scope when it runs in a YouTube tab.
   *
   * It only accepts URLs that YouTube already returned in a format's `url`
   * field. It never evaluates player JavaScript, deciphers signatureCipher,
   * requests a DRM licence, or reconstructs SABR/HLS/DASH streams.
   */
  async function collectYouTubeMediaFromPage(options) {
    const settings = Object.assign({
      includeVideoOnly: false,
      maxFormats: 24,
      maxPayloadLength: 2000000,
      maxResponses: 8,
      maxScripts: 160,
      maxScriptBytes: 4000000,
      maxTotalScriptBytes: 12000000,
      maxResponseBytes: 8000000,
      requestPlayerApi: true,
      requestTimeoutMs: 8000
    }, options || {});
    const youtubeHostPattern = /(?:^|\.)(?:youtube\.com|youtube-nocookie\.com)$/i;
    const shortHostPattern = /(?:^|\.)youtu\.be$/i;
    const videoIdPattern = /^[A-Za-z0-9_-]{11}$/;
    const googleVideoHostPattern = /(?:^|\.)googlevideo\.com$/i;
    const posterHostPattern = /(?:^|\.)(?:ytimg\.com|ggpht\.com|googleusercontent\.com)$/i;
    const supportedVideoMimeTypes = new Map([
      ["video/mp4", "mp4"],
      ["video/webm", "webm"]
    ]);
    const pageUrl = String(
      settings.pageUrl ||
      (typeof location === "object" && location && location.href) ||
      ""
    ).slice(0, 16384);
    const pageTitle = String(
      settings.pageTitle ||
      (typeof document === "object" && document && document.title) ||
      ""
    ).slice(0, 300);
    const warnings = [];

    function boundedInteger(value, fallback, minimum, maximum) {
      const number = Number(value);
      if (!Number.isFinite(number)) {
        return fallback;
      }
      return Math.min(maximum, Math.max(minimum, Math.floor(number)));
    }

    const maxFormats = boundedInteger(settings.maxFormats, 24, 1, 128);
    const maxPayloadLength = boundedInteger(settings.maxPayloadLength, 2000000, 1024, 4000000);
    const maxResponses = boundedInteger(settings.maxResponses, 8, 1, 24);
    const maxScripts = boundedInteger(settings.maxScripts, 160, 0, 500);
    const maxScriptBytes = boundedInteger(settings.maxScriptBytes, 4000000, 1000, 8000000);
    const maxTotalScriptBytes = boundedInteger(
      settings.maxTotalScriptBytes,
      12000000,
      1000,
      24000000
    );
    const maxResponseBytes = boundedInteger(settings.maxResponseBytes, 8000000, 1000, 16000000);
    const requestTimeoutMs = boundedInteger(settings.requestTimeoutMs, 8000, 1000, 15000);

    function parsedPageUrl() {
      try {
        const parsed = new URL(pageUrl);
        if (!["http:", "https:"].includes(parsed.protocol)) {
          return null;
        }
        if (!youtubeHostPattern.test(parsed.hostname) && !shortHostPattern.test(parsed.hostname)) {
          return null;
        }
        return parsed;
      } catch (_error) {
        return null;
      }
    }

    const parsedPage = parsedPageUrl();
    if (!parsedPage) {
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
      return String(value == null ? "" : value).slice(0, maximum);
    }

    function own(object, key) {
      return Boolean(object && typeof object === "object" &&
        Object.prototype.hasOwnProperty.call(object, key));
    }

    function safeObjectProperty(object, key) {
      if (!own(object, key)) {
        return undefined;
      }
      try {
        return object[key];
      } catch (_error) {
        return undefined;
      }
    }

    function validVideoId(value) {
      const id = safeText(value, 32).trim();
      return videoIdPattern.test(id) ? id : "";
    }

    function videoIdFromUrl(urlObject) {
      const queryId = validVideoId(urlObject.searchParams.get("v"));
      if (queryId) {
        return queryId;
      }
      const parts = urlObject.pathname.split("/").filter(Boolean);
      if (shortHostPattern.test(urlObject.hostname)) {
        return validVideoId(parts[0]);
      }
      if (["embed", "live", "shorts", "v"].includes(String(parts[0] || "").toLowerCase())) {
        return validVideoId(parts[1]);
      }
      return "";
    }

    function parseJsonValueAt(text, position) {
      let cursor = position;
      while (cursor < text.length && /[\s:=]/.test(text[cursor])) {
        cursor += 1;
      }
      if (text[cursor] === "'") {
        return null;
      }
      if (text[cursor] === '"') {
        let escaped = false;
        for (let index = cursor + 1; index < text.length; index += 1) {
          const character = text[index];
          if (escaped) {
            escaped = false;
          } else if (character === "\\") {
            escaped = true;
          } else if (character === '"') {
            try {
              const stringValue = JSON.parse(text.slice(cursor, index + 1));
              return typeof stringValue === "string" ? JSON.parse(stringValue) : null;
            } catch (_error) {
              return null;
            }
          }
        }
        return null;
      }
      if (text[cursor] !== "{") {
        return null;
      }

      let depth = 0;
      let quote = "";
      let escaped = false;
      for (let index = cursor; index < text.length; index += 1) {
        const character = text[index];
        if (quote) {
          if (escaped) {
            escaped = false;
          } else if (character === "\\") {
            escaped = true;
          } else if (character === quote) {
            quote = "";
          }
          continue;
        }
        if (character === '"') {
          quote = character;
        } else if (character === "{") {
          depth += 1;
        } else if (character === "}") {
          depth -= 1;
          if (depth === 0) {
            try {
              return JSON.parse(text.slice(cursor, index + 1));
            } catch (_error) {
              return null;
            }
          }
        }
      }
      return null;
    }

    function responsesFromScripts() {
      if (typeof document !== "object" || !document ||
        typeof document.querySelectorAll !== "function" || maxScripts === 0) {
        return [];
      }
      let scripts;
      try {
        scripts = Array.from(document.querySelectorAll("script")).slice(0, maxScripts);
      } catch (_error) {
        return [];
      }
      const responses = [];
      const markers = ["ytInitialPlayerResponse", '"PLAYER_RESPONSE"', '"playerResponse"'];
      let totalBytes = 0;
      for (const script of scripts) {
        if (responses.length >= maxResponses || totalBytes >= maxTotalScriptBytes) {
          break;
        }
        let text = "";
        try {
          text = typeof script.textContent === "string" ? script.textContent : "";
        } catch (_error) {
          text = "";
        }
        if (!text || text.length > maxScriptBytes || totalBytes + text.length > maxTotalScriptBytes) {
          continue;
        }
        totalBytes += text.length;
        for (const marker of markers) {
          let offset = 0;
          while (responses.length < maxResponses) {
            const markerIndex = text.indexOf(marker, offset);
            if (markerIndex < 0) {
              break;
            }
            offset = markerIndex + marker.length;
            const response = parseJsonValueAt(text, offset);
            if (response && typeof response === "object") {
              responses.push(response);
              break;
            }
          }
        }
      }
      return responses;
    }

    function directPageResponses() {
      const responses = [];
      const supplied = Array.isArray(settings.playerResponses) ? settings.playerResponses : [];
      for (const response of supplied.slice(0, maxResponses)) {
        if (response && typeof response === "object") {
          responses.push(response);
        }
      }
      if (responses.length >= maxResponses) {
        return responses;
      }

      try {
        const globalResponse = safeObjectProperty(globalThis, "ytInitialPlayerResponse");
        if (globalResponse && typeof globalResponse === "object") {
          responses.push(globalResponse);
        }
      } catch (_error) {
        // The normal extension isolated world does not expose page globals.
      }

      if (responses.length < maxResponses && typeof document === "object" && document) {
        try {
          const player = typeof document.getElementById === "function"
            ? document.getElementById("movie_player")
            : null;
          if (player && typeof player.getPlayerResponse === "function") {
            const response = player.getPlayerResponse();
            if (response && typeof response === "object") {
              responses.push(response);
            }
          }
        } catch (_error) {
          // Script parsing and the public-player request remain available.
        }
      }

      for (const response of responsesFromScripts()) {
        if (responses.length >= maxResponses) {
          break;
        }
        responses.push(response);
      }
      return responses.slice(0, maxResponses);
    }

    function normalizedMimeType(rawValue) {
      const mimeType = safeText(rawValue, 200).split(";", 1)[0].trim().toLowerCase();
      return supportedVideoMimeTypes.has(mimeType) ? mimeType : "";
    }

    function directFormatUrl(rawValue) {
      const value = typeof rawValue === "string" ? rawValue.trim() : "";
      if (!value || value.length > 16384) {
        return "";
      }
      try {
        const parsed = new URL(value);
        if (parsed.protocol !== "https:" || !googleVideoHostPattern.test(parsed.hostname)) {
          return "";
        }
        return value;
      } catch (_error) {
        return "";
      }
    }

    function safePosterUrl(rawValue) {
      const value = typeof rawValue === "string" ? rawValue.trim() : "";
      if (!value || value.length > 16384) {
        return "";
      }
      try {
        const parsed = new URL(value);
        return parsed.protocol === "https:" && posterHostPattern.test(parsed.hostname)
          ? value
          : "";
      } catch (_error) {
        return "";
      }
    }

    function largestPoster(response) {
      const videoDetails = safeObjectProperty(response, "videoDetails");
      const thumbnail = safeObjectProperty(videoDetails, "thumbnail");
      const thumbnails = safeObjectProperty(thumbnail, "thumbnails");
      if (!Array.isArray(thumbnails)) {
        return "";
      }
      let best = null;
      for (const candidate of thumbnails.slice(0, 20)) {
        const url = safePosterUrl(safeObjectProperty(candidate, "url"));
        if (!url) {
          continue;
        }
        const area = Math.max(0, Number(safeObjectProperty(candidate, "width")) || 0) *
          Math.max(0, Number(safeObjectProperty(candidate, "height")) || 0);
        if (!best || area > best.area) {
          best = { url, area };
        }
      }
      return best ? best.url : "";
    }

    function responseMetadata(response, fallback) {
      const details = safeObjectProperty(response, "videoDetails");
      const microformat = safeObjectProperty(response, "microformat");
      const playerMicroformat = safeObjectProperty(microformat, "playerMicroformatRenderer");
      const title = safeText(
        safeObjectProperty(details, "title") ||
        safeObjectProperty(playerMicroformat, "title") &&
          safeObjectProperty(safeObjectProperty(playerMicroformat, "title"), "simpleText") ||
        fallback.title,
        300
      ).trim();
      const duration = Number(safeObjectProperty(details, "lengthSeconds"));
      return {
        title: title || fallback.title,
        videoId: validVideoId(safeObjectProperty(details, "videoId")) || fallback.videoId,
        duration: Number.isFinite(duration) && duration > 0 ? duration : fallback.duration,
        posterUrl: largestPoster(response) || fallback.posterUrl
      };
    }

    function codecsContainAudio(rawMimeType) {
      return /(?:mp4a|opus|vorbis|aac|ac-3|ec-3)/i.test(safeText(rawMimeType, 300));
    }

    function hasProtectedMetadata(format) {
      return Boolean(
        safeObjectProperty(format, "drmFamilies") ||
        safeObjectProperty(format, "drmTrackType") ||
        safeObjectProperty(format, "licenseInfos") ||
        safeObjectProperty(format, "licenseInfo") ||
        safeObjectProperty(format, "keyUri")
      );
    }

    function cleanFilenamePart(value, fallback, maximum) {
      const cleaned = safeText(value, maximum * 2)
        .normalize("NFKC")
        .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, "_")
        .replace(/\s+/g, " ")
        .replace(/[. ]+$/g, "")
        .trim();
      return (cleaned || fallback).slice(0, maximum).replace(/[. ]+$/g, "") || fallback;
    }

    function suggestedFilename(metadata, candidate) {
      const extension = supportedVideoMimeTypes.get(candidate.mimeType) || "mp4";
      const title = cleanFilenamePart(metadata.title, metadata.videoId || "YouTube video", 72);
      const descriptors = [];
      if (candidate.qualityLabel) {
        descriptors.push(cleanFilenamePart(candidate.qualityLabel, "", 20));
      }
      if (candidate.fps > 30) {
        descriptors.push(`${candidate.fps}fps`);
      }
      if (!candidate.hasAudio) {
        descriptors.push("video-only");
      }
      if (!descriptors.length && candidate.itag) {
        descriptors.push(`itag-${candidate.itag}`);
      }
      return `${title}${descriptors.length ? ` - ${descriptors.join(" ")}` : ""}.${extension}`;
    }

    const counters = {
      ciphered: 0,
      directRejected: 0,
      sabr: 0,
      videoOnlyDirect: 0
    };
    const candidateByKey = new Map();
    let metadata = {
      title: pageTitle.replace(/\s+-\s+YouTube\s*$/i, "").trim() || "YouTube video",
      videoId: videoIdFromUrl(parsedPage),
      duration: 0,
      posterUrl: ""
    };
    let playabilityReason = "";

    function considerFormat(format, progressive) {
      if (!format || typeof format !== "object") {
        return;
      }
      const mimeType = normalizedMimeType(safeObjectProperty(format, "mimeType"));
      if (!mimeType) {
        return;
      }
      const rawUrl = safeObjectProperty(format, "url");
      const url = directFormatUrl(rawUrl);
      if (!url) {
        if (safeObjectProperty(format, "signatureCipher") || safeObjectProperty(format, "cipher")) {
          counters.ciphered += 1;
        } else if (typeof rawUrl === "string" && rawUrl.trim()) {
          counters.directRejected += 1;
        }
        return;
      }
      const width = Math.max(0, Math.round(Number(safeObjectProperty(format, "width")) || 0));
      const height = Math.max(0, Math.round(Number(safeObjectProperty(format, "height")) || 0));
      const fps = Math.max(0, Math.round(Number(safeObjectProperty(format, "fps")) || 0));
      const itag = Math.max(0, Math.round(Number(safeObjectProperty(format, "itag")) || 0));
      const hasAudio = Boolean(
        progressive ||
        safeObjectProperty(format, "audioQuality") ||
        safeObjectProperty(format, "audioSampleRate") ||
        safeObjectProperty(format, "audioChannels") ||
        codecsContainAudio(safeObjectProperty(format, "mimeType"))
      );
      const candidate = {
        url,
        mimeType,
        width,
        height,
        fps,
        itag,
        qualityLabel: safeText(safeObjectProperty(format, "qualityLabel"), 40).trim(),
        bitrate: Math.max(0, Number(safeObjectProperty(format, "bitrate")) || 0),
        contentLength: safeText(safeObjectProperty(format, "contentLength"), 32),
        hasAudio,
        protectedMetadata: hasProtectedMetadata(format)
      };
      if (!hasAudio) {
        counters.videoOnlyDirect += 1;
      }
      const key = `${itag || "unknown"}:${mimeType}:${width}x${height}:${fps}:${hasAudio ? "av" : "v"}`;
      if (!candidateByKey.has(key)) {
        candidateByKey.set(key, candidate);
      }
    }

    function analyzeResponse(response) {
      if (!response || typeof response !== "object") {
        return;
      }
      metadata = responseMetadata(response, metadata);
      const playability = safeObjectProperty(response, "playabilityStatus");
      const status = safeText(safeObjectProperty(playability, "status"), 50);
      const reason = safeText(safeObjectProperty(playability, "reason"), 300).trim();
      if (status && status !== "OK" && reason && !playabilityReason) {
        playabilityReason = reason;
      }
      const streamingData = safeObjectProperty(response, "streamingData");
      if (!streamingData || typeof streamingData !== "object") {
        return;
      }
      if (safeObjectProperty(streamingData, "serverAbrStreamingUrl")) {
        counters.sabr += 1;
      }
      const progressiveFormats = safeObjectProperty(streamingData, "formats");
      const adaptiveFormats = safeObjectProperty(streamingData, "adaptiveFormats");
      if (Array.isArray(progressiveFormats)) {
        for (const format of progressiveFormats.slice(0, 128)) {
          considerFormat(format, true);
        }
      }
      if (Array.isArray(adaptiveFormats)) {
        for (const format of adaptiveFormats.slice(0, 128)) {
          considerFormat(format, false);
        }
      }
    }

    const initialResponses = directPageResponses();
    for (const response of initialResponses) {
      analyzeResponse(response);
    }

    function hasCompleteDirectFormat() {
      return Array.from(candidateByKey.values()).some((candidate) => candidate.hasAudio);
    }

    async function readBoundedResponseText(response) {
      const declaredLength = Number(
        response && response.headers && typeof response.headers.get === "function"
          ? response.headers.get("content-length")
          : 0
      );
      if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
        throw new Error("response exceeded the safety limit");
      }
      if (response && response.body && typeof response.body.getReader === "function") {
        const reader = response.body.getReader();
        const chunks = [];
        let total = 0;
        while (true) {
          const result = await reader.read();
          if (result.done) {
            break;
          }
          const chunk = result.value instanceof Uint8Array
            ? result.value
            : new Uint8Array(result.value);
          total += chunk.byteLength;
          if (total > maxResponseBytes) {
            await reader.cancel().catch(() => undefined);
            throw new Error("response exceeded the safety limit");
          }
          chunks.push(chunk);
        }
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      }
      const text = await response.text();
      if (typeof text !== "string" || text.length > maxResponseBytes) {
        throw new Error("response exceeded the safety limit");
      }
      return text;
    }

    async function requestPublicPlayerResponse(clientProfile) {
      if (settings.requestPlayerApi === false || !metadata.videoId || typeof fetch !== "function") {
        return null;
      }
      const endpointOrigin = youtubeHostPattern.test(parsedPage.hostname)
        ? parsedPage.origin
        : "https://www.youtube.com";
      const endpoint = `${endpointOrigin}/youtubei/v1/player?prettyPrint=false`;
      const profile = clientProfile && typeof clientProfile === "object"
        ? clientProfile
        : {
            clientName: "ANDROID_VR",
            clientVersion: safeText(settings.androidVrClientVersion || "1.65.10", 40),
            clientId: "28",
            deviceMake: "Oculus",
            deviceModel: "Quest 3",
            androidSdkVersion: 32,
            osVersion: "12L",
            userAgentPrefix: "com.google.android.apps.youtube.vr.oculus"
          };
      const clientVersion = safeText(profile.clientVersion, 40);
      const clientUserAgent = `${safeText(profile.userAgentPrefix, 100)}/${clientVersion} ` +
        `(Linux; U; Android ${safeText(profile.osVersion, 20)}) gzip`;
      const language = safeText(
        typeof document === "object" && document && document.documentElement &&
          document.documentElement.lang || "en",
        20
      ).replace(/[^A-Za-z0-9_-]/g, "") || "en";
      const body = JSON.stringify({
        videoId: metadata.videoId,
        context: {
          client: {
            clientName: safeText(profile.clientName, 40),
            clientVersion,
            deviceMake: safeText(profile.deviceMake, 40),
            deviceModel: safeText(profile.deviceModel, 40),
            androidSdkVersion: boundedInteger(profile.androidSdkVersion, 32, 1, 100),
            userAgent: clientUserAgent,
            osName: "Android",
            osVersion: safeText(profile.osVersion, 20),
            hl: language
          }
        }
      });
      let timeoutId = null;
      let controller = null;
      try {
        if (typeof AbortController === "function") {
          controller = new AbortController();
          timeoutId = setTimeout(() => controller.abort(), requestTimeoutMs);
        }
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-YouTube-Client-Name": safeText(profile.clientId, 10),
            "X-YouTube-Client-Version": clientVersion
          },
          body,
          credentials: "omit",
          cache: "no-store",
          redirect: "error",
          referrerPolicy: "no-referrer",
          signal: controller ? controller.signal : undefined
        });
        if (!response || response.ok !== true || typeof response.text !== "function") {
          const status = response && Number(response.status);
          throw new Error(status ? `HTTP ${status}` : "request rejected");
        }
        const text = await readBoundedResponseText(response);
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === "object" ? parsed : null;
      } catch (error) {
        const message = error && error.name === "AbortError"
          ? "request timed out"
          : safeText(error && error.message || error, 180);
        warnings.push(`YouTube's direct-format request failed (${message || "unknown error"}).`);
        return null;
      } finally {
        if (timeoutId !== null) {
          clearTimeout(timeoutId);
        }
      }
    }

    if (!hasCompleteDirectFormat() && settings.playerApiResponse &&
      typeof settings.playerApiResponse === "object") {
      analyzeResponse(settings.playerApiResponse);
    }
    if (!hasCompleteDirectFormat() && !settings.playerApiResponse) {
      const clientProfiles = [
        {
          clientName: "ANDROID_VR",
          clientVersion: safeText(settings.androidVrClientVersion || "1.65.10", 40),
          clientId: "28",
          deviceMake: "Oculus",
          deviceModel: "Quest 3",
          androidSdkVersion: 32,
          osVersion: "12L",
          userAgentPrefix: "com.google.android.apps.youtube.vr.oculus"
        },
        {
          clientName: "ANDROID",
          clientVersion: safeText(settings.androidClientVersion || "21.02.35", 40),
          clientId: "3",
          deviceMake: "Google",
          deviceModel: "Pixel 9",
          androidSdkVersion: 35,
          osVersion: "15",
          userAgentPrefix: "com.google.android.youtube"
        }
      ];
      for (const clientProfile of clientProfiles) {
        const publicResponse = await requestPublicPlayerResponse(clientProfile);
        if (publicResponse) {
          analyzeResponse(publicResponse);
        }
        if (hasCompleteDirectFormat()) {
          break;
        }
      }
    }

    function candidateOrder(left, right) {
      if (left.hasAudio !== right.hasAudio) {
        return left.hasAudio ? -1 : 1;
      }
      if (left.height !== right.height) {
        return right.height - left.height;
      }
      if (left.fps !== right.fps) {
        return right.fps - left.fps;
      }
      if (left.bitrate !== right.bitrate) {
        return right.bitrate - left.bitrate;
      }
      return left.itag - right.itag;
    }

    const allCandidates = Array.from(candidateByKey.values()).sort(candidateOrder);
    const completeCandidates = allCandidates.filter((candidate) => candidate.hasAudio);
    let selectedCandidates;
    if (settings.includeVideoOnly === true) {
      selectedCandidates = allCandidates;
    } else if (completeCandidates.length) {
      selectedCandidates = completeCandidates;
    } else {
      selectedCandidates = allCandidates.slice(0, 1);
    }
    selectedCandidates = selectedCandidates.slice(0, maxFormats);

    const images = [];
    let payloadLength = 0;
    for (const candidate of selectedCandidates) {
      const previewUrl = metadata.posterUrl;
      const nextLength = candidate.url.length + previewUrl.length;
      if (payloadLength + nextLength > maxPayloadLength) {
        warnings.push("Some YouTube formats were omitted because their URLs exceeded the scan safety limit.");
        break;
      }
      payloadLength += nextLength;
      const quality = candidate.qualityLabel ||
        (candidate.height ? `${candidate.height}p` : "quality unknown");
      const trackDescription = candidate.hasAudio ? "video + audio" : "video-only (no audio)";
      images.push({
        url: candidate.url,
        previewUrl,
        alt: safeText(`${metadata.title} — ${quality}`, 500),
        width: candidate.width,
        height: candidate.height,
        duration: metadata.duration,
        mimeType: candidate.mimeType,
        mediaType: "video",
        filename: suggestedFilename(metadata, candidate),
        kinds: ["YouTube direct file", `${quality} ${trackDescription}`],
        sourceProvider: "youtube",
        identityKey: `youtube:${metadata.videoId}:${candidate.itag}`,
        videoId: metadata.videoId,
        qualityLabel: quality,
        hasAudio: candidate.hasAudio,
        itag: candidate.itag,
        contentLength: candidate.contentLength,
        protectedPlaybackMetadata: candidate.protectedMetadata
      });
    }

    if (images.length) {
      if (counters.videoOnlyDirect && settings.includeVideoOnly !== true && completeCandidates.length) {
        warnings.push(
          "YouTube's higher-quality tracks may separate video from audio. " +
          "AnyDownload lists complete video files and does not merge separate streams."
        );
      } else if (images.some((image) => !image.hasAudio)) {
        warnings.push(
          "YouTube exposed no complete video-and-audio file. The listed fallback is video-only and will have no sound."
        );
      }
      const listedProtectedCount = images.filter((image) => image.protectedPlaybackMetadata).length;
      if (listedProtectedCount) {
        warnings.push(
          `${listedProtectedCount} direct YouTube track${listedProtectedCount === 1 ? " reports" : "s report"} ` +
          "protected-playback metadata. It is listed unchanged; AnyDownload does not obtain licences or decrypt media."
        );
      }
      warnings.push("YouTube direct links expire; start the selected download promptly.");
    } else {
      if (playabilityReason) {
        warnings.push(`YouTube did not make this video playable: ${playabilityReason}`);
      }
      if (counters.ciphered) {
        warnings.push(
          `YouTube exposed ${counters.ciphered} signature-ciphered format${counters.ciphered === 1 ? "" : "s"}. ` +
          "AnyDownload does not defeat URL signatures."
        );
      }
      if (counters.sabr) {
        warnings.push(
          "This YouTube player exposed SABR streaming data rather than a standalone file. " +
          "AnyDownload does not reconstruct proprietary streams."
        );
      }
      if (counters.directRejected) {
        warnings.push("YouTube returned media URLs outside its downloadable video host; they were ignored.");
      }
      if (!metadata.videoId) {
        warnings.push("No YouTube video ID was found on this page.");
      } else if (!warnings.length) {
        warnings.push("YouTube did not expose a directly downloadable MP4 or WebM file for this video.");
      }
    }

    return {
      handled: true,
      pageUrl,
      pageTitle: metadata.title || pageTitle,
      embeddedFrameCount: 0,
      images,
      warnings: Array.from(new Set(warnings)).slice(0, 12)
    };
  }

  const api = Object.freeze({
    collectYouTubeMediaFromPage,
    isYouTubeUrl
  });
  root.AnyDownloadYouTube = api;
  root.AnyDownloadYouTubeCollector = collectYouTubeMediaFromPage;
  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
  }
})(typeof globalThis === "object" ? globalThis : this);
