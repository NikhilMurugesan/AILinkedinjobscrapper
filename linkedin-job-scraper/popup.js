const popupState = {
  jobs: [],
  state: {
    status: "idle",
    message: "Ready",
    scrapedCount: 0,
    totalEstimate: null,
    activeTabCount: 0,
    activeTabLimit: 6,
    currentPageNumber: null
  }
};

const elements = {
  status: document.querySelector("[data-popup-status]"),
  count: document.querySelector("[data-popup-count]"),
  jobs: document.querySelector("[data-popup-jobs]"),
  page: document.querySelector("[data-popup-page]"),
  tabs: document.querySelector("[data-popup-tabs]"),
  preview: document.querySelector("[data-popup-preview]"),
  actions: document.querySelectorAll("[data-popup-action]")
};

document.addEventListener("DOMContentLoaded", initPopup);

async function initPopup() {
  bindActions();
  await refreshData();
  chrome.storage.onChanged.addListener(refreshData);
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "SCRAPER_STATE_CHANGED") {
      popupState.state = { ...popupState.state, ...message.state };
      render();
      refreshData();
    }
  });
}

function bindActions() {
  for (const button of elements.actions) {
    button.addEventListener("click", async () => {
      const action = button.getAttribute("data-popup-action");
      button.disabled = true;
      try {
        if (action === "start") {
          await sendCommandToActiveTab("START");
        } else if (["pause", "resume", "stop"].includes(action)) {
          await sendBackground({ type: "SCRAPER_CONTROL", command: action.toUpperCase() });
          await sendCommandToActiveTab(action.toUpperCase(), true);
        } else if (action === "csv") {
          await sendBackground({ type: "EXPORT_CSV" });
        } else if (action === "json") {
          await sendBackground({ type: "EXPORT_JSON" });
        } else if (action === "clear-cache") {
          await sendBackground({ type: "CLEAR_SCRAPER_DATA" });
        }
        await refreshData();
      } catch (error) {
        elements.status.textContent = error.message || String(error);
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
  const count = popupState.jobs.length || state.scrapedCount || 0;
  const total = state.totalEstimate ? ` / ~${state.totalEstimate}` : "";

  elements.status.textContent = `${capitalize(state.status || "idle")} - ${state.message || "Ready"}`;
  elements.count.textContent = `${count}${total}`;
  if (elements.jobs) {
    elements.jobs.textContent = String(count);
  }
  if (elements.page) {
    elements.page.textContent = state.currentPageNumber ? `Page ${state.currentPageNumber}` : "-";
  }
  if (elements.tabs) {
    elements.tabs.textContent = `${state.activeTabCount || 0}/${state.activeTabLimit || 6}`;
  }

  const recent = popupState.jobs.slice(-5).reverse();
  if (!recent.length) {
    elements.preview.innerHTML = `<div class="lijs-popup-empty">No jobs scraped yet.</div>`;
    return;
  }

  elements.preview.innerHTML = recent
    .map(
      (job) => `
        <article class="lijs-popup-job">
          <strong>${escapeHtml(job.jobTitle || "Untitled role")}</strong>
          <span>${escapeHtml([job.companyName, job.location].filter(Boolean).join(" - "))}</span>
        </article>
      `
    )
    .join("");
}

async function sendCommandToActiveTab(command, optional = false) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !isLinkedInJobsUrl(tab.url || "")) {
    if (optional) {
      return { ok: true };
    }
    throw new Error("Open a LinkedIn Jobs search or collection page first.");
  }

  try {
    return await sendTabMessage(tab.id, { type: "SCRAPER_COMMAND", command });
  } catch {
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["styles.css"] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
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

function isLinkedInJobsUrl(url) {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname === "www.linkedin.com" &&
      (parsed.pathname.startsWith("/jobs/search") || parsed.pathname.startsWith("/jobs/collections"))
    );
  } catch {
    return false;
  }
}

function capitalize(value) {
  return String(value || "").charAt(0).toUpperCase() + String(value || "").slice(1);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
