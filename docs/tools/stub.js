// ---- stub Supabase client (ใช้เฉพาะตอนถ่ายรูปคู่มือ) ----
(function(){
  function mk(){
    const t=function(){};
    return new Proxy(t,{
      get(_,k){
        if(k==='then')return (res)=>res({data:[],error:null,count:0});
        if(k==='catch'||k==='finally')return ()=>mk();
        if(k===Symbol.toStringTag)return 'Object';
        if(k==='toJSON')return ()=>({});
        return mk();
      },
      apply(){return mk();}
    });
  }
  window.__stub=mk;
  window.supabase={createClient:()=>mk()};
  Object.defineProperty(window,'supabase',{value:{createClient:()=>mk()},writable:false,configurable:false});
})();
