// api/leap.js — CA proposals from LEAP/JobProgress
// Returns pipeline rows: { rows: [{jobId, customer, address, rep, status}] }

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
    // Fetch all proposals
    const prResp = await fetch(BASE + '/proposals?limit=200', { headers });
    if (!prResp.ok) {
      const text = await prResp.text().catch(() => '');
      return res.status(prResp.status).json({
        error: 'LEAP proposals returned ' + prResp.status,
        detail: text.substring(0, 300)
      });
    }
    const prData = await prResp.json();
    const proposals = prData.data || [];

    // Filter to CA proposals only (title starts with "CA")
    const caProposals = proposals.filter(p =>
      (p.title || p.name || '').toUpperCase().startsWith('CA')
    );

    // Debug mode: show raw job fields with every possible rep include
    if (debug) {
      const sample = caProposals[0] || proposals[0] || null;
      let rawJob = null;
      if (sample && sample.job_id) {
        const jr = await fetch(
          `${BASE}/jobs/${sample.job_id}?includes[]=rep&includes[]=rep_user&includes[]=users&includes[]=sales_rep&includes[]=customer&includes[]=address`,
          { headers }
        );
        if (jr.ok) { const jd = await jr.json(); rawJob = jd.data || jd; }
      }
      return res.json({
        debug: true,
        totalProposals: proposals.length,
        caProposals: caProposals.length,
        sampleProposal: sample,
        rawJob,
        jobFields: rawJob ? Object.keys(rawJob) : null
      });
    }

    // Get unique job IDs
    const jobIds = [...new Set(caProposals.map(p => p.job_id).filter(Boolean))];

    // Fetch each job individually
    const jobResults = await Promise.all(
      jobIds.map(id =>
        fetch(`${BASE}/jobs/${id}?includes[]=rep&includes[]=customer&includes[]=address`, { headers })
          .then(r => r.ok ? r.json() : null)
          .catch(() => null)
      )
    );

    // Build job map keyed by job_id
    const jobMap = {};
    jobResults.forEach((result, i) => {
      if (result) jobMap[jobIds[i]] = result.data || result;
    });

    // Helper: extract state string from object or string
    function stateStr(s) {
      if (!s) return '';
      if (typeof s === 'string') return s;
      return s.abbreviation || s.name || s.code || '';
    }

    // Build output rows
    const rows = caProposals.map(p => {
      const job = jobMap[p.job_id] || {};
      const cust = job.customer || {};
      const addr = job.address || {};

      const addrStr = typeof addr === 'string'
        ? addr
        : [addr.address, addr.city, stateStr(addr.state)].filter(Boolean).join(', ');

      const custName = cust.display_name ||
        ((cust.first_name || '') + ' ' + (cust.last_name || '')).trim();

      // Try multiple possible rep field names
      const repUser = job.rep || job.rep_user || job.sales_rep || job.users?.[0] || {};
      const rep = repUser.display_name || repUser.name ||
        ((repUser.first_name || '') + ' ' + (repUser.last_name || '')).trim() || '';

      return {
        jobId: job.number || job.job_number || String(p.job_id || ''),
        customer: custName,
        address: addrStr,
        rep,
        status: (p.status || '').toLowerCase()
      };
    });

    return res.status(200).json({ rows, total: rows.length });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
