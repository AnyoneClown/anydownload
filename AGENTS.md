# AGENTS.md

## Project overview

AnyDownload is a Manifest V3 Firefox extension for desktop and Android. Source code lives in `extension/`; dependency-free Node tests live in `tests/`.

### Main features

- Scans the active page for images and direct video files, preferring exposed full-size sources.
- Provides previews, ignore rules, filters, safe filename templates, destination folders, and bulk downloads.
- Includes a durable download queue, retry controls, history, statistics, and a completed-download ledger.
- Supports live gallery updates, a responsive manager, Firefox Sidebar, and context-menu actions.
- Builds local, image-only ZIP archives with bounded memory and partial-failure reporting.
- Includes bounded adapters for Instagram posts/profiles/stories/highlights, FapFolder group videos, and basic public YouTube progressive formats.
- Tracks static pages periodically with review, notification, or automatic-download actions.
- Keeps normal data locally and private-window state in session storage. It does not decrypt DRM, mux tracks, or reconstruct Blob/HLS/DASH streams.

## Development

Run all checks with:

```bash
npm test
npx --yes web-ext@10.6.0 lint --source-dir extension
```

Preserve minimal permissions, strict validation, bounded storage/network work, and normal/private-context separation.

## Publishing a release

1. Choose a new version and update it in `extension/manifest.json`, `package.json`, and `tests/run-tests.cjs`.
2. Move relevant `CHANGELOG.md` entries from **Unreleased** into a dated version section.
3. Run the checks, commit, and push `main`.
4. Create and push an annotated matching tag:

```bash
git tag -a v1.13.0 -m "AnyDownload 1.13.0"
git push origin v1.13.0
```

`.github/workflows/release.yml` tests, lints, builds, submits the listed update to AMO, and creates the GitHub release. Firefox distributes it after Mozilla approval.
