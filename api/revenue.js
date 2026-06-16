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

  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const awardedFrom = `${year}-${month}-01`;
  const awardedTo = `${year}-${month}-${day}`;
  const debug = req.query.debug === '1';

  try {
    // 1. Fetch all company users to map created_by IDs -> names
    // Use auth-only headers — Content-Type on GET causes 404 on /users endpoint
    const authHeaders = { 'Authorization': 'Bearer ' + token };
    const usersResp = await fetch(`${BASE}/users?limit=200`, { headers: authHeaders });
    const usersJson = usersResp.ok ? await usersResp.json() : {};
    const userList = usersJson?.data || [];
    const userMap = {};
    userList.forEach(u => {
      const n = u.display_name || u.name ||
        `${u.first_name || ''} ${u.last_name || ''}`.trim();
      userMap[u.id] = n.replace(/\s+/g, ' ').trim();
    });

    // 2. Fetch all awarded MTD jobs with reps + financial details (paginated)
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
          const respHeaders = {};
          resp.headers.forEach((v, k) => { respHeaders[k] = v; });
          return res.status(resp.status).json({ error: 'LEAP v3 API error', status: resp.status, body: text.substring(0, 500), responseHeaders: respHeaders });
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

    // 3. Group by rep: reps.data[0] > estimators.data[0] > created_by
    // Amount = financial_details.final_job_total (Document Amount in LEAP UI)
    const repMap = {};
    for (const job of allJobs) {
      const fd = job.financial_details || {};
      const amount = parseFloat(fd.final_job_total || fd.total_job_price || 0);

      const normName = s => (s || '').replace(/\s+/g, ' ').trim();
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
        repName = userMap[job.created_by] || `User ${job.created_by}`;
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

    const reps = Object.values(repMap)
      .filter(r => r.name && r.contractAmount > 0)
      .sort((a, b) => a.name.localeCompare(b.name));
    const totalRevenue = reps.reduce((sum, r) => sum + r.contractAmount, 0);

    if (debug) {
      return res.status(200).json({
        reps, totalRevenue,
        totalJobs: allJobs.length,
        awardedFrom, awardedTo,
        userMapSize: Object.keys(userMap).length,
        usersStatus: usersResp.status,
        repMapAll: Object.values(repMap),
      });
    }
    return res.status(200).json({ reps, totalRevenue });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
