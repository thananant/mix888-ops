import {createRequire} from 'node:module';const require=createRequire(import.meta.url);const {chromium}=require('/opt/node22/lib/node_modules/playwright');
import fs from 'node:fs';
const SRC='file:///home/user/thananant/mix888/wnqz-6e9u-j4ym.html';
const OUT='/home/user/mix888-ops/docs/img';
fs.mkdirSync(OUT,{recursive:true});
const stub=fs.readFileSync('stub.js','utf8');
const mock=fs.readFileSync('mock.js','utf8');
const dash=fs.readFileSync('dash.js','utf8');
const chartjs=fs.readFileSync('node_modules/chart.js/dist/chart.umd.js','utf8');

const b=await chromium.launch({args:['--font-render-hinting=none']});
const ctx=await b.newContext({viewport:{width:1800,height:1010},deviceScaleFactor:2,
  locale:'th-TH',timezoneId:'Asia/Bangkok'});
await ctx.route('**/@supabase/supabase-js**',r=>r.abort());
await ctx.route('**/chart.js**',r=>r.fulfill({status:200,contentType:'application/javascript',body:chartjs}));
const page=await ctx.newPage();
page.on('pageerror',e=>console.log('PAGEERR:',String(e).slice(0,140)));
await page.addInitScript(stub);
await page.goto(SRC,{waitUntil:'load'});
await page.waitForTimeout(1500);

const shot=async(name,sel)=>{
  const p=`${OUT}/${name}.png`;
  if(sel){const el=await page.$(sel); if(!el){console.log('MISS',name,sel);return;} await el.screenshot({path:p});}
  else await page.screenshot({path:p});
  console.log('✓',name);
};

// 1) หน้า login
await shot('01-login');

// เข้าระบบด้วยผู้ใช้จำลอง + ยัดข้อมูลตัวอย่าง
await page.evaluate(mock);
await page.evaluate(()=>{
  window.enterApp({id:1,username:'somchai',display_name:'สมชาย ใจดี',role:'admin',active:true});
});
await page.waitForTimeout(1200);
await page.evaluate(mock);   // ยัดซ้ำหลัง startApp ล้างค่า
await page.evaluate(dash);
await page.evaluate(()=>{
  window.dashCoreReady=true;
  try{dashLocalCards();}catch(e){console.log('dash',e.message);}
  try{renderOrders();}catch(e){console.log('ord',e.message);}
  try{renderAccount();acStats();}catch(e){console.log('acc',e.message);}
  try{renderCustomers();}catch(e){console.log('cus',e.message);}
  try{renderProducts();}catch(e){console.log('pro',e.message);}
  try{renderSales();}catch(e){console.log('sal',e.message);}
});
await page.waitForTimeout(600);
await shot('02-dashboard');

// การ์ดลูกค้าใหม่ 3 มุมมอง
await page.evaluate(()=>openNewCustModal());
await page.waitForTimeout(900);
await shot('03-newcust-day','#newcust-modal > div');
await page.evaluate(()=>{const d=document.querySelectorAll('#ncm-body details');if(d[1])d[1].open=true;});
await page.waitForTimeout(300);
await shot('03b-newcust-day-open','#newcust-modal > div');
await page.evaluate(()=>ncmSetTab('who'));await page.waitForTimeout(300);
await shot('04-newcust-who','#newcust-modal > div');
await page.evaluate(()=>ncmSetTab('all'));await page.waitForTimeout(300);
await shot('05-newcust-all','#newcust-modal > div');
await page.evaluate(()=>{document.getElementById('newcust-modal').style.display='none';});

const RENDER={
  orders:'renderOrders()',
  account:'renderAccount();acStats()',
  customers:'renderCustomers()',
  products:'renderProducts()',
  sales:'renderSales()',
  users:'renderUsers()',
  warehouse:'renderWhList()'
};
const pages=[
  ['06-orders','orders'],['07-account','account'],['08-customers','customers'],
  ['09-products','products'],['10-pricing','pricing'],['11-receive','receive'],
  ['12-transfer','transfer'],['13-plan','plan'],['14-stockops','stockops'],
  ['15-expense','expense'],['16-quote','quote'],['17-bcast','bcast'],
  ['18-crm','crm'],['19-warehouse','warehouse'],['20-purchase','purchase'],
  ['21-users','users'],['22-sales','sales'],['23-custhist','custhist'],
  ['24-moves','moves'],['25-cost','cost'],['26-shipcalc','shipcalc'],
  ['27-suppliers','suppliers'],['28-custmap','custmap']
];
for(const [n,p] of pages){
  await page.evaluate(p=>{try{showPage(p);}catch(e){}},p);
  await page.waitForTimeout(700);
  await page.evaluate(mock);
  if(RENDER[p]) await page.evaluate(code=>{try{eval(code);}catch(e){console.log('R',e.message);}},RENDER[p]);
  await page.waitForTimeout(400);
  await page.evaluate(()=>window.scrollTo(0,0));
  await shot(n);
}
await b.close();
