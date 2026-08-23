(function attachImageDownloaderDownloadQueue(root) {
  "use strict";

  const SCHEMA_VERSION = 1;
  const MAX_BATCH_SIZE = 1500;
  const MAX_STORED_TASKS = 1500;
  const MAX_STORED_JOBS = 100;
  const MAX_HISTORY_ITEMS = 100;
  const MAX_BATCH_TOTAL_URL_LENGTH = 2000000;
  const MAX_HTTP_URL_LENGTH = 16384;
  const MAX_DATA_URL_LENGTH = 500000;
  const MAX_CONCURRENCY = 16;
  const MAX_ID_LENGTH = 128;
  const MAX_LABEL_LENGTH = 200;
  const MAX_FOLDER_LENGTH = 240;
  const MAX_FILENAME_LENGTH = 180;
  const MAX_ERROR_LENGTH = 500;
  const MAX_SOURCE_LENGTH = 500;
  const TERMINAL_STATUSES = new Set(["complete", "interrupted", "cancelled"]);
  const TASK_STATUSES = new Set([
    "queued",
    "starting",
    "in_progress",
    "paused",
    "complete",
    "interrupted",
    "cancelled"
  ]);
  const ACTIVE_STATUSES = new Set(["starting", "in_progress"]);
  let generatedIdSequence = 0;

  function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function read(value, key, fallback) {
    if (!isRecord(value)) {
      return fallback;
    }
    try {
      return value[key];
    } catch (_error) {
      return fallback;
    }
  }

  function finiteInteger(value, fallback, maximum) {
    let number;
    try {
      number = Number(value);
    } catch (_error) {
      return fallback;
    }
    if (!Number.isFinite(number)) {
      return fallback;
    }
    return Math.min(maximum, Math.max(0, Math.floor(number)));
  }

  function timestamp(value, fallback) {
    const result = finiteInteger(value, fallback, Number.MAX_SAFE_INTEGER);
    return result > 0 ? result : fallback;
  }

  function resolveNow(input) {
    let value = input;
    if (typeof input === "function") {
      try {
        value = input();
      } catch (_error) {
        value = undefined;
      }
    }
    return timestamp(value, Date.now());
  }

  function boundedString(value, maximum, fallback) {
    let text;
    try {
      text = String(value == null ? "" : value);
    } catch (_error) {
      return fallback || "";
    }
    return text.slice(0, maximum) || fallback || "";
  }

  function safeId(value) {
    return boundedString(value, MAX_ID_LENGTH, "")
      .replace(/[^a-z0-9._:-]/gi, "-")
      .replace(/-+/g, "-")
      .replace(/^[-.:]+|[-.:]+$/g, "");
  }

  function nextGeneratedId(kind, now) {
    generatedIdSequence = (generatedIdSequence + 1) % 0x1000000;
    let random = "";
    try {
      if (root.crypto && typeof root.crypto.getRandomValues === "function") {
        const values = new Uint32Array(1);
        root.crypto.getRandomValues(values);
        random = values[0].toString(36);
      }
    } catch (_error) {
      random = "";
    }
    return `${kind}-${now.toString(36)}-${generatedIdSequence.toString(36)}${random ? `-${random}` : ""}`;
  }

  function makeUniqueId(kind, now, idFactory, index, usedIds) {
    let candidate = "";
    if (typeof idFactory === "function") {
      try {
        candidate = safeId(idFactory(kind, index));
      } catch (_error) {
        candidate = "";
      }
    }
    candidate = candidate || nextGeneratedId(kind, now);
    let unique = candidate;
    let suffix = 2;
    while (usedIds.has(unique)) {
      unique = boundedString(`${candidate}-${suffix}`, MAX_ID_LENGTH, "");
      suffix += 1;
    }
    usedIds.add(unique);
    return unique;
  }

  function dayKey(input) {
    const now = resolveNow(input);
    let date = new Date(now);
    if (!Number.isFinite(date.getTime())) {
      date = new Date();
    }
    return [
      String(date.getFullYear()).padStart(4, "0"),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0")
    ].join("-");
  }

  function emptyCounter() {
    return {
      enqueued: 0,
      completed: 0,
      interrupted: 0,
      cancelled: 0,
      bytesDownloaded: 0
    };
  }

  function normalizeCounter(value) {
    return {
      enqueued: finiteInteger(read(value, "enqueued", 0), 0, Number.MAX_SAFE_INTEGER),
      completed: finiteInteger(read(value, "completed", 0), 0, Number.MAX_SAFE_INTEGER),
      interrupted: finiteInteger(read(value, "interrupted", 0), 0, Number.MAX_SAFE_INTEGER),
      cancelled: finiteInteger(read(value, "cancelled", 0), 0, Number.MAX_SAFE_INTEGER),
      bytesDownloaded: finiteInteger(read(value, "bytesDownloaded", 0), 0, Number.MAX_SAFE_INTEGER)
    };
  }

  function emptyState(input) {
    const now = resolveNow(input);
    return {
      schemaVersion: SCHEMA_VERSION,
      jobs: [],
      history: [],
      stats: {
        lifetime: emptyCounter(),
        today: { date: dayKey(now), ...emptyCounter() }
      }
    };
  }

  function validateUrl(value) {
    if (typeof value !== "string" || !value) {
      return { ok: false, error: "Missing media URL." };
    }
    if (value.startsWith("data:")) {
      if (!/^data:(?:image|video)\/[a-z0-9.+-]+[;,]/i.test(value)) {
        return { ok: false, error: "Only image and video data URLs are allowed." };
      }
      if (value.length > MAX_DATA_URL_LENGTH) {
        return { ok: false, error: "Embedded media URL is too long." };
      }
      return { ok: true, value };
    }
    if (value.length > MAX_HTTP_URL_LENGTH) {
      return { ok: false, error: "Media URL is too long." };
    }
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return { ok: false, error: "Unsupported media URL scheme." };
      }
      parsed.hash = "";
      return { ok: true, value: parsed.href };
    } catch (_error) {
      return { ok: false, error: "Invalid media URL." };
    }
  }

  function normalizeDownloadId(value) {
    return Number.isInteger(value) && value >= 0 ? value : null;
  }

  function normalizeTask(value, jobId, fallbackNow, usedTaskIds, recoverInFlight) {
    if (!isRecord(value)) {
      return null;
    }
    const urlResult = validateUrl(read(value, "url", ""));
    if (!urlResult.ok) {
      return null;
    }
    let id = safeId(read(value, "id", ""));
    if (!id || usedTaskIds.has(id)) {
      id = makeUniqueId("task", fallbackNow, null, usedTaskIds.size, usedTaskIds);
    } else {
      usedTaskIds.add(id);
    }
    const createdAt = timestamp(read(value, "createdAt", fallbackNow), fallbackNow);
    let status = boundedString(read(value, "status", "queued"), 32, "queued");
    status = TASK_STATUSES.has(status) ? status : "queued";
    const downloadId = normalizeDownloadId(read(value, "downloadId", null));
    if (recoverInFlight && status === "starting" && downloadId === null) {
      status = "queued";
    }
    if (status === "in_progress" && downloadId === null) {
      status = "queued";
    }
    const attempt = Math.max(1, finiteInteger(read(value, "attempt", 1), 1, 1000000));
    let recordedAttempt = finiteInteger(read(value, "recordedAttempt", 0), 0, attempt);
    if (TERMINAL_STATUSES.has(status) && recordedAttempt === 0) {
      recordedAttempt = attempt;
    }
    const bytesReceived = finiteInteger(read(value, "bytesReceived", 0), 0, Number.MAX_SAFE_INTEGER);
    const totalBytes = finiteInteger(read(value, "totalBytes", 0), 0, Number.MAX_SAFE_INTEGER);
    return {
      id,
      jobId,
      url: urlResult.value,
      filename: boundedString(read(value, "filename", ""), MAX_FILENAME_LENGTH, ""),
      status,
      downloadId,
      attempt,
      recordedAttempt,
      needsReconciliation: Boolean(read(value, "needsReconciliation", false)) &&
        TERMINAL_STATUSES.has(status) && downloadId !== null,
      bytesReceived: totalBytes > 0 ? Math.min(bytesReceived, totalBytes) : bytesReceived,
      totalBytes,
      error: boundedString(read(value, "error", ""), MAX_ERROR_LENGTH, ""),
      createdAt,
      updatedAt: timestamp(read(value, "updatedAt", createdAt), createdAt),
      completedAt: TERMINAL_STATUSES.has(status)
        ? timestamp(read(value, "completedAt", read(value, "updatedAt", createdAt)), createdAt)
        : 0
    };
  }

  function deriveJobStatus(tasks) {
    if (!tasks.length) {
      return "complete";
    }
    if (tasks.some((task) => task.status === "in_progress")) {
      return "in_progress";
    }
    if (tasks.some((task) => task.status === "starting")) {
      return "starting";
    }
    if (tasks.some((task) => task.status === "queued")) {
      return "queued";
    }
    if (tasks.some((task) => task.status === "paused")) {
      return "paused";
    }
    if (tasks.some((task) => task.status === "interrupted")) {
      return "interrupted";
    }
    if (tasks.some((task) => task.status === "cancelled")) {
      return "cancelled";
    }
    return "complete";
  }

  function normalizeJob(
    value,
    fallbackNow,
    usedJobIds,
    usedTaskIds,
    remainingCapacity,
    remainingUrlLength,
    recoverInFlight
  ) {
    if (!isRecord(value) || remainingCapacity <= 0) {
      return null;
    }
    let id = safeId(read(value, "id", ""));
    if (!id || usedJobIds.has(id)) {
      id = makeUniqueId("job", fallbackNow, null, usedJobIds.size, usedJobIds);
    } else {
      usedJobIds.add(id);
    }
    const createdAt = timestamp(read(value, "createdAt", fallbackNow), fallbackNow);
    let rawTasks;
    try {
      rawTasks = Array.isArray(value.tasks) ? value.tasks : [];
    } catch (_error) {
      rawTasks = [];
    }
    const tasks = [];
    let totalUrlLength = 0;
    for (const rawTask of rawTasks.slice(0, remainingCapacity)) {
      const task = normalizeTask(rawTask, id, createdAt, usedTaskIds, recoverInFlight);
      if (!task || totalUrlLength + task.url.length > remainingUrlLength) {
        continue;
      }
      totalUrlLength += task.url.length;
      tasks.push(task);
    }
    if (!tasks.length) {
      return null;
    }
    const status = deriveJobStatus(tasks);
    const terminal = TERMINAL_STATUSES.has(status);
    const taskFinishedAt = terminal
      ? tasks.reduce((latest, task) => Math.max(latest, task.completedAt || 0), 0)
      : 0;
    return {
      id,
      label: boundedString(read(value, "label", "Download"), MAX_LABEL_LENGTH, "Download"),
      folder: boundedString(read(value, "folder", ""), MAX_FOLDER_LENGTH, ""),
      source: boundedString(read(value, "source", ""), MAX_SOURCE_LENGTH, ""),
      saveAs: read(value, "saveAs", false) === true,
      status,
      createdAt,
      updatedAt: timestamp(read(value, "updatedAt", createdAt), createdAt),
      finishedAt: terminal
        ? taskFinishedAt || timestamp(
          read(value, "finishedAt", read(value, "updatedAt", createdAt)),
          createdAt
        )
        : 0,
      historyRecorded: Boolean(read(value, "historyRecorded", false)),
      tasks
    };
  }

  function normalizeHistoryItem(value, fallbackNow) {
    if (!isRecord(value)) {
      return null;
    }
    const jobId = safeId(read(value, "jobId", ""));
    if (!jobId) {
      return null;
    }
    const status = boundedString(read(value, "status", "complete"), 32, "complete");
    return {
      jobId,
      label: boundedString(read(value, "label", "Download"), MAX_LABEL_LENGTH, "Download"),
      folder: boundedString(read(value, "folder", ""), MAX_FOLDER_LENGTH, ""),
      status: TERMINAL_STATUSES.has(status) ? status : "complete",
      createdAt: timestamp(read(value, "createdAt", fallbackNow), fallbackNow),
      finishedAt: timestamp(read(value, "finishedAt", fallbackNow), fallbackNow),
      total: finiteInteger(read(value, "total", 0), 0, MAX_STORED_TASKS),
      completed: finiteInteger(read(value, "completed", 0), 0, MAX_STORED_TASKS),
      interrupted: finiteInteger(read(value, "interrupted", 0), 0, MAX_STORED_TASKS),
      cancelled: finiteInteger(read(value, "cancelled", 0), 0, MAX_STORED_TASKS),
      bytesDownloaded: finiteInteger(read(value, "bytesDownloaded", 0), 0, Number.MAX_SAFE_INTEGER)
    };
  }

  function rebuildStats(jobs, currentDay) {
    const lifetime = emptyCounter();
    const today = { date: currentDay, ...emptyCounter() };
    for (const job of jobs) {
      for (const task of job.tasks) {
        lifetime.enqueued += 1;
        if (dayKey(task.createdAt) === currentDay) {
          today.enqueued += 1;
        }
        if (!TERMINAL_STATUSES.has(task.status)) {
          continue;
        }
        const counterKey = task.status === "complete" ? "completed" : task.status;
        lifetime[counterKey] += 1;
        if (task.status === "complete") {
          lifetime.bytesDownloaded += task.bytesReceived;
        }
        if (dayKey(task.completedAt || task.updatedAt) === currentDay) {
          today[counterKey] += 1;
          if (task.status === "complete") {
            today.bytesDownloaded += task.bytesReceived;
          }
        }
      }
    }
    return { lifetime, today };
  }

  function hydrate(rawState, options) {
    const now = resolveNow(read(options, "now", options));
    if (!isRecord(rawState)) {
      return emptyState(now);
    }
    const storedVersion = finiteInteger(read(rawState, "schemaVersion", 0), 0, 1000000);
    if (storedVersion > SCHEMA_VERSION) {
      return emptyState(now);
    }
    const usedJobIds = new Set();
    const usedTaskIds = new Set();
    const recoverInFlight = read(options, "recoverInFlight", true) !== false;
    const jobs = [];
    let storedUrlLength = 0;
    let rawJobs;
    try {
      rawJobs = Array.isArray(rawState.jobs) ? rawState.jobs : [];
    } catch (_error) {
      rawJobs = [];
    }
    for (const rawJob of rawJobs.slice(0, MAX_STORED_JOBS)) {
      const remainingCapacity = MAX_STORED_TASKS - usedTaskIds.size;
      const job = normalizeJob(
        rawJob,
        now,
        usedJobIds,
        usedTaskIds,
        remainingCapacity,
        MAX_BATCH_TOTAL_URL_LENGTH - storedUrlLength,
        recoverInFlight
      );
      if (job) {
        jobs.push(job);
        storedUrlLength += job.tasks.reduce((sum, task) => sum + task.url.length, 0);
      }
      if (usedTaskIds.size >= MAX_STORED_TASKS || storedUrlLength >= MAX_BATCH_TOTAL_URL_LENGTH) {
        break;
      }
    }

    let rawHistory;
    try {
      rawHistory = Array.isArray(rawState.history) ? rawState.history : [];
    } catch (_error) {
      rawHistory = [];
    }
    const history = rawHistory
      .slice(-MAX_HISTORY_ITEMS)
      .map((item) => normalizeHistoryItem(item, now))
      .filter(Boolean);
    const currentDay = dayKey(now);
    const rawStats = read(rawState, "stats", null);
    const rawLifetime = read(rawStats, "lifetime", null);
    let stats;
    if (isRecord(rawLifetime)) {
      const storedToday = read(rawStats, "today", null);
      stats = {
        lifetime: normalizeCounter(rawLifetime),
        today: boundedString(read(storedToday, "date", ""), 10, "") === currentDay
          ? { date: currentDay, ...normalizeCounter(storedToday) }
          : { date: currentDay, ...emptyCounter() }
      };
    } else {
      stats = rebuildStats(jobs, currentDay);
    }
    return { schemaVersion: SCHEMA_VERSION, jobs, history, stats };
  }

  function cloneState(state, now) {
    return hydrate(state, { now, recoverInFlight: false });
  }

  function rollToday(state, now) {
    const currentDay = dayKey(now);
    if (state.stats.today.date !== currentDay) {
      state.stats.today = { date: currentDay, ...emptyCounter() };
    }
  }

  function addStat(state, key, amount, now, occurredAt) {
    rollToday(state, now);
    const safeAmount = finiteInteger(amount, 0, Number.MAX_SAFE_INTEGER);
    state.stats.lifetime[key] = Math.min(
      Number.MAX_SAFE_INTEGER,
      state.stats.lifetime[key] + safeAmount
    );
    if (dayKey(occurredAt === undefined ? now : occurredAt) === state.stats.today.date) {
      state.stats.today[key] = Math.min(
        Number.MAX_SAFE_INTEGER,
        state.stats.today[key] + safeAmount
      );
    }
  }

  function allUsedIds(state) {
    const ids = new Set();
    for (const job of state.jobs) {
      ids.add(job.id);
      for (const task of job.tasks) {
        ids.add(task.id);
      }
    }
    return ids;
  }

  function enqueueBatch(inputState, items, options) {
    const now = resolveNow(read(options, "now", undefined));
    const state = cloneState(inputState, now);
    const rejected = [];
    if (!Array.isArray(items)) {
      return { state, jobId: null, accepted: 0, acceptedIndexes: [], rejected: [{ index: -1, error: "Items must be an array." }] };
    }
    const capacity = state.jobs.length >= MAX_STORED_JOBS
      ? 0
      : Math.max(
        0,
        MAX_STORED_TASKS - state.jobs.reduce((sum, job) => sum + job.tasks.length, 0)
      );
    const urlCapacity = Math.max(
      0,
      MAX_BATCH_TOTAL_URL_LENGTH - state.jobs.reduce(
        (sum, job) => sum + job.tasks.reduce((taskSum, task) => taskSum + task.url.length, 0),
        0
      )
    );
    const limit = Math.min(items.length, MAX_BATCH_SIZE, capacity);
    const acceptedItems = [];
    let totalUrlLength = 0;
    for (let index = 0; index < limit; index += 1) {
      const input = items[index];
      const rawUrl = typeof input === "string" ? input : read(input, "url", "");
      const result = validateUrl(rawUrl);
      if (!result.ok) {
        rejected.push({ index, error: result.error });
        continue;
      }
      if (totalUrlLength + result.value.length > urlCapacity) {
        rejected.push({ index, error: "Batch URL data is too large." });
        continue;
      }
      totalUrlLength += result.value.length;
      acceptedItems.push({
        originalIndex: index,
        url: result.value,
        filename: boundedString(read(input, "filename", ""), MAX_FILENAME_LENGTH, "")
      });
    }
    if (items.length > limit) {
      rejected.push({
        index: limit,
        count: items.length - limit,
        error: capacity <= limit ? "Queue capacity reached." : "Batch item limit reached."
      });
    }
    if (!acceptedItems.length) {
      return { state, jobId: null, accepted: 0, acceptedIndexes: [], rejected };
    }

    const usedIds = allUsedIds(state);
    const idFactory = read(options, "idFactory", null);
    const jobId = makeUniqueId("job", now, idFactory, 0, usedIds);
    const tasks = acceptedItems.map((item, index) => ({
      id: makeUniqueId("task", now, idFactory, index, usedIds),
      jobId,
      url: item.url,
      filename: item.filename,
      status: "queued",
      downloadId: null,
      attempt: 1,
      recordedAttempt: 0,
      needsReconciliation: false,
      bytesReceived: 0,
      totalBytes: 0,
      error: "",
      createdAt: now,
      updatedAt: now,
      completedAt: 0
    }));
    state.jobs.push({
      id: jobId,
      label: boundedString(read(options, "label", "Download"), MAX_LABEL_LENGTH, "Download"),
      folder: boundedString(read(options, "folder", ""), MAX_FOLDER_LENGTH, ""),
      source: boundedString(read(options, "source", ""), MAX_SOURCE_LENGTH, ""),
      saveAs: read(options, "saveAs", false) === true,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      finishedAt: 0,
      historyRecorded: false,
      tasks
    });
    addStat(state, "enqueued", tasks.length, now);
    return {
      state,
      jobId,
      accepted: tasks.length,
      acceptedIndexes: acceptedItems.map((item) => item.originalIndex),
      rejected
    };
  }

  function locateTask(state, taskId) {
    const safeTaskId = safeId(taskId);
    for (const job of state.jobs) {
      const task = job.tasks.find((candidate) => candidate.id === safeTaskId);
      if (task) {
        return { job, task };
      }
    }
    return null;
  }

  function historySummary(job) {
    const summary = progressSummaryForJob(job);
    return {
      jobId: job.id,
      label: job.label,
      folder: job.folder,
      status: job.status,
      createdAt: job.createdAt,
      finishedAt: job.finishedAt,
      total: summary.total,
      completed: summary.complete,
      interrupted: summary.interrupted,
      cancelled: summary.cancelled,
      bytesDownloaded: job.tasks.reduce(
        (sum, task) => sum + (task.status === "complete" ? task.bytesReceived : 0),
        0
      )
    };
  }

  function refreshJob(state, job, now) {
    job.status = deriveJobStatus(job.tasks);
    job.updatedAt = now;
    if (TERMINAL_STATUSES.has(job.status)) {
      job.finishedAt = job.tasks.reduce(
        (latest, task) => Math.max(latest, task.completedAt || 0),
        0
      ) || now;
      if (!job.historyRecorded) {
        state.history = state.history.filter((item) => item.jobId !== job.id);
        state.history.push(historySummary(job));
        state.history = state.history.slice(-MAX_HISTORY_ITEMS);
        job.historyRecorded = true;
      } else {
        const index = state.history.findIndex((item) => item.jobId === job.id);
        if (index >= 0) {
          state.history[index] = historySummary(job);
        }
      }
    } else {
      job.finishedAt = 0;
    }
  }

  function recordOutcome(state, task, now) {
    if (!TERMINAL_STATUSES.has(task.status) || task.recordedAttempt === task.attempt) {
      return;
    }
    task.recordedAttempt = task.attempt;
    if (task.status === "complete") {
      addStat(state, "completed", 1, now, task.completedAt || now);
      addStat(state, "bytesDownloaded", task.bytesReceived, now, task.completedAt || now);
    } else {
      addStat(state, task.status, 1, now, task.completedAt || now);
    }
  }

  function claimNextTasks(inputState, options) {
    const now = resolveNow(read(options, "now", undefined));
    const state = cloneState(inputState, now);
    const requested = finiteInteger(read(options, "concurrency", 1), 1, MAX_CONCURRENCY) || 1;
    const active = state.jobs.reduce(
      (count, job) => count + job.tasks.filter((task) => ACTIVE_STATUSES.has(task.status)).length,
      0
    );
    let available = Math.max(0, requested - active);
    const tasks = [];
    for (const job of state.jobs) {
      for (const task of job.tasks) {
        if (!available) {
          break;
        }
        if (task.status !== "queued") {
          continue;
        }
        task.status = "starting";
        task.updatedAt = now;
        job.updatedAt = now;
        tasks.push({
          id: task.id,
          jobId: job.id,
          url: task.url,
          filename: task.filename,
          folder: job.folder,
          source: job.source,
          saveAs: job.saveAs,
          attempt: task.attempt
        });
        available -= 1;
      }
      job.status = deriveJobStatus(job.tasks);
    }
    return { state, tasks };
  }

  function bindDownload(inputState, taskId, downloadId, options) {
    const now = resolveNow(read(options, "now", undefined));
    const state = cloneState(inputState, now);
    const found = locateTask(state, taskId);
    const safeDownloadId = normalizeDownloadId(downloadId);
    if (!found || safeDownloadId === null || TERMINAL_STATUSES.has(found.task.status)) {
      return state;
    }
    found.task.downloadId = safeDownloadId;
    found.task.status = "in_progress";
    found.task.needsReconciliation = false;
    found.task.updatedAt = now;
    refreshJob(state, found.job, now);
    return state;
  }

  function deltaCurrent(value, fallback) {
    if (isRecord(value) && Object.prototype.hasOwnProperty.call(value, "current")) {
      return read(value, "current", fallback);
    }
    return value === undefined ? fallback : value;
  }

  function snapshotTotalBytes(snapshot, fallback) {
    const safeFallback = finiteInteger(fallback, 0, Number.MAX_SAFE_INTEGER);
    const totalBytes = finiteInteger(
      read(snapshot, "totalBytes", safeFallback),
      safeFallback,
      Number.MAX_SAFE_INTEGER
    );
    if (totalBytes > 0) {
      return totalBytes;
    }
    const fileSize = finiteInteger(
      read(snapshot, "fileSize", 0),
      0,
      Number.MAX_SAFE_INTEGER
    );
    return fileSize > 0 ? fileSize : safeFallback;
  }

  function snapshotCompletionTimestamp(snapshot, task, now, fallback) {
    const rawEndTime = read(snapshot, "endTime", undefined);
    if (typeof rawEndTime !== "string" || !rawEndTime.trim()) {
      return fallback;
    }
    let parsed;
    try {
      parsed = Date.parse(rawEndTime);
    } catch (_error) {
      return fallback;
    }
    if (!Number.isFinite(parsed)) {
      return fallback;
    }
    const createdAt = timestamp(read(task, "createdAt", now), now);
    const lowerBound = Math.min(createdAt, now);
    return Math.min(now, Math.max(lowerBound, Math.floor(parsed)));
  }

  function reattributeTodayOutcome(state, task, previousCompletedAt, now) {
    if (
      !previousCompletedAt
      || task.recordedAttempt !== task.attempt
      || !TERMINAL_STATUSES.has(task.status)
    ) {
      return;
    }
    rollToday(state, now);
    const wasToday = dayKey(previousCompletedAt) === state.stats.today.date;
    const isToday = dayKey(task.completedAt || now) === state.stats.today.date;
    if (wasToday === isToday) {
      return;
    }
    const key = task.status === "complete" ? "completed" : task.status;
    const direction = isToday ? 1 : -1;
    state.stats.today[key] = Math.max(
      0,
      Math.min(Number.MAX_SAFE_INTEGER, state.stats.today[key] + direction)
    );
    if (task.status === "complete") {
      state.stats.today.bytesDownloaded = Math.max(
        0,
        Math.min(
          Number.MAX_SAFE_INTEGER,
          state.stats.today.bytesDownloaded + (direction * task.bytesReceived)
        )
      );
    }
  }

  function addReconciledBytes(state, task, amount, now) {
    const safeAmount = finiteInteger(amount, 0, Number.MAX_SAFE_INTEGER);
    if (!safeAmount) {
      return;
    }
    rollToday(state, now);
    state.stats.lifetime.bytesDownloaded = Math.min(
      Number.MAX_SAFE_INTEGER,
      state.stats.lifetime.bytesDownloaded + safeAmount
    );
    if (dayKey(task.completedAt || now) === state.stats.today.date) {
      state.stats.today.bytesDownloaded = Math.min(
        Number.MAX_SAFE_INTEGER,
        state.stats.today.bytesDownloaded + safeAmount
      );
    }
  }

  function enrichTerminalTask(state, found, snapshot, now, reconciled) {
    const task = found.task;
    const snapshotState = boundedString(read(snapshot, "state", ""), 32, "");
    const compatibleState = !snapshotState || snapshotState === task.status;
    if (!compatibleState) {
      return false;
    }
    const previousCompletedAt = task.completedAt;
    task.completedAt = snapshotCompletionTimestamp(
      snapshot,
      task,
      now,
      task.completedAt || now
    );
    if (task.completedAt !== previousCompletedAt) {
      reattributeTodayOutcome(state, task, previousCompletedAt, now);
    }
    const previousBytes = task.bytesReceived;
    const snapshotBytes = finiteInteger(
      read(snapshot, "bytesReceived", previousBytes),
      previousBytes,
      Number.MAX_SAFE_INTEGER
    );
    const snapshotTotal = snapshotTotalBytes(snapshot, task.totalBytes);
    task.totalBytes = Math.max(task.totalBytes, snapshotTotal);
    task.bytesReceived = Math.max(task.bytesReceived, snapshotBytes);
    if (task.status === "complete" && task.totalBytes > 0) {
      task.bytesReceived = Math.max(task.bytesReceived, task.totalBytes);
    }
    task.filename = boundedString(
      read(snapshot, "filename", task.filename),
      MAX_FILENAME_LENGTH,
      task.filename
    );
    task.error = boundedString(
      read(snapshot, "error", task.error),
      MAX_ERROR_LENGTH,
      task.error
    );
    if (task.status === "complete") {
      addReconciledBytes(state, task, task.bytesReceived - previousBytes, now);
    }
    if (reconciled) {
      task.needsReconciliation = false;
    }
    task.updatedAt = now;
    refreshJob(state, found.job, now);
    return true;
  }

  function applySnapshotToTask(state, found, snapshot, now, reconciled) {
    const task = found.task;
    if (TERMINAL_STATUSES.has(task.status)) {
      return enrichTerminalTask(state, found, snapshot, now, reconciled);
    }
    const snapshotState = boundedString(read(snapshot, "state", ""), 32, "");
    const pausedValue = read(snapshot, "paused", undefined);
    const bytesReceived = finiteInteger(read(snapshot, "bytesReceived", task.bytesReceived), task.bytesReceived, Number.MAX_SAFE_INTEGER);
    const totalBytes = snapshotTotalBytes(snapshot, task.totalBytes);
    task.bytesReceived = totalBytes > 0 ? Math.min(bytesReceived, totalBytes) : bytesReceived;
    task.totalBytes = totalBytes;
    task.filename = boundedString(read(snapshot, "filename", task.filename), MAX_FILENAME_LENGTH, task.filename);
    task.error = boundedString(read(snapshot, "error", task.error), MAX_ERROR_LENGTH, task.error);
    if (snapshotState === "complete") {
      task.status = "complete";
      if (task.totalBytes > 0) {
        task.bytesReceived = task.totalBytes;
      }
      task.completedAt = snapshotCompletionTimestamp(snapshot, task, now, now);
    } else if (snapshotState === "interrupted") {
      task.status = "interrupted";
      task.completedAt = snapshotCompletionTimestamp(snapshot, task, now, now);
    } else if (pausedValue === true) {
      task.status = "paused";
    } else if (pausedValue === false || snapshotState === "in_progress") {
      task.status = "in_progress";
    }
    task.needsReconciliation = TERMINAL_STATUSES.has(task.status) && !reconciled;
    task.updatedAt = now;
    recordOutcome(state, task, now);
    refreshJob(state, found.job, now);
    return true;
  }

  function applyDownloadSnapshot(inputState, snapshot, options) {
    const now = resolveNow(read(options, "now", undefined));
    const reconciled = read(options, "reconciled", true) !== false;
    const state = cloneState(inputState, now);
    if (!isRecord(snapshot)) {
      return state;
    }
    const downloadId = normalizeDownloadId(read(snapshot, "id", null));
    if (downloadId === null) {
      return state;
    }
    for (const job of state.jobs) {
      const task = job.tasks.find((candidate) => candidate.downloadId === downloadId);
      if (task) {
        applySnapshotToTask(state, { job, task }, snapshot, now, reconciled);
        break;
      }
    }
    return state;
  }

  function applyDownloadSnapshots(inputState, snapshots, options) {
    const now = resolveNow(read(options, "now", undefined));
    const reconciled = read(options, "reconciled", true) !== false;
    const state = cloneState(inputState, now);
    if (!Array.isArray(snapshots)) {
      return state;
    }
    const tasksByDownloadId = new Map();
    for (const job of state.jobs) {
      for (const task of job.tasks) {
        if (task.downloadId !== null) {
          tasksByDownloadId.set(task.downloadId, { job, task });
        }
      }
    }
    const matchedDownloadIds = new Set();
    for (const snapshot of snapshots.slice(0, MAX_STORED_TASKS)) {
      if (!isRecord(snapshot)) {
        continue;
      }
      const downloadId = normalizeDownloadId(read(snapshot, "id", null));
      const found = downloadId === null ? null : tasksByDownloadId.get(downloadId);
      if (found) {
        matchedDownloadIds.add(downloadId);
        applySnapshotToTask(state, found, snapshot, now, reconciled);
      }
    }
    if (read(options, "markMissing", false) === true) {
      for (const [downloadId, found] of tasksByDownloadId) {
        if (matchedDownloadIds.has(downloadId)) {
          continue;
        }
        if (TERMINAL_STATUSES.has(found.task.status)) {
          found.task.needsReconciliation = false;
          continue;
        }
        found.task.status = "interrupted";
        found.task.needsReconciliation = false;
        found.task.error = "Download no longer exists in Firefox history.";
        found.task.updatedAt = now;
        found.task.completedAt = now;
        recordOutcome(state, found.task, now);
        refreshJob(state, found.job, now);
      }
    }
    return state;
  }

  function applyDownloadChange(inputState, downloadId, change, options) {
    if (!isRecord(change)) {
      return cloneState(inputState, resolveNow(read(options, "now", undefined)));
    }
    const snapshot = {
      id: downloadId,
      state: deltaCurrent(read(change, "state", undefined), undefined),
      paused: deltaCurrent(read(change, "paused", undefined), undefined),
      bytesReceived: deltaCurrent(read(change, "bytesReceived", undefined), undefined),
      totalBytes: deltaCurrent(read(change, "totalBytes", undefined), undefined),
      fileSize: deltaCurrent(read(change, "fileSize", undefined), undefined),
      endTime: deltaCurrent(read(change, "endTime", undefined), undefined),
      filename: deltaCurrent(read(change, "filename", undefined), undefined),
      error: deltaCurrent(read(change, "error", undefined), undefined)
    };
    return applyDownloadSnapshot(inputState, snapshot, {
      now: read(options, "now", undefined),
      reconciled: false
    });
  }

  function setTaskPaused(inputState, taskId, paused, options) {
    const now = resolveNow(read(options, "now", undefined));
    const state = cloneState(inputState, now);
    const found = locateTask(state, taskId);
    if (!found || TERMINAL_STATUSES.has(found.task.status)) {
      return state;
    }
    if (paused && ["queued", "starting", "in_progress"].includes(found.task.status)) {
      found.task.status = "paused";
    } else if (!paused && found.task.status === "paused") {
      found.task.status = found.task.downloadId === null ? "queued" : "in_progress";
    }
    found.task.updatedAt = now;
    refreshJob(state, found.job, now);
    return state;
  }

  function setTasksPaused(inputState, taskIds, paused, options) {
    const now = resolveNow(read(options, "now", undefined));
    const state = cloneState(inputState, now);
    const ids = new Set(
      Array.isArray(taskIds) ? taskIds.map(safeId).filter(Boolean) : []
    );
    let updated = 0;
    for (const job of state.jobs) {
      let jobChanged = false;
      for (const task of job.tasks) {
        if (!ids.has(task.id) || TERMINAL_STATUSES.has(task.status)) {
          continue;
        }
        if (paused && ["queued", "starting", "in_progress"].includes(task.status)) {
          task.status = "paused";
        } else if (!paused && task.status === "paused") {
          task.status = task.downloadId === null ? "queued" : "in_progress";
        } else {
          continue;
        }
        task.updatedAt = now;
        updated += 1;
        jobChanged = true;
      }
      if (jobChanged) {
        refreshJob(state, job, now);
      }
    }
    return { state, updated };
  }

  function cancelTask(inputState, taskId, options) {
    const now = resolveNow(read(options, "now", undefined));
    const state = cloneState(inputState, now);
    const found = locateTask(state, taskId);
    if (!found || TERMINAL_STATUSES.has(found.task.status)) {
      return state;
    }
    found.task.status = "cancelled";
    found.task.needsReconciliation = false;
    found.task.error = boundedString(read(options, "reason", "Cancelled"), MAX_ERROR_LENGTH, "Cancelled");
    found.task.updatedAt = now;
    found.task.completedAt = now;
    recordOutcome(state, found.task, now);
    refreshJob(state, found.job, now);
    return state;
  }

  function cancelTasks(inputState, taskIds, options) {
    const now = resolveNow(read(options, "now", undefined));
    const state = cloneState(inputState, now);
    const ids = new Set(
      Array.isArray(taskIds) ? taskIds.map(safeId).filter(Boolean) : []
    );
    const reason = boundedString(
      read(options, "reason", "Cancelled"),
      MAX_ERROR_LENGTH,
      "Cancelled"
    );
    let cancelled = 0;
    for (const job of state.jobs) {
      let jobChanged = false;
      for (const task of job.tasks) {
        if (!ids.has(task.id) || TERMINAL_STATUSES.has(task.status)) {
          continue;
        }
        task.status = "cancelled";
        task.needsReconciliation = false;
        task.error = reason;
        task.updatedAt = now;
        task.completedAt = now;
        recordOutcome(state, task, now);
        cancelled += 1;
        jobChanged = true;
      }
      if (jobChanged) {
        refreshJob(state, job, now);
      }
    }
    return { state, cancelled };
  }

  function interruptTask(inputState, taskId, error, options) {
    const now = resolveNow(read(options, "now", undefined));
    const state = cloneState(inputState, now);
    const found = locateTask(state, taskId);
    if (!found || TERMINAL_STATUSES.has(found.task.status)) {
      return state;
    }
    found.task.status = "interrupted";
    found.task.needsReconciliation = false;
    found.task.error = boundedString(error, MAX_ERROR_LENGTH, "Download failed to start.");
    found.task.updatedAt = now;
    found.task.completedAt = now;
    recordOutcome(state, found.task, now);
    refreshJob(state, found.job, now);
    return state;
  }

  function resetTaskForRetry(task, now) {
    // Attempt numbers are the idempotency key used by recordOutcome. Once the
    // bounded counter is exhausted, refusing another retry is safer than
    // counting multiple outcomes against the same attempt.
    if (task.attempt >= 1000000) {
      return false;
    }
    task.status = "queued";
    task.downloadId = null;
    task.attempt += 1;
    task.needsReconciliation = false;
    task.bytesReceived = 0;
    task.totalBytes = 0;
    task.error = "";
    task.updatedAt = now;
    task.completedAt = 0;
    return true;
  }

  function retryFailures(inputState, options) {
    const now = resolveNow(read(options, "now", undefined));
    const state = cloneState(inputState, now);
    const jobId = safeId(read(options, "jobId", ""));
    const includeCancelled = read(options, "includeCancelled", false) === true;
    let retried = 0;
    for (const job of state.jobs) {
      if (jobId && job.id !== jobId) {
        continue;
      }
      let jobRetried = 0;
      for (const task of job.tasks) {
        if (task.status !== "interrupted" && !(includeCancelled && task.status === "cancelled")) {
          continue;
        }
        if (!resetTaskForRetry(task, now)) {
          continue;
        }
        retried += 1;
        jobRetried += 1;
      }
      if (jobRetried) {
        job.historyRecorded = false;
        job.finishedAt = 0;
        state.history = state.history.filter((item) => item.jobId !== job.id);
        refreshJob(state, job, now);
      }
    }
    return { state, retried };
  }

  function retryTask(inputState, taskId, options) {
    const now = resolveNow(read(options, "now", undefined));
    const state = cloneState(inputState, now);
    const found = locateTask(state, taskId);
    const includeCancelled = read(options, "includeCancelled", false) === true;
    if (
      !found
      || (found.task.status !== "interrupted"
        && !(includeCancelled && found.task.status === "cancelled"))
      || !resetTaskForRetry(found.task, now)
    ) {
      return { state, retried: 0 };
    }

    found.job.historyRecorded = false;
    found.job.finishedAt = 0;
    state.history = state.history.filter((item) => item.jobId !== found.job.id);
    refreshJob(state, found.job, now);
    return { state, retried: 1 };
  }

  function clearCompleted(inputState, options) {
    const now = resolveNow(read(options, "now", undefined));
    const state = cloneState(inputState, now);
    let removed = 0;
    state.jobs = state.jobs.filter((job) => {
      if (
        job.status !== "complete"
        || job.tasks.some((task) => task.needsReconciliation)
      ) {
        return true;
      }
      removed += job.tasks.length;
      return false;
    });
    return { state, removed };
  }

  function clearHistory(inputState, options) {
    const now = resolveNow(read(options, "now", undefined));
    const state = cloneState(inputState, now);
    const removed = state.history.length;
    state.history = [];
    return { state, removed };
  }

  function progressSummaryForJob(job) {
    const summary = {
      total: job.tasks.length,
      queued: 0,
      starting: 0,
      in_progress: 0,
      paused: 0,
      complete: 0,
      interrupted: 0,
      cancelled: 0,
      active: 0,
      finished: 0,
      bytesReceived: 0,
      totalBytes: 0,
      percent: 0
    };
    for (const task of job.tasks) {
      summary[task.status] += 1;
      summary.bytesReceived += task.bytesReceived;
      summary.totalBytes += task.totalBytes;
    }
    summary.active = summary.starting + summary.in_progress;
    summary.finished = summary.complete + summary.interrupted + summary.cancelled;
    if (summary.totalBytes > 0) {
      summary.percent = Math.min(100, Math.round((summary.bytesReceived / summary.totalBytes) * 100));
    } else if (summary.total > 0) {
      summary.percent = Math.round((summary.finished / summary.total) * 100);
    }
    return summary;
  }

  function progressSummary(inputState, jobId, options) {
    const now = resolveNow(read(options, "now", undefined));
    const state = cloneState(inputState, now);
    const safeJobId = safeId(jobId);
    if (safeJobId) {
      const job = state.jobs.find((candidate) => candidate.id === safeJobId);
      return job ? progressSummaryForJob(job) : null;
    }
    return progressSummaryForJob({ tasks: state.jobs.flatMap((job) => job.tasks) });
  }

  const api = Object.freeze({
    SCHEMA_VERSION,
    MAX_BATCH_SIZE,
    MAX_STORED_TASKS,
    MAX_STORED_JOBS,
    MAX_HISTORY_ITEMS,
    MAX_BATCH_TOTAL_URL_LENGTH,
    MAX_CONCURRENCY,
    TASK_STATUSES: Object.freeze(Array.from(TASK_STATUSES)),
    emptyState,
    hydrate,
    enqueueBatch,
    claimNextTasks,
    bindDownload,
    applyDownloadChange,
    applyDownloadSnapshot,
    applyDownloadSnapshots,
    setTaskPaused,
    setTasksPaused,
    cancelTask,
    cancelTasks,
    interruptTask,
    retryTask,
    retryFailures,
    clearCompleted,
    clearHistory,
    progressSummary,
    dayKey
  });

  root.ImageDownloaderDownloadQueue = api;
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis === "object" ? globalThis : this);
