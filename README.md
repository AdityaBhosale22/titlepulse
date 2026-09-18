# TitlePulse

A minimal Manifest V3 Chrome extension and Express backend that ranks recurring 2–4 word title patterns and shows the matching article titles under each pattern. Keywords are an optional, collapsed secondary section. No database, accounts, AI API, or frontend build step.

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

- **Titles analyzed** counts articles with extracted titles, excluding duplicate canonical URLs. Separate articles with identical titles still count separately.
- **Recurring title patterns** are contiguous 2–4 word sequences, ranked by the number of articles containing them. Each pattern includes all its matching titles. Only the top 10 patterns are returned; there is no separate website-wide title list.
- A count of **8 titles** means the pattern appears in **8 articles**, even if repeated several times in one title. An article can match more than one pattern, so counts should not be added together.
- Patterns must occur in at least **2 articles**. Ties prefer phrases used at the start of titles, then longer phrases, then alphabetical order. Redundant shorter fragments are suppressed only when a longer pattern matches exactly the same articles; a shorter phrase with broader support remains eligible.
- Matching uses Unicode NFKC and lowercase, removes apostrophes, treats in-word hyphens as word boundaries, and rejects pure-number tokens and boilerplate. Meaningful stop words remain inside patterns (such as **How to Create**); stopword-only phrases, dangling endings (such as **Guide to**), and unsuitable starting words are rejected. Phrases never bridge punctuation or deleted words. No stemming or AI-based interpretation is performed.
- **Individual keywords** use stricter stop-word filtering and appear only in a collapsed optional section, with at most 10 results. Repeated keywords never substitute for an empty pattern result.
- Known site branding is removed when `og:site_name` matches a title segment. Primary article headings and structured headlines take priority over browser titles.

For example, `The Ultimate Guide to Digital Signatures` and `The Ultimate Guide to Electronic Signatures` produce **The Ultimate Guide → 2 titles**, with both titles underneath. `How to Create a Digital Signature` and `How to Create an Electronic Signature` produce **How to Create → 2 titles**.

The crawler fetches HTML to inspect links and title metadata, but **only titles feed the analysis**. Article bodies are not analyzed, stored, or returned. The API returns ranked patterns with their matching titles, optional keyword counts, progress, and warnings. Matching titles remain in the in-memory result cache until expiry or restart.

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
| Crawl deadline | 90 seconds |
| Request deadline, including redirects | 8 seconds |
| Response body size | 2 MiB |
| Concurrent jobs | 2 |
| Completed result cache | 15 minutes, up to 200 retained jobs |

Every successfully extracted article title feeds the analysis; the previous 100-page cutoff is removed. Discovery pages that are articles also contribute titles. Discovery safeguards (500 candidates, 12 sitemaps, 8 hubs) and the 90-second crawl deadline still apply, so coverage of an entire website is not guaranteed. Hitting a candidate/sitemap bound or deadline produces a partial-result warning. Sitemap errors fall back to links. Failed, blocked, oversized, or timed-out pages are skipped and successful titles produce partial results. Missing guessed blog hubs are ignored. `robots.txt` disallow rules are respected when available; missing or inaccessible robots files do not block discovery.

JavaScript-only pages, authenticated content, CAPTCHA pages, gzip sitemap files, and non-English stop-word filtering are not supported. No browser rendering is performed. A site with titles but no repeated useful terms shows an explicit empty-result state.

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

Completed jobs have `status: "complete"` and `result` containing `website`, `totalTitles`, `phrases`, `keywords`, `stats`, `partial`, `warnings`, and `completedAt`. Failed jobs have `status: "error"` and an `error` message. `GET /api/health` reports health.

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

Tests use deterministic website fixtures, DOM interaction tests, and real local HTTP requests to the API. They cover frequency semantics, title extraction, sitemap indexes, fallback discovery, deduplication, private URL rejection, redirects, crawl deadlines, partial/empty results, job deduplication, concurrency bounds, expiry, popup validation, progress, restore, safe rendering, and errors. DOM tests do not replace visual verification or loading the extension in Chrome.

Manual extension checks: submit an invalid URL; analyze a public blog; click Analyze repeatedly; close/reopen during the crawl; stop the backend to check reconnection; restart it to check expired-job recovery. Check a site with no articles and a site without usable sitemaps.

## Hosting

This is a working local MVP, without billing or user accounts. To deploy one shared instance:

1. Run the Node process behind an HTTPS reverse proxy and set `HOST=0.0.0.0` in the hosting environment.
2. Set `extension/config.js`'s `API_BASE` to the HTTPS API origin and replace the local `host_permissions` entry in `extension/manifest.json` with `https://your-api-host/*`.
3. Set `EXTENSION_ID` to the installed/published extension ID. Reload the unpacked extension after changes.
4. Before offering unrestricted public service, add authentication, per-user quotas and infrastructure rate limiting. CORS is an origin restriction, not authentication; non-browser clients can call an unauthenticated endpoint. In-memory jobs require a single process (or sticky routing); restarts lose jobs.

Outbound requests reject private, loopback, link-local, reserved, and mixed public/private DNS destinations, validate addresses at socket lookup, disable proxy environment inheritance, and validate each redirect. The API limits request size and concurrent work. No page scripts execute. Extension permissions are limited to active-tab URL detection, local storage, and the backend host.

References: [Chrome extension permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions), [activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab), and [Axios request configuration](https://axios-http.com/docs/req_config).

## Project layout

```text
backend/
  server.js       Express API, job state, cache and request bounds
  network.js      Public-URL validation and bounded HTTP transport
  crawler.js      Sitemap/link discovery and article-title extraction
  analyzer.js     Normalization and recurring-term ranking
extension/
  manifest.json   Chrome Manifest V3
  config.js       Backend URL
  popup.html      Popup and web-preview interface
  popup.css       Light/dark responsive styles
  popup.js        Detection, validation, polling and safe result rendering
test/             Deterministic analysis, crawler and API tests
```
