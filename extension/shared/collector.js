(function attachImageDownloaderCollector(root) {
  "use strict";

  function collectImagesFromPage(options) {
    const settings = Object.assign(
      {
        includeBackgrounds: true,
        maxImages: 1500,
        maxElements: 10000,
        maxDataUrlLength: 500000,
        maxPayloadLength: 2000000
      },
      options || {}
    );
    const found = new Map();
    const warnings = [];
    const IMAGE_EXTENSION = /\.(?:apng|avif|bmp|gif|ico|jpe?g|jxl|png|svg|tiff?|webp)$/i;
    const FULL_IMAGE_ATTRIBUTES = [
      "data-full",
      "data-full-src",
      "data-full-image",
      "data-full-image-src",
      "data-fullsize",
      "data-fullsize-src",
      "data-original",
      "data-original-src",
      "data-image",
      "data-hires",
      "data-hi-res",
      "data-high-res",
      "data-high-res-src",
      "data-large",
      "data-large-src",
      "data-large-image",
      "data-large_image",
      "data-src-full",
      "data-src-large",
      "data-zoom-image",
      "data-zoom-src",
      "data-pin-media"
    ];
    const LAZY_IMAGE_ATTRIBUTES = ["data-src", "data-lazy-src", "data-url"];
    const FULL_IMAGE_DIMENSION_ATTRIBUTES = [
      ["data-full-width", "data-full-height"],
      ["data-full-image-width", "data-full-image-height"],
      ["data-fullsize-width", "data-fullsize-height"],
      ["data-original-width", "data-original-height"],
      ["data-image-width", "data-image-height"],
      ["data-large-width", "data-large-height"],
      ["data-hires-width", "data-hires-height"],
      ["data-hi-res-width", "data-hi-res-height"],
      ["data-high-res-width", "data-high-res-height"],
      ["data-natural-width", "data-natural-height"],
      ["data-photo-width", "data-photo-height"],
      ["data-media-width", "data-media-height"],
      ["data-width", "data-height"]
    ];
    let truncated = false;
    let payloadLimitReached = false;
    let skippedLargeDataUrls = 0;
    let skippedBlobUrls = 0;
    let skippedLongUrls = 0;
    let totalUrlLength = 0;

    function safeText(value, maxLength) {
      return String(value == null ? "" : value).slice(0, maxLength);
    }

    function normalizeUrl(rawValue) {
      if (typeof rawValue !== "string") {
        return "";
      }
      const value = rawValue.trim();
      if (!value) {
        return "";
      }
      if (/^data:/i.test(value)) {
        if (!/^data:image\/[a-z0-9.+-]+[;,]/i.test(value)) {
          return "";
        }
        if (value.length > settings.maxDataUrlLength) {
          skippedLargeDataUrls += 1;
          return "";
        }
        return `data:${value.slice(5)}`;
      }
      if (value.length > 16384) {
        skippedLongUrls += 1;
        return "";
      }

      try {
        const parsed = new URL(value, document.baseURI);
        if (parsed.protocol === "blob:") {
          skippedBlobUrls += 1;
          return "";
        }
        if (!["http:", "https:"].includes(parsed.protocol)) {
          return "";
        }
        parsed.hash = "";
        return parsed.href;
      } catch (_error) {
        return "";
      }
    }

    function parseDimensionHint(value) {
      const text = String(value == null ? "" : value).trim();
      if (!/^\d+(?:\.\d+)?$/.test(text)) {
        return 0;
      }
      const dimension = Math.round(Number(text));
      return Number.isSafeInteger(dimension) && dimension > 0 && dimension <= 1000000
        ? dimension
        : 0;
    }

    function fullImageDimensionHints(element) {
      let candidate = element;
      for (let depth = 0; candidate && depth <= 4; depth += 1) {
        for (const [widthAttribute, heightAttribute] of FULL_IMAGE_DIMENSION_ATTRIBUTES) {
          if (!candidate.getAttribute) {
            continue;
          }
          const rawWidth = candidate.getAttribute(widthAttribute);
          const rawHeight = candidate.getAttribute(heightAttribute);
          if (rawWidth == null && rawHeight == null) {
            continue;
          }
          const width = parseDimensionHint(rawWidth);
          const height = parseDimensionHint(rawHeight);
          if (width || height) {
            return { width, height };
          }
        }
        candidate = candidate.parentElement || candidate.parentNode;
      }
      return { width: 0, height: 0 };
    }

    function addImage(rawUrl, details) {
      details = details || {};
      const url = normalizeUrl(rawUrl);
      if (!url) {
        return;
      }
      const normalizedPreviewUrl = normalizeUrl(details.previewUrl);
      const previewUrl = normalizedPreviewUrl && normalizedPreviewUrl !== url
        ? normalizedPreviewUrl
        : "";
      const existing = found.get(url);
      if (existing) {
        if (details.kind && existing.kinds.length < 8 && !existing.kinds.includes(details.kind)) {
          existing.kinds.push(details.kind);
        }
        existing.width = Math.max(existing.width || 0, Number(details.width) || 0);
        existing.height = Math.max(existing.height || 0, Number(details.height) || 0);
        existing.alt = existing.alt || safeText(details.alt, 500);
        if (!existing.previewUrl && previewUrl &&
          totalUrlLength + previewUrl.length <= settings.maxPayloadLength) {
          existing.previewUrl = previewUrl;
          totalUrlLength += previewUrl.length;
        }
        return;
      }

      if (found.size >= settings.maxImages) {
        truncated = true;
        return;
      }
      if (totalUrlLength + url.length > settings.maxPayloadLength) {
        payloadLimitReached = true;
        return;
      }

      totalUrlLength += url.length;
      const storedPreviewUrl = previewUrl &&
        totalUrlLength + previewUrl.length <= settings.maxPayloadLength
        ? previewUrl
        : "";
      totalUrlLength += storedPreviewUrl.length;
      found.set(url, {
        url,
        previewUrl: storedPreviewUrl,
        alt: safeText(details.alt, 500),
        width: Math.max(0, Number(details.width) || 0),
        height: Math.max(0, Number(details.height) || 0),
        kinds: [safeText(details.kind || "Page image", 50)]
      });
    }

    function parseSrcset(srcset) {
      if (typeof srcset !== "string" || !srcset.trim()) {
        return [];
      }
      const input = srcset.slice(0, 200000);
      const rawCandidates = [];
      const isSpace = (character) => /[\t\n\f\r ]/.test(character || "");
      let position = 0;

      while (position < input.length && rawCandidates.length < 64) {
        while (position < input.length && (isSpace(input[position]) || input[position] === ",")) {
          position += 1;
        }
        if (position >= input.length) {
          break;
        }

        const urlStart = position;
        while (position < input.length && !isSpace(input[position])) {
          position += 1;
        }
        let url = input.slice(urlStart, position);
        let descriptorText = "";

        if (/,+$/.test(url)) {
          url = url.replace(/,+$/, "");
        } else {
          while (position < input.length && isSpace(input[position])) {
            position += 1;
          }
          const descriptorStart = position;
          let parentheses = 0;
          while (position < input.length) {
            const character = input[position];
            if (character === "(") {
              parentheses += 1;
            } else if (character === ")" && parentheses > 0) {
              parentheses -= 1;
            } else if (character === "," && parentheses === 0) {
              break;
            }
            position += 1;
          }
          descriptorText = input.slice(descriptorStart, position).trim();
          if (input[position] === ",") {
            position += 1;
          }
        }

        if (url) {
          rawCandidates.push({ url, descriptors: descriptorText.split(/\s+/).filter(Boolean) });
        }
      }

      const candidates = [];
      let setType = "";
      for (const rawCandidate of rawCandidates) {
        let type = "x";
        let value = 1;
        if (rawCandidate.descriptors.length > 1) {
          continue;
        }
        if (rawCandidate.descriptors.length === 1) {
          const descriptor = rawCandidate.descriptors[0];
          const widthMatch = descriptor.match(/^(\d+)w$/i);
          const densityMatch = descriptor.match(/^(?:(\d+(?:\.\d+)?)|(\.\d+))x$/i);
          if (widthMatch && Number(widthMatch[1]) > 0) {
            type = "w";
            value = Number(widthMatch[1]);
          } else if (densityMatch && Number(densityMatch[1] || densityMatch[2]) > 0) {
            type = "x";
            value = Number(densityMatch[1] || densityMatch[2]);
          } else {
            continue;
          }
        }
        if (setType && setType !== type) {
          return [];
        }
        setType = type;
        candidates.push({
          url: rawCandidate.url,
          width: type === "w" ? value : 0,
          density: type === "x" ? value : 0,
          descriptorValue: value
        });
      }
      return candidates;
    }

    function bestSrcsetCandidate(srcset) {
      const candidates = parseSrcset(srcset);
      let best = null;
      for (const candidate of candidates) {
        if (!best || candidate.descriptorValue > best.descriptorValue) {
          best = candidate;
        }
      }
      return best;
    }

    function cssUrls(value) {
      const urls = [];
      const pattern = /url\(\s*(?:(["'])(.*?)\1|([^)]*))\s*\)/gi;
      const boundedValue = String(value || "").slice(0, 200000);
      let match;
      while ((match = pattern.exec(boundedValue))) {
        urls.push((match[2] || match[3] || "").trim());
      }
      return urls;
    }

    function isClearlyImageLink(anchor, normalizedUrl) {
      if (!normalizedUrl) {
        return false;
      }
      if (/^data:image\//i.test(normalizedUrl)) {
        return true;
      }
      const declaredType = safeText(anchor && anchor.getAttribute && anchor.getAttribute("type"), 100);
      if (/^image\//i.test(declaredType.trim())) {
        return true;
      }
      try {
        const parsed = new URL(normalizedUrl);
        if (IMAGE_EXTENSION.test(parsed.pathname)) {
          return true;
        }
        const format = (parsed.searchParams.get("format") || parsed.searchParams.get("fm") || "")
          .replace(/^image\//i, "");
        if (IMAGE_EXTENSION.test(`file.${format}`)) {
          return true;
        }
        const downloadName = safeText(anchor && anchor.getAttribute && anchor.getAttribute("download"), 500);
        return IMAGE_EXTENSION.test(downloadName);
      } catch (_error) {
        return false;
      }
    }

    function derivedOriginalUrls(normalizedUrl) {
      if (!normalizedUrl || /^data:/i.test(normalizedUrl)) {
        return [];
      }
      const derived = [];
      try {
        const parsed = new URL(normalizedUrl);
        const hostname = parsed.hostname.toLowerCase();
        const originalPath = parsed.pathname;

        if (/\/_next\/image$/i.test(originalPath)) {
          const embedded = parsed.searchParams.get("url");
          if (embedded) {
            derived.push(new URL(embedded, parsed.origin).href);
          }
        }

        if (hostname === "fap.onl" && /^\/uploads\/preview\//i.test(originalPath)) {
          const original = new URL(parsed.href);
          original.pathname = original.pathname
            .replace(/^\/uploads\/preview\//i, "/uploads/photos/")
            .replace(/_(?:middle|small|thumb|thumbnail|\d+px)(?=\.(?:avif|gif|jpe?g|png|webp)$)/i, "");
          derived.push(original.href);
        }

        const isFapelloHost = hostname === "fapello.com" || hostname.endsWith(".fapello.com") ||
          hostname === "fapello.su" || hostname.endsWith(".fapello.su") ||
          hostname === "ahcdn.com" || hostname.endsWith(".ahcdn.com");
        if (isFapelloHost && /\/content\//i.test(originalPath)) {
          const original = new URL(parsed.href);
          original.pathname = original.pathname
            .replace(/\.(?:md|th)(?=\.(?:avif|gif|jpe?g|png|webp)$)/i, "")
            .replace(/_\d+px(?=\.(?:avif|gif|jpe?g|png|webp)$)/i, "");
          if (original.pathname !== originalPath) {
            derived.push(original.href);
          }
        }
      } catch (_error) {
        return [];
      }
      return derived;
    }

    function mediaMatches(source) {
      const media = safeText(source && source.getAttribute && source.getAttribute("media"), 1000).trim();
      if (!media) {
        return true;
      }
      try {
        return typeof matchMedia === "function" ? Boolean(matchMedia(media).matches) : false;
      } catch (_error) {
        return false;
      }
    }

    function resolveImageElement(element) {
      const candidates = new Map();
      const naturalWidth = Math.max(0, Number(element.naturalWidth) || 0);
      const naturalHeight = Math.max(0, Number(element.naturalHeight) || 0);
      const rawCurrentUrl = element.currentSrc || element.src || element.getAttribute("src") || "";
      const currentUrl = normalizeUrl(rawCurrentUrl);
      const lazyValues = LAZY_IMAGE_ATTRIBUTES
        .map((attribute) => element.getAttribute(attribute))
        .filter(Boolean);
      const looksLikePlaceholder = /^data:/i.test(String(rawCurrentUrl || "")) &&
        naturalWidth <= 2 && naturalHeight <= 2;
      let candidateOrder = 0;

      function betterCandidate(left, right) {
        if (!right) {
          return true;
        }
        if (left.priority !== right.priority) {
          return left.priority > right.priority;
        }
        const leftResolution = left.width || (left.density ? left.density * 1000 : 0);
        const rightResolution = right.width || (right.density ? right.density * 1000 : 0);
        if (leftResolution !== rightResolution) {
          return leftResolution > rightResolution;
        }
        return left.order < right.order;
      }

      function consider(rawUrl, details) {
        if (candidates.size >= 40) {
          return false;
        }
        const url = normalizeUrl(rawUrl);
        if (!url) {
          return false;
        }
        const candidate = {
          url,
          kind: details.kind,
          priority: Number(details.priority) || 0,
          width: Math.max(0, Number(details.width) || 0),
          height: Math.max(0, Number(details.height) || 0),
          density: Math.max(0, Number(details.density) || 0),
          order: candidateOrder
        };
        candidateOrder += 1;
        if (betterCandidate(candidate, candidates.get(url))) {
          candidates.set(url, candidate);
        }
        return true;
      }

      function considerSrcset(srcset, details) {
        const candidate = bestSrcsetCandidate(srcset);
        if (!candidate) {
          return;
        }
        consider(candidate.url, {
          kind: details.kind,
          priority: details.priority,
          width: candidate.width,
          density: candidate.density
        });
      }

      if (!looksLikePlaceholder || lazyValues.length === 0) {
        consider(rawCurrentUrl, { kind: "Image", priority: 100 });
      }
      for (const lazyUrl of lazyValues) {
        consider(lazyUrl, { kind: "Lazy image", priority: 220 });
      }
      considerSrcset(element.getAttribute("srcset"), {
        kind: "Largest responsive image",
        priority: 350
      });
      considerSrcset(element.getAttribute("data-srcset"), {
        kind: "Largest responsive image",
        priority: 350
      });
      considerSrcset(element.getAttribute("data-lazy-srcset"), {
        kind: "Largest responsive image",
        priority: 350
      });

      const parent = element.parentElement || element.parentNode;
      if (parent && String(parent.localName || "").toLowerCase() === "picture") {
        const sources = Array.from(parent.children || [])
          .filter((child) => String(child.localName || "").toLowerCase() === "source" && mediaMatches(child));
        let activeSource = null;
        for (const source of sources) {
          const sourceSet = source.getAttribute("srcset") ||
            source.getAttribute("data-srcset") ||
            source.getAttribute("data-lazy-srcset");
          const sourceCandidates = parseSrcset(sourceSet);
          if (currentUrl && sourceCandidates.some((candidate) => normalizeUrl(candidate.url) === currentUrl)) {
            activeSource = source;
            break;
          }
        }
        activeSource = activeSource || sources[0] || null;
        if (activeSource) {
          considerSrcset(
            activeSource.getAttribute("srcset") ||
              activeSource.getAttribute("data-srcset") ||
              activeSource.getAttribute("data-lazy-srcset"),
            { kind: "Largest responsive image", priority: 380 }
          );
        }
      }

      let ancestor = element;
      for (let depth = 0; ancestor && depth <= 4; depth += 1) {
        let foundExplicitAtDepth = false;
        for (const attribute of FULL_IMAGE_ATTRIBUTES) {
          const rawValue = ancestor.getAttribute && ancestor.getAttribute(attribute);
          if (!rawValue) {
            continue;
          }
          const dimensions = fullImageDimensionHints(ancestor);
          if (consider(rawValue, {
            kind: "Full-size image",
            priority: 600 - depth,
            width: dimensions.width,
            height: dimensions.height
          })) {
            foundExplicitAtDepth = true;
          }
        }
        if (foundExplicitAtDepth) {
          break;
        }
        ancestor = ancestor.parentElement || ancestor.parentNode;
      }

      let anchor = element;
      for (let depth = 0; anchor && depth <= 5; depth += 1) {
        if (String(anchor.localName || "").toLowerCase() === "a") {
          const href = normalizeUrl(anchor.getAttribute && anchor.getAttribute("href"));
          if (isClearlyImageLink(anchor, href)) {
            consider(href, { kind: "Linked full-size image", priority: 500 });
          }
          break;
        }
        anchor = anchor.parentElement || anchor.parentNode;
      }

      const derivationBases = Array.from(candidates.values());
      for (const baseCandidate of derivationBases) {
        for (const derivedUrl of derivedOriginalUrls(baseCandidate.url)) {
          consider(derivedUrl, { kind: "Original image", priority: 450 });
        }
      }

      let best = null;
      for (const candidate of candidates.values()) {
        if (betterCandidate(candidate, best)) {
          best = candidate;
        }
      }
      if (!best) {
        return null;
      }

      let previewUrl = !looksLikePlaceholder ? currentUrl : "";
      if (!previewUrl) {
        for (const lazyUrl of lazyValues) {
          previewUrl = normalizeUrl(lazyUrl);
          if (previewUrl) {
            break;
          }
        }
      }
      if (previewUrl === best.url) {
        previewUrl = "";
      }

      let width = 0;
      let height = 0;
      if (best.width || best.height) {
        width = best.width || 0;
        height = best.height || 0;
      } else if (best.url === currentUrl) {
        width = naturalWidth;
        height = naturalHeight;
      }

      return {
        url: best.url,
        previewUrl,
        alt: element.alt || element.getAttribute("alt") || "",
        width,
        height,
        kind: best.kind
      };
    }

    let targetImage = null;
    if (Number.isInteger(settings.targetElementId)) {
      try {
        if (
          typeof browser === "object" &&
          browser &&
          browser.menus &&
          typeof browser.menus.getTargetElement === "function"
        ) {
          const targetElement = browser.menus.getTargetElement(settings.targetElementId);
          if (targetElement && String(targetElement.localName || "").toLowerCase() === "img") {
            targetImage = targetElement;
          }
        }
      } catch (_error) {
        // A stale target ID is equivalent to the fast path being unavailable.
      }
    }

    const roots = [document];
    const allElements = targetImage ? [targetImage] : [];
    let elementLimitReached = false;
    for (let rootIndex = 0; !targetImage && rootIndex < roots.length && allElements.length < settings.maxElements; rootIndex += 1) {
      try {
        const walker = document.createTreeWalker(roots[rootIndex], NodeFilter.SHOW_ELEMENT);
        let element;
        while ((element = walker.nextNode())) {
          if (allElements.length >= settings.maxElements) {
            elementLimitReached = true;
            break;
          }
          allElements.push(element);
          if (element.shadowRoot && !roots.includes(element.shadowRoot)) {
            roots.push(element.shadowRoot);
          }
        }
      } catch (_error) {
        // Detached or browser-owned roots can disappear while being walked.
      }
      if (elementLimitReached) {
        break;
      }
    }
    if (elementLimitReached) {
      warnings.push(`Only the first ${settings.maxElements.toLocaleString()} page elements were scanned.`);
    }

    let embeddedFrameCount = 0;
    for (const element of allElements) {
      const tagName = String(element.localName || "").toLowerCase();
      if (tagName === "iframe" || tagName === "frame") {
        embeddedFrameCount += 1;
      }
      if (tagName === "img") {
        const resolved = resolveImageElement(element);
        if (resolved) {
          addImage(resolved.url, resolved);
        }
      } else if (tagName === "image" && element.namespaceURI === "http://www.w3.org/2000/svg") {
        const href = element.href && element.href.baseVal
          ? element.href.baseVal
          : element.getAttribute("href") || element.getAttribute("xlink:href");
        const bounds = element.getBoundingClientRect();
        addImage(href, {
          kind: "SVG image",
          alt: element.getAttribute("aria-label") || "",
          width: bounds.width,
          height: bounds.height
        });
      } else if (tagName === "input" && String(element.type).toLowerCase() === "image") {
        addImage(element.src || element.getAttribute("src"), {
          kind: "Image input",
          alt: element.alt,
          width: element.width,
          height: element.height
        });
      } else if (tagName === "video" && element.poster) {
        addImage(element.poster, {
          kind: "Video poster",
          alt: element.getAttribute("aria-label") || "",
          width: element.videoWidth,
          height: element.videoHeight
        });
      }

      if (settings.includeBackgrounds && !truncated && !payloadLimitReached) {
        try {
          const style = getComputedStyle(element);
          const values = [
            style.backgroundImage,
            style.borderImageSource,
            style.listStyleImage,
            style.maskImage,
            style.webkitMaskImage
          ];
          for (const value of values) {
            for (const url of cssUrls(value)) {
              addImage(url, {
                kind: "CSS image",
                alt: element.getAttribute("aria-label") || "",
                width: element.clientWidth,
                height: element.clientHeight
              });
            }
          }
        } catch (_error) {
          // Some browser-owned or detached nodes do not expose computed styles.
        }
      }
    }

    if (truncated) {
      warnings.push(`The scan reached its safety limit of ${settings.maxImages.toLocaleString()} distinct images.`);
    }
    if (payloadLimitReached) {
      warnings.push("Some images were skipped because their combined URL data exceeded the 2 MB safety limit.");
    }
    if (skippedLargeDataUrls) {
      warnings.push(`${skippedLargeDataUrls} very large embedded image${skippedLargeDataUrls === 1 ? " was" : "s were"} skipped.`);
    }
    if (skippedBlobUrls) {
      warnings.push(`${skippedBlobUrls} page-owned blob image${skippedBlobUrls === 1 ? " was" : "s were"} skipped because Firefox cannot download it from an extension.`);
    }
    if (skippedLongUrls) {
      warnings.push(`${skippedLongUrls} unusually long image URL${skippedLongUrls === 1 ? " was" : "s were"} skipped.`);
    }
    if (document.querySelector("canvas")) {
      warnings.push("Canvas pixels are not downloadable as source images.");
    }

    return {
      pageUrl: safeText(location.href, 16384),
      pageTitle: safeText(document.title, 300),
      embeddedFrameCount,
      images: Array.from(found.values()),
      warnings
    };
  }

  root.ImageDownloaderCollector = collectImagesFromPage;
  if (typeof module === "object" && module.exports) {
    module.exports = collectImagesFromPage;
  }
})(typeof globalThis === "object" ? globalThis : this);
