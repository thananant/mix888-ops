import {createRequire} from 'node:module';const require=createRequire(import.meta.url);
const {chromium}=require('/opt/node22/lib/node_modules/playwright');
import fs from 'node:fs';
const SRC='file:///home/user/thananant/mix888/index.html?t=demo';
const OUT='/home/user/mix888-ops/docs/img';
const stub=fs.readFileSync('stub.js','utf8');
const b=await chromium.launch();
const ctx=await b.newContext({viewport:{width:430,height:900},deviceScaleFactor:3,
  locale:'th-TH',timezoneId:'Asia/Bangkok',isMobile:true,hasTouch:true});
await ctx.route('**/@supabase/supabase-js**',r=>r.abort());
const page=await ctx.newPage();
page.on('pageerror',e=>console.log('ERR:',String(e).slice(0,120)));
await page.addInitScript(stub);
await page.goto(SRC,{waitUntil:'load'});
await page.waitForTimeout(1200);

const M=`(function(){
  customer={id:100,code:'SMC00021',name:'ร้านหม่าล่าเจ๊หมวย',hide_prices:false};
  const P=[
    ['MLA0001','เส้นหม่าล่าเบอร์ 1 (ลัง)','ลัง',780,142,24],
    ['HTP0001','น้ำซุปหม่าล่าเข้มข้น 2.5 กก.','ถุง',245,320,80],
    ['VEG0001','เห็ดเข็มทอง 200 ก. (ลัง 40)','ลัง',560,61,20],
    ['MEA0001','ลูกชิ้นปลาเส้นใหญ่ 1 กก.','แพ็ค',158,3,40],
    ['SAU0001','ซอสงาดำหม้อไฟ 1 ลิตร','ขวด',119,254,60],
    ['MEA0002','เบคอนม้วนหม้อไฟ 500 ก.','แพ็ค',189,0,40]
  ];
  items=P.map((p,i)=>({product_id:200+i,sku:p[0],name:p[1],unit:p[2],price:p[3],
    stock_qty:p[4],safety_stock:p[5],image_url:null}));
  promos={201:{promo_price:219,normal:245,ends_at:'2026-08-31T23:59:00+07:00'}};
  items[1].price=219;
  cart={200:4,201:10};
  document.getElementById('errpage').style.display='none';
  document.getElementById('shop').style.display='';
  document.getElementById('cust-name').textContent='SMC00021 · ร้านหม่าล่าเจ๊หมวย';
  render();updateCartBar();
})()`;
await page.evaluate(M);
await page.waitForTimeout(400);
await page.screenshot({path:OUT+'/30-shop-catalog.png'});
console.log('✓ catalog');
await page.evaluate(()=>openConfirm());
await page.waitForTimeout(400);
await page.screenshot({path:OUT+'/31-shop-confirm.png'});
console.log('✓ confirm');
await page.evaluate(()=>{closeConfirm();document.getElementById('pin-overlay').style.display='flex';
  document.getElementById('pin-input').value='123456';});
await page.waitForTimeout(300);
await page.screenshot({path:OUT+'/32-shop-pin.png'});
console.log('✓ pin');
await page.evaluate(()=>{document.getElementById('pin-overlay').style.display='none';
  document.getElementById('s-no').textContent='SO-260826-007';
  document.getElementById('s-total').textContent='฿5,310.00';
  document.getElementById('success').classList.add('show');
  document.getElementById('success').style.display='flex';});
await page.waitForTimeout(300);
await page.screenshot({path:OUT+'/33-shop-success.png'});
console.log('✓ success');
await b.close();
