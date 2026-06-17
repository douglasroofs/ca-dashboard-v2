// api/revenue.js - MTD revenue from LEAP Sales Performance Summary Report
// Calls the v1 API endpoint that powers LEAP's own Sales Performance Summary Report.
// Tries JP_API_TOKEN first; falls back to password-grant if JP_USERNAME/JP_PASSWORD are set.
// Excludes: Haley Barry, Doug Rimel, Kyle Higginbotham, TCNA

const EXCLUDE = ['haley barry', 'doug rimel', 'kyle higginbotham', 'carmen tcna', 'tcna'];

function isExcluded(name) {
    if (!name) return true;
    const n = name.toLowerCase().trim();
    return EXCLUDE.some(ex => n.includes(ex));
}

async function fetchReport(accessToken) {
    const url =
          'https://www.jobprogress.com/api/public/api/v1/reports/sales_performance_summary_report' +
          '?date_range_type=job_awarded_date&duration=MTD&with_inactive=0&with_archived=0' +
          '&page=1&limit=200&access_token=' + encodeURIComponent(accessToken);
    const r = await fetch(url);
    const data = await r.json();
    if (data && data.status === 200 && Array.isArray(data.data)) return data.data;
    return null;
}

async function passwordGrantToken() {
    const username = process.env.JP_USERNAME;
    const password = process.env.JP_PASSWORD;
    if (!username || !password) return null;
    const r = await fetch('https://www.jobprogress.com/api/public/api/v1/oauth/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
                  grant_type: 'password',
                  username,
                  password,
                  client_id: process.env.JP_CLIENT_ID || 'jobprogress',
                  client_secret: process.env.JP_CLIENT_SECRET || '',
          }).toString(),
    });
    const d = await r.json();
    return d.access_token || null;
}

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const jwtToken = process.env.JP_API_TOKEN;
    if (!jwtToken) return res.status(500).json({ error: 'JP_API_TOKEN not set.' });

    let rows = null;
    let authUsed = 'unknown';

    // Attempt 1: JP_API_TOKEN directly as v1 access_token
    try {
          rows = await fetchReport(jwtToken);
          if (rows) authUsed = 'v1-jwt';
    } catch (e) {
          console.error('v1 jwt attempt:', e.message);
    }

    // Attempt 2: OAuth password grant (JP_USERNAME + JP_PASSWORD)
    if (!rows) {
          try {
                  const oauthToken = await passwordGrantToken();
                  if (oauthToken) {
                            rows = await fetchReport(oauthToken);
                            if (rows) authUsed = 'v1-oauth';
                  }
          } catch (e) {
                  console.error('v1 oauth attempt:', e.message);
          }
    }

    if (!rows) {
          return res.status(502).json({
                  error: 'LEAP v1 report endpoint failed. Add JP_USERNAME + JP_PASSWORD env vars if JP_API_TOKEN does not work as v1 access_token.',
          });
    }

    const reps = rows
      .filter(r => !isExcluded(r.full_name))
      .map(r => ({
              id: r.id,
              name: (r.full_name || '').trim().replace(/\s+/g, ' '),
              contractAmount: parseFloat(r.contract_amount) || 0,
              contractsCount: parseInt(r.awarded_job_count, 10) || 0,
      }))
      .filter(r => r.contractAmount > 0)
      .sort((a, b) => b.contractAmount - a.contractAmount);

    const totalRevenue = reps.reduce((s, r) => s + r.contractAmount, 0);

    return res.json({ reps, totalRevenue, source: authUsed });
};
