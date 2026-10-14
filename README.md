
@echo off
node --no-warnings server.js
pause

{"name":"paket-merkezi","version":"1.0.0","scripts":{"start":"node --no-warnings server.js"},"engines":{"node":">=22.5"}}

#!/bin/sh
node --no-warnings server.js

// Paket Merkezi - sıfır bağımlılık (Node 22+). Çalıştır: npm start
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const {DatabaseSync}=require('node:sqlite');
const PORT=process.env.PORT||3000,WEBHOOK_KEY=process.env.WEBHOOK_KEY||crypto.randomBytes(12).toString('hex');
const db=new DatabaseSync(process.env.DB_FILE||'data.db');
db.exec(`CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,username TEXT UNIQUE,name TEXT,role TEXT,pass TEXT,active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id INTEGER);
CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY,platform TEXT,ext_id TEXT,customer TEXT,phone TEXT,address TEXT,lat REAL,lng REAL,items TEXT,total REAL,pay TEXT,status TEXT DEFAULT 'yeni',courier_id INTEGER,day TEXT,created_at TEXT,delivered_at TEXT);
CREATE TABLE IF NOT EXISTS settlements(id INTEGER PRIMARY KEY,courier_id INTEGER,amount REAL,created_at TEXT);`);
const hash=(p,s=crypto.randomBytes(8).toString('hex'))=>s+':'+crypto.scryptSync(p,s,32).toString('hex');
const check=(p,h)=>{const s=h.split(':')[0];return crypto.timingSafeEqual(Buffer.from(hash(p,s)),Buffer.from(h))};
const today=()=>new Date().toLocaleDateString('sv-SE',{timeZone:'Europe/Istanbul'});
const now=()=>new Date().toISOString();
if(!db.prepare('SELECT 1 FROM users WHERE role=?').get('admin')){
  const pw=process.env.ADMIN_PASS||'1234',un=(process.env.ADMIN_USER||'fettah').toLowerCase();
  db.prepare('INSERT INTO users(username,name,role,pass) VALUES(?,?,?,?)').run(un,'Fettah','admin',hash(pw));
  console.log('İlk yönetici oluşturuldu: kullanıcı='+un+' şifre='+pw+' (hemen değiştir: ADMIN_PASS ile başlat)');
}
const Q=(s,...a)=>db.prepare(s).all(...a), Q1=(s,...a)=>db.prepare(s).get(...a), R=(s,...a)=>db.prepare(s).run(...a);
const fmt=o=>o&&{...o,items:JSON.parse(o.items||'[]')};
function send(res,c,d){res.writeHead(c,{'content-type':'application/json'});res.end(JSON.stringify(d))}
const body=req=>new Promise(r=>{let b='';req.on('data',c=>{b+=c;if(b.length>1e6)req.destroy()});req.on('end',()=>{try{r(JSON.parse(b||'{}'))}catch{r({})}})});
function addOrder(o,platform){
  const pay=o.pay==='online'?'online':'nakit';
  const r=R('INSERT INTO orders(platform,ext_id,customer,phone,address,lat,lng,items,total,pay,day,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    platform,o.ext_id||null,o.customer||'',o.phone||'',o.address||'',o.lat??null,o.lng??null,JSON.stringify(o.items||[]),+o.total||0,pay,today(),now());
  return Number(r.lastInsertRowid);
}
function cashDue(id){
  const a=Q1("SELECT COALESCE(SUM(total),0) t FROM orders WHERE courier_id=? AND status='teslim' AND pay='nakit'",id).t;
  const b=Q1('SELECT COALESCE(SUM(amount),0) t FROM settlements WHERE courier_id=?',id).t;return a-b;
}
async function api(req,res,u){
  const m=req.method,p=u.pathname;
  if(m==='POST'&&p.startsWith('/api/webhook/')){ // Platform/entegratör buraya sipariş gönderir
    if(req.headers['x-api-key']!==WEBHOOK_KEY)return send(res,401,{error:'anahtar yanlış'});
    const id=addOrder(await body(req),p.split('/').pop().toUpperCase());return send(res,200,{id});
  }
  const b=await body(req);
  if(m==='POST'&&p==='/api/login'){
    const u2=Q1('SELECT * FROM users WHERE username=? AND active=1',String(b.username||'').trim().toLowerCase());
    if(!u2||!check(String(b.password||''),u2.pass))return send(res,401,{error:'Kullanıcı adı veya şifre yanlış'});
    const t=crypto.randomBytes(24).toString('hex');R('INSERT INTO sessions VALUES(?,?)',t,u2.id);
    return send(res,200,{token:t,role:u2.role,name:u2.name});
  }
  const tok=(req.headers.authorization||'').replace('Bearer ','');
  const me=Q1('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND u.active=1',tok);
  if(!me)return send(res,401,{error:'Giriş gerekli'});
  const admin=me.role==='admin';
  if(m==='GET'&&p==='/api/me')return send(res,200,{id:me.id,name:me.name,role:me.role,webhookKey:admin?WEBHOOK_KEY:undefined});
  if(m==='GET'&&p==='/api/orders'){
    const day=u.searchParams.get('day')||today();
    const rows=admin?Q('SELECT o.*,u.name courier FROM orders o LEFT JOIN users u ON u.id=o.courier_id WHERE day=? ORDER BY o.id DESC',day)
      :Q("SELECT * FROM orders WHERE courier_id=? AND (status!='teslim' OR day=?) ORDER BY id DESC",me.id,day);
    return send(res,200,rows.map(fmt));
  }
  if(m==='POST'&&p==='/api/orders'&&admin)return send(res,200,{id:addOrder(b,String(b.platform||'TELEFON').toUpperCase())});
  let x;
  if(m==='POST'&&(x=p.match(/^\/api\/orders\/(\d+)\/assign$/))&&admin){
    R("UPDATE orders SET courier_id=?,status='yolda' WHERE id=? AND status!='teslim'",b.courier_id||null,+x[1]);
    if(!b.courier_id)R("UPDATE orders SET status='yeni' WHERE id=? AND status!='teslim'",+x[1]);return send(res,200,{ok:1});
  }
  if(m==='POST'&&(x=p.match(/^\/api\/orders\/(\d+)\/status$/))){
    const o=Q1('SELECT * FROM orders WHERE id=?',+x[1]);
    if(!o||(!admin&&o.courier_id!==me.id))return send(res,403,{error:'Yetkisiz'});
    if(!['yolda','teslim'].includes(b.status))return send(res,400,{error:'Geçersiz durum'});
    R('UPDATE orders SET status=?,delivered_at=? WHERE id=?',b.status,b.status==='teslim'?now():null,o.id);return send(res,200,{ok:1});
  }
  if(m==='GET'&&p==='/api/couriers'&&admin){
    const d=today();
    return send(res,200,Q("SELECT id,name,username FROM users WHERE role='kurye' AND active=1").map(c=>({...c,
      todayCount:Q1("SELECT COUNT(*) n FROM orders WHERE courier_id=? AND status='teslim' AND day=?",c.id,d).n,
      active:Q1("SELECT COUNT(*) n FROM orders WHERE courier_id=? AND status='yolda'",c.id).n,cashDue:cashDue(c.id)})));
  }
  if(m==='GET'&&p==='/api/me/summary'){
    return send(res,200,{todayCount:Q1("SELECT COUNT(*) n FROM orders WHERE courier_id=? AND status='teslim' AND day=?",me.id,today()).n,cashDue:cashDue(me.id)});
  }
  if(m==='POST'&&p==='/api/couriers'&&admin){
    if(!b.name||!b.username||String(b.password||'').length<4)return send(res,400,{error:'Ad, kullanıcı adı ve en az 4 haneli şifre gerekli'});
    try{R('INSERT INTO users(username,name,role,pass) VALUES(?,?,?,?)',String(b.username).trim().toLowerCase(),b.name,'kurye',hash(String(b.password)))}
    catch{return send(res,400,{error:'Bu kullanıcı adı kullanılıyor'})}return send(res,200,{ok:1});
  }
  if(m==='POST'&&(x=p.match(/^\/api\/couriers\/(\d+)\/settle$/))&&admin){
    const due=cashDue(+x[1]);if(due>0)R('INSERT INTO settlements(courier_id,amount,created_at) VALUES(?,?,?)',+x[1],due,now());return send(res,200,{settled:due});
  }
  if(m==='GET'&&p==='/api/report'&&admin){
    const n=Math.min(+u.searchParams.get('days')||14,120);
    return send(res,200,{daily:Q(`SELECT day,COUNT(*) orders,SUM(total) revenue,SUM(CASE WHEN pay='nakit' THEN total ELSE 0 END) cash,SUM(CASE WHEN pay='online' THEN total ELSE 0 END) online FROM orders GROUP BY day ORDER BY day DESC LIMIT ?`,n),
      platforms:Q('SELECT platform,COUNT(*) orders,SUM(total) revenue FROM orders WHERE day=? GROUP BY platform',today())});
  }
  send(res,404,{error:'Bulunamadı'});
}
const TYPES={'.html':'text/html;charset=utf-8','.json':'application/json','.js':'text/javascript','.png':'image/png'};
http.createServer(async(req,res)=>{
  const u=new URL(req.url,'http://x');
  try{
    if(u.pathname.startsWith('/api/'))return await api(req,res,u);
    const f=path.join(__dirname,'public',u.pathname==='/'?'index.html':path.normalize(u.pathname).replace(/^(\.\.[\/\\])+/,''));
    if(!f.startsWith(path.join(__dirname,'public'))||!fs.existsSync(f))return send(res,404,{error:'yok'});
    res.writeHead(200,{'content-type':TYPES[path.extname(f)]||'application/octet-stream'});fs.createReadStream(f).pipe(res);
  }catch(e){console.error(e);send(res,500,{error:'Sunucu hatası'})}
}).listen(PORT,()=>console.log('Paket Merkezi http://localhost:'+PORT+'  | Webhook anahtarı: '+WEBHOOK_KEY));

<!DOCTYPE html><html lang="tr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<link rel="manifest" href="manifest.json"><meta name="theme-color" content="#12263A"><title>Paket Merkezi</title>
<style>
:root{--bg:#EEF2F4;--card:#fff;--ink:#12263A;--mute:#5E7080;--line:#D5DDE3;--acc:#F2B705;--ok:#1F9D6B;--bad:#D64545}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,sans-serif;padding:env(safe-area-inset-top) 0 env(safe-area-inset-bottom)}
button,input,select{font:inherit;color:inherit}main{max-width:1000px;margin:auto;padding:14px}
header{background:var(--ink);color:#fff;padding:12px 16px;display:flex;align-items:center;gap:10px}header b{margin-right:auto;font-size:17px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:12px}
.grid{display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));margin-bottom:12px}
.grid .card{margin:0}.grid b{font-size:24px;display:block}.mute{color:var(--mute);font-size:13px}
.btn{border:0;border-radius:8px;padding:9px 13px;font-weight:700;background:var(--ink);color:#fff;cursor:pointer}.btn.g{background:var(--ok)}.btn.y{background:var(--acc);color:var(--ink)}.btn.o{background:none;border:1.5px solid var(--line);color:var(--ink);text-decoration:none;display:inline-block}
input,select{background:#fff;border:1.5px solid var(--line);border-radius:8px;padding:9px;width:100%}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.sp{margin-left:auto}
.o{border-top:1px solid var(--line);padding:10px 0;display:grid;gap:5px}.o:first-child{border-top:0}
.tag{font-size:12px;font-weight:700;padding:2px 8px;border-radius:99px;background:var(--mute);color:#fff}
.pay{font-size:12px;font-weight:700;padding:2px 8px;border-radius:6px;border:1.5px solid var(--acc);background:#F2B70526}.pay.online{border-color:var(--ok);background:none;color:var(--ok)}
table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:7px 3px;border-top:1px solid var(--line);font-size:14px}th{border:0;color:var(--mute);font-size:12px}
.f{display:grid;gap:8px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}h2{font-size:16px;margin:16px 0 8px}
.login{max-width:340px;margin:12vh auto;display:grid;gap:10px}.err{color:var(--bad);font-size:13px}
.cols{display:grid;gap:12px}@media(min-width:850px){.cols{grid-template-columns:1.5fr 1fr}}
.big{font-size:18px;font-weight:800}.scroll{overflow-x:auto}
</style></head><body><div id="app"></div>
<script>
const $=s=>document.querySelector(s),P={YEMEKSEPETI:'Yemeksepeti',TRENDYOL:'Trendyol Yemek',MIGROS:'Migros Yemek',TELEFON:'Telefon'};
const tl=n=>Math.round(n||0).toLocaleString('tr-TR')+' ₺',esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);
let token=localStorage.getItem('tok'),me=null,seen=null,timer=null,lastErr='';
async function api(p,method='GET',data){
  const r=await fetch('/api/'+p,{method,headers:{'content-type':'application/json',authorization:'Bearer '+token},body:data?JSON.stringify(data):undefined});
  const j=await r.json().catch(()=>({}));if(r.status===401&&token){logout();throw 0}if(!r.ok)throw new Error(j.error||'Hata');return j}
function logout(){localStorage.removeItem('tok');token=null;me=null;clearInterval(timer);login()}
function login(){$('#app').innerHTML=`<form class="card login" id="lf"><h2 style="margin:0">Paket Merkezi</h2><input name="u" placeholder="Kullanıcı adı" autocomplete="username" required><input name="p" type="password" placeholder="Şifre" autocomplete="current-password" required><button class="btn y">Giriş yap</button><div class="err" id="le"></div></form>`;
  $('#lf').onsubmit=async e=>{e.preventDefault();const f=e.target;try{const r=await fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:f.u.value,password:f.p.value})});const j=await r.json();if(!r.ok)throw new Error(j.error);token=j.token;localStorage.setItem('tok',token);start()}catch(x){$('#le').textContent=x.message}}}
async function start(){try{me=await api('me')}catch{return}seen=null;clearInterval(timer);await draw();timer=setInterval(draw,5000)}
const hdr=()=>`<header><b>Paket Merkezi</b><span class="mute" style="color:#cfd8df">${esc(me.name)}</span><button class="btn y" onclick="logout()">Çıkış</button></header>`;
function beep(){try{const a=new (window.AudioContext||webkitAudioContext)(),o=a.createOscillator();o.connect(a.destination);o.frequency.value=880;o.start();setTimeout(()=>o.stop(),250)}catch{}}
function focused(){const a=document.activeElement;return a&&(a.tagName==='INPUT'||a.tagName==='SELECT')}
async function draw(){if(focused())return;try{me.role==='admin'?await admin():await courier()}catch(e){}}
const mapUrl=o=>'https://www.google.com/maps/search/?api=1&query='+(o.lat!=null?o.lat+','+o.lng:encodeURIComponent(o.address));
async function admin(){
  const [O,C,R]=await Promise.all([api('orders'),api('couriers'),api('report?days=14')]);
  const t=O.reduce((a,o)=>a+o.total,0),cash=O.filter(o=>o.pay==='nakit').reduce((a,o)=>a+o.total,0);
  const ids=O.map(o=>o.id);if(seen&&ids.some(i=>!seen.includes(i)))beep();seen=ids;
  const by={};O.forEach(o=>{by[o.platform]=by[o.platform]||[0,0];by[o.platform][0]++;by[o.platform][1]+=o.total});
  const w=R.daily.length?R.daily.reduce((a,d)=>a+d.revenue,0):0;
  $('#app').innerHTML=hdr()+`<main><div class="grid"><div class="card"><b>${O.length}</b><span class="mute">Bugünkü sipariş</span></div><div class="card"><b>${tl(t)}</b><span class="mute">Ciro</span></div><div class="card"><b>${tl(cash)}</b><span class="mute">Nakit</span></div><div class="card"><b>${tl(t-cash)}</b><span class="mute">Online</span></div><div class="card"><b>${O.filter(o=>o.status==='yeni').length}</b><span class="mute">Atama bekliyor</span></div></div>
  <div class="cols"><div><h2>Siparişler</h2><div class="card">${O.map(o=>`<div class="o"><div class="row"><span class="tag">${P[o.platform]||esc(o.platform)}</span><b>#${o.id} ${esc(o.customer)}</b><b class="sp">${tl(o.total)}</b></div><div class="mute">${esc(o.address)} · ${esc(o.phone)}</div><div>${esc(o.items.join(', '))}</div>
  <div class="row"><span class="pay ${o.pay}">${o.pay==='nakit'?'Nakit':'Online'}</span><span class="mute">${o.status==='teslim'?'Teslim edildi':o.status==='yolda'?'Yolda: '+esc(o.courier):'Atama bekliyor'}</span>
  <select class="sp" style="width:auto" ${o.status==='teslim'?'disabled':''} onchange="assign(${o.id},this.value)"><option value="">Kurye seç</option>${C.map(c=>`<option value="${c.id}" ${o.courier_id===c.id?'selected':''}>${esc(c.name)}</option>`).join('')}</select></div></div>`).join('')||'<p class="mute">Bugün sipariş yok.</p>'}</div></div>
  <div><h2>Kuryeler ve nakit</h2><div class="card scroll"><table><tr><th>Kurye</th><th>Teslim</th><th>Nakit</th><th></th></tr>${C.map(c=>`<tr><td><b>${esc(c.name)}</b><div class="mute">${c.active} yolda</div></td><td>${c.todayCount}</td><td>${tl(c.cashDue)}</td><td>${c.cashDue>0?`<button class="btn g" onclick="settle(${c.id})">Nakdi aldım</button>`:''}</td></tr>`).join('')}</table>
  <form class="f" style="margin-top:10px" onsubmit="addC(event)"><input name="name" placeholder="Kurye adı" required><input name="username" placeholder="Kullanıcı adı" required><input name="password" placeholder="Şifre (en az 4)" required><button class="btn">Kurye ekle</button></form></div>
  <h2>Platform dağılımı</h2><div class="card"><table>${Object.entries(by).map(([k,v])=>`<tr><td>${P[k]||esc(k)}</td><td>${v[0]} sipariş</td><td>${tl(v[1])}</td></tr>`).join('')}</table></div></div></div>
  <h2>Gelir raporu (son 14 gün: ${tl(w)})</h2><div class="card scroll"><table><tr><th>Gün</th><th>Sipariş</th><th>Ciro</th><th>Nakit</th><th>Online</th></tr>${R.daily.map(d=>`<tr><td>${d.day}</td><td>${d.orders}</td><td>${tl(d.revenue)}</td><td>${tl(d.cash)}</td><td>${tl(d.online)}</td></tr>`).join('')}</table></div>
  <h2>Sipariş ekle (telefon / elle)</h2><form class="card f" onsubmit="addO(event)"><select name="platform"><option value="TELEFON">Telefon</option><option value="YEMEKSEPETI">Yemeksepeti</option><option value="TRENDYOL">Trendyol Yemek</option><option value="MIGROS">Migros Yemek</option></select><input name="customer" placeholder="Müşteri" required><input name="phone" placeholder="Telefon" required><input name="address" placeholder="Adres" required><input name="items" placeholder="Ürünler (virgülle)" required><input name="total" type="number" placeholder="Tutar ₺" required><select name="pay"><option value="nakit">Nakit</option><option value="online">Online</option></select><button class="btn y">Ekle</button></form>
  <p class="mute">Platform entegrasyonu: siparişleri <code>POST /api/webhook/yemeksepeti</code> adresine <code>x-api-key: ${esc(me.webhookKey)}</code> başlığıyla gönder.</p></main>`}
async function courier(){
  const [O,S]=await Promise.all([api('orders'),api('me/summary')]),J=O.filter(o=>o.status!=='teslim');
  const ids=J.map(o=>o.id);if(seen&&ids.some(i=>!seen.includes(i))){beep();navigator.vibrate&&navigator.vibrate(300)}seen=ids;
  $('#app').innerHTML=hdr()+`<main style="max-width:460px"><div class="grid"><div class="card"><b>${S.todayCount}</b><span class="mute">Bugün teslim</span></div><div class="card"><b>${tl(S.cashDue)}</b><span class="mute">Dükkana verilecek nakit</span></div></div>
  ${J.map(o=>`<div class="card" style="display:grid;gap:8px"><div class="row"><span class="tag">${P[o.platform]||esc(o.platform)}</span><span class="mute">#${o.id}</span><span class="pay ${o.pay} sp">${o.pay==='nakit'?'Nakit al: '+tl(o.total):'Ödendi'}</span></div><div class="big">${esc(o.customer)}</div><div>${esc(o.address)}</div><div class="mute">${esc(o.items.join(', '))}</div>
  <div class="row"><a class="btn o" href="tel:${esc(o.phone.replace(/\s/g,''))}">Ara</a><a class="btn o" target="_blank" rel="noopener" href="${mapUrl(o)}">Yol tarifi</a>${o.status==='yolda'&&!o.picked?`<button class="btn g sp" onclick="done(${o.id})">Teslim ettim</button>`:''}</div></div>`).join('')||'<p class="mute" style="text-align:center;padding:30px">Atanmış sipariş yok. Yeni paket gelince telefon ses çıkarır.</p>'}</main>`}
const act=async(f)=>{try{await f();draw()}catch(e){if(e)alert(e.message)}};
window.assign=(id,c)=>act(()=>api(`orders/${id}/assign`,'POST',{courier_id:c?+c:null}));
window.settle=id=>act(()=>api(`couriers/${id}/settle`,'POST'));
window.done=id=>confirm('Teslim edildi olarak işaretlensin mi?')&&act(()=>api(`orders/${id}/status`,'POST',{status:'teslim'}));
window.addC=e=>{e.preventDefault();const f=Object.fromEntries(new FormData(e.target));act(()=>api('couriers','POST',f));e.target.reset()};
window.addO=e=>{e.preventDefault();const f=Object.fromEntries(new FormData(e.target));f.items=f.items.split(',').map(s=>s.trim());f.total=+f.total;act(()=>api('orders','POST',f));e.target.reset()};
token?start():login();
</script></body></html>

{"name":"Paket Merkezi","short_name":"Paket","start_url":"/","display":"standalone","background_color":"#12263A","theme_color":"#12263A","icons":[]}
