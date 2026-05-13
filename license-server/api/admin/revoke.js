// POST /api/admin/revoke
// Auth : Basic Auth
// Body : { key: "XXXX-..." }
// Retourne : { key, entry: { ..., revoked: true, revokedAt: "YYYY-MM-DD" } }

const { requireAuth } = require('../../lib/auth');
const { getKey, setKey } = require('../../lib/kv');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (!requireAuth(req, res)) return;
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Méthode non autorisée — utiliser POST' });
    return;
  }

  const body = req.body || {};
  const rawKey = (body.key || '').toString().toUpperCase().trim();
  if (!rawKey) { res.status(400).json({ error: 'Clé manquante' }); return; }

  try {
    const entry = await getKey(rawKey);
    if (!entry) { res.status(404).json({ error: 'Clé inconnue' }); return; }

    if (entry.revoked) {
      res.status(200).json({ key: rawKey, entry, alreadyRevoked: true });
      return;
    }

    entry.revoked = true;
    entry.revokedAt = new Date().toISOString().substring(0, 10);
    await setKey(rawKey, entry);

    res.status(200).json({ key: rawKey, entry });
  } catch (err) {
    console.error('[admin/revoke] error:', err);
    res.status(500).json({ error: 'Erreur serveur', detail: err.message });
  }
};
