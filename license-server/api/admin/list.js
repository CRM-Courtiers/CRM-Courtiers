// GET /api/admin/list
// Auth : Basic Auth (voir lib/auth.js)
// Retourne : { keys: { "XXXX-...": { expires, plan, name, ..., status, daysRemaining } } }

const { requireAuth } = require('../../lib/auth');
const { getAllKeys, redis } = require('../../lib/kv');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (!requireAuth(req, res)) return;
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Méthode non autorisée — utiliser GET' });
    return;
  }

  try {
    const keys = await getAllKeys();
    const now = new Date();
    const enriched = {};
    for (const [k, entry] of Object.entries(keys)) {
      // Étape 34 — clé liée : son état effectif (expiration/révocation) vient du parent
      let effEntry = entry;
      if (entry.linkedTo && keys[entry.linkedTo]) {
        const parent = keys[entry.linkedTo];
        effEntry = { ...entry, expires: parent.expires, revoked: entry.revoked || parent.revoked };
      }
      const exp = new Date(effEntry.expires + 'T23:59:59');
      const daysRemaining = Math.ceil((exp - now) / 86400000);
      let status;
      if (effEntry.revoked) status = 'revoked';
      else if (daysRemaining < 0) status = 'expired';
      else if (daysRemaining < 30) status = 'expiring';
      else status = 'active';
      // Étape 34 — postes vus pour cette clé (suivi machineId, best effort)
      let machines = 0;
      try { machines = (await redis.hlen('machines:' + k)) || 0; } catch (e) { /* non bloquant */ }
      enriched[k] = { ...entry, expires: effEntry.expires, status, daysRemaining, machines };
    }
    res.status(200).json({ keys: enriched, serverTime: now.toISOString() });
  } catch (err) {
    console.error('[admin/list] error:', err);
    res.status(500).json({ error: 'Erreur serveur', detail: err.message });
  }
};
