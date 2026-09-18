export function buildReport(result) {
  const rows = [], sections = [], headers = [];
  const add = (...v) => { rows.push([...v, ...Array(5-v.length).fill('')]); return rows.length; };
  const section = (name, help) => { add(); sections.push(add(name)); if(help) add(help); };
  sections.push(add('Website title analysis'));
  add('Website', result.website || '');
  add('Analysis date', result.completedAt || 'Not recorded');
  add('Distinct titles analyzed', result.totalTitles ?? 0);
  add('Source articles', (result.sourceTitles || []).length);
  add('Result status', result.partial ? 'Partial - see analysis notes' : 'Complete');
  add('Scope', 'Article titles only. Counts mean distinct titles, not search volume.');
  for(const [type,name,help] of [
    ['Phrase','Recurring title patterns','Repeated title phrases. Matching articles are listed below each pattern.'],
    ['Long-tail','Long-tail keywords','Specific topic phrases in titles, not external SEO metrics.'],
    ['Keyword','Individual keywords','Recurring single words, separate from title patterns.']
  ]) {
    section(name,help);
    headers.push(add('Rank',type==='Keyword'?'Keyword':'Phrase / pattern','Titles containing it','Matching article title','Article URL'));
    const items=(result.rankedAnalysis || []).filter(r=>r.type===type);
    if(!items.length) add('No results in this section.');
    items.forEach((item,i)=>{
      add(i+1,item.term,item.count);
      if(type==='Phrase') for(const title of item.matchingTitles || []) {
        const source=(result.sourceTitles || []).find(s=>s.title===title);
        add('','','',title,source?.url || '');
      }
    });
  }
  section('Source articles','All analyzed source articles, including separate URLs with duplicate titles.');
  headers.push(add('Article #','','','Article title','Article URL'));
  if(!result.sourceTitles?.length) add('No article titles were collected.');
  (result.sourceTitles || []).forEach((s,i)=>add(i+1,'','',s.title,s.url));
  if(result.warnings?.length) {section('Analysis notes','Limits and unavailable pages may affect coverage.');result.warnings.forEach(w=>add(w));}
  if(rows.length>20000) throw new Error('Report exceeds 20,000 rows.');
  return {version:2,rows,sections,headers};
}
