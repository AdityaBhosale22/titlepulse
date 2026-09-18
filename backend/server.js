import express from 'express';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { crawlWebsite } from './crawler.js';
import { normalizeUrl, sameSite, UserError } from './network.js';
import { createAnalysisWorkbook, XLSX_TYPE } from './export.js';

// Full export data stays in the job cache; the UI only receives top results.
function publicJob(job) {
  if (!job.result) return job;
  const { rankedAnalysis, sourceTitles, ...result } = job.result;
  return { ...job, result };
}

export function createApp({ crawl = crawlWebsite, now = Date.now, jobTimeout = 110000 } = {}) {
  const app = express();
  const jobs = new Map();
  const byUrl = new Map();
  const rate = new Map();
  const exports = new WeakMap();
  const ttl = 15 * 60 * 1000;
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
    const origin = req.get('origin');
    const extensionAllowed = /^chrome-extension:\/\/[a-p]{32}$/.test(origin || '') && (!process.env.EXTENSION_ID || origin === `chrome-extension://${process.env.EXTENSION_ID}`);
    const sameOrigin = origin === `${req.protocol}://${req.get('host')}`;
    if (origin && !extensionAllowed && !sameOrigin) return res.status(403).json({ error: 'This origin is not allowed.' });
    if (origin) { res.set('Access-Control-Allow-Origin', origin); res.vary('Origin'); }
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use(express.json({ limit: '4kb' }));
  app.get('/api/health', (_, res) => res.json({ status: 'ok', service: 'TitlePulse' }));
  const cleanup = () => {
    for (const [id, job] of jobs) if (job.finishedAt && now() - job.finishedAt > ttl) {
      jobs.delete(id); if (byUrl.get(job.url) === id) byUrl.delete(job.url);
    }
    for (const [ip, entry] of rate) if (now() - entry.start > 60000) rate.delete(ip);
  };
  app.post('/api/analyses', (req, res, next) => {
    try {
      if (!req.is('application/json')) throw new UserError('Send a JSON request.', 415);
      const url = normalizeUrl(req.body?.url);
      cleanup();
      const existing = jobs.get(byUrl.get(url));
      if (existing && existing.status !== 'error') return res.status(existing.status === 'complete' ? 200 : 202).json(publicJob(existing));
      if ([...jobs.values()].some(job => job.status === 'running' && sameSite(job.url, url))) throw new UserError('An analysis of this website is already running. Reopen its original URL to resume it, or wait for it to finish.', 409);
      const bucket = rate.get(req.ip) || { start: now(), count: 0 };
      if (bucket.count >= 10 || rate.size >= 10000) throw new UserError('Too many requests. Please try again in a minute.', 429);
      if ([...jobs.values()].filter(job => job.status === 'running').length >= 2) throw new UserError('The analyzer is busy. Please try again shortly.', 429);
      if (jobs.size >= 200) throw new UserError('The analyzer is at capacity. Please try again later.', 429);
      bucket.count++; rate.set(req.ip, bucket);
      const job = { id: randomUUID(), url, status: 'running', progress: { phase: 'discovering', message: 'Starting website discovery…', titlesAnalyzed: 0 }, createdAt: now(), deadlineAt: now() + jobTimeout };
      jobs.set(job.id, job); byUrl.set(url, job.id);
      res.status(202).json(job);
      const controller = new AbortController();
      const watchdog = setTimeout(() => {
        controller.abort(); job.status = 'error'; job.error = 'Analysis exceeded its time limit. Please try a more specific blog URL.'; job.finishedAt = now();
      }, jobTimeout);
      watchdog.unref();
      Promise.resolve().then(() => crawl(url, progress => { if (job.status === 'running') job.progress = progress; }, { signal: controller.signal }))
        .then(result => { if (job.status === 'running') { job.status = 'complete'; job.result = result; } })
        .catch(error => { if (job.status === 'running') { job.status = 'error'; job.error = error.message || 'Analysis failed. Please try again.'; } })
        .finally(() => { clearTimeout(watchdog); job.finishedAt ??= now(); });
    } catch (error) { next(error); }
  });
  app.get('/api/analyses/:id', (req, res) => {
    cleanup();
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'This analysis expired or the backend restarted. Analyze the website again.' });
    res.json(publicJob(job));
  });
  app.get('/api/analyses/:id/export', async (req, res, next) => {
    try {
      cleanup();
      const job = jobs.get(req.params.id);
      if (!job) throw new UserError('This analysis expired or the backend restarted. Analyze the website again before exporting.', 404);
      if (job.status !== 'complete') throw new UserError('The analysis must finish successfully before it can be exported.', 409);
      if (!exports.has(job)) {
        const pending = createAnalysisWorkbook(job.result).catch(error => { exports.delete(job); throw error; });
        exports.set(job, pending);
      }
      const buffer = await exports.get(job);
      const host = new URL(job.url).hostname.replace(/[^a-z0-9.-]/gi, '-');
      res.type(XLSX_TYPE).attachment(`titlepulse-${host}${job.result.partial ? '-partial' : ''}.xlsx`).send(buffer);
    } catch (error) { next(error); }
  });
  const extension = fileURLToPath(new URL('../extension/', import.meta.url));
  app.use(express.static(extension, { index: 'popup.html' }));
  app.use((_, res) => res.status(404).json({ error: 'Not found.' }));
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error instanceof UserError ? error.message : error.type === 'entity.parse.failed' ? 'Request must contain valid JSON.' : error.status === 413 ? 'Request is too large.' : 'Something went wrong. Please try again.' }));
  return app;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 3000);
  const server = createApp().listen(port, host, () => console.log(`TitlePulse running at http://${host}:${port}`));
  server.on('error', error => { console.error(`Cannot start TitlePulse: ${error.message}`); process.exitCode = 1; });
}
