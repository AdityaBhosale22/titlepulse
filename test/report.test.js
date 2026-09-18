import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ExcelJS from 'exceljs';
import {buildReport} from '../backend/report.js';
import {analyzeTitles} from '../backend/analyzer.js';
import {createAnalysisWorkbook} from '../backend/export.js';

const sourceTitles=[
 {title:'How to Create a Digital Signature',url:'https://example.com/a'},
 {title:'How to Create an Electronic Signature',url:'https://example.com/b'},
 {title:'=1+1',url:'https://example.com/formula?q=a&b=2'}
];
const result={website:'https://example.com',...analyzeTitles(sourceTitles.map(s=>s.title)),sourceTitles,partial:true,warnings:['Time limit reached.'],completedAt:'2026-09-18T12:00:00Z'};
test('readable report separates topics and retains source evidence and partial status',()=>{
 const report=buildReport(result);
 assert.ok(report.rows.every(r=>r.length===5));
 for(const name of ['Recurring title patterns','Long-tail keywords','Individual keywords','Source articles','Analysis notes']) assert.ok(report.rows.some(r=>r[0]===name));
 assert.ok(report.rows.some(r=>r[1]==='Partial - see analysis notes'));
 assert.ok(report.rows.filter(r=>r[3]===sourceTitles[0].title).length>=2);
 assert.ok(report.rows.some(r=>r[3]==='=1+1'));
});
test('Excel report includes safe text, hyperlinks, summary, and readable formatting',async()=>{
 const workbook=new ExcelJS.Workbook();
 await workbook.xlsx.load(await createAnalysisWorkbook(result));
 const sheet=workbook.getWorksheet('Website Report');
 assert.equal(sheet.getCell('B2').value,result.website);
 assert.equal(sheet.views[0].showGridLines,false);
 let formulaFound=false,links=0;
 sheet.eachRow(row=>{row.eachCell(cell=>{
   assert.notEqual(cell.type,ExcelJS.ValueType.Formula);
   if(cell.value==='=1+1')formulaFound=true;
   if(cell.type===ExcelJS.ValueType.Hyperlink)links++;
 });});
 assert.ok(formulaFound);assert.ok(links>=3);
 assert.ok(sheet.getColumn(4).width>=70);
});
const gas=await readFile(new URL('../apps-script/Code.gs',import.meta.url),'utf8');
test('Apps Script validates before writes, escapes formulas, and reuses hostname tabs',()=>{
 const context=vm.createContext({});
 vm.runInContext(gas,context);
 context.validateReport(buildReport(result));
 assert.throws(()=>context.validateReport({version:2,rows:[['bad']],sections:[],headers:[]}),/Invalid/);
 for(const value of ['=1+1',' +SUM(A1)','-1','@x'])assert.equal(context.safeText(value),"'"+value);
 assert.equal(context.safeText('Unicode Tokyo & more'),'Unicode Tokyo & more');
 const sheet={getDeveloperMetadata:()=>[{getKey:()=> 'TITLEPULSE_WEBSITE',getValue:()=> 'example.com'}]};
 assert.equal(context.findOrCreateWebsiteTab({getSheets:()=>[sheet]},'example.com'),sheet);
 assert.equal(context.websiteHost('https://www.example.com/blog'),'example.com');
});
test('Apps Script end-to-end adapter writes report and rejects unauthorized payloads',()=>{
 let writes=0,values,unlocked=false;
 const range=new Proxy({}, {get:(_,key)=>(...args)=>{if(key==='setValues'){writes++;values=args[0];}return range;}});
 const sheet={
 getDeveloperMetadata:()=>[{getKey:()=> 'TITLEPULSE_WEBSITE',getValue:()=> 'example.com'}],
 getLastRow:()=>100,getMaxRows:()=>1000,getMaxColumns:()=>5,getRange:()=>range,
 setHiddenGridlines(){},setFrozenRows(){},setColumnWidth(){},setRowHeights(){},autoResizeRows(){},
 getName:()=> 'example',getSheetId:()=>1
 };
 const book={getSheets:()=>[sheet],getUrl:()=> 'https://docs.google.com/spreadsheets/d/test/edit'};
 const context=vm.createContext({
 PropertiesService:{getScriptProperties:()=>({getProperty:()=> 'secret'})},
 LockService:{getScriptLock:()=>({tryLock:()=>true,hasLock:()=>true,releaseLock:()=>{unlocked=true;}})},
 ContentService:{MimeType:{JSON:'json'},createTextOutput:text=>({setMimeType:()=>JSON.parse(text)})},
 SpreadsheetApp:{openById:()=>book,flush(){},newRichTextValue:()=>{const b={setText:()=>b,setLinkUrl:()=>b,build:()=>({})};return b;}}
 });
 vm.runInContext(gas,context);
 const post=secret=>context.doPost({postData:{contents:JSON.stringify({secret,website:result.website,report:buildReport(result)})}});
 assert.equal(post('wrong').ok,false);assert.equal(writes,0);
 assert.equal(post('secret').ok,true);assert.equal(writes,1);assert.equal(unlocked,true);
 assert.equal(values.length,100);
 assert.ok(values.some(r=>r[3]==="'=1+1"));
 assert.deepEqual(Array.from(values.at(-1)),['','','','','']);
});
