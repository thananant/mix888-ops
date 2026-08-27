// ---- ข้อมูลตัวอย่างสำหรับถ่ายรูปคู่มือ (ไม่ใช่ข้อมูลจริง) ----
(function(){
  const D=(d,h,m)=>new Date(2026,7,d,h||10,m||0).toISOString();   // ส.ค. 2026
  sales=[
    {id:1,code:'SMC',name:'สมชาย ใจดี',phone:'0812345678',email:'somchai@example.com'},
    {id:2,code:'PRY',name:'ปรียา ศรีสุข',phone:'0898765432',email:'preeya@example.com'},
    {id:3,code:'TNK',name:'ธนกฤต วงศ์ไพศาล',phone:'0851112222',email:'thanakrit@example.com'}
  ];
  const shops=[
    ['SMC00021','ร้านหม่าล่าเจ๊หมวย','สาขาลาดพร้าว',1,'สมชาย ใจดี',18,'Lalamove'],
    ['SMC00022','ครัวหม้อไฟบ้านสวน','',1,'สมชาย ใจดี',18,'BI'],
    ['SMC00023','ร้านชาบูพี่ตุ้ม','',1,'สมชาย ใจดี',19,'แพ็คของ'],
    ['PRY00014','สุกี้เฮียเล้ง','สาขา 2',2,'ปรียา ศรีสุข',19,'Lalamove'],
    ['PRY00015','ร้านหมูกระทะน้องแนน','',2,'ปรียา ศรีสุข',20,'มารับเอง'],
    ['PRY00016','หม่าล่าสายไหม','',2,'ปรียา ศรีสุข',20,'BI'],
    ['PRY00017','ก๋วยเตี๋ยวเรือป้าอ้อย','',2,'ปรียา ศรีสุข',21,'BI'],
    ['TNK00008','บุฟเฟต์หม้อไฟ 199','',3,'ธนกฤต วงศ์ไพศาล',21,'Lalamove'],
    ['TNK00009','ร้านอาหารจีนซินหลง','',3,'ธนกฤต วงศ์ไพศาล',22,'แพ็คของ'],
    ['TNK00010','ครัวหม่าล่ารามอินทรา','',3,'ธนกฤต วงศ์ไพศาล',25,'BI'],
    ['SMC00024','ร้านหม้อไฟเจ้เล็ก','',1,'สมชาย ใจดี',25,'Lalamove'],
    ['SMC00025','สุกี้ตี๋น้อยซอย 5','',1,'สมชาย ใจดี',26,'BI']
  ];
  const addBy=['สมชาย ใจดี','ปรียา ศรีสุข','ธุรการ ก้อย','ธนกฤต วงศ์ไพศาล'];
  customers=shops.map((s,i)=>({
    id:100+i,code:s[0],name:s[1],branch_name:s[2],sale_id:s[3],sale_name:s[4],
    created_at:D(s[5],9+(i%6),15*(i%4)),
    created_by:i<9?addBy[i%4]:null,
    delivery_method:s[6],active:true,
    line_group_id:i===4?null:'Cxxxxxxxxxxxxxxxx',
    contact_name:'คุณ'+['หมวย','เล็ก','ตุ้ม','แนน','อ้อย','เจี๊ยบ'][i%6],
    phone:'08'+(10000000+i*137911),
    billing_address:'99/'+(i+1)+' ถ.ลาดพร้าว แขวงจอมพล เขตจตุจักร กรุงเทพฯ 10900',
    ship_address:'99/'+(i+1)+' ถ.ลาดพร้าว แขวงจอมพล เขตจตุจักร กรุงเทพฯ 10900',
    crm_color:null,crm_note:null,price_group:'ทั่วไป'
  }));
  const prods=[
    ['MLA0001','เส้นหม่าล่าเบอร์ 1 (ลัง)','ลัง',780,142,12,'MLA'],
    ['MLA0002','เส้นหม่าล่าเบอร์ 3 (ลัง)','ลัง',780,86,12,'MLA'],
    ['MLA0003','เส้นบุกเกาหลี (ลัง)','ลัง',920,8,10,'MLA'],
    ['HTP0001','น้ำซุปหม่าล่าเข้มข้น 2.5 กก.','ถุง',245,320,40,'HTP'],
    ['HTP0002','พริกแห้งหม่าล่า (กระสอบ 5 กก.)','กระสอบ',1150,24,6,'HTP'],
    ['VEG0001','เห็ดเข็มทอง 200 ก. (ลัง 40)','ลัง',560,61,10,'VEG'],
    ['VEG0002','เต้าหู้ปลาเส้น 1 กก.','แพ็ค',135,410,50,'VEG'],
    ['MEA0001','ลูกชิ้นปลาเส้นใหญ่ 1 กก.','แพ็ค',158,3,20,'MEA'],
    ['MEA0002','เบคอนม้วนหม้อไฟ 500 ก.','แพ็ค',189,96,20,'MEA'],
    ['SAU0001','ซอสงาดำหม้อไฟ 1 ลิตร','ขวด',119,254,30,'SAU']
  ];
  products=prods.map((p,i)=>({
    id:200+i,sku:p[0],name:p[1],unit:p[2],base_price:p[3],stock_qty:p[4],
    reserved_qty:i===7?2:0,low_stock_alert:p[5],active:true,category:p[6],
    safety_stock:p[5]*2,max_stock:p[5]*6,pack_info:'',image_url:null,
    last_cost:Math.round(p[3]*0.71),
    expiry_date:null,source:'โกดังลาดพร้าว'
  }));
  const oi=(a)=>a.map(([pi,q])=>({qty:q,price:products[pi].base_price,
    amount:q*products[pi].base_price,product_id:products[pi].id,
    products:{name:products[pi].name,unit:products[pi].unit}}));
  orders=[
    {id:900,order_no:'SO-260826-003',created_at:D(26,9,12),customer_id:100,
     customers:customers[0],created_by:null,status:'pending',pinned:false,
     order_items:oi([[0,4],[3,10],[6,12]]),total:4*780+10*245+12*135},
    {id:901,order_no:'SO-260826-004',created_at:D(26,10,5),customer_id:103,
     customers:customers[3],created_by:'ปรียา ศรีสุข',status:'pending',pinned:false,
     order_items:oi([[1,6],[5,3],[9,8]]),total:6*780+3*560+8*119},
    {id:902,order_no:'SO-260826-005',created_at:D(26,11,40),customer_id:107,
     customers:customers[7],created_by:null,status:'pending',pinned:false,
     order_items:oi([[2,2],[4,2],[8,10]]),total:2*920+2*1150+10*189}
  ];
  orders.forEach(o=>{o.total=o.order_items.reduce((s,x)=>s+x.amount,0);});
  let bn=1240;
  bills=[0,1,2,3,4,5,6].map(i=>{
    const c=customers[i], tot=[8640,12450,5390,21800,7620,15240,9180][i];
    const paid=i<3, part=i===3;
    return {id:800+i,bill_no:'MF'+(++bn),order_id:700+i,total:tot,
      paid_amount:paid?tot:(part?10000:0),payment_status:paid?'paid':'unpaid',
      ship_status:i<4?'shipped':'pending',created_at:D(20+i,13,20),
      created_by:['สมชาย ใจดี','ธุรการ ก้อย','ปรียา ศรีสุข'][i%3],
      paid_by:paid?'ธุรการ ก้อย':null,paid_at:paid?D(22+i,16,0):null,
      pay_method:'transfer',line_sent:i%4!==3,revision:i===5?2:1,
      slip_url:paid?'x':null,doc_type:'บิลเงินสด',
      customers:c,orders:{order_no:'SO-2608'+(10+i)+'-00'+(i+1),pinned:false,op_note:i===2?'ลูกค้าขอส่งเช้า':null,
        carrier:null,extra_cost:0,extra_note:null,created_by:i%2?'สมชาย ใจดี':null,deliver_date:null}};
  });
  acPendingOrders=orders.slice(0,2).map(o=>({...o}));
  try{arRows=bills.filter(b=>b.payment_status!=='paid');arLoaded=true;}catch(e){}
})();
