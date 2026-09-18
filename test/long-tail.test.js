import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTitles } from '../backend/analyzer.js';

test('distinguishes general topics from qualified long-tail phrases in the reference', () => {
  const result = analyzeTitles(['search', 'search marketing', 'search engine marketing', 'search engine optimization los angeles']);
  assert.deepEqual(result.longTails.map(row => row.term), ['search engine optimization los angeles']);
  assert.equal(result.longTails[0].count, 1);
  assert.equal(result.longTails[0].parent, 'search engine optimization');
});

test('extracts full audience-qualified topics and preserves action intent', () => {
  const titles = ['Best Digital Signature Software', 'Best Digital Signature Software for Small Businesses', 'Digital Signature Software for Small Businesses', 'How to Choose Digital Signature Software for Small Businesses'];
  const result = analyzeTitles(titles);
  assert.deepEqual(result.longTails.map(row => [row.term, row.count]), [
    ['digital signature software for small businesses', 3],
    ['choose digital signature software for small businesses', 1],
  ]);
  assert.deepEqual(result.longTails[0].matchingTitles, titles.slice(1));
  assert.equal(result.longTails[0].parent, 'digital signature software');
});

test('rejects generic templates and arbitrary three-word topics', () => {
  const titles = ['The Ultimate Guide', 'How to Create', 'Simple Easy Amazing Things', 'Search Engine Marketing', 'Digital Signature Software', 'This is a really great blog article', 'Content Marketing Strategy', 'Software and Marketing and Analytics'];
  assert.deepEqual(analyzeTitles(titles).longTails, []);
});

test('normalizes Unicode and hyphens, matches whole words, and counts each title once', () => {
  const titles = ['Digital-Signature Software for Small Businesses', 'ＤＩＧＩＴＡＬ signature software for small businesses: digital signature software for small businesses', 'Digital signature software for small businessesplus'];
  const row = analyzeTitles(titles).longTails.find(row => row.term === 'digital signature software for small businesses');
  assert.equal(row.count, 2);
  assert.deepEqual(row.matchingTitles, titles.slice(0, 2));
});

test('retains all ranked results for export while capping the UI arrays', () => {
  const titles = Array.from({ length: 15 }, (_, i) => `Digital signature software for industry${String.fromCharCode(97 + i)}`);
  const result = analyzeTitles([...titles, ...titles.map(title => `${title}: case study`)]);
  assert.equal(result.longTails.length, 10);
  assert.equal(result.rankedAnalysis.filter(row => row.type === 'Long-tail').length, 15);
  assert.ok(result.rankedAnalysis.filter(row => row.type === 'Keyword').length > 10);
  assert.ok(result.rankedAnalysis.filter(row => row.type === 'Phrase').length > 10);
  assert.ok(result.phrases.length <= 10);
  assert.ok(result.keywords.length <= 10);
});
