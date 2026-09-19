import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const html = await readFile(new URL('../extension/popup.html', import.meta.url), 'utf8');
const script = (await readFile(new URL('../extension/popup.js', import.meta.url), 'utf8')).replace("import { API_BASE } from './config.js';", "const API_BASE = 'http://127.0.0.1:3000';");
const flush = () => new Promise(resolve => setImmediate(resolve));
const result = overrides => ({ website: 'https://example.com/', totalTitles: 20, phrases: [{ term: 'content strategy', count: 8 }], keywords: [{ term: 'content', count: 12 }], partial: false, warnings: [], ...overrides });


test('completed analysis shows confirmed automatic save and only Open Sheet', async t => {
  const ui = await setup(t, { fetcher: async () => ({ ok:true, json:async()=>({id:'job',status:'complete',result:result(),sheetSave:{status:'saved',tab:'example'}}) }) });
  ui.get('website').value='example.com'; ui.submit(); await flush();
  assert.equal(ui.get('sheet-status').textContent,'\u2713 Saved to Google Sheet');
  assert.equal(ui.calls.length,1);
  for (const id of ['export-excel','save-sheet','sheet-key','sheet-form']) assert.equal(ui.get(id),null);
  assert.equal(ui.dom.window.document.querySelectorAll('#results button, #results a').length,1);
});
test('reopening resumes save polling and confirms only after save succeeds', async t => {
  let calls=0;
  const ui=await setup(t,{saved:{url:'example.com',id:'job'},fetcher:async()=>({ok:true,json:async()=>({id:'job',status:'complete',result:result(),sheetSave:++calls===1?{status:'saving'}:{status:'saved',tab:'example'}})})});
  assert.equal(ui.get('sheet-status').textContent,'Saving to Google Sheet?');
  await new Promise(resolve=>setTimeout(resolve,1100));
  assert.equal(ui.get('sheet-status').textContent,'\u2713 Saved to Google Sheet');
  assert.ok(ui.calls.every(([,options])=>!options.method));
});
test('automatic save errors preserve results and Open Sheet without a false confirmation', async t => {
  const ui=await setup(t,{fetcher:async()=>({ok:true,json:async()=>({id:'job',status:'complete',result:result(),sheetSave:{status:'error',error:'Save unavailable.'}})})});
  ui.get('website').value='example.com';ui.submit();await flush();
  assert.equal(ui.get('results').hidden,false);
  assert.equal(ui.get('sheet-status').classList.contains('error'),true);
  assert.match(ui.get('sheet-status').textContent,/Save unavailable/);
  assert.ok(!ui.get('sheet-status').textContent.includes('\u2713'));
});
test('Use current tab refreshes the full address including query and fragment', async t => {
  const ui = await setup(t, { extension:true });
  const address = 'https://blog.example.com/marketing/?topic=email&sort=new#articles';
  ui.dom.window.chrome.tabs.query = async () => [{url:address}];
  ui.get('website').value='https://old.example.com';
  ui.get('detect').click(); await flush();
  assert.equal(ui.get('website').value,address);
  ui.submit(); await flush();
  assert.equal(JSON.parse(ui.calls[0][1].body).url,address.split('#')[0]);
});
test('partial results retain badge and warnings without an extra success banner', async t => {
  const ui = await setup(t, {fetcher:async()=>({ok:true,json:async()=>({id:'job',status:'complete',result:result({partial:true,warnings:['Some pages timed out.']})})})});
  ui.get('website').value='example.com';ui.submit();await flush();
  assert.equal(ui.get('status-panel').hidden,true);
  assert.equal(ui.get('result-state').textContent,'Partial results');
  assert.equal(ui.get('warnings').hidden,false);
  assert.match(ui.get('warning-list').textContent,/timed out/);
});
test('Use current tab reports unsupported browser pages without replacing the input', async t => {
  const ui = await setup(t, {extension:true});
  ui.dom.window.chrome.tabs.query = async()=>[{url:'chrome://extensions/'}];
  ui.get('website').value='https://example.org/blog';
  ui.get('detect').click();await flush();
  assert.equal(ui.get('website').value,'https://example.org/blog');
  assert.equal(ui.get('input-error').hidden,false);
});

test('utility layout forces light mode and opens the shared sheet safely', async t => {
  const ui=await setup(t);
  assert.equal(ui.dom.window.document.querySelector('meta[name="color-scheme"]').content,'light');
  assert.equal(ui.get('open-sheet').target,'_blank');
  assert.ok(ui.get('open-sheet').rel.includes('noopener'));
  assert.ok(ui.get('open-sheet').href.includes('1ZbQ1BrGaJDhKXXaj8D2kwt8PgVlyrPvw2dOrD-5Wtds'));
  assert.equal(ui.get('welcome').hidden,false);
});

async function setup(t, { fetcher, saved, extension = false } = {}) {
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:3000', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  let stored = saved;
  const calls = [];
  dom.window.AbortSignal = AbortSignal;
  dom.window.fetch = async (...args) => { calls.push(args); return fetcher ? fetcher(...args) : { ok: true, json: async () => ({ id: 'job', status: 'complete', result: result() }) }; };
  if (saved) dom.window.localStorage.setItem('titlepulse', JSON.stringify(saved));
  if (extension) dom.window.chrome = {
    storage: { local: { get: async () => ({ titlepulse: stored }), set: async value => { stored = value.titlepulse; } } },
    tabs: { query: async () => [{ url: 'https://example.org/blog/story' }] },
  };
  dom.window.eval(script);
  await flush();
  const get = id => dom.window.document.getElementById(id);
  return { dom, get, calls, submit: () => get('analyze-form').dispatchEvent(new dom.window.Event('submit', { cancelable: true, bubbles: true })) };
}

test('popup validates URLs without making a request', async t => {
  const ui = await setup(t);
  ui.get('website').value = 'file:///secret'; ui.submit();
  await flush();
  assert.equal(ui.calls.length, 0);
  assert.equal(ui.get('input-error').hidden, false);
  assert.equal(ui.get('website').getAttribute('aria-invalid'), 'true');
});
test('popup renders aggregate rankings and limits each section to ten', async t => {
  const ui = await setup(t, { fetcher: async () => ({ ok: true, json: async () => ({ id: 'job', status: 'complete', result: result({ keywords: Array.from({ length: 15 }, (_, i) => ({ term: `term ${i}`, count: 20 - i })) }) }) }) });
  ui.get('website').value = 'example.com'; ui.submit(); await flush();
  assert.equal(ui.get('results').hidden, false);
  assert.equal(ui.get('total').textContent, '20');
  assert.equal(ui.get('phrases').textContent, 'content strategy8 titles');
  assert.equal(ui.get('keywords').children.length, 10);
  assert.equal(ui.get('status-panel').hidden, true);
  assert.equal(ui.get('analyze').disabled, false);
});

test('shows matching article titles under patterns and keeps keywords collapsed', async t => {
  const titles = ['How to Create a Digital Signature', 'How to Create an Electronic Signature'];
  const ui = await setup(t, { fetcher: async () => ({ ok: true, json: async () => ({ id: 'job', status: 'complete', result: result({ phrases: [{ term: 'how to create', label: 'How to Create', count: 2, matchingTitles: titles }] }) }) }) });
  ui.get('website').value = 'example.com'; ui.submit(); await flush();
  assert.equal(ui.get('phrases').querySelector('.term').textContent, 'How to Create');
  assert.equal(ui.get('phrases').querySelector('.count').textContent, '2 titles');
  assert.deepEqual([...ui.get('phrases').querySelectorAll('.matching-titles > li')].map(li => li.textContent), titles);
  assert.equal(ui.get('keyword-details').open, false);
  assert.equal(ui.get('keyword-details').hidden, false);
});

test('reports empty patterns even when recurring single keywords exist', async t => {
  const ui = await setup(t, { fetcher: async () => ({ ok: true, json: async () => ({ id: 'job', status: 'complete', result: result({ phrases: [], keywords: [{ term: 'signatures', count: 27 }], partial: true, warnings: ['A page timed out.'] }) }) }) });
  ui.get('website').value = 'example.com'; ui.submit(); await flush();
  assert.equal(ui.get('status-title').textContent, 'No recurring title patterns');
  assert.equal(ui.get('phrases-empty').hidden, false);
  assert.equal(ui.get('keyword-details').open, false);
  assert.equal(ui.get('warnings').hidden, false);
  assert.equal(ui.get('result-state').textContent, 'Partial results');
});

test('safely renders matching titles without interpreting markup', async t => {
  const title = 'How to Create <img src=x onerror=alert(1)>';
  const ui = await setup(t, { fetcher: async () => ({ ok: true, json: async () => ({ id: 'job', status: 'complete', result: result({ phrases: [{ term: 'how to create', count: 2, matchingTitles: [title, 'How to Create PDFs'] }] }) }) }) });
  ui.get('website').value = 'example.com'; ui.submit(); await flush();
  assert.equal(ui.get('phrases').querySelector('img'), null);
  assert.equal(ui.get('phrases').querySelector('.matching-titles > li').textContent, title);
});
test('popup prevents duplicate submits and shows real progress', async t => {
  const ui = await setup(t, { fetcher: async () => ({ ok: true, json: async () => ({ id: 'job', status: 'running', progress: { phase: 'crawling', message: 'Checked 3 of 20 pages.' } }) }) });
  ui.get('website').value = 'example.com'; ui.submit(); ui.submit(); await flush();
  assert.equal(ui.calls.length, 1);
  assert.equal(ui.get('analyze').disabled, true);
  assert.equal(ui.get('status-message').textContent, 'Checked 3 of 20 pages.');
  assert.equal(ui.get('spinner').hidden, false);
});
test('popup restores a saved job and explains expired analyses', async t => {
  const ui = await setup(t, { saved: { url: 'example.com', id: 'expired' }, fetcher: async () => ({ ok: false, status: 404, json: async () => ({ error: 'Analysis expired.' }) }) });
  assert.ok(ui.calls[0][0].endsWith('/api/analyses/expired'));
  assert.equal(ui.get('status-title').textContent, 'Analysis no longer available');
  assert.equal(ui.get('analyze').disabled, false);
});
test('popup shows partial and empty results and safely renders untrusted terms', async t => {
  const ui = await setup(t, { fetcher: async () => ({ ok: true, json: async () => ({ id: 'job', status: 'complete', result: result({ totalTitles: 0, keywords: [], phrases: [], partial: true, warnings: ['Some pages were blocked.'] }) }) }) });
  ui.get('website').value = 'example.com'; ui.submit(); await flush();
  assert.equal(ui.get('status-title').textContent, 'No article titles found');
  assert.equal(ui.get('result-state').textContent, 'Partial results');
  assert.equal(ui.get('warnings').hidden, false);
  assert.equal(ui.get('phrases-empty').hidden, false);
  const safe = await setup(t, { fetcher: async () => ({ ok: true, json: async () => ({ id: 'job', status: 'complete', result: result({ phrases: [{ term: '<img src=x onerror=alert(1)>', count: 2 }] }) }) }) });
  safe.get('website').value = 'example.com'; safe.submit(); await flush();
  assert.equal(safe.get('phrases').querySelector('img'), null);
  assert.ok(safe.get('phrases').textContent.includes('<img'));
});
test('popup explains backend connection failures', async t => {
  const ui = await setup(t, { fetcher: async () => { throw new TypeError('Failed to fetch'); } });
  ui.get('website').value = 'example.com'; ui.submit(); await flush();
  assert.equal(ui.get('status-title').textContent, 'Couldn’t start analysis');
  assert.match(ui.get('status-message').textContent, /backend is running/);
  assert.equal(ui.get('analyze').disabled, false);
});
test('extension detects full current URL and stores a completed job', async t => {
  const ui = await setup(t, { extension: true });
  assert.equal(ui.get('detect').hidden, false);
  assert.equal(ui.get('website').value, 'https://example.org/blog/story');
  ui.submit(); await flush();
  assert.equal(ui.get('results').hidden, false);
  assert.ok(ui.calls[0][0].startsWith('http://127.0.0.1:3000/api/'));
});

test('shows specific long-tail matches even when there are no recurring patterns', async t => {
  const tail = { term: 'choose digital signature software for small businesses', count: 1, matchingTitles: ['How to Choose Digital Signature Software for Small Businesses'] };
  const ui = await setup(t, { fetcher: async () => ({ ok: true, json: async () => ({ id: 'job', status: 'complete', result: result({ phrases: [], longTails: [tail] }) }) }) });
  ui.get('website').value = 'example.com'; ui.submit(); await flush();
  assert.equal(ui.get('long-tails').querySelector('.term').textContent, tail.term);
  assert.equal(ui.get('long-tails').querySelector('.count').textContent, '1 title');
  assert.equal(ui.get('long-tails-empty').hidden, true);
  assert.equal(ui.get('status-panel').hidden, true);
});

test('popup stops analyzing when a restored job has exceeded its deadline', async t => {
  const ui = await setup(t, { saved: { url: 'example.com', id: 'stuck' }, fetcher: async () => ({ ok: true, json: async () => ({ id: 'stuck', status: 'running', deadlineAt: Date.now() - 1000, progress: { phase: 'crawling', message: 'Still running' } }) }) });
  assert.equal(ui.get('analyze').disabled, false);
  assert.equal(ui.get('spinner').hidden, true);
  assert.equal(ui.get('status-title').textContent, 'Analysis timed out');
});

test('reopening a running job resumes polling without submitting a new analysis', async t => {
  const ui = await setup(t, { saved: { url: 'example.com', id: 'running' }, fetcher: async () => ({ ok: true, json: async () => ({ id: 'running', status: 'running', deadlineAt: Date.now() + 60000, progress: { phase: 'crawling', message: 'Checked 10 pages; 2 failed.' } }) }) });
  assert.equal(ui.get('analyze').disabled, true);
  assert.equal(ui.calls.length, 1);
  assert.ok(ui.calls[0][0].endsWith('/api/analyses/running'));
  assert.equal(ui.get('status-message').textContent, 'Checked 10 pages; 2 failed.');
});
