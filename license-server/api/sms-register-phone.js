// Endpoint POST /api/sms-register-phone
//
// Enregistre (ou retire) le mapping {phone → licenseKey} dans Redis,
// pour que le webhook SMS puisse identifier le sender.
//
// Body POST : { "key": "XXXX-XXXX-XXXX-XXXX", "phone": "514-555-0100" }
// Body POST (unregister) : { "key": "...", "phone": "...", "action": "remove" }
// Réponse : { ok: bool, phone?: "+1...", error?: "..." }

const { getKey } = require('../lib/kv');
const { registerPhone, unregisterPhone, findLicenseByPhone, findPhoneByLicense, normalizePhone } = require('../lib/sms');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Méthode non autorisée — POST attendu' });
    return;
  }

  const body = req.body || {};
  const key = String(body.key || '').toUpperCase().trim();
  const phoneRaw = String(body.phone || '').trim();
  const action = String(body.action || 'add').toLowerCase();

  if (!key) { res.status(400).json({ ok: false, error: 'Clé licence manquante' }); return; }
  if (!phoneRaw) { res.status(400).json({ ok: false, error: 'Téléphone manquant' }); return; }

  // Valider la clé existe + active
  let entry;
  try { entry = await getKey(key); }
  catch (err) {
    console.error('[sms-register] KV error:', err);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
    return;
  }
  if (!entry) { res.status(403).json({ ok: false, error: 'Clé inconnue' }); return; }
  if (entry.revoked) { res.status(403).json({ ok: false, error: 'Clé révoquée' }); return; }
  const expDate = new Date(entry.expires + 'T23:59:59');
  if (expDate < new Date()) { res.status(403).json({ ok: false, error: 'Clé expirée' }); return; }

  const norm = normalizePhone(phoneRaw);
  if (!norm) { res.status(400).json({ ok: false, error: 'Numéro invalide' }); return; }

  try {
    if (action === 'remove') {
      // Sécurité : on ne retire que si le mapping correspond à cette clé
      const existing = await findLicenseByPhone(norm);
      if (existing && existing !== key) {
        res.status(403).json({ ok: false, error: 'Ce numéro est rattaché à une autre licence' });
        return;
      }
      await unregisterPhone(norm);
      res.status(200).json({ ok: true, phone: norm, action: 'removed' });
      return;
    }

    // ADD : vérifier qu'aucune autre licence n'a déjà ce numéro
    const existing = await findLicenseByPhone(norm);
    if (existing && existing !== key) {
      res.status(409).json({ ok: false, error: 'Ce numéro est déjà rattaché à une autre licence TRI-ANGLE.' });
      return;
    }

    // Si cette licence avait déjà un autre numéro, le retirer
    const prev = await findPhoneByLicense(key);
    if (prev && prev !== norm) await unregisterPhone(prev);

    await registerPhone(norm, key);
    res.status(200).json({ ok: true, phone: norm, action: 'registered' });
  } catch (err) {
    console.error('[sms-register] error:', err);
    res.status(500).json({ ok: false, error: 'Erreur serveur : ' + err.message });
  }
};
