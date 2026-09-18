import { API_BASE } from './config.js';

const $ = id => document.getElementById(id);
const isExtension = Boolean(globalThis.chrome?.storage?.local && globalThis.chrome?.tabs);
const api = isExtension ? API_BASE : location.origin;
let busy = false;
let activeJob = null;
let timer;
let pollFailures = 0;
let exporting = false;
let completedResult = null;
let analysisDeadline = 0;
let sheetTimer;
let sheetSaving = false;
let sheetChecks = 0;
const storage = {
  async get() { if (isExtension) return (await chrome.storage.local.get('titlepulse')).titlepulse; try { return JSON.parse(localStorage.getItem('titlepulse')); } catch { return null; } },
  async set(value) { if (isExtension) await chrome.storage.local.set({ titlepulse: value }); else localStorage.setItem('titlepulse', JSON.stringify(value)); },
};

function setBusy(value) {
  busy = value;
  $('analyze').disabled = value || exporting;
  $('export-excel').disabled = value || exporting || !completedResult;
  $('save-sheet').disabled = value || sheetSaving || !completedResult;
  $('website').disabled = value;
  $('detect').disabled = value;
  $('analyze').replaceChildren(document.createTextNode(value ? 'Analyzing…' : 'Analyze website'));
  $('analyze-form').setAttribute('aria-busy', String(value));
}
function status(title, message, { error = false, loading = false } = {}) {
  $('status-panel').hidden = false;
  $('status-panel').classList.toggle('error', error);
  $('status-title').textContent = title;
  $('status-message').textContent = message;
  $('spinner').hidden = !loading;
  $('retry').hidden = true;
  $('welcome').hidden = true;
}
async function request(path, options = {}) {
  let response;
  try { response = await fetch(`${api}${path}`, { ...options, signal: AbortSignal.timeout(12000) }); }
  catch { throw new Error('Cannot connect to TitlePulse. Check that the backend is running, then try again.'); }
  let data;
  try { data = await response.json(); } catch { throw new Error('The backend returned an unexpected response. Check its URL and try again.'); }
  if (!response.ok) { const error = new Error(data.error || 'The request failed. Please try again.'); error.status = response.status; throw error; }
  return data;
}
function showRanking(id, items) {
  const rows = items.slice(0, 10).map(item => {
    const row = document.createElement('li');
    const term = document.createElement('span'); term.className = 'term'; term.textContent = item.term;
    const count = document.createElement('span'); count.className = 'count'; count.textContent = item.count; count.setAttribute('aria-label', `${item.count} titles`);
    row.append(term, count); return row;
  });
  $(id).replaceChildren(...rows);
  $(`${id}-empty`).hidden = rows.length > 0;
}
function showPatterns(items, id = 'phrases') {
  const rows = items.slice(0, 10).map(item => {
    const row = document.createElement('li');
    const term = document.createElement('span'); term.className = 'term'; term.textContent = item.label || item.term;
    const count = document.createElement('span'); count.className = 'count'; count.textContent = `${item.count} ${item.count === 1 ? 'title' : 'titles'}`;
    const matches = document.createElement('ul'); matches.className = 'matching-titles'; matches.tabIndex = 0;
    matches.setAttribute('aria-label', `Titles matching ${item.label || item.term}`);
    for (const title of item.matchingTitles || []) {
      const match = document.createElement('li'); match.textContent = title; matches.append(match);
    }
    row.append(term, count, matches);
    return row;
  });
  $(id).replaceChildren(...rows);
  $(`${id}-empty`).hidden = rows.length > 0;
}
function showResults(result) {
  completedResult = result;
  $('export-excel').disabled = exporting;
  $('save-sheet').disabled = sheetSaving;
  $('export-status').hidden = true;
  $('results').hidden = false;
  $('total').textContent = result.totalTitles;
  $('result-state').textContent = result.partial ? 'Partial results' : 'Complete';
  $('result-site').textContent = new URL(result.website).hostname + (result.stats ? ` · ${result.stats.checked} pages checked, ${result.stats.failed} failed` : '');
  showPatterns(result.phrases);
  showPatterns(result.longTails || [], 'long-tails');
  showRanking('keywords', result.keywords);
  $('keyword-details').hidden = !result.keywords.length;
  $('keyword-details').open = false;
  $('warnings').hidden = !result.warnings.length;
  $('warnings').open = false;
  $('warning-list').replaceChildren(...result.warnings.map(warning => { const li = document.createElement('li'); li.textContent = warning; return li; }));
  if (!result.totalTitles) status('No article titles found', 'Try the website’s blog URL. The site may require JavaScript, block crawling, or have no discoverable articles.');
  else if (!result.phrases.length && !result.longTails?.length) status('No recurring title patterns', `We analyzed ${result.totalTitles} titles, but found no recurring patterns or sufficiently specific long-tail phrases.${result.partial ? ' Some pages could not be included; see “About these results”.' : ''}`);
  else if (result.partial) status('Analysis ready, with some gaps', 'Some pages could not be included. See “About these results” for details.');
  else $('status-panel').hidden = true;
}
async function handleJob(job) {
  activeJob = job.id;
  if (job.status === 'running') {
    analysisDeadline ||= Math.min(Date.now() + 120000, Number(job.deadlineAt) || Date.now() + 120000);
    if (Date.now() >= analysisDeadline) {
      setBusy(false);
      status('Analysis timed out', 'The backend did not finish in time. Try again or enter a more specific blog URL.', { error: true });
      return;
    }
    setBusy(true);
    const titles = { discovering: 'Discovering articles', crawling: 'Reading article titles', analyzing: 'Finding recurring topics' };
    status(titles[job.progress.phase] || 'Analyzing website', job.progress.message, { loading: true });
    timer = setTimeout(poll, 1000);
  } else {
    setBusy(false);
    if (job.status === 'complete') { showResults(job.result); showSheetState(job.sheetSave); }
    else status('Couldn’t analyze this website', job.error, { error: true });
  }
}
async function poll() {
  clearTimeout(timer);
  try {
    const job = await request(`/api/analyses/${activeJob}`);
    pollFailures = 0;
    await handleJob(job);
  } catch (error) {
    if (error.status === 404) {
      activeJob = null; setBusy(false);
      await storage.set({ url: $('website').value, id: null }).catch(() => {});
      status('Analysis no longer available', error.message, { error: true });
    } else if (++pollFailures < 4) {
      status('Reconnecting…', 'The connection was interrupted. Your analysis may still be running.', { loading: true });
      timer = setTimeout(poll, 2000 * pollFailures);
    } else {
      setBusy(false);
      status('Connection interrupted', error.message, { error: true });
      $('retry').hidden = false;
    }
  }
}
function validate(value) {
  const raw = value.trim();
  if (!raw || /\s/.test(raw)) throw new Error('Enter a website URL, such as example.com.');
  let url;
  try { url = new URL(/^[a-z][a-z\d+.-]*:/i.test(raw) ? raw : `https://${raw}`); } catch { throw new Error('Enter a valid website URL, such as example.com.'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname.includes('.') || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) throw new Error('Use a public HTTP or HTTPS website URL.');
  url.hash = '';
  return url.href;
}
$('analyze-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || exporting) return;
  let url;
  try { url = validate($('website').value); }
  catch (error) { $('input-error').textContent = error.message; $('input-error').hidden = false; $('website').setAttribute('aria-invalid', 'true'); $('website').focus(); return; }
  clearTimeout(timer); pollFailures = 0; analysisDeadline = 0;
  $('input-error').hidden = true; $('website').removeAttribute('aria-invalid');
  $('results').hidden = true;
  completedResult = null;
  setBusy(true); status('Starting analysis', 'Looking for article titles on your website…', { loading: true });
  try {
    const job = await request('/api/analyses', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
    await storage.set({ url, id: job.id }).catch(() => {});
    await handleJob(job);
  } catch (error) { setBusy(false); status('Couldn’t start analysis', error.message, { error: true }); }
});
$('export-excel').addEventListener('click', async () => {
  if (busy || exporting || !completedResult || !activeJob) return;
  exporting = true;
  setBusy(false);
  $('export-excel').textContent = 'Exporting…';
  $('export-status').hidden = false;
  $('export-status').classList.remove('error');
  $('export-status').textContent = 'Preparing all ranked results and source titles…';
  try {
    let response;
    try { response = await fetch(`${api}/api/analyses/${activeJob}/export`, { signal: AbortSignal.timeout(30000) }); }
    catch { throw new Error('Could not download the workbook. Check the backend connection and try again.'); }
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'Excel export failed. Please try again.');
    }
    if (!response.headers.get('content-type')?.includes('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')) throw new Error('The backend returned an unexpected export. Please update the backend and try again.');
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const host = new URL(completedResult.website).hostname.replace(/[^a-z0-9.-]/gi, '-');
    link.href = url;
    link.download = `titlepulse-${host}${completedResult.partial ? '-partial' : ''}.xlsx`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    $('export-status').textContent = completedResult.partial ? 'Download started. This workbook contains partial crawl results.' : 'Download started. All analyzed results and source titles are included.';
  } catch (error) {
    $('export-status').classList.add('error');
    $('export-status').textContent = error.message;
  } finally {
    exporting = false;
    $('export-excel').textContent = 'Export Excel';
    setBusy(busy);
  }
});
$('website').addEventListener('input', () => { $('input-error').hidden = true; $('website').removeAttribute('aria-invalid'); });
function showSheetState(state) {
  clearTimeout(sheetTimer);
  sheetSaving = state?.status === 'saving';
  $('save-sheet').disabled = busy || sheetSaving || !completedResult;
  $('save-sheet').textContent = sheetSaving ? 'Saving...' : 'Save to Google Sheet';
  $('sheet-status').hidden = !state;
  $('sheet-status').classList.toggle('error', state?.status === 'error');
  $('sheet-status').textContent = state?.status === 'saved' ? 'Saved to tab: ' + state.tab : state?.status === 'error' ? state.error : state ? 'Saving all ranked results and source titles. You can close this popup.' : '';
  if (sheetSaving) {
    const id = activeJob;
    sheetTimer = setTimeout(async () => {
      if (activeJob !== id) return;
      try {
        if (++sheetChecks > 60) throw new Error('Save confirmation timed out. Reopen the popup to check its status.');
        const job = await request('/api/analyses/' + id);
        if (activeJob === id) showSheetState(job.sheetSave);
      } catch (error) { if (activeJob === id) showSheetState({ status: 'error', error: error.message + ' Check the sheet before retrying.' }); }
    }, 1000);
  }
}
$('save-sheet').addEventListener('click', async () => {
  if (busy || sheetSaving || !completedResult || !activeJob) return;
  const key = $('sheet-key').value.trim();
  if (!key) { showSheetState({ status: 'error', error: 'Enter your team save key under Team sheet access.' }); $('sheet-key').closest('details').open = true; $('sheet-key').focus(); return; }
  const id = activeJob;
  sheetChecks = 0;
  showSheetState({ status: 'saving' });
  try {
    const state = await request('/api/analyses/' + id + '/sheets', { method: 'POST', headers: { 'X-TitlePulse-Team-Key': key } });
    if (activeJob === id) showSheetState(state);
  } catch (error) { if (activeJob === id) showSheetState({ status: 'error', error: error.message }); }
});
$('retry').addEventListener('click', () => { pollFailures = 0; setBusy(true); poll(); });
async function detect({ silent = false } = {}) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url || !/^https?:/.test(tab.url)) throw new Error('Open a public website tab, or enter its URL above.');
    $('website').value = new URL(tab.url).origin;
    $('input-error').hidden = true;
    $('website').removeAttribute('aria-invalid');
  } catch (error) { if (!silent) { $('input-error').textContent = error.message; $('input-error').hidden = false; } }
}
$('detect').hidden = !isExtension;
$('detect').addEventListener('click', () => detect());
async function init() {
  const saved = await storage.get().catch(() => null);
  if (saved?.url) $('website').value = saved.url;
  if (saved?.id) { activeJob = saved.id; setBusy(true); status('Restoring analysis', 'Checking your last analysis…', { loading: true }); await poll(); }
  else if (isExtension) await detect({ silent: true });
}
window.addEventListener('pagehide', () => { clearTimeout(timer); clearTimeout(sheetTimer); });
init();
