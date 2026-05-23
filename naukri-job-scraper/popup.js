const popupState = {
  jobs: [],
  state: {
    status: "idle",
    message: "Ready",
    scrapedCount: 0,
    totalEstimate: null,
    activeTabCount: 0,
    activeTabLimit: 6
  }
};

const elements = {
  status: document.querySelector("[data-popup-status]"),
  message: document.querySelector("[data-popup-message]"),
  count: document.querySelector("[data-popup-count]"),
  page: document.querySelector("[data-popup-page]"),
  tabs: document.querySelector("[data-popup-tabs]"),
  preview: document.querySelector("[data-popup-preview]"),
  actions: document.querySelectorAll("[data-popup-action]")
};

document.addEventListener("DOMContentLoaded", initPopup);

async function initPopup() {
  bindActions();
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "SCRAPER_STATE_CHANGED") {
      popupState.state = { ...popupState.state, ...message.state };
      render();
      refreshData();
    }
  });
  chrome.storage.onChanged.addListener(refreshData);
  await refreshData();
}

function bindActions() {
  for (const button of elements.actions) {
    button.addEventListener("click", async () => {
      const action = button.getAttribute("data-popup-action");
      button.disabled = true;
      try {
        if (action === "start") {
          await sendCommandToActiveResultsTab("START");
        } else if (["pause", "resume", "stop"].includes(action)) {
          await sendBackground({ type: "SCRAPER_CONTROL", command: action.toUpperCase() });
          await sendCommandToActiveResultsTab(action.toUpperCase(), true);
        } else if (action === "csv") {
          await sendBackground({ type: "EXPORT_CSV" });
        } else if (action === "json") {
          await sendBackground({ type: "EXPORT_JSON" });
        } else if (action === "clear-cache") {
          await sendBackground({ type: "CLEAR_SCRAPER_DATA" });
        }
        await refreshData();
      } catch (error) {
        elements.message.textContent = error.message || String(error);
      } finally {
        button.disabled = false;
      }
    });
  }
}

async function refreshData() {
  const response = await sendBackground({ type: "GET_SCRAPER_DATA" });
  popupState.jobs = response.jobs || [];
  popupState.state = response.state || popupState.state;
  render();
}

function render() {
  const state = popupState.state || {};
  const jobsCount = popupState.jobs.length || state.scrapedCount || 0;
  const total = state.totalEstimate ? ` / ~${state.totalEstimate}` : "";
  const page = state.currentPageNumber ? `Page ${state.currentPageNumber}` : "-";

  elements.status.textContent = capitalize(state.status || "idle");
  elements.status.dataset.status = state.status || "idle";
  elements.message.textContent = state.message || "Ready";
  elements.count.textContent = `${jobsCount}${total}`;
  elements.page.textContent = page;
  elements.tabs.textContent = `${state.activeTabCount || 0}/${state.activeTabLimit || 6}`;

  const recent = popupState.jobs.slice(-5).reverse();
  if (!recent.length) {
    elements.preview.innerHTML = `<div class="njs-popup-empty">No jobs scraped yet.</div>`;
    return;
  }

  elements.preview.innerHTML = recent
    .map(
      (job) => `
        <article class="njs-popup-job">
          <strong>${escapeHtml(job.jobTitle || "Untitled role")}</strong>
          <span>${escapeHtml([job.companyName, job.scrapeStatus].filter(Boolean).join(" - "))}</span>
        </article>
      `
    )
    .join("");
}

async function sendCommandToActiveResultsTab(command, optional = false) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !isNaukriResultsUrl(tab.url || "")) {
    if (optional) {
      return { ok: true };
    }
    throw new Error("Open a Naukri job search results page first.");
  }

  try {
    return await sendTabMessage(tab.id, { type: "SCRAPER_COMMAND", command });
  } catch (error) {
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["styles.css"] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content_results.js"] });
    return sendTabMessage(tab.id, { type: "SCRAPER_COMMAND", command });
  }
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      if (response && response.ok === false) {
        reject(new Error(response.error || "Content script request failed"));
        return;
      }
      resolve(response || { ok: true });
    });
  });
}

function sendBackground(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      if (response && response.ok === false) {
        reject(new Error(response.error || "Background request failed"));
        return;
      }
      resolve(response || { ok: true });
    });
  });
}

function isNaukriResultsUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "www.naukri.com") {
      return false;
    }
    if (/\/job-listings-/i.test(parsed.pathname)) {
      return false;
    }
    return /jobs/i.test(parsed.pathname) || parsed.searchParams.has("k") || parsed.searchParams.has("keyword");
  } catch {
    return false;
  }
}

function capitalize(value) {
  const text = String(value || "");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
