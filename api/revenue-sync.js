// api/revenue-sync.js — push LEAP (JobProgress) revenue into Amplify (SalesScreen)
// ---------------------------------------------------------------------------
// Auth mirrors the PROVEN api/revenue.js path (ca-dashboard v1), which returns
// live data: OAuth password-grant login -> switch_company(5154) -> Bearer token,
// then the sales_performance_summary_report. Per-rep contract_amount is pushed
// to Amplify as two custom activities:
//   date_range_type[]=job_awarded_date     -> "Approved Revenue"          (Approved $)
//   date_range_type[]=contract_signed_date -> "Contract Signed Revenue"   (Contract $)
// Crediting is by rep EMAIL; Amplify routes each rep to their office board via
// their Department. Re-runs UPDATE (stable id per rep) — never double-count.
// Secrets (Vercel): JP_USERNAME, JP_PASSWORD, ampliphy (Amplify key).
// Optional overrides: JP_CLIENT_ID, JP_CLIENT_SECRET, JP_COMPANY_ID.
// Trigger: GET /api/revenue-sync     (add ?dry=1 to preview WITHOUT pushing)
// ---------------------------------------------------------------------------

const V1 = "https://jobprogress.com/api/public/api/v1";
const CLIENT_ID = process.env.JP_CLIENT_ID || "12345";
const CLIENT_SECRET = process.env.JP_CLIENT_SECRET || "XraqRySfIhUTuvdfz7ATuJxXYf8aX5MY";
const COMPANY_ID = process.env.JP_COMPANY_ID || "5154";

const AMPLIFY_PUSH_URL = "https://connect.salesscreen.com/api/v1/Record/Add";
const AMPLIFY_KEY = process.env.ampliphy || process.env.SALESRABBIT_PLUS_TOKEN;
const ACTIVITY_APPROVED = "Approved Revenue";
const ACTIVITY_CONTRACT = "Contract Signed Revenue";

// Canonical rep name (as it appears in JobProgress) -> Amplify user email.
const REP_EMAIL = {
  "Kelly Alston": "kelly@douglasroofs.com",
  "Steven Arevalo": "steven@douglasroofs.com",
  "Joshua Baca": "joshua@douglasroofs.com",
  "Dalton Barr": "dalton@douglasroofs.com",
  "Haley Barry": "haley@douglasroofs.com",
  "Sean Beasy": "sean@douglasroofs.com",
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
  "Marcus Schanewolf": "marcus@douglasroofs.com",
  "Mike Schoultz": "mike@douglasroofs.com",
  "Nick Seward": "nick@douglasroofs.com",
  "Harvey Shoemaker": "harvey@douglasroofs.com",
  "Brandon Simmons": "brandon@douglasroofs.com",
  "JR Zaguehi": "jr@douglasroofs.com",
};

// The report sometimes returns a name that differs from the canonical one above
// (surname/nickname drift). Map those report-name variants straight to email.
const ALIASES = {
  "robert wilson": "robert@douglasroofs.com",     // report: "Robert Wilson"
  "isabelle price": "isabelle@douglasroofs.com",  // report: "Isabelle Price" (map: Izzy)
  "michael mccarthy": "michaelmccarthy@douglasroofs.com", // report: "Michael McCarthy" (map: Mike)
};

// Normalize for tolerant matching: lowercase, collapse whitespace, trim.
function norm(s) { return (s || "").toLowerCase().replace(/\s+/g, " ").trim(); }
const EMAIL_BY_NORM = {};
for (const [k, v] of Object.entries(REP_EMAIL)) EMAIL_BY_NORM[norm(k)] = v;
for (const [k, v] of Object.entries(ALIASES)) EMAIL_BY_NORM[norm(k)] = v;
function resolveEmail(name) { return EMAIL_BY_NORM[norm(name)] || null; }

// ---- Auth (mirrors the working ca-dashboard v1 api/revenue.js) ----
async function login() {
  const r = await fetch(`${V1}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      username: process.env.JP_USERNAME,
      password: process.env.JP_PASSWORD,
      grant_type: "password",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      end_existing_sessions: "0",
    }).toString(),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`login -> ${r.status}: ${text.slice(0, 150)}`);
  let d = {}; try { d = JSON.parse(text); } catch (e) {}
  const token = (d.token && d.token.access_token) || d.access_token || (d.data && d.data.token && d.data.token.access_token);
  if (!token) throw new Error("login ok but no access_token in response");
  return token;
}

async function switchCompany(token) {
  const r = await fetch(`${V1}/users/switch_company`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", platform: "web" },
    body: new URLSearchParams({ company_id: COMPANY_ID }).toString(),
  });
  if (!r.ok) throw new Error(`switch_company -> ${r.status}: ${(await r.text()).slice(0, 150)}`);
  const d = await r.json().catch(() => ({}));
  return (d && d.token && d.token.access_token) || (d && d.access_token) || token;
}

let _tok = null;
async function getToken() {
  if (!_tok) _tok = await switchCompany(await login());
  return _tok;
}

async function apiGet(path) {
  let token = await getToken();
  let r = await fetch(`${V1}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json", platform: "web" } });
  if (r.status === 401 || r.status === 403) {
    _tok = null;
    token = await getToken();
    r = await fetch(`${V1}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json", platform: "web" } });
  }
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status}: ${(await r.text()).slice(0, 150)}`);
  return r.json();
}

const REPORT = "/reports/sales_performance_summary_report";
async function fetchRows(dateType) {
  const rows = [];
  for (let page = 1; page <= 50; page++) {
    const j = await apiGet(`${REPORT}?date_range_type[]=${dateType}&duration=MTD&limit=100&page=${page}&sort_field=full_name&sort_order=asc&with_inactive=0`);
    const data = j.data || j.rows || [];
    rows.push(...data);
    const pag = (j.meta && j.meta.pagination) || j.pagination || {};
    const totalPages = pag.total_pages || (data.length < 100 ? page : page + 1);
    if (page >= totalPages || data.length === 0) break;
  }
  return rows;
}

function dollars(row) {
  const n = parseFloat(row.contract_amount);
  return isNaN(n) ? 0 : n;
}

function toRecords(rows, activityTypeName, suffix, unmapped) {
  const recs = [];
  for (const row of rows) {
    const name = (row.full_name || "").trim();
    const amount = dollars(row);
    if (amount <= 0) continue;
    const email = resolveEmail(name);
    if (!email) { if (name && !unmapped.includes(name)) unmapped.push(name); continue; }
    recs.push({
      id: `rep-${row.id}-${suffix}`,        // stable per rep+figure -> idempotent updates
      activityTypeName,
      user: { id: email, email },
      activity: { key: "Revenue", name: "" },
      quantity: 1,
      value1: amount,                        // -> the "Amount" the currency metric sums
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
    const url = new URL(req.url, "http://localhost");
    const dry = url.searchParams.get("dry");

    const [approvedRows, contractRows] = await Promise.all([
      fetchRows("job_awarded_date"),
      fetchRows("contract_signed_date"),
    ]);

    const unmapped = [];
    const approvedRecs = toRecords(approvedRows, ACTIVITY_APPROVED, "approved", unmapped);
    const contractRecs = toRecords(contractRows, ACTIVITY_CONTRACT, "contract", unmapped);
    const records = [...approvedRecs, ...contractRecs];

    const approvedTotal = approvedRecs.reduce((s, r) => s + r.value1, 0);
    const contractTotal = contractRecs.reduce((s, r) => s + r.value1, 0);

    if (dry) {
      return res.status(200).json({
        ok: true, dry: true, built: records.length,
        approvedReps: approvedRows.length, contractReps: contractRows.length,
        approvedTotal: Math.round(approvedTotal * 100) / 100,
        contractTotal: Math.round(contractTotal * 100) / 100,
        unmapped, sample: records.slice(0, 6),
      });
    }

    const pushed = await pushToAmplify(records);
    return res.status(200).json({
      ok: true, pushed, built: records.length,
      approvedReps: approvedRows.length, contractReps: contractRows.length,
      approvedTotal: Math.round(approvedTotal * 100) / 100,
      contractTotal: Math.round(contractTotal * 100) / 100,
      unmapped,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// vercel.json cron (optional, daily 7am ET = 11:00 UTC):
// { "crons": [{ "path": "/api/revenue-sync", "schedule": "0 11 * * *" }] }
