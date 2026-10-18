(function initializeDownloadHistory(root) {
  "use strict";

  const POLL_ACTIVE_MS = 1000;
  const POLL_IDLE_MS = 4000;
  const INITIAL_TASK_LIMIT = 12;
  const elements = {};
  const expandedJobs = new Set();
  let snapshot = null;
  let renderedSnapshotSignature = "";
  let pollTimer = null;
  let refreshing = false;
  let privateContext = false;

  function cacheElements() {
    for (const id of [
      "bytes-detail",
      "bytes-stat",
      "cancel-pending-button",
      "cancelled-detail",
      "cancelled-stat",
      "clear-completed-button",
      "completed-detail",
      "completed-stat",
      "dashboard-subtitle",
      "error-banner",
      "failed-detail",
      "failed-stat",
      "history-empty",
      "history-empty-title",
      "history-empty-detail",
      "history-search",
      "history-status",
      "history-tools",
      "job-list",
      "main-content",
      "open-folder-button",
      "pause-all-button",
      "queue-description",
      "queue-progress",
      "queue-section",
      "refresh-button",
      "resume-all-button",
      "retry-failed-button",
      "reset-filters-button",
      "search-input",
      "status-filter",
      "statistics-panel",
      "success-detail",
      "success-stat"
    ]) {
      elements[id] = document.getElementById(id);
    }
  }

  async function resolveIncognitoContext() {
    const contextLookups = [
      browser.tabs && typeof browser.tabs.getCurrent === "function"
        ? () => browser.tabs.getCurrent()
        : null,
      browser.windows && typeof browser.windows.getCurrent === "function"
        ? () => browser.windows.getCurrent()
        : null
    ];
    for (const lookup of contextLookups) {
      if (!lookup) {
        continue;
      }
      try {
        const context = await lookup();
        if (context && typeof context.incognito === "boolean") {
          return context.incognito;
        }
      } catch (_error) {
        // A second context API, or the extension-level fallback, may still work.
      }
    }
    return Boolean(browser.extension && browser.extension.inIncognitoContext);
  }

  function formatBytes(value) {
    let amount = Math.max(0, Number(value) || 0);
    if (amount < 1024) {
      return `${Math.round(amount).toLocaleString()} B`;
    }
    const units = ["KiB", "MiB", "GiB", "TiB"];
    let unit = "B";
    for (const candidate of units) {
      amount /= 1024;
      unit = candidate;
      if (amount < 1024 || candidate === units[units.length - 1]) {
        break;
      }
    }
    return `${amount.toLocaleString(undefined, { maximumFractionDigits: amount >= 100 ? 0 : amount >= 10 ? 1 : 2 })} ${unit}`;
  }

  function formatDate(value) {
    const date = new Date(Number(value));
    if (!(Number(value) > 0) || !Number.isFinite(date.getTime())) {
      return "";
    }
    return date.toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short"
    });
  }

  function setError(message) {
    elements["error-banner"].textContent = message || "";
    elements["error-banner"].hidden = !message;
  }

  function snapshotSignature(value) {
    try {
      return JSON.stringify(value);
    } catch (_error) {
      return null;
    }
  }

  async function performDownloadsAction(method, args, unsupportedMessage) {
    setError("");
    const downloadsApi = browser.downloads;
    if (!downloadsApi || typeof downloadsApi[method] !== "function") {
      setError(unsupportedMessage);
      return;
    }
    try {
      await Promise.resolve(downloadsApi[method](...(args || [])));
    } catch (error) {
      setError(error && error.message ? error.message : String(error));
    }
  }

  function statusLabel(value) {
    const labels = {
      queued: "Queued",
      starting: "Starting",
      in_progress: "Downloading",
      active: "Active",
      paused: "Paused",
      complete: "Complete",
      interrupted: "Failed",
      failed: "Failed",
      partial: "Partial",
      cancelled: "Cancelled"
    };
    return labels[value] || "Unknown";
  }

  function createButton(label, action, targetType, id, className) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className || "task-button";
    button.textContent = label;
    button.dataset.focusKey = `${targetType}:${id}:${action}`;
    button.addEventListener("click", () => performAction(action, targetType, id));
    return button;
  }

  function taskActions(task) {
    const fragment = document.createDocumentFragment();
    if (["queued", "starting", "in_progress"].includes(task.status)) {
      fragment.append(createButton("Pause", "pause", "task", task.id));
    }
    if (task.status === "paused") {
      fragment.append(createButton("Resume", "resume", "task", task.id));
    }
    if (["queued", "starting", "in_progress", "paused"].includes(task.status)) {
      fragment.append(createButton("Cancel", "cancel", "task", task.id));
    }
    if (["failed", "interrupted", "cancelled"].includes(task.status)) {
      fragment.append(createButton("Retry", "retry", "task", task.id));
    }
    if (task.downloadId != null && task.status === "complete" &&
      browser.downloads && typeof browser.downloads.show === "function") {
      const show = document.createElement("button");
      show.type = "button";
      show.className = "task-button";
      show.textContent = "Show";
      show.dataset.focusKey = `task:${task.id}:show`;
      show.addEventListener("click", () => performDownloadsAction(
        "show",
        [task.downloadId],
        "Firefox cannot reveal this downloaded file."
      ));
      fragment.append(show);
    }
    return fragment;
  }

  function renderTask(task) {
    const item = document.createElement("li");
    item.className = "task-row";
    item.dataset.focusScope = `task:${task.id}`;
    item.tabIndex = -1;
    const copy = document.createElement("div");
    copy.className = "task-copy";
    const title = document.createElement("strong");
    title.className = "task-title";
    title.textContent = String(task.filename || "Media download").split(/[\\/]/).pop() || "Media download";
    title.title = task.filename || "";
    const received = Number(task.bytesReceived) || 0;
    const total = Number(task.totalBytes) || 0;
    copy.append(title);
    if (task.error) {
      const detail = document.createElement("span");
      detail.className = "task-meta";
      detail.textContent = task.error;
      copy.append(detail);
    }
    const size = document.createElement("span");
    size.className = "task-size";
    size.textContent = task.status === "complete"
      ? received || total ? formatBytes(received || total) : "—"
      : total ? `${formatBytes(received)} / ${formatBytes(total)}`
        : received ? `${formatBytes(received)} received` : "—";
    size.title = size.textContent === "—" ? "Size unknown" : size.textContent;
    if (["starting", "in_progress"].includes(task.status) || total > 0 && task.status === "paused") {
      const progress = document.createElement("progress");
      progress.className = "task-progress";
      if (total > 0) {
        progress.max = total;
        progress.value = Math.min(total, received);
      }
      progress.setAttribute("aria-label", `${title.textContent}: download progress`);
      copy.append(progress);
    }
    const pill = document.createElement("span");
    pill.className = `status-pill ${task.status || "unknown"}`;
    pill.textContent = statusLabel(task.status);
    const actions = document.createElement("div");
    actions.className = "task-actions";
    actions.append(taskActions(task));
    item.append(copy, size, pill, actions);
    return item;
  }

  function statusMatchesFilter(status, filter) {
    if (filter === "all") {
      return true;
    }
    if (filter === "active") {
      return ["queued", "starting", "in_progress", "active", "paused"].includes(status);
    }
    if (filter === "failed") {
      return ["failed", "interrupted", "partial"].includes(status);
    }
    return status === filter;
  }

  function renderJob(job, tasks) {
    const card = document.createElement("article");
    card.className = "job-card";
    card.dataset.focusScope = `job:${job.id}`;
    card.tabIndex = -1;
    const header = document.createElement("div");
    header.className = "job-header";
    const copy = document.createElement("div");
    copy.className = "job-copy";
    const title = document.createElement("h2");
    title.className = "job-title";
    title.textContent = job.label || job.folder || "Download batch";
    title.title = title.textContent;
    const counts = job.counts || {};
    const allTasks = Array.isArray(job.tasks) ? job.tasks : [];
    copy.append(title);
    const location = document.createElement("div");
    location.className = "job-location";
    if (job.source) {
      let sourceUrl;
      try {
        const candidate = new URL(job.source);
        if (["http:", "https:"].includes(candidate.protocol)) sourceUrl = candidate;
      } catch (_error) { /* Keep unparseable sources as plain text. */ }
      const source = document.createElement(sourceUrl ? "a" : "span");
      source.className = "job-source";
      source.textContent = sourceUrl ? `${sourceUrl.hostname}${sourceUrl.pathname === "/" ? "" : sourceUrl.pathname}` : job.source;
      source.title = job.source;
      if (sourceUrl) {
        source.dataset.focusKey = `job:${job.id}:source`;
        source.href = sourceUrl.href;
        source.target = "_blank";
        source.rel = "noopener noreferrer";
      }
      location.append(source);
    }
    if (job.folder) {
      const folder = document.createElement("span");
      folder.className = "job-folder";
      folder.textContent = `Downloads/${job.folder}`;
      location.append(folder);
    }
    copy.append(location);
    const pill = document.createElement("span");
    pill.className = `status-pill ${job.status || "unknown"}`;
    pill.textContent = statusLabel(job.status);
    const actions = document.createElement("div");
    actions.className = "job-actions";
    if (!job.historyOnly && Number(counts.active || 0) + Number(counts.queued || 0) > 0) {
      actions.append(createButton("Pause", "pause", "job", job.id, "quiet-button"));
    }
    if (!job.historyOnly && Number(counts.paused || 0) > 0) {
      actions.append(createButton("Resume", "resume", "job", job.id, "quiet-button"));
    }
    if (!job.historyOnly && Number(counts.pending || 0) > 0) {
      actions.append(createButton("Cancel", "cancel", "job", job.id, "danger-button"));
    }
    if (!job.historyOnly && Number(counts.failed || 0) > 0) {
      actions.append(createButton("Retry failed", "retry", "job", job.id, "quiet-button"));
    }
    header.append(copy, pill, actions);
    card.append(header);
    const meta = document.createElement("div");
    meta.className = "job-meta";
    const count = document.createElement("span");
    count.className = "job-count";
    count.textContent = `${Number(counts.complete || 0).toLocaleString()} / ${Number(counts.total || 0).toLocaleString()} complete` +
      (Number(counts.failed) ? ` · ${Number(counts.failed).toLocaleString()} failed` : "") +
      (Number(counts.cancelled) ? ` · ${Number(counts.cancelled).toLocaleString()} cancelled` : "");
    meta.append(count);
    const received = allTasks.reduce((sum, task) => sum + (Number(task.bytesReceived) || 0), 0);
    const totalBytes = allTasks.reduce((sum, task) => sum + (Number(task.totalBytes) ||
      (task.status === "complete" ? Number(task.bytesReceived) || 0 : 0)), 0);
    const totalKnown = allTasks.length > 0 && allTasks.every((task) => Number(task.totalBytes) > 0 ||
      task.status === "complete" && Number(task.bytesReceived) > 0);
    if (received || totalKnown && totalBytes) {
      const size = document.createElement("span");
      size.className = "job-size";
      size.textContent = totalKnown
        ? received < totalBytes ? `${formatBytes(received)} / ${formatBytes(totalBytes)}` : formatBytes(received)
        : `${formatBytes(received)} received`;
      meta.append(size);
    }
    const dateValue = job.finishedAt || job.createdAt;
    const dateText = formatDate(dateValue);
    if (dateText) {
      const date = document.createElement("time");
      date.className = "job-time";
      date.dateTime = new Date(Number(dateValue)).toISOString();
      date.textContent = `${job.finishedAt ? "Finished" : "Added"} ${dateText}`;
      meta.append(date);
    }
    card.append(meta);
    if (Number(counts.pending || 0) > 0) {
      const progress = document.createElement("progress");
      progress.className = "job-progress";
      progress.max = Math.max(1, Number(counts.total) || 1);
      progress.value = Math.min(progress.max, Number(counts.complete || 0) + Number(counts.failed || 0) + Number(counts.cancelled || 0));
      progress.setAttribute("aria-label", `${title.textContent}: finished files, including failed and cancelled files`);
      card.append(progress);
    }

    if (job.historyOnly) {
      const note = document.createElement("p");
      note.className = "history-note";
      note.textContent = "File details cleared";
      card.append(note);
      return card;
    }
    const expanded = expandedJobs.has(job.id);
    if (tasks.length !== (job.tasks || []).length) {
      const note = document.createElement("p");
      note.className = "history-note";
      note.textContent = `${tasks.length.toLocaleString()} of ${job.tasks.length.toLocaleString()} files shown · Batch actions affect all files.`;
      card.append(note);
    }
    const visible = expanded ? tasks : tasks.slice(0, INITIAL_TASK_LIMIT);
    const list = document.createElement("ol");
    list.className = "task-list";
    visible.forEach((task) => list.append(renderTask(task)));
    card.append(list);
    if (tasks.length > INITIAL_TASK_LIMIT) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "show-more-button";
      more.dataset.focusKey = `job:${job.id}:expand`;
      more.setAttribute("aria-expanded", String(expanded));
      more.textContent = expanded
        ? "Show fewer files"
        : `Show ${tasks.length - INITIAL_TASK_LIMIT} more files`;
      more.addEventListener("click", () => {
        if (expanded) {
          expandedJobs.delete(job.id);
        } else {
          expandedJobs.add(job.id);
        }
        render();
      });
      card.append(more);
    }
    return card;
  }

  function render() {
    const focused = document.activeElement;
    const focusedKey = focused && focused.dataset && focused.dataset.focusKey;
    const focusedScope = focused && focused.closest("[data-focus-scope]");
    const focusedJob = focused && focused.closest(".job-card");
    const data = snapshot || {};
    const summary = data.summary || {};
    const stats = data.stats || {};
    const lifetime = stats.lifetime || {};
    const today = stats.today || {};
    const completed = Number(lifetime.completed) || 0;
    const failed = Number(lifetime.failed) || 0;
    const cancelled = Number(lifetime.cancelled) || 0;
    const finished = completed + failed + cancelled;
    const todayCompleted = Number(today.completed) || 0;
    const todayFailed = Number(today.failed) || 0;
    const todayCancelled = Number(today.cancelled) || 0;
    const todayFinished = todayCompleted + todayFailed + todayCancelled;
    const queued = Number(summary.queued) || 0;
    const active = Number(summary.active) || 0;
    const paused = Number(summary.paused) || 0;
    const currentFailed = Number(summary.failed) || 0;
    const allJobs = Array.isArray(data.jobs) ? data.jobs : [];

    elements["completed-stat"].textContent = completed.toLocaleString();
    elements["completed-detail"].textContent = todayCompleted.toLocaleString();
    elements["failed-stat"].textContent = failed.toLocaleString();
    elements["failed-detail"].textContent = todayFailed.toLocaleString();
    elements["cancelled-stat"].textContent = cancelled.toLocaleString();
    elements["cancelled-detail"].textContent = todayCancelled.toLocaleString();
    elements["bytes-stat"].textContent = formatBytes(lifetime.bytes);
    elements["bytes-detail"].textContent = formatBytes(today.bytes);
    elements["success-stat"].textContent = finished ? `${Math.round((completed / finished) * 100)}%` : "—";
    elements["success-detail"].textContent = todayFinished ? `${Math.round((todayCompleted / todayFinished) * 100)}%` : "—";
    elements["statistics-panel"].hidden = !(finished || todayFinished || Number(lifetime.bytes) || Number(today.bytes));

    const activeJobs = allJobs.filter((job) => Number(job.counts && job.counts.pending) > 0);
    const queueTotal = activeJobs.reduce((sum, job) => sum + (Number(job.counts.total) || 0), 0);
    const queueFinished = activeJobs.reduce((sum, job) => sum + (Number(job.counts.complete) || 0) +
      (Number(job.counts.failed) || 0) + (Number(job.counts.cancelled) || 0), 0);
    elements["queue-section"].hidden = active + queued + paused === 0;
    elements["queue-progress"].max = Math.max(1, queueTotal);
    elements["queue-progress"].value = Math.min(elements["queue-progress"].max, queueFinished);
    const announcement = [
      active ? `${active.toLocaleString()} downloading` : "",
      queued ? `${queued.toLocaleString()} queued` : "",
      paused ? `${paused.toLocaleString()} paused` : ""
    ].filter(Boolean).join(" · ");
    if (elements["queue-description"].textContent !== announcement) {
      elements["queue-description"].textContent = announcement;
    }
    elements["dashboard-subtitle"].textContent = privateContext ? "Private queue" : "";
    elements["dashboard-subtitle"].title = privateContext ? "Private downloads are cleared when Firefox closes." : "";
    elements["dashboard-subtitle"].hidden = !privateContext;

    elements["pause-all-button"].disabled = active + queued === 0;
    elements["pause-all-button"].hidden = active + queued === 0;
    elements["resume-all-button"].disabled = paused === 0;
    elements["resume-all-button"].hidden = paused === 0;
    elements["cancel-pending-button"].disabled = active + queued + paused === 0;
    elements["cancel-pending-button"].hidden = active + queued + paused === 0;
    elements["retry-failed-button"].disabled = currentFailed === 0;
    elements["retry-failed-button"].hidden = currentFailed === 0;
    const canClear = allJobs.some((job) => !job.historyOnly && job.status === "complete");
    elements["clear-completed-button"].disabled = !canClear;
    elements["clear-completed-button"].hidden = !canClear;

    const filter = elements["status-filter"].value;
    const query = elements["search-input"].value.trim().toLocaleLowerCase();
    const fileCount = allJobs.reduce((sum, job) => sum + (Number(job.counts && job.counts.total) || 0), 0);
    const statuses = new Set();
    for (const job of allJobs) {
      if (!(job.tasks || []).length) statuses.add(job.status);
      for (const task of job.tasks || []) {
        statuses.add(statusMatchesFilter(task.status, "active") ? "active" :
          statusMatchesFilter(task.status, "failed") ? "failed" : task.status);
      }
    }
    elements["history-search"].hidden = !query && allJobs.length < 2 && fileCount < 8;
    elements["history-status"].hidden = filter === "all" && statuses.size < 2;
    elements["history-tools"].hidden = elements["history-search"].hidden && elements["history-status"].hidden &&
      elements["retry-failed-button"].hidden && elements["clear-completed-button"].hidden;
    const jobs = allJobs.map((job) => {
      const matchesBatch = [job.label, job.folder, job.source].some((value) =>
        String(value || "").toLocaleLowerCase().includes(query));
      const tasks = (Array.isArray(job.tasks) ? job.tasks : []).filter((task) =>
        statusMatchesFilter(task.status, filter) &&
        (matchesBatch || String(task.filename || "").toLocaleLowerCase().includes(query)));
      return { job, tasks, matchesBatch };
    }).filter(({ job, tasks, matchesBatch }) => tasks.length ||
      (!(job.tasks || []).length && matchesBatch && statusMatchesFilter(job.status, filter)));
    jobs.sort((left, right) => Number(Number(right.job.counts && right.job.counts.pending) > 0) -
      Number(Number(left.job.counts && left.job.counts.pending) > 0));
    elements["job-list"].replaceChildren(...jobs.map(({ job, tasks }) => renderJob(job, tasks)));
    const fallback = !elements["history-status"].hidden ? elements["status-filter"] :
      !elements["history-search"].hidden ? elements["search-input"] :
        !elements["refresh-button"].disabled ? elements["refresh-button"] : elements["main-content"];
    if (focusedScope) {
      const controls = Array.from(elements["job-list"].querySelectorAll("[data-focus-key], [data-focus-scope]"));
      const target = controls.find((element) => focusedKey && element.dataset.focusKey === focusedKey && !element.disabled) ||
        controls.find((element) => element.dataset.focusScope === focusedScope.dataset.focusScope) ||
        controls.find((element) => focusedJob && element.dataset.focusScope === focusedJob.dataset.focusScope) ||
        fallback;
      target.focus({ preventScroll: true });
    } else if (focused && (focused.hidden ||
      focused === elements["search-input"] && elements["history-search"].hidden ||
      focused === elements["status-filter"] && elements["history-status"].hidden)) {
      const nextQueueAction = ["pause-all-button", "resume-all-button", "cancel-pending-button"]
        .map((id) => elements[id]).find((button) => !button.hidden && !button.disabled);
      const queueControl = ["pause-all-button", "resume-all-button", "cancel-pending-button"]
        .some((id) => elements[id] === focused);
      (queueControl && nextQueueAction || fallback).focus({ preventScroll: true });
    }
    elements["history-empty"].hidden = jobs.length > 0;
    elements["history-empty-title"].textContent = allJobs.length ? "No matching downloads"
      : finished ? "No recent downloads" : "No downloads yet";
    elements["history-empty-detail"].textContent = allJobs.length
      ? "Try another filename or clear the filters."
      : "Select files in Media to start downloading.";
    elements["history-empty-detail"].hidden = jobs.length > 0;
    elements["reset-filters-button"].hidden = jobs.length > 0 || !allJobs.length;

  }

  function schedulePoll() {
    if (pollTimer !== null) {
      clearTimeout(pollTimer);
    }
    const summary = snapshot && snapshot.summary || {};
    const active = Number(summary.active || 0) + Number(summary.queued || 0) + Number(summary.paused || 0);
    pollTimer = setTimeout(refresh, active ? POLL_ACTIVE_MS : POLL_IDLE_MS);
  }

  async function refresh() {
    if (refreshing) {
      return;
    }
    refreshing = true;
    elements["refresh-button"].disabled = true;
    elements["refresh-button"].setAttribute("aria-busy", "true");
    try {
      const response = await browser.runtime.sendMessage({
        type: "GET_DOWNLOAD_DASHBOARD",
        incognito: privateContext
      });
      if (!response || !response.ok || !response.snapshot) {
        throw new Error(response && response.error || "The download queue did not respond.");
      }
      const nextSnapshot = response.snapshot;
      const nextSignature = snapshotSignature(nextSnapshot);
      snapshot = nextSnapshot;
      setError("");
      if (nextSignature === null || nextSignature !== renderedSnapshotSignature) {
        renderedSnapshotSignature = nextSignature || "";
        render();
      }
    } catch (error) {
      setError(error && error.message ? error.message : String(error));
      if (!snapshot) {
        elements["history-empty-title"].textContent = "Downloads unavailable";
        elements["history-empty-detail"].textContent = "Refresh to try again.";
        elements["history-empty-detail"].hidden = false;
      }
    } finally {
      refreshing = false;
      elements["refresh-button"].disabled = false;
      elements["refresh-button"].setAttribute("aria-busy", "false");
      schedulePoll();
    }
  }

  async function performAction(action, targetType, id) {
    setError("");
    try {
      const response = await browser.runtime.sendMessage({
        type: "DOWNLOAD_QUEUE_ACTION",
        action,
        targetType,
        id: id || "",
        incognito: privateContext
      });
      if (!response || !response.ok) {
        throw new Error(response && response.error || "Firefox could not update the queue.");
      }
      snapshot = response.snapshot || snapshot;
      renderedSnapshotSignature = snapshotSignature(snapshot) || "";
      render();
      await refresh();
    } catch (error) {
      setError(error && error.message ? error.message : String(error));
    }
  }

  function wireEvents() {
    elements["refresh-button"].addEventListener("click", refresh);
    const canOpenFolder = browser.downloads && typeof browser.downloads.showDefaultFolder === "function";
    elements["open-folder-button"].disabled = !canOpenFolder;
    elements["open-folder-button"].hidden = !canOpenFolder;
    if (!canOpenFolder) {
      elements["open-folder-button"].title = "Firefox cannot open the Downloads folder in this environment.";
    }
    elements["open-folder-button"].addEventListener("click", () => performDownloadsAction(
      "showDefaultFolder",
      [],
      "Firefox cannot open the Downloads folder."
    ));
    elements["reset-filters-button"].addEventListener("click", () => {
      elements["search-input"].value = "";
      elements["status-filter"].value = "all";
      render();
      const target = !elements["history-search"].hidden ? elements["search-input"] :
        !elements["history-status"].hidden ? elements["status-filter"] : elements["refresh-button"];
      target.focus({ preventScroll: true });
    });
    elements["status-filter"].addEventListener("change", render);
    elements["search-input"].addEventListener("input", render);
    elements["pause-all-button"].addEventListener("click", () => performAction("pause", "all", ""));
    elements["resume-all-button"].addEventListener("click", () => performAction("resume", "all", ""));
    elements["cancel-pending-button"].addEventListener("click", () => performAction("cancel", "all", ""));
    elements["retry-failed-button"].addEventListener("click", () => performAction("retry", "all", ""));
    elements["clear-completed-button"].addEventListener("click", () => performAction("clear_completed", "all", ""));
    root.addEventListener("beforeunload", () => {
      if (pollTimer !== null) {
        clearTimeout(pollTimer);
      }
    }, { once: true });
  }

  document.addEventListener("DOMContentLoaded", async () => {
    cacheElements();
    privateContext = await resolveIncognitoContext();
    wireEvents();
    await refresh();
  }, { once: true });
})(globalThis);
