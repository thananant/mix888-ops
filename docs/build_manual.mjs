/* สร้างคู่มือ PDF จาก manual.html — ทำ 2 รอบเพื่อเติมเลขหน้าในสารบัญให้ตรงจริง */
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const {chromium} = require('/opt/node22/lib/node_modules/playwright');
import fs from 'node:fs';
import path from 'node:path';

const DIR = '/home/user/mix888-ops/docs';
const SRC = DIR + '/manual.html';
const OUT = DIR + '/คู่มือการใช้งาน-Mix888.pdf';
const TMP = '/tmp/claude-0/-home-user-mix888-ops/670e7377-7f8f-5b55-96d5-7f072f790f6d/scratchpad';

let html = fs.readFileSync(SRC, 'utf8').replace('LOGO_SRC', 'img/logo.png');

/* ---------- เก็บหัวข้อทั้งหมดตามลำดับที่ปรากฏ ---------- */
const heads = [];
html = html.replace(/<h1 class="ch"(?: id="([^"]*)")?>\s*<span class="num">([^<]*)<\/span>([\s\S]*?)<\/h1>/g,
  (m, id, num, title) => {
    const key = 'K' + String(heads.length).padStart(2,'0');
    const clean = title.replace(/<[^>]+>/g,'').trim();
    heads.push({ lvl:1, id, num:num.trim(), title:clean, key });
    return m.replace('</h1>', `<span class="mk">§${key}§</span></h1>`);
  });
html = html.replace(/<h2 id="([^"]*)">([^<]*)<\/h2>/g, (m, id, title) => {
  const key = 'K' + String(heads.length).padStart(2,'0');
  heads.push({ lvl:2, id, title:title.trim(), key });
  return m.replace('</h2>', `<span class="mk">§${key}§</span></h2>`);
});

/* หัวข้อ h2 ถูกจับหลัง h1 จึงต้องเรียงใหม่ตามตำแหน่งจริงในเอกสาร */
heads.forEach(h => { h.pos = html.indexOf(`§${h.key}§`); });
heads.sort((a,b) => a.pos - b.pos);

html = html.replace('</style>', '.mk{font-size:2px;color:#FFFFFF}\n</style>');

function tocHtml(pages){
  return '<div>' + heads.map(h => {
    const pg = pages ? (pages[h.key] || '') : '';
    const label = h.lvl===1 ? `${h.num} · ${h.title}` : h.title;
    return `<div class="${h.lvl===1?'t1':'t2'}"><a href="#${h.id}" style="color:inherit;text-decoration:none">${label}</a>`
      + `<span class="dots"></span><span class="pg">${pg}</span></div>`;
  }).join('') + '</div>';
}

async function render(pages, outFile){
  const b = await chromium.launch();
  const ctx = await b.newContext();
  const page = await ctx.newPage();
  const file = TMP + '/manual-render.html';
  fs.writeFileSync(file, html.replace('TOC_HERE', tocHtml(pages)));
  fs.copyFileSync(file, DIR + '/.manual-render.html');   // ให้ path รูปสัมพัทธ์ทำงาน
  await page.goto('file://' + DIR + '/.manual-render.html', {waitUntil:'load'});
  await page.waitForTimeout(2500);                        // รอฟอนต์ไทยและรูปโหลดครบ
  await page.emulateMedia({media:'print'});
  await page.pdf({
    path: outFile, format:'A4', printBackground:true,
    margin:{top:'20mm', bottom:'18mm', left:'17mm', right:'17mm'},
    displayHeaderFooter:true,
    headerTemplate:'<div></div>',
    footerTemplate:`<div style="width:100%;font-family:sans-serif;font-size:7.5pt;color:#9C8683;
      padding:0 17mm;display:flex;justify-content:space-between;">
      <span>คู่มือการใช้งานระบบสั่งสินค้า Mix Fresh 168 · build 25/08-A</span>
      <span class="pageNumber"></span></div>`
  });
  await b.close();
  fs.unlinkSync(DIR + '/.manual-render.html');
}

/* ---------- รอบที่ 1: ยังไม่มีเลขหน้า ---------- */
await render(null, TMP + '/pass1.pdf');

/* ---------- อ่านว่าหัวข้อไหนอยู่หน้าไหน ---------- */
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
const doc = await pdfjs.getDocument({data:new Uint8Array(fs.readFileSync(TMP+'/pass1.pdf')),
  useSystemFonts:true}).promise;
const pageText = [];
for(let i=1;i<=doc.numPages;i++){
  const p = await doc.getPage(i);
  const tc = await p.getTextContent();
  pageText.push(tc.items.map(x=>x.str).join(''));
}
const pages = {};
for(const h of heads){
  const idx = pageText.findIndex(t => t.includes('§'+h.key+'§'));
  pages[h.key] = idx>=0 ? idx+1 : '';
}
const missing = heads.filter(h=>!pages[h.key]);
console.log('จำนวนหน้า:', doc.numPages, '· หัวข้อทั้งหมด:', heads.length,
  '· หาเลขหน้าไม่เจอ:', missing.length);
if(missing.length) console.log('  ->', missing.map(m=>m.title).join(' | '));

/* ---------- รอบที่ 2: ใส่เลขหน้าจริงลงสารบัญ ---------- */
await render(pages, OUT);
console.log('เขียนไฟล์แล้ว:', OUT);
