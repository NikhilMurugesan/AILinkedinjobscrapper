(() => {
  if (window.__LINKEDIN_JOB_SCRAPER_LOADED__) {
    return;
  }
  window.__LINKEDIN_JOB_SCRAPER_LOADED__ = true;

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
    detailPanel: [
      ".jobs-search__job-details--container",
      ".jobs-search__job-details",
      ".jobs-details",
      ".jobs-details__main-content",
      ".jobs-unified-top-card"
    ],
    detailTitle: [
      ".jobs-unified-top-card__job-title",
      ".jobs-unified-top-card__title",
      "h1 a[href*='/jobs/view/']",
      "h1"
    ],
    detailCompany: [
      ".jobs-unified-top-card__company-name",
      ".jobs-unified-top-card__company-name a",
      ".jobs-unified-top-card__primary-description a"
    ],
    detailLocation: [
      ".jobs-unified-top-card__bullet",
      ".jobs-unified-top-card__primary-description-container span",
      ".jobs-unified-top-card__primary-description"
    ],
    detailDescription: [
      ".jobs-description-content__text",
      ".jobs-box__html-content",
      "#job-details",
      ".jobs-description__content",
      ".description__text",
      ".show-more-less-html__markup"
    ],
    detailCriteriaItems: [
      ".description__job-criteria-item",
      ".jobs-description-details__list-item",
      ".jobs-unified-top-card__job-insight",
      ".job-details-jobs-unified-top-card__job-insight"
    ],
    applyLinks: [
      "a.jobs-apply-button",
      ".jobs-apply-button a",
      "a[href*='/jobs/apply/']",
      "a[href*='externalApply']",
      "a[href*='jobApplication']"
    ],
    applyButtons: [
      ".jobs-apply-button",
      "button.jobs-apply-button",
      "button[aria-label*='Apply']",
      "button[aria-label*='Easy Apply']"
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

  const STORAGE_STATUS = {
    idle: "idle",
    running: "running",
    paused: "paused",
    stopped: "stopped",
    complete: "complete",
    blocked: "blocked",
    error: "error"
  };

  const MAX_JOB_RETRIES = 3;
  const EMPTY_SCROLL_LIMIT = 5;
  const DETAIL_TIMEOUT_MS = 12000;
  const CARD_WAIT_TIMEOUT_MS = 15000;

  const scraper = {
    status: STORAGE_STATUS.idle,
    stopRequested: false,
    pauseResolver: null,
    task: null,
    jobsSeen: new Set(),
    totalEstimate: null,
    lastMessage: "Ready"
  };

  ensureOverlay();
  hydrateFromStorage();

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "SCRAPER_COMMAND") {
      return false;
    }

    handleRuntimeMessage(message)
      .then((response) => sendResponse(response))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  });

  // Starts a fresh scrape, clearing stored data before collecting the current search.
  async function startScraping() {
    if (!isSupportedJobsUrl(location.href)) {
      await setStatus(STORAGE_STATUS.error, "Open a LinkedIn Jobs search or collection page first.");
      return { ok: false, error: "Unsupported LinkedIn Jobs URL" };
    }

    if (scraper.task && scraper.status === STORAGE_STATUS.running) {
      return { ok: true, message: "Scrape already running" };
    }

    scraper.stopRequested = false;
    scraper.pauseResolver = null;
    scraper.jobsSeen = new Set();
    scraper.totalEstimate = getTotalEstimate();

    await sendBackground({ type: "CLEAR_SCRAPER_DATA" });
    await setStatus(STORAGE_STATUS.running, "Starting scrape...", {
      totalEstimate: scraper.totalEstimate,
      startedAt: new Date().toISOString(),
      scrapedCount: 0
    });

    scraper.task = runScraper()
      .catch(async (error) => {
        console.error("LinkedIn Job Scraper content error:", error);
        await setStatus(STORAGE_STATUS.error, error.message || "Scrape failed");
      })
      .finally(() => {
        scraper.task = null;
      });

    return { ok: true };
  }

  // Pauses the running scrape after the current awaited operation completes.
  async function pauseScraping() {
    if (scraper.status !== STORAGE_STATUS.running) {
      return { ok: true };
    }
    scraper.status = STORAGE_STATUS.paused;
    await setStatus(STORAGE_STATUS.paused, "Paused");
    return { ok: true };
  }

  // Resumes a paused scrape loop without clearing stored data.
  async function resumeScraping() {
    if (scraper.status !== STORAGE_STATUS.paused) {
      return { ok: true };
    }
    scraper.status = STORAGE_STATUS.running;
    await setStatus(STORAGE_STATUS.running, "Resuming...");
    if (scraper.pauseResolver) {
      scraper.pauseResolver();
      scraper.pauseResolver = null;
    }
    return { ok: true };
  }

  // Stops the scrape loop while preserving already-scraped jobs for export.
  async function stopScraping() {
    scraper.stopRequested = true;
    if (scraper.pauseResolver) {
      scraper.pauseResolver();
      scraper.pauseResolver = null;
    }
    await setStatus(STORAGE_STATUS.stopped, "Stopped by user");
    return { ok: true };
  }

  // Main scrape loop: process visible cards, scroll lazy-loaded lists, and click next page when present.
  async function runScraper() {
    let emptyScrollPasses = 0;
    let pageNumber = 1;

    await waitForAny(SELECTORS.jobCards, CARD_WAIT_TIMEOUT_MS);

    while (!scraper.stopRequested) {
      await waitIfPaused();
      if (await detectBlocker()) {
        return;
      }

      const countBefore = scraper.jobsSeen.size;
      await setStatus(STORAGE_STATUS.running, `Scanning page ${pageNumber}...`);
      await processVisibleCards();

      if (scraper.stopRequested) {
        break;
      }

      if (scraper.jobsSeen.size === countBefore) {
        emptyScrollPasses += 1;
      } else {
        emptyScrollPasses = 0;
      }

      if (emptyScrollPasses >= EMPTY_SCROLL_LIMIT) {
        const advanced = await advanceToNextResultPage(pageNumber + 1);
        if (!advanced) {
          break;
        }
        pageNumber += 1;
        emptyScrollPasses = 0;
        continue;
      }

      await scrollResultsPanel();
      await delay(randomBetween(1500, 3000));
    }

    if (scraper.stopRequested) {
      await setStatus(STORAGE_STATUS.stopped, "Stopped. Existing data is ready to export.");
      return;
    }

    await setStatus(STORAGE_STATUS.complete, "Complete. Export is ready.");
  }

  // Scrapes the currently rendered job cards before the list virtualizes them away.
  async function processVisibleCards() {
    const cards = getVisibleJobCards();

    for (let index = 0; index < cards.length; index += 1) {
      if (scraper.stopRequested) {
        return;
      }
      await waitIfPaused();

      const card = cards[index];
      const cardData = extractCardData(card);
      const key = cardData.linkedinJobId || cardData.linkedinUrl || cardData.fingerprint;

      if (!key || scraper.jobsSeen.has(key)) {
        continue;
      }

      scraper.jobsSeen.add(key);
      await scrapeCardWithRetries(card, cardData, scraper.jobsSeen.size);
    }
  }

  // Handles per-job retry logic and stores a fallback row if detail loading fails.
  async function scrapeCardWithRetries(card, cardData, ordinal) {
    let lastError = null;

    for (let attempt = 1; attempt <= MAX_JOB_RETRIES; attempt += 1) {
      try {
        await setStatus(
          STORAGE_STATUS.running,
          `Fetching JD for job #${ordinal}${cardData.jobTitle ? `: ${cardData.jobTitle}` : ""}`,
          { currentJobTitle: cardData.jobTitle || "" }
        );
        const detailData = await clickAndExtractDetail(card, cardData.linkedinJobId);
        const job = normalizeJob(mergeJobData(cardData, detailData, {
          scrapeStatus: detailData.jobDescription ? "ok" : "JD unavailable",
          scrapedAt: new Date().toISOString()
        }));

        await sendBackground({ type: "UPSERT_JOB", job });
        await setStatus(STORAGE_STATUS.running, `Scraped ${scraper.jobsSeen.size} jobs`, {
          scrapedCount: scraper.jobsSeen.size
        });
        await delay(randomBetween(1500, 3000));
        return;
      } catch (error) {
        lastError = error;
        await delay(randomBetween(1200, 2200));
      }
    }

    const fallbackJob = normalizeJob({
      ...cardData,
      jobDescription: "",
      scrapeStatus: `Failed after ${MAX_JOB_RETRIES} retries: ${lastError?.message || "unknown error"}`,
      scrapedAt: new Date().toISOString()
    });
    await sendBackground({ type: "UPSERT_JOB", job: fallbackJob });
  }

  // Clicks a card, waits for the detail panel, expands the JD, and extracts detail fields.
  async function clickAndExtractDetail(card, expectedJobId) {
    const link = findFirst(card, SELECTORS.cardTitle) || card.querySelector("a[href*='/jobs/view/']");
    const target = link || card;

    scrollIntoView(target);
    await delay(randomBetween(250, 650));
    target.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: window }));
    target.click();

    const panel = await waitForDetailPanel(expectedJobId);
    await expandDescription(panel);
    return extractDetailData(panel);
  }

  async function waitForDetailPanel(expectedJobId) {
    return waitForCondition(() => {
      const panel = findFirst(document, SELECTORS.detailPanel);
      if (!panel) {
        return null;
      }

      const description = textFromFirst(panel, SELECTORS.detailDescription);
      const currentId = extractJobIdFromUrl(location.href) || extractJobIdFromElement(panel);
      if (description || !expectedJobId || currentId === expectedJobId || panel.innerText.length > 500) {
        return panel;
      }
      return null;
    }, DETAIL_TIMEOUT_MS);
  }

  async function expandDescription(panel) {
    const buttons = Array.from(panel.querySelectorAll("button")).filter((button) => {
      const text = normalizeText(button.innerText || button.getAttribute("aria-label") || "");
      return /show more|see more|more/i.test(text);
    });

    for (const button of buttons.slice(0, 3)) {
      if (isVisible(button)) {
        button.click();
        await delay(300);
      }
    }
  }

  // Extracts fields available directly on a search-result card.
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
      ...splitLocation(location),
      datePosted: firstNonEmptyText(card, SELECTORS.cardDate),
      jobType: extractJobType(`${location} ${insightText}`),
      workplaceType: extractWorkplaceType(`${location} ${insightText}`),
      linkedinJobId,
      linkedinUrl,
      fingerprint: fingerprint([
        textFromNode(titleNode),
        firstNonEmptyText(card, SELECTORS.cardCompany),
        location,
        linkedinUrl
      ])
    };
  }

  // Extracts fields that are only available after LinkedIn renders the detail panel.
  function extractDetailData(panel) {
    const criteria = extractCriteria(panel);
    const detailLocation = firstNonEmptyText(panel, SELECTORS.detailLocation);
    const jobLocation = cleanupLocation(detailLocation) || "";
    const apply = extractApplyInfo(panel);
    const description = textFromFirst(panel, SELECTORS.detailDescription);
    const allText = normalizeText(panel.innerText || "");
    const fallbackCriteria = extractCriteriaFromText(allText);

    return {
      jobTitle: cleanJobTitle(firstNonEmptyText(panel, SELECTORS.detailTitle)),
      companyName: firstNonEmptyText(panel, SELECTORS.detailCompany),
      location: jobLocation,
      ...splitLocation(jobLocation),
      jobDescription: description || "",
      directApplyUrl: apply.url,
      applyType: apply.type,
      seniorityLevel: criteria.seniorityLevel || fallbackCriteria.seniorityLevel || "",
      employmentType: criteria.employmentType || fallbackCriteria.employmentType || "",
      industries: criteria.industries || fallbackCriteria.industries || "",
      jobType:
        criteria.employmentType ||
        fallbackCriteria.employmentType ||
        extractJobType(`${allText} ${jobLocation}`),
      workplaceType: extractWorkplaceType(`${allText} ${jobLocation}`),
      linkedinJobId: extractJobIdFromUrl(window.location.href) || extractJobIdFromElement(panel),
      linkedinUrl: toAbsoluteUrl(window.location.href)
    };
  }

  // Parses seniority, employment type, and industries from LinkedIn criteria blocks.
  function extractCriteria(panel) {
    const criteria = {};
    const items = SELECTORS.detailCriteriaItems.flatMap((selector) =>
      Array.from(panel.querySelectorAll(selector))
    );

    for (const item of items) {
      const text = normalizeText(item.innerText || "");
      if (!text) {
        continue;
      }

      const lines = text.split("\n").map(normalizeText).filter(Boolean);
      const label = lines[0] || "";
      const value = lines.slice(1).join(", ") || text.replace(label, "").trim();
      setCriteriaValue(criteria, label, value);
    }

    return criteria;
  }

  function extractCriteriaFromText(text) {
    const criteria = {};
    const labels = [
      ["seniorityLevel", /Seniority level\s*([\s\S]{0,160}?)(?:Employment type|Job function|Industries|$)/i],
      ["employmentType", /Employment type\s*([\s\S]{0,160}?)(?:Job function|Industries|Seniority level|$)/i],
      ["industries", /Industries\s*([\s\S]{0,220}?)(?:Seniority level|Employment type|Job function|$)/i]
    ];

    for (const [key, regex] of labels) {
      const match = text.match(regex);
      if (match?.[1]) {
        criteria[key] = normalizeText(match[1]).split("\n")[0];
      }
    }
    return criteria;
  }

  function setCriteriaValue(criteria, rawLabel, rawValue) {
    const label = normalizeText(rawLabel).toLowerCase();
    const value = normalizeText(rawValue);
    if (!value || value === rawLabel) {
      return;
    }
    if (label.includes("seniority")) {
      criteria.seniorityLevel = value;
    } else if (label.includes("employment")) {
      criteria.employmentType = value;
    } else if (label.includes("industr")) {
      criteria.industries = value;
    }
  }

  // Captures Easy Apply versus external apply links when LinkedIn exposes them in the DOM.
  function extractApplyInfo(panel) {
    const links = SELECTORS.applyLinks.flatMap((selector) => Array.from(panel.querySelectorAll(selector)));
    const buttons = SELECTORS.applyButtons.flatMap((selector) =>
      Array.from(panel.querySelectorAll(selector))
    );

    const externalLink = links
      .map((link) => toAbsoluteUrl(link.getAttribute("href") || ""))
      .find((href) => href && !href.includes("linkedin.com/jobs/view/"));

    const buttonText = normalizeText(buttons.map((button) => button.innerText || button.getAttribute("aria-label") || "").join(" "));

    if (/easy apply/i.test(buttonText)) {
      return { type: "Easy Apply", url: externalLink || toAbsoluteUrl(location.href) };
    }

    if (externalLink) {
      return { type: "External Apply", url: externalLink };
    }

    if (/apply/i.test(buttonText)) {
      return { type: "Apply button detected", url: toAbsoluteUrl(location.href) };
    }

    return { type: "Unavailable", url: "" };
  }

  // Clicks lazy-load or pagination controls when scrolling stops revealing new jobs.
  async function advanceToNextResultPage(pageNumber) {
    await setStatus(STORAGE_STATUS.running, `Looking for page ${pageNumber}...`);

    const showMore = SELECTORS.showMoreButtons
      .map((selector) => document.querySelector(selector))
      .find((button) => button && isVisible(button) && !button.disabled);
    if (showMore) {
      showMore.click();
      await delay(randomBetween(1500, 3000));
      return true;
    }

    const nextButton = SELECTORS.nextButtons
      .map((selector) => document.querySelector(selector))
      .find((button) => button && isVisible(button) && !button.disabled && button.getAttribute("aria-disabled") !== "true");

    if (!nextButton) {
      return false;
    }

    nextButton.click();
    await setStatus(STORAGE_STATUS.running, `Loading page ${pageNumber}...`);
    await delay(randomBetween(1800, 3200));
    await waitForAny(SELECTORS.jobCards, CARD_WAIT_TIMEOUT_MS);
    return true;
  }

  // Scrolls the result list rather than the detail panel whenever LinkedIn exposes it.
  async function scrollResultsPanel() {
    const container = getResultsContainer();
    if (!container) {
      window.scrollBy({ top: window.innerHeight * 0.8, behavior: "smooth" });
      return;
    }

    const amount = Math.max(container.clientHeight * 0.85, 550);
    if (container === document.body || container === document.documentElement || container === document.scrollingElement) {
      window.scrollBy({ top: amount, behavior: "smooth" });
      return;
    }
    container.scrollBy({ top: amount, behavior: "smooth" });
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

  // Detects common CAPTCHA, security challenge, auth wall, and login-wall states.
  async function detectBlocker() {
    const selectorHit = SELECTORS.blockerCandidates.some((selector) => document.querySelector(selector));
    const bodyText = normalizeText(document.body?.innerText || "");
    const textHit = /captcha|security check|verify.*human|sign in to continue|join linkedin/i.test(bodyText);

    if (selectorHit || textHit) {
      scraper.stopRequested = true;
      await setStatus(STORAGE_STATUS.blocked, "LinkedIn requested verification or login. Scrape paused.");
      alert("LinkedIn Job Scraper paused because LinkedIn requested verification or login. Complete the challenge, then start a new scrape.");
      return true;
    }
    return false;
  }

  async function waitIfPaused() {
    while (scraper.status === STORAGE_STATUS.paused && !scraper.stopRequested) {
      await new Promise((resolve) => {
        scraper.pauseResolver = resolve;
      });
    }
  }

  async function handleRuntimeMessage(message) {
    switch (message.command) {
      case "START":
        return startScraping();
      case "PAUSE":
        return pauseScraping();
      case "RESUME":
        return resumeScraping();
      case "STOP":
        return stopScraping();
      case "PING":
        return { ok: true, status: scraper.status };
      default:
        return { ok: false, error: "Unknown command" };
    }
  }

  async function hydrateFromStorage() {
    const response = await sendBackground({ type: "GET_SCRAPER_DATA" }).catch(() => null);
    const state = response?.state || {};
    scraper.status = state.status || STORAGE_STATUS.idle;
    scraper.totalEstimate = state.totalEstimate || getTotalEstimate();
    updateOverlay(state);
  }

  async function setStatus(status, message, patch = {}) {
    scraper.status = status;
    scraper.lastMessage = message;
    const statePatch = {
      status,
      message,
      totalEstimate: scraper.totalEstimate,
      ...patch
    };
    await sendBackground({ type: "UPDATE_SCRAPER_STATE", patch: statePatch });
    updateOverlay(statePatch);
  }

  // Creates the floating in-page progress overlay and wires its controls.
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
      if (action === "minimize") {
        overlay.classList.toggle("lijs-minimized");
        button.textContent = overlay.classList.contains("lijs-minimized") ? "+" : "_";
      } else if (action === "start") {
        await startScraping();
      } else if (action === "pause") {
        await pauseScraping();
      } else if (action === "resume") {
        await resumeScraping();
      } else if (action === "stop") {
        await stopScraping();
      } else if (action === "csv") {
        await sendBackground({ type: "EXPORT_CSV" });
      } else if (action === "json") {
        await sendBackground({ type: "EXPORT_JSON" });
      }
    });

    document.documentElement.appendChild(overlay);
  }

  function updateOverlay(state = {}) {
    const overlay = document.getElementById("linkedin-job-scraper-overlay");
    if (!overlay) {
      return;
    }

    const status = state.status || scraper.status || STORAGE_STATUS.idle;
    const count = Number(state.scrapedCount ?? scraper.jobsSeen.size ?? 0);
    const total = Number(state.totalEstimate ?? scraper.totalEstimate ?? 0);
    const percentage = total > 0 ? Math.min(100, Math.round((count / total) * 100)) : 0;

    const statusNode = overlay.querySelector("[data-lijs-status]");
    const countNode = overlay.querySelector("[data-lijs-count]");
    const progressNode = overlay.querySelector("[data-lijs-progress]");

    statusNode.textContent = state.message || scraper.lastMessage || status;
    countNode.textContent = total ? `Scraped ${count} / ~${total} jobs` : `Scraped ${count} jobs`;
    progressNode.style.width = total ? `${percentage}%` : status === STORAGE_STATUS.running ? "12%" : "0%";

    overlay.dataset.status = status;
  }

  function getTotalEstimate() {
    const text = collectText(document, SELECTORS.totalCountCandidates).join(" ");
    const match = text.match(/([\d,.]+)\s*\+?\s*(?:jobs|results)/i) || text.match(/([\d,.]+)\s*\+?/);
    if (!match) {
      return null;
    }
    const parsed = Number(match[1].replace(/[^\d]/g, ""));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  // Produces the final export shape with stable keys and normalized text.
  function normalizeJob(job) {
    const mergedLocation = job.location || "";
    const split = splitLocation(mergedLocation);
    const linkedinUrl = toAbsoluteUrl(job.linkedinUrl || location.href);
    return {
      jobTitle: cleanJobTitle(job.jobTitle),
      companyName: normalizeText(job.companyName),
      location: normalizeText(mergedLocation),
      city: normalizeText(job.city || split.city),
      country: normalizeText(job.country || split.country),
      jobType: normalizeText(job.jobType),
      workplaceType: normalizeText(job.workplaceType),
      datePosted: normalizeText(job.datePosted),
      jobDescription: normalizeText(job.jobDescription),
      applyType: normalizeText(job.applyType),
      directApplyUrl: toAbsoluteUrl(job.directApplyUrl || ""),
      linkedinJobId: normalizeText(job.linkedinJobId || extractJobIdFromUrl(linkedinUrl)),
      linkedinUrl,
      seniorityLevel: normalizeText(job.seniorityLevel),
      employmentType: normalizeText(job.employmentType),
      industries: normalizeText(job.industries),
      scrapedAt: job.scrapedAt || new Date().toISOString(),
      scrapeStatus: normalizeText(job.scrapeStatus || "ok")
    };
  }

  // Keeps good card values when LinkedIn's detail panel omits a field.
  function mergeJobData(base, detail, extras = {}) {
    const merged = { ...base };
    for (const [key, value] of Object.entries(detail || {})) {
      if (value !== undefined && value !== null && String(value).trim() !== "") {
        merged[key] = value;
      }
    }
    return { ...merged, ...extras };
  }

  function isSupportedJobsUrl(url) {
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
    const patterns = [
      /\/jobs\/view\/(\d+)/i,
      /currentJobId=(\d+)/i,
      /jobId=(\d+)/i,
      /jk=(\d+)/i
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
    const normalized = cleanupLocation(location);
    if (!normalized) {
      return { city: "", country: "" };
    }
    const parts = normalized.split(",").map((part) => part.trim()).filter(Boolean);
    return {
      city: parts[0] || normalized,
      country: parts.length > 1 ? parts[parts.length - 1] : ""
    };
  }

  function cleanupLocation(location) {
    return normalizeText(location)
      .replace(/\b\d+\s+(?:applicants?|connections?)\b/gi, "")
      .replace(/\b(?:reposted|posted)\b.*$/i, "")
      .replace(/\s+\((?:Remote|Hybrid|On-site)\)$/i, "")
      .trim();
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
    const types = [
      "Full-time",
      "Part-time",
      "Contract",
      "Temporary",
      "Internship",
      "Volunteer",
      "Other",
      "Remote",
      "Hybrid",
      "On-site"
    ];
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

  function textFromFirst(root, selectors) {
    const node = findFirst(root, selectors);
    return textFromNode(node);
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

  function scrollIntoView(element) {
    element.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
  }

  function uniqueElements(elements) {
    return Array.from(new Set(elements));
  }

  function fingerprint(parts) {
    const input = parts.map((part) => normalizeText(part)).join("|");
    let hash = 0;
    for (let index = 0; index < input.length; index += 1) {
      hash = (hash << 5) - hash + input.charCodeAt(index);
      hash |= 0;
    }
    return `fingerprint-${Math.abs(hash)}`;
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function randomBetween(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function waitForAny(selectors, timeoutMs) {
    return waitForCondition(() => findFirst(document, selectors), timeoutMs);
  }

  function waitForCondition(check, timeoutMs) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      let observer;
      let intervalId;

      const run = () => {
        const result = check();
        if (result) {
          cleanup();
          resolve(result);
          return;
        }
        if (Date.now() - started >= timeoutMs) {
          cleanup();
          reject(new Error("Timed out waiting for LinkedIn content to load"));
        }
      };

      const cleanup = () => {
        if (observer) {
          observer.disconnect();
        }
        if (intervalId) {
          clearInterval(intervalId);
        }
      };

      observer = new MutationObserver(run);
      observer.observe(document.documentElement, { childList: true, subtree: true });
      intervalId = setInterval(run, 500);
      run();
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
          reject(new Error(response.error || "Extension background request failed"));
          return;
        }
        resolve(response || { ok: true });
      });
    });
  }
})();
