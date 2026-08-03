// nas-worker.js — Mix888 NAS bill renderer worker
// Polls Supabase for bills with image_url IS NULL, renders them with the in-browser
// pipeline (bill-render.html + window.renderBill) via headless Chromium (Playwright),
// uploads the long PNG + A4 JPEG pages to storage bucket 'bills' using the exact same
// filename patterns as the web back office, then patches the bills row.
//
// Env: SUPABASE_URL, SERVICE_KEY (service_role), POLL_MS (default 30000)
// Node >= 20 (built-in fetch + globalThis.crypto).

import { chromium } from 'playwright';

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY  = process.env.SERVICE_KEY || '';
const POLL_MS      = Math.max(5000, Number(process.env.POLL_MS) || 30000);
const RENDER_PAGE  = process.env.RENDER_PAGE || 'file:///app/bill-render.html';

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('[fatal] SUPABASE_URL and SERVICE_KEY must be set (see .env.example)');
  process.exit(1);
}

const REST_HEADERS = {
  apikey: SERVICE_KEY,
  Authorization: 'Bearer ' + SERVICE_KEY
};

// ---------------------------------------------------------------------------
// rndTag — verbatim port of work.html line 7005-7007 (same alphabet, same modulo)
// ---------------------------------------------------------------------------
function rndTag(n) {
  const c = 'abcdefghijklmnopqrstuvwxyz0123456789'; let o = '';
  const a = new Uint8Array(n || 10);
  (crypto && crypto.getRandomValues) ? crypto.getRandomValues(a) : a.forEach((_, i) => a[i] = Math.floor(Math.random() * 256));
  for (let i = 0; i < a.length; i++) o += c[a[i] % c.length];
  return o;
}

// ---------------------------------------------------------------------------
// Canonical data query — mirrors regenBillImages (work.html 5152-5158):
//   bills:  bill_no,order_id,shipping_fee,discount,total,revision,doc_type,seller_mode
//   orders: *, customers(<regen list>), order_items(qty,price,amount,product_id,
//           products(name,unit,sku,image_url))
// The customers column list below is byte-identical to the regen select (it has no
// sale_id — so billContact falls back to appSettings shop_* exactly like the browser
// regen path does).
// ---------------------------------------------------------------------------
const BILL_SELECT =
  'id,bill_no,order_id,customer_id,shipping_fee,discount,total,revision,doc_type,seller_mode,created_at,ship_status,' +
  'orders(*,' +
    'customers(id,code,name,line_group_id,branch_name,contact_name,phone,billing_address,tax_id,sale_name,map_link,receive_time,note,delivery_method,doc_type,bill_seller_mode,ship_shop_name,ship_receiver,ship_phone,ship_address),' +
    'order_items(qty,price,amount,product_id,products(name,unit,sku,image_url))' +
  ')';

async function restGet(table, params) {
  const u = new URL(SUPABASE_URL + '/rest/v1/' + table);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const r = await fetch(u, { headers: REST_HEADERS });
  if (!r.ok) throw new Error('GET ' + table + ' -> ' + r.status + ' ' + (await r.text()).slice(0, 300));
  return r.json();
}

async function restPatch(table, filter, body) {
  const u = new URL(SUPABASE_URL + '/rest/v1/' + table);
  for (const [k, v] of Object.entries(filter)) u.searchParams.set(k, v);
  const r = await fetch(u, {
    method: 'PATCH',
    headers: { ...REST_HEADERS, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error('PATCH ' + table + ' -> ' + r.status + ' ' + (await r.text()).slice(0, 300));
}

// Upload a Buffer to storage bucket 'bills'; returns the public URL
// (same URL shape the browser gets from getPublicUrl()).
async function uploadToBills(name, buf, contentType) {
  const r = await fetch(SUPABASE_URL + '/storage/v1/object/bills/' + name, {
    method: 'POST',
    headers: { ...REST_HEADERS, 'Content-Type': contentType, 'x-upsert': 'true' },
    body: buf
  });
  if (!r.ok) throw new Error('upload ' + name + ' -> ' + r.status + ' ' + (await r.text()).slice(0, 300));
  return SUPABASE_URL + '/storage/v1/object/public/bills/' + name;
}

function dataUrlToBuffer(d) {
  if (typeof d !== 'string' || !d.startsWith('data:')) throw new Error('renderBill returned a non-dataURL value');
  return Buffer.from(d.slice(d.indexOf(',') + 1), 'base64');
}

// ---------------------------------------------------------------------------
// Persistent headless browser — one browser, one page, render page loaded once.
// ---------------------------------------------------------------------------
let browser = null, page = null;

async function getPage() {
  if (page && !page.isClosed()) return page;
  if (browser) { try { await browser.close(); } catch {} browser = null; }
  console.log('[browser] launching chromium + loading ' + RENDER_PAGE);
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  page = await browser.newPage();
  page.on('crash', () => { console.error('[browser] page crashed'); page = null; });
  await page.goto(RENDER_PAGE, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => typeof window.renderBill === 'function', null, { timeout: 60000 });
  return page;
}

function resetPageOn(errMsg) {
  if (/crash|Target closed|browser has been closed|Navigation failed|Protocol error/i.test(String(errMsg))) page = null;
}

// ---------------------------------------------------------------------------
// Per-bill processing
// ---------------------------------------------------------------------------
async function processBill(b, support) {
  const t0 = Date.now();
  const o = b.orders;
  if (!o) throw new Error('order ' + b.order_id + ' not found (join returned null)');
  if (!o.customers) throw new Error('order has no customers row');
  if (!Array.isArray(o.order_items)) o.order_items = [];

  // extra — byte-mirrors regenBillImages 5160-5162
  const extra = {
    shipFee: Number(b.shipping_fee) || 0,
    discount: Number(b.discount) || 0,
    grand: Number(b.total),
    revision: b.revision || 1,
    docType: b.doc_type || 'บิลเงินสด',
    sellerMode: b.seller_mode || 'none'
  };

  const pg = await getPage();
  // window.renderBill(data) is provided by bill-render.html. Contract:
  //   data = { billNo, order, extra, products, sales, appSettings }
  //   returns Promise<{ long: 'data:image/png;base64,..'|null, pages: ['data:image/jpeg;base64,..', ...] }>
  // pages are the A4 slices (billToA4Pages, JPEG q=0.82); long is the full tall canvas
  // (null when PNG export fails, e.g. tainted canvas — treat as failure, keep queued).
  const out = await pg.evaluate(d => window.renderBill(d), {
    billNo: b.bill_no,
    order: o,
    extra,
    products: support.products,
    sales: support.sales,
    appSettings: support.appSettings
  });

  if (!out || typeof out.long !== 'string') throw new Error('renderBill returned no long image (null = tainted canvas?)');
  if (!Array.isArray(out.pages) || out.pages.length === 0) throw new Error('renderBill returned no A4 pages');

  // Filenames — identical patterns to the browser (makeBill 3668 / uploadA4Pages 3509)
  const longName = b.bill_no + '-' + rndTag(10) + '.png';
  const imageUrl = await uploadToBills(longName, dataUrlToBuffer(out.long), 'image/png');

  const pageUrls = [];
  for (let i = 0; i < out.pages.length; i++) {
    const name = b.bill_no + '-p' + (i + 1) + '-' + rndTag(8) + '.jpg';
    pageUrls.push(await uploadToBills(name, dataUrlToBuffer(out.pages[i]), 'image/jpeg'));
  }

  // page_urls is always a non-empty array here — never null.
  await restPatch('bills', { id: 'eq.' + b.id }, { image_url: imageUrl, page_urls: pageUrls });
  console.log('[bill] ' + b.bill_no + ' pages=' + pageUrls.length + ' ms=' + (Date.now() - t0));
}

// Support data the renderer's globals need (products[]/sales[]/appSettings —
// see loadProducts 1857, loadSales 2798, loadSettings 8114 in work.html).
async function fetchSupportData() {
  const [products, sales, settingsRows] = await Promise.all([
    restGet('products', { select: '*', order: 'sku' }),
    restGet('sales',    { select: '*', order: 'name' }),
    restGet('settings', { select: 'key,value' })
  ]);
  const appSettings = {};
  (settingsRows || []).forEach(r => { appSettings[r.key] = r.value; });
  return { products: products || [], sales: sales || [], appSettings };
}

// ---------------------------------------------------------------------------
// Poll loop — never crashes; failed bills stay queued (image_url stays NULL)
// so the edge-function fallback can still pick them up.
// ---------------------------------------------------------------------------
async function cycle() {
  let bills;
  try {
    bills = await restGet('bills', {
      select: BILL_SELECT,
      image_url: 'is.null',
      or: '(ship_status.is.null,ship_status.neq.cancelled)',
      order: 'created_at.desc',
      limit: '5'
    });
  } catch (e) {
    console.error('[poll] ' + (e.message || e));
    return;
  }
  if (!bills || !bills.length) return;
  console.log('[poll] ' + bills.length + ' bill(s) need drawing');

  let support;
  try {
    support = await fetchSupportData();
  } catch (e) {
    console.error('[support-data] ' + (e.message || e));
    return;
  }

  for (const b of bills) {
    try {
      await processBill(b, support);
    } catch (e) {
      const msg = e && e.message || String(e);
      console.error('[bill] ' + (b.bill_no || b.id) + ' FAILED: ' + msg + ' (left queued)');
      resetPageOn(msg);
    }
  }
}

let stopping = false;
async function main() {
  console.log('[start] Mix888 NAS renderer · poll every ' + POLL_MS + ' ms · ' + SUPABASE_URL);
  while (!stopping) {
    try { await cycle(); } catch (e) { console.error('[cycle] ' + (e.message || e)); }
    await new Promise(res => setTimeout(res, POLL_MS));
  }
}

async function shutdown(sig) {
  if (stopping) return;
  stopping = true;
  console.log('[stop] ' + sig + ' received, closing browser…');
  try { if (browser) await browser.close(); } catch {}
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

main().catch(e => { console.error('[fatal] ' + (e && e.stack || e)); process.exit(1); });
