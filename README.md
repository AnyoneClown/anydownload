# Page Image Downloader for Firefox

This repository contains a working Manifest V3 Firefox extension. It scans the **currently loaded page**, lists distinct image URLs, lets you save one image or select many, and downloads them to a named folder below Firefox's configured Downloads directory.

The manifest targets Firefox desktop 140+ and Firefox for Android 142+. Firefox for Android does not support the optional Save As dialog, so that checkbox is disabled there.

## Try it in two minutes

1. Open Firefox and enter `about:debugging` in the address bar.
2. Choose **This Firefox** → **Load Temporary Add-on**.
3. Select `extension/manifest.json` from this project.
4. Open a normal website, select the extension's toolbar button, and wait for the image list.
5. Enter a relative destination such as `Website images/example.com`, select the images you want, and choose **Download selected**.

The temporary extension is removed when Firefox restarts. Use the **Reload** button on `about:debugging` after changing source files. Mozilla documents this workflow in [Temporary installation in Firefox](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/).

If you are upgrading from version 1.0.0, reload the temporary add-on from `about:debugging` before reopening the toolbar popup. Version 1.0.1 fixes Firefox initially constraining the popup to a narrow strip.

## The folder limitation that matters

Firefox's `downloads.download()` API accepts a filename **relative to Firefox's configured Downloads directory**. It rejects absolute paths and `../` traversal. Therefore:

```text
Folder field: Website images/example.com
Actual destination: <Firefox Downloads>/Website images/example.com/
```

A regular WebExtension cannot choose `/Users/you/Pictures` once and then silently write hundreds of files there. You have three practical options:

1. In Firefox **Settings → General → Files and Applications → Downloads**, make your preferred root directory the default; this extension then creates a subfolder below it.
2. Enable **Show a Save As dialog when downloading exactly one image** for one-off downloads.
3. If arbitrary bulk destinations are essential, add a separately installed [native-messaging](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging) application. The native helper performs filesystem writes; the extension sends it validated URLs and paths. This requires an OS-specific installer and a native-host manifest, so it is intentionally outside this browser-only version.

The exact `filename` and `saveAs` rules are in Mozilla's [`downloads.download()` documentation](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/downloads/download).

## How the implementation works

```text
Toolbar popup
  └─ browser.scripting.executeScript() using temporary activeTab access
       └─ collector runs inside the current page and returns image metadata
  └─ selection UI sends a validated DOWNLOAD_BATCH message
       └─ Firefox background event page sanitizes names and calls downloads.download()
```

- `extension/manifest.json` declares the toolbar popup and only four permissions: `activeTab`, `scripting`, `downloads`, and `storage`.
- `extension/popup/popup.js` injects a self-contained collector. It detects the chosen `<img currentSrc>`, common lazy-image attributes, SVG `<image>` resources, video posters, image inputs, CSS image URLs, open shadow roots, and frames Firefox permits it to inspect.
- `extension/shared/core.js` validates relative folder paths, rejects unsafe URL schemes, creates filenames, strips traversal/illegal characters, handles Windows-reserved names, and resolves duplicate names.
- `extension/background.js` validates the request again, keeps at most five download-start API calls in flight, and uses `conflictAction: "uniquify"` so existing files are not overwritten. Firefox controls the number of network transfers after accepting them.
- Embedded `data:image` resources are converted to extension-owned Blob URLs. The background page retains each Blob until Firefox reports that download complete or interrupted.
- `extension/popup/popup.html` never interpolates page content with `innerHTML`; it uses DOM nodes and `textContent`. Thumbnails use `referrerpolicy="no-referrer"` and load only as their rows approach the visible list.

The `activeTab` permission is granted only after the user invokes the toolbar action. It avoids asking for permanent access to every website. Mozilla's [`scripting`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/scripting) and [`activeTab`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/permissions) documentation explains that permission model.

## Development loop

The included checks need only Node.js:

```bash
cd firefox-image-downloader
npm test
```

For Mozilla's current `web-ext` v10 tooling, use a current Node.js LTS release, install `web-ext`, and run:

```bash
web-ext lint --source-dir extension
web-ext run --source-dir extension --devtools
web-ext build --source-dir extension
```

`web-ext run` launches a temporary Firefox profile and reloads the add-on when source files change. `web-ext build` creates a submission ZIP. See Mozilla's [Getting started with web-ext](https://extensionworkshop.com/documentation/develop/getting-started-with-web-ext/).

## Package and install permanently

Normal Firefox Release and Beta builds require Mozilla signing for permanent installation.

1. Change `browser_specific_settings.gecko.id` in `manifest.json` to your own stable, unique email-style ID.
2. Run the tests and `web-ext lint`.
3. Build a ZIP with `web-ext build --source-dir extension`.
4. Submit it through the [Firefox Add-on Developer Hub](https://addons.mozilla.org/developers/) as a listed add-on, or use Mozilla's unlisted signing channel for private distribution.

The manifest declares `data_collection_permissions.required: ["none"]` because this implementation sends no browsing/image information to an analytics or cloud service. If you later add telemetry or remote processing, update that declaration and the privacy experience. See Mozilla's [Firefox built-in data consent guide](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/) and [signing overview](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/).

## Known boundaries

- It scans what is currently present or referenced in the loaded DOM; it does not crawl every page of an entire domain.
- Scroll first and rescan when a site creates image elements only as they approach the viewport. Infinite-scroll pages expose only the content loaded so far.
- `currentSrc` downloads the responsive resource the browser chose, not every candidate in `srcset`.
- With `activeTab`, the top page and permitted/same-origin frames are scanned. Cross-origin frames may be omitted unless you add broader host permissions.
- Page-created `blob:` URLs are skipped with a warning because Firefox does not let an extension background page download a Blob owned by the website. Ordinary HTTP(S) URLs and embedded `data:image` resources are supported.
- Canvas pixels, inline SVG markup, closed shadow roots, browser-internal pages, the built-in PDF viewer, and protected Mozilla pages are not downloadable through this scanner.
- A safety limit caps a scan/batch at 1,500 images and computed-style inspection at 10,000 elements. The popup renders at most 350 matching rows at once, while bulk selection still includes all discovered records.
- Private-window downloads retain their private browsing context when the user has allowed the extension in private windows. Firefox Container-specific cookie stores are not requested in this minimal-permission version, so an authenticated image that exists only in a non-default Container may fail.
- HTTP(S) URLs are taken from image-related page elements, but the extension does not pre-fetch every response to verify its MIME type. Suspicious filename extensions are neutralized, and files are never opened automatically.
- A successful API call means Firefox started a download. Network failures that happen later appear in Firefox's Downloads panel.

## Manual test checklist

- Test PNG, JPEG, WebP, AVIF, GIF, SVG, relative URLs, `<picture>`, lazy attributes, CSS backgrounds, and duplicate URLs.
- Download the same batch twice and confirm Firefox adds unique suffixes instead of overwriting.
- Try folder input such as `Summer/2026`, `../escape`, `/absolute/path`, `CON`, emoji, and trailing dots.
- Test a logged-in image, an expired URL, offline mode, and a server returning 403/404.
- Start a large batch and close the popup; downloads already handed to Firefox should continue.
- Try `about:`, the built-in PDF viewer, and addons.mozilla.org; the popup should show a friendly restricted-page error.
- Put HTML-looking text in an image's `alt` attribute and verify it remains inert text.

## Suggested next features

- Build one ZIP in the extension and show a single Save As dialog. This needs a locally bundled ZIP library plus host permissions for cross-origin fetches.
- Add minimum width/height and file-type filters.
- Add an optional right-click **Download this image** context-menu action.
- Add a native-messaging companion only if arbitrary OS folder selection is a hard requirement.
