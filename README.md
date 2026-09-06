# AnyDownload — Page Media Downloader for Firefox

This repository contains a working Manifest V3 Firefox extension. It scans the **currently loaded page** for images and video files, prefers the best full-size source exposed for each image, lets you preview or ignore unwanted media, narrows the list with media-type, photo, format, and Instagram-collection filters, and applies safe filename templates. Images and direct MP4, WebM, Ogg/OGV, MOV, M4V, and MKV files can be downloaded individually or together through the ordinary queue; Instagram routes, FapFolder group-video listings, and public YouTube video pages have bounded site adapters for media their ordinary pages or players expose indirectly. Locally built ZIP archives remain image-only. A dedicated Downloads page shows live queue controls, recent batch history, and downloaded-file statistics; completed files also feed a URL-free site-scoped ledger so repeated scans can mark and skip prior downloads. Background trackers can notify, hold new matches in a local approval inbox, or download automatically.

The manifest targets Firefox desktop 140+ and Firefox for Android 142+. Firefox desktop first opens a compact toolbar popup; its **Open window** button moves the same media manager into a separate resizable window, and its sidebar button opens the persistent Firefox Sidebar. The manager and sidebar can watch an infinite-scroll gallery while you keep using the page, and the sidebar can automatically follow active-tab changes after one explicit permission grant. Firefox for Android falls back to an extension tab and does not support the sidebar, optional Save As dialog, or extension context menus.

## Try it in two minutes

1. Open Firefox and enter `about:debugging` in the address bar.
2. Choose **This Firefox** → **Load Temporary Add-on**.
3. Select `extension/manifest.json` from this project.
4. Open a normal website containing images or video, an Instagram post/reel/story/highlight, a FapFolder group video listing, or a public YouTube video page and select the extension's toolbar button. Use the compact popup directly, choose **Open window** for a resizable manager, or choose the sidebar button to keep the manager beside the page.
5. Expand **Filters** to choose **Images & videos**, **Images**, or **Videos**, enable **Photos only**, or select a format or Instagram profile collection.
6. Expand **Filename template** to keep the default ordered name (`0001-photo.jpg`) or combine page, host, index, dimension, and date tokens; the live example shows the resulting safe filename.
7. Click an image thumbnail, video poster, or video placeholder to preview it in a full browser tab; choose **Ignore** to hide unwanted media; or right-click a page image or video and open the **AnyDownload** submenu.
8. Choose **Collect gallery** to scroll automatically, use recognizable Load more buttons, and optionally follow up to ten same-site Next pages. The compact popup opens the resizable manager for collection. Use **Stop collecting** at any time, review the accumulated selection, then download. Each website's gallery is saved when you switch tabs or visit another page.
9. To monitor the current URL after the manager closes, choose **Track page**, select **Add to review**, **Notify only**, or **Download automatically**, choose an interval, and grant access to that exact website. The default first check records a baseline without acting on existing matches.
10. Enter a relative destination such as `Website media/example.com`, select the images and videos you want, and use **Download selected** at the bottom. Use **Download ZIP** there only for image selections. The download-arrow button in the header opens the queue, history, progress, and statistics.

The temporary extension is removed when Firefox restarts. Use the **Reload** button on `about:debugging` after changing source files. Mozilla documents this workflow in [Temporary installation in Firefox](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/).

If you are upgrading an existing temporary installation, reload the add-on from `about:debugging` before clicking its toolbar button again. Version 1.11.0 adds bounded background tracking, a dedicated Tracking dashboard, and complete Instagram profile-grid carousel fallback on top of the interface and collection improvements introduced in 1.10.0; see [Version history](#version-history) for earlier milestones.

## Instagram profiles, posts, stories, and highlights

On an Instagram profile route such as `https://www.instagram.com/username/`, AnyDownload uses that tab's signed-in session to request the profile feed through bounded first-party pagination. It continues across the returned cursors until Instagram reports no more pages or an item, document, response-size, or combined-URL safety limit is reached. Every post is added in feed order, and every photo or direct video in each carousel is expanded into its own ordered row. Private, restricted, or otherwise unavailable posts appear only when Instagram makes them accessible to the current browser session; AnyDownload does not bypass account access controls.

On a specific post or reel route, a fresh scan collects only that exact route-scoped post. It expands every carousel item regardless of `?img_index=1`, a middle index, or the last visible slide, and it never discovers profile-feed posts, stories, highlights, comments, recommendations, avatars, or navigation artwork from that route. Story and highlight scans likewise remain scoped to the selected collection. Previously collected Instagram media remains in the growing saved gallery for that website, including media from posts or profiles you scanned earlier.

The **Stories & highlights** button appears on profile routes. It requests the profile owner's current story and exposed highlights with the same signed-in or private-window session, while preserving the profile posts already in the manager. After collection, the Instagram collection filter offers **Posts only**, **Current story only**, **All highlights**, and one option for each discovered named highlight, in addition to the combined profile-media view. The action remains explicit because requesting story data may register as a story view. Profiles without an active story, inaccessible private media, expired items, and partial highlight access are reported without attempting to bypass Instagram.

Instagram profile, story, and highlight requests are bounded to 1,500 media records, 32 fetched documents, 4 MB per document, 32 MB of fetched document data, and 2 MB of combined media URLs. Reaching a bound returns the collected prefix with a warning instead of continuing without limit. Extension code does not inspect cookie or credential values and does not persist raw Instagram page documents; selected media URLs follow the normal download queue's retention rules.

Instagram's CDN links are signed and can expire, so queue selected media promptly. Direct progressive video variants are supported; a story that exposes only a page-owned Blob, HLS playlist, DASH manifest, or separate audio/video tracks remains outside the browser-only downloader's scope. Ordinary Instagram downloads add only the fixed first-party `Referer: https://www.instagram.com/` request header that Firefox supports for downloads; arbitrary headers from the page are never forwarded.

## Basic YouTube video downloads

On a public YouTube watch, Shorts, embed, `/live/` video, `youtu.be`, or YouTube Music video URL, AnyDownload first checks the bounded player data already present in the page. When the web player exposes only a page-owned Blob or SABR metadata, it makes an anonymous request directly to YouTube's player endpoint using `credentials: "omit"`. It tries two public Android player profiles and accepts only already-signed HTTPS MP4/WebM URLs on YouTube's media host; it never evaluates remote player code or sends the request through an AnyDownload service.

The default list prefers complete files that contain both video and audio. Current public responses commonly provide a progressive MP4 around 240p for Shorts/low-resolution sources or 360p for ordinary videos. Higher resolutions usually arrive as separate video-only and audio-only tracks; AnyDownload does not merge them, so it does not advertise the fallback as an HD downloader. The row identifies the resolution and audio state, keeps a title-based filename and poster, and warns when only a silent video-only fallback is available.

YouTube's signed media URLs expire and contain playback parameters. When the user chooses **Download**, Firefox asks for exact `https://www.youtube.com/*` access so the durable queue can store only the public video ID and selected format number. The background resolves a fresh signed URL in memory immediately before every start or retry, then hands it to Firefox without rewriting it. API keys, visitor data, account cookies, authorization headers, complete player responses, and signed Googlevideo URLs are not written to extension storage.

This deliberately limited resolver does not handle private, age/member/paid/region-gated, rental, live/upcoming, or unavailable videos; captions or alternate audio; signature ciphers; proof-of-origin tokens; SABR, HLS, or DASH reconstruction; separate-track muxing; licence acquisition; or decryption. YouTube can change its unsupported internal player interface, so a page that works today may later show an actionable unsupported-format warning instead of a file.

## FapFolder group video posts

On a supported `https://fapfolder.club/groups/<group>/videos` page, the visible grid contains post links and thumbnails rather than direct video elements. AnyDownload follows only the ordered `/posts/<id>` links already loaded in that grid, fetches those same-site post documents with the current tab's browser session, and extracts direct HTTP(S) video sources from the site's lazy video placeholders or ordinary `<video>`/`<source>` elements. Results retain the grid's post order even though at most three post documents are inspected concurrently. Opening a supported individual `/posts/<id-or-slug>` route also recognizes its lazy video placeholder before the site's player mounts.

The adapter inspects at most 64 loaded posts per scan, 2 MB per post document, 16 MB across fetched post documents, 1,500 media records, and 2 MB of combined media URLs. Successful post results are cached briefly inside the source tab so automatic live scans do not repeatedly fetch unchanged posts; newly loaded **See More** links are still discovered and inspected. The adapter does not crawl unrelated links or guess post IDs. Explicit **Collect gallery** can activate a recognizable non-form See more button; passive live watching does not click it.

FapFolder may require an account before a post exposes its video URL. The adapter reuses the source tab's session through normal credentialed same-site requests but never reads, stores, or bypasses login credentials. Sign in on the source tab and rescan when the manager reports login-gated posts. Blob players, HLS/DASH manifests, and pages that do not expose a direct file remain unsupported.

## Background tracker MVP

Choose **Track page** to monitor the current HTTP(S) URL after the popup or manager closes. A tracker remembers the current destination folder, filename template, media-type/photo/format filters, matching rules, pagination strategy, action, and notification preferences. Firefox asks for access only to that website, then an alarm wakes the extension every 15 minutes, hour, six hours, or day. **Run now**, **Pause/Resume**, and **Remove** are available from the same panel. New trackers default to **Add to review**; **Notify only** reports new matches without retaining them for approval or downloading them, while **Download automatically** sends them directly to the durable queue. Existing tracker records created before these modes retain automatic-download behavior.

The target-shaped header button opens the dedicated **Tracking** dashboard, which lists every tracked page and the local review inbox in one place. It shows active, paused, error, and pending-review totals; saved action, matching, and pagination settings; the latest result and reliability state; and up to 40 recent activity records per tracker. Each record includes its trigger, duration, pages checked, new matches, reviewed or queued files, and outcome. A pending item can be approved into Downloads using the tracker's current destination and filename template, previewed directly, or dismissed without downloading. From there you can also open the source page, run or pause one tracker, remove it, or pause/resume the complete schedule. Tracking and Downloads link to each other directly.

By default, the first successful check creates a baseline of matching media and takes no action; later checks apply the selected review, notify, or automatic-download action only to unseen matches. Enable **Process current matches on the first check** when the initial set should receive that action immediately. Include/exclude text searches URLs and exposed labels; URL patterns support `*` and `?`, one per line; and the per-check cap lets later unseen matches roll into future checks. Fingerprints ignore common expiring signature/token parameters so a refreshed signed URL does not normally look like a new file, and matches already present in the completed-download ledger are marked seen without another automatic download.

Tracker settings, activity, and fingerprints are kept in local extension storage; cookies, response bodies, and page HTML are not stored. **Notify only** likewise retains no pending URL. Review mode necessarily stores each pending media URL plus bounded display metadata so it can later be approved; the inbox accepts at most 500 items and 2 MB of payload. Pending signed URLs can still expire, but a later review-mode check refreshes the stored URL when the page exposes the same stable media again. Deleting a tracker also removes its pending review items.

Each checked page uses one credentialed `GET` and parses static HTML. Pagination can stay on the first page, follow a static same-origin Next link, or substitute `{page}` in a same-origin URL template; requests remain sequential and stop at the configured 2–10 page cap, a repeated URL, or an empty later template page. The tracker does not execute page JavaScript, click **More**, submit or replay AJAX requests, crawl detail pages, or reuse the foreground-only Instagram, FapFolder, or YouTube adapters. Media must therefore be present as a direct HTTP(S) image/video source or recognizable media link in the returned HTML. A JS-only gallery, Cloudflare challenge, expired login, Container-only session, `blob:` player, HLS/DASH stream, or media revealed only by an AJAX offset will yield no matches or a visible tracker error.

Each request has a 15-second timeout and a 4 MB HTML limit. A complete check visits at most 10 pages, inspects at most 500 unique media candidates, retains at most 2 MB of media URLs, and applies the selected action to the configured 1–100 new matches. Failures use a bounded retry delay (including HTTP `Retry-After`); removed site access pauses immediately, and three consecutive HTTP 401/403 responses pause the tracker. Optional system notifications report new reviewed or queued matches, the first error in a streak, and automatic pauses; notifications are always enabled for Notify only mode. Up to 20 trackers and 5,000 recent fingerprints per tracker are retained. Firefox alarms are best-effort and may run late while the browser or device sleeps; checks resume when Firefox can wake the extension. Background trackers are disabled in private windows in this MVP.

## Ignore and preview media

- Choose **Ignore** beside an image or video to deselect and hide that exact media URL on the website. Compact fingerprints are stored instead of full URLs, so signed query strings and large embedded media are not copied into extension storage.
- Choose **Ignored (N)** above the list to review hidden media. **Restore** returns an item to the normal list and leaves it unselected.
- Choose **Restore all** in the ignored view to remove every stored rule for the current website, including rules for media that are no longer on the current page.
- Click any image thumbnail or video poster/placeholder—including one in the ignored view—to open a larger preview in a new Firefox tab. Image previews toggle between fit-to-window and actual size; direct video previews use Firefox's native playback controls.

Ignore rules are scoped to the top-level website origin and capped at 500 per website and 5,000 overall in each storage context; the oldest rules are pruned if that global limit is reached. Normal-window rules are remembered in local extension storage; private-window rules stay only in Firefox's in-memory extension session storage, and private folder edits are not written to persistent settings. Each rule is stored independently, and open manager windows synchronize rule changes through Firefox storage events. Preview details use in-memory session storage, are removed when the preview reads them, and are rejected after five minutes.

## Right-click actions and media rows

On Firefox desktop, right-click an image or video on a normal webpage and open the **AnyDownload** submenu. It provides actions to download the resolved full-size image or direct video file, preview it in a new tab, ignore it on the current website, or open the complete media-manager window. The context-menu click grants the existing temporary `activeTab` access, so resolving a gallery thumbnail or video source does not require permanent access to every website.

Image rows retain the existing full-size-source behavior: the collector first uses trustworthy dimensions exposed beside an original URL, such as `data-image-width` and `data-image-height`. If an original has no dimension metadata, the manager keeps showing the inexpensive thumbnail and probes the full-size image only when that row becomes visible. At most three dimension probes run concurrently. Video rows use the page's poster as their list thumbnail when one is available and a neutral video placeholder otherwise, without downloading the whole video merely to render the list.

## Smart filters and bulk selection

Expand **Filters** to show **Images & videos**, **Images**, or **Videos**. **Photos only** is available in the same panel and remains an image-focused heuristic for hiding obvious non-photo assets such as logos, icons, avatars, sprites, emoji, tracking pixels, and known very small images. Videos are outside that image-photo heuristic and are excluded while **Photos only** is enabled. The filter does not upload media or run a visual recognition model.

- **Instagram collection** appears on profile routes. It can show all collected profile media, posts only, the current story only, all highlights, or one discovered highlight by name.
- **Format** supports Any, JPEG, PNG, WebP, GIF, SVG, AVIF, MP4, WebM, Ogg/OGV, MOV, M4V, and MKV.

Smart-filter settings are remembered. Applying a filter removes nonmatching items from the current selection; **Select matches only** then checks only the visible eligible media. The bottom **Download selected** action starts the validated bulk-download path and never includes ignored or filtered-out media. A batch may contain images, videos, or both.

## Filename templates and record identity

Expand **Filename template** above the media list to control names for ordinary image/video downloads and image-only ZIP entries. The default `{index}-{filename}` prefixes the safe source filename with its zero-padded selected-batch position, producing names such as `0001-photo.jpg`. Templates can combine literal text with these tokens:

- `{filename}` — the source filename including its extension.
- `{name}` and `{ext}` — the source filename stem and extension separately.
- `{index}` — the item's one-based position in the selected batch.
- `{hostname}` and `{page-title}` — the source page host and title.
- `{width}` and `{height}` — known media dimensions, or `unknown` when unresolved.
- `{date}` — the user's local batch date in `YYYY-MM-DD` form.

Selected media retains the manager's discovery order, which follows page traversal or a site adapter's explicit feed/carousel order. The complete batch is named in that order before the bounded concurrent download queue starts, so differences in network speed or completion time cannot scramble a folder sorted by filename. Filters, ignored items, and manual deselection are omitted; the remaining selected subset is numbered contiguously from `0001` rather than retaining gaps from its original page positions.

The extension validates templates before enabling a download, preserves the recognized image or video extension, sanitizes browser-unsafe path characters, limits the final filename length, and adds numeric suffixes when two rendered names collide. The example beside the control updates immediately; a missing or unknown token is shown as an error instead of silently producing malformed names.

The manager does not compare media for visual similarity. It uses a stable adapter identity where one is exposed (for example, an Instagram post and carousel position); otherwise it uses the normalized URL after dropping common expiring CDN credentials while retaining content and transform parameters. This lets a refreshed signed URL update one row during automatic scanning, without merging genuinely different responsive or cropped assets. Filename-collision handling is separate; downloads with the same rendered name still receive safe numeric suffixes.

## Download queue, history, and statistics

Ordinary single, bulk, and mixed image/video downloads enter a bounded background queue instead of requiring the popup to remain open while every Firefox download is started. Direct MP4, WebM, Ogg/OGV, MOV, M4V, and MKV URLs use the same queue, destination, filename-template, progress, and history path as images. Select the download-arrow button in the manager header to open the full **Downloads** dashboard. It provides:

- live per-file and per-batch state, byte progress when Firefox exposes totals, and an active-queue badge in the manager;
- pause, resume, and cancel controls for individual files, complete batches, or all pending work;
- retry controls for individual interrupted or cancelled files, bulk retry for failed work, and a way to clear completed batches;
- recent batch history with destination, filenames, errors, and actions that reveal completed files in Firefox; and
- today and lifetime completed-file counts, downloaded bytes, failure/cancellation counts, and success rate.

Normal-window queue state and counters are stored in local extension storage and reconciled with Firefox's Downloads API when the background restarts. When Firefox confirms an ordinary file complete, AnyDownload adds its site-scoped stable fingerprint, safe filename, and completion time to a bounded completed-download ledger. Manager rows then show **Queued**, **Downloaded**, or **Failed** state; **Select all** skips downloaded records, **Hide downloaded** removes them from the current view, and manually checking one or choosing **Again** explicitly permits a repeat download. The normal ledger keeps at most 5,000 records and 500 per source website, stores no media URL, and favors the newest completions.

Private-window jobs and completed fingerprints use Firefox's in-memory session storage, are not copied into persistent storage, and disappear when Firefox closes. Normal and private status never mix. Queue controls affect ordinary downloads; the visible Archive Progress tab continues to own each bounded ZIP job, and ZIP entries are not individually added to the completed ledger.

## ZIP archives

ZIP creation remains intentionally **image-only**. Choose **Download ZIP** at the bottom for an image-only selection; the action is unavailable while any selected item is a video. Deselect videos or use the **Images** filter before building an archive, and download videos individually or in bulk through the ordinary queue instead. AnyDownload opens a visible **Archive Progress** tab, fetches the selected image originals sequentially, and builds each ZIP locally inside Firefox; image data is not uploaded to a service. Keep that tab open until it reports completion. Because JPEG, PNG, WebP, AVIF, and GIF files are already compressed, the archive uses the dependency-free ZIP “store” method instead of spending CPU recompressing them.

Firefox asks for access only to the HTTP(S) origins used by the currently selected images. Embedded `data:image` items need no host permission. If a request is denied, expires, times out after two minutes, returns a non-image response, or is otherwise unavailable, the remaining files are still archived and `anydownload-errors.txt` records the failures. A job accepts at most 2,000 selected images and uses a 64 MiB fetch safety ceiling per image; each entry must also fit below the 64 MiB ZIP-part limit after its headers are added. If everything fits in one part, the result is `gallery.zip`; larger jobs are saved sequentially as `gallery-part-001.zip`, `gallery-part-002.zip`, and so on. This keeps memory bounded instead of retaining all selected images and the finished ZIP at once.

## Automatic live updates

Automatic live updates start after every successful page scan; there is no manual reload or live-capture control. Keep scrolling or opening lazy gallery sections on the source page and the extension watches for relevant DOM changes, then rescans when the page exposes new image candidates or direct video-file sources. On ordinary pages it also performs a periodic safety rescan. Passive watching does not scroll or click controls; use **Collect gallery** for that. Instagram profile-feed pagination remains a bounded site-adapter exception, and a YouTube video route still resolves only its current public video ID rather than a playlist or channel.

During an automatic update, known checked items stay checked and known unchecked items stay unchecked. Newly discovered media is selected only when it is not ignored and matches the current filters. The compact toolbar popup can update only while Firefox keeps that popup open; use **Open window** or the sidebar when updates must continue while you interact with and scroll the webpage.

The compact popup and separate manager remain pinned to the tab they scanned, and automatic updates stop if that source closes or navigates because navigation ends the temporary page grant. The saved gallery is retained. After **Enable auto-follow** is granted, the Sidebar stops the old watcher, restores the destination website's saved gallery, scans the new page into it, and starts live updates after the scan succeeds.

## Complete-gallery collection and saved websites

Each HTTP(S) website origin has one growing gallery: media found on page A remains when you visit page B on that website, and switching to another website shows its own collection. Returning restores its media and checked/unchecked selections, including after reopening AnyDownload. Stable identities prevent duplicate rows, and each record keeps its source page title for filename templates. **Clear saved gallery** removes only that site's saved media and selections, stops its watcher, and leaves downloaded files and history intact.

Normal galleries are saved locally with their media URLs and bounded display metadata; private galleries stay in session storage and never mix with normal galleries. YouTube videos use public video-ID/format references, resolve afresh through the download queue, and preview on the public video page. Other signed URLs can expire; revisiting their source refreshes them when the same media is exposed again.

**Collect gallery** scrolls the current page and activates visible, enabled Load/Show/See more buttons outside forms. Scanning between steps retains media removed by virtualized galleries. Select this page, three pages, or ten pages as the limit. Recognizable Next links are followed only on the same origin using the source tab's session. Later pages use the same image/direct-video collector on static HTML; their scripts and foreground site adapters do not run. AJAX-only pagination and indirectly resolved post videos may still require opening that page directly.

Progress and **Stop collecting** remain visible throughout collection. Navigation, tab closure, and sidebar tab changes stop collection while retaining results. A toolbar-popup launch opens a resizable manager, or an extension tab on Android; keep that surface open while collecting. Review the final selection before downloading: collection itself does not enqueue files.

Limits are 1,500 media and 2 MB of media URLs per website, 3 MiB of serialized records per website, and 20 saved websites/4 MiB of gallery data per browsing context. Older websites are evicted at the shared limit. Each run allows 120 scroll steps, 20 Load more actions, about five minutes plus the current request, and ten pages. HTML requests have a 15-second timeout, a 4 MiB per-page limit, and a 16 MiB combined limit.

## Firefox Sidebar

Choose the sidebar button in the compact popup, or select **AnyDownload media** from Firefox's sidebar menu, to run the responsive media manager beside the webpage. The sidebar remains available while you scroll, so it is the most convenient surface for automatic live updates. It can also open the separate resizable manager when more room is needed. Firefox's [`sidebar_action`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/sidebar_action) manifest key and [`sidebarAction`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/sidebarAction) API provide this desktop integration.

On first use, the sidebar can scan the page that received Firefox's temporary `activeTab` grant. Choose **Enable auto-follow** to grant optional access to normal websites. Changing the active tab or navigating then saves the outgoing website's gallery, stops its watcher, restores the destination website's gallery, and scans the new page into it. Protected Firefox pages, the built-in PDF viewer, and other non-scriptable pages still show a friendly error.

Auto-follow access is optional and can be removed from Firefox's extension permissions at any time. Without it, opening AnyDownload from the compact popup, context menu, or sidebar continues to use temporary `activeTab` access; the sidebar simply cannot follow future tab changes automatically.

## The folder limitation that matters

Firefox's `downloads.download()` API accepts a filename **relative to Firefox's configured Downloads directory**. It rejects absolute paths and `../` traversal. Therefore:

```text
Folder field: Website media/example.com
Actual destination: <Firefox Downloads>/Website media/example.com/
```

A regular WebExtension cannot choose `/Users/you/Pictures` once and then silently write hundreds of files there. You have three practical options:

1. In Firefox **Settings → General → Files and Applications → Downloads**, make your preferred root directory the default; this extension then creates a subfolder below it.
2. Enable **Save As for one file** for one-off downloads.
3. If arbitrary bulk destinations are essential, add a separately installed [native-messaging](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging) application. The native helper performs filesystem writes; the extension sends it validated URLs and paths. This requires an OS-specific installer and a native-host manifest, so it is intentionally outside this browser-only version.

The exact `filename` and `saveAs` rules are in Mozilla's [`downloads.download()` documentation](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/downloads/download).

## How the implementation works

```text
Toolbar action
  └─ compact popup scans the current source tab
       └─ Open window asks the background to open/reuse a resizable manager
       └─ Sidebar opens the same responsive manager beside the webpage
       └─ automatic live updates start after the scan; manager/sidebar remain open during page interaction
       └─ browser.scripting.executeScript() using temporary activeTab access
       └─ generic collector returns image/direct-video metadata
       └─ Instagram adapter scopes exact-post routes and paginates profile posts within safety bounds
            └─ every post carousel expands into its ordered media items
            └─ explicit Stories & highlights adds the profile owner's exposed collections
       └─ FapFolder adapter inspects direct video sources inside the loaded group-post links
       └─ YouTube adapter resolves one public video to complete progressive formats
       └─ media and smart filters decide which discovered records stay eligible
       └─ live fingerprint changes trigger selection-preserving rescans
       └─ Track page saves the current filter/folder/template profile and exact-site permission
            └─ browser.alarms wakes the background for bounded same-origin HTML checks
            └─ optional static Next-link or URL-template pagination visits up to ten pages
            └─ first run records a baseline; unseen matches notify, wait for review, or enter the durable queue
            └─ retry/backoff, notifications, and activity history report each outcome
            └─ Tracking dashboard controls trackers and approves or dismisses pending review items
  └─ thumbnail/poster click stores a one-time payload and opens a packaged preview tab
  └─ Ignore stores a site-scoped media key and removes it from selection
  └─ Download selected sends a validated DOWNLOAD_BATCH message
       └─ filename template renders safe, unique names for the selected batch
       └─ durable background queue starts bounded downloads.download() work
            └─ YouTube tasks refresh an in-memory signed URL from the stored video ID/itag
            └─ Downloads dashboard shows progress, controls, history, and statistics
            └─ confirmed completions add a compact site-scoped fingerprint to the download ledger
  └─ Download ZIP accepts images only and requests their selected origins
       └─ stores a validated one-time job and opens Archive Progress
            └─ visible page fetches originals sequentially
            └─ builds and saves bounded 64 MiB ZIP parts one at a time
```

- `extension/manifest.json` declares `popup/popup.html` as the toolbar popup, `sidebar/sidebar.html` as the Firefox Sidebar entry point, and seven required permissions: `activeTab`, `alarms`, `scripting`, `downloads`, `menus`, `notifications`, and `storage`. `<all_urls>` is declared only as an optional host permission: the UI requests broad access only for user-enabled Sidebar following, while trackers, image-only ZIP fetches, and just-in-time YouTube resolution request exact origins. The same packaged popup page switches to responsive manager or sidebar mode, so scanning, filtering, ignoring, tracking, and downloading share one implementation.
- `extension/sidebar/sidebar.html` and `extension/sidebar/sidebar.js` load that responsive manager inside Firefox's sidebar without inline script, preserving the extension page's strict content-security policy.
- `extension/shared/collector.js` contains the self-contained page collector injected by `extension/popup/popup.js`. For each `<img>`, it prefers explicit full/original attributes (including those on a nearby gallery link), a clearly linked image file, or the largest candidate in the active `srcset`/`<picture>` source before falling back to lazy and displayed sources. It also detects SVG `<image>` resources, image inputs, CSS image URLs, direct HTTP(S) media exposed through `<video>`/`<source>` or clearly linked video files, open shadow roots, and frames Firefox permits it to inspect. A video poster is used for that video's row thumbnail when available and can still be discovered as an image in its own right.
- `extension/shared/fapfolder.js` recognizes only supported FapFolder group-video and post routes. It preserves the loaded post-link order, fetches a bounded set of same-site post documents with the current tab session, extracts direct lazy/ordinary video sources, retains listing thumbnails as previews, caches bounded results briefly, and reports login, response-size, and unsupported-source boundaries.
- `extension/shared/instagram.js` is a self-contained, top-frame site adapter. It recognizes only real Instagram hosts, bounds JSON/document traversal and first-party profile pagination, matches exact-post media to the active shortcode, expands every ordered carousel, labels post/story/highlight membership for filtering, chooses the largest exposed image and progressive-video candidate, and falls back cleanly when the current signed-in session cannot access the requested content.
- `extension/shared/youtube.js` is a self-contained public-video adapter. It recognizes strict YouTube video routes, bounds script/player responses, accepts only direct HTTPS Googlevideo MP4/WebM formats, tries anonymous Android VR and standard Android player profiles, and reports separate-track, stream, cipher, access, and expiry boundaries without evaluating player code.
- When a gallery exposes both a thumbnail and an original, the manager renders the inexpensive thumbnail while **Preview**, **Save**, and bulk download use the original URL. Superseded thumbnail variants are not added as separate selected rows.
- `extension/shared/filters.js` normalizes the persisted Smart Filters state, distinguishes images and videos, infers recognized media format from safe URL/file hints, and implements the conservative image-focused **Photos only** heuristic. Filtering remains local to the extension.
- `extension/shared/tracker.js` validates bounded tracker profiles, action modes, matching rules, same-origin pagination, and review records; extracts direct media from static HTML; normalizes volatile signed URLs into compact fingerprints; and caps retained state. `extension/background.js` owns the corresponding alarms, sequential fetches, reliability/backoff behavior, notifications, baseline/new-match decisions, review-inbox updates, activity history, and durable queue handoff.
- `extension/shared/templates.js` validates the supported filename-token grammar, renders batch metadata, preserves recognized image and video extensions, sanitizes the result, and resolves case-insensitive filename collisions.
- `extension/shared/download-ledger.js` derives stable 16-character media fingerprints while removing common rotating CDN credentials, scopes completed identities to the source website, and normalizes/prunes the URL-free completion ledger.
- `extension/shared/gallery.js` validates and bounds saved website galleries, reuses ledger fingerprints for record identity, and provides the source-tab scrolling and bounded HTML fetch steps used by complete-gallery collection. Background storage mutations preserve concurrent discoveries and keep normal/private records separate.
- `extension/shared/download-queue.js` owns the bounded, serializable queue model, status transitions, ledger identity handoff, retries, completed-job history, daily/lifetime counters, and recovery of work that was in flight when a background context stopped. YouTube tasks serialize a canonical provider URL containing only the public video ID/itag; signed playback URLs exist only in background memory while a task starts.
- `extension/shared/archive.js` is a dependency-free stored-ZIP writer with CRC32, UTF-8 filenames, safe entry-name validation, and classic ZIP size limits. It does not contact a remote service.
- `extension/archive/archive.html` is a visible, cancellable progress surface for ZIP jobs. It consumes a one-time request from session storage, fetches originals sequentially, releases each completed part, and polls Firefox's download state as a fallback if a completion event is missed.
- `extension/history/history.html` is the responsive Downloads dashboard. It polls a small queue snapshot while work is active, exposes per-task and batch controls, and can reveal completed files through Firefox's Downloads API.
- `extension/tracking/tracking.html` is the responsive Tracking dashboard. It summarizes all persistent trackers, renders the bounded local review inbox with Approve/Dismiss actions, synchronizes alarm-driven storage changes, filters trackers by status or text, displays reliability and per-run activity, and exposes safe per-tracker and pause/resume-all controls.
- `extension/popup/popup.js` owns all three UI modes. Automatic live updates periodically inject a lightweight fingerprint function into the pinned source tab and perform a full collector scan after relevant page changes or, on ordinary pages, a periodic safety interval. Its stable-media-identity merge retains known dimensions and checked/unchecked state while selecting new eligible records, including when a signed CDN URL refreshes. Sidebar handoffs start a fresh watcher after the replacement page scans successfully.
- `extension/background.js` registers the native **AnyDownload** image and video submenu. It resolves the exact context-clicked element through Firefox's target-element ID, then reuses the same validated preview, ignore, and download paths as the manager. It also refreshes YouTube provider tasks immediately before start/retry and adds the fixed Instagram first-party `Referer` header.
- `extension/preview/preview.html` is a packaged extension page used for full-tab image and direct-video previews, including bounded embedded `data:image` and `data:video` resources that Firefox does not allow as direct tab URLs.
- `extension/shared/core.js` validates relative folder paths, rejects unsafe URL schemes, creates filenames, strips traversal/illegal characters, handles Windows-reserved names, and resolves filename collisions.
- `extension/background.js` validates ordinary batch requests, persists them in the appropriate normal/private queue, reconciles Firefox download events into history and statistics, starts work at bounded concurrency, and uses `conflictAction: "uniquify"` so existing files are not overwritten.
- Embedded `data:image` and `data:video` resources are converted to extension-owned Blob URLs. The background page retains each Blob until Firefox reports that download complete or interrupted. Direct HTTP(S) videos use their exposed URL without DRM-specific filtering or rewriting.
- `extension/popup/popup.html` never interpolates page content with `innerHTML`; it uses DOM nodes and `textContent`. Thumbnails use `referrerpolicy="no-referrer"` and load only as their rows approach the visible list.

The `activeTab` permission is granted only after the user invokes the toolbar action. Broader website access is requested only from a direct **Enable auto-follow**, **Track page**, image-only ZIP, or supported provider action and can be declined. Mozilla documents this split in its [`activeTab`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/permissions), [`scripting`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/scripting), and [`optional_host_permissions`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/optional_host_permissions) references.

## Version history

- **1.12.1** — Restores active-story and highlight collection for signed-in private Instagram profiles when Instagram rejects its legacy profile lookup.
- **1.12.0** — Adds a site-scoped completed-download ledger, explicit review/notify/automatic tracker actions, a local approval inbox, and substantial queue, manager, dashboard, and Instagram collection performance improvements.
- **1.11.0** — Adds bounded background tracking with exact-site permission, baseline/new-match detection, include/exclude matching rules, per-check limits, incremental same-origin static pagination, retry/backoff and auto-pause behavior, system notifications, a 40-run activity history, durable queue handoff, and a dedicated all-trackers dashboard. Instagram profile-grid carousels now recover every exposed item when the profile feed API is unavailable. JavaScript-driven and AJAX “More” pagination remain intentionally out of scope.
- **1.10.0** — Introduces the redesigned AnyDownload interface and illustrated Firefox icon, unifies all extension surfaces under one restrained light/dark theme, makes live updates automatic, simplifies filters and download actions, removes heuristic duplicate tooling, adds bounded FapFolder group-video collection, and improves signed-in Instagram profile pagination and collection filters.
- **1.9.0** — Adds ordered Instagram carousel expansion, active-story and highlight extraction, and an explicit profile-owner **Stories & highlights** collector that reuses the current Instagram session without persisting credentials. It also adds basic public YouTube progressive-video resolution, usually 240p/360p with audio, with anonymous player requests and just-in-time queue refreshes that never persist signed Googlevideo URLs.
- **1.8.0** — Adds direct MP4, WebM, Ogg/OGV, MOV, M4V, and MKV discovery; video poster/placeholder rows and previews; media filters; image/video context actions; live gallery updates; and ordinary single, bulk, or mixed image/video downloads. ZIP creation remains image-only. Direct exposed HTTP(S) URLs are handed to Firefox unchanged without a DRM detection blocklist; AnyDownload does not decrypt protected media or assemble `blob:`, HLS, or DASH streams.
- **1.7.0** — Adds safe filename templates with page/image metadata tokens and a durable ordinary-download queue with pause/resume/cancel/retry controls, recent batch history, and today/lifetime statistics.
- **1.6.1** — Moves ZIP creation out of a long-lived background message into a visible Archive Progress tab, adds progress and cancellation, splits large jobs into bounded 64 MiB parts, and polls download completion defensively. This fixes extension-context loss seen with 400+ images.
- **1.6.0** — Makes the Firefox Sidebar follow active tabs and completed navigations after an optional permission grant, and adds local multi-image ZIP downloads with partial-failure reports.
- **1.5.0** — Adds the top-level **Download N** bulk action, persisted Smart Filters and **Photos only**, selection-preserving live gallery updates, and a responsive Firefox Sidebar.
- **1.4.1** — Stabilizes compact-popup sizing and reduces the destination panel height.
- **1.4.0** — Adds the optional resizable manager while retaining the quick toolbar popup.
- **1.3.0** — Adds image context-menu actions and lazy full-size dimension detection.
- **1.2.0** — Adds gallery-original and responsive-source resolution.
- **1.1.0** — Adds remembered per-site ignore rules and full-tab previews.

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

## Tagged GitHub releases

Pushing a `v*` tag runs [`.github/workflows/release.yml`](.github/workflows/release.yml). The workflow requires the tag, `extension/manifest.json`, and `package.json` to contain the same version; runs the tests and `web-ext lint`; builds the extension ZIP; generates `SHA256SUMS.txt`; submits the listed update to AMO; and creates a GitHub release with generated notes and both files attached.

```bash
# After updating both version fields and committing the release:
git tag -a v1.12.1 -m "AnyDownload 1.12.1"
git push origin v1.12.1
```

AMO submission requires the `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` repository secrets. The workflow submits without waiting for review; after Mozilla approves the version, Firefox distributes it through normal automatic update checks. The attached GitHub ZIP remains an unsigned source package rather than the installable AMO build.

## Package and install permanently

Normal Firefox Release and Beta builds require Mozilla signing for permanent installation. The tagged workflow automates listed updates for an existing AMO add-on. For a first or manual publication:

1. Before the first publication, set `browser_specific_settings.gecko.id` in `manifest.json` to a stable, unique email-style ID. Never change the ID after publication.
2. Run the tests and `web-ext lint`.
3. Build a ZIP with `web-ext build --source-dir extension`.
4. Submit it through the [Firefox Add-on Developer Hub](https://addons.mozilla.org/developers/) as a listed add-on, or use Mozilla's unlisted signing channel for private distribution.

The manifest declares `data_collection_permissions.required: ["none"]` because this implementation sends no browsing/media information to an analytics or cloud service. If you later add telemetry or remote processing, update that declaration and the privacy experience. See Mozilla's [Firefox built-in data consent guide](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/) and [signing overview](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/).

## Known boundaries

- It normally scans media currently present or referenced in the loaded DOM; it does not crawl every page of an entire domain. Instagram profile routes are a bounded exception: they paginate that one profile's accessible feed through first-party JSON responses, while exact post/story/highlight routes remain route-scoped. The user-initiated **Stories & highlights** action requests only that profile owner's exposed collections. A recognized YouTube video route may make up to two bounded, anonymous first-party player requests for one public video ID.
- Passive live updates watch the source tab while the manager surface remains open. Explicit **Collect gallery** adds bounded scrolling, recognizable non-form Load more buttons, and static same-origin Next pages. It cannot recover media the site never exposes or replay arbitrary AJAX controls. Instagram profile pagination remains handled by the bounded Instagram adapter.
- The compact popup and manager stop automatic updates when their source tab closes or navigates. With optional auto-follow access, the Sidebar tears down the previous watcher, moves to the active loaded page, scans it, and starts a new watcher only after that scan succeeds.
- The compact toolbar popup can update only while it remains open; Firefox closes it when the webpage regains focus. Use the resizable manager or Firefox Sidebar for updates that must continue while you scroll. The Sidebar is a desktop feature and is hidden on Firefox for Android.
- **Photos only** uses filenames, URL/element hints, and known dimensions. It can misclassify unusually named photos or photo-like logos; turn it off, use the individual checkboxes, or choose **Ignore** to correct the selection.
- Media with the same stable adapter identity, or the same URL after only expiring CDN credentials change, shares one manager record during rescans. Distinct responsive/cropped sources remain separate even if they look identical; use individual selection or **Ignore** when you do not want one of them.
- Filename templates produce one safe filename segment, not nested folders. Unknown dimensions render as `unknown`, generated names retain a recognized image or video extension, unsafe characters are replaced, and long/colliding names are shortened or suffixed.
- Format filtering is inferred from the media URL and exposed metadata, not from a preflight fetch of every response. An extensionless endpoint can therefore remain unknown even if the server eventually returns a supported image or video.
- The collector can use only sources that the loaded page exposes. It prefers explicit original/full-size image attributes, the largest candidate in the active responsive image set, and direct video URLs exposed through the media element. It does not guess arbitrary URL rewrites or fetch every linked detail page to invent a larger asset.
- With `activeTab`, the top page and permitted/same-origin frames are scanned. Cross-origin frames may be omitted unless you add broader host permissions. Navigation ends the temporary grant, so an existing manager/sidebar may ask you to reopen AnyDownload from the target page.
- ZIP creation is image-only and runs only while its visible Archive Progress tab remains open. It fetches sequentially and caps jobs at 2,000 selections, applies a 64 MiB per-image fetch ceiling, and caps each generated ZIP part at 64 MiB including ZIP headers. Large jobs therefore produce numbered parts, while a file at the exact fetch ceiling may be skipped because its headers cannot fit; authentication, Container isolation, hotlink protection, timeouts, or expired signed links can still make individual fetches fail.
- General video support means downloading a directly exposed HTTP(S) file, not recording or reconstructing a stream. The YouTube adapter can resolve a public video ID to a complete progressive file that YouTube's player endpoint already returns, but it still does not record the page's Blob or reconstruct SABR/HLS/DASH. AnyDownload does not assemble page-owned `blob:`/MediaSource content, HLS playlists (`.m3u8`), DASH manifests (`.mpd`), segmented media, or separate audio and video tracks.
- Basic YouTube resolution is intentionally limited to public on-demand media with an already-signed direct format. It normally tops out around 240p/360p, can break when YouTube changes its internal player behavior, and does not support gated/rental/live media, high-resolution split tracks, captions, alternate audio, signature deciphering, proof-of-origin tokens, muxing, licences, or decryption. Exact YouTube host access is requested only when a user queues a result; durable tasks retain the public video ID and itag instead of the expiring signed media URL.
- AnyDownload adds no DRM detector or DRM URL blocklist. If the page exposes a direct HTTP(S) media URL, the ordinary queue hands that URL to Firefox unchanged. The extension does not request content licenses, bypass access controls, or decrypt protected bytes, so a downloaded protected file can remain encrypted or unusable outside its authorized player.
- Page-created `blob:` URLs are skipped with a warning because Firefox does not let an extension background page download a Blob owned by the website. This technical limitation is separate from DRM: ordinary exposed HTTP(S) image/video URLs and bounded embedded `data:image`/`data:video` resources are supported.
- Canvas pixels, inline SVG markup, closed shadow roots, browser-internal pages, the built-in PDF viewer, and protected Mozilla pages are not downloadable through this scanner.
- A safety limit caps a scan/batch at 1,500 media records and computed-style inspection at 10,000 elements. The manager renders at most 350 matching rows at once, while bulk selection still includes all discovered records.
- The ordinary-download queue retains at most 100 detailed batches, 1,500 task records, and 100 compact history summaries per storage context. Clearing completed work keeps its compact summary, and the oldest finished details are pruned automatically when room is needed for a new batch. The separate completed ledger is fingerprint-based rather than a content hash: distinct URLs that return identical bytes can remain distinct, while URLs differing only in recognized rotating credentials share downloaded state. ZIP entries are not marked individually. Firefox may not expose a useful total byte count for every server response, so those rows show state without a percentage until more metadata arrives.
- Private-window downloads retain their private browsing context when the user has allowed the extension in private windows. Firefox Container-specific cookie stores are not requested in this minimal-permission version, so authenticated media that exists only in a non-default Container may fail.
- Dashboard counters currently describe ordinary queued downloads. ZIP parts are visible in Firefox's native Downloads list and Archive Progress, but individual files inside a locally generated ZIP are not counted as separate browser downloads.
- Full-tab previews make a new media request from a packaged extension page. A hotlink-protected, CORP-restricted, or Container-only image/video may fail there even when its popup thumbnail or poster works; use **Open original** in the preview tab as the fallback.
- Full-size dimension detection also makes a request when an unknown-size row becomes visible. If the server blocks extension-page image requests, the row reports that the full size is unavailable instead of displaying the thumbnail's dimensions as if they belonged to the original.
- HTTP(S) URLs are taken from image- and video-related page elements, but the extension does not pre-fetch every response to verify its MIME type. Suspicious filename extensions are neutralized, and files are never opened automatically.
- A successful queue response means the batch was accepted. Its final network outcome, error, and retry controls appear on the Downloads dashboard and in Firefox's native Downloads list.

## Manual test checklist

- Create trackers on static HTML galleries and deny then grant their exact-site permissions. Confirm the default first check creates a baseline without an action, then test **Add to review**, **Notify only**, and **Download automatically** against newly added URLs. Review mode must retain a pending item without queuing it until **Approve**, **Dismiss** must mark it handled without downloading, Notify only must emit one notification without retaining a pending URL, and automatic mode must use the durable queue. Confirm include/exclude text and wildcard URL rules work, the per-check cap leaves excess unseen matches for the next run, current smart filters and the filename template are honored, pause prevents scheduled checks, resume recreates the alarm, remove deletes it and its pending reviews, and no tracker can be created in a private window. Open **Tracking** and verify review totals, previews, filters, reliability state, action labels, expandable activity metrics, individual actions, Pause all/Resume all, live updates, responsive layout, and link to Downloads. Repeat with **Process current matches** enabled and confirm the selected action is applied to the initial set once.
- Track static galleries with a same-origin `<a rel="next">`/custom Next selector and with a `{page}` URL template. Confirm pages are visited sequentially, duplicates are removed, another-origin link is rejected, empty template pages stop the run, and the page cap is honored. Then test a JavaScript/AJAX **More** control and confirm it remains unsupported rather than replaying captured requests.
- Simulate HTTP 429 with `Retry-After`, a server failure, repeated 401/403 responses, and removed site access. Confirm the dashboard shows retry or automatic-pause state, activity keeps the outcome, system notifications follow each tracker's preferences and open Tracking when clicked, and granting access plus Resume clears the reliability streak.
- Test PNG, JPEG, WebP, AVIF, GIF, SVG, relative URLs, `<picture>`, lazy attributes, CSS backgrounds, and repeated exact URLs.
- Test direct MP4, WebM, Ogg/OGV, MOV, M4V, and MKV URLs exposed by `<video src>`, nested `<source src>`, clearly linked video files, sources populated after lazy loading, and MIME `type` hints. Confirm each direct file appears once and keeps its recognized extension.
- On a FapFolder `/groups/<group>/videos` route, confirm the manager lists direct files from the loaded post links rather than only grid thumbnails, preserves the grid order, and adds newly exposed posts after using **See More**. Repeat signed out and signed in; confirm signed-out posts report the login boundary, signed-in direct files download normally, and unrelated post/navigation links are never crawled.
- On Instagram, test a profile with enough posts to require several feed cursors and mixed photo/video carousels. Confirm all accessible posts appear in feed order, every carousel item expands in source order, and pagination stops cleanly at Instagram's end cursor or a documented bound. Then test a single-photo post and the same carousel from `?img_index=1`, a middle index, and the last index; confirm each exact-post route contains only that post and never fetches related profile/story/highlight content. On the profile, choose **Stories & highlights**, acknowledge the possible story-view warning, and confirm existing posts remain while **Posts only**, **Current story only**, **All highlights**, and each named-highlight filter select the expected records. Repeat signed out, signed in, and in a private window, including an expired/no-story profile and inaccessible private content.
- On YouTube, test a public watch video, Short, `youtu.be` redirect, embed, and YouTube Music video. Confirm the row reports a complete audio+video MP4 and its actual 240p/360p quality, the permission request appears only when Download is chosen, the completed file has sound, and durable queue storage contains the public video ID/itag but no `googlevideo.com`, `expire`, or playback-token query data. Interrupt and retry once to confirm the direct URL is refreshed. Then confirm private/age/member/paid/live/SABR-only cases fail with a useful boundary message rather than claiming a download.
- Test videos with and without `poster`. Confirm the media list shows the poster when available, uses the video placeholder otherwise, and opens a controlled video preview without eagerly loading every full file merely to render its row.
- On a thumbnail gallery, confirm each item appears once, its row identifies a full-size or responsive source, the popup loads the small preview, and **Preview**/**Save** use the original. Include an unordered `srcset` and confirm the numerically largest `w` or `x` candidate wins.
- Click **Select all** and confirm the bottom selection count tracks individual checkbox changes and **Download selected** starts that batch. Clear the selection and confirm the action is disabled; enter an unsafe folder and confirm the bottom download actions remain disabled.
- Expand **Filters**, turn on **Photos only** on a page containing normal photos, logos, avatars, SVG icons, and tiny pixels, and confirm obvious non-photo assets leave the eligible selection. Turn the filter off and select any exceptions manually.
- In **Filters**, switch among **Images & videos**, **Images**, and **Videos**, test each supported image/video format, and confirm **Photos only** excludes video records until it is turned off. Confirm **Select matches only** affects only filtered rows, nonmatching rows cannot remain silently selected, **Reset** restores defaults, and the settings survive closing/reopening the manager.
- With the untouched `{index}-{filename}` default, download several media items and confirm sorting the destination by filename preserves their manager/site discovery order as `0001-…`, `0002-…`, even when later items finish first. Deselect the first discovered item and confirm the selected subset restarts at `0001` without a gap. Then test `{filename}`, `{name}-{index}.{ext}`, `{hostname}-{page-title}-{date}-{width}x{height}.{ext}`, duplicate rendered names, a missing token, and unsafe punctuation with both image and video selections. Confirm the live example matches ordinary filenames and image-only ZIP names, recognized extensions survive, invalid templates block downloads, and collisions receive stable numeric suffixes.
- Confirm repeated exact URLs and a URL with only refreshed CDN credentials merge into one row, while distinct thumbnail/original or responsive-transform URLs remain separate records. Trigger several automatic rescans and confirm a known checked item remains checked when its signed URL refreshes.
- Open an infinite-scroll test gallery and leave the manager or sidebar open. Uncheck one known item, leave another checked, then scroll until new images and direct video sources appear. Confirm automatic updates require no button, preserve known checked/unchecked state, select only eligible new media, and leave ignored or filter-rejected additions unselected.
- Open the Firefox Sidebar from the toolbar button and from Firefox's sidebar menu. Choose **Enable auto-follow**, accept the optional permission, switch active tabs, and navigate the active tab; confirm the old watcher stops, each completed normal page is scanned automatically, and live updates start for the new source. Remove the permission in Firefox and confirm the sidebar explains how to enable it again.
- Select local embedded and cross-origin images, choose **Download ZIP**, approve the selected origins, and confirm Archive Progress opens and saves an archive containing unique filenames. Include one failing URL and confirm the successful images plus `anydownload-errors.txt` remain in the ZIP; deny the permission once and confirm no fetch or download starts.
- Select videos alone and together with images and confirm the bottom ZIP action is unavailable for selections containing video. Deselect the videos and confirm the image-only ZIP works; then confirm the videos remain available through ordinary single or bulk download.
- Run a 1,500–2,000 image ZIP job whose total exceeds 64 MiB. Confirm Archive Progress remains responsive, progress reaches the full selection, numbered `part-001`, `part-002`, … archives are saved sequentially, and no “Receiving end does not exist” message appears. Cancel a second run and confirm its unfinished part is discarded while already completed parts remain.
- Complete a normal batch, reopen the same website, and confirm matching rows show **Downloaded**, start deselected, and disappear under **Hide downloaded**. Confirm a refreshed signed URL with only token/expiry changes retains downloaded state, a different transform remains new, **Select all** skips the completed row, manually checking it or choosing **Again** permits an intentional repeat, an in-progress duplicate shows **Queued**, an interrupted latest attempt shows **Failed**, and normal/private ledgers remain isolated. Downloading the same batch explicitly twice should still make Firefox add unique suffixes instead of overwriting.
- Download one direct video, a video-only batch, and a mixed image/video batch. Confirm each enters the ordinary queue, uses the requested relative destination and template, reports progress/history like an image download, and continues after the manager closes.
- Start a batch larger than the queue concurrency, close the popup, and open the Downloads dashboard. Pause and resume a file and the whole queue, cancel pending work, retry an interrupted item, clear completed batches, and confirm the header badge follows active/queued/paused totals.
- While that batch runs, confirm known byte totals advance, completed and downloaded-byte statistics update once per finished attempt, daily and lifetime totals remain distinct, and reloading the temporary extension reconciles surviving Firefox downloads without double-counting them.
- Repeat a small batch in a private window. Confirm the private dashboard is labeled accordingly and its URLs, queue history, and counters do not appear in the normal dashboard or survive a Firefox restart.
- Try folder input such as `Summer/2026`, `../escape`, `/absolute/path`, `CON`, emoji, and trailing dots.
- Test a logged-in image and direct video, an expired URL, offline mode, and a server returning 403/404.
- Start a large batch and close the manager window; downloads already handed to Firefox should continue.
- Try `about:`, the built-in PDF viewer, and addons.mozilla.org; the manager should show a friendly restricted-page error.
- Put HTML-looking text in an image's `alt` attribute and verify it remains inert text.
- Ignore a logo, reopen the manager on the same website, and confirm it stays hidden and unselected. Restore it from **Ignored (N)** and confirm it remains unselected.
- Confirm that ignoring `logo.png?v=1` does not hide `logo.png?v=2` or a query-driven sibling such as `render?id=2`.
- In a private window, ignore an image, restart Firefox, and confirm the private rule was not retained.
- Click HTTP(S) and embedded-data thumbnails, verify each opens in a new preview tab, and toggle fit-to-window/actual size.
- Click video posters and placeholders, verify each direct HTTP(S) file opens in the video preview with native controls, and verify **Open original** uses the exposed URL.
- Right-click a gallery thumbnail and verify **AnyDownload → Download media**, **Preview media**, **Ignore media on this site**, and **Open media list…** all act on the original rather than the thumbnail.
- Right-click a page video and verify the **AnyDownload** download, preview, ignore, and open-list actions resolve the direct media source and use the ordinary queue for download.
- Test a page-owned `blob:`/MediaSource video, an HLS `.m3u8`, and a DASH `.mpd` player. Confirm AnyDownload does not claim to assemble those streams. Separately expose a direct HTTP(S) media URL and confirm it is handed to Firefox without a DRM detection/blocklist; the extension must neither claim to decrypt protected content nor alter the URL.
- Confirm a full-size row changes from **checking full size…** to its actual pixel dimensions when it becomes visible, while off-screen rows do not start eager probes.
- Open the compact toolbar popup, choose **Open window**, resize the manager larger and smaller, then repeat from the toolbar popup and confirm the same manager window is focused with its current size while the clicked source tab is rescanned.
- In the compact popup, test a long page title, folder path, media URL, and filename; header controls, filters, row actions, and the bottom download actions must remain inside the popup without horizontal scrolling.

## Suggested next features

- Add per-site profiles that remember the destination subfolder, smart filters, and CSS-background setting.
- Add reusable filename-template presets and an optional subfolder token mode with explicit path-segment validation.
- Add export/import for queue history and statistics without exporting private-session records.
- Add a pick-on-page mode that highlights the media under the pointer and lets the user download, ignore, or add it to the current selection without searching the list.
- Add optional quality selection and assembly for unencrypted HLS/DASH streams, including separate audio/video track muxing, without presenting it as DRM decryption.
- Add duration and codec filters when video metadata can be obtained without eagerly fetching every file.
- Add a native-messaging companion only if arbitrary OS folder selection is a hard requirement.
