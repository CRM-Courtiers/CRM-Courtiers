// Endpoint /api/sms-pending
//
// GET (poll) ?key=XXXX-XXXX-XXXX-XXXX
//   → { ok: true, count: N, entries: [...] }
//
// POST (clear after confirmation) { "key": "...", "ids": ["id1","id2"] }
//   → { ok: true, removed: N }
// POST avec ids absent ou [] : clear all
//
// L'app Electron poll ce endpoint toutes les 60s ; après confirmation par l'user,
// elle POST les ids confirmés pour qu'on les retire de la queue.

const { getKey } = require('../lib/kv');
const { getPending, clearPending, findPhoneByLicense } = require('../lib/sms');

async function _validateLicense(key) {
  if (!key) return { ok: false, error: 'Clé manquante' };
  let entry;
  try { entry = await getKey(key); }
  catch (e) { return { ok: false, error: 'Erreur serveur', status: 500 }; }
  if (!entry) return { ok: false, error: 'Clé inconnue', status: 403 };
  if (entry.revoked) return { ok: false, error: 'Clé révoquée', status: 403 };
  const exp = new Date(entry.expires + 'T23:59:59');
  if (exp < new Date()) return { ok: false, error: 'Clé expirée', status: 403 };
  return { ok: true };
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  // GET → poll queue
  if (req.method === 'GET') {
    const key = String((req.query && req.query.key) || '').toUpperCase().trim();
    const v = await _validateLicense(key);
    if (!v.ok) { res.status(v.status || 400).json(v); return; }
    try {
      const entries = await getPending(key);
      const phone = await findPhoneByLicense(key);
      res.status(200).json({ ok: true, count: entries.length, entries, registeredPhone: phone || null });
    } catch (err) {
      console.error('[sms-pending GET] error:', err);
      res.status(500).json({ ok: false, error: 'Erreur serveur' });
    }
    return;
  }

  // POST → clear (after user confirmation)
  if (req.method === 'POST') {
    const body = req.body || {};
    const key = String(body.key || '').toUpperCase().trim();
    const ids = Array.isArray(body.ids) ? body.ids : [];
    const v = await _validateLicense(key);
    if (!v.ok) { res.status(v.status || 400).json(v); return; }
    try {
      const removed = await clearPending(key, ids);
      res.status(200).json({ ok: true, removed });
    } catch (err) {
      console.error('[sms-pending POST] error:', err);
      res.status(500).json({ ok: false, error: 'Erreur serveur' });
    }
    return;
  }

  res.status(405).json({ ok: false, error: 'Méthode non autorisée' });
};
