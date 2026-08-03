-- watchdog_cron.sql — เปลี่ยน job รอบสรุปจาก "ยิงวันละครั้ง 06:00" เป็น "ยามจิ้มทุก 15 นาที"
-- ⚠️ รันได้ต่อเมื่อ deploy cron-43 แล้วเท่านั้น (?health=1 ต้องได้ "version":"cron-43")
--    ถ้ารันตอนยังเป็น cron-42 ทุกนัดจะกลายเป็นรอบสรุปเต็ม เสี่ยงส่งหน้าต่างเศษซ้ำ
-- ผลลัพธ์: รอบส่งจริงยังออกที่นาทีแรกหลังเวลาตัดรอบเหมือนเดิม (นัด :00 ตรงเวลาตัดพอดี)
--    ถ้านัดนั้นตาย (CPU) นัดถัดไปกู้ให้เองภายใน ≤15 นาที · นอกช่วง 1 ชม.หลังตัดรอบ = no-op
--    เปลี่ยนเวลาตัดรอบใน settings (summary_cutoff/bill_cutoff) ได้เลย ยามเลื่อนตามอัตโนมัติ
select cron.alter_job(
  (select jobid from cron.job where jobname = 'daily-summary-2am'),
  schedule => '*/15 * * * *',
  command  => $cmd$
select net.http_post(
    url := 'https://eqbzpgynzgdwvouuzfwt.supabase.co/functions/v1/daily-summary?watchdog=1',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer sb_publishable_HqLNQDwR4omYcb7BNUEKIw_vyHCo4N-"}'::jsonb,
    body := '{"trigger":"watchdog-15min"}'::jsonb);
$cmd$
);

-- เช็คผล: schedule ต้องเป็น */15 * * * * และ command ต้องมี ?watchdog=1
-- select jobname, schedule, command from cron.job where jobname = 'daily-summary-2am';
