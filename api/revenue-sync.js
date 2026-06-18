// api/revenue-sync.js — push LEAP revenue into Amplify (SalesScreen)
// --------------------------------------------------------------------------
// Uses the SAME proven auth as api/revenue.js: POST /api/public/api/v1/login
// with JP_USERNAME + JP_PASSWORD → access_token, then the
// sales_performance_summary_report (per-rep contract_amount).
//   date_range_type=job_awarded_date     → "Approved $"
//   date_range_type=contract_signed_date → "Contract $"
// Revenue is per rep (full_name → Amplify email). Office split is automatic
// via each rep's Amplify Department. Period = MTD. Trigger: /api/revenue-sync
// Secrets (Vercel): JP_USERNAME, JP_PASSWORD, ampliphy (Amplify API key).
// --------------------------------------------------------------------------

const ACTIVITY_APPROVED = "Approved Revenue";
const ACTIVITY_CONTRACT = "Contract Signed Revenue";
const AMPLIFY_PUSH_URL  = "https://connect.salesscreen.com/api/v1/Record/Add";
const AMPLIFY_KEY = process.env.ampliphy || process.env.SALESRABBIT_PLUS_TOKEN;
const JP_BASE = "https://www.jobprogress.com/api/public/api/v1";

// Rep full_name (from LEAP) → Amplify user email.
const REP_EMAIL = {
  "Kelly Alston": "kelly@douglasroofs.com",
  "Steven Arevalo": "steven@douglasroofs.com",
  "Joshua Baca": "joshua@douglasroofs.com",
  "Dalton Barr": "dalton@douglasroofs.com",
  "haley barry": "haley@douglasroofs.com",
  "sean beasy": "sean@douglasroofs.com",
  "George Bechara": "gbechara@douglasroofs.com",
  "Christian Brown": "christian@douglasroofs.com",
  "Logan Burbic": "logan@douglasroofs.com",
  "Justin Coghill": "justin@douglasroofs.com",
  "Bryan Courtney": "bryan@douglasroofs.com",
  "Alfred Duncan": "alfred@douglasroofs.com",
  "Terry Eggleston": "terry@douglasroofs.com",
  "Andrew Funk": "andrew@douglasroofs.com",
  "Aiden Glonek": "aiden@douglasroofs.com",
  "Kenny Gonzalez": "kenny@douglasroofs.com",
  "Andrew Harris": "andrew.h@douglasroofs.com",
  "David Kerns": "david@douglasroofs.com",
  "Travis Kizzar": "travis@douglasroofs.com",
  "Solomon Lincoln Jr.": "solomon@douglasroofs.com",
  "Kevin Mahan": "kevin@douglasroofs.com",
  "Carter Massengill": "carter.m@douglasroofs.com",
  "Kevin Mccann": "kevinm@douglasroofs.com",
  "Mike Mccarthy": "michaelmccarthy@douglasroofs.com",
  "Marc Mitchell": "marc@douglasroofs.com",
  "Adam Mulvaney": "adam@douglasroofs.com",
  "Robert Mumford-Wilson": "robert@douglasroofs.com",
  "Jack Obert": "jack@douglasroofs.com",
  "Felipe Osorio": "felipe@douglasroofs.com",
  "Izzy Price": "isabelle@douglasroofs.com",
  "Andrew Prickel": "andrewprickel@douglasroofs.com",
  "Pedro Ramirez": "pedro@douglasroofs.com",
  "Cristina Saunders": "cristina@douglasroofs.com",
  "marcus schanewolf": "marcus@douglasroofs.com",
  "mike schoultz": "mike@douglasroofs.com",
  "nick seward": "nick@douglasroofs.com",
  "Harvey Shoemaker": "harvey@douglasroofs.com",
  "Brandon Simmons": "brandon@douglasroofs.com",
  "JR Zaguehi": "jr@douglasroofs.com",
};

async function getToken() {
  const r = await fetch(JP_BASE + "/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: process.env.JP_USERNAME, password: process.env.JP_PASSWORD }),
  });
  const d = await r.json().catch(() => ({}));
  return (d && d.data && d.data.token && d.data.token.access_token) || null;
}

async function fetchReport(token, dateType) {
  const url = JP_BASE + "/reports/sales_performance_summary_report"
    + `?date_range_type=${dateType}&duration=MTD&with_inactive=0&with_archived=0&page=1&limit=500`
    + "&access_token=" + encodeURIComponent(token);
  const r = await fetch(url);
  const d = await r.json().catch(() => ({}));
  return Array.isArray(d && d.data) ? d.data : [];
}

function toRecords(rows, activityTypeName, suffix) {
  const recs = [];
  for (const row of rows) {
    const name = (row.full_name || "").trim().replace(/\s+/g, " ");
    const email = REP_EMAIL[name];
    const amount = parseFloat(row.contract_amount) || 0;
    if (!email) { if (name) console.warn(`No email for rep "${name}" — skipped`); continue; }
    if (amount <= 0) continue;
    recs.push({
      id: `rep-${row.id}-${suffix}`,        // stable per rep → idempotent updates
      activityTypeName,
      user: { id: email, email },
      activity: { key: "Revenue", name: "" },
      quantity: 1,
      value1: amount,                        // → the "Amount" field the metric sums
    });
  }
  return recs;
}

async function pushToAmplify(records) {
  if (!AMPLIFY_KEY) throw new Error('Missing Amplify key (set "ampliphy" in Vercel)');
  let ok = 0;
  for (let i = 0; i < records.length; i += 100) {
    const batch = records.slice(i, i + 100);
    const res = await fetch(AMPLIFY_PUSH_URL, {
      method: "POST",
      headers: { apiKey: AMPLIFY_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(batch),
    });
    if (res.ok) ok += batch.length;
    else console.error("push batch failed", res.status, await res.text());
    await new Promise((r) => setTimeout(r, 1000));
  }
  return ok;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (!process.env.JP_USERNAME || !process.env.JP_PASSWORD) {
      return res.status(500).json({ ok: false, error: "JP_USERNAME / JP_PASSWORD not set" });
    }
    const token = await getToken();
    if (!token) return res.status(502).json({ ok: false, error: "LEAP login failed — check JP_USERNAME / JP_PASSWORD" });

    const [approvedRows, contractRows] = await Promise.all([
      fetchReport(token, "job_awarded_date"),
      fetchReport(token, "contract_signed_date"),
    ]);

    const records = [
      ...toRecords(approvedRows, ACTIVITY_APPROVED, "approved"),
      ...toRecords(contractRows, ACTIVITY_CONTRACT, "contract"),
    ];
    const pushed = await pushToAmplify(records);
    return res.status(200).json({
      ok: true, pushed, built: records.length,
      approvedReps: approvedRows.length, contractReps: contractRows.length,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// vercel.json cron (optional, daily 7am ET):
// { "crons": [{ "path": "/api/revenue-sync", "schedule": "0 11 * * *" }] }
