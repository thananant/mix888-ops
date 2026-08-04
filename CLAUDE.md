# Mix888 (Mix Fresh 168) — ระบบสั่งสินค้า B2B

> ไฟล์นี้ sync ผ่าน OneDrive — Claude Code ทุกเครื่องอ่านอัตโนมัติตอนเปิด session ใหม่
> อัปเดตล่าสุด: 04 ส.ค. 2569 (บ่าย — เพิ่มข้อมูล line-push/SlipOK)

## Git repos (ตั้งค่า 04/08/2569)
- `origin` = **github.com/thananant/mix888-ops (Private)** — repo ของโฟลเดอร์นี้ ใช้เปิด cloud session/ทำงานข้ามเครื่อง · จบงานสำคัญให้ commit+push เสมอ
- `pages` = **github.com/thananant/Mix888 (Public — GitHub Pages เว็บหลังบ้านตัวจริง)** — ⚠️ ห้าม push ไฟล์ ops ไป repo นี้เด็ดขาด (ทุกไฟล์ในนั้นเผยแพร่สาธารณะ) ใช้เฉพาะตอนแก้ไฟล์เว็บ (wnqz-6e9u-j4ym.html ฯลฯ)

## สถาปัตยกรรม
- **หน้าเว็บหลังบ้าน**: `wnqz-6e9u-j4ym.html` บน GitHub Pages (ไฟล์เวอร์ชันต่าง ๆ อยู่ใน Downloads ของเครื่องบ้าน) — build marker มุมซ้ายบน **ต้อง bump ทุกครั้งที่แก้**
- **Supabase** `eqbzpgynzgdwvouuzfwt` — DB + Storage (bucket `bills`, `slips`) + edge functions `daily-summary`, `line-push`
- **Edge daily-summary ปัจจุบัน: cron-47** (ไฟล์เต็มล่าสุดในโฟลเดอร์นี้ `daily-summary.cron47.ts`) — เช็คด้วย `?health=1`
- **Edge line-push ปัจจุบัน: merged-10** (ไฟล์เต็ม `line-push.merged-10.ts`) — LINE webhook + push จากหน้าเว็บ + **ตรวจสลิปอัตโนมัติผ่าน SlipOK**: ลูกค้าส่งรูปสลิปเข้ากลุ่มที่ผูกร้าน → ตรวจกับธนาคาร → กันสลิปซ้ำ (`slip_log.trans_ref`) → ยอดตรงบิลเดียว/ตรงผลรวมทุกบิล = ตัดปิดอัตโนมัติ · หลายบิลไม่ตรงเป๊ะ = ปุ่ม quick reply ให้ลูกค้าเลือกบิล · ทุกการตัดแจ้งกลุ่มไลน์กลาง (`settings.line_central_group`) · Secrets: `SLIPOK_API_KEY` `SLIPOK_BRANCH_ID` · เช็คเวอร์ชันด้วย GET เปล่า
- **คำสั่งพิมพ์ในกลุ่มไลน์** (line-push): `ผูกกลุ่ม <รหัส>…` / `ปลดกลุ่ม <รหัส>` / `ยกเลิกผูกกลุ่ม` (เปล่า = ถอดทุกร้าน) / `เช็คกลุ่ม` / `id` / `บิลค้าง` / เลข 6 หลัก หรือ `รหัส 123456` = ตั้ง PIN ครั้งแรก / `เปลี่ยน 654321` = เปลี่ยน PIN / `รหัส` = ดูสถานะ PIN / `ขอลิงก์` = ลิงก์สั่งซื้อ+PIN / แอดมิน: `ตั้งกลุ่มสรุป` `ตั้งกลุ่มแพ็คของ` `ตั้งกลุ่มเรียกของ`
- **NAS DS925+** container `mix888-renderer` (โฟลเดอร์ `nas-renderer/` + บน NAS ที่ `Mix888/mix888-renderer`) — วาดรูปบิลเทมเพลต 2 (บาร์โค้ด/ลายเซ็น) ~1.4 วิ/ใบ; edge เป็น fallback วาดเทมเพลตเรียบง่ายเมื่อบิลค้างเกิน 10 นาที (สวิตช์ `nas_mode` ใน settings)

## รอบงานอัตโนมัติ
- **ออกบิล**: trigger ตอน order เข้า + pg_cron `autobill-every-10min` (ตอนนี้ `1-59/3` — เว้นนาทีที่ :00)
- **รอบสรุป 06:00**: pg_cron `daily-summary-2am` ยิง `?watchdog=1` ทุก 15 นาที — ส่งจริงเฉพาะชั่วโมงแรกหลังเวลาตัดรอบ (อ่านจาก settings `summary_cutoff`) · ข้ามวันอาทิตย์/วันหยุด · ส่งเข้ากลุ่ม LINE แบบ **PDF-only** (`summary_bill_mode='pdf'`)
- **กันส่งซ้ำ**: ระบบ "จองก่อนส่ง" + unique index `summary_log_cron_round_uq` (partial, mode='cron') — อย่าแตะ logic นี้โดยไม่อ่านคอมเมนต์ใน ds.ts ก่อน

## กติกาส่งงาน (สำคัญ)
- ส่ง**ไฟล์เต็มเสมอ** ไม่มี placeholder · แก้ทีละขั้น
- ds.ts ผ่าน `deno check` ด้วย stub: `npx -y deno check --import-map=import_map.stub.json <file>` (stub อยู่โฟลเดอร์นี้)
- SQL ผ่าน parser libpg_query (npm `pgsql-parser`) · JS ผ่าน `node --check`
- Storage key ห้ามมีอักษรไทย · PostgREST `not.eq` ไม่รวม NULL ใช้ `or=(col.is.null,col.neq.x)` · `bills.page_urls` NOT NULL ห้าม set null
- ตัดคำไทยในโค้ดวาดรูป: ห้ามหั่นแยกสระ/วรรณยุกต์จากพยัญชนะ (มี helper `cutAt`/`wrap2` ใน ds.ts แล้ว)

## การเข้าถึง/ตรวจสอบ
- Base: `https://eqbzpgynzgdwvouuzfwt.supabase.co/functions/v1/daily-summary`
  - `?health=1` เวอร์ชัน · `?preview=1&force=1&start=YYYY-MM-DDT06:00&end=...` ซ้อมไม่ส่งจริง (แต่สร้าง PDF จริง) · `?autobill=1` ออกบิล+วาด 1 ใบ
  - ยิง URL เปล่านอกชั่วโมงส่ง = ถูกปัดตก (by design ตั้งแต่ cron-45)
- Publishable key อยู่ใน work.html — RLS บังทุกตาราง (ใช้ endpoint ข้างบนแทน) แต่ **storage list เปิดได้**: `POST /storage/v1/object/list/bills` ด้วย publishable key
- Deploy edge = วางไฟล์เต็มใน dashboard · SQL = SQL Editor (ล้างแท็บก่อนวาง)

## ไฟล์ในโฟลเดอร์นี้
- `daily-summary.cron41-47.ts` — ประวัติเวอร์ชัน edge (47 = ล่าสุด)
- `line-push.merged-10.ts` — edge function LINE webhook/บอทไลน์ + ตรวจสลิป SlipOK (merged-10 = ตัวที่ deploy อยู่ เก็บเข้า repo 04/08/2569)
- `wnqz-6e9u-j4ym.html` — สำเนาเว็บหลังบ้าน (ตัวจริง deploy อยู่ที่ repo `Mix888`/GitHub Pages) — **build 04/08-A**: แก้ Excel บัญชีแถวหายจากเพดาน PostgREST 1,000 แถว (`exportMonthExcel`/`exportAccountXlsx` เปลี่ยนเป็นแบ่งถาม+ไล่หน้า) + ใบโอน/ใบสั่งซื้อแบ่งชื่อยาว 2 บรรทัดด้วย `tfWrap2` เลิกตัด "…" (ตามที่ทีมแพ็คขอ ให้ตรงกับ edge cron-46)
- `nas-renderer/` — ตัววาดบน NAS (SETUP-NAS.md = คู่มือติดตั้ง)
- `claim_dedup.sql` `watchdog_cron.sql` `nas_mode.sql` `requeue_png_bills.sql` — รันไปแล้ว
- `move_customers_template.sql` — **ยังไม่ได้ใช้** รอมีเซลล์ลาออก (ย้ายลูกค้า+เปลี่ยนรหัส 3 ตัวหน้า — อ่านหมายเหตุในไฟล์: ปิดงวดคอมมิชชั่นก่อน + แก้ autobill_skip)

## งานค้าง
- **Deploy เว็บ build 04/08-A** — เอา `wnqz-6e9u-j4ym.html` ใน repo นี้ไปวางทับใน repo `Mix888` (ตอนนี้ production ยังเป็น 27/07-S ซึ่งมีบั๊ก Excel สรุปกำไรแถวหาย)
- คนสั่งออเดอร์ผ่านบอทไลน์ — ✅ ได้โค้ด webhook แล้ว (`line-push.merged-10.ts` 04/08/2569) เหลือดูว่าจะต่อยอดสั่งออเดอร์ผ่านแชทไหม (ตอนนี้บอทส่งลิงก์เว็บสั่งซื้อ+PIN ให้แทน)
- ปริ้นเตอร์ L3250 ส่งเมลอัตโนมัติ (รอ Brevo API key + อีเมลเครื่อง)
- ข้อเสนอ Supabase Pro (~$25/ด.) — ยังไม่ตัดสินใจ (ความจำเป็นลดลงมากหลังมี NAS)
- เปลี่ยน secret key ของ NAS (`nas-renderer/.env`) ตัวใหม่เมื่อสะดวก (ตัวเก่าเคยโผล่ในแชท)
