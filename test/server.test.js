import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../backend/server.js';

async function serve(t, options) {
  const server = createApp(options).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
const post = (base, body, headers = {}) => fetch(`${base}/api/analyses`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('job API deduplicates running jobs and returns cached aggregate results', async t => {
  let finish;
  let count = 0;
  const base = await serve(t, { crawl: async () => { count++; return new Promise(resolve => { finish = resolve; }); } });
  const first = await (await post(base, { url: 'example.com' })).json();
  const duplicate = await (await post(base, { url: 'https://example.com/#top' })).json();
  assert.equal(first.id, duplicate.id);
  assert.equal(count, 1);
  finish({ totalTitles: 2, phrases: [], keywords: [{ term: 'cloud', count: 2 }] });
  const result = await (await fetch(`${base}/api/analyses/${first.id}`)).json();
  assert.equal(result.status, 'complete');
  assert.equal(result.result.totalTitles, 2);
  assert.equal((await post(base, { url: 'example.com' })).status, 200);
});
test('validates input, restricts cross-origin requests and caps concurrent jobs', async t => {
  const base = await serve(t, { crawl: async () => new Promise(() => {}) });
  assert.equal((await post(base, { url: 'http://127.0.0.1' })).status, 400);
  assert.equal((await post(base, {})).status, 400);
  assert.equal((await post(base, { url: 'example.com' }, { Origin: 'https://malicious.example' })).status, 403);
  assert.equal((await post(base, { url: 'example.com' })).status, 202);
  assert.equal((await post(base, { url: 'example.org' })).status, 202);
  assert.equal((await post(base, { url: 'example.net' })).status, 429);
  assert.equal((await fetch(`${base}/api/analyses/unknown`)).status, 404);
});
test('records errors, allows retries and expires results', async t => {
  let clock = 1000;
  const base = await serve(t, { crawl: async () => { throw new Error('Website is unavailable.'); }, now: () => clock });
  const first = await (await post(base, { url: 'example.com' })).json();
  const failed = await (await fetch(`${base}/api/analyses/${first.id}`)).json();
  assert.equal(failed.status, 'error');
  const retry = await (await post(base, { url: 'example.com' })).json();
  assert.notEqual(retry.id, first.id);
  clock += 16 * 60 * 1000;
  assert.equal((await fetch(`${base}/api/analyses/${first.id}`)).status, 404);
});
