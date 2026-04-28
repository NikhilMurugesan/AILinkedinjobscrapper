(() => {
  if (window.__NAUKRI_JOB_SCRAPER_RESULTS_LOADED__) {
    return;
  }
  window.__NAUKRI_JOB_SCRAPER_RESULTS_LOADED__ = true;

  const SELECTORS = {
    resultsContainer: [
      "main",
      "#root",
      ".list",
      ".srp-container",
      "[class*='srp']",
      "[class*='search-result']"
    ],
    jobCards: [
      ".srp-jobtuple-wrapper",
      "article.jobTuple",
      "div.jobTuple",
      "div[class*='srp-jobtuple-wrapper']",
      "div[class*='jobTuple']",
      "[data-job-id]",
      "[data-jobsearch-job-id]",
      "[data-job]"
    ],
    cardTitle: [
      "a.title",
      "a[class*='title']",
      "h2 a",
      "h3 a",
      "a[href*='job-listings']"
    ],
    cardCompany: [
      "a.comp-name",
      "a[class*='comp-name']",
      ".companyInfo .subTitle",
      ".subTitle",
      "[class*='company'] a",
      "[class*='company']"
    ],
    cardExperience: [
      ".exp-wrap .expwdth",
      "[class*='exp-wrap'] [class*='exp']",
      "[class*='experience']",
      "span[title*='Yrs']",
      "span[title*='Years']",
      "li[class*='experience']"
    ],
    cardSalary: [
      ".sal-wrap .sal",
      "[class*='sal-wrap'] [class*='sal']",
      "[class*='salary']",
      "span[title*='Lacs']",
      "span[title*='Not disclosed']",
      "li[class*='salary']"
    ],
    cardLocation: [
      ".loc-wrap .locWdth",
      "[class*='loc-wrap'] [class*='loc']",
      "[class*='location']",
      "span[title*=',']",
      "li[class*='location']"
    ],
    cardSkills: [
      ".tags-gt .tag-li",
      ".tag-li",
      "[class*='tags'] li",
      "[class*='skill']",
      "ul li"
    ],
    cardDate: [
      ".job-post-day",
      "[class*='job-post-day']",
      "[class*='posted']",
      "[class*='freshness']",
      "time"
    ],
    cardDescription: [
      ".job-desc",
      "[class*='job-desc']",
      "[class*='description']"
    ],
    cardRating: [
      ".rating",
      "[class*='rating']",
      "[class*='starRating']"
    ],
    paginationContainer: [
      ".pagination",
      "[class*='pagination']",
      "[class*='pages']",
      "nav[aria-label*='Pagination']",
      "nav"
    ],
    nextButtons: [
      "a[aria-label*='Next']",
      "button[aria-label*='Next']",
      "a[title*='Next']",
      "button[title*='Next']",
      "a[rel='next']",
      "[class*='next']"
    ],
    activePage: [
      ".selected",
      ".active",
      "[aria-current='page']",
      "[class*='selected']",
      "[class*='active']"
    ],
    totalCountCandidates: [
      "h1",
      "[class*='count-string']",
      "[class*='job-count']",
      "[class*='result-count']",
      "[class*='sortAndH1']",
      "[aria-live='polite']"
    ],
    noResultsCandidates: [
      "[class*='no-result']",
      "[class*='noResult']",
      "[class*='zero']"
    ],
    captchaCandidates: [
      "iframe[src*='captcha']",
      "[id*='captcha']",
      "[class*='captcha']",
      "[data-testid*='captcha']",
      "input[name*='captcha']"
    ],
    loginWallCandidates: [
      "input[type='password']",
      "[class*='login']",
      "[class*='register']",
      "a[href*='login']"
    ]
  };

  const CARD_WAIT_TIMEOUT_MS = 15000;
  const BATCH_POLL_MS = 1000;
  const PAGE_CHANGE_TIMEOUT_MS = 12000;
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
        scraper.task = runScraper(false).finally(() => {
          scraper.task = null;
        });
      }
      return response;
    }
    if (normalized === "STOP") {
      scraper.stopRequested = true;
      return sendBackground({ type: "SCRAPER_CONTROL", command: "STOP" });
    }
    return { ok: false, error: `Unsupported command: ${command}` };
  }

  async function startScraping() {
    if (!isSupportedResultsUrl(location.href)) {
      throw new Error("Open a Naukri job search results page first.");
    }
    if (scraper.task) {
      return { ok: true, message: "Scrape already running" };
    }

    scraper.stopRequested = false;
    await sendBackground({ type: "NEW_SCRAPE", page: getPageInfo() });
    scraper.task = runScraper(true).finally(() => {
      scraper.task = null;
    });
    return { ok: true };
  }

  // Continues automatically after Naukri loads the next results page.
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
        scraper.task = runScraper(false).finally(() => {
          scraper.task = null;
        });
      }
    } catch (error) {
      renderOverlay({ status: "error", message: error.message || String(error) });
    }
  }

  // Scrapes the current results page, waits for background detail tabs, then paginates.
  async function runScraper() {
    while (!scraper.stopRequested) {
      const status = await waitForRunnableState();
      if (status !== "running") {
        return;
      }

      if (detectCaptcha()) {
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

      const cards = await waitForJobCards();
      if (!cards.length) {
        if (detectCaptcha()) {
          await sendBackground({ type: "CAPTCHA_DETECTED", source: "results page" });
          continue;
        }
        if (isNoResultsPage()) {
          await markComplete("No result cards found.");
          return;
        }
        throw new Error("Timed out waiting for Naukri result cards.");
      }

      const jobs = scrapeJobsFromCards(cards, pageInfo);
      if (!jobs.length) {
        await markComplete("No valid job URLs found on this page.");
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

      const nextControl = findNextPageControl();
      if (!nextControl) {
        await markComplete("Scraping complete.");
        return;
      }

      await updateStatus({
        status: "running",
        message: `Page ${pageInfo.pageNumber || "current"} complete`,
        currentAction: "Opening next results page"
      });

      const stayedInContext = await navigateToNextPage(nextControl);
      if (!stayedInContext) {
        return;
      }
    }
  }

  async function waitForJobCards() {
    try {
      await waitForCondition(() => {
        if (detectCaptcha()) {
          return true;
        }
        return getJobCards().length > 0;
      }, CARD_WAIT_TIMEOUT_MS);
    } catch {
      return [];
    }
    return getJobCards();
  }

  // Waits until all detail tabs for this page have finished or the user pauses/stops.
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

  // Blocks page work while the background state is paused or CAPTCHA-blocked.
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

  // Uses Naukri's visible pagination control and lets the next page auto-continue.
  async function navigateToNextPage(control) {
    const oldUrl = location.href;
    const oldSignature = pageSignature();

    if (control.href) {
      location.href = control.href;
    } else {
      control.element.click();
    }

    try {
      await waitForCondition(() => {
        return location.href !== oldUrl || pageSignature() !== oldSignature;
      }, PAGE_CHANGE_TIMEOUT_MS);
      await delay(600);
      return true;
    } catch {
      return false;
    }
  }

  // Extracts structured card data and de-duplicates repeated URLs on the same page.
  function scrapeJobsFromCards(cards, pageInfo) {
    const byUrl = new Map();
    cards.forEach((card, index) => {
      const job = extractJobFromCard(card, index, pageInfo);
      if (!job?.jobUrl) {
        return;
      }
      const key = canonicalizeUrl(job.jobUrl);
      if (!byUrl.has(key)) {
        byUrl.set(key, job);
      }
    });
    return Array.from(byUrl.values());
  }

  function extractJobFromCard(card, index, pageInfo) {
    const link = findJobLink(card);
    const jobUrl = toAbsoluteUrl(link?.getAttribute("href") || "");
    const cardText = textFromNode(card);
    const title = cleanCardTitle(textFromFirst(card, SELECTORS.cardTitle) || link?.textContent || "");

    return {
      jobTitle: title || `Naukri job ${index + 1}`,
      companyName: textFromFirst(card, SELECTORS.cardCompany),
      experienceRequired: textFromFirst(card, SELECTORS.cardExperience) || extractExperience(cardText),
      salaryRange: textFromFirst(card, SELECTORS.cardSalary) || extractSalary(cardText) || "Not Disclosed",
      locations: normalizeList(collectText(card, SELECTORS.cardLocation)),
      keySkills: normalizeList(collectText(card, SELECTORS.cardSkills)).filter((skill) => {
        return !looksLikeCardMetadata(skill);
      }),
      datePosted: textFromFirst(card, SELECTORS.cardDate) || extractFreshness(cardText),
      companyRating: textFromFirst(card, SELECTORS.cardRating),
      jobUrl,
      jobId: extractJobId(jobUrl) || extractJobIdFromCard(card),
      sourcePageNumber: pageInfo.pageNumber,
      sourcePageUrl: pageInfo.pageUrl,
      scrapeStatus: "Queued"
    };
  }

  function findJobLink(card) {
    const titleLink = findFirst(card, SELECTORS.cardTitle);
    if (titleLink?.matches?.("a[href]")) {
      return titleLink;
    }

    return Array.from(card.querySelectorAll("a[href]")).find((anchor) => {
      const href = anchor.getAttribute("href") || "";
      return /job-listings|\/job\//i.test(href);
    });
  }

  function getJobCards() {
    const cards = uniqueElements(
      SELECTORS.jobCards.flatMap((selector) => safeQueryAll(document, selector))
    ).filter((card) => {
      const link = findJobLink(card);
      return Boolean(link?.getAttribute("href")) && isVisible(card);
    });

    return cards.length ? cards : inferCardsFromLinks();
  }

  function inferCardsFromLinks() {
    const links = Array.from(document.querySelectorAll("a[href*='job-listings']"));
    return uniqueElements(
      links
        .map((link) => link.closest("article, li, div"))
        .filter(Boolean)
        .filter((node) => textFromNode(node).length > 30)
    );
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
    const queryPage = url.searchParams.get("pageNo") || url.searchParams.get("page") || url.searchParams.get("p");
    if (queryPage && Number(queryPage)) {
      return Number(queryPage);
    }

    const pathMatch = url.pathname.match(/-jobs-(\d+)\/?$/i);
    if (pathMatch?.[1]) {
      return Number(pathMatch[1]);
    }

    const active = SELECTORS.activePage.map((selector) => findFirst(document, [selector])).find(Boolean);
    const activeNumber = Number(textFromNode(active).match(/\d+/)?.[0]);
    return activeNumber || 1;
  }

  function getTotalEstimate() {
    const text = collectText(document, SELECTORS.totalCountCandidates).join(" ");
    const matches = Array.from(text.matchAll(/([\d,]+)\s+(?:jobs?|results?)/gi));
    if (!matches.length) {
      return null;
    }
    return Number(matches[0][1].replace(/,/g, "")) || null;
  }

  function findNextPageControl() {
    const selectorCandidates = uniqueElements(
      SELECTORS.nextButtons.flatMap((selector) => safeQueryAll(document, selector))
    );
    const textCandidates = Array.from(document.querySelectorAll("a[href], button")).filter((element) => {
      const label = [
        element.textContent,
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
        element.getAttribute("rel"),
        element.className
      ].join(" ");
      return /\bnext\b|\u203a|\u00bb|>\s*$/i.test(label);
    });

    const candidates = uniqueElements([...selectorCandidates, ...textCandidates]);
    for (const element of candidates) {
      if (!isVisible(element) || isDisabled(element)) {
        continue;
      }
      const href = element.matches("a[href]") ? toAbsoluteUrl(element.getAttribute("href")) : "";
      return { element, href };
    }

    const pageNumber = getCurrentPageNumber();
    if (!pageNumber) {
      return null;
    }
    const nextNumber = String(pageNumber + 1);
    const numberedNext = Array.from(document.querySelectorAll("a[href]")).find((anchor) => {
      return textFromNode(anchor) === nextNumber && isVisible(anchor) && !isDisabled(anchor);
    });
    if (numberedNext) {
      return { element: numberedNext, href: toAbsoluteUrl(numberedNext.getAttribute("href")) };
    }
    return null;
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
    if (document.getElementById("naukri-job-scraper-overlay")) {
      return;
    }

    const overlay = document.createElement("div");
    overlay.id = "naukri-job-scraper-overlay";
    overlay.innerHTML = `
      <div class="njs-header">
        <strong>Naukri Scraper</strong>
        <button type="button" class="njs-icon-button" data-njs-minimize title="Minimize">_</button>
      </div>
      <div class="njs-body">
        <div class="njs-status" data-njs-status>Ready</div>
        <div class="njs-progress-track" aria-hidden="true">
          <div class="njs-progress-bar" data-njs-progress></div>
        </div>
        <div class="njs-count" data-njs-count>Scraped 0 jobs</div>
        <div class="njs-current" data-njs-current>Current job: -</div>
        <div class="njs-tabs" data-njs-tabs>Open tabs: 0/2</div>
        <div class="njs-actions">
          <button type="button" data-njs-action="start">Start</button>
          <button type="button" data-njs-action="pause">Pause</button>
          <button type="button" data-njs-action="resume">Resume</button>
          <button type="button" data-njs-action="stop">Stop</button>
        </div>
        <div class="njs-actions njs-actions-secondary">
          <button type="button" data-njs-action="csv">CSV</button>
          <button type="button" data-njs-action="json">JSON</button>
          <button type="button" data-njs-action="clear-cache">Clear</button>
        </div>
      </div>
    `;
    document.documentElement.appendChild(overlay);

    overlay.querySelector("[data-njs-minimize]").addEventListener("click", () => {
      overlay.classList.toggle("njs-minimized");
    });

    overlay.querySelectorAll("[data-njs-action]").forEach((button) => {
      button.addEventListener("click", async () => {
        const action = button.getAttribute("data-njs-action");
        button.disabled = true;
        try {
          if (["start", "pause", "resume", "stop"].includes(action)) {
            await handleCommand(action.toUpperCase());
          } else if (action === "csv") {
            await sendBackground({ type: "EXPORT_CSV" });
          } else if (action === "json") {
            await sendBackground({ type: "EXPORT_JSON" });
          } else if (action === "clear-cache") {
            await sendBackground({ type: "CLEAR_SCRAPER_DATA" });
          }
        } catch (error) {
          renderOverlay({ status: "error", message: error.message || String(error) });
        } finally {
          button.disabled = false;
        }
      });
    });
  }

  function renderOverlay(state, batch) {
    const overlay = document.getElementById("naukri-job-scraper-overlay");
    if (!overlay) {
      return;
    }

    const scraped = state?.scrapedCount || 0;
    const total = state?.totalEstimate || null;
    const batchSuffix = batch && batch.total ? ` Page batch ${batch.completed}/${batch.total}.` : "";
    const progress = total ? Math.min(100, Math.round((scraped / total) * 100)) : batch?.percent || 0;
    const current = state?.currentJobTitle ? truncate(state.currentJobTitle, 56) : "-";

    overlay.dataset.status = state?.status || "idle";
    overlay.querySelector("[data-njs-status]").textContent = `${capitalize(state?.status || "idle")} - ${state?.message || "Ready"}${batchSuffix}`;
    overlay.querySelector("[data-njs-progress]").style.width = `${progress}%`;
    overlay.querySelector("[data-njs-count]").textContent = `Scraped ${scraped}${total ? ` / ~${total}` : ""} jobs`;
    overlay.querySelector("[data-njs-current]").textContent = `Current job: ${current}`;
    overlay.querySelector("[data-njs-tabs]").textContent = `Open tabs: ${state?.activeTabCount || 0}/${state?.activeTabLimit || 2}`;
  }

  function detectCaptcha() {
    if (findActiveCaptchaNode()) {
      return true;
    }
    return hasVisibleCaptchaText();
  }

  function findActiveCaptchaNode() {
    const candidates = uniqueElements(
      SELECTORS.captchaCandidates.flatMap((selector) => safeQueryAll(document, selector))
    );
    return candidates.find(isActiveCaptchaNode) || null;
  }

  function isActiveCaptchaNode(element) {
    if (!element || !isVisible(element)) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    const text = textFromNode(element);
    const descriptor = [
      element.id,
      element.className,
      element.getAttribute("src"),
      element.getAttribute("title"),
      element.getAttribute("aria-label"),
      text
    ].join(" ");

    if (/captcha|recaptcha|hcaptcha|verify you are human|not a robot/i.test(descriptor)) {
      return rect.width >= 40 && rect.height >= 20;
    }

    return false;
  }

  function hasVisibleCaptchaText() {
    const text = normalizeText(document.body?.innerText || "");
    const challengeText =
      /(?:enter|solve|complete)\s+(?:the\s+)?captcha/i.test(text) ||
      /verify\s+(?:that\s+)?you\s+are\s+(?:a\s+)?human/i.test(text) ||
      /unusual traffic|security check|not a robot|automated requests/i.test(text);

    if (!challengeText) {
      return false;
    }

    return getJobCards().length === 0 || Boolean(findActiveCaptchaNode());
  }

  function isNoResultsPage() {
    if (findFirst(document, SELECTORS.noResultsCandidates)) {
      return true;
    }
    return /no jobs found|no results found|could not find any jobs/i.test(document.body?.innerText || "");
  }

  function isSupportedResultsUrl(url) {
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

  function pageSignature() {
    return getJobCards()
      .slice(0, 5)
      .map((card) => findJobLink(card)?.getAttribute("href") || textFromNode(card).slice(0, 80))
      .join("|");
  }

  function extractJobIdFromCard(card) {
    const attrs = ["data-job-id", "data-jobsearch-job-id", "data-job", "id"];
    for (const attr of attrs) {
      const value = card.getAttribute(attr) || findFirst(card, [`[${attr}]`])?.getAttribute(attr);
      if (value) {
        return extractJobId(value) || value;
      }
    }
    return "";
  }

  function extractJobId(url) {
    const decoded = safeDecode(url || "");
    const patterns = [
      /(?:jobId|jobid|jk)=([A-Za-z0-9_-]+)/i,
      /\/job-listings-[^?#]*?-([0-9]{6,})(?:[?#]|$)/i,
      /-([0-9]{6,})(?:[?#]|$)/
    ];
    for (const pattern of patterns) {
      const match = decoded.match(pattern);
      if (match?.[1]) {
        return match[1];
      }
    }
    return "";
  }

  function extractExperience(text) {
    return normalizeText(text.match(/\b\d+\s*[-+]\s*\d*\s*(?:yrs?|years?)\b/i)?.[0] || "");
  }

  function extractSalary(text) {
    const notDisclosed = text.match(/not\s+disclosed/i)?.[0];
    if (notDisclosed) {
      return "Not Disclosed";
    }
    return normalizeText(text.match(/(?:\u20b9|Rs\.?|INR)?\s*[\d.]+\s*(?:-|to)\s*[\d.]+\s*(?:LPA|Lacs?|Lakhs?|Cr|Crores?)/i)?.[0] || "");
  }

  function extractFreshness(text) {
    return normalizeText(text.match(/\b(?:just now|few hours ago|\d+\s+(?:hours?|days?|weeks?)\s+ago|today|yesterday)\b/i)?.[0] || "");
  }

  function looksLikeCardMetadata(value) {
    return /^(view job|save|apply|posted|not disclosed|\d+\s*[-+]\s*\d*\s*yrs?)$/i.test(value);
  }

  function cleanCardTitle(value) {
    return normalizeText(value).replace(/\bnew\b$/i, "").trim();
  }

  function findFirst(root, selectors) {
    for (const selector of selectors) {
      const node = safeQueryAll(root, selector)[0];
      if (node) {
        return node;
      }
    }
    return null;
  }

  function textFromFirst(root, selectors) {
    const node = findFirst(root, selectors);
    return textFromNode(node);
  }

  function collectText(root, selectors) {
    return selectors.flatMap((selector) =>
      safeQueryAll(root, selector)
        .map(textFromNode)
        .flatMap((text) => text.split(/\n/))
        .map(normalizeText)
        .filter(Boolean)
    );
  }

  function textFromNode(node) {
    return normalizeText(node?.innerText || node?.textContent || node?.getAttribute?.("title") || "");
  }

  function normalizeList(values) {
    return Array.from(
      new Set(
        values
          .flatMap((value) => String(value || "").split(/\n|\u2022/))
          .map(normalizeText)
          .filter(Boolean)
      )
    );
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

  function safeQueryAll(root, selector) {
    try {
      return Array.from(root.querySelectorAll(selector));
    } catch {
      return [];
    }
  }

  function uniqueElements(elements) {
    return Array.from(new Set(elements));
  }

  function isVisible(element) {
    if (!element || !element.getClientRects().length) {
      return false;
    }
    const style = window.getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) !== 0;
  }

  function isDisabled(element) {
    return (
      element.disabled ||
      element.getAttribute("aria-disabled") === "true" ||
      /\bdisabled\b/i.test(element.className || "") ||
      /\bdisabled\b/i.test(element.parentElement?.className || "")
    );
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

  function canonicalizeUrl(url) {
    try {
      const parsed = new URL(url, location.origin);
      parsed.hash = "";
      ["src", "sid", "xp", "px", "utm_source", "utm_medium", "utm_campaign"].forEach((key) => {
        parsed.searchParams.delete(key);
      });
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

  function capitalize(value) {
    const text = String(value || "");
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  function truncate(value, maxLength) {
    const text = String(value || "");
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
        if (check()) {
          cleanup();
          resolve(true);
          return;
        }
        if (Date.now() - started >= timeoutMs) {
          cleanup();
          reject(new Error("Timed out waiting for page change"));
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
          reject(new Error(response.error || "Background request failed"));
          return;
        }
        resolve(response || { ok: true });
      });
    });
  }
})();
