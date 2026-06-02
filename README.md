# e-Voucher System — the real (working) version

This is a **real working system** that saves data in a database file on this PC
(`evoucher.db`). Unlike the prototype, what you add here **stays** after you reload or
restart.

## How to start it
1. Double-click **run-eVoucher.bat**.
2. A black window opens (the server) and your browser opens at **http://localhost:3000**.
3. Sign in (any username/password — it's a demo login) and use it.
4. To stop: close the black window.

If the browser opens before it's ready, just refresh the page once.

## What works (saves to the database)
- **Beneficiaries** — add / remove / suspend (persists)
- **Subsidy packages** — create / remove (persists)
- **Voucher issuance** — issue a voucher (persists, updates the dashboard)
- **Dashboard** — live counts read from the database
- **Audit trail** — every action is recorded automatically

## Proof it's real
Add a beneficiary, then **close the black window and start it again** — your beneficiary
is still there, because it was saved to `evoucher.db`.

## What this is NOT (yet)
This is built in Node.js for learning and ownership. The tender's *production* system
would use C#/.NET + SQL Server and the real integrations (BAS, RICA, payment gateway).
The ideas and structure here port directly to that.

## Files
- `server.js` — the server + database (the "engine")
- `public/index.html` — the web interface (what you see)
- `evoucher.db` — your data (created automatically on first run)
- `run-eVoucher.bat` — the launcher
