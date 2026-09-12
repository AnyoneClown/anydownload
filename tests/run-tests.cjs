"use strict";

const assert = require("assert").strict;
const fs = require("fs");
const path = require("path");
const Core = require("../extension/shared/core.js");

const root = path.resolve(__dirname, "../extension");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

function assertLocalResource(basePath, resourcePath, label) {
  assert.ok(
    typeof resourcePath === "string" && resourcePath.length > 0,
    `${label} must name a local resource`
  );
  assert.ok(!/^(?:[a-z]+:|\/\/|#)/i.test(resourcePath), `${label} must be local: ${resourcePath}`);
  const absoluteResourcePath = path.resolve(basePath, resourcePath);
  assert.ok(
    absoluteResourcePath.startsWith(`${root}${path.sep}`) && fs.existsSync(absoluteResourcePath),
    `${label} is missing: ${resourcePath}`
  );
  return absoluteResourcePath;
}

assert.equal(
  manifest.action && manifest.action.default_popup,
  "popup/popup.html",
  "The toolbar action must open the compact popup"
);
const popupRelativePath = manifest.action.default_popup;
const popupPath = assertLocalResource(root, popupRelativePath, "Manifest popup");
assert.equal(manifest.sidebar_action && manifest.sidebar_action.default_title, "AnyDownload media");
assert.equal(manifest.sidebar_action && manifest.sidebar_action.default_panel, "sidebar/sidebar.html");
assert.equal(manifest.sidebar_action && manifest.sidebar_action.open_at_install, false);
const sidebarPath = assertLocalResource(
  root,
  manifest.sidebar_action.default_panel,
  "Manifest sidebar panel"
);
for (const [size, iconPath] of Object.entries(manifest.sidebar_action.default_icon || {})) {
  assertLocalResource(root, iconPath, `Sidebar ${size}px icon`);
}
const popupCss = fs.readFileSync(path.join(root, "popup/popup.css"), "utf8");
const popupHtml = fs.readFileSync(popupPath, "utf8");
const popupJs = fs.readFileSync(path.join(root, "popup/popup.js"), "utf8");
const backgroundJs = fs.readFileSync(path.join(root, "background.js"), "utf8");
const archiveJs = fs.readFileSync(path.join(root, "shared/archive.js"), "utf8");
const archivePagePath = path.join(root, "archive/archive.html");
const archivePageHtml = fs.readFileSync(archivePagePath, "utf8");
const archivePageJs = fs.readFileSync(path.join(root, "archive/archive.js"), "utf8");
const archivePageCss = fs.readFileSync(path.join(root, "archive/archive.css"), "utf8");
const previewHtml = fs.readFileSync(path.join(root, "preview/preview.html"), "utf8");
const previewJs = fs.readFileSync(path.join(root, "preview/preview.js"), "utf8");
const sidebarHtml = fs.readFileSync(sidebarPath, "utf8");
const sidebarJs = fs.readFileSync(path.join(root, "sidebar/sidebar.js"), "utf8");
const historyPath = path.join(root, "history/history.html");
const historyHtml = fs.readFileSync(historyPath, "utf8");
const historyCss = fs.readFileSync(path.join(root, "history/history.css"), "utf8");
const historyJs = fs.readFileSync(path.join(root, "history/history.js"), "utf8");
const trackingPath = path.join(root, "tracking/tracking.html");
const trackingHtml = fs.readFileSync(trackingPath, "utf8");
const trackingCss = fs.readFileSync(path.join(root, "tracking/tracking.css"), "utf8");
const trackingJs = fs.readFileSync(path.join(root, "tracking/tracking.js"), "utf8");

assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.name, "AnyDownload — Page Media Downloader");
assert.equal(manifest.version, "1.18.0");
assert.equal(manifest.action.default_title, "Download page media");
assert.equal(Core.MAX_BATCH_TOTAL_URL_LENGTH, 2000000);
assert.deepEqual(manifest.permissions.sort(), ["activeTab", "alarms", "downloads", "menus", "notifications", "scripting", "storage"]);
assert.deepEqual(manifest.optional_host_permissions, ["<all_urls>"]);
assert.deepEqual(
  manifest.background.scripts,
  [
    "shared/core.js",
    "shared/collector.js",
    "shared/fapfolder.js",
    "shared/instagram.js",
    "shared/youtube.js",
    "shared/archive.js",
    "shared/filters.js",
    "shared/templates.js",
    "shared/tracker.js",
    "shared/download-ledger.js",
    "shared/gallery.js",
    "shared/download-queue.js",
    "shared/cloud-sync.js",
    "shared/integrations.js",
    "shared/cloud-sync-runtime.js",
    "background.js"
  ]
);
assert.match(manifest.content_security_policy.extension_pages, /connect-src http: https: data: blob:/);
assert.match(
  manifest.content_security_policy.extension_pages,
  /media-src 'self' http: https: data: blob:/,
  "Extension pages must be allowed to preview direct HTTP, data, and blob video sources"
);
assert.deepEqual(
  manifest.browser_specific_settings.gecko.data_collection_permissions.required,
  ["none"]
);
assert.equal(manifest.browser_specific_settings.gecko_android.strict_min_version, "142.0");
assert.deepEqual(manifest.browser_specific_settings.gecko.data_collection_permissions.optional,
  ["authenticationInfo", "personallyIdentifyingInfo", "browsingActivity", "websiteActivity", "websiteContent"]);
assert.match(popupHtml, /^<!doctype html>/i, "Popup must use standards mode for reliable Firefox sizing");
const popupScriptSources = Array.from(
  popupHtml.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*><\/script>/gi),
  (match) => match[1]
);
assert.deepEqual(
  popupScriptSources,
  [
    "../shared/core.js",
    "../shared/collector.js",
    "../shared/fapfolder.js",
    "../shared/instagram.js",
    "../shared/youtube.js",
    "../shared/filters.js",
    "../shared/templates.js",
    "../shared/tracker.js",
    "../shared/download-ledger.js",
    "../shared/gallery.js",
    "popup.js"
  ],
  "Popup scripts must load in dependency order"
);
assert.doesNotMatch(popupHtml, /shared\/duplicates\.js/);
const popupResourcePaths = [
  ...popupScriptSources,
  ...Array.from(
    popupHtml.matchAll(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi),
    (match) => match[1]
  )
];
for (const resourcePath of popupResourcePaths) {
  assertLocalResource(path.dirname(popupPath), resourcePath, "Popup resource");
}
assert.match(popupCss, /html,\s*body\s*\{[^}]*width:\s*780px;[^}]*height:\s*600px;[^}]*min-width:\s*0;[^}]*min-height:\s*0;/s);
assert.doesNotMatch(popupCss, /html,\s*body\s*\{[^}]*max-(?:width|height):/s);
assert.match(popupCss, /\.app-shell\s*\{[^}]*height:\s*600px;[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/s);
assert.match(popupCss, /\.media-workspace\s*\{[^}]*grid-template-rows:\s*auto auto auto minmax\(0,\s*1fr\) auto auto;/s);
assert.match(
  popupCss,
  /\.media-workspace\s*\{[^}]*grid-template-areas:\s*"controls"\s*"notice"\s*"undo"\s*"media"\s*"pagination"\s*"actions";/s,
  "Hidden notices must not shift the footer into the flexible media row during scanning"
);
for (const [selector, area] of [
  ["app-header", "header"],
  ["controls", "controls"],
  ["notice", "notice"],
  ["image-list", "media"],
  ["action-bar", "actions"]
]) {
  assert.match(
    popupCss,
    new RegExp(`\\.${selector}\\s*\\{[^}]*grid-area:\\s*${area};`, "s"),
    `${selector} must remain pinned to the ${area} grid area`
  );
}
assert.match(popupCss, /\.app-shell\s*\{[^}]*grid-template-columns:\s*156px minmax\(0,\s*1fr\);/s);
assert.match(popupCss, /\.app-shell\s*\{[^}]*grid-template-areas:\s*"header workspace";/s);
assert.match(popupCss, /\.app-shell\s*>\s*\*\s*\{[^}]*min-width:\s*0;/s);
assert.match(popupCss, /html\.responsive-surface,\s*html\.responsive-surface body\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;/s);
assert.match(popupCss, /html\.responsive-surface \.app-shell\s*\{[^}]*height:\s*100dvh;/s);
assert.match(popupCss, /\.image-list\s*\{[^}]*overflow-x:\s*hidden;/s);
assert.match(popupCss, /\.action-bar\s*\{[^}]*min-width:\s*0;/s);
for (const panel of ["download-settings-panel", "tracker-panel", "smart-filter-panel"]) {
  assert.match(popupHtml, new RegExp(`id="${panel}"[^>]*popover`));
  assert.match(popupHtml, new RegExp(`popovertarget="${panel}"`));
}
assert.match(popupHtml, /id="grid-view-button"[^>]*aria-pressed="true"/);
assert.match(popupHtml, /id="list-view-button"[^>]*aria-pressed="false"/);
assert.match(popupHtml, /id="folder-help"[^>]*role="status"[^>]*aria-live="polite"[^>]*hidden/);
assert.match(popupHtml, /class="folder-toolbar"/);
assert.match(popupHtml, /class="folder-options"/);
assert.match(popupHtml, /id="history-button"[^>]*title="Download queue and statistics"/);
assert.match(popupHtml, /id="queue-badge"[^>]*hidden/);
assert.match(popupHtml, /id="tracking-dashboard-button"[^>]*title="Background trackers"/);
const popupWorkspaceNav = popupHtml.match(/<nav\b[^>]*class="workspace-nav"[^>]*>([\s\S]*?)<\/nav>/)?.[1] || "";
for (const controlId of ["history-button", "tracking-dashboard-button", "sync-button", "integrations-button"]) {
  assert.match(popupWorkspaceNav, new RegExp(`id="${controlId}"[^>]*class="nav-link"`), `${controlId} must be in the main navigation`);
}
assert.match(popupHtml, /<iframe\b[^>]*id="workspace-frame"[^>]*title="[^"]+"[^>]*hidden/);
assert.match(trackingHtml, /data-source-link href="\.\.\/integrations\/integrations\.html"/,
  "The standalone Trackers dashboard must also offer Integrations");
for (const controlId of ["media-button", "history-button", "tracking-dashboard-button", "sync-button", "integrations-button"]) {
  const button = popupWorkspaceNav.match(new RegExp(`<button\\b[^>]*id="${controlId}"[^>]*>[\\s\\S]*?</button>`))?.[0] || "";
  assert.match(button, /<svg[^>]*aria-hidden="true"/,
    `${controlId} must keep its navigation icon`);
}
assert.match(popupHtml, /id="filename-template-button"[^>]*aria-controls="filename-template-panel"/);
assert.match(popupHtml, /id="filename-template-input"[^>]*value="\{index\}-\{filename\}"[^>]*maxlength="240"/);
assert.match(popupHtml, /id="filename-template-help"[^>]*>[^<]*\{hostname\}[^<]*\{page-title\}[^<]*\{date\}/);
assert.match(popupHtml, /zero-padded \{index\} follows selected page order/);
for (const removedControlId of [
  "deduplicate-button",
  "duplicate-panel",
  "duplicates-button",
  "hide-duplicates-input",
  "live-capture-button",
  "rescan-button",
  "open-window-button",
  "sidebar-button",
  "collection-scope-select",
  "gallery-pages-select",
  "page-tools-panel"
]) {
  assert.doesNotMatch(
    popupHtml,
    new RegExp(`id=["']${removedControlId}["']`),
    `${removedControlId} must not remain in the popup`
  );
}
assert.match(popupHtml, />Save As for one file<\/span>/);
assert.match(popupHtml, /id="backgrounds-input"[^>]*type="checkbox"/);
assert.match(popupHtml, /id="ignored-button"[^>]*aria-pressed="false"/);
assert.match(popupHtml, /id="clear-ignored-button"/);
assert.match(popupHtml, /id="downloaded-button"[^>]*aria-pressed="false"/);
assert.match(popupHtml, /src="\.\.\/shared\/collector\.js"/);
assert.match(popupHtml, /src="\.\.\/shared\/youtube\.js"/);
assert.match(popupHtml, /src="\.\.\/shared\/filters\.js"/);
assert.match(popupHtml, /id="archive-footer-button"[^>]*disabled>Download ZIP<\/button>/);
assert.match(popupHtml, /id="download-button"[^>]*disabled>Download selected<\/button>/);
for (const removedTopActionId of ["bulk-download-button", "archive-download-button"]) {
  assert.doesNotMatch(
    popupHtml,
    new RegExp(`id=["']${removedTopActionId}["']`),
    `${removedTopActionId} must not duplicate the footer download actions`
  );
  assert.doesNotMatch(
    popupJs,
    new RegExp(`elements\\["${removedTopActionId}"\\]`),
    `${removedTopActionId} must not remain wired in popup.js`
  );
}
assert.doesNotMatch(popupCss, /\.bulk-download-button\b/);
assert.doesNotMatch(popupCss, /\.archive-download-button\b/);
assert.match(popupHtml, /id="sidebar-follow-button"[^>]*hidden>Enable auto-follow<\/button>/);
assert.match(popupHtml, /id="instagram-collections-button"[^>]*hidden>Stories &amp; highlights<\/button>/);
assert.match(popupHtml, /id="instagram-collection-filter-select"/);
for (const collectionFilter of ["all", "posts", "story", "highlights"]) {
  assert.match(
    popupHtml,
    new RegExp(`<option value=["']${collectionFilter}["']`),
    `Missing Instagram collection filter: ${collectionFilter}`
  );
}
assert.match(popupHtml, /id="smart-filter-panel"[^>]*popover/);
assert.match(popupHtml, /id="smart-filters-button"[^>]*aria-expanded="false"[^>]*aria-controls="smart-filter-panel"/);
assert.match(popupHtml, /id="tracker-button"[^>]*aria-controls="tracker-panel"[^>]*disabled/);
assert.match(popupHtml, /id="tracker-panel"[^>]*popover/);
assert.match(popupHtml, /id="tracker-download-initial-input"[^>]*type="checkbox"/);
for (const trackerAction of ["review", "notify", "download"]) {
  assert.match(popupHtml, new RegExp(`<option value=["']${trackerAction}["']`));
}
for (const trackerControlId of [
  "tracker-action-select",
  "tracker-include-text-input",
  "tracker-exclude-text-input",
  "tracker-include-patterns-input",
  "tracker-exclude-patterns-input",
  "tracker-max-downloads-select",
  "tracker-pagination-mode-select",
  "tracker-max-pages-select",
  "tracker-next-selector-input",
  "tracker-url-template-input",
  "tracker-notify-matches-input",
  "tracker-notify-errors-input"
]) {
  assert.match(popupHtml, new RegExp(`id=["']${trackerControlId}["']`));
}
assert.match(popupHtml, /AJAX “More” requests are not replayed yet/);
assert.equal(
  (popupHtml.match(/id=["']photos-only-input["']/g) || []).length,
  1,
  "Photos only must be exposed exactly once"
);
assert.match(
  popupHtml,
  /<div id="smart-filter-panel"[^>]*popover[^>]*>[\s\S]*?<input id="photos-only-input"[^>]*type="checkbox"[\s\S]*?<\/div>/,
  "Photos only must live inside the Filters popover"
);
const popupFilters = popupHtml.slice(popupHtml.indexOf('<div id="smart-filter-panel"'), popupHtml.indexOf('<div class="summary-row"'));
for (const controlId of ["media-type-filter-select", "backgrounds-input", "clear-gallery-button"]) {
  assert.match(popupFilters, new RegExp(`id="${controlId}"`), `${controlId} must live in Filters`);
}
assert.match(popupHtml, /id="collect-gallery-button"[^>]*aria-describedby="scan-help"[^>]*>Find more media<\/button>/);
assert.match(popupHtml, /id="scan-help"[^>]*>Scrolls this page and checks linked pages \(up to 10\)\./);
assert.doesNotMatch(popupHtml, /Collection settings|Saved website|>This page<|>Collect gallery</);
assert.match(popupHtml, /id="media-type-filter-select"/);
for (const format of ["mp4", "webm", "ogv", "mov", "m4v", "mkv"]) {
  assert.match(popupHtml, new RegExp(`<option value=["']${format}["']`));
}
assert.match(popupHtml, /id="format-filter-select"/);
assert.match(popupHtml, /id="reset-filters-button"/);
for (const id of ["min-width-input", "min-height-input", "orientation-filter-select", "sort-select"]) {
  assert.ok(popupHtml.includes(`id="${id}"`), `${id} must be available in the Filters panel`);
}
assert.match(popupJs, /browser\.tabs\.create\(createProperties\)/);
assert.match(popupJs, /browser\.storage\.session\.set\(\{ \[key\]: payload \}\)/);
assert.doesNotMatch(popupJs, /areaName\s*=\s*"local"/);
assert.match(popupJs, /ignoredImage:/);
assert.match(popupJs, /browser\.storage\.onChanged\.addListener\(handleIgnoredStorageChanges\)/);
assert.match(popupJs, /MAX_IGNORED_RULES\s*=\s*5000/);
assert.match(popupJs, /image\.previewUrl \|\| image\.url/);
assert.match(popupJs, /MAX_DIMENSION_PROBE_CONCURRENCY\s*=\s*3/);
assert.match(popupJs, /probeFullImageDimensions/);
assert.match(popupJs, /probe\.naturalWidth/);
assert.match(popupJs, /checking full size/);
assert.match(popupJs, /full size unavailable/);
assert.match(popupJs, /renderedMetaNodes/);
assert.match(popupJs, /dimensionProbeScheduler\.cancelQueued/);
assert.match(popupJs, /isPaused:\s*\(\)\s*=>\s*state\.busy/);
assert.match(popupJs, /rootMargin:\s*"0px"/);
assert.match(popupJs, /sourceTabIdFromUrl/);
assert.match(popupJs, /launchOptionsFromUrl/);
assert.match(popupJs, /sidebar:\s*params\.get\("sidebar"\) === "1"/);
assert.doesNotMatch(popupJs, /params\.get\("live"\)/);
assert.match(popupJs, /const sidebarMode = launchOptions\.sidebar/);
assert.match(popupJs, /const responsiveSurface = managerTabMode \|\| sidebarMode/);
assert.match(popupJs, /initialize\(\)\.catch\(handleInitializationError\)/);
assert.match(popupJs, /AnyDownload popup initialization failed/);
assert.match(popupJs, /elements\["folder-help"\]\.hidden = false/);
assert.match(popupJs, /elements\["folder-help"\]\.hidden = true/);
assert.match(popupJs, /setAttribute\("aria-invalid", "true"\)/);
assert.match(popupJs, /browser\.tabs\.get\(state\.sourceTabId\)/);
assert.doesNotMatch(popupJs, /manager-window|managerWindowMode|openManagerWindow|openFirefoxSidebar/);
assert.match(popupJs, /classList\.add\("sidebar-panel"\)/);
assert.match(popupJs, /classList\.add\("responsive-surface"\)/);
assert.match(popupJs, /type:\s*"OPEN_MANAGER_TAB"/);
assert.match(popupJs, /sourceTabId:\s*state\.sourceTabId/);
assert.match(popupJs, /browser\.tabs\.onActivated\.addListener/);
assert.match(popupJs, /browser\.tabs\.onUpdated\.addListener/);
assert.match(popupJs, /else if \(changeInfo\.url\)/);
assert.match(popupJs, /if \(!value\) \{[\s\S]*?return true;/);
assert.match(popupJs, /browser\.permissions\.request\(SIDEBAR_ALL_URLS_PERMISSION\)/);
assert.match(popupJs, /state\.sidebarPermissionNeeded = !state\.sidebarHasBroadAccess/);
for (const removedElementId of [
  "deduplicate-button",
  "duplicate-panel",
  "duplicates-button",
  "hide-duplicates-input",
  "live-capture-button",
  "rescan-button",
  "open-window-button",
  "sidebar-button",
  "collection-scope-select",
  "gallery-pages-select",
  "page-tools-panel"
]) {
  assert.doesNotMatch(
    popupJs,
    new RegExp(`elements\\["${removedElementId}"\\]`),
    `${removedElementId} must not remain wired in popup.js`
  );
}
assert.match(popupJs, /Filters\.matchesSmartFilters/);
assert.match(popupJs, /Filters\.hasActiveSmartFilters/);
assert.match(popupJs, /smartFilters:\s*Filters\.normalizeFilters\(\)/);
assert.match(popupJs, /Templates\.validate\(elements\["filename-template-input"\]\.value\)/);
assert.match(popupJs, /Templates\.render\(/);
assert.match(
  popupJs,
  /module\.exports\s*=\s*\{[\s\S]*matchesInstagramCollectionFilter,[\s\S]*mergeInstagramCollections,/
);
assert.match(popupJs, /type:\s*"GET_DOWNLOAD_DASHBOARD"/);
assert.match(popupJs, /summaryOnly:\s*true/);
assert.match(popupJs, /elements\["archive-footer-button"\]\.addEventListener\("click", downloadSelectedArchive\)/);
assert.match(popupJs, /elements\["download-button"\]\.addEventListener\("click", downloadSelectedImages\)/);
assert.match(popupJs, /function hostPermissionPatternsForImages\(images\)/);
assert.match(popupJs, /browser\.permissions\.request\(\{ origins \}\)/);
assert.match(popupJs, /type:\s*"GET_MEDIA_DOWNLOAD_STATUS"/);
assert.match(popupJs, /downloadStatusFor/);
assert.match(popupJs, /explicitRedownloads/);
assert.match(popupJs, /type:\s*"UPSERT_TRACKER"/);
assert.match(popupJs, /type:\s*"RUN_TRACKER"/);
assert.match(popupJs, /type:\s*"SET_TRACKER_ENABLED"/);
assert.match(popupJs, /type:\s*"DELETE_TRACKER"/);
assert.match(popupJs, /browser\.permissions\.request\(\{ origins:\s*\[pattern\] \}\)/);
assert.match(popupJs, /maxDownloadsPerRun:/);
assert.match(popupJs, /urlTemplate:/);
assert.match(popupJs, /newMatches:/);
assert.doesNotMatch(
  popupJs,
  /type:\s*"DOWNLOAD_ARCHIVE"/,
  "ZIP jobs must not depend on one long-lived runtime message to the event background"
);
assert.match(popupJs, /`archiveJobRequest:\$\{jobId\}`/);
assert.match(popupJs, /archive\/archive\.html\?job=\$\{encodeURIComponent\(jobId\)\}/);
assert.match(popupJs, /await browser\.storage\.session\.set\(\{/);
assert.match(popupJs, /await browser\.tabs\.create\(createProperties\)/);
assert.match(popupJs, /const downloadItems = renderedDownloadItems\(images, template\.value\)/);
assert.match(popupJs, /items:\s*downloadItems/);
assert.match(popupJs, /const archiveItems = renderedDownloadItems\(images, templateValue\)/);
assert.match(popupJs, /items:\s*archiveItems/);
assert.match(popupJs, /collectLiveGalleryFingerprint/);
assert.match(popupJs, /const FapFolder = globalThis\.AnyDownloadFapFolder/);
assert.match(popupJs, /const collectFapFolderMediaFromPage = globalThis\.AnyDownloadFapFolderCollector/);
assert.match(popupJs, /FapFolder\.isSupportedUrl\(tab\.url\)/);
assert.match(popupJs, /func:\s*collectFapFolderMediaFromPage/);
assert.match(popupJs, /maxPosts:\s*64/);
assert.match(popupJs, /fapFolderCollectionSucceeded/);
assert.match(popupJs, /collectInstagramMediaFromPage/);
assert.match(popupJs, /world:\s*"MAIN",\s*func:\s*collectInstagramMediaFromPage/);
assert.match(popupJs, /includeProfilePosts:\s*!settings\.instagramCollections/);
assert.match(popupJs, /includeStories:\s*Boolean\(settings\.instagramCollections\)/);
assert.match(popupJs, /includeHighlights:\s*Boolean\(settings\.instagramCollections\)/);
assert.match(popupJs, /Instagram\.canCollectRelated\(state\.pageUrl\)/);
assert.match(popupJs, /Instagram\.routeKeyForUrl\(tab\.url\)/);
assert.match(
  popupJs,
  /if \(instagramRouteKey && !settings\.instagramCollections && !injectionResults\)\s*\{[\s\S]*handled:\s*true,[\s\S]*images:\s*\[\]/
);
assert.match(popupJs, /Instagram stories and highlights could not be collected; the existing results were kept/);
assert.match(popupJs, /scanPage\(\{ instagramCollections: true, preserveSelection: true \}\)/);
assert.match(
  popupJs,
  /const scanned = await scanPage\(\);\s*refreshQueueBadge\(\);\s*startQueueBadgePolling\(\);\s*if \(scanned\)\s*\{\s*await startLiveCapture\(\{ skipInitialScan: true, quiet: true \}\);/
);
assert.match(
  popupJs,
  /const scanned = await scanPage\(\{[\s\S]*sidebarFollow:\s*true,[\s\S]*\}\);\s*if \(scanned && request\.generation === sidebarFollowGeneration\)\s*\{\s*await startLiveCapture\(\{ skipInitialScan: true, quiet: true \}\);/
);
assert.match(popupJs, /const YouTube = globalThis\.AnyDownloadYouTube/);
assert.match(popupJs, /const collectYouTubeMediaFromPage = globalThis\.AnyDownloadYouTubeCollector/);
assert.match(popupJs, /YouTube\.isYouTubeUrl\(tab\.url\)/);
assert.match(popupJs, /func:\s*collectYouTubeMediaFromPage/);
assert.match(popupJs, /includeVideoOnly:\s*false/);
assert.match(popupJs, /youtubeCollectionSucceeded/);
assert.match(popupJs, /scanPage\(\{[\s\S]*preserveSelection:\s*true,[\s\S]*live:\s*true[\s\S]*\}\)/);
assert.match(
  popupJs,
  /const fingerprint = await liveFingerprintForSource\(\);[\s\S]*if \(state\.busy\) \{\s*scheduleLiveCapturePoll\(generation\);\s*return;/,
  "Automatic updates must defer rather than stop when another action becomes busy during a fingerprint request"
);
assert.match(
  popupJs,
  /Automatic live updates are temporarily unavailable and will retry/,
  "Transient watcher failures must retry now that there is no manual live control"
);
assert.match(
  popupJs,
  /canRetainSameInstagramRoute\([\s\S]*state\.pageUrl = nextUrl;[\s\S]*resetSidebarPageState\([\s\S]*gallery was saved/,
  "Source navigation must preserve same-post index changes and save the old site's gallery"
);
assert.match(
  popupJs,
  /const scanSourceGeneration = sourcePageGeneration;[\s\S]*scanSourceStillCurrent\(settings, scanSourceGeneration\)/,
  "In-flight scans must be invalidated when their source route changes"
);
assert.match(backgroundJs, /contexts:\s*\["image",\s*"video"\]/);
assert.match(backgroundJs, /const FapFolder = globalThis\.AnyDownloadFapFolder/);
assert.match(backgroundJs, /const collectFapFolderMediaFromPage = globalThis\.AnyDownloadFapFolderCollector/);
assert.match(backgroundJs, /FapFolder\.isSupportedUrl\(tab\.url\)/);
assert.match(backgroundJs, /func:\s*collectFapFolderMediaFromPage/);
assert.match(backgroundJs, /const Instagram = globalThis\.ImageDownloaderInstagram/);
assert.match(backgroundJs, /world:\s*"MAIN",\s*func:\s*collectInstagramMediaFromPage/);
assert.match(backgroundJs, /func:\s*collectInstagramMediaFromPage/);
assert.match(backgroundJs, /const YouTube = globalThis\.AnyDownloadYouTube/);
assert.match(backgroundJs, /const collectYouTubeMediaFromPage = globalThis\.AnyDownloadYouTubeCollector/);
assert.match(backgroundJs, /isYouTubeVideoPageUrl\(tab\.url\)/);
assert.match(backgroundJs, /func:\s*collectYouTubeMediaFromPage/);
assert.match(backgroundJs, /browser\.menus\.onClicked\.addListener/);
assert.match(backgroundJs, /targetElementId/);
assert.doesNotMatch(backgroundJs, /browser\.action\.onClicked\.addListener/);
assert.match(backgroundJs, /message\.type === "OPEN_MANAGER_TAB"/);
assert.match(backgroundJs, /const Tracker = globalThis\.AnyDownloadTracker/);
assert.match(backgroundJs, /const DownloadLedger = globalThis\.AnyDownloadLedger/);
assert.match(backgroundJs, /GET_MEDIA_DOWNLOAD_STATUS/);
assert.match(backgroundJs, /TRACKER_REVIEW_ACTION/);
assert.match(backgroundJs, /browser\.alarms\.onAlarm\.addListener/);
assert.match(backgroundJs, /credentials:\s*"include"/);
assert.match(backgroundJs, /Tracker\.extractMediaFromDocument/);
assert.match(backgroundJs, /Tracker\.extractNextPageUrl/);
assert.match(backgroundJs, /Tracker\.pageUrlFromTemplate/);
assert.match(backgroundJs, /Tracker\.matchesTrackerRules/);
assert.match(backgroundJs, /function trackerBackoffMinutes/);
assert.match(backgroundJs, /browser\.notifications\.create/);
assert.match(backgroundJs, /browser\.permissions\.onRemoved/);
assert.match(backgroundJs, /"UPSERT_TRACKER"/);
assert.match(backgroundJs, /"GET_TRACKERS"/);
assert.match(backgroundJs, /"SET_ALL_TRACKERS_ENABLED"/);
assert.match(backgroundJs, /browser\.tabs\.get\(message\.sourceTabId\)/);
assert.match(backgroundJs, /function managerTabUrl\(sourceTabId\)/);
assert.match(backgroundJs, /openManagerTab\(tab\)/);
assert.doesNotMatch(backgroundJs, /liveCapture|[?&]live=1/);
assert.doesNotMatch(backgroundJs, /browser\.windows|OPEN_MANAGER_WINDOW|managerWindowUrl|openResizableImageWindow/);
assert.match(backgroundJs, /sourceTabId/);
assert.doesNotMatch(backgroundJs, /browser\.action\.openPopup/);
assert.match(backgroundJs, /message\.type === "DOWNLOAD_ARCHIVE"/);
assert.match(backgroundJs, /Archive\.createStoredZip/);
assert.match(backgroundJs, /anydownload-errors\.txt/);
assert.match(backgroundJs, /MAX_ARCHIVE_ITEMS\s*=\s*2000/);
assert.match(backgroundJs, /MAX_ARCHIVE_ENTRY_BYTES\s*=\s*64 \* 1024 \* 1024/);
assert.match(backgroundJs, /MAX_ARCHIVE_TOTAL_BYTES\s*=\s*256 \* 1024 \* 1024/);
assert.match(backgroundJs, /MAX_ARCHIVE_FETCH_CONCURRENCY\s*=\s*2/);
assert.match(backgroundJs, /MAX_ARCHIVE_FETCH_TIMEOUT_MS\s*=\s*120000/);
assert.match(backgroundJs, /new AbortController\(\)/);
assert.match(backgroundJs, /Another ZIP archive is already being built/);
assert.match(backgroundJs, /terminal && terminal\.state === "interrupted"/);
assert.match(archiveJs, /function createStoredZip\(entries, options\)/);
assert.match(archiveJs, /function crc32\(value\)/);
assert.match(archivePageHtml, /^<!doctype html>/i);
assert.match(archivePageHtml, /id="job-progress"/);
assert.match(archivePageHtml, /id="cancel-button"/);
assert.match(archivePageHtml, /src="\.\.\/shared\/core\.js"/);
assert.match(archivePageHtml, /src="\.\.\/shared\/archive\.js"/);
assert.match(archivePageHtml, /src="archive\.js"/);
assert.match(archivePageJs, /MAX_ARCHIVE_ITEMS\s*=\s*2000/);
assert.match(archivePageJs, /MAX_ARCHIVE_PART_BYTES\s*=\s*64 \* 1024 \* 1024/);
assert.match(archivePageJs, /browserObject\.storage\.session\.remove\(storageKey\)/);
assert.match(archivePageJs, /waitForDownloadTerminal/);
assert.match(archivePageJs, /downloadsApi\.search\(\{ id: downloadId \}\)/);
assert.match(archivePageJs, /archivePartFilename/);
assert.match(archivePageCss, /@media\s*\(max-width:\s*480px\)/);
assert.match(previewHtml, /id="image-button"[^>]*aria-pressed="false"/);
assert.match(previewHtml, /<video id="preview-video"[^>]*controls[^>]*preload="metadata"[^>]*playsinline[^>]*hidden><\/video>/);
assert.match(previewJs, /browser\.storage\.session/);
assert.match(previewJs, /payload\.mediaType/);
assert.match(previewJs, /elements\.video\.src = urlResult\.value/);

assert.match(sidebarHtml, /^<!doctype html>/i, "Sidebar must use standards mode");
assert.match(sidebarHtml, /id="sidebar-status"[^>]*role="status"[^>]*aria-live="polite"/);
assert.match(sidebarHtml, /id="open-manager-link"[^>]*href="\.\.\/popup\/popup\.html\?sidebar=1"/);
const sidebarScriptSources = Array.from(
  sidebarHtml.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*><\/script>/gi),
  (match) => match[1]
);
assert.deepEqual(sidebarScriptSources, ["sidebar.js"]);
for (const resourcePath of sidebarScriptSources) {
  assertLocalResource(path.dirname(sidebarPath), resourcePath, "Sidebar resource");
}
assert.match(sidebarJs, /browser\.runtime\.getURL\("popup\/popup\.html\?sidebar=1"\)/);
assert.match(sidebarJs, /window\.location\.replace\(managerUrl\)/);

assert.match(historyHtml, /^<!doctype html>/i, "Download dashboard must use standards mode");
assert.match(historyHtml, /<title>AnyDownload — Downloads<\/title>/);
assert.match(historyHtml, /id="completed-stat"/);
assert.match(historyHtml, /id="bytes-stat"/);
assert.match(historyHtml, /id="success-stat"/);
assert.match(historyHtml, /id="queue-stat"/);
assert.match(historyHtml, /id="pause-all-button"/);
assert.match(historyHtml, /id="resume-all-button"/);
assert.match(historyHtml, /id="cancel-pending-button"/);
assert.match(historyHtml, /id="retry-failed-button"/);
assert.match(historyHtml, /id="clear-completed-button"/);
const historyScriptSources = Array.from(
  historyHtml.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*><\/script>/gi),
  (match) => match[1]
);
assert.deepEqual(historyScriptSources, ["../shared/navigation.js", "history.js"]);
const historyResourcePaths = [
  ...historyScriptSources,
  ...Array.from(
    historyHtml.matchAll(/<(?:link|img)\b[^>]*(?:href|src)=["']([^"']+)["'][^>]*>/gi),
    (match) => match[1]
  )
];
for (const resourcePath of historyResourcePaths) {
  assertLocalResource(path.dirname(historyPath), resourcePath, "Download dashboard resource");
}
assert.match(historyJs, /type:\s*"GET_DOWNLOAD_DASHBOARD"/);
assert.match(historyJs, /type:\s*"DOWNLOAD_QUEUE_ACTION"/);
assert.match(historyJs, /performDownloadsAction\(\s*"show",\s*\[task\.downloadId\]/s);
assert.match(historyJs, /performDownloadsAction\(\s*"showDefaultFolder"/s);
assert.match(historyCss, /\.stats-grid\s*\{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\);/s);
assert.match(historyCss, /@media\s*\(max-width:\s*800px\)/);
assert.match(historyHtml, /href="\.\.\/tracking\/tracking\.html"><svg\b[^>]*>[\s\S]*?<\/svg>Trackers<\/a>/);

assert.match(trackingHtml, /^<!doctype html>/i, "Tracking dashboard must use standards mode");
assert.match(trackingHtml, /<title>AnyDownload — Tracking<\/title>/);
assert.match(trackingHtml, /id="total-stat"/);
assert.match(trackingHtml, /id="active-stat"/);
assert.match(trackingHtml, /id="issues-stat"/);
assert.match(trackingHtml, /id="pending-stat"/);
assert.match(trackingHtml, /id="review-status"[^>]*role="status"/);
assert.match(trackingJs, /TRACKER_REVIEW_ACTION/);
assert.doesNotMatch(trackingHtml, /id="(?:tracker-list|review-list)"[^>]*aria-live/);
assert.match(trackingHtml, /id="pause-all-button"/);
assert.match(trackingHtml, /id="resume-all-button"/);
assert.match(trackingHtml, /href="\.\.\/history\/history\.html"><svg\b[^>]*>[\s\S]*?<\/svg>Downloads<\/a>/);
const trackingResourcePaths = [
  ...Array.from(
    trackingHtml.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*><\/script>/gi),
    (match) => match[1]
  ),
  ...Array.from(
    trackingHtml.matchAll(/<(?:link|img)\b[^>]*(?:href|src)=["']([^"']+)["'][^>]*>/gi),
    (match) => match[1]
  )
];
for (const resourcePath of trackingResourcePaths) {
  assertLocalResource(path.dirname(trackingPath), resourcePath, "Tracking dashboard resource");
}
assert.match(trackingJs, /type:\s*"GET_TRACKERS"/);
assert.match(trackingJs, /type:\s*"SET_ALL_TRACKERS_ENABLED"/);
assert.match(trackingJs, /"RUN_TRACKER"/);
assert.match(trackingJs, /"DELETE_TRACKER"/);
assert.match(trackingJs, /activity-list/);
assert.match(trackingJs, /Automatically paused/);
assert.doesNotMatch(trackingJs, /\.innerHTML\s*=/);
assert.match(trackingCss, /\.stats-grid\s*\{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\);/s);
assert.match(trackingCss, /\.activity-list\s*\{/);
assert.match(trackingCss, /@media\s*\(max-width:\s*560px\)/);

for (const relativePath of [
  "archive/archive.css",
  "archive/archive.html",
  "archive/archive.js",
  "background.js",
  "history/history.css",
  "history/history.html",
  "history/history.js",
  "icons/image-downloader.svg",
  "popup/popup.css",
  "popup/popup.html",
  "popup/popup.js",
  "preview/preview.css",
  "preview/preview.html",
  "preview/preview.js",
  "shared/filters.js",
  "shared/archive.js",
  "shared/collector.js",
  "shared/core.js",
  "shared/download-queue.js",
  "shared/fapfolder.js",
  "shared/tracker.js",
  "shared/templates.js",
  "shared/youtube.js",
  "sidebar/sidebar.html",
  "sidebar/sidebar.js",
  "tracking/tracking.css",
  "tracking/tracking.html",
  "tracking/tracking.js"
]) {
  assert.ok(fs.existsSync(path.join(root, relativePath)), `Missing ${relativePath}`);
}

assert.deepEqual(Core.validateFolderPath("Website images/example.com"), {
  ok: true,
  value: "Website images/example.com",
  changed: false
});
assert.equal(Core.validateFolderPath("../escape").ok, false);
assert.equal(Core.validateFolderPath("/Users/test/Pictures").ok, false);
assert.equal(Core.validateFolderPath("C:\\Pictures").ok, false);
assert.equal(Core.validateFolderPath("Pictures/CON").value, "Pictures/_CON");
assert.equal(Core.validateFolderPath("Pictures\\Summer").value, "Pictures/Summer");

assert.equal(
  Core.filenameForImage("https://example.com/assets/my%20photo.webp?width=900", 0),
  "my photo.webp"
);
assert.equal(
  Core.filenameForImage("https://example.com/render?id=42&format=avif", 1),
  "render.avif"
);
assert.equal(Core.filenameForImage("data:image/png;base64,AA==", 2), "image-0003.png");
assert.equal(Core.filenameForImage("https://example.com/payload.exe", 3), "payload_exe");
assert.equal(
  Core.filenameForMedia("https://example.com/clips/trailer.MP4?token=abc", 0, "video"),
  "trailer.MP4"
);
assert.equal(
  Core.filenameForMedia("https://example.com/render?format=video/webm", 1, "video"),
  "render.webm"
);
assert.equal(Core.filenameForMedia("data:video/mp4;base64,AA==", 2, "video"), "video-0003.mp4");
assert.equal(Core.filenameForMedia("https://example.com/payload.exe", 3, "video"), "payload_exe");
assert.equal(Core.sanitizeFilename("../CON?.jpg", "image"), "_CON_.jpg");
const longWebpName = `${"a".repeat(96)}.webp`;
const preservedLongWebp = Core.filenameForImage(
  `https://example.com/${longWebpName}`,
  0
);
assert.ok(preservedLongWebp.length <= 100);
assert.match(preservedLongWebp, /\.webp$/, "Long source names must retain their image extension");
const surrogateBoundaryName = Core.sanitizeFilename(
  `${"a".repeat(95)}😀${"b".repeat(20)}.jpg`,
  "image.jpg"
);
assert.ok(surrogateBoundaryName.length <= 100);
assert.match(surrogateBoundaryName, /\.jpg$/);
assert.doesNotMatch(
  surrogateBoundaryName,
  /[\ud800-\udfff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/,
  "Filename truncation must not leave an unpaired UTF-16 surrogate"
);

const used = new Set();
assert.equal(Core.uniquifyFilename("photo.jpg", used), "photo.jpg");
assert.equal(Core.uniquifyFilename("photo.jpg", used), "photo-2.jpg");
assert.equal(Core.uniquifyFilename("PHOTO.JPG", used), "PHOTO-3.JPG");

assert.equal(Core.validateDownloadUrl("javascript:alert(1)").ok, false);
assert.equal(Core.validateDownloadUrl("data:text/html,hello").ok, false);
assert.equal(Core.validateDownloadUrl("data:image/png;base64,AA==").ok, true);
assert.equal(Core.validateMediaUrl("data:video/mp4;base64,AA==").ok, true);
assert.equal(Core.validateMediaUrl("data:application/mp4;base64,AA==").ok, false);
assert.equal(
  Core.validateMediaUrl("https://media.example/video.mp4?token=abc#preview").value,
  "https://media.example/video.mp4?token=abc"
);
assert.equal(Core.validateDownloadUrl("blob:https://example.com/id").ok, false);
assert.equal(Core.buildDownloadPath("Site/image", "photo.jpg"), "Site/image/photo.jpg");

assert.equal(Core.siteKeyForUrl("https://example.com/gallery?page=2"), "https://example.com");
assert.equal(Core.siteKeyForUrl("http://example.com:8080/path"), "http://example.com:8080");
assert.equal(Core.siteKeyForUrl("file:///tmp/image.html"), "");
assert.equal(Core.ignoreKeyForUrl("not a URL"), "");
assert.notEqual(
  Core.ignoreKeyForUrl("https://cdn.example/logo.png?v=1#top"),
  Core.ignoreKeyForUrl("https://cdn.example/logo.png?v=2")
);
assert.equal(
  Core.ignoreKeyForUrl("https://cdn.example/logo.png?v=1#top"),
  Core.ignoreKeyForUrl("https://cdn.example/logo.png?v=1#other")
);
assert.notEqual(
  Core.ignoreKeyForUrl("https://cdn.example/logo.png?v=1"),
  Core.ignoreKeyForUrl("https://cdn.example/header.png?v=1")
);
const dataIgnoreKey = Core.ignoreKeyForUrl("data:image/png;base64,AA==");
assert.match(Core.ignoreKeyForUrl("https://cdn.example/logo.png?v=1"), /^url:\d+:[a-f0-9]{16}$/);
assert.match(dataIgnoreKey, /^data:\d+:[a-f0-9]{16}$/);
assert.equal(dataIgnoreKey, Core.ignoreKeyForUrl("data:image/png;base64,AA=="));
assert.match(Core.ignoreKeyForUrl("data:IMAGE/PNG;base64,AA=="), /^data:\d+:[a-f0-9]{16}$/);

for (const relativePath of [
  "background.js",
  "archive/archive.js",
  "history/history.js",
  "popup/popup.js",
  "preview/preview.js",
  "shared/collector.js",
  "shared/core.js",
  "shared/download-queue.js",
  "shared/filters.js",
  "shared/archive.js",
  "shared/templates.js",
  "shared/tracker.js",
  "sidebar/sidebar.js",
  "tracking/tracking.js"
]) {
  const source = fs.readFileSync(path.join(root, relativePath), "utf8");
  assert.doesNotThrow(() => new Function(source), `${relativePath} has a syntax error`);
}

console.log("All extension checks passed.");
