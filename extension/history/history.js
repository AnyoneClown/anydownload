(function initializeDownloadHistory(root) {
  "use strict";

  const POLL_ACTIVE_MS = 1000;
  const POLL_IDLE_MS = 4000;
  const INITIAL_TASK_LIMIT = 12;
  const elements = {};
  const expandedJobs = new Set();
  let snapshot = null;
  let pollTimer = null;
  let refreshing = false;
  let privateContext = false;

  function cacheElements() {
    for (const id of [
      "bytes-detail",
      "bytes-stat",
      "cancel-pending-button",
      "clear-completed-button",
      "completed-detail",
      "completed-stat",
      "dashboard-subtitle",
      "error-banner",
      "history-empty",
      "job-list",
      "open-folder-button",
      "pause-all-button",
      "queue-description",
      "queue-detail",
      "queue-progress",
      "queue-stat",
      "refresh-button",
      "resume-all-button",
      "retry-failed-button",
      "status-filter",
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
    if (!Number.isFinite(date.getTime())) {
      return "Unknown time";
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
      cancelled: "Cancelled"
    };
    return labels[value] || "Unknown";
  }

  function createButton(label, action, targetType, id, className) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className || "task-button";
    button.textContent = label;
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
    if (task.downloadId != null && task.status === "complete") {
      const show = document.createElement("button");
      show.type = "button";
      show.className = "task-button";
      show.textContent = "Show";
      const canShow = browser.downloads && typeof browser.downloads.show === "function";
      show.disabled = !canShow;
      if (!canShow) {
        show.title = "Firefox cannot reveal downloaded files in this environment.";
      }
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
    const copy = document.createElement("div");
    copy.className = "task-copy";
    const title = document.createElement("strong");
    title.className = "task-title";
    title.textContent = task.filename || "Media download";
    title.title = task.filename || "";
    const detail = document.createElement("span");
    detail.className = "task-meta";
    const received = Number(task.bytesReceived) || 0;
    const total = Number(task.totalBytes) || 0;
    detail.textContent = task.error
      ? `${statusLabel(task.status)} · ${task.error}`
      : total
        ? `${statusLabel(task.status)} · ${formatBytes(received)} of ${formatBytes(total)}`
        : `${statusLabel(task.status)}${received ? ` · ${formatBytes(received)}` : ""}`;
    copy.append(title, detail);
    const pill = document.createElement("span");
    pill.className = `status-pill ${task.status || "unknown"}`;
    pill.textContent = statusLabel(task.status);
    const actions = document.createElement("div");
    actions.className = "task-actions";
    actions.append(taskActions(task));
    item.append(copy, pill, actions);
    return item;
  }

  function jobMatchesFilter(job, filter) {
    if (filter === "all") {
      return true;
    }
    if (filter === "active") {
      return ["queued", "starting", "in_progress", "active", "paused"].includes(job.status);
    }
    if (filter === "failed") {
      return ["failed", "interrupted", "partial"].includes(job.status);
    }
    return job.status === filter;
  }

  function renderJob(job) {
    const card = document.createElement("article");
    card.className = "job-card";
    const header = document.createElement("div");
    header.className = "job-header";
    const copy = document.createElement("div");
    copy.className = "job-copy";
    const title = document.createElement("strong");
    title.className = "job-title";
    title.textContent = job.label || job.folder || "Download batch";
    title.title = title.textContent;
    const meta = document.createElement("span");
    meta.className = "job-meta";
    const counts = job.counts || {};
    const destination = job.folder ? ` · Downloads/${job.folder}` : "";
    meta.textContent = `${formatDate(job.createdAt)} · ${Number(counts.complete || 0).toLocaleString()} of ${Number(counts.total || 0).toLocaleString()} complete${destination}`;
    meta.title = meta.textContent;
    copy.append(title, meta);
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

    const progress = document.createElement("progress");
    progress.className = "job-progress";
    progress.max = Math.max(1, Number(counts.total) || 1);
    progress.value = Math.min(progress.max, Number(counts.complete || 0) + Number(counts.failed || 0) + Number(counts.cancelled || 0));
    card.append(progress);

    const tasks = Array.isArray(job.tasks) ? job.tasks : [];
    if (job.historyOnly) {
      const note = document.createElement("p");
      note.className = "history-note";
      note.textContent = "History summary · detailed file rows were cleared to keep the queue compact.";
      card.append(note);
      return card;
    }
    const expanded = expandedJobs.has(job.id);
    const visible = expanded ? tasks : tasks.slice(0, INITIAL_TASK_LIMIT);
    const list = document.createElement("ol");
    list.className = "task-list";
    visible.forEach((task) => list.append(renderTask(task)));
    card.append(list);
    if (tasks.length > INITIAL_TASK_LIMIT) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "show-more-button";
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

    elements["completed-stat"].textContent = completed.toLocaleString();
    elements["completed-detail"].textContent = `${todayCompleted.toLocaleString()} completed · ${todayFailed.toLocaleString()} failed · ${todayCancelled.toLocaleString()} cancelled today`;
    elements["bytes-stat"].textContent = formatBytes(lifetime.bytes);
    elements["bytes-detail"].textContent = `${formatBytes(today.bytes)} today`;
    elements["success-stat"].textContent = finished ? `${Math.round((completed / finished) * 100)}%` : "—";
    elements["success-detail"].textContent = todayFinished
      ? `${Math.round((todayCompleted / todayFinished) * 100)}% success today · ${failed.toLocaleString()} failed · ${cancelled.toLocaleString()} cancelled lifetime`
      : `No finished files today · ${failed.toLocaleString()} failed · ${cancelled.toLocaleString()} cancelled lifetime`;
    elements["queue-stat"].textContent = (queued + active + paused).toLocaleString();
    elements["queue-detail"].textContent = active
      ? `${active.toLocaleString()} active · ${queued.toLocaleString()} waiting`
      : paused
        ? `${paused.toLocaleString()} paused`
        : queued
          ? `${queued.toLocaleString()} waiting`
          : "Nothing active";

    const total = Number(summary.total) || 0;
    const terminal = Number(summary.complete || 0) + Number(summary.failed || 0) + Number(summary.cancelled || 0);
    elements["queue-progress"].max = Math.max(1, total);
    elements["queue-progress"].value = Math.min(elements["queue-progress"].max, terminal);
    elements["queue-description"].textContent = queued + active + paused
      ? `${active.toLocaleString()} downloading, ${queued.toLocaleString()} queued, ${paused.toLocaleString()} paused.`
      : total
        ? "All recorded downloads are finished."
        : "No downloads are queued.";
    elements["dashboard-subtitle"].textContent = privateContext
      ? "Private queue · kept in memory until Firefox closes"
      : `${Number(data.jobs && data.jobs.length || 0).toLocaleString()} recent batch${data.jobs && data.jobs.length === 1 ? "" : "es"}`;

    elements["pause-all-button"].disabled = active + queued === 0;
    elements["resume-all-button"].disabled = paused === 0;
    elements["cancel-pending-button"].disabled = active + queued + paused === 0;
    elements["retry-failed-button"].disabled = currentFailed === 0;
    elements["retry-failed-button"].hidden = currentFailed === 0;
    elements["clear-completed-button"].disabled = !(Array.isArray(data.jobs) &&
      data.jobs.some((job) => !job.historyOnly && job.status === "complete"));

    const filter = elements["status-filter"].value;
    const jobs = (Array.isArray(data.jobs) ? data.jobs : []).filter((job) => jobMatchesFilter(job, filter));
    elements["job-list"].replaceChildren(...jobs.map(renderJob));
    elements["history-empty"].hidden = jobs.length > 0;
    elements["history-empty"].textContent = data.jobs && data.jobs.length
      ? "No download batches match this status."
      : "No downloads have been recorded yet.";
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
    try {
      const response = await browser.runtime.sendMessage({
        type: "GET_DOWNLOAD_DASHBOARD",
        incognito: privateContext
      });
      if (!response || !response.ok || !response.snapshot) {
        throw new Error(response && response.error || "The download queue did not respond.");
      }
      snapshot = response.snapshot;
      setError("");
      render();
    } catch (error) {
      setError(error && error.message ? error.message : String(error));
    } finally {
      refreshing = false;
      elements["refresh-button"].disabled = false;
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
    if (!canOpenFolder) {
      elements["open-folder-button"].title = "Firefox cannot open the Downloads folder in this environment.";
    }
    elements["open-folder-button"].addEventListener("click", () => performDownloadsAction(
      "showDefaultFolder",
      [],
      "Firefox cannot open the Downloads folder."
    ));
    elements["status-filter"].addEventListener("change", render);
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
