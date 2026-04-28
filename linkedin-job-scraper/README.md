# LinkedIn Job Scraper Chrome Extension

Manifest V3 Chrome extension that scrapes LinkedIn Jobs search and collection pages from the page DOM, stores results incrementally in `chrome.storage.local`, and exports CSV or JSON.

## Install in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the `linkedin-job-scraper` folder.
5. Pin the extension if you want quick access from the toolbar.

## Use

1. Sign in to LinkedIn in Chrome.
2. Open a supported page:
   - `https://www.linkedin.com/jobs/search/?keywords=...`
   - `https://www.linkedin.com/jobs/collections/...`
3. Click **Start** in the floating card or extension toolbar popup.
4. Keep the tab open while scraping. The extension clicks each visible job, waits for the details panel, stores the data, then scrolls/paginates until no more jobs load.
5. Use **Pause**, **Resume**, or **Stop** any time. Stored jobs remain available after pausing or stopping.
6. Click **Download CSV** or **Download JSON** in the popup, or **CSV** / **JSON** in the floating card.

CSV exports include a UTF-8 BOM for Excel compatibility and quote all cells so commas and multiline job descriptions import cleanly.

## Captured Fields

- Job Title
- Company Name
- Location, City, Country
- Job Type and Workplace Type
- Date Posted
- Full Job Description
- Apply Type and Direct Apply / External Apply URL when visible in the DOM
- LinkedIn Job ID and LinkedIn URL
- Seniority Level
- Employment Type
- Industries
- Scrape Status and Scraped At timestamp

## Known Limitations

- LinkedIn changes DOM class names frequently. Scraping may need selector updates.
- External apply URLs are only captured when LinkedIn exposes an anchor URL in the page DOM. Some apply buttons open modals or redirect flows that do not expose the final employer URL until clicked.
- LinkedIn may rate-limit, show a CAPTCHA, or require login verification. The extension detects common blocker screens and stops with an alert.
- Large searches can take a long time because the scraper intentionally waits 1.5-3 seconds between actions.
- Scraping LinkedIn may violate LinkedIn's terms or trigger account restrictions. Test carefully, preferably with a secondary account.

## Updating Selectors

All LinkedIn DOM selectors are centralized in the `SELECTORS` object near the top of `content.js`.

To update selectors:

1. Open LinkedIn Jobs in Chrome.
2. Right-click the element you need, such as a job card title or description panel, and choose **Inspect**.
3. Find a stable selector. Prefer semantic attributes, `data-*` attributes, `aria-label` text, or stable structural classes.
4. Add the selector to the matching array in `content.js`, for example:
   - `jobCards`
   - `cardTitle`
   - `detailDescription`
   - `detailCriteriaItems`
   - `applyLinks`
   - `nextButtons`
5. Reload the extension from `chrome://extensions`.
6. Reload the LinkedIn Jobs tab and start a new scrape.

The scraper tries selectors in order, so put the most specific and current selectors first and keep older fallbacks below them.
