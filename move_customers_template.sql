-- move_customers_template.sql — ย้ายลูกค้าให้เซลล์ใหม่ พร้อมเปลี่ยนรหัส 3 ตัวหน้า
-- วิธีใช้: ก๊อปบล็อกข้างล่างซ้ำ 1 บล็อกต่อเซลล์ปลายทาง 1 คน
--   แก้ 'BBB' = รหัสเซลล์ปลายทาง · แก้รายการรหัสร้านใน moves = ร้านที่จะยกให้เขา
-- กติกาเลขรหัส: ร้านที่ย้ายมาจะได้เลขรันต่อท้ายของเซลล์ปลายทาง (เช่น BBB มีถึง 00018
--   → ร้านย้ายมาได้ 00019, 00020, …) เรียงตามรหัสเดิม — สูตรเดียวกับที่หน้าเว็บใช้รันรหัสใหม่
-- ⚠️ แนะนำรันช่วงกลางวัน (นอก 06:00-07:00) และรันทีละบล็อกดูจำนวนแถวที่ขึ้น

begin;

with base as (
  select s.id as sid, s.name as sname, s.code as prefix,
         coalesce((select max(right(c2.code, 5)::int)
                     from customers c2
                    where c2.code ~ ('^' || s.code || '[0-9]{5}$')), 0) as maxn
    from sales s
   where s.code = 'BBB'
),
moves as (
  select c.id, row_number() over (order by c.code) as rn
    from customers c
   where c.code in ('AAA00003', 'AAA00007', 'AAA00012')
)
update customers c
   set sale_id   = b.sid,
       sale_name = b.sname,
       code      = b.prefix || lpad((b.maxn + m.rn)::text, 5, '0')
  from moves m, base b
 where c.id = m.id;

commit;

-- ── เช็คหลังย้าย ──
-- 1) ร้านไหนอยู่ในลิสต์ยกเว้นออกบิลอัตโนมัติ (เก็บเป็น "รหัส" ต้องแก้ตาม):
-- select value from settings where key = 'autobill_skip';
--    ถ้ามีรหัสเก่าของร้านที่ย้าย ให้แก้ในหน้าเว็บ (ติ๊กยกเว้นใหม่) หรือ update settings ตรง ๆ
-- 2) ดูผลการย้าย:
-- select code, name, sale_name from customers where sale_id = (select id from sales where code = 'BBB') order by code;
