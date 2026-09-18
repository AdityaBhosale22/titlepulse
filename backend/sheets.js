import axios from 'axios';
import { buildReport } from './report.js';
import { UserError } from './network.js';

export const DEFAULT_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbw-3LrcPES6fbtGgr2AG7SSSN_sJmro3lQliZejgnw3OvoE2YjvWaXl9vnOlSzgVD8/exec';

export async function saveToSheets(result, { endpoint = process.env.GOOGLE_SHEETS_SCRIPT_URL || DEFAULT_SCRIPT_URL, secret = process.env.GOOGLE_SHEETS_SECRET, requester = axios.post } = {}) {
  if (!secret) throw new UserError('Google Sheets is not configured. Ask the administrator to set GOOGLE_SHEETS_SECRET.', 503);
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[a-zA-Z0-9_-]+\/exec$/.test(endpoint)) throw new UserError('The Google Sheets deployment URL is invalid.', 503);
  try {
    const response = await requester(endpoint, {
      secret, website: result.website, report: buildReport(result), rankedAnalysis: result.rankedAnalysis,
      sourceTitles: result.sourceTitles, partial: Boolean(result.partial), warnings: result.warnings || []
    }, { timeout: 45000, signal: AbortSignal.timeout(45000), maxRedirects: 3, maxBodyLength: 2000000, maxContentLength: 100000, proxy: false });
    if (response.data?.ok !== true || typeof response.data.tab !== 'string') throw new Error('Rejected');
    return { tab: response.data.tab };
  } catch {
    throw new UserError('Google Sheets did not confirm the save. Check the sheet before retrying; verify the deployment and secret with your administrator.', 502);
  }
}
