// Module partagé : client Upstash Redis + helpers pour les licences TRI-ANGLE
//
// Modèle de données : un seul hash Redis nommé "licenses" où chaque field est
// une clé de licence (XXXX-XXXX-XXXX-XXXX) et la valeur est l'entrée JSON.
//
// Les scripts CLI locaux chargent .env.local via dotenv ; les fonctions Vercel
// reçoivent les env vars automatiquement.

const { Redis } = require('@upstash/redis');

// Charger .env.local pour usage CLI local (no-op si dotenv pas dispo en prod)
try {
  if (!process.env.KV_REST_API_URL) {
    require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });
  }
} catch (e) { /* dotenv pas installé en prod, c'est OK */ }

if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
  throw new Error('KV_REST_API_URL et KV_REST_API_TOKEN doivent être définis (vercel env pull pour local)');
}

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN
});

const HASH_KEY = 'licenses';

async function getAllKeys() {
  const all = await redis.hgetall(HASH_KEY);
  if (!all) return {};
  // Upstash SDK auto-parse les valeurs JSON, mais on garantit le format
  const out = {};
  for (const [k, v] of Object.entries(all)) {
    out[k] = typeof v === 'string' ? JSON.parse(v) : v;
  }
  return out;
}

async function getKey(key) {
  const v = await redis.hget(HASH_KEY, key);
  if (v === null || v === undefined) return null;
  return typeof v === 'string' ? JSON.parse(v) : v;
}

async function setKey(key, entry) {
  await redis.hset(HASH_KEY, { [key]: JSON.stringify(entry) });
}

async function deleteKey(key) {
  await redis.hdel(HASH_KEY, key);
}

async function keyExists(key) {
  const v = await redis.hget(HASH_KEY, key);
  return v !== null && v !== undefined;
}

// Helpers pour sets (anti-abus trial)
async function setHas(setName, value) {
  const r = await redis.sismember(setName, value);
  return r === 1 || r === true;
}

async function setAdd(setName, value) {
  await redis.sadd(setName, value);
}

module.exports = { redis, getAllKeys, getKey, setKey, deleteKey, keyExists, setHas, setAdd, HASH_KEY };
