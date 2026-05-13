// Liste toutes les clés de licence TRI-ANGLE avec leur statut
// Usage : node list-keys.js
//
// Source : Upstash Redis (hash "licenses"). Tri par urgence (expirées en haut).

const { getAllKeys } = require('./lib/kv');

async function main() {
  const keys = await getAllKeys();
  const now = new Date();
  const today = now.toISOString().substring(0, 10);

  const rows = [];
  for (const [key, entry] of Object.entries(keys)) {
    const expiresDate = new Date(entry.expires + 'T23:59:59');
    const daysRemaining = Math.ceil((expiresDate - now) / 86400000);

    let status;
    if (entry.revoked) status = 'RÉVOQUÉE';
    else if (daysRemaining < 0) status = 'EXPIRÉE';
    else if (daysRemaining < 30) status = 'EXPIRE BIENTÔT';
    else status = 'ACTIVE';

    rows.push({ key, name: entry.name || '—', plan: entry.plan, expires: entry.expires, daysRemaining, status });
  }

  const statusOrder = { 'EXPIRÉE': 0, 'EXPIRE BIENTÔT': 1, 'ACTIVE': 2, 'RÉVOQUÉE': 3 };
  rows.sort((a, b) => {
    if (statusOrder[a.status] !== statusOrder[b.status]) return statusOrder[a.status] - statusOrder[b.status];
    return a.daysRemaining - b.daysRemaining;
  });

  const headers = { key: 'Clé', name: 'Nom', plan: 'Plan', expires: 'Expire', days: 'Jours', status: 'Statut' };
  const widths = {
    key: Math.max(headers.key.length, ...rows.map(r => r.key.length), 4),
    name: Math.max(headers.name.length, ...rows.map(r => r.name.length), 3),
    plan: Math.max(headers.plan.length, ...rows.map(r => r.plan.length), 4),
    expires: Math.max(headers.expires.length, ...rows.map(r => r.expires.length), 10),
    days: Math.max(headers.days.length, ...rows.map(r => String(r.daysRemaining).length), 5),
    status: Math.max(headers.status.length, ...rows.map(r => r.status.length), 6)
  };

  const pad = (s, w) => String(s).padEnd(w);
  const padNum = (s, w) => String(s).padStart(w);
  const sep = (w) => '─'.repeat(w);

  const headerLine = [pad(headers.key, widths.key), pad(headers.name, widths.name), pad(headers.plan, widths.plan), pad(headers.expires, widths.expires), padNum(headers.days, widths.days), pad(headers.status, widths.status)].join('  ');
  const sepLine = [sep(widths.key), sep(widths.name), sep(widths.plan), sep(widths.expires), sep(widths.days), sep(widths.status)].join('  ');

  console.log('');
  console.log('═══════════════════════════════════════════');
  console.log(' 🔑 CLÉS DE LICENCE TRI-ANGLE  (' + today + ')');
  console.log('═══════════════════════════════════════════');
  console.log('');

  if (rows.length === 0) {
    console.log('  (Aucune clé en KV. Lance : node migrate-to-kv.js)');
    console.log('');
    return;
  }

  console.log(headerLine);
  console.log(sepLine);
  for (const r of rows) {
    console.log([pad(r.key, widths.key), pad(r.name, widths.name), pad(r.plan, widths.plan), pad(r.expires, widths.expires), padNum(r.daysRemaining, widths.days), pad(r.status, widths.status)].join('  '));
  }

  const counts = { ACTIVE: 0, 'EXPIRE BIENTÔT': 0, 'EXPIRÉE': 0, 'RÉVOQUÉE': 0 };
  for (const r of rows) counts[r.status]++;
  console.log('');
  console.log(`Total : ${rows.length} clé(s)  —  ${counts.ACTIVE} active(s), ${counts['EXPIRE BIENTÔT']} expire(nt) bientôt, ${counts['EXPIRÉE']} expirée(s), ${counts['RÉVOQUÉE']} révoquée(s)`);
  console.log('');
}

main().catch(err => {
  console.error('❌ Erreur :', err.message);
  process.exit(1);
});
