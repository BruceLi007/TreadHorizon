/**
 * 本地客户端 ↔ 云端账号（2026-11-18 D-523 登录 / D-524 分享直传 / D-525 同步快照）
 *
 * 设计要点：
 * - 密码只在登录那一刻经过本地服务，**不落盘**；落地只存云端会话 Cookie
 *   （`data/cloud-account.json`，0600，不在备份清单里）。
 * - 所有云端调用都是**服务端到服务端**（Node fetch，没有 Origin 头 → 云端 sameOrigin 放行），
 *   浏览器不跨域，云端也不用开 CORS。
 * - 分享直传复用本地「导出分享包」那套生成器（server/share-export.mjs），生成 zip 后
 *   直接 POST 云端 `/api/shares/import`，不再让用户先导出再手动上传。
 * - 同步是把「全部足迹的缩略图 + 元数据」打成同格式的包，POST 云端 `/api/snapshot/import`，
 *   云端导入账号主库（每个账号只保留一份，覆盖式）。
 */
import {
  existsSync,
  mkdirSync,
  openAsBlob,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { CONFIG } from './config.mjs';
import { db, now } from './db.mjs';
import { sameOrigin } from './auth.mjs';
import { mediaBaseFor } from './media-root.mjs';
import { safeResolve } from './paths.mjs';
import { decodeHeicToJpeg, isHeicFile } from './heic.mjs';
import { writeZip } from './zip.mjs';
import { haversineKm } from './stats.mjs';

export class CloudError extends Error {
  constructor(message, status = 400, code = '') {
    super(message);
    this.name = 'CloudError';
    this.status = status;
    this.code = code;
  }
}

const CRED_PATH = join(CONFIG.dataDir, 'cloud-account.json');
/** 2026-11-18 D-528：云端账号头像的本地缓存（云端头像要登录态 + 跨域，浏览器 <img> 拿不到） */
const AVATAR_PATH = join(CONFIG.dataDir, 'cloud-avatar.webp');
const AVATAR_META = join(CONFIG.dataDir, 'cloud-avatar.json');
const PREVIEW_MAX = 1280;
const PREVIEW_QUALITY = 75;
const JOB_TTL_MS = 60 * 60 * 1000;
const jobs = new Map();

const sha16 = (s) => randomUUID().slice(0, 8) + String(s).length.toString(16);
const pad = (n) => String(n).padStart(2, '0');
const fileSize = (p) => {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
};

function pruneJobs() {
  const cut = Date.now() - JOB_TTL_MS;
  for (const [id, j] of jobs) if (j.finishedAt && j.finishedAt < cut) jobs.delete(id);
}

/* ───────────── 凭据 ───────────── */

export function readCredential() {
  try {
    const c = JSON.parse(readFileSync(CRED_PATH, 'utf8'));
    if (c && typeof c.baseUrl === 'string' && typeof c.cookie === 'string' && c.cookie) return c;
  } catch {
    /* 没登录过 / 文件损坏都当未登录 */
  }
  return null;
}

function writeCredential(c) {
  mkdirSync(CONFIG.dataDir, { recursive: true });
  writeFileSync(CRED_PATH, JSON.stringify(c, null, 2), { mode: 0o600 });
}

export function clearCredential() {
  try {
    unlinkSync(CRED_PATH);
  } catch {
    /* ignore */
  }
}

/* ───────────── 头像缓存（D-528） ───────────── */

function clearAvatarCache() {
  for (const p of [AVATAR_PATH, AVATAR_META]) {
    try {
      unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
}

function readAvatarMeta() {
  try {
    return JSON.parse(readFileSync(AVATAR_META, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * 拉当前云端账号的头像（128×128 webp）并缓存到本机，供 `/api/cloud/avatar` 直接回图。
 * - 云端没设头像（avatarUpdatedAt=0）→ null（前端回退显示名首字母）；
 * - 版本号没变 → 直接用缓存；变了 → 重新拉一次后覆盖；
 * - 云端连不上 / 401 → 有缓存就先给缓存（顶栏不要因为断网变空）。
 * @returns {Promise<{buf: Buffer, at: number}|null>}
 */
export async function cloudAvatar() {
  const cred = readCredential();
  if (!cred) return null;
  const cached = existsSync(AVATAR_PATH) ? readFileSync(AVATAR_PATH) : null;
  const meta = readAvatarMeta();
  const cachedAt = Number(meta.at) || 0;

  let at = 0;
  let meOk = false;
  try {
    const meRes = await cloudFetch(cred, '/api/auth/me', { timeoutMs: 5000 });
    if (meRes.status === 401) {
      clearCredential();
      clearAvatarCache();
      return null;
    }
    const me = await readJson(meRes);
    if (me?.user) {
      meOk = true;
      at = Number(me.user.avatarUpdatedAt ?? me.user.avatar_updated_at ?? 0) || 0;
    } else if (meRes.ok) {
      // 会话已失效（云端 /api/auth/me 未登录时返回 200 + user:null）
      clearCredential();
      clearAvatarCache();
      return null;
    }
  } catch {
    /* 云端不可达：走缓存兜底 */
  }

  if (meOk && !at) return null; // 账号没设头像
  if (!at && cached) return { buf: cached, at: cachedAt }; // 离线：用旧缓存
  if (cached && at === cachedAt) return { buf: cached, at };

  try {
    const res = await cloudFetch(cred, '/api/account/avatar', { timeoutMs: 8000 });
    if (!res.ok) return cached ? { buf: cached, at: cachedAt } : null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return cached ? { buf: cached, at: cachedAt } : null;
    try {
      writeFileSync(AVATAR_PATH, buf);
      writeFileSync(AVATAR_META, JSON.stringify({ at, savedAt: now() }));
    } catch {
      /* 写缓存失败不影响这次显示 */
    }
    return { buf, at };
  } catch {
    return cached ? { buf: cached, at: cachedAt } : null;
  }
}

function requireCredential() {
  const c = readCredential();
  if (!c) throw new CloudError('还没有登录云端账号', 401, 'relogin');
  return c;
}

/** 规范化云端地址：只允许 http(s)，去掉尾部斜杠，不允许带查询 / hash */
export function normalizeBaseUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) throw new CloudError('请填写云端地址');
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new CloudError('云端地址格式不正确（例如 https://share.example.com）');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new CloudError('云端地址必须是 http:// 或 https://');
  }
  if (u.search || u.hash) throw new CloudError('云端地址不要带参数');
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

/* ───────────── 云端请求 ───────────── */

async function cloudFetch(cred, path, { timeoutMs = 20000, ...opts } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${cred.baseUrl}${path}`, {
      ...opts,
      signal: ctrl.signal,
      headers: { cookie: cred.cookie, ...(opts.headers || {}) },
    });
    return res;
  } catch (e) {
    if (e?.name === 'AbortError') throw new CloudError('云端请求超时，请检查网络', 504);
    throw new CloudError('连不上云端，请检查地址和网络', 502);
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

/* ───────────── 登录 / 状态 ───────────── */

export async function cloudLogin(body = {}) {
  if (CONFIG.authMode !== 'local') throw new CloudError('云端版本不需要在这里登录', 400);
  const baseUrl = normalizeBaseUrl(body.baseUrl);
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!username) throw new CloudError('请填写用户名');
  if (!password) throw new CloudError('请填写密码');

  let res;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      res = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    if (e?.name === 'AbortError') throw new CloudError('登录超时，请检查云端地址', 504);
    if (e?.cause?.code === 'CERT_HAS_EXPIRED' || e?.cause?.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
      throw new CloudError('云端证书不受信任，请检查 https 配置', 502);
    }
    throw new CloudError('连不上云端，请检查地址和网络', 502);
  }
  if (res.status === 401) throw new CloudError('用户名或密码不正确', 401);
  if (res.status === 429) throw new CloudError('尝试次数过多，请稍后再试', 429);
  if (res.status === 404) throw new CloudError('这个地址不是 Tread Horizon 云端（接口不存在）', 404);
  if (!res.ok) throw new CloudError(`云端登录失败（HTTP ${res.status}）`, 502);

  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const cookie = list
    .map((c) => String(c).split(';')[0])
    .filter(Boolean)
    .join('; ');
  if (!cookie) throw new CloudError('云端没有返回登录会话', 502);

  const meRes = await cloudFetch({ baseUrl, cookie }, '/api/auth/me');
  const me = await readJson(meRes);
  if (!meRes.ok || !me?.user) throw new CloudError('登录后无法确认账号，请检查云端版本', 502);

  const user = me.user;
  writeCredential({
    baseUrl,
    cookie,
    username: user.username || username,
    displayName: user.display_name || user.displayName || user.username || username,
    savedAt: now(),
  });
  // 换账号 / 重新登录：上一张云端头像的缓存作废
  clearAvatarCache();
  return cloudStatus();
}

export async function cloudLogout() {
  const cred = readCredential();
  if (cred) {
    try {
      await cloudFetch(cred, '/api/auth/logout', { method: 'POST', timeoutMs: 5000 });
    } catch {
      /* 云端连不上也要清本地 */
    }
  }
  clearCredential();
  clearAvatarCache();
  return { ok: true };
}

/** 本地快照指纹：地点 / 到访 / 照片数 + 最新更新时间，用来提示「本地有未同步的改动」
 *  2026-11-18 D-529（测试 E4）：三个数必须和 runSyncJob **同一个口径**——
 *  排除秘密基地，且「到访」只算有照片的（runSyncJob 只把带照片的到访打进包）。
 *  否则有秘密基地 / 有没有照片的到访的账号，同步成功后仍会一直显示「本地有未同步的改动」。
 */
export function localSnapshotFingerprint() {
  const p = db
    .prepare('SELECT COUNT(*) AS n, MAX(updated_at) AS m FROM place WHERE deleted_at IS NULL AND secret = 0 AND user_id IS NULL')
    .get();
  const v = db
    .prepare(
      `SELECT COUNT(*) AS n, MAX(v.updated_at) AS m FROM visit v
         JOIN place p ON p.id = v.place_id
        WHERE v.deleted_at IS NULL AND p.deleted_at IS NULL AND p.secret = 0 AND v.user_id IS NULL
          AND EXISTS (SELECT 1 FROM media m2
                        WHERE m2.visit_id = v.id AND m2.kind = 'photo'
                          AND m2.deleted_at IS NULL AND m2.user_id IS NULL)`
    )
    .get();
  const m = db
    .prepare(
      `SELECT COUNT(*) AS n, MAX(m.created_at) AS m FROM media m
         JOIN visit v ON v.id = m.visit_id
         JOIN place p ON p.id = v.place_id
        WHERE m.kind = 'photo' AND m.deleted_at IS NULL
          AND v.deleted_at IS NULL AND p.deleted_at IS NULL AND p.secret = 0
          AND m.user_id IS NULL`
    )
    .get();
  return {
    places: Number(p?.n) || 0,
    visits: Number(v?.n) || 0,
    photos: Number(m?.n) || 0,
    maxUpdated: Math.max(Number(p?.m) || 0, Number(v?.m) || 0, Number(m?.m) || 0),
  };
}

export async function cloudStatus() {
  const cred = readCredential();
  if (!cred) return { configured: false, fingerprint: localSnapshotFingerprint() };
  const out = {
    configured: true,
    baseUrl: cred.baseUrl,
    user: { username: cred.username, displayName: cred.displayName },
    lastSync: cred.lastSync || null,
    fingerprint: localSnapshotFingerprint(),
    reachable: false,
    usage: null,
  };
  try {
    const [meRes, useRes] = await Promise.all([
      cloudFetch(cred, '/api/auth/me', { timeoutMs: 6000 }),
      cloudFetch(cred, '/api/shares/usage', { timeoutMs: 6000 }),
    ]);
    // 2026-11-18 D-529（测试 B8）：云端 /api/auth/me 在未登录时返回 200 + user:null（不是 401），
    // 只看 401 会一直显示「已登录 · 已连接」。user 为空也当会话失效：清凭证 + 提示重新登录。
    const me = meRes.status === 401 ? null : await readJson(meRes);
    if (meRes.status === 401 || !me?.user) {
      clearCredential();
      clearAvatarCache();
      return { configured: false, relogin: true, fingerprint: out.fingerprint };
    }
    out.user = {
      username: me.user.username || cred.username,
      displayName: me.user.display_name || me.user.displayName || cred.displayName,
      avatarUpdatedAt: Number(me.user.avatarUpdatedAt ?? me.user.avatar_updated_at ?? 0) || 0,
    };
    if (useRes.ok) out.usage = await readJson(useRes);
    out.reachable = true;
  } catch (e) {
    out.error = e?.message || String(e);
  }
  return out;
}

/* ───────────── 上传 ───────────── */

/** 分享包直传：POST 云端 /api/shares/import（multipart: file + expiresIn/expiresHours/title） */
export async function uploadSharePackage(zipPath, fields = {}) {
  const cred = requireCredential();
  const blob = await openAsBlob(zipPath, { type: 'application/zip' });
  const form = new FormData();
  form.append('file', blob, 'share.zip');
  form.append('expiresIn', String(fields.expiresIn || '24h'));
  if (fields.expiresHours != null) form.append('expiresHours', String(fields.expiresHours));
  if (fields.title) form.append('title', String(fields.title).slice(0, 200));

  const res = await cloudFetch(cred, '/api/shares/import', {
    method: 'POST',
    body: form,
    timeoutMs: 5 * 60 * 1000,
  });
  if (res.status === 401) {
    clearCredential();
    throw new CloudError('云端登录已过期，请重新登录', 401, 'relogin');
  }
  const data = await readJson(res);
  if (!res.ok) throw new CloudError(data.error || `上传失败（HTTP ${res.status}）`, res.status);
  return data;
}

/* ───────────── 同步（本地打包 → 云端主库） ───────────── */

function sourceImage(abs) {
  if (isHeicFile(abs)) {
    return decodeHeicToJpeg(abs).then((jpeg) => sharp(jpeg, { failOn: 'none' }));
  }
  return sharp(abs, { failOn: 'none' });
}

async function makePreview(abs, dest) {
  const img = await sourceImage(abs);
  const info = await img
    .rotate()
    .resize({ width: PREVIEW_MAX, height: PREVIEW_MAX, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: PREVIEW_QUALITY })
    .toFile(dest);
  return { width: info.width || 0, height: info.height || 0 };
}

async function pool(items, limit, fn) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    })
  );
}

function appVersion() {
  try {
    return JSON.parse(readFileSync(join(CONFIG.root, 'package.json'), 'utf8')).version || '';
  } catch {
    return '';
  }
}

/** 启动一次同步任务（打包 + 上传都在后台；返回 jobId 给前端轮询） */
export function startCloudSync(body = {}) {
  if (CONFIG.authMode !== 'local') throw new CloudError('云端版本不需要同步', 400);
  requireCredential();
  const jobId = randomUUID();
  const job = {
    jobId,
    state: 'running',
    phase: 'pack',
    total: 0,
    done: 0,
    bytes: 0,
    photos: 0,
    places: 0,
    visits: 0,
    error: null,
    createdAt: now(),
    finishedAt: null,
    canceled: false,
    displayName: String(body.displayName || ''),
  };
  jobs.set(jobId, job);
  pruneJobs();
  setImmediate(() => void runSyncJob(job));
  return { jobId };
}

async function runSyncJob(job) {
  const tmp = join(CONFIG.dataDir, 'tmp', `snapshot-${job.jobId}`);
  try {
    mkdirSync(join(tmp, 'media'), { recursive: true });

    const places = db
      .prepare(
        'SELECT * FROM place WHERE deleted_at IS NULL AND secret = 0 AND user_id IS NULL ORDER BY created_at'
      )
      .all();
    const visits = db
      .prepare(
        `SELECT v.* FROM visit v
           JOIN place p ON p.id = v.place_id
          WHERE v.deleted_at IS NULL AND p.deleted_at IS NULL AND p.secret = 0
            AND v.user_id IS NULL
          ORDER BY v.date`
      )
      .all();
    const media = db
      .prepare(
        `SELECT m.* FROM media m
           JOIN visit v ON v.id = m.visit_id
           JOIN place p ON p.id = v.place_id
          WHERE m.kind = 'photo'
            AND m.deleted_at IS NULL AND v.deleted_at IS NULL AND p.deleted_at IS NULL
            AND p.secret = 0 AND m.user_id IS NULL
          ORDER BY m.created_at`
      )
      .all();

    job.places = places.length;
    job.visits = visits.length;
    job.total = media.length;

    const mediaBase = CONFIG.mediaRoot;
    const outMedia = [];
    const fileOf = new Map();

    await pool(media, 2, async (m) => {
      if (job.canceled) return;
      try {
        const abs = safeResolve(mediaBase, m.rel_path);
        if (!abs || !existsSync(abs)) throw new Error('missing');
        const file = `p_${sha16(m.id)}.webp`;
        const dim = await makePreview(abs, join(tmp, 'media', file));
        outMedia.push({
          id: m.id,
          kind: 'photo',
          w: dim.width,
          h: dim.height,
          takenAt: Number(m.taken_at) || Number(m.created_at) || now(),
          file,
          bytes: fileSize(join(tmp, 'media', file)),
          _m: m,
        });
        fileOf.set(m.id, file);
      } catch {
        job.photos += 0;
      } finally {
        job.done += 1;
      }
    });
    if (job.canceled) throw new CloudError('已取消', 499, 'canceled');
    if (!outMedia.length) throw new CloudError('本地没有可同步的照片', 400);

    const byPlace = new Map();
    for (const v of visits) {
      const arr = byPlace.get(v.place_id) || [];
      arr.push(v);
      byPlace.set(v.place_id, arr);
    }
    const mediaByVisit = new Map();
    for (const m of outMedia) {
      const arr = mediaByVisit.get(m._m.visit_id) || [];
      arr.push(m);
      mediaByVisit.set(m._m.visit_id, arr);
    }

    const homeRow = places.find((p) => Number(p.home) === 1) || null;
    const placeOut = [];
    let photoCount = 0;
    let visitCount = 0;
    for (const p of places) {
      const pv = (byPlace.get(p.id) || []).filter((v) => (mediaByVisit.get(v.id) || []).length > 0);
      const visitsOut = pv.map((v) => {
        const list = mediaByVisit.get(v.id) || [];
        photoCount += list.length;
        return {
          id: v.id,
          date: v.date,
          media: list.map((m) => m.id),
          ...(v.title ? { title: v.title } : {}),
          ...(v.note ? { note: v.note } : {}),
          ...(v.companions ? { companions: JSON.parse(v.companions || '[]') } : {}),
        };
      });
      // 地点即使没有照片也保留（想去的、只打了点的），visits 为空
      if (!visitsOut.length && !p.due) {
        /* 仍然保留：快照要和本地库一致 */
      }
      visitCount += visitsOut.length;
      const place = {
        id: p.id,
        name: p.name,
        kind: p.kind === 'wishlist' ? 'wishlist' : 'visited',
        lng: Number(p.lng),
        lat: Number(p.lat),
        ...(p.province_code ? { provinceCode: p.province_code } : {}),
        ...(p.province ? { provinceName: p.province } : {}),
        ...(p.city ? { city: p.city } : {}),
        ...(p.county ? { district: p.county } : {}),
      };
      const coverId =
        p.cover_media_id && fileOf.has(p.cover_media_id) ? p.cover_media_id : null;
      if (coverId) place.coverId = coverId;
      place.visits = visitsOut;
      if (homeRow) {
        place.home = p.id === homeRow.id;
        if (!place.home) {
          place.homeDistanceKm =
            Math.round(haversineKm(Number(homeRow.lng), Number(homeRow.lat), Number(p.lng), Number(p.lat)) * 10) / 10;
        }
      }
      placeOut.push(place);
    }

    const manifest = {
      format: 'tread-horizon-share',
      formatVersion: 1,
      appVersion: appVersion(),
      createdAt: now(),
      title: '',
      sharer: { displayName: job.displayName || '' },
      counts: { places: placeOut.length, visits: visitCount, photos: photoCount },
      places: placeOut,
      media: outMedia.map(({ _m, ...m }) => m),
    };
    writeFileSync(join(tmp, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

    const entries = [{ name: 'manifest.json', data: readFileSync(join(tmp, 'manifest.json')) }];
    for (const m of manifest.media) {
      entries.push({ name: `media/${m.file}`, path: join(tmp, 'media', m.file), compress: false });
    }
    const zipPath = join(tmp, 'snapshot.zip');
    await writeZip(zipPath, entries, { shouldCancel: () => job.canceled });
    job.bytes = fileSize(zipPath);
    job.phase = 'upload';

    const cred = requireCredential();
    const blob = await openAsBlob(zipPath, { type: 'application/zip' });
    const form = new FormData();
    form.append('file', blob, 'snapshot.zip');
    const res = await cloudFetch(cred, '/api/snapshot/import', {
      method: 'POST',
      body: form,
      timeoutMs: 15 * 60 * 1000,
    });
    if (res.status === 401) {
      clearCredential();
      throw new CloudError('云端登录已过期，请重新登录', 401, 'relogin');
    }
    const data = await readJson(res);
    if (!res.ok) throw new CloudError(data.error || `同步失败（HTTP ${res.status}）`, res.status);

    job.state = 'done';
    job.photos = Number(data.photos) || photoCount;
    const fresh = readCredential();
    if (fresh) {
      fresh.lastSync = {
        at: now(),
        places: Number(data.places) || placeOut.length,
        visits: Number(data.visits) || visitCount,
        photos: job.photos,
        bytes: Number(data.bytes) || job.bytes,
      };
      writeCredential(fresh);
    }
  } catch (e) {
    job.state = e?.code === 'canceled' ? 'canceled' : 'error';
    job.error = e?.message || String(e);
  } finally {
    job.finishedAt = now();
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

export function getCloudSyncStatus(jobId) {
  const j = jobs.get(String(jobId || ''));
  if (!j) throw new CloudError('同步任务不存在或已过期', 404);
  return {
    jobId: j.jobId,
    state: j.state,
    phase: j.phase,
    total: j.total,
    done: j.done,
    bytes: j.bytes,
    photos: j.photos,
    places: j.places,
    visits: j.visits,
    error: j.error,
  };
}

export function cancelCloudSync(jobId) {
  const j = jobs.get(String(jobId || ''));
  if (!j) return false;
  if (j.state === 'running') j.canceled = true;
  return true;
}

/**
 * 设置 → 后台任务：列出内存里最近的同步任务（2026-11-19 D-536）。
 *
 * 同步本来就是**服务端后台任务**（`startCloudSync` → setImmediate，关设置 / 刷新都不中断），
 * 但以前只在「云端账号」卡片里按 jobId 轮询：关掉设置就看不到进度、后台任务里也没有这一项。
 * 这里把内存 job 列表暴露给 `/api/background-tasks`，两处共用同一份状态。
 * 任务在内存里按 `JOB_TTL_MS`（60 分钟）过期，前端只需要「当前 + 刚结束的几条」。
 */
export function listCloudSyncJobs() {
  // 2026-11-19：列表也会被「设置 → 后台任务」每 2 秒轮询，顺手清掉过期任务 ——
  // 否则超过 JOB_TTL_MS 的旧行要等到下一次起同步才消失（列表里挂着几小时前的任务很怪）。
  pruneJobs();
  return [...jobs.values()]
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .map((j) => ({
      jobId: j.jobId,
      state: j.state,
      phase: j.phase,
      total: j.total,
      done: j.done,
      bytes: j.bytes,
      photos: j.photos,
      places: j.places,
      visits: j.visits,
      error: j.error,
      createdAt: j.createdAt,
      finishedAt: j.finishedAt,
      canceled: j.canceled === true,
    }));
}

/* ───────────── 路由 ───────────── */

export async function registerCloudRoutes(app) {
  const guard = (reply) => {
    if (CONFIG.authMode !== 'local') {
      reply.code(404).send({ error: '云端版本没有云端账号功能' });
      return false;
    }
    return true;
  };

  app.get('/api/cloud/status', async (req, reply) => {
    if (!guard(reply)) return;
    return cloudStatus();
  });

  /**
   * 2026-11-18 D-528：把云端账号的头像代理到本地（顶栏 + 设置账号卡用）。
   * 云端 `/api/account/avatar` 要登录态、且和本地不同源，浏览器 <img> 带不上 Cookie；
   * 这里由本地服务用存着的会话 Cookie 拉一次并缓存，图片 URL 用手里的版本号做 `?v=`。
   */
  app.get('/api/cloud/avatar', async (req, reply) => {
    if (!guard(reply)) return;
    const av = await cloudAvatar();
    if (!av) return reply.code(404).send({ error: '没有头像' });
    reply.header('content-type', 'image/webp');
    reply.header('cache-control', 'private, max-age=86400');
    return reply.send(av.buf);
  });

  app.post('/api/cloud/login', async (req, reply) => {
    if (!guard(reply)) return;
    if (!sameOrigin(req)) return reply.code(403).send({ error: '请求来源不合法' });
    try {
      return await cloudLogin(req.body || {});
    } catch (e) {
      return reply.code(e.status || 400).send({ error: e.message, code: e.code || '' });
    }
  });

  app.post('/api/cloud/logout', async (req, reply) => {
    if (!guard(reply)) return;
    if (!sameOrigin(req)) return reply.code(403).send({ error: '请求来源不合法' });
    return cloudLogout();
  });

  app.post('/api/cloud/sync', async (req, reply) => {
    if (!guard(reply)) return;
    if (!sameOrigin(req)) return reply.code(403).send({ error: '请求来源不合法' });
    try {
      return startCloudSync(req.body || {});
    } catch (e) {
      return reply.code(e.status || 400).send({ error: e.message, code: e.code || '' });
    }
  });

  app.get('/api/cloud/sync/:jobId', async (req, reply) => {
    if (!guard(reply)) return;
    try {
      return getCloudSyncStatus(req.params.jobId);
    } catch (e) {
      return reply.code(e.status || 404).send({ error: e.message });
    }
  });

  app.post('/api/cloud/sync/:jobId/cancel', async (req, reply) => {
    if (!guard(reply)) return;
    if (!sameOrigin(req)) return reply.code(403).send({ error: '请求来源不合法' });
    return { ok: cancelCloudSync(req.params.jobId) };
  });
}
