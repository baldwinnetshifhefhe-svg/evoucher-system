// ============================================================================
//  e-Voucher System — real backend server  (Node.js + built-in SQLite)
//  Run:  node server.js   (or double-click run-eVoucher.bat)
// ============================================================================
const http = require('node:http');
const fs   = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;            // Render supplies PORT automatically
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'evoucher.db');
const db = new DatabaseSync(DB_PATH);

// ---- tables ---------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS producers(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT,prov TEXT,dist TEXT,ent TEXT,status TEXT DEFAULT 'Active',rica TEXT DEFAULT 'Verified',demo TEXT,email TEXT);
CREATE TABLE IF NOT EXISTS packages(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT,val INTEGER,items TEXT,status TEXT DEFAULT 'Active');
CREATE TABLE IF NOT EXISTS vouchers(id INTEGER PRIMARY KEY AUTOINCREMENT,no TEXT,who TEXT,prov TEXT,pkg TEXT,val INTEGER,status TEXT,otp TEXT,dealer TEXT,created TEXT,redeemed_at TEXT,expiry TEXT);
CREATE TABLE IF NOT EXISTS dealers(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT,prov TEXT,dist TEXT,contact TEXT,status TEXT DEFAULT 'Active',company_reg TEXT,vat TEXT,csd TEXT,bank TEXT,address TEXT,email TEXT,phone TEXT,catalogue TEXT);
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT,username TEXT UNIQUE,password TEXT,name TEXT,role TEXT,scope TEXT);
CREATE TABLE IF NOT EXISTS grievances(id INTEGER PRIMARY KEY AUTOINCREMENT,ref TEXT,who TEXT,issue TEXT,status TEXT DEFAULT 'Open',created TEXT);
CREATE TABLE IF NOT EXISTS catalogue(id INTEGER PRIMARY KEY AUTOINCREMENT,n TEXT,c TEXT,p INTEGER,s TEXT DEFAULT 'Approved');
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT,ts TEXT,audience TEXT,channel TEXT,subject TEXT,body TEXT,recipients INTEGER);
CREATE TABLE IF NOT EXISTS applications(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT,prov TEXT,dist TEXT,ent TEXT,demo TEXT,status TEXT DEFAULT 'Applied',created TEXT,recommended_by TEXT,approved_by TEXT,reason TEXT);
CREATE TABLE IF NOT EXISTS payments(id INTEGER PRIMARY KEY AUTOINCREMENT,ts TEXT,supplier TEXT,voucher_no TEXT,who TEXT,amount INTEGER,gateway TEXT,ref TEXT,status TEXT);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT,ts TEXT,actor TEXT,event TEXT,kind TEXT);
`);

const now = () => new Date().toLocaleString('en-ZA');
const today = () => new Date().toLocaleDateString('en-ZA');
const fyEnd = () => { const d=new Date(); const y=d.getMonth()>=3?d.getFullYear()+1:d.getFullYear(); return y+'-03-31'; }; // SA financial year ends 31 March
const fyLabel = () => { const d=new Date(); const s=d.getMonth()>=3?d.getFullYear():d.getFullYear()-1; return s+'/'+String(s+1).slice(2); };
function logAudit(actor,event,kind){ db.prepare('INSERT INTO audit(ts,actor,event,kind) VALUES(?,?,?,?)').run(now(),actor,event,kind); }

// ---- seed (first run only) ------------------------------------------------
if (db.prepare('SELECT COUNT(*) c FROM producers').get().c === 0){
  const ip=db.prepare('INSERT INTO producers(name,prov,dist,ent,status,rica,demo) VALUES(?,?,?,?,?,?,?)');
  [["Thabo Mokoena","FS","Thaba Nchu","Maize · 4ha","Active","Verified","M·41"],
   ["Nomsa Dlamini","KZN","uMzinyathi","Vegetables · 1.5ha","Active","Verified","F·29"],
   ["Pieter van Wyk","WC","Swartland","Wheat · 12ha","Pending","Verified","M·53"],
   ["Lerato Sithole","GP","Tshwane","Poultry · 800 birds","Active","Verified","F·34"],
   ["Sipho Ndlovu","MP","Nkomazi","Sugarcane · 6ha","Active","Verified","M·47"],
   ["Anna Botha","NW","Mahikeng","Cattle · 40 head","Suspended","Mismatch","F·61"],
   ["Zanele Khumalo","KZN","Zululand","Vegetables · 2ha","Active","Verified","F·26"],
   ["Dineo Phiri","LP","Vhembe","Tomatoes · 3ha","Active","Verified","F·31"],
   ["Bongani Zulu","KZN","King Cetshwayo","Goats · 60 head","Active","Verified","M·44"],
   ["Andile Mbeki","EC","OR Tambo","Maize · 2.5ha","Active","Verified","M·33"],
  ].forEach(r=>ip.run(...r));
  db.prepare("UPDATE producers SET email = lower(replace(name,' ','.'))||'@example.co.za' WHERE email IS NULL").run();

  const ipk=db.prepare('INSERT INTO packages(name,val,items,status) VALUES(?,?,?,?)');
  [["Maize starter pack",3200,"Maize seed 10kg + LAN 50kg","Active"],
   ["Vegetable seed + fertiliser",1850,"Veg seed kit + fertiliser","Active"],
   ["Poultry feed pack",2400,"Starter feed 40kg x2","Active"],
   ["Sunflower seed + fertiliser",5400,"Sunflower seed 5kg + fert.","Active"],
  ].forEach(r=>ipk.run(...r));

  const idl=db.prepare('INSERT INTO dealers(name,prov,dist,contact,status) VALUES(?,?,?,?,?)');
  [["AgriMart Tshwane","GP","Tshwane","D. Naidoo","Active"],
   ["FarmCo Nkomazi","MP","Nkomazi","S. Mahlangu","Active"],
   ["KZN Agri Supplies","KZN","Zululand","B. Cele","Active"],
   ["Vhembe Farm Centre","LP","Vhembe","R. Netshi","Pending"],
  ].forEach(r=>idl.run(...r));

  const ic=db.prepare('INSERT INTO catalogue(n,c,p,s) VALUES(?,?,?,?)');
  [["Maize seed (10kg)","Seed",850,"Approved"],["LAN fertiliser (50kg)","Fertiliser",620,"Approved"],
   ["Vegetable seed kit","Seed",430,"Approved"],["Poultry starter feed (40kg)","Feed",540,"Approved"],
   ["Tomato seedlings (tray)","Seedlings",180,"Approved"],["Sunflower seed (5kg)","Seed",720,"Approved"],
   ["Knapsack sprayer","Equipment",1200,"Under review"],["Cattle lick supplement","Feed",390,"Approved"],
  ].forEach(r=>ic.run(...r));

  const iu=db.prepare('INSERT INTO users(username,password,name,role,scope) VALUES(?,?,?,?,?)');
  iu.run("admin","admin123","Motshidisi Sitali","national","All provinces");
  iu.run("kzn","kzn123","Quinton Nyoka","provincial","KwaZulu-Natal");
  iu.run("dealer","dealer123","AgriMart Tshwane","dealer","AgriMart Tshwane");
  iu.run("zmkhize","demo123","Zinhle Mkhize","provincial","Free State");
  iu.run("jngaka","demo123","James Ngaka","district","Vhembe (LP)");
  iu.run("mlekganyane","demo123","Mpho Lekganyane","district","Tshwane (GP)");
  iu.run("bcoetzer","demo123","Ben Coetzer","finance","Treasury / BAS");
  iu.run("swilliams","demo123","Sara Williams","auditor","All provinces");

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
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost'); const p=url.pathname; const m=req.method;
  const scope=url.searchParams.get('scope')||'';
  try{
    if(p.startsWith('/api/')){

      // ---- auth ----
      if(p==='/api/login' && m==='POST'){
        const b=await body(req);
        const u=db.prepare('SELECT username,name,role,scope FROM users WHERE username=? AND password=?').get((b.username||'').trim(),(b.password||'').trim());
        if(!u) return json(res,401,{error:'Invalid username or password'});
        logAudit(u.name,'Signed in','info');
        return json(res,200,u);
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
        return json(res,200,{producers,issued,redeemed,value,byProv,female,male:producers-female,youth});
      }

      // ---- producers ----
      if(p==='/api/producers' && m==='GET'){
        const rows = scope? db.prepare('SELECT * FROM producers WHERE prov=? ORDER BY id DESC').all(scope) : db.prepare('SELECT * FROM producers ORDER BY id DESC').all();
        return json(res,200,rows);
      }
      if(p==='/api/producers' && m==='POST'){
        const b=await body(req); if(!b.name)return json(res,400,{error:'name required'});
        const email=b.email||(b.name.toLowerCase().replace(/[^a-z ]/g,'').trim().replace(/ +/g,'.')+'@example.co.za');
        const info=db.prepare('INSERT INTO producers(name,prov,dist,ent,status,rica,demo,email) VALUES(?,?,?,?,?,?,?,?)').run(b.name,b.prov||'GP',b.dist||'—',b.ent||'—','Active',b.rica||'Verified',b.demo||'—',email);
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
        logAudit(b.who,`Voucher ${no} issued (${pk.name}) — SMS sent with OTP; valid until ${fyEnd()}`,'info');
        return json(res,200,{no,val:pk.val,otp,expiry:fyEnd()});
      }
      mm=p.match(/^\/api\/vouchers\/(\d+)\/redeem$/);
      if(mm && m==='POST'){
        const b=await body(req); const v=db.prepare('SELECT * FROM vouchers WHERE id=?').get(+mm[1]);
        if(!v)return json(res,404,{error:'voucher not found'});
        if(v.status==='Redeemed')return json(res,400,{error:'already redeemed'});
        if(v.expiry && new Date() > new Date(v.expiry+'T23:59:59')) return json(res,400,{error:'Voucher expired (financial year ended) — cannot redeem'});
        if(String(b.otp).trim()!==v.otp) return json(res,400,{error:'Wrong OTP — redemption refused'});
        const dealer=b.dealer||'(dealer)';
        db.prepare("UPDATE vouchers SET status='Redeemed',dealer=?,redeemed_at=? WHERE id=?").run(dealer,today(),+mm[1]);
        // IMMEDIATE payment to the supplier via the payment gateway, the instant redemption is confirmed
        const ref='PG-'+Date.now().toString().slice(-8);
        db.prepare("INSERT INTO payments(ts,supplier,voucher_no,who,amount,gateway,ref,status) VALUES(?,?,?,?,?,?,?,?)").run(now(),dealer,v.no,v.who,v.val,'PayGate (gateway)',ref,'Paid');
        logAudit(v.who,`Voucher ${v.no} redeemed at ${dealer} — OTP verified; immediate payment R${v.val} to supplier via gateway (${ref})`,'ok');
        return json(res,200,{ok:true,paid:v.val,ref});
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

      // ---- users (list/add/remove for the Users & Access screen) ----
      if(p==='/api/users' && m==='GET') return json(res,200,db.prepare('SELECT id,username,name,role,scope FROM users ORDER BY id').all());
      if(p==='/api/users' && m==='POST'){const b=await body(req);if(!b.name)return json(res,400,{error:'name required'});const un=(b.name.toLowerCase().replace(/[^a-z]/g,'')||'user')+Math.floor(Math.random()*900+100);db.prepare('INSERT INTO users(username,password,name,role,scope) VALUES(?,?,?,?,?)').run(un,'demo123',b.name,b.role||'district',b.scope||'—');logAudit('Admin',`User added: ${b.name}`,'info');return json(res,200,{ok:true});}
      mm=p.match(/^\/api\/users\/(\d+)$/); if(mm && m==='DELETE'){db.prepare('DELETE FROM users WHERE id=?').run(+mm[1]);return json(res,200,{ok:true});}

      if(p==='/api/audit' && m==='GET') return json(res,200,db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 80').all());

      return json(res,404,{error:'unknown endpoint'});
    }

    // ---- static ----
    const file=p==='/'?'/index.html':p;
    const full=path.join(__dirname,'public',path.normalize(file).replace(/^(\.\.[/\\])+/,''));
    if(fs.existsSync(full)&&fs.statSync(full).isFile()){
      const ext=path.extname(full).toLowerCase(); const types={'.html':'text/html','.js':'text/javascript','.css':'text/css'};
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
