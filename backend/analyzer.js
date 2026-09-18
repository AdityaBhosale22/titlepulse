const STOP = new Set(`a an the and or but if then than as at by for from in into of on onto out over per to up via with without about above after again against all am any are around be because been before being below between both can could did do does doing down during each few further had has have having he her here hers herself him himself his how i im ive in is it its itself just let lets me more most my myself no nor not now off once only other our ours ourselves own same she should so some such that their theirs them themselves there these they this those through too under until very was we were what when where which while who whom why will would you your yours yourself yourselves also new best top ultimate complete guide guides tips ways learn read blog blogs article articles post posts news home page pages website official updated update copyright reserved menu search next previous share related minute minutes reading`.split(/\s+/));

export function cleanTitle(title, siteName = '') {
  let value = title.replace(/\s+/g, ' ').trim();
  const segments = value.split(/\s+[|–—-]\s+|\s*\|\s*/);
  if (siteName && segments.length > 1) {
    const key = text => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    value = segments.filter(segment => key(segment) !== key(siteName)).join(' - ');
  }
  return value.slice(0, 500);
}

// Stop words are removed from keywords, but preserved INSIDE meaningful patterns.
// Removing them before n-gram generation would destroy "How to Create".
const TITLE_WORDS = new Set('new best top ultimate complete guide guides tips ways learn read updated update'.split(' '));
const PHRASE_STOP = new Set([...STOP].filter(word => !TITLE_WORDS.has(word)));
const OPENERS = new Set('a an the how why what when where which who can should is are do does'.split(' '));
const NOISE = new Set('blog blogs article articles post posts news home page pages website official copyright reserved menu search next previous share related minute minutes reading'.split(' '));

export function analyzeTitles(titles) {
  const keywords = new Map();
  const patterns = new Map();
  titles.forEach((title, titleIndex) => {
    const normalized = title.normalize('NFKC').replace(/[’']/g, '').replace(/(?<=\p{L})-(?=\p{L})/gu, ' ');
    // Every punctuation boundary is retained, so filtering cannot invent adjacency.
    const tokens = [...normalized.matchAll(/[\p{L}\p{N}]+|[^\p{L}\p{N}\s]/gu)];
    const words = tokens.map(token => token[0].toLowerCase());
    const isWord = word => /^\p{L}[\p{L}\p{N}]*$/u.test(word);
    const useful = word => isWord(word) && word.length > 1 && !STOP.has(word);
    for (const word of new Set(words.filter(useful))) keywords.set(word, (keywords.get(word) || 0) + 1);
    for (let start = 0; start < words.length; start++) {
      for (const size of [2, 3, 4]) {
        const chunk = words.slice(start, start + size);
        if (chunk.length !== size || !chunk.every(word => isWord(word) && !NOISE.has(word))) continue;
        if (!chunk.some(word => !PHRASE_STOP.has(word))) continue;
        if (PHRASE_STOP.has(chunk.at(-1))) continue; // No dangling "guide to" or "create a".
        if (PHRASE_STOP.has(chunk[0]) && !OPENERS.has(chunk[0])) continue;
        const term = chunk.join(' ');
        let pattern = patterns.get(term);
        if (!pattern) {
          const end = tokens[start + size - 1];
          pattern = { term, label: normalized.slice(tokens[start].index, end.index + end[0].length), words: chunk, matches: new Set(), starts: 0 };
          patterns.set(term, pattern);
        }
        pattern.matches.add(titleIndex);
        if (start === 0) pattern.starts++;
      }
    }
  });

  // Hide redundant fragments only when a longer pattern explains exactly the
  // same articles. Keep shorter phrases when they have broader support.
  const redundant = new Set();
  for (const pattern of patterns.values()) {
    if (pattern.matches.size < 2) continue;
    for (let size = 2; size < pattern.words.length; size++) {
      for (let start = 0; start <= pattern.words.length - size; start++) {
        const shorter = patterns.get(pattern.words.slice(start, start + size).join(' '));
        if (shorter && shorter.matches.size === pattern.matches.size && [...shorter.matches].every(id => pattern.matches.has(id))) redundant.add(shorter.term);
      }
    }
  }
  const phrases = [...patterns.values()].filter(pattern => pattern.matches.size >= 2 && !redundant.has(pattern.term))
    .sort((a, b) => b.matches.size - a.matches.size || b.starts - a.starts || b.words.length - a.words.length || a.term.localeCompare(b.term, 'en'))
    .slice(0, 10)
    .map(pattern => ({ term: pattern.term, label: pattern.label, count: pattern.matches.size, matchingTitles: [...pattern.matches].map(id => titles[id]) }));
  const rankedKeywords = [...keywords].filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'en'))
    .slice(0, 10).map(([term, count]) => ({ term, count }));
  return { totalTitles: titles.length, phrases, keywords: rankedKeywords };
}
