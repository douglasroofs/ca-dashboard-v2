// api/revenue.js - MTD revenue from LEAP v3 API
// Auth: JP_API_TOKEN (JWT) - server-to-server, no session cookies needed
// Groups awarded MTD jobs by customer rep (falls back to created_by user)
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = process.env.JP_API_TOKEN;
  if (!token) return res.status(500).json({ error: 'JP_API_TOKEN not set in Vercel env vars.' });

  const BASE = 'https://api.jobprogress.com/api/v3';
  const headers = {
    'Authorization': 'Bearer ' + token,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  };
  // Use auth-only for GET endpoints - Content-Type causes 404 on some v3 routes
  const authOnly = { 'Authorization': 'Bearer ' + token };

  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const awardedFrom = `${year}-${month}-01`;
  const awardedTo = `${year}-${month}-${day}`;
  const debug = req.query.debug === '1';

  const normName = s => (s || '').replace(/\s+/g, ' ').trim();

  try {
    // 1. Fetch awarded MTD jobs with reps + financial details (paginated)
    let allJobs = [];
    let page = 1;
    while (true) {
      const url = `${BASE}/jobs?awarded_jobs=1&awarded_from=${awardedFrom}&awarded_to=${awardedTo}` +
        `&includes[]=reps&includes[]=estimators&includes[]=financial_details` +
        `&limit=100&page=${page}`;
      const resp = await fetch(url, { headers });
      if (!resp.ok) {
        const text = await resp.text();
        if (debug) {
          const rh = {};
          resp.headers.forEach((v, k) => { rh[k] = v; });
          return res.status(resp.status).json({ error: 'LEAP v3 API error', status: resp.status, body: text.substring(0, 500), responseHeaders: rh });
        }
        return res.status(resp.status).json({ error: 'LEAP v3 API error', status: resp.status });
      }
      const json = await resp.json();
      const jobs = json?.data || [];
      allJobs = allJobs.concat(jobs);
      if (jobs.length < 100) break;
      page++;
      if (page > 20) break;
    }

    // 2. Group by rep: reps.data[0] > estimators.data[0] > created_by
    // Amount = financial_details.final_job_total (Document Amount in LEAP UI)
    const repMap = {};
    for (const job of allJobs) {
      const fd = job.financial_details || {};
      const amount = parseFloat(fd.final_job_total || fd.total_job_price || 0);

      let repId = null;
      let repName = null;

      if (job.reps?.data?.length > 0) {
        const r = job.reps.data[0];
        repId = r.id;
        repName = normName(r.display_name || r.full_name || `${r.first_name || ''} ${r.last_name || ''}`);
      } else if (job.estimators?.data?.length > 0) {
        const e = job.estimators.data[0];
        repId = e.id;
        repName = normName(e.display_name || e.full_name || `${e.first_name || ''} ${e.last_name || ''}`);
      } else if (job.created_by) {
        repId = `u_${job.created_by}`;
        repName = `User ${job.created_by}`; // resolved below
      } else {
        repId = 'unassigned';
        repName = 'Unassigned';
      }

      if (!repMap[repId]) {
        repMap[repId] = { id: repId, name: repName, contractAmount: 0, contractsCount: 0 };
      }
      repMap[repId].contractAmount += amount;
      repMap[repId].contractsCount += 1;
    }

    // 3. Resolve created_by user IDs individually (list endpoint returns 404 with this JWT)
    const unknownEntries = Object.values(repMap).filter(r => String(r.id).startsWith('u_'));
    if (unknownEntries.length > 0) {
      const results = await Promise.all(
        unknownEntries.map(r => {
          const uid = String(r.id).slice(2);
          return fetch(`${BASE}/users/${uid}`, { headers: authOnly })
            .then(res2 => res2.ok ? res2.json() : null)
            .catch(() => null);
        })
      );
      results.forEach((result, i) => {
        if (result) {
          const u = result.data || result;
          const n = normName(u.display_name || u.name || `${u.first_name || ''} ${u.last_name || ''}`);
          if (n) repMap[unknownEntries[i].id].name = n;
        }
      });
    }

    const reps = Object.values(repMap)
      .filter(r => r.name && r.contractAmount > 0)
      .sort((a, b) => a.name.localeCompare(b.name));
    const totalRevenue = reps.reduce((sum, r) => sum + r.contractAmount, 0);

    if (debug) {
      return res.status(200).json({
        reps, totalRevenue,
        totalJobs: allJobs.length,
        awardedFrom, awardedTo,
        unknownResolved: unknownEntries.length,
        repMapAll: Object.values(repMap),
      });
    }
    return res.status(200).json({ reps, totalRevenue });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
