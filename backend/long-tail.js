import { matchingText } from './title-text.js';
// Conservative, title-only heuristics. These are specificity candidates, not
// estimates of search demand or competition, and not semantic/AI classification.
const ACTIONS = new Set('choose choosing create creating compare comparing find finding buy buying install installing integrate integrating automate automating optimize optimizing secure securing migrate migrating troubleshoot troubleshooting'.split(' '));
const QUALIFIERS = new Set('for with without using near in versus vs'.split(' '));
const TOPIC_HEADS = new Set('software tools platform service services optimization marketing management automation security signatures signature integration analytics storage hosting insurance loans training certification templates template solutions'.split(' '));
const GENERIC = new Set('best top ultimate complete comprehensive guide guides tips ways things everything something everyone great amazing simple easy better latest new essential powerful perfect introduction overview beginners beginner learn learning read updated update'.split(' '));
const BOILERPLATE = new Set('copyright reserved menu share related reading blog blogs article articles posts website official'.split(' '));

function stripTemplate(text) {
  let core = text.trim().replace(/^\d+\s+/, '');
  // Strip editorial framing, preserving meaningful actions such as "choose".
  for (let i = 0; i < 4; i++) {
    const next = core.replace(/^(?:how\s+to|(?:the\s+)?(?:(?:ultimate|complete|comprehensive|beginners?)\s+)?guide\s+to|(?:the\s+)?(?:best|top|ultimate|complete)|an?\s+introduction\s+to)\s+/i, '').trim();
    if (next === core) break;
    core = next;
  }
  return core;
}

export function findLongTails(titles, stopWords) {
  const candidates = new Map();
  const normalizedTitles = titles.map(matchingText);
  const meaningful = word => /\p{L}/u.test(word) && !stopWords.has(word) && !GENERIC.has(word);
  for (const title of normalizedTitles) {
    // Use complete title clauses, not every overlapping n-gram.
    for (const clause of title.split(/[^\p{L}\p{N}\s]/u)) {
      const core = stripTemplate(clause);
      const words = core.match(/[\p{L}\p{N}]+/gu) || [];
      const variants = [words];
      if (ACTIONS.has(words[0])) variants.push(words.slice(1));
      for (const tokens of variants) {
        const content = tokens.filter(meaningful);
        if (tokens.length < 3 || tokens.length > 16 || content.length < 3 || tokens.some(word => BOILERPLATE.has(word))) continue;
        if (!meaningful(tokens[0]) || !meaningful(tokens.at(-1))) continue;
        // Reject sentence-like clauses and promotional padding.
        if (tokens.some(word => /^(is|are|was|were|will|should|because|that|which|why|and|or)$/.test(word)) || tokens.some(word => GENERIC.has(word))) continue;
        const qualifier = tokens.findIndex(word => QUALIFIERS.has(word));
        const qualified = qualifier >= 0 && tokens.slice(0, qualifier).filter(meaningful).length >= 2 && tokens.slice(qualifier + 1).filter(meaningful).length >= 1;
        const action = ACTIONS.has(tokens[0]) && tokens.slice(1).filter(meaningful).length >= 3;
        // Topic + extra modifiers/location, e.g. "search engine optimization los angeles".
        // A bare three-word topic, e.g. "search engine marketing", is insufficient.
        const head = tokens.findIndex(word => TOPIC_HEADS.has(word));
        const modifiedTopic = content.length >= 4 && head >= 1 && tokens.slice(head + 1).filter(meaningful).length >= 1;
        if (!qualified && !action && !modifiedTopic) continue;
        const term = tokens.join(' ');
        const parent = qualified ? tokens.slice(0, qualifier).join(' ') : action ? tokens.slice(1).join(' ') : tokens.slice(0, head + 1).join(' ');
        if (parent === term) continue;
        candidates.set(term, { term, parent, reason: qualified ? 'Topic with audience, use-case or location context' : action ? 'Action with a specific topic' : 'Topic with additional specific modifiers', meaningfulWords: content.length });
      }
    }
  }
  // Count evidence across ALL titles, including occurrences inside another title.
  // Word boundaries prevent "business" matching "businesses" accidentally.
  const tokenized = normalizedTitles.map(title => (title.match(/[\p{L}\p{N}]+|[^\p{L}\p{N}\s]/gu) || []).join(' '));
  return [...candidates.values()].map(candidate => {
    const ids = tokenized.flatMap((title, index) => (` ${title} `).includes(` ${candidate.term} `) ? [index] : []);
    return { ...candidate, count: ids.length, matchingTitles: ids.map(id => titles[id]) };
  }).filter(candidate => candidate.count > 0)
    .sort((a, b) => b.count - a.count || b.meaningfulWords - a.meaningfulWords || a.term.localeCompare(b.term, 'en'))
    .map(({ meaningfulWords, ...candidate }) => candidate);
}
