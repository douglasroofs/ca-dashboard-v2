// api/sr-webhook.js — receives door activity webhooks from Sales Rabbit
// Stores events in data/sr-data.json via GitHub API

const GITHUB_REPO = 'douglasroofs/ca-dashboard-v2';
const DATA_PATH = 'data/sr-data.json';

const SR_USER_MAP = {
  "6":  "Steven Arevalo",
  "7":  "Marc Mitchell",
  "9":  "Andrew Funk",
  "10": "Michael McCarthy",
  "11": "George Bechara",
  "12": "Isabelle Price",
  "13": "Jack Obert",
  "14": "Harvey Shoemaker",
  "15": "Kevin Mahan",
  "19": "Robert Wilson",
  "21": "Andrew Prickel",
  "34": "Alfred Duncan",
  "44": "Nick Seward",
  "62": "Christian Brown",
  "64": "Kelly Alston",
  "72": "David Kerns"
};

const DOOR_STATUSES = ['ICA', 'SGCA', 'NO ANSWER', 'NOT HOME', 'NOT INTERESTED', 'CALLBACK', 'DNK'];
const CA_STATUSES = ['ICA', 'SGCA'];
const SKIP_STATUSES = [];

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(200).json({ ok: true });

  try {
    const ghToken = process.env.GITHUB_TOKEN;
    if (!ghToken) return res.status(500).json({ error: 'GITHUB_TOKEN not set' });

    const payload = req.body || {};
    const leadData = payload.leadData || {};
    const status = (leadData.status || '').toUpperCase();
    const userId = String(payload.actionUserId || leadData.userId || leadData.ownerId || '');
    const repName = SR_USER_MAP[userId] || '';

    if (!repName || SKIP_STATUSES.includes(status)) {
      return res.status(200).json({
        received: true,
        skipped: true,
        reason: repName ? 'skip status: ' + status : 'unknown userId: ' + userId
      });
    }

    const isDoor = DOOR_STATUSES.includes(status);
    const isCA = CA_STATUSES.includes(status);

    const eventDate = isCA
      ? (leadData.statusModified || leadData.dateModified || new Date().toISOString()).split('T')[0]
      : (leadData.dateCreated || leadData.statusModified || new Date().toISOString()).split('T')[0];

    const address = [leadData.street1, leadData.city, leadData.state].filter(Boolean).join(', ');
    const leadId = String(payload.leadId || leadData.leadId || '');

    const ghHeaders = {
      'Authorization': 'token ' + ghToken,
      'Content-Type': 'application/json'
    };
    const getResp = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/${DATA_PATH}`,
      { headers: ghHeaders }
    );

    let srData = { updated: eventDate, events: [] };
    let existingSha = null;

    if (getResp.ok) {
      const meta = await getResp.json();
      existingSha = meta.sha;
      const decoded = Buffer.from(meta.content.replace(/\n/g, ''), 'base64').toString('utf8');
      srData = JSON.parse(decoded);
      if (!Array.isArray(srData.events)) srData.events = [];
    }

    srData.events.push({ leadId, repName, status, isDoor, isCA, date: eventDate, address, ts: new Date().toISOString() });

    const thisYear = new Date().getFullYear().toString();
    srData.events = srData.events.filter(e => (e.date || '').startsWith(thisYear));
    srData.updated = new Date().toISOString().split('T')[0];

    const encodedContent = Buffer.from(JSON.stringify(srData, null, 2)).toString('base64');
    await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/${DATA_PATH}`,
      {
        method: 'PUT',
        headers: ghHeaders,
        body: JSON.stringify({ message: `SR: ${repName} ${status} ${eventDate}`, content: encodedContent, sha: existingSha })
      }
    );

    return res.status(200).json({ received: true, repName, status, isDoor, isCA, date: eventDate, totalEvents: srData.events.length });
  } catch (err) {
    return res.status(200).json({ received: true, error: err.message });
  }
};
