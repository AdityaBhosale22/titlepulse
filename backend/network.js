import axios from 'axios';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import ipaddr from 'ipaddr.js';

export class UserError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export function publicAddress(address) {
  try { return ipaddr.process(address).range() === 'unicast'; } catch { return false; }
}

export function normalizeUrl(input, base) {
  if (typeof input !== 'string' || input.length > 2048 || !input.trim()) throw new UserError('Enter a valid public website URL.');
  let url;
  try {
    const value = input.trim();
    url = new URL(base || /^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`, base);
  } catch { throw new UserError('Enter a valid website URL, such as https://example.com.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) {
    throw new UserError('Use a public HTTP or HTTPS website without credentials or a custom port.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || /\.(localhost|local|internal|test|invalid)$/.test(host) || (!host.includes('.') && !host.includes(':')) || (ipaddr.isValid(host) && !publicAddress(host))) {
    throw new UserError('Only public websites can be analyzed. Local and private addresses are not supported.');
  }
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (/^(utm_.+|fbclid|gclid|ref)$/i.test(key)) url.searchParams.delete(key);
  url.searchParams.sort();
  url.pathname = url.pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
  return url.href;
}

export function sameSite(a, b) {
  const host = value => new URL(value).hostname.replace(/^www\./, '').toLowerCase();
  return host(a) === host(b);
}

// Validate the actual DNS answers used by the socket, including every redirect.
// This avoids a validation-then-resolution gap (DNS rebinding).
function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error) return callback(error);
    if (!addresses.length || addresses.some(entry => !publicAddress(entry.address))) return callback(new Error('Private network destinations are blocked.'));
    const family = typeof options === 'number' ? options : options?.family;
    const matches = family ? addresses.filter(entry => entry.family === family) : addresses;
    if (!matches.length) return callback(new Error('No supported public address was found.'));
    if (options?.all) callback(null, matches);
    else callback(null, matches[0].address, matches[0].family);
  });
}
const httpAgent = new http.Agent({ lookup: safeLookup, keepAlive: true, maxSockets: 6 });
const httpsAgent = new https.Agent({ lookup: safeLookup, keepAlive: true, maxSockets: 6 });

export async function fetchText(input, { signal, site = input, requester = axios.get } = {}) {
  let url = normalizeUrl(input);
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000);
  for (let hop = 0; hop <= 4; hop++) {
    if (!sameSite(url, site)) throw new Error('Cross-site redirect skipped.');
    const response = await requester(url, {
      signal: requestSignal, timeout: 8000, maxRedirects: 0, proxy: false,
      httpAgent, httpsAgent, responseType: 'text', transformResponse: [data => data],
      maxContentLength: 2 * 1024 * 1024, maxBodyLength: 2 * 1024 * 1024,
      headers: { 'User-Agent': 'TitlePulse/1.0 (title analysis)', Accept: 'text/html,application/xhtml+xml,application/xml,text/xml,text/plain;q=0.8' },
      validateStatus: status => status >= 200 && status < 400,
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (!response.headers.location) throw new Error('Redirect has no destination.');
      const destination = new URL(response.headers.location, url);
      normalizeUrl(destination.href); // Validate without changing the server's redirect path.
      destination.hash = '';
      url = destination.href;
      continue;
    }
    if (response.status >= 300) throw new Error('Page did not return usable content.');
    return { text: response.data, url, type: response.headers['content-type'] || '' };
  }
  throw new Error('Too many redirects.');
}
