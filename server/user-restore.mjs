/**
 * M6 P2-3+（2026-11-07，D-210）：普通用户「从我的备份恢复」（按账号范围的恢复）
 *
 * 背景：此前「导出我的数据」只是给人看 / 留档的 zip，普通用户不能恢复（恢复只有管理员整库恢复）。
 * 用户验收时明确要求「普通用户这些功能也应该要」，所以把个人导出 zip 升级为**可恢复到自己的账号**：
 * - 只恢复当前登录账号的数据（place / visit / media 全部替换成包里的行），绝不碰别的账号；
 * - 包里的 user_id 一律改成当前账号 id；媒体 rel_path 重新加上当前账号前缀；
 * - 恢复前自动把当前账号导出成一个 metadata + 缩略图 的 zip（`data/backups/pre-user-restore-*`，保留最近 5 份），
 *   这个自动备份本身也是可恢复的个人导出包；
 * - 数据库用事务替换（失败回滚，当前数据不动）；素材先流式解压到暂存目录并校验（大小 / zip CRC / hash），
 *   校验通过后、DB 提交成功才写入素材库（同路径覆盖，不删除其它文件）；
 * - 秘密基地密码 / 天地图 Key 不随个人导出（安全设计），恢复只还原「是否曾经配置」的信息展示，不改当前设置。
 *
 * 安全：
 * - 只允许恢复 **同一个用户名** 的导出包（账号被删后重建、id 变了的场景也允许；用户名不同一律拒绝）；
 * - 所有条目名 / 相对路径 / 缩略图名重新校验（路径穿越、盘符、`..`、反斜杠、NUL、空段）；
 * - 行数上限、data.json 解压上限、zip 总解压上限（scanZip / MAX_*）；
 * - 与管理员完整恢复互斥（backup.mjs 的 isRestoring 为真时拒绝），同一时间只允许一个用户恢复。
 */
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { CONFIG } from './config.mjs';
import { db } from './db.mjs';
import { mediaBaseFor } from './media-root.mjs';
import { buildUserExportZip, USER_EXPORT_FORMAT, USER_EXPORT_VERSION } from './user-export.mjs';
import { isRestoring } from './backup.mjs';
import {
  extractThumbs,
  formatBytes,
  isSafeThumbName,
  readEntryBuffer,
  scanZip,
  stageMediaEntries,
  ZipError,
} from './zip.mjs';

/** 可预期错误（消息可直接给用户看；status 默认 400） */
export class UserRestoreError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'UserRestoreError';
    this.status = status;
  }
}

/** data.json 解压后上限（个人库几万条记录也够；防止「声明巨大」的恶意包） */
const MAX_DATA_BYTES = 128 * 1024 * 1024;
/** manifest.json 解压后上限 */
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
/** 单表行数上限 */
const MAX_ROWS = 100_000;
/** 恢复令牌有效期（默认 10 分钟，与管理员恢复一致） */
const TOKEN_TTL_MS = (() => {
  const n = Number(process.env.USER_RESTORE_TOKEN_TTL_MS || 10 * 60 * 1000);
  return Number.isFinite(n) && n > 0 ? n : 10 * 60 * 1000;
})();
/** 恢复前自动备份保留份数 */
const KEEP_AUTO = 5;

const THUMB_PREFIX = 'thumbs/';
const MEDIA_PREFIX = 'media/';

// ───────────── 小工具 ─────────────

function strOrNull(v, maxLen) {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function intOrNull(v) {
  const n = numOrNull(v);
  return n === null ? null : Math.trunc(n);
}

function boolInt(v) {
  return v === true || v === 1 || v === '1' ? 1 : 0;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function stampLocal(d = new Date()) {
  return (
    `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-` +
    `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
  );
}

/** 账号名 → 文件名安全片段 */
function safeNamePart(s) {
  return String(s ?? '').replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'user';
}

/** 素材相对路径（`省/市/…/文件名`）：返回段数组；不合法返回 null */
function safeRelSegments(value) {
  if (typeof value !== 'string') return null;
  const rel = value.trim();
  if (!rel || rel.length > 2048) return null;
  if (rel.includes('\\') || rel.includes('\0')) return null;
  const segs = rel.split('/');
  for (const seg of segs) {
    if (!seg || seg === '.' || seg === '..') return null;
    if (seg.length > 255) return null;
    if (/^[A-Za-z]:/.test(seg)) return null;
  }
  return segs;
}

function isSafeId(v) {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (!s || s.length > 128) return false;
  return !/[\\/\0]/.test(s);
}

// ───────────── 解析 / 校验 ─────────────

/**
 * 解析个人导出 zip（只解析 + 校验，不写任何东西）。
 * @param {string} zipPath
 * @param {{id:string, username:string}} user 当前登录账号
 * @returns {Promise<{summary:object, data:object}>} data 里是「已清洗 + 已改成当前账号」的行
 */
export async function inspectUserBackupZip(zipPath, user) {
  if (!user?.id || !user?.username) throw new UserRestoreError('请先登录后再恢复备份', 401);
  if (!existsSync(zipPath)) throw new UserRestoreError('备份包不存在或已被清理，请重新上传', 400);

  // 1) zip 层校验（路径穿越 / 条目数 / 解压总大小 / 重复条目）
  let scan;
  try {
    scan = await scanZip(zipPath);
  } catch (e) {
    throw new UserRestoreError(e instanceof ZipError ? e.message : '备份包解析失败：' + (e?.message || e));
  }
  const names = new Set(scan.names);
  if (!names.has('manifest.json')) throw new UserRestoreError('备份包缺少 manifest.json，不是 Tread Horizon 个人数据导出包');
  if (!names.has('data.json')) throw new UserRestoreError('备份包缺少 data.json，不是 Tread Horizon 个人数据导出包');

  // 2) manifest / data.json
  let manifest;
  let data;
  try {
    manifest = JSON.parse(
      (await readEntryBuffer(zipPath, 'manifest.json', { maxBytes: MAX_MANIFEST_BYTES })).toString('utf8')
    );
    data = JSON.parse(
      (await readEntryBuffer(zipPath, 'data.json', { maxBytes: MAX_DATA_BYTES })).toString('utf8')
    );
  } catch (e) {
    if (e instanceof ZipError) throw new UserRestoreError(e.message);
    throw new UserRestoreError('备份包里的 manifest.json / data.json 不是合法 JSON：' + (e?.message || e));
  }
  if (!manifest || typeof manifest !== 'object') throw new UserRestoreError('manifest.json 内容不合法');
  if (!data || typeof data !== 'object') throw new UserRestoreError('data.json 内容不合法');
  if (manifest.format !== USER_EXPORT_FORMAT || data.format !== USER_EXPORT_FORMAT) {
    throw new UserRestoreError('这个 zip 不是 Tread Horizon 个人数据导出包（format 不匹配）');
  }
  if (Number(manifest.version) !== USER_EXPORT_VERSION || Number(data.version) !== USER_EXPORT_VERSION) {
    throw new UserRestoreError(`备份包版本不支持（只支持 v${USER_EXPORT_VERSION}）`);
  }
  const srcUser = data.user && typeof data.user === 'object' ? data.user : manifest.user || {};
  const srcUsername = String(srcUser.username ?? '');
  if (!srcUsername || srcUsername !== String(user.username)) {
    throw new UserRestoreError(
      srcUsername
        ? `这个备份包属于账号「${srcUsername}」，不能恢复到当前账号「${user.username}」`
        : '备份包里没有账号信息，无法确认归属，已拒绝恢复'
    );
  }
  const srcUserId = String(srcUser.id ?? '');
  if (!isSafeId(srcUserId)) throw new UserRestoreError('备份包里的账号 ID 不合法');

  const settings = data.settings && typeof data.settings === 'object' ? data.settings : {};

  // 3) 行校验 + 清洗（user_id 一律改成当前账号；媒体路径重新加前缀）
  const tables = data.tables;
  if (!tables || typeof tables !== 'object') throw new UserRestoreError('data.json 缺少 tables');
  const rawPlace = tables.place;
  const rawVisit = tables.visit;
  const rawMedia = tables.media;
  for (const [label, arr] of [
    ['place', rawPlace],
    ['visit', rawVisit],
    ['media', rawMedia],
  ]) {
    if (!Array.isArray(arr)) throw new UserRestoreError(`data.json 的 tables.${label} 不是数组`);
    if (arr.length > MAX_ROWS) throw new UserRestoreError(`备份包数据量过大（${label} 超过 ${MAX_ROWS} 行）`);
  }

  const warnings = [];
  const unsupportedEntries = scan.names.filter(
    (n) =>
      n !== 'manifest.json' &&
      n !== 'data.json' &&
      n !== 'README.txt' &&
      !n.startsWith(THUMB_PREFIX) &&
      !n.startsWith(MEDIA_PREFIX)
  );
  if (unsupportedEntries.length) {
    warnings.push(`备份包里有 ${unsupportedEntries.length} 个无法识别的文件，已忽略`);
  }

  // 3.1 地点
  const placeIds = new Set();
  const places = [];
  let homeYet = false;
  for (const row of rawPlace) {
    if (!row || typeof row !== 'object') throw new UserRestoreError('备份包里有非法地点记录');
    const id = String(row.id ?? '').trim();
    if (!isSafeId(id)) throw new UserRestoreError('备份包里有非法地点 ID');
    if (placeIds.has(id)) throw new UserRestoreError('备份包里有重复的地点 ID');
    placeIds.add(id);
    const name = strOrNull(row.name, 200);
    if (!name || !name.trim()) throw new UserRestoreError('备份包里有缺少名称的地点');
    const lng = numOrNull(row.lng);
    const lat = numOrNull(row.lat);
    if (lng === null || lat === null || lng < -180 || lng > 180 || lat < -90 || lat > 90) {
      throw new UserRestoreError(`地点「${name}」的坐标不合法`);
    }
    let home = boolInt(row.home);
    if (home) {
      if (homeYet) home = 0;
      else homeYet = true;
    }
    places.push({
      id,
      name,
      lng,
      lat,
      province: strOrNull(row.province, 100),
      city: strOrNull(row.city, 100),
      county: strOrNull(row.county, 100),
      provinceCode: strOrNull(row.province_code, 50),
      cityCode: strOrNull(row.city_code, 50),
      countyCode: strOrNull(row.county_code, 50),
      kind: strOrNull(row.kind, 20) || 'visited',
      coverMediaId: isSafeId(row.cover_media_id) ? String(row.cover_media_id) : null,
      createdAt: intOrNull(row.created_at) ?? Date.now(),
      updatedAt: intOrNull(row.updated_at) ?? intOrNull(row.created_at) ?? Date.now(),
      deletedAt: intOrNull(row.deleted_at),
      secret: boolInt(row.secret),
      home,
    });
  }

  // 3.2 到访
  const visitIds = new Set();
  const visits = [];
  for (const row of rawVisit) {
    if (!row || typeof row !== 'object') throw new UserRestoreError('备份包里有非法到访记录');
    const id = String(row.id ?? '').trim();
    if (!isSafeId(id)) throw new UserRestoreError('备份包里有非法到访 ID');
    if (visitIds.has(id)) throw new UserRestoreError('备份包里有重复的到访 ID');
    visitIds.add(id);
    const placeId = String(row.place_id ?? '').trim();
    if (!placeIds.has(placeId)) throw new UserRestoreError('备份包里有到访指向了不存在的地点');
    const date = strOrNull(row.date, 10);
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new UserRestoreError('备份包里有日期格式不合法（应为 YYYY-MM-DD）的到访');
    }
    visits.push({
      id,
      placeId,
      date,
      title: strOrNull(row.title, 300),
      note: strOrNull(row.note, 20000),
      rating: intOrNull(row.rating),
      companions: strOrNull(row.companions, 4000),
      createdAt: intOrNull(row.created_at) ?? Date.now(),
      updatedAt: intOrNull(row.updated_at) ?? intOrNull(row.created_at) ?? Date.now(),
      deletedAt: intOrNull(row.deleted_at),
    });
  }

  // 3.3 媒体
  const mediaIds = new Set();
  const media = [];
  const mediaEntryNames = new Set(); // 期望在 zip 里的 media/ 条目名
  let missingMedia = 0;
  let droppedThumbRefs = 0;
  for (const row of rawMedia) {
    if (!row || typeof row !== 'object') throw new UserRestoreError('备份包里有非法媒体记录');
    const id = String(row.id ?? '').trim();
    if (!isSafeId(id)) throw new UserRestoreError('备份包里有非法媒体 ID');
    if (mediaIds.has(id)) throw new UserRestoreError('备份包里有重复的媒体 ID');
    mediaIds.add(id);
    const visitId = String(row.visit_id ?? '').trim();
    if (!visitIds.has(visitId)) throw new UserRestoreError('备份包里有媒体指向了不存在的到访');

    // rel_path：导出时带 `<导出账号 id>/` 前缀，恢复时去掉再换成当前账号 id 前缀
    const segs = safeRelSegments(row.rel_path);
    if (!segs || segs.length < 2) throw new UserRestoreError('备份包里有非法的素材相对路径');
    const rest = segs[0] === srcUserId ? segs.slice(1) : segs;
    if (!rest.length) throw new UserRestoreError('备份包里有非法的素材相对路径');
    const entryName = MEDIA_PREFIX + rest.join('/');
    if (mediaEntryNames.has(entryName)) throw new UserRestoreError('备份包里有重复的素材文件');
    mediaEntryNames.add(entryName);

    const kind = String(row.kind ?? '').trim();
    if (kind !== 'photo' && kind !== 'video') throw new UserRestoreError('备份包里有未知的媒体类型');
    const thumb = pickBareName(row.thumb);
    const preview = pickBareName(row.preview);
    const poster = pickBareName(row.poster);
    if (
      (row.thumb !== null && row.thumb !== undefined && String(row.thumb).trim() !== '' && !thumb) ||
      (row.preview !== null && row.preview !== undefined && String(row.preview).trim() !== '' && !preview) ||
      (row.poster !== null && row.poster !== undefined && String(row.poster).trim() !== '' && !poster)
    ) {
      droppedThumbRefs += 1;
    }
    if (!names.has(entryName)) missingMedia += 1;

    media.push({
      id,
      visitId,
      kind,
      restSegs: rest, // 相对当前账号目录的段（不含 ownerId）
      entryName,
      // zip 里是否真的带了这个素材文件（「最小导出」不含素材时全部为 false）
      hasFile: names.has(entryName),
      hash: typeof row.hash === 'string' && /^[0-9a-f]{16}$/i.test(row.hash) ? row.hash.toLowerCase() : null,
      bytes: numOrNull(row.bytes) !== null && Number(row.bytes) >= 0 ? Math.trunc(Number(row.bytes)) : null,
      width: intOrNull(row.width),
      height: intOrNull(row.height),
      duration: numOrNull(row.duration),
      takenAt: intOrNull(row.taken_at),
      thumb,
      preview,
      poster,
      createdAt: intOrNull(row.created_at) ?? Date.now(),
      deletedAt: intOrNull(row.deleted_at),
    });
  }
  if (droppedThumbRefs > 0) warnings.push(`${droppedThumbRefs} 条媒体记录的缩略图文件名不合法，已忽略该缓存引用`);

  // 4) 统计（给前端摘要）
  const counts = {
    places: places.length,
    visits: visits.length,
    media: media.length,
  };
  const trashed = {
    places: places.filter((p) => p.deletedAt !== null).length,
    visits: visits.filter((v) => v.deletedAt !== null).length,
    media: media.filter((m) => m.deletedAt !== null).length,
  };
  const thumbsInZip = scan.names.filter((n) => n.startsWith(THUMB_PREFIX)).length;
  const mediaFilesInZip = scan.names.filter((n) => n.startsWith(MEDIA_PREFIX)).length;
  const includesThumbs = manifest.includes?.thumbs === true;
  const includesMedia = manifest.includes?.media === true;

  return {
    summary: {
      username: srcUsername,
      displayName: String(srcUser.displayName ?? srcUsername),
      exportedAtISO: typeof manifest.createdAtISO === 'string' ? manifest.createdAtISO : null,
      appVersion: typeof manifest.appVersion === 'string' ? manifest.appVersion : null,
      zipBytes: Number(scan.size) || statSync(zipPath).size,
      counts,
      trashed,
      includes: { thumbs: includesThumbs, media: includesMedia },
      filesInZip: { thumbs: thumbsInZip, media: mediaFilesInZip, total: scan.names.length },
      missingMedia,
      homeSet: places.some((p) => p.home === 1),
      secretConfigured: settings.secretConfigured === true,
      tdtKeyConfigured: settings.tdtKeyConfigured === true,
      warnings,
    },
    data: { places, visits, media, srcUserId },
  };
}

/** 裸文件名（thumb / preview / poster）：不合法返回 null（该条忽略缓存引用） */
function pickBareName(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  return isSafeThumbName(s) ? s : null;
}

// ───────────── 恢复令牌（上传的 zip + 摘要，10 分钟有效）─────────────

const tokenStore = new Map();

function pruneTokens(nowTs = Date.now()) {
  for (const [token, rec] of tokenStore) {
    if (rec.expiresAt <= nowTs) {
      tokenStore.delete(token);
      safeUnlink(rec.zipPath);
    }
  }
}

function safeUnlink(p) {
  if (!p) return;
  try {
    unlinkSync(p);
  } catch {
    /* ignore */
  }
}

/** 检查通过后存 token（token → 上传的 zip 路径 + 摘要），返回 {token, expiresAt} */
export function storeUserRestoreToken(zipPath, summary, userId) {
  pruneTokens();
  const token = randomUUID();
  const nowTs = Date.now();
  const expiresAt = nowTs + TOKEN_TTL_MS;
  tokenStore.set(token, { zipPath, summary, userId, createdAt: nowTs, expiresAt });
  return { token, expiresAt };
}

function takeToken(token, userId) {
  pruneTokens();
  const rec = tokenStore.get(String(token || ''));
  if (!rec || rec.userId !== userId) {
    throw new UserRestoreError('恢复令牌无效或已过期，请重新选择备份包', 400);
  }
  return rec;
}

/** 成功后清掉 token 与其上传文件 */
function dropToken(token) {
  const key = String(token || '');
  const rec = tokenStore.get(key);
  if (!rec) return;
  tokenStore.delete(key);
  safeUnlink(rec.zipPath);
}

const tokenTimer = setInterval(() => pruneTokens(), 60_000);
tokenTimer.unref?.();

// ───────────── 数据库写入 ─────────────

const INSERT_PLACE = `INSERT INTO place
  (id, user_id, name, lng, lat, province, city, county, province_code, city_code, county_code,
   kind, cover_media_id, created_at, updated_at, deleted_at, secret, home)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const INSERT_VISIT = `INSERT INTO visit
  (id, user_id, place_id, date, title, note, rating, companions, created_at, updated_at, deleted_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const INSERT_MEDIA = `INSERT INTO media
  (id, user_id, visit_id, kind, rel_path, hash, bytes, width, height, duration, taken_at,
   thumb, preview, poster, created_at, deleted_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/**
 * 如果包里的行 id 已经属于别的账号（理论上只会出现在「把同一个包导给另一个账号」等异常情况），
 * 直接拒绝，避免主键冲突 / 数据串号。
 */
function assertIdsFreeOfOtherUsers(data, ownerId) {
  const checks = [
    { table: 'place', ids: data.places.map((p) => p.id) },
    { table: 'visit', ids: data.visits.map((v) => v.id) },
    { table: 'media', ids: data.media.map((m) => m.id) },
  ];
  for (const { table, ids } of checks) {
    if (!ids.length) continue;
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400);
      const ph = chunk.map(() => '?').join(',');
      const row = db
        .prepare(
          `SELECT COUNT(*) AS n FROM ${table} WHERE id IN (${ph}) AND (user_id IS NULL OR user_id <> ?)`
        )
        .get(...chunk, ownerId);
      if (Number(row?.n) > 0) {
        throw new UserRestoreError(
          '备份包里的数据 ID 与现有其他账号的记录冲突，已拒绝恢复（请联系管理员）'
        );
      }
    }
  }
}

/** 事务替换当前账号的数据（只动 user_id = ownerId 的行） */
function replaceOwnerData(data, ownerId) {
  db.exec('BEGIN IMMEDIATE');
  try {
    // 先删旧数据（media → visit → place；外键 CASCADE 也已覆盖）
    db.prepare('DELETE FROM media WHERE user_id = ?').run(ownerId);
    db.prepare('DELETE FROM visit WHERE user_id = ?').run(ownerId);
    db.prepare('DELETE FROM place WHERE user_id = ?').run(ownerId);

    const insPlace = db.prepare(INSERT_PLACE);
    for (const p of data.places) {
      insPlace.run(
        p.id,
        ownerId,
        p.name,
        p.lng,
        p.lat,
        p.province,
        p.city,
        p.county,
        p.provinceCode,
        p.cityCode,
        p.countyCode,
        p.kind,
        p.coverMediaId,
        p.createdAt,
        p.updatedAt,
        p.deletedAt,
        p.secret,
        p.home
      );
    }
    const insVisit = db.prepare(INSERT_VISIT);
    for (const v of data.visits) {
      insVisit.run(
        v.id,
        ownerId,
        v.placeId,
        v.date,
        v.title,
        v.note,
        v.rating,
        v.companions,
        v.createdAt,
        v.updatedAt,
        v.deletedAt
      );
    }
    const insMedia = db.prepare(INSERT_MEDIA);
    for (const m of data.media) {
      const relPath = ownerId + '/' + m.restSegs.join('/');
      insMedia.run(
        m.id,
        ownerId,
        m.visitId,
        m.kind,
        relPath,
        m.hash,
        m.bytes,
        m.width,
        m.height,
        m.duration,
        m.takenAt,
        m.thumb,
        m.preview,
        m.poster,
        m.createdAt,
        m.deletedAt
      );
    }
    db.exec('COMMIT');
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw e;
  }
}

// ───────────── 恢复前自动备份（metadata + 缩略图，不含素材）─────────────

function backupsDir() {
  return join(CONFIG.dataDir, 'backups');
}

async function autoBackupBeforeRestore(user) {
  const dir = backupsDir();
  mkdirSync(dir, { recursive: true });
  const base = `pre-user-restore-${safeNamePart(user.username)}-${stampLocal()}.zip`;
  let zipPath = join(dir, base);
  if (existsSync(zipPath)) zipPath = join(dir, base.replace(/\.zip$/, `-${randomUUID().slice(0, 6)}.zip`));
  try {
    const built = await buildUserExportZip({
      ownerId: user.id,
      includeThumbs: true,
      includeMedia: false,
      zipPath,
    });
    pruneAutoRestoreBackups(user.username);
    return { name: zipPath.slice(dir.length + 1), bytes: built.size };
  } catch (e) {
    safeUnlink(zipPath);
    throw new UserRestoreError(
      500,
      '恢复前自动备份当前数据失败，已中止恢复（当前数据未变）：' + (e?.message || e)
    );
  }
}

function pruneAutoRestoreBackups(username) {
  try {
    const dir = backupsDir();
    const prefix = `pre-user-restore-${safeNamePart(username)}-`;
    const files = readdirSync(dir)
      .filter((f) => f.startsWith(prefix) && f.endsWith('.zip'))
      .sort()
      .reverse();
    for (const f of files.slice(KEEP_AUTO)) {
      try {
        unlinkSync(join(dir, f));
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

// ───────────── 暂存素材 → 提交写入素材库 ─────────────

async function stageMedia(zipPath, data, ownerId) {
  // 暂存目录放在该账号素材库根目录所在盘（同盘 rename 快；自定义路径时也一致）
  const base = resolve(mediaBaseFor(ownerId));
  const stageDir = resolve(base, `.user-restore-${randomUUID()}`);
  rmSync(stageDir, { recursive: true, force: true });
  const expectations = new Map();
  for (const m of data.media) {
    // 只把 zip 里确实存在的素材文件放进 expectations（「最小导出」不含素材时为空，
    // 恢复只替换数据库记录，磁盘上已有的同名文件保持不动）。
    if (!m.hasFile) continue;
    expectations.set(m.entryName, {
      size: m.bytes === null ? -1 : m.bytes,
      hash: m.hash,
      segments: m.restSegs,
    });
  }
  if (!expectations.size) return { stageDir: null, staged: [] };
  try {
    const staged = await stageMediaEntries(zipPath, stageDir, expectations);
    return { stageDir, staged };
  } catch (e) {
    rmSync(stageDir, { recursive: true, force: true });
    const msg = e instanceof ZipError ? e.message : e?.message || String(e);
    throw new UserRestoreError(500, '解压素材失败，已中止（当前数据与素材库保持原样）：' + msg);
  }
}

/**
 * 把暂存素材移动 / 复制进 mediaRoot/<ownerId>/…（同路径覆盖；不删除其它文件）。
 * 优先 rename（同盘最快、原子）；rename 失败（目标已存在 / 跨卷 / 沙箱限制）时退回流式复制。
 */
async function moveStagedFile(src, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  try {
    if (existsSync(dest)) unlinkSync(dest);
    renameSync(src, dest);
    return;
  } catch {
    /* 退回流式复制 */
  }
  await pipeline(createReadStream(src), createWriteStream(dest));
  try {
    unlinkSync(src);
  } catch {
    /* ignore */
  }
}

async function commitStagedMedia(staged, ownerId) {
  let written = 0;
  let failed = 0;
  const warnings = [];
  // D-212：按账号自己的素材库根目录写回（默认 = 服务器 mediaRoot）
  const root = resolve(mediaBaseFor(ownerId));
  for (const item of staged) {
    const dest = resolve(root, ownerId, ...item.segments);
    if (dest === root || !dest.startsWith(root + sep)) {
      failed += 1;
      warnings.push(`素材路径异常，已跳过：${item.entryName}`);
      continue;
    }
    try {
      await moveStagedFile(item.stagedPath, dest);
      written += 1;
    } catch (e) {
      failed += 1;
      warnings.push(`写入素材失败（${item.entryName}）：${e?.message || e}`);
    }
  }
  return { written, failed, warnings };
}

// ───────────── 对外：执行恢复 ─────────────

let userRestoring = false;
export const isUserRestoring = () => userRestoring;

/**
 * 用个人导出 zip 恢复当前账号的数据（按账号范围替换）。
 *
 * @param {{ token:string, confirm:boolean, user:{id:string, username:string} }} opts
 */
export async function restoreUserBackup({ token, confirm, user } = {}) {
  if (!user?.id || !user?.username) throw new UserRestoreError('请先登录后再恢复备份', 401);
  if (confirm !== true) throw new UserRestoreError('恢复需要确认（confirm: true）');
  if (isRestoring()) throw new UserRestoreError(409, '管理员正在恢复整库备份，请稍后再试');
  if (userRestoring) throw new UserRestoreError(409, '已有恢复任务在进行中，请稍后再试');

  const rec = takeToken(token, user.id);
  userRestoring = true;
  try {
    // 1) 重新完整校验（检查与确认之间文件可能被替换 / 损坏）
    let inspected;
    try {
      inspected = await inspectUserBackupZip(rec.zipPath, user);
    } catch (e) {
      if (e instanceof UserRestoreError) e.message = '备份包校验失败：' + e.message;
      throw e;
    }
    const data = inspected.data;

    // 2) 恢复前自动备份当前账号（metadata + 缩略图；失败就中止）
    const autoBackup = await autoBackupBeforeRestore(user);

    // 3) 素材先解压到暂存目录并逐条校验（DB 事务开始前，失败时当前数据不动）
    const { stageDir, staged } = await stageMedia(rec.zipPath, data, user.id);
    try {
      // 4) 事务替换（包里的 id 属于别的账号时先拒绝）
      assertIdsFreeOfOtherUsers(data, user.id);
      try {
        replaceOwnerData(data, user.id);
      } catch (e) {
        if (e instanceof UserRestoreError) throw e;
        throw new UserRestoreError(
          500,
          '恢复失败，已回滚，当前数据保持原样：' + (e?.message || e)
        );
      }

      // 5) DB 提交成功后才把暂存素材写入素材库
      let mediaReport = { packaged: 0, written: 0, skipped: 0, failed: 0 };
      const warnings = [...inspected.summary.warnings];
      if (staged.length) {
        const moved = await commitStagedMedia(staged, user.id);
        mediaReport = { packaged: staged.length, written: moved.written, skipped: 0, failed: moved.failed };
        warnings.push(...moved.warnings);
      }

      // 6) 缩略图 / 预览缓存（失败只警告，不影响已提交的数据）
      const thumbRoot = join(CONFIG.thumbDir, user.id);
      const thumbResult = await extractThumbs(rec.zipPath, thumbRoot);
      warnings.push(...thumbResult.warnings);

      // 7) 成功：清 token + 上传的 zip
      dropToken(token);

      return {
        ok: true,
        restored: {
          places: data.places.length,
          visits: data.visits.length,
          media: data.media.length,
        },
        autoBackup,
        media: mediaReport,
        thumbFiles: thumbResult.written,
        missingMedia: inspected.summary.missingMedia,
        homeSet: inspected.summary.homeSet,
        warnings,
      };
    } finally {
      if (stageDir) {
        try {
          rmSync(stageDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }
  } finally {
    userRestoring = false;
  }
}
