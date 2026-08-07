# Page Image Downloader for Firefox

This repository contains a working Manifest V3 Firefox extension. It scans the **currently loaded page**, prefers the best full-size source exposed for each image, lets you preview or ignore unwanted images, and downloads one image or a selected batch to a named folder below Firefox's configured Downloads directory.

The manifest targets Firefox desktop 140+ and Firefox for Android 142+. Firefox for Android does not support the optional Save As dialog or extension context menus, so those controls are desktop-only where applicable.

## Try it in two minutes

1. Open Firefox and enter `about:debugging` in the address bar.
2. Choose **This Firefox** → **Load Temporary Add-on**.
3. Select `extension/manifest.json` from this project.
4. Open a normal website, select the extension's toolbar button, and wait for the image list.
5. Click a thumbnail to preview it in a full browser tab, choose **Ignore** to hide an unwanted logo, or right-click a page image and open the **AnyDownload** submenu.
6. Enter a relative destination such as `Website images/example.com`, select the images you want, and choose **Download selected**.

The temporary extension is removed when Firefox restarts. Use the **Reload** button on `about:debugging` after changing source files. Mozilla documents this workflow in [Temporary installation in Firefox](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/).

If you are upgrading an existing temporary installation, reload the add-on from `about:debugging` before reopening the toolbar popup. Version 1.3.0 adds image context-menu actions and lazy full-size dimension detection; version 1.2.0 added gallery-original and responsive-source resolution; version 1.1.0 added remembered per-site ignore rules and full-tab previews.

## Ignore and preview images

- Choose **Ignore** beside an image to deselect and hide that exact image URL on the website. Compact fingerprints are stored instead of full image URLs, so signed query strings and large embedded images are not copied into extension storage.
- Choose **Ignored (N)** above the list to review hidden images. **Restore** returns an image to the normal list and leaves it unselected.
- Choose **Restore all** in the ignored view to remove every stored rule for the current website, including rules for images that are no longer on the current page.
- Click any thumbnail—including one in the ignored view—to open a larger preview in a new Firefox tab. Click the preview to toggle between fit-to-window and actual size.

Ignore rules are scoped to the top-level website origin and capped at 500 per website and 5,000 overall in each storage context; the oldest rules are pruned if that global limit is reached. Normal-window rules are remembered in local extension storage; private-window rules stay only in Firefox's in-memory extension session storage, and private folder edits are not written to persistent settings. Each rule is stored independently, and open popups synchronize rule changes through Firefox storage events. Preview details use in-memory session storage, are removed when the preview reads them, and are rejected after five minutes.

## Right-click actions and image dimensions

On Firefox desktop, right-click an image on a normal webpage and open the **AnyDownload** submenu. It provides actions to download the resolved full-size image, preview it in a new tab, ignore it on the current website, or open the complete image-list popup. The context-menu click grants the existing temporary `activeTab` access, so resolving a gallery thumbnail does not require permanent access to every website.

The collector first uses trustworthy dimensions exposed beside an original URL, such as `data-image-width` and `data-image-height`. If an original has no dimension metadata, the popup keeps showing the inexpensive thumbnail and probes the full-size image only when that row becomes visible. At most three dimension probes run concurrently. This avoids loading every original in a large gallery merely because the popup opened.

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
  └─ thumbnail click stores a one-time payload and opens a packaged preview tab
  └─ Ignore stores a site-scoped image key and removes it from selection
  └─ selection UI sends a validated DOWNLOAD_BATCH message
       └─ Firefox background event page sanitizes names and calls downloads.download()
```

- `extension/manifest.json` declares the toolbar popup and five permissions: `activeTab`, `scripting`, `downloads`, `menus`, and `storage`.
- `extension/shared/collector.js` contains the self-contained page collector injected by `extension/popup/popup.js`. For each `<img>`, it prefers explicit full/original attributes (including those on a nearby gallery link), a clearly linked image file, or the largest candidate in the active `srcset`/`<picture>` source before falling back to lazy and displayed sources. It also detects SVG `<image>` resources, video posters, image inputs, CSS image URLs, open shadow roots, and frames Firefox permits it to inspect.
- When a gallery exposes both a thumbnail and an original, the popup renders the inexpensive thumbnail while **Preview**, **Save**, and bulk download use the original URL. Superseded thumbnail variants are not added as separate selected rows.
- `extension/background.js` registers the native **AnyDownload** image submenu. It resolves the exact context-clicked element through Firefox's target-element ID, then reuses the same validated preview, ignore, and download paths as the popup.
- `extension/preview/preview.html` is a packaged extension page used for full-tab previews, including embedded `data:image` resources that Firefox does not allow as direct tab URLs.
- `extension/shared/core.js` validates relative folder paths, rejects unsafe URL schemes, creates filenames, strips traversal/illegal characters, handles Windows-reserved names, and resolves duplicate names.
- `extension/background.js` validates the request again, keeps at most five download-start API calls in flight, and uses `conflictAction: "uniquify"` so existing files are not overwritten. Firefox controls the number of network transfers after accepting them.
- Embedded `data:image` resources are converted to extension-owned Blob URLs. The background page retains each Blob until Firefox reports that download complete or interrupted.
- `extension/popup/popup.html` never interpolates page content with `innerHTML`; it uses DOM nodes and `textContent`. Thumbnails use `referrerpolicy="no-referrer"` and load only as their rows approach the visible list.

The `activeTab` permission is granted only after the user invokes the toolbar action. It avoids asking for permanent access to every website. Mozilla's [`scripting`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/scripting) and [`activeTab`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/permissions) documentation explains that permission model.

## Development loop

The included checks need only Node.js:

```bash
cd anydownload
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
- The collector can use only sources that the loaded page exposes. It prefers explicit original/full-size attributes and the largest candidate in the active responsive set, but it does not guess arbitrary URL rewrites or fetch every linked detail page to invent a larger asset.
- With `activeTab`, the top page and permitted/same-origin frames are scanned. Cross-origin frames may be omitted unless you add broader host permissions.
- Page-created `blob:` URLs are skipped with a warning because Firefox does not let an extension background page download a Blob owned by the website. Ordinary HTTP(S) URLs and embedded `data:image` resources are supported.
- Canvas pixels, inline SVG markup, closed shadow roots, browser-internal pages, the built-in PDF viewer, and protected Mozilla pages are not downloadable through this scanner.
- A safety limit caps a scan/batch at 1,500 images and computed-style inspection at 10,000 elements. The popup renders at most 350 matching rows at once, while bulk selection still includes all discovered records.
- Private-window downloads retain their private browsing context when the user has allowed the extension in private windows. Firefox Container-specific cookie stores are not requested in this minimal-permission version, so an authenticated image that exists only in a non-default Container may fail.
- Full-tab previews make a new image request from a packaged extension page. A hotlink-protected, CORP-restricted, or Container-only image may fail there even when its popup thumbnail works; use **Open original** in the preview tab as the fallback.
- Full-size dimension detection also makes a request when an unknown-size row becomes visible. If the server blocks extension-page image requests, the row reports that the full size is unavailable instead of displaying the thumbnail's dimensions as if they belonged to the original.
- HTTP(S) URLs are taken from image-related page elements, but the extension does not pre-fetch every response to verify its MIME type. Suspicious filename extensions are neutralized, and files are never opened automatically.
- A successful API call means Firefox started a download. Network failures that happen later appear in Firefox's Downloads panel.

## Manual test checklist

- Test PNG, JPEG, WebP, AVIF, GIF, SVG, relative URLs, `<picture>`, lazy attributes, CSS backgrounds, and duplicate URLs.
- On a thumbnail gallery, confirm each item appears once, its row identifies a full-size or responsive source, the popup loads the small preview, and **Preview**/**Save** use the original. Include an unordered `srcset` and confirm the numerically largest `w` or `x` candidate wins.
- Download the same batch twice and confirm Firefox adds unique suffixes instead of overwriting.
- Try folder input such as `Summer/2026`, `../escape`, `/absolute/path`, `CON`, emoji, and trailing dots.
- Test a logged-in image, an expired URL, offline mode, and a server returning 403/404.
- Start a large batch and close the popup; downloads already handed to Firefox should continue.
- Try `about:`, the built-in PDF viewer, and addons.mozilla.org; the popup should show a friendly restricted-page error.
- Put HTML-looking text in an image's `alt` attribute and verify it remains inert text.
- Ignore a logo, reopen the popup on the same website, and confirm it stays hidden and unselected. Restore it from **Ignored (N)** and confirm it remains unselected.
- Confirm that ignoring `logo.png?v=1` does not hide `logo.png?v=2` or a query-driven sibling such as `render?id=2`.
- In a private window, ignore an image, restart Firefox, and confirm the private rule was not retained.
- Click HTTP(S) and embedded-data thumbnails, verify each opens in a new preview tab, and toggle fit-to-window/actual size.
- Right-click a gallery thumbnail and verify **AnyDownload → Download full-size image**, **Preview full-size image**, **Ignore image on this site**, and **Open image list…** all act on the original rather than the thumbnail.
- Confirm a full-size row changes from **checking full size…** to its actual pixel dimensions when it becomes visible, while off-screen rows do not start eager probes.

## Suggested next features

- Build one ZIP in the extension and show a single Save As dialog. This needs a locally bundled ZIP library plus host permissions for cross-origin fetches.
- Add minimum width/height and file-type filters.
- Add a native-messaging companion only if arbitrary OS folder selection is a hard requirement.
