// Endpoint POST /api/validate
// Body : { "key": "XXXX-XXXX-XXXX-XXXX" }
// Réponse : { valid: bool, expires: "YYYY-MM-DD", plan: "free_trial"|"paid", name: "...", daysRemaining: int, expired?: bool, revoked?: bool }
//
// Source des données : Upstash Redis (hash "licenses"). Voir lib/kv.js.

const { getKey } = require('../lib/kv');

module.exports = async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ valid: false, error: 'Méthode non autorisée — utiliser POST' });
    return;
  }

  const body = req.body || {};
  const rawKey = (body.key || '').toString().toUpperCase().trim();

  if (!rawKey) {
    res.status(400).json({ valid: false, error: 'Clé manquante' });
    return;
  }

  let entry;
  try {
    entry = await getKey(rawKey);
  } catch (err) {
    console.error('[validate] KV error:', err);
    res.status(500).json({ valid: false, error: 'Erreur serveur' });
    return;
  }

  if (!entry) {
    res.status(200).json({ valid: false, error: 'Clé inconnue ou révoquée' });
    return;
  }

  // Soft revoke
  if (entry.revoked) {
    res.status(200).json({ valid: false, revoked: true, error: 'Clé révoquée' });
    return;
  }

  // Vérifier expiration
  const now = new Date();
  const expiresDate = new Date(entry.expires + 'T23:59:59');
  const daysRemaining = Math.ceil((expiresDate - now) / 86400000);

  if (expiresDate < now) {
    res.status(200).json({
      valid: false,
      expired: true,
      expires: entry.expires,
      plan: entry.plan,
      name: entry.name,
      daysRemaining: 0
    });
    return;
  }

  res.status(200).json({
    valid: true,
    expires: entry.expires,
    plan: entry.plan,
    name: entry.name,
    daysRemaining: daysRemaining,
    serverTime: now.toISOString()
  });
};
