const STORAGE_KEYS = {
  jobsById: "linkedinJobScraper.jobsById",
  state: "linkedinJobScraper.state"
};

const DEFAULT_STATE = {
  status: "idle",
  message: "Ready",
  scrapedCount: 0,
  totalEstimate: null,
  currentJobTitle: "",
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
  ["scrapedAt", "Scraped At"],
  ["scrapeStatus", "Scrape Status"]
];

let jobWriteQueue = Promise.resolve();

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await storageGet([STORAGE_KEYS.state, STORAGE_KEYS.jobsById]);
  await storageSet({
    [STORAGE_KEYS.state]: existing[STORAGE_KEYS.state] || DEFAULT_STATE,
    [STORAGE_KEYS.jobsById]: existing[STORAGE_KEYS.jobsById] || {}
  });
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

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "GET_SCRAPER_DATA":
      return getScraperData();
    case "CLEAR_SCRAPER_DATA":
      return clearScraperData();
    case "UPSERT_JOB":
      return queueJobUpsert(message.job);
    case "UPDATE_SCRAPER_STATE":
      return updateScraperState(message.patch || {});
    case "EXPORT_CSV":
      return exportCsv();
    case "EXPORT_JSON":
      return exportJson();
    default:
      return { ok: false, error: "Unknown message type" };
  }
}

// Returns the authoritative scrape state plus sorted jobs for the popup.
async function getScraperData() {
  const data = await storageGet([STORAGE_KEYS.jobsById, STORAGE_KEYS.state]);
  const jobsById = data[STORAGE_KEYS.jobsById] || {};
  const state = {
    ...DEFAULT_STATE,
    ...(data[STORAGE_KEYS.state] || {}),
    scrapedCount: Object.keys(jobsById).length
  };

  return {
    ok: true,
    state,
    jobs: Object.values(jobsById).sort(sortByScrapedAt)
  };
}

// Clears all persisted jobs and resets state for a new scrape.
async function clearScraperData() {
  const state = {
    ...DEFAULT_STATE,
    status: "idle",
    message: "Ready for a new scrape",
    scrapedCount: 0,
    totalEstimate: null,
    currentJobTitle: "",
    startedAt: null,
    updatedAt: Date.now()
  };

  await storageSet({
    [STORAGE_KEYS.jobsById]: {},
    [STORAGE_KEYS.state]: state
  });
  await broadcastState(state);
  return { ok: true, state, jobs: [] };
}

function queueJobUpsert(job) {
  jobWriteQueue = jobWriteQueue.then(() => upsertJob(job));
  return jobWriteQueue;
}

// Merges a scraped job into local storage with de-duplication by LinkedIn ID or URL.
async function upsertJob(job) {
  if (!job || typeof job !== "object") {
    throw new Error("UPSERT_JOB requires a job object");
  }

  const key = makeJobKey(job);
  const data = await storageGet([STORAGE_KEYS.jobsById, STORAGE_KEYS.state]);
  const jobsById = data[STORAGE_KEYS.jobsById] || {};
  const currentState = data[STORAGE_KEYS.state] || DEFAULT_STATE;

  jobsById[key] = {
    ...jobsById[key],
    ...job,
    storageKey: key,
    scrapedAt: job.scrapedAt || new Date().toISOString()
  };

  const state = {
    ...DEFAULT_STATE,
    ...currentState,
    status: currentState.status === "idle" ? "running" : currentState.status,
    scrapedCount: Object.keys(jobsById).length,
    currentJobTitle: job.jobTitle || currentState.currentJobTitle || "",
    updatedAt: Date.now()
  };

  await storageSet({
    [STORAGE_KEYS.jobsById]: jobsById,
    [STORAGE_KEYS.state]: state
  });
  await broadcastState(state);
  return { ok: true, state, job: jobsById[key] };
}

// Persists status/progress updates from the content script.
async function updateScraperState(patch) {
  const data = await storageGet([STORAGE_KEYS.jobsById, STORAGE_KEYS.state]);
  const jobsById = data[STORAGE_KEYS.jobsById] || {};
  const state = {
    ...DEFAULT_STATE,
    ...(data[STORAGE_KEYS.state] || {}),
    ...patch,
    scrapedCount: patch.scrapedCount ?? Object.keys(jobsById).length,
    updatedAt: Date.now()
  };

  await storageSet({ [STORAGE_KEYS.state]: state });
  await broadcastState(state);
  return { ok: true, state };
}

// Builds an Excel-friendly CSV and starts a Chrome download.
async function exportCsv() {
  const { jobs } = await getScraperData();
  const header = CSV_COLUMNS.map(([, label]) => escapeCsvValue(label)).join(",");
  const rows = jobs.map((job) =>
    CSV_COLUMNS.map(([key]) => escapeCsvValue(job[key] ?? "")).join(",")
  );
  const csv = "\uFEFF" + [header, ...rows].join("\r\n");

  const downloadId = await downloadTextFile(
    `linkedin-jobs-${timestampForFilename()}.csv`,
    csv,
    "text/csv;charset=utf-8"
  );
  return { ok: true, downloadId, count: jobs.length };
}

// Builds a pretty-printed JSON export and starts a Chrome download.
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

// Uses chrome.downloads with a data URL so the service worker owns downloads.
function downloadTextFile(filename, text, mimeType) {
  const url = `data:${mimeType},${encodeURIComponent(text)}`;
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url,
        filename,
        saveAs: true,
        conflictAction: "uniquify"
      },
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

// Chooses a stable storage key, preferring LinkedIn's job ID.
function makeJobKey(job) {
  const raw =
    job.linkedinJobId ||
    job.linkedInJobId ||
    job.linkedinUrl ||
    `${job.jobTitle || "untitled"}|${job.companyName || "unknown"}|${job.location || "unknown"}`;
  return String(raw).trim() || crypto.randomUUID();
}

// Quotes every CSV cell and preserves multiline job descriptions.
function escapeCsvValue(value) {
  const normalized = String(value)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n/g, "\r\n");
  return `"${normalized.replace(/"/g, '""')}"`;
}

function timestampForFilename() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function sortByScrapedAt(a, b) {
  return String(a.scrapedAt || "").localeCompare(String(b.scrapedAt || ""));
}

function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function storageSet(items) {
  return new Promise((resolve) => chrome.storage.local.set(items, resolve));
}

async function broadcastState(state) {
  try {
    await chrome.runtime.sendMessage({ type: "SCRAPER_STATE_CHANGED", state });
  } catch {
    // No visible extension page may be listening. Storage remains authoritative.
  }
}
