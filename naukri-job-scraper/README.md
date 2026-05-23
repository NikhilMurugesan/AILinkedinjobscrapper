# Naukri Job Scraper Chrome Extension

Manifest V3 Chrome extension that scrapes Naukri search result pages, opens each job detail URL in a throttled background tab, extracts the full JD and apply link, closes the tab, and exports the collected data as CSV or JSON.

## Install in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the `naukri-job-scraper` folder.
5. Pin **Naukri Job Scraper** from the extensions menu if you want toolbar access.

## Use

1. Open a Naukri search results page, for example:
   - `https://www.naukri.com/jobs-in-india?k=machine%20learning`
   - `https://www.naukri.com/machine-learning-jobs`
2. Click **Start** in the floating bottom-right panel or the toolbar popup.
3. Keep the Naukri results tab open. The extension collects cards from the current page, opens job detail pages in background tabs, extracts full details, closes those tabs, and then moves to the next results page.
4. Use **Pause**, **Resume**, or **Stop** at any time. Already scraped jobs stay in `chrome.storage.local`.
5. Click **Download CSV** or **Download JSON** from the toolbar popup, or **CSV** / **JSON** from the floating panel.
6. Click **Clear Cache** in the toolbar popup or **Clear** in the floating panel to reset stored jobs, queue state, and progress.

CSV exports include a UTF-8 BOM for Excel and Google Sheets. The job description column is flattened to one line, and the apply link is the final column.

## Captured Fields

- Job Title
- Company Name
- Experience Required
- Salary Range, defaulting to `Not Disclosed`
- Location(s)
- Key Skills / Tags
- Date Posted / Freshness
- Full Job Description
- Apply Link / Redirect URL when exposed in the page DOM
- Job ID
- Employment Type
- Education Required
- Company Rating
- Number of Openings
- Source page, scrape status, and scraped timestamp

## Updating CSS Selectors

Naukri changes class names regularly. All selectors are centralized near the top of:

- `content_results.js` for search result cards and pagination.
- `content_job.js` for job detail pages.

To update selectors:

1. Open Naukri in Chrome.
2. Right-click the missing field, such as a result card title or JD body, and choose **Inspect**.
3. Prefer stable selectors: semantic tags, `href` patterns, `aria-*`, `data-*`, or class fragments such as `[class*='job-desc']`.
4. Add the new selector at the top of the relevant array in `SELECTORS`.
5. Reload the extension from `chrome://extensions`.
6. Reload the Naukri tab and start a new scrape.

The scraper tries selectors in order, so keep the most current selectors first and older fallbacks below them.

## Tab Concurrency

The detail tab concurrency limit is controlled by the named constant at the top of `background.js`:

```js
const MAX_TABS = 6;
```

Increase it only if Naukri and your browser remain stable. The scraper also waits a randomized 0.7-1.5 seconds between opening job detail tabs.

Detail tabs are opened with `active: false` in the same Chrome window as the Naukri results tab. If Chrome or Naukri activates a managed detail tab anyway, the extension switches back to your previous tab so you can keep using other tabs or another Chrome window while scraping runs.

## Idempotent Start

**Start preserves previously scraped jobs.** When you click Start, the existing `jobsById` store is kept and used to filter out cards whose Naukri job ID / URL has already been collected. This means you can stop, navigate, or reload and restart without re-fetching JDs that you already have. Use **Clear Cache** to wipe everything and start over.

## Known Limitations

- Naukri can show CAPTCHA, security, login, or expired-job pages. CAPTCHA on the results page pauses scraping; CAPTCHA inside a job detail tab is recorded for that job and skipped so the rest of the queue continues. Expired and login-required jobs are recorded without crashing.
- Some apply buttons do not expose the final employer URL until a real click or login flow. The extension captures the best visible `href` or data URL but does not submit applications.
- Very large exports are generated through `chrome.downloads` using a data URL. If Chrome rejects a huge export, try exporting after smaller batches.
- DOM changes may require selector updates in `content_results.js` or `content_job.js`.
- Scraping may violate a site's terms or trigger rate limits. Use cautiously and keep the default throttling in place.
