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

## Test and lint

The Node tests require no dependency installation.

```bash
npm test
npx --yes web-ext@10.6.0 lint --source-dir extension
```

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
