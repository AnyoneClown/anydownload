# Changelog

All notable changes to AnyDownload are documented here.

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
