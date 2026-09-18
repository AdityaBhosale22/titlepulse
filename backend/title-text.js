import { load } from 'cheerio';

export function titleText(value) {
  if (typeof value !== 'string') return '';
  // Decode entities without interpreting scraped text as markup.
  return load(`<textarea>${value.slice(0, 4000).replace(/</g, '&lt;')}</textarea>`)
    ('textarea').text().replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
}

export function matchingText(value) {
  return value.normalize('NFKC').toLowerCase().replace(/[’']/g, '')
    .replace(/(?<=\p{L})[-‐‑](?=\p{L})/gu, ' ')
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, ' ').replace(/\s+/g, ' ').trim();
}

export function titleKey(value) {
  return (matchingText(value).match(/[\p{L}\p{N}]+/gu) || []).join(' ');
}

export function usableTitle(value) {
  return (value.match(/\p{L}/gu) || []).length >= 3 && !/^(?:403|404|429|500|502|503|504)\b/.test(value) && !/^(?:just a moment|access denied|attention required|please wait|loading|untitled|not found|page not found|internal server error|service unavailable|verify you are human|checking your browser|enable javascript|javascript required|home|blog|error)(?:[.!…\s]|\s*[-|:].*)*$/i.test(value);
}
