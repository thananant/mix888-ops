// ============================================================
// line-push (BETA 2) — Mix Fresh 168
// ของเดิมจาก BETA 1 (คงครบ):
//   • PUSH {to,messages[]} จากหน้าเว็บ → ตอบ {status:200}
//   • คำสั่งกลุ่ม: ผูกกลุ่ม / ปลดกลุ่ม / เช็คกลุ่ม
// ของใหม่ BETA 2 — ตรวจสลิปอัตโนมัติ:
//   • ลูกค้าส่ง "รูปสลิป" (ธนาคารไหนก็ได้) เข้ากลุ่มที่ผูกร้านไว้
//   • บอทโหลดรูป → ตรวจกับธนาคารผ่าน SlipOK → กันสลิปซ้ำ (trans_ref)
//   • ยอดตรงบิลเดียว = ตัดยอดปิดบิลอัตโนมัติ
//   • ยอดตรงผลรวมทุกบิลค้าง = ปิดทุกบิล
//   • มีบิลเดียวแต่ยอดไม่ตรง = ตัดเข้าบิลนั้น (ขาด=ค้างต่อ / เกิน=แจ้งแอดมิน)
//   • หลายบิลและยอดไม่ตรงเป๊ะ (รวมกรณีโอนมาเกิน) = ถามลูกค้าด้วยปุ่มกดเลือกบิล
//   • ทุกการตัดยอดแจ้งไลน์กลางให้ทีมงานเห็น
// ต้องตั้ง Secrets: SLIPOK_API_KEY, SLIPOK_BRANCH_ID (จากหน้า SlipOK)
// ============================================================

const VERSION = 'merged-10'; // line-webhook: ของเดิม + ผูกหลายร้าน + ตรวจสลิปอัตโนมัติ

// ---------- ENV ----------
const LINE_TOKEN =
  Deno.env.get('LINE_CHANNEL_ACCESS_TOKEN') ??
  Deno.env.get('LINE_TOKEN') ??
  Deno.env.get('CHANNEL_ACCESS_TOKEN') ?? '';
const LINE_SECRET = Deno.env.get('LINE_CHANNEL_SECRET') ?? '';
const SB_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SLIPOK_KEY = Deno.env.get('SLIPOK_API_KEY') ?? '';
const SLIPOK_BRANCH = Deno.env.get('SLIPOK_BRANCH_ID') ?? '';
const SLIPOK_URL = Deno.env.get('SLIPOK_ENDPOINT') ??
  (SLIPOK_BRANCH ? 'https://api.slipok.com/api/line/apikey/' + SLIPOK_BRANCH : '');

const EPS = 0.01;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};
const J = (obj: unknown, code = 200) =>
  new Response(JSON.stringify(obj), { status: code, headers: { ...CORS, 'Content-Type': 'application/json' } });

// ---------- ชนิดข้อมูล ----------
export type Cust = { id: number; code: string; name: string; branch_name?: string | null; line_group_id?: string | null };
export type Bill = {
  id: number; bill_no: string; total: number; paid_amount: number | null;
  payment_status?: string; ship_status?: string; created_at?: string;
  customers?: { code: string; name: string; branch_name?: string | null };
};
export type Cmd = { type: 'bind' | 'unbind' | 'roster' | 'gid' | 'due'; codes: string[] }
  | { type: 'setpin' | 'newpin'; codes: string[]; pin: string }
  | { type: 'pinstatus'; codes: string[] }
  | { type: 'getlink'; codes: string[] }
  | { type: 'setgroup'; codes: string[]; key: string; label: string } | null;
export type Plan =
  | { mode: 'none' }
  | { mode: 'single' | 'all'; alloc: { bill: Bill; pay: number }[]; leftover: number }
  | { mode: 'ask' };

// ============================================================
// ลอจิกล้วน (เทสต์ได้)
// ============================================================
export function parseCmd(text: string): Cmd {
  const t = String(text ?? '').trim();
  const grab = (rest: string) =>
    rest.toUpperCase().split(/[\s,]+/).filter((c) => /^[A-Z0-9]{4,}$/.test(c));
  let m = t.match(/^ผูกกลุ่ม\s*[:：]?\s*(.*)$/s);
  if (m) return { type: 'bind', codes: grab(m[1]) };
  m = t.match(/^(?:ปลดกลุ่ม|ยกเลิกผูก|ถอนกลุ่ม)\s*[:：]?\s*(.*)$/s);
  if (m) return { type: 'unbind', codes: grab(m[1]) };
  if (/^(?:เช็คกลุ่ม|เช็กกลุ่ม|กลุ่มนี้|รายชื่อร้าน|ดูกลุ่ม)$/.test(t)) return { type: 'roster', codes: [] };
  if (/^(?:id|กลุ่มไอดี)$/i.test(t)) return { type: 'gid', codes: [] }; // ของเดิม: ถาม Group ID
  if (/^(?:บิลค้าง|ยอดค้าง|ค้างจ่าย|เช็คบิล|เช็กบิล|เช็คยอด|เช็กยอด)$/.test(t)) return { type: 'due', codes: [] }; // ถามบิลค้างชำระ

  // ---- รหัสยืนยันคำสั่งซื้อ ----
  const dig = (x: string) => x.replace(/\D/g, '');
  // เปลี่ยนรหัส: "เปลี่ยน 123456" / "เปลี่ยนรหัส 123-456"
  m = t.match(/^(?:เปลี่ยน|เปลี่ยนรหัส|เปลี่ยนพาส|เปลี่ยนพาสเวิร์ด)\s*[:：]?\s*([\d\s-]{6,})$/);
  if (m && dig(m[1]).length === 6) return { type: 'newpin', codes: [], pin: dig(m[1]) };
  // ตั้งรหัสครั้งแรก: "รหัส 123456" หรือพิมพ์เลข 6 ตัวเปล่า ๆ
  m = t.match(/^(?:รหัส|ตั้งรหัส|พาสเวิร์ด|pin)\s*[:：]?\s*([\d\s-]{6,})$/i);
  if (m && dig(m[1]).length === 6) return { type: 'setpin', codes: [], pin: dig(m[1]) };
  if (/^\d{6}$/.test(t)) return { type: 'setpin', codes: [], pin: t };
  if (/^(?:รหัส|ดูรหัส|เช็ครหัส|เช็กรหัส|pin)$/i.test(t)) return { type: 'pinstatus', codes: [] };
  // ตั้งกลุ่มระบบ 3 กลุ่ม (พิมพ์ในกลุ่มนั้น ๆ ครั้งเดียว)
  if (/^ตั้งกลุ่มสรุป$/.test(t)) return { type: 'setgroup', codes: [], key: 'line_summary_group', label: 'Mix สรุปออเดอร์ (เซลล์เช็คออเดอร์)' };
  if (/^ตั้งกลุ่มแพ็คของ$/.test(t)) return { type: 'setgroup', codes: [], key: 'line_pack_group', label: 'Mix888 แพ็คของ (สรุปตี 2 + รูปบิล)' };
  if (/^ตั้งกลุ่มเรียกของ$/.test(t)) return { type: 'setgroup', codes: [], key: 'line_supplier_group', label: 'เรียกของกัลปพฤกษ์ → วังหิน' };
  // ขอลิงก์สั่งซื้อ (+รหัส) — รองรับหลายสะกด: ลิงก์/ลิงค์/ลิ้งค์/ลิ้งก์/ลิ้ง/link
  if (/^(?:ขอ|ส่ง)?\s*(?:ลิงก์|ลิงค์|ลิ้งค์|ลิ้งก์|ลิ้ง|link)(?:\s*สั่งซื้อ|\s*สั่งของ)?(?:\s*(?:หน่อย|ด้วย|ครับ|ค่ะ|คะ|จ้า))*$/i.test(t))
    return { type: 'getlink', codes: [] };
  return null;
}

/** ปิดบังรหัสตอนตอบกลับ: 123456 → 12••56 */
export function maskPin(pin: string): string {
  const p = String(pin || '');
  return p.length < 4 ? '••••' : p.slice(0, 2) + '••' + p.slice(-2);
}

export function shopLabel(c: Cust): string {
  return c.code + ' ' + (c.name || '') + (c.branch_name ? ' • ' + c.branch_name : '');
}
export function shopTagOf(c?: { name?: string; branch_name?: string | null } | null): string {
  if (!c || !c.name) return '';
  return '\u3010' + c.name + (c.branch_name ? ' \u2022 ' + c.branch_name : '') + '\u3011\n';
}
export function fmtB(n: number): string {
  const s = Number(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return '฿' + s.replace(/\.00$/, '');
}
export const outOf = (b: Bill) => Number(b.total) - Number(b.paid_amount || 0);

/** วางแผนตัดยอด: ยอดโอน A เทียบกับบิลค้างทั้งกลุ่ม */
export function planPayment(amount: number, billsIn: Bill[]): Plan {
  const bills = billsIn.filter((b) => outOf(b) > EPS && b.ship_status !== 'cancelled');
  if (!bills.length) return { mode: 'none' };
  const exact = bills.find((b) => Math.abs(outOf(b) - amount) < EPS);
  if (exact) return { mode: 'single', alloc: [{ bill: exact, pay: amount }], leftover: 0 };
  const sumAll = bills.reduce((s, b) => s + outOf(b), 0);
  if (Math.abs(sumAll - amount) < EPS)
    return { mode: 'all', alloc: bills.map((b) => ({ bill: b, pay: outOf(b) })), leftover: 0 };
  if (bills.length === 1) {
    const pay = Math.min(amount, outOf(bills[0]));
    return { mode: 'single', alloc: [{ bill: bills[0], pay }], leftover: +(amount - pay).toFixed(2) };
  }
  return { mode: 'ask' }; // หลายบิล + ยอดไม่ตรงเป๊ะ (รวมกรณีโอนเกิน) → ถามลูกค้า
}

/** ปุ่มเลือกบิล (label LINE จำกัด 20 ตัวอักษร) */
export function billBtnLabel(b: Bill): string {
  const short = '..' + b.bill_no.slice(-4);
  const money = fmtB(outOf(b));
  return (short + ' ' + money).slice(0, 20);
}

export function fmtPaidLines(alloc: { bill: Bill; pay: number }[]): string {
  return alloc.map((a) => {
    const after = Number(a.bill.paid_amount || 0) + a.pay;
    const left = Number(a.bill.total) - after;
    const tag = shopTagOf(a.bill.customers).replace(/\n$/, ' ');
    return left <= EPS
      ? tag + '✅ บิล ' + a.bill.bill_no + ' รับชำระ ' + fmtB(a.pay) + ' ครบถ้วน'
      : tag + '💰 บิล ' + a.bill.bill_no + ' รับชำระ ' + fmtB(a.pay) + ' คงค้าง ' + fmtB(left);
  }).join('\n');
}

/** สรุปบิลค้างชำระ แยกตามรหัสร้าน (ใช้ตอบคำสั่ง "บิลค้าง" ในกลุ่ม) */
export function fmtDueReply(bills: Bill[]): string {
  if (!bills.length) return '\u2713 ไม่มีบิลค้างชำระในกลุ่มนี้ครับ';
  const by: Record<string, { c: { code: string; name: string; branch_name?: string | null }; list: Bill[] }> = {};
  for (const b of bills) {
    const c = b.customers || { code: '?', name: '' };
    (by[c.code] ??= { c, list: [] }).list.push(b);
  }
  const parts: string[] = ['📋 บิลค้างชำระในกลุ่มนี้'];
  let gSum = 0, gCnt = 0;
  for (const code of Object.keys(by).sort()) {
    const g = by[code];
    const cap = 10;
    const lines = g.list.slice(0, cap).map((b) => {
      const paid = Number(b.paid_amount || 0);
      return '\u2022 ' + b.bill_no + ' ค้าง ' + fmtB(outOf(b)) + (paid > EPS ? ' (จ่ายบางส่วนแล้ว ' + fmtB(paid) + ')' : '');
    });
    if (g.list.length > cap) lines.push('\u2026อีก ' + (g.list.length - cap) + ' ใบ');
    const sum = g.list.reduce((s, b) => s + outOf(b), 0);
    gSum += sum; gCnt += g.list.length;
    parts.push('\u3010' + code + ' ' + (g.c.name || '') + (g.c.branch_name ? ' \u2022 ' + g.c.branch_name : '') + '\u3011\n'
      + lines.join('\n') + '\nรวม ' + g.list.length + ' บิล ' + fmtB(sum));
  }
  if (Object.keys(by).length > 1) parts.push('รวมทั้งกลุ่ม ' + gCnt + ' บิล ค้าง ' + fmtB(gSum));
  return parts.join('\n\n');
}

// ============================================================
// LINE + Supabase glue
// ============================================================
async function lineApi(path: string, body: unknown): Promise<Response> {
  return await fetch('https://api.line.me/v2/bot/' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + LINE_TOKEN },
    body: JSON.stringify(body),
  });
}
const linePush = (to: string, messages: unknown[]) => lineApi('message/push', { to, messages });
const lineReplyMsgs = (replyToken: string, messages: unknown[]) => lineApi('message/reply', { replyToken, messages });
const lineReply = (replyToken: string, text: string) => lineReplyMsgs(replyToken, [{ type: 'text', text }]);
async function lineContent(messageId: string): Promise<Uint8Array | null> {
  const r = await fetch('https://api-data.line.me/v2/bot/message/' + messageId + '/content', {
    headers: { Authorization: 'Bearer ' + LINE_TOKEN },
  });
  if (!r.ok) return null;
  return new Uint8Array(await r.arrayBuffer());
}

const sbHead = {
  apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY,
  'Content-Type': 'application/json', Prefer: 'return=representation',
};
async function sbGet(pathQs: string): Promise<any[]> {
  const r = await fetch(SB_URL + '/rest/v1/' + pathQs, { headers: sbHead });
  if (!r.ok) throw new Error('db get ' + pathQs + ': ' + (await r.text()));
  return await r.json();
}
async function sbPatch(pathQs: string, body: unknown): Promise<any[]> {
  const r = await fetch(SB_URL + '/rest/v1/' + pathQs, { method: 'PATCH', headers: sbHead, body: JSON.stringify(body) });
  if (!r.ok) throw new Error('db patch ' + pathQs + ': ' + (await r.text()));
  return await r.json();
}
async function sbInsert(table: string, body: unknown): Promise<any[]> {
  const r = await fetch(SB_URL + '/rest/v1/' + table, { method: 'POST', headers: sbHead, body: JSON.stringify(body) });
  if (!r.ok) throw new Error('db insert ' + table + ': ' + (await r.text()));
  return await r.json();
}
async function sbUploadSlip(path: string, bytes: Uint8Array): Promise<string | null> {
  const r = await fetch(SB_URL + '/storage/v1/object/slips/' + path, {
    method: 'POST',
    headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'image/jpeg', 'x-upsert': 'true' },
    body: bytes as unknown as BodyInit,
  });
  if (!r.ok) { console.error('upload slip fail:', await r.text()); return null; }
  return SB_URL + '/storage/v1/object/public/slips/' + path;
}

const rosterOf = (gid: string): Promise<Cust[]> =>
  sbGet('customers?line_group_id=eq.' + encodeURIComponent(gid) + '&select=id,code,name,branch_name&order=code') as Promise<Cust[]>;

async function unpaidBills(gid: string): Promise<Bill[]> {
  const rows = await sbGet(
    'bills?select=id,bill_no,total,paid_amount,payment_status,ship_status,created_at,' +
    'customers!inner(code,name,branch_name,line_group_id)' +
    '&customers.line_group_id=eq.' + encodeURIComponent(gid) +
    '&payment_status=neq.paid&order=created_at.asc');
  return (rows as Bill[]).filter((b) => b.ship_status !== 'cancelled' && outOf(b) > EPS);
}

async function centralNotify(text: string) {
  try {
    const st = await sbGet('settings?key=eq.line_central_group&select=value');
    const gid = st?.[0]?.value; if (!gid) return;
    await linePush(gid, [{ type: 'text', text }]);
  } catch (e) { console.error('central notify fail:', e); }
}

// ---------- SlipOK ----------
async function slipokVerify(bytes: Uint8Array): Promise<any | null> {
  if (!SLIPOK_URL || !SLIPOK_KEY) return null;
  const fd = new FormData();
  fd.append('files', new Blob([bytes as unknown as BlobPart], { type: 'image/jpeg' }), 'slip.jpg');
  fd.append('log', 'true');
  const r = await fetch(SLIPOK_URL, { method: 'POST', headers: { 'x-authorization': SLIPOK_KEY }, body: fd });
  let j: any = null;
  try { j = await r.json(); } catch { return null; }
  if (!r.ok || !j?.success || j?.data?.success === false) {
    console.error('slipok reject:', r.status, JSON.stringify(j).slice(0, 600)); // เหตุผลจาก SlipOK เช่น ผู้รับไม่ตรงบัญชีที่ลงทะเบียน/สลิปปลอม
    return null;
  }
  return j.data;
}

// ---------- ตัดยอดเข้าบิล 1 ใบ ----------
async function applyPay(b: Bill, pay: number, slipRef: string, slipUrl: string | null) {
  const newPaid = +(Number(b.paid_amount || 0) + pay).toFixed(2);
  const paidFull = newPaid >= Number(b.total) - EPS;
  const body: any = {
    paid_amount: newPaid,
    payment_status: paidFull ? 'paid' : 'unpaid',
    slip_ref: slipRef,
    pay_method: 'transfer',
    paid_by: 'ลูกค้า (สลิปอัตโนมัติ)',
  };
  if (slipUrl) body.slip_url = slipUrl;
  await sbPatch('bills?id=eq.' + b.id, body);
  // บันทึกประวัติการชำระ (เก็บสลิปทุกใบ ไม่ทับกัน)
  try {
    await sbInsert('payments', {
      bill_id: b.id, amount: pay, method: 'transfer',
      slips: slipUrl ? [slipUrl] : [], trans_ref: slipRef,
      paid_by: 'ลูกค้า (สลิปอัตโนมัติ)',
      note: paidFull ? null : 'จ่ายบางส่วน',
    });
  } catch (e) { console.warn('payments log:', e); }
}

async function finishSlip(slipId: number, appliedAdd: number, billsNote: string, leftover: number) {
  const row = (await sbGet('slip_log?id=eq.' + slipId + '&select=applied_total,applied_bills'))[0];
  const appliedTotal = +(Number(row?.applied_total || 0) + appliedAdd).toFixed(2);
  const note = (row?.applied_bills ? row.applied_bills + ', ' : '') + billsNote;
  await sbPatch('slip_log?id=eq.' + slipId, {
    applied_total: appliedTotal,
    applied_bills: note,
    status: leftover > EPS ? 'over' : 'applied',
  });
}

function askMessage(slipId: number, amount: number, bills: Bill[]) {
  const items: any[] = bills.slice(0, 12).map((b) => ({
    type: 'action',
    action: {
      type: 'postback',
      label: billBtnLabel(b),
      data: 'sp|' + slipId + '|' + b.id,
      displayText: 'ชำระบิล ' + b.bill_no,
    },
  }));
  items.push({
    type: 'action',
    action: { type: 'postback', label: 'ให้แอดมินจัดการ', data: 'sp|' + slipId + '|admin', displayText: 'ให้แอดมินจัดการ' },
  });
  const list = bills.slice(0, 12).map((b) =>
    '\u2022 ' + b.bill_no + ' ค้าง ' + fmtB(outOf(b)) + ' (' + (b.customers?.name || '') + (b.customers?.branch_name ? ' \u2022 ' + b.customers.branch_name : '') + ')').join('\n');
  return {
    type: 'text',
    text: '💰 ได้รับสลิปยอด ' + fmtB(amount) + '\nมีบิลค้างชำระหลายรายการ:\n' + list +
      '\n\nกดเลือกด้านล่างว่าชำระบิลไหนครับ 👇',
    quickReply: { items },
  };
}

// ---------- ลูกค้าส่งรูปเข้ากลุ่ม ----------
async function handleImage(ev: any) {
  const gid = ev.source?.groupId || ev.source?.roomId;
  if (!gid) { console.log('slip skip: not a group message'); return; }
  if (!SLIPOK_URL || !SLIPOK_KEY) { console.log('slip skip: SLIPOK secrets not set'); return; }
  // กลุ่มนี้ผูกร้านไหม — ไม่ผูกก็ไม่ยุ่งกับรูป
  const shops = await rosterOf(gid);
  if (!shops.length) { console.log('slip skip: group not bound to any shop', gid); return; }

  const bytes = await lineContent(ev.message.id);
  if (!bytes) { console.error('slip skip: cannot download image from LINE'); return; }
  const slip = await slipokVerify(bytes);
  if (!slip) return; // ไม่ใช่สลิป/ตรวจไม่ผ่าน → เงียบ (เหตุผลถูกพิมพ์ลง Logs โดย slipokVerify แล้ว)

  const amount = Number(slip.amount || 0);
  const transRef = String(slip.transRef || slip.transactionId || '');
  if (!transRef || !(amount > 0)) { console.error('slip skip: no transRef/amount in response', JSON.stringify(slip).slice(0, 400)); return; }

  // กันสลิปเวียนทั้งระบบ
  const dup = await sbGet('slip_log?trans_ref=eq.' + encodeURIComponent(transRef) + '&select=id,status,applied_bills,amount');
  if (dup.length) {
    await lineReply(ev.replyToken, '🚨 สลิปนี้เคยส่งเข้าระบบแล้ว (ยอด ' + fmtB(Number(dup[0].amount)) +
      (dup[0].applied_bills ? ' \u2192 ' + dup[0].applied_bills : '') + ')\nหากไม่ถูกต้องกรุณาติดต่อแอดมินครับ');
    return;
  }

  const slipUrl = await sbUploadSlip('auto/' + transRef + '.jpg', bytes);
  const logRow = (await sbInsert('slip_log', {
    trans_ref: transRef, group_id: gid, amount,
    bank: slip.sendingBank || '', trans_date: slip.transDate || '', trans_time: slip.transTime || '',
    sender_name: slip.sender?.displayName || slip.sender?.name || '',
    receiver_name: slip.receiver?.displayName || slip.receiver?.name || '',
    image_path: slipUrl || '', raw: slip, status: 'pending',
  }))[0];

  const bills = await unpaidBills(gid);
  const plan = planPayment(amount, bills);

  if (plan.mode === 'none') {
    await sbPatch('slip_log?id=eq.' + logRow.id, { status: 'over' });
    await lineReply(ev.replyToken, '💰 ได้รับสลิปยอด ' + fmtB(amount) + '\nตอนนี้ไม่มีบิลค้างชำระในกลุ่มนี้ แอดมินจะตรวจสอบและติดต่อกลับครับ 🙏');
    await centralNotify('\u26a0\ufe0f สลิปไม่มีบิลรองรับ ' + fmtB(amount) + '\nกลุ่มของ: ' + shops.map(shopLabel).join(', ') + '\nref ' + transRef);
    return;
  }
  if (plan.mode === 'ask') {
    await lineReplyMsgs(ev.replyToken, [askMessage(logRow.id, amount, bills)]);
    return;
  }
  // single / all → ตัดยอดเลย
  for (const a of plan.alloc) await applyPay(a.bill, a.pay, transRef, slipUrl);
  const note = plan.alloc.map((a) => a.bill.bill_no + '(+' + a.pay.toFixed(2) + ')').join(', ');
  await finishSlip(logRow.id, amount - plan.leftover, note, plan.leftover);
  let msg = '💳 สลิปยอด ' + fmtB(amount) + ' ตัดชำระ ' + plan.alloc.length + ' บิล ดังนี้\n' + fmtPaidLines(plan.alloc);
  if (plan.leftover > EPS) msg += '\n\u26a0\ufe0f ยอดโอนเกิน ' + fmtB(plan.leftover) + ' — แอดมินจะติดต่อกลับครับ';
  msg += '\nขอบคุณครับ 🙏';
  await lineReply(ev.replyToken, msg);
  await centralNotify('🤖 ตัดยอดอัตโนมัติ ' + fmtB(amount - plan.leftover) + '\n' + note +
    (plan.leftover > EPS ? '\n\u26a0\ufe0f เกิน ' + fmtB(plan.leftover) : '') + '\nref ' + transRef);
}

// ---------- ลูกค้ากดปุ่มเลือกบิล ----------
async function handlePostback(ev: any) {
  const gid = ev.source?.groupId || ev.source?.roomId;
  const parts = String(ev.postback?.data || '').split('|');
  if (parts[0] !== 'sp' || !gid) return;
  const slipId = Number(parts[1]); const pick = parts[2];
  const log = (await sbGet('slip_log?id=eq.' + slipId + '&select=*'))[0];
  if (!log) return;
  if (log.status !== 'pending') {
    await lineReply(ev.replyToken, 'ℹ️ สลิปใบนี้จัดการเรียบร้อยแล้วครับ' + (log.applied_bills ? ' (' + log.applied_bills + ')' : ''));
    return;
  }
  const leftover = +(Number(log.amount) - Number(log.applied_total || 0)).toFixed(2);
  if (pick === 'admin') {
    await centralNotify('🙋 ลูกค้าขอให้แอดมินจัดการสลิป ' + fmtB(leftover) + '\nref ' + log.trans_ref);
    await lineReply(ev.replyToken, 'รับทราบครับ แจ้งแอดมินให้แล้ว รอสักครู่นะครับ 🙏');
    return;
  }
  const bills = await unpaidBills(gid);
  const b = bills.find((x) => x.id === Number(pick));
  if (!b) { await lineReply(ev.replyToken, 'บิลนี้ไม่อยู่ในรายการค้างแล้วครับ ลองเลือกใหม่อีกครั้ง'); return; }

  const pay = Math.min(leftover, outOf(b));
  await applyPay(b, pay, log.trans_ref, log.image_path || null);
  const newLeft = +(leftover - pay).toFixed(2);
  await finishSlip(slipId, pay, b.bill_no + '(+' + pay.toFixed(2) + ')', newLeft);
  let msg = fmtPaidLines([{ bill: b, pay }]);
  await centralNotify('🤖 ตัดยอด (ลูกค้าเลือกบิล) ' + fmtB(pay) + ' \u2192 ' + b.bill_no + '\nref ' + log.trans_ref);

  if (newLeft > EPS) {
    const remain = (await unpaidBills(gid)).filter((x) => x.id !== b.id);
    if (remain.length) {
      // ยังเหลือยอด + ยังมีบิลอื่น → คงสถานะ pending แล้วถามต่อ
      await sbPatch('slip_log?id=eq.' + slipId, { status: 'pending' });
      await lineReplyMsgs(ev.replyToken, [
        { type: 'text', text: msg },
        askMessage(slipId, newLeft, remain),
      ]);
      return;
    }
    msg += '\n\u26a0\ufe0f ยอดคงเหลือ ' + fmtB(newLeft) + ' — แอดมินจะติดต่อกลับครับ';
    await centralNotify('\u26a0\ufe0f ยอดสลิปเหลือ ' + fmtB(newLeft) + ' ไม่มีบิลรองรับ ref ' + log.trans_ref);
  }
  msg += '\nขอบคุณครับ 🙏';
  await lineReply(ev.replyToken, msg);
}

// ---------- คำสั่งข้อความ (จาก BETA 1) ----------
export function fmtRoster(list: Cust[]): string {
  if (!list.length) return '📋 กลุ่มนี้ยังไม่ได้ผูกร้านใด\nพิมพ์: ผูกกลุ่ม <รหัสลูกค้า>';
  const cap = 50;
  const lines = list.slice(0, cap).map((c) => '\u2022 ' + shopLabel(c));
  if (list.length > cap) lines.push('\u2026และอีก ' + (list.length - cap) + ' ร้าน');
  return '📋 กลุ่มนี้รับแจ้งเตือน ' + list.length + ' ร้าน:\n' + lines.join('\n');
}
export function fmtBindReply(bound: { c: Cust; moved: boolean }[], already: Cust[], notFound: string[], roster: Cust[]): string {
  const parts: string[] = [];
  if (bound.length)
    parts.push('✅ ผูกเข้ากลุ่มนี้แล้ว:\n' + bound.map((b) => '\u2022 ' + shopLabel(b.c) + (b.moved ? ' (ย้ายมาจากกลุ่มเดิม)' : '')).join('\n'));
  if (already.length) parts.push('ℹ️ ผูกอยู่แล้ว: ' + already.map((c) => c.code).join(', '));
  if (notFound.length) parts.push('❌ ไม่พบรหัส: ' + notFound.join(', '));
  if (!bound.length && !already.length && !notFound.length)
    parts.push('วิธีใช้: ผูกกลุ่ม <รหัสลูกค้า>\nผูกทีเดียวหลายร้านได้ เช่น\nผูกกลุ่ม SKG00001 SKG00002');
  if (bound.length) parts.push('ลิงก์สั่งซื้อ / บิล / สถานะออเดอร์ ของร้านข้างต้นจะถูกส่งเข้ากลุ่มนี้ครับ');
  parts.push(fmtRoster(roster));
  return parts.join('\n\n');
}
export function fmtUnbindReply(removed: Cust[], notHere: string[], roster: Cust[]): string {
  const parts: string[] = [];
  if (removed.length) parts.push('🗑️ ปลดออกจากกลุ่มนี้แล้ว:\n' + removed.map((c) => '\u2022 ' + shopLabel(c)).join('\n'));
  if (notHere.length) parts.push('❌ ไม่ได้ผูกกับกลุ่มนี้: ' + notHere.join(', '));
  if (!removed.length && !notHere.length) parts.push('วิธีใช้: ปลดกลุ่ม <รหัสลูกค้า>');
  parts.push(fmtRoster(roster));
  return parts.join('\n\n');
}

/** ฐาน URL เว็บสั่งซื้อ: จากตั้งค่า site_url หรือค่ามาตรฐาน */
async function siteBase(): Promise<string> {
  let base = 'https://thananant.github.io/Mix888/';
  try {
    const st = await sbGet('settings?key=eq.site_url&select=value');
    if (st?.[0]?.value) base = String(st[0].value).replace(/\/+$/, '') + '/';
  } catch (_) { /* ใช้ค่ามาตรฐาน */ }
  return base;
}

/** บล็อกลิงก์สั่งซื้อ + รหัส ต่อร้าน */
export function fmtLinkPin(rows: any[], base: string): string {
  const blocks = rows.map((c) => {
    const link = c.slug ? base + c.slug : (c.order_token ? base + '?t=' + encodeURIComponent(c.order_token) : '');
    return shopLabel(c) +
      (link ? '\n🛒 ลิงก์สั่งสินค้า 👇\n' + link : '') +
      (c.order_pin ? '\n🔐 รหัสยืนยันตอนกดสั่ง: ' + c.order_pin : '');
  }).filter(Boolean);
  if (!blocks.length) return '';
  return blocks.join('\n\n') +
    '\n\n(รหัสกรอกครั้งเดียว เครื่องเดิมจำให้)' +
    '\nเปลี่ยนรหัสเองได้ พิมพ์: เปลี่ยน <เลข 6 หลัก>';
}

async function handleCmd(cmd: Exclude<Cmd, null>, gid: string): Promise<string> {
  if (cmd.type === 'setgroup') {
    const exist = await sbGet('settings?key=eq.' + cmd.key + '&select=key');
    if (exist.length) await sbPatch('settings?key=eq.' + cmd.key, { value: gid });
    else await sbInsert('settings', { key: cmd.key, value: gid });
    return '✅ ตั้งกลุ่มนี้เป็น "' + cmd.label + '" เรียบร้อยครับ\nระบบจะส่งข้อความอัตโนมัติเข้ากลุ่มนี้ตั้งแต่ตอนนี้';
  }
  if (cmd.type === 'getlink') {
    const shops: any[] = await sbGet('customers?line_group_id=eq.' + encodeURIComponent(gid) +
      '&active=is.true&select=code,name,branch_name,order_pin,order_token,slug');
    if (!shops.length) return '📋 กลุ่มนี้ยังไม่ได้ผูกร้านใด\nพิมพ์: ผูกกลุ่ม <รหัสลูกค้า> ก่อนครับ';
    const body = fmtLinkPin(shops, await siteBase());
    return body || '⚠️ ร้านในกลุ่มนี้ยังไม่มีลิงก์สั่งซื้อ — แจ้งแอดมินให้สร้างลิงก์ก่อนครับ';
  }
  if (cmd.type === 'setpin' || cmd.type === 'newpin' || cmd.type === 'pinstatus') {
    const shops: any[] = await sbGet('customers?line_group_id=eq.' + encodeURIComponent(gid) +
      '&active=is.true&select=id,code,name,branch_name,order_pin');
    if (!shops.length) return '📋 กลุ่มนี้ยังไม่ได้ผูกร้านใด\nพิมพ์: ผูกกลุ่ม <รหัสลูกค้า> ก่อนตั้งรหัสครับ';

    if (cmd.type === 'pinstatus') {
      const lines = shops.map((c) =>
        '\u2022 ' + shopLabel(c) + ' — ' + (c.order_pin ? 'ตั้งรหัสแล้ว (' + maskPin(c.order_pin) + ')' : 'ยังไม่ได้ตั้ง'));
      return '🔐 สถานะรหัสยืนยันคำสั่งซื้อ\n' + lines.join('\n') +
        '\n\nตั้งรหัสครั้งแรก: พิมพ์เลข 6 หลัก เช่น 123456' +
        '\nเปลี่ยนรหัส: พิมพ์ เปลี่ยน 654321';
    }

    const already = shops.filter((c) => c.order_pin);
    if (cmd.type === 'setpin' && already.length === shops.length) {
      return '🔐 ร้านในกลุ่มนี้ตั้งรหัสไว้แล้ว\nถ้าต้องการเปลี่ยน พิมพ์: เปลี่ยน ' + cmd.pin;
    }
    const targets = cmd.type === 'newpin' ? shops : shops.filter((c) => !c.order_pin);
    for (const c of targets) {
      await sbPatch('customers?id=eq.' + c.id, { order_pin: cmd.pin, pin_updated_at: new Date().toISOString() });
    }
    await centralNotify((cmd.type === 'newpin' ? '🔄 เปลี่ยนรหัสสั่งซื้อ' : '🔐 ตั้งรหัสสั่งซื้อครั้งแรก') +
      '\n' + targets.map(shopLabel).join('\n') + '\nรหัสใหม่ ' + maskPin(cmd.pin) + ' (ตั้งจากกลุ่มไลน์ร้าน)');
    return (cmd.type === 'newpin' ? '🔄 เปลี่ยนรหัสเรียบร้อย' : '🔐 ตั้งรหัสเรียบร้อย') +
      ' (' + maskPin(cmd.pin) + ')\n' + targets.map((c) => '\u2022 ' + shopLabel(c)).join('\n') +
      '\n\nตั้งแต่นี้ไป เวลากดยืนยันสั่งสินค้าในเว็บ ต้องใส่รหัส 6 หลักนี้ครับ' +
      '\n(กรอกครั้งเดียว เครื่องเดิมจำให้ ไม่ต้องกรอกซ้ำ)' +
      '\nเปลี่ยนรหัสได้ตลอด พิมพ์: เปลี่ยน <เลข 6 หลัก>';
  }
  if (cmd.type === 'roster') return fmtRoster(await rosterOf(gid));
  if (cmd.type === 'due') return fmtDueReply(await unpaidBills(gid));
  if (cmd.type === 'gid') // ของเดิม: พิมพ์ id / กลุ่มไอดี
    return '🆔 Group ID ของกลุ่มนี้:\n' + gid +
      '\n\nคำสั่งที่ใช้ได้:\n\u2022 ผูกกลุ่ม <รหัส> [<รหัส2> ...] — ผูกได้หลายร้านในกลุ่มเดียว\n\u2022 ปลดกลุ่ม <รหัส> — ถอดทีละร้าน\n\u2022 ยกเลิกผูกกลุ่ม — ถอดทุกร้านออกจากกลุ่มนี้\n\u2022 เช็คกลุ่ม — ดูรายชื่อร้านในกลุ่ม\n\u2022 บิลค้าง — ดูบิลค้างชำระแยกตามร้าน';
  if (cmd.type === 'bind') {
    if (!cmd.codes.length) return fmtBindReply([], [], [], await rosterOf(gid));
    const found: any[] = await sbGet('customers?code=in.(' + cmd.codes.map(encodeURIComponent).join(',') + ')&select=id,code,name,branch_name,line_group_id');
    const foundCodes = new Set(found.map((c) => c.code));
    const notFound = cmd.codes.filter((c) => !foundCodes.has(c));
    const already = found.filter((c) => c.line_group_id === gid);
    const toBind = found.filter((c) => c.line_group_id !== gid);
    if (toBind.length) await sbPatch('customers?id=in.(' + toBind.map((c) => c.id).join(',') + ')', { line_group_id: gid });
    const bound = toBind.map((c) => ({ c, moved: !!c.line_group_id }));
    let reply = fmtBindReply(bound, already, notFound, await rosterOf(gid));
    // ผูกกลุ่มสำเร็จ → แนบลิงก์สั่งซื้อ + รหัสยืนยัน เข้ากลุ่มนี้เลย จบในข้อความเดียว
    if (toBind.length) {
      const rows: any[] = await sbGet('customers?id=in.(' + toBind.map((c) => c.id).join(',') +
        ')&select=code,name,branch_name,order_pin,order_token,slug');
      const body = fmtLinkPin(rows, await siteBase());
      if (body) reply += '\n\n' + body;
    }
    return reply;
  }
  if (!cmd.codes.length) { // ของเดิม: 'ยกเลิกผูกกลุ่ม' เปล่าๆ = ถอดทุกร้านออกจากกลุ่มนี้
    const bound = await rosterOf(gid);
    if (!bound.length) return 'กลุ่มนี้ยังไม่ได้ผูกกับลูกค้ารายใดครับ';
    await sbPatch('customers?line_group_id=eq.' + encodeURIComponent(gid), { line_group_id: null });
    return '🔓 ยกเลิกผูกกลุ่มกับ ' + bound.map((b) => '[' + b.code + '] ' + b.name).join(', ') + ' แล้วครับ' +
      '\n(รหัสยืนยันถูกยกเลิกด้วย — ร้านจะสั่งของได้โดยไม่ต้องใส่รหัส)';
  }
  const removed: any[] = await sbPatch(
    'customers?code=in.(' + cmd.codes.map(encodeURIComponent).join(',') + ')&line_group_id=eq.' + encodeURIComponent(gid),
    { line_group_id: null });
  const removedCodes = new Set(removed.map((c) => c.code));
  const notHere = cmd.codes.filter((c) => !removedCodes.has(c));
  return fmtUnbindReply(removed, notHere, await rosterOf(gid));
}

// ---------- ตรวจลายเซ็น webhook ----------
async function validSig(rawBody: string, sig: string | null): Promise<boolean> {
  if (!LINE_SECRET) return true;
  if (!sig) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(LINE_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  return btoa(String.fromCharCode(...new Uint8Array(mac))) === sig;
}

// ============================================================
// HTTP entry
// ============================================================
if (!Deno.env.get('LP_TEST')) Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  if (req.method === 'GET') {
    return J({
      ok: true, fn: 'line-push', version: VERSION,
      has_line_token: !!LINE_TOKEN, has_line_secret: !!LINE_SECRET,
      has_db: !!(SB_URL && SB_KEY),
      has_slipok: !!(SLIPOK_URL && SLIPOK_KEY),
    });
  }

  const raw = await req.text();
  let body: any = null;
  try { body = JSON.parse(raw); } catch { /* ปล่อยไป */ }
  if (!body) return J({ status: 400, error: 'bad json' }, 200);

  // ---------- webhook จาก LINE ----------
  if (Array.isArray(body.events)) {
    if (!(await validSig(raw, req.headers.get('x-line-signature'))))
      return J({ ok: false, error: 'bad signature' }, 403);
    for (const ev of body.events) {
      try {
        try { // ของเดิม: บันทึกทุก event ไว้ debug ย้อนหลัง
          await sbInsert('line_events', {
            source_type: ev.source?.type ?? null,
            group_id: ev.source?.groupId ?? null,
            user_id: ev.source?.userId ?? null,
            text: typeof ev.message?.text === 'string' ? ev.message.text.trim() : ev.type,
          });
        } catch (logErr) { console.error('line_events log fail:', logErr); }
        if (ev.type === 'postback') { await handlePostback(ev); continue; }
        if (ev.type !== 'message') continue;
        if (ev.message?.type === 'image') { await handleImage(ev); continue; }
        if (ev.message?.type !== 'text') continue;
        const gid = ev.source?.groupId || ev.source?.roomId;
        if (!gid) continue;
        const cmd = parseCmd(ev.message.text);
        if (!cmd) continue;
        const replyText = await handleCmd(cmd, gid);
        if (ev.replyToken) await lineReply(ev.replyToken, replyText);
      } catch (e) {
        console.error('webhook event error:', e);
        if (ev?.replyToken) { try { await lineReply(ev.replyToken, '\u26a0\ufe0f ระบบขัดข้องชั่วคราว ลองใหม่อีกครั้ง'); } catch { /* เงียบ */ } }
      }
    }
    return J({ ok: true });
  }

  // ---------- push จากหน้าเว็บ ----------
  if (body.to && Array.isArray(body.messages)) {
    if (!req.headers.get('apikey') && !req.headers.get('authorization'))
      return J({ status: 401, error: 'missing apikey' }, 200);
    if (!LINE_TOKEN) return J({ status: 500, error: 'LINE token not set' }, 200);
    const r = await linePush(body.to, body.messages);
    const detail = r.ok ? undefined : await r.text();
    return J({ status: r.status, ...(detail ? { error: detail } : {}) }, 200);
  }

  return J({ status: 400, error: 'unknown payload' }, 200);
});
