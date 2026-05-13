// Endpoint POST /api/sms-webhook
//
// Twilio POST ici quand notre numéro reçoit un SMS.
// Pipeline : identify sender → parse LLM → push pending queue → reply SMS de confirmation
//
// Body Twilio (form-urlencoded) :
//   From      : "+15145550100"  (sender)
//   To        : "+15144441234"  (notre numéro Twilio)
//   Body      : "le texte du SMS"
//   MessageSid: "SM..."
//   NumMedia  : "0"
//
// On répond avec un TwiML vide (200 OK) — pas de reply auto-TwiML, on envoie via API séparée
// pour avoir plus de flexibilité (ex: déléguer en background si parsing prend > 10s).

const { findLicenseByPhone, pushPending, logSms, parseSmsViaLlm, sendTwilioReply, normalizePhone } = require('../lib/sms');

// Génère un ID court pour la queue entry
function _shortId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function _truncate(s, n) {
  if (!s) return '';
  s = String(s);
  return s.length > n ? s.substring(0, n - 1) + '…' : s;
}

// Twilio envoie form-urlencoded — Vercel ne le parse pas auto, on bypass
function _parseFormBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
      resolve(req.body);
      return;
    }
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try {
        const params = new URLSearchParams(data);
        const obj = {};
        for (const [k, v] of params) obj[k] = v;
        resolve(obj);
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// Renvoie un TwiML 200 OK vide (Twilio ne fait rien)
function _twimlEmpty(res) {
  res.setHeader('Content-Type', 'text/xml');
  res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }

  let body;
  try { body = await _parseFormBody(req); }
  catch (e) {
    console.error('[sms-webhook] body parse error:', e);
    _twimlEmpty(res);
    return;
  }

  const fromRaw = body.From || '';
  const toRaw = body.To || '';
  const text = (body.Body || '').toString().trim();
  const msgSid = body.MessageSid || '';

  if (!fromRaw || !text) {
    console.warn('[sms-webhook] payload incomplet:', { from: fromRaw, body: text.substring(0, 40) });
    _twimlEmpty(res);
    return;
  }

  const fromNorm = normalizePhone(fromRaw);
  let licenseKey;
  try { licenseKey = await findLicenseByPhone(fromNorm); }
  catch (e) {
    console.error('[sms-webhook] phone lookup error:', e);
    _twimlEmpty(res);
    return;
  }

  if (!licenseKey) {
    // Sender inconnu : on l'avertit
    console.warn('[sms-webhook] sender inconnu:', fromNorm);
    try {
      await sendTwilioReply(fromRaw,
        'TRI-ANGLE : numéro non connecté. Ouvre l\'app → Paramètres → Intégrations → Capture SMS pour activer.');
    } catch (e) { /* swallow */ }
    _twimlEmpty(res);
    return;
  }

  // Log SMS reçu (avant LLM, pour debug si parser plante)
  try { await logSms(licenseKey, { from: fromNorm, text: text.substring(0, 500), msgSid, stage: 'received' }); }
  catch (e) { /* non-fatal */ }

  // Parser via LLM
  let parsed;
  try {
    parsed = await parseSmsViaLlm(text);
  } catch (e) {
    console.error('[sms-webhook] LLM parse error:', e.message);
    // Fallback : push avec needs_review=true, le user éditera dans l'app
    parsed = {
      prenom: '', nom: '', telephone: '', courriel: '', source: 'Autre',
      address_hint: '', notes: text.substring(0, 200), confidence: 'low'
    };
  }

  // Construire l'entrée pending
  const entry = {
    id: _shortId(),
    receivedAt: new Date().toISOString(),
    rawText: text.substring(0, 500),
    senderPhone: fromNorm,
    needs_review: parsed.confidence === 'low',
    parsed: parsed
  };

  try { await pushPending(licenseKey, entry); }
  catch (e) {
    console.error('[sms-webhook] push pending error:', e);
    try { await sendTwilioReply(fromRaw, '⚠ TRI-ANGLE : erreur serveur. Réessaie plus tard ou note manuellement.'); } catch (_) {}
    _twimlEmpty(res);
    return;
  }

  // Reply SMS de confirmation
  const who = (parsed.prenom + ' ' + parsed.nom).trim() || '(à compléter)';
  const where = parsed.address_hint || '(propriété à confirmer)';
  let confirmMsg;
  if (parsed.confidence === 'low') {
    confirmMsg = `🟡 TRI-ANGLE: capté mais à réviser. Ouvre l'app à la prochaine occasion pour compléter. (${_truncate(text, 60)})`;
  } else {
    confirmMsg = `✓ TRI-ANGLE: capté · ${_truncate(who, 40)} · ${_truncate(where, 50)}. Confirme à la prochaine ouverture app.`;
  }
  try { await sendTwilioReply(fromRaw, confirmMsg); } catch (e) { /* swallow */ }

  _twimlEmpty(res);
};
