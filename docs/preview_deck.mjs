/* เรนเดอร์พรีวิวสไลด์เป็นรูป เพื่อตรวจ layout/ข้อความล้นกรอบ (QA เท่านั้น ไม่ใช่ไฟล์ส่งมอบ) */
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const {chromium} = require('/opt/node22/lib/node_modules/playwright');
import fs from 'node:fs';

const DIR = '/home/user/mix888-ops/docs';
const OUT = '/tmp/claude-0/-home-user-mix888-ops/670e7377-7f8f-5b55-96d5-7f072f790f6d/scratchpad/preview';
fs.mkdirSync(OUT, {recursive:true});
const REC = JSON.parse(fs.readFileSync(DIR + '/deck-manifest.json', 'utf8'));
const PX = 96, W = 13.333*PX, H = 7.5*PX;
const esc = s => String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

function shapeHtml(kind, o){
  const st = [`left:${o.x*PX}px`,`top:${o.y*PX}px`,`width:${o.w*PX}px`,`height:${o.h*PX}px`,
    `background:#${(o.fill&&o.fill.color)||'CCCCCC'}`];
  if(o.line && o.line.color) st.push(`border:${(o.line.width||1)}px solid #${o.line.color}`,'box-sizing:border-box');
  if(kind==='ellipse') st.push('border-radius:50%');
  else if(kind==='roundRect') st.push(`border-radius:${(o.rectRadius||0.1)*PX}px`);
  else if(kind==='rightArrow') st.push('clip-path:polygon(0 30%,60% 30%,60% 0,100% 50%,60% 100%,60% 70%,0 70%)');
  else if(kind==='upArrow') st.push('clip-path:polygon(30% 100%,30% 40%,0 40%,50% 0,100% 40%,70% 40%,70% 100%)');
  if(o.shadow) st.push('box-shadow:0 2px 8px rgba(0,0,0,.10)');
  return `<div class="sh" style="${st.join(';')}"></div>`;
}

function textHtml(payload, o, idx){
  const size = (o.fontSize||18)*(96/72);
  const lh = o.lineSpacingMultiple || 1.22;
  const st = [`left:${o.x*PX}px`,`top:${o.y*PX}px`,`width:${o.w*PX}px`,`height:${o.h*PX}px`,
    `font-size:${size}px`, `color:#${o.color||'000000'}`,
    `font-family:'${o.fontFace||'Sarabun'}',sans-serif`,
    `line-height:${lh}`, `text-align:${o.align||'left'}`,
    o.bold?'font-weight:700':'font-weight:400', o.italic?'font-style:italic':'',
    o.charSpacing?`letter-spacing:${o.charSpacing}px`:''];
  if(o.valign==='middle') st.push('display:flex','flex-direction:column','justify-content:center');
  let inner;
  if(Array.isArray(payload)){
    inner = payload.map(p=>`<div class="li" style="margin-bottom:${(o.paraSpaceAfter||0)*(96/72)}px">`
      +`<span class="bu">▪</span><span>${esc(p.text)}</span></div>`).join('');
  } else inner = esc(payload).replace(/\n/g,'<br>');
  return `<div class="tx" data-i="${idx}" style="${st.join(';')}">${inner}</div>`;
}

function slideHtml(r){
  const parts = [];
  for(const it of r.items){
    if(it.t==='addShape') parts.push(shapeHtml(it.a[0], it.a[1]));
    else if(it.t==='addText') parts.push(textHtml(it.a[0], it.a[1], parts.length));
    else if(it.t==='addImage'){
      const o = it.a[0];
      const b64 = fs.readFileSync(o.path).toString('base64');
      parts.push(`<img class="sh" style="left:${o.x*PX}px;top:${o.y*PX}px;width:${o.w*PX}px;height:${o.h*PX}px;${o.rounding?'border-radius:50%':''}" src="data:image/png;base64,${b64}">`);
    }
  }
  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Sarabun:ital,wght@0,400;0,700;1,400&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:content-box}
body{width:${W}px;height:${H}px;position:relative;overflow:hidden;background:#${r.bg}}
.sh{position:absolute}
.tx{position:absolute;overflow:visible;white-space:pre-wrap;word-wrap:break-word}
.li{display:flex;gap:8px;align-items:flex-start;text-align:left}
.bu{flex:none;font-size:.62em;line-height:2}
img.sh{object-fit:fill}
</style></head><body>${parts.join('')}</body></html>`;
}

const b = await chromium.launch();
const ctx = await b.newContext({viewport:{width:Math.round(W),height:Math.round(H)}, deviceScaleFactor:1.35});
const page = await ctx.newPage();
const report = [];
for(let i=0;i<REC.length;i++){
  const f = OUT + `/s${String(i+1).padStart(2,'0')}.html`;
  fs.writeFileSync(f, slideHtml(REC[i]));
  await page.goto('file://'+f, {waitUntil:'load'});
  await page.waitForTimeout(500);
  const over = await page.evaluate(()=>{
    const out=[];
    document.querySelectorAll('.tx').forEach(el=>{
      const ov = el.scrollHeight - el.clientHeight;
      const r = el.getBoundingClientRect();
      const wide = el.scrollWidth - el.clientWidth;
      if(ov>3||wide>3||r.right>document.body.clientWidth+1||r.bottom>document.body.clientHeight+1)
        out.push({txt:(el.textContent||'').slice(0,42), ovY:ov, ovX:wide,
          right:Math.round(r.right), bottom:Math.round(r.bottom)});
    });
    return out;
  });
  if(over.length) report.push({slide:i+1, over});
  await page.screenshot({path: OUT + `/slide-${String(i+1).padStart(2,'0')}.png`});
  process.stdout.write('.');
}
console.log('\n--- ตรวจข้อความล้นกรอบ ---');
console.log(report.length ? JSON.stringify(report,null,1) : 'ไม่พบข้อความล้นกรอบ');
await b.close();
