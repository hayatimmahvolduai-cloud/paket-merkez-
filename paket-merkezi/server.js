// Paket Merkezi - sıfır bağımlılık (Node 22+). Çalıştır: npm start
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const {DatabaseSync}=require('node:sqlite');
const PORT=process.env.PORT||3000,WEBHOOK_KEY=process.env.WEBHOOK_KEY||crypto.randomBytes(12).toString('hex');
if(process.env.NODE_ENV==='production'&&(!process.env.ADMIN_PASS||!process.env.WEBHOOK_KEY)){console.error('HATA: ADMIN_PASS ve WEBHOOK_KEY ayarlanmadan internette çalışmaz.');process.exit(1)}
const tries=new Map();
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
if(process.env.RESET_ADMIN){ // baslat.bat ile her açılışta yönetici şifresini sıfırlar
  const un=(process.env.ADMIN_USER||'fettah').toLowerCase(),pw=process.env.ADMIN_PASS||'1234';
  db.prepare("DELETE FROM users WHERE role='admin'").run();
  db.prepare('INSERT OR REPLACE INTO users(username,name,role,pass) VALUES(?,?,?,?)').run(un,'Fettah','admin',hash(pw));
  console.log('YÖNETİCİ GİRİŞİ -> kullanıcı adı: '+un+'  şifre: '+pw);
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
    const ip=String(req.headers['x-forwarded-for']||req.socket.remoteAddress).split(',')[0].trim(),t0=Date.now();
    const h=(tries.get(ip)||[]).filter(t=>t0-t<60000);
    if(h.length>=8)return send(res,429,{error:'Çok fazla deneme. 1 dakika bekle.'});
    h.push(t0);tries.set(ip,h);
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
