(function attachFirefoxCollectorBenchmark(root) {
  "use strict";

  function assert(condition, message) {
    if (!condition) throw new Error(`Firefox collector regression: ${message}`);
  }

  function normalizeRecords(records) {
    return records.map((record) => ({
      url: String(record.url || ""),
      mediaType: String(record.mediaType || "image"),
      width: Number(record.width) || 0,
      height: Number(record.height) || 0,
      previewUrl: String(record.previewUrl || ""),
      duration: Number(record.duration) || 0,
      mimeType: String(record.mimeType || ""),
      kinds: Array.from(record.kinds || [], String).slice(0, 8)
    })).sort((left, right) => left.url.localeCompare(right.url));
  }

  function collectorOptions(includeBackgrounds) {
    return {
      includeBackgrounds,
      maxImages: 5000,
      maxElements: 10000,
      maxDataUrlLength: 500000,
      maxPayloadLength: 2000000
    };
  }

  function validateResult(result, fixture, includeBackgrounds) {
    assert(result && Array.isArray(result.images), "collector did not return an image array");
    assert(result.images.length <= 5000, "collector exceeded its 5,000-item bound");
    const backgroundUrl = new URL("/media/long/background.svg", location.href).href;
    const expectedUrls = fixture.expectedUrls.filter((url) => includeBackgrounds || url !== backgroundUrl);
    const expectedSet = new Set(expectedUrls);
    const records = normalizeRecords(result.images);
    const actualUrls = records.map((record) => record.url);
    const actualSet = new Set(actualUrls);
    const missing = expectedUrls.filter((url) => !actualSet.has(url));
    const unexpected = actualUrls.filter((url) => !expectedSet.has(url));
    assert(actualSet.size === records.length, "duplicate URLs were returned");
    assert(records.length === expectedUrls.length && missing.length === 0 && unexpected.length === 0,
      `expected exactly ${expectedUrls.length} media items, received ${records.length}; ` +
      `missing=${JSON.stringify(missing.slice(0, 12))}, unexpected=${JSON.stringify(unexpected.slice(0, 12))}`);

    const expectedVideoUrls = new Set(fixture.videoPaths.map((path) => new URL(path, location.href).href));
    for (const record of records) {
      const parsed = new URL(record.url);
      assert(parsed.origin === location.origin && /^https?:$/.test(parsed.protocol) &&
        !parsed.username && !parsed.password && parsed.href === record.url,
      `unsafe or noncanonical media URL: ${record.url}`);
      assert(record.mediaType === (expectedVideoUrls.has(record.url) ? "video" : "image"),
        `wrong media type for ${record.url}`);
      assert(Number.isFinite(record.width) && record.width >= 0 && Number.isFinite(record.height) && record.height >= 0,
        `invalid dimensions for ${record.url}`);
      assert(record.kinds.length > 0 && record.kinds.every((kind) => kind.length > 0),
        `missing source kind for ${record.url}`);
      if (record.previewUrl) {
        const preview = new URL(record.previewUrl);
        assert(preview.origin === location.origin && /^https?:$/.test(preview.protocol) &&
          !preview.username && !preview.password && preview.href === record.previewUrl && record.previewUrl !== record.url,
        `unsafe, duplicate or noncanonical preview URL for ${record.url}`);
      }
    }

    const passedChecks = [
      "Exact expected URL set and count",
      "No duplicate, unsafe or noncanonical media/preview URLs",
      "Correct image/video classification and finite dimensions",
      "Bounded media count and source kinds"
    ];
    if (fixture.kind === "long-dom") {
      const byPath = (path) => records.find((record) => record.url === new URL(path, location.href).href);
      const fullSize = byPath(fixture.fullSizePath);
      assert(fullSize.width === fixture.fullSizeDimensions.width && fullSize.height === fixture.fullSizeDimensions.height,
        "lazy full-size dimensions were lost");
      assert(fullSize.kinds.includes("Full-size image"), "lazy original was not classified as full-size");
      assert(byPath("/media/long/late.svg"), "direct image after the general DOM budget was missed");
      assert(byPath("/media/long/shadow.svg"), "image in an early-discovered open shadow root was missed");
      const responsive = byPath("/media/long/responsive-full.svg");
      assert(responsive.width === 1600 && responsive.kinds.includes("Largest responsive image"),
        "largest responsive source or its width hint was lost");
      assert(!byPath("/media/long/responsive-small.svg"), "responsive thumbnail was returned instead of full-size source");
      if (includeBackgrounds) {
        assert(byPath("/media/long/background.svg").kinds.includes("CSS image"), "early CSS background was lost");
      } else {
        assert(!byPath("/media/long/background.svg"), "CSS background was collected while disabled");
      }
      const clipUrl = new URL("/media/long/clip.webm", location.href).href;
      const clip = result.images.find((record) => record.url === clipUrl);
      assert(clip.width === 64 && clip.height === 48 && Math.abs(clip.duration - 1) < 0.05 && clip.mimeType === "video/webm",
        "video dimensions, duration or MIME metadata were lost (wait for loadedmetadata before measuring)");
      assert(clip.previewUrl === new URL("/media/long/poster.svg", location.href).href,
        "video poster preview was lost");
      const budgetWarning = fixture.expectedWarningIncludes.replace("10,000", (10000).toLocaleString());
      assert(result.warnings.some((warning) => warning.includes(budgetWarning)),
        `long DOM general-element budget warning was lost: ${JSON.stringify(result.warnings)}`);
      passedChecks.push("Late image/video and open-shadow media beyond the general DOM budget",
        "Lazy original dimensions and largest responsive source",
        includeBackgrounds ? "CSS background discovery" : "CSS background exclusion",
        "Video dimensions, one-second duration, WebM MIME and poster preview",
        "General DOM budget warning");
    } else {
      assert(records.every((record) => record.width === 1200 && record.height === 900 &&
        record.kinds.includes("Full-size image")), "gallery full-size dimensions or source classification were lost");
      assert(result.warnings.length === 0, `unexpected gallery warnings: ${JSON.stringify(result.warnings)}`);
      passedChecks.push("Full-size dimensions for every gallery image", "No unexpected gallery warnings");
    }
    return { records, passedChecks };
  }

  // Inject after extension/shared/collector.js and await fixture readiness and
  // video loadedmetadata before calling. Assertions are outside timed regions.
  root.runFirefoxCollectorBenchmark = function runFirefoxCollectorBenchmark(options = {}) {
    assert(typeof root.ImageDownloaderCollector === "function", "collector.js has not been loaded");
    assert(root.fixture && root.fixture.ready && Array.isArray(root.fixture.expectedUrls), "fixture is not ready");
    const includeBackgrounds = options.includeBackgrounds !== false;
    const settings = collectorOptions(includeBackgrounds);
    let result;
    for (let warmup = 0; warmup < 2; warmup += 1) result = root.ImageDownloaderCollector(settings);
    const samplesMs = [];
    for (let sample = 0; sample < 7; sample += 1) {
      const start = performance.now();
      result = root.ImageDownloaderCollector(settings);
      samplesMs.push(performance.now() - start);
    }
    // Validate once after all samples so assertion and normalization allocations
    // do not add unrelated garbage-collection pressure between measurements.
    const validated = validateResult(result, root.fixture, includeBackgrounds);
    const sorted = samplesMs.slice().sort((left, right) => left - right);
    return {
      fixtureKind: root.fixture.kind,
      includeBackgrounds,
      warmups: 2,
      sampleCount: samplesMs.length,
      samplesMs,
      medianMs: sorted[Math.floor(sorted.length / 2)],
      p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
      count: validated.records.length,
      records: validated.records,
      discoveryOrder: result.images.map((record) => record.url),
      warnings: Array.from(result.warnings || [], String),
      passedChecks: validated.passedChecks
    };
  };

  // Optional isolated safety checks use an inert native HTMLDocument: they do
  // not modify the visible fixture or issue external media requests.
  root.runFirefoxCollectorEdgeChecks = function runFirefoxCollectorEdgeChecks() {
    assert(typeof root.ImageDownloaderCollector === "function", "collector.js has not been loaded");
    const sourceDocument = document.implementation.createHTMLDocument("Collector safety cases");
    const base = sourceDocument.createElement("base");
    base.href = location.href;
    sourceDocument.head.append(base);
    sourceDocument.body.innerHTML = '<img src="/media/long/edge-valid.svg">' +
      '<img src="http://[">' +
      '<img src="javascript:void(0)">' +
      `<img src="blob:${location.origin}/fixture-missing">` +
      '<video src="/media/long/stream.m3u8"></video>' +
      '<video src="/media/long/stream.mpd"></video>' +
      `<video src="blob:${location.origin}/fixture-video-missing"></video>` +
      '<video src="/media/long/clip.webm" type="video/webm"></video>' +
      '<img src="/media/long/edge-valid.svg">';
    const result = root.ImageDownloaderCollector(collectorOptions(false), sourceDocument);
    const records = normalizeRecords(result.images);
    const expected = ["/media/long/edge-valid.svg", "/media/long/clip.webm"].map((path) => new URL(path, location.href).href).sort();
    assert(records.length === 2 && records.map((record) => record.url).sort().every((url, index) => url === expected[index]),
      "malformed, script, blob or streaming-manifest URLs leaked into results, or valid duplicates were not collapsed");
    assert(result.warnings.some((warning) => warning.includes("streaming video manifest")), "manifest rejection warning was lost");
    assert(result.warnings.some((warning) => warning.includes("blob image")) &&
      result.warnings.some((warning) => warning.includes("blob video")), "blob rejection warnings were lost");
    return {
      count: records.length,
      records,
      warnings: Array.from(result.warnings || [], String),
      passedChecks: ["Malformed and script URL rejection", "Blob image/video rejection and warnings",
        "HLS/DASH manifest rejection and warnings", "Duplicate URL collapse", "Valid image and direct video preservation"]
    };
  };
})(globalThis);
