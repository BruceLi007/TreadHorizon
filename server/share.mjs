/**
 * 分享功能（F-SHR-01 / 2026-11-14 D-416，v1.2.0）—— 服务端：
 * - 导入分享包（multipart）：十道校验 → data/shares/<userId>/<shareId>/ → DB；
 * - 公开只读接口：GET /api/share/:token、POST .../unlock、GET .../media/:file；
 * - 账号接口：GET /api/shares、DELETE /api/shares/:id、GET /api/shares/usage；
 * - 统计：打开次数 + 独立访客（匿名 cookie HMAC 去重，不存 IP / UA / 原始访客 id）；
 * - 时效：1h / 24h / 7d / 不限时（expires_at = NULL）；到期 / 撤销 → 立刻删媒体目录与访客行，
 *   行只留 7 天做 410 墓碑（purged_at），之后删行；
 * - 安全边界：删除路径只由 DB 行的 user_id + id 拼成，safeResolve + isInside 双重校验，
 *   只删单个 <sid>/ 目录，父目录只做非递归 rmdir（绝不误删别人的分享）。
 *
 * 路由注册见 registerShareRoutes(app)，由 server/index.mjs 在静态资源之前调用。
 */
import {
  copyFileSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { CONFIG, getShareCookieSecret } from './config.mjs';
import { db, now } from './db.mjs';
import { getUserById, quotaBytesOf, readCookie, sameOrigin, userUsage } from './auth.mjs';
import { isInside, safeResolve } from './paths.mjs';
import {
  MAX_SHARE_ENTRIES,
  MAX_SHARE_UNCOMPRESSED_BYTES,
  MAX_SHARE_ZIP_BYTES,
  SHARE_LIMITS,
  ShareError,
  stageSharePackage,
} from './share-package.mjs';

const SHARE_MAX_ACTIVE = 20;
const MAX_VISITORS = Number(process.env.SHARE_MAX_VISITORS || 50000);
const VISITOR_COOKIE = 'tm_sv';
const VISITOR_COOKIE_MAX_AGE = 365 * 24 * 60 * 60;
const UNLOCK_TTL_MS = 2 * 60 * 60 * 1000;
const UNLOCK_WINDOW_MS = 10 * 60 * 1000;
const UNLOCK_MAX_FAILS = 10;
const TOMBSTONE_MS = 7 * 24 * 60 * 60 * 1000;

const EXPIRY_MS = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  forever: null,
};

const sharesRoot = () => join(CONFIG.dataDir, 'shares');
const tmpRoot = () => join(CONFIG.dataDir, 'tmp');

const hmac = (data) =>
  createHmac('sha256', getShareCookieSecret()).update(String(data)).digest('base64url');

const hmacHex = (data) =>
  createHmac('sha256', getShareCookieSecret()).update(String(data)).digest('hex');

const secureSuffix = () => (CONFIG.cookieSecure ? '; Secure' : '');

/** 只允许服务端生成的 id / uuid 进路径 */
const safeId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(v);

function setPublicShareHeaders(reply) {
  reply.header('X-Robots-Tag', 'noindex, nofollow');
  reply.header('Referrer-Policy', 'no-referrer');
  reply.header('Cache-Control', 'private, no-store');
}

function shareUrl(req, token) {
  const base = CONFIG.publicBaseUrl || `${req.protocol}://${req.headers.host || 'localhost'}`;
  return `${base.replace(/\/+$/, '')}/s/${token}`;
}

function findShareById(id) {
  return db.prepare('SELECT * FROM share WHERE id = ?').get(String(id ?? '')) || null;
}

function findShareByToken(token) {
  if (typeof token !== 'string' || token.length < 10 || token.length > 100) return null;
  return db.prepare('SELECT * FROM share WHERE token = ?').get(token) || null;
}

function shareStatus(row) {
  if (!row) return 'missing';
  // 2026-11-18 D-524：删除 = 进回收站（链接立即失效，媒体保留，可恢复）
  if (row.deleted_at) return 'deleted';
  if (row.revoked_at) return 'revoked';
  if (row.expires_at != null && Number(row.expires_at) <= now()) return 'expired';
  return 'ok';
}

/** 分享目录：只由 DB 行的 user_id + id 拼成；越界 / 非法 id 返回 null */
function shareDirOf(row) {
  if (!row || !safeId(row.user_id) || !safeId(row.id)) return null;
  try {
    const userDir = safeResolve(sharesRoot(), row.user_id);
    const dir = safeResolve(sharesRoot(), `${row.user_id}/${row.id}`);
    if (!isInside(userDir, dir)) return null;
    return dir;
  } catch {
    return null;
  }
}

/**
 * 删除一份分享的媒体目录 + 访客行，并清空 bytes / 密码（保留行做 7 天墓碑）。
 * 只删 <uid>/<sid>/ 这一个目录；父目录只用非递归 rmdir（非空则忽略）。
 */
function purgeShareMedia(row) {
  const dir = shareDirOf(row);
  if (dir) {
    try {
      const st = lstatSync(dir);
      if (st.isSymbolicLink()) {
        console.warn('[share] 目录是符号链接，拒绝删除：', dir);
      } else if (st.isDirectory()) {
        rmSync(dir, { recursive: true, force: true });
      }
    } catch (e) {
      if (e?.code !== 'ENOENT') console.warn('[share] 删除分享目录失败：', e?.message || e);
    }
    // 该账号目录空了才删（非递归；还有别的分享会 ENOTEMPTY → 忽略）
    try {
      const userDir = safeResolve(sharesRoot(), row.user_id);
      if (readdirSync(userDir).length === 0) rmdirSync(userDir);
    } catch {
      /* ignore */
    }
  }
  db.prepare('DELETE FROM share_visitor WHERE share_id = ?').run(row.id);
  db.prepare(
    `UPDATE share
        SET bytes = 0,
            item_count = 0,
            media_count = 0,
            password_hash = NULL,
            password_salt = NULL,
            purged_at = COALESCE(purged_at, ?)
      WHERE id = ?`
  ).run(now(), row.id);
}

/**
 * 2026-11-18 D-524：撤销 / 过期**不再自动删媒体**（媒体留给用户手动「删除」进回收站，
 * 回收站里再「彻底删除」才真正释放空间）。这里只做墓碑行清理。
 */
function revokeShareRow(row) {
  if (!row.revoked_at) {
    db.prepare('UPDATE share SET revoked_at = ? WHERE id = ?').run(now(), row.id);
  }
}

/** 彻底删除一份分享：媒体目录 + 访客行 + 数据库行（不可恢复） */
function purgeShareRow(row) {
  purgeShareMedia(row);
  db.prepare('DELETE FROM share_visitor WHERE share_id = ?').run(row.id);
  db.prepare('DELETE FROM share WHERE id = ?').run(row.id);
}

/** 到期 / 撤销清理 + 7 天墓碑删除（启动扫一次、每 5 分钟扫一次、访问兜底也会调用） */
export function pruneShares() {
  const t = now();
  // 2026-11-18 D-524：撤销 / 过期不再自动清媒体（改为手动删除），只清墓碑行
  const old = db
    .prepare('SELECT id FROM share WHERE purged_at IS NOT NULL AND purged_at <= ?')
    .all(t - TOMBSTONE_MS);
  for (const row of old) {
    db.prepare('DELETE FROM share WHERE id = ?').run(row.id);
  }
  return old.length;
}

/** 管理员禁用 / 删除账号时调用：彻底删掉其全部分享（媒体 + 行） */
export function revokeAllSharesForUser(userId) {
  if (!userId) return 0;
  const rows = db.prepare('SELECT * FROM share WHERE user_id = ?').all(userId);
  for (const row of rows) {
    try {
      purgeShareRow(row);
    } catch (e) {
      console.warn('[share] 撤销账号分享失败：', e?.message || e);
    }
  }
  return rows.length;
}

// ───────────── 密码 / 解锁 cookie / 访客 cookie ─────────────

function hashSharePassword(password, salt) {
  return scryptSync(String(password), String(salt), 64).toString('hex');
}

function verifySharePassword(row, password) {
  if (!row.password_hash || !row.password_salt) return true;
  try {
    const a = Buffer.from(hashSharePassword(password, row.password_salt), 'hex');
    const b = Buffer.from(String(row.password_hash), 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

const unlockCookieName = (row) => `tm_share_${String(row.id).slice(0, 8)}`;

function unlockCookieFor(row) {
  const remain = row.expires_at != null ? Math.max(0, Number(row.expires_at) - now()) : UNLOCK_TTL_MS;
  const ttl = Math.min(UNLOCK_TTL_MS, remain);
  const exp = now() + Math.max(60_000, ttl);
  const sig = hmac(`${row.id}:${row.token}:${exp}`);
  return `${unlockCookieName(row)}=${exp}.${sig}; Path=/api/share/${row.token}; HttpOnly; SameSite=Lax; Max-Age=${Math.max(
    60,
    Math.floor(ttl / 1000)
  )}${secureSuffix()}`;
}

function isUnlocked(req, row) {
  if (!row.password_hash) return true;
  const raw = readCookie(req, unlockCookieName(row));
  if (!raw) return false;
  const dot = raw.indexOf('.');
  if (dot <= 0) return false;
  const exp = Number(raw.slice(0, dot));
  const sig = raw.slice(dot + 1);
  if (!Number.isFinite(exp) || exp < now()) return false;
  const expect = hmac(`${row.id}:${row.token}:${exp}`);
  try {
    return (
      sig.length === expect.length &&
      timingSafeEqual(Buffer.from(sig, 'utf8'), Buffer.from(expect, 'utf8'))
    );
  } catch {
    return false;
  }
}

function visitorCookieFor(id) {
  return `${VISITOR_COOKIE}=${id}; Path=/api/share/; HttpOnly; SameSite=Lax; Max-Age=${VISITOR_COOKIE_MAX_AGE}${secureSuffix()}`;
}

function visitorHash(row, visitorId) {
  return hmacHex(`${row.id}:${visitorId}`);
}

/**
 * 记录一次页面打开：
 * - view_count + 1、last_view_at = now（所有成功 GET 都算）；
 * - 独立访客：没有 tm_sv 就下发一个；INSERT OR IGNORE 成功才 visitor_count + 1；
 * - 不存 IP / UA / 原始访客 id；每份分享最多记 MAX_VISITORS 个访客。
 */
function recordView(row, req, reply) {
  const t = now();
  db.prepare('UPDATE share SET view_count = view_count + 1, last_view_at = ? WHERE id = ?').run(t, row.id);
  let visitorId = readCookie(req, VISITOR_COOKIE);
  if (!visitorId || visitorId.length > 200) {
    visitorId = randomBytes(16).toString('base64url');
    reply.header('set-cookie', visitorCookieFor(visitorId));
  }
  const count = Number(row.visitor_count) || 0;
  if (count >= MAX_VISITORS) return;
  const hash = visitorHash(row, visitorId);
  const r = db
    .prepare('INSERT OR IGNORE INTO share_visitor (share_id, visitor_hash, first_seen_at) VALUES (?, ?, ?)')
    .run(row.id, hash, t);
  if (Number(r.changes) > 0) {
    db.prepare('UPDATE share SET visitor_count = visitor_count + 1 WHERE id = ?').run(row.id);
  }
}

/**
 * 2026-11-15 D-424：老分享（导入时还没有头像功能）在第一次被打开时补一次头像：
 * 账号有头像文件 → 复制进副本目录并写回 manifest；失败就保持原样。
 */
function ensureShareAvatar(row, manifest) {
  try {
    if (!row || !manifest) return manifest;
    const dir = shareDirOf(row);
    if (!dir) return manifest;
    let changed = false;
    const sharer = { ...(manifest.sharer || {}) };
    if (!sharer.displayName) {
      const u = getUserById(row.user_id);
      const name = String(u?.display_name || u?.username || '').slice(0, 100);
      if (name) {
        sharer.displayName = name;
        changed = true;
      }
    }
    if (!sharer.avatar) {
      const src = join(CONFIG.dataDir, 'avatars', `${row.user_id}.webp`);
      if (existsSync(src)) {
        copyFileSync(src, join(dir, 'avatar.webp'));
        sharer.avatar = 'avatar.webp';
        changed = true;
      }
    }
    if (changed) {
      manifest.sharer = sharer;
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
    }
  } catch (e) {
    console.warn('[share] 补齐分享头像 / 昵称失败（忽略）：', e?.message || e);
  }
  return manifest;
}

/** 读 manifest；损坏 / 缺失返回 null（调用方按「分享已失效」处理） */
function readShareManifest(row) {
  const dir = shareDirOf(row);
  if (!dir) return null;
  try {
    const raw = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

/** 公开响应：剔除 secret（分享页不出现「秘密基地」任何痕迹） */
function publicManifest(manifest) {
  const places = Array.isArray(manifest.places) ? manifest.places : [];
  for (const p of places) {
    if (p && typeof p === 'object') delete p.secret;
  }
  return manifest;
}

// ───────────── 导入限速 / 串行（同账号并发导入不超额） ─────────────

const importChains = new Map();
function runSerialized(key, task) {
  const prev = importChains.get(key) || Promise.resolve();
  const run = prev.then(task, task);
  const tail = run.then(
    () => undefined,
    () => undefined
  );
  importChains.set(key, tail);
  tail.then(() => {
    if (importChains.get(key) === tail) importChains.delete(key);
  });
  return run;
}

// 解锁失败限速：同 IP 10 分钟最多 10 次（内存；重启清零）
const unlockHits = new Map();
function unlockIp(req) {
  return String(req.ip || req.headers['x-forwarded-for'] || 'unknown');
}
function unlockBlocked(ip) {
  const rec = unlockHits.get(ip);
  if (!rec) return false;
  if (now() - rec.first > UNLOCK_WINDOW_MS) {
    unlockHits.delete(ip);
    return false;
  }
  return rec.count >= UNLOCK_MAX_FAILS;
}
function unlockFailed(ip) {
  const rec = unlockHits.get(ip);
  if (!rec || now() - rec.first > UNLOCK_WINDOW_MS) unlockHits.set(ip, { count: 1, first: now() });
  else rec.count += 1;
}

// ───────────── 回收站（2026-11-18 D-527：分享删除并入既有「回收站」页） ─────────────

/**
 * 回收站里的分享（只列 deleted_at 非空的行）。
 * 用户在「设置 → 回收站」里看到、恢复 / 彻底删除；「我的分享」不再单开一份回收站。
 */
export function listTrashShares(ownerId) {
  if (!ownerId) return [];
  const rows = db
    .prepare(
      `SELECT * FROM share WHERE user_id = ? AND deleted_at IS NOT NULL
        ORDER BY deleted_at DESC LIMIT 200`
    )
    .all(ownerId);
  return rows.map((row) => ({
    kind: 'share',
    id: row.id,
    title: row.title || '',
    token: row.token,
    bytes: Number(row.bytes) || 0,
    mediaCount: Number(row.media_count) || 0,
    itemCount: Number(row.item_count) || 0,
    hasPassword: Boolean(row.password_hash),
    createdAt: row.created_at,
    deletedAt: row.deleted_at ?? null,
    expiresAt: row.expires_at ?? null,
    // 删除时一并写 revoked_at；恢复后是「已撤销」，要重新上线再调 /online
    revokedAt: row.revoked_at ?? null,
  }));
}

/** 回收站里分享的条数（顶部角标 / 清空提示用） */
export function countTrashShares(ownerId) {
  if (!ownerId) return 0;
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM share WHERE user_id = ? AND deleted_at IS NOT NULL')
    .get(ownerId);
  return Number(row?.n) || 0;
}

const MB = 1024 ** 2;
const fmtBytes = (n) =>
  n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${(n / MB).toFixed(1)} MB`;

/**
 * 2026-11-19 D-543：**分享也按账号配额动态限额，照片张数不设限**。
 * 分享是新增占用：可用 = 配额 − 快照媒体 − 已有分享（与快照的「整批替换」口径不同）。
 */
export function shareQuota(ownerId) {
  const quota = quotaBytesOf(getUserById(ownerId));
  const usage = userUsage(ownerId);
  const used = usage.mediaBytes + usage.sharesBytes;
  return {
    quota,
    mediaBytes: usage.mediaBytes,
    sharesBytes: usage.sharesBytes,
    used,
    available: Math.max(0, quota - used),
  };
}

function shareQuotaError(q, needBytes = 0) {
  const need = needBytes > 0 ? `本次分享约需 ${fmtBytes(needBytes)}，` : '';
  return new ShareError(
    `账号空间不足：${need}上限 ${fmtBytes(q.quota)}，已用 ${fmtBytes(q.used)}，剩余 ${fmtBytes(q.available)}。` +
      '可以在云端「设置 → 账号」申请扩容，或减少要分享的照片。',
    413,
    'quota'
  );
}

// ───────────── 路由 ─────────────

/** @param {import('fastify').FastifyInstance} app */
export async function registerShareRoutes(app) {
  // 账号：导入分享包
  app.post('/api/shares/import', async (req, reply) => {
    const owner = req.authUser?.id;
    if (!owner) {
      return reply.code(400).send({ error: '本地版没有账号；分享包请在云端账号里上传' });
    }

    /**
     * 2026-11-19 D-543：包大小上限跟账号配额走（照片张数不设限）。
     * 可用 = 配额 − 快照媒体 − 已有分享；先算出来，收包时就按它卡，不用传完再拒。
     */
    const quota = shareQuota(owner);
    if (quota.available <= 0) {
      return reply.code(413).send({ error: shareQuotaError(quota).message });
    }
    const MAX_ZIP = quota.available + Math.max(32 * MB, Math.ceil(quota.available * 0.02));

    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_ZIP) {
      return reply.code(413).send({ error: shareQuotaError(quota).message });
    }
    if (Number.isFinite(declared) && declared > 0) {
      try {
        const st = statfsSync(resolve(CONFIG.dataDir));
        const available = Number(st.bavail) * Number(st.bsize);
        if (Number.isFinite(available) && available < declared * 2.5 + 200 * 1024 * 1024) {
          return reply.code(413).send({
            error: `磁盘空间不足：需要约 ${(declared / 1024 ** 2).toFixed(1)} MB（另需预留 200 MB）`,
          });
        }
      } catch {
        /* statfs 不可用就交给写入失败兜底 */
      }
    }

    mkdirSync(tmpRoot(), { recursive: true });
    const zipPath = join(tmpRoot(), `share-upload-${randomUUID()}.zip`);
    const stageDir = join(tmpRoot(), `share-stage-${randomUUID()}`);
    const fields = {};
    let fileBytes = 0;
    let extraFile = false;
    try {
      for await (const part of req.parts({
        limits: { fileSize: MAX_ZIP, files: 1, fields: 20 },
      })) {
        if (part.type === 'file') {
          if (part.fieldname !== 'file' || fileBytes > 0) {
            extraFile = true;
            part.file.resume();
            continue;
          }
          await pipeline(part.file, createWriteStream(zipPath));
          if (part.file.truncated) throw shareQuotaError(quota);
          fileBytes = Number(part.file.bytesRead) || 0;
        } else {
          const key = String(part.fieldname || '');
          if (['expiresIn', 'expiresHours', 'password', 'title'].includes(key)) fields[key] = String(part.value ?? '');
        }
      }
    } catch (e) {
      try {
        rmSync(zipPath, { force: true });
      } catch {
        /* ignore */
      }
      const status = e instanceof ShareError ? e.status : e?.code === 'FST_REQ_FILE_TOO_LARGE' ? 413 : 400;
      return reply.code(status).send({ error: e?.message || '读取上传文件失败' });
    }

    try {
      if (extraFile) throw new ShareError('只能上传一个分享包（multipart 字段名 file）');
      if (!fileBytes) throw new ShareError('缺少分享包（multipart 字段名 file）');
      if (fileBytes > MAX_ZIP) throw shareQuotaError(quota);

      const expiresIn = String(fields.expiresIn || '24h').trim().toLowerCase();
      // 2026-11-15 D-424：支持「自定义」时效（1–8760 小时）
      let customHours = 0;
      if (expiresIn === 'custom') {
        customHours = Number(fields.expiresHours);
        if (!Number.isFinite(customHours) || customHours < 1 || customHours > 8760) {
          throw new ShareError('自定义时效需要在 1–8760 小时之间');
        }
      } else if (!(expiresIn in EXPIRY_MS)) {
        throw new ShareError('时效只能是 1h / 24h / 7d / forever，或自定义小时数');
      }
      const password = String(fields.password ?? '');
      if (password.length > 128) throw new ShareError('分享密码不能超过 128 位');

      /**
       * 2026-11-19 D-543：照片不设限、体积按账号可用空间卡（解压阶段就中断，不落盘白占）。
       */
      let pkg;
      try {
        pkg = await stageSharePackage(zipPath, stageDir, {
          ...SHARE_LIMITS,
          maxUncompressed: quota.available,
        });
      } catch (e) {
        if (e instanceof ShareError && e.code === 'too-large') throw shareQuotaError(quota);
        throw e;
      }
      // 2026-11-15 D-427（用户拍板「秘密基地还是不参与分享吧，默认不允许分享」）：
      // 含秘密基地的包一律拒收 —— 不再要求「设密码就能传」。
      // 这是给老版本客户端 / 手改包的兜底（本地导出侧已经先拦一道）。
      if (pkg.hasSecret) {
        throw new ShareError('分享包里包含秘密基地，秘密基地不参与分享，请重新导出（不含秘密基地）后再上传');
      }

      return await runSerialized(owner, async () => {
        pruneShares();
        const usage = userUsage(owner);
        if (usage.shareCount >= SHARE_MAX_ACTIVE) {
          throw new ShareError(`每个账号最多同时保留 ${SHARE_MAX_ACTIVE} 份分享，请先撤销旧的`);
        }
        // 并发上传兜底：按「此刻」的用量再核一次配额
        const fresh = shareQuota(owner);
        if (fresh.used + pkg.bytes > fresh.quota) {
          throw shareQuotaError(fresh, pkg.bytes);
        }
        const user = getUserById(owner);

        const shareId = randomUUID();
        const token = randomBytes(16).toString('base64url');
        const createdAt = now();
        const expiresAt =
          expiresIn === 'custom'
            ? createdAt + Math.round(customHours * 3600_000)
            : EXPIRY_MS[expiresIn] == null
              ? null
              : createdAt + EXPIRY_MS[expiresIn];
        // 2026-11-15 D-424（用户要求）：上传弹窗的标题默认填分享包里导出时写的标题，可改。
        // 前端总是带 title 字段（可能为空）——带了就以它为准；老客户端不带才回退 manifest.title。
        const hasUploadTitle = Object.prototype.hasOwnProperty.call(fields, 'title');
        let title = hasUploadTitle
          ? String(fields.title || '').trim()
          : String(pkg.manifest.title || '').trim();
        if (/^\d{4}-\d{2}-\d{2}\s*~\s*\d{4}-\d{2}-\d{2}$/.test(title)) title = '';
        title = title.slice(0, 200);
        const salt = password ? randomBytes(16).toString('hex') : null;
        const hash = password ? hashSharePassword(password, salt) : null;
        // 2026-11-18 D-524：封面 = 本地选的那张（manifest.coverId），没选就取第一张
        const coverEntry = pkg.manifest.coverId
          ? pkg.manifest.media.find((m) => m.id === pkg.manifest.coverId)
          : null;
        const coverFile = coverEntry?.file || pkg.manifest.media[0]?.file || null;

        const userDir = join(sharesRoot(), owner);
        mkdirSync(userDir, { recursive: true });
        const dest = join(userDir, shareId);
        renameSync(stageDir, dest);

        // 2026-11-15 D-424：把账号头像带进分享副本（分享页顶栏显示分享者头像）；没头像就跳过。
        // 头像不参与分享包校验（包是本地导出的，本机没有账号头像），由云端导入时补。
        // 顺带：本地导出的 displayName 可能为空 → 用云端账号的昵称 / 用户名补上。
        try {
          const mfPath = join(dest, 'manifest.json');
          const mf = JSON.parse(readFileSync(mfPath, 'utf8'));
          const name = String(
            mf.sharer?.displayName || user?.display_name || user?.username || ''
          ).slice(0, 100);
          mf.sharer = { ...(mf.sharer || {}), displayName: name };
          const avatarSrc = join(CONFIG.dataDir, 'avatars', `${owner}.webp`);
          if (existsSync(avatarSrc)) {
            copyFileSync(avatarSrc, join(dest, 'avatar.webp'));
            mf.sharer.avatar = 'avatar.webp';
          }
          writeFileSync(mfPath, JSON.stringify(mf));
        } catch (e) {
          console.warn('[share] 头像 / 昵称写入分享副本失败（忽略）：', e?.message || e);
        }

        db.prepare(
          `INSERT INTO share (
             id, user_id, token, title, created_at, expires_at, password_hash, password_salt,
             has_secret, bytes, item_count, media_count, app_version, cover
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          shareId,
          owner,
          token,
          title,
          createdAt,
          expiresAt,
          hash,
          salt,
          pkg.hasSecret ? 1 : 0,
          pkg.bytes,
          pkg.placeCount + pkg.visitCount + pkg.mediaCount,
          pkg.mediaCount,
          String(pkg.manifest.appVersion || '').slice(0, 30),
          coverFile
        );

        return {
          id: shareId,
          token,
          url: shareUrl(req, token),
          expiresAt,
          counts: pkg.manifest.counts,
        };
      });
    } catch (e) {
      try {
        rmSync(stageDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      const status = e instanceof ShareError ? e.status : 500;
      if (status >= 500) console.error('[share] 导入失败：', e);
      return reply.code(status).send({ error: e?.message || '导入分享失败' });
    } finally {
      try {
        unlinkSync(zipPath);
      } catch {
        /* ignore */
      }
    }
  });

  // 账号：我的分享列表（默认不含回收站里的；?trash=1 只列回收站）
  app.get('/api/shares', async (req, reply) => {
    const owner = req.authUser?.id;
    if (!owner) return { items: [] };
    const trash = String(req.query?.trash || '') === '1';
    const rows = db
      .prepare(
        `SELECT * FROM share WHERE user_id = ? AND deleted_at IS ${trash ? 'NOT NULL' : 'NULL'}
          ORDER BY created_at DESC LIMIT 200`
      )
      .all(owner);
    return {
      items: rows.map((row) => ({
        id: row.id,
        token: row.token,
        title: row.title || '',
        url: shareUrl(req, row.token),
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at ?? null,
        deletedAt: row.deleted_at ?? null,
        status: shareStatus(row),
        hasSecret: Number(row.has_secret) === 1,
        hasPassword: Boolean(row.password_hash),
        // 2026-11-18 D-524：封面（分享包里选的那张）；前端走 /api/shares/:id/cover 取图
        hasCover: Boolean(row.cover),
        bytes: Number(row.bytes) || 0,
        itemCount: Number(row.item_count) || 0,
        mediaCount: Number(row.media_count) || 0,
        viewCount: Number(row.view_count) || 0,
        visitorCount: Number(row.visitor_count) || 0,
        lastViewAt: row.last_view_at ?? null,
      })),
    };
  });

  /** 账号自己看某份分享的封面（密码分享也能看，因为鉴权走登录态而不是分享密码） */
  app.get('/api/shares/:id/cover', async (req, reply) => {
    const owner = req.authUser?.id;
    if (!owner) return reply.code(401).send({ error: '请先登录' });
    const row = findShareById(req.params.id);
    if (!row || row.user_id !== owner || !row.cover) {
      return reply.code(404).send({ error: '没有封面' });
    }
    const dir = shareDirOf(row);
    if (!dir) return reply.code(404).send({ error: '没有封面' });
    // 封面文件在分享目录的 media/ 下（manifest 里只存文件名）
    const abs = safeResolve(join(dir, 'media'), String(row.cover));
    if (!abs || !existsSync(abs)) return reply.code(404).send({ error: '没有封面' });
    reply.header('cache-control', 'private, max-age=3600');
    // 2026-11-18 D-530：补 content-type（测试发现流式返回没带，浏览器靠嗅探才显示）
    reply.header('content-type', 'image/webp');
    return reply.send(createReadStream(abs));
  });

  /** 账号：设置 / 修改 / 清空分享访问密码（2026-11-18 D-524：密码从本地移到云端管理） */
  app.post('/api/shares/:id/password', async (req, reply) => {
    const owner = req.authUser?.id;
    if (!owner) return reply.code(401).send({ error: '请先登录' });
    const row = findShareById(req.params.id);
    if (!row || row.user_id !== owner) return reply.code(404).send({ error: '分享不存在' });
    const password = String(req.body?.password ?? '');
    if (password.length > 128) return reply.code(400).send({ error: '分享密码不能超过 128 位' });
    if (shareStatus(row) === 'deleted') {
      return reply.code(400).send({ error: '回收站里的分享不能设密码' });
    }
    if (!password) {
      db.prepare('UPDATE share SET password_hash = NULL, password_salt = NULL WHERE id = ?').run(row.id);
      return { ok: true, hasPassword: false };
    }
    const salt = randomBytes(16).toString('hex');
    db.prepare('UPDATE share SET password_hash = ?, password_salt = ? WHERE id = ?').run(
      hashSharePassword(password, salt),
      salt,
      row.id
    );
    return { ok: true, hasPassword: true };
  });

  /** 账号：撤销（只下线，媒体保留，可重新上线） */
  app.post('/api/shares/:id/revoke', async (req, reply) => {
    const owner = req.authUser?.id;
    if (!owner) return reply.code(401).send({ error: '请先登录' });
    const row = findShareById(req.params.id);
    if (!row || row.user_id !== owner) return reply.code(404).send({ error: '分享不存在' });
    if (row.deleted_at) return reply.code(400).send({ error: '回收站里的分享请先恢复' });
    revokeShareRow(row);
    return { ok: true, id: row.id, status: 'revoked' };
  });

  /** 账号：重新上线（撤销 / 过期未删的都可以；过期时间不动） */
  app.post('/api/shares/:id/online', async (req, reply) => {
    const owner = req.authUser?.id;
    if (!owner) return reply.code(401).send({ error: '请先登录' });
    const row = findShareById(req.params.id);
    if (!row || row.user_id !== owner) return reply.code(404).send({ error: '分享不存在' });
    if (row.deleted_at) return reply.code(400).send({ error: '回收站里的分享请先恢复' });
    if (row.expires_at != null && Number(row.expires_at) <= now()) {
      return reply.code(400).send({ error: '这份分享已经过期，不能重新上线' });
    }
    db.prepare('UPDATE share SET revoked_at = NULL WHERE id = ?').run(row.id);
    return { ok: true, id: row.id, status: 'ok' };
  });

  /** 账号：删除 = 移进分享回收站（链接立即失效，媒体保留，可恢复） */
  app.delete('/api/shares/:id', async (req, reply) => {
    const owner = req.authUser?.id;
    if (!owner) return reply.code(401).send({ error: '请先登录' });
    const row = findShareById(req.params.id);
    if (!row || row.user_id !== owner) return reply.code(404).send({ error: '分享不存在' });
    db.prepare('UPDATE share SET deleted_at = ?, revoked_at = COALESCE(revoked_at, ?) WHERE id = ?').run(
      now(),
      now(),
      row.id
    );
    return { ok: true, id: row.id, trashed: true };
  });

  /** 账号：从回收站恢复（恢复成「已撤销」，要上线再调 /online） */
  app.post('/api/shares/:id/restore', async (req, reply) => {
    const owner = req.authUser?.id;
    if (!owner) return reply.code(401).send({ error: '请先登录' });
    const row = findShareById(req.params.id);
    if (!row || row.user_id !== owner) return reply.code(404).send({ error: '分享不存在' });
    if (!row.deleted_at) return { ok: true, id: row.id, status: shareStatus(row) };
    db.prepare('UPDATE share SET deleted_at = NULL, revoked_at = COALESCE(revoked_at, ?) WHERE id = ?').run(
      now(),
      row.id
    );
    return { ok: true, id: row.id, status: 'revoked' };
  });

  /** 账号：彻底删除（回收站里清空 / 单条删除；不可恢复） */
  app.delete('/api/shares/:id/purge', async (req, reply) => {
    const owner = req.authUser?.id;
    if (!owner) return reply.code(401).send({ error: '请先登录' });
    const row = findShareById(req.params.id);
    if (!row || row.user_id !== owner) return reply.code(404).send({ error: '分享不存在' });
    purgeShareRow(row);
    return { ok: true, id: row.id, purged: true };
  });

  // 账号：用量（分享占用 + 统计汇总）
  app.get('/api/shares/usage', async (req, reply) => {
    const owner = req.authUser?.id;
    if (!owner) {
      return { sharesBytes: 0, shareCount: 0, quotaBytes: 0, mediaBytes: 0, views: 0, visitors: 0 };
    }
    const usage = userUsage(owner);
    return {
      sharesBytes: usage.sharesBytes,
      shareCount: usage.shareCount,
      quotaBytes: quotaBytesOf(getUserById(owner)),
      mediaBytes: usage.mediaBytes,
      views: usage.views,
      visitors: usage.visitors,
    };
  });

  // 公开：manifest
  app.get('/api/share/:token', async (req, reply) => {
    setPublicShareHeaders(reply);
    const row = findShareByToken(req.params.token);
    const status = shareStatus(row);
    if (status === 'missing') return reply.code(404).send({ error: 'not_found' });
    if (status === 'deleted' || status === 'revoked') {
      return reply.code(410).send({ error: 'revoked' });
    }
    if (status === 'expired') return reply.code(410).send({ error: 'expired' });
    if (!isUnlocked(req, row)) {
      return reply.code(401).send({
        error: 'password_required',
        hasPassword: true,
        title: row.title || '',
        expiresAt: row.expires_at,
      });
    }
    const manifest = readShareManifest(row);
    if (!manifest) return reply.code(404).send({ error: 'not_found' });
    ensureShareAvatar(row, manifest);
    if (req.method === 'GET') recordView(row, req, reply);
    return {
      manifest: publicManifest(manifest),
      title: row.title || '',
      expiresAt: row.expires_at,
      hasPassword: Boolean(row.password_hash),
      // 2026-11-14 D-421：分享页不再下发任何地图 Key；访客自己填、只存本机浏览器
    };
  });

  // 公开：解锁密码
  app.post('/api/share/:token/unlock', async (req, reply) => {
    setPublicShareHeaders(reply);
    if (!sameOrigin(req)) return reply.code(403).send({ error: '请求来源不合法' });
    const row = findShareByToken(req.params.token);
    const status = shareStatus(row);
    if (status === 'missing') return reply.code(404).send({ error: 'not_found' });
    if (status === 'deleted' || status === 'revoked') {
      return reply.code(410).send({ error: 'revoked' });
    }
    if (status === 'expired') return reply.code(410).send({ error: 'expired' });
    if (!row.password_hash) return { ok: true, hasPassword: false, expiresAt: row.expires_at };

    const ip = unlockIp(req);
    // 限速按「IP + token」计：不同分享之间互不牵连（同一个分享被爆破时仍然拦得住）
    const hitKey = `${ip}|${row.token}`;
    if (unlockBlocked(hitKey)) {
      return reply.code(429).send({ error: '尝试次数过多，请稍后再试' });
    }
    const password = String(req.body?.password ?? '');
    if (!verifySharePassword(row, password)) {
      unlockFailed(hitKey);
      return reply.code(401).send({ error: '密码不正确' });
    }
    unlockHits.delete(hitKey);
    reply.header('set-cookie', unlockCookieFor(row));
    return { ok: true, hasPassword: true, expiresAt: row.expires_at };
  });

  // 公开：分享者头像（导入时从账号头像复制到副本目录；没有就 404，前端回退成默认图标）
  app.get('/api/share/:token/avatar', async (req, reply) => {
    setPublicShareHeaders(reply);
    const row = findShareByToken(req.params.token);
    const status = shareStatus(row);
    if (status === 'missing') return reply.code(404).send({ error: 'not_found' });
    if (status === 'deleted' || status === 'revoked') {
      return reply.code(410).send({ error: 'revoked' });
    }
    if (status === 'expired') return reply.code(410).send({ error: 'expired' });
    if (!isUnlocked(req, row)) return reply.code(401).send({ error: 'password_required' });
    const dir = shareDirOf(row);
    if (!dir) return reply.code(404).send({ error: 'not_found' });
    const abs = join(dir, 'avatar.webp');
    try {
      if (!statSync(abs).isFile()) return reply.code(404).send({ error: 'not_found' });
    } catch {
      return reply.code(404).send({ error: 'not_found' });
    }
    reply.header('Content-Type', 'image/webp');
    reply.header('Content-Length', String(statSync(abs).size));
    // 2026-11-15 D-448（用户要求）：分享图片允许访客本地缓存 24 小时（文件名是内容哈希，内容不会变）；
    // 页面 / JSON 仍是 no-store，撤销 / 过期 / 统计校验照常实时生效。
    reply.header('Cache-Control', 'private, max-age=86400, immutable');
    return reply.send(createReadStream(abs));
  });

  // 公开：图片代理（只从副本目录发文件，不碰原库）
  app.get('/api/share/:token/media/:file', async (req, reply) => {
    setPublicShareHeaders(reply);
    const row = findShareByToken(req.params.token);
    const status = shareStatus(row);
    if (status === 'missing') return reply.code(404).send({ error: 'not_found' });
    if (status === 'deleted' || status === 'revoked') {
      return reply.code(410).send({ error: 'revoked' });
    }
    if (status === 'expired') return reply.code(410).send({ error: 'expired' });
    if (!isUnlocked(req, row)) return reply.code(401).send({ error: 'password_required' });

    const file = String(req.params.file || '');
    if (!/^p_[a-z0-9_]{3,40}\.webp$/.test(file)) {
      return reply.code(404).send({ error: 'not_found' });
    }
    const dir = shareDirOf(row);
    if (!dir) return reply.code(404).send({ error: 'not_found' });
    const mediaDir = join(dir, 'media');
    let abs;
    try {
      abs = safeResolve(mediaDir, file);
    } catch {
      return reply.code(404).send({ error: 'not_found' });
    }
    if (!isInside(mediaDir, abs)) return reply.code(404).send({ error: 'not_found' });
    try {
      if (!statSync(abs).isFile()) return reply.code(404).send({ error: 'not_found' });
    } catch {
      return reply.code(404).send({ error: 'not_found' });
    }
    reply.header('Content-Type', 'image/webp');
    reply.header('Content-Length', String(statSync(abs).size));
    // 2026-11-15 D-448：与分享图片一致，访客本地缓存 24 小时（头像文件按分享副本固定）
    reply.header('Cache-Control', 'private, max-age=86400, immutable');
    return reply.send(createReadStream(abs));
  });
}

// 供 index.mjs 启动时 / 定时器调用
export { MAX_SHARE_ENTRIES, MAX_SHARE_UNCOMPRESSED_BYTES };
