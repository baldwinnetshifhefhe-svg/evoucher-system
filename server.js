// ============================================================================
//  e-Voucher System — real backend server  (Node.js + built-in SQLite)
//  Run:  node server.js   (or double-click run-eVoucher.bat)
// ============================================================================
const http = require('node:http');
const fs   = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');

const PORT = process.env.PORT || 3000;            // Render supplies PORT automatically
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'evoucher.db');
const db = new DatabaseSync(DB_PATH);

// ---- tables ---------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS producers(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT,prov TEXT,dist TEXT,ent TEXT,status TEXT DEFAULT 'Active',rica TEXT DEFAULT 'Verified',demo TEXT,email TEXT);
CREATE TABLE IF NOT EXISTS farmer_register(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT,prov TEXT,dist TEXT,ent TEXT,demo TEXT,rica TEXT,enrolled INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS packages(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT,val INTEGER,items TEXT,status TEXT DEFAULT 'Active');
CREATE TABLE IF NOT EXISTS vouchers(id INTEGER PRIMARY KEY AUTOINCREMENT,no TEXT,who TEXT,prov TEXT,pkg TEXT,val INTEGER,status TEXT,otp TEXT,dealer TEXT,created TEXT,redeemed_at TEXT,expiry TEXT);
CREATE TABLE IF NOT EXISTS dealers(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT,prov TEXT,dist TEXT,contact TEXT,status TEXT DEFAULT 'Active',company_reg TEXT,vat TEXT,csd TEXT,bank TEXT,address TEXT,email TEXT,phone TEXT,catalogue TEXT);
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT,username TEXT UNIQUE,password TEXT,name TEXT,role TEXT,scope TEXT);
CREATE TABLE IF NOT EXISTS grievances(id INTEGER PRIMARY KEY AUTOINCREMENT,ref TEXT,who TEXT,issue TEXT,status TEXT DEFAULT 'Open',created TEXT);
CREATE TABLE IF NOT EXISTS catalogue(id INTEGER PRIMARY KEY AUTOINCREMENT,n TEXT,c TEXT,p INTEGER,s TEXT DEFAULT 'Approved');
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT,ts TEXT,audience TEXT,channel TEXT,subject TEXT,body TEXT,recipients INTEGER);
CREATE TABLE IF NOT EXISTS applications(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT,prov TEXT,dist TEXT,ent TEXT,demo TEXT,status TEXT DEFAULT 'Applied',created TEXT,recommended_by TEXT,approved_by TEXT,reason TEXT);
CREATE TABLE IF NOT EXISTS payments(id INTEGER PRIMARY KEY AUTOINCREMENT,ts TEXT,supplier TEXT,voucher_no TEXT,who TEXT,amount INTEGER,gateway TEXT,ref TEXT,status TEXT);
CREATE TABLE IF NOT EXISTS feedback(id INTEGER PRIMARY KEY AUTOINCREMENT,ts TEXT,role TEXT,rating INTEGER,comment TEXT,by TEXT);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT,ts TEXT,actor TEXT,event TEXT,kind TEXT);
`);

// add columns to existing databases (SQLite has no "ADD COLUMN IF NOT EXISTS")
function ensureCol(table,col,def){ const cols=db.prepare(`PRAGMA table_info(${table})`).all(); if(!cols.some(c=>c.name===col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); }
ensureCol('vouchers','confirm_code','TEXT');     // code SMS-sent to the FARMER to confirm receipt
ensureCol('vouchers','confirmed_at','TEXT');
ensureCol('vouchers','confirm_status',"TEXT DEFAULT ''");  // '' | Confirmed | Disputed (farmer receipt check)
ensureCol('audit','prev_hash','TEXT');           // tamper-evident hash chain
ensureCol('audit','hash','TEXT');
ensureCol('users','failed_attempts','INTEGER DEFAULT 0');  // login lockout (brute-force protection)
ensureCol('users','locked_until','INTEGER');
ensureCol('producers','phone','TEXT');   // farmer cellphone — for real SMS of voucher + OTP
function hashPw(pw){ const salt=crypto.randomBytes(16).toString('hex'); return salt+':'+crypto.scryptSync(String(pw),salt,32).toString('hex'); }
function checkPw(pw, stored){ if(!stored) return false; if(!String(stored).includes(':')) return String(pw)===String(stored); const [s,h]=String(stored).split(':'); try{ return crypto.scryptSync(String(pw),s,32).toString('hex')===h; }catch(e){ return false; } }
// Real SMS: prefers BulkSMS (SA-local), then Twilio; otherwise safely simulated.
async function sendSms(to, text){
  // 1) BulkSMS — best for South African delivery
  const bUser=process.env.BULKSMS_USERNAME, bPass=process.env.BULKSMS_PASSWORD;
  if(bUser&&bPass){
    try{
      const r=await fetch('https://api.bulksms.com/v1/messages',{method:'POST',
        headers:{'Authorization':'Basic '+Buffer.from(bUser+':'+bPass).toString('base64'),'Content-Type':'application/json'},
        body:JSON.stringify({to, body:text})});
      const j=await r.json().catch(()=>null);
      if(r.ok){ const id=Array.isArray(j)&&j[0]?j[0].id:undefined; return { sent:true, to, ref:id, source:'BulkSMS' }; }
      return { sent:false, to, error:(j&&(j.detail||j.title))||('HTTP '+r.status), source:'BulkSMS' };
    }catch(e){ return { sent:false, to, error:String(e), source:'BulkSMS' }; }
  }
  // 2) Twilio
  const sid=process.env.TWILIO_ACCOUNT_SID, tok=process.env.TWILIO_AUTH_TOKEN, from=process.env.TWILIO_FROM;
  if(sid&&tok&&from){
    try{
      const r=await fetch('https://api.twilio.com/2010-04-01/Accounts/'+sid+'/Messages.json',{method:'POST',
        headers:{'Authorization':'Basic '+Buffer.from(sid+':'+tok).toString('base64'),'Content-Type':'application/x-www-form-urlencoded'},
        body:new URLSearchParams({To:to,From:from,Body:text})});
      const j=await r.json().catch(()=>({}));
      return r.ok ? { sent:true, to, ref:j.sid, source:'Twilio' } : { sent:false, error:j.message||('HTTP '+r.status), to, source:'Twilio' };
    }catch(e){ return { sent:false, error:String(e), to, source:'Twilio' }; }
  }
  // 3) simulated
  return { sent:false, simulated:true, to:to||'•••• ••••', source:'SMS gateway (simulated — add BULKSMS_USERNAME/PASSWORD or TWILIO_* to send for real)' };
}
// Ask BulkSMS the real delivery status of a message id (ACCEPTED / SENT / DELIVERED / FAILED).
async function smsStatus(id){
  const bUser=process.env.BULKSMS_USERNAME, bPass=process.env.BULKSMS_PASSWORD;
  if(!bUser||!bPass) return { id, status:'no-provider' };
  if(!id) return { id, status:'no-id' };
  try{
    const r=await fetch('https://api.bulksms.com/v1/messages/'+encodeURIComponent(id),
      { headers:{'Authorization':'Basic '+Buffer.from(bUser+':'+bPass).toString('base64')} });
    const j=await r.json().catch(()=>null);
    if(r.ok&&j){ const s=j.status||{}; return { id, status:(s.type||s.id||'unknown'), detail:(s.subtype||''), to:j.to }; }
    return { id, status:'error', detail:'HTTP '+r.status };
  }catch(e){ return { id, status:'error', detail:String(e) }; }
}

const now = () => new Date().toLocaleString('en-ZA');
const today = () => new Date().toLocaleDateString('en-ZA');
const fyEnd = () => { const d=new Date(); const y=d.getMonth()>=3?d.getFullYear()+1:d.getFullYear(); return y+'-03-31'; }; // SA financial year ends 31 March
const fyLabel = () => { const d=new Date(); const s=d.getMonth()>=3?d.getFullYear():d.getFullYear()-1; return s+'/'+String(s+1).slice(2); };
function logAudit(actor,event,kind){
  const prev=db.prepare('SELECT hash FROM audit ORDER BY id DESC LIMIT 1').get();
  const prevHash=prev&&prev.hash?prev.hash:'GENESIS';
  const ts=now();
  const hash=crypto.createHash('sha256').update(prevHash+'|'+ts+'|'+actor+'|'+event+'|'+kind).digest('hex');
  db.prepare('INSERT INTO audit(ts,actor,event,kind,prev_hash,hash) VALUES(?,?,?,?,?,?)').run(ts,actor,event,kind,prevHash,hash);
}

// ---- seed (first run only) ------------------------------------------------
if (db.prepare('SELECT COUNT(*) c FROM producers').get().c === 0){
  const ip=db.prepare('INSERT INTO producers(name,prov,dist,ent,status,rica,demo) VALUES(?,?,?,?,?,?,?)');
  [["Thabo Mokoena","FS","Mangaung","Maize · 4ha","Active","Verified","M·41"],
   ["Johannes Maritz","FS","Mangaung","Maize · 9ha","Active","Verified","M·58"],
   ["Palesa Mofokeng","FS","Mangaung","Beans · 3ha","Active","Verified","F·33"],
   ["Nomsa Dlamini","KZN","uMzinyathi","Vegetables · 1.5ha","Active","Verified","F·29"],
   ["Thandeka Mthembu","KZN","uMzinyathi","Maize · 2ha","Active","Verified","F·41"],
   ["Sipho Buthelezi","KZN","uMzinyathi","Goats · 35 head","Active","Verified","M·52"],
   ["Lungile Zwane","KZN","uMzinyathi","Vegetables · 1ha","Pending","Verified","F·27"],
   ["Zanele Khumalo","KZN","Zululand","Vegetables · 2ha","Active","Verified","F·26"],
   ["Bongani Zulu","KZN","King Cetshwayo","Goats · 60 head","Active","Verified","M·44"],
   ["Pieter van Wyk","WC","West Coast","Wheat · 12ha","Pending","Verified","M·53"],
   ["Annelize Booysen","WC","West Coast","Wheat · 8ha","Active","Verified","F·36"],
   ["Lerato Sithole","GP","Tshwane","Poultry · 800 birds","Active","Verified","F·34"],
   ["Kabelo Maluleke","GP","Tshwane","Vegetables · 2ha","Active","Verified","M·40"],
   ["Fatima Patel","GP","Ekurhuleni","Poultry · 1200 birds","Active","Verified","F·48"],
   ["Sipho Ndlovu","MP","Ehlanzeni","Sugarcane · 6ha","Active","Verified","M·47"],
   ["Grace Nkosi","MP","Ehlanzeni","Vegetables · 1ha","Active","Verified","F·27"],
   ["Tshepo Molefe","NW","Bojanala Platinum","Sunflower · 15ha","Active","Verified","M·36"],
   ["Anna Botha","NW","Ngaka Modiri Molema","Cattle · 40 head","Suspended","Mismatch","F·61"],
   ["Dineo Phiri","LP","Vhembe","Tomatoes · 3ha","Active","Verified","F·31"],
   ["Mulalo Ramavhoya","LP","Vhembe","Maize · 4ha","Active","Verified","M·38"],
   ["Khathutshelo Nemukula","LP","Vhembe","Tomatoes · 2ha","Active","Verified","F·45"],
   ["Andile Mbeki","EC","OR Tambo","Maize · 2.5ha","Active","Verified","M·33"],
   ["Maria Adams","NC","Frances Baard","Grapes · 5ha","Pending","Verified","F·39"],
  ].forEach(r=>ip.run(...r));
  // ---- generate more beneficiaries to reach 50 (deterministic, from SA name pools) ----
  const FN={M:["Sipho","Thabo","Kabelo","Mpho","Andile","Bongani","Lwazi","Tshepo","Themba","Vusi","Katlego","Lehlohonolo","Mandla","Sizwe","Tumelo"],F:["Nomsa","Thandeka","Lerato","Palesa","Zanele","Dineo","Grace","Naledi","Boitumelo","Refilwe","Nokuthula","Ayanda","Precious","Khanyisile","Lindiwe"]};
  const SUR=["Mokoena","Dlamini","Nkosi","Zulu","Mahlangu","Khumalo","Molefe","Sithole","Ndlovu","Mthembu","Maluleke","Buthelezi","Phiri","Mokwena","Ngcobo","Nene","Mabaso","Radebe","Sibeko","Tshabalala"];
  const PD={FS:["Mangaung","Fezile Dabi","Thabo Mofutsanyana"],KZN:["uMzinyathi","Zululand","King Cetshwayo","uMgungundlovu"],WC:["West Coast","Cape Winelands","Garden Route"],GP:["Tshwane","Ekurhuleni","Johannesburg"],MP:["Ehlanzeni","Gert Sibande","Nkangala"],NW:["Bojanala Platinum","Dr Kenneth Kaunda","Ngaka Modiri Molema"],LP:["Vhembe","Capricorn","Mopani"],EC:["OR Tambo","Amathole","Chris Hani"],NC:["Frances Baard","ZF Mgcawu","Pixley ka Seme"]};
  const ENT=["Maize · 3ha","Maize · 6ha","Vegetables · 1ha","Vegetables · 2ha","Poultry · 500 birds","Goats · 40 head","Sugarcane · 5ha","Tomatoes · 2ha","Sunflower · 10ha","Cattle · 25 head","Beans · 2ha","Wheat · 7ha"];
  const PK=Object.keys(PD); let _r=20260605; const rnd=()=>{_r=(_r*1103515245+12345)&0x7fffffff;return _r/0x7fffffff;}; const pick=a=>a[Math.floor(rnd()*a.length)];
  while(db.prepare('SELECT COUNT(*) c FROM producers').get().c < 50){
    const g=rnd()<0.5?'F':'M'; const pk=pick(PK);
    ip.run(pick(FN[g])+' '+pick(SUR), pk, pick(PD[pk]), pick(ENT), rnd()<0.9?'Active':'Pending', 'Verified', g+'·'+(20+Math.floor(rnd()*45)));
  }
  // ---- seed the central FARMER REGISTER (enrolled = all current beneficiaries; plus a few awaiting enrolment) ----
  const ifr=db.prepare('INSERT INTO farmer_register(name,prov,dist,ent,demo,rica,enrolled) VALUES(?,?,?,?,?,?,?)');
  db.prepare('SELECT name,prov,dist,ent,demo,rica FROM producers').all().forEach(p=>ifr.run(p.name,p.prov,p.dist,p.ent,p.demo,p.rica,1));
  for(let i=0;i<8;i++){const g=rnd()<0.5?'F':'M';const pk=pick(PK);ifr.run(pick(FN[g])+' '+pick(SUR),pk,pick(PD[pk]),pick(ENT),g+'·'+(20+Math.floor(rnd()*45)),'Verified',0);}
  db.prepare("UPDATE producers SET email = lower(replace(name,' ','.'))||'@example.co.za' WHERE email IS NULL").run();

  const ipk=db.prepare('INSERT INTO packages(name,val,items,status) VALUES(?,?,?,?)');
  [["Maize starter pack",3200,"Maize seed 10kg + LAN 50kg","Active"],
   ["Vegetable seed + fertiliser",1850,"Veg seed kit + fertiliser","Active"],
   ["Poultry feed pack",2400,"Starter feed 40kg x2","Active"],
   ["Sunflower seed + fertiliser",5400,"Sunflower seed 5kg + fert.","Active"],
  ].forEach(r=>ipk.run(...r));

  const idl=db.prepare('INSERT INTO dealers(name,prov,dist,contact,status) VALUES(?,?,?,?,?)');
  [["AgriMart Tshwane","GP","Tshwane","D. Naidoo","Active"],
   ["FarmCo Nkomazi","MP","Ehlanzeni","S. Mahlangu","Active"],
   ["KZN Agri Supplies","KZN","Zululand","B. Cele","Active"],
   ["uMzinyathi Agri Co-op","KZN","uMzinyathi","M. Ndlovu","Active"],
   ["Vhembe Farm Centre","LP","Vhembe","R. Netshi","Active"],
  ].forEach(r=>idl.run(...r));

  const ic=db.prepare('INSERT INTO catalogue(n,c,p,s) VALUES(?,?,?,?)');
  [["Maize seed (10kg)","Seed",850,"Approved"],["LAN fertiliser (50kg)","Fertiliser",620,"Approved"],
   ["Vegetable seed kit","Seed",430,"Approved"],["Poultry starter feed (40kg)","Feed",540,"Approved"],
   ["Tomato seedlings (tray)","Seedlings",180,"Approved"],["Sunflower seed (5kg)","Seed",720,"Approved"],
   ["Knapsack sprayer","Equipment",1200,"Under review"],["Cattle lick supplement","Feed",390,"Approved"],
  ].forEach(r=>ic.run(...r));

  const iu=db.prepare('INSERT INTO users(username,password,name,role,scope) VALUES(?,?,?,?,?)');
  iu.run("admin","admin123","Motshidisi Sitali","national","All provinces");
  iu.run("baldwinnetshifhefhe@gmail.com","2026","Baldwin Netshifhefhe","national","All provinces");
  iu.run("kzn","kzn123","Quinton Nyoka","provincial","KZN");
  iu.run("fs","fs123","Zinhle Mkhize","provincial","FS");
  iu.run("umzinyathi","dist123","Bongani Ndlovu","district","uMzinyathi");
  iu.run("vhembe","dist123","James Ngaka","district","Vhembe");
  iu.run("dealer","dealer123","AgriMart Tshwane","dealer","AgriMart Tshwane");
  iu.run("finance","fin123","Ben Coetzer","finance","Treasury / BAS");
  iu.run("auditor","audit123","Sara Williams","auditor","All provinces");

  const ig=db.prepare('INSERT INTO grievances(ref,who,issue,status,created) VALUES(?,?,?,?,?)');
  ig.run("GR-0041","Pieter van Wyk","Agro-dealer out of stock of fertiliser","Resolved",today());
  ig.run("GR-0042","Anna Botha","Voucher not received — RICA mismatch","Open",today());

  const iv=db.prepare('INSERT INTO vouchers(no,who,prov,pkg,val,status,otp,dealer,created,redeemed_at,expiry) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
  iv.run("EV-2026-004471","Thabo Mokoena","FS","Maize starter pack",3200,"Redeemed","1234","AgriMart Tshwane","12 May 2026","12 May 2026",fyEnd());
  iv.run("EV-2026-004472","Nomsa Dlamini","KZN","Vegetable seed + fertiliser",1850,"Issued","4821","","13 May 2026","",fyEnd());
  db.prepare("INSERT INTO payments(ts,supplier,voucher_no,who,amount,gateway,ref,status) VALUES(?,?,?,?,?,?,?,?)").run("12 May 2026","AgriMart Tshwane","EV-2026-004471","Thabo Mokoena",3200,"PayGate (gateway)","PG-10000001","Paid");
  const ia=db.prepare("INSERT INTO applications(name,prov,dist,ent,demo,status,created) VALUES(?,?,?,?,?,?,?)");
  ia.run("Sibusiso Khoza","KZN","uMzinyathi","Maize · 2ha","M·30","Applied",today());
  ia.run("Refilwe Mahlangu","GP","Tshwane","Vegetables · 1ha","F·27","Applied",today());
  logAudit("System","Database created and seeded","info");
  console.log("✔ Database seeded (first run).");
}
// hash any plain-text passwords (one-time migration; safe to run every start)
for(const u of db.prepare('SELECT id,password FROM users').all()){ if(u.password && !String(u.password).includes(':')) db.prepare('UPDATE users SET password=? WHERE id=?').run(hashPw(u.password), u.id); }
// seed two test farmer cellphones so issuing them a voucher sends a REAL SMS
try{ db.prepare("UPDATE producers SET phone='+27718724388' WHERE name='Thabo Mokoena' AND (phone IS NULL OR phone='')").run();
     db.prepare("UPDATE producers SET phone='+27716084771' WHERE name='Nomsa Dlamini' AND (phone IS NULL OR phone='')").run(); }catch(e){}

// ---- helpers --------------------------------------------------------------
const json=(res,code,obj)=>{res.writeHead(code,{'Content-Type':'application/json'});res.end(JSON.stringify(obj));};
const body=req=>new Promise(r=>{let d='';req.on('data',c=>d+=c);req.on('end',()=>{try{r(d?JSON.parse(d):{})}catch{r({})}});});
const nextVoucherNo=()=> "EV-2026-00"+(480+db.prepare('SELECT COUNT(*) c FROM vouchers').get().c+1);
const otp4=()=> String(Math.floor(1000+Math.random()*9000));
const provOf=name=>{const r=db.prepare('SELECT prov FROM producers WHERE name=?').get(name);return r?r.prov:'';};
function matchProducers(q){           // criteria-based selection (women, youth, area) — NOT by individual
  let sql='SELECT * FROM producers WHERE status=\'Active\''; const a=[];
  if(q.gender==='F') sql+=" AND demo LIKE 'F%'"; else if(q.gender==='M') sql+=" AND demo LIKE 'M%'";
  if(q.youth) sql+=" AND CAST(substr(demo,instr(demo,'·')+1) AS INT)<=35";
  if(q.prov){ sql+=' AND prov=?'; a.push(q.prov); }
  if(q.dist){ sql+=' AND dist=?'; a.push(q.dist); }
  return db.prepare(sql).all(...a);
}

// ---- server ---------------------------------------------------------------
const SESSIONS = new Map();   // token -> { name, ts } : API access requires a valid session token
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost'); const p=url.pathname; const m=req.method;
  const scope=url.searchParams.get('scope')||'';
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy',"frame-ancestors 'none'");
  res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  res.setHeader('Strict-Transport-Security','max-age=31536000; includeSubDomains');
  try{
    if(p.startsWith('/api/')){

      // ---- API authentication gate: every endpoint except /api/login needs a valid token ----
      if(p!=='/api/login'){
        const tok=(req.headers['authorization']||'').replace(/^Bearer\s+/i,'')||req.headers['x-auth-token']||'';
        const sess=SESSIONS.get(tok);
        if(!sess || (Date.now()-sess.ts>12*3600*1000)){ if(sess) SESSIONS.delete(tok); return json(res,401,{error:'Not signed in'}); }
      }

      // ---- auth ----
      if(p==='/api/login' && m==='POST'){
        const b=await body(req); const un=(b.username||'').trim(); const pw=(b.password||'').trim();
        const row=db.prepare('SELECT * FROM users WHERE username=?').get(un);
        if(row && row.locked_until && Date.now() < row.locked_until)
          return json(res,423,{error:'Account locked after too many attempts. Try again in '+Math.ceil((row.locked_until-Date.now())/60000)+' min.'});
        if(!row || !checkPw(pw,row.password)){
          if(row){ const fa=(row.failed_attempts||0)+1; const lock=fa>=5?Date.now()+15*60000:null; db.prepare('UPDATE users SET failed_attempts=?, locked_until=? WHERE id=?').run(fa,lock,row.id); }
          return json(res,401,{error:'Invalid username or password'});
        }
        db.prepare('UPDATE users SET failed_attempts=0, locked_until=NULL WHERE id=?').run(row.id);
        logAudit(row.name,'Signed in','info');
        const token=crypto.randomBytes(24).toString('hex'); SESSIONS.set(token,{name:row.name, ts:Date.now()});
        return json(res,200,{username:row.username,name:row.name,role:row.role,scope:row.scope,token});
      }

      // ---- stats (optionally scoped to a province) ----
      if(p==='/api/stats' && m==='GET'){
        const pw = scope? ' WHERE prov=?':''; const args = scope?[scope]:[];
        const producers=db.prepare('SELECT COUNT(*) c FROM producers'+pw).get(...args).c;
        const vw = scope? ' WHERE prov=?':'';
        const issued=db.prepare('SELECT COUNT(*) c FROM vouchers'+vw).get(...args).c;
        const redeemed=db.prepare("SELECT COUNT(*) c FROM vouchers WHERE status='Redeemed'"+(scope?' AND prov=?':'')).get(...args).c;
        const value=db.prepare('SELECT COALESCE(SUM(val),0) s FROM vouchers'+vw).get(...args).s;
        const byProv=db.prepare('SELECT prov,COUNT(*) c FROM producers'+pw+' GROUP BY prov ORDER BY c DESC').all(...args);
        const female=db.prepare("SELECT COUNT(*) c FROM producers WHERE demo LIKE 'F%'"+(scope?' AND prov=?':'')).get(...args).c;
        const youth=db.prepare("SELECT COUNT(*) c FROM producers WHERE CAST(substr(demo,instr(demo,'·')+1) AS INT)<=35"+(scope?' AND prov=?':'')).get(...args).c;
        const confirmed=db.prepare("SELECT COUNT(*) c FROM vouchers WHERE confirm_status='Confirmed'"+(scope?' AND prov=?':'')).get(...args).c;
        const unconfirmed=db.prepare("SELECT COUNT(*) c FROM vouchers WHERE status='Redeemed' AND COALESCE(confirm_status,'')=''"+(scope?' AND prov=?':'')).get(...args).c;
        const disputed=db.prepare("SELECT COUNT(*) c FROM vouchers WHERE confirm_status='Disputed'"+(scope?' AND prov=?':'')).get(...args).c;
        return json(res,200,{producers,issued,redeemed,value,byProv,female,male:producers-female,youth,confirmed,unconfirmed,disputed});
      }

      // ---- producers ----
      if(p==='/api/producers' && m==='GET'){
        const rows = scope? db.prepare('SELECT * FROM producers WHERE prov=? ORDER BY id DESC').all(scope) : db.prepare('SELECT * FROM producers ORDER BY id DESC').all();
        return json(res,200,rows);
      }
      if(p==='/api/producers' && m==='POST'){
        const b=await body(req); if(!b.name)return json(res,400,{error:'name required'});
        const email=b.email||(b.name.toLowerCase().replace(/[^a-z ]/g,'').trim().replace(/ +/g,'.')+'@example.co.za');
        let ph=(b.phone||'').replace(/[\s\-()]/g,''); if(ph.startsWith('0'))ph='+27'+ph.slice(1); else if(ph.startsWith('27'))ph='+'+ph; else if(ph&&!ph.startsWith('+'))ph='+'+ph;
        const info=db.prepare('INSERT INTO producers(name,prov,dist,ent,status,rica,demo,email,phone) VALUES(?,?,?,?,?,?,?,?,?)').run(b.name,b.prov||'GP',b.dist||'—',b.ent||'—','Active',b.rica||'Verified',b.demo||'—',email,ph);
        logAudit(b.actor||'Admin',`Beneficiary added: ${b.name}`,'info');
        return json(res,200,db.prepare('SELECT * FROM producers WHERE id=?').get(info.lastInsertRowid));
      }
      let mm=p.match(/^\/api\/producers\/(\d+)$/);
      if(mm && m==='DELETE'){const r=db.prepare('SELECT name FROM producers WHERE id=?').get(+mm[1]);db.prepare('DELETE FROM producers WHERE id=?').run(+mm[1]);if(r)logAudit('Admin',`Beneficiary removed: ${r.name}`,'no');return json(res,200,{ok:true});}
      mm=p.match(/^\/api\/producers\/(\d+)\/suspend$/);
      if(mm && m==='POST'){const r=db.prepare('SELECT status,name FROM producers WHERE id=?').get(+mm[1]);const ns=r.status==='Suspended'?'Active':'Suspended';db.prepare('UPDATE producers SET status=? WHERE id=?').run(ns,+mm[1]);logAudit('Admin',`${r.name} ${ns==='Suspended'?'suspended':'reactivated'}`,ns==='Suspended'?'no':'ok');return json(res,200,{status:ns});}

      // ---- packages ----
      if(p==='/api/packages' && m==='GET') return json(res,200,db.prepare('SELECT * FROM packages ORDER BY id').all());
      if(p==='/api/packages' && m==='POST'){const b=await body(req);if(!b.name)return json(res,400,{error:'name required'});const info=db.prepare('INSERT INTO packages(name,val,items,status) VALUES(?,?,?,?)').run(b.name,+b.val||0,b.items||'—','Active');logAudit('Admin',`Package created: ${b.name}`,'info');return json(res,200,db.prepare('SELECT * FROM packages WHERE id=?').get(info.lastInsertRowid));}
      mm=p.match(/^\/api\/packages\/(\d+)$/); if(mm && m==='DELETE'){db.prepare('DELETE FROM packages WHERE id=?').run(+mm[1]);return json(res,200,{ok:true});}

      // ---- dealers ----
      if(p==='/api/dealers' && m==='GET') return json(res,200,db.prepare('SELECT * FROM dealers ORDER BY id').all());
      if(p==='/api/dealers' && m==='POST'){const b=await body(req);if(!b.name)return json(res,400,{error:'name required'});
        db.prepare('INSERT INTO dealers(name,prov,dist,contact,status,company_reg,vat,csd,bank,address,email,phone,catalogue) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(b.name,b.prov||'GP',b.dist||'—',b.contact||'—','Pending',b.company_reg||'',b.vat||'',b.csd||'',b.bank||'',b.address||'',b.email||'',b.phone||'',b.catalogue||'');
        logAudit('Admin',`Dealer registered (pending accreditation): ${b.name}`,'wait');return json(res,200,{ok:true});}
      mm=p.match(/^\/api\/dealers\/(\d+)\/approve$/); if(mm && m==='POST'){const d=db.prepare('SELECT name FROM dealers WHERE id=?').get(+mm[1]);db.prepare("UPDATE dealers SET status='Active' WHERE id=?").run(+mm[1]);logAudit('Admin',`Dealer accredited & activated: ${d?d.name:''}`,'ok');return json(res,200,{ok:true});}
      mm=p.match(/^\/api\/dealers\/(\d+)$/); if(mm && m==='DELETE'){db.prepare('DELETE FROM dealers WHERE id=?').run(+mm[1]);return json(res,200,{ok:true});}

      // ---- grievances ----
      if(p==='/api/grievances' && m==='GET') return json(res,200,db.prepare('SELECT * FROM grievances ORDER BY id DESC').all());
      if(p==='/api/grievances' && m==='POST'){const b=await body(req);const ref='GR-'+String(40+db.prepare('SELECT COUNT(*) c FROM grievances').get().c+3).padStart(4,'0');db.prepare('INSERT INTO grievances(ref,who,issue,status,created) VALUES(?,?,?,?,?)').run(ref,b.who||'—',b.issue||'—','Open',today());logAudit('Admin',`Grievance logged: ${ref}`,'wait');return json(res,200,{ref});}
      mm=p.match(/^\/api\/grievances\/(\d+)\/resolve$/); if(mm && m==='POST'){const r=db.prepare('SELECT ref FROM grievances WHERE id=?').get(+mm[1]);db.prepare("UPDATE grievances SET status='Resolved' WHERE id=?").run(+mm[1]);logAudit('Admin',`Grievance resolved: ${r?r.ref:''}`,'ok');return json(res,200,{ok:true});}

      // ---- vouchers ----
      if(p==='/api/vouchers' && m==='GET'){
        const rows = scope? db.prepare('SELECT * FROM vouchers WHERE prov=? ORDER BY id DESC').all(scope) : db.prepare('SELECT * FROM vouchers ORDER BY id DESC').all();
        return json(res,200,rows);
      }
      if(p==='/api/vouchers' && m==='POST'){
        const b=await body(req); const pk=db.prepare('SELECT * FROM packages WHERE name=?').get(b.pkg);
        if(!b.who||!pk)return json(res,400,{error:'producer and package required'});
        const dup=db.prepare("SELECT 1 FROM vouchers WHERE who=? AND pkg=? AND status='Issued'").get(b.who,pk.name);
        if(dup) return json(res,400,{error:'Beneficiary already has an active voucher for this package (anti double-dipping)'});
        const no=nextVoucherNo(); const otp=otp4();
        db.prepare('INSERT INTO vouchers(no,who,prov,pkg,val,status,otp,dealer,created,redeemed_at,expiry) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
          .run(no,b.who,provOf(b.who),pk.name,pk.val,'Issued',otp,'',today(),'',fyEnd());
        logAudit(b.who,`Voucher ${no} issued (${pk.name}) — valid until ${fyEnd()}`,'info');
        const ph=db.prepare('SELECT phone FROM producers WHERE name=?').get(b.who); let sms=null;
        if(ph&&ph.phone) sms=await sendSms(ph.phone, `DoA e-Voucher: You have received ${pk.name} (R${pk.val}). Redeem at an accredited agro-dealer with OTP ${otp}. Valid until ${fyEnd()}. Ref ${no}.`);
        return json(res,200,{no,val:pk.val,otp,expiry:fyEnd(),sms});
      }
      mm=p.match(/^\/api\/vouchers\/(\d+)\/redeem$/);
      if(mm && m==='POST'){
        const b=await body(req); const v=db.prepare('SELECT * FROM vouchers WHERE id=?').get(+mm[1]);
        if(!v)return json(res,404,{error:'voucher not found'});
        if(v.status==='Redeemed')return json(res,400,{error:'already redeemed'});
        if(v.status==='Awaiting confirmation')return json(res,400,{error:'goods already collected — awaiting the farmer’s confirmation of receipt'});
        if(v.expiry && new Date() > new Date(v.expiry+'T23:59:59')) return json(res,400,{error:'Voucher expired (financial year ended) — cannot redeem'});
        if(String(b.otp).trim()!==v.otp) return json(res,400,{error:'Wrong OTP — redemption refused'});
        const dealer=b.dealer||'(dealer)';
        const cc=otp4();   // confirmation code SMS-sent to the FARMER to verify receipt (added layer)
        // Dealer OTP method retained: supplier is paid immediately on redemption (unchanged).
        db.prepare("UPDATE vouchers SET status='Redeemed',dealer=?,redeemed_at=?,confirm_code=?,confirm_status='' WHERE id=?").run(dealer,today(),cc,+mm[1]);
        const ref='PG-'+Date.now().toString().slice(-8);
        db.prepare("INSERT INTO payments(ts,supplier,voucher_no,who,amount,gateway,ref,status) VALUES(?,?,?,?,?,?,?,?)").run(now(),dealer,v.no,v.who,v.val,'PayGate (gateway)',ref,'Paid');
        logAudit(v.who,`Voucher ${v.no} redeemed at ${dealer} — OTP verified; payment R${v.val} to supplier (${ref}). Farmer confirmation code SMS-sent to verify receipt.`,'ok');
        const rp=db.prepare('SELECT phone FROM producers WHERE name=?').get(v.who);
        if(rp&&rp.phone) await sendSms(rp.phone, `DoA e-Voucher: Please confirm you received your inputs for voucher ${v.no}. Confirmation code: ${cc}.`);
        return json(res,200,{ok:true,paid:v.val,ref,confirm_code:cc});
      }
      // FARMER confirms they actually received the goods (added assurance, after redemption)
      mm=p.match(/^\/api\/vouchers\/(\d+)\/confirm$/);
      if(mm && m==='POST'){
        const b=await body(req); const v=db.prepare('SELECT * FROM vouchers WHERE id=?').get(+mm[1]);
        if(!v)return json(res,404,{error:'voucher not found'});
        if(v.status!=='Redeemed')return json(res,400,{error:'only a redeemed voucher can be confirmed'});
        if(v.confirm_status==='Confirmed')return json(res,400,{error:'already confirmed by the farmer'});
        if(String(b.code||'').trim()!==v.confirm_code) return json(res,400,{error:'Wrong confirmation code — only the farmer who received the goods can confirm'});
        db.prepare("UPDATE vouchers SET confirm_status='Confirmed',confirmed_at=? WHERE id=?").run(now(),+mm[1]);
        logAudit(v.who,`Voucher ${v.no} — FARMER CONFIRMED receipt of goods from ${v.dealer}.`,'ok');
        return json(res,200,{ok:true});
      }
      // FARMER disputes (did not receive / short) — opens a grievance for investigation/recovery
      mm=p.match(/^\/api\/vouchers\/(\d+)\/dispute$/);
      if(mm && m==='POST'){
        const b=await body(req); const v=db.prepare('SELECT * FROM vouchers WHERE id=?').get(+mm[1]);
        if(!v)return json(res,404,{error:'voucher not found'});
        if(v.status!=='Redeemed')return json(res,400,{error:'only a redeemed voucher can be disputed'});
        db.prepare("UPDATE vouchers SET confirm_status='Disputed' WHERE id=?").run(+mm[1]);
        const ref='GR-'+String(40+db.prepare('SELECT COUNT(*) c FROM grievances').get().c+3).padStart(4,'0');
        db.prepare('INSERT INTO grievances(ref,who,issue,status,created) VALUES(?,?,?,?,?)').run(ref,v.who,`Did not receive / short delivery — voucher ${v.no} at ${v.dealer}. ${b.reason||'Reported by farmer.'} (Payment already made — investigate / recover.)`,'Open',today());
        logAudit(v.who,`Voucher ${v.no} DISPUTED by farmer — grievance ${ref} opened to investigate ${v.dealer} (payment already released; recovery may be needed).`,'no');
        return json(res,200,{ok:true,grievance:ref});
      }

      // ---- catalogue ----
      if(p==='/api/catalogue' && m==='GET') return json(res,200,db.prepare('SELECT * FROM catalogue ORDER BY id').all());
      if(p==='/api/catalogue' && m==='POST'){const b=await body(req);if(!b.n)return json(res,400,{error:'name required'});db.prepare('INSERT INTO catalogue(n,c,p,s) VALUES(?,?,?,?)').run(b.n,b.c||'—',+b.p||0,'Under review');logAudit('Admin',`Input added: ${b.n}`,'info');return json(res,200,{ok:true});}
      mm=p.match(/^\/api\/catalogue\/(\d+)$/); if(mm && m==='DELETE'){db.prepare('DELETE FROM catalogue WHERE id=?').run(+mm[1]);return json(res,200,{ok:true});}

      // ---- targeted auto-distribution (issue a package to everyone matching the criteria) ----
      if(p==='/api/distribute' && m==='POST'){
        const b=await body(req); const pk=db.prepare('SELECT * FROM packages WHERE name=?').get(b.pkg);
        if(!pk) return json(res,400,{error:'package required'});
        const list=matchProducers(b); let n=0;
        const iv=db.prepare('INSERT INTO vouchers(no,who,prov,pkg,val,status,otp,dealer,created,redeemed_at,expiry) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
        for(const pr of list){ if(db.prepare("SELECT 1 FROM vouchers WHERE who=? AND pkg=? AND status='Issued'").get(pr.name,pk.name)) continue; iv.run(nextVoucherNo(), pr.name, pr.prov, pk.name, pk.val, 'Issued', otp4(), '', today(), '', fyEnd()); n++; }
        logAudit('Admin',`Auto-distributed '${pk.name}' to ${n} beneficiaries by criteria (valid until ${fyEnd()})`,'info');
        return json(res,200,{count:n});
      }

      // ---- communications: email/SMS to a group of beneficiaries ----
      if(p==='/api/messages' && m==='GET') return json(res,200,db.prepare('SELECT * FROM messages ORDER BY id DESC LIMIT 50').all());
      if(p==='/api/messages' && m==='POST'){
        const b=await body(req); const recips=matchProducers(b).length;
        db.prepare('INSERT INTO messages(ts,audience,channel,subject,body,recipients) VALUES(?,?,?,?,?,?)').run(now(),b.audience||'All',b.channel||'Email',b.subject||'',b.body||'',recips);
        logAudit('Admin',`${b.channel||'Email'} sent to ${recips} beneficiaries: "${b.subject||''}"`,'info');
        return json(res,200,{count:recips});
      }

      // ---- farmer applications (apply -> screen -> approve/reject) ----
      if(p==='/api/applications' && m==='GET') return json(res,200,db.prepare('SELECT * FROM applications ORDER BY id DESC').all());
      if(p==='/api/applications' && m==='POST'){const b=await body(req);if(!b.name)return json(res,400,{error:'name required'});db.prepare('INSERT INTO applications(name,prov,dist,ent,demo,status,created) VALUES(?,?,?,?,?,?,?)').run(b.name,b.prov||'GP',b.dist||'—',b.ent||'—',b.demo||'—','Applied',today());logAudit('Farmer',`Application received: ${b.name}`,'wait');return json(res,200,{ok:true});}
      mm=p.match(/^\/api\/applications\/(\d+)\/recommend$/);
      if(mm && m==='POST'){const b=await body(req);const ap=db.prepare('SELECT * FROM applications WHERE id=?').get(+mm[1]);if(!ap)return json(res,404,{error:'not found'});if(ap.status!=='Applied')return json(res,400,{error:'Only new applications can be recommended'});db.prepare("UPDATE applications SET status='Recommended',recommended_by=? WHERE id=?").run(b.by||'District officer',+mm[1]);logAudit(b.by||'District',`Application recommended: ${ap.name}`,'info');return json(res,200,{ok:true});}
      mm=p.match(/^\/api\/applications\/(\d+)\/approve$/);
      if(mm && m==='POST'){const b=await body(req);const ap=db.prepare('SELECT * FROM applications WHERE id=?').get(+mm[1]);if(!ap)return json(res,404,{error:'not found'});
        if(ap.status!=='Recommended')return json(res,400,{error:'Application must be RECOMMENDED by a district officer before it can be approved (separation of duties)'});
        if(b.by&&ap.recommended_by&&b.by===ap.recommended_by)return json(res,400,{error:'The same official cannot both recommend and approve (separation of duties)'});
        db.prepare("UPDATE applications SET status='Approved',approved_by=? WHERE id=?").run(b.by||'Approver',+mm[1]);
        const email=ap.name.toLowerCase().replace(/[^a-z ]/g,'').trim().replace(/ +/g,'.')+'@example.co.za';
        db.prepare('INSERT INTO producers(name,prov,dist,ent,status,rica,demo,email) VALUES(?,?,?,?,?,?,?,?)').run(ap.name,ap.prov,ap.dist,ap.ent,'Active','Verified',ap.demo,email);
        logAudit(b.by||'Approver',`Application APPROVED & added to register: ${ap.name} (recommended by ${ap.recommended_by})`,'ok');return json(res,200,{ok:true});}
      mm=p.match(/^\/api\/applications\/(\d+)\/reject$/);
      if(mm && m==='POST'){const b=await body(req);const ap=db.prepare('SELECT name FROM applications WHERE id=?').get(+mm[1]);db.prepare("UPDATE applications SET status='Rejected',reason=? WHERE id=?").run(b.reason||'',+mm[1]);logAudit(b.by||'Admin',`Application rejected: ${ap?ap.name:''} (${b.reason||'no reason given'})`,'no');return json(res,200,{ok:true});}

      // ---- payments (auto-created at redemption, via gateway) ----
      if(p==='/api/payments' && m==='GET') return json(res,200,db.prepare('SELECT * FROM payments ORDER BY id DESC LIMIT 100').all());

      // ---- user feedback / ratings ----
      if(p==='/api/feedback' && m==='GET') return json(res,200,db.prepare('SELECT * FROM feedback ORDER BY id DESC LIMIT 100').all());
      if(p==='/api/feedback' && m==='POST'){const b=await body(req);db.prepare('INSERT INTO feedback(ts,role,rating,comment,by) VALUES(?,?,?,?,?)').run(now(),b.role||'—',+b.rating||0,b.comment||'',b.by||'');logAudit(b.by||'User',`Feedback: ${+b.rating||0}★ (${b.role||''})`,'info');return json(res,200,{ok:true});}

      // ================= SIMULATED INTEGRATIONS (mock APIs mirroring the real systems) =================
      if(p==='/api/integrations/status' && m==='GET') return json(res,200,[
        {system:'Farmer / Producer Register',detail:db.prepare('SELECT COUNT(*) c FROM farmer_register').get().c+' farmers'},
        {system:'Decision Support System (DSS)',detail:'weather & advisory feed'},
        {system:'Extension Directory',detail:'officer contacts'},
        {system:'RICA verification',detail:'cellphone-to-name check'},
        {system:'Payment gateway',detail:'supplier payouts'},
        {system:'BAS (Basic Accounting System)',detail:'government disbursement'},
        {system:'SMS gateway',detail:'OTP & notifications'}]);
      if(p==='/api/integrations/farmer-register' && m==='GET') return json(res,200,db.prepare('SELECT * FROM farmer_register ORDER BY enrolled, name').all());
      if(p==='/api/integrations/farmer-register/sync' && m==='POST'){
        const pend=db.prepare('SELECT * FROM farmer_register WHERE enrolled=0').all(); let n=0;
        const ip2=db.prepare('INSERT INTO producers(name,prov,dist,ent,status,rica,demo,email) VALUES(?,?,?,?,?,?,?,?)');
        for(const f of pend){ if(!db.prepare('SELECT 1 FROM producers WHERE name=?').get(f.name)){ ip2.run(f.name,f.prov,f.dist,f.ent,'Active',f.rica||'Verified',f.demo,(f.name.toLowerCase().replace(/[^a-z ]/g,'').trim().replace(/ +/g,'.')+'@example.co.za')); n++; } db.prepare('UPDATE farmer_register SET enrolled=1 WHERE id=?').run(f.id); }
        logAudit('System',`Synced ${n} farmers from the Farmer Register into beneficiaries`,'info');
        return json(res,200,{synced:n});
      }
      if(p==='/api/integrations/dss' && m==='GET'){const prov=url.searchParams.get('prov')||'national';const lv=['Low','Watch','Medium','High'];const i=[...prov].reduce((a,c)=>a+c.charCodeAt(0),0)%lv.length;return json(res,200,{prov,risk:lv[i],rainfall_mm:i*7+3,advisory:i>=2?'Dry spell expected — advise water-wise inputs':'Conditions favourable for planting',source:'DSS (simulated)'});}
      if(p==='/api/integrations/rica' && m==='GET'){const name=url.searchParams.get('name')||'';const ok=!/botha/i.test(name);return json(res,200,{name,verified:ok,result:ok?"Number registered in the producer's name":'Name mismatch — manual check required',source:'RICA (simulated)'});}
      if(p==='/api/integrations/extension-directory' && m==='GET') return json(res,200,[{name:'M. Sitali',role:'Extension Officer',prov:'KZN',cell:'082 000 0001'},{name:'J. Ngaka',role:'Extension Officer',prov:'LP',cell:'082 000 0002'},{name:'T. Mothibi',role:'Extension Officer',prov:'MP',cell:'082 000 0003'}]);
      if(p==='/api/integrations/sms' && m==='POST'){const b=await body(req);return json(res,200, await sendSms(b.to||'', b.body||b.message||'Test message from e-PSS (e-Voucher).'));}
      if(p==='/api/integrations/sms-status' && m==='GET'){ return json(res,200, await smsStatus(url.searchParams.get('id'))); }
      if(p==='/api/integrations/bas' && m==='POST'){const b=await body(req);return json(res,200,{ref:'BAS-'+Date.now().toString().slice(-8),amount:b.amount||0,status:'Disbursement raised',source:'BAS (simulated)'});}
      if(p==='/api/integrations/gateway' && m==='POST'){const b=await body(req);return json(res,200,{ref:'PG-'+Date.now().toString().slice(-8),amount:b.amount||0,status:'Paid',source:'Payment gateway (simulated)'});}

      // ---- users (list/add/remove for the Users & Access screen) ----
      if(p==='/api/users' && m==='GET') return json(res,200,db.prepare('SELECT id,username,name,role,scope FROM users ORDER BY id').all());
      if(p==='/api/users' && m==='POST'){const b=await body(req);if(!b.name)return json(res,400,{error:'name required'});const un=(b.name.toLowerCase().replace(/[^a-z]/g,'')||'user')+Math.floor(Math.random()*900+100);db.prepare('INSERT INTO users(username,password,name,role,scope) VALUES(?,?,?,?,?)').run(un,'demo123',b.name,b.role||'district',b.scope||'—');logAudit('Admin',`User added: ${b.name}`,'info');return json(res,200,{ok:true});}
      mm=p.match(/^\/api\/users\/(\d+)$/); if(mm && m==='DELETE'){db.prepare('DELETE FROM users WHERE id=?').run(+mm[1]);return json(res,200,{ok:true});}

      if(p==='/api/audit' && m==='GET') return json(res,200,db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 80').all());

      // tamper-evident audit: recompute the hash chain and report any break
      if(p==='/api/audit/verify' && m==='GET'){
        const rows=db.prepare('SELECT * FROM audit ORDER BY id').all();
        let prev='GENESIS', ok=true, broken=null, checked=0;
        for(const r of rows){
          if(r.hash==null) continue;   // legacy row from before hashing
          const expect=crypto.createHash('sha256').update(prev+'|'+r.ts+'|'+r.actor+'|'+r.event+'|'+r.kind).digest('hex');
          if(r.prev_hash!==prev || r.hash!==expect){ ok=false; broken=r.id; break; }
          prev=r.hash; checked++;
        }
        return json(res,200,{ok,checked,broken});
      }

      // confirmation oversight: per-dealer confirmed/awaiting/disputed (the aggregate-silence red flag)
      if(p==='/api/oversight/confirmation' && m==='GET'){
        const rows=db.prepare(`SELECT dealer,
          SUM(CASE WHEN status='Redeemed' THEN 1 ELSE 0 END) redeemed,
          SUM(CASE WHEN confirm_status='Confirmed' THEN 1 ELSE 0 END) confirmed,
          SUM(CASE WHEN status='Redeemed' AND COALESCE(confirm_status,'')='' THEN 1 ELSE 0 END) awaiting,
          SUM(CASE WHEN confirm_status='Disputed' THEN 1 ELSE 0 END) disputed
          FROM vouchers WHERE dealer IS NOT NULL AND dealer<>'' GROUP BY dealer ORDER BY disputed DESC, awaiting DESC`).all();
        return json(res,200,rows);
      }

      return json(res,404,{error:'unknown endpoint'});
    }

    // ---- static ----
    const file=p==='/'?'/index.html':p;
    const full=path.join(__dirname,'public',path.normalize(file).replace(/^(\.\.[/\\])+/,''));
    if(fs.existsSync(full)&&fs.statSync(full).isFile()){
      const ext=path.extname(full).toLowerCase(); const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.json':'application/json'};
      res.writeHead(200,{'Content-Type':types[ext]||'text/plain'}); return res.end(fs.readFileSync(full));
    }
    res.writeHead(404); res.end('Not found');
  }catch(e){console.error(e);json(res,500,{error:String(e)});}
});

server.listen(PORT,()=>{
  console.log(`\n  ✅ e-Voucher System is running.`);
  console.log(`  Open your browser at:  http://localhost:${PORT}\n`);
  console.log(`  Logins:  admin/admin123 (national)   kzn/kzn123 (provincial)   dealer/dealer123 (agro-dealer)`);
  console.log(`  Data saved in: ${DB_PATH}\n  (Keep this window open. Close it to stop.)\n`);
});
