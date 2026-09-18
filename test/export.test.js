import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { createAnalysisWorkbook } from '../backend/export.js';
import { analyzeTitles } from '../backend/analyzer.js';

test('exports all ranked results and all source titles into the two requested sheets', async () => {
  const sources = Array.from({ length: 15 }, (_, i) => ({ title: `Digital signature software for industry${String.fromCharCode(97 + i)}`, url: `https://example.com/blog/${i}` }));
  sources.push({ title: '=HYPERLINK("https://evil.example","click")', url: 'https://example.com/blog/formula-like-title' });
  const result = { ...analyzeTitles(sources.map(row => row.title)), sourceTitles: sources, website: 'https://example.com/', partial: true, warnings: ['Time limit reached.'], completedAt: '2026-09-18T12:00:00Z' };
  const buffer = await createAnalysisWorkbook(result);
  assert.equal(buffer.subarray(0, 2).toString(), 'PK');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), ['Website Report', 'Ranked Analysis', 'Source Titles']);
  const ranked = workbook.getWorksheet('Ranked Analysis');
  const sourceSheet = workbook.getWorksheet('Source Titles');
  assert.deepEqual(ranked.getRow(1).values.slice(1), ['Rank', 'Type', 'Phrase/Keyword', 'Number of Titles']);
  assert.deepEqual(sourceSheet.getRow(1).values.slice(1), ['Article Title', 'URL']);
  assert.equal(ranked.rowCount - 1, result.rankedAnalysis.length);
  assert.equal(sourceSheet.rowCount - 1, sources.length);
  assert.ok(ranked.rowCount > result.phrases.length + result.keywords.length + result.longTails.length);
  for (let index = 0; index < result.rankedAnalysis.length; index++) {
    const expected = result.rankedAnalysis[index];
    assert.deepEqual(ranked.getRow(index + 2).values.slice(1), [index + 1, expected.type, expected.term, expected.count]);
  }
  assert.equal(sourceSheet.getCell(`A${sources.length + 1}`).value, sources.at(-1).title);
  assert.equal(sourceSheet.getCell(`A${sources.length + 1}`).type, ExcelJS.ValueType.String);
  assert.equal(sourceSheet.getCell('B2').value, sources[0].url);
  assert.equal(ranked.views[0].state, 'frozen');
  assert.ok(ranked.autoFilter);
  assert.match(JSON.stringify(ranked.getCell('A1').note), /PARTIAL ANALYSIS/);
});

test('exports an empty completed crawl with valid header-only worksheets', async () => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await createAnalysisWorkbook({ website: 'https://example.com', totalTitles: 0, rankedAnalysis: [], sourceTitles: [], warnings: [] }));
  assert.equal(workbook.worksheets.length, 3);
  assert.ok(workbook.worksheets.slice(1).every(sheet => sheet.rowCount === 1));
  assert.ok(workbook.getWorksheet('Website Report').rowCount > 10);
});
