import { getStore } from '@netlify/blobs';
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const DATA_STORE = 'obsession-hub-data';
const ASSET_STORE = 'obsession-hub-assets';
const MAX_UPLOAD_BYTES = 1_500_000;
const ALLOWED_IMAGES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml']);
const SITE_DOCS = new Set(['site/links', 'site/featured', 'site/getkey', 'site/profile']);
const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const ASSET_RE = /^[a-f0-9]{32}$/;

const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra },
});

function secrets() {
  return { password: process.env.OBSESSION_ADMIN_PASSWORD || '', signing: process.env.OBSESSION_SESSION_SECRET || '' };
}
function safeEqualString(a, b) {
  const aa = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return { algorithm: 'scrypt', salt: salt.toString('base64url'), hash: derived.toString('base64url'), updatedAt: Date.now() };
}
function verifyPasswordRecord(password, record) {
  if (!record || record.algorithm !== 'scrypt' || typeof record.salt !== 'string' || typeof record.hash !== 'string') return false;
  try {
    const salt = Buffer.from(record.salt, 'base64url');
    const expected = Buffer.from(record.hash, 'base64url');
    if (salt.length !== 16 || expected.length !== 64) return false;
    const actual = scryptSync(password, salt, expected.length, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch { return false; }
}
async function verifyAdminPassword(data, candidate) {
  const record = await readJson(data, 'security:admin-password');
  if (record) return verifyPasswordRecord(candidate, record);
  const envPassword = secrets().password;
  return !!envPassword && safeEqualString(candidate, envPassword);
}
function sign(payload, secret) { return createHmac('sha256', secret).update(payload).digest('base64url'); }
function makeToken(secret) {
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ sub: 'admin', iat: now, exp: now + 12 * 60 * 60 })).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}
function isAdmin(req) {
  const { signing } = secrets();
  if (!signing || signing.length < 32) return false;
  const match = /^Bearer\s+([A-Za-z0-9_.-]+)$/i.exec(req.headers.get('authorization') || '');
  if (!match) return false;
  const parts = match[1].split('.'); if (parts.length !== 2) return false;
  const [payload, signature] = parts; const expected = sign(payload, signing);
  if (!safeEqualString(signature, expected)) return false;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return parsed.sub === 'admin' && Number.isFinite(parsed.exp) && parsed.exp > Math.floor(Date.now() / 1000);
  } catch { return false; }
}
function dataKey(path) {
  if (typeof path !== 'string') return null;
  if (SITE_DOCS.has(path)) return { key: `doc:${path}`, path };
  const m = /^(scripts|executors)\/([a-zA-Z0-9_-]{1,64})$/.exec(path);
  if (m) return { key: `${m[1]}:${m[2]}`, path };
  return null;
}
async function readJson(store, key) { return await store.get(key, { type: 'json' }); }
async function readCollection(store, name) {
  if (name !== 'scripts' && name !== 'executors') throw new Error('invalid_collection');
  const { blobs } = await store.list({ prefix: `${name}:` });
  const entries = await Promise.all(blobs.map(async (blob) => {
    const id = blob.key.slice(name.length + 1);
    if (!ID_RE.test(id)) return null;
    const value = await readJson(store, blob.key);
    return value == null ? null : [id, value];
  }));
  return Object.fromEntries(entries.filter(Boolean));
}
async function remoteIsEmpty(store) {
  if (await readJson(store, 'meta:legacy-import-done') != null) return false;
  for (const path of SITE_DOCS) if (await readJson(store, `doc:${path}`) != null) return false;
  for (const name of ['scripts', 'executors']) {
    const { blobs } = await store.list({ prefix: `${name}:` });
    if (blobs.length) return false;
  }
  return true;
}
function errorCode(err) {
  return typeof err?.message === 'string' && /^[a-z0-9_]+$/.test(err.message) ? err.message : 'server_error';
}

export default async (req) => {
  const url = new URL(req.url);
  const data = getStore(DATA_STORE);
  const assets = getStore(ASSET_STORE);
  try {
    if (req.method === 'GET') {
      const assetId = url.searchParams.get('asset');
      if (assetId) {
        if (!ASSET_RE.test(assetId)) return new Response('Not found', { status: 404 });
        const item = await assets.getWithMetadata(assetId, { type: 'arrayBuffer' });
        if (!item || !item.data) return new Response('Not found', { status: 404 });
        const contentType = ALLOWED_IMAGES.has(item.metadata?.contentType) ? item.metadata.contentType : 'application/octet-stream';
        return new Response(item.data, { headers: {
          'Content-Type': contentType, 'Cache-Control': 'public, max-age=3600, immutable',
          'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox",
        } });
      }
      const resource = url.searchParams.get('resource');
      if (resource === 'empty') return json({ empty: await remoteIsEmpty(data) });
      if (resource !== 'all') return json({ error: 'not_found' }, 404);
      const docs = {};
      for (const path of SITE_DOCS) docs[path] = await readJson(data, `doc:${path}`);
      const [scripts, executors] = await Promise.all([readCollection(data, 'scripts'), readCollection(data, 'executors')]);
      return json({ docs, collections: { scripts, executors } });
    }
    if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { Allow: 'GET, POST' });
    const body = await req.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'invalid_request' }, 400);

    if (body.action === 'login') {
      const { password, signing } = secrets();
      const savedPassword = await readJson(data, 'security:admin-password');
      if (signing.length < 32 || (!savedPassword && !password)) return json({ error: 'admin_not_configured', message: 'Set an initial OBSESSION_ADMIN_PASSWORD and a 32+ character OBSESSION_SESSION_SECRET in Netlify, then redeploy. After the first login, you can change your password in the Admin panel.' }, 503);
      if (typeof body.password !== 'string' || !(savedPassword ? verifyPasswordRecord(body.password, savedPassword) : safeEqualString(body.password, password))) return json({ error: 'wrong_password' }, 401);
      return json({ token: makeToken(signing), expiresIn: 43200 });
    }
    if (body.action === 'whoami') {
      if (!isAdmin(req)) return json({ error: 'unauthorized' }, 401);
      return json({ admin: true });
    }
    if (!isAdmin(req)) return json({ error: 'unauthorized' }, 401);

    if (body.action === 'changeAdminPassword') {
      const currentPassword = body.currentPassword;
      const newPassword = body.newPassword;
      if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') return json({ error: 'invalid_request' }, 400);
      if (newPassword.length < 12 || newPassword.length > 256) return json({ error: 'weak_password' }, 400);
      if (newPassword === currentPassword) return json({ error: 'weak_password' }, 400);
      if (!await verifyAdminPassword(data, currentPassword)) return json({ error: 'wrong_current_password' }, 401);
      await data.setJSON('security:admin-password', hashPassword(newPassword));
      return json({ ok: true });
    }

    if (['setDoc', 'updateDoc', 'deleteDoc'].includes(body.action)) {
      const target = dataKey(body.path);
      if (!target) return json({ error: 'invalid_path' }, 400);
      if (body.action === 'deleteDoc') { await data.delete(target.key); return json({ ok: true }); }
      if (!body.data || typeof body.data !== 'object' || Array.isArray(body.data)) return json({ error: 'invalid_data' }, 400);
      let value = body.data;
      if (body.action === 'updateDoc') value = { ...((await readJson(data, target.key)) || {}), ...body.data };
      await data.setJSON(target.key, value);
      return json({ ok: true });
    }

    if (body.action === 'uploadAsset') {
      const match = typeof body.dataUrl === 'string' && /^data:(image\/(?:png|jpeg|gif|webp|svg\+xml));base64,([A-Za-z0-9+/]+={0,2})$/.exec(body.dataUrl);
      if (!match || !ALLOWED_IMAGES.has(match[1])) return json({ error: 'unsupported_type' }, 400);
      const bytes = Buffer.from(match[2], 'base64');
      if (!bytes.length || bytes.length > MAX_UPLOAD_BYTES) return json({ error: 'too_large' }, 413);
      const requestedId = body.id;
      if (requestedId != null && !ASSET_RE.test(requestedId)) return json({ error: 'invalid_asset_id' }, 400);
      const id = requestedId || randomBytes(16).toString('hex');
      const binary = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      await assets.set(id, binary, { ...(requestedId ? { onlyIfNew: true } : {}), metadata: { contentType: match[1] } });
      return json({ id, url: `/.netlify/functions/api?asset=${id}` });
    }
    if (body.action === 'deleteAsset') {
      if (!ASSET_RE.test(body.id || '')) return json({ error: 'invalid_asset_id' }, 400);
      await assets.delete(body.id); return json({ ok: true });
    }

    if (body.action === 'importLegacyData') {
      const legacy = body.legacy;
      if (!legacy || typeof legacy !== 'object' || !legacy.docs || !legacy.collections) return json({ error: 'invalid_legacy_data' }, 400);
      if (!await remoteIsEmpty(data)) return json({ imported: false, reason: 'shared_data_exists' });
      let count = 0;
      for (const path of SITE_DOCS) {
        const value = legacy.docs[path];
        if (value == null) continue;
        const result = await data.setJSON(`doc:${path}`, value, { onlyIfNew: true });
        if (result.modified) count++;
      }
      for (const name of ['scripts', 'executors']) {
        const collection = legacy.collections[name];
        if (!collection || typeof collection !== 'object' || Array.isArray(collection)) continue;
        for (const [id, value] of Object.entries(collection)) {
          if (!ID_RE.test(id) || !value || typeof value !== 'object' || Array.isArray(value)) continue;
          const result = await data.setJSON(`${name}:${id}`, value, { onlyIfNew: true });
          if (result.modified) count++;
        }
      }
      await data.setJSON('meta:legacy-import-done', { at: Date.now(), count });
      return json({ imported: true, count });
    }
    return json({ error: 'unknown_action' }, 400);
  } catch (err) {
    console.error('Obsession API error:', err);
    const code = errorCode(err);
    const status = ['invalid_collection', 'invalid_path', 'invalid_data'].includes(code) ? 400 : 500;
    return json({ error: code }, status);
  }
};
