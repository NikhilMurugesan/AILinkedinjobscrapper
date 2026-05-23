# LinkedIn Job Scraper Chrome Extension

Manifest V3 Chrome extension that scrapes LinkedIn Jobs search and collection pages. It collects cards from the results list, opens each job detail page in a throttled set of background tabs (up to 6 in parallel), extracts the full JD, closes the tab, and exports the collected data as CSV or JSON.

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
3. Click **Start** in the floating card or the extension toolbar popup.
4. Keep the results tab open. The extension collects all visible cards on the current page, opens job detail pages in up to 6 parallel background tabs, extracts the JD, closes each tab, then advances to the next results page.
5. Use **Pause**, **Resume**, or **Stop** any time. Stored jobs remain available after pausing or stopping.
6. Click **Download CSV** or **Download JSON** in the popup, or **CSV** / **JSON** in the floating card.
7. **Start is idempotent.** Existing jobs in storage are preserved and any duplicate job ID / URL encountered on a results page is skipped, so you can restart or rerun without re-fetching the same JDs. Use **Clear Cache** to wipe the store.

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
- Source page, scrape status, and Scraped At timestamp

## Architecture

- `content.js` runs on `/jobs/search*` and `/jobs/collections*`. It scrolls / paginates the results list and submits batches of card data to the background.
- `background.js` queues each job, opens up to `MAX_TABS` background detail tabs in parallel, injects `content_job.js` into each, persists results to `chrome.storage.local`, and closes the tab.
- `content_job.js` is the detail-page extractor. It is **not** auto-registered; the service worker injects it on demand via `chrome.scripting.executeScript`.

## Tab Concurrency

The parallel detail-tab limit is at the top of `background.js`:

```js
const MAX_TABS = 6;
```

Lower it if LinkedIn rate-limits you or your machine struggles. A short randomized delay (0.6-1.4s) is inserted between tab opens to spread load.

## Known Limitations

- LinkedIn changes DOM class names frequently. Scraping may need selector updates.
- External apply URLs are only captured when LinkedIn exposes an anchor URL in the page DOM. Some apply buttons open modals or redirect flows that do not expose the final employer URL until clicked.
- LinkedIn may rate-limit, show a CAPTCHA, or require login verification. The extension detects common blocker screens and pauses; resume after solving manually.
- Scraping LinkedIn may violate LinkedIn's terms or trigger account restrictions. Test carefully, preferably with a secondary account.

## Updating Selectors

DOM selectors are centralized in the `SELECTORS` object near the top of `content.js` (results list) and `content_job.js` (detail page).

1. Right-click the element in Chrome and choose **Inspect**.
2. Prefer stable attributes (semantic tags, `aria-*`, `data-*`, or class fragments such as `[class*='jobs-description']`).
3. Add the new selector to the top of the matching array.
4. Reload the extension from `chrome://extensions` and reload the LinkedIn tab.

The scraper tries selectors in order, so keep the most current selectors first and older fallbacks below them.
