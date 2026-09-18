import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTitles, cleanTitle } from '../backend/analyzer.js';
import { normalizeUrl, publicAddress, sameSite } from '../backend/network.js';
import { extractPage, crawlWebsite, LIMITS } from '../backend/crawler.js';

test('counts once per article and includes matching titles only for ranked patterns', () => {
  const result = analyzeTitles(['Content marketing: content marketing tips', 'Content marketing strategy', 'A guide to email marketing']);
  assert.deepEqual(result.phrases, [{ term: 'content marketing', label: 'Content marketing', count: 2, matchingTitles: ['Content marketing: content marketing tips', 'Content marketing strategy'] }]);
  assert.deepEqual(result.keywords[0], { term: 'marketing', count: 3 });
  assert.equal(result.keywords.find(row => row.term === 'content').count, 2);
  assert.equal(result.totalTitles, 3);
  assert.equal('titles' in result, false);
});
test('preserves internal stop words without inventing adjacency across punctuation', () => {
  const result = analyzeTitles(['Growth for teams: software', 'Growth for teams: software']);
  assert.deepEqual(result.phrases.map(row => row.term), ['growth for teams']);
  assert.equal(analyzeTitles(['One unique title']).keywords.length, 0);
});
test('normalizes Unicode and hyphens, caps sections at ten results', () => {
  const titles = ['ＣＯＮＴＥＮＴ data-driven café design research growth analytics cloud software security engineering product commerce development', 'content data driven café design research growth analytics cloud software security engineering product commerce development'];
  const result = analyzeTitles(titles);
  assert.equal(result.keywords.length, 10);
  assert.equal(result.phrases.length, 10);
  assert.ok(result.phrases.some(row => row.term.includes('data driven')));
});
test('removes identified site branding without removing article subtitles', () => {
  assert.equal(cleanTitle('Email marketing | Example', 'Example'), 'Email marketing');
  assert.equal(cleanTitle('Email marketing - A practical approach', 'Example'), 'Email marketing - A practical approach');
});
test('normalizes duplicate URLs and rejects private destinations and unsafe schemes', () => {
  assert.equal(normalizeUrl('example.com/blog/?utm_source=mail#top'), 'https://example.com/blog');
  for (const url of ['http://127.0.0.1', 'http://2130706433', 'http://[::1]', 'http://[::ffff:127.0.0.1]', 'http://10.0.0.1', 'file:///tmp', 'ftp://example.com', 'https://user:pass@example.com', 'https://example.com:9000', 'http://localhost']) assert.throws(() => normalizeUrl(url));
  assert.equal(publicAddress('169.254.169.254'), false);
  assert.equal(publicAddress('192.168.1.1'), false);
  assert.equal(publicAddress('8.8.8.8'), true);
  assert.equal(sameSite('https://example.com', 'https://www.example.com'), true);
  assert.equal(sameSite('https://example.com', 'https://evil-example.com'), false);
});
test('extracts article title only and rejects generic pages', () => {
  const page = extractPage('<title>Wrong | Brand</title><meta property="og:site_name" content="Brand"><article><h1>Content strategy</h1><p>Body content should not be analyzed</p></article>', 'https://example.com/blog/strategy');
  assert.equal(page.title, 'Content strategy');
  assert.equal(page.isArticle, true);
  assert.equal(extractPage('<h1>Products</h1>', 'https://example.com/products').isArticle, false);
  assert.equal(extractPage('<h1>Blog</h1>', 'https://example.com/blog').isArticle, false);
  const schema = extractPage('<script type="application/ld+json">{"@graph":[{"@type":"BlogPosting","headline":"Schema headline"}]}</script><h1>Navigation</h1>', 'https://example.com/slug');
  assert.equal(schema.title, 'Schema headline'); assert.equal(schema.isArticle, true);
});

function fixtures(entries) {
  const calls = [];
  return {
    calls,
    fetcher: async (url, { signal } = {}) => {
      calls.push(url);
      signal?.throwIfAborted();
      if (!(url in entries)) throw new Error('Unavailable');
      const text = entries[url];
      if (text instanceof Error) throw text;
      return { url, text, type: url.endsWith('.xml') ? 'application/xml' : url.endsWith('.txt') ? 'text/plain' : 'text/html' };
    },
  };
}
test('deduplicates canonical URLs but counts separate articles with identical titles', async () => {
  const origin = 'https://example.com';
  const fixture = fixtures({
    [origin + '/robots.txt']: 'User-agent: *\nDisallow: /blog/private',
    [origin + '/']: '<h1>Home</h1>',
    [origin + '/sitemap.xml']: '<sitemapindex><sitemap><loc>https://example.com/posts.xml</loc></sitemap></sitemapindex>',
    [origin + '/posts.xml']: '<urlset>' + ['content', 'content?utm_source=x', 'email', 'copy', 'alias', 'broken', 'private'].map(slug => `<url><loc>${origin}/blog/${slug}</loc></url>`).join('') + '</urlset>',
    [origin + '/blog/content']: '<h1>Content marketing strategy</h1>',
    [origin + '/blog/email']: '<h1>Email marketing strategy</h1>',
    [origin + '/blog/copy']: '<h1>Content marketing strategy</h1>',
    [origin + '/blog/alias']: '<link rel="canonical" href="/blog/content"><h1>Different alias heading</h1>',
  });
  const updates = [];
  const result = await crawlWebsite(origin, update => updates.push(update), fixture);
  assert.equal(result.totalTitles, 3);
  assert.ok(result.phrases.some(row => row.term === 'marketing strategy' && row.count === 3));
  assert.equal(fixture.calls.filter(url => url === origin + '/blog/content').length, 1);
  assert.equal(fixture.calls.includes(origin + '/blog/private'), false);
  assert.equal(result.partial, true);
  assert.ok(updates.some(update => update.phase === 'crawling'));
});
test('falls back to article links when sitemap is missing or malformed', async () => {
  const fixture = fixtures({
    'https://example.com/': '<a href="/blog">Blog</a>',
    'https://example.com/sitemap.xml': '<html>Not an XML sitemap</html>',
    'https://example.com/blog': '<a href="/blog/one">One</a><a href="/blog/two">Two</a>',
    'https://example.com/blog/one': '<h1>Cloud security patterns</h1>',
    'https://example.com/blog/two': '<h1>Cloud security tools</h1>',
  });
  const result = await crawlWebsite('example.com', () => {}, fixture);
  assert.equal(result.totalTitles, 2);
  assert.deepEqual(result.phrases, [{ term: 'cloud security', label: 'Cloud security', count: 2, matchingTitles: ['Cloud security patterns', 'Cloud security tools'] }]);
  assert.ok(result.warnings.some(warning => warning.includes('No usable sitemap')));
});
test('empty accessible sites return empty results; inaccessible sites fail meaningfully', async () => {
  const result = await crawlWebsite('example.com', () => {}, fixtures({ 'https://example.com/': '<h1>Home</h1>' }));
  assert.equal(result.totalTitles, 0);
  await assert.rejects(crawlWebsite('example.com', () => {}, fixtures({})), /could not be reached/);
});
test('analyzes every discovered article including patterns beyond the old 100-page cutoff', async () => {
  const urls = Array.from({ length: 105 }, (_, i) => `https://example.com/blog/story-${i}`);
  const entries = Object.fromEntries(urls.map((url, i) => [url, `<h1>${i < 100 ? `Unique subject ${i}` : `How to Create a Document ${i}`}</h1>`]));
  const fixture = fixtures({ ...entries,
    'https://example.com/': '<h1>Home</h1>',
    'https://example.com/sitemap.xml': '<urlset>' + urls.map(url => `<url><loc>${url}</loc></url>`).join('') + '</urlset>',
  });
  const result = await crawlWebsite('example.com', () => {}, fixture);
  assert.equal(result.totalTitles, 105);
  assert.equal(result.stats.checked, 105);
  assert.ok(result.phrases.some(row => row.term === 'how to create' && row.count === 5));
  assert.equal(result.partial, false);
});

test('prioritizes the requested title templates and attaches their exact evidence', () => {
  const titles = ['The Ultimate Guide to Digital Signatures', 'The Ultimate Guide to Electronic Signatures', 'How to Create a Digital Signature', 'How to Create an Electronic Signature'];
  const result = analyzeTitles(titles);
  assert.deepEqual(result.phrases, [
    { term: 'how to create', label: 'How to Create', count: 2, matchingTitles: titles.slice(2) },
    { term: 'the ultimate guide', label: 'The Ultimate Guide', count: 2, matchingTitles: titles.slice(0, 2) },
  ]);
});

test('supports four-word patterns, ranks by article count, suppresses only redundant fragments', () => {
  const titles = ['How to Create Better Documents', 'How to Create Better Reports', 'How to Create Signatures'];
  const result = analyzeTitles(titles);
  assert.equal(result.phrases[0].term, 'how to create');
  assert.equal(result.phrases[0].count, 3);
  assert.ok(result.phrases.some(row => row.term === 'how to create better' && row.count === 2));
  assert.ok(!result.phrases.some(row => row.term === 'create better'));
  for (const row of result.phrases) assert.equal(row.count, row.matchingTitles.length);
});

test('never substitutes single words, stopword-only phrases or boilerplate for patterns', () => {
  assert.deepEqual(analyzeTitles(['signature', 'signature', 'pdf', 'pdf', 'sign', 'sign']).phrases, []);
  assert.deepEqual(analyzeTitles(['the and of', 'the and of', 'Copyright reserved', 'Copyright reserved']).phrases, []);
  assert.deepEqual(analyzeTitles(['cloud + security', 'cloud + security']).phrases, []);
});

test('matches case and Unicode variants, counting repeated occurrences in one title once', () => {
  const titles = ['How to Create: HOW TO CREATE', 'ＨＯＷ to create PDFs', 'Unrelated example'];
  const row = analyzeTitles(titles).phrases.find(pattern => pattern.term === 'how to create');
  assert.equal(row.count, 2);
  assert.deepEqual(row.matchingTitles, titles.slice(0, 2));
});

test('crawl deadline aborts pending requests and retains collected titles', async () => {
  const fixture = fixtures({
    'https://example.com/blog/start': '<h1>Cloud security patterns</h1><a href="/blog/slow">Next article</a>',
    'https://example.com/sitemap.xml': '<urlset><url><loc>https://example.com/blog/slow</loc></url></urlset>',
  });
  const fetcher = async (url, options) => {
    if (url.endsWith('/slow')) return new Promise((_, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
    });
    return fixture.fetcher(url, options);
  };
  const result = await crawlWebsite('https://example.com/blog/start', () => {}, { fetcher, limits: { ...LIMITS, duration: 50 } });
  assert.equal(result.totalTitles, 1);
  assert.ok(result.warnings.some(warning => warning.includes('Time limit reached')));
});

test('article H1 takes precedence over a navigation heading', () => {
  const page = extractPage('<h1>Brand navigation</h1><article><h1>Cloud security patterns</h1></article>', 'https://example.com/blog/cloud');
  assert.equal(page.title, 'Cloud security patterns');
  assert.equal(extractPage('<h1>Blog archive</h1>', 'https://example.com/blog/page/2').isArticle, false);
});
