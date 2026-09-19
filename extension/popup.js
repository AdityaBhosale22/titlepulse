import { API_BASE } from './config.js';

const $ = id => document.getElementById(id);
const isExtension = Boolean(globalThis.chrome?.storage?.local && globalThis.chrome?.tabs);
const api = isExtension ? API_BASE : location.origin;
let busy = false;
let activeJob = null;
let timer;
let pollFailures = 0;
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
  $('analyze').disabled = value;
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
  if (busy) return;
  let url;
  try { url = validate($('website').value); }
  catch (error) { $('input-error').textContent = error.message; $('input-error').hidden = false; $('website').setAttribute('aria-invalid', 'true'); $('website').focus(); return; }
  clearTimeout(timer); pollFailures = 0; analysisDeadline = 0;
  $('input-error').hidden = true; $('website').removeAttribute('aria-invalid');
  $('results').hidden = true;
  clearTimeout(sheetTimer); sheetChecks = 0; activeJob = null;
  showSheetState(null);
  setBusy(true); status('Starting analysis', 'Looking for article titles on your website…', { loading: true });
  try {
    const job = await request('/api/analyses', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, refresh: true }) });
    await storage.set({ url, id: job.id }).catch(() => {});
    await handleJob(job);
  } catch (error) { setBusy(false); status('Couldn’t start analysis', error.message, { error: true }); }
});
$('website').addEventListener('input', () => { $('input-error').hidden = true; $('website').removeAttribute('aria-invalid'); });
function showSheetState(state) {
  clearTimeout(sheetTimer);
  sheetSaving = state?.status === 'saving';
  $('sheet-status').hidden = !state;
  $('sheet-status').classList.toggle('error', state?.status === 'error');
  $('sheet-status').textContent = state?.status === 'saved' ? '\u2713 Saved to Google Sheet' : state?.status === 'error' ? state.error + ' Open Sheet to check before analyzing again.' : state ? 'Saving to Google Sheet?' : '';
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
$('retry').addEventListener('click', () => { pollFailures = 0; setBusy(true); poll(); });
async function detect({ silent = false } = {}) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url || !/^https?:/.test(tab.url)) throw new Error('Open a public website tab, or enter its URL above.');
    $('website').value = tab.url;
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
