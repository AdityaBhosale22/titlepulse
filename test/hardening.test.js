import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import ExcelJS from 'exceljs';
import { analyzeTitles } from '../backend/analyzer.js';
import { fetchText, normalizeUrl } from '../backend/network.js';
import { crawlWebsite, LIMITS, extractPage } from '../backend/crawler.js';
import { createAnalysisWorkbook } from '../backend/export.js';

test('normalization ignores garbage, entities, emoji/case/punctuation duplicates and years', () => {
  const result = analyzeTitles(['', null, '   ', '12345', '😀😀', 'Loading...', 'Access denied', 'Cloud &amp; Data Security 🚀', 'CLOUD & DATA SECURITY!', 'Cloud Data Security', 'Digital signatures in 2025', 'Digital signature in 2026']);
  assert.equal(result.totalTitles, 3);
  assert.ok(result.keywords.some(row => row.term === 'signature' && row.count === 2));
  assert.ok(result.keywords.every(row => !/^\d+$/.test(row.term)));
  assert.ok(result.longTails.every(row => row.matchingTitles.length === row.count));
});

test('keeps location names and exact plural phrases separate, bounding very long titles', () => {
  const result = analyzeTitles(['Search engine optimization Los Angeles', 'Search engine optimization San Francisco', 'Digital signature software for small businesses', 'Digital signatures software for small businesses', 'the best way to', 'complete guide to', 'word '.repeat(100000)]);
  assert.ok(result.longTails.some(row => row.term.includes('los angeles')));
  assert.ok(result.longTails.some(row => row.term.includes('san francisco')));
  assert.ok(result.longTails.some(row => row.term.startsWith('digital signature software')));
  assert.ok(result.longTails.some(row => row.term.startsWith('digital signatures software')));
  assert.ok(result.rankedAnalysis.length < 300);
});

test('preserves meaningful query parameters and removes only known tracking parameters', () => {
  assert.equal(normalizeUrl('https://example.com/blog/a/?utm_source=x&fbclid=y&mc_cid=z&b=2&a=1#x'), 'https://example.com/blog/a?a=1&b=2');
  assert.notEqual(normalizeUrl('https://example.com/?p=1'), normalizeUrl('https://example.com/?p=2'));
});

test('retries transient statuses once, respects Retry-After, and never retries 403/404', async () => {
  for (const status of [403, 404, 429, 500, 502, 503, 504]) {
    let calls = 0;
    const waits = [];
    const request = () => fetchText('https://example.com', { sleep: async ms => waits.push(ms), requester: async () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error('HTTP failure'), { response: { status, headers: { 'retry-after': '1' } } });
      return { status: 200, headers: {}, data: 'ok' };
    } });
    if ([403, 404].includes(status)) { await assert.rejects(request()); assert.equal(calls, 1); }
    else { assert.equal((await request()).text, 'ok'); assert.equal(calls, 2); assert.deepEqual(waits, [1000]); }
  }
  let calls = 0;
  await assert.rejects(fetchText('https://example.com', { requester: async () => { calls++; throw Object.assign(new Error('Rate limited'), { response: { status: 429, headers: { 'retry-after': '120' } } }); } }));
  assert.equal(calls, 1);
});

test('permanent transient failures stop after one retry and abort cancels pending requests', async () => {
  let calls = 0;
  await assert.rejects(fetchText('https://example.com', { sleep: async () => {}, requester: async () => { calls++; throw Object.assign(new Error('Timeout'), { code: 'ETIMEDOUT' }); } }));
  assert.equal(calls, 2);
  const controller = new AbortController();
  const pending = fetchText('https://example.com', { signal: controller.signal, requester: async (_url, { signal }) => { await delay(1000, null, { signal }); } });
  controller.abort();
  await assert.rejects(pending);
});

test('redirect destinations are checked against robots before issuing another request', async () => {
  let calls = 0;
  await assert.rejects(fetchText('https://example.com', { allowUrl: url => !url.endsWith('/private'), requester: async () => { calls++; return { status: 302, headers: { location: '/private' } }; } }), /robots/);
  assert.equal(calls, 1);
});

test('rejects block pages and empty JS shells, preferring article H1 over generic metadata', () => {
  assert.equal(extractPage('<title>Just a moment...</title><h1>Checking browser</h1>', 'https://example.com/blog/a').blocked, true);
  assert.equal(extractPage('<div id="challenge-form"></div><title>Security</title>', 'https://example.com/blog/a').blocked, true);
  assert.equal(extractPage('<title>Loading...</title><div id="root"></div>', 'https://example.com/blog/a').title, '');
  assert.equal(extractPage('<title>Home</title><article><h1>Security &amp; privacy in Los Angeles</h1></article>', 'https://example.com/blog/a').title, 'Security & privacy in Los Angeles');
});

test('multiple sitemaps, malformed children, failures, no titles and non-articles yield accurate counts', async () => {
  const entries = {
    '/': '<h1>Home</h1>',
    '/robots.txt': 'Sitemap: https://example.com/extra.xml',
    '/sitemap.xml': '<sitemapindex><sitemap><loc>https://example.com/child.xml</loc></sitemap><sitemap><loc>https://example.com/bad.xml</loc></sitemap></sitemapindex>',
    '/child.xml': '<urlset>' + ['/blog/a', '/blog/a/?utm_source=x', '/blog/empty', '/blog/block', '/blog/fail', '/products'].map(path => `<url><loc>https://example.com${path}</loc></url>`).join('') + '</urlset>',
    '/extra.xml': '<urlset><url><loc>https://example.com/blog/b</loc></url></urlset>',
    '/bad.xml': '<broken>',
    '/blog/a': '<h1>Digital signature security</h1>', '/blog/b': '<h1>Digital signature software</h1>',
    '/blog/empty': '<title></title><div id="root"></div>', '/blog/block': '<title>Just a moment...</title>', '/products': '<h1>Our products</h1>',
  };
  const result = await crawlWebsite('https://example.com', () => {}, { fetcher: async url => {
    const path = new URL(url).pathname;
    if (!(path in entries)) throw new Error('Unavailable');
    return { url, text: entries[path], type: path.endsWith('.xml') ? 'application/xml' : 'text/html' };
  } });
  assert.equal(result.totalTitles, 2);
  assert.equal(result.stats.failed, 2);
  assert.equal(result.stats.missingTitles, 1);
  assert.equal(result.stats.nonArticles, 2);
  assert.equal(result.stats.checked, 7);
  assert.equal(result.partial, true);
  assert.ok(result.warnings.some(text => text.includes('sitemaps could not')));
});

test('large sitemaps remain bounded and concurrency never exceeds the configured limit', async () => {
  let active = 0, maxActive = 0;
  const result = await crawlWebsite('https://example.com', () => {}, { limits: { ...LIMITS, candidates: 30, concurrency: 3 }, fetcher: async url => {
    const path = new URL(url).pathname;
    if (path === '/') return { url, text: '<h1>Home</h1>', type: 'text/html' };
    if (path === '/sitemap.xml') return { url, text: '<urlset>' + Array.from({ length: 2000 }, (_, i) => `<url><loc>https://example.com/blog/${i}</loc></url>`).join('') + '</urlset>', type: 'application/xml' };
    if (!/^\/blog\/\d+$/.test(path)) throw new Error('404');
    active++; maxActive = Math.max(maxActive, active);
    await delay(2); active--;
    return { url, text: `<h1>Digital signature security ${path.split('/').at(-1)}</h1>`, type: 'text/html' };
  } });
  assert.equal(result.totalTitles, 30);
  assert.equal(result.stats.discovered, 30);
  assert.equal(maxActive, 3);
  assert.ok(result.warnings.some(text => text.includes('Discovery limit')));
});

test('Excel safely round-trips Unicode, special URLs, formula-like text, duplicates and 1000 rows', async () => {
  const special = ['=1+1', '+SUM(A1:A2)', '-1+1', '@SUM(A1:A2)', 'Crème 東京 😀 & < > "', 'Long title '.repeat(45), 'Duplicate title', 'Duplicate title'];
  const sourceTitles = Array.from({ length: 1000 }, (_, i) => ({ title: special[i % special.length], url: `https://example.com/blog/${i}?q=%E6%9D%B1%E4%BA%AC&a=1&b=2#section` }));
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await createAnalysisWorkbook({ website: 'https://example.com', totalTitles: special.length - 1, sourceTitles, rankedAnalysis: [{ type: 'Keyword', term: '=1+1', count: 2 }], warnings: [] }));
  const sheet = workbook.getWorksheet('Source Titles');
  assert.equal(sheet.rowCount, 1001);
  sourceTitles.forEach((source, i) => {
    assert.equal(sheet.getCell(i + 2, 1).value, source.title);
    assert.equal(sheet.getCell(i + 2, 1).type, ExcelJS.ValueType.String);
    assert.equal(sheet.getCell(i + 2, 2).value, source.url);
  });
  assert.equal(workbook.getWorksheet('Ranked Analysis').getCell('C2').type, ExcelJS.ValueType.String);
});
