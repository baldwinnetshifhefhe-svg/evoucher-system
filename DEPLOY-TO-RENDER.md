# Putting the e-Voucher System online with Render

Goal: turn your local system into a real web link (like `evoucher-system.onrender.com`)
you can open from any device and share.

It happens in two stages:
- **Stage A** — put the code on GitHub (Render reads it from there).
- **Stage B** — connect Render to that GitHub repo and deploy.

---

## STAGE A — Put the code on GitHub

1. Open **github.com** in your browser and sign in.
2. Click the **+** at the top-right, then **New repository**.
3. **Repository name:** type `evoucher-system`.
4. Leave it **Public** (or Private — both work).
5. **IMPORTANT:** do **NOT** tick "Add a README", ".gitignore" or "license" — leave them off (we already have those files).
6. Click **Create repository**.
7. On the next page, **copy the repository web address** — it looks like
   `https://github.com/YOURNAME/evoucher-system.git`.
8. **Send that address to me** and I'll upload the code for you. (A GitHub sign-in
   window may pop up on your screen — just approve it.)

---

## STAGE B — Deploy on Render

*(Do this once the code is on GitHub.)*

1. Open **render.com** and sign in (the account you use for MasterMaths).
2. Click **New +** (top-right), then **Web Service**.
3. Choose **Build and deploy from a Git repository**, click **Next**.
4. Find **evoucher-system** in the list and click **Connect**.
   (If it's not listed, click "Configure account" to give Render access to the repo.)
5. Render reads our settings automatically. Check they say:
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `node --no-warnings server.js`
   - **Instance Type:** **Free**
6. Click **Create Web Service**.
7. Wait 2–4 minutes while it builds (you'll see logs scrolling). When it says
   **"Live"**, click the link at the top — that's your public address. 🎉

---

## Honest notes about the FREE plan

- **It sleeps when idle.** After ~15 minutes with no visitors, the free service goes to
  sleep. The next visit takes about **30–60 seconds** to wake up, then it's normal. (Tell
  anyone you share it with to wait a moment on first load.)
- **Saved data resets on restart.** On the free plan the database starts fresh whenever
  Render restarts or re-deploys the app. So the **seeded demo data is always there**, and
  anything you add stays **during a session**, but may reset later.
- **Want data to stay permanently?** Two options, both easy to add later:
  1. Add a small **Render Persistent Disk** (about \$1/month) — keeps the database file.
  2. Switch to a **free cloud database** (Turso/Neon) — keeps data without a disk.
  Just say the word and I'll set either one up.

---

## If something goes wrong
- Build fails mentioning Node version → tell me; we'll pin the Node version.
- Page loads but is blank → wait for it to finish waking, then refresh (Ctrl+F5).
- Send me a screenshot of the Render logs and I'll read them.
