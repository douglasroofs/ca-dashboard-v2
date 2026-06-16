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

  try {
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

    const caProposals = proposals.filter(p =>
      (p.title || p.name || '').toUpperCase().startsWith('CA')
    );

    const jobIds = [...new Set(caProposals.map(p => p.job_id).filter(Boolean))];

    const jobResults = await Promise.all(
      jobIds.map(id =>
        fetch(`${BASE}/jobs/${id}?includes[]=rep_user&includes[]=customer&includes[]=address`, { headers })
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
      const repUser = job.rep_user || {};
      const rep = repUser.display_name || repUser.name ||
        ((repUser.first_name || '') + ' ' + (repUser.last_name || '')).trim() || '';
      return {
        jobId: job.job_number || String(p.job_id || ''),
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
