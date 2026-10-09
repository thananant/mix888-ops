// Edge Function: keys-crm  (Supabase project: cloudbeds-rm)
// Backend for the keys Lead Finder CRM page.
//
//   GET  ?action=list                 header x-team-code  -> all lead documents
//   POST ?action=save   {id, data}    header x-team-code  -> upsert one lead
//   POST ?action=remind&slot=morning|evening  header x-cron-key -> LINE reminders
//   POST ?action=line-webhook         (LINE platform)     -> remembers group ids the bot joins
//   GET  ?action=health                                   -> config status (no secrets)
//
// Stored in table crm_settings (service-role only, never in the repo):
//   team_code_sha256     SHA-256 of the code the sales team types once on the page
//   cron_key             shared key for the pg_cron reminder call
// Edge Function secrets:
//   LINE_TOKEN           channel access token of the keys LINE OA   (optional until the OA exists)
//   LINE_CHANNEL_SECRET  channel secret, verifies webhook signatures (optional until the OA exists)
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-team-code",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

function safeEqual(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ---------- LINE helpers
async function linePush(to: string, text: string) {
  const token = Deno.env.get("LINE_TOKEN");
  if (!token) return { ok: false, error: "LINE_TOKEN not set" };
  const r = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: JSON.stringify({ to, messages: [{ type: "text", text: text.slice(0, 4900) }] }),
  });
  return { ok: r.ok, status: r.status, body: r.ok ? undefined : await r.text() };
}
async function verifyLineSignature(raw: string, sig: string | null) {
  const secret = Deno.env.get("LINE_CHANNEL_SECRET");
  if (!secret || !sig) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  const b64 = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return safeEqual(b64, sig);
}
async function setting(key: string) {
  const { data } = await db.from("crm_settings").select("value").eq("key", key).maybeSingle();
  return data?.value;
}
async function sha256(t: string) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function getGroups(): Promise<string[]> {
  const { data } = await db.from("crm_settings").select("value").eq("key", "line_groups").maybeSingle();
  return Array.isArray(data?.value) ? data!.value.map((g: { id: string }) => g.id) : [];
}

// ---------- reminder text
type Appt = { id: string; date: string; time?: string; type?: string; with?: string; note?: string; done?: boolean };
type Lead = { id: string; data: { name?: string; appts?: Appt[]; contact?: string; next?: string; stage?: string } };

function bangkokDate(offsetDays = 0) {
  const d = new Date(Date.now() + 7 * 3600e3 + offsetDays * 864e5);
  return d.toISOString().slice(0, 10);
}
const TH_MONTH = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
const thDate = (s: string) => { const [y, m, d] = s.split("-").map(Number); return `${d} ${TH_MONTH[m - 1]} ${y + 543}`; };

async function buildReminder(slot: "morning" | "evening") {
  const day = slot === "morning" ? bangkokDate(0) : bangkokDate(1);
  const { data: leads } = await db.from("crm_leads").select("id, data");
  const { data: names } = await db.from("crm_settings").select("value").eq("key", "hotel_names").maybeSingle();
  const nameOf = (id: string) => (names?.value as Record<string, string> | undefined)?.[id] || id;
  const items: { time: string; line: string }[] = [];
  for (const l of (leads || []) as Lead[]) {
    for (const a of l.data?.appts || []) {
      if (a.done || a.date !== day) continue;
      const parts = [`🕘 ${a.time || "--:--"}  ${l.data?.name || nameOf(l.id)}`, `   ${a.type || "นัดหมาย"}${a.with ? " · " + a.with : ""}`];
      if (a.note) parts.push(`   📝 ${a.note}`);
      items.push({ time: a.time || "99:99", line: parts.join("\n") });
    }
  }
  items.sort((a, b) => a.time.localeCompare(b.time));
  if (!items.length) return { day, text: "" };
  const head = slot === "morning" ? `📅 นัดวันนี้ ${thDate(day)} (${items.length} นัด)` : `⏰ เตือนล่วงหน้า: นัดพรุ่งนี้ ${thDate(day)} (${items.length} นัด)`;
  return { day, text: [head, "", ...items.map((i) => i.line), "", "เปิดดูรายละเอียด: https://thananant.github.io/keys-leads/"].join("\n") };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);
  const action = url.searchParams.get("action") || "";

  try {
    if (action === "health") {
      const groups = await getGroups();
      return json({ ok: true, team_code: !!(await setting("team_code_sha256")), line_token: !!Deno.env.get("LINE_TOKEN"), line_secret: !!Deno.env.get("LINE_CHANNEL_SECRET"), line_groups: groups.length });
    }

    if (action === "line-webhook") {
      const raw = await req.text();
      if (!(await verifyLineSignature(raw, req.headers.get("x-line-signature")))) return json({ error: "bad signature" }, 401);
      const body = JSON.parse(raw || "{}");
      for (const ev of body.events || []) {
        const src = ev.source || {};
        const gid = src.groupId || src.roomId;
        if (!gid) continue;
        const { data } = await db.from("crm_settings").select("value").eq("key", "line_groups").maybeSingle();
        let groups: { id: string; joined: boolean; at: string }[] = Array.isArray(data?.value) ? data!.value : [];
        groups = groups.filter((g) => g.id !== gid);
        if (ev.type !== "leave") groups.push({ id: gid, joined: true, at: new Date().toISOString() });
        await db.from("crm_settings").upsert({ key: "line_groups", value: groups, updated_at: new Date().toISOString() });
        if (ev.type === "join") await linePush(gid, "สวัสดีครับ บอท keys จะแจ้งนัดหมายลูกค้าในกลุ่มนี้ทุกวัน 08:00 (นัดวันนี้) และ 18:00 (นัดพรุ่งนี้) ✅");
      }
      return json({ ok: true });
    }

    if (action === "remind") {
      const gotKey = req.headers.get("x-cron-key") || "", wantKey = String((await setting("cron_key")) || "");
      if (!safeEqual(gotKey, wantKey)) return json({ error: "forbidden", got: gotKey.length, want: wantKey.length }, 403);
      const slot = url.searchParams.get("slot") === "evening" ? "evening" : "morning";
      const force = url.searchParams.get("force") === "1";
      const { day, text } = await buildReminder(slot);
      if (!text) return json({ ok: true, sent: 0, reason: "no appointments", day });
      const groups = await getGroups();
      if (!Deno.env.get("LINE_TOKEN") || !groups.length) return json({ ok: false, sent: 0, reason: "LINE bot not set up yet", groups: groups.length, day, preview: text });
      const today = bangkokDate(0);
      if (!force) {
        const { error } = await db.from("crm_reminder_log").insert({ sent_on: today, slot });
        if (error) return json({ ok: true, sent: 0, reason: "already sent", day });
      }
      const results = [];
      for (const g of groups) results.push(await linePush(g, text));
      await db.from("crm_reminder_log").update({ detail: { day, groups: groups.length, results } }).eq("sent_on", today).eq("slot", slot);
      return json({ ok: true, sent: results.filter((r) => r.ok).length, groups: groups.length, day, results });
    }

    // --- team endpoints
    const want = String((await setting("team_code_sha256")) || "");
    if (!safeEqual(await sha256((req.headers.get("x-team-code") || "").trim().toUpperCase()), want)) return json({ error: "wrong team code" }, 401);

    if (action === "list") {
      const { data, error } = await db.from("crm_leads").select("id, data, updated_at");
      if (error) throw error;
      return json({ ok: true, leads: data });
    }
    if (action === "save" && req.method === "POST") {
      const { id, data } = await req.json();
      if (typeof id !== "string" || !/^[A-Za-z0-9]{3,40}$/.test(id) || typeof data !== "object" || !data) return json({ error: "bad input" }, 400);
      if (JSON.stringify(data).length > 200_000) return json({ error: "too large" }, 413);
      const { error } = await db.from("crm_leads").upsert({ id, data, updated_at: new Date().toISOString() });
      if (error) throw error;
      return json({ ok: true });
    }
    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
