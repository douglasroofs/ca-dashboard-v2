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
    // Fetch proposals and users in parallel
    const [prResp, usersResp] = await Promise.all([
      fetch(BASE + '/proposals?limit=200', { headers }),
      fetch(BASE + '/users?limit=200', { headers })
    ]);

    if (!prResp.ok) {
      const text = await prResp.text().catch(() => '');
      return res.status(prResp.status).json({
        error: 'LEAP proposals returned ' + prResp.status,
        detail: text.substring(0, 300)
      });
    }

    const prData = await prResp.json();
    const proposals = prData.data || [];

    // Build user ID -> name map
    const usersMap = {};
    if (usersResp.ok) {
      const usersData = await usersResp.json();
      const usersList = usersData.data || [];
      usersList.forEach(u => {
        usersMap[u.id] = u.display_name || u.name ||
          ((u.first_name || '') + ' ' + (u.last_name || '')).trim();
      });
    }

    // Filter to CA proposals only (title starts with "CA")
    const caProposals = proposals.filter(p =>
      (p.title || p.name || '').toUpperCase().startsWith('CA')
    );

    // Debug mode
    if (debug) {
      const sample = caProposals[0] || proposals[0] || null;
      let rawJob = null;
      if (sample && sample.job_id) {
        const jr = await fetch(
          `${BASE}/jobs/${sample.job_id}?includes[]=customer&includes[]=address`,
          { headers }
        );
        if (jr.ok) { const jd = await jr.json(); rawJob = jd.data || jd; }
      }
      return res.json({
        debug: true,
        totalProposals: proposals.length,
        caProposals: caProposals.length,
        usersCount: Object.keys(usersMap).length,
        usersSample: Object.entries(usersMap).slice(0, 5),
        sampleProposal: sample,
        rawJob,
        jobFields: rawJob ? Object.keys(rawJob) : null,
        createdBy: rawJob?.created_by,
        resolvedRep: rawJob?.created_by ? usersMap[rawJob.created_by] : null
      });
    }

    // Get unique job IDs
    const jobIds = [...new Set(caProposals.map(p => p.job_id).filter(Boolean))];

    // Fetch each job individually
    const jobResults = await Promise.all(
      jobIds.map(id =>
        fetch(`${BASE}/jobs/${id}?includes[]=customer&includes[]=address`, { headers })
          .then(r => r.ok ? r.json() : null)
          .catch(() => null)
      )
    );

    const jobMap = {};
    jobResults.forEach((result, i) => {
      if (result) jobMap[jobIds[i]] = result.data || result;
    });

    function stateStr(s) {
      if (!s) return '';
      if (typeof s === 'string') return s;
      return s.abbreviation || s.name || s.code || '';
    }

    const rows = caProposals.map(p => {
      const job = jobMap[p.job_id] || {};
      const cust = job.customer || {};
      const addr = job.address || {};

      const addrStr = typeof addr === 'string'
        ? addr
        : [addr.address, addr.city, stateStr(addr.state)].filter(Boolean).join(', ');

      const custName = cust.display_name ||
        ((cust.first_name || '') + ' ' + (cust.last_name || '')).trim();

      // Map created_by user ID to name
      const rep = usersMap[job.created_by] || '';

      return {
        jobId: job.number || String(p.job_id || ''),
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
