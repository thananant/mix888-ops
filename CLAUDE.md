# Mix888 ops — กติกาการทำงาน

## ผู้ใช้สั่งงานจาก iPhone (ตั้งแต่ 9 ต.ค. 2569)
- ผู้ใช้สั่งงานผ่านแอป Claude บน iPhone ไม่มีเครื่องคอมไว้ดูไฟล์ในเครื่อง
- **งานทุกชิ้นที่สร้างหรือแก้ ต้องอัปขึ้น GitHub ทุกครั้ง โดยไม่ต้องถาม:** commit → push branch → เปิด PR → merge เข้า `main`
- เสร็จแล้วส่ง **ลิงก์ที่กดเปิดบนมือถือได้** กลับไปเสมอ:
  - หน้าเว็บ: `https://thananant.github.io/mix888-ops/<path>/` (GitHub Pages เปิดจาก `main` / root)
  - ไฟล์อื่น (xlsx, csv ฯลฯ): `https://github.com/thananant/mix888-ops/blob/main/<path>`
- ตอบเป็นภาษาไทย สั้น อ่านง่ายบนจอมือถือ
- ข้อความที่พิมพ์มาแบบอักษรอังกฤษอ่านไม่ออก มักเป็นภาษาไทยที่ลืมสลับแป้น (เช่น `wfhc]t` = "ได้แล้ว")

## ข้อควรระวัง
- repo นี้เป็น **Public** ทุกไฟล์ใน repo ใครก็เปิดดูได้ ห้ามใส่ key, password, token หรือข้อมูลลับลง repo
- `hotel-leads/` เป็นงานของ **keys** (ระบบสำหรับโรงแรมที่ใช้ Cloudbeds) **ไม่เกี่ยวกับ Mix888 หรือจริงใจหมูกระทะ** ห้ามใช้ Supabase/LINE ของ Mix888 กับงานนี้
  - กำลังจะย้ายไป repo `thananant/keys-leads` (รอผู้ใช้สร้าง repo ตาม `hotel-leads/SETUP.md`)
- Backend ของ keys: Supabase project **cloudbeds-rm** (`vauqbfjgkdhgrtycqhnd`)
  - edge function `keys-crm` และตาราง `crm_*`
  - รหัสทีมกับ cron key อยู่ใน `crm_settings` เท่านั้น ห้ามใส่ลง repo
  - รายละเอียดอยู่ใน `hotel-leads/SETUP.md`

## งานใน repo
- `hotel-leads/` — Cloudbeds Lead Finder: โรงแรมในกรุงเทพฯ ที่ใช้ Cloudbeds (52 แห่ง) แยกตามเขต ดาว รีวิว ราคา
  - หน้าเว็บ: https://thananant.github.io/mix888-ops/hotel-leads/
  - แก้ข้อมูลหรือหน้าตา: แก้ `lead-finder.template.html` (มี `__DATA__` เป็นตัวแทนข้อมูล) แล้ว build ออกมาเป็น `index.html` (มี doctype สำหรับ Pages) และ `lead-finder.html` (สำหรับ claude.ai artifact)
  - เวอร์ชัน claude.ai (สถานะลูกค้าเห็นตรงกันทุกคน): https://claude.ai/artifact/PkrMvU3M6VFaSYinbcSyXx
