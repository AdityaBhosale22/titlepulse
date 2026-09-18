import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchText } from '../backend/network.js';

test('preserves a trailing slash required by a server redirect', async () => {
  const calls = [];
  const requester = async url => {
    calls.push(url);
    return url.endsWith('/') ? { status: 200, data: '<h1>Article</h1>', headers: { 'content-type': 'text/html' } } : { status: 301, headers: { location: '/blog/article/' } };
  };
  const result = await fetchText('https://example.com/blog/article', { requester });
  assert.deepEqual(calls, ['https://example.com/blog/article', 'https://example.com/blog/article/']);
  assert.equal(result.url, 'https://example.com/blog/article/');
});
test('blocks cross-site and private redirects before fetching the next hop', async () => {
  for (const location of ['http://127.0.0.1/secret', 'https://unrelated.com/article']) {
    let count = 0;
    await assert.rejects(fetchText('https://example.com', { requester: async () => { count++; return { status: 302, headers: { location } }; } }));
    assert.equal(count, 1);
  }
});
test('bounds redirect loops', async () => {
  let count = 0;
  await assert.rejects(fetchText('https://example.com', { requester: async () => { count++; return { status: 302, headers: { location: '/' } }; } }), /Too many redirects/);
  assert.equal(count, 5);
});
