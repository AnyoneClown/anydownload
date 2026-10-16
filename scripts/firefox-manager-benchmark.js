"use strict";

// Loaded by benchmark-firefox.py into an actual Firefox extension manager tab.
// __anydownloadBench exists only in disposable instrumented extension copies.
globalThis.runFirefoxManagerBenchmark = async function ({ samples = 7 } = {}) {
  const bench = globalThis.__anydownloadBench;
  const checks = [];
  const errors = [];
  const metrics = {};
  const observations = {};
  const sampleCount = Math.max(1, Math.min(30, Math.floor(Number(samples) || 7)));
  const byId = (id) => {
    const element = document.getElementById(id);
    if (!element) throw new Error(`Missing manager control: #${id}`);
    return element;
  };
  const rows = () => Array.from(document.querySelectorAll("#image-list .image-row"));
  const firstCheckbox = () => rows()[0].querySelector('input[type="checkbox"]');
  const paint = () => new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const waitFor = async (predicate, description, timeout = 15000) => {
    const started = performance.now();
    while (!predicate()) {
      if (performance.now() - started > timeout) throw new Error(`Timed out: ${description}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const check = (name, passed, details) => {
    const record = { name, passed: Boolean(passed) };
    if (details !== undefined) record.details = details;
    checks.push(record);
    if (!record.passed) errors.push(`Regression check failed: ${name}`);
  };
  const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };
  const summarize = (values) => ({
    samples: values,
    medianSyncMs: median(values.map((value) => value.syncMs)),
    medianPaintedMs: median(values.map((value) => value.paintedMs)),
    medianRenderCpuMs: median(values.map((value) => value.renderCpuMs))
  });
  const measure = async (action, complete) => {
    const renderStart = bench.renders.length;
    const started = performance.now();
    const returned = action();
    const syncMs = performance.now() - started;
    if (returned && typeof returned.then === "function") await returned;
    if (complete) await complete();
    await paint();
    const paintedMs = performance.now() - started;
    const renders = bench.renders.slice(renderStart);
    return {
      syncMs, paintedMs,
      renderCpuMs: renders.reduce((sum, duration) => sum + duration, 0),
      renderCount: renders.length
    };
  };
  const runSamples = async (name, action, prepare, complete) => {
    const values = [];
    // The same two untimed warmups and seven default samples run in each build.
    for (let index = -2; index < sampleCount; index += 1) {
      if (prepare) await prepare(index);
      const value = await measure(() => action(index), complete && (() => complete(index)));
      if (index >= 0) values.push(value);
    }
    metrics[name] = summarize(values);
  };
  const click = (id) => byId(id).click();
  const setTemplate = async (value) => {
    const control = byId("filename-template-input");
    control.value = value;
    control.dispatchEvent(new Event("input", { bubbles: true }));
    await paint();
  };
  const setSearch = async (value) => {
    const previous = bench.generation;
    const input = byId("filter-input");
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await waitFor(() => bench.generation > previous, "debounced search render");
    await paint();
  };
  const resetView = async () => {
    bench.resetMediaFilters();
    byId("sort-select").value = "page";
    byId("sort-select").dispatchEvent(new Event("change", { bubbles: true }));
    await paint();
  };

  if (!bench) return { metrics, checks, errors: ["Missing test-only manager instrumentation"] };
  const originalTemplate = byId("filename-template-input").value;
  const dimensionOriginals = [];
  try {
    await waitFor(() => !bench.state.busy && bench.state.images.length > 0, "initial gallery scan");
    bench.stopLiveCapture();
    await resetView();
    await setTemplate("{index}-{filename}");
    check("large gallery contains 5,000 media", bench.state.images.length === 5000, bench.state.images.length);
    check("first gallery page has 350 cards", rows().length === 350, rows().length);
    check("first pagination label", byId("pagination-label").textContent === `1–350 of ${(5000).toLocaleString()}`,
      byId("pagination-label").textContent);
    if (bench.state.images.length !== 5000 || rows().length !== 350) {
      throw new Error("Expected the deterministic 5,000-image benchmark gallery");
    }
    observations.initialSelection = bench.state.selected.size;

    await runSamples("deselectAll", () => click("select-none-button"), async () => {
      click("select-all-button");
      await paint();
    });
    check("Deselect removes all selections", bench.state.selected.size === 0);

    await runSamples("singleCheckbox", () => firstCheckbox().click());
    check("single checkbox tracks selection", bench.state.selected.size <= 1 &&
      firstCheckbox().checked === bench.state.selected.has(rows()[0].anydownloadImage.url));
    click("select-none-button");
    await paint();

    await runSamples("nextPage", () => click("next-page-button"), async () => {
      while (bench.state.galleryPage > 0) click("previous-page-button");
      await paint();
    });
    check("second page starts at item 351", bench.state.galleryPage === 1 && rows().length === 350 &&
      rows()[0].anydownloadImage.url === bench.state.images[350].url);
    await runSamples("previousPage", () => click("previous-page-button"), async () => {
      while (bench.state.galleryPage > 0) click("previous-page-button");
      click("next-page-button");
      await paint();
    });

    let searchGeneration = 0;
    await runSamples("filterSearch", (index) => {
      searchGeneration = bench.generation;
      const input = byId("filter-input");
      input.value = index % 2 ? "00001.svg" : "00002.svg";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, undefined, () => waitFor(() => bench.generation > searchGeneration, "search input debounce"));
    check("search matches exactly one image", bench.filteredImages().length === 1 && rows().length === 1);
    observations.searchDebounceMs = 90;
    await setSearch("");
    check("clearing search restores 5,000 media", bench.filteredImages().length === 5000 && rows().length === 350);

    const dimensionImage = rows()[0].anydownloadImage;
    const dimensionRow = rows()[0];
    dimensionOriginals.push({ image: dimensionImage, width: dimensionImage.width,
      height: dimensionImage.height, dimensionStatus: dimensionImage.dimensionStatus });
    await runSamples("dimensionsDefaultTemplate", (index) =>
      bench.applyDimensionResult(dimensionImage.url, { width: 1600 + index, height: 900 }));
    check("dimension updates refresh card metadata", dimensionRow.querySelector(".image-meta").textContent
      .includes(Number(dimensionImage.width).toLocaleString()));

    await setTemplate("{name}-{width}x{height}.{ext}");
    await runSamples("dimensionsWidthTemplate", (index) =>
      bench.applyDimensionResult(dimensionImage.url, { width: 1800 + index, height: 901 }));
    const dimensionName = dimensionRow.querySelector(".image-name > span").textContent;
    check("width and height tokens update filename", dimensionName.includes(`${dimensionImage.width}x901`), dimensionName);
    await setTemplate("{index}-{filename}");

    // Check selection through the actual page and search controls. These are
    // outside timing samples, so their assertions cannot bias CPU measurements.
    click("select-none-button");
    firstCheckbox().click();
    const firstUrl = rows()[0].anydownloadImage.url;
    click("next-page-button");
    firstCheckbox().click();
    const secondUrl = rows()[0].anydownloadImage.url;
    await setSearch("00001.svg");
    check("selection survives page changes and filtering", bench.state.selected.size === 2 &&
      bench.state.selected.has(firstUrl) && bench.state.selected.has(secondUrl) && firstCheckbox().checked);
    check("hidden selections remain visible in summary", byId("selected-label").textContent.includes("1 hidden"),
      byId("selected-label").textContent);
    await setSearch("");
    click("selected-label");
    const selectedNames = rows().map((row) => row.querySelector(".image-name > span").textContent);
    check("selected review preserves page-order filename indices", rows().length === 2 &&
      selectedNames[0].startsWith("0001-") && selectedNames[1].startsWith("0002-"), selectedNames);
    click("back-to-collection-button");

    const duplicateInputs = bench.selectedDownloadableImages().map((image) =>
      ({ ...image, filename: "collision.svg", mimeType: "image/svg+xml" }));
    const duplicateNames = bench.renderedDownloadItems(duplicateInputs, "{filename}").map((item) => item.filename);
    check("download filename collisions receive distinct suffixes",
      duplicateNames.length === 2 && duplicateNames[0] === "collision.svg" && duplicateNames[1] === "collision-2.svg",
      duplicateNames);
    const indexNames = bench.renderedDownloadItems(duplicateInputs, "{index}-{filename}").map((item) => item.filename);
    check("download batch filename index follows selected page order",
      indexNames[0] === "0001-collision.svg" && indexNames[1] === "0002-collision.svg", indexNames);
    const unicodeSequences = [
      ["J\u030c.jpg", "J\u030c.jpg", "J\u030c.jpg"],
      ["J\u030c.jpg", "ǰ.jpg", "J\u030c.jpg"],
      ["ǰ.jpg", "J\u030c.jpg", "ǰ.jpg"]
    ];
    const unicodeParity = unicodeSequences.every((filenames) => {
      const inputs = filenames.map((filename, index) => ({
        url: `https://example.invalid/unicode-${index}.jpg`, filename, mediaType: "image", mimeType: "image/jpeg"
      }));
      const usedNames = new Set();
      const expected = inputs.map((image, index) => ImageDownloaderTemplates.render("{filename}",
        { ...image, index: index + 1 }, { usedNames }));
      return JSON.stringify(bench.renderedDownloadItems(inputs, "{filename}").map((item) => item.filename)) ===
        JSON.stringify(expected);
    });
    check("Unicode collision names match legacy Set ordering", unicodeParity);
    click("select-none-button");

    while (!byId("next-page-button").disabled) click("next-page-button");
    check("final gallery page contains 100 cards", rows().length === 100 && bench.state.galleryPage === 14, rows().length);
    check("final pagination label", byId("pagination-label").textContent === `4901–5000 of ${(5000).toLocaleString()}`,
      byId("pagination-label").textContent);
    while (bench.state.galleryPage > 0) click("previous-page-button");
    await paint();

    byId("sort-select").value = "name";
    byId("sort-select").dispatchEvent(new Event("change", { bubbles: true }));
    check("filename sort retains all media", bench.filteredImages().length === 5000 && rows().length === 350);
    byId("sort-select").value = "resolution";
    byId("sort-select").dispatchEvent(new Event("change", { bubbles: true }));
    const resolutionItems = bench.filteredImages();
    check("resolution sort orders descending image area", resolutionItems.every((image, index) =>
      index === 0 || resolutionItems[index - 1].width * resolutionItems[index - 1].height >= image.width * image.height));
    byId("sort-select").value = "page";
    byId("sort-select").dispatchEvent(new Event("change", { bubbles: true }));
    await paint();

    const beforeStatusRow = rows()[0];
    const statusTiming = await measure(() => bench.refreshDownloadStatuses());
    observations.unchangedStatusRefresh = { ...statusTiming, preservesCardNode: beforeStatusRow === rows()[0] };
    check("unchanged status refresh preserves gallery count", bench.state.images.length === 5000 && rows().length === 350);

    rows()[0].querySelector("button.preview").click();
    check("preview dialog opens", byId("media-preview-dialog").open);
    await waitFor(() => {
      const image = byId("media-preview-stage").querySelector("img");
      return image && image.complete && image.naturalWidth > 0;
    }, "local image preview load");
    const previewImage = byId("media-preview-stage").querySelector("img");
    check("preview decodes real local image", previewImage.naturalWidth > 0 && previewImage.naturalHeight > 0,
      { width: previewImage.naturalWidth, height: previewImage.naturalHeight });
    click("close-preview-button");
    check("preview dialog closes", !byId("media-preview-dialog").open);
  } catch (error) {
    errors.push(String(error && error.stack || error));
  } finally {
    try {
      for (const original of dimensionOriginals) {
        bench.applyDimensionResult(original.image.url, original);
        if (original.dimensionStatus === undefined) delete original.image.dimensionStatus;
        else original.image.dimensionStatus = original.dimensionStatus;
      }
      await resetView();
      await setTemplate(originalTemplate);
      click("select-none-button");
      await paint();
    } catch (error) {
      errors.push(`Cleanup: ${String(error)}`);
    }
  }
  const result = { sampleCount, metrics, checks, observations,
    errors: [...errors, ...(bench.errors || [])],
    finalState: { images: bench.state.images.length, selected: bench.state.selected.size,
      page: bench.state.galleryPage, renderedCards: rows().length, incognito: bench.state.incognito } };
  globalThis.__anydownloadManagerBenchmarkResult = result;
  return result;
};
