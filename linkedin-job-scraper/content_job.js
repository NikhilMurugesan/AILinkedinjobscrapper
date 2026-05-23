// LinkedIn Job Scraper — detail-page extractor.
// Programmatically injected into background tabs opened at
// https://www.linkedin.com/jobs/view/{id}/. Reads the job detail DOM, sends the
// payload back via runtime.sendMessage, and also returns it so the background
// service worker can use the executeScript return value as a fallback.

(() => {
  if (window.__LINKEDIN_JOB_SCRAPER_DETAIL_RUNNING__) {
    return null;
  }
  window.__LINKEDIN_JOB_SCRAPER_DETAIL_RUNNING__ = true;

  const SELECTORS = {
    title: [
      ".jobs-unified-top-card__job-title",
      ".job-details-jobs-unified-top-card__job-title",
      ".top-card-layout__title",
      "h1 a[href*='/jobs/view/']",
      "h1"
    ],
    company: [
      ".jobs-unified-top-card__company-name",
      ".jobs-unified-top-card__company-name a",
      ".job-details-jobs-unified-top-card__company-name",
      ".jobs-unified-top-card__primary-description a",
      ".topcard__org-name-link",
      ".top-card-layout__second-subline a"
    ],
    location: [
      ".jobs-unified-top-card__bullet",
      ".jobs-unified-top-card__primary-description-container span",
      ".jobs-unified-top-card__primary-description",
      ".job-details-jobs-unified-top-card__primary-description-container",
      ".topcard__flavor--bullet",
      ".top-card-layout__second-subline"
    ],
    description: [
      ".jobs-description-content__text",
      ".jobs-box__html-content",
      "#job-details",
      ".jobs-description__content",
      ".description__text",
      ".show-more-less-html__markup"
    ],
    criteriaItems: [
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
    datePosted: [
      ".jobs-unified-top-card__posted-date",
      ".posted-time-ago__text",
      ".job-details-jobs-unified-top-card__primary-description-container time",
      "time"
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

  const DETAIL_WAIT_MS = 12000;

  return extractAndSend();

  async function extractAndSend() {
    let job;
    try {
      await waitForDetailPage();
      job = extractJobDetails();
    } catch (error) {
      job = {
        linkedinUrl: location.href,
        linkedinJobId: extractJobIdFromUrl(location.href),
        scrapeStatus: "Extraction Error",
        jobDescription: error.message || "Could not extract job detail page.",
        error: error.message || String(error)
      };
    }

    try {
      await chrome.runtime.sendMessage({ type: "JOB_DETAIL_EXTRACTED", job });
    } catch {
      // executeScript return value is the fallback path.
    }
    return job;
  }

  async function waitForDetailPage() {
    try {
      await waitForCondition(() => {
        if (detectBlocker()) {
          return true;
        }
        const hasTitle = Boolean(findFirst(document, SELECTORS.title));
        const hasDescription = Boolean(findFirst(document, SELECTORS.description));
        return hasTitle && (hasDescription || (document.body?.innerText || "").length > 1500);
      }, DETAIL_WAIT_MS);
    } catch {
      // extractJobDetails will surface whatever is on the page.
    }
  }

  function extractJobDetails() {
    if (detectBlocker()) {
      return {
        linkedinUrl: location.href,
        linkedinJobId: extractJobIdFromUrl(location.href),
        scrapeStatus: "Blocked",
        jobDescription: "LinkedIn verification or login wall encountered."
      };
    }

    const root = document;
    const criteria = extractCriteria(root);
    const allText = normalizeText(document.body?.innerText || "");
    const fallbackCriteria = extractCriteriaFromText(allText);
    const location = firstNonEmptyText(root, SELECTORS.location);
    const cleanLocation = cleanupLocation(location);
    const apply = extractApplyInfo(root);
    const description = textFromFirst(root, SELECTORS.description) || extractDescriptionFallback();
    const linkedinJobId = extractJobIdFromUrl(window.location.href);

    return {
      jobTitle: cleanJobTitle(firstNonEmptyText(root, SELECTORS.title)),
      companyName: firstNonEmptyText(root, SELECTORS.company),
      location: cleanLocation,
      ...splitLocation(cleanLocation),
      datePosted: firstNonEmptyText(root, SELECTORS.datePosted),
      jobDescription: description || "",
      directApplyUrl: apply.url,
      applyType: apply.type,
      seniorityLevel: criteria.seniorityLevel || fallbackCriteria.seniorityLevel || "",
      employmentType: criteria.employmentType || fallbackCriteria.employmentType || "",
      industries: criteria.industries || fallbackCriteria.industries || "",
      jobType:
        criteria.employmentType ||
        fallbackCriteria.employmentType ||
        extractJobType(`${allText} ${cleanLocation}`),
      workplaceType: extractWorkplaceType(`${allText} ${cleanLocation}`),
      linkedinJobId,
      linkedinUrl: toAbsoluteUrl(window.location.href),
      scrapeStatus: description ? "Complete" : "JD unavailable"
    };
  }

  function extractCriteria(root) {
    const criteria = {};
    const items = SELECTORS.criteriaItems.flatMap((selector) =>
      Array.from(root.querySelectorAll(selector))
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

  function extractApplyInfo(root) {
    const links = SELECTORS.applyLinks.flatMap((selector) => Array.from(root.querySelectorAll(selector)));
    const buttons = SELECTORS.applyButtons.flatMap((selector) =>
      Array.from(root.querySelectorAll(selector))
    );

    const externalLink = links
      .map((link) => toAbsoluteUrl(link.getAttribute("href") || ""))
      .find((href) => href && !href.includes("linkedin.com/jobs/view/"));

    const buttonText = normalizeText(
      buttons.map((button) => button.innerText || button.getAttribute("aria-label") || "").join(" ")
    );

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

  function extractDescriptionFallback() {
    const headings = Array.from(document.querySelectorAll("h2, h3, strong, b")).filter((node) => {
      return /about the job|job description|responsibilities|qualifications/i.test(textFromNode(node));
    });
    for (const heading of headings) {
      const container = heading.closest("section, div, article");
      const text = textFromNode(container);
      if (text.length > 80) {
        return text;
      }
    }
    return "";
  }

  function detectBlocker() {
    const selectorHit = SELECTORS.blockerCandidates.some((selector) => document.querySelector(selector));
    const bodyText = normalizeText(document.body?.innerText || "");
    const textHit = /captcha|security check|verify.*human|sign in to continue|join linkedin to view/i.test(bodyText);
    return selectorHit || textHit;
  }

  function cleanupLocation(value) {
    return normalizeText(value)
      .replace(/\b\d+\s+(?:applicants?|connections?)\b/gi, "")
      .replace(/\b(?:reposted|posted)\b.*$/i, "")
      .replace(/\s+\((?:Remote|Hybrid|On-site)\)$/i, "")
      .trim();
  }

  function splitLocation(value) {
    const text = normalizeText(value);
    if (!text) {
      return { city: "", country: "" };
    }
    const parts = text.split(",").map((part) => part.trim()).filter(Boolean);
    return {
      city: parts[0] || text,
      country: parts.length > 1 ? parts[parts.length - 1] : ""
    };
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

  function extractJobIdFromUrl(url) {
    if (!url) {
      return "";
    }
    const decoded = safeDecode(url);
    const patterns = [/\/jobs\/view\/(\d+)/i, /currentJobId=(\d+)/i, /jobId=(\d+)/i];
    for (const pattern of patterns) {
      const match = decoded.match(pattern);
      if (match?.[1]) {
        return match[1];
      }
    }
    return "";
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

  function firstNonEmptyText(root, selectors) {
    for (const selector of selectors) {
      for (const node of safeQueryAll(root, selector)) {
        const text = normalizeText(node.innerText || node.textContent || "");
        if (text) {
          return text;
        }
      }
    }
    return "";
  }

  function textFromFirst(root, selectors) {
    return textFromNode(findFirst(root, selectors));
  }

  function textFromNode(node) {
    return normalizeText(node?.innerText || node?.textContent || "");
  }

  function safeQueryAll(root, selector) {
    try {
      return Array.from(root.querySelectorAll(selector));
    } catch {
      return [];
    }
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
      return new URL(url, "https://www.linkedin.com").toString();
    } catch {
      return String(url);
    }
  }

  function safeDecode(value) {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
          // Keep polling.
        }
        if (Date.now() - started >= timeoutMs) {
          cleanup();
          reject(new Error("Timed out waiting for LinkedIn detail content"));
        }
      };

      observer = new MutationObserver(run);
      observer.observe(document.documentElement, { childList: true, subtree: true });
      intervalId = setInterval(run, 350);
      run();
    });
  }
})();
