// Endpoint GET /api/download?os=win|mac — Étape 34b
// Lien de téléchargement STABLE et convivial : redirige directement vers le DERNIER
// installateur (un clic → le fichier se télécharge), sans jamais montrer la page
// GitHub Releases (jargon technique, assets multiples — pas pour les courtiers).
//
//   Windows : https://license-server-ebon-xi.vercel.app/api/download
//   Mac     : https://license-server-ebon-xi.vercel.app/api/download?os=mac
//
// Parcourt les releases publiées et prend le premier installateur trouvé (Windows :
// TRI-ANGLE-Setup-*.exe ; Mac : .dmg Intel de préférence — utile quand le dernier
// build Mac a échoué, ex. v0.3.31 sans .dmg → retombe sur v0.3.30).
// Cache CDN 10 min (ménage le rate-limit GitHub). En cas de pépin : page releases.

const REPO = 'CRM-Courtiers/CRM-Courtiers';
const FALLBACK = 'https://github.com/' + REPO + '/releases/latest';

module.exports = async (req, res) => {
  const os = (((req.query || {}).os) || 'win').toString().toLowerCase();
  try {
    const r = await fetch('https://api.github.com/repos/' + REPO + '/releases?per_page=15', {
      headers: { 'User-Agent': 'tri-angle-download', 'Accept': 'application/vnd.github+json' }
    });
    if (!r.ok) throw new Error('GitHub ' + r.status);
    const rels = await r.json();
    let url = null;
    for (const rel of rels) {
      if (rel.draft || rel.prerelease) continue;
      const assets = rel.assets || [];
      if (os === 'mac') {
        const dmg = assets.find(a => /\.dmg$/i.test(a.name) && !/arm64/i.test(a.name))
          || assets.find(a => /\.dmg$/i.test(a.name));
        if (dmg) { url = dmg.browser_download_url; break; }
      } else {
        const exe = assets.find(a => /^TRI-ANGLE-Setup-.*\.exe$/i.test(a.name));
        if (exe) { url = exe.browser_download_url; break; }
      }
    }
    if (!url) throw new Error('aucun installateur trouvé');
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');
    res.redirect(302, url);
  } catch (e) {
    console.error('[download]', e && e.message);
    res.redirect(302, FALLBACK);
  }
};
