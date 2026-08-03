-- requeue_png_bills.sql — สั่งวาดหน้าบิลใหม่เป็น JPEG
-- ⚠️ ลำดับสำคัญมาก: deploy cron-41 ก่อน แล้วเปิด ?health=1 ต้องได้ "version":"cron-41" ค่อยรันไฟล์นี้
--    ถ้ารันตอนยังเป็น cron-40 มันจะวาดกลับเป็น PNG เสียเปล่าทั้งคิว แล้วต้องมารันไฟล์นี้ซ้ำอีกรอบ
--
-- ขอบเขต: เฉพาะบิลที่หน้า A4 ปัจจุบันเป็น PNG ที่ "เซิร์ฟเวอร์" วาด (path /bills/auto/…png) เท่านั้น
--    ห้ามใช้เงื่อนไข image_url ilike '%.png' เด็ดขาด — บิลที่คนออกจากหน้าเว็บมี "บิลยาว" เป็น PNG
--    ใน image_url แต่หน้า A4 ของมันเป็น JPEG (มีบาร์โค้ด) อยู่แล้ว requeue จะทำให้เซิร์ฟเวอร์วาดทับ
--    = หน้าแบบมีบาร์โค้ดหายทั้งคลัง (บทเรียนรีวิว 01/08/2569)
-- ไม่แตะใบส่งแล้ว (shipped ไม่เข้าสรุป/PDF อยู่แล้ว — requeue ไปก็เสียรอบเปล่า)
-- ไม่แตะใบยกเลิก/ออเดอร์ยกเลิก · ต้องมี order (ไม่มี order เซิร์ฟเวอร์วาดไม่ได้ จะค้างหัวคิวตลอด)
-- ⚠️ ห้าม set page_urls = null เด็ดขาด (NOT NULL constraint)
update bills b
   set image_url = null
 where b.page_urls::text ilike '%/bills/auto/%.png%'
   and b.order_id is not null
   and (b.ship_status is null or b.ship_status not in ('cancelled', 'shipped'))
   and not exists (select 1 from orders o where o.id = b.order_id and o.status = 'cancelled');

-- เช็คความคืบหน้า "ของจริง" (ลด ~6 ใบ/ชม. จนถึง 0) — ห้ามใช้ count image_url is null
-- เพราะใบที่ถอยไป PNG จะออกจากคิวทั้งที่ยังไม่เป็น JPEG ตัวเลขนั้นจะดูเสร็จทั้งที่ยังไม่เสร็จ:
-- select count(*) from bills
--  where page_urls::text ilike '%/bills/auto/%.png%'
--    and (ship_status is null or ship_status not in ('cancelled', 'shipped'));
