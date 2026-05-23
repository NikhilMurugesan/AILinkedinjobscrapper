// LinkedIn Job Scraper — background service worker.
// Implements a parallel-tab scraper: the results-page content script enqueues job
// URLs, this worker opens up to MAX_TABS detail tabs concurrently, injects a
// detail extractor into each, persists jobs (deduplicated by LinkedIn job id),
// and closes the tab. Mirrors the Naukri scraper architecture.

const MAX_TABS = 6;
const TAB_TIMEOUT_MS = 25000;
const TAB_OPEN_DELAY_MIN_MS = 600;
const TAB_OPEN_DELAY_MAX_MS = 1400;

const STORAGE_KEYS = {
  jobsById: "linkedinJobScraper.jobsById",
  state: "linkedinJobScraper.state",
  queue: "linkedinJobScraper.queue",
  activeTasks: "linkedinJobScraper.activeTasks",
  batches: "linkedinJobScraper.batches",
  seenKeys: "linkedinJobScraper.seenKeys"
};

const STATUSES = {
  idle: "idle",
  running: "running",
  paused: "paused",
  stopped: "stopped",
  complete: "complete",
  blocked: "blocked",
  error: "error"
};

const DEFAULT_STATE = {
  status: STATUSES.idle,
  message: "Ready",
  currentAction: "",
  currentJobTitle: "",
  currentPageNumber: null,
  currentPageUrl: "",
  totalEstimate: null,
  scrapedCount: 0,
  queueLength: 0,
  activeTabCount: 0,
  activeTabLimit: MAX_TABS,
  autoContinue: false,
  lastBatchId: "",
  startedAt: null,
  updatedAt: Date.now()
};

const CSV_COLUMNS = [
  ["jobTitle", "Job Title"],
  ["companyName", "Company Name"],
  ["location", "Location"],
  ["city", "City"],
  ["country", "Country"],
  ["jobType", "Job Type"],
  ["workplaceType", "Workplace Type"],
  ["datePosted", "Date Posted"],
  ["jobDescription", "Job Description"],
  ["applyType", "Apply Type"],
  ["directApplyUrl", "Direct Apply Link / External Apply URL"],
  ["linkedinJobId", "LinkedIn Job ID"],
  ["linkedinUrl", "LinkedIn URL"],
  ["seniorityLevel", "Seniority Level"],
  ["employmentType", "Employment Type"],
  ["industries", "Industries"],
  ["sourcePageNumber", "Source Page"],
  ["scrapedAt", "Scraped At"],
  ["scrapeStatus", "Scrape Status"]
];

const runtime = {
  queue: [],
  activeTabs: new Map(),
  batches: {},
  seenKeys: new Set(),
  lastActiveTabsByWindow: new Map(),
  initPromise: null,
  pumpRunning: false,
  pumpTimerId: null,
  nextOpenAt: 0
};

let jobWriteQueue = Promise.resolve();
let stateWriteQueue = Promise.resolve();

runtime.initPromise = initializeRuntime();

chrome.runtime.onInstalled.addListener(async () => {
  await initializeStorage();
});

chrome.runtime.onStartup?.addListener(() => {
  runtime.initPromise = initializeRuntime();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((response) => sendResponse(response))
    .catch((error) => {
      console.error("LinkedIn Job Scraper background error:", error);
      sendResponse({ ok: false, error: error.message || String(error) });
    });
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "complete") {
    return;
  }
  const task = runtime.activeTabs.get(tabId);
  if (!task || task.status !== "loading") {
    return;
  }
  injectJobExtractor(tabId).catch((error) => {
    finishTask(tabId, {
      scrapeStatus: "Extraction Error",
      jobDescription: "Could not inject job detail extractor.",
      error: error.message || String(error)
    });
  });
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  keepManagedTabsInBackground(activeInfo.tabId, activeInfo.windowId).catch((error) => {
    console.error("Failed to restore active tab:", error);
  });
});

chrome.tabs.onCreated.addListener((tab) => {
  closeChildTabFromManagedDetail(tab).catch((error) => {
    console.error("Failed to close scraper child tab:", error);
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const task = runtime.activeTabs.get(tabId);
  if (!task) {
    return;
  }
  finishTask(
    tabId,
    {
      scrapeStatus: "Tab Closed",
      jobDescription: "Detail tab was closed before extraction completed."
    },
    { skipClose: true }
  ).catch((error) => {
    console.error("Failed to finalize removed tab:", error);
  });
});

async function handleMessage(message, sender) {
  await ensureInitialized();

  switch (message?.type) {
    case "GET_SCRAPER_DATA":
      return getScraperData();
    case "NEW_SCRAPE":
      return startNewScrape(message.page || {});
    case "PROCESS_RESULTS_PAGE":
      return enqueueResultsPage(message.jobs || [], message.page || {}, sender);
    case "GET_BATCH_STATUS":
      return getBatchStatus(message.batchId);
    case "SCRAPER_CONTROL":
      return controlScrape(message.command);
    case "RESULTS_STATUS_UPDATE":
      return updateScraperState(message.patch || {});
    case "CAPTCHA_DETECTED":
      return pauseForCaptcha(sender.tab?.id || null, message.source || "page");
    case "JOB_DETAIL_EXTRACTED":
      return finishTask(sender.tab?.id || message.tabId, message.job || {});
    case "EXPORT_CSV":
      return exportCsv();
    case "EXPORT_JSON":
      return exportJson();
    case "CLEAR_SCRAPER_DATA":
      return clearScraperData();
    default:
      return { ok: false, error: "Unknown message type" };
  }
}

async function initializeStorage() {
  const existing = await storageGet(Object.values(STORAGE_KEYS));
  await storageSet({
    [STORAGE_KEYS.jobsById]: existing[STORAGE_KEYS.jobsById] || {},
    [STORAGE_KEYS.state]: existing[STORAGE_KEYS.state] || DEFAULT_STATE,
    [STORAGE_KEYS.queue]: existing[STORAGE_KEYS.queue] || [],
    [STORAGE_KEYS.activeTasks]: existing[STORAGE_KEYS.activeTasks] || [],
    [STORAGE_KEYS.batches]: existing[STORAGE_KEYS.batches] || {},
    [STORAGE_KEYS.seenKeys]: existing[STORAGE_KEYS.seenKeys] || []
  });
}

async function initializeRuntime() {
  await initializeStorage();
  const data = await storageGet([
    STORAGE_KEYS.queue,
    STORAGE_KEYS.activeTasks,
    STORAGE_KEYS.batches,
    STORAGE_KEYS.seenKeys,
    STORAGE_KEYS.state
  ]);

  const persistedQueue = data[STORAGE_KEYS.queue] || [];
  const activeTasks = data[STORAGE_KEYS.activeTasks] || [];
  const state = { ...DEFAULT_STATE, ...(data[STORAGE_KEYS.state] || {}) };

  runtime.queue = [...persistedQueue];
  runtime.activeTabs = new Map();
  runtime.batches = data[STORAGE_KEYS.batches] || {};
  runtime.seenKeys = new Set(data[STORAGE_KEYS.seenKeys] || []);
  runtime.lastActiveTabsByWindow = new Map();
  runtime.nextOpenAt = 0;

  if (shouldRecoverActiveTasks(state.status)) {
    for (const task of activeTasks.map(stripRuntimeTask)) {
      if (task.tabId && (await tabExists(task.tabId))) {
        if (task.status !== "captcha") {
          scheduleTaskTimeout(task);
        }
        runtime.activeTabs.set(task.tabId, task);
        continue;
      }
      runtime.queue.unshift({ ...task, status: "queued" });
    }
  }

  await persistRuntime();

  if (state.status === STATUSES.running) {
    for (const [tabId, task] of runtime.activeTabs) {
      if (task.status !== "captcha") {
        injectJobExtractor(tabId).catch((error) => {
          finishTask(tabId, {
            scrapeStatus: "Extraction Error",
            jobDescription: "Could not recover detail extraction after service worker restart.",
            error: error.message || String(error)
          });
        });
      }
    }
    schedulePump(0);
  }
}

async function ensureInitialized() {
  if (!runtime.initPromise) {
    runtime.initPromise = initializeRuntime();
  }
  await runtime.initPromise;
}

function shouldRecoverActiveTasks(status) {
  return [STATUSES.running, STATUSES.paused, STATUSES.blocked].includes(status);
}

async function getScraperData() {
  const data = await storageGet([STORAGE_KEYS.jobsById, STORAGE_KEYS.state]);
  const jobsById = data[STORAGE_KEYS.jobsById] || {};
  const state = decorateState(data[STORAGE_KEYS.state] || {});

  return {
    ok: true,
    state,
    jobs: dedupeJobs(Object.values(jobsById)).sort(sortByScrapedAt)
  };
}

// Starts (or resumes against existing data) a scrape. Existing jobs are preserved
// and used to skip duplicate cards. Use CLEAR_SCRAPER_DATA to wipe the store.
async function startNewScrape(page) {
  await closeActiveTabs(false);

  runtime.queue = [];
  runtime.activeTabs.clear();
  runtime.batches = {};
  runtime.nextOpenAt = 0;

  const existing = (await storageGet([STORAGE_KEYS.jobsById]))[STORAGE_KEYS.jobsById] || {};
  runtime.seenKeys = new Set(Object.keys(existing));

  const state = decorateState({
    ...DEFAULT_STATE,
    status: STATUSES.running,
    message: "Starting scrape...",
    currentAction: "Collecting jobs from the current results page",
    currentPageNumber: page.pageNumber || null,
    currentPageUrl: page.pageUrl || "",
    totalEstimate: page.totalEstimate || null,
    autoContinue: true,
    startedAt: new Date().toISOString(),
    scrapedCount: Object.keys(existing).length,
    updatedAt: Date.now()
  });

  await storageSet({
    [STORAGE_KEYS.queue]: [],
    [STORAGE_KEYS.activeTasks]: [],
    [STORAGE_KEYS.batches]: {},
    [STORAGE_KEYS.seenKeys]: Array.from(runtime.seenKeys),
    [STORAGE_KEYS.state]: state
  });
  await broadcastState(state);
  return { ok: true, state };
}

async function clearScraperData() {
  await closeActiveTabs(false);

  runtime.queue = [];
  runtime.activeTabs.clear();
  runtime.batches = {};
  runtime.seenKeys = new Set();
  runtime.nextOpenAt = 0;

  const state = decorateState({
    ...DEFAULT_STATE,
    message: "Ready for a new scrape",
    updatedAt: Date.now()
  });

  await storageSet({
    [STORAGE_KEYS.jobsById]: {},
    [STORAGE_KEYS.queue]: [],
    [STORAGE_KEYS.activeTasks]: [],
    [STORAGE_KEYS.batches]: {},
    [STORAGE_KEYS.seenKeys]: [],
    [STORAGE_KEYS.state]: state
  });
  await broadcastState(state);
  return { ok: true, state, jobs: [] };
}

async function enqueueResultsPage(jobs, page, sender) {
  const batchId = makeId("batch");
  const normalizedJobs = jobs.map(normalizeSummaryJob).filter((job) => job.linkedinUrl || job.linkedinJobId);

  const data = await storageGet([STORAGE_KEYS.jobsById]);
  const existingKeys = new Set(Object.keys(data[STORAGE_KEYS.jobsById] || {}));
  const activeKeys = new Set(Array.from(runtime.activeTabs.values()).map((task) => task.key));
  const queuedKeys = new Set(runtime.queue.map((task) => task.key));
  const knownKeys = new Set([...existingKeys, ...runtime.seenKeys, ...activeKeys, ...queuedKeys]);
  const tasks = [];

  for (const job of normalizedJobs) {
    const key = makeJobKey(job);
    if (!key || knownKeys.has(key)) {
      continue;
    }
    knownKeys.add(key);
    runtime.seenKeys.add(key);
    tasks.push({
      id: makeId("task"),
      batchId,
      key,
      url: detailUrlFor(job),
      summary: {
        ...job,
        storageKey: key,
        sourcePageNumber: page.pageNumber || job.sourcePageNumber || null,
        sourcePageUrl: page.pageUrl || job.sourcePageUrl || ""
      },
      sourceTabId: sender?.tab?.id || null,
      sourceWindowId: sender?.tab?.windowId || null,
      createdAt: Date.now()
    });
  }

  rememberUserTab(sender?.tab);

  runtime.queue.push(...tasks);
  runtime.batches[batchId] = {
    batchId,
    status: tasks.length ? "running" : "complete",
    pageNumber: page.pageNumber || null,
    pageUrl: page.pageUrl || "",
    total: tasks.length,
    completed: 0,
    failed: 0,
    skipped: normalizedJobs.length - tasks.length,
    queuedAt: new Date().toISOString(),
    completedAt: tasks.length ? "" : new Date().toISOString()
  };

  await persistRuntime();
  await updateScraperState({
    status: STATUSES.running,
    message: tasks.length
      ? `Queued ${tasks.length} new jobs from page ${page.pageNumber || "current"}`
      : `No new jobs on page ${page.pageNumber || "current"}`,
    currentAction: tasks.length ? "Opening detail tabs" : "Preparing next results page",
    currentPageNumber: page.pageNumber || null,
    currentPageUrl: page.pageUrl || "",
    totalEstimate: page.totalEstimate || null,
    lastBatchId: batchId,
    autoContinue: true
  });

  schedulePump(0);

  return {
    ok: true,
    batchId,
    queuedCount: tasks.length,
    skippedCount: normalizedJobs.length - tasks.length,
    totalCards: jobs.length
  };
}

async function getBatchStatus(batchId) {
  const batch = runtime.batches[batchId] || null;
  const { state } = await getScraperData();
  return {
    ok: true,
    state,
    batch: batch
      ? {
          ...batch,
          percent: batch.total ? Math.round((batch.completed / batch.total) * 100) : 100
        }
      : null
  };
}

async function controlScrape(command) {
  const normalized = String(command || "").toUpperCase();
  if (normalized === "PAUSE") {
    return pauseScrape();
  }
  if (normalized === "RESUME") {
    return resumeScrape();
  }
  if (normalized === "STOP") {
    return stopScrape();
  }
  return { ok: false, error: `Unsupported command: ${command}` };
}

async function pauseScrape() {
  const state = await updateScraperState({
    status: STATUSES.paused,
    message: "Paused",
    currentAction: "Waiting to resume"
  });
  return { ok: true, state };
}

async function resumeScrape() {
  const state = await updateScraperState({
    status: STATUSES.running,
    message: "Resuming...",
    currentAction: "Continuing queued detail tabs",
    autoContinue: true
  });

  for (const [tabId, task] of runtime.activeTabs) {
    if (task.status === "captcha") {
      task.status = "loading";
      runtime.activeTabs.set(tabId, task);
      injectJobExtractor(tabId).catch((error) => {
        finishTask(tabId, {
          scrapeStatus: "Extraction Error",
          jobDescription: "Could not resume detail extraction after CAPTCHA.",
          error: error.message || String(error)
        });
      });
    }
  }

  await persistRuntime();
  schedulePump(0);
  return { ok: true, state };
}

async function stopScrape() {
  for (const [tabId, task] of runtime.activeTabs) {
    clearTaskTimer(task);
    await upsertJob({
      ...task.summary,
      scrapeStatus: "Stopped",
      jobDescription: "Stopped before detail extraction completed.",
      scrapedAt: new Date().toISOString()
    });
    await closeTab(tabId);
    markBatchFinished(task.batchId, true);
  }

  runtime.activeTabs.clear();
  runtime.queue = [];
  for (const batch of Object.values(runtime.batches)) {
    if (batch.status === "running") {
      batch.status = "stopped";
      batch.completedAt = new Date().toISOString();
    }
  }

  await persistRuntime();
  const state = await updateScraperState({
    status: STATUSES.stopped,
    message: "Stopped by user",
    currentAction: "",
    currentJobTitle: "",
    autoContinue: false
  });
  return { ok: true, state };
}

function schedulePump(delayMs) {
  if (runtime.pumpTimerId) {
    clearTimeout(runtime.pumpTimerId);
  }
  runtime.pumpTimerId = setTimeout(() => {
    runtime.pumpTimerId = null;
    pumpQueue().catch((error) => {
      console.error("Queue pump failed:", error);
      updateScraperState({
        status: STATUSES.error,
        message: error.message || "Queue processing failed"
      });
    });
  }, Math.max(0, delayMs || 0));
}

async function pumpQueue() {
  if (runtime.pumpRunning) {
    return;
  }

  runtime.pumpRunning = true;
  try {
    while (runtime.queue.length && runtime.activeTabs.size < MAX_TABS) {
      const state = (await storageGet([STORAGE_KEYS.state]))[STORAGE_KEYS.state] || DEFAULT_STATE;
      if (state.status !== STATUSES.running) {
        break;
      }

      const waitMs = Math.max(0, runtime.nextOpenAt - Date.now());
      if (waitMs > 0) {
        schedulePump(waitMs);
        break;
      }

      const task = runtime.queue.shift();
      runtime.nextOpenAt = Date.now() + randomBetween(TAB_OPEN_DELAY_MIN_MS, TAB_OPEN_DELAY_MAX_MS);
      await persistRuntime();
      await openJobTab(task);
    }
  } finally {
    runtime.pumpRunning = false;
  }

  await updateScraperState({
    queueLength: runtime.queue.length,
    activeTabCount: runtime.activeTabs.size
  });
}

async function openJobTab(task) {
  await updateScraperState({
    currentAction: `Opening tab for ${truncate(task.summary.jobTitle || "job", 80)}`,
    currentJobTitle: task.summary.jobTitle || "",
    queueLength: runtime.queue.length,
    activeTabCount: runtime.activeTabs.size
  });

  const tab = await createInactiveJobTab(task);
  const activeTask = {
    ...task,
    tabId: tab.id,
    status: "loading",
    openedAt: Date.now()
  };

  scheduleTaskTimeout(activeTask);
  runtime.activeTabs.set(tab.id, activeTask);
  await persistRuntime();

  await updateScraperState({
    currentAction: `Loading detail tab for ${truncate(task.summary.jobTitle || "job", 80)}`,
    activeTabCount: runtime.activeTabs.size,
    queueLength: runtime.queue.length
  });
}

async function injectJobExtractor(tabId) {
  const task = runtime.activeTabs.get(tabId);
  if (!task) {
    return;
  }

  task.status = "extracting";
  scheduleTaskTimeout(task);
  runtime.activeTabs.set(tabId, task);
  await persistRuntime();
  await updateScraperState({
    currentAction: `Extracting JD for ${truncate(task.summary.jobTitle || "job", 80)}`,
    currentJobTitle: task.summary.jobTitle || "",
    activeTabCount: runtime.activeTabs.size
  });

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content_job.js"]
  });

  const result = results?.[0]?.result;
  if (result && runtime.activeTabs.has(tabId)) {
    await finishTask(tabId, result);
  }
}

function scheduleTaskTimeout(task) {
  clearTaskTimer(task);
  task.timeoutId = setTimeout(() => {
    finishTask(task.tabId, {
      scrapeStatus: "Timeout",
      jobDescription: "Detail page did not finish loading in time."
    }).catch((error) => console.error("Timeout finalization failed:", error));
  }, TAB_TIMEOUT_MS);
}

function clearTaskTimer(task) {
  if (task?.timeoutId) {
    clearTimeout(task.timeoutId);
    task.timeoutId = null;
  }
}

async function finishTask(tabId, detail, options = {}) {
  if (!tabId || !runtime.activeTabs.has(tabId)) {
    return { ok: true, ignored: true };
  }

  const task = runtime.activeTabs.get(tabId);
  clearTaskTimer(task);

  runtime.activeTabs.delete(tabId);

  const scrapeStatus = detail.scrapeStatus || (detail.expired ? "Expired" : "Complete");
  const merged = mergeJobData(task.summary, detail);
  const job = normalizeFinishedJob({
    ...merged,
    linkedinJobId:
      detail.linkedinJobId ||
      task.summary.linkedinJobId ||
      extractJobIdFromUrl(detail.linkedinUrl || task.summary.linkedinUrl || task.url),
    linkedinUrl: detail.linkedinUrl || task.summary.linkedinUrl || task.url,
    scrapeStatus,
    scrapedAt: new Date().toISOString()
  });

  await upsertJob(job);
  if (!options.skipClose) {
    await closeTab(tabId);
  }

  markBatchFinished(task.batchId, scrapeStatus !== "Complete");
  await persistRuntime();
  const resultMessage =
    scrapeStatus === "Complete"
      ? `Scraped ${job.jobTitle || "job"}`
      : `${scrapeStatus}: recorded ${job.jobTitle || "job"} and continued`;
  await updateScraperState({
    message: resultMessage,
    currentAction: runtime.queue.length ? "Moving to next queued job" : "Waiting for page batch to finish",
    currentJobTitle: job.jobTitle || "",
    activeTabCount: runtime.activeTabs.size,
    queueLength: runtime.queue.length
  });

  if (runtime.queue.length) {
    schedulePump(0);
  }

  return { ok: true, job };
}

async function pauseForCaptcha(tabId, source) {
  const state = await updateScraperState({
    status: STATUSES.blocked,
    message: `Verification challenge detected on ${source}. Solve it in the page, then click Resume.`,
    currentAction: "Paused for verification",
    activeTabCount: runtime.activeTabs.size,
    queueLength: runtime.queue.length,
    autoContinue: true
  });
  return { ok: true, state };
}

async function createInactiveJobTab(task) {
  const createProperties = {
    url: task.url,
    active: false
  };

  if (Number.isInteger(task.sourceWindowId)) {
    createProperties.windowId = task.sourceWindowId;
  }
  if (Number.isInteger(task.sourceTabId)) {
    createProperties.openerTabId = task.sourceTabId;
  }

  try {
    return await tabsCreate(createProperties);
  } catch (error) {
    console.warn("Could not open job tab in source window; falling back.", error);
    return tabsCreate({ url: task.url, active: false });
  }
}

async function keepManagedTabsInBackground(tabId, windowId) {
  await ensureInitialized();
  if (!Number.isInteger(windowId)) {
    return;
  }

  if (!runtime.activeTabs.has(tabId)) {
    runtime.lastActiveTabsByWindow.set(windowId, tabId);
    return;
  }

  const previousTabId = runtime.lastActiveTabsByWindow.get(windowId);
  if (previousTabId && previousTabId !== tabId && (await tabExists(previousTabId))) {
    await tabsUpdate(previousTabId, { active: true });
    return;
  }

  const fallback = (await tabsQuery({ windowId })).find((tab) => {
    return tab.id && tab.id !== tabId && !runtime.activeTabs.has(tab.id);
  });

  if (fallback?.id) {
    runtime.lastActiveTabsByWindow.set(windowId, fallback.id);
    await tabsUpdate(fallback.id, { active: true });
  }
}

async function closeChildTabFromManagedDetail(tab) {
  await ensureInitialized();

  if (!tab?.id || !tab.openerTabId || !runtime.activeTabs.has(tab.openerTabId)) {
    return;
  }

  await closeTab(tab.id);
}

function rememberUserTab(tab) {
  if (!tab?.id || !Number.isInteger(tab.windowId) || runtime.activeTabs.has(tab.id)) {
    return;
  }
  runtime.lastActiveTabsByWindow.set(tab.windowId, tab.id);
}

function markBatchFinished(batchId, failed) {
  const batch = runtime.batches[batchId];
  if (!batch || batch.status !== "running") {
    return;
  }

  batch.completed += 1;
  if (failed) {
    batch.failed += 1;
  }
  if (batch.completed >= batch.total) {
    batch.status = "complete";
    batch.completedAt = new Date().toISOString();
  }
}

async function closeActiveTabs(markStopped) {
  const activeEntries = Array.from(runtime.activeTabs.entries());
  for (const [tabId, task] of activeEntries) {
    clearTaskTimer(task);
    if (markStopped) {
      await upsertJob({
        ...task.summary,
        scrapeStatus: "Stopped",
        jobDescription: "Stopped before detail extraction completed.",
        scrapedAt: new Date().toISOString()
      });
    }
    await closeTab(tabId);
  }
  runtime.activeTabs.clear();
}

async function upsertJob(job) {
  jobWriteQueue = jobWriteQueue.then(async () => {
    const normalized = normalizeFinishedJob(job);
    const key = makeJobKey(normalized);
    const data = await storageGet([STORAGE_KEYS.jobsById, STORAGE_KEYS.state]);
    const jobsById = data[STORAGE_KEYS.jobsById] || {};
    const existing = jobsById[key] || {};

    jobsById[key] = {
      ...existing,
      ...normalized,
      storageKey: key,
      scrapedAt: normalized.scrapedAt || existing.scrapedAt || new Date().toISOString()
    };

    const state = decorateState({
      ...(data[STORAGE_KEYS.state] || {}),
      scrapedCount: Object.keys(jobsById).length,
      updatedAt: Date.now()
    });

    await storageSet({
      [STORAGE_KEYS.jobsById]: jobsById,
      [STORAGE_KEYS.state]: state
    });
    await broadcastState(state);
    return jobsById[key];
  });
  return jobWriteQueue;
}

async function updateScraperState(patch) {
  stateWriteQueue = stateWriteQueue.then(async () => {
    const data = await storageGet([STORAGE_KEYS.jobsById, STORAGE_KEYS.state]);
    const jobsById = data[STORAGE_KEYS.jobsById] || {};
    const state = decorateState({
      ...(data[STORAGE_KEYS.state] || {}),
      ...patch,
      scrapedCount: patch.scrapedCount ?? Object.keys(jobsById).length,
      queueLength: runtime.queue.length,
      activeTabCount: runtime.activeTabs.size,
      activeTabLimit: MAX_TABS,
      updatedAt: Date.now()
    });
    await storageSet({ [STORAGE_KEYS.state]: state });
    await broadcastState(state);
    return state;
  });
  return stateWriteQueue;
}

async function persistRuntime() {
  await storageSet({
    [STORAGE_KEYS.queue]: runtime.queue.map(stripRuntimeTask),
    [STORAGE_KEYS.activeTasks]: Array.from(runtime.activeTabs.values()).map(stripRuntimeTask),
    [STORAGE_KEYS.batches]: runtime.batches,
    [STORAGE_KEYS.seenKeys]: Array.from(runtime.seenKeys)
  });
}

async function exportCsv() {
  const { jobs } = await getScraperData();
  const header = CSV_COLUMNS.map(([, label]) => escapeCsvValue(label)).join(",");
  const rows = jobs.map((job) =>
    CSV_COLUMNS.map(([key]) => escapeCsvValue(formatExportValue(job[key]))).join(",")
  );
  const csv = "\uFEFF" + [header, ...rows].join("\r\n");
  const downloadId = await downloadTextFile(
    `linkedin-jobs-${timestampForFilename()}.csv`,
    csv,
    "text/csv;charset=utf-8"
  );
  return { ok: true, downloadId, count: jobs.length };
}

async function exportJson() {
  const { jobs } = await getScraperData();
  const json = JSON.stringify(jobs, null, 2);
  const downloadId = await downloadTextFile(
    `linkedin-jobs-${timestampForFilename()}.json`,
    json,
    "application/json;charset=utf-8"
  );
  return { ok: true, downloadId, count: jobs.length };
}

function downloadTextFile(filename, text, mimeType) {
  const url = `data:${mimeType},${encodeURIComponent(text)}`;
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      { url, filename, saveAs: true, conflictAction: "uniquify" },
      (downloadId) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve(downloadId);
      }
    );
  });
}

function normalizeSummaryJob(job) {
  const linkedinJobId = normalizeText(job.linkedinJobId || extractJobIdFromUrl(job.linkedinUrl || ""));
  const linkedinUrl = toAbsoluteLinkedInUrl(job.linkedinUrl || (linkedinJobId ? `https://www.linkedin.com/jobs/view/${linkedinJobId}/` : ""));
  const location = normalizeText(job.location);
  const split = splitLocation(location);
  return {
    jobTitle: normalizeText(job.jobTitle),
    companyName: normalizeText(job.companyName),
    location,
    city: normalizeText(job.city || split.city),
    country: normalizeText(job.country || split.country),
    jobType: normalizeText(job.jobType),
    workplaceType: normalizeText(job.workplaceType),
    datePosted: normalizeText(job.datePosted),
    linkedinJobId,
    linkedinUrl,
    sourcePageNumber: job.sourcePageNumber || null,
    sourcePageUrl: job.sourcePageUrl || "",
    scrapeStatus: normalizeText(job.scrapeStatus) || "Queued"
  };
}

function mergeJobData(summary, detail) {
  const merged = { ...(summary || {}), ...(detail || {}) };
  const textKeys = [
    "jobTitle",
    "companyName",
    "location",
    "city",
    "country",
    "jobType",
    "workplaceType",
    "datePosted",
    "seniorityLevel",
    "employmentType",
    "industries",
    "applyType",
    "directApplyUrl",
    "linkedinJobId",
    "linkedinUrl"
  ];

  for (const key of textKeys) {
    const detailValue = normalizeText(detail?.[key]);
    const summaryValue = normalizeText(summary?.[key]);
    if (!detailValue && summaryValue) {
      merged[key] = summaryValue;
    }
  }

  return merged;
}

function normalizeFinishedJob(job) {
  const linkedinJobId = normalizeText(job.linkedinJobId || extractJobIdFromUrl(job.linkedinUrl || ""));
  const linkedinUrl = toAbsoluteLinkedInUrl(job.linkedinUrl || (linkedinJobId ? `https://www.linkedin.com/jobs/view/${linkedinJobId}/` : ""));
  const location = normalizeText(job.location);
  const split = splitLocation(location);
  return {
    jobTitle: cleanJobTitle(job.jobTitle),
    companyName: normalizeText(job.companyName),
    location,
    city: normalizeText(job.city || split.city),
    country: normalizeText(job.country || split.country),
    jobType: normalizeText(job.jobType),
    workplaceType: normalizeText(job.workplaceType),
    datePosted: normalizeText(job.datePosted),
    jobDescription: normalizeText(job.jobDescription),
    applyType: normalizeText(job.applyType),
    directApplyUrl: toAbsoluteLinkedInUrl(job.directApplyUrl || ""),
    linkedinJobId,
    linkedinUrl,
    seniorityLevel: normalizeText(job.seniorityLevel),
    employmentType: normalizeText(job.employmentType),
    industries: normalizeText(job.industries),
    sourcePageNumber: job.sourcePageNumber || null,
    sourcePageUrl: job.sourcePageUrl || "",
    scrapedAt: job.scrapedAt || new Date().toISOString(),
    scrapeStatus: normalizeText(job.scrapeStatus) || "Complete"
  };
}

function makeJobKey(job) {
  const id = normalizeText(job.linkedinJobId || extractJobIdFromUrl(job.linkedinUrl || ""));
  if (id) {
    return `job:${id}`;
  }
  if (job.linkedinUrl) {
    return `url:${canonicalizeUrl(job.linkedinUrl)}`;
  }
  return `fingerprint:${fingerprint([job.jobTitle, job.companyName, job.location].join("|"))}`;
}

function detailUrlFor(job) {
  if (job.linkedinJobId) {
    return `https://www.linkedin.com/jobs/view/${job.linkedinJobId}/`;
  }
  return toAbsoluteLinkedInUrl(job.linkedinUrl || "");
}

function extractJobIdFromUrl(url) {
  if (!url) {
    return "";
  }
  const decoded = safeDecode(String(url));
  const patterns = [
    /\/jobs\/view\/(\d+)/i,
    /currentJobId=(\d+)/i,
    /jobId=(\d+)/i
  ];
  for (const pattern of patterns) {
    const match = decoded.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }
  return "";
}

function splitLocation(location) {
  const text = normalizeText(location);
  if (!text) {
    return { city: "", country: "" };
  }
  const parts = text.split(",").map((part) => part.trim()).filter(Boolean);
  return {
    city: parts[0] || text,
    country: parts.length > 1 ? parts[parts.length - 1] : ""
  };
}

function cleanJobTitle(text) {
  return normalizeText(text)
    .replace(/\s+with verification\b/i, "")
    .replace(/\s+Promoted\b/i, "")
    .trim();
}

function stripRuntimeTask(task) {
  const { timeoutId, ...serializable } = task || {};
  return serializable;
}

function decorateState(state) {
  return {
    ...DEFAULT_STATE,
    ...state,
    queueLength: runtime.queue.length,
    activeTabCount: runtime.activeTabs.size,
    activeTabLimit: MAX_TABS
  };
}

function dedupeJobs(jobs) {
  const byKey = new Map();
  for (const job of jobs) {
    const key = makeJobKey(job);
    if (!byKey.has(key)) {
      byKey.set(key, job);
    }
  }
  return Array.from(byKey.values());
}

function sortByScrapedAt(a, b) {
  return String(a.scrapedAt || "").localeCompare(String(b.scrapedAt || ""));
}

function formatExportValue(value) {
  if (Array.isArray(value)) {
    return value.join("; ");
  }
  if (value === null || value === undefined) {
    return "";
  }
  return String(value);
}

function escapeCsvValue(value) {
  const normalized = String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n/g, "\r\n");
  return `"${normalized.replace(/"/g, '""')}"`;
}

function normalizeText(text) {
  return String(text || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function toAbsoluteLinkedInUrl(url) {
  if (!url) {
    return "";
  }
  try {
    return new URL(url, "https://www.linkedin.com").toString();
  } catch {
    return String(url);
  }
}

function canonicalizeUrl(url) {
  try {
    const parsed = new URL(url, "https://www.linkedin.com");
    parsed.hash = "";
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (/^(refId|trackingId|trk|src|sid|originalSubdomain|utm_|origin)/i.test(key)) {
        parsed.searchParams.delete(key);
      }
    }
    return parsed.toString();
  } catch {
    return String(url || "");
  }
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function fingerprint(value) {
  let hash = 0;
  const input = String(value || "");
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash << 5) - hash + input.charCodeAt(index);
    hash |= 0;
  }
  return String(Math.abs(hash));
}

function truncate(value, maxLength) {
  const text = String(value || "");
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function makeId(prefix) {
  if (crypto?.randomUUID) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function timestampForFilename() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function storageSet(items) {
  return new Promise((resolve) => chrome.storage.local.set(items, resolve));
}

function tabsCreate(createProperties) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create(createProperties, (tab) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(tab);
    });
  });
}

async function closeTab(tabId) {
  try {
    await tabsRemove(tabId);
  } catch {
    // Already gone.
  }
}

async function broadcastState(state) {
  chrome.runtime.sendMessage({ type: "SCRAPER_STATE_CHANGED", state }, () => {
    void chrome.runtime.lastError;
  });

  try {
    const tabs = await tabsQuery({ url: "https://www.linkedin.com/*" });
    for (const tab of tabs) {
      if (!tab.id) {
        continue;
      }
      chrome.tabs.sendMessage(tab.id, { type: "SCRAPER_STATE_CHANGED", state }, () => {
        void chrome.runtime.lastError;
      });
    }
  } catch {
    // Content tabs are optional listeners.
  }
}

function tabsQuery(queryInfo) {
  return new Promise((resolve, reject) => {
    chrome.tabs.query(queryInfo, (tabs) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(tabs || []);
    });
  });
}

function tabsRemove(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.remove(tabId, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });
}

function tabsUpdate(tabId, updateProperties) {
  return new Promise((resolve, reject) => {
    chrome.tabs.update(tabId, updateProperties, (tab) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(tab);
    });
  });
}

function tabsGet(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.get(tabId, (tab) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(tab);
    });
  });
}

async function tabExists(tabId) {
  try {
    await tabsGet(tabId);
    return true;
  } catch {
    return false;
  }
}
