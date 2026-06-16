// api/revenue.js — MTD revenue from LEAP/JobProgress
// Fetches proposals -> jobs -> worksheets to get contract amounts
// Add ?debug=1 to see raw field names from the API

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = process.env.JP_API_TOKEN;
  if (!token) return res.status(500).json({ error: 'JP_API_TOKEN not set' });

  const BASE = 'https://api.jobprogress.com/api/v3';
  const headers = { 'Authorization': 'Bearer ' + token };
  const debug = req.query.debug === '1';

  try {
    const now = new Date();
    const year = now.getFullYear();
    const mo = String(now.getMonth() + 1).padStart(2, '0');
    const monthStr = `${year}-${mo}`;

    // Fetch proposals
    const prResp = await fetch(BASE + '/proposals?limit=200', { headers });
    if (!prResp.ok) {
      return res.status(prResp.status).json({ error: 'LEAP proposals returned ' + prResp.status });
    }
    const prData = await prResp.json();
    const allProposals = prData.data || [];

    // Debug mode: show raw field names from proposal, job, and worksheet
    if (debug) {
      const sample = allProposals[0] || null;
      let sampleJob = null;
      let sampleWorksheet = null;

      if (sample && sample.job_id) {
        const jr = await fetch(`${BASE}/jobs/${sample.job_id}?includes[]=rep&includes[]=rep_user`, { headers });
        if (jr.ok) { const jd = await jr.json(); sampleJob = jd.data || jd; }
      }
      if (sample && sample.worksheet_id) {
        const wr = await fetch(`${BASE}/worksheets/${sample.worksheet_id}`, { headers });
        if (wr.ok) { const wd = await wr.json(); sampleWorksheet = wd.data || wd; }
      }

      return res.json({
        debug: true,
        totalProposals: allProposals.length,
        proposal: sample ? { allFields: Object.keys(sample), status: sample.status, title: sample.title, worksheet_id: sample.worksheet_id, job_id: sample.job_id, created_at: sample.created_at, updated_at: sample.updated_at } : null,
        job: sampleJob ? { allFields: Object.keys(sampleJob), contract_signed_date: sampleJob.contract_signed_date, awarded_date: sampleJob.awarded_date, created_at: sampleJob.created_at, rep: sampleJob.rep, rep_user: sampleJob.rep_user } : null,
        worksheet: sampleWorksheet ? { allFields: Object.keys(sampleWorksheet), ...sampleWorksheet } : null
      });
    }

    // --- Revenue calculation ---
    const SIGNED_STATUSES = ['accepted', 'signed', 'approved', 'won', 'contracted'];

    const thisMonthProposals = allProposals.filter(p => {
      const status = (p.status || '').toLowerCase();
      if (!SIGNED_STATUSES.includes(status)) return false;
      const dateField = p.contract_signed_date || p.signed_at || p.updated_at || p.created_at || '';
      return dateField.startsWith(monthStr);
    });

    // Get unique job IDs and worksheet IDs
    const jobIds = [...new Set(thisMonthProposals.map(p => p.job_id).filter(Boolean))];
    const worksheetIds = [...new Set(thisMonthProposals.map(p => p.worksheet_id).filter(Boolean))];

    // Fetch jobs for rep info
    const jobResults = await Promise.all(
      jobIds.map(id =>
        fetch(`${BASE}/jobs/${id}?includes[]=rep&includes[]=rep_user`, { headers })
          .then(r => r.ok ? r.json() : null)
          .catch(() => null)
      )
    );
    const jobMap = {};
    jobResults.forEach((result, i) => {
      if (result) jobMap[jobIds[i]] = result.data || result;
    });

    // Fetch worksheets for amounts
    const worksheetResults = await Promise.all(
      worksheetIds.map(id =>
        fetch(`${BASE}/worksheets/${id}`, { headers })
          .then(r => r.ok ? r.json() : null)
          .catch(() => null)
      )
    );
    const worksheetMap = {};
    worksheetResults.forEach((result, i) => {
      if (result) worksheetMap[worksheetIds[i]] = result.data || result;
    });

    // Aggregate per rep
    const repMap = {};
    thisMonthProposals.forEach(p => {
      const job = jobMap[p.job_id] || {};
      const worksheet = worksheetMap[p.worksheet_id] || {};

      // Try multiple rep field names
      const repUser = job.rep || job.rep_user || job.sales_rep || {};
      const rep = repUser.display_name || repUser.name ||
        ((repUser.first_name || '') + ' ' + (repUser.last_name || '')).trim() ||
        'Unknown';

      // Try multiple amount field names from worksheet first, then job
      const amount = Number(
        worksheet.total || worksheet.grand_total || worksheet.subtotal ||
        worksheet.amount || worksheet.price || worksheet.total_amount ||
        job.contract_amount || job.total_amount || job.amount || 0
      );

      if (!repMap[rep]) repMap[rep] = { rep, jobs: 0, amount: 0 };
      repMap[rep].jobs++;
      repMap[rep].amount += amount;
    });

    const reps = Object.values(repMap).sort((a, b) => b.amount - a.amount);

    return res.json({
      month: monthStr,
      contractedCount: thisMonthProposals.length,
      reps,
      note: thisMonthProposals.length === 0
        ? 'No contracted proposals found for this month. Add ?debug=1 to inspect field names.'
        : null
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
