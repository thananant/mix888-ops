// ⚠️ ต้อง import แบบคงที่ตรงนี้เท่านั้น ห้ามใช้ await import() ข้างล่าง
// Supabase รวมไลบรารีตอน deploy ถ้าเขียนแบบไดนามิกมันจะมองไม่เห็น
// แล้วขึ้น "Module not found" ตอนรันจริง (เจอมาแล้วใน cron-20)
import { initWasm, Resvg } from 'https://esm.sh/@resvg/resvg-wasm@2.6.2';
import { PDFDocument, StandardFonts, rgb } from 'https://esm.sh/pdf-lib@1.17.1';
import { encode as jpegEncode } from 'https://esm.sh/jpeg-js@0.4.4';

// daily-summary — ส่งสรุปออเดอร์เข้าไลน์กลางอัตโนมัติเมื่อถึงเวลาตัดรอบ
// ตั้ง cron ให้เรียกทุก 15 นาที ตัวฟังก์ชันจะตัดสินใจเองว่าถึงเวลาส่งหรือยัง (และไม่ส่งซ้ำ)
// cron-41: หน้าบิลเซิร์ฟเวอร์เปลี่ยนจาก PNG → JPEG (jpeg-js) เพราะ buildBillsPdf ฝังได้เฉพาะ
// JPEG — หน้า PNG ถูกข้ามหมดทำให้ pdf=null มาตลอด (พิสูจน์จาก preview 01/08 ค่ำ: ข้ามรูปPNG 6 หน้า)
// cron-42: เพิ่ม nas_mode — เมื่อ settings.nas_mode='1' การวาดรูปพื้นหลังใน autobill จะเลือกเฉพาะ
// บิลที่เก่ากว่า 10 นาที เปิดทางให้ตัวทำงานบน NAS (เทมเพลต 2 · ไม่มีเพดานซีพียู) จับวาดก่อน
// — edge ยังเป็นตัวเก็บตกใบที่ NAS วาดไม่ทันเหมือนเดิม
// cron-43: เพิ่มโหมดยาม (?watchdog=1) — ตั้ง pg_cron เรียกทุก 15 นาทีแทนยิงวันละครั้ง:
// ในช่วง 1 ชม.แรกหลังเวลาตัดรอบ ถ้ารอบส่งแล้ว=เงียบ ถ้ารอบพลาด (CPU ตายแบบเช้า 01/08)=ส่งแทน
// ภายใน ≤15 นาที · นอกช่วงนั้นไม่ทำอะไรเลย · เปลี่ยน summary_cutoff ใน settings ได้ ยามตามเอง
// cron-44: กันส่งซ้ำแบบ "จองก่อนส่ง" — ปิดรูรั่วรอบตายหลังพุชบางส่วน/สองนัดชนกัน/เปลี่ยน
// เวลาตัดรอบกลางวัน (ต้องรัน claim_dedup.sql สร้าง unique index "หลัง" deploy ไฟล์นี้)
// cron-45: อุดตามรีวิวรอบสอง — (1) overlap guard เผื่อ 90 นาที (30 นาทีทำรอบวันถัดไปโดนข้าม
// เงียบถ้ายามเคยกู้รอบช้า) (2) รอบว่างบิลต้องลบใบจองทิ้ง (3) เกณฑ์ใบจองค้าง 12 นาที
// (4) นัดเปล่านอกชั่วโมงแรกหลังตัดรอบถูกปัดตก กันรอบเศษไปจอง range_start ของวันถัดไป
// cron-46: ใบโอน/ใบเรียกของ — ชื่อสินค้ายาวแบ่ง 2 บรรทัด เลิกตัด "…" (ทีมแพ็คหยิบของยาก 03/08)
export const VERSION = 'cron-46';

const TZ = 7 * 3600000; // Asia/Bangkok ไม่มี DST
const LIMIT = 4500;     // LINE จำกัด 5,000 ตัวอักษร/ข้อความ

export type Cust = {
  code?: string; name?: string; sale_name?: string | null; contact_name?: string | null;
  phone?: string | null; billing_address?: string | null; map_link?: string | null;
  receive_time?: string | null; note?: string | null; delivery_method?: string | null;
  ship_receiver?: string | null; ship_phone?: string | null; ship_address?: string | null;
};
export type Bill = { bill_no?: string; ship_status?: string | null };
export type Order = {
  order_no?: string; created_at?: string; total?: number;
  customers?: Cust | null; order_items?: { qty: number; products?: { name?: string; unit?: string } | null }[];
  bills?: Bill[] | null;
};

/** ขอบรอบตัดล่าสุดที่ผ่านมาแล้ว (คืนเป็น epoch UTC) */
export function lastBoundary(nowMs: number, cutoff: string): number {
  const [hh, mm] = String(cutoff || '00:00').split(':').map((n) => parseInt(n, 10) || 0);
  const shifted = nowMs + TZ;
  const d = new Date(shifted);
  const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  let b = dayStart + hh * 3600000 + mm * 60000;
  if (shifted < b) b -= 86400000;
  return b - TZ;
}

/** ตัดออเดอร์ที่ส่งแล้ว/บิลยกเลิกออก — ตรรกะเดียวกับปุ่มในหลังบ้าน */
export function pendingOnly(rows: Order[]): Order[] {
  return (rows || []).filter((o) => {
    const bs = (o.bills || []).filter((b) => b.ship_status !== 'cancelled');
    if ((o.bills || []).length && !bs.length) return false;
    if (bs.some((b) => b.ship_status === 'shipped')) return false;
    return true;
  });
}

export function buildBlocks(rows: Order[], dateStr: string): { head: string; items: string[] }[] {
  const groups: Record<string, Order[]> = {};
  rows.forEach((o) => {
    const m = o.customers?.delivery_method || 'อื่นๆ';
    (groups[m] ??= []).push(o);
  });
  return Object.entries(groups).map(([method, list]) => ({
    head: '━━━━━━━━━━━━━━\n📦 ออเดอร์ ' + method + ' ' + dateStr + '\n━━━━━━━━━━━━━━',
    items: list.map((o, i) => {
      const c = o.customers || {};
      let t = '(' + (i + 1) + ')';
      const bill = (o.bills || []).find((b) => b.ship_status !== 'cancelled');
      if (bill?.bill_no) t += '\nเลขที่บิล : ' + bill.bill_no;
      if (c.sale_name) t += '\nSale : ' + c.sale_name;
      t += '\nผู้รับ : ' + (c.ship_receiver || c.contact_name || c.name || '-');
      const ph = c.ship_phone || c.phone;
      if (ph) t += '\nเบอร์ติดต่อ : ' + ph;
      if (c.map_link) t += '\nGoogle map : ' + c.map_link;
      const addr = c.ship_address || c.billing_address;
      if (addr) t += '\nที่อยู่ : ' + addr;
      if (c.receive_time) t += '\nเวลารับของ : ' + c.receive_time;
      t += '\nรายการ :';
      (o.order_items || []).forEach((it) => {
        t += '\n' + (it.products?.name || '?') + ' ' + Number(it.qty) + ' ' + (it.products?.unit || '');
      });
      if (c.note) t += '\nหมายเหตุ : ' + c.note;
      return t;
    }),
  }));
}

/** หั่นระดับรายออเดอร์ ไม่ให้เกินลิมิตของ LINE */
export function chunks(blocks: { head: string; items: string[] }[], lim = LIMIT): string[] {
  const msgs: string[] = [];
  for (const b of blocks) {
    let cur = b.head;
    for (let it of b.items) {
      if (it.length > lim - 100) it = it.slice(0, lim - 120) + '\n…(ยาวเกิน ตัดท้าย)';
      if ((cur + '\n\n' + it).length > lim) { msgs.push(cur); cur = b.head + ' (ต่อ)'; }
      cur += '\n\n' + it;
    }
    msgs.push(cur);
  }
  return msgs;
}

// ---------------- ส่วนที่คุยกับภายนอก ----------------
const URL_ = Deno.env.get('SUPABASE_URL')!;
const KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const LINE_TOKEN = Deno.env.get('LINE_TOKEN')!;
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };

async function rest(path: string, init?: RequestInit) {
  const r = await fetch(URL_ + '/rest/v1/' + path, { ...init, headers: { ...H, ...(init?.headers || {}) } });
  const body = await r.text();
  if (!r.ok) throw new Error(path.split('?')[0] + ': ' + body.slice(0, 200));
  if (!body) return null;              // 201/204 ไม่มีเนื้อหา (เช่น insert แบบ return=minimal)
  try { return JSON.parse(body); } catch { return null; }
}

async function pushLine(to: string, texts: string[]) {
  for (let i = 0; i < texts.length; i += 5) {
    const r = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + LINE_TOKEN },
      body: JSON.stringify({ to, messages: texts.slice(i, i + 5).map((text) => ({ type: 'text', text })) }),
    });
    if (!r.ok) throw new Error('LINE ' + r.status + ': ' + (await r.text()).slice(0, 200));
    if (i + 5 < texts.length) await new Promise((s) => setTimeout(s, 400));
  }
}

async function pushMsgs(to: string, messages: any[]) {
  for (let i = 0; i < messages.length; i += 5) {
    const r = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + LINE_TOKEN },
      body: JSON.stringify({ to, messages: messages.slice(i, i + 5) }),
    });
    if (!r.ok) throw new Error('LINE ' + r.status + ': ' + (await r.text()).slice(0, 200));
    if (i + 5 < messages.length) await new Promise((s) => setTimeout(s, 450));
  }
}
export function shortMethod(m?: string | null): string {
  const v = String(m || 'อื่นๆ');
  if (/lalamove/i.test(v)) return 'Lala';
  if (/^bi$/i.test(v)) return 'BI';
  return v.length > 8 ? v.slice(0, 8) : v;
}

/** [รูป 4] คำนวณเรียกของ กัลปพฤกษ์ → วังหิน ตามกฎ Safety/Max/จอง/ปลีก */
/** ปัดจำนวนขึ้นให้ลงท้ายด้วย 5 หรือ 0 (4→5, 9→10, 92→95, 198→200) */
export function roundUp5(n: number): number {
  return n <= 0 ? 0 : Math.ceil(n / 5) * 5;
}

export function calcTransfer(products: any[], stockRows: any[], whFrom: number, whTo: number,
  inTransit: Record<number, number> = {}) {
  const byWh: Record<string, Record<number, number>> = {};
  stockRows.forEach((r: any) => {
    (byWh[r.product_id] = byWh[r.product_id] || {})[Number(r.warehouse_id)] = Number(r.qty) || 0;
  });
  const pull: any[] = []; const buy: any[] = [];
  products.forEach((p: any) => {
    if (p.active === false) return;
    const st = byWh[p.id] || {};
    const from = st[whFrom] || 0;
    // นับของที่อยู่ในใบโอนค้างส่งด้วย ไม่งั้นพรุ่งนี้จะเรียกซ้ำของเดิม
    const to = (st[whTo] || 0) + (inTransit[p.id] || 0);
    const reserved = Number(p.reserved_qty) || 0;
    if (/S$/.test(String(p.sku || ''))) return;   // สินค้าปลีก ไม่ต้องเรียกโอน
    const avail = to - reserved;
    const safety = Number(p.safety_stock) || 0;
    if (avail >= safety) return;        // ยังไม่ต่ำกว่า Safety = ยังไม่ต้องเรียก
    const maxS = Number(p.max_stock) || 0;
    const target = maxS > 0 ? maxS : safety;
    const need = roundUp5(target - avail);        // ปัดขึ้นเป็นลงท้าย 5 หรือ 0
    if (need <= 0) return;
    if (from > 0) pull.push({ p, qty: Math.min(need, from), from, to });   // เก็บสต๊อกไว้โชว์ในใบเรียกของด้วย
    else if (p.thai_orderable) buy.push({ p, qty: need });   // ของหมด + สั่งไทยได้ → แจ้งสั่งซื้อ
    // ของหมด + สั่งไทยไม่ได้ = ไม่มีส่ง ข้ามเงียบ ๆ
  });
  return { pull, buy };
}

/** วันที่ (YYYY-MM-DD) ตามเวลาไทยของ epoch ที่ให้ */
export function thaiDate(ms: number): string {
  return new Date(ms + 7 * 3600000).toISOString().slice(0, 10);
}

/** วันปิดร้าน = วันอาทิตย์ (ถ้าเปิดกฎ) หรือวันหยุดพิเศษที่ตั้งไว้ */
export function isClosedDay(ms: number, holidays: Set<string>, skipSunday = true): boolean {
  if (skipSunday && new Date(ms + 7 * 3600000).getUTCDay() === 0) return true;
  return holidays.has(thaiDate(ms));
}

/** วางแผนช่วงสรุป:
 *  - วันที่รันเป็นวันปิด → ไม่ส่ง (ยกไปรวมวันเปิดถัดไป)
 *  - ไม่งั้น ถอยจุดเริ่มต้นย้อนกลับไปเรื่อย ๆ จนพ้นวันปิดทั้งหมด
 *  boundBase = จุดตัดรอบล่าสุด (ตี 2 ของวันที่รัน) */
export function planRange(nowMs: number, boundBase: number, holidays: Set<string>, skipSunday = true) {
  if (isClosedDay(nowMs, holidays, skipSunday)) return { skip: true, start: boundBase };
  let start = boundBase;
  for (let i = 0; i < 30; i++) {
    const prevDay = start - 86400000;          // ช่วงที่กำลังจะสรุปคือ prevDay → start
    if (!isClosedDay(prevDay, holidays, skipSunday)) break;
    start = prevDay;                            // วันนั้นปิด = ไม่มีใครสรุป ต้องรวมย้อนไปอีก
  }
  return { skip: false, start: start - 86400000 };
}

/* ═══ วาดรายการเป็นรูป PNG บนเซิร์ฟเวอร์ ═══
   edge function ไม่มี canvas จึงต้องสร้าง SVG แล้วให้ resvg แปลงเป็น PNG
   ฟอนต์ไทยต้องส่งให้เองเพราะเซิร์ฟเวอร์ไม่มีฟอนต์ติดตั้งไว้
   ทุกจุดที่เรียกใช้ห่อ try ไว้หมด — ถ้าพังตรงไหนจะตกไปส่งข้อความแบบเดิม */
const RESVG_WASM = 'https://unpkg.com/@resvg/resvg-wasm@2.6.2/index_bg.wasm';
const THAI_FONTS = [
  'https://cdn.jsdelivr.net/gh/cadsondemak/Sarabun@master/fonts/Sarabun-Regular.ttf',
  'https://raw.githubusercontent.com/cadsondemak/Sarabun/master/fonts/Sarabun-Regular.ttf',
];
let _wasmReady = false;
let _font: Uint8Array | null = null;

async function initRender() {
  if (!_wasmReady) {
    const w = await fetch(RESVG_WASM);
    if (!w.ok) throw new Error('โหลด wasm ไม่ได้: HTTP ' + w.status);
    await initWasm(await w.arrayBuffer());
    _wasmReady = true;
  }
  if (!_font) {
    for (const u of THAI_FONTS) {
      try { const r = await fetch(u); if (r.ok) { _font = new Uint8Array(await r.arrayBuffer()); break; } } catch (_) { /* ลองแหล่งถัดไป */ }
    }
  }
  if (!_font) throw new Error('โหลดฟอนต์ไทยไม่ได้ทุกแหล่ง');
}

const xesc = (v: unknown) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** ดึงรูปสินค้ามาฝังใน SVG แบบ base64 — ข้ามเงียบ ๆ ถ้าโหลดไม่ได้หรือไฟล์ใหญ่เกิน */
const MAX_THUMB = 600_000;
async function fetchThumb(url?: string | null): Promise<string | null> {
  if (!url) return null;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 4000);
    const r = await fetch(url, { signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    const buf = new Uint8Array(await r.arrayBuffer());
    if (buf.length > MAX_THUMB) return null;
    const mime = r.headers.get('content-type') || 'image/jpeg';
    if (!/^image\//.test(mime)) return null;
    let bin = '';
    const C = 0x8000;
    for (let i = 0; i < buf.length; i += C) bin += String.fromCharCode(...buf.subarray(i, i + C));
    return 'data:' + mime + ';base64,' + btoa(bin);
  } catch (_) { return null; }
}

const cutTxt = (v: unknown, n: number) => { const t = String(v ?? ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

/** ใบเรียกของ A4 หน้าตาเดียวกับใบโอนที่หลังบ้านวาด
    ตำแหน่งคอลัมน์วัดจากความกว้างตัวอักษรจริงของฟอนต์ Sarabun แล้ว */
function docSvg(o: {
  title: string; from: string; to: string; when: string; by: string;
  rows: { n: number; img: string | null; sku: string; name: string; qty: string; left: string; dest: string }[];
  page: number; pages: number; totalItems: number; totalQty: number;
}) {
  const W = 1000, H = 1414, ML = 64, MR = 936;
  const HEAD = 196, RH = 74;
  const cNo = 82, cImg = 116, cSku = 200, cName = 300;
  const cQty = 700, cLeft = 812, cDest = 936;   // สามช่องนี้ชิดขวา
  let b = '';
  o.rows.forEach((r, i) => {
    const y = HEAD + i * RH, ty = y + RH / 2 + 9;
    if (i % 2) b += `<rect x="${ML}" y="${y}" width="${MR - ML}" height="${RH}" fill="#F7F3EE"/>`;
    b += `<text x="${cNo}" y="${ty}" font-family="Sarabun" font-size="22" fill="#8A8078">${r.n}</text>`;
    b += r.img
      ? `<image x="${cImg}" y="${y + 7}" width="60" height="60" href="${r.img}" preserveAspectRatio="xMidYMid meet"/>`
      : `<rect x="${cImg}" y="${y + 7}" width="60" height="60" rx="6" fill="#EFEAE4"/>`;
    b += `<text x="${cSku}" y="${ty}" font-family="Sarabun" font-size="21" fill="#6E645C">${xesc(r.sku)}</text>`;
    // ชื่อยาวเกิน 1 บรรทัด → แบ่ง 2 บรรทัดให้อ่านครบ หยิบของถูกตัว (cron-46 — ขอจากทีมแพ็ค
    // 03/08: ชื่อโดนตัด "…" ทำให้หยิบยาก) · แถวสูง 74px รองรับ 2 บรรทัดฟอนต์ 22 พอดี
    const nameLines = wrap2(r.name, 26);
    if (nameLines.length === 1) {
      b += `<text x="${cName}" y="${ty}" font-family="Sarabun" font-size="22" fill="#241814">${xesc(nameLines[0])}</text>`;
    } else {
      b += `<text x="${cName}" y="${y + RH / 2 - 4}" font-family="Sarabun" font-size="22" fill="#241814">${xesc(nameLines[0])}</text>`
        + `<text x="${cName}" y="${y + RH / 2 + 24}" font-family="Sarabun" font-size="22" fill="#241814">${xesc(nameLines[1])}</text>`;
    }
    b += `<text x="${cQty}" y="${ty}" font-family="Sarabun" font-size="24" font-weight="700" fill="#9E2B25" text-anchor="end">${xesc(r.qty)}</text>`
      + `<text x="${cLeft}" y="${ty}" font-family="Sarabun" font-size="21" fill="#8A8078" text-anchor="end">${xesc(r.left)}</text>`
      + `<text x="${cDest}" y="${ty}" font-family="Sarabun" font-size="21" fill="#8A8078" text-anchor="end">${xesc(r.dest)}</text>`;
  });
  const fy = H - 96;
  const th = (x: number, t: string, end = false) =>
    `<text x="${x}" y="188" font-family="Sarabun" font-size="19" font-weight="700" fill="#6E645C"${end ? ' text-anchor="end"' : ''}>${t}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">`
    + `<rect width="100%" height="100%" fill="#FFFFFF"/>`
    + `<text x="${ML}" y="72" font-family="Sarabun" font-size="34" font-weight="700" fill="#241814">${xesc(o.title)}</text>`
    + `<text x="${ML}" y="112" font-family="Sarabun" font-size="21" fill="#6E645C">จาก: ${xesc(o.from)}   \u2192   ไป: ${xesc(o.to)}</text>`
    + `<text x="${ML}" y="144" font-family="Sarabun" font-size="21" fill="#6E645C">${xesc(o.when)}   ·   ${o.totalItems} รายการ${o.pages > 1 ? '   ·   หน้า ' + o.page + '/' + o.pages : ''}</text>`
    + `<line x1="${ML}" y1="166" x2="${MR}" y2="166" stroke="#241814" stroke-width="2"/>`
    + th(cNo, '#') + th(cSku, 'รหัส') + th(cName, 'ชื่อสินค้า')
    + th(cQty, 'จำนวน', true) + th(cLeft, 'ต้นทางเหลือ', true) + th(cDest, 'ปลายทางเป็น', true)
    + b
    + `<line x1="${ML}" y1="${fy}" x2="${MR}" y2="${fy}" stroke="#D9D2CB" stroke-width="2"/>`
    + `<text x="${ML}" y="${fy + 34}" font-family="Sarabun" font-size="20" fill="#8A8078">ผู้จัดทำ: ${xesc(o.by)}</text>`
    + `<text x="${MR}" y="${fy + 34}" font-family="Sarabun" font-size="22" font-weight="700" fill="#241814" text-anchor="end">รวม ${o.totalItems} รายการ   ·   ${o.totalQty} หน่วย</text>`
    + `</svg>`;
}

/** อ่านขนาดกว้างยาวจากหัวไฟล์ JPEG (SOF marker) — ไม่ต้องคลายภาพ */
function jpegSize(u8: Uint8Array): { w: number; h: number } | null {
  if (u8[0] !== 0xFF || u8[1] !== 0xD8) return null;
  let i = 2;
  while (i + 9 < u8.length) {
    if (u8[i] !== 0xFF) { i++; continue; }
    const m = u8[i + 1];
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
      return { h: (u8[i + 5] << 8) | u8[i + 6], w: (u8[i + 7] << 8) | u8[i + 8] };
    }
    i += 2 + ((u8[i + 2] << 8) | u8[i + 3]);
  }
  return null;
}

/** ประทับตราลำดับลงมุมบนซ้ายของรูปบิลเดิม (JPEG ที่เบราว์เซอร์วาดไว้ ไม่มีตรา)
    ทำสำเนาใหม่เฉพาะรอบส่ง ไม่แตะไฟล์เดิม · พังก็คืน null ให้ใช้รูปเดิมไป */
async function stampJpegPage(url: string, label: string): Promise<string | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const buf = new Uint8Array(await r.arrayBuffer());
    if (buf.byteLength > 1_200_000) return null;          // ใหญ่เกิน ไม่เสี่ยงหน่วยความจำ
    const dim = jpegSize(buf);
    if (!dim || dim.w < 200) return null;
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    const sc = dim.w / 1000;
    const bw = (label.length * 15 + 34) * sc;
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + dim.w + '" height="' + dim.h + '">'
      + '<image width="' + dim.w + '" height="' + dim.h + '" href="data:image/jpeg;base64,' + btoa(bin) + '"/>'
      + '<rect x="' + 64 * sc + '" y="' + 40 * sc + '" width="' + bw + '" height="' + 46 * sc + '" rx="' + 8 * sc
      + '" fill="#FFFFFF" stroke="#9E2B25" stroke-width="' + 3 * sc + '"/>'
      + '<text x="' + 81 * sc + '" y="' + 72 * sc + '" font-family="Sarabun" font-size="' + 26 * sc
      + '" font-weight="700" fill="#9E2B25">' + xesc(label) + '</text></svg>';
    return await svgToUrl(svg, 'stamp/' + label.replace(/[^A-Za-z0-9]/g, '') + '-' + Math.random().toString(36).slice(2, 8) + '.png');
  } catch (_) { return null; }
}

/** ใบบิล A4 ฝั่งเซิร์ฟเวอร์ — โครงเดียวกับเทมเพลตเบราว์เซอร์ (ข้อมูลออกบิล/จัดส่ง/ลายเซ็น)
    ต่างแค่ไม่มีบาร์โค้ด (ใช้เลขที่แทน) และมีตราลำดับมุมบนซ้ายเมื่อรู้ลำดับ */
const money = (n: unknown) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const wrap2 = (t: string, n: number): string[] => {
  const x = String(t || '-');
  if (x.length <= n) return [x];
  return [x.slice(0, n), cutTxt(x.slice(n), n)];
};
function billSvg(o: {
  label: string; title: string; billNo: string; when: string; by: string;
  cust: { name: string; addr: string; phone: string; shipName: string; shipAddr: string; recv: string; recvPhone: string; orderNo: string };
  rows: { n: number; img: string | null; sku: string; name: string; qty: string; price: string; amt: string }[];
  page: number; pages: number;
  sub: string; ship: string; disc: string; net: string; totalQty: number; totalItems: number;
}) {
  const W = 1000, H = 1414, ML = 64, MR = 936;
  const T = (x: number, y: number, t: string, sz = 20, o2 = '') =>
    `<text x="${x}" y="${y}" font-family="Sarabun" font-size="${sz}" ${o2}>${xesc(t)}</text>`;
  let hd = '';
  // ── หัวขวา: ชื่อเอกสาร + เลขที่ (แทนบาร์โค้ด) ──
  hd += T(MR, 70, o.title, 38, 'font-weight="700" fill="#241814" text-anchor="end"');
  hd += T(MR, 104, o.billNo, 22, 'fill="#241814" text-anchor="end"');
  hd += `<line x1="${ML}" y1="136" x2="${MR}" y2="136" stroke="#241814" stroke-width="2.5"/>`;
  // ── คอลัมน์ซ้าย: ข้อมูลออกบิล + ข้อมูลจัดส่ง (โครงเหมือนเบราว์เซอร์) ──
  const L = ML, LV = ML + 118; let y = 168;
  const row = (k: string, v: string, lines = 1) => {
    hd += T(L, y, k, 20, 'font-weight="700" fill="#241814"');
    wrap2(v, 42).slice(0, lines).forEach((ln, i) => { hd += T(LV, y + i * 28, ln, 20, 'fill="#241814"'); });
    y += 28 * Math.min(lines, wrap2(v, 42).length) + 4;
  };
  hd += T(L, y, 'ข้อมูลออกบิล', 16, 'fill="#8A8078"'); y += 26;
  row('ลูกค้า:', o.cust.name); row('ที่อยู่:', o.cust.addr, 2); row('โทรศัพท์:', o.cust.phone);
  y += 6; hd += T(L, y, 'ข้อมูลจัดส่ง', 16, 'fill="#8A8078"'); y += 26;
  row('ชื่อร้าน:', o.cust.shipName); row('ที่อยู่จัดส่ง:', o.cust.shipAddr, 2);
  row('ผู้รับสินค้า:', o.cust.recv); row('เบอร์ผู้รับ:', o.cust.recvPhone);
  // ── คอลัมน์ขวา: วันที่ / เลขที่ / ผู้สร้างรายการ ──
  const R1 = 600, R2 = 782; let ry = 168;
  const rrow = (k: string, v: string) => { hd += T(R1, ry, k, 20, 'font-weight="700" fill="#241814"'); hd += T(R2, ry, cutTxt(v, 15), 20, 'fill="#241814"'); ry += 32; };
  rrow('วันที่:', o.when); rrow('เลขที่:', o.billNo); rrow('ผู้สร้างรายการ:', o.by); rrow('เลขออเดอร์:', o.cust.orderNo);
  // ── ตารางสินค้า ──
  const HEAD = 560, RH = 68;
  const cNo = 82, cImg = 106, cSku = 176, cName = 268, cQty = 700, cPrice = 822, cAmt = 936;
  let tb = `<line x1="${ML}" y1="${HEAD - 14}" x2="${MR}" y2="${HEAD - 14}" stroke="#241814" stroke-width="2"/>`
    + T(cNo, HEAD + 8, '#', 18, 'font-weight="700" fill="#6E645C"')
    + T(cSku, HEAD + 8, 'รหัสสินค้า', 18, 'font-weight="700" fill="#6E645C"')
    + T(cName, HEAD + 8, 'ชื่อสินค้า', 18, 'font-weight="700" fill="#6E645C"')
    + T(cQty, HEAD + 8, 'จำนวน', 18, 'font-weight="700" fill="#6E645C" text-anchor="end"')
    + T(cPrice, HEAD + 8, 'มูลค่าต่อหน่วย', 18, 'font-weight="700" fill="#6E645C" text-anchor="end"')
    + T(cAmt, HEAD + 8, 'รวม', 18, 'font-weight="700" fill="#6E645C" text-anchor="end"');
  o.rows.forEach((r, i) => {
    const yy = HEAD + 24 + i * RH, ty = yy + RH / 2 + 8;
    if (i % 2) tb += `<rect x="${ML}" y="${yy}" width="${MR - ML}" height="${RH}" fill="#F7F3EE"/>`;
    tb += T(cNo, ty, String(r.n), 20, 'fill="#8A8078"');
    tb += r.img
      ? `<image x="${cImg}" y="${yy + 6}" width="56" height="56" href="${r.img}" preserveAspectRatio="xMidYMid meet"/>`
      : `<rect x="${cImg}" y="${yy + 6}" width="56" height="56" rx="6" fill="#EFEAE4"/>`;
    tb += T(cSku, ty, r.sku, 19, 'fill="#6E645C"')
      + T(cName, ty, cutTxt(r.name, 20), 19, 'fill="#241814"')
      + T(cQty, ty, r.qty, 20, 'fill="#241814" text-anchor="end"')
      + T(cPrice, ty, r.price, 19, 'fill="#6E645C" text-anchor="end"')
      + T(cAmt, ty, r.amt, 19, 'font-weight="700" fill="#241814" text-anchor="end"');
  });
  const tEnd = HEAD + 24 + o.rows.length * RH;
  let foot = `<line x1="${ML}" y1="${tEnd + 8}" x2="${MR}" y2="${tEnd + 8}" stroke="#241814" stroke-width="2"/>`;
  if (o.page === o.pages) {
    const fy = tEnd + 52;
    foot += T(560, fy, 'รวมทั้งหมด', 22, 'font-weight="700" fill="#241814" text-anchor="end"')
      + T(700, fy, String(o.totalQty), 22, 'font-weight="700" fill="#241814" text-anchor="end"')
      + T(MR, fy, money(o.sub), 22, 'font-weight="700" fill="#241814" text-anchor="end"')
      + `<line x1="${ML}" y1="${fy + 18}" x2="${MR}" y2="${fy + 18}" stroke="#241814" stroke-width="2"/>`
      + T(760, fy + 58, 'ค่าขนส่ง', 20, 'fill="#6E645C" text-anchor="end"')
      + T(MR, fy + 58, money(o.ship), 20, 'fill="#241814" text-anchor="end"')
      + T(760, fy + 92, 'ส่วนลด', 20, 'fill="#6E645C" text-anchor="end"')
      + T(MR, fy + 92, money(o.disc), 20, 'fill="#241814" text-anchor="end"')
      + T(760, fy + 134, 'มูลค่ารวมสุทธิ', 26, 'font-weight="700" fill="#241814" text-anchor="end"')
      + T(MR, fy + 134, money(o.net) + ' บาท', 26, 'font-weight="700" fill="#9E2B25" text-anchor="end"');
    // ลายเซ็นสามช่อง เหมือนเทมเพลตเบราว์เซอร์
    const sy = H - 150;
    [['ผู้รับสินค้า', 230], ['ผู้ส่งสินค้า', 500], ['ผู้รับเงิน', 770]].forEach(([nm, cx]) => {
      foot += T(cx as number, sy, nm as string, 20, 'fill="#241814" text-anchor="middle"')
        + `<line x1="${(cx as number) - 90}" y1="${sy + 56}" x2="${(cx as number) + 90}" y2="${sy + 56}" stroke="#B7AEA5" stroke-width="1.6" stroke-dasharray="6 5"/>`
        + T(cx as number, sy + 84, 'วันที่', 17, 'fill="#B7AEA5" text-anchor="middle"')
        + `<line x1="${(cx as number) - 90}" y1="${sy + 100}" x2="${(cx as number) + 90}" y2="${sy + 100}" stroke="#B7AEA5" stroke-width="1.6" stroke-dasharray="6 5"/>`;
    });
  } else {
    foot += T(MR, tEnd + 48, 'มีต่อหน้าถัดไป \u2192', 21, 'fill="#8A8078" text-anchor="end"');
  }
  foot += T(MR, H - 26, o.billNo + '   หน้า ' + o.page + '/' + o.pages, 17, 'fill="#B7AEA5" text-anchor="end"');
  const bw = o.label.length * 15 + 34;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">`
    + `<rect width="100%" height="100%" fill="#FFFFFF"/>`
    + (o.label ? `<rect x="${ML}" y="36" width="${bw}" height="46" rx="8" fill="#FFFFFF" stroke="#9E2B25" stroke-width="3"/>`
      + T(ML + 17, 68, o.label, 26, 'font-weight="700" fill="#9E2B25"') : '')
    + hd + tb + foot + `</svg>`;
}

/** วาดบิลอัตโนมัติเป็นหน้า A4 อัปขึ้นสตอเรจ + บันทึกกลับเข้า bills */
async function renderBillPages(b: any, o: any, shortLabel: string): Promise<string[]> {
  const c = o.customers || {};
  const items: any[] = o.order_items || [];
  const thumbs = await Promise.all(items.map((it) => fetchThumb(it.products?.image_url)));
  const cust = {
    name: (c.name || '-') + (c.code ? '  (' + c.code + ')' : ''),
    addr: c.billing_address || '-',
    phone: c.phone || '-',
    shipName: c.ship_shop_name || c.name || '-',
    shipAddr: c.ship_address || c.billing_address || '-',
    recv: c.ship_receiver || c.contact_name || '-',
    recvPhone: c.ship_phone || c.phone || '-',
    orderNo: o.order_no || '-',
  };
  const whenTxt = new Date(b.created_at).toLocaleDateString('th-TH', {
    timeZone: 'Asia/Bangkok', day: 'numeric', month: 'long', year: 'numeric',
  });
  const sub = items.reduce((a, it) => a + (Number(it.amount) || 0), 0);
  const totalQty = items.reduce((a, it) => a + (Number(it.qty) || 0), 0);
  const PER = 8, pgs = Math.max(1, Math.ceil(items.length / PER));
  const pageSvg = (pg: number): string => {
    const part = items.slice((pg - 1) * PER, pg * PER).map((it, j) => ({
      n: (pg - 1) * PER + j + 1,
      img: thumbs[(pg - 1) * PER + j],
      sku: String(it.products?.sku || ''),
      name: String(it.products?.name || ''),
      qty: (Number(it.qty) || 0) + ' ' + (it.products?.unit || ''),
      price: money(it.price),
      amt: money(it.amount),
    }));
    return billSvg({
      label: shortLabel, title: b.doc_type || 'บิลเงินสด', billNo: b.bill_no, when: whenTxt,
      by: b.created_by || 'ระบบอัตโนมัติ', cust, rows: part, page: pg, pages: pgs,
      sub: String(sub), ship: String(b.shipping_fee || 0), disc: String(b.discount || 0),
      net: String(b.total || 0), totalQty, totalItems: items.length,
    });
  };
  // ทุกหน้าของใบเดียวกันต้องฟอร์แมตเดียวกันเสมอ — ห้าม .jpg/.png ปนใบเดียว ไม่งั้น PDF
  // จะตัดเฉพาะหน้า PNG ทิ้ง กลายเป็นบิลแหว่ง (หน้าท้ายมียอดสุทธิ+ลายเซ็นหายเงียบ — รีวิว 01/08)
  const draw = async (asJpeg: boolean): Promise<string[]> => {
    const out: string[] = [];
    for (let pg = 1; pg <= pgs; pg++) {
      const name = 'auto/' + b.bill_no + '-' + pg + '-' + Math.random().toString(36).slice(2, 8);
      const u = asJpeg ? await svgToJpegUrl(pageSvg(pg), name + '.jpg')
                       : await svgToUrl(pageSvg(pg), name + '.png');
      if (!u) throw new Error('อัปโหลดหน้า ' + pg + ' ไม่สำเร็จ');
      out.push(u);
    }
    return out;
  };
  let urls: string[];
  try { urls = await draw(true); }
  catch (e) {
    // JPEG พลาดหน้าไหนก็ตาม → ถอยทั้งใบเป็น PNG (ส่งไลน์/หน้าเว็บได้ปกติ แค่ไม่เข้า PDF
    // — สภาพเดียวกับ cron-40 · บิลออกจากคิวไปก่อน requeue_png_bills.sql เก็บตกทีหลังได้)
    console.warn('วาด JPEG ไม่ผ่าน ถอยทั้งใบเป็น PNG:', String((e as Error).message || e).slice(0, 120));
    urls = await draw(false);
  }
  try {
    await rest('bills?id=eq.' + b.id, { method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ image_url: urls[0], page_urls: urls }) });
  } catch (_) { /* เก็บไม่ได้ไม่เป็นไร รอบนี้ยังส่งได้ */ }
  return urls;
}

/** แปลง SVG เป็น PNG อัปขึ้นสตอเรจ คืน URL สาธารณะ (ไลน์ต้องใช้ URL) */
async function svgToUrl(svg: string, name: string): Promise<string | null> {
  const opts = (w?: number) => ({
    background: 'white',
    font: { fontBuffers: [_font!], defaultFontFamily: 'Sarabun', loadSystemFonts: false },
    ...(w ? { fitTo: { mode: 'width', value: w } } : {}),
  } as any);
  let png = new Resvg(svg, opts()).render().asPng();
  // ไลน์แสดงรูปเป็นสีดำถ้าไฟล์พรีวิวใหญ่เกิน — เกินก็ย่อความกว้างลงจนพอดี
  if (png.byteLength > 950_000) png = new Resvg(svg, opts(820)).render().asPng();
  if (png.byteLength > 950_000) png = new Resvg(svg, opts(640)).render().asPng();
  const up = await fetch(URL_ + '/storage/v1/object/bills/' + name, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'image/png', 'x-upsert': 'true' },
    body: png,
  });
  if (!up.ok) { console.error('upload png:', await up.text()); return null; }
  return URL_ + '/storage/v1/object/public/bills/' + name;
}

/** แปลง SVG เป็น JPEG อัปขึ้นสตอเรจ — ใช้กับ "หน้าบิล" เท่านั้น
 *  เหตุผล: buildBillsPdf ฝังรูปด้วย embedJpg อย่างเดียว (PNG ต้องคลายภาพ = หน่วยความจำเกิน
 *  แพ็กเกจฟรี) หน้า PNG เลยถูกข้ามหมด → pdf=null มาตลอด · จ่ายค่า encode ตอนวาด (1 ใบ/รอบ
 *  10 นาที) ตามหลักกระจายงานหนัก ดีกว่าไปคลาย PNG 8 หน้ารวดตอนรอบตัด 06:00
 *  พลาด = คืน null เฉย ๆ — ห้าม fallback เป็น PNG ในนี้ ไม่งั้นใบหลายหน้าอาจได้ .jpg/.png
 *  ปนกัน แล้ว PDF จะตัดเฉพาะหน้า PNG ทิ้ง = บิลแหว่งแบบเงียบ (รีวิว 01/08) —
 *  ให้ renderBillPages ตัดสินใจถอย "ทั้งใบ" เอง */
async function svgToJpegUrl(svg: string, name: string): Promise<string | null> {
  try {
    const img = new Resvg(svg, {
      background: 'white',
      font: { fontBuffers: [_font!], defaultFontFamily: 'Sarabun', loadSystemFonts: false },
    } as any).render();
    const px: Uint8Array | undefined = (img as any).pixels;
    if (!px || !px.length) throw new Error('resvg ไม่มี pixels');
    // เอกสารพื้นขาว คุณภาพ 78 พอ (~150-300KB) · เกินเพดานพรีวิวไลน์ (~1MB) ค่อยลดคุณภาพลง
    let jpg = jpegEncode({ data: px, width: img.width, height: img.height }, 78).data;
    if (jpg.byteLength > 950_000) jpg = jpegEncode({ data: px, width: img.width, height: img.height }, 55).data;
    const up = await fetch(URL_ + '/storage/v1/object/bills/' + name, {
      method: 'POST',
      headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'image/jpeg', 'x-upsert': 'true' },
      body: jpg,
    });
    if (!up.ok) { console.error('upload jpg:', await up.text()); return null; }
    return URL_ + '/storage/v1/object/public/bills/' + name;
  } catch (e) {
    console.warn('svgToJpegUrl:', String((e as Error).message || e).slice(0, 120));
    return null;
  }
}

/** รวมรูปหน้า A4 ของหลายบิลเป็น PDF ไฟล์เดียว แล้วอัปขึ้นสตอเรจ คืน URL */
async function buildBillsPdf(items: { u: string; label: string }[], fileName: string): Promise<string | null> {
  try {
    const pdf = await PDFDocument.create();
    // ป้ายเป็นอักษรละติน+ตัวเลขล้วน (Lala 3/13, BI 2/14) ใช้ฟอนต์มาตรฐานได้ ไม่ต้องฝังฟอนต์ไทย
    const font = await pdf.embedFont(StandardFonts.HelveticaBold);
    const RED = rgb(0.62, 0.13, 0.12);
    const A4W = 595.28, A4H = 841.89;
    let pages = 0;
    {
      for (const it of items) {
        try {
          const r = await fetch(it.u);
          if (!r.ok) continue;
          const buf = new Uint8Array(await r.arrayBuffer());
          const img = await pdf.embedJpg(buf);   // JPEG เท่านั้น (PNG ต้องคลายภาพ = หน่วยความจำเกิน)
          const page = pdf.addPage([A4W, A4H]);
          const sc = Math.min(A4W / img.width, A4H / img.height);
          const w = img.width * sc, h = img.height * sc;
          page.drawImage(img, { x: (A4W - w) / 2, y: A4H - h, width: w, height: h });
          // ประทับเลขลำดับตามสรุป มุมบนซ้าย (พื้นที่นั้นว่างอยู่แล้วในเทมเพลตบิล)
          if (it.label) {
            const tw = font.widthOfTextAtSize(it.label, 15);
            page.drawRectangle({ x: 16, y: A4H - 42, width: tw + 20, height: 27,
              color: rgb(1, 1, 1), opacity: 0.88, borderColor: RED, borderWidth: 1.2 });
            page.drawText(it.label, { x: 26, y: A4H - 34, size: 15, font, color: RED });
          }
          pages++;
        } catch (e) { console.error('embed:', e); }
      }
    }
    if (!pages) return null;
    const bytes = await pdf.save({ useObjectStreams: false });
    const path = fileName;
    const up = await fetch(URL_ + '/storage/v1/object/bills/' + path, {
      method: 'POST',
      headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/pdf', 'x-upsert': 'true' },
      body: bytes,
    });
    if (!up.ok) { console.error('upload pdf:', await up.text()); return null; }
    return URL_ + '/storage/v1/object/public/bills/' + path;
  } catch (e) { console.error('buildBillsPdf:', e); return null; }
}

export async function handler(req: Request): Promise<Response> {
  // เปิดให้เรียกจากเบราว์เซอร์ได้ (ปุ่มทดลองสรุปในหลังบ้าน)
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const out = (o: unknown, code = 200) => new Response(JSON.stringify(o), { status: code, headers: { 'Content-Type': 'application/json', ...CORS } });
  try {
    if (new URL(req.url).searchParams.get('health')) {
      return out({ ok: true, version: VERSION, has_db: !!KEY, has_line: !!LINE_TOKEN });
    }
    const qs = new URL(req.url).searchParams;
    const force = qs.get('force') === '1';
    const preview = qs.get('preview') === '1';   // ทดลองดูผล ไม่ส่งไลน์จริง
    const seen: any[] = [];                       // เก็บข้อความที่ "จะส่ง" ตอนพรีวิว
    // กำหนดช่วงเองได้ เช่น ?start=2026-07-24T02:00&end=2026-07-25T02:00 (เวลาไทย) ต้องใส่ force=1 ด้วย
    const qStart = qs.get('start'), qEnd = qs.get('end');
    const thai = (v: string) => Date.parse(/[Zz]$|[+-]\d{2}:?\d{2}$/.test(v) ? v : v + '+07:00');

    const st = await rest('settings?select=key,value');
    const S: Record<string, string> = {};
    (st || []).forEach((r: { key: string; value: string }) => (S[r.key] = r.value));
    const gid = S.line_pack_group || S.line_central_group;
    if (!gid) return out({ skipped: 'ยังไม่ได้ตั้งกลุ่มแพ็คของ — พิมพ์ "ตั้งกลุ่มแพ็คของ" ในกลุ่มที่ต้องการ' });

    // ── โหมดออกบิลอย่างเดียว (?autobill=1) — cron ตัวที่สองเรียกทุก 10 นาที ──
    // ออกบิลให้ออเดอร์ค้างทันที ไม่ต้องรอถึงรอบตัด · ไม่ส่งไลน์ ไม่สรุป ไม่สร้างใบโอน
    // ไม่แตะ summary_log จึงไม่กระทบกันส่งซ้ำของรอบสรุปหลัก · ทำงานทุกวันรวมวันปิดร้าน
    // ปิดได้ด้วยสวิตช์เดียวกัน: settings.autobill_cron = '0'
    if (qs.get('autobill') === '1') {
      if ((S.autobill_cron ?? '1') === '0') return out({ skipped: 'ปิดออกบิลอัตโนมัติไว้ (autobill_cron=0)' });
      const skipSet = new Set(String(S.autobill_skip || '').split(',')
        .map((x) => x.trim().toUpperCase()).filter(Boolean));
      const pend = await rest('orders?select=' +
        encodeURIComponent('id,order_no,total,customer_id,customers(code,doc_type,bill_seller_mode)') +
        '&status=eq.new&order=created_at.asc&limit=200') || [];
      let done = 0, skipped = 0;
      const fails: string[] = [];
      for (const o of pend) {
        if (skipSet.has(String(o.customers?.code || '').toUpperCase())) { skipped++; continue; }
        try {
          const claimed = await rest('orders?id=eq.' + o.id + '&status=eq.new', {
            method: 'PATCH', headers: { Prefer: 'return=representation' },
            body: JSON.stringify({ status: 'billed' }),
          });
          if (!Array.isArray(claimed) || !claimed.length) continue;   // มีคนออกตัดหน้าไปแล้ว
          const no = await rest('rpc/next_doc_no', { method: 'POST', body: JSON.stringify({ p_prefix: 'IV' }) });
          if (!no) throw new Error('ไม่ได้เลขบิล');
          await rest('bills', {
            method: 'POST', headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({
              bill_no: no, order_id: o.id, customer_id: o.customer_id,
              total: o.total, shipping_fee: 0, discount: 0, revision: 1,
              doc_type: o.customers?.doc_type || 'บิลเงินสด',
              seller_mode: o.customers?.bill_seller_mode || 'none',
              line_sent: false,
              created_by: 'ระบบอัตโนมัติ',
            }),
          });
          done++;
        } catch (e) {
          try {
            await rest('orders?id=eq.' + o.id, { method: 'PATCH',
              headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'new' }) });
          } catch (_) { /* คืนไม่ได้ก็ปล่อยให้เห็นว่าค้าง */ }
          fails.push((o.order_no || o.id) + ': ' + String((e as Error).message || e).slice(0, 80));
        }
      }
      // วาดรูปสะสมอัตโนมัติ: รอบละ 1 ใบ — เครื่องใหม่ทุก 10 นาที = งบซีพียูใหม่
      // (จากบทเรียนจริง: วาดทีละหลายใบในรอบเดียว = CPU Time exceeded ตายทั้งรอบ)
      // ทำหลังออกบิลเสร็จ พังก็ไม่กระทบการออกบิล และรอบถัดไปวาดต่อเอง → ถึง 6 โมงรูปครบ
      let drewNo: string | null = null;
      try {
        // nas_mode='1': เว้นบิลที่อายุยังไม่ถึง 10 นาที ให้ NAS (เทมเพลต 2) จับวาดก่อน — edge เก็บตกใบที่ NAS ไม่ทัน
        const nasMode = (S.nas_mode ?? '0') === '1';
        const need = await rest('bills?select=' +
          encodeURIComponent('id,bill_no,created_at,total,shipping_fee,discount,doc_type,created_by,orders(order_no,customers(code,name,phone,billing_address,ship_shop_name,ship_receiver,ship_phone,ship_address),order_items(qty,price,amount,products(sku,name,unit,image_url)))') +
          '&image_url=is.null&or=(ship_status.is.null,ship_status.neq.cancelled)&order=created_at.desc&limit=1' +
          (nasMode ? '&created_at=lt.' + encodeURIComponent(new Date(Date.now() - 10 * 60000).toISOString()) : ''));
        if (Array.isArray(need) && need.length && need[0].orders) {
          await initRender();
          await renderBillPages(need[0], need[0].orders, '');
          drewNo = need[0].bill_no;
        }
      } catch (e) { console.error('bg draw:', e); }
      return out({ mode: 'autobill', พบออเดอร์ค้าง: pend.length, ออกบิลให้: done, ข้ามร้านยกเว้น: skipped, พลาด: fails, วาดรูปให้: drewNo, version: VERSION });
    }

    // ── โหมดยามเฝ้ารอบ (?watchdog=1) — pg_cron เรียกทุก 15 นาที ──
    // ทำงานเฉพาะ "ภายใน 1 ชม.แรกหลังเวลาตัดรอบ": รอบส่งแล้ว = ตัวกันซ้ำข้างล่างตอบเงียบเอง,
    // รอบพลาด = ไหลเข้ากระบวนการปกติ = ส่งแทนภายใน ≤15 นาที · นอกช่วงต้องหยุดตรงนี้เด็ดขาด —
    // log จดรอบด้วย range_start ที่ถูกถอยไปวันก่อนหน้าเสมอ (กติกา <1 ชม.ข้างล่าง) การ probe
    // หลังชั่วโมงแรกจะมองไม่เห็น log แล้วเผลอส่งหน้าต่างเศษซ้ำ · เปลี่ยนเวลาตัดรอบใน settings
    // ได้เลย ยามคำนวณตามให้เอง ไม่ต้องแก้ตารางเวลา/โค้ดอีก
    if (qs.get('watchdog') === '1') {
      const wnow = Date.now();
      const wb = lastBoundary(wnow, S.summary_cutoff || S.bill_cutoff || '14:00');
      if (wnow - wb >= 3600000) {
        return out({ watchdog: 'นอกช่วงเฝ้า (เกิน 1 ชม.หลังตัดรอบ) — ไม่ทำอะไร', version: VERSION });
      }
    }

    const now = Date.now();
    // ช่วงสรุป: ยึดเวลาสร้าง "บิล" ตั้งแต่รอบตัดล่าสุด (14:00 เมื่อวาน) จนถึงตอนรัน (ตี 2)
    // ช่วงสรุป: ตั้งแต่รอบตัดล่าสุด → ตอนรัน
    // กันเคสเวลารัน cron ตรงกับเวลาตัดรอบพอดี (ช่วงจะเป็น 0 นาที) → ถอยไปรอบก่อนหน้า
    let bound = lastBoundary(now, S.summary_cutoff || S.bill_cutoff || '14:00');
    const inFirstHour = now - bound < 3600000;
    if (inFirstHour) bound -= 86400000;   // ห่างไม่ถึง 1 ชม. = ใช้รอบเมื่อวาน
    // นัดส่งจริงแบบไม่ระบุช่วง (ไม่มี start/end) นอกชั่วโมงแรกหลังตัดรอบ = ไม่มีหน้าที่อะไร
    // ต้องปัดตกตรงนี้ ไม่งั้นจะเกิด "รอบเศษ" (start=เส้นตัดวันนี้ end=ตอนนี้) ไปจอง range_start
    // ของรอบเช้าวันพรุ่งนี้ → unique index ทำให้รอบจริงพรุ่งนี้โดนบล็อกเงียบ (รีวิว 01/08 ดึก)
    // อยากดูตัวอย่างใช้ preview ได้ปกติ · อยากส่งย้อนหลังให้ระบุ start/end (จดเป็น custom)
    if (!preview && !(qStart && qEnd) && !inFirstHour) {
      return out({ skipped: 'นอกชั่วโมงส่งรอบปกติ — ดูตัวอย่างใช้ ?preview=1 · ส่งเองให้ระบุ start/end พร้อม force=1' });
    }
    let start = new Date(bound).toISOString();
    let end = new Date(now).toISOString();
    // กฎวันปิดร้าน: วันอาทิตย์ + วันหยุดพิเศษ (ข้ามได้ถ้ากำหนดช่วงเอง)
    if (!(qStart && qEnd)) {
      const skipSunday = (S.summary_skip_sunday ?? '1') !== '0';
      let hset = new Set<string>();
      try {
        const hs = await rest('holidays?select=d&d=gte.' + thaiDate(now - 40 * 86400000));
        hset = new Set((hs || []).map((r: any) => String(r.d).slice(0, 10)));
      } catch (_) { /* ไม่มีตาราง = ไม่มีวันหยุดพิเศษ */ }
      const plan = planRange(now, bound + 86400000, hset, skipSunday);
      if (plan.skip) {
        return out({ skipped: 'วันนี้ปิดร้าน (วันอาทิตย์/วันหยุดพิเศษ) — ยกยอดไปรวมสรุปวันเปิดถัดไป', date: thaiDate(now) });
      }
      bound = plan.start;
      start = new Date(bound).toISOString();
    }
    if (qStart && qEnd) {
      const a = thai(qStart), b = thai(qEnd);
      if (isNaN(a) || isNaN(b) || b <= a) return out({ error: 'ช่วงเวลาไม่ถูกต้อง — ใช้รูปแบบ start=2026-07-24T02:00&end=2026-07-25T02:00' }, 400);
      start = new Date(a).toISOString(); end = new Date(b).toISOString();
    }

    // ── กันส่งซ้ำแบบ "จองก่อนส่ง" (cron-44) ─────────────────────────
    // แบบเก่า (เช็คก่อน-เขียนทีหลัง) มีรูรั่ว 2 จุดจากรีวิว 01/08 ดึก:
    //   (1) รอบที่ตายหลังพุชไปบางส่วน ยังไม่ทันเขียน log → ยามรอบถัดไปส่งซ้ำทั้งชุด
    //   (2) สองนัดที่เริ่มห่างกันไม่กี่วินาที-นาที ผ่านเช็คพร้อมกันแล้วส่งคู่
    // วิธีปิด: เขียน "ใบจอง" (sent_by=กำลังส่ง…) ลง summary_log ก่อนพุชข้อความแรก
    // มี unique index กันชนระดับฐานข้อมูล (summary_log_cron_round_uq — รัน claim_dedup.sql
    // หลัง deploy ไฟล์นี้) ใครชนใบจอง = มีรอบกำลังส่ง/ส่งแล้ว → ถอย
    // ใบจองค้างเกิน 12 นาที = รอบนั้นตายจริง → ลบทิ้งจองใหม่ (ยามยังกู้รอบที่ตายได้)
    // เพดานที่เหลือตามความจริง: รอบที่ตาย "หลังพุชไปแล้วบางส่วน" ยังส่งซ้ำได้อย่างมาก 1 ครั้ง
    // ตอนนัดกู้ (แยกไม่ออกจากรอบที่ตายก่อนพุช) — ยอมซ้ำหนดีกว่าเงียบหาย
    const CLAIM = 'กำลังส่ง…';
    let claimId: number | null = null;
    let skipLog = false;
    const isCronRound = !(qStart && qEnd);

    // เปิด JWT ไว้ไม่ได้ (cron ต้องเรียกได้) → กันคนยิง force รัวๆ ด้วยการจำกัด 1 ครั้ง/10 นาที
    if (force && isCronRound) {
      const since = new Date(now - 10 * 60000).toISOString();
      const recent = await rest('summary_log?select=id&mode=eq.cron&created_at=gt.' + encodeURIComponent(since) + '&limit=1');
      if (recent?.length) return out({ skipped: 'เพิ่งส่งไปเมื่อกี้ รอ 10 นาทีก่อนสั่งซ้ำ' });
    }

    if (!preview && isCronRound) {
      // กันรอบหน้าต่างทับซ้อน (เช่น เปลี่ยน summary_cutoff กลางวัน): ถ้ามีรอบที่ส่งจบแล้ว
      // ครอบเลยจุดเริ่มของรอบนี้เกิน 90 นาที = ของช่วงนี้ถูกส่งไปแล้ว ไม่ส่งทับ
      // ⚠️ ต้อง 90 นาที ห้ามน้อยกว่านั้น: รอบปกติ+รอบที่ยามกู้ จบได้ช้าสุดราวเส้นตัด+60 นาที
      // (หน้าต่างเฝ้า 1 ชม.) ถ้าเผื่อแค่ 30 นาที รอบที่ยามกู้ตอน :30-:45 จะทำให้รอบ "วันถัดไป"
      // โดนตัดสินว่าถูกครอบ → ข้ามเงียบทั้งวัน (regression ที่รีวิวจับได้ 01/08 ดึก) ·
      // ส่วนเคสเปลี่ยนเวลาตัดรอบจริงจะครอบกันหลายชั่วโมง 90 นาทีแยกสองเคสนี้ขาดกัน
      if (!force) {
        const lap = await rest('summary_log?select=id&mode=eq.cron&sent_by=neq.' + encodeURIComponent(CLAIM) +
          '&range_end=gt.' + encodeURIComponent(new Date(Date.parse(start) + 90 * 60000).toISOString()) + '&limit=1');
        if (lap?.length) return out({ skipped: 'มีรอบที่ส่งแล้วครอบช่วงเวลานี้อยู่ (เช่น เพิ่งเปลี่ยนเวลาตัดรอบ) — ตั้งใจส่งจริงให้ใช้ force=1', range_start: start });
      }
      const doClaim = () => rest('summary_log', {
        method: 'POST', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ sent_by: CLAIM, mode: 'cron', range_start: start, range_end: end, order_count: 0, msg_count: 0, detail: [] }),
      });
      try {
        const c = await doClaim();
        claimId = Array.isArray(c) && c.length ? c[0].id : null;
      } catch (e) {
        // พังแบบอื่นที่ไม่ใช่ชน unique = ห้ามส่งต่อโดยไม่มีกำแพง (เดี๋ยวยามนัดหน้ามาใหม่เอง)
        if (!/duplicate key|23505/i.test(String(e))) throw e;
        const row = (await rest('summary_log?select=id,sent_by,created_at&mode=eq.cron&range_start=eq.' +
          encodeURIComponent(start) + '&limit=1'))?.[0];
        if (!row) return out({ skipped: 'ชนกับอีกนัดที่กำลังจองรอบนี้พอดี — ถอยให้รอบนั้น', range_start: start });
        // เกณฑ์ใบจองค้าง 12 นาที: มากกว่าเพดานเวลารันจริงของ edge (~ไม่กี่นาที) หลายเท่า
        // = ไม่มีทางแย่งรอบที่ยัง "กำลังส่งอยู่จริง" แต่น้อยกว่าจังหวะยาม 15 นาที
        // = ใบจองที่ตายตอนนัด :30/:45 ยังได้นัดกู้อีกครั้งก่อนหมดชั่วโมงเฝ้าเสมอ
        const stale = row.sent_by === CLAIM && Date.now() - Date.parse(row.created_at) > 12 * 60000;
        if (!stale) {
          if (row.sent_by !== CLAIM && force) {
            skipLog = true;   // force ตั้งใจส่งซ้ำรอบที่จบแล้ว — อนุญาตแบบเดิม แต่ไม่เขียน log ซ้ำ (index ห้าม)
          } else if (row.sent_by === CLAIM) {
            return out({ skipped: 'มีนัดอื่นกำลังส่งรอบนี้อยู่ (ใบจองอายุยังไม่ถึง 12 นาที)', range_start: start });
          } else {
            return out({ skipped: 'รอบนี้ส่งไปแล้ว', range_start: start });
          }
        } else {
          // ใบจองค้างจากรอบที่ตาย — ลบแล้วจองใหม่ ถ้าชนอีกแปลว่ามีคนแย่งตัดหน้า ให้พังออกไปเลย
          await rest('summary_log?id=eq.' + row.id, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
          const c2 = await doClaim();
          claimId = Array.isArray(c2) && c2.length ? c2[0].id : null;
        }
      }
      if (!skipLog && claimId == null) return out({ error: 'จองรอบไม่สำเร็จ — ยกเลิกการส่ง กันส่งซ้ำไว้ก่อน', range_start: start }, 500);
    }

    // ── ออกบิลอัตโนมัติ ณ เวลาตัดรอบ ────────────────────────────
    // ทำงานเหมือนกดปุ่ม "ออกบิลเฉย ๆ" ให้ทุกออเดอร์ที่ยังค้างอยู่ในช่วงนี้
    //   · ไม่ส่งเข้ากลุ่มไลน์ของลูกค้า
    //   · ค่าขนส่ง/ส่วนลด = 0 (ไม่มีคนกรอก) เหมือนกดปุ่มโดยไม่พิมพ์อะไร
    //   · ไม่มีรูปบิล เพราะ edge วาด canvas ไม่ได้ → ไปกดปุ่มสร้างรูปย้อนหลังที่หน้าบัญชี
    //   · โหมดพรีวิวไม่ออกบิลจริง
    // ปิดได้ด้วย settings.autobill_cron = '0' · ยกเว้นร้านด้วย settings.autobill_skip
    let autoIssued = 0, autoSkipped = 0;
    const autoFails: string[] = [];
    if (!preview && (S.autobill_cron ?? '1') !== '0') {
      try {
        const skipSet = new Set(String(S.autobill_skip || '').split(',')
          .map((x) => x.trim().toUpperCase()).filter(Boolean));
        const pendSel = 'id,order_no,total,customer_id,customers(code,doc_type,bill_seller_mode)';
        const pend = await rest('orders?select=' + encodeURIComponent(pendSel) +
          '&status=eq.new&created_at=gte.' + encodeURIComponent(start) +
          '&created_at=lt.' + encodeURIComponent(end) +
          '&order=created_at.asc&limit=500') || [];
        for (const o of pend) {
          if (skipSet.has(String(o.customers?.code || '').toUpperCase())) { autoSkipped++; continue; }
          try {
            // จองออเดอร์ก่อนด้วย PATCH ที่บังคับว่าต้องยังเป็น new อยู่
            // ถ้ามีคนกดออกบิลจากหน้าเว็บตัดหน้าไปแล้ว จะได้ผลลัพธ์ว่าง → ข้ามใบนี้
            // ทำแบบนี้ก่อนขอเลขบิล จะได้ไม่กินเลขทิ้งเปล่า ๆ
            const claimed = await rest('orders?id=eq.' + o.id + '&status=eq.new', {
              method: 'PATCH',
              headers: { Prefer: 'return=representation' },
              body: JSON.stringify({ status: 'billed' }),
            });
            if (!Array.isArray(claimed) || !claimed.length) continue;

            const no = await rest('rpc/next_doc_no', {
              method: 'POST',
              body: JSON.stringify({ p_prefix: 'IV' }),
            });
            if (!no) throw new Error('ไม่ได้เลขบิล');

            await rest('bills', {
              method: 'POST',
              headers: { Prefer: 'return=minimal' },
              body: JSON.stringify({
                bill_no: no,
                order_id: o.id,
                customer_id: o.customer_id,
                total: o.total,
                shipping_fee: 0,
                discount: 0,
                revision: 1,
                doc_type: o.customers?.doc_type || 'บิลเงินสด',
                seller_mode: o.customers?.bill_seller_mode || 'none',
                line_sent: false,
                created_by: 'ระบบอัตโนมัติ',
              }),
            });
            autoIssued++;
          } catch (e) {
            // คืนสถานะให้เป็น new เพื่อให้รอบหน้าหรือคนกดเองทำต่อได้
            try {
              await rest('orders?id=eq.' + o.id, {
                method: 'PATCH',
                headers: { Prefer: 'return=minimal' },
                body: JSON.stringify({ status: 'new' }),
              });
            } catch (_) { /* ถ้าคืนไม่ได้ก็ปล่อย จะเห็นในรายงานว่าใบไหนพลาด */ }
            autoFails.push((o.order_no || o.id) + ': ' + String((e as Error).message || e).slice(0, 80));
          }
        }
      } catch (e) {
        autoFails.push('ดึงออเดอร์ค้างไม่ได้: ' + String((e as Error).message || e).slice(0, 120));
      }
    }
    // [กฎ 1+2] ดึงจาก "บิล" ที่สร้างในช่วง (เฉพาะออเดอร์ที่ออก INV แล้ว) ตัดใบยกเลิก
    const ordSel = 'orders(order_no,total,status,customers(code,name,sale_name,contact_name,phone,billing_address,map_link,receive_time,note,delivery_method,ship_shop_name,ship_receiver,ship_phone,ship_address),order_items(qty,price,amount,products(sku,name,unit,image_url)))';
    // หมายเหตุ: ไม่กรอง ship_status ในคำสั่งดึงข้อมูล เพราะบิลที่ยังไม่ได้ส่งมีค่าเป็นค่าว่าง (NULL)
    // ซึ่งจะถูกตัดทิ้งไปด้วย — กรองในโค้ดแทนเพื่อให้ครบทุกใบ
    const q = '&created_at=gte.' + encodeURIComponent(start) + '&created_at=lt.' + encodeURIComponent(end) +
      '&order=created_at.asc&limit=1000';
    let billsRaw: any[] = []; let qErr = '';
    try {
      billsRaw = await rest('bills?select=' + encodeURIComponent('id,bill_no,created_at,total,shipping_fee,discount,doc_type,created_by,image_url,page_urls,ship_status,' + ordSel) + q) || [];
    } catch (e) {
      qErr = String(e).slice(0, 300);
      try {   // เผื่อยังไม่มีคอลัมน์ page_urls → ลองใหม่แบบไม่เอาคอลัมน์นั้น
        billsRaw = await rest('bills?select=' + encodeURIComponent('id,bill_no,created_at,total,shipping_fee,discount,doc_type,created_by,image_url,ship_status,' + ordSel) + q) || [];
        qErr += ' | ใช้ข้อมูลแบบไม่มี page_urls แทน (ยังไม่ได้รัน page_urls.sql)';
      } catch (e2) { qErr += ' || ' + String(e2).slice(0, 200); }
    }
    const noOrder = (billsRaw || []).filter((b: any) => !b.orders).length;
    const cancelled = (billsRaw || []).filter((b: any) => b.ship_status === 'cancelled' || b.orders?.status === 'cancelled').length;
    // สรุปนี้คือ "งานที่ต้องแพ็ค/จัดส่ง" → ตัดใบที่กดส่งแล้วออก (เปิดกลับได้ด้วย summary_include_shipped=1)
    const inclShipped = (S.summary_include_shipped ?? '0') === '1';
    const shipped = (billsRaw || []).filter((b: any) => b.ship_status === 'shipped').length;
    const billRows = (billsRaw || []).filter((b: any) =>
      b.orders && b.ship_status !== 'cancelled' && b.orders.status !== 'cancelled' &&
      (inclShipped || b.ship_status !== 'shipped'));
    const diag = { พบบิลในช่วง: (billsRaw || []).length, ยกเลิก: cancelled, ส่งแล้วตัดออก: inclShipped ? 0 : shipped, ต่อออเดอร์ไม่ได้: noOrder, ใช้ได้จริง: billRows.length, ปัญหา: qErr || null };
    (diag as any).ออกบิลอัตโนมัติ = { ออกให้: autoIssued, ข้ามร้านยกเว้น: autoSkipped, พลาด: autoFails };
    if (!billRows.length) {
      const info = { ช่วงเวลา: [new Date(start).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }), new Date(end).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })], ตรวจสอบ: diag };
      if (preview) return out({ preview: true, bills: 0, ...info, จะส่ง: [] });
      if (!force) {
        // ไม่มีบิล = ไม่ส่ง → ต้อง "ลบ" ใบจองทิ้ง (ห้ามปิดเป็นบันทึกจริง) เพื่อให้บิลที่เพิ่ง
        // เข้ามาระหว่างชั่วโมงเฝ้ายังถูกส่งได้ในนัดถัดไป — ปล่อยใบจองค้าง = แถวผี "กำลังส่ง…"
        // โผล่ในหน้าประวัติ + นัดถัดไปต้องรอเกณฑ์ใบจองค้างก่อนถึงจะส่งได้ (รีวิว 01/08 ดึก)
        if (claimId != null) {
          try { await rest('summary_log?id=eq.' + claimId, { method: 'DELETE', headers: { Prefer: 'return=minimal' } }); }
          catch (e) { console.warn('ลบใบจองรอบว่างไม่สำเร็จ:', e); }
        }
        return out({ skipped: 'รอบนี้ยังไม่มีบิล', ...info });
      }
    }

    // แปลงเป็นรูปแบบออเดอร์ให้ buildBlocks ใช้ได้ (เลขลำดับนับตามเวลาสร้างบิล แยกขนส่ง)
    const rows = billRows.map((b: any) => ({
      order_no: b.orders.order_no, created_at: b.created_at, total: b.orders.total,
      customers: b.orders.customers, order_items: b.orders.order_items,
      bills: [{ bill_no: b.bill_no, ship_status: b.ship_status }],
    }));

    const dateStr = new Date(now).toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok', day: '2-digit', month: '2-digit', year: 'numeric' });
    const send = async (to: string, texts: string[], gname: string) => {
      if (preview) { seen.push({ กลุ่ม: gname, ข้อความ: texts }); return; }
      await pushLine(to, texts);
    };
    const sendMsgs = async (to: string, m: any[], gname: string) => {
      if (preview) { seen.push({ กลุ่ม: gname, รูปภาพ: m.filter((x) => x.type === 'image').length, ป้ายกำกับ: m.filter((x) => x.type === 'text').map((x) => x.text) }); return; }
      await pushMsgs(to, m);
    };
    const msgs = chunks(buildBlocks(rows as any, dateStr));
    await send(gid, msgs, 'แพ็คของ');

    // [กฎ 9] รูปบิลทีละใบ เรียงตามขนส่ง ชื่อกำกับ เช่น "Lala 1/7 - IVxxxx"
    const groups: Record<string, any[]> = {};
    billRows.forEach((b: any) => {
      const m = shortMethod(b.orders.customers?.delivery_method);
      (groups[m] = groups[m] || []).push(b);
    });
    const billMsgs: any[] = [];
    let srvDrawn = 0, srvStamped = 0; const srvFails: string[] = [];
    const sentImgs: Record<string, number> = {};   // จดว่าแต่ละบิลส่งรูปเข้ากลุ่มกี่หน้าในรอบนี้
    // งบเวลา: วาด/ประทับได้ไม่เกิน 70 วิ — เกินแล้วส่งเท่าที่มี ดีกว่าโดนตัดเวลาแล้วเงียบทั้งรอบ
    // (เกิดจริงเช้า 31/07: รอบหนักเกินเพดาน edge function ทั้งรอบเลยหายเงียบ)
    const T0 = Date.now(); const BUDGET = 100_000;
    const inBudget = () => Date.now() - T0 < BUDGET;
    // จำกัดจำนวนงานหนักต่อรอบ กันชนเพดานหน่วยความจำ (WORKER_RESOURCE_LIMIT — เจอจริง 31/07-01/08)
    // งานที่ทำแล้วถูกบันทึกเก็บ ยิงรอบถัดไปทำต่อจากที่ค้างเสมอ
    // บทเรียนจริง: การวาดบิล (พื้นขาว) เบา — รอบวันหยุด 44 ใบผ่านสบาย
    // ตัวหนัก = ตราทับรูปถ่ายเดิม (stampJpegPage) → ปิดเป็นค่าตั้งต้น เปิดเฉพาะ stamp_old='1'
    // บทสรุปจาก log จริง (01/08): CPU Time exceeded = วาดบนเซิร์ฟเวอร์เกินเพดานแพ็กเกจฟรี
    // และมันฆ่า "ทั้งรอบ" ไม่ใช่แค่ข้ามใบ → รอบปกติห้ามวาดเด็ดขาด ส่งครบสำคัญกว่ารูปครบ
    // อยากวาดสะสม: ยิงมือด้วย ?draw=1 (วาดรอบละ 1 ใบ เว้น 2-3 นาทีต่อนัด)
    let drawLeft = (qs.get('draw') === '1') ? 1 : 0;
    let stampLeft = 0;
    for (const [m, list] of Object.entries(groups)) {
      let i = 0;
      for (const b of list as any[]) {
        i++;
        // ใช้หน้า A4 ถ้ามี (บิลยาวได้หลายหน้า) ไม่มีค่อยใช้รูปเดิม
        let pages: string[] = Array.isArray(b.page_urls) && b.page_urls.length ? b.page_urls
          : (b.image_url ? [b.image_url] : []);
        const shortLabel = m + ' ' + i + '/' + (list as any[]).length;
        // บิลที่ระบบออกอัตโนมัติไม่มีรูปติดตัวมา — วาดบนเซิร์ฟเวอร์ตรงนี้
        // พร้อมตราลำดับมุมบนซ้ายในเนื้อรูปเลย · วาดพังก็ยังได้ป้ายข้อความเหมือนเดิม
        if (!pages.length && b.orders) {
          if (!inBudget() || drawLeft-- <= 0) { srvFails.push(b.bill_no + ': เกินโควตารอบนี้ — ยิงซ้ำเพื่อวาดต่อ'); }
          else try {
            await initRender();
            pages = await renderBillPages(b, b.orders, shortLabel);
            srvDrawn++;
          } catch (e) { srvFails.push(b.bill_no + ': ' + String((e as Error).message || e).slice(0, 60)); }
        }
        // รูปเดิมจากเบราว์เซอร์ (JPEG) ไม่มีตรา — ประทับสำเนาใหม่ก่อนส่ง พังก็ใช้รูปเดิม
        // ยกเว้นหน้า auto/ (เซิร์ฟเวอร์วาด — cron-41 เป็น .jpg แล้ว): ป้ายถูกฝังตอนวาดอยู่แล้ว
        // จะโดนตราซ้ำตำแหน่งเดิม แถม stampJpegPage คืนไฟล์ .png ซึ่งหลุดจากเงื่อนไข PDF
        if (pages.length && /\.jpe?g(\?|$)/i.test(pages[0]) && !/\/auto\//.test(pages[0]) && inBudget() && stampLeft-- > 0) {
          try { await initRender(); } catch (_) { /* ไม่มีฟอนต์ก็ส่งรูปเดิม */ }
          const stamped: string[] = [];
          for (const u of pages) stamped.push((/\.jpe?g(\?|$)/i.test(u) ? await stampJpegPage(u, shortLabel) : null) || u);
          if (stamped.some((u, ix) => u !== pages[ix])) srvStamped++;
          pages = stamped;
        }
        sentImgs[b.bill_no] = pages.length;
        billMsgs.push({ type: 'text', text: shortLabel + ' - ' + b.bill_no + (pages.length > 1 ? '  (' + pages.length + ' หน้า)' : '') });
        pages.forEach((u: string) => billMsgs.push({ type: 'image', originalContentUrl: u, previewImageUrl: u }));
      }
    }
    if (srvDrawn || srvStamped || srvFails.length) (diag as any).วาดบิลเซิร์ฟเวอร์ = { วาดให้: srvDrawn, ตราบนรูปเดิม: srvStamped, พลาด: srvFails };
    // โหมดส่งบิล: pdf (ลิงก์ไฟล์เดียว · ประหยัดโควตา) | image (รูปทีละใบ) | both
    const billMode = S.summary_bill_mode || 'pdf';
    let pdfUrl: string | null = null;
    const pdfUrls: string[] = [];
    if (billMode === 'pdf' || billMode === 'both') {
      // เรียงตามกลุ่มขนส่ง แล้วแบ่งไฟล์ละไม่เกิน 15 หน้า (กันหน่วยความจำเกินโควตา)
      // พ่วงป้ายกำกับ "BI 2/14" ไปกับทุกหน้า — เลขชุดเดียวกับข้อความสรุปแน่นอน
      // เพราะวน groups ลูปเดียวกัน ลำดับเดียวกัน
      // ใช้ได้เฉพาะไฟล์ JPEG (embedJpg) — และตัดสินเป็น "รายใบ" เท่านั้น: ใบไหนมีหน้า
      // non-JPEG ปนอยู่ ตัดออกทั้งใบ กันบิลแหว่งใน PDF (ตัดรายหน้า = หน้าท้ายที่มี
      // ยอดสุทธิ+ลายเซ็นหายเงียบ ๆ ทั้งที่หน้าแรกเขียนว่า "มีต่อหน้าถัดไป" — รีวิว 01/08)
      const allPages: { u: string; label: string }[] = [];
      const pdfSkip: string[] = [];
      let skippedPng = 0;
      Object.entries(groups).forEach(([m, list]) => {
        list.forEach((b: any, i: number) => {
          const pgs: string[] = Array.isArray(b.page_urls) && b.page_urls.length
            ? b.page_urls : (b.image_url ? [b.image_url] : []);
          if (!pgs.length) return;
          const label = m + ' ' + (i + 1) + '/' + list.length;
          if (pgs.every((u: string) => /\.jpe?g(\?|$)/i.test(u))) {
            pgs.forEach((u: string) => allPages.push({ u, label }));
          } else { skippedPng += pgs.length; pdfSkip.push(b.bill_no); }
        });
      });
      if (skippedPng) (diag as any).ข้ามรูปPNG = skippedPng + ' หน้า — ตัดทั้งใบ: ' + pdfSkip.join(', ') + ' (กดปุ่ม 📐 สร้างหน้า A4 ใหม่เพื่อให้เป็น JPEG)';
      const CHUNK = 8;
      const parts = Math.ceil(allPages.length / CHUNK);
      for (let i = 0; i < parts; i++) {
        const name = 'billset-' + thaiDate(now) + (parts > 1 ? '-p' + (i + 1) : '') +
          '-' + Math.random().toString(36).slice(2, 8) + '.pdf';
        const u = await buildBillsPdf(allPages.slice(i * CHUNK, (i + 1) * CHUNK), name);
        if (u) pdfUrls.push(u);
      }
      pdfUrl = pdfUrls[0] || null;
      if (pdfUrls.length) {
        const lines = Object.entries(groups).map(([m, list]) => '\u2022 ' + m + ' ' + list.length + ' บิล');
        await send(gid, ['📄 ไฟล์บิลรวม (' + billRows.length + ' บิล · A4 พร้อมปริ้นท์)\n' + lines.join('\n') +
          '\n\nกดลิงก์เพื่อเปิด/ดาวน์โหลด 👇\n' +
          pdfUrls.map((u, i) => (pdfUrls.length > 1 ? 'ชุด ' + (i + 1) + '/' + pdfUrls.length + ':\n' : '') + u).join('\n\n')], 'แพ็คของ');
      }
    }
    if ((billMode === 'image' || billMode === 'both' || !pdfUrls.length) && billMsgs.length) await sendMsgs(gid, billMsgs, 'แพ็คของ (รูปบิล)');

    // [รูป 4] เรียกของ กัลปพฤกษ์ → วังหิน + แจ้งสั่งซื้อของหมด
    let pullCount = 0, buyCount = 0;
    try {
      const whs = await rest('warehouses?select=id,name');
      const whFrom = (whs || []).find((w: any) => /กัลป/.test(w.name))?.id;
      const whTo = (whs || []).find((w: any) => /วังหิน/.test(w.name))?.id;
      if (whFrom && whTo) {
        const prods = await rest('products?select=id,sku,name,unit,active,reserved_qty,safety_stock,max_stock,thai_orderable,supplier,image_url&limit=2000');
        const stockRows = await rest('stock?select=product_id,warehouse_id,qty&limit=5000');
        // ของที่อยู่ในใบโอนสถานะ pending ปลายทางเดียวกัน = ถือว่ากำลังจะถึง
        const inTransit: Record<number, number> = {};
        try {
          const pend = await rest('transfer_items?select=' +
            encodeURIComponent('product_id,qty,transfers!inner(status,to_wh)') +
            '&transfers.status=eq.pending&transfers.to_wh=eq.' + whTo + '&limit=5000') || [];
          pend.forEach((r: any) => {
            inTransit[r.product_id] = (inTransit[r.product_id] || 0) + (Number(r.qty) || 0);
          });
        } catch (e) { console.warn('in-transit:', e); }
        const { pull, buy } = calcTransfer(prods || [], stockRows || [], whFrom, whTo, inTransit);
        pullCount = pull.length; buyCount = buy.length;
        // ── บันทึกเป็นใบโอนจริง เข้าประวัติใบโอน ──
        // ปิดได้ด้วย settings.pull_make_transfer = '0' (ถ้าอยากได้แค่ข้อความแจ้ง ไม่เอาเอกสาร)
        let tfNo = '';
        if (pull.length && (S.pull_make_transfer ?? '1') !== '0' && !preview) {
          try {
            const ymd = new Date(now + 7 * 3600000).toISOString().slice(2, 10).replace(/-/g, '');
            const prefix = 'TF' + ymd;
            const last = await rest('transfers?select=tf_no&tf_no=like.' + prefix +
              '*&order=tf_no.desc&limit=1') || [];
            let seq = 1;
            if (last.length) {
              const n = parseInt(String(last[0].tf_no).slice(prefix.length), 10);
              if (!isNaN(n)) seq = n + 1;
            }
            tfNo = prefix + String(seq).padStart(4, '0');
            const tf = await rest('transfers', {
              method: 'POST',
              headers: { Prefer: 'return=representation' },
              body: JSON.stringify({
                tf_no: tfNo, from_wh: whFrom, to_wh: whTo, status: 'pending',
                note: 'สร้างอัตโนมัติจากรอบสรุป ' + dateStr,
                created_by: 'ระบบอัตโนมัติ',
              }),
            });
            const tfId = Array.isArray(tf) && tf.length ? tf[0].id : null;
            if (!tfId) throw new Error('ไม่ได้ id ใบโอน');
            await rest('transfer_items', {
              method: 'POST',
              headers: { Prefer: 'return=minimal' },
              body: JSON.stringify(pull.map((x: any) => ({
                transfer_id: tfId, product_id: x.p.id, qty: x.qty,
              }))),
            });
            (diag as any).ใบโอนอัตโนมัติ = tfNo + ' · ' + pull.length + ' รายการ';
          } catch (e) {
            tfNo = '';
            (diag as any).ใบโอนอัตโนมัติ = 'สร้างไม่สำเร็จ — ' + String((e as Error).message || e).slice(0, 140);
            console.warn('auto transfer:', e);
          }
        }

        const supGid = S.line_supplier_group;
        if (supGid && pull.length) {
          const head = '📦 เรียกของ กัลปพฤกษ์ → วังหิน ' + dateStr + ' (' + pull.length + ' รายการ)' +
            (tfNo ? '\nเลขที่ใบโอน ' + tfNo : '');
          const foot = '🚚 ฝากส่งวังหิน 9.00 น. ครับ 🙏';
          let asImage = false;
          // ลองส่งเป็นรูปก่อน — หน้าละ 16 รายการ รูปยาวเกินไปจะอ่านไม่ออกบนมือถือ
          try {
            await initRender();
            // ดึงรูปสินค้ามาฝัง — ทำพร้อมกันทีเดียว ตัวไหนโหลดไม่ได้ใช้กล่องเปล่าแทน
            const thumbs = await Promise.all(pull.map((x: any) => fetchThumb(x.p.image_url)));
            const totalQty = pull.reduce((a: number, x: any) => a + Number(x.qty || 0), 0);
            const whenTxt = new Date(now).toLocaleString('th-TH', {
              timeZone: 'Asia/Bangkok', day: 'numeric', month: 'long', year: 'numeric',
              hour: '2-digit', minute: '2-digit',
            }) + ' น.';
            const CH = 14, tot = Math.ceil(pull.length / CH), urls: string[] = [];
            for (let i = 0; i < pull.length; i += CH) {
              const pg = Math.floor(i / CH) + 1;
              const part = pull.slice(i, i + CH).map((x: any, j: number) => ({
                n: i + j + 1,
                img: thumbs[i + j],
                sku: String(x.p.sku || ''),
                name: String(x.p.name || ''),
                qty: x.qty + ' ' + (x.p.unit || ''),
                left: String(Math.max(Number(x.from || 0) - Number(x.qty || 0), 0)),
                dest: String(Number(x.to || 0) + Number(x.qty || 0)),
              }));
              const svg = docSvg({
                title: tfNo ? 'ใบโอนสินค้าระหว่างโกดัง  ' + tfNo : 'ใบเรียกของระหว่างโกดัง',
                from: 'โกดังกัลปพฤกษ์', to: 'โกดังวังหิน',
                when: whenTxt, by: 'ระบบอัตโนมัติ',
                rows: part, page: pg, pages: tot,
                totalItems: pull.length, totalQty,
              });
              const u = await svgToUrl(svg, 'transfer/pull-' + thaiDate(now) + '-' + pg +
                '-' + Math.random().toString(36).slice(2, 8) + '.png');
              if (u) urls.push(u);
            }
            if (urls.length === tot) {
              const m: any[] = [{ type: 'text', text: head }];
              urls.forEach((u) => m.push({ type: 'image', originalContentUrl: u, previewImageUrl: u }));
              m.push({ type: 'text', text: foot });
              await sendMsgs(supGid, m, 'เรียกของ (กิจศิริ)');
              asImage = true;
              (diag as any).เรียกของ = 'ส่งเป็นรูป ' + urls.length + ' หน้า';
            }
          } catch (e) {
            (diag as any).เรียกของ = 'วาดรูปไม่ได้ ส่งข้อความแทน — ' + String((e as Error).message || e).slice(0, 140);
            console.warn('pull image:', e);
          }
          // วาดรูปไม่สำเร็จ → ส่งข้อความแบบเดิม จะได้ไม่มีวันที่ซัพพลายเออร์ไม่ได้รับอะไรเลย
          if (!asImage) {
            const lines = pull.map((x: any, i: number) => (i + 1) + '. ' + x.p.name + '  ' + x.qty + ' ' + (x.p.unit || ''));
            const texts: string[] = [];
            let cur = head;
            for (const ln of lines) {
              if ((cur + '\n' + ln).length > 4500) { texts.push(cur); cur = ln; }
              else cur += '\n' + ln;
            }
            texts.push(cur);
            texts.push(foot);
            await send(supGid, texts, 'เรียกของ (กิจศิริ)');
          }
        }
        const sumGid = S.line_summary_group;
        if (sumGid && buy.length) {
          const bySup: Record<string, any[]> = {};
          buy.forEach((x: any) => { (bySup[x.p.supplier || 'ไม่ระบุซัพพลายเออร์'] = bySup[x.p.supplier || 'ไม่ระบุซัพพลายเออร์'] || []).push(x); });
          const txt = '🛒 ของหมดโกดัง — สั่งซื้อในไทย\n' + Object.entries(bySup).map(([sup, list]) =>
            '━━ ' + sup + ' ━━\n' + list.map((x: any) => '\u2022 ' + x.p.name + '  ' + x.qty + ' ' + (x.p.unit || '')).join('\n')).join('\n');
          await send(sumGid, [txt.slice(0, 4900)], 'สรุปออเดอร์ (เซลล์)');
        }
      }
    } catch (e) { console.error('transfer calc:', e); }

    if (!preview) try {
      const logBody = JSON.stringify({
        // รอบที่ยิงเองผ่าน URL (มี start/end) ต้องจดเป็น custom — ไม่งั้นตัวกันส่งซ้ำ
        // ของรอบ cron เช้าจะนึกว่าส่งไปแล้ว แล้วเงียบทั้งรอบ (เกิดจริงเช้า 01/08)
        sent_by: (qStart && qEnd) ? 'ยิงเอง (URL)' : 'ระบบอัตโนมัติ',
        mode: (qStart && qEnd) ? 'custom' : 'cron', range_start: start, range_end: end,
        order_count: rows.length, msg_count: msgs.length,
        detail: rows.map((o: any) => ({
          order_no: o.order_no,
          bill_no: (o.bills || []).find((b: any) => b.ship_status !== 'cancelled')?.bill_no ?? null,
          customer: ((o.customers?.code ? o.customers.code + ' ' : '') + (o.customers?.name || '')).trim(),
          method: o.customers?.delivery_method || 'อื่นๆ', total: o.total,
          img: sentImgs[((o.bills || []).find((b: any) => b.ship_status !== 'cancelled')?.bill_no) as string] ?? 0,
        })),
      });
      if (claimId != null) {
        // ปิดใบจองเป็นบันทึกจริง — ต้องพยายามให้ถึงที่สุด: ใบจองที่ค้าง (แม้ส่งสำเร็จ)
        // จะถูกมองเป็นรอบตายหลัง 20 นาที แล้วเสี่ยงโดนส่งซ้ำหนึ่งครั้งในชั่วโมงเฝ้า
        for (let t = 0; t < 3; t++) {
          try {
            await rest('summary_log?id=eq.' + claimId, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: logBody });
            break;
          } catch (e) {
            if (t === 2) console.error('summary_log ปิดใบจองไม่สำเร็จ:', e);
            else await new Promise((r) => setTimeout(r, 1500));
          }
        }
      } else if (!skipLog) {
        // รอบ custom (ไม่มี unique index กั้น) — เขียนบันทึกแบบเดิม
        await rest('summary_log', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: logBody });
      }
      // skipLog (force ส่งซ้ำรอบที่จบแล้ว) = ไม่เขียนอะไร — log ของจริงมีอยู่แล้ว
    } catch (e) { console.error('summary_log:', e); }
    if (preview) return out({ preview: true, bills: billRows.length, pdf: pdfUrl, pdfs: pdfUrls, ตรวจสอบ: diag,
      ช่วงเวลา: [new Date(start).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }), new Date(end).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })],
      จะส่ง: seen });
    return out({ sent: true, bills: billRows.length, auto_bills: autoIssued, auto_skipped: autoSkipped, auto_fails: autoFails, messages: msgs.length, pdf: pdfUrl, bill_images: billMsgs.filter((m: any) => m.type === 'image').length, transfer_items: pullCount, buy_items: buyCount, range: [start, end] });
  } catch (e) {
    console.error('daily-summary error:', e);
    return out({ error: String(e) }, 500);
  }
}
if (!Deno.env.get('CRON_TEST')) Deno.serve(handler);   // ตอนรันเทสต์ไม่ต้องเปิดพอร์ต
