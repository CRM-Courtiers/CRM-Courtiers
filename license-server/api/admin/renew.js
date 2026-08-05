// POST /api/admin/renew
// Auth : Basic Auth
// Body : { key: "XXXX-...", months: number }
// Retourne : { key, entry: { ... } }
//
// Si la clé est expirée, recommence à aujourd'hui.
// Si la clé est révoquée, la réactive (revoked supprimé).

const { requireAuth } = require('../../lib/auth');
const { getKey, setKey } = require('../../lib/kv');
const { Resend } = require('resend');

// Repli sur l'adresse professionnelle (jamais une adresse personnelle : le replyTo est
// visible par le client quand il répond). En prod, SUPPORT_EMAIL vaut contact@tri-angle.ca.
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'contact@tri-angle.ca';
const FROM_EMAIL = process.env.FROM_EMAIL || 'TRI-ANGLE <onboarding@resend.dev>';

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// Date en toutes lettres, partagée par les versions HTML et texte pour qu'elles
// ne puissent pas diverger. (Volontairement local : renew.js reste autonome.)
function formatExpires(expiresStr) {
  return new Date(expiresStr + 'T12:00:00').toLocaleDateString('fr-CA', { year: 'numeric', month: 'long', day: 'numeric' });
}

// Courriel de confirmation de renouvellement. Couvre aussi la réactivation d'une clé
// révoquée : la formulation « active jusqu'au … » vaut dans les deux cas.
// ⚠ Aucun montant ni prix — les tarifs ne sont pas finalisés.
function buildRenewHtml({ firstName, expiresStr }) {
  const hello = firstName ? `Bonjour ${escapeHtml(firstName)},` : 'Bonjour,';
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#F8FAFC;font-family:-apple-system,Segoe UI,sans-serif;color:#0F172A;">
  <div style="max-width:560px;margin:0 auto;padding:40px 24px;">
    <div style="background:#0F172A;padding:24px;border-radius:8px 8px 0 0;text-align:center;">
      <div style="color:#fff;font-size:22px;font-weight:700;letter-spacing:1px;">TRI-ANGLE</div>
      <div style="color:#94A3B8;font-style:italic;font-size:13px;margin-top:4px;">La pierre angulaire de votre réussite</div>
    </div>
    <div style="background:#fff;padding:32px;border-radius:0 0 8px 8px;border:1px solid #E2E8F0;border-top:none;">
      <h1 style="margin:0 0 16px;font-size:20px;">${hello}</h1>
      <p style="line-height:1.6;color:#334155;">Merci de votre confiance — votre licence TRI-ANGLE est renouvelée.</p>
      <div style="background:#0F172A;color:#84CC16;padding:18px;border-radius:6px;text-align:center;font-size:15px;font-weight:700;margin:20px 0;">
        Licence active jusqu'au ${formatExpires(expiresStr)}
      </div>
      <p style="line-height:1.6;color:#334155;font-size:13px;">Vous n'avez rien à faire : votre application se met à jour automatiquement au prochain démarrage.</p>
      <hr style="border:none;border-top:1px solid #E2E8F0;margin:28px 0;">
      <p style="font-size:12px;color:#64748B;line-height:1.5;">Une question ? Répondez simplement à ce courriel — ça nous parvient directement.</p>
      <p style="font-size:12px;color:#64748B;line-height:1.5;margin-top:16px;">— L'équipe TRI-ANGLE</p>
    </div>
  </div>
</body></html>`;
}

function buildRenewText({ firstName, expiresStr }) {
  const hello = firstName ? `Bonjour ${firstName},` : 'Bonjour,';
  return `${hello}

Merci de votre confiance — votre licence TRI-ANGLE est renouvelée.

    Licence active jusqu'au ${formatExpires(expiresStr)}

Vous n'avez rien à faire : votre application se met à jour automatiquement
au prochain démarrage.

--
Une question ? Répondez simplement à ce courriel — ça nous parvient directement.

— L'équipe TRI-ANGLE
La pierre angulaire de votre réussite`;
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
  const months = parseInt(body.months);

  if (!rawKey) { res.status(400).json({ error: 'Clé manquante' }); return; }
  if (isNaN(months) || months < 1 || months > 120) {
    res.status(400).json({ error: 'Nombre de mois invalide (1-120)' });
    return;
  }

  try {
    const entry = await getKey(rawKey);
    if (!entry) { res.status(404).json({ error: 'Clé inconnue' }); return; }

    const now = new Date();
    const currentExpires = new Date(entry.expires + 'T23:59:59');
    const isExpired = currentExpires < now;
    const base = isExpired ? new Date() : new Date(entry.expires + 'T23:59:59');
    base.setMonth(base.getMonth() + months);
    const newExpires = base.toISOString().substring(0, 10);

    entry.expires = newExpires;
    if (entry.revoked) { delete entry.revoked; delete entry.revokedAt; }
    entry.renewedAt = new Date().toISOString().substring(0, 10);

    await setKey(rawKey, entry);

    // Confirmation au client — BEST-EFFORT et STRICTEMENT après l'écriture en base :
    // le renouvellement est déjà acquis, un échec d'envoi ne doit jamais le remettre en cause.
    // emailSent / emailReason ne servent qu'à informer le dashboard.
    let emailSent = false;
    let emailReason = null;

    if (!entry.email) {
      // Cas courant : clé créée manuellement depuis /admin (aucun courriel sur la fiche).
      emailReason = 'aucun courriel sur cette fiche';
    } else if (!process.env.RESEND_API_KEY) {
      emailReason = 'RESEND_API_KEY non configurée';
    } else {
      try {
        // `firstName` n'existe que sur les inscriptions self-service (formulaire en 2 champs).
        // Les clés créées depuis /admin n'ont qu'un `name` global : on en extrait le prénom
        // pour éviter un « Bonjour, » impersonnel. Si les deux manquent, le gabarit retombe
        // proprement sur « Bonjour, ».
        const prenom = entry.firstName || (entry.name || '').trim().split(/\s+/)[0] || '';
        const resend = new Resend(process.env.RESEND_API_KEY);
        await resend.emails.send({
          from: FROM_EMAIL,
          to: entry.email,
          replyTo: SUPPORT_EMAIL,
          subject: 'Votre licence TRI-ANGLE est renouvelée',
          html: buildRenewHtml({ firstName: prenom, expiresStr: newExpires }),
          text: buildRenewText({ firstName: prenom, expiresStr: newExpires })
        });
        emailSent = true;
      } catch (mailErr) {
        emailReason = mailErr.message || 'échec de l\'envoi';
        console.error('[admin/renew] confirmation email failed:', mailErr.message);
      }
    }

    res.status(200).json({ key: rawKey, entry, emailSent, emailReason, emailTo: entry.email || null });
  } catch (err) {
    console.error('[admin/renew] error:', err);
    res.status(500).json({ error: 'Erreur serveur', detail: err.message });
  }
};
