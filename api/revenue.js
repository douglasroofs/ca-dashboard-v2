// api/revenue.js - MTD approved revenue from LEAP Sales Performance Summary Report
// Auth: POST /api/public/api/v1/login with JP_USERNAME + JP_PASSWORD to get access_token
// Excludes: Haley Barry, Doug Rimel, Kyle Higginbotham, TCNA

const EXCLUDE = ['haley barry', 'doug rimel', 'kyle higginbotham', 'carmen tcna', 'tcna'];
const BASE = 'https://www.jobprogress.com/api/public/api/v1';

function isExcluded(name) {
      if (!name) return true;
      const n = name.toLowerCase().trim();
      return EXCLUDE.some(ex => n.includes(ex));
}

async function getToken() {
      const username = process.env.JP_USERNAME;
      const password = process.env.JP_PASSWORD;
      if (!username || !password) return null;
      const r = await fetch(BASE + '/login', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ username, password }),
      });
      const d = await r.json();
      if (d && d.data && d.data.token && d.data.token.access_token) {
              return d.data.token.access_token;
      }
      console.error('login response:', JSON.stringify(d).substring(0, 200));
      return null;
}

async function fetchReport(accessToken) {
      const url =
              BASE + '/reports/sales_performance_summary_report' +
              '?date_range_type=job_awarded_date&duration=MTD&with_inactive=0&with_archived=0' +
              '&page=1&limit=200&access_token=' + encodeURIComponent(accessToken);
      const r = await fetch(url);
      const data = await r.json();
      if (data && data.status === 200 && Array.isArray(data.data)) return data.data;
      console.error('report response:', JSON.stringify(data).substring(0, 200));
      return null;
}

module.exports = async function handler(req, res) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'no-store');
      if (req.method === 'OPTIONS') return res.status(200).end();

      if (!process.env.JP_USERNAME || !process.env.JP_PASSWORD) {
              return res.status(500).json({ error: 'JP_USERNAME and JP_PASSWORD env vars required.' });
      }

      const token = await getToken();
      if (!token) {
              return res.status(502).json({ error: 'LEAP login failed. Check JP_USERNAME and JP_PASSWORD in Vercel env vars.' });
      }

      const rows = await fetchReport(token);
      if (!rows) {
              return res.status(502).json({ error: 'LEAP report endpoint failed after successful login.' });
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
      return res.json({ reps, totalRevenue, source: 'v1-login' });
};
