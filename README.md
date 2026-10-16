# AnyDownload

## Launch locally

Use Node.js 22 (matching CI) and Firefox desktop 140+. Run commands from the repository root.

```bash
npx --yes web-ext@10.6.0 run --source-dir extension --devtools
```

This opens a temporary Firefox profile and reloads the extension when source files change. Open a media page and click the AnyDownload toolbar button.

To load it in your existing Firefox profile:

1. Open `about:debugging` → **This Firefox** → **Load Temporary Add-on**.
2. Select `extension/manifest.json`.
3. Click **Reload** after editing source files. The temporary add-on is removed when Firefox restarts.

## Media manager

Use **All / Images / Videos** above the gallery to narrow the collection. Advanced filters appear as removable chips; filtering preserves your selection, and the footer identifies selected files hidden by filters.

Use **Download** for individual files, or its arrow menu for an image-only ZIP or an Immich upload. Each card's **More** menu offers download and ignore/restore actions. **Settings** contains Account and Integrations. **Page actions** contains tracking, scan options, and **Clear collection and rescan…**, which resets the saved collection while keeping downloaded files and history.

The same manager opens in the Firefox Sidebar, with a compact list at narrow widths.

## Test and lint

The Node tests require no dependency installation.

```bash
npm test
npx --yes web-ext@10.6.0 lint --source-dir extension
```

## Code structure and performance

| Area | Responsibility |
| --- | --- |
| `extension/shared/` | Reusable validation, collectors, provider adapters, filtering, filenames, queue and storage models. Modules expose browser globals and CommonJS exports for dependency-free tests. |
| `extension/background.js` | Firefox APIs, serialized durable queue operations, download reconciliation, trackers, saved galleries and cloud integration. Normal and private work use separate storage contexts. |
| `extension/popup/` | Gallery state, filters, selection, paginated rendering, previews and bounded dimension probes. The Sidebar reuses this manager. |
| Other extension page folders | Dedicated interfaces for history, tracking, archive creation, uploads, synchronization and integrations. |
| `tests/` | Pure model tests and DOM/Firefox API fixtures that exercise page and background behavior. |

Page scans reuse URL parsing and ancestor metadata within each scan, with bounded URL caches. Complete tree walks avoid a redundant media query; truncated scans retain a separate bounded media pass. The manager formats unselected filename previews as rows become visible and preserves cards when download statuses have not changed. Queue progress updates copy changed tasks, and batched reconciliation updates each affected job once. Queue admission determines all necessary history-detail evictions before validating the retained state.

Selected filename batches use indexed collision checks, preserving filename order and Unicode behavior without rescanning earlier names. Saved-gallery normalization reuses bounded source-page validations and avoids parsing empty optional previews.

Run the synthetic 5,000-task queue benchmarks with:

```bash
npm run benchmark
# Compare working-tree code with a repository revision, e.g. before committing:
npm run benchmark -- --baseline-ref=HEAD
```

The benchmark reports median Node model timings and task-copy counts. These exclude Firefox rendering, storage, network and server latency. Regression tests also check operation counts, cache limits, selected filename uniqueness, download history and private-context separation.

For an actual Firefox comparison, run:

```bash
npm run benchmark:firefox -- --baseline-ref=HEAD
# Optional: executable, artifact directory, or reverse the build order.
npm run benchmark:firefox -- --firefox=/path/to/firefox --output-dir=/tmp/anydownload-firefox-results --variants=optimized,baseline
# Compare an uncommitted snapshot, measuring fresh and saved collection openings.
npm run benchmark:firefox -- --baseline-dir=/path/to/before/extension --opening-samples=3
# Add --opening-only to skip the separate interaction and download regressions.
```

This requires Python 3.9+, Node and desktop Firefox. The default executable is the macOS Firefox application. The harness launches a visible browser in disposable profiles, serves local galleries, and grants the test extension access to localhost and private windows. Identical instrumentation is added to temporary extension copies; the repository extension is left intact. JSON results, logs, screenshots and verified downloads are written to the printed artifact directory. Close other heavy work while measuring, and repeat with the build order reversed.

The earlier scan/interaction comparison against commit `9fc609a` used Firefox 158/macOS and three comparisons, including a reversed build order. Medians over 21 samples per build for a 5,000-image gallery were:

| Operation | Before | Optimized |
| --- | ---: | ---: |
| Collector scan on loaded DOM, including CSS backgrounds | 133 ms | 99 ms |
| Deselect event handler | 60 ms | 18 ms |
| Single checkbox event handler | 53 ms | 10 ms |
| Dimension update with default filename template | 50 ms | <1 ms |

That earlier comparison changed initial manager readiness only slightly (2.88 s to 2.78 s across three launches per build); pagination and debounced search were broadly unchanged. Media records, discovery order and warnings matched. Both builds passed 23 UI checks per run, native download byte checks and private-storage separation checks; later runs also verified live discovery and preserved selection. [Raw samples, methodology and regression results](benchmarks/firefox-2026-10-16.json) describe this desktop localhost test's scope.

The subsequent opening-focused changes compare with a snapshot that already contains those scan/interaction improvements. On the same Firefox 158 desktop fixture, two comparisons in opposite build orders, with six samples per build and mode, measured:

| 5,000-image opening | Before | Optimized | Time reduction |
| --- | ---: | ---: | ---: |
| Fresh collection, full initialization | 2.69 s | 1.07 s | 60% |
| Saved collection, full initialization | 4.25 s | 1.04 s | 76% |
| Fresh collection, interactive-frame proxy | 2.17 s | 0.59 s | 73% |

Every opening retained all 5,000 selections. Full initialization includes gallery persistence and live-capture setup; the frame proxy uses two animation frames after the first non-busy collection render. Selected filename generation fell from 1,583 ms to 50.5 ms for fresh collections. Both builds passed 24 browser UI checks, including Unicode filename collisions, plus native-download, private-storage and live-update checks. [Opening samples, source checksums and startup profiles](benchmarks/firefox-opening-2026-10-16.json) record the exact comparison.

## Build

```bash
npx --yes web-ext@10.6.0 build --source-dir extension --artifacts-dir release-artifacts
```

The ZIP is written to `release-artifacts/`. For permanent installation, submit it for Mozilla signing through the [Firefox Add-on Developer Hub](https://addons.mozilla.org/developers/).

## Publish a release

1. Update the version in `extension/manifest.json`, `package.json`, and `tests/run-tests.cjs`.
2. Move the relevant **Unreleased** entries in `CHANGELOG.md` into a dated version section.
3. Run the tests and lint above, then commit and push `main`.
4. Create and push an annotated tag matching the new version:

```bash
release_version=$(node -p "require('./package.json').version")
git tag -a "v${release_version}" -m "AnyDownload ${release_version}"
git push origin "v${release_version}"
```

Configure the repository secrets `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` before releasing. The [release workflow](.github/workflows/release.yml) tests, lints, builds, submits the listed update to AMO, and publishes the GitHub release with the ZIP and checksum. Firefox distributes the update after Mozilla approval; the GitHub ZIP is unsigned.

## Service setup

- [Cloud sync setup](supabase/README.md)
- [Immich integration setup](supabase/INTEGRATIONS.md)
