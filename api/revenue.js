// api/revenue.js — MTD revenue from LEAP/JobProgress
// Uses proposals -> individual jobs approach (bulk jobs endpoint is restricted)
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

    const prResp = await fetch(BASE + '/proposals?limit=200', { headers });
    if (!prResp.ok) {
      return res.status(prResp.status).json({ error: 'LEAP proposals returned ' + prResp.status });
    }
    const prData = await prResp.json();
    const allProposals = prData.data || [];

    if (debug) {
      const sample = allProposals[0] || null;
      let sampleJob = null;
      if (sample && sample.job_id) {
        const jr = await fetch(`${BASE}/jobs/${sample.job_id}?includes[]=rep_user`, { headers });
        if (jr.ok) { const jd = await jr.json(); sampleJob = jd.data || jd; }
      }
      return res.json({
        debug: true,
        totalProposals: allProposals.length,
        proposal: sample ? { allFields: Object.keys(sample), status: sample.status, title: sample.title, price: sample.price, total: sample.total, amount: sample.amount, grand_total: sample.grand_total, contract_amount: sample.contract_amount, created_at: sample.created_at, updated_at: sample.updated_at, signed_at: sample.signed_at, contract_signed_date: sample.contract_signed_date, date: sample.date, job_id: sample.job_id } : null,
        job: sampleJob ? { allFields: Object.keys(sampleJob), status: sampleJob.status, contract_amount: sampleJob.contract_amount, total_amount: sampleJob.total_amount, job_total_amount: sampleJob.job_total_amount, amount: sampleJob.amount, price: sampleJob.price, contract_signed_date: sampleJob.contract_signed_date, job_awarded_date: sampleJob.job_awarded_date, created_at: sampleJob.created_at, rep_user: sampleJob.rep_user } : null
      });
    }

    const SIGNED_STATUSES = ['accepted', 'signed', 'approved', 'won', 'contracted'];

    const thisMonthProposals = allProposals.filter(p => {
      const status = (p.status || '').toLowerCase();
      if (!SIGNED_STATUSES.includes(status)) return false;
      const dateField = p.contract_signed_date || p.signed_at || p.updated_at || p.created_at || '';
      return dateField.startsWith(monthStr);
    });

    const jobIds = [...new Set(thisMonthProposals.map(p => p.job_id).filter(Boolean))];

    const jobResults = await Promise.all(
      jobIds.map(id =>
        fetch(`${BASE}/jobs/${id}?includes[]=rep_user`, { headers })
          .then(r => r.ok ? r.json() : null).catch(() => null)
      )
    );

    const jobMap = {};
    jobResults.forEach((result, i) => {
      if (result) jobMap[jobIds[i]] = result.data || result;
    });

    const repMap = {};
    thisMonthProposals.forEach(p => {
      const job = jobMap[p.job_id] || {};
      const repUser = job.rep_user || {};
      const rep = repUser.display_name || repUser.name ||
        ((repUser.first_name || '') + ' ' + (repUser.last_name || '')).trim();
      if (!rep) return;
      const amount = Number(job.contract_amount || job.total_amount || job.job_total_amount || job.amount || p.grand_total || p.price || p.total || p.amount || 0);
      if (!repMap[rep]) repMap[rep] = { rep, jobs: 0, amount: 0 };
      repMap[rep].jobs++;
      repMap[rep].amount += amount;
    });

    const reps = Object.values(repMap).sort((a, b) => b.amount - a.amount);

    return res.json({
      month: monthStr,
      contractedCount: thisMonthProposals.length,
      reps,
      note: thisMonthProposals.length === 0 ? 'No contracted proposals found. Add ?debug=1 to inspect field names.' : null
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
