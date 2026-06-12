// Endpoint POST /api/adjointe-key — Étape 34b : génération AUTONOME de la clé adjointe
// PAR LE COURTIER, depuis l'app (Paramètres → Équipe → Adjoint(e)).
//
// Body : { key: "<clé du courtier>", name: "Nom de l'adjoint(e)", peek: bool }
//   - peek:true → ne crée RIEN, retourne la clé adjointe existante s'il y en a une.
// Auth : la clé du courtier elle-même (doit être valide, non liée, non révoquée, non expirée).
// Règle : UNE seule clé adjointe active par clé courtier — si elle existe déjà, on la
// retourne (le courtier peut la réafficher/recopier, jamais en créer une 2e).
// La clé créée est liée (linkedTo) : elle suit l'expiration/révocation du courtier,
// et force le profil Adjoint(e) dans l'app (role:'adjointe').

const crypto = require('crypto');
const { getKey, getAllKeys, setKey } = require('../lib/kv');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genGroup() {
  let s = '';
  const bytes = crypto.randomBytes(4);
  for (let i = 0; i < 4; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return s;
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Méthode non autorisée — utiliser POST' });
    return;
  }

  const body = req.body || {};
  const rawKey = (body.key || '').toString().toUpperCase().trim();
  const name = (body.name || '').toString().trim().substring(0, 80);
  const peek = !!body.peek;

  if (!rawKey) { res.status(400).json({ ok: false, error: 'Clé manquante' }); return; }

  let parent;
  try {
    parent = await getKey(rawKey);
  } catch (err) {
    console.error('[adjointe-key] KV error:', err);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
    return;
  }

  if (!parent) { res.status(200).json({ ok: false, error: 'Clé inconnue' }); return; }
  if (parent.linkedTo) { res.status(200).json({ ok: false, error: 'Cette clé est déjà une clé adjointe — seule la clé du courtier peut en générer une' }); return; }
  if (parent.revoked) { res.status(200).json({ ok: false, error: 'Clé révoquée' }); return; }
  const now = new Date();
  if (new Date(parent.expires + 'T23:59:59') < now) {
    res.status(200).json({ ok: false, error: 'Licence expirée — renouvelle d\'abord ta propre licence' });
    return;
  }

  let all;
  try {
    all = await getAllKeys();
  } catch (err) {
    console.error('[adjointe-key] KV error:', err);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
    return;
  }

  // Clé adjointe déjà existante pour ce courtier → la retourner (jamais de doublon)
  for (const [k, e] of Object.entries(all)) {
    if (e && e.linkedTo === rawKey && !e.revoked) {
      res.status(200).json({ ok: true, existing: true, key: k, name: e.name || '' });
      return;
    }
  }

  if (peek) { res.status(200).json({ ok: true, none: true }); return; }
  if (!name) { res.status(400).json({ ok: false, error: 'Nom de l\'adjoint(e) requis' }); return; }

  let newKey = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    const k = `${genGroup()}-${genGroup()}-${genGroup()}-${genGroup()}`;
    if (!all[k] && !(await getKey(k))) { newKey = k; break; }
  }
  if (!newKey) { res.status(500).json({ ok: false, error: 'Impossible de générer une clé unique' }); return; }

  try {
    await setKey(newKey, {
      expires: parent.expires, // informatif — validate résout toujours le parent en direct
      plan: 'linked',
      role: 'adjointe',
      linkedTo: rawKey,
      name: name,
      createdAt: now.toISOString().substring(0, 10),
      createdVia: 'app'
    });
  } catch (err) {
    console.error('[adjointe-key] KV error (set):', err);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
    return;
  }

  res.status(200).json({ ok: true, key: newKey, name: name });
};
