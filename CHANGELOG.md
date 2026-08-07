# Changelog

All notable changes to AnyDownload are documented here.

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
