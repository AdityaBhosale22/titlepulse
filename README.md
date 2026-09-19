# TitlePulse

### Analyze and automatically save

Enter a website and click **Analyze website**. The backend analyzes it and automatically saves the full results and source titles to Google Sheets, even if the popup closes. Results stay visible during saving. A successful save shows **✓ Saved to Google Sheet**; **Open Sheet** is the only post-analysis action. Save errors remain visible without discarding the analysis; check the sheet before analyzing again to retry. Cached successful saves are not written again.

Deploy the updated backend and reload the extension together. Keep `GOOGLE_SHEETS_SECRET` configured to match Apps Script's `TITLEPULSE_SECRET`. `GOOGLE_SHEETS_SCRIPT_URL` optionally overrides the existing deployment URL. No team password or enable flag is used.

A minimal Manifest V3 Chrome extension and Express backend that ranks recurring 2–4 word title patterns and specific long-tail phrases, with matching article titles. Keywords are an optional, collapsed secondary section. Full ranked analysis and source titles are automatically saved to Google Sheets. No database, accounts, AI API, or frontend build step.

## Run the backend

Requires Node.js 22.15+ and npm.

```sh
npm install
npm start
```

On Windows PowerShell, use `npm.cmd` if execution policy blocks `npm.ps1`.

The backend listens on **http://127.0.0.1:3000**. Open that address to preview and use the same popup UI as a normal web page. Use `npm run dev` for automatic backend restarts.

Optional configuration: copy `.env.example` to `.env`, then edit `HOST`, `PORT`, or `EXTENSION_ID`. Defaults work without a `.env` file.

## Load the Chrome extension

1. Start the backend.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Click **Load unpacked** and choose this project's **extension** directory.
4. Pin TitlePulse, open a public website, and click the extension.
5. The website's origin is detected on first use. Edit the URL or select **Use current tab**, then **Analyze website**.

The last analysis is restored when you reopen the popup. The backend continues crawling while it is closed. Jobs and cached results expire 15 minutes after completion; restarting the backend clears them. Submit the same URL within that window to reuse its result.

## What the results mean

- **Titles analyzed** counts distinct normalized titles, excluding duplicate canonical URLs and equivalent titles that differ only in case, whitespace, punctuation, entities or emoji. The Source Titles sheet still retains every unique article URL, including separate articles with the same title.
- **Recurring title patterns** are contiguous 2–4 word sequences, ranked by the number of articles containing them. Each pattern includes all its matching titles. Only the top 10 patterns are shown; the full filtered rankings are retained for export. There is no separate website-wide title list in the UI.
- A count of **8 titles** means the pattern appears in **8 distinct titles**, even if repeated several times in one title. A title can match more than one pattern, so counts should not be added together.
- Patterns must occur in at least **2 articles**. Ties prefer phrases used at the start of titles, then longer phrases, then alphabetical order. Redundant shorter fragments are suppressed only when a longer pattern matches exactly the same articles; a shorter phrase with broader support remains eligible.
- Matching uses Unicode NFKC and lowercase, removes apostrophes, treats in-word hyphens as word boundaries, and rejects pure-number tokens and boilerplate. Meaningful stop words remain inside patterns (such as **How to Create**); stopword-only phrases, dangling endings (such as **Guide to**), and unsuitable starting words are rejected. Phrases never bridge punctuation or deleted words. No stemming or AI-based interpretation is performed.
- **Individual keywords** use stricter stop-word filtering and appear only in a collapsed optional section, with at most 10 results. Repeated keywords never substitute for an empty pattern result.
- Known site branding is removed when `og:site_name` matches a title segment. Primary article headings and structured headlines take priority over browser titles.

For example, `The Ultimate Guide to Digital Signatures` and `The Ultimate Guide to Electronic Signatures` produce **The Ultimate Guide → 2 titles**, with both titles underneath. `How to Create a Digital Signature` and `How to Create an Electronic Signature` produce **How to Create → 2 titles**.

The crawler fetches HTML to inspect links and title metadata, but **only titles feed the analysis**. Article bodies are not analyzed, stored, or returned. The normal JSON API returns top patterns/long-tail phrases with their matching titles, optional keyword counts, progress, and warnings. Full filtered rankings and source title/URL pairs remain in the in-memory job cache for export until expiry or restart.

## Long-tail keywords

Long-tail candidates must have at least three meaningful words **and** evidence of specificity: a topic qualified by audience/use-case/location (`software for small businesses`), an action with a specific topic (`choose digital signature software`), or a recognized topic with extra modifiers (`search engine optimization los angeles`). Bare word count is insufficient: `search engine marketing` and generic editorial templates are not automatically long-tail.

The detector uses complete title clauses, strips editorial framing such as `Best` and `How to`, and can retain both a qualified topic and its action variant. For the four digital-signature example titles, it yields:

- `digital signature software for small businesses`: **3 titles**
- `choose digital signature software for small businesses`: **1 title**

Counts use whole-word, case-insensitive matches across all analyzed titles, once per title. Single-article candidates are eligible. Results rank by title count, then meaningful-word specificity and alphabetically. The UI shows only the top 10 with matching titles. The implementation is a conservative English heuristic, not semantic classification: its action/topic vocabularies can miss unfamiliar domains, and some candidates may need human judgment. Clauses longer than 16 words and sentence-like/promotional clauses are excluded to avoid flooding the results with title fragments.

Identical normalized titles contribute once even if found on different URLs. Numeric years are not keywords. The keyword section explicitly combines only these singular/plural pairs: signature/signatures, document/documents, template/templates, business/businesses and tool/tools. Patterns and long-tail phrases retain exact forms, preserving specific terms and location names without semantic stemming.

The reference illustrates search demand and competition conceptually. TitlePulse does **not** infer or display search volume, CPC, difficulty, competition, or any external SEO metrics. Its only frequency measure is the number of matching article titles.

## Saved report

Google Sheets receives all accepted analysis results before the UI top-10 limits, including matching evidence, collapsed keywords, single-title long-tail candidates, and source title/URL pairs. Partial and empty completed analyses are included. The popup provides only **Open Sheet** after analysis. The internal workbook export API remains available for existing integrations, but has no popup action.

## Discovery and limits

Discovery checks `robots.txt` sitemap declarations, `/sitemap.xml`, `/sitemap_index.xml`, nested sitemap indexes, the entered page's relevant links, and common blog/article hubs. It follows same-site HTTP/HTTPS and `www` redirects. Other subdomains and unrelated domains are not crawled; enter a blog subdomain directly.

Article detection uses `Article`/`BlogPosting` structured data, `og:type=article`, or common article/date URL patterns. Title priority: structured headline → primary H1 → Open Graph title → HTML title. This is heuristic: unusual publishing systems may be missed and unusual category URLs may be mistaken for articles.

Default bounds in `backend/crawler.js`:

| Limit | Value |
| --- | --- |
| Candidate pages processed after discovery | All retained candidates, subject to the crawl deadline |
| Discovery pages | Entered page + up to 8 hubs |
| Sitemap requests | 12 |
| Retained candidate URLs | 500 |
| Concurrent article requests per job | 3 |
| Minimum spacing between outgoing requests | 200 ms |
| Retry limit | One retry for transient network errors, 429 and 500/502/503/504 |
| Crawl deadline | 90 seconds |
| Backend job watchdog | 110 seconds; aborts stalled work |
| Popup polling deadline | At most 120 seconds per attempt, also respects backend deadline |
| Request deadline, including redirects | 8 seconds |
| Response body size | 2 MiB |
| Concurrent jobs | 2 |
| Completed result cache | 15 minutes, up to 200 retained jobs |

Every successfully extracted article title feeds the analysis; the previous 100-page cutoff is removed. Discovery pages that are articles also contribute titles. Discovery safeguards (500 candidates, 12 sitemaps, 8 hubs) and the 90-second crawl deadline still apply, so coverage of an entire website is not guaranteed. Hitting a candidate/sitemap bound or deadline produces a partial-result warning. Sitemap errors fall back to links. Failed, blocked, oversized, or timed-out pages are skipped and successful titles produce partial results. Missing guessed blog hubs are ignored. `robots.txt` disallow rules are respected when available; missing or inaccessible robots files do not block discovery.

JavaScript-only pages, authenticated content, CAPTCHA pages, gzip sitemap files, and non-English stop-word filtering are not supported. No browser rendering is performed. A site with titles but no repeated useful terms shows an explicit empty-result state.

Retries share the original eight-second request budget. They wait at least 600 ms and honor `Retry-After`; requests requiring more than six seconds of backoff are not retried. An exhausted 429 stops further crawling and preserves collected results. 403/404 responses are not retried. Redirect destinations are rechecked for robots exclusions and public-network safety. Two simultaneous jobs cannot crawl the same website, including its `www` variant.

Known Cloudflare/challenge pages are excluded instead of being analyzed as titles. Missing/garbage titles and JavaScript shells produce a missing-title warning. The final summary shows pages checked and failed requests; `stats` also distinguishes `skipped` robots exclusions, `missingTitles`, `nonArticles`, `duplicateTitles`, `pagesWithTitles` and distinct titles `analyzed`. `checked` counts attempted, non-optional page URLs once, including the entered page and discovered hubs; guessed optional hubs and sitemap/robots requests are excluded. These categories are not all additive: an article can have a valid title but duplicate another title.

## API

`POST /api/analyses` with JSON `{ "url": "https://example.com" }` returns a job (`202` while running, `200` for cached results).

`GET /api/analyses/:id` returns:

```json
{
  "id": "job-uuid",
  "url": "https://example.com/",
  "status": "running",
  "progress": {
    "phase": "crawling",
    "message": "Checked 12 of 40 pages; found 10 titles.",
    "titlesAnalyzed": 10
  }
}
```

Completed jobs have `status: "complete"` and `result` containing `website`, `totalTitles`, `phrases`, `keywords`, `longTails`, `stats`, `partial`, `warnings`, and `completedAt`. Failed jobs have `status: "error"` and an `error` message. `GET /api/health` reports health.

`GET /api/analyses/:id/export` downloads the two-sheet workbook with the XLSX MIME type and attachment filename. It returns `409` for unfinished/failed jobs and `404` for expired/unknown jobs. Export responses reuse the completed job's full rankings and source titles; these full arrays are not exposed by the normal polling response.

The `phrases` field contains the primary ranked title patterns. Each item has a normalized `term`, a readable `label` from a matching title, an article `count`, and `matchingTitles`. The length of `matchingTitles` equals `count`:

```json
{
  "term": "how to create",
  "label": "How to Create",
  "count": 2,
  "matchingTitles": [
    "How to Create a Digital Signature",
    "How to Create an Electronic Signature"
  ]
}
```

After updating an existing installation, restart/redeploy the backend and reload the extension at `chrome://extensions`. Restarting clears cached analyses computed by the previous logic; run a new analysis for the new pattern results.

## Verification

```sh
npm test
npm run check
```

Tests use deterministic website fixtures, DOM interaction tests, and real local HTTP requests to the API. They cover frequency semantics, title extraction, sitemap indexes, fallback discovery, deduplication, private URL rejection, redirects, crawl deadlines, partial/empty results, job deduplication, concurrency bounds, expiry, popup validation, progress, restore, safe rendering, and errors. Long-tail tests cover the reference examples and specificity filtering; export tests reopen generated workbooks, reconcile every ranked row and source count, verify cell types and headers. DOM tests do not replace visual verification or loading the extension in the browser.

ExcelJS's UUID dependency is overridden to the compatible patched 11.x line to address the upstream dependency advisory; the workbook tests exercise the installed dependency combination.

The hardening suite includes 2,000-URL sitemap discovery with bounded retention, failed/malformed child sitemaps, block pages, missing titles, retries, concurrency bounds, duplicate normalization, watchdog recovery and 1,000-row Excel exports with Unicode, emojis, special URLs and `=`, `+`, `-`, `@` prefixes. Scraped export values are always string cells, never formulas. XML control characters are removed and Excel cell/row size limits are enforced. Titles used in analysis are bounded to 500 characters.

Manual extension checks: submit an invalid URL; analyze a public blog; click Analyze repeatedly; close/reopen during the crawl; stop the backend to check reconnection; restart it to check expired-job recovery. Check a site with no articles and a site without usable sitemaps.

## Hosting

### Shared Google Sheet saving

Completed analyses automatically queue a backend save, with at most two saves in flight. The popup polls its existing analysis to display save progress and confirmation. Reopening restores that state. Partial and empty completed analyses are also saved. Saved jobs are deduplicated for the 15-minute cache lifetime; requesting Analyze again after a save failure retries after a 10-second cooldown. Check the sheet before retrying an ambiguous timeout. Backend restarts clear the cache.

The Apps Script deployment owns per-host tab naming and replacement. Keep its secret on the backend. Anyone with API access can request an analysis and sheet save; restrict backend access as appropriate for your team.
