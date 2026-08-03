-- claim_dedup.sql — กำแพงกันส่งซ้ำระดับฐานข้อมูล (คู่กับ cron-44)
-- ⚠️ ลำดับ: deploy cron-44 "ก่อน" แล้วค่อยรันไฟล์นี้
--    (ถ้าสร้าง index ตอน cron-43/42 ยังรันอยู่ การเขียน log ท้ายรอบอาจชน index แล้วถูกกลืน
--     → log หาย → ยามส่งซ้ำใน 15 นาที — ตรงข้ามกับที่ตั้งใจ)

-- 1) ล้าง "ใบจองค้าง" ที่มีบันทึกจริงคู่กันก่อนเสมอ — กันขั้นถัดไปเผลอเก็บใบจอง (id ต่ำกว่า)
--    แล้วลบบันทึกจริงทิ้ง (จะทำให้รอบที่ส่งแล้วถูกมองว่ายังไม่ส่ง → ส่งซ้ำ)
delete from summary_log a
 using summary_log b
 where a.mode = 'cron' and b.mode = 'cron'
   and a.range_start = b.range_start
   and a.sent_by = 'กำลังส่ง…' and b.sent_by <> 'กำลังส่ง…';

-- 2) ล้างแถว cron ที่ range_start ซ้ำกัน (เก็บแถวแรกสุดไว้) — ต้องล้างก่อน ไม่งั้นสร้าง index ไม่ผ่าน
delete from summary_log a
 using summary_log b
 where a.mode = 'cron' and b.mode = 'cron'
   and a.range_start = b.range_start
   and a.id > b.id;

-- 3) กำแพง: หนึ่งรอบตัด (range_start เดียวกัน) มีบันทึก cron ได้แถวเดียวตลอดกาล
--    ใครแทรกซ้ำจะโดนฐานข้อมูลปัดตกทันที (cron-44 ใช้ตัวนี้เป็นตัวตัดสินใบจอง)
create unique index if not exists summary_log_cron_round_uq
  on summary_log (range_start)
  where mode = 'cron';

-- เช็คผล: ต้องเห็น index ใหม่
-- select indexname from pg_indexes where tablename = 'summary_log';
