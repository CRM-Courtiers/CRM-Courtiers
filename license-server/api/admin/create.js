// POST /api/admin/create
// Auth : Basic Auth
// Body : { name: string, plan: "trial"|"paid", months: number }
// Retourne : { key: "XXXX-...", entry: { ... } }

const crypto = require('crypto');
const { requireAuth } = require('../../lib/auth');
const { setKey, keyExists } = require('../../lib/kv');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genGroup() {
  let s = '';
  const bytes = crypto.randomBytes(4);
  for (let i = 0; i < 4; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return s;
}

async function generateUniqueKey() {
  for (let i = 0; i < 10; i++) {
    const k = `${genGroup()}-${genGroup()}-${genGroup()}-${genGroup()}`;
    if (!(await keyExists(k))) return k;
  }
  throw new Error('Impossible de générer une clé unique');
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (!requireAuth(req, res)) return;
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Méthode non autorisée — utiliser POST' });
    return;
  }

  const body = req.body || {};
  const name = (body.name || '').toString().trim();
  let plan = (body.plan || '').toString().toLowerCase().trim();
  const months = parseInt(body.months);

  if (!name) {
    res.status(400).json({ error: 'Nom requis' });
    return;
  }
  if (plan === 'trial') plan = 'free_trial';
  if (plan !== 'free_trial' && plan !== 'paid') {
    res.status(400).json({ error: 'Plan invalide (trial|paid)' });
    return;
  }
  if (isNaN(months) || months < 1 || months > 120) {
    res.status(400).json({ error: 'Nombre de mois invalide (1-120)' });
    return;
  }

  try {
    const exp = new Date();
    exp.setMonth(exp.getMonth() + months);
    const expiresStr = exp.toISOString().substring(0, 10);

    const key = await generateUniqueKey();
    const entry = {
      expires: expiresStr,
      plan,
      name,
      createdAt: new Date().toISOString().substring(0, 10)
    };
    await setKey(key, entry);

    res.status(200).json({ key, entry });
  } catch (err) {
    console.error('[admin/create] error:', err);
    res.status(500).json({ error: 'Erreur serveur', detail: err.message });
  }
};
