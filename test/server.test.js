import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../backend/server.js';
import { analyzeTitles } from '../backend/analyzer.js';
import ExcelJS from 'exceljs';

test('analyses automatically save full data without a popup and deduplicate', async t => {
  let finish, calls = 0;
  const full = { website:'https://example.com', rankedAnalysis:[{term:'hello',count:2,type:'Keyword'}], sourceTitles:[{title:'hello world',url:'https://example.com/a'}] };
  const base = await serve(t, {  crawl:async () => full, sheetSave: async result => { calls++; assert.equal(result,full); return new Promise(resolve => {finish=resolve;}); } });
  const job = await (await post(base,{url:'example.com'})).json();
  await delay(5);
  const save = () => post(base,{url:'example.com'});
  assert.equal((await save()).status,200);
  assert.equal((await save()).status,200);
  assert.equal(calls,1);
  finish({tab:'example'}); await delay(5);
  assert.equal((await save()).status,200);
  const state=await (await fetch(base+'/api/analyses/'+job.id)).json();
  assert.equal(state.sheetSave.status,'saved');
  assert.equal(state.result.sourceTitles,undefined);
});
test('sheet save failures preserve analysis and can be retried after cooldown', async t => {
  let clock=1000, calls=0;
  const base=await serve(t,{now:()=>clock,crawl:async()=>({website:'https://example.com'}),sheetSave:async()=>{calls++;throw new Error('private');}});
  const job=await (await post(base,{url:'example.com'})).json();await delay(5);
  const save=()=>post(base,{url:'example.com'});
  await save();await delay(5);
  const state=await (await fetch(base+'/api/analyses/'+job.id)).json();
  assert.equal(state.status,'complete');assert.equal(state.sheetSave.status,'error');
  assert.ok(!state.sheetSave.error.includes('private'));
  assert.equal((await save()).status,200);assert.equal(calls,1);
  clock+=11000;assert.equal((await save()).status,200);await delay(5);assert.equal(calls,2);
});
import { setTimeout as delay } from 'node:timers/promises';

async function serve(t, options) {
  const server = createApp({ sheetSave: async () => ({tab:'test'}), ...options }).listen(0, '127.0.0.1');
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

test('exports cached full results while keeping source titles out of normal JSON responses', async t => {
  const sourceTitles = Array.from({ length: 14 }, (_, index) => ({ title: `Digital signature software for industry${String.fromCharCode(97 + index)}`, url: `https://example.com/blog/${index}` }));
  let crawls = 0;
  const base = await serve(t, { crawl: async () => { crawls++; return { website: 'https://example.com/', ...analyzeTitles(sourceTitles.map(row => row.title)), sourceTitles, partial: true, warnings: ['Time limit reached.'] }; } });
  const started = await (await post(base, { url: 'example.com' })).json();
  const job = await (await fetch(`${base}/api/analyses/${started.id}`)).json();
  assert.equal(job.result.longTails.length, 10);
  assert.equal('rankedAnalysis' in job.result, false);
  assert.equal('sourceTitles' in job.result, false);
  const cached = await (await post(base, { url: 'example.com' })).json();
  assert.equal('sourceTitles' in cached.result, false);
  const response = await fetch(`${base}/api/analyses/${started.id}/export`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /spreadsheetml.sheet/);
  assert.match(response.headers.get('content-disposition'), /titlepulse-example.com-partial.xlsx/);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()));
  assert.equal(workbook.getWorksheet('Source Titles').rowCount, 15);
  const ranked = workbook.getWorksheet('Ranked Analysis');
  let longTailRows = 0;
  ranked.eachRow(row => { if (row.getCell(2).value === 'Long-tail') longTailRows++; });
  assert.equal(longTailRows, 14);
  assert.equal((await fetch(`${base}/api/analyses/${started.id}/export`)).status, 200);
  assert.equal(crawls, 1);
});

test('export explains pending, failed and expired jobs', async t => {
  const base = await serve(t, { crawl: () => new Promise(() => {}) });
  const job = await (await post(base, { url: 'example.com' })).json();
  assert.equal((await fetch(`${base}/api/analyses/${job.id}/export`)).status, 409);
  assert.equal((await fetch(`${base}/api/analyses/missing/export`)).status, 404);
  const failedBase = await serve(t, { crawl: async () => { throw new Error('Unavailable'); } });
  const failed = await (await post(failedBase, { url: 'example.com' })).json();
  assert.equal((await fetch(`${failedBase}/api/analyses/${failed.id}/export`)).status, 409);
});

test('watchdog terminates hung jobs and ignores late results', async t => {
  let complete;
  const base = await serve(t, { jobTimeout: 30, crawl: () => new Promise(resolve => { complete = resolve; }) });
  const job = await (await post(base, { url: 'example.com' })).json();
  await delay(60);
  let state = await (await fetch(`${base}/api/analyses/${job.id}`)).json();
  assert.equal(state.status, 'error');
  assert.match(state.error, /time limit/);
  complete({ totalTitles: 123 });
  await delay(1);
  state = await (await fetch(`${base}/api/analyses/${job.id}`)).json();
  assert.equal(state.status, 'error');
  assert.equal(state.result, undefined);
});

test('different URLs on the same site cannot launch concurrent crawls', async t => {
  const base = await serve(t, { crawl: () => new Promise(() => {}) });
  assert.equal((await post(base, { url: 'https://example.com/blog' })).status, 202);
  assert.equal((await post(base, { url: 'https://www.example.com/articles' })).status, 409);
});


test('automatic saves queue beyond two writes and retain partial and empty results', async t => {
  const finishes = [];
  const saved = [];
  const base = await serve(t, {
    crawl: async website => ({website,totalTitles:0,partial:true,sourceTitles:[],rankedAnalysis:[]}),
    sheetSave: result => { saved.push(result); return new Promise(resolve => finishes.push(resolve)); }
  });
  const jobs=[];
  for (const host of ['example.com','example.org','example.net']) {
    jobs.push(await (await post(base,{url:host})).json());
    await delay(5);
  }
  assert.equal(saved.length,2);
  const queued=await (await fetch(base+'/api/analyses/'+jobs[2].id)).json();
  assert.equal(queued.status,'complete');
  assert.equal(queued.sheetSave.status,'saving');
  finishes[0]({tab:'first'});await delay(5);
  assert.equal(saved.length,3);
  assert.equal(saved[2].totalTitles,0);
  assert.equal(saved[2].partial,true);
  finishes[1]({tab:'second'});finishes[2]({tab:'third'});await delay(5);
  for (const job of jobs) assert.equal((await (await fetch(base+'/api/analyses/'+job.id)).json()).sheetSave.status,'saved');
});
