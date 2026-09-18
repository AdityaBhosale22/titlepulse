import ExcelJS from 'exceljs';
import { buildReport } from './report.js';

export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const textCell = value => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, 32767);

export async function createAnalysisWorkbook(result) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'TitlePulse';
  workbook.title = `TitlePulse analysis: ${result.website}`;
  workbook.subject = result.partial ? 'Partial crawl results' : 'Title analysis';
  workbook.description = [result.website, `Titles analyzed: ${result.totalTitles}`, ...(result.warnings || [])].join('\n');

  const report = buildReport(result);
  const overview = workbook.addWorksheet('Website Report');
  overview.columns = [{width:24},{width:46},{width:22},{width:76},{width:65}];
  overview.views = [{state:'frozen', ySplit:7, showGridLines:false}];
  report.rows.forEach((values, index) => {
    const row = overview.addRow(values.map(value => typeof value === 'number' ? value : textCell(value)));
    row.font = {name:'Calibri',size:11,color:{argb:'FF172B4D'}};
    row.alignment = {vertical:'top',wrapText:true};
    row.height = Math.min(409, Math.max(28, ...values.map((value,col)=>Math.ceil(String(value).length/(overview.columns[col].width-3))*16+10)));
    if(report.sections.includes(index+1)) {
      overview.mergeCells(index+1,1,index+1,5);
      row.font = {name:'Calibri',size:13,bold:true,color:{argb:'FFFFFFFF'}};
      row.fill = {type:'pattern',pattern:'solid',fgColor:{argb:'FF0867C9'}};
      row.height=32;
    } else if(report.headers.includes(index+1)) {
      row.font = {name:'Calibri',size:11,bold:true};
      row.fill = {type:'pattern',pattern:'solid',fgColor:{argb:'FFEAF3FF'}};
      row.height=32;
    } else if(values[0] && values.slice(1).every(v=>v==='')) {
      overview.mergeCells(index+1,1,index+1,5);row.height=30;
    } else if(index>0 && index<7) {
      overview.mergeCells(index+1,2,index+1,5);row.height=34;
    } else if(index%2===0) row.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFF7FAFF'}};
    if(typeof values[4]==='string' && /^https?:\/\//i.test(values[4])) {
      try { const url = new URL(values[4]); if(!url.username&&!url.password) row.getCell(5).value={text:textCell(values[4]),hyperlink:url.href}; } catch {}
      row.getCell(5).font={name:'Calibri',size:11,color:{argb:'FF0867C9'},underline:true};
    }
  });

  const ranked = workbook.addWorksheet('Ranked Analysis');
  ranked.columns = [
    { header: 'Rank', key: 'rank', width: 10 },
    { header: 'Type', key: 'type', width: 16 },
    { header: 'Phrase/Keyword', key: 'term', width: 72 },
    { header: 'Number of Titles', key: 'count', width: 22 },
  ];
  for (const [index, row] of result.rankedAnalysis.entries()) ranked.addRow({ rank: index + 1, type: textCell(row.type), term: textCell(row.term), count: row.count });
  ranked.getColumn('rank').numFmt = '#,##0';
  ranked.getColumn('count').numFmt = '#,##0';
  const sources = workbook.addWorksheet('Source Titles');
  sources.columns = [{ header: 'Article Title', key: 'title', width: 80 }, { header: 'URL', key: 'url', width: 80 }];
  // Plain string cells, never formulas or active hyperlinks from scraped content.
  for (const source of result.sourceTitles) sources.addRow({ title: textCell(source.title), url: textCell(source.url) });
  for (const sheet of [ranked, sources]) {
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, sheet.rowCount), column: sheet.columnCount } };
    sheet.eachRow((row, index) => {
      row.font = { name: 'Calibri', size: 11, color: { argb: 'FF202B25' } };
      row.alignment = { vertical: 'top', wrapText: true };
      // Give long titles/URLs room without expanding every row to a fixed height.
      const lines = Math.max(...row.values.slice(1).map((value, col) => Math.ceil(String(value ?? '').length / (sheet.columns[col].width - 3))));
      row.height = Math.min(409, Math.max(22, lines * 16 + 6));
      if (index === 1) {
        row.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
        row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF266647' } };
        row.height = 28;
      } else if (index % 2 === 0) row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F5F1' } };
    });
    sheet.getCell('A1').note = [result.partial ? 'PARTIAL ANALYSIS' : 'ANALYSIS COMPLETE', `Website: ${result.website}`, `Titles analyzed: ${result.totalTitles}`, `Completed: ${result.completedAt || ''}`, ...(result.warnings || [])].join('\n');
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
