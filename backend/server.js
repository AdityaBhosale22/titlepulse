import express from 'express';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { crawlWebsite } from './crawler.js';
import { normalizeUrl, UserError } from './network.js';

export function createApp({ crawl = crawlWebsite, now = Date.now } = {}) {
  const app = express();
  const jobs = new Map();
  const byUrl = new Map();
  const rate = new Map();
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
      if (existing && existing.status !== 'error') return res.status(existing.status === 'complete' ? 200 : 202).json(existing);
      const bucket = rate.get(req.ip) || { start: now(), count: 0 };
      if (bucket.count >= 10 || rate.size >= 10000) throw new UserError('Too many requests. Please try again in a minute.', 429);
      if ([...jobs.values()].filter(job => job.status === 'running').length >= 2) throw new UserError('The analyzer is busy. Please try again shortly.', 429);
      if (jobs.size >= 200) throw new UserError('The analyzer is at capacity. Please try again later.', 429);
      bucket.count++; rate.set(req.ip, bucket);
      const job = { id: randomUUID(), url, status: 'running', progress: { phase: 'discovering', message: 'Starting website discovery…', titlesAnalyzed: 0 }, createdAt: now() };
      jobs.set(job.id, job); byUrl.set(url, job.id);
      res.status(202).json(job);
      Promise.resolve().then(() => crawl(url, progress => { job.progress = progress; }))
        .then(result => { job.status = 'complete'; job.result = result; })
        .catch(error => { job.status = 'error'; job.error = error.message || 'Analysis failed. Please try again.'; })
        .finally(() => { job.finishedAt = now(); });
    } catch (error) { next(error); }
  });
  app.get('/api/analyses/:id', (req, res) => {
    cleanup();
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'This analysis expired or the backend restarted. Analyze the website again.' });
    res.json(job);
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
