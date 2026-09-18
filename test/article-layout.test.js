import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPage, crawlWebsite, LIMITS } from '../backend/crawler.js';

const cards = '<aside><article><h2>Related one</h2></article><article><h2>Related two</h2></article></aside>';
const headline = '<main><h1>How to build a marketing strategy</h1></main>';
test('parent collection references do not override the current article in schema graphs', () => {
  const schema = { '@graph': [
    { '@type': 'Article', url: 'https://example.com/marketing/strategy', headline: 'How to build a marketing strategy',
      isPartOf: { '@type': 'CollectionPage', '@id': 'https://example.com/marketing#page' } },
    { '@type': 'Article', url: 'https://example.com/another-story', headline: 'Wrong title' }
  ] };
  const page = extractPage('<script type="application/ld+json">' + JSON.stringify(schema) + '</script>' + headline + cards, 'https://example.com/marketing/strategy');
  assert.equal(page.isArticle, true);
  assert.equal(page.title, 'How to build a marketing strategy');
});
test('article metadata overrides related cards when the main H1 is outside article elements', () => {
  for (const metadata of [
    '<meta property="og:type" content="article">',
    '<script type="application/ld+json">{"@graph":[{"@type":"Article","headline":"How to build a marketing strategy"}]}</script>',
    '<meta property="og:type" content="ARTICLE">'
  ]) {
    const page = extractPage(metadata + headline + cards, 'https://example.com/marketing/strategy');
    assert.equal(page.isArticle, true);
    assert.equal(page.title, 'How to build a marketing strategy');
  }
});
test('related-card fix still excludes known hubs, categories and explicit collection pages', () => {
  const html = '<meta property="og:type" content="article">' + headline + cards;
  for (const path of ['/blog', '/en/blog', '/blog/es', '/category/marketing']) {
    assert.equal(extractPage(html, 'https://example.com' + path).isArticle, false);
  }
  assert.equal(extractPage('<script type="application/ld+json">{"@type":"CollectionPage"}</script>' + html, 'https://example.com/marketing').isArticle, false);
  assert.equal(extractPage(headline + cards, 'https://example.com/marketing').isArticle, false);
});
test('crawl collects custom-section articles with related cards, not their landing page', async () => {
  const entries = {
    '/marketing': '<h1>Marketing</h1><article><h2><a href="/marketing/strategy">Strategy</a></h2></article><article><h2><a href="/marketing/planning">Planning</a></h2></article>',
    '/marketing/strategy': '<meta property="og:type" content="article">' + headline + cards,
    '/marketing/planning': '<meta property="og:type" content="article"><main><h1>How to build a content plan</h1></main>' + cards
  };
  const result = await crawlWebsite('https://example.com/marketing', () => {}, {
    limits: { ...LIMITS, candidates: 10 },
    fetcher: async url => {
      const text = entries[new URL(url).pathname];
      if (!text) throw new Error('404');
      return {url, text, type: 'text/html'};
    }
  });
  assert.equal(result.totalTitles, 2);
  assert.equal(result.stats.failed, 0);
  assert.ok(result.sourceTitles.every(row => row.title !== 'Marketing'));
});
