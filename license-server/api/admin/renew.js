// POST /api/admin/renew
// Auth : Basic Auth
// Body : { key: "XXXX-...", months: number }
// Retourne : { key, entry: { ... } }
//
// Si la clé est expirée, recommence à aujourd'hui.
// Si la clé est révoquée, la réactive (revoked supprimé).

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
  const months = parseInt(body.months);

  if (!rawKey) { res.status(400).json({ error: 'Clé manquante' }); return; }
  if (isNaN(months) || months < 1 || months > 120) {
    res.status(400).json({ error: 'Nombre de mois invalide (1-120)' });
    return;
  }

  try {
    const entry = await getKey(rawKey);
    if (!entry) { res.status(404).json({ error: 'Clé inconnue' }); return; }

    const now = new Date();
    const currentExpires = new Date(entry.expires + 'T23:59:59');
    const isExpired = currentExpires < now;
    const base = isExpired ? new Date() : new Date(entry.expires + 'T23:59:59');
    base.setMonth(base.getMonth() + months);
    const newExpires = base.toISOString().substring(0, 10);

    entry.expires = newExpires;
    if (entry.revoked) { delete entry.revoked; delete entry.revokedAt; }
    entry.renewedAt = new Date().toISOString().substring(0, 10);

    await setKey(rawKey, entry);
    res.status(200).json({ key: rawKey, entry });
  } catch (err) {
    console.error('[admin/renew] error:', err);
    res.status(500).json({ error: 'Erreur serveur', detail: err.message });
  }
};
