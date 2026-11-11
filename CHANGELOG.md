# Changelog

All notable changes to AnyDownload are documented here.

## [Unreleased]

## [1.30.1] - 2026-11-11

### Fixed

- Resume paused downloads. Pausing a download in Firefox no longer counts it as failed, frees its queue slot or discards its data, so resuming finishes it and the queue still tracks it. A paused ZIP download keeps waiting instead of being treated as finished.
- Keep the queue accurate after a browser restart. A task left from an earlier session no longer takes over an unrelated new download because Firefox reused its number.
- Show the right files after switching videos on YouTube without reloading the page, instead of the previous video's files.
- Let tracked pages redirect within the same website, such as from http to https or to an address with a trailing slash. Pausing a tracker during a failing check keeps it paused, and deleting a tracker during a check no longer causes an error.
- Find tracked images whose srcset addresses contain commas, and resolve relative addresses on pages that set a base address.
- Count each skipped image once in scan messages.
- Keep a ZIP part when one of its images is named anydownload-errors.txt.
- Show the connection-limit message as soon as 20 connections exist.

### Performance

- Read only ignore rules from storage instead of the whole store when the popup opens, a scan starts, or a rule changes.
- Skip the full local snapshot in cloud sync when nothing changed locally or remotely.
- Open saved collections faster by not re-processing data the background already prepared.
- Stop a Telegram scan once it reaches its item limit.

## [1.30.0] - 2026-11-10

### Added

- Close any message at the bottom of the collection with its × button, such as the hint to scroll an Instagram profile to the end. A new message shows it again.

### Fixed

- Keep Page actions (⋯) reachable while a scan runs. Stop scanning is now a compact red stop icon, and a narrower Sidebar first shrinks Filters and the layout toggle to icons, then moves search to a second row, instead of pushing Page actions out of view.

## [1.29.0] - 2026-11-10

### Changed

- Browse many Instagram stories and highlights without a sideways scroll. On a profile, each story and highlight is a chip with its name and file count; click the name to open it and see its files in a grid, or click the round mark to select the whole highlight without opening it. With more than three, only the active story starts open, and Show all / Hide all opens or closes every one. Closed highlights do not load their thumbnails.

### Fixed

- Keep the story and highlights block in place while you work. Selecting files, download status updates, and live scan results no longer rebuild it, which used to jump the highlights strip back to the start.

## [1.28.0] - 2026-11-09

### Added

- Select media like in a file manager: Shift+click a card to select or deselect every card between it and the last one you clicked, and press Ctrl+A (Cmd+A on macOS) to select all. A plain or Ctrl/Cmd+click still toggles one card. Ranges skip media that already completed, as Select all does.
- Show media while a long scan is still running. Collecting an Instagram account's history, its stories and highlights, or a FapFolder group's posts now adds what it has found to the collection every second, and you can select it right away. Stop scanning ends the run and keeps everything found so far; downloads start once the scan ends or is stopped. If a scan fails partway, the media it already found stays. Media found so far is also saved every few seconds, so closing the popup keeps it.

### Changed

- Mark every video in the grid. A video tile always shows a play chip with the video's length, or "Video" while the length is unknown, and a video without a poster shows a play mark instead of a text label. When a page does not report a video's length or size, AnyDownload reads only the file's metadata for the videos on screen, two at a time, and saves what it learns with the collection. Opening a video in the preview fills them in too.
- Name the media type before downloading. A selection of only videos or only images reads "Download 4 videos" or "Download 8 images", and a mixed selection shows how many videos it includes, such as "12 selected · 4 videos".

### Fixed

- Stop carrying one profile's media into another. Opening a different Instagram account or Fapello profile now clears the saved collection for that website instead of adding the new profile's media to the old ones. Pages that belong to no single profile, such as a post or the feed, keep the current collection. Downloaded files and history are kept.

## [1.27.0] - 2026-11-08

### Changed

- Keep media tiles in place when the collection updates. Live updates, download status changes, and saved-gallery syncs now update the existing tiles instead of rebuilding up to 350 of them, so thumbnails no longer blank and reload, and the scroll position and keyboard focus stay put.
- Show status messages as a toast over the bottom of the media instead of a row above it, so a message no longer pushes the grid down. Success messages disappear after 8 seconds. The Undo bar for a cleared collection floats the same way.
- Stop toolbar and footer controls from shifting. Tab labels keep one weight and use fixed-width digits, the download button and selection count keep a minimum width, the destination stays on one line, the download queue count is a corner badge on Downloads, and the media list reserves its scrollbar space.
- Fade buttons that are disabled for a moment only after a short delay, so short background work such as a live update does not make them blink.
- Fade unselected media with opacity only and track selection with a class instead of `:has()`, so a selection change no longer restyles the whole grid. Deselecting 350 cards takes about 13 ms instead of 72 ms in Firefox.
- Stop the Downloads page Refresh button from blinking on every automatic refresh.

### Performance

- Stop rewriting the whole download queue to storage several times a second while a download runs. Byte progress stays in memory between status changes, as it already did for Firefox's progress events, and open managers no longer refresh download status in a loop.
- Make filename de-duplication linear. Selecting 1,500 files that share a name took about 1.7 seconds per click and now takes about 25 ms. Building the download batch is about 300 times faster for the same files.
- Normalize the completed-download ledger once per update instead of four times.
- Back off automatic safety rescans of an unchanged page from every 12 seconds to at most once a minute. Live updates of the same site no longer read all extension storage to reload ignore rules, and the manager no longer re-renders and re-reads download status when its own gallery save comes back unchanged.
- Pause the Downloads page refresh and the queue badge while their tab is hidden, and draw a hidden manager tab's live updates once it is shown again.
- Skip computed-style reads for elements that cannot show a CSS image (scripts, metadata, SVG shapes) and read the mask image once, which reduces work on the scanned page.
- Check a paused data: or blob: download less often over time instead of every second.

## [1.26.3] - 2026-11-06

### Fixed

- Collect every slide of an Instagram carousel from a profile whose grid links posts by 39-character codes, as private profiles do. The post lookup skipped those codes, so only the grid cover was collected. It now resolves them through the media ID in the code's first 11 characters.
- Send Instagram GraphQL requests the way Instagram's web app does, with the page's `fb_dtsg` token, async flags, and the query's provided variables, and accept the `text/javascript` JSON it returns. A signed-in session answered the previous requests with an HTML page, so profile history, post lookups, and the story fallback failed. Stop sending GraphQL for the rest of a scan once it answers with a page, and stop the scan when a query reports a rate limit.
- Keep reading an Instagram profile's post history when Instagram reports a failed field on a post it still returned.

## [1.26.2] - 2026-11-06

### Changed

- When an Instagram profile scan cannot read the full post history, say that only the posts loaded on the page were collected and ask to scroll the profile to the end, then scan again. The request details move to the page console.

### Fixed

- Stop Instagram post and reels collection from failing on profiles whose page state holds sparse arrays ("can't access property Symbol.iterator").
- Send Instagram GraphQL requests to `/api/graphql`, which Instagram's web app uses now; `/graphql/query/` answers 403 or redirects. Use the operation ID and name of a query the page has already loaded, with an updated fallback for profile posts, and include the page's request token.

## [1.26.1] - 2026-11-06

### Fixed

- Show why an Instagram post and reels collection failed, with the error and the step where it stopped, instead of the generic "did not expose media for this exact route" message. Firefox reports a collector that threw as an error result, which was only read for stories and highlights.
- Center the Preview and More icons on media tiles and the Filters icon in the narrow toolbar.

## [1.26.0] - 2026-11-06

### Changed

- Redesign the media manager around the media itself. A slim header names the scanned page (an Instagram profile by its handle), one toolbar holds the type tabs, search, Filters, sort, layout, and page actions, and the action bar holds the selection count, Select all, Deselect, the destination, and Download. The popup now shows about 15 thumbnails instead of 4.
- Show media as a dense grid without card chrome. Selected files carry the number they will be saved with (`{index}`), unselected files fade once anything is selected, and size, video duration, carousel position, and download status appear on the tile. Preview and More appear on hover or focus, and on touch screens More stays visible.
- On Instagram profiles, add All, Posts, Story, and Highlights tabs, show the story and each highlight in a strip above the posts with a control to select or deselect the whole group, and use the 4:5 post grid.
- Say "Looking for media…" while a scan is still running instead of "No media found yet".
- Fit the Sidebar and Firefox for Android toolbar into two rows.

## [1.25.0] - 2026-11-05

### Changed

- Keep Instagram live updates, Sidebar tab follows, and page reloads to the loaded page after a route has been collected. Network collection runs for explicit scans and at most once per route every 10 minutes, and page-only refreshes no longer replace resolved slides or videos with grid covers.
- Stop an Instagram collection at the first rate-limit, login, or security-check response, cancel its pending requests, and pause automatic network collection for at least 5 minutes after a rate limit. Explain what happened and what to do next, keep media collected before the stop, and drop generic "may be private" guesses for these cases.
- Report Instagram results with file and post counts, and show partial results and scan warnings with a distinct warning style.
- Explain Firefox download interruption codes on the Downloads page with a next step, keeping the original code in the tooltip, and name each row action after its file or batch for assistive technology.
- Give the Downloads and Trackers buttons accessible names that match their visible labels and announce the queue count. Make secondary-button borders meet non-text contrast in light mode.

### Fixed

- Keep the direct MP4 for a mixed Instagram carousel slide when the feed first exposed a larger cover image for the same slot.
- Continue parsing later Instagram responses after one oversized script reaches the structured-data traversal limit.

## [1.24.2] - 2026-10-28

### Fixed

- Restore Instagram active-story collection through the current story viewer's owner-scoped connection query when the older endpoints fail. Use the loaded viewer's query ID when available, retain bounded fallbacks, and keep the current-story filter selected while refreshing the same profile.

## [1.24.1] - 2026-10-26

### Changed

- Revert the Instagram fetching changes introduced in 1.24.0, restoring the interface and collection behavior from 1.23.2. Publish the rollback under a newer version so existing installations can receive it as an update.

## [1.24.0] - 2026-10-26

### Changed

- Add visible Instagram fetch controls for highlights, active stories, and posts/reels, with live post and media counts, highlight progress, and collection filters with file counts.
- Allow an Instagram fetch to be stopped or restarted while running, and allow Undo to restore the cleared collection during refetching. Abort pending requests and reject superseded results while preserving private-session isolation.
- Process Instagram post and highlight responses incrementally within the existing concurrency and safety limits, release parsed responses earlier, avoid duplicate profile-object processing and successful highlight-page requests, and yield between long script-parsing batches.

## [1.23.2] - 2026-10-26

### Fixed

- Expand Instagram profile carousel covers through the exact post query and loaded page data, so every exposed photo and direct video is collected even when the profile feed supplies only the first slide.
- Allow larger Instagram profile histories within a 512-request, two-minute collection budget, retaining existing response and media limits and enforcing the shared byte allowance across concurrent requests.

## [1.23.1] - 2026-10-24

### Fixed

- Retry Instagram active-story collection through the web story viewer's owner-scoped GraphQL query when the legacy endpoint fails, and show a story-specific failure even when highlights load successfully.

## [1.23.0] - 2026-10-18

### Changed

- Simplify Account and Integrations to compact account/sync controls and server setup, with small Account and Integrations buttons at the top right beside the three main tabs.
- Add useful first-use guidance and direct setup actions to Trackers and Integrations, including URL-based tracker setup, explicit Add server, and clear upload prerequisites and limits.
- Replace Downloads and Trackers dashboard tiles with compact work lists, contextual controls, real transfer results and schedules, and optional statistics or rule details. Hide empty queue/review sections and remove repeated category headings.
- Refine the media manager with clearer collection headings, more readable filenames and metadata, consistent controls, stronger focus and field boundaries, and polished light/dark states.
- Improve narrow Sidebar and landscape layouts, filter explanations, selection controls, and download settings.
- Add clear loading, empty, and failure guidance across Downloads, Trackers, Account, and Integrations, with labeled filters, per-file progress, and readable mobile details.
- Fit standalone previews to the available window space and add a visible Actual size / Fit to window action. Improve archive results, upload preparation feedback, and the Sidebar fallback.

### Fixed

- Preserve keyboard focus through media updates, preview navigation, and action-menu dismissal; keep disclosure states and loading announcements accessible.
- Keep busy media-card actions disabled consistently, prevent filtered selection controls from overlapping Sort, and preserve keyboard access to embedded workspaces.
- Preserve existing tracker settings during URL-based setup, wait for saved settings before saving, and keep the approved site URL fixed during permission requests.
- Preserve deliberate keyboard focus changes when slow integration actions finish.

## [1.22.2] - 2026-10-16

### Changed

- Reuse bounded URL parsing and ancestor metadata during page scans, and skip redundant media queries after a complete DOM traversal.
- Generate unselected filename previews only for visible gallery rows, skip filename refreshes when dimensions cannot affect the template, and retain media cards when download statuses are unchanged.
- Copy only affected queue tasks for download progress and scheduling, refresh each job once during batched reconciliation, and validate retained queue details once when making room for a large download batch.
- Add repeatable synthetic queue benchmarks and regression checks for expensive-operation counts.
- Add a real Firefox comparison harness with local large galleries, UI timings, native-download validation, private-window checks and live-update regressions.
- Speed up large-gallery opening and reopening with indexed selected-filename collision checks and fewer saved-gallery URL validations; preserve legacy Unicode filename behavior and all storage bounds.
- Measure fresh and saved manager openings separately, with startup-stage timings and a visible-frame proxy, against either a Git revision or an uncommitted extension snapshot.

### Fixed

- Prevent duplicate maximum-length queue IDs from hanging normalization by reserving space for their uniqueness suffix.

## [1.22.1] - 2026-10-11

### Fixed

- Give Select all, Deselect, and sorting controls visible borders, readable labels, and consistent spacing in the popup and Sidebar.
- Center the three-dot menu and preview icons inside media action buttons, including touch layouts.

## [1.22.0] - 2026-10-09

### Changed

- Put Media, Downloads, and Trackers in a compact top navigation bar, with Account and Integrations in Settings. Use the full gallery width in the popup and Firefox Sidebar, with a readable list on the narrowest screens.
- Expose All, Images, and Videos filters with collection counts, and show removable chips for active filters without clearing selected files.
- Simplify media cards to selection, preview, and an actions menu. Keep actions bound to the current media record when live updates change its URL, and invalidate them when the source or private context changes.
- Keep one primary Download action, with ZIP and Upload in its menu. Explain the image-only ZIP restriction there while retaining visible warnings about selected files hidden by filters.
- Move scanning and collection management into Page actions, and explicitly label the collection-clearing rescan. Preserve keyboard focus, touch targets, private storage separation, and existing permissions.

## [1.21.11] - 2026-10-06

### Fixed

- Collect loaded images and direct videos beyond the general 10,000-element scan limit so the end of long galleries, including Fapello `page-2`, remains discoverable. Bound the additional media pass separately and retain existing limits for CSS scanning, collected files, and URL data.

## [1.21.10] - 2026-10-06

### Fixed

- Remove the Fapello **Scan all pages** button and allow ordinary page scans, live updates, same-site navigation, and saved collections to retain up to 5,000 media files on any website. Keep download batches capped at 1,500 and preserve existing byte limits and private-session separation.

## [1.21.9] - 2026-10-06

### Fixed

- Add **Scan all pages** on Fapello profiles to collect from their first page even when started on `page-2`, following localized pagination links within the same profile. Allow up to 200 pages and 5,000 saved Fapello items while retaining byte and time limits.
- Queue large selections in batches of 1,500, retain up to 5,000 queue tasks, and query download status in bounded batches so profiles larger than 1,500 items can be downloaded.

## [1.21.8] - 2026-09-27

### Fixed

- Follow Instagram's account timeline and reels pagination so profile scans include posts and reels that have not been loaded or scrolled into view.
- Verify every carousel slide has a downloadable source, resolve incomplete posts, and report incomplete account scans instead of declaring success.
- Keep partial-scan warnings visible during automatic updates.

## [1.21.7] - 2026-09-27

### Fixed

- Capture standalone Instagram profile photos and reels alongside carousels, including posts whose grid thumbnails have not loaded. Keep unresolved visible photos when individual post requests fail or reach the collection limit.

## [1.21.6] - 2026-09-23

### Changed

- Reuse live-page fingerprints until relevant DOM or viewport changes, avoiding repeated broad page queries between safety scans.
- Cache media search and filename-sort keys, and bound Instagram's fallback JSON and DOM traversal work.
- Keep upload progress rows in place, load history summaries from a compact index, and migrate existing upload jobs into separate storage records so each durable checkpoint writes only its own job. Reading source bytes updates progress without a storage write.
- Build validated source-upload Blobs from bounded response chunks without an extra full-size byte-array copy.

## [1.21.5] - 2026-09-22

### Fixed

- Expand Instagram profile carousel covers from each exact post when the profile feed supplies only a cover and slide count, preserving every exposed photo or direct video in the post.

## [1.21.4] - 2026-09-22

### Fixed

- Detect every purchased photo and video in loaded Telegram Stars posts while continuing to exclude locked previews.
- Read Instagram's current Relay profile timeline and `display_uri` covers so server-rendered posts are not lost when lazy grid images or legacy profile endpoints are unavailable.

## [1.21.3] - 2026-09-21

### Fixed

- Repair saved Telegram `document/` and pre-1.21.2 `stream/` URLs before previewing or downloading, restoring their video MIME type, filename, and required original-file marker.

## [1.21.2] - 2026-09-21

### Fixed

- Resolve Telegram Web K's largest photo variant from loaded message metadata instead of saving the chat preview.
- Recognize video documents before playback, preserving video MIME types, dimensions, duration, and filenames (including MP4).
- Load original Telegram photos and playable videos on demand in gallery and separate-tab previews, releasing preview bytes when closed.
- Build Telegram document streams with the required original-file `thumb_size` sentinel, fixing MP4 preview and download failures in the current Web K client.

## [1.21.1] - 2026-09-21

### Added

- Collect loaded Telegram Web chat photos and videos, including page-owned blobs and Web K progressive service-worker video URLs. Transfer complete files through the original tab into the Firefox download queue with byte validation, a 64 MiB per-file limit, and normal/private-window separation.
- Show photo thumbnails and Telegram loading guidance; clear media when switching chats and avoid restoring expired Telegram galleries.

### Fixed

- Make Telegram Blob range fixtures compatible with Node 22 used in release CI. Version 1.21.0 stopped at this test before publishing; production byte validation remains unchanged.

## [1.20.0] - 2026-09-19

### Added

- Added direct video uploads to Immich for selected page media and local files, supporting MP4, WebM, Ogg/OGV, MOV, M4V, and MKV within the existing 64 MiB per-file limit.

### Changed

- Kept **Upload selected** inside the Media workspace with a compact destination picker that refreshes current writable albums automatically and starts the embedded transfer after confirmation.
- Refined the upload picker with a clearer batch summary, grouped server and album fields, responsive actions, and cleaner status messaging.

## [1.19.2] - 2026-09-19

### Changed

- Renamed **Deselect matches** to **Deselect** and made it clear every selected image or video, including items hidden by the current search or filters.
- Removed **Find more media** from the media toolbar and rebalanced **Refresh media** and **Track page** across popup and Sidebar widths.

## [1.19.1] - 2026-09-19

### Changed

- Open **Upload selected** and upload history inside the current popup, manager, or Firefox Sidebar workspace instead of creating a separate browser tab.

## [1.19.0] - 2026-09-16

### Added

- Added **Refresh media** beside **Find more media** to clear the current website's remembered collection and scan the current page again, keeping downloaded files and history.

## [1.18.0] - 2026-09-12

### Changed

- Kept Media, Downloads, Trackers, Account, and Integrations in a persistent popup sidebar, with tracker editing inside the same workspace and media selections preserved between sections.
- Restored navigation and action icons, including at compact widths, and added the missing Integrations links on Downloads and Trackers.

## [1.17.1] - 2026-09-12

### Changed

- Placed **Account** and **Integrations** beside **Downloads** and **Trackers** in the main navigation.
- Moved media type and background-image options into **Filters**, removed the **Saved website**/**This page** switch and three-dot Collection settings menu, and made **Track page** open its own settings panel.
- Renamed **Collect gallery** to **Find more media** with a visible explanation of automatic scrolling and the ten-page search limit. Website collections remain saved; their clear action is in **Filters**.
- Removed the separate resizable window. **Find more media** and context-menu **Open media list…** actions now use a browser tab; Firefox Sidebar remains available from Firefox's sidebar menu.

## [1.17.0] - 2026-09-12

### Changed

- Surfaced **Track page**, **Account**, and **Integrations** as direct manager buttons. Renamed the Cloud sync navigation entry to **Account**.
- Redesigned Connections and Uploads with consistent navigation, clearer setup, a dedicated image picker, readable transfer results and history, and responsive light/dark layouts.

### Fixed

- Deployed the missing Immich connection backend to the shared service on 2026-09-12, resolving the missing endpoint behind **Could not load connections**. Narrowed Vault permission revocation to its public API so the migration works with hosted Supabase permissions. Available to existing 1.16.0 installations without an extension update.

## [1.16.0] - 2026-09-12

### Added

- Immich connections with account-owned encrypted API keys, direct Firefox uploads to HTTP(S) LAN/Tailscale servers, writable album selection, and a visible upload tab with separate upload/album results and explicit retries. Includes Supabase Vault migration, authenticated credential operations, and setup instructions.
- In-gallery image and direct-video previews with Previous/Next, arrow-key navigation, Escape, selection, download, and optional full-tab preview. Standalone previews can return to their source and survive reload within the existing five-minute expiry.
- **This page** and **Saved website** views, 350-item pagination, filename/resolution sorting, and minimum-width, minimum-height, and orientation filters. Unknown sizes are excluded while a size or orientation filter is active.
- Tracker review selection, **Download selected**/**Dismiss selected**, a tracker filter, visible destinations, partial-failure feedback, and an **Edit tracker** shortcut to the existing settings editor.
- Downloads search by filename or source website, file-level status filtering within mixed-result batches, and **Retry failed images** in Archive Progress.

### Changed

- Search and media filters now change visibility without clearing selections. The clickable selected count reveals the whole batch, hidden selections are called out, and **Select matches only** explicitly replaces the selection with matching media across collection pages.
- A more compact popup header and footer leave room for media while keeping destination and validation warnings readable. Infrequent collection actions live in Collection settings, and touch controls have larger targets.
- **Clear website collection** names its scope and offers Undo until the source context changes or the manager closes. **Clear completed details** in Downloads explains that downloaded files and summaries remain.

### Fixed

- The gallery, Downloads, and Tracking retain keyboard focus through live updates. Dashboard updates announce concise status summaries instead of rebuilding whole-list announcements.
- Open gallery previews follow refreshed media URLs and close cleanly when their media is removed.
- Archive Progress explains that its tab must remain open and opens workspace navigation separately while a ZIP is running; failed-image retries keep previously saved parts.

### Deployment note

- At publication, the Supabase Vault migration and `external-integrations` Edge Function were not deployed to the shared service. Both were deployed later on 2026-09-12; see the current [deployment and verification status](supabase/INTEGRATIONS.md). Live Immich uploads remain unverified.

## [1.15.0] - 2026-09-12

### Changed

- Redesigned Cloud sync with a responsive account dashboard, readable consent and data-sharing summary, second-device setup instructions, live sync and permission states, and last-success feedback.
- Automatic sync checks other devices every minute, catches up on startup and reconnection, and still batches local edits within seconds. Added a persistent per-device pause/resume switch with immediate catch-up on resume; manual sync remains available while paused. Signed-out devices no longer schedule sync alarms.

## [1.14.1] - 2026-09-12

### Fixed

- All installations now use AnyDownload's shared Supabase service automatically. Cloud sync needs only consent and Google sign-in; users no longer enter a project URL or public key. Existing shared-project sessions stay connected. Old custom-project sessions stop before reconnecting, preserving local data.

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
