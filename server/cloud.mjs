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
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { CONFIG } from './config.mjs';
import { db, now } from './db.mjs';
import { sameOrigin } from './auth.mjs';
import { mediaBaseFor } from './media-root.mjs';
import { safeResolve } from './paths.mjs';
import { isHeicFile } from './heic.mjs';
import { writeZip } from './zip.mjs';
import { SNAPSHOT_LIMITS } from './share-package.mjs';
import {
  HEIC_CONCURRENCY,
  JPEG_CONCURRENCY,
  makeCloudPreview,
  orderByCostDesc,
  persistPreviewNames,
} from './preview-cache.mjs';
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

/**
 * 分享包直传：POST 云端 /api/shares/import（multipart: file + expiresIn/expiresHours/title）。
 *
 * 2026-11-19 D-543：分享也按账号配额、照片不设限，包可能很大 → 改成和快照同一套**流式上传**
 * （真实字节进度 + 按体积给超时 + 90 秒停滞判停），不再用 fetch + FormData（无进度、5 分钟硬超时）。
 */
export async function uploadSharePackage(zipPath, fields = {}, job = null) {
  const cred = requireCredential();
  const progJob = job || { canceled: false, bytes: 0, uploaded: 0 };
  const multipartFields = { expiresIn: String(fields.expiresIn || '24h') };
  if (fields.expiresHours != null) multipartFields.expiresHours = String(fields.expiresHours);
  const title = String(fields.title || '').slice(0, 200);
  if (title) multipartFields.title = title;

  const { status, data } = await uploadZipStream(cred, zipPath, {
    path: '/api/shares/import',
    filename: 'share.zip',
    fields: multipartFields,
    job: progJob,
  });
  if (status === 401) {
    clearCredential();
    throw new CloudError('云端登录已过期，请重新登录', 401, 'relogin');
  }
  if (status < 200 || status >= 300) {
    throw new CloudError(data?.error || `上传失败（HTTP ${status}）`, status);
  }
  return data;
}

/* ───────────── 同步（本地打包 → 云端主库） ───────────── */

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
    /** 打包产物的字节数（zip） */
    bytes: 0,
    /** 2026-11-19 D-541：已上传字节，上传阶段用它算真实进度 */
    uploaded: 0,
    /** 是否复用了上一次失败留下的打包结果（省掉几十分钟重新打包） */
    reused: false,
    /** 2026-11-19 D-542：账号配额 / 分享占用 / 本次可用（拿不到云端 usage 时为 null） */
    quotaBytes: null,
    sharesBytes: null,
    limitBytes: null,
    /** 打包后**解压口径**的字节数（云端按它卡账号配额） */
    uncompressed: 0,
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
  pruneSnapshotTmp();
  setImmediate(() => void runSyncJob(job));
  return { jobId };
}

/**
 * 清理 `data/tmp/snapshot-*` 残留（2026-11-19 D-541）：
 * 失败/取消时会**故意保留**打包好的 zip，好让下次重试直接上传；这里只按天数兜底清掉太旧的。
 */
function pruneSnapshotTmp(keepDays = 7) {
  try {
    const root = join(CONFIG.dataDir, 'tmp');
    if (!existsSync(root)) return;
    const cut = now() - keepDays * 24 * 60 * 60 * 1000;
    for (const name of readdirSync(root)) {
      if (!name.startsWith('snapshot-')) continue;
      const dir = join(root, name);
      try {
        if (statSync(dir).mtimeMs < cut) rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

/**
 * 找一个可以复用的打包结果（2026-11-19 D-541）：同样是「地点 / 到访 / 照片」数量、
 * 且 zip 与 meta 都在，就直接拿来上传，不再花几十分钟重新生成 3342 张预览。
 */
function findReusableZip(counts) {
  try {
    const root = join(CONFIG.dataDir, 'tmp');
    if (!existsSync(root)) return null;
    const candidates = readdirSync(root)
      .filter((n) => n.startsWith('snapshot-'))
      .map((n) => join(root, n))
      .sort((a, b) => {
        try {
          return statSync(b).mtimeMs - statSync(a).mtimeMs;
        } catch {
          return 0;
        }
      });
    for (const dir of candidates) {
      const zip = join(dir, 'snapshot.zip');
      const metaPath = join(dir, 'meta.json');
      if (!existsSync(zip) || !existsSync(metaPath)) continue;
      try {
        const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
        if (
          Number(meta.places) === counts.places &&
          Number(meta.visits) === counts.visits &&
          Number(meta.photos) === counts.photos
        ) {
          return { dir, zip, meta };
        }
      } catch {
        /* 坏 meta 跳过 */
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 拉云端账号的用量（2026-11-19 D-542 / D-543）：配额 / 快照媒体 / 分享占用。
 * 拿不到（离线 / 旧云端没有这个接口）就返回 null：本地不拦，交给云端导入时兜底。
 */
async function fetchCloudUsage(cred) {
  try {
    const res = await cloudFetch(cred, '/api/shares/usage', { timeoutMs: 8000 });
    if (!res.ok) return null;
    const u = await readJson(res);
    const quota = Number(u?.quotaBytes) || 0;
    if (!(quota > 0)) return null;
    return {
      quota,
      mediaBytes: Number(u?.mediaBytes) || 0,
      sharesBytes: Number(u?.sharesBytes) || 0,
      shareCount: Number(u?.shareCount) || 0,
    };
  } catch {
    return null;
  }
}

/** 快照可用 = 配额 − 分享占用（快照整批替换自身，旧快照不重复计） */
const snapshotAvailable = (u) => Math.max(0, u.quota - u.sharesBytes);
/** 分享可用 = 配额 − 快照媒体 − 已有分享（分享是新增占用） */
export const shareAvailableOf = (u) => Math.max(0, u.quota - u.mediaBytes - u.sharesBytes);

/** 分享当前可用（给 share-export 打包后先拦一道；拿不到云端用量返回 null） */
export async function cloudShareCapacity() {
  const cred = readCredential();
  if (!cred) return null;
  const usage = await fetchCloudUsage(cred);
  if (!usage) return null;
  return {
    quota: usage.quota,
    used: usage.mediaBytes + usage.sharesBytes,
    available: shareAvailableOf(usage),
    usage,
  };
}

const fmtMB = (n) => `${(n / 1024 ** 2).toFixed(1)} MB`;

/**
 * 配额不足的统一话术（2026-11-19 D-542/D-543）：**直接给出「已用 / 上限 / 剩余」**，
 * 用户要的就是「下次的限额 = 总配额 − 已占用」。
 */
export function quotaMessage(kind, needBytes, usage) {
  const isShare = kind === 'share';
  const used = isShare ? usage.mediaBytes + usage.sharesBytes : usage.sharesBytes;
  const remaining = Math.max(0, usage.quota - used);
  const label = isShare ? '分享' : '同步';
  const need = needBytes > 0 ? `本次${label}约需 ${fmtMB(needBytes)}，` : '';
  const tail = isShare
    ? '可以在云端「设置 → 账号」申请扩容，或减少要分享的照片。'
    : '可以在云端「设置 → 账号」申请扩容，或先删掉一些分享；扩容后再点「立即同步」会直接复用这次打好的包。';
  return `账号空间不足：${need}上限 ${fmtMB(usage.quota)}，已用 ${fmtMB(used)}，剩余 ${fmtMB(remaining)}。${tail}`;
}

function quotaError(needBytes, usage, kind = 'sync') {
  return new CloudError(quotaMessage(kind, needBytes, usage), 413, 'quota');
}

/**
 * 流式 multipart 上传 zip（2026-11-19 D-541 快照 / D-543 分享共用）。
 *
 * 为什么不用 fetch + FormData：那样**拿不到上传进度**，几百 MB 的包传几十分钟也只有
 * 「完成数」停着不动，看起来就像卡死；这里手工拼 multipart，边写边数已发字节，
 * 超时改成「按体积给预算 + 90 秒无进展就判停」。
 *
 * @param {{path:string, fields?:Record<string,string>, filename?:string, job:object}} opts
 *   job 至少要有 canceled / bytes / uploaded 字段；上传中会持续更新 uploaded（只数文件字节）。
 */
function uploadZipStream(cred, zipPath, { path: apiPath, fields = {}, filename = 'package.zip', job }) {
  return new Promise((resolve, reject) => {
    const size = fileSize(zipPath);
    job.bytes = size;
    job.uploaded = 0;
    const boundary = `----treadhorizon${randomUUID().replace(/-/g, '')}`;
    const parts = [];
    for (const [name, value] of Object.entries(fields)) {
      if (value == null) continue;
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${String(value)}\r\n`
        )
      );
    }
    parts.push(
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
          'Content-Type: application/zip\r\n\r\n'
      )
    );
    const head = Buffer.concat(parts);
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const total = head.length + size + tail.length;

    let url;
    try {
      url = new URL(apiPath, cred.baseUrl);
    } catch {
      return reject(new CloudError('云端地址不合法', 502));
    }
    const mod = url.protocol === 'https:' ? https : http;
    // 预算：10 分钟打底 + 每 40 MB 加 4 分钟（400 MB ≈ 50 分钟），上限 3 小时
    const budgetMs = Math.min(
      3 * 60 * 60 * 1000,
      10 * 60 * 1000 + Math.ceil(size / (40 * 1024 * 1024)) * 4 * 60 * 1000
    );
    const IDLE_MS = 90 * 1000;

    let settled = false;
    let lastProgress = Date.now();
    const watchdog = setInterval(() => {
      if (job.canceled) {
        req.destroy(new CloudError('已取消', 499, 'canceled'));
        return;
      }
      if (Date.now() - lastProgress > IDLE_MS) {
        req.destroy(new CloudError('上传停滞超过 90 秒，已中断（可重试）', 504));
      }
    }, 5000);
    watchdog.unref?.();
    const budgetTimer = setTimeout(() => {
      req.destroy(new CloudError(`上传超时（预算 ${Math.round(budgetMs / 60000)} 分钟）`, 504));
    }, budgetMs);
    budgetTimer.unref?.();
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      clearTimeout(budgetTimer);
      if (err) reject(err);
      else resolve(value);
    };

    const req = mod.request(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
          'content-length': String(total),
          cookie: cred.cookie,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          let data = {};
          try {
            data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            /* 非 JSON */
          }
          finish(null, { status: res.statusCode || 0, data });
        });
        res.on('error', (e) => finish(new CloudError(`读云端响应失败：${e.message}`, 502)));
      }
    );

    req.on('error', (e) => {
      if (e instanceof CloudError) return finish(e);
      finish(new CloudError(`上传失败：${e?.message || String(e)}`, 502));
    });

    // 文件流 → 请求体，边写边记 bytes（backpressure 用 drain 等）；head 不算进度
    const stream = createReadStream(zipPath);
    req.write(head);
    stream.on('data', (chunk) => {
      if (settled) return;
      lastProgress = Date.now();
      const ok = req.write(chunk, () => {
        job.uploaded += chunk.length;
      });
      if (!ok) stream.pause();
    });
    req.on('drain', () => stream.resume());
    stream.on('end', () => {
      if (settled) return;
      req.end(tail, () => {
        job.uploaded = size;
      });
    });
    stream.on('error', (e) => {
      req.destroy(e);
      finish(new CloudError(`读打包文件失败：${e.message}`, 500));
    });
  });
}

/** 同步包上传（快照导入） */
function uploadSnapshot(cred, zipPath, job) {
  return uploadZipStream(cred, zipPath, {
    path: '/api/snapshot/import',
    filename: 'snapshot.zip',
    job,
  });
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

    /**
     * 2026-11-19 D-542：**包大小上限跟账号配额走，照片张数不设限**。
     * 先拿云端 usage（拿不到就不在本地拦，云端导入时兜底），可用 = 配额 − 分享占用。
     */
    const usage = await fetchCloudUsage(requireCredential());
    const syncAvailable = usage ? snapshotAvailable(usage) : 0;
    if (usage) {
      job.quotaBytes = usage.quota;
      job.sharesBytes = usage.sharesBytes;
      job.limitBytes = syncAvailable;
      if (syncAvailable <= 0) throw quotaError(0, usage, 'sync');
    }

    /**
     * 2026-11-19 D-541：**本地先把关**（张数口径保留给测试用 env 覆盖；默认不限制）。
     * 以前是传完 403 MB 才被云端回「一份分享最多 2000 张照片」；现在超出配额在打包后立刻报错。
     */
    if (Number.isFinite(SNAPSHOT_LIMITS.maxMedia) && media.length > SNAPSHOT_LIMITS.maxMedia) {
      throw new CloudError(
        `照片太多（${media.length} 张），一次同步最多 ${SNAPSHOT_LIMITS.maxMedia} 张`,
        400
      );
    }
    if (places.length > SNAPSHOT_LIMITS.maxPlaces) {
      throw new CloudError(
        `地点太多（${places.length} 个），一次同步最多 ${SNAPSHOT_LIMITS.maxPlaces} 个`,
        400
      );
    }

    const mediaBase = CONFIG.mediaRoot;
    const outMedia = [];
    const fileOf = new Map();
    /**
     * 2026-11-19 D-541：先看有没有**上次失败留下的打包结果**（地点/到访/照片数量一致才复用）。
     * 这个包 403 MB、3342 张照片，重新生成预览要半个多小时；超时或断网后重试不该再付一次。
     */
    const reused = findReusableZip({
      places: places.length,
      visits: visits.length,
      photos: media.length,
    });
    let zipPath = reused ? reused.zip : '';
    let placeOut = [];
    let visitCount = 0;
    let photoCount = 0;
    if (reused) {
      job.reused = true;
      job.done = job.total;
      job.bytes = fileSize(zipPath);
      job.uncompressed = Number(reused.meta?.uncompressed) || 0;
      job.phase = 'upload';
    } else {

    /**
     * 2026-11-20 D-544：预览缓存 + HEIC 优先调度。
     * - 先查 `<thumbDir>/<id>_p.webp`（或 DB preview）→ 命中就只解 1600 小图；
     * - 未命中从原图生成 1600 并写盘，再由它缩 1280（第一次多一次编码，之后每次同步/分享都省）；
     * - HEIC 是单线程 WASM：先把 HEIC（含大图）跑完、并发 4，再跑 JPEG/PNG（并发 2），避免慢尾巴。
     */
    const cacheUpdates = new Map();
    let cacheCreated = 0;
    const runOne = async (m) => {
      if (job.canceled) return;
      try {
        const abs = safeResolve(mediaBase, m.rel_path);
        if (!abs || !existsSync(abs)) throw new Error('missing');
        const file = `p_${sha16(m.id)}.webp`;
        const dim = await makeCloudPreview({
          id: m.id,
          abs,
          previewName: m.preview,
          dest: join(tmp, 'media', file),
        });
        if (dim.cacheName) cacheUpdates.set(m.id, dim.cacheName);
        if (dim.cacheCreated) cacheCreated += 1;
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
    };
    const ordered = orderByCostDesc(media, (m) => m.rel_path, (m) => m.bytes);
    const heicList = ordered.filter((m) => isHeicFile(m.rel_path));
    const otherList = ordered.filter((m) => !isHeicFile(m.rel_path));
    await pool(heicList, HEIC_CONCURRENCY, runOne);
    await pool(otherList, JPEG_CONCURRENCY, runOne);
    if (job.canceled) throw new CloudError('已取消', 499, 'canceled');
    job.cached = persistPreviewNames(db, cacheUpdates, (msg) => {
      job.cacheWarn = msg;
    });
    job.cacheCreated = cacheCreated;
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
    placeOut = [];
    photoCount = 0;
    visitCount = 0;
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
    const zipPathInner = join(tmp, 'snapshot.zip');
    /**
     * 2026-11-20 D-544：写 zip 单独一个阶段，并给出**字节进度**。
     * 以前 3342/3342 之后还要闷头写 400 MB，进度条停在 100% 看起来像卡住。
     */
    job.uncompressed =
      outMedia.reduce((n, m) => n + (Number(m.bytes) || 0), 0) + fileSize(join(tmp, 'manifest.json'));
    job.phase = 'zip';
    job.zipTotal = job.uncompressed;
    job.zipDone = 0;
    await writeZip(zipPathInner, entries, {
      shouldCancel: () => job.canceled,
      onProgress: ({ bytesDone }) => {
        job.zipDone = bytesDone;
      },
    });
    job.zipDone = job.zipTotal;
    zipPath = zipPathInner;
    job.bytes = fileSize(zipPath);
    // 记一份 meta：失败后重试时用它判断「能不能直接复用这个包」
    writeFileSync(
      join(tmp, 'meta.json'),
      JSON.stringify(
        {
          places: places.length,
          visits: visits.length,
          photos: media.length,
          bytes: job.bytes,
          /** 解压口径（D-542：云端按它卡配额） */
          uncompressed: job.uncompressed,
          createdAt: now(),
        },
        null,
        2
      ),
      'utf8'
    );
    job.phase = 'upload';
    }

    /**
     * 2026-11-19 D-542：本地按账号可用空间先拦一道。
     * 超了不白传（包会留着，扩容后重试直接复用）；拿不到配额时交给云端 413 兜底。
     */
    if (usage && job.uncompressed > syncAvailable) {
      // 还没开始上传，阶段别显示成 upload（否则「上传中」+ 0 字节看起来像卡住）
      job.phase = 'pack';
      throw quotaError(job.uncompressed, usage, 'sync');
    }

    // ── 上传（流式，带真实字节进度；失败时保留 zip 供下次复用）──
    const cred = requireCredential();
    const { status, data } = await uploadSnapshot(cred, zipPath, job);
    if (status === 401) {
      clearCredential();
      throw new CloudError('云端登录已过期，请重新登录', 401, 'relogin');
    }
    if (status < 200 || status >= 300) {
      throw new CloudError(data?.error || `同步失败（HTTP ${status}）`, status);
    }

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
    if (job.state === 'done') {
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    } else {
      /**
       * 2026-11-19 D-541：失败 / 取消时**保留打包好的 zip + meta**，
       * 下次「立即同步」发现数量一致就能直接复用（省掉几十分钟重新生成 3342 张预览）；
       * 只需要把中间文件（media/ 与 manifest.json）删掉，别白占几百 MB。
       */
      try {
        rmSync(join(tmp, 'media'), { recursive: true, force: true });
        rmSync(join(tmp, 'manifest.json'), { force: true });
      } catch {
        /* ignore */
      }
      if (!existsSync(join(tmp, 'snapshot.zip'))) {
        try {
          rmSync(tmp, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
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
    uploaded: j.uploaded || 0,
    reused: j.reused === true,
    /** 2026-11-20 D-544：打包阶段里「写 zip」单独计数（字节） */
    zipDone: j.zipDone || 0,
    zipTotal: j.zipTotal || 0,
    /** 本次新建 / 写回 DB 的 1600 预览缓存条数（新建才提示「下次更快」） */
    cached: j.cacheCreated || 0,
    quotaBytes: j.quotaBytes ?? null,
    sharesBytes: j.sharesBytes ?? null,
    limitBytes: j.limitBytes ?? null,
    uncompressed: j.uncompressed || 0,
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
      uploaded: j.uploaded || 0,
      reused: j.reused === true,
      zipDone: j.zipDone || 0,
      zipTotal: j.zipTotal || 0,
      cached: j.cacheCreated || 0,
      quotaBytes: j.quotaBytes ?? null,
      sharesBytes: j.sharesBytes ?? null,
      limitBytes: j.limitBytes ?? null,
      uncompressed: j.uncompressed || 0,
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
