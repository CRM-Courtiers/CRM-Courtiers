// Endpoint POST /api/validate
// Body : { "key": "XXXX-XXXX-XXXX-XXXX", "machineId": "..." (optionnel, Étape 34) }
// Réponse : { valid, expires, plan, name, daysRemaining, role, linkedTo?, linkedToName?, expired?, revoked? }
//
// Étape 34 — Clés liées (adjointe) : une clé avec linkedTo hérite de l'état de sa clé
// PARENT (expiration, plan, révocation). Renouveler/révoquer le courtier suffit : la clé
// adjointe suit automatiquement. `role` ('courtier' par défaut, 'adjointe' pour une clé
// liée) est lu par l'app pour forcer le profil du poste.
// Étape 34 — Suivi des postes : si l'app envoie machineId, on le journalise par clé
// (hash Redis machines:<clé>) → visible au dashboard admin. Aucun blocage.
//
// Source des données : Upstash Redis (hash "licenses"). Voir lib/kv.js.

const { getKey, redis } = require('../lib/kv');

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

  // Suivi des postes (best effort — jamais bloquant)
  const machineId = (body.machineId || '').toString().trim().substring(0, 80);
  if (machineId) {
    try {
      await redis.hset('machines:' + rawKey, { [machineId]: JSON.stringify({ last: new Date().toISOString().substring(0, 10) }) });
    } catch (e) { /* le suivi ne doit jamais faire échouer une validation */ }
  }

  // Soft revoke de la clé elle-même
  if (entry.revoked) {
    res.status(200).json({ valid: false, revoked: true, error: 'Clé révoquée' });
    return;
  }

  // Clé liée (adjointe) : l'état effectif (expiration/plan/révocation) vient du PARENT
  const role = entry.role || 'courtier';
  let effExpires = entry.expires;
  let effPlan = entry.plan;
  let parentName = null;
  if (entry.linkedTo) {
    let parent = null;
    try {
      parent = await getKey(String(entry.linkedTo).toUpperCase().trim());
    } catch (err) {
      console.error('[validate] KV error (parent):', err);
      res.status(500).json({ valid: false, error: 'Erreur serveur' });
      return;
    }
    if (!parent) {
      res.status(200).json({ valid: false, error: 'Licence principale introuvable — contactez le support' });
      return;
    }
    if (parent.revoked) {
      res.status(200).json({ valid: false, revoked: true, error: 'Licence principale révoquée' });
      return;
    }
    effExpires = parent.expires;
    effPlan = parent.plan;
    parentName = parent.name || null;
  }

  // Vérifier expiration (sur l'état effectif)
  const now = new Date();
  const expiresDate = new Date(effExpires + 'T23:59:59');
  const daysRemaining = Math.ceil((expiresDate - now) / 86400000);

  if (expiresDate < now) {
    res.status(200).json({
      valid: false,
      expired: true,
      expires: effExpires,
      plan: effPlan,
      name: entry.name,
      role: role,
      daysRemaining: 0
    });
    return;
  }

  res.status(200).json({
    valid: true,
    expires: effExpires,
    plan: effPlan,
    name: entry.name,
    role: role,
    linkedTo: entry.linkedTo || undefined,
    linkedToName: parentName || undefined,
    daysRemaining: daysRemaining,
    serverTime: now.toISOString()
  });
};
