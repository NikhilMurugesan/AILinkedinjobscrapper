// LinkedIn Job Scraper — results-page content script.
// Runs on /jobs/search* and /jobs/collections*. Scrolls the result list, harvests
// card data, sends batches to the background service worker, then advances pages.
// Detail extraction happens in background tabs (see content_job.js).

(() => {
  if (window.__LINKEDIN_JOB_SCRAPER_RESULTS_LOADED__) {
    return;
  }
  window.__LINKEDIN_JOB_SCRAPER_RESULTS_LOADED__ = true;

  const SELECTORS = {
    resultsContainer: [
      ".jobs-search-results-list",
      ".scaffold-layout__list",
      ".jobs-search-results",
      "[aria-label*='Search results']",
      "main"
    ],
    jobCards: [
      "li.jobs-search-results__list-item",
      ".jobs-search-results__list-item",
      ".job-card-container",
      ".jobs-job-board-list__item",
      "[data-occludable-job-id]",
      "[data-job-id]"
    ],
    cardTitle: [
      ".job-card-list__title",
      ".job-card-container__link",
      ".job-card-container__title",
      "a[href*='/jobs/view/']"
    ],
    cardCompany: [
      ".job-card-container__primary-description",
      ".job-card-container__company-name",
      ".artdeco-entity-lockup__subtitle",
      ".base-search-card__subtitle"
    ],
    cardLocation: [
      ".job-card-container__metadata-item",
      ".job-card-container__metadata-wrapper li",
      ".artdeco-entity-lockup__caption",
      ".job-search-card__location",
      ".base-search-card__metadata"
    ],
    cardDate: [
      "time",
      ".job-card-container__listed-time",
      ".job-card-list__listed-time",
      ".job-search-card__listdate"
    ],
    cardInsights: [
      ".job-card-container__metadata-wrapper",
      ".job-card-list__footer-wrapper",
      ".job-card-container__job-insight-text",
      ".job-card-container__footer-wrapper"
    ],
    nextButtons: [
      "button[aria-label='View next page']",
      "button[aria-label*='Next']",
      ".artdeco-pagination__button--next",
      "li[data-test-pagination-page-btn].active + li button"
    ],
    showMoreButtons: [
      "button[aria-label*='See more jobs']",
      "button[aria-label*='Show more']",
      ".infinite-scroller__show-more-button"
    ],
    totalCountCandidates: [
      ".jobs-search-results-list__text",
      ".jobs-search-results-list__title-heading",
      ".jobs-search-results-list__subtitle",
      "h1",
      "[aria-live='polite']"
    ],
    blockerCandidates: [
      "#captcha-internal",
      "[data-test-id='captcha']",
      ".challenge-dialog",
      ".security-challenge",
      "input[name='session_key']",
      ".authwall-join-form",
      ".sign-in-modal"
    ]
  };

  const CARD_WAIT_TIMEOUT_MS = 15000;
  const PAGE_CHANGE_TIMEOUT_MS = 15000;
  const BATCH_POLL_MS = 1000;
  const EMPTY_SCROLL_LIMIT = 5;
  const AUTO_CONTINUE_DELAY_MS = 900;

  const scraper = {
    task: null,
    stopRequested: false,
    currentState: null
  };

  if (!isSupportedResultsUrl(location.href)) {
    return;
  }

  ensureOverlay();
  hydrateFromBackground();

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "SCRAPER_STATE_CHANGED") {
      scraper.currentState = { ...(scraper.currentState || {}), ...(message.state || {}) };
      renderOverlay(scraper.currentState);
      return false;
    }

    if (message?.type !== "SCRAPER_COMMAND") {
      return false;
    }

    handleCommand(message.command)
      .then((response) => sendResponse(response))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  });

  setTimeout(autoContinueIfNeeded, AUTO_CONTINUE_DELAY_MS);

  async function handleCommand(command) {
    const normalized = String(command || "").toUpperCase();
    if (normalized === "START") {
      return startScraping();
    }
    if (normalized === "PAUSE") {
      return sendBackground({ type: "SCRAPER_CONTROL", command: "PAUSE" });
    }
    if (normalized === "RESUME") {
      scraper.stopRequested = false;
      const response = await sendBackground({ type: "SCRAPER_CONTROL", command: "RESUME" });
      if (!scraper.task) {
        scraper.task = runScraper().finally(() => {
          scraper.task = null;
        });
      }
      return response;
    }
    if (normalized === "STOP") {
      scraper.stopRequested = true;
      return sendBackground({ type: "SCRAPER_CONTROL", command: "STOP" });
    }
    if (normalized === "PING") {
      return { ok: true };
    }
    return { ok: false, error: `Unsupported command: ${command}` };
  }

  async function startScraping() {
    if (!isSupportedResultsUrl(location.href)) {
      throw new Error("Open a LinkedIn Jobs search or collection page first.");
    }
    if (scraper.task) {
      return { ok: true, message: "Scrape already running" };
    }

    scraper.stopRequested = false;
    await sendBackground({ type: "NEW_SCRAPE", page: getPageInfo() });
    scraper.task = runScraper().finally(() => {
      scraper.task = null;
    });
    return { ok: true };
  }

  async function autoContinueIfNeeded() {
    try {
      const response = await sendBackground({ type: "GET_SCRAPER_DATA" });
      scraper.currentState = response.state;
      renderOverlay(response.state);
      if (
        response.state?.status === "running" &&
        response.state?.autoContinue &&
        !scraper.task
      ) {
        scraper.task = runScraper().finally(() => {
          scraper.task = null;
        });
      }
    } catch (error) {
      renderOverlay({ status: "error", message: error.message || String(error) });
    }
  }

  async function runScraper() {
    while (!scraper.stopRequested) {
      const status = await waitForRunnableState();
      if (status !== "running") {
        return;
      }

      if (await detectBlocker()) {
        await sendBackground({ type: "CAPTCHA_DETECTED", source: "results page" });
        await waitForRunnableState();
        continue;
      }

      const pageInfo = getPageInfo();
      await updateStatus({
        status: "running",
        message: `Collecting jobs from page ${pageInfo.pageNumber || "current"}`,
        currentAction: "Reading result cards",
        currentPageNumber: pageInfo.pageNumber,
        currentPageUrl: pageInfo.pageUrl,
        totalEstimate: pageInfo.totalEstimate
      });

      try {
        await waitForAny(SELECTORS.jobCards, CARD_WAIT_TIMEOUT_MS);
      } catch {
        await markComplete("Timed out waiting for LinkedIn result cards.");
        return;
      }

      await loadAllCardsOnPage();

      const cards = getVisibleJobCards();
      const jobs = cards.map(extractCardData).filter((job) => job.linkedinJobId || job.linkedinUrl);
      if (!jobs.length) {
        await markComplete("No job cards found on this page.");
        return;
      }

      const batch = await sendBackground({
        type: "PROCESS_RESULTS_PAGE",
        jobs,
        page: pageInfo
      });

      await waitForBatch(batch.batchId);
      if (scraper.stopRequested) {
        return;
      }

      const advanced = await advanceToNextResultPage(pageInfo.pageNumber + 1);
      if (!advanced) {
        await markComplete("Scraping complete.");
        return;
      }

      await updateStatus({
        status: "running",
        message: `Page ${pageInfo.pageNumber || "current"} complete`,
        currentAction: "Opening next results page"
      });

      await delay(700);
    }
  }

  // Scrolls / clicks "see more" until LinkedIn stops revealing new cards.
  async function loadAllCardsOnPage() {
    let lastCount = -1;
    let emptyPasses = 0;
    while (emptyPasses < EMPTY_SCROLL_LIMIT && !scraper.stopRequested) {
      const before = getVisibleJobCards().length;
      await clickShowMoreIfPresent();
      await scrollResultsPanel();
      await delay(randomBetween(700, 1200));
      const after = getVisibleJobCards().length;
      if (after === before && after === lastCount) {
        emptyPasses += 1;
      } else {
        emptyPasses = 0;
      }
      lastCount = after;
    }
  }

  async function clickShowMoreIfPresent() {
    for (const selector of SELECTORS.showMoreButtons) {
      const button = document.querySelector(selector);
      if (button && isVisible(button) && !button.disabled) {
        button.click();
        await delay(randomBetween(800, 1400));
        return true;
      }
    }
    return false;
  }

  async function waitForBatch(batchId) {
    while (!scraper.stopRequested) {
      const response = await sendBackground({ type: "GET_BATCH_STATUS", batchId });
      scraper.currentState = response.state;
      renderOverlay(response.state, response.batch);

      if (response.state?.status === "stopped") {
        scraper.stopRequested = true;
        return;
      }
      if (response.state?.status === "paused" || response.state?.status === "blocked") {
        await delay(BATCH_POLL_MS);
        continue;
      }
      if (!response.batch || ["complete", "stopped"].includes(response.batch.status)) {
        return;
      }
      await delay(BATCH_POLL_MS);
    }
  }

  async function waitForRunnableState() {
    while (!scraper.stopRequested) {
      const response = await sendBackground({ type: "GET_SCRAPER_DATA" });
      const status = response.state?.status || "idle";
      scraper.currentState = response.state;
      renderOverlay(response.state);

      if (status === "stopped" || status === "complete" || status === "idle") {
        return status;
      }
      if (status === "running") {
        return status;
      }
      await delay(BATCH_POLL_MS);
    }
    return "stopped";
  }

  async function advanceToNextResultPage(nextPageNumber) {
    await updateStatus({
      status: "running",
      message: `Looking for page ${nextPageNumber}...`
    });

    const nextButton = SELECTORS.nextButtons
      .map((selector) => document.querySelector(selector))
      .find((button) => button && isVisible(button) && !button.disabled && button.getAttribute("aria-disabled") !== "true");

    if (!nextButton) {
      return false;
    }

    const oldSignature = pageSignature();
    nextButton.click();
    try {
      await waitForCondition(
        () => pageSignature() !== oldSignature && getVisibleJobCards().length > 0,
        PAGE_CHANGE_TIMEOUT_MS
      );
      await delay(600);
      return true;
    } catch {
      return false;
    }
  }

  async function scrollResultsPanel() {
    const container = getResultsContainer();
    if (!container) {
      window.scrollBy({ top: window.innerHeight * 0.8, behavior: "smooth" });
      return;
    }

    const amount = Math.max(container.clientHeight * 0.85, 550);
    if (
      container === document.body ||
      container === document.documentElement ||
      container === document.scrollingElement
    ) {
      window.scrollBy({ top: amount, behavior: "smooth" });
      return;
    }
    container.scrollBy({ top: amount, behavior: "smooth" });
  }

  function extractCardData(card) {
    const titleNode = findFirst(card, SELECTORS.cardTitle);
    const linkNode = titleNode?.closest("a") || card.querySelector("a[href*='/jobs/view/']");
    const linkedinUrl = toAbsoluteUrl(linkNode?.getAttribute("href") || "");
    const linkedinJobId =
      card.getAttribute("data-job-id") ||
      card.getAttribute("data-occludable-job-id") ||
      extractJobIdFromUrl(linkedinUrl) ||
      extractJobIdFromElement(card);

    const location = firstNonEmptyText(card, SELECTORS.cardLocation);
    const insightText = collectText(card, SELECTORS.cardInsights).join(" | ");

    return {
      jobTitle: cleanJobTitle(textFromNode(titleNode)),
      companyName: firstNonEmptyText(card, SELECTORS.cardCompany),
      location,
      datePosted: firstNonEmptyText(card, SELECTORS.cardDate),
      jobType: extractJobType(`${location} ${insightText}`),
      workplaceType: extractWorkplaceType(`${location} ${insightText}`),
      linkedinJobId,
      linkedinUrl
    };
  }

  function getVisibleJobCards() {
    const cards = SELECTORS.jobCards.flatMap((selector) => Array.from(document.querySelectorAll(selector)));
    return uniqueElements(cards).filter((card) => isVisible(card) && hasJobSignal(card));
  }

  function getResultsContainer() {
    const fromSelectors = SELECTORS.resultsContainer
      .map((selector) => document.querySelector(selector))
      .find(Boolean);
    if (fromSelectors) {
      return findScrollableAncestor(fromSelectors) || fromSelectors;
    }
    const firstCard = getVisibleJobCards()[0];
    return firstCard ? findScrollableAncestor(firstCard) : document.scrollingElement;
  }

  function findScrollableAncestor(element) {
    let node = element;
    while (node && node !== document.body) {
      const style = window.getComputedStyle(node);
      const canScroll = /(auto|scroll)/.test(`${style.overflowY}${style.overflow}`);
      if (canScroll && node.scrollHeight > node.clientHeight + 25) {
        return node;
      }
      node = node.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  async function detectBlocker() {
    const selectorHit = SELECTORS.blockerCandidates.some((selector) => document.querySelector(selector));
    const bodyText = normalizeText(document.body?.innerText || "");
    const textHit = /captcha|security check|verify.*human|sign in to continue|join linkedin/i.test(bodyText);
    return selectorHit || textHit;
  }

  function getPageInfo() {
    return {
      pageNumber: getCurrentPageNumber(),
      pageUrl: location.href,
      totalEstimate: getTotalEstimate()
    };
  }

  function getCurrentPageNumber() {
    const url = new URL(location.href);
    const param = Number(url.searchParams.get("start"));
    if (Number.isFinite(param) && param > 0) {
      return Math.floor(param / 25) + 1;
    }
    const active = document.querySelector("li.artdeco-pagination__indicator--number.active button, [aria-current='page']");
    const number = Number(normalizeText(active?.textContent || "").match(/\d+/)?.[0]);
    return number || 1;
  }

  function getTotalEstimate() {
    const text = collectText(document, SELECTORS.totalCountCandidates).join(" ");
    const match = text.match(/([\d,.]+)\s*\+?\s*(?:jobs|results)/i);
    if (!match) {
      return null;
    }
    const parsed = Number(match[1].replace(/[^\d]/g, ""));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  function pageSignature() {
    return getVisibleJobCards()
      .slice(0, 5)
      .map((card) => card.getAttribute("data-job-id") || card.getAttribute("data-occludable-job-id") || textFromNode(card).slice(0, 80))
      .join("|");
  }

  async function markComplete(message) {
    await updateStatus({
      status: "complete",
      message,
      currentAction: "",
      currentJobTitle: "",
      autoContinue: false
    });
  }

  async function updateStatus(patch) {
    const response = await sendBackground({ type: "RESULTS_STATUS_UPDATE", patch });
    scraper.currentState = response.state;
    renderOverlay(response.state);
    return response;
  }

  async function hydrateFromBackground() {
    try {
      const response = await sendBackground({ type: "GET_SCRAPER_DATA" });
      scraper.currentState = response.state;
      renderOverlay(response.state);
    } catch {
      renderOverlay({ status: "idle", message: "Ready" });
    }
  }

  function ensureOverlay() {
    if (document.getElementById("linkedin-job-scraper-overlay")) {
      return;
    }

    const overlay = document.createElement("section");
    overlay.id = "linkedin-job-scraper-overlay";
    overlay.innerHTML = `
      <div class="lijs-header">
        <strong>Job Scraper</strong>
        <button type="button" class="lijs-icon-button" data-lijs-action="minimize" title="Minimize">_</button>
      </div>
      <div class="lijs-body">
        <div class="lijs-status" data-lijs-status>Ready</div>
        <div class="lijs-progress-track" aria-label="Scrape progress">
          <div class="lijs-progress-bar" data-lijs-progress></div>
        </div>
        <div class="lijs-count" data-lijs-count>0 jobs</div>
        <div class="lijs-count" data-lijs-tabs>Open tabs: 0/6</div>
        <div class="lijs-actions">
          <button type="button" data-lijs-action="start">Start</button>
          <button type="button" data-lijs-action="pause">Pause</button>
          <button type="button" data-lijs-action="resume">Resume</button>
          <button type="button" data-lijs-action="stop">Stop</button>
        </div>
        <div class="lijs-actions lijs-actions-secondary">
          <button type="button" data-lijs-action="csv">CSV</button>
          <button type="button" data-lijs-action="json">JSON</button>
        </div>
      </div>
    `;

    overlay.addEventListener("click", async (event) => {
      const button = event.target.closest("[data-lijs-action]");
      if (!button) {
        return;
      }
      const action = button.getAttribute("data-lijs-action");
      try {
        if (action === "minimize") {
          overlay.classList.toggle("lijs-minimized");
          button.textContent = overlay.classList.contains("lijs-minimized") ? "+" : "_";
        } else if (action === "start") {
          await startScraping();
        } else if (action === "pause") {
          await sendBackground({ type: "SCRAPER_CONTROL", command: "PAUSE" });
        } else if (action === "resume") {
          scraper.stopRequested = false;
          await sendBackground({ type: "SCRAPER_CONTROL", command: "RESUME" });
          if (!scraper.task) {
            scraper.task = runScraper().finally(() => {
              scraper.task = null;
            });
          }
        } else if (action === "stop") {
          scraper.stopRequested = true;
          await sendBackground({ type: "SCRAPER_CONTROL", command: "STOP" });
        } else if (action === "csv") {
          await sendBackground({ type: "EXPORT_CSV" });
        } else if (action === "json") {
          await sendBackground({ type: "EXPORT_JSON" });
        }
      } catch (error) {
        renderOverlay({ status: "error", message: error.message || String(error) });
      }
    });

    document.documentElement.appendChild(overlay);
  }

  function renderOverlay(state, batch) {
    const overlay = document.getElementById("linkedin-job-scraper-overlay");
    if (!overlay) {
      return;
    }

    const status = state?.status || "idle";
    const count = Number(state?.scrapedCount ?? 0);
    const total = Number(state?.totalEstimate ?? 0);
    const percentage = total > 0 ? Math.min(100, Math.round((count / total) * 100)) : batch?.percent || 0;

    overlay.dataset.status = status;
    overlay.querySelector("[data-lijs-status]").textContent =
      `${capitalize(status)} - ${state?.message || "Ready"}`;
    overlay.querySelector("[data-lijs-count]").textContent =
      total ? `Scraped ${count} / ~${total} jobs` : `Scraped ${count} jobs`;
    overlay.querySelector("[data-lijs-progress]").style.width =
      total ? `${percentage}%` : status === "running" ? "12%" : `${percentage}%`;
    overlay.querySelector("[data-lijs-tabs]").textContent =
      `Open tabs: ${state?.activeTabCount || 0}/${state?.activeTabLimit || 6}`;
  }

  function capitalize(value) {
    const text = String(value || "");
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  function isSupportedResultsUrl(url) {
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

  function hasJobSignal(card) {
    return Boolean(
      card.getAttribute("data-job-id") ||
        card.getAttribute("data-occludable-job-id") ||
        card.querySelector("a[href*='/jobs/view/']") ||
        findFirst(card, SELECTORS.cardTitle)
    );
  }

  function extractJobIdFromElement(element) {
    const idAttr =
      element.getAttribute?.("data-job-id") ||
      element.getAttribute?.("data-occludable-job-id") ||
      element.querySelector?.("[data-job-id]")?.getAttribute("data-job-id") ||
      element.querySelector?.("[data-occludable-job-id]")?.getAttribute("data-occludable-job-id");
    if (idAttr) {
      return idAttr;
    }
    const link = element.querySelector?.("a[href*='/jobs/view/']");
    return extractJobIdFromUrl(link?.getAttribute("href") || "");
  }

  function extractJobIdFromUrl(url) {
    if (!url) {
      return "";
    }
    const decoded = decodeURIComponent(url);
    const patterns = [/\/jobs\/view\/(\d+)/i, /currentJobId=(\d+)/i, /jobId=(\d+)/i];
    for (const pattern of patterns) {
      const match = decoded.match(pattern);
      if (match?.[1]) {
        return match[1];
      }
    }
    return "";
  }

  function extractWorkplaceType(text) {
    const match = normalizeText(text).match(/\b(Remote|Hybrid|On-site|Onsite)\b/i);
    if (!match) {
      return "";
    }
    return match[1].replace(/Onsite/i, "On-site");
  }

  function extractJobType(text) {
    const normalized = normalizeText(text);
    const types = ["Full-time", "Part-time", "Contract", "Temporary", "Internship", "Volunteer", "Other"];
    return types.find((type) => new RegExp(`\\b${escapeRegExp(type)}\\b`, "i").test(normalized)) || "";
  }

  function cleanJobTitle(text) {
    return normalizeText(text)
      .replace(/\s+with verification\b/i, "")
      .replace(/\s+Promoted\b/i, "")
      .trim();
  }

  function findFirst(root, selectors) {
    for (const selector of selectors) {
      const node = root.querySelector(selector);
      if (node) {
        return node;
      }
    }
    return null;
  }

  function firstNonEmptyText(root, selectors) {
    for (const selector of selectors) {
      const nodes = Array.from(root.querySelectorAll(selector));
      for (const node of nodes) {
        const text = normalizeText(node.innerText || node.textContent || "");
        if (text) {
          return text;
        }
      }
    }
    return "";
  }

  function collectText(root, selectors) {
    return selectors.flatMap((selector) =>
      Array.from(root.querySelectorAll(selector))
        .map((node) => normalizeText(node.innerText || node.textContent || ""))
        .filter(Boolean)
    );
  }

  function textFromNode(node) {
    return normalizeText(node?.innerText || node?.textContent || "");
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

  function toAbsoluteUrl(url) {
    if (!url) {
      return "";
    }
    try {
      return new URL(url, location.origin).toString();
    } catch {
      return url;
    }
  }

  function isVisible(element) {
    if (!element || !element.getClientRects().length) {
      return false;
    }
    const style = window.getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) !== 0;
  }

  function uniqueElements(elements) {
    return Array.from(new Set(elements));
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function waitForAny(selectors, timeoutMs) {
    return waitForCondition(() => {
      return selectors.some((selector) => document.querySelector(selector));
    }, timeoutMs);
  }

  function waitForCondition(check, timeoutMs) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      let observer;
      let intervalId;

      const cleanup = () => {
        observer?.disconnect();
        if (intervalId) {
          clearInterval(intervalId);
        }
      };

      const run = () => {
        try {
          if (check()) {
            cleanup();
            resolve(true);
            return;
          }
        } catch {
          // Keep polling on transient DOM exceptions.
        }
        if (Date.now() - started >= timeoutMs) {
          cleanup();
          reject(new Error("Timed out waiting for LinkedIn DOM"));
        }
      };

      observer = new MutationObserver(run);
      observer.observe(document.documentElement, { childList: true, subtree: true });
      intervalId = setInterval(run, 350);
      run();
    });
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function randomBetween(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
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
})();
