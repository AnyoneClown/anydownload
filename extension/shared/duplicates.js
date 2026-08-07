(function attachImageDownloaderDuplicates(root) {
  "use strict";

  // These parameters change delivery size/encoding, not the identity embedded
  // in the rest of the URL. Keep this list intentionally small: parameters
  // such as id, key, token, signature, crop, and arbitrary CDN transforms must
  // continue to distinguish otherwise similar URLs.
  const RESIZE_PARAMETERS = new Set([
    "dpr",
    "fm",
    "format",
    "h",
    "height",
    "q",
    "quality",
    "w",
    "width"
  ]);
  const IMAGE_FORMATS = new Set([
    "apng",
    "auto",
    "avif",
    "bmp",
    "gif",
    "heic",
    "heif",
    "ico",
    "jpeg",
    "jpg",
    "jxl",
    "png",
    "svg",
    "tif",
    "tiff",
    "webp"
  ]);
  const TRACKING_PARAMETERS = new Set([
    "_gl",
    "dclid",
    "fbclid",
    "gclid",
    "mc_cid",
    "mc_eid",
    "msclkid",
    "utm_campaign",
    "utm_content",
    "utm_creative_format",
    "utm_id",
    "utm_marketing_tactic",
    "utm_medium",
    "utm_source",
    "utm_source_platform",
    "utm_term"
  ]);
  const GENERIC_FILENAME = /^(?:asset|download|file|image|img|media|photo|picture|render|source|thumb|thumbnail)$/i;
  const PLACEHOLDER_FILENAME = /(?:blank|default|dummy|empty|fallback|loading|missing|no[-_. ]*image|not[-_. ]*found|placeholder|spacer|transparent|spinner|pixel|unavailable)/i;
  const RESIZED_FILENAME_SUFFIX = /(?:[-_.](?:(?:thumb|thumbnail|preview|small|medium|large|original|full|fullsize)|(?:w|h)\d{2,6}|\d{2,6}x\d{2,6}))+$/i;
  const SOURCE_ID_FIELDS = [
    "assetId",
    "elementId",
    "elementKey",
    "mediaId",
    "photoId",
    "sourceId",
    "sourceKey"
  ];

  function safeValue(record, key) {
    try {
      return record && record[key];
    } catch (_error) {
      return undefined;
    }
  }

  function safeString(value) {
    try {
      return String(value == null ? "" : value);
    } catch (_error) {
      return "";
    }
  }

  function normalizeImageUrl(value) {
    const text = safeString(value).trim();
    if (!text) {
      return "";
    }
    if (/^data:image\/[a-z0-9.+-]+[;,]/i.test(text)) {
      return text;
    }
    try {
      const parsed = new URL(text);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return "";
      }
      parsed.hash = "";
      return parsed.href;
    } catch (_error) {
      return "";
    }
  }

  function numericParameter(value, minimum, maximum, integer) {
    const text = safeString(value);
    if (!(integer ? /^\d+$/ : /^(?:\d+(?:\.\d+)?|\.\d+)$/).test(text)) {
      return false;
    }
    const numeric = Number(text);
    return Number.isFinite(numeric) && numeric >= minimum && numeric <= maximum;
  }

  function recognizedImageFormat(value) {
    const normalized = safeString(value).toLowerCase();
    if (IMAGE_FORMATS.has(normalized)) {
      return true;
    }
    return normalized.startsWith("image/") && IMAGE_FORMATS.has(normalized.slice(6));
  }

  function validResizeParameter(name, value) {
    switch (name) {
      case "w":
      case "width":
      case "h":
      case "height":
        return numericParameter(value, 1, 1000000, true);
      case "dpr":
        return numericParameter(value, 0.01, 100, false);
      case "q":
      case "quality":
        return numericParameter(value, 0, 100, false);
      case "fm":
      case "format":
        return recognizedImageFormat(value);
      default:
        return false;
    }
  }

  function parameterKind(name, value) {
    const normalized = safeString(name).toLowerCase();
    if (RESIZE_PARAMETERS.has(normalized) && validResizeParameter(normalized, value)) {
      return "resize";
    }
    if (TRACKING_PARAMETERS.has(normalized)) {
      return "tracking";
    }
    return "";
  }

  function variantDescriptor(value) {
    const normalized = normalizeImageUrl(value);
    if (!normalized || /^data:/i.test(normalized)) {
      return {
        key: normalized,
        normalized,
        strippedParameters: [],
        remainingQuery: ""
      };
    }

    try {
      const parsed = new URL(normalized);
      const kept = [];
      const strippedParameters = [];
      let order = 0;
      for (const [name, parameterValue] of parsed.searchParams.entries()) {
        const kind = parameterKind(name, parameterValue);
        if (kind) {
          strippedParameters.push({ name: name.toLowerCase(), kind });
        } else {
          kept.push({ name, value: parameterValue, order });
        }
        order += 1;
      }
      kept.sort((left, right) => {
        const nameOrder = left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
        if (nameOrder) {
          return nameOrder;
        }
        const valueOrder = left.value < right.value ? -1 : left.value > right.value ? 1 : 0;
        return valueOrder || left.order - right.order;
      });
      parsed.search = "";
      for (const entry of kept) {
        parsed.searchParams.append(entry.name, entry.value);
      }
      return {
        key: parsed.href,
        normalized,
        strippedParameters,
        remainingQuery: parsed.search
      };
    } catch (_error) {
      return {
        key: normalized,
        normalized,
        strippedParameters: [],
        remainingQuery: ""
      };
    }
  }

  function safeDecode(value) {
    try {
      return decodeURIComponent(value);
    } catch (_error) {
      return value;
    }
  }

  function normalizedFilename(record, normalizedUrl) {
    let filename = safeString(safeValue(record, "filename")).trim();
    if (!filename && normalizedUrl && !/^data:/i.test(normalizedUrl)) {
      try {
        const parsed = new URL(normalizedUrl);
        filename = safeDecode(parsed.pathname.split("/").filter(Boolean).pop() || "");
      } catch (_error) {
        filename = "";
      }
    }
    filename = typeof filename.normalize === "function" ? filename.normalize("NFKC") : filename;
    const stem = filename
      .replace(/\.[a-z0-9]{2,8}$/i, "")
      .replace(RESIZED_FILENAME_SUFFIX, "")
      .replace(/[\s_.-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLocaleLowerCase("en-US");
    return {
      filename,
      stem,
      descriptive: stem.length >= 4 && !GENERIC_FILENAME.test(stem) && !PLACEHOLDER_FILENAME.test(stem)
    };
  }

  function dimension(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 && numeric <= 1000000
      ? Math.round(numeric)
      : 0;
  }

  function dimensionsFor(record) {
    const width = dimension(safeValue(record, "width"));
    const height = dimension(safeValue(record, "height"));
    return {
      width,
      height,
      area: width && height ? width * height : 0,
      ratio: width && height ? width / height : 0
    };
  }

  function compatibleAspectRatio(leftRecord, rightRecord) {
    return compatibleDimensions(dimensionsFor(leftRecord), dimensionsFor(rightRecord));
  }

  function compatibleDimensions(left, right) {
    if (!left.ratio || !right.ratio) {
      return false;
    }
    return Math.abs(left.ratio - right.ratio) / Math.max(left.ratio, right.ratio) <= 0.025;
  }

  function sourceIdentitiesFor(record) {
    const identities = [];
    for (const field of SOURCE_ID_FIELDS) {
      const value = safeString(safeValue(record, field)).trim();
      if (value && value.length <= 500) {
        identities.push(`${field}:${value}`);
      }
    }
    return identities;
  }

  function sourceIdentityMatch(leftIdentities, rightIdentities) {
    for (const identity of leftIdentities) {
      if (rightIdentities.includes(identity)) {
        return true;
      }
    }
    return false;
  }

  function meaningfulAltFor(record) {
    let alt = safeString(safeValue(record, "alt"));
    alt = typeof alt.normalize === "function" ? alt.normalize("NFKC") : alt;
    alt = alt.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
    return alt.length >= 8 && alt.length <= 500 ? alt : "";
  }

  function corroborationReasons(left, right, leftInfo, rightInfo) {
    const reasons = [];
    if (sourceIdentityMatch(left.sourceIdentities, right.sourceIdentities)) {
      reasons.push("matching-source-id");
    }
    if (compatibleDimensions(left.dimensions, right.dimensions)) {
      reasons.push("matching-aspect-ratio");
    }
    if (
      leftInfo.descriptive &&
      rightInfo.descriptive &&
      leftInfo.stem === rightInfo.stem
    ) {
      reasons.push("matching-filename");
    }
    if (left.meaningfulAlt && left.meaningfulAlt === right.meaningfulAlt) {
      reasons.push("matching-alt-text");
    }
    return reasons;
  }

  function sourceConfidence(record) {
    const kindsValue = safeValue(record, "kinds");
    const kinds = Array.isArray(kindsValue) ? kindsValue : [
      safeValue(record, "kind"),
      safeValue(record, "sourceType")
    ];
    const text = kinds.map(safeString).join(" ").toLocaleLowerCase("en-US");
    let tier = 1;
    if (/\boriginal\b/.test(text)) {
      tier = 5;
    } else if (/(?:full[ -]?size|high[ -]?res(?:olution)?|\bhires\b|linked full)/.test(text)) {
      tier = 4;
    } else if (/(?:largest responsive|\bsrcset\b)/.test(text)) {
      tier = 3;
    } else if (/\blazy\b/.test(text)) {
      tier = 2;
    }

    const url = normalizeImageUrl(safeValue(record, "url"));
    const previewUrl = normalizeImageUrl(safeValue(record, "previewUrl"));
    if (previewUrl && previewUrl !== url) {
      tier = Math.max(tier, 4);
    }
    if (/(?:^|[/_.-])(?:original|full|fullsize|hires)(?:[/_.-]|$)/i.test(url)) {
      tier = Math.max(tier, 3);
    }
    if (tier <= 2 && /(?:^|[/_.-])(?:thumb|thumbnail|preview|small)(?:[/_.-]|$)/i.test(url)) {
      tier = Math.min(tier, 2);
    }
    return tier;
  }

  function deliveryQuality(record) {
    const explicit = Number(safeValue(record, "quality"));
    if (Number.isFinite(explicit) && explicit >= 0) {
      return Math.min(1000, explicit);
    }
    const url = normalizeImageUrl(safeValue(record, "url"));
    if (!url || /^data:/i.test(url)) {
      return 0;
    }
    try {
      const parsed = new URL(url);
      const queryQuality = Number(parsed.searchParams.get("quality") || parsed.searchParams.get("q"));
      return Number.isFinite(queryQuality) && queryQuality >= 0
        ? Math.min(1000, queryQuality)
        : 0;
    } catch (_error) {
      return 0;
    }
  }

  function scoreRecord(record) {
    const dimensions = dimensionsFor(record);
    const descriptor = variantDescriptor(safeValue(record, "url"));
    const resizeParameterCount = descriptor.strippedParameters
      .filter((parameter) => parameter.kind === "resize").length;
    return {
      sourceConfidence: sourceConfidence(record),
      area: dimensions.area,
      width: dimensions.width,
      height: dimensions.height,
      quality: deliveryQuality(record),
      untransformed: resizeParameterCount === 0 ? 1 : 0,
      resizeParameterCount
    };
  }

  function chooseBestRecord(records) {
    if (!Array.isArray(records) || records.length === 0) {
      return null;
    }
    let best = null;
    let bestScore = null;
    for (const record of records) {
      if (!record || typeof record !== "object") {
        continue;
      }
      const score = scoreRecord(record);
      if (!best) {
        best = record;
        bestScore = score;
        continue;
      }
      const left = [
        score.sourceConfidence,
        score.area,
        score.quality,
        score.untransformed,
        Math.max(score.width, score.height),
        -score.resizeParameterCount
      ];
      const right = [
        bestScore.sourceConfidence,
        bestScore.area,
        bestScore.quality,
        bestScore.untransformed,
        Math.max(bestScore.width, bestScore.height),
        -bestScore.resizeParameterCount
      ];
      let replace = false;
      for (let index = 0; index < left.length; index += 1) {
        if (left[index] !== right[index]) {
          replace = left[index] > right[index];
          break;
        }
      }
      if (replace) {
        best = record;
        bestScore = score;
      }
    }
    return best;
  }

  function createDisjointSet(size) {
    const parents = Array.from({ length: size }, (_value, index) => index);
    const ranks = new Uint8Array(size);
    function find(index) {
      let rootIndex = index;
      while (parents[rootIndex] !== rootIndex) {
        rootIndex = parents[rootIndex];
      }
      while (parents[index] !== index) {
        const parent = parents[index];
        parents[index] = rootIndex;
        index = parent;
      }
      return rootIndex;
    }
    function union(left, right) {
      let leftRoot = find(left);
      let rightRoot = find(right);
      if (leftRoot === rightRoot) {
        return;
      }
      if (ranks[leftRoot] < ranks[rightRoot]) {
        [leftRoot, rightRoot] = [rightRoot, leftRoot];
      }
      parents[rightRoot] = leftRoot;
      if (ranks[leftRoot] === ranks[rightRoot]) {
        ranks[leftRoot] += 1;
      }
    }
    return { find, union };
  }

  function addBucket(map, key, index) {
    if (key === "" || key === null || key === undefined) {
      return;
    }
    const bucket = map.get(key);
    if (bucket) {
      bucket.push(index);
    } else {
      map.set(key, [index]);
    }
  }

  function usefulPreviewUrl(url) {
    if (!url || /^data:/i.test(url)) {
      return false;
    }
    try {
      const parsed = new URL(url);
      const pathname = safeDecode(parsed.pathname);
      const filename = pathname.split("/").filter(Boolean).pop() || "";
      return Boolean(filename) && !PLACEHOLDER_FILENAME.test(pathname);
    } catch (_error) {
      return false;
    }
  }

  function pathFilenameSignature(info) {
    if (!info.filename.descriptive || !info.normalized || /^data:/i.test(info.normalized)) {
      return "";
    }
    try {
      const parsed = new URL(info.normalized);
      const parts = parsed.pathname.split("/");
      parts.pop();
      return `${parsed.origin}${parts.join("/")}/${info.filename.stem}`;
    } catch (_error) {
      return "";
    }
  }

  function analyzeDuplicates(records) {
    const sourceRecords = Array.isArray(records) ? records : [];
    const entries = [];
    for (let index = 0; index < sourceRecords.length; index += 1) {
      const record = sourceRecords[index];
      if (!record || typeof record !== "object") {
        continue;
      }
      const normalized = normalizeImageUrl(safeValue(record, "url"));
      if (!normalized) {
        continue;
      }
      const preview = normalizeImageUrl(safeValue(record, "previewUrl"));
      entries.push({
        record,
        index,
        normalized,
        preview: preview && preview !== normalized ? preview : "",
        variant: variantDescriptor(normalized),
        filename: normalizedFilename(record, normalized),
        dimensions: dimensionsFor(record),
        meaningfulAlt: meaningfulAltFor(record),
        sourceIdentities: sourceIdentitiesFor(record)
      });
    }

    const disjoint = createDisjointSet(entries.length);
    const edges = [];
    const primaryBuckets = new Map();
    for (let index = 0; index < entries.length; index += 1) {
      addBucket(primaryBuckets, entries[index].normalized, index);
    }
    for (const bucket of primaryBuckets.values()) {
      for (let position = 1; position < bucket.length; position += 1) {
        disjoint.union(bucket[0], bucket[position]);
        edges.push({ left: bucket[0], right: bucket[position], reason: "same-url", exact: true });
      }
    }
    const previewReferenceBuckets = new Map();
    for (let index = 0; index < entries.length; index += 1) {
      if (usefulPreviewUrl(entries[index].preview)) {
        addBucket(previewReferenceBuckets, entries[index].preview, index);
      }
    }
    for (const [preview, referencingEntries] of previewReferenceBuckets.entries()) {
      const matchingPrimary = primaryBuckets.get(preview) || [];
      if (referencingEntries.length !== 1 || matchingPrimary.length !== 1) {
        continue;
      }
      const sourceIndex = referencingEntries[0];
      const primaryIndex = matchingPrimary[0];
      if (sourceIndex !== primaryIndex) {
        disjoint.union(sourceIndex, primaryIndex);
        edges.push({ left: sourceIndex, right: primaryIndex, reason: "preview-full-link", exact: true });
      }
    }

    const exactComponents = entries.map((_entry, index) => disjoint.find(index));

    function addLikelyEdge(leftIndex, rightIndex, reason, corroboration) {
      disjoint.union(leftIndex, rightIndex);
      edges.push({
        left: leftIndex,
        right: rightIndex,
        reason,
        corroboration: corroboration.slice(),
        exact: false
      });
    }

    const variantBuckets = new Map();
    for (let index = 0; index < entries.length; index += 1) {
      if (!/^data:/i.test(entries[index].variant.key)) {
        addBucket(variantBuckets, entries[index].variant.key, index);
      }
    }
    for (const bucket of variantBuckets.values()) {
      for (let rightPosition = 1; rightPosition < bucket.length; rightPosition += 1) {
        for (let leftPosition = 0; leftPosition < rightPosition; leftPosition += 1) {
          const leftIndex = bucket[leftPosition];
          const rightIndex = bucket[rightPosition];
          const left = entries[leftIndex];
          const right = entries[rightIndex];
          if (left.normalized === right.normalized || (
            left.variant.strippedParameters.length === 0 && right.variant.strippedParameters.length === 0
          )) {
            continue;
          }
          const corroboration = corroborationReasons(left, right, left.filename, right.filename);
          if (corroboration.length) {
            addLikelyEdge(leftIndex, rightIndex, "resized-url-variant", corroboration);
            break;
          }
        }
      }
    }

    const filenameBuckets = new Map();
    for (let index = 0; index < entries.length; index += 1) {
      addBucket(filenameBuckets, pathFilenameSignature(entries[index]), index);
    }
    for (const bucket of filenameBuckets.values()) {
      for (let rightPosition = 1; rightPosition < bucket.length; rightPosition += 1) {
        for (let leftPosition = 0; leftPosition < rightPosition; leftPosition += 1) {
          const leftIndex = bucket[leftPosition];
          const rightIndex = bucket[rightPosition];
          const left = entries[leftIndex];
          const right = entries[rightIndex];
          if (
            left.normalized === right.normalized ||
            left.variant.key === right.variant.key ||
            left.variant.remainingQuery !== right.variant.remainingQuery ||
            !compatibleDimensions(left.dimensions, right.dimensions)
          ) {
            continue;
          }
          addLikelyEdge(leftIndex, rightIndex, "filename-dimension-match", ["matching-aspect-ratio"]);
          break;
        }
      }
    }

    const previewBuckets = new Map();
    for (let index = 0; index < entries.length; index += 1) {
      if (usefulPreviewUrl(entries[index].preview)) {
        addBucket(previewBuckets, entries[index].preview, index);
      }
    }
    for (const bucket of previewBuckets.values()) {
      for (let rightPosition = 1; rightPosition < bucket.length; rightPosition += 1) {
        for (let leftPosition = 0; leftPosition < rightPosition; leftPosition += 1) {
          const leftIndex = bucket[leftPosition];
          const rightIndex = bucket[rightPosition];
          const left = entries[leftIndex];
          const right = entries[rightIndex];
          const corroboration = corroborationReasons(left, right, left.filename, right.filename);
          if (
            corroboration.includes("matching-source-id") ||
            corroboration.includes("matching-filename")
          ) {
            addLikelyEdge(leftIndex, rightIndex, "same-preview", corroboration);
            break;
          }
        }
      }
    }

    const groupedIndexes = new Map();
    for (let index = 0; index < entries.length; index += 1) {
      addBucket(groupedIndexes, disjoint.find(index), index);
    }
    const duplicateBuckets = Array.from(groupedIndexes.values())
      .filter((bucket) => bucket.length > 1)
      .sort((left, right) => entries[left[0]].index - entries[right[0]].index);

    const groups = [];
    const allRecommendedUrls = [];
    const allRecommendedIndexes = [];
    const seenRecommendedUrls = new Set();
    let duplicateRecordCount = 0;
    for (const bucket of duplicateBuckets) {
      bucket.sort((left, right) => entries[left].index - entries[right].index);
      const bucketSet = new Set(bucket);
      const groupRecords = bucket.map((index) => entries[index].record);
      const bestRecord = chooseBestRecord(groupRecords);
      const bestPosition = groupRecords.indexOf(bestRecord);
      const bestEntryIndex = bucket[bestPosition];
      const bestIndex = entries[bestEntryIndex].index;
      const bestUrl = entries[bestEntryIndex].normalized;
      const recommendedRecordsToDeselect = [];
      const recommendedIndexesToDeselect = [];
      const recommendedUrlsToDeselect = [];
      const groupSeenUrls = new Set();
      for (const entryIndex of bucket) {
        if (entryIndex === bestEntryIndex) {
          continue;
        }
        const entry = entries[entryIndex];
        recommendedRecordsToDeselect.push(entry.record);
        recommendedIndexesToDeselect.push(entry.index);
        allRecommendedIndexes.push(entry.index);
        if (entry.normalized !== bestUrl && !groupSeenUrls.has(entry.normalized)) {
          groupSeenUrls.add(entry.normalized);
          recommendedUrlsToDeselect.push(entry.normalized);
          if (!seenRecommendedUrls.has(entry.normalized)) {
            seenRecommendedUrls.add(entry.normalized);
            allRecommendedUrls.push(entry.normalized);
          }
        }
      }
      const groupEdges = edges.filter((edge) => bucketSet.has(edge.left) && bucketSet.has(edge.right));
      const reasons = [];
      const corroboration = [];
      for (const edge of groupEdges) {
        if (!reasons.includes(edge.reason)) {
          reasons.push(edge.reason);
        }
        for (const reason of edge.corroboration || []) {
          if (!corroboration.includes(reason)) {
            corroboration.push(reason);
          }
        }
      }
      const exactRoots = new Set(bucket.map((entryIndex) => exactComponents[entryIndex]));
      const kind = exactRoots.size === 1 ? "exact" : "likely";
      duplicateRecordCount += bucket.length - 1;
      groups.push({
        id: `duplicate-${groups.length + 1}`,
        kind,
        confidence: kind,
        reasons,
        corroboration,
        records: groupRecords,
        indexes: bucket.map((entryIndex) => entries[entryIndex].index),
        bestRecord,
        bestIndex,
        recommendedRecordsToDeselect,
        recommendedIndexesToDeselect,
        recommendedUrlsToDeselect
      });
    }

    return {
      groups,
      duplicateRecordCount,
      duplicateUrlCount: allRecommendedUrls.length,
      recommendedIndexesToDeselect: allRecommendedIndexes,
      recommendedUrlsToDeselect: allRecommendedUrls
    };
  }

  function findDuplicateGroups(records) {
    return analyzeDuplicates(records).groups;
  }

  function recommendedUrlsToDeselect(records) {
    return analyzeDuplicates(records).recommendedUrlsToDeselect;
  }

  const api = Object.freeze({
    analyzeDuplicates,
    chooseBestRecord,
    findDuplicateGroups,
    normalizeImageUrl,
    recommendedUrlsToDeselect,
    scoreRecord,
    variantDescriptor
  });

  root.ImageDownloaderDuplicates = api;
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis === "object" ? globalThis : this);
