// POST /api/start-trial
// Endpoint public — créé un essai gratuit de 90 jours.
// Body : { email, firstName, lastName, machineId }
// Retourne : { key, expires, name }
//
// Anti-abus :
//   - 1 trial par courriel (set Redis "trial_emails")
//   - 1 trial par machine (set Redis "trial_machines", fingerprint Windows MachineGuid ou macOS UUID)
//   - Rate limit IP : géré par Vercel built-in
//
// Email de confirmation : envoyé via Resend (best-effort, échec email ne bloque pas la création de la clé).

const crypto = require('crypto');
const { setKey, keyExists, setHas, setAdd } = require('../lib/kv');
const { Resend } = require('resend');

const TRIAL_DAYS = 90;
const EMAILS_SET = 'trial_emails';
const MACHINES_SET = 'trial_machines';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'lpbussiere.lpb@gmail.com';
const FROM_EMAIL = process.env.FROM_EMAIL || 'TRI-ANGLE <onboarding@resend.dev>';

function isValidEmail(e) {
  if (typeof e !== 'string') return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254;
}

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

function buildEmailHtml({ firstName, key, expiresStr }) {
  const fmt = new Date(expiresStr + 'T12:00:00').toLocaleDateString('fr-CA', { year: 'numeric', month: 'long', day: 'numeric' });
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#F8FAFC;font-family:-apple-system,Segoe UI,sans-serif;color:#0F172A;">
  <div style="max-width:560px;margin:0 auto;padding:40px 24px;">
    <div style="background:#0F172A;padding:24px;border-radius:8px 8px 0 0;text-align:center;">
      <div style="color:#fff;font-size:22px;font-weight:700;letter-spacing:1px;">TRI-ANGLE</div>
      <div style="color:#94A3B8;font-style:italic;font-size:13px;margin-top:4px;">La pierre angulaire de votre réussite</div>
    </div>
    <div style="background:#fff;padding:32px;border-radius:0 0 8px 8px;border:1px solid #E2E8F0;border-top:none;">
      <h1 style="margin:0 0 16px;font-size:20px;">Bonjour ${escapeHtml(firstName)},</h1>
      <p style="line-height:1.6;color:#334155;">Bienvenue dans TRI-ANGLE ! Votre essai gratuit de <strong>90 jours</strong> est maintenant actif.</p>
      <p style="line-height:1.6;color:#334155;">Votre clé de licence — déjà installée dans votre application :</p>
      <div style="background:#0F172A;color:#84CC16;padding:18px;border-radius:6px;font-family:Consolas,monospace;font-size:18px;text-align:center;letter-spacing:1.5px;font-weight:700;margin:20px 0;">${key}</div>
      <p style="line-height:1.6;color:#334155;">Valide jusqu'au <strong>${fmt}</strong>.</p>
      <p style="line-height:1.6;color:#334155;font-size:13px;">Vous n'avez rien à faire — votre app a déjà enregistré la clé automatiquement. Cet email est pour vos dossiers.</p>
      <hr style="border:none;border-top:1px solid #E2E8F0;margin:28px 0;">
      <p style="font-size:12px;color:#64748B;line-height:1.5;">Questions ou commentaires ? Répondez simplement à ce courriel — ça nous parvient directement.</p>
      <p style="font-size:12px;color:#64748B;line-height:1.5;margin-top:16px;">— L'équipe TRI-ANGLE</p>
    </div>
  </div>
</body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Méthode non autorisée — utiliser POST' });
    return;
  }

  const body = req.body || {};
  const email = (body.email || '').toString().toLowerCase().trim();
  const firstName = (body.firstName || '').toString().trim();
  const lastName = (body.lastName || '').toString().trim();
  const machineId = (body.machineId || '').toString().trim();

  // Validation
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Courriel invalide.' });
  }
  if (!firstName || firstName.length > 60) {
    return res.status(400).json({ error: 'Prénom requis (max 60 caractères).' });
  }
  if (!lastName || lastName.length > 60) {
    return res.status(400).json({ error: 'Nom requis (max 60 caractères).' });
  }
  if (!machineId || machineId.length < 8 || machineId.length > 128) {
    return res.status(400).json({ error: 'Identifiant machine manquant ou invalide.' });
  }

  try {
    // Anti-abus
    const [emailUsed, machineUsed] = await Promise.all([
      setHas(EMAILS_SET, email),
      setHas(MACHINES_SET, machineId)
    ]);

    if (emailUsed) {
      return res.status(409).json({
        error: 'Un essai gratuit existe déjà pour ce courriel. Si vous avez perdu votre clé, contactez-nous.',
        code: 'EMAIL_USED'
      });
    }
    if (machineUsed) {
      return res.status(409).json({
        error: 'Un essai gratuit a déjà été activé sur cet appareil. Si vous croyez que c\'est une erreur, contactez-nous.',
        code: 'MACHINE_USED'
      });
    }

    // Générer la clé
    const key = await generateUniqueKey();
    const exp = new Date();
    exp.setDate(exp.getDate() + TRIAL_DAYS);
    const expiresStr = exp.toISOString().substring(0, 10);

    const entry = {
      expires: expiresStr,
      plan: 'free_trial',
      name: `${firstName} ${lastName}`,
      firstName,
      lastName,
      email,
      machineId,
      createdAt: new Date().toISOString().substring(0, 10),
      trialSource: 'self-service'
    };

    await setKey(key, entry);
    await Promise.all([
      setAdd(EMAILS_SET, email),
      setAdd(MACHINES_SET, machineId)
    ]);

    // Email de confirmation (best-effort, off par défaut tant qu'un domaine n'est pas vérifié dans Resend)
    // Pour activer : définir TRIAL_EMAIL_ENABLED=true dans Vercel (et avoir un domaine vérifié)
    if (process.env.TRIAL_EMAIL_ENABLED === 'true' && process.env.RESEND_API_KEY) {
      try {
        const resend = new Resend(process.env.RESEND_API_KEY);
        await resend.emails.send({
          from: FROM_EMAIL,
          to: email,
          replyTo: SUPPORT_EMAIL,
          subject: 'Votre essai gratuit TRI-ANGLE de 90 jours',
          html: buildEmailHtml({ firstName, key, expiresStr })
        });
      } catch (emailErr) {
        // On log mais on échoue pas la requête — la clé est créée, c'est l'essentiel
        console.error('[start-trial] email send failed:', emailErr.message);
      }
    } else {
      console.warn('[start-trial] RESEND_API_KEY non configurée, email skip');
    }

    return res.status(200).json({ key, expires: expiresStr, name: entry.name });

  } catch (err) {
    console.error('[start-trial] error:', err);
    return res.status(500).json({ error: 'Erreur serveur. Réessayez dans un instant.' });
  }
};
