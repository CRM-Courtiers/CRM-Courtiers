// Révoque (soft) une clé de licence TRI-ANGLE dans Upstash Redis.
// Usage : node revoke-key.js "XXXX-XXXX-XXXX-XXXX"

const readline = require('readline');
const { getKey, setKey } = require('./lib/kv');

const args = process.argv.slice(2);
if (args.length < 1) {
  console.error('❌ Usage : node revoke-key.js "XXXX-XXXX-XXXX-XXXX"');
  process.exit(1);
}

const rawKey = args[0].toUpperCase().trim();

async function main() {
  const entry = await getKey(rawKey);
  if (!entry) {
    console.error(`❌ Clé inconnue : ${rawKey}`);
    console.error('   Liste les clés avec : node list-keys.js');
    process.exit(1);
  }

  if (entry.revoked) {
    console.log(`ℹ  La clé ${rawKey} est déjà révoquée depuis ${entry.revokedAt || '?'}. Aucun changement.`);
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise((resolve) => {
    rl.question(`⚠  Révoquer la clé ${rawKey} (${entry.name || '—'}, expire ${entry.expires}) ?\n   Le client perdra l'accès au prochain check serveur (24h max). [o/N] `, async (answer) => {
      rl.close();
      const a = answer.toLowerCase().trim();
      if (a !== 'o' && a !== 'oui') {
        console.log('Annulé. Aucun changement.');
        resolve();
        return;
      }

      entry.revoked = true;
      entry.revokedAt = new Date().toISOString().substring(0, 10);

      await setKey(rawKey, entry);

      console.log('');
      console.log('═══════════════════════════════════════════');
      console.log(' 🚫 CLÉ RÉVOQUÉE');
      console.log('═══════════════════════════════════════════');
      console.log('');
      console.log('  Clé :       ' + rawKey);
      console.log('  Client :    ' + (entry.name || '—'));
      console.log('  Révoquée :  ' + entry.revokedAt);
      console.log('');
      console.log('═══════════════════════════════════════════');
      console.log('');
      console.log('✅ Prend effet sous 24h (cache client). Pour réactiver : node renew-key.js "' + rawKey + '" <mois>');
      console.log('');
      resolve();
    });
  });
}

main().catch(err => {
  console.error('❌ Erreur :', err.message);
  process.exit(1);
});
