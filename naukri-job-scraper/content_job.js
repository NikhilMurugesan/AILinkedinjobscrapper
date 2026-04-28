(() => {
  if (window.__NAUKRI_JOB_SCRAPER_DETAIL_RUNNING__) {
    return null;
  }
  window.__NAUKRI_JOB_SCRAPER_DETAIL_RUNNING__ = true;

  const SELECTORS = {
    title: [
      "h1",
      ".styles_jd-header-title__rZwM1",
      "[class*='jd-header-title']",
      "[class*='job-title']"
    ],
    company: [
      ".styles_jd-header-comp-name__MvqAI",
      "[class*='jd-header-comp-name']",
      "[class*='company-name']",
      "a[href*='company']"
    ],
    jobDescription: [
      ".styles_job-desc-container__txpYf",
      ".styles_JDC__dang-inner-html__h0K4t",
      "[class*='job-desc-container']",
      "[class*='dang-inner-html']",
      "[class*='job-description']",
      "[class*='description']"
    ],
    applyLinks: [
      "a[href*='apply']",
      "a[href*='companyapply']",
      "a[href*='external']",
      "a[class*='apply']",
      "button[class*='apply']",
      "#apply-button",
      "[data-ga-track*='Apply']"
    ],
    keySkills: [
      ".styles_key-skill__GIPn_ a",
      "[class*='key-skill'] a",
      "[class*='skill'] a",
      "[class*='skills'] a",
      "[class*='chip']"
    ],
    detailsRows: [
      ".styles_other-details__oEN4O",
      ".styles_details__Y424J",
      "[class*='other-details']",
      "[class*='details']",
      "section",
      "li"
    ],
    experience: [
      "[class*='exp']",
      "span[title*='Yrs']",
      "span[title*='Years']"
    ],
    salary: [
      "[class*='salary']",
      "span[title*='Not disclosed']",
      "span[title*='Lacs']"
    ],
    location: [
      "[class*='location']",
      "[class*='loc']"
    ],
    rating: [
      "[class*='rating']",
      "[class*='starRating']"
    ],
    expiredCandidates: [
      "[class*='expired']",
      "[class*='not-found']",
      "[class*='notfound']"
    ],
    loginCandidates: [
      "input[type='password']",
      "[class*='login']",
      "[class*='register']",
      "a[href*='login']"
    ],
    captchaCandidates: [
      "iframe[src*='captcha']",
      "[id*='captcha']",
      "[class*='captcha']",
      "[data-testid*='captcha']",
      "input[name*='captcha']"
    ]
  };

  const DETAIL_WAIT_MS = 8000;

  return extractAndSend();

  // Extracts the detail page payload and notifies the service worker.
  async function extractAndSend() {
    let job;
    try {
      await waitForDetailPage();
      job = extractJobDetails();
    } catch (error) {
      job = {
        jobUrl: location.href,
        jobId: extractJobId(location.href),
        scrapeStatus: "Extraction Error",
        jobDescription: error.message || "Could not extract job detail page.",
        error: error.message || String(error)
      };
    }

    try {
      await chrome.runtime.sendMessage({ type: "JOB_DETAIL_EXTRACTED", job });
    } catch {
      // The executeScript return value is a fallback if messaging is unavailable.
    }
    return job;
  }

  async function waitForDetailPage() {
    try {
      await waitForCondition(() => {
        const hasTitle = Boolean(findFirst(document, SELECTORS.title));
        const hasUsefulBody = hasTitle && textFromNode(document.body).length > 1200;
        return (
          detectCaptcha() ||
          detectExpired() ||
          detectLoginWall() ||
          Boolean(findFirst(document, SELECTORS.jobDescription)) ||
          hasUsefulBody
        );
      }, DETAIL_WAIT_MS);
    } catch {
      // Extraction below will still capture timeout/error text from the page.
    }
  }

  function extractJobDetails() {
    if (detectCaptcha()) {
      return {
        jobUrl: location.href,
        jobId: extractJobId(location.href),
        scrapeStatus: "Captcha",
        captchaDetected: true,
        jobDescription: "CAPTCHA detected. Manual resolution required."
      };
    }

    if (detectExpired()) {
      return {
        jobTitle: textFromFirst(document, SELECTORS.title),
        companyName: textFromFirst(document, SELECTORS.company),
        jobUrl: location.href,
        jobId: extractJobId(location.href),
        scrapeStatus: "Expired",
        expired: true,
        jobDescription: "Expired listing"
      };
    }

    if (detectLoginWall()) {
      return {
        jobTitle: textFromFirst(document, SELECTORS.title),
        companyName: textFromFirst(document, SELECTORS.company),
        jobUrl: location.href,
        jobId: extractJobId(location.href),
        scrapeStatus: "Login Required",
        loginRequired: true,
        jobDescription: "Login required"
      };
    }

    const bodyText = textFromNode(document.body);
    const description = textFromFirst(document, SELECTORS.jobDescription) || extractDescriptionFallback();
    const detailText = collectText(document, SELECTORS.detailsRows).join("\n");

    return {
      jobTitle: textFromFirst(document, SELECTORS.title),
      companyName: textFromFirst(document, SELECTORS.company),
      experienceRequired: textFromFirst(document, SELECTORS.experience) || extractExperience(bodyText),
      salaryRange: textFromFirst(document, SELECTORS.salary) || extractSalary(bodyText) || "Not Disclosed",
      locations: normalizeList(collectText(document, SELECTORS.location)).filter((value) => value.length < 120),
      keySkills: normalizeList(collectText(document, SELECTORS.keySkills)),
      datePosted: extractFreshness(bodyText),
      jobDescription: description,
      applyLink: extractApplyLink(),
      jobId: extractJobId(location.href),
      employmentType: extractLabeledValue(detailText, ["Employment Type", "Job Type", "Type"]),
      educationRequired: extractLabeledValue(detailText, ["Education", "UG", "PG", "Doctorate"]),
      companyRating: textFromFirst(document, SELECTORS.rating) || extractRating(bodyText),
      openings: extractLabeledValue(detailText, ["Openings", "Number of Openings", "No. of Openings"]) || extractOpenings(bodyText),
      jobUrl: location.href,
      scrapeStatus: "Complete"
    };
  }

  function extractApplyLink() {
    const candidates = uniqueElements(
      SELECTORS.applyLinks.flatMap((selector) => safeQueryAll(document, selector))
    );

    for (const element of candidates) {
      const direct =
        element.getAttribute("href") ||
        element.getAttribute("data-url") ||
        element.getAttribute("data-href") ||
        element.getAttribute("formaction");
      if (direct && !/^javascript:/i.test(direct)) {
        return toAbsoluteUrl(direct);
      }
    }

    const serialized = document.documentElement.innerHTML.match(/https?:\\?\/\\?\/[^"'<> ]+(?:apply|companyapply|external)[^"'<> ]*/i)?.[0];
    return serialized ? toAbsoluteUrl(serialized.replace(/\\\//g, "/")) : "";
  }

  function extractDescriptionFallback() {
    const headings = Array.from(document.querySelectorAll("h2, h3, strong, b")).filter((node) => {
      return /job description|role|responsibilities|candidate profile/i.test(textFromNode(node));
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
    return (
      /(?:enter|solve|complete)\s+(?:the\s+)?captcha/i.test(text) ||
      /verify\s+(?:that\s+)?you\s+are\s+(?:a\s+)?human/i.test(text) ||
      /unusual traffic|security check|not a robot|automated requests/i.test(text)
    );
  }

  function detectExpired() {
    if (findFirst(document, SELECTORS.expiredCandidates)) {
      return true;
    }
    return /job no longer available|job has expired|vacancy is closed|page not found|404/i.test(document.body?.innerText || "");
  }

  function detectLoginWall() {
    const text = document.body?.innerText || "";
    if (/login to view|register to apply|sign in to apply|please login/i.test(text)) {
      return true;
    }
    const password = document.querySelector("input[type='password']");
    return Boolean(password && /login|sign in|register/i.test(text));
  }

  function extractLabeledValue(text, labels) {
    const lines = normalizeText(text).split(/\n/).map(normalizeText).filter(Boolean);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      for (const label of labels) {
        const pattern = new RegExp(`^${escapeRegExp(label)}\\s*:?\\s*(.+)$`, "i");
        const inline = line.match(pattern);
        if (inline?.[1]) {
          return inline[1].trim();
        }
        if (new RegExp(`^${escapeRegExp(label)}:?$`, "i").test(line) && lines[index + 1]) {
          return lines[index + 1];
        }
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

  function extractOpenings(text) {
    return normalizeText(text.match(/\b(?:openings?|vacancies)\s*:?\s*\d+/i)?.[0] || "");
  }

  function extractRating(text) {
    return normalizeText(text.match(/\b[1-5](?:\.\d)?\s*(?:\/\s*5)?\b(?=\s*(?:rating|reviews?))/i)?.[0] || "");
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
        .flatMap((text) => text.split(/\n|\u2022/))
        .map(normalizeText)
        .filter(Boolean)
    );
  }

  function textFromNode(node) {
    return normalizeText(node?.innerText || node?.textContent || node?.getAttribute?.("title") || "");
  }

  function normalizeList(values) {
    return Array.from(new Set(values.map(normalizeText).filter(Boolean)));
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
        if (check()) {
          cleanup();
          resolve(true);
          return;
        }
        if (Date.now() - started >= timeoutMs) {
          cleanup();
          reject(new Error("Timed out waiting for Naukri detail content"));
        }
      };

      observer = new MutationObserver(run);
      observer.observe(document.documentElement, { childList: true, subtree: true });
      intervalId = setInterval(run, 350);
      run();
    });
  }
})();
