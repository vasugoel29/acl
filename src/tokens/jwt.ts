import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPair, exportJWK, importJWK, SignJWT, jwtVerify, type JWK } from 'jose';
import { config, isProd, isServerless } from '../config.js';
import { pool } from '../db/pool.js';
import { randomToken } from '../util.js';

const ALG = 'ES256';

interface StoredKey {
  kid: string;
  private: JWK;
  public: JWK;
}

let loaded: { stored: StoredKey[]; signing: { kid: string; key: CryptoKey | Uint8Array } } | null = null;
let loadedAt = 0;
const KEY_CACHE_TTL_MS = 60_000;

async function createKey(): Promise<StoredKey> {
  const { privateKey, publicKey } = await generateKeyPair(ALG, { extractable: true });
  const kid = randomToken(8);
  return {
    kid,
    private: { ...(await exportJWK(privateKey)), kid, alg: ALG, use: 'sig' },
    public: { ...(await exportJWK(publicKey)), kid, alg: ALG, use: 'sig' },
  };
}

/**
 * Keys can be loaded from:
 *  1. `SIGNING_KEYS_JSON` environment variable (recommended for serverless / secret managers)
 *  2. Local file `KEYS_FILE` (when present)
 *  3. PostgreSQL `signing_keys` table in serverless environments (Vercel + Supabase)
 */
async function load(force = false) {
  const now = Date.now();
  if (!force && loaded && now - loadedAt < KEY_CACHE_TTL_MS) return loaded;
  let stored: StoredKey[] = [];

  if (config.signingKeysJson) {
    stored = JSON.parse(config.signingKeysJson);
  } else if (fs.existsSync(config.keysFile)) {
    stored = JSON.parse(fs.readFileSync(config.keysFile, 'utf8'));
  } else if (isServerless) {
    const existing = await pool.query(`SELECT keys_json FROM signing_keys WHERE id = 'active'`);
    if (existing.rowCount && existing.rows[0]?.keys_json) {
      stored = existing.rows[0].keys_json;
    } else {
      const fresh = [await createKey()];
      const upserted = await pool.query(
        `INSERT INTO signing_keys (id, keys_json) VALUES ('active', $1::jsonb)
         ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
         RETURNING keys_json`,
        [JSON.stringify(fresh)],
      );
      stored = upserted.rows[0].keys_json;
    }
  } else {
    if (isProd && process.env.ALLOW_AUTO_KEYGEN !== 'true') {
      throw new Error(
        `Signing key file missing at ${config.keysFile} in production. Set SIGNING_KEYS_JSON, mount KEYS_FILE, or set ALLOW_AUTO_KEYGEN=true.`,
      );
    }
    stored = [await createKey()];
    fs.mkdirSync(path.dirname(config.keysFile), { recursive: true });
    fs.writeFileSync(config.keysFile, JSON.stringify(stored, null, 2), { mode: 0o600 });
  }
  const signing = { kid: stored[0].kid, key: await importJWK(stored[0].private, ALG) };
  loaded = { stored, signing };
  loadedAt = now;
  return loaded;
}

/** Add a new signing key at the front (rotation). Old keys stay in JWKS. */
export async function rotateKeys() {
  const { stored } = await load();
  const next = [await createKey(), ...stored].slice(0, 3);
  if (isServerless) {
    await pool.query(
      `INSERT INTO signing_keys (id, keys_json, updated_at) VALUES ('active', $1::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET keys_json = EXCLUDED.keys_json, updated_at = now()`,
      [JSON.stringify(next)],
    );
  } else {
    fs.mkdirSync(path.dirname(config.keysFile), { recursive: true });
    fs.writeFileSync(config.keysFile, JSON.stringify(next, null, 2), { mode: 0o600 });
  }
  loaded = null;
  loadedAt = 0;
}

export async function jwks() {
  const { stored } = await load();
  return { keys: stored.map((k) => k.public) };
}

export async function signJwt(claims: Record<string, unknown>, opts: { aud: string | string[]; sub: string; ttlSec: number; jti?: string }) {
  const { signing } = await load();
  return new SignJWT(claims)
    .setProtectedHeader({ alg: ALG, kid: signing.kid, typ: 'JWT' })
    .setIssuer(config.issuer)
    .setSubject(opts.sub)
    .setAudience(opts.aud)
    .setIssuedAt()
    .setExpirationTime(`${opts.ttlSec}s`)
    .setJti(opts.jti ?? `tok_${randomToken(12)}`)
    .sign(signing.key);
}

export async function verifyJwt(token: string, aud?: string | string[]) {
  let { stored } = await load();
  // Verify against any published key (matched by kid).
  const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
  let k = stored.find((s) => s.kid === header.kid);
  if (!k) {
    stored = (await load(true)).stored;
    k = stored.find((s) => s.kid === header.kid);
  }
  if (!k) throw new Error('unknown kid');
  const key = await importJWK(k.public, ALG);
  let expectedAudience = aud;
  if (aud === config.internalAppId || aud === config.internalClientSlug) {
    expectedAudience = [config.internalAppId, config.internalClientSlug];
  }
  const { payload } = await jwtVerify(token, key, {
    issuer: config.issuer,
    ...(expectedAudience !== undefined ? { audience: expectedAudience } : {}),
    algorithms: [ALG],
  });
  return payload;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  rotateKeys().then(() => console.log(`Rotated ES256 signing keys in ${config.keysFile}`));
}
