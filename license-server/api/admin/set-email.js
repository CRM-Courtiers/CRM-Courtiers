// POST /api/admin/set-email
// Auth : Basic Auth (même protection que les autres endpoints admin)
// Body : { key: "XXXX-...", email: "client@exemple.com" }
// Retourne : { key, email, entry }
//
// Enregistre (ou corrige) le courriel d'une fiche de licence. Nécessaire parce que
// les clés créées depuis /admin n'avaient historiquement aucun courriel : sans lui,
// la confirmation de renouvellement ne peut pas partir.
//
// ⚠ N'ENVOIE AUCUN COURRIEL — cet endpoint ne fait qu'enregistrer l'adresse.
// ⚠ Ne modifie QUE le champ `email` : expires / plan / name / etc. restent intacts.
//
// Un courriel vide efface l'adresse de la fiche (utile pour retirer une erreur).

const { requireAuth } = require('../../lib/auth');
const { getKey, setKey } = require('../../lib/kv');

function isValidEmail(e) {
  if (typeof e !== 'string') return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254;
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (!requireAuth(req, res)) return;
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Méthode non autorisée — utiliser POST' });
    return;
  }

  const body = req.body || {};
  const rawKey = (body.key || '').toString().toUpperCase().trim();
  const email = (body.email || '').toString().toLowerCase().trim();

  if (!rawKey) { res.status(400).json({ error: 'Clé manquante' }); return; }
  if (email && !isValidEmail(email)) {
    res.status(400).json({ error: 'Courriel invalide.' });
    return;
  }

  try {
    const entry = await getKey(rawKey);
    if (!entry) { res.status(404).json({ error: 'Clé inconnue' }); return; }

    // Modification chirurgicale : on ne touche qu'à `email`.
    if (email) entry.email = email;
    else delete entry.email;

    await setKey(rawKey, entry);
    res.status(200).json({ key: rawKey, email: entry.email || null, entry });
  } catch (err) {
    console.error('[admin/set-email] error:', err);
    res.status(500).json({ error: 'Erreur serveur', detail: err.message });
  }
};
