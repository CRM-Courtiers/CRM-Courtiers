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

const { findLicenseByPhone, pushPending, logSms, parseSmsViaLlm, parseImageViaLlm, downloadTwilioMedia, sendTwilioReply, normalizePhone, _hashPayload, _normalizeTextForHash, isFingerprintSeen, markFingerprint } = require('../lib/sms');

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
  const numMedia = parseInt(body.NumMedia || '0', 10) || 0;
  const hasImage = numMedia > 0 && body.MediaUrl0;

  // Doit avoir un sender ET (du texte OU une image)
  if (!fromRaw || (!text && !hasImage)) {
    console.warn('[sms-webhook] payload incomplet:', { from: fromRaw, body: text.substring(0, 40), numMedia });
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
  try { await logSms(licenseKey, { from: fromNorm, text: text.substring(0, 500), msgSid, hasImage, numMedia, stage: 'received' }); }
  catch (e) { /* non-fatal */ }

  // Étape 24 — anti-doublons : fingerprint SHA-256 (KILL SWITCH via env var ANTIDUP_ENABLED)
  // Off par défaut pendant phase de test ; flip à "true" sur Vercel quand prêt pour prod
  // Pour MMS : hash base64 (calculé après download)
  // Pour SMS texte : hash du body normalisé
  // Si même fingerprint dans les 24h → skip silencieusement
  const ANTIDUP_ENABLED = String(process.env.ANTIDUP_ENABLED || 'false').toLowerCase() === 'true';
  let textFp = null;
  if (ANTIDUP_ENABLED && !hasImage && text) {
    textFp = _hashPayload(_normalizeTextForHash(text));
    try {
      const seen = await isFingerprintSeen(licenseKey, textFp);
      if (seen) {
        await logSms(licenseKey, { from: fromNorm, fp: textFp.substring(0,12), stage: 'dup-skip-text', preview: text.substring(0, 60) });
        try { await sendTwilioReply(fromRaw, '↺ TRI-ANGLE : déjà reçu ce message dans les dernières 24h, ignoré.'); } catch (_) {}
        _twimlEmpty(res);
        return;
      }
    } catch (e) { console.warn('[fp-check text]', e.message); /* non-fatal */ }
  }

  // Parser via LLM — vision si image, texte sinon
  let parsed;
  let imageBase64Preview = ''; // Pour stocker un thumbnail (optionnel, futur usage)
  let imageFp = null;
  try {
    if (hasImage) {
      // Log MediaUrl0 + verif env vars
      try {
        const rawSid = process.env.TWILIO_ACCOUNT_SID || '';
        const rawTok = process.env.TWILIO_AUTH_TOKEN || '';
        const stripCtrl = (s) => { let r = String(s||''); while (r.length && (r.charCodeAt(0) <= 0x20 || r.charCodeAt(0) === 0xFEFF)) r = r.slice(1); while (r.length && (r.charCodeAt(r.length-1) <= 0x20 || r.charCodeAt(r.length-1) === 0xFEFF)) r = r.slice(0, -1); return r; };
        const cleanedSid = stripCtrl(rawSid);
        const cleanedTok = stripCtrl(rawTok);
        await logSms(licenseKey, {
          stage: 'pre-download',
          mediaUrl0: body.MediaUrl0,
          rawSidLen: rawSid.length, rawTokLen: rawTok.length,
          cleanedSidLen: cleanedSid.length, cleanedTokLen: cleanedTok.length,
          rawSidFirst3Codes: [rawSid.charCodeAt(0), rawSid.charCodeAt(1), rawSid.charCodeAt(2)],
          cleanedSidFirst3Codes: [cleanedSid.charCodeAt(0), cleanedSid.charCodeAt(1), cleanedSid.charCodeAt(2)]
        });
      } catch (_) {}
      const dl = await downloadTwilioMedia(body.MediaUrl0);
      // Étape 24 — fingerprint sur le contenu base64 de l'image AVANT d'appeler le LLM (économie d'API)
      // Skip si ANTIDUP_ENABLED=false (mode test)
      if (ANTIDUP_ENABLED) {
        imageFp = _hashPayload(dl.base64);
        try {
          const seen = await isFingerprintSeen(licenseKey, imageFp);
          if (seen) {
            await logSms(licenseKey, { from: fromNorm, fp: imageFp.substring(0,12), stage: 'dup-skip-image', size: dl.base64.length });
            try { await sendTwilioReply(fromRaw, '↺ TRI-ANGLE : déjà reçu cette image dans les dernières 24h, ignorée.'); } catch (_) {}
            _twimlEmpty(res);
            return;
          }
        } catch (e) { console.warn('[fp-check image]', e.message); /* non-fatal */ }
      }
      parsed = await parseImageViaLlm(dl.base64, dl.contentType, text);
      // On garde une référence à l'image pour le UI (thumbnail base64 si petite)
      if (dl.base64.length < 200000) imageBase64Preview = dl.base64;
    } else {
      parsed = await parseSmsViaLlm(text);
    }
  } catch (e) {
    console.error('[sms-webhook] LLM parse error:', e.message);
    // Log l'erreur dans sms_log pour debug — FULL error message
    try { await logSms(licenseKey, { from: fromNorm, error: e.message, hasImage, stage: 'llm_error' }); }
    catch (_) {}
    // Fallback : push avec needs_review=true, le user éditera dans l'app
    parsed = {
      is_broker_request: false,
      prenom: '', nom: '', telephone: '', courriel: '',
      courtier_prenom: '', courtier_nom: '', courtier_agence: '', courtier_telephone: '', courtier_courriel: '',
      source: hasImage ? 'Autre' : 'SMS',
      address_hint: '', notes: (text.substring(0, 200) || '(screenshot non parsable)') + ' [err: ' + e.message.substring(0, 200) + ']',
      screenshot_type: hasImage ? 'unknown' : '', confidence: 'low'
    };
  }

  // Construire l'entrée pending
  const entry = {
    id: _shortId(),
    receivedAt: new Date().toISOString(),
    rawText: text.substring(0, 500),
    senderPhone: fromNorm,
    needs_review: parsed.confidence === 'low',
    parsed: parsed,
    isImage: hasImage,
    mediaContentType: hasImage ? (body.MediaContentType0 || '') : '',
    imagePreview: imageBase64Preview // base64, peut être '' si trop gros
  };

  try { await pushPending(licenseKey, entry); }
  catch (e) {
    console.error('[sms-webhook] push pending error:', e);
    try { await sendTwilioReply(fromRaw, '⚠ TRI-ANGLE : erreur serveur. Réessaie plus tard ou note manuellement.'); } catch (_) {}
    _twimlEmpty(res);
    return;
  }

  // Étape 24 — marque le fingerprint dans Redis (TTL 24h) après push réussi
  // Si le user re-envoie le même texte/image dans cette fenêtre, on skip (uniquement si ANTIDUP_ENABLED)
  if (ANTIDUP_ENABLED) {
    try {
      if (textFp) await markFingerprint(licenseKey, textFp, { type: 'text', preview: text.substring(0, 60) });
      if (imageFp) await markFingerprint(licenseKey, imageFp, { type: 'image', screenshotType: parsed.screenshot_type || '' });
    } catch (e) { console.warn('[fp-mark]', e.message); /* non-fatal */ }
  }

  // Reply SMS de confirmation
  const who = ((parsed.prenom || '') + ' ' + (parsed.nom || '')).trim() || '(à compléter)';
  const where = parsed.address_hint || '(propriété à confirmer)';
  const sourceLabel = hasImage ? '📸 screenshot' : 'SMS';
  let confirmMsg;
  if (parsed.confidence === 'low') {
    confirmMsg = `🟡 TRI-ANGLE (${sourceLabel}): capté mais à réviser. Ouvre l'app pour compléter.`;
  } else {
    confirmMsg = `✓ TRI-ANGLE (${sourceLabel}): ${_truncate(who, 40)} · ${_truncate(where, 50)}. Confirme dans l'app.`;
  }
  try { await sendTwilioReply(fromRaw, confirmMsg); } catch (e) { /* swallow */ }

  _twimlEmpty(res);
};
