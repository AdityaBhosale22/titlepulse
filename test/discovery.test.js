import test from 'node:test';
import assert from 'node:assert/strict';
import { crawlWebsite, LIMITS, extractPage } from '../backend/crawler.js';

const origin = 'https://example.com';
const sitemap = paths => '<urlset>' + paths.map(path => '<url><loc>' + origin + path + '</loc></url>').join('') + '</urlset>';
function fixture(entries, seen = []) {
  return async url => {
    const path = new URL(url).pathname;
    seen.push(path);
    if (!(path in entries)) throw new Error('404');
    return { url, text: entries[path], type: path.endsWith('.xml') ? 'application/xml' : 'text/html' };
  };
}
test('blog and localized landing pages are not articles despite article metadata', () => {
  for (const path of ['/', '/blog/', '/en/blog/', '/blog/es/', '/news/']) {
    assert.equal(extractPage('<meta property="og:type" content="article"><h1>Front Page</h1>', origin + path).isArticle, false);
  }
  assert.equal(extractPage('<h1>Artificial intelligence security</h1>', origin + '/blog/ai').isArticle, true);
  assert.equal(extractPage('<meta property="og:type" content="article"><h1>Query based article</h1>', origin + '/?p=123').isArticle, true);
});
test('article links survive a full unrelated sitemap and landing titles are excluded', async () => {
  const seen = [];
  const result = await crawlWebsite(origin + '/blog', () => {}, { limits: { ...LIMITS, candidates: 3, concurrency: 1 }, fetcher: fixture({
    '/blog': '<meta property="og:type" content="article"><h1>Front Page</h1><article><h2><a href="/blog/email-search">Email search</a></h2></article>',
    '/sitemap.xml': sitemap(Array.from({ length: 50 }, (_, i) => '/products/' + i)),
    '/blog/email-search': '<h1>How to find business email addresses</h1><a href="/blog/email-verification">Related article</a>',
    '/blog/email-verification': '<h1>How to find verified email addresses</h1>',
  }, seen) });
  assert.equal(result.totalTitles, 2);
  assert.ok(result.sourceTitles.every(row => row.title !== 'Front Page'));
  assert.ok(seen.indexOf('/blog/email-search') < seen.findIndex(path => path.startsWith('/products/')));
  assert.ok(result.partial);
});
test('later article sitemap entries displace earlier low priority pages', async () => {
  const result = await crawlWebsite(origin, () => {}, { limits: { ...LIMITS, candidates: 2 }, fetcher: fixture({
    '/': '<h1>Home</h1>',
    '/sitemap.xml': sitemap(['/product/a', '/product/b', '/insights/security', '/insights/compliance']),
    '/insights/security': '<h1>Cloud security best practices</h1>',
    '/insights/compliance': '<h1>Cloud compliance best practices</h1>',
  }) });
  assert.equal(result.totalTitles, 2);
  assert.equal(result.stats.failed, 0);
});
test('section-local sitemap indexes find child sitemaps and avoid loops', async () => {
  const seen = [];
  const result = await crawlWebsite(origin + '/blog', () => {}, { fetcher: fixture({
    '/blog': '<h1>Blog</h1>',
    '/blog/sitemap_index.xml': '<sitemapindex><sitemap><loc>' + origin + '/blog/post-sitemap.xml</loc></sitemap><sitemap><loc>' + origin + '/blog/sitemap_index.xml</loc></sitemap></sitemapindex>',
    '/blog/post-sitemap.xml': sitemap(['/blog/a', '/blog/b']),
    '/blog/a': '<h1>Digital security for small businesses</h1>',
    '/blog/b': '<h1>Cloud security for small businesses</h1>',
  }, seen) });
  assert.equal(result.totalTitles, 2);
  assert.equal(seen.filter(path => path === '/blog/sitemap_index.xml').length, 1);
});
test('editorial links support flat article URLs and collection schemas are not articles', async () => {
  const result = await crawlWebsite(origin, () => {}, { fetcher: fixture({
    '/': '<a href="/insights">Insights</a>',
    '/insights': '<h1>Insights</h1><article><h2><a href="/cloud-security">Cloud security</a></h2></article>',
    '/cloud-security': '<article><h1>Cloud security for healthcare teams</h1></article>',
  }) });
  assert.equal(result.totalTitles, 1);
  const html = '<script type="application/ld+json">{"@type":"CollectionPage","mainEntity":{"@type":"ItemList","itemListElement":[{"@type":"Article","headline":"Unrelated card headline"}]}}</script><h1>Our library</h1>';
  assert.equal(extractPage(html, origin + '/library').isArticle, false);
  assert.equal(extractPage(html, origin + '/library').title, 'Our library');
});
