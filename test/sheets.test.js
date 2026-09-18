import test from 'node:test';
import assert from 'node:assert/strict';
import { saveToSheets } from '../backend/sheets.js';
test('sheet transport sends full cached data and only returns the tab', async () => {
  const result = { website: 'https://example.com', rankedAnalysis: Array.from({length: 25}, (_, i) => ({term: String(i), count: 1, type: 'Keyword'})), sourceTitles: [{title: '=1+1', url: 'https://example.com/a'}], partial: true, warnings: ['Partial'] };
  const saved = await saveToSheets(result, { secret: 'private', requester: async (url, body, options) => {
    assert.ok(url.endsWith('/exec')); assert.equal(body.secret, 'private');
    assert.equal(body.rankedAnalysis.length, 25); assert.deepEqual(body.sourceTitles, result.sourceTitles);
    assert.equal(options.timeout, 45000);
    return { data: {ok: true, tab: 'example', secret: 'never return'} };
  }});
  assert.deepEqual(saved, {tab: 'example'});
});
test('sheet transport rejects missing configuration and unexpected responses', async () => {
  await assert.rejects(saveToSheets({}, {secret: ''}), /not configured/);
  await assert.rejects(saveToSheets({}, {secret: 'x', endpoint: 'https://evil.example/exec'}), /invalid/);
  for (const data of [{ok:false,error:'secret leaked'}, '<html>Login</html>', {ok:true}]) {
    await assert.rejects(saveToSheets({}, {secret: 'x', requester: async () => ({data})}), /did not confirm/);
  }
  await assert.rejects(saveToSheets({}, {secret:'x', requester: async () => {throw new Error('private details');}}), /did not confirm/);
});
