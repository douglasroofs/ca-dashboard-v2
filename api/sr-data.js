// api/sr-data.js — returns Sales Rabbit door activity data

const GITHUB_REPO = 'douglasroofs/ca-dashboard-v2';
const DATA_PATH = 'data/sr-data.json';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const ghToken = process.env.GITHUB_TOKEN;
    if (!ghToken) return res.status(500).json({ error: 'GITHUB_TOKEN not set' });

    const resp = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/${DATA_PATH}`,
      { headers: { 'Authorization': 'token ' + ghToken } }
    );

    if (!resp.ok) return res.status(200).json({ events: [], updated: null });

    const meta = await resp.json();
    const content = Buffer.from(meta.content.replace(/\n/g, ''), 'base64').toString('utf8');
    const data = JSON.parse(content);

    return res.status(200).json(data);
  } catch (err) {
    return res.status(200).json({ events: [], error: err.message });
  }
};
