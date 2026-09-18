const SPREADSHEET_ID = '1ZbQ1BrGaJDhKXXaj8D2kwt8PgVlyrPvw2dOrD-5Wtds';
const WEBSITE_KEY = 'TITLEPULSE_WEBSITE';

function authorizeSetup() {
  console.log('Connected to: ' + SpreadsheetApp.openById(SPREADSHEET_ID).getName());
}
function jsonResponse(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}
function doGet() { return jsonResponse({ok:true,service:'TitlePulse Sheet Sync',version:2}); }

function validateReport(report) {
  if (!report || report.version !== 2 || !Array.isArray(report.rows) ||
      !report.rows.length || report.rows.length > 20000) throw new Error('Invalid report. Update the TitlePulse backend.');
  for (const row of report.rows) {
    if (!Array.isArray(row) || row.length !== 5 || row.some(value =>
      (typeof value !== 'string' && typeof value !== 'number') ||
      (typeof value === 'number' && !Number.isFinite(value)) ||
      (typeof value === 'string' && value.length > 32767))) throw new Error('Invalid report row.');
  }
  for (const key of ['sections','headers']) {
    if (!Array.isArray(report[key]) || report[key].length > 30 ||
        report[key].some(row => !Number.isInteger(row) || row < 1 || row > report.rows.length)) throw new Error('Invalid report formatting.');
  }
  return report;
}
function safeText(value) {
  if (typeof value === 'number') return value;
  const text=String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,'');
  return /^[\s]*[=+\-@]/.test(text) ? "'" + text : text;
}
function websiteHost(value) {
  const match=/^https?:\/\/([^/?#]+)(?:[/?#]|$)/i.exec(String(value || '').trim());
  if(!match) throw new Error('Invalid website URL.');
  const host=match[1].toLowerCase().replace(/:\d+$/,'').replace(/\.$/,'').replace(/^www\./,'');
  if(host.length>253 || !host.includes('.') || !host.split('.').every(part=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))) throw new Error('Invalid website hostname.');
  return host;
}
function findOrCreateWebsiteTab(book,host) {
  const existing=book.getSheets().find(sheet=>sheet.getDeveloperMetadata().some(m=>m.getKey()===WEBSITE_KEY&&m.getValue()===host));
  if(existing) return existing;
  const base=host.split('.')[0].slice(0,70);
  let name=base, suffix=2;
  while(book.getSheetByName(name)) name=base+'-'+suffix++;
  const sheet=book.insertSheet(name);sheet.addDeveloperMetadata(WEBSITE_KEY,host);return sheet;
}
function doPost(e) {
  let lock;
  try {
    const raw=e && e.postData && e.postData.contents;
    if(!raw || raw.length>2000000) throw new Error('Missing or oversized request.');
    const data=JSON.parse(raw);
    const secret=PropertiesService.getScriptProperties().getProperty('TITLEPULSE_SECRET');
    if(!secret || data.secret!==secret) throw new Error('Unauthorized request.');
    const host=websiteHost(data.website);
    const report=validateReport(data.report);
    const values=report.rows.map(row=>row.map(safeText));
    lock=LockService.getScriptLock();
    if(!lock.tryLock(15000)) throw new Error('Another save is running. Retry shortly.');
    const book=SpreadsheetApp.openById(SPREADSHEET_ID);
    const sheet=findOrCreateWebsiteTab(book,host);
    const height=Math.max(values.length,sheet.getLastRow());
    while(values.length<height) values.push(['','','','','']);
    if(sheet.getMaxRows()<height) sheet.insertRowsAfter(sheet.getMaxRows(),height-sheet.getMaxRows());
    if(sheet.getMaxColumns()<5) sheet.insertColumnsAfter(sheet.getMaxColumns(),5-sheet.getMaxColumns());
    const range=sheet.getRange(1,1,height,5);
    range.breakApart();
    range.setValues(values);
    range.clearFormat().setFontFamily('Arial').setFontSize(11).setFontColor('#172b4d')
      .setBackground('#ffffff').setVerticalAlignment('top').setWrap(true);
    sheet.setHiddenGridlines(true);
    sheet.setFrozenRows(7);
    [180,330,150,520,440].forEach((width,i)=>sheet.setColumnWidth(i+1,width));
    sheet.setRowHeights(1,height,30);
    for(let i=0;i<report.rows.length;i++) {
      const row=report.rows[i];
      if(report.sections.includes(i+1)) {
        sheet.getRange(i+1,1,1,5).merge().setBackground('#0867c9').setFontColor('#ffffff').setFontWeight('bold').setFontSize(13);
      } else if(report.headers.includes(i+1)) {
        sheet.getRange(i+1,1,1,5).setBackground('#eaf3ff').setFontWeight('bold');
      } else if(row[0] && row.slice(1).every(v=>v==='')) {
        sheet.getRange(i+1,1,1,5).merge();
      } else if(i>0&&i<7) {
        sheet.getRange(i+1,2,1,4).merge();
      }
    }
    // Rich text hyperlinks are not formulas. All other scraped values stay text.
    const links=report.rows.map(row=>{
      const text=String(row[4] || '');
      const builder=SpreadsheetApp.newRichTextValue().setText(text);
      if(/^https?:\/\/[^\s]+$/i.test(text)) builder.setLinkUrl(text);
      return [builder.build()];
    });
    // Set links only on unmerged data/header rows, in contiguous batches.
    let start=0;
    while(start<links.length) {
      while(start<links.length && (report.sections.includes(start+1) || (start>0&&start<7) || (report.rows[start][0]&&report.rows[start].slice(1).every(v=>v==='')))) start++;
      let end=start;
      while(end<links.length && !report.sections.includes(end+1) && !(end>0&&end<7) && !(report.rows[end][0]&&report.rows[end].slice(1).every(v=>v===''))) end++;
      if(end>start) sheet.getRange(start+1,5,end-start,1).setRichTextValues(links.slice(start,end));
      start=end;
    }
    sheet.autoResizeRows(1,report.rows.length);
    SpreadsheetApp.flush();
    return jsonResponse({ok:true,tab:sheet.getName(),url:book.getUrl()+'#gid='+sheet.getSheetId()});
  } catch(error) {
    return jsonResponse({ok:false,error:error.message || 'Unable to save report.'});
  } finally { if(lock&&lock.hasLock()) lock.releaseLock(); }
}
