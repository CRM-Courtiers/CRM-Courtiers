// Migration one-shot : copie data/keys.json → Upstash Redis (hash "licenses")
// Usage : node migrate-to-kv.js
//
// Idempotent : si une clé existe déjà dans KV avec la même date d'expiration,
// elle est skipée. Sinon écrasée (KV gagne... non, JSON gagne — c'est le seed).
//
// Options :
//   --force  Écrase tout, même les clés déjà présentes en KV
//   --dry    Affiche ce qui serait fait, sans écrire

const fs = require('fs');
const path = require('path');
const { getAllKeys, setKey } = require('./lib/kv');

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const DRY = args.includes('--dry');

async function main() {
  const jsonPath = path.join(__dirname, 'data', 'keys.json');
  const jsonData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

  console.log('');
  console.log('═══════════════════════════════════════════');
  console.log(' 🔄 MIGRATION keys.json → Upstash Redis');
  console.log('═══════════════════════════════════════════');
  console.log('');
  if (DRY) console.log('[DRY RUN] Aucune écriture ne sera faite.');
  console.log('');

  const existing = await getAllKeys();
  const existingKeys = new Set(Object.keys(existing));

  let added = 0, skipped = 0, overwritten = 0;
  const entries = Object.entries(jsonData).filter(([k]) => !k.startsWith('_'));

  for (const [key, entry] of entries) {
    const alreadyThere = existingKeys.has(key);

    if (alreadyThere && !FORCE) {
      console.log(`  ⏭  ${key}  (${entry.name || '—'})  SKIP — déjà en KV`);
      skipped++;
      continue;
    }

    if (DRY) {
      console.log(`  ➕ ${key}  (${entry.name || '—'})  ${alreadyThere ? 'OVERWRITE' : 'ADD'}`);
    } else {
      await setKey(key, entry);
      console.log(`  ✅ ${key}  (${entry.name || '—'})  ${alreadyThere ? 'OVERWRITTEN' : 'ADDED'}`);
    }
    if (alreadyThere) overwritten++; else added++;
  }

  console.log('');
  console.log('───────────────────────────────────────────');
  console.log(`Résumé : ${added} ajoutée(s), ${overwritten} écrasée(s), ${skipped} skipée(s)`);
  console.log('───────────────────────────────────────────');
  console.log('');
  if (DRY) {
    console.log('Pour exécuter la migration : node migrate-to-kv.js');
  } else {
    console.log('Vérifier avec : node list-keys.js');
  }
  console.log('');
}

main().catch(err => {
  console.error('❌ Erreur :', err.message);
  process.exit(1);
});
