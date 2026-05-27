// Module SMS Capture (Étape 23) — helpers Redis + parsing LLM + Twilio reply
//
// Schema Redis :
//   - phone_map (hash)            : {phone (+1...) → licenseKey}
//   - pending:{licenseKey} (list) : queue JSON de demandes en attente de confirmation
//   - sms_log:{licenseKey} (list) : journal des SMS reçus (rotated, max 50 récents)
//
// Format normalisé d'un téléphone : E.164, ex "+15145550100"

const { redis } = require('./kv');

const PHONE_MAP = 'phone_map';
const QUEUE_MAX = 100;     // taille max de la queue pending (pour éviter overflow)
const SMS_LOG_MAX = 50;    // journal pour debug

// ─── Normalisation téléphone ──────────────────────────────
function normalizePhone(raw) {
  if (!raw) return '';
  let s = String(raw).replace(/\D/g, ''); // garde seulement les chiffres
  if (!s) return '';
  if (s.length === 10) s = '1' + s;       // 5145550100 → 15145550100
  if (s.length === 11 && s[0] === '1') return '+' + s;
  // Format inconnu — on garde tel quel avec préfixe +
  return '+' + s;
}

// ─── Phone → License mapping ──────────────────────────────
async function registerPhone(phone, licenseKey) {
  const norm = normalizePhone(phone);
  if (!norm) throw new Error('Numéro de téléphone invalide');
  if (!licenseKey) throw new Error('licenseKey manquant');
  await redis.hset(PHONE_MAP, { [norm]: licenseKey });
  return norm;
}

async function unregisterPhone(phone) {
  const norm = normalizePhone(phone);
  if (!norm) return false;
  await redis.hdel(PHONE_MAP, norm);
  return true;
}

async function findLicenseByPhone(phone) {
  const norm = normalizePhone(phone);
  if (!norm) return null;
  const v = await redis.hget(PHONE_MAP, norm);
  return v || null;
}

async function findPhoneByLicense(licenseKey) {
  // Inverse lookup : utile pour le UI "tu as connecté ce numéro"
  const all = await redis.hgetall(PHONE_MAP);
  if (!all) return null;
  for (const [phone, lic] of Object.entries(all)) {
    if (lic === licenseKey) return phone;
  }
  return null;
}

// ─── Queue pending (push/pull/clear) ──────────────────────
function _queueKey(licenseKey) {
  return `pending:${licenseKey}`;
}

async function pushPending(licenseKey, entry) {
  if (!licenseKey || !entry) return;
  const key = _queueKey(licenseKey);
  await redis.lpush(key, JSON.stringify(entry));
  await redis.ltrim(key, 0, QUEUE_MAX - 1); // cap pour éviter overflow
  await redis.expire(key, 60 * 60 * 24 * 30); // TTL 30 jours
}

async function getPending(licenseKey) {
  if (!licenseKey) return [];
  const key = _queueKey(licenseKey);
  const raw = await redis.lrange(key, 0, -1);
  if (!raw || !raw.length) return [];
  return raw.map(s => {
    try { return typeof s === 'string' ? JSON.parse(s) : s; }
    catch (e) { return null; }
  }).filter(Boolean);
}

async function clearPending(licenseKey, ids) {
  if (!licenseKey) return 0;
  const key = _queueKey(licenseKey);
  if (!ids || !ids.length) {
    // Clear all
    const len = await redis.llen(key);
    await redis.del(key);
    return len;
  }
  // Clear specific entries : pull all, filter, push back
  const all = await getPending(licenseKey);
  const idSet = new Set(ids);
  const kept = all.filter(e => !idSet.has(e.id));
  await redis.del(key);
  if (kept.length) {
    // Push back in reverse order to preserve original order (lpush adds to head)
    for (let i = kept.length - 1; i >= 0; i--) {
      await redis.lpush(key, JSON.stringify(kept[i]));
    }
    await redis.expire(key, 60 * 60 * 24 * 30);
  }
  return all.length - kept.length;
}

// ─── SMS log (journal pour debug) ─────────────────────────
async function logSms(licenseKey, payload) {
  if (!licenseKey) return;
  const key = `sms_log:${licenseKey}`;
  await redis.lpush(key, JSON.stringify({ ...payload, at: new Date().toISOString() }));
  await redis.ltrim(key, 0, SMS_LOG_MAX - 1);
  await redis.expire(key, 60 * 60 * 24 * 90); // 90 jours
}

// ─── LLM parser (Anthropic Claude Haiku) ──────────────────
async function parseSmsViaLlm(rawText) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY manquante dans Vercel');

  const sysPrompt = `Tu es un assistant qui extrait des informations de demandes immobilières envoyées par un courtier. Le courtier copie-colle du texte reçu via Messenger, Centris, courriel, téléphone ou autre, puis te l'envoie par SMS.

Ton job : retourner UN SEUL objet JSON, sans markdown, avec ces champs :
{
  "prenom": "...",            // prénom de l'acheteur potentiel (ou chaîne vide si inconnu)
  "nom": "...",               // nom de famille (chaîne vide si inconnu)
  "telephone": "...",         // tel trouvé dans le texte (chaîne vide si aucun)
  "courriel": "...",          // courriel trouvé (chaîne vide si aucun)
  "source": "Centris" | "Messenger" | "Courriel" | "Téléphone" | "SMS" | "Walk-in" | "Autre",
  "address_hint": "...",      // adresse de la propriété mentionnée (chaîne vide si aucune)
  "notes": "...",             // ce que la personne veut faire/demander, max 200 caractères
  "confidence": "high" | "medium" | "low"  // ton degré de certitude sur prenom/nom
}

Règles :
- Si tu ne peux pas extraire un prénom ET un nom, mets confidence="low"
- Si le texte est très court ou ambigu, mets confidence="low" et explique dans notes
- N'invente JAMAIS d'info. Champs vides = "" (chaîne vide)
- Réponds SEULEMENT avec l'objet JSON, rien d'autre.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      system: sysPrompt,
      messages: [{ role: 'user', content: rawText }]
    })
  });

  if (!res.ok) {
    const errTxt = await res.text();
    throw new Error(`Anthropic ${res.status}: ${errTxt.substring(0, 300)}`);
  }

  const data = await res.json();
  const text = (data.content && data.content[0] && data.content[0].text || '').trim();

  // Strip ```json fences si jamais
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    throw new Error('Réponse LLM non parsable : ' + cleaned.substring(0, 200));
  }
}

// ─── LLM parser (image / screenshot via Claude vision) ───
// Le courtier prend un screenshot d'une demande (Messenger, Centris, courriel,
// SMS, Marketplace, etc.) et l'envoie en MMS à notre numéro. On extrait les
// infos du lead via vision.
async function parseImageViaLlm(imageBase64, mediaType, additionalText) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY manquante dans Vercel');

  const sysPrompt = `Tu es un assistant qui extrait des informations de demandes immobilières à partir d'un screenshot envoyé par un courtier au Québec.

Le screenshot peut venir de :
- Messenger / Facebook
- Centris.ca ou DuProprio
- Courriel (Gmail, Outlook, Apple Mail)
- SMS / iMessage
- Realtor.ca / MLS
- Facebook Marketplace
- Instagram DM
- Tout autre canal

Ton job : analyser l'image et retourner UN SEUL objet JSON, sans markdown, avec ces champs :
{
  "prenom": "...",                  // prénom du potentiel acheteur (chaîne vide si inconnu)
  "nom": "...",                     // nom de famille (chaîne vide si inconnu)
  "telephone": "...",               // téléphone trouvé (format quelconque, chaîne vide si aucun)
  "courriel": "...",                // courriel trouvé (chaîne vide si aucun)
  "source": "Centris" | "Messenger" | "Courriel" | "Téléphone" | "SMS" | "Walk-in" | "Autre",
  "address_hint": "...",            // adresse / propriété mentionnée (chaîne vide si aucune)
  "notes": "...",                   // ce que la personne veut/demande, max 250 caractères
  "screenshot_type": "...",         // un mot court décrivant la source détectée (ex: "Messenger conversation", "Centris listing inquiry", "Email")
  "confidence": "high" | "medium" | "low"
}

Règles :
- Le NOM est ce qui apparaît dans l'en-tête de la conversation (Messenger), le "From:" du courriel, ou le profil. Ce n'est PAS toi le destinataire — c'est l'expéditeur de la demande.
- Si tu vois clairement prénom ET nom → confidence="high"
- Si juste prénom OU pseudo → confidence="medium"
- Si tu ne peux extraire ni nom ni téléphone ni courriel → confidence="low"
- Si tu vois une adresse civique précise (numéro + rue), mets-la dans address_hint
- N'invente JAMAIS d'info. Champs inconnus = "" (chaîne vide)
- Réponds SEULEMENT avec l'objet JSON, rien d'autre.`;

  const userContent = [
    {
      type: 'image',
      source: {
        type: 'base64',
        media_type: mediaType || 'image/jpeg',
        data: imageBase64
      }
    }
  ];
  if (additionalText && additionalText.trim()) {
    userContent.push({
      type: 'text',
      text: 'Note du courtier accompagnant le screenshot : ' + additionalText.trim()
    });
  } else {
    userContent.push({
      type: 'text',
      text: 'Analyse ce screenshot et extrais le lead.'
    });
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 800,
      system: sysPrompt,
      messages: [{ role: 'user', content: userContent }]
    })
  });

  if (!res.ok) {
    const errTxt = await res.text();
    throw new Error(`Anthropic vision ${res.status}: ${errTxt.substring(0, 300)}`);
  }

  const data = await res.json();
  const text = (data.content && data.content[0] && data.content[0].text || '').trim();
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    throw new Error('Réponse LLM (vision) non parsable : ' + cleaned.substring(0, 200));
  }
}

// ─── Twilio : télécharger un media (MMS attachment) ───────
async function downloadTwilioMedia(mediaUrl) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) throw new Error('Twilio creds manquants');
  const auth = Buffer.from(`${sid}:${token}`).toString('base64');
  const res = await fetch(mediaUrl, {
    headers: { 'Authorization': `Basic ${auth}` },
    redirect: 'follow'
  });
  if (!res.ok) throw new Error(`Twilio media download ${res.status}`);
  const contentType = res.headers.get('content-type') || 'image/jpeg';
  const buf = await res.arrayBuffer();
  const base64 = Buffer.from(buf).toString('base64');
  return { base64, contentType };
}

// ─── Twilio : envoyer un SMS reply ────────────────────────
async function sendTwilioReply(toPhone, body) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_PHONE;
  if (!sid || !token || !from) {
    console.warn('[sms] Twilio env vars manquantes — pas de reply envoyé');
    return null;
  }
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const auth = Buffer.from(`${sid}:${token}`).toString('base64');
  const params = new URLSearchParams({ From: from, To: toPhone, Body: body });
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params.toString()
  });
  if (!res.ok) {
    const errTxt = await res.text();
    console.warn('[sms] Twilio reply failed:', res.status, errTxt.substring(0, 200));
    return null;
  }
  return await res.json();
}

module.exports = {
  normalizePhone,
  registerPhone,
  unregisterPhone,
  findLicenseByPhone,
  findPhoneByLicense,
  pushPending,
  getPending,
  clearPending,
  logSms,
  parseSmsViaLlm,
  parseImageViaLlm,
  downloadTwilioMedia,
  sendTwilioReply
};
