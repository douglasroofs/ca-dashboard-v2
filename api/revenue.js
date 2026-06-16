// api/revenue.js - MTD revenue from LEAP Sales Performance Summary Report
// Auth: uses JP_LEAP_TOKEN (OAuth session access_token from LEAP web login)
// Header: platform: web  (required by LEAP public API)
// CloudFront: CF signed cookies required (LEAP_CF_COOKIES env var)
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = process.env.JP_LEAP_TOKEN || process.env.JP_PUBLIC_TOKEN || process.env.JP_API_TOKEN;
  if (!token) return res.status(500).json({ error: 'No API token configured. Set JP_LEAP_TOKEN in Vercel env vars.' });

  const BASE = 'https://jobprogress.com/api/public/api/v1';
  const params = new URLSearchParams({
        duration: 'MTD', with_inactive: '0', with_archived: '0',
        limit: '50', page: '1', sort_field: 'full_name', sort_order: 'asc',
  });
  params.append('date_range_type[]', 'job_awarded_date');
  const debug = req.query.debug === '1';

  const headers = {
    'Authorization': 'Bearer ' + token,
    'platform': 'web',
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  };
  if (process.env.LEAP_CF_COOKIES) {
    headers['Cookie'] = process.env.LEAP_CF_COOKIES;
  }

  try {
    const resp = await fetch(`${BASE}/reports/sales_performance_summary_report?${params}`, { headers });
    if (!resp.ok) {
      const text = await resp.text();
      return res.status(resp.status).json({
        error: 'LEAP API error', status: resp.status,
        body: debug ? text : text.substring(0, 300),
        hint: resp.status === 401
          ? 'Token expired or invalid. Update JP_LEAP_TOKEN in Vercel env vars with a fresh OAuth access_token from LEAP browser session (ls.AppUser.token.access_token). Also refresh LEAP_CF_COOKIES (CloudFront cookies expire ~5 days).'
          : undefined,
      });
    }
    const json = await resp.json();
    const rows = json.data || json || [];
    if (debug) return res.status(200).json({ raw: json, rowCount: rows.length, sampleKeys: rows[0] ? Object.keys(rows[0]) : [] });
    const reps = rows.map(r => ({
      id: r.id,
      name: r.full_name || `${r.first_name || ''} ${r.last_name || ''}`.trim(),
      contractAmount: parseFloat(r.contract_amount || 0),
      bidAmount: parseFloat(r.bid_amount || 0),
      closingPct: parseFloat(r.closing_percentage || 0),
      contractsCount: parseInt(r.contracts_jobs_count || 0, 10),
      bidsCount: parseInt(r.bids_jobs_count || 0, 10),
    })).filter(r => r.name);
    const totalRevenue = reps.reduce((sum, r) => sum + r.contractAmount, 0);
    return res.status(200).json({ reps, totalRevenue });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
