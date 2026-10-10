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
- งานของ **keys** (หาลูกค้าโรงแรม Cloudbeds) ย้ายไป repo `thananant/keys-leads` แล้ว ไม่เกี่ยวกับ Mix888 ห้ามใส่กลับมาใน repo นี้

## งานใน repo
- `hotel-leads/index.html` เหลือแค่หน้าพาไป https://thananant.github.io/keys-leads/ (สำหรับลิงก์เก่า)
