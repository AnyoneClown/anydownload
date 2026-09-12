# Changelog

All notable changes to AnyDownload are documented here.

## [Unreleased]

## [1.14.0] - 2026-09-12

### Added

- Optional Google sign-in through Supabase and automatic cross-device sync for settings, filters, filename templates, ignored-media rules, and completed-download records. Sync preserves offline edits and deletions; active queues, destination folders, saved galleries, and private-session data stay on the device. Includes a Supabase migration and sign-in callback setup guide.

### Fixed

- Photo checkboxes and **Select matches only** remain available during live library scans, and selections survive scan results and refreshed media URLs.
- **Collect gallery** recognizes **Load more videos** controls and follows Next links using the page's declared base URL, while keeping pagination on the original website.

## [1.13.2] - 2026-09-07

### Changed

- **Clear media** is now visible beside **Collect gallery** and clears the current website's saved list. Selection-only clearing is labeled **Deselect**, and the cleared state explains how to start again while keeping downloaded files and history.

### Fixed

- Confirmed Instagram photo stories keep their image URL and type when merged with video hydration, live scans, or older saved-gallery records. Direct story/highlight pages now inspect viewer data and request bounded first-party metadata when the original media type is missing.
- **Collect gallery** now recognizes FapFolder's JavaScript **See More** control on group photo pages, including its non-button markup. Controls inside forms remain excluded.

## [1.13.1] - 2026-09-07

### Fixed

- Instagram stories and highlights explicitly marked as originating from a photo now use the largest available image instead of the generated video. Real videos and items without a confirmed photo source or usable image keep the video download.

## [1.13.0] - 2026-09-07

### Added

- **Collect gallery** automatically scrolls the source page, activates recognizable non-form Load/Show/See more buttons, and optionally follows up to ten same-origin Next pages. Progress, Stop, bounded requests, and partial-result retention keep collection reviewable before downloading.
- A growing saved gallery for each website combines discoveries across its pages and tabs, preserves selections and source-page filename metadata, and restores when AnyDownload reopens. Normal galleries stay locally on the device; private galleries use session storage. **Clear saved gallery** removes one site's collection without changing downloaded files.

### Changed

- Clicking a media card toggles its download selection; a separate **Preview** button opens the full preview without changing selection.
- Redesigned the media manager with larger previews, remembered grid/list layouts, labeled navigation, and a persistent download bar with a clickable destination. Collection, filter, and filename settings use keyboard-accessible panels so the gallery stays visible.
- Download actions show the file count and identify selections hidden by search. Empty searches offer a filter reset, and invalid destination or filename settings remain discoverable.
- Refreshed light and dark colors, focus indicators, and dashboard layouts. Downloads prioritizes queue activity, and dashboard navigation preserves the source page when returning to Media.

### Privacy and boundaries

- Saved galleries retain media URLs and bounded display metadata: at most 1,500 items and 2 MB of media URLs per site, 20 sites, and 4 MiB of gallery data per browsing context. Older sites are evicted at the shared limit. YouTube entries retain public video/format references rather than signed playback URLs; their previews open the public video page.
- Collection is limited to 120 scroll steps, 20 Load more actions, about five minutes plus an in-flight request, 4 MiB per fetched HTML page, and 16 MiB of fetched HTML in total. Subsequent pages are parsed as static HTML; page scripts and arbitrary detail links are not followed. No additional permissions are required.

## [1.12.1] - 2026-09-04

### Fixed

- Private Instagram profile story collection now reuses the profile ID exposed by the signed-in page when Instagram rejects the legacy profile lookup, restoring active stories and highlights available to the current browser session.

## [1.12.0] - 2026-08-28

### Added

- A tag-driven release workflow that tests, lints, and packages the extension, submits listed updates to AMO, and creates checksummed GitHub release assets.
- A bounded, site-scoped completed-download ledger that stores compact stable fingerprints instead of media URLs. Manager rows now show New, Queued, Downloaded, or Failed state; completed items are skipped by default selection, can be hidden, and remain available through an explicit Download again action.
- Three tracker actions: **Add to review**, **Notify only**, and **Download automatically**. New trackers default to review, while existing tracker records retain automatic-download behavior.
- A local review inbox on the Tracking dashboard with media previews and individual Approve or Dismiss actions. Approval uses the tracker’s current destination and durable queue; pending signed URLs are refreshed whenever the tracked page exposes them again.

### Changed

- Large durable queues now reuse already-normalized state for transitions and read-only summaries, reconcile native downloads concurrently, avoid unchanged and byte-only storage rewrites, and send lightweight summary-only payloads to the manager badge.
- Manager filtering and rerendering now cache stable media/filter metadata and filename previews, index current rows by URL, and debounce text-filter DOM rebuilds. Downloads dashboard polling also skips unchanged DOM rebuilds.
- Instagram collection now skips unrelated inline scripts and link scans, caches repeated carousel/DOM analysis, and fetches independent profile carousels, stories, and highlights with bounded three-request concurrency while preserving source order.

### Privacy and boundaries

- The normal completed ledger retains at most 5,000 fingerprints and 500 per source website; private-window completion state stays in session storage. Filenames and completion times are retained, but source media URLs are not.
- Review mode necessarily retains the pending media URL and bounded display metadata in local extension storage. The inbox is limited to 500 items and 2 MB of review payload, is unavailable in private windows, and is removed per tracker when that tracker is deleted.

## [1.11.0] - 2026-08-23

### Added

- A bounded background tracker that stores the current URL, folder, filename template, filters, matching rules, pagination strategy, and alert preferences; requests exact-site access; baselines existing matches by default; and sends only unseen matches to the durable download queue.
- Include/exclude text, newline-separated `*`/`?` URL patterns, a 1–100 per-check download cap, and incremental static pagination through either a same-origin Next link or a same-origin `{page}` URL template for up to ten pages.
- Optional system notifications for newly queued matches and tracker errors. Clicking a tracker notification opens the Tracking dashboard.
- Reliability controls with bounded exponential retry delays for failures and rate limits, `Retry-After` handling, consecutive-error state, and automatic pausing when site permission is removed or authentication repeatedly fails.
- Compact tracker controls for interval selection, optional initial downloads, matching, pagination, alerts, live status, manual checks, pause/resume, and removal.
- A dedicated responsive **Tracking** dashboard, linked from the manager and Downloads, with all-tracker statistics, search/status filters, saved matching and pagination details, per-run activity history, reliability state, individual run/pause/remove actions, source-page links, and pause/resume-all controls.

### Fixed

- Instagram profile-grid carousels now request the exact post when the profile feed API is unavailable, preserving every ordered photo or direct video instead of only the visible cover.

### Security and boundaries

- Tracker requests reuse the normal browser session without reading or storing cookie values, stay on the granted origin, time out after 15 seconds, reject non-HTML/oversized responses, and retain compact media fingerprints instead of page documents.
- Pagination remains same-origin, sequential, user-configured, and capped. The MVP does not run page JavaScript, press **More**, replay AJAX requests, crawl detail pages, track private windows, or assemble `blob:`, HLS, or DASH media.

## [1.10.0] - 2026-08-13

### Added

- A new illustrated AnyDownload icon with dedicated transparent PNG assets for Firefox's 16, 32, 48, and 96 pixel extension surfaces.
- A shared light/dark visual theme for the manager, Downloads dashboard, Archive Progress, media preview, and Sidebar fallback.
- Bounded FapFolder group-video collection that follows only loaded post links in source order, reuses the current tab session, and extracts direct video files from each post's lazy player markup.
- Bounded, session-authenticated Instagram profile-feed pagination that follows first-party cursors, preserves feed order, and expands every photo or direct video in every returned carousel.
- Instagram profile collection filters for posts only, the current story, all highlights, or one discovered named highlight.

### Changed

- The extension interface now uses a restrained desktop-utility design with warm neutral surfaces, forest-green structure, vermilion actions, clearer toolbar icons, card-based media rows, and responsive multi-column manager layouts.
- Downloads, Archive Progress, previews, and manager states now share consistent controls, borders, status colors, focus treatments, spacing, and reduced-motion behavior.
- The default filename template is now `{index}-{filename}`. Zero-padded names are assigned in selected discovery order before concurrent downloads start, so folders sorted by filename retain the page or site-adapter order regardless of completion timing.
- Automatic live updates now start after every successful manager scan. Sidebar handoffs stop the previous watcher, scan the newly active or navigated page, and start a watcher for that new source without a separate capture action.
- The profile-only **Stories & highlights** action uses the current signed-in or private-window Instagram session, preserves already collected profile posts, and warns that requesting story data may register as a view.
- Exact Instagram post and reel routes now collect only the selected post, expand its complete carousel regardless of `img_index`, and never fetch related profile posts, stories, or highlights.
- Exact Instagram posts opened through profile-page SPA navigation now recover the shortcode-scoped post with the active browser session when the original document has no matching hydration data.
- Instagram profile, story, and highlight access remains bounded by item, document, response-size, and combined-URL limits; private or restricted media is returned only when it is available to the current browser session.
- Exact media URLs continue to share one manager identity across frames and live rescans, while distinct URLs remain separate records.
- **Photos only** now lives inside the expandable **Filters** panel.

### Removed

- Manual manager reload and live-capture controls; live updates are always enabled after a successful scan.
- Heuristic image duplicate analysis, its Duplicates panel, keep-best selection, and hide-extra-copies controls.
- Minimum-width, minimum-height, orientation, and unknown-size filter controls.
- Duplicate top-of-list download and ZIP actions; both actions now appear only in the bottom bar.

## [1.9.0] - 2026-08-07

### Added

- Route-scoped Instagram post and reel extraction that expands every ordered photo and direct video in a carousel regardless of the starting `img_index`.
- Full active-story and open-highlight extraction from Instagram's structured page data, including mixed image/video collections and their best exposed resolutions.
- An explicit **Stories & highlights** action for collecting the current Instagram post plus the profile owner's active story and exposed highlights in the user's existing signed-in session.
- Bounded Instagram document, item, and payload traversal with clear partial-access, expiry, and unsupported-stream warnings.
- Automatic basic YouTube extraction on public watch, Shorts, embed, live-route, and YouTube Music video URLs. The resolver accepts only direct HTTPS MP4/WebM files already returned by YouTube's player API and prefers complete video-plus-audio formats.
- A two-client anonymous YouTube fallback (Android VR, then standard Android) for pages whose web player exposes only a page-owned Blob or SABR metadata. It normally yields a progressive MP4 around 240p/360p; high-resolution split tracks are deliberately not merged.
- Title-, quality-, poster-, duration-, and dimension-aware YouTube rows, previews, ordinary downloads, and desktop video context actions.
- Durable YouTube provider tasks: the queue stores only the public video ID and requested itag, resolves a fresh short-lived file URL immediately before start/retry, and never writes signed Googlevideo playback URLs to extension storage.

### Privacy and access

- Instagram collection runs inside the temporarily authorized source tab and does not read or persist cookies, session tokens, or account credentials.
- Private, close-friends, expired, or otherwise restricted media is collected only when Instagram already exposes it to the current browser session; no login or access control is bypassed.
- Related story/highlight collection is user initiated because Instagram may count opened story data as viewed.
- Instagram downloads send only an allowlisted first-party `Referer: https://www.instagram.com/` header so Instagram's CDN can accept the file request; no arbitrary page-supplied headers are forwarded.
- YouTube fallback requests go directly from the extension to YouTube with `credentials: "omit"`; account cookies, authorization headers, page visitor tokens, API keys, player responses, and signed file URLs are not persisted.

### Provider boundaries

- Basic YouTube support targets public on-demand videos with a complete progressive file. Age/private/member/paid/region-gated videos, live or upcoming streams, rentals, captions, alternate audio, and formats requiring a signature cipher, SABR/HLS/DASH reconstruction, separate-track muxing, a proof-of-origin token, a licence, or decryption remain unsupported.
- No DRM URL blocklist is applied to direct files. Protected-playback metadata is reported and a direct URL may still be handed to Firefox unchanged, but AnyDownload does not obtain licences or decrypt protected bytes.

## [1.8.0] - 2026-08-07

### Added

- Direct video-file discovery for exposed HTTP(S) MP4, WebM, Ogg/OGV, MOV, M4V, and MKV sources, including media selected by `<video>` and nested `<source>` elements.
- Video rows that use the page's poster when available and a clear video placeholder otherwise, plus full-tab previews with native Firefox playback controls.
- Media-type and video-format filters so the manager can show all media, images only, or videos only while retaining the existing photo, dimension, orientation, and image-duplicate tools.
- Ordinary single, video-only bulk, and mixed image/video batch downloads through the durable queue, with the existing filename templates, relative destination folders, progress controls, history, statistics, retries, and private-session separation.
- Image/video context-menu actions for direct download, preview, ignore, and opening the full media list.
- Live Capture discovery and selection-preserving rescans for newly exposed direct video sources as well as images.

### Changed

- User-facing manager terminology now describes media where behavior applies to both images and videos, while image-specific full-size, photo, duplicate, and dimension behavior remains documented separately.
- Recognized video extensions and MIME hints now retain safe MP4, WebM, Ogg/OGV, MOV, M4V, and MKV filenames instead of falling back to image-only naming assumptions.
- ZIP creation remains intentionally image-only; direct videos use the ordinary queue individually or in bulk and are never assembled into the local image archive.
- Extension and package versions are now `1.8.0`.

### Media boundaries

- No DRM detector or DRM URL blocklist was added. A direct HTTP(S) media URL exposed by the page is handed to Firefox's Downloads API unchanged.
- AnyDownload does not acquire DRM licenses, bypass access controls, or decrypt protected bytes. A directly downloaded protected file may therefore remain encrypted or unusable outside its authorized player.
- Page-owned `blob:`/MediaSource playback, HLS (`.m3u8`), DASH (`.mpd`), segmented streams, and separate audio/video tracks are not recorded or assembled by this direct-file release.

## [1.7.0] - 2026-08-07

### Added

- Safe filename templates for ordinary downloads and ZIP entries, with `{filename}`, `{name}`, `{ext}`, `{index}`, `{hostname}`, `{page-title}`, `{width}`, `{height}`, and local `{date}` tokens.
- Live batch-accurate template validation and filename previews, automatic extension preservation, Unicode-safe length limits, sanitization, and case-insensitive collision suffixes.
- Conservative duplicate detection for thumbnail/full-size relationships and corroborated resized or filename/dimension variants, with exact/likely labels and placeholder safeguards.
- **Keep best selected** and temporary **Hide extra copies** controls that favor full-size and higher-resolution records without creating permanent ignore rules.
- A durable ordinary-download queue with bounded concurrency and persisted normal-window state; private-window state remains session-only.
- A responsive Downloads dashboard with per-file and per-batch progress, pause, resume, cancel, retry, clear-completed, and native file-reveal/folder actions.
- Recent batch history plus today/lifetime completed, downloaded-byte, failed, cancelled, queued, and success-rate statistics.
- Unit and integration coverage for template rendering, duplicate grouping, queue transitions/recovery, the Downloads dashboard, and archive cancellation.

### Changed

- Ordinary single and bulk requests now enter the background queue, so accepted work does not depend on the manager or popup staying open.
- The manager header now links to the Downloads dashboard and reports active, queued, and paused work with a compact badge.
- Queue reconciliation now resumes recovered work on background wake, durably records missed completion events using Firefox completion times, and keeps “today” statistics on the user's local calendar day.
- Partial batch acceptance is reported explicitly, and bulk retry leaves intentionally cancelled files alone while individual cancelled files remain retryable.
- Extension and package versions are now `1.7.0`.

### Privacy

- Duplicate decisions use local URL and metadata evidence; image pixels are not uploaded or hashed.
- Private queue URLs, history, and counters are kept out of persistent local extension storage.

## [1.6.1] - 2026-08-07

- Moved ZIP creation from a long-lived background message to a visible, cancellable Archive Progress tab.
- Split large archives into bounded 64 MiB parts and added defensive download-completion polling, fixing extension-context loss on 400+ image jobs.

## [1.6.0]

- Added Firefox Sidebar auto-follow for active-tab changes and completed navigations after an optional permission grant.
- Added local multi-image ZIP downloads with partial-failure reports.

## [1.5.0]

- Added the top-level bulk-download action, persisted Smart Filters, **Photos only**, selection-preserving Live Gallery Capture, and a responsive Firefox Sidebar.

## [1.4.1]

- Stabilized compact-popup sizing and reduced the destination panel height.

## [1.4.0]

- Added the optional resizable image-manager window while retaining the quick toolbar popup.

## [1.3.0]

- Added image context-menu actions and lazy full-size dimension detection.

## [1.2.0]

- Added gallery-original and responsive-source resolution.

## [1.1.0]

- Added remembered per-site ignore rules and full-tab previews.
