// Prolonge une clé de licence TRI-ANGLE existante (Upstash Redis).
// Usage : node renew-key.js "XXXX-XXXX-XXXX-XXXX" <mois>

const readline = require('readline');
const { getKey, setKey } = require('./lib/kv');

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('❌ Usage : node renew-key.js "XXXX-XXXX-XXXX-XXXX" <mois>');
  console.error('   Exemple : node renew-key.js "KC9K-NM5C-GMQZ-CAPM" 12');
  process.exit(1);
}

const rawKey = args[0].toUpperCase().trim();
const months = parseInt(args[1]);

if (isNaN(months) || months < 1 || months > 120) {
  console.error('❌ Nombre de mois invalide (1-120).');
  process.exit(1);
}

async function applyRenewal(entry, isExpired) {
  const base = isExpired ? new Date() : new Date(entry.expires + 'T23:59:59');
  base.setMonth(base.getMonth() + months);
  const newExpires = base.toISOString().substring(0, 10);

  const oldExpires = entry.expires;
  entry.expires = newExpires;
  if (entry.revoked) {
    delete entry.revoked;
    delete entry.revokedAt;
  }
  entry.renewedAt = new Date().toISOString().substring(0, 10);

  await setKey(rawKey, entry);

  console.log('');
  console.log('═══════════════════════════════════════════');
  console.log(' ✅ CLÉ PROLONGÉE');
  console.log('═══════════════════════════════════════════');
  console.log('');
  console.log('  Clé :        ' + rawKey);
  console.log('  Client :     ' + (entry.name || '—'));
  console.log('  Plan :       ' + entry.plan);
  console.log('  Ancienne :   ' + oldExpires + (isExpired ? '  (expirée)' : ''));
  console.log('  Nouvelle :   ' + newExpires + '  (+' + months + ' mois' + (isExpired ? ' depuis aujourd\'hui' : '') + ')');
  console.log('');
  console.log('═══════════════════════════════════════════');
  console.log('');
  console.log('✅ Prend effet immédiatement (pas besoin de deploy).');
  console.log('');
}

async function main() {
  const entry = await getKey(rawKey);
  if (!entry) {
    console.error(`❌ Clé inconnue : ${rawKey}`);
    console.error('   Liste les clés avec : node list-keys.js');
    process.exit(1);
  }

  const now = new Date();
  const currentExpires = new Date(entry.expires + 'T23:59:59');
  const isExpired = currentExpires < now;

  if (entry.revoked) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    await new Promise((resolve) => {
      rl.question(`⚠  La clé ${rawKey} (${entry.name || '—'}) est révoquée depuis ${entry.revokedAt || '?'}.\n   La réactiver et la prolonger de ${months} mois ? [o/N] `, async (answer) => {
        rl.close();
        const a = answer.toLowerCase().trim();
        if (a === 'o' || a === 'oui') {
          await applyRenewal(entry, isExpired);
        } else {
          console.log('Annulé. Aucun changement.');
        }
        resolve();
      });
    });
  } else {
    await applyRenewal(entry, isExpired);
  }
}

main().catch(err => {
  console.error('❌ Erreur :', err.message);
  process.exit(1);
});
