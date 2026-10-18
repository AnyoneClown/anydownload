(function attachTrackingDashboard(root, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
    return;
  }
  api.initialize(root);
})(typeof globalThis === "object" ? globalThis : this, function createTrackingDashboard() {
  "use strict";

  function count(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
  }

  function summarizeTrackers(trackers, reviews) {
    const values = Array.isArray(trackers) ? trackers : [];
    const summary = values.reduce((result, tracker) => {
      result.total += 1;
      result.active += tracker && tracker.enabled ? 1 : 0;
      result.paused += tracker && !tracker.enabled ? 1 : 0;
      result.issues += tracker && tracker.lastError ? 1 : 0;
      result.queued += count(tracker && tracker.lastQueued);
      result.reviewed += count(tracker && tracker.lastReviewed);
      result.discovered += count(tracker && tracker.lastDiscovered);
      return result;
    }, { total: 0, active: 0, paused: 0, issues: 0, queued: 0, reviewed: 0, discovered: 0, pending: 0 });
    summary.pending = Array.isArray(reviews) ? reviews.length : 0;
    return summary;
  }

  function trackerStatus(tracker) {
    if (tracker && tracker.lastError) {
      return "issue";
    }
    return tracker && tracker.enabled ? "active" : "paused";
  }

  function trackerMatchesFilter(tracker, filter) {
    if (filter === "active") {
      return Boolean(tracker && tracker.enabled);
    }
    if (filter === "paused") {
      return Boolean(tracker && !tracker.enabled);
    }
    if (filter === "issues") {
      return Boolean(tracker && tracker.lastError);
    }
    return true;
  }

  function trackerMatchesSearch(tracker, query) {
    const needle = String(query || "").trim().toLocaleLowerCase();
    if (!needle) {
      return true;
    }
    return [
      tracker && tracker.pageTitle,
      tracker && tracker.url,
      tracker && tracker.folder,
      tracker && tracker.action,
      describeAction(tracker),
      tracker && tracker.query,
      tracker && tracker.matching && tracker.matching.includeText,
      tracker && tracker.matching && tracker.matching.excludeText,
      tracker && tracker.matching && tracker.matching.includePatterns && tracker.matching.includePatterns.join(" "),
      tracker && tracker.matching && tracker.matching.excludePatterns && tracker.matching.excludePatterns.join(" "),
      tracker && tracker.filters && tracker.filters.mediaType,
      tracker && tracker.filters && tracker.filters.format,
      tracker && tracker.lastError
    ].some((value) => String(value || "").toLocaleLowerCase().includes(needle));
  }

  function intervalLabel(value) {
    const minutes = count(value);
    if (minutes % 1440 === 0 && minutes >= 1440) {
      const days = minutes / 1440;
      return `Every ${days} day${days === 1 ? "" : "s"}`;
    }
    if (minutes % 60 === 0 && minutes >= 60) {
      const hours = minutes / 60;
      return `Every ${hours} hour${hours === 1 ? "" : "s"}`;
    }
    return `Every ${minutes || 15} minutes`;
  }

  function describeFilters(tracker) {
    const filters = tracker && tracker.filters || {};
    const parts = [];
    if (filters.mediaType === "image") {
      parts.push("Images");
    } else if (filters.mediaType === "video") {
      parts.push("Videos");
    } else {
      parts.push("Images & videos");
    }
    if (filters.photosOnly) {
      parts.push("Photos only");
    }
    if (filters.format && filters.format !== "any") {
      parts.push(String(filters.format).toUpperCase());
    }
    if (filters.minWidth || filters.minHeight) {
      parts.push(`At least ${count(filters.minWidth)} × ${count(filters.minHeight)} px`);
    }
    if (filters.orientation && filters.orientation !== "any") {
      parts.push(filters.orientation[0].toUpperCase() + filters.orientation.slice(1));
    }
    if (tracker && tracker.query) {
      parts.push(`Search: “${tracker.query}”`);
    }
    return parts.join(" · ");
  }

    function describeMatching(tracker) {
    const matching = tracker && tracker.matching || {};
    const parts = [describeFilters(tracker)];
    if (matching.excludeText) {
      parts.push(`Excludes “${matching.excludeText}”`);
    }
    const includeCount = Array.isArray(matching.includePatterns) ? matching.includePatterns.length : 0;
    const excludeCount = Array.isArray(matching.excludePatterns) ? matching.excludePatterns.length : 0;
    if (includeCount) {
      parts.push(`${includeCount} include pattern${includeCount === 1 ? "" : "s"}`);
    }
    if (excludeCount) {
      parts.push(`${excludeCount} exclude pattern${excludeCount === 1 ? "" : "s"}`);
    }
    const maximum = count(matching.maxDownloadsPerRun);
    if (maximum) {
      parts.push(`Max ${maximum}/check`);
    }
    return parts.filter(Boolean).join(" · ");
  }

  function describeAction(tracker) {
    const action = tracker && tracker.action;
    if (action === "review") {
      return "Add to review";
    }
    if (action === "notify") {
      return "Notify only";
    }
    return "Download automatically";
  }

  function describePagination(tracker) {
    const pagination = tracker && tracker.pagination || {};
    if (pagination.mode === "next-link") {
      return `Static Next link · up to ${count(pagination.maxPages) || 3} pages`;
    }
    if (pagination.mode === "url-template") {
      return `URL template · up to ${count(pagination.maxPages) || 3} pages`;
    }
    return "First page only";
  }

  function formatDuration(value) {
    const milliseconds = count(value);
    if (!milliseconds) {
      return "<1s";
    }
    if (milliseconds < 1000) {
      return `${milliseconds}ms`;
    }
    if (milliseconds < 60000) {
      return `${(milliseconds / 1000).toFixed(milliseconds < 10000 ? 1 : 0)}s`;
    }
    const minutes = Math.floor(milliseconds / 60000);
    const seconds = Math.floor(milliseconds % 60000 / 1000);
    return `${minutes}m ${seconds}s`;
  }

  function activityStatusLabel(status) {
    if (status === "baseline") {
      return "Baseline";
    }
    if (status === "partial") {
      return "Partial";
    }
    if (status === "error") {
      return "Failed";
    }
    if (status === "skipped") {
      return "Skipped";
    }
    return "Success";
  }

  function actionLabel(tracker) {
    return tracker && tracker.action === "review" ? "Review"
      : tracker && tracker.action === "notify" ? "Notify" : "Download";
  }

  function trackerDomain(value) {
    try {
      return new URL(value).host;
    } catch (_error) {
      return String(value || "");
    }
  }

  function nextCheckAt(tracker) {
    return tracker && tracker.enabled
      ? Math.max(count(tracker.nextRunAt), count(tracker.backoffUntil)) : 0;
  }

  function latestActivity(tracker) {
    const activity = tracker && tracker.activity;
    return Array.isArray(activity) && activity.length ? activity[activity.length - 1] : null;
  }

  function activityOutcome(record) {
    if (count(record.reviewed)) return `${count(record.reviewed).toLocaleString()} added to review`;
    if (count(record.queued)) return `${count(record.queued).toLocaleString()} queued`;
    if (count(record.discovered)) return `${count(record.discovered).toLocaleString()} new`;
    return "";
  }

  function describeLastResult(tracker) {
    const record = latestActivity(tracker);
    const partial = record && record.status === "partial";
    if (tracker && tracker.lastError && !partial || record && record.status === "error") return "Failed";
    if (record && record.status === "baseline") {
      return "Baseline recorded · no action";
    }
    if (record && record.status === "skipped") return record.message || "Skipped";
    if (!record && !(tracker && tracker.lastSuccessAt)) return "";
    const outcome = activityOutcome(record || {
      reviewed: tracker.lastReviewed, queued: tracker.lastQueued, discovered: tracker.lastDiscovered
    });
    return partial ? `Partial${outcome ? ` · ${outcome}` : ""}` : outcome || "No new media";
  }

  function formatDate(value) {
    const date = new Date(Number(value));
    if (!Number.isFinite(date.getTime()) || Number(value) <= 0) {
      return "Not checked yet";
    }
    return date.toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short"
    });
  }

  function initialize(root) {
    const browser = root.browser;
    const document = root.document;
    const elements = {};
    const busyIds = new Set();
    const reviewBusyIds = new Set();
    const selectedReviewIds = new Set();
    let trackers = [];
    let reviews = [];
    let refreshing = false;
    let loaded = false;
    let refreshPending = false;
    let globalBusy = false;
    let privateContext = false;
    let contextReady = false;
    let reviewResult = "";
    const expandedActivity = new Set();
    const expandedDetails = new Set();

    function cacheElements() {
      for (const id of [
        "tracker-heading", "tracker-summary", "tracker-tools", "tracker-list",
        "dismiss-selected-button", "download-selected-button",
        "empty-detail", "empty-state", "empty-title", "error-banner",
        "empty-actions", "empty-setup", "create-tracker-button", "reset-filters-button",
        "retry-trackers-button", "open-regular-window-button", "header-create-tracker-button",
        "pause-all-button", "refresh-button", "resume-all-button",
        "review-count", "review-empty", "review-heading", "review-section", "review-link",
        "review-list", "review-select-all", "review-status", "review-tools",
        "review-tracker-filter", "search-input", "status-filter"
      ]) {
        elements[id] = document.getElementById(id);
      }
    }

    function setError(message) {
      elements["error-banner"].textContent = message || "";
      elements["error-banner"].hidden = !message;
    }

    async function createTracker() {
      if (!contextReady || privateContext) return;
      const buttons = [elements["create-tracker-button"], elements["header-create-tracker-button"]];
      for (const button of buttons) button.disabled = true;
      setError("");
      try {
        if (root.frameElement && typeof root.parent?.AnyDownloadWorkspace?.createTracker === "function") {
          await root.parent.AnyDownloadWorkspace.createTracker();
          return;
        }
        const url = new URL(browser.runtime.getURL("popup/popup.html"));
        url.searchParams.set("createTracker", "1");
        const source = new URL(root.location && root.location.href || url.href).searchParams.get("sourceTabId");
        if (/^\d+$/.test(source || "") && Number.isSafeInteger(Number(source))) url.searchParams.set("sourceTabId", source);
        await browser.tabs.create({ active: true, url: url.href });
      } catch (_error) {
        setError("Could not open tracker setup. Try Add tracker again.");
      } finally {
        for (const button of buttons) button.disabled = false;
      }
    }

    async function openRegularWindow() {
      if (!contextReady || !privateContext || typeof browser.windows?.create !== "function") return;
      elements["open-regular-window-button"].disabled = true;
      try {
        await browser.windows.create({ incognito: false, url: browser.runtime.getURL("tracking/tracking.html") });
      } catch (_error) {
        setError("Could not open a regular window. Open AnyDownload from a regular Firefox window.");
      } finally {
        elements["open-regular-window-button"].disabled = false;
      }
    }

    async function resolveIncognitoContext() {
      const lookups = [
        browser.tabs && typeof browser.tabs.getCurrent === "function"
          ? () => browser.tabs.getCurrent()
          : null,
        browser.windows && typeof browser.windows.getCurrent === "function"
          ? () => browser.windows.getCurrent()
          : null
      ];
      for (const lookup of lookups) {
        if (!lookup) {
          continue;
        }
        try {
          const context = await lookup();
          if (context && typeof context.incognito === "boolean") {
            return context.incognito;
          }
        } catch (_error) {
          // The next context API or the extension-level fallback may still work.
        }
      }
      return Boolean(browser.extension && browser.extension.inIncognitoContext);
    }

    function createButton(label, className, listener) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = className || "tracker-button";
      button.textContent = label;
      button.addEventListener("click", listener);
      return button;
    }

    function createDetail(label, value, title) {
      const block = document.createElement("div");
      block.className = "detail-block";
      const caption = document.createElement("span");
      caption.textContent = label;
      const content = document.createElement("strong");
      content.textContent = value;
      content.title = title || value;
      block.append(caption, content);
      return block;
    }

    async function openTrackedPage(tracker) {
      try {
        await browser.tabs.create({ active: true, url: tracker.url });
      } catch (error) {
        setError(`Firefox could not open the tracked page. (${error.message || error})`);
      }
    }

    async function editTracker(tracker) {
      if (privateContext) return;
      try {
        if (root.frameElement && typeof root.parent?.AnyDownloadWorkspace?.editTracker === "function") {
          await root.parent.AnyDownloadWorkspace.editTracker(tracker.id);
          return;
        }
        await browser.tabs.create({
          active: true,
          url: `${browser.runtime.getURL("popup/popup.html")}?editTrackerId=${encodeURIComponent(tracker.id)}`
        });
      } catch (error) {
        setError(`Firefox could not open the tracker editor. (${error.message || error})`);
      }
    }

    function mergeTracker(updated) {
      if (!updated || !updated.id) {
        return;
      }
      const index = trackers.findIndex((tracker) => tracker.id === updated.id);
      if (index >= 0) {
        trackers[index] = updated;
      } else {
        trackers.push(updated);
      }
    }

    async function performTrackerAction(type, tracker, extra) {
      if (!tracker || busyIds.has(tracker.id) || globalBusy) {
        return;
      }
      if (type === "DELETE_TRACKER" && !root.confirm("Remove this background tracker? Its pending review items will be removed; download history will be kept.")) {
        return;
      }
      busyIds.add(tracker.id);
      setError("");
      render();
      try {
        const response = await browser.runtime.sendMessage({ type, id: tracker.id, ...(extra || {}) });
        if (!response || !response.ok) {
          throw new Error(response && response.error || "Firefox could not update this tracker.");
        }
        if (type === "DELETE_TRACKER") {
          trackers = trackers.filter((item) => item.id !== tracker.id);
          reviews = reviews.filter((item) => item.trackerId !== tracker.id);
          expandedActivity.delete(tracker.id);
          expandedDetails.delete(tracker.id);
        } else {
          mergeTracker(response.tracker);
        }
      } catch (error) {
        setError(error && error.message ? error.message : String(error));
      } finally {
        busyIds.delete(tracker.id);
        render();
      }
    }

    function renderTracker(tracker) {
      const card = document.createElement("article");
      const status = trackerStatus(tracker);
      const busy = busyIds.has(tracker.id);
      card.className = `tracker-item${tracker.lastError ? " has-error" : ""}`;
      card.id = `tracker-${tracker.id}`;
      card.tabIndex = -1;
      card.setAttribute("aria-busy", String(busy));

      const header = document.createElement("div");
      header.className = "tracker-header";
      const copy = document.createElement("div");
      copy.className = "tracker-copy";
      const openButton = createButton(tracker.pageTitle || trackerDomain(tracker.url) || "Tracked page", "tracker-title", () => openTrackedPage(tracker));
      openButton.id = `${card.id}-open`;
      openButton.title = `Open ${tracker.url || "tracked page"}`;
      const domain = document.createElement("span");
      domain.className = "tracker-domain";
      domain.textContent = trackerDomain(tracker.url);
      copy.append(openButton, domain);
      const pill = document.createElement("span");
      pill.className = `status-pill ${status}`;
      pill.textContent = tracker.enabled ? status === "issue" ? "Needs attention" : "Active"
        : tracker.autoPausedReason ? "Automatically paused" : "Paused";
      if (!tracker.enabled && tracker.lastError) pill.textContent += " · issue";

      const actions = document.createElement("div");
      actions.className = "tracker-actions";
      const runButton = createButton(busy ? "Checking…" : "Run now", "tracker-button", () =>
        performTrackerAction("RUN_TRACKER", tracker)
      );
      const toggleButton = createButton(tracker.enabled ? "Pause" : "Resume", "tracker-button", () =>
        performTrackerAction("SET_TRACKER_ENABLED", tracker, { enabled: !tracker.enabled })
      );
      const expanded = expandedDetails.has(tracker.id);
      const detailsButton = createButton("Details", "tracker-button details-button", () => {
        if (expandedDetails.has(tracker.id)) expandedDetails.delete(tracker.id);
        else expandedDetails.add(tracker.id);
        render();
      });
      for (const [action, button] of Object.entries({ run: runButton, toggle: toggleButton, "details-toggle": detailsButton })) {
        button.id = `${card.id}-${action}`;
      }
      detailsButton.setAttribute("aria-expanded", String(expanded));
      detailsButton.setAttribute("aria-controls", `${card.id}-details`);
      for (const button of [openButton, runButton, toggleButton]) button.disabled = busy || globalBusy;
      actions.append(runButton, toggleButton, detailsButton);
      header.append(copy, pill, actions);

      const facts = document.createElement("div");
      facts.className = "tracker-facts";
      const next = nextCheckAt(tracker);
      const nextText = !tracker.enabled ? "Paused" : busy ? "Checking…"
        : next ? next <= Date.now() ? "Due" : formatDate(next) : "Not scheduled";
      const nextFact = createDetail("Next check", nextText);
      nextFact.className = "tracker-fact";
      nextFact.id = `${card.id}-next-check`;
      if (next) nextFact.title = formatDate(next);
      const record = latestActivity(tracker);
      const completedAt = record && (record.finishedAt || record.startedAt) || (!tracker.lastError && tracker.lastSuccessAt);
      const lastFact = createDetail("Last check", completedAt ? formatDate(completedAt) : tracker.lastError ? "—" : "Not checked");
      lastFact.className = "tracker-fact";
      lastFact.id = `${card.id}-last-check`;
      const resultText = describeLastResult(tracker);
      if (resultText && !tracker.lastError) {
        const result = document.createElement("small");
        result.className = `tracker-result${tracker.lastError ? " error" : ""}`;
        result.textContent = resultText;
        lastFact.append(result);
      }
      const actionFact = createDetail("Action", actionLabel(tracker));
      actionFact.className = "tracker-fact";
      facts.append(nextFact, lastFact, actionFact);
      card.append(header, facts);
      if (tracker.lastError) {
        const error = document.createElement("p");
        error.className = "tracker-error";
        error.textContent = `${record && record.status === "partial" && resultText !== "Partial" ? `${resultText} · ` : ""}${tracker.lastError}`;
        card.append(error);
      }

      const panel = document.createElement("div");
      panel.className = "tracker-details-panel";
      panel.id = `${card.id}-details`;
      panel.hidden = !expanded;
      const details = document.createElement("div");
      details.className = "tracker-details";
      details.append(
        createDetail("Page", tracker.url || ""),
        createDetail("Schedule", intervalLabel(tracker.intervalMinutes)),
        createDetail("Folder", `Downloads/${tracker.folder || ""}`),
        createDetail("Matching", describeMatching(tracker)),
        createDetail("Pagination", describePagination(tracker))
      );
      if (tracker.autoPausedReason) details.append(createDetail("Pause reason", tracker.autoPausedReason));
      if (count(tracker.consecutiveErrors)) details.append(createDetail("Consecutive errors", count(tracker.consecutiveErrors).toLocaleString()));
      if (record) {
        details.append(createDetail("Last check", `${count(record.found)} matched · ${count(record.pagesChecked)} page${count(record.pagesChecked) === 1 ? "" : "s"} · ${formatDuration(record.durationMs)}`));
        if (record.message) details.append(createDetail("Last result", record.message));
      }
      const detailActions = document.createElement("div");
      detailActions.className = "detail-actions";
      const editButton = createButton("Edit tracker", "tracker-button", () => editTracker(tracker));
      const removeButton = createButton("Remove", "tracker-button danger-button", () =>
        performTrackerAction("DELETE_TRACKER", tracker)
      );
      editButton.id = `${card.id}-edit`;
      removeButton.id = `${card.id}-remove`;
      editButton.disabled = busy || globalBusy;
      removeButton.disabled = busy || globalBusy;
      detailActions.append(editButton);
      const activity = Array.isArray(tracker.activity) ? tracker.activity : [];
      if (activity.length) {
        const historyButton = createButton(`Activity (${activity.length})`, "tracker-button activity-button", () => {
          if (expandedActivity.has(tracker.id)) expandedActivity.delete(tracker.id);
          else expandedActivity.add(tracker.id);
          render();
        });
        historyButton.id = `${card.id}-activity`;
        historyButton.setAttribute("aria-expanded", String(expandedActivity.has(tracker.id)));
        historyButton.setAttribute("aria-controls", `${card.id}-activity-list`);
        detailActions.append(historyButton);
      }
      detailActions.append(removeButton);
      panel.append(details, detailActions);
      if (expandedActivity.has(tracker.id) && activity.length) {
        const history = document.createElement("ol");
        history.id = `${card.id}-activity-list`;
        history.className = "activity-list";
        for (const record of activity.slice().reverse()) {
          const row = document.createElement("li");
          row.className = `activity-row ${record.status || "error"}`;
          const heading = document.createElement("div");
          heading.className = "activity-heading";
          const activityPill = document.createElement("span");
          activityPill.className = `activity-status ${record.status || "error"}`;
          activityPill.textContent = activityStatusLabel(record.status);
          const date = document.createElement("time");
          date.dateTime = new Date(Number(record.finishedAt || record.startedAt) || 0).toISOString();
          date.textContent = formatDate(record.finishedAt || record.startedAt);
          heading.append(activityPill, date);
          const metrics = document.createElement("p");
          const actionMetrics = record.status === "baseline" ? "no action"
            : activityOutcome(record) || (["error", "skipped"].includes(record.status) ? "no action" : "No new media");
          metrics.textContent = `${count(record.pagesChecked)} page${count(record.pagesChecked) === 1 ? "" : "s"} · ${count(record.found)} matched · ${actionMetrics} · ${formatDuration(record.durationMs)} · ${record.reason || "alarm"}`;
          row.append(heading, metrics);
          if (record.message) {
            const message = document.createElement("p");
            message.className = "activity-message";
            message.textContent = record.message;
            row.append(message);
          }
          history.append(row);
        }
        panel.append(history);
      }
      card.append(panel);
      return card;
    }

    async function performReviewAction(items, action) {
      if (!items.length || globalBusy || refreshing || privateContext) {
        return;
      }
      const sourceButton = elements[action === "approve" ? "download-selected-button" : "dismiss-selected-button"];
      const restoreFocus = document.activeElement === sourceButton;
      globalBusy = true;
      for (const review of items) reviewBusyIds.add(review.id);
      reviewResult = "";
      setError("");
      render();
      let completed = 0;
      let queued = 0;
      const failures = [];
      try {
        for (const review of items) {
          try {
            const response = await browser.runtime.sendMessage({
              type: "TRACKER_REVIEW_ACTION", action, id: review.id
            });
            if (!response || !response.ok || !Array.isArray(response.reviews)) {
              throw new Error(response && response.error || "Firefox could not update the review inbox.");
            }
            reviews = response.reviews;
            selectedReviewIds.delete(review.id);
            completed += 1;
            queued += count(response.queued);
          } catch (error) {
            failures.push(`${review.filename || "Item"}: ${error && error.message || error}`);
          }
          elements["review-status"].textContent = `${action === "dismiss" ? "Dismissing" : "Adding to Downloads"}: ${completed + failures.length} of ${items.length} reviewed…`;
        }
        for (const tracker of trackers) {
          tracker.pendingReviewCount = reviews.filter((item) => item.trackerId === tracker.id).length;
        }
        reviewResult = action === "dismiss"
          ? `${completed} item${completed === 1 ? "" : "s"} dismissed.`
          : `${queued} added to Downloads.${completed > queued ? ` ${completed - queued} already downloaded.` : ""}`;
        if (failures.length) {
          setError(`${failures.length} item${failures.length === 1 ? "" : "s"} could not be ${action === "dismiss" ? "dismissed" : "downloaded"}. ${failures[0]} Remaining items stay in review.`);
        }
      } finally {
        reviewBusyIds.clear();
        globalBusy = false;
        render();
        if (restoreFocus && (!document.activeElement || document.activeElement === sourceButton || document.activeElement === document.body)) {
          (!sourceButton.hidden ? sourceButton : elements[elements["review-section"].hidden ? "tracker-heading" : "review-heading"]).focus({ preventScroll: true });
        }
        if (refreshPending) await refreshTrackers(true);
      }
    }

    function renderReviewItem(review) {
      const card = document.createElement("article");
      const busy = reviewBusyIds.has(review.id);
      card.className = "review-item";
      card.id = `review-${review.id}`;
      card.tabIndex = -1;
      card.setAttribute("aria-busy", String(busy));

      const selectLabel = document.createElement("label");
      selectLabel.className = "review-selection";
      const checkbox = document.createElement("input");
      checkbox.id = `${card.id}-select`;
      checkbox.type = "checkbox";
      checkbox.checked = selectedReviewIds.has(review.id);
      checkbox.disabled = busy || globalBusy;
      checkbox.setAttribute("aria-label", `Select ${review.filename || review.alt || "tracked media"}`);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) selectedReviewIds.add(review.id);
        else selectedReviewIds.delete(review.id);
        render();
      });
      selectLabel.append(checkbox);

      const preview = document.createElement("div");
      preview.className = `review-preview${review.mediaType === "video" ? " video" : ""}`;
      const previewUrl = review.previewUrl || (review.mediaType === "image" ? review.url : "");
      if (previewUrl) {
        const image = document.createElement("img");
        image.src = previewUrl;
        image.alt = "";
        image.loading = "lazy";
        image.referrerPolicy = "no-referrer";
        image.addEventListener("error", () => {
          preview.replaceChildren();
          preview.textContent = "No preview";
        }, { once: true });
        preview.append(image);
      } else {
        preview.textContent = review.mediaType === "video" ? "Video" : "No preview";
      }

      const copy = document.createElement("div");
      copy.className = "review-copy";
      const title = document.createElement("strong");
      title.textContent = review.filename || review.alt || "Tracked media";
      title.title = title.textContent;
      const sourceTracker = trackers.find((tracker) => tracker.id === review.trackerId);
      const source = document.createElement("span");
      source.textContent = `${sourceTracker && sourceTracker.pageTitle || review.pageTitle || "Removed tracker"}${review.detectedAt ? ` · ${formatDate(review.detectedAt)}` : ""}`;
      source.title = review.url || "";
      const destination = document.createElement("span");
      destination.className = "review-destination";
      destination.textContent = sourceTracker
        ? `Destination: Downloads/${sourceTracker.folder || ""}`
        : "Tracker removed — dismiss this item";
      copy.append(title, source, destination);

      const actions = document.createElement("div");
      actions.className = "review-actions";
      const open = createButton("Preview", "tracker-button", async () => {
        try {
          await browser.tabs.create({ active: true, url: review.url });
        } catch (error) {
          setError(`Firefox could not open this media. (${error.message || error})`);
        }
      });
      const approve = createButton(busy ? "Working…" : "Download", "tracker-button approve-button", () =>
        performReviewAction([review], "approve")
      );
      const dismiss = createButton("Dismiss", "tracker-button", () =>
        performReviewAction([review], "dismiss")
      );
      for (const [action, button] of Object.entries({ preview: open, download: approve, dismiss })) {
        button.id = `${card.id}-${action}`;
      }
      open.disabled = busy || globalBusy;
      approve.hidden = !sourceTracker;
      approve.disabled = busy || globalBusy || refreshing || !sourceTracker;
      dismiss.disabled = busy || globalBusy || refreshing;
      actions.append(open, approve, dismiss);
      card.append(selectLabel, preview, copy, actions);
      return card;
    }

    function renderReviews() {
      const ids = new Set(reviews.map((review) => review.id));
      for (const id of selectedReviewIds) {
        if (!ids.has(id)) selectedReviewIds.delete(id);
      }
      const filter = elements["review-tracker-filter"];
      const current = filter.value;
      const trackerIds = [...new Set(reviews.map((review) => review.trackerId))];
      const all = document.createElement("option");
      all.value = "all";
      all.textContent = "All trackers";
      filter.replaceChildren(all, ...trackerIds.map((id) => {
        const option = document.createElement("option");
        const tracker = trackers.find((item) => item.id === id);
        option.value = id;
        option.textContent = `${tracker && (tracker.pageTitle || tracker.url) || "Removed tracker"} (${reviews.filter((review) => review.trackerId === id).length})`;
        return option;
      }));
      filter.value = trackerIds.includes(current) ? current : "all";
      filter.disabled = privateContext || globalBusy || !reviews.length;
      const visible = visibleReviews();
      const selectedVisible = visible.filter((review) => selectedReviewIds.has(review.id)).length;
      const selectedCount = selectedReviewIds.size;
      const selectAll = elements["review-select-all"];
      selectAll.checked = visible.length > 0 && selectedVisible === visible.length;
      selectAll.indeterminate = selectedVisible > 0 && selectedVisible < visible.length;
      selectAll.disabled = privateContext || globalBusy || !visible.length;
      for (const id of ["download-selected-button", "dismiss-selected-button"]) {
        elements[id].hidden = !selectedCount;
        elements[id].disabled = privateContext || globalBusy || refreshing || !selectedCount;
      }
      elements["review-count"].textContent = `${visible.length.toLocaleString()}${filter.value !== "all" ? ` of ${reviews.length.toLocaleString()}` : ""} item${visible.length === 1 ? "" : "s"}`;
      const hidden = selectedCount - selectedVisible;
      elements["review-status"].textContent = `${reviewResult ? `${reviewResult} ` : ""}${selectedCount ? `${selectedCount} selected${hidden ? ` (${hidden} hidden by the tracker filter)` : ""}.` : ""}`;
      elements["review-status"].hidden = !elements["review-status"].textContent;
      elements["review-section"].hidden = !reviews.length || privateContext;
      elements["review-tools"].hidden = !reviews.length || privateContext;
      elements["review-tracker-filter"].hidden = trackerIds.length < 2;
      elements["review-empty"].hidden = visible.length > 0 || !reviews.length;
      elements["review-empty"].textContent = "No items from this tracker. Choose All trackers to view the full inbox.";
      elements["review-list"].replaceChildren(...visible.map(renderReviewItem));
    }

    function visibleReviews() {
      const filter = elements["review-tracker-filter"].value;
      return reviews.filter((review) => filter === "all" || review.trackerId === filter);
    }

    function sortedVisibleTrackers() {
      const filter = elements["status-filter"].value;
      const query = elements["search-input"].value;
      return trackers
        .filter((tracker) => trackerMatchesFilter(tracker, filter) && trackerMatchesSearch(tracker, query))
        .sort((left, right) =>
          Number(Boolean(right.lastError)) - Number(Boolean(left.lastError)) ||
          Number(right.updatedAt || right.createdAt || 0) - Number(left.updatedAt || left.createdAt || 0)
        );
    }

    function render() {
      const focused = document.activeElement;
      const focusedId = focused && (focused.getAttribute("data-focus-control") || focused.id);
      const focusedCard = focused && focused.closest(".tracker-item, .review-item");
      const focusedReviewControl = focused && ["review-select-all", "review-tracker-filter", "download-selected-button", "dismiss-selected-button", "review-heading"].includes(focused.id);
      const summary = summarizeTrackers(trackers, reviews);
      const counts = [];
      if (summary.active) counts.push(`${summary.active.toLocaleString()} active`);
      if (summary.paused) counts.push(`${summary.paused.toLocaleString()} paused`);
      if (summary.issues) counts.push(`${summary.issues.toLocaleString()} issue${summary.issues === 1 ? "" : "s"}`);
      elements["tracker-summary"].textContent = counts.join(" · ");
      elements["tracker-summary"].hidden = !loaded || privateContext || !counts.length;
      elements["review-link"].hidden = !reviews.length || privateContext;
      elements["review-link"].textContent = `${reviews.length.toLocaleString()} to review`;
      elements["review-link"].setAttribute("aria-label", `${reviews.length.toLocaleString()} item${reviews.length === 1 ? "" : "s"} to review. Go to review inbox.`);
      elements["tracker-tools"].hidden = !trackers.length || privateContext;
      elements["header-create-tracker-button"].hidden = !loaded || !trackers.length || privateContext;
      elements["pause-all-button"].hidden = !summary.active || privateContext;
      elements["resume-all-button"].hidden = !summary.paused || privateContext;
      elements["pause-all-button"].disabled = globalBusy || refreshing || summary.active === 0;
      elements["resume-all-button"].disabled = globalBusy || refreshing || summary.paused === 0;
      elements["refresh-button"].disabled = refreshing || globalBusy || privateContext;
      elements["refresh-button"].setAttribute("aria-busy", String(refreshing));
      elements["search-input"].disabled = privateContext;
      elements["status-filter"].disabled = privateContext;

      renderReviews();
      const visible = sortedVisibleTrackers();
      elements["tracker-list"].replaceChildren(...visible.map(renderTracker));
      elements["tracker-list"].hidden = !visible.length;
      elements["empty-state"].hidden = visible.length > 0;
      const filtered = summary.total > 0;
      const loadFailed = !loaded && Boolean(elements["error-banner"].textContent);
      const firstUse = loaded && !filtered && !privateContext;
      const filterEmpty = loaded && filtered && !visible.length && !privateContext;
      const normalWindowAvailable = privateContext && typeof browser.windows?.create === "function";
      elements["empty-state"].setAttribute("data-state", privateContext ? "private" : !loaded ? loadFailed ? "error" : "loading" : filtered ? "filtered" : "first-use");
      elements["empty-title"].textContent = privateContext ? "Trackers are unavailable in private windows."
        : !loaded ? loadFailed ? "Could not load trackers" : "Loading trackers…"
        : filtered ? "No matching trackers" : "Check a page for new media";
      elements["empty-detail"].textContent = privateContext ? "Open AnyDownload in a regular Firefox window to create and manage trackers."
        : !loaded ? loadFailed ? "Your saved pages could not be read. Retry to load them." : "Reading saved pages and pending reviews."
        : filtered ? `${summary.total.toLocaleString()} saved page${summary.total === 1 ? "" : "s"}. Clear the search and status filters to show them.`
        : "Save a webpage and check it on a schedule for new images or videos. Checks run while Firefox is open.";
      elements["empty-detail"].hidden = !elements["empty-detail"].textContent;
      elements["create-tracker-button"].hidden = !firstUse;
      elements["reset-filters-button"].hidden = !filterEmpty;
      elements["retry-trackers-button"].hidden = !loadFailed || privateContext;
      elements["retry-trackers-button"].disabled = refreshing;
      elements["open-regular-window-button"].hidden = !normalWindowAvailable;
      elements["empty-actions"].hidden = !(firstUse || filterEmpty || loadFailed && !privateContext || normalWindowAvailable);
      elements["empty-setup"].hidden = !firstUse;
      if (focusedCard) {
        const replacement = document.getElementById(focusedId);
        const fallback = document.getElementById(focusedCard.id) ||
          (focusedCard.className === "review-item" && !elements["review-section"].hidden
            ? elements["review-heading"] : elements["tracker-heading"]);
        if ((!replacement || replacement.disabled) && fallback.id === focusedCard.id) {
          fallback.setAttribute("data-focus-control", focusedId);
        }
        (replacement && !replacement.disabled ? replacement : fallback).focus({ preventScroll: true });
      } else if (focused && (focused.hidden || focusedReviewControl && elements["review-section"].hidden)) {
        const counterpart = focused.id === "pause-all-button" ? elements["resume-all-button"]
          : focused.id === "resume-all-button" ? elements["pause-all-button"] : null;
        const target = counterpart && !counterpart.hidden ? counterpart
          : focusedReviewControl && !elements["review-section"].hidden
            ? elements["review-heading"] : elements["tracker-heading"];
        target.focus({ preventScroll: true });
      }
    }

    async function refreshTrackers(preserveError = false) {
      if (!contextReady || privateContext) {
        return;
      }
      if (refreshing || globalBusy) {
        refreshPending = true;
        return;
      }
      refreshPending = false;
      refreshing = true;
      if (!preserveError) setError("");
      render();
      try {
        const response = await browser.runtime.sendMessage({ type: "GET_TRACKERS" });
        if (!response || !response.ok || !Array.isArray(response.trackers)) {
          throw new Error(response && response.error || "Firefox could not load background trackers.");
        }
        trackers = response.trackers;
        reviews = Array.isArray(response.reviews) ? response.reviews : [];
        loaded = true;
      } catch (error) {
        if (!preserveError || !elements["error-banner"].textContent) {
          setError(error && error.message ? error.message : String(error));
        }
      } finally {
        refreshing = false;
        render();
        if (refreshPending && !globalBusy) {
          Promise.resolve().then(() => refreshTrackers(true));
        }
      }
    }

    async function setAllTrackersEnabled(enabled) {
      if (globalBusy || refreshing) {
        return;
      }
      const sourceButton = elements[enabled ? "resume-all-button" : "pause-all-button"];
      const restoreFocus = document.activeElement === sourceButton;
      globalBusy = true;
      setError("");
      render();
      try {
        const response = await browser.runtime.sendMessage({
          type: "SET_ALL_TRACKERS_ENABLED",
          enabled
        });
        if (!response || !response.ok || !Array.isArray(response.trackers)) {
          throw new Error(response && response.error || "Firefox could not update the trackers.");
        }
        trackers = response.trackers;
      } catch (error) {
        setError(error && error.message ? error.message : String(error));
      } finally {
        globalBusy = false;
        render();
        if (restoreFocus && (!document.activeElement || document.activeElement === sourceButton || document.activeElement === document.body)) {
          const counterpart = elements[enabled ? "pause-all-button" : "resume-all-button"];
          (!sourceButton.hidden ? sourceButton : !counterpart.hidden ? counterpart : elements["tracker-heading"]).focus({ preventScroll: true });
        }
        if (refreshPending) await refreshTrackers(true);
      }
    }

    function wireEvents() {
      elements["refresh-button"].addEventListener("click", () => refreshTrackers());
      elements["pause-all-button"].addEventListener("click", () => setAllTrackersEnabled(false));
      elements["resume-all-button"].addEventListener("click", () => setAllTrackersEnabled(true));
      elements["create-tracker-button"].addEventListener("click", createTracker);
      elements["header-create-tracker-button"].addEventListener("click", createTracker);
      elements["open-regular-window-button"].addEventListener("click", openRegularWindow);
      elements["retry-trackers-button"].addEventListener("click", () => refreshTrackers());
      elements["reset-filters-button"].addEventListener("click", () => {
        elements["search-input"].value = "";
        elements["status-filter"].value = "all";
        render();
        elements["search-input"].focus({ preventScroll: true });
      });
      elements["search-input"].addEventListener("input", render);
      elements["status-filter"].addEventListener("change", render);
      elements["review-tracker-filter"].addEventListener("change", render);
      elements["review-select-all"].addEventListener("change", () => {
        for (const review of visibleReviews()) {
          if (elements["review-select-all"].checked) selectedReviewIds.add(review.id);
          else selectedReviewIds.delete(review.id);
        }
        render();
      });
      elements["download-selected-button"].addEventListener("click", () =>
        performReviewAction(reviews.filter((review) => selectedReviewIds.has(review.id)), "approve")
      );
      elements["dismiss-selected-button"].addEventListener("click", () =>
        performReviewAction(reviews.filter((review) => selectedReviewIds.has(review.id)), "dismiss")
      );
      if (browser.storage && browser.storage.onChanged) {
        browser.storage.onChanged.addListener((changes, areaName) => {
          if (
            areaName === "local" &&
            changes &&
            (changes["mediaTrackers:v1"] || changes["trackerReviewItems:v1"]) &&
            !privateContext
          ) {
            refreshTrackers(true);
          }
        });
      }
    }

    document.addEventListener("DOMContentLoaded", async () => {
      cacheElements();
      wireEvents();
      privateContext = await resolveIncognitoContext();
      contextReady = true;
      render();
      if (privateContext) return;
      refreshTrackers();
    }, { once: true });
  }

  return Object.freeze({
    actionLabel,
    activityStatusLabel,
    describeLastResult,
    nextCheckAt,
    trackerDomain,
    describeAction,
    describeFilters,
    describeMatching,
    describePagination,
    formatDuration,
    initialize,
    intervalLabel,
    summarizeTrackers,
    trackerMatchesFilter,
    trackerMatchesSearch,
    trackerStatus
  });
});
