import { load } from 'cheerio';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import robotsParser from 'robots-parser';
import { fetchText, normalizeUrl, sameSite } from './network.js';
import { analyzeTitles, cleanTitle } from './analyzer.js';
import { titleKey } from './title-text.js';
import { setTimeout as delay } from 'node:timers/promises';

export const LIMITS = Object.freeze({ sitemaps: 12, listings: 8, candidates: 500, duration: 90000, concurrency: 3, requestInterval: 200 });
const parser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, processEntities: true, parseTagValue: false });
const array = value => value ? (Array.isArray(value) ? value : [value]) : [];
const section = /\/(blog|blogs|articles?|posts?|news|insights|journal|stories|resources)(\/|$)/i;
const excluded = /\/(tag|tags|category|categories|author|authors|search|login|signup|contact|about|privacy|terms|feed|wp-json|cart|page)(\/|$)|\.(jpg|jpeg|png|gif|svg|webp|pdf|zip|xml|gz|mp4|css|js)$/i;

export function articlePath(url) {
  const path = new URL(url).pathname;
  return !excluded.test(path) && (/(?:blog|blogs|articles?|posts?|news|insights|journal|stories)\/.+/i.test(path) || /\/\d{4}\/\d{1,2}\//.test(path));
}

export function extractPage(html, url) {
  const $ = load(html);
  const blocked = $('#challenge-form, #cf-challenge-running, .cf-challenge, #challenge-running').length > 0 || /^(just a moment|access denied|attention required|verify you are human|checking your browser)/i.test($('title').text().trim());
  const headings = $('article h1').first().text().trim() || $('main h1').first().text().trim() || $('h1').first().text().trim();
  const siteName = $('meta[property="og:site_name"]').attr('content') || '';
  let schemaHeadline = '';
  let schemaArticle = false;
  const inspect = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 8) return;
    if (array(node['@type']).some(type => /^(Article|BlogPosting|NewsArticle|TechArticle|Report|ScholarlyArticle)$/i.test(type))) {
      schemaArticle = true;
      if (typeof node.headline === 'string') schemaHeadline ||= node.headline;
    }
    for (const child of Object.values(node)) if (typeof child === 'object') {
      if (Array.isArray(child)) child.slice(0, 100).forEach(item => inspect(item, depth + 1));
      else inspect(child, depth + 1);
    }
  };
  $('script[type="application/ld+json"]').slice(0, 20).each((_, el) => { try { inspect(JSON.parse($(el).text())); } catch { /* Invalid structured data is optional. */ } });
  const ogArticle = $('meta[property="og:type"]').attr('content') === 'article';
  const isArticle = !excluded.test(new URL(url).pathname) && (schemaArticle || ogArticle || articlePath(url));
  const title = [schemaHeadline, headings, $('meta[property="og:title"]').attr('content'), $('title').first().text()].map(value => cleanTitle(value || '', siteName)).find(Boolean) || '';
  const canonical = $('link[rel="canonical"]').attr('href');
  const links = [];
  $('a[href]').slice(0, 3000).each((_, el) => {
    const href = $(el).attr('href');
    try {
      const link = normalizeUrl(href, url);
      if (sameSite(link, url) && !excluded.test(new URL(link).pathname)) links.push({ url: link, relevant: section.test(new URL(link).pathname) || /\b(blog|articles|insights|journal|news)\b/i.test($(el).text()) || $(el).closest('article').length > 0 });
    } catch { /* Ignore non-web and malformed links. */ }
  });
  return { isArticle, title: blocked ? '' : title, canonical, links: blocked ? [] : links, blocked };
}

export async function crawlWebsite(input, report = () => {}, { fetcher = fetchText, limits = LIMITS, signal } = {}) {
  let site = normalizeUrl(input);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(() => controller.abort(), limits.duration);
  const warnings = new Set();
  const stats = { discovered: 0, checked: 0, failed: 0, skipped: 0, missingTitles: 0, nonArticles: 0, duplicateTitles: 0, pagesWithTitles: 0, analyzed: 0, sitemaps: 0 };
  const titles = [];
  const sourceTitles = [];
  const candidates = new Map();
  const pages = new Map();
  const canonicalSeen = new Set();
  const titleSeen = new Set();
  const collectedPages = new Set();
  let nextRequest = 0;
  const beforeRequest = async requestSignal => {
    const wait = Math.max(0, nextRequest - Date.now());
    nextRequest = Math.max(Date.now(), nextRequest) + (fetcher === fetchText ? limits.requestInterval ?? 200 : 0);
    if (wait) await delay(wait, undefined, { signal: requestSignal });
    requestSignal?.throwIfAborted();
  };
  let robots;
  let usableResponses = 0;
  const progress = (phase, message) => report({ phase, message, ...stats, titlesAnalyzed: titles.length });
  const addCandidate = (raw, priority = 0) => {
    try {
      const url = normalizeUrl(raw, site);
      if (!sameSite(url, site) || excluded.test(new URL(url).pathname)) return;
      if (candidates.size >= limits.candidates && !candidates.has(url)) { warnings.add('Discovery limit reached; results cover a sample of this website.'); return; }
      candidates.set(url, Math.max(priority, candidates.get(url) || 0));
      stats.discovered = candidates.size;
    } catch { /* Invalid sitemap/link URL. */ }
  };
  const get = async url => {
    if (controller.signal.aborted) throw new Error('Crawl time limit reached.');
    if (robots?.isAllowed(url, 'TitlePulse') === false) throw new Error('Blocked by robots.txt');
    try {
      return await fetcher(url, { signal: controller.signal, site, beforeRequest, allowUrl: value => robots?.isAllowed(value, 'TitlePulse') !== false });
    } catch (error) {
      if (error.response?.status === 429) { warnings.add('The website requested fewer requests. Crawling stopped; results include titles already collected.'); controller.abort(); }
      throw error;
    }
  };
  const readPage = async (url, optional = false) => {
    url = normalizeUrl(url);
    if (pages.has(url)) return pages.get(url);
    const pending = (async () => {
      try {
        const response = await get(url);
        if (response.type && !/html/i.test(response.type)) { if (!optional) stats.nonArticles++; return null; }
        const page = { ...extractPage(response.text, response.url), url: response.url };
        if (page.blocked) throw new Error('Website blocked automated requests.');
        usableResponses++;
        return page;
      } catch (error) {
        if (!optional) {
          if (error.message === 'Blocked by robots.txt') stats.skipped++;
          else stats.failed++;
        }
        return null;
      } finally { if (!optional) stats.checked++; }
    })();
    pages.set(url, pending);
    return pending;
  };
  const collect = page => {
    if (!page || collectedPages.has(page)) return;
    collectedPages.add(page);
    if (!page.isArticle) { stats.nonArticles++; return; }
    if (!page.title) { stats.missingTitles++; return; }
    let canonical = normalizeUrl(page.url);
    try { const value = normalizeUrl(page.canonical, page.url); if (sameSite(value, site)) canonical = value; } catch { /* Use fetched URL. */ }
    if (canonicalSeen.has(canonical)) return;
    canonicalSeen.add(canonical);
    sourceTitles.push({ title: page.title, url: canonical });
    stats.pagesWithTitles++;
    const key = titleKey(page.title);
    if (titleSeen.has(key)) { stats.duplicateTitles++; return; }
    titleSeen.add(key); titles.push(page.title); stats.analyzed = titles.length;
  };
  try {
    progress('discovering', 'Looking for sitemaps and article links…');
    const root = new URL(site).origin;
    let robotsText = '';
    try {
      robotsText = (await fetcher(`${root}/robots.txt`, { signal: controller.signal, site, beforeRequest })).text;
      robots = robotsParser(`${root}/robots.txt`, robotsText);
    } catch { /* robots.txt is optional; normal crawl limits still apply. */ }
    const home = await readPage(site);
    if (home) site = home.url;
    collect(home);
    const mapQueue = [`${new URL(site).origin}/sitemap.xml`, `${new URL(site).origin}/sitemap_index.xml`];
    const declaredMaps = new Set();
    for (const match of robotsText.matchAll(/^sitemap:\s*(\S+)/gim)) { mapQueue.push(match[1]); declaredMaps.add(match[1]); }
    const seenMaps = new Set();
    let mapSuccess = 0;
    while (mapQueue.length && seenMaps.size < limits.sitemaps && !controller.signal.aborted) {
      let url;
      try { url = normalizeUrl(mapQueue.shift(), site); } catch { continue; }
      if (!sameSite(url, site) || seenMaps.has(url)) continue;
      seenMaps.add(url);
      try {
        const { text } = await get(url);
        if (/<!DOCTYPE|<!ENTITY/i.test(text) || XMLValidator.validate(text) !== true) throw new Error('Invalid sitemap');
        const xml = parser.parse(text);
        if (!xml.sitemapindex && !xml.urlset) throw new Error('Not a sitemap');
        mapSuccess++;
        const children = array(xml.sitemapindex?.sitemap).map(entry => entry.loc).filter(value => typeof value === 'string');
        children.sort((a, b) => Number(/post|blog|article/i.test(b)) - Number(/post|blog|article/i.test(a)));
        for (const child of children.slice(0, 100)) { try { declaredMaps.add(normalizeUrl(child, site)); } catch { /* Invalid URL. */ } }
        if (children.length > 100) warnings.add('Sitemap child limit reached; some articles may be missing.');
        mapQueue.push(...children.slice(0, 100));
        for (const entry of array(xml.urlset?.url)) if (typeof entry.loc === 'string') addCandidate(entry.loc, articlePathSafe(entry.loc) ? 3 : /post|blog|article/i.test(url) ? 2 : 0);
      } catch {
        if (declaredMaps.has(url)) warnings.add('Some declared sitemaps could not be read; their articles may be missing.');
      }
      stats.sitemaps = seenMaps.size;
      progress('discovering', `Checked ${stats.sitemaps} sitemaps; found ${stats.discovered} candidate pages.`);
    }
    if (mapQueue.length) warnings.add('Sitemap scan was limited; some articles may not be included.');
    if (!mapSuccess) warnings.add('No usable sitemap found. Results are based on discovered article links.');
    const guessedHubs = new Set([new URL('/blog', site).href, new URL('/articles', site).href]);
    const listings = new Set();
    for (const link of home?.links || []) if (link.relevant) { addCandidate(link.url, 2); if (!articlePath(link.url)) listings.add(link.url); }
    for (const hub of guessedHubs) if (!listings.has(hub)) listings.add(hub);
    let listingCount = 0;
    for (const url of listings) {
      if (listingCount++ >= limits.listings || controller.signal.aborted) break;
      const page = await readPage(url, guessedHubs.has(url) && !candidates.has(url));
      collect(page);
      for (const link of page?.links || []) if (link.relevant || section.test(new URL(url).pathname)) {
        addCandidate(link.url, articlePath(link.url) ? 3 : 1);
        if (link.relevant && !articlePath(link.url) && listings.size < limits.listings) listings.add(link.url);
      }
    }
    // Process every discovered candidate, not just the first 100. The overall
    // deadline still bounds slow sites and is reported as a partial result.
    const queue = [...candidates].sort((a, b) => b[1] - a[1]).map(([url]) => url).filter(url => url !== normalizeUrl(site));
    let cursor = 0;
    progress('crawling', `Reading titles from ${queue.length} candidate pages…`);
    await Promise.all(Array.from({ length: limits.concurrency }, async () => {
      while (cursor < queue.length && !controller.signal.aborted) {
        const url = queue[cursor++];
        collect(await readPage(url));
        progress('crawling', `Checked ${stats.checked} pages; analyzed ${titles.length} distinct titles; ${stats.failed} failed.`);
      }
    }));
    if (controller.signal.aborted && ![...warnings].some(message => message.includes('fewer requests'))) warnings.add('Time limit reached. Results include titles collected before the limit.');
    if (stats.failed) warnings.add(`${stats.failed} page requests were unavailable, blocked, or timed out.`);
    if (stats.skipped) warnings.add(`${stats.skipped} requests were excluded by robots.txt.`);
    if (stats.missingTitles) warnings.add(`${stats.missingTitles} article pages had no usable title in their initial HTML; JavaScript rendering is not supported.`);
    if (!usableResponses) throw new Error('This website could not be reached. It may be offline or block automated requests.');
    progress('analyzing', `Finding recurring title patterns across ${titles.length} article titles…`);
    return { website: site, ...analyzeTitles(titles), sourceTitles, stats, partial: warnings.size > 0, warnings: [...warnings], completedAt: new Date().toISOString() };
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

function articlePathSafe(url) { try { return articlePath(url); } catch { return false; } }
