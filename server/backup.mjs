/**
 * M4 / M4.1 备份、恢复、提醒（F-SYS-03 / F-SYS-04 / F-SYS-05）
 *
 * 设计要点（与 D-51 / D-71 / D-73 一致）：
 * - 备份分三块可选：元数据（恒包含）、缩略图/预览缓存（默认可选）、照片视频素材（可选）。
 *   素材**只打包 DB 引用的文件**（media.rel_path，含回收站软删记录），不扫整个 B、不带孤儿。
 *   **A 原件永不读写**；B 里的孤儿文件既不打包也不删除。
 * - 数据库快照用 `VACUUM INTO`（WAL 里未 checkpoint 的数据也会进快照），绝不直接拷 travel.db。
 * - 导出支持两阶段任务（start → status 轮询进度 → download），zip 放 data/tmp/export-<jobId>/，TTL 10 分钟。
 * - 恢复 = 行级事务替换：BEGIN IMMEDIATE → DELETE media/visit/place → 从备份库插回 → 校验行数 → COMMIT；
 *   任何错误 ROLLBACK，当前数据保持原样；不重启服务、不碰 DB 文件 / WAL。
 * - 含素材的恢复先把素材解压到 mediaRoot/.restore-<uuid>/ 暂存并逐条校验，DB 提交成功后才移动到最终路径；
 *   「只写/覆盖备份中的文件，绝不删除 B 里备份外的文件」。
 * - 恢复前先自动把当前数据（元数据+缩略图，不含素材）备份到 data/backups/pre-restore-*.zip，保留最近 5 份。
 * - 恢复只从备份 config.json 里取 `secret` 和 `home`（家的位置）；当前 mediaRoot / lastBackupAt / snooze / threshold 保留。
 *
 * ZIP 格式（formatVersion 2；v1 无素材的旧包仍可检查/恢复）：
 *   manifest.json
 *   media-manifest.json
 *   data/travel.db
 *   data/config.json
 *   thumbs/<文件名>        # 可选
 *   media/<rel_path 分段>  # 可选（formatVersion 2）
 *   README.txt
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { CONFIG, ROOT, normalizeHome, readLocalConfig, saveLocalConfig, setHome } from './config.mjs';
import { db } from './db.mjs';
import { getUserSetting, saveUserSetting } from './auth.mjs';
import {
  ZipCanceledError,
  ZipError,
  extractEntry,
  extractThumbs,
  formatBytes,
  isSafeMediaEntryName,
  isSafeThumbName,
  readEntryBuffer,
  scanZip,
  sha256Buffer,
  sha256File,
  stageMediaEntries,
  writeZip,
} from './zip.mjs';

export const BACKUP_FORMAT = 'travelmaps-backup';
export const BACKUP_FORMAT_VERSION = 2;
export const ALLOWED_REMINDER_DAYS = [7, 14, 30, 60, 90];
export const DEFAULT_REMINDER_DAYS = 30;
export const KEEP_AUTO_BACKUPS = 5;

const DAY_MS = 86_400_000;
const REQUIRED_FILES = [
  'manifest.json',
  'media-manifest.json',
  'data/travel.db',
  'data/config.json',
  'README.txt',
];
const BACKUP_TABLES = ['place', 'visit', 'media'];

/** 三张表里恢复时必须存在的列（缺了就不能插回去） */
const REQUIRED_COLUMNS = {
  place: ['id', 'name', 'lng', 'lat', 'kind', 'created_at', 'updated_at'],
  visit: ['id', 'place_id', 'date', 'created_at', 'updated_at'],
  media: ['id', 'visit_id', 'kind', 'rel_path', 'created_at'],
};

/** 当前版本新增、备份里没有时可以补默认值的列 */
const COLUMN_DEFAULTS = {
  deleted_at: null,
  companions: null,
  secret: 0,
  // M5 新增 place.home（NOT NULL DEFAULT 0）：M5 之前生成的备份没有这一列，恢复时补 0
  home: 0,
};

/** 上传的备份 zip 放在 data/tmp/（不要放 backups/，那是自动备份目录） */
const TOKEN_TTL_MS = (() => {
  const n = Number(process.env.BACKUP_TOKEN_TTL_MS || 10 * 60 * 1000);
  return Number.isFinite(n) && n > 0 ? n : 10 * 60 * 1000;
})();
const MAX_JSON_ENTRY_BYTES = 8 * 1024 * 1024;

/** 上传备份 zip 的单个文件上限：素材包可能很大，默认 100GB（测试可用 env 覆盖） */
export const BACKUP_UPLOAD_MAX_BYTES = (() => {
  const n = Number(process.env.BACKUP_UPLOAD_MAX_BYTES || 100 * 1024 ** 3);
  return Number.isFinite(n) && n > 0 ? n : 100 * 1024 ** 3;
})();
/** 恢复素材时在素材库所在盘额外预留的空间，默认 500MB */
const RESTORE_RESERVE_BYTES = (() => {
  const n = Number(process.env.BACKUP_RESTORE_RESERVE_BYTES || 500 * 1024 * 1024);
  return Number.isFinite(n) && n >= 0 ? n : 500 * 1024 * 1024;
})();

/** 两阶段导出任务 */
const EXPORT_JOB_TTL_MS = (() => {
  const n = Number(process.env.BACKUP_EXPORT_TTL_MS || 10 * 60 * 1000);
  return Number.isFinite(n) && n > 0 ? n : 10 * 60 * 1000;
})();
/** 测试钩子：让任务在 building 状态停留一会儿，便于覆盖 409 / 取消 / 进度；默认 0 */
const EXPORT_JOB_DELAY_MS = (() => {
  const n = Number(process.env.BACKUP_JOB_DELAY_MS || 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
})();
/** 磁盘空间检查的额外预留，默认 200MB（测试可用 BACKUP_DISK_RESERVE_BYTES 调大来覆盖报错） */
const DISK_RESERVE_BYTES = (() => {
  const n = Number(process.env.BACKUP_DISK_RESERVE_BYTES || 200 * 1024 * 1024);
  return Number.isFinite(n) && n >= 0 ? n : 200 * 1024 * 1024;
})();
/** 测试钩子：BACKUP_SKIP_DISK_CHECK=1 跳过磁盘空间检查 */
const SKIP_DISK_CHECK = process.env.BACKUP_SKIP_DISK_CHECK === '1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** DB 里的 rel_path 可能是 Windows 反斜杠：统一成 `a/b/c` 分段比较 */
function normalizeRelKey(rel) {
  return String(rel ?? '')
    .split(/[\\/]+/)
    .filter((s) => s && s !== '.')
    .join('/');
}

/** 可直接映射成 HTTP 的业务错误 */
export class BackupError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.name = 'BackupError';
    this.status = status;
    this.extra = extra;
  }
}

/** 恢复进行中标记：导出接口据此返回 409，也防止并发恢复 */
let restoring = false;
export const isRestoring = () => restoring;

// ───────────── 小工具 ─────────────

const tmpDir = () => resolve(CONFIG.dataDir, 'tmp');
/** 备份目录（2026-11-11 D-364）：默认 data/backups，可被用户在设置里改到其它盘（见 config.mjs backupDir） */
const backupsDir = () => CONFIG.backupDir || resolve(CONFIG.dataDir, 'backups');

function ensureTmpDir() {
  mkdirSync(tmpDir(), { recursive: true });
}
function ensureBackupDirs() {
  mkdirSync(tmpDir(), { recursive: true });
  mkdirSync(backupsDir(), { recursive: true });
}
/** 给路由层分配一个 data/tmp 下的临时 zip 路径 */
export function newTmpZipPath(prefix = 'inspect') {
  ensureTmpDir();
  return resolve(tmpDir(), `${prefix}-${randomUUID()}.zip`);
}

function safeUnlink(path) {
  if (!path) return;
  try {
    unlinkSync(path);
  } catch {
    /* 不存在就算了 */
  }
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 本地时间戳 YYYYMMDD-HHmmss（备份文件名用） */
export function fileStamp(date = new Date()) {
  return (
    `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}` +
    `-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`
  );
}

/**
 * 导出备份的默认文件名（2026-11-06 用户指定）：
 *   My旅迹素材备份-YYYY-MM-DD-（备份勿删）.zip
 * 中文文件名在 Content-Disposition 里用 RFC 5987 的 filename* 下发（见 server/index.mjs）。
 */
export function backupFileName(date = new Date()) {
  return `My旅迹素材备份-${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}-（备份勿删）.zip`;
}

/** null / undefined / 空串 / 非数字都算「没有」 */
function toFiniteNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

let cachedAppVersion = null;
export function appVersion() {
  if (cachedAppVersion !== null) return cachedAppVersion;
  try {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
    cachedAppVersion = typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.0.0';
  } catch {
    cachedAppVersion = '0.0.0';
  }
  return cachedAppVersion;
}

function oneCount(sql, params = []) {
  return Number(db.prepare(sql).get(...params)?.n) || 0;
}

/**
 * 活着（未软删）的行数：给 status.dataCounts / 清单用。
 * ownerId = null（local 模式）时统计全库，SQL 与旧版一致；
 * multi 模式下按账号过滤（M6 P2-2，D-202）。
 */
function aliveCounts(ownerId = null) {
  const own = ownerId ? ' AND user_id = ?' : '';
  const args = ownerId ? [ownerId] : [];
  return {
    places: oneCount('SELECT COUNT(*) AS n FROM place WHERE deleted_at IS NULL' + own, args),
    visits: oneCount('SELECT COUNT(*) AS n FROM visit WHERE deleted_at IS NULL' + own, args),
    media: oneCount('SELECT COUNT(*) AS n FROM media WHERE deleted_at IS NULL' + own, args),
  };
}

/** 全表行数（含回收站软删）：给备份清单用 */
function totalCounts() {
  return {
    place: oneCount('SELECT COUNT(*) AS n FROM place'),
    visit: oneCount('SELECT COUNT(*) AS n FROM visit'),
    media: oneCount('SELECT COUNT(*) AS n FROM media'),
  };
}

/**
 * 启动清理 data/tmp：
 * - 两阶段导出任务的目录 export-<jobId>/ 是内存任务的一部分，进程重启后必然失效，直接全删；
 * - 上传的 inspect-*.zip / VACUUM 快照只删 24 小时前的（避免误删正在进行的请求）。
 */
function cleanupStaleTmp() {
  try {
    const dir = tmpDir();
    if (!existsSync(dir)) return;
    const cut = Date.now() - 24 * 60 * 60 * 1000;
    for (const name of readdirSync(dir)) {
      const p = resolve(dir, name);
      try {
        if (name.startsWith('export-')) {
          rmSync(p, { recursive: true, force: true });
          continue;
        }
        if (!/^(inspect|snapshot)-/.test(name)) continue;
        const st = statSync(p);
        if (st.mtimeMs >= cut) continue;
        if (st.isDirectory()) rmSync(p, { recursive: true, force: true });
        else unlinkSync(p);
      } catch {
        /* 删不掉就算了 */
      }
    }
  } catch {
    /* 清理失败不影响功能 */
  }
}
cleanupStaleTmp();

/**
 * 启动清理：素材库根目录下的恢复暂存目录 `.restore-*`。
 * 正常流程恢复结束会删掉；只有进程崩溃/断电会残留。单实例下重启后不会有活着的暂存，
 * 但保守起见只清 24 小时前的。
 */
function cleanupStaleRestoreDirs() {
  try {
    const root = resolve(CONFIG.mediaRoot);
    if (!existsSync(root)) return;
    const cut = Date.now() - 24 * 60 * 60 * 1000;
    for (const name of readdirSync(root)) {
      if (!name.startsWith('.restore-')) continue;
      const p = resolve(root, name);
      try {
        const st = statSync(p);
        if (st.isDirectory() && st.mtimeMs < cut) rmSync(p, { recursive: true, force: true });
      } catch {
        /* 删不掉就算了 */
      }
    }
  } catch {
    /* 清理失败不影响功能 */
  }
}
cleanupStaleRestoreDirs();

function tableColumns(handle, table) {
  return handle
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => String(c.name));
}

// ───────────── 备份提醒（F-SYS-05）─────────────

/** 列出 data/backups 里的恢复前自动备份（新→旧） */
export function listAutoBackups(limit = KEEP_AUTO_BACKUPS) {
  const dir = backupsDir();
  let names = [];
  try {
    names = readdirSync(dir).filter((n) => /^pre-restore-.+\.zip$/i.test(n));
  } catch {
    return [];
  }
  const items = [];
  for (const name of names) {
    try {
      const st = statSync(resolve(dir, name));
      items.push({ name, bytes: st.size, createdAt: Math.round(st.mtimeMs) });
    } catch {
      /* 读不到就跳过 */
    }
  }
  items.sort((a, b) => b.createdAt - a.createdAt || (a.name < b.name ? 1 : -1));
  return items.slice(0, limit);
}

/** 保留最近 keep 份自动备份（恢复前调用） */
export function pruneAutoBackups(keep = KEEP_AUTO_BACKUPS) {
  const dir = backupsDir();
  let names = [];
  try {
    names = readdirSync(dir).filter((n) => /^pre-restore-.+\.zip$/i.test(n));
  } catch {
    return { removed: [], kept: [] };
  }
  // 文件名里带 YYYYMMDD-HHmmss[.zip | -序号.zip]，按「解析出的时间戳 + 序号」倒序 = 最新在前。
  // 不能直接按字符串排：同一秒内 `xxx.zip` 与 `xxx-2.zip` 的字典序会把先创建的排在后面。
  const sortKey = (name) => {
    const m = /^pre-restore-(\d{8})-(\d{6})(?:-(\d+))?\.zip$/i.exec(name);
    if (!m) return '';
    const seq = Number(m[3] || 1);
    return `${m[1]}${m[2]}-${String(seq).padStart(6, '0')}`;
  };
  names.sort((a, b) => {
    const ka = sortKey(a);
    const kb = sortKey(b);
    if (ka !== kb) return ka < kb ? 1 : -1;
    return a < b ? 1 : -1;
  });
  const kept = names.slice(0, keep);
  const removed = [];
  for (const name of names.slice(keep)) {
    try {
      unlinkSync(resolve(dir, name));
      removed.push(name);
    } catch {
      /* 删不掉就下次再删 */
    }
  }
  return { removed, kept };
}

/**
 * 记录「刚完成一次备份」：local 写 data/config.json（旧行为不变）；
 * multi 写当前账号的 user_setting.last_backup_at（每用户备份提醒，D-202）。
 */
function markBackupDone(ownerId = null) {
  if (ownerId) {
    saveUserSetting(ownerId, { last_backup_at: Date.now(), backup_snooze_until: null });
    return;
  }
  saveLocalConfig({ lastBackupAt: Date.now(), lastBackupSnoozeUntil: null });
}

/**
 * GET /api/backup/status
 * @param {string|null} ownerId multi 模式 = 当前账号（提醒字段读 user_setting、数据量只统计该账号）；
 *   null = local 模式（读 data/config.json、全库统计，行为与以前逐字一致）。
 * @param {number} [nowTs] 当前时间（setSnooze 内部复用；测试也可注入）。
 */
export function getBackupStatus(ownerId = null, nowTs = Date.now()) {
  const setting = ownerId ? getUserSetting(ownerId) : null;
  const cfg = ownerId ? null : readLocalConfig();
  const lastBackupAt = toFiniteNumber(ownerId ? setting?.last_backup_at : cfg.lastBackupAt);
  const savedThreshold = toFiniteNumber(
    ownerId ? setting?.backup_threshold_days : cfg.backupReminderDays
  );
  const thresholdDays = ALLOWED_REMINDER_DAYS.includes(savedThreshold)
    ? savedThreshold
    : DEFAULT_REMINDER_DAYS;
  const snoozeUntil = toFiniteNumber(
    ownerId ? setting?.backup_snooze_until : cfg.lastBackupSnoozeUntil
  );
  const alive = aliveCounts(ownerId);
  const dataCounts = { places: alive.places, visits: alive.visits, media: alive.media };
  // 素材体积预估：全部 media 行（含回收站软删），给前端显示「导出素材约 X MB」；
  // multi 只算自己的（D-202）。
  const mediaStats = ownerId
    ? db
        .prepare(
          'SELECT COUNT(*) AS files, COALESCE(SUM(COALESCE(bytes, 0)), 0) AS bytes FROM media WHERE user_id = ?'
        )
        .get(ownerId)
    : db
        .prepare('SELECT COUNT(*) AS files, COALESCE(SUM(COALESCE(bytes, 0)), 0) AS bytes FROM media')
        .get();
  const mediaFiles = Number(mediaStats?.files) || 0;
  const mediaBytes = Number(mediaStats?.bytes) || 0;

  const daysSinceBackup =
    lastBackupAt === null ? null : Math.floor((nowTs - lastBackupAt) / DAY_MS);
  const snoozed = snoozeUntil !== null && snoozeUntil > nowTs;
  const due =
    dataCounts.places > 0 &&
    (lastBackupAt === null || daysSinceBackup >= thresholdDays) &&
    !snoozed;
  const reason = due ? (lastBackupAt === null ? 'never' : 'overdue') : null;

  return {
    lastBackupAt,
    lastBackupAtISO: lastBackupAt === null ? null : new Date(lastBackupAt).toISOString(),
    daysSinceBackup,
    thresholdDays,
    snoozeUntil, // 已过期的也保留原值，前端按 > now 自行判断
    due,
    reason,
    dataCounts,
    mediaBytes,
    mediaFiles,
    autoBackupDir: backupsDir(),
    recentAutoBackups: listAutoBackups(),
  };
}

/** POST /api/backup/snooze（默认 1 天，clamp 1..30） */
export function setSnooze(body = {}, ownerId = null) {
  let days = 1;
  if (body && body.days !== undefined && body.days !== null) {
    const raw = Number(body.days);
    if (!Number.isFinite(raw)) throw new BackupError(400, '稍后提醒的天数必须是数字');
    days = Math.min(30, Math.max(1, Math.round(raw)));
  }
  const nowTs = Date.now();
  if (ownerId) saveUserSetting(ownerId, { backup_snooze_until: nowTs + days * DAY_MS });
  else saveLocalConfig({ lastBackupSnoozeUntil: nowTs + days * DAY_MS });
  return getBackupStatus(ownerId, nowTs);
}

/** POST /api/backup/settings（只允许 7 / 14 / 30 / 60 / 90 天） */
export function setReminderDays(body = {}, ownerId = null) {
  const n = body?.reminderDays;
  if (typeof n !== 'number' || !ALLOWED_REMINDER_DAYS.includes(n)) {
    throw new BackupError(400, '备份提醒间隔只支持 7 / 14 / 30 / 60 / 90 天');
  }
  if (ownerId) saveUserSetting(ownerId, { backup_threshold_days: n });
  else saveLocalConfig({ backupReminderDays: n });
  return getBackupStatus(ownerId);
}

// ───────────── 导出备份（F-SYS-03）─────────────

function listThumbFiles() {
  try {
    return readdirSync(CONFIG.thumbDir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * 找出「DB 引用、且文件确实存在」的素材文件。
 * 只认 media.rel_path（含回收站软删记录），不扫整个 B、不带孤儿。
 * 文件缺失 / 大小和 DB 记录对不上（说明被替换过）都计入 missingAtExport，不打包。
 */
function listMediaFilesForBackup(includeMedia) {
  const rows = db
    .prepare(
      `SELECT id, visit_id, kind, rel_path, hash, bytes, thumb, poster
       FROM media ORDER BY created_at, id`
    )
    .all();
  if (!includeMedia) return { mediaRows: rows, files: [], missing: 0 };

  const root = resolve(CONFIG.mediaRoot);
  const files = [];
  const usedNames = new Set();
  let missing = 0;
  for (const row of rows) {
    const rel = String(row.rel_path ?? '');
    const abs = resolve(root, rel);
    if (!rel || abs === root || !abs.startsWith(root + sep)) {
      missing++;
      continue;
    }
    let size;
    try {
      const st = statSync(abs);
      if (!st.isFile()) {
        missing++;
        continue;
      }
      size = st.size;
    } catch {
      missing++;
      continue;
    }
    const recorded = Number(row.bytes);
    if (Number.isFinite(recorded) && recorded >= 0 && recorded !== size) {
      // 文件内容和入库时记录的大小不一致（被替换/改过），不当作可靠备份素材
      missing++;
      continue;
    }
    const segments = normalizeRelKey(rel).split('/').filter(Boolean);
    if (!segments.length || !isSafeMediaEntryName(`media/${segments.join('/')}`)) {
      missing++;
      continue;
    }
    const name = `media/${segments.join('/')}`;
    if (usedNames.has(name)) {
      missing++;
      continue;
    }
    usedNames.add(name);
    files.push({ name, path: abs, size, segments, relPath: String(row.rel_path), row });
  }
  return { mediaRows: rows, files, missing };
}

function buildReadme({
  createdAtISO,
  appVersion: version,
  counts,
  aliveCounts: alive,
  includeThumbs,
  thumbsCount,
  includeMedia,
  mediaCount,
  mediaBytes,
  mediaMissingAtExport,
}) {
  const mediaLine = includeMedia
    ? `照片视频素材：已包含 ${mediaCount} 个（${formatBytes(mediaBytes)}）${mediaMissingAtExport ? `，导出时另有 ${mediaMissingAtExport} 个文件缺失未打包` : ''}`
    : '照片视频素材：未包含（恢复后需要自己把 B 素材库拷回，或用「切换路径并重新关联」对上）';
  const bSection = includeMedia
    ? `- B 素材库原片：已打包 ${mediaCount} 个数据库引用的文件（media/ 目录）；恢复时会写回当前素材库。
  恢复只写/覆盖备份里的文件，**不会删除** B 里备份外的文件；A 原件仍然不受影响。`
    : `- B 素材库原片：应用副本（素材库根目录下的「省/市/区县/日期_地点名」）没有打包进 zip。
  恢复后如果换了电脑，需要自己把整个 B 素材库拷到新路径，
  再用「设置 → 素材库 → 切换路径并重新关联」把记录和文件对上。`;
  return `TravelMaps 备份包
格式：${BACKUP_FORMAT} v${BACKUP_FORMAT_VERSION}
生成时间：${createdAtISO}
应用版本：${version}
数据行数：地点 ${counts.place} / 到访 ${counts.visit} / 媒体 ${counts.media}（含回收站里的软删记录）
存活行数：地点 ${alive.place} / 到访 ${alive.visit} / 媒体 ${alive.media}
缩略图缓存：${includeThumbs ? `已包含 ${thumbsCount} 个（可由素材库重建）` : '未包含（可由素材库重建）'}
${mediaLine}

这个包里有什么
- data/travel.db        应用数据库快照（地点 / 到访 / 媒体的全部记录）
- data/config.json      少量配置（含秘密基地密码的加盐哈希、家的位置）
- media-manifest.json   媒体清单（原片的相对路径，用于核对素材库）
- manifest.json         包清单：版本、行数、sha256 校验和
- thumbs/               可选：缩略图 / 1600 预览 / 视频封面帧缓存
- media/                可选：照片/视频素材原片（仅数据库引用的文件）
- README.txt            本说明

不包含什么（重要）
- A 原件：你自己的照片/视频原文件从来没有被读取、复制或打包，它们永远安全。
${bSection}
- 没有上云：这个 zip 只是本地文件，请自己再拷一份到移动硬盘 / 网盘。

恢复步骤
1. 启动 TravelMaps，打开「设置 → 备份 → 从备份恢复」，选择这个 zip。
2. 系统会先校验（格式版本、sha256、数据库完整性、行数、媒体清单、素材大小/哈希）并显示摘要，确认后才会覆盖。
3. 恢复前会自动把当前数据（元数据 + 缩略图，不含素材）导出到 data/backups/pre-restore-*.zip，并保留最近 5 份。
4. 恢复只替换数据库记录（以及可选的缩略图/素材文件）；不会删除素材库里备份外的文件，也不用重启服务。
5. 秘密基地密码以哈希形式随包恢复，会覆盖当前密码；恢复后请用备份时的密码解锁。
6. 家的地图位置也会随包恢复；旧备份没有家位置时保留当前的家。

安全提示
- 这个 zip 含秘密基地密码哈希（scrypt 加盐，不是明文），请和照片一样妥善保管。
- 恢复时校验 sha256、SQLite PRAGMA integrity_check、素材大小/CRC/哈希，损坏或篡改过的包会被拒绝。
`;
}

/**
 * 收集一次备份需要的内容并估算大小（导出任务 start 用它返回 filesTotal/bytesTotal）。
 * 实际的 DB 校验和要等 VACUUM 快照做完才补进 manifest，这里用等长占位符估算文本长度。
 */
function collectBackupPlan({ includeThumbs, includeMedia, createdAt }) {
  const createdAtISO = new Date(createdAt).toISOString();
  const counts = totalCounts();
  const alive = aliveCounts();

  const { mediaRows, files: mediaFiles, missing: mediaMissingAtExportRaw } =
    listMediaFilesForBackup(includeMedia);
  const mediaManifest = {
    total: mediaRows.length,
    items: mediaRows.map((m) => ({
      id: m.id,
      visit_id: m.visit_id,
      kind: m.kind,
      rel_path: m.rel_path,
      hash: m.hash ?? null,
      bytes: m.bytes ?? null,
      thumb: m.thumb ?? null,
      poster: m.poster ?? null,
    })),
  };
  const mediaManifestText = JSON.stringify(mediaManifest, null, 2) + '\n';

  const local = readLocalConfig();
  const configSnapshot = {
    appVersion: appVersion(),
    createdAt,
    createdAtISO,
    mediaRoot: CONFIG.mediaRoot,
    // 只导出秘密基地密码哈希 + 家的位置（用户数据）；
    // mediaRoot / 提醒等「本机运行配置」不随包恢复
    secret: local.secret && typeof local.secret === 'object' ? local.secret : null,
    home: normalizeHome(local.home),
  };
  const configText = JSON.stringify(configSnapshot, null, 2) + '\n';

  const thumbEntries = includeThumbs
    ? listThumbFiles().map((name) => {
        const abs = resolve(CONFIG.thumbDir, name);
        let size = 0;
        try {
          size = statSync(abs).size;
        } catch {
          /* 读不到按 0 算，写 zip 时会报错 */
        }
        return { name: `thumbs/${name}`, path: abs, size };
      })
    : [];

  const mediaCount = mediaFiles.length;
  const mediaBytes = mediaFiles.reduce((n, f) => n + f.size, 0);
  const mediaMissingAtExport = includeMedia ? mediaMissingAtExportRaw : 0;
  const includes = {
    thumbs: includeThumbs,
    thumbsCount: thumbEntries.length,
    media: includeMedia,
    mediaCount,
    mediaBytes,
    mediaMissingAtExport,
  };
  const manifestBase = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    appVersion: appVersion(),
    createdAt,
    createdAtISO,
    source: { mediaRoot: CONFIG.mediaRoot },
    counts: { place: counts.place, visit: counts.visit, media: counts.media },
    aliveCounts: { place: alive.places, visit: alive.visits, media: alive.media },
    checksums: {
      // 占位符：sha256 固定 64 位，文本长度和最终 manifest 相同，bytesTotal 估算才准
      'data/travel.db': '0'.repeat(64),
      'data/config.json': sha256Buffer(Buffer.from(configText)),
    },
    includes,
    mediaManifest: 'media-manifest.json',
  };
  const manifestTextEstimate = JSON.stringify(manifestBase, null, 2) + '\n';

  const readme = buildReadme({
    createdAtISO,
    appVersion: manifestBase.appVersion,
    counts: manifestBase.counts,
    aliveCounts: manifestBase.aliveCounts,
    includeThumbs,
    thumbsCount: thumbEntries.length,
    includeMedia,
    mediaCount,
    mediaBytes,
    mediaMissingAtExport,
  });

  // DB 快照大小估算：page_count * page_size（VACUUM 前）；不含 -wal 的少量浮动误差可接受
  let dbBytesEstimate = 0;
  try {
    const pageCount = Number(db.prepare('PRAGMA page_count').get()?.page_count) || 0;
    const pageSize = Number(db.prepare('PRAGMA page_size').get()?.page_size) || 4096;
    dbBytesEstimate = pageCount * pageSize;
  } catch {
    dbBytesEstimate = 4 * 1024 * 1024;
  }

  const filesTotal = 5 + thumbEntries.length + mediaCount;
  const bytesTotal =
    dbBytesEstimate +
    Buffer.byteLength(manifestTextEstimate) +
    Buffer.byteLength(mediaManifestText) +
    Buffer.byteLength(configText) +
    Buffer.byteLength(readme) +
    thumbEntries.reduce((n, f) => n + f.size, 0) +
    mediaBytes;

  return {
    createdAt,
    createdAtISO,
    counts,
    aliveCounts: alive,
    mediaRows,
    mediaManifest,
    mediaManifestText,
    configSnapshot,
    configText,
    thumbEntries,
    mediaFiles,
    mediaCount,
    mediaBytes,
    mediaMissingAtExport,
    includes,
    manifestBase,
    manifestTextEstimate,
    readme,
    filesTotal,
    bytesTotal,
  };
}

/**
 * 生成一个备份 zip 到 destPath。
 * - includeThumbs：是否把 data/thumbs 下的缓存文件打进包
 * - includeMedia：是否把 DB 引用的照片/视频素材打进包（条目名 media/<rel_path 分段>）
 * - updateLastBackup：成功后是否写 lastBackupAt（恢复前自动备份 / 两阶段任务传 false 自己写）
 * - ownerId：M6 P2-2（D-202）multi 模式下的当前账号；只用于把 lastBackupAt 记到
 *   user_setting（每用户备份提醒），导出的仍是全库快照（P2-3 再做普通用户自己的导出）。
 *   null = local，写 data/config.json（旧行为不变）。
 * - createdAt：可指定（两阶段任务用任务创建时间，保证 manifest 与下载文件名一致）
 * - onProgress / shouldCancel：两阶段任务的逐文件进度与取消
 */
export async function buildBackupZip({
  destPath,
  includeThumbs = false,
  includeMedia = false,
  updateLastBackup = true,
  ownerId = null,
  createdAt: createdAtOverride = null,
  onProgress = null,
  shouldCancel = null,
} = {}) {
  if (!destPath) throw new BackupError(500, '内部错误：缺少备份目标路径');
  ensureBackupDirs();
  const createdAt =
    Number.isFinite(Number(createdAtOverride)) && Number(createdAtOverride) > 0
      ? Number(createdAtOverride)
      : Date.now();
  const plan = collectBackupPlan({ includeThumbs, includeMedia, createdAt });
  const snapshotPath = resolve(tmpDir(), `snapshot-${randomUUID()}.db`);
  try {
    // WAL 模式下必须用 VACUUM INTO 做一致性快照；直接拷 travel.db 会丢 -wal 里的数据
    db.prepare('VACUUM INTO ?').run(snapshotPath);

    const manifest = {
      ...plan.manifestBase,
      checksums: {
        'data/travel.db': await sha256File(snapshotPath),
        'data/config.json': sha256Buffer(Buffer.from(plan.configText)),
      },
    };
    const manifestText = JSON.stringify(manifest, null, 2) + '\n';

    const entries = [
      { name: 'manifest.json', data: manifestText },
      { name: 'media-manifest.json', data: plan.mediaManifestText },
      { name: 'data/travel.db', path: snapshotPath },
      { name: 'data/config.json', data: plan.configText },
      ...plan.thumbEntries.map((f) => ({ name: f.name, path: f.path })),
      // 素材用 store 不压缩：照片/视频本身已压缩，deflate 只浪费时间
      ...plan.mediaFiles.map((f) => ({ name: f.name, path: f.path, compress: false })),
      { name: 'README.txt', data: plan.readme },
    ];

    const written = await writeZip(destPath, entries, { onProgress, shouldCancel });

    if (updateLastBackup) markBackupDone(ownerId);

    return { path: destPath, size: written.size, createdAt, createdAtISO: plan.createdAtISO, manifest, written };
  } finally {
    safeUnlink(snapshotPath);
  }
}

// ───────────── 检查备份（F-SYS-04 第一步）─────────────

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new BackupError(400, `${label} 不是合法 JSON：${e?.message || e}`);
  }
}

function normCounts(raw, label) {
  const out = {};
  for (const [key, dbKey] of [
    ['place', 'place'],
    ['visit', 'visit'],
    ['media', 'media'],
  ]) {
    const n = Number(raw?.[key] ?? raw?.[dbKey]);
    if (!Number.isInteger(n) || n < 0) throw new BackupError(400, `备份清单的 ${label}.${key} 不是有效行数`);
    out[key] = n;
  }
  return out;
}

function missingMediaForRows(rows) {
  const root = resolve(CONFIG.mediaRoot);
  let missing = 0;
  for (const m of rows) {
    const rel = String(m.rel_path ?? '');
    const abs = resolve(root, rel);
    if (!rel || (abs !== root && !abs.startsWith(root + sep)) || !existsSync(abs)) missing++;
  }
  return missing;
}

function missingThumbsForRows(rows) {
  const root = resolve(CONFIG.thumbDir);
  let missing = 0;
  for (const m of rows) {
    const ref = m.kind === 'video' ? m.poster : m.thumb;
    if (!ref) continue;
    const abs = resolve(root, String(ref));
    if (abs === root || !abs.startsWith(root + sep) || !existsSync(abs)) missing++;
  }
  return missing;
}

/**
 * 完整校验一个备份 zip。
 * 成功返回 { summary, manifest, mediaManifest, config, workDir, dbPath, thumbNames }；
 * workDir 由调用方负责删除（inspect 路由只取 summary，restore 需要 dbPath）。
 * 任何校验失败抛 BackupError(400)。
 */
export async function inspectBackupZip(zipPath) {
  ensureTmpDir();
  const scan = await scanZip(zipPath); // 路径穿越 / 条目数 / 解压总大小
  const names = scan.names;

  for (const required of REQUIRED_FILES) {
    if (!names.includes(required)) throw new BackupError(400, `备份包缺少必要文件：${required}`);
  }

  const exact = new Set(REQUIRED_FILES);
  const thumbNames = [];
  const mediaNames = [];
  for (const name of names) {
    if (exact.has(name)) continue;
    if (name.startsWith('thumbs/')) {
      const base = name.slice('thumbs/'.length);
      if (!isSafeThumbName(base)) throw new BackupError(400, `备份包内含非法缩略图路径：${name}`);
      thumbNames.push(name);
      continue;
    }
    if (name.startsWith('media/')) {
      if (!isSafeMediaEntryName(name)) throw new BackupError(400, `备份包内含非法素材路径：${name}`);
      mediaNames.push(name);
      continue;
    }
    throw new BackupError(400, `备份包包含未知文件：${name}`);
  }
  const entrySizeByName = new Map(scan.entries.map((e) => [e.name, e.size]));

  const manifestText = (
    await readEntryBuffer(zipPath, 'manifest.json', { maxBytes: MAX_JSON_ENTRY_BYTES })
  ).toString('utf8');
  const mediaManifestText = (
    await readEntryBuffer(zipPath, 'media-manifest.json', { maxBytes: MAX_JSON_ENTRY_BYTES })
  ).toString('utf8');
  const configText = (
    await readEntryBuffer(zipPath, 'data/config.json', { maxBytes: MAX_JSON_ENTRY_BYTES })
  ).toString('utf8');

  const manifest = parseJson(manifestText, 'manifest.json');
  if (!manifest || typeof manifest !== 'object') throw new BackupError(400, 'manifest.json 格式不正确');
  if (manifest.format !== BACKUP_FORMAT) {
    throw new BackupError(400, '不是 TravelMaps 备份包（manifest.format 不正确）');
  }
  const formatVersion = Number(manifest.formatVersion);
  if (!Number.isInteger(formatVersion) || formatVersion < 1) {
    throw new BackupError(400, '备份清单的 formatVersion 无效');
  }
  if (formatVersion > BACKUP_FORMAT_VERSION) {
    throw new BackupError(
      400,
      `备份来自更新版本的 TravelMaps（formatVersion=${formatVersion}），当前只支持 ${BACKUP_FORMAT_VERSION}，请先升级应用`
    );
  }
  if (manifest.mediaManifest !== undefined && manifest.mediaManifest !== 'media-manifest.json') {
    throw new BackupError(400, '备份清单的 mediaManifest 字段不正确');
  }
  const createdAt = Number(manifest.createdAt);
  if (!Number.isFinite(createdAt) || createdAt <= 0) {
    throw new BackupError(400, '备份清单缺少有效的创建时间');
  }
  const counts = normCounts(manifest.counts, 'counts');
  const claimedAlive = manifest.aliveCounts ? normCounts(manifest.aliveCounts, 'aliveCounts') : null;
  if (!manifest.checksums || typeof manifest.checksums !== 'object') {
    throw new BackupError(400, '备份清单缺少 sha256 校验和');
  }
  for (const file of ['data/travel.db', 'data/config.json']) {
    const v = manifest.checksums[file];
    if (typeof v !== 'string' || !/^[a-f0-9]{64}$/i.test(v)) {
      throw new BackupError(400, `备份清单缺少 ${file} 的 sha256 校验和`);
    }
  }
  const includes = manifest.includes && typeof manifest.includes === 'object' ? manifest.includes : {};
  const includeThumbs = includes.thumbs === true;
  const claimedThumbsCount = Number.isInteger(Number(includes.thumbsCount))
    ? Number(includes.thumbsCount)
    : 0;
  if (includeThumbs) {
    if (claimedThumbsCount !== thumbNames.length) {
      throw new BackupError(
        400,
        `备份包含的缩略图数量与清单不一致（清单 ${claimedThumbsCount} / 实际 ${thumbNames.length}）`
      );
    }
  } else if (thumbNames.length > 0) {
    throw new BackupError(400, '备份清单声明不含缩略图，但包里存在 thumbs/ 文件');
  }

  // formatVersion 2 起：素材（media/ 条目）信息。v1 旧包没有这些字段，按「不含素材」处理。
  const includeMedia = includes.media === true;
  const claimedMediaCount = Number.isInteger(Number(includes.mediaCount))
    ? Number(includes.mediaCount)
    : 0;
  const claimedMediaBytes = Number(includes.mediaBytes);
  const claimedMediaMissing = Number(includes.mediaMissingAtExport);
  if (formatVersion >= 2) {
    if (typeof includes.media !== 'boolean') {
      throw new BackupError(400, '备份清单 includes.media 字段缺失或无效');
    }
    if (!Number.isInteger(claimedMediaCount) || claimedMediaCount < 0) {
      throw new BackupError(400, '备份清单 includes.mediaCount 不是有效数量');
    }
    if (!Number.isInteger(claimedMediaBytes) || claimedMediaBytes < 0) {
      throw new BackupError(400, '备份清单 includes.mediaBytes 不是有效字节数');
    }
    if (!Number.isInteger(claimedMediaMissing) || claimedMediaMissing < 0) {
      throw new BackupError(400, '备份清单 includes.mediaMissingAtExport 不是有效数量');
    }
  }
  if (!includeMedia && mediaNames.length > 0) {
    throw new BackupError(400, '备份不含素材，但包里存在 media/ 文件');
  }

  // 解压数据库到 data/tmp 下的独立工作目录
  const workDir = resolve(tmpDir(), `inspect-${randomUUID()}`);
  mkdirSync(workDir, { recursive: true });
  const dbPath = resolve(workDir, 'travel.db');
  try {
    await extractEntry(zipPath, 'data/travel.db', dbPath);

    const dbSha = (await sha256File(dbPath)).toLowerCase();
    if (dbSha !== String(manifest.checksums['data/travel.db']).toLowerCase()) {
      throw new BackupError(400, '备份数据库校验失败（sha256 不一致，文件可能被修改过）');
    }
    const configSha = sha256Buffer(Buffer.from(configText, 'utf8'));
    if (configSha !== String(manifest.checksums['data/config.json']).toLowerCase()) {
      throw new BackupError(400, '备份配置文件校验失败（sha256 不一致，文件可能被修改过）');
    }

    let bdb;
    try {
      bdb = new DatabaseSync(dbPath, { readOnly: true });
    } catch (e) {
      throw new BackupError(400, '备份数据库无法打开（文件可能损坏）：' + (e?.message || e));
    }
    try {
      // SQLite 完整性检查
      const integrity = bdb.prepare('PRAGMA integrity_check').all();
      const integrityOk =
        integrity.length === 1 && Object.values(integrity[0])[0] === 'ok';
      if (!integrityOk) throw new BackupError(400, '备份数据库损坏（PRAGMA integrity_check 未通过）');

      const tables = new Set(
        bdb
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all()
          .map((r) => String(r.name))
      );
      for (const table of BACKUP_TABLES) {
        if (!tables.has(table)) throw new BackupError(400, `备份数据库缺少 ${table} 表`);
        const cols = tableColumns(bdb, table);
        const missing = REQUIRED_COLUMNS[table].filter((c) => !cols.includes(c));
        if (missing.length) {
          throw new BackupError(400, `备份数据库的 ${table} 表缺少必需列：${missing.join(', ')}`);
        }
      }

      const dbCounts = {
        place: Number(bdb.prepare('SELECT COUNT(*) AS n FROM place').get().n) || 0,
        visit: Number(bdb.prepare('SELECT COUNT(*) AS n FROM visit').get().n) || 0,
        media: Number(bdb.prepare('SELECT COUNT(*) AS n FROM media').get().n) || 0,
      };
      for (const table of BACKUP_TABLES) {
        if (counts[table] !== dbCounts[table]) {
          throw new BackupError(
            400,
            `备份清单行数与数据库不一致：${table} 清单 ${counts[table]} / 实际 ${dbCounts[table]}`
          );
        }
      }

      const aliveNow = {};
      for (const table of BACKUP_TABLES) {
        const cols = tableColumns(bdb, table);
        aliveNow[table] = cols.includes('deleted_at')
          ? Number(
              bdb
                .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE deleted_at IS NULL`)
                .get().n
            ) || 0
          : dbCounts[table];
      }
      if (claimedAlive) {
        for (const table of BACKUP_TABLES) {
          if (claimedAlive[table] !== aliveNow[table]) {
            throw new BackupError(
              400,
              `备份清单存活行数与数据库不一致：${table} 清单 ${claimedAlive[table]} / 实际 ${aliveNow[table]}`
            );
          }
        }
      }

      const mediaRows = bdb.prepare('SELECT * FROM media').all();
      const dbMediaIds = new Set(mediaRows.map((m) => String(m.id)));

      const mediaManifest = parseJson(mediaManifestText, 'media-manifest.json');
      if (!mediaManifest || typeof mediaManifest !== 'object') {
        throw new BackupError(400, 'media-manifest.json 格式不正确');
      }
      if (!Array.isArray(mediaManifest.items)) {
        throw new BackupError(400, '媒体清单格式不正确（items 不是数组）');
      }
      const total = Number(mediaManifest.total);
      if (!Number.isInteger(total) || total !== mediaManifest.items.length) {
        throw new BackupError(400, '媒体清单 total 与 items 数量不一致');
      }
      if (total !== dbMediaIds.size) {
        throw new BackupError(
          400,
          `媒体清单数量与数据库不一致（清单 ${total} / 数据库 ${dbMediaIds.size}）`
        );
      }
      const seenIds = new Set();
      for (const item of mediaManifest.items) {
        const id = String(item?.id ?? '');
        if (!id) throw new BackupError(400, '媒体清单存在缺少 id 的条目');
        if (seenIds.has(id)) throw new BackupError(400, `媒体清单存在重复的媒体 id：${id}`);
        seenIds.add(id);
      }
      for (const id of dbMediaIds) {
        if (!seenIds.has(id)) throw new BackupError(400, `媒体清单缺少数据库中的媒体记录：${id}`);
      }

      // 素材条目（media/）只能是 DB 引用的文件，且大小/路径要能对上；
      // inspect 这里只读中央目录元数据，不真正解压素材（大包也能秒级检查）。
      const mediaItems = new Map(mediaManifest.items.map((it) => [String(it.id), it]));
      const mediaEntriesByName = new Map();
      let mediaBytesActual = 0;
      if (includeMedia) {
        if (mediaNames.length !== claimedMediaCount) {
          throw new BackupError(
            400,
            `备份包含的素材数量与清单不一致（清单 ${claimedMediaCount} / 实际 ${mediaNames.length}）`
          );
        }
        if (claimedMediaCount + claimedMediaMissing !== dbCounts.media) {
          throw new BackupError(
            400,
            `素材数量与数据库媒体行数不一致（打包 ${claimedMediaCount} + 缺失 ${claimedMediaMissing} / 数据库 ${dbCounts.media}）`
          );
        }
        const rowsByKey = new Map();
        for (const row of mediaRows) {
          const key = normalizeRelKey(row.rel_path);
          if (!key) continue;
          const arr = rowsByKey.get(key);
          if (arr) arr.push(row);
          else rowsByKey.set(key, [row]);
        }
        const usedRowIds = new Set();
        for (const name of mediaNames) {
          const segments = name.slice('media/'.length).split('/');
          const key = segments.join('/');
          const candidates = rowsByKey.get(key) || [];
          const row = candidates.find((r) => !usedRowIds.has(String(r.id)));
          if (!row) {
            throw new BackupError(400, `备份包包含数据库未引用的素材文件：${name}`);
          }
          usedRowIds.add(String(row.id));
          const item = mediaItems.get(String(row.id));
          if (!item) throw new BackupError(400, `媒体清单缺少素材对应的记录：${name}`);
          if (normalizeRelKey(item.rel_path) !== key) {
            throw new BackupError(400, `素材条目与媒体清单路径不一致：${name}`);
          }
          const declared = Number(entrySizeByName.get(name));
          if (!Number.isFinite(declared) || declared < 0) {
            throw new BackupError(400, `备份包素材大小无效：${name}`);
          }
          const dbBytes = Number(row.bytes);
          if (Number.isFinite(dbBytes) && dbBytes >= 0 && declared !== dbBytes) {
            throw new BackupError(
              400,
              `素材大小与数据库不一致：${name}（包内 ${declared} / 数据库 ${dbBytes}）`
            );
          }
          const itemBytes = Number(item.bytes);
          if (Number.isFinite(itemBytes) && itemBytes >= 0 && declared !== itemBytes) {
            throw new BackupError(
              400,
              `素材大小与媒体清单不一致：${name}（包内 ${declared} / 清单 ${itemBytes}）`
            );
          }
          mediaBytesActual += declared;
          mediaEntriesByName.set(name, {
            name,
            size: declared,
            segments,
            hash:
              row.hash !== null && row.hash !== undefined && String(row.hash).trim()
                ? String(row.hash).trim()
                : null,
            relPath: String(row.rel_path),
            rowId: String(row.id),
          });
        }
        if (mediaBytesActual !== claimedMediaBytes) {
          throw new BackupError(
            400,
            `素材总字节与清单不一致（清单 ${claimedMediaBytes} / 实际 ${mediaBytesActual}）`
          );
        }
      }

      const config = parseJson(configText, 'data/config.json');
      const secret = config?.secret;
      const secretConfigured = Boolean(
        secret &&
          typeof secret === 'object' &&
          typeof secret.salt === 'string' &&
          secret.salt &&
          typeof secret.hash === 'string' &&
          secret.hash
      );

      const mediaMissing = missingMediaForRows(mediaRows);
      const thumbsMissing = missingThumbsForRows(mediaRows);
      const warnings = [];
      if (includeThumbs) {
        warnings.push(
          `备份包含 ${thumbNames.length} 个缩略图/预览缓存，恢复时会写入当前缩略图目录。`
        );
      } else {
        warnings.push('备份不含缩略图，恢复后缩略图会在首次查看时自动重建（不影响原片）。');
      }
      if (includeMedia) {
        if (mediaNames.length > 0) {
          warnings.push(
            `备份包含 ${mediaNames.length} 个照片/视频素材（${formatBytes(mediaBytesActual)}），恢复时会写回当前素材库。`
          );
        } else {
          warnings.push('备份勾选了素材，但导出时素材库里没有任何可打包的素材文件。');
        }
        if (claimedMediaMissing > 0) {
          warnings.push(
            `导出时另有 ${claimedMediaMissing} 个素材文件不在素材库（或大小与记录不一致），没有打包进备份。`
          );
        }
      } else {
        warnings.push('备份不含照片/视频素材，恢复后需要素材库原片才能查看照片（A 原件不受影响）。');
      }
      if (mediaMissing > 0) {
        warnings.push(
          `备份中有 ${mediaMissing} 个原片在当前素材库（${CONFIG.mediaRoot}）里找不到；` +
            '恢复后需要自己把 B 素材库拷回，或用「设置 → 素材库 → 切换路径并重新关联」对上（A 原件不受影响）。'
        );
      }
      if (secretConfigured) {
        warnings.push('备份包含秘密基地密码哈希，恢复后会覆盖当前密码。');
      } else {
        warnings.push('备份不含秘密基地密码，恢复后会清除当前密码。');
      }
      if (
        counts.place > aliveNow.place ||
        counts.visit > aliveNow.visit ||
        counts.media > aliveNow.media
      ) {
        warnings.push('备份包含回收站里的软删记录，恢复后会一并回来。');
      }

      const summary = {
        createdAt,
        createdAtISO:
          typeof manifest.createdAtISO === 'string'
            ? manifest.createdAtISO
            : new Date(createdAt).toISOString(),
        appVersion: typeof manifest.appVersion === 'string' ? manifest.appVersion : 'unknown',
        formatVersion,
        zipBytes: scan.size,
        includeThumbs,
        thumbsCount: thumbNames.length,
        includeMedia,
        mediaCount: includeMedia ? mediaNames.length : 0,
        mediaBytes: includeMedia ? mediaBytesActual : 0,
        mediaMissingAtExport: includeMedia ? claimedMediaMissing : 0,
        counts: { place: counts.place, visit: counts.visit, media: counts.media },
        aliveCounts: {
          place: aliveNow.place,
          visit: aliveNow.visit,
          media: aliveNow.media,
        },
        secretConfigured,
        mediaMissing,
        thumbsMissing,
        warnings,
      };

      return {
        summary,
        manifest,
        mediaManifest,
        config,
        workDir,
        dbPath,
        thumbNames,
        mediaNames,
        mediaEntries: mediaEntriesByName,
        mediaRows,
        counts,
      };
    } finally {
      try {
        bdb.close();
      } catch {
        /* ignore */
      }
    }
  } catch (e) {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    if (e instanceof BackupError) throw e;
    if (e instanceof ZipError) throw new BackupError(400, e.message);
    throw new BackupError(400, '备份校验失败：' + (e?.message || e));
  }
}

// ───────────── 检查令牌（内存 Map，TTL 10 分钟）─────────────

const tokenStore = new Map();

export function pruneExpiredTokens(nowTs = Date.now()) {
  for (const [token, rec] of tokenStore) {
    if (rec.expiresAt <= nowTs) {
      tokenStore.delete(token);
      safeUnlink(rec.zipPath);
    }
  }
}

export function storeInspectToken(zipPath, summary) {
  pruneExpiredTokens();
  const token = randomUUID();
  const nowTs = Date.now();
  const expiresAt = nowTs + TOKEN_TTL_MS;
  tokenStore.set(token, { zipPath, createdAt: nowTs, expiresAt, summary });
  return { token, expiresAt };
}

function getTokenRecord(token) {
  pruneExpiredTokens();
  const rec = tokenStore.get(String(token || ''));
  if (!rec) throw new BackupError(400, '备份令牌无效或已过期，请重新选择备份文件');
  return rec;
}

export function dropInspectToken(token) {
  const key = String(token || '');
  const rec = tokenStore.get(key);
  if (!rec) return;
  tokenStore.delete(key);
  safeUnlink(rec.zipPath);
}

// 定时清理过期上传文件（unref 不阻止进程退出）
const tokenTimer = setInterval(() => pruneExpiredTokens(), 60_000);
tokenTimer.unref?.();

// ───────────── 两阶段导出任务（大文件友好：start → 轮询进度 → download）─────────────

/** jobId → 任务状态；zip 在 data/tmp/export-<jobId>/backup.zip，TTL 到期 / DELETE 时清理 */
const exportJobs = new Map();

function cleanupJobFiles(job) {
  if (!job) return;
  if (job.dir) {
    try {
      rmSync(job.dir, { recursive: true, force: true });
    } catch {
      /* 清理失败下次再删 */
    }
  }
  job.zipPath = null;
}

/** 清掉过期任务（含内存里的 zip 文件）；每次任务 API 调用 + 每分钟定时都会跑 */
export function pruneExportJobs(nowTs = Date.now()) {
  for (const [jobId, job] of exportJobs) {
    // 打包中的任务不能被 TTL 删掉（超大素材包可能比 TTL 还久）；只清已完成/失败/取消的
    if (job.state === 'building') continue;
    if (nowTs - job.createdAt > EXPORT_JOB_TTL_MS) {
      cleanupJobFiles(job);
      exportJobs.delete(jobId);
    }
  }
}

function hasBuildingExportJob() {
  for (const job of exportJobs.values()) {
    if (job.state === 'building') return true;
  }
  return false;
}

/**
 * POST /api/backup/export/start
 * 返回 { jobId, filesTotal, bytesTotal, createdAt }，实际打包在后台异步进行。
 * ownerId：multi 模式下创建任务的账号（P2-3 前仅管理员；任务按 owner 隔离访问），local 传 null。
 */
export function startExport({ includeThumbs = false, includeMedia = false } = {}, ownerId = null) {
  if (restoring) throw new BackupError(409, '正在恢复备份，请稍后再导出');
  pruneExportJobs();
  if (hasBuildingExportJob()) throw new BackupError(409, '已有导出任务进行中，请稍后再试');

  const createdAt = Date.now();
  const plan = collectBackupPlan({ includeThumbs, includeMedia, createdAt });

  // 磁盘空间检查：dataDir 所在盘可用空间 < 预计大小 + 预留（默认 200MB）时拒绝
  if (!SKIP_DISK_CHECK) {
    let available = null;
    try {
      const st = statfsSync(resolve(CONFIG.dataDir));
      available = Number(st.bavail) * Number(st.bsize);
    } catch {
      /* 有的平台/沙箱不支持 statfs：不拦，交给写入失败兜底 */
    }
    if (Number.isFinite(available) && available < plan.bytesTotal + DISK_RESERVE_BYTES) {
      throw new BackupError(
        400,
        `磁盘空间不足：预计需要 ${formatBytes(plan.bytesTotal)}（另需预留 ${formatBytes(DISK_RESERVE_BYTES)}），可用 ${formatBytes(available)}`
      );
    }
  }

  ensureTmpDir();
  const jobId = randomUUID();
  const dir = resolve(tmpDir(), `export-${jobId}`);
  mkdirSync(dir, { recursive: true });
  const job = {
    jobId,
    dir,
    zipPath: resolve(dir, 'backup.zip'),
    filename: backupFileName(new Date(createdAt)),
    state: 'building',
    filesDone: 0,
    filesTotal: plan.filesTotal,
    bytesDone: 0,
    bytesTotal: plan.bytesTotal,
    zipBytes: 0,
    error: null,
    createdAt,
    finishedAt: null,
    includeThumbs,
    includeMedia,
    ownerId: ownerId || null,
    canceled: false,
    promise: null,
  };
  exportJobs.set(jobId, job);
  job.promise = runExportJob(job);
  return { jobId, filesTotal: plan.filesTotal, bytesTotal: plan.bytesTotal, createdAt };
}

async function runExportJob(job) {
  try {
    // 测试钩子：给 building 状态留一个窗口，覆盖并发 409 / 取消 / 进度
    if (EXPORT_JOB_DELAY_MS > 0) await sleep(EXPORT_JOB_DELAY_MS);
    if (job.canceled) throw new ZipCanceledError();

    const built = await buildBackupZip({
      destPath: job.zipPath,
      includeThumbs: job.includeThumbs,
      includeMedia: job.includeMedia,
      updateLastBackup: false, // 打包完成后由任务自己写，保证「完成即算备份」
      ownerId: job.ownerId || null,
      createdAt: job.createdAt,
      shouldCancel: () => job.canceled,
      onProgress: (p) => {
        if (job.state !== 'building') return;
        job.filesDone = p.filesDone;
        job.bytesDone = p.bytesDone;
      },
    });
    if (job.canceled) throw new ZipCanceledError();

    job.zipBytes = built.size;
    job.filesTotal = built.written.filesDone;
    job.filesDone = built.written.filesDone;
    job.bytesTotal = built.written.bytesDone;
    job.bytesDone = built.written.bytesDone;
    job.finishedAt = Date.now();
    job.state = 'done';
    // 打包完成即写 lastBackupAt（不是下载时）；multi 记到当前账号的 user_setting
    markBackupDone(job.ownerId || null);
  } catch (e) {
    if (job.canceled || e instanceof ZipCanceledError) {
      job.state = 'canceled';
      job.error = null;
    } else {
      job.state = 'error';
      job.error = e?.message || String(e);
    }
    cleanupJobFiles(job);
  }
}

/**
 * 取导出任务：ownerId 非空时只认自己创建的任务；
 * 跨用户访问一律 404（不泄露任务是否存在，D-202）。
 */
function getJobForOwner(jobId, ownerId = null) {
  const job = exportJobs.get(String(jobId || ''));
  if (!job) throw new BackupError(404, '导出任务不存在或已过期');
  if (ownerId && job.ownerId !== ownerId) throw new BackupError(404, '导出任务不存在或已过期');
  return job;
}

/** GET /api/backup/export/status/:jobId */
export function getExportStatus(jobId, ownerId = null) {
  pruneExportJobs();
  const job = getJobForOwner(jobId, ownerId);
  return {
    jobId: job.jobId,
    state: job.state,
    filesDone: job.filesDone,
    filesTotal: job.filesTotal,
    bytesDone: job.bytesDone,
    bytesTotal: job.bytesTotal,
    zipBytes: job.zipBytes,
    error: job.error,
    createdAt: job.createdAt,
  };
}

/** GET /api/backup/export/download/:jobId —— 返回 { zipPath, size, filename }，由路由流式发送 */
export function getExportDownload(jobId, ownerId = null) {
  pruneExportJobs();
  const job = getJobForOwner(jobId, ownerId);
  if (job.state === 'building') throw new BackupError(409, '导出任务还在打包中，请稍后再下载');
  if (job.state !== 'done') {
    throw new BackupError(409, `导出任务状态为「${job.state}」，无法下载`);
  }
  if (!job.zipPath || !existsSync(job.zipPath)) {
    cleanupJobFiles(job);
    throw new BackupError(404, '导出文件已被清理，请重新导出');
  }
  const size = job.zipBytes || statSync(job.zipPath).size;
  return { zipPath: job.zipPath, size, filename: job.filename };
}

/** DELETE /api/backup/export/:jobId —— building 取消并清理；done/error 删除临时 zip 与任务 */
export async function cancelExportJob(jobId, ownerId = null) {
  pruneExportJobs();
  const key = String(jobId || '');
  const job = getJobForOwner(key, ownerId);

  if (job.state === 'building') {
    job.canceled = true;
    try {
      await job.promise;
    } catch {
      /* runExportJob 内部已把状态/清理做好 */
    }
    cleanupJobFiles(job);
    return { ok: true };
  }

  cleanupJobFiles(job);
  exportJobs.delete(key);
  return { ok: true };
}

// 定时清理过期导出任务（unref 不阻止进程退出）
const exportJobTimer = setInterval(() => pruneExportJobs(), 60_000);
exportJobTimer.unref?.();

/** 列出导出任务（2026-11-11 D-365：设置关掉再打开能接着看进度）；owner 隔离同 exportJobs */
export function listExportJobs(ownerId = null) {
  pruneExportJobs();
  const out = [];
  for (const job of exportJobs.values()) {
    if (ownerId && job.ownerId !== ownerId) continue;
    out.push({
      jobId: job.jobId,
      state: job.state,
      filesDone: job.filesDone,
      filesTotal: job.filesTotal,
      bytesDone: job.bytesDone,
      bytesTotal: job.bytesTotal,
      zipBytes: job.zipBytes,
      error: job.error,
      createdAt: job.createdAt,
      includeThumbs: job.includeThumbs,
      includeMedia: job.includeMedia,
    });
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

// ───────────── 恢复任务（2026-11-11 D-365：关掉设置 / 切去别的页面也不丢进度、可回来继续看）─────────────

const RESTORE_JOB_TTL_MS = 6 * 60 * 60 * 1000;
const restoreJobs = new Map();

function pruneRestoreJobs(nowTs = Date.now()) {
  for (const [jobId, job] of restoreJobs) {
    if (job.state === 'running') continue;
    if (nowTs - job.createdAt > RESTORE_JOB_TTL_MS) restoreJobs.delete(jobId);
  }
}

/**
 * POST /api/backup/restore/start —— 后台执行恢复（复用 restoreBackup 全套校验 / 自动备份 / 回滚），
 * 客户端只轮询状态。这样关掉设置对话框甚至刷新页面后，恢复仍在服务端跑完；重开设置可继续看进度。
 */
export function startRestoreJob({ token } = {}, ownerId = null) {
  if (restoring) throw new BackupError(409, '正在恢复备份，请稍后再试');
  pruneRestoreJobs();
  if ([...restoreJobs.values()].some((j) => j.state === 'running')) {
    throw new BackupError(409, '已有恢复任务进行中');
  }
  const createdAt = Date.now();
  const job = {
    jobId: randomUUID(),
    state: 'running',
    createdAt,
    finishedAt: null,
    error: null,
    rolledBack: false,
    result: null,
    ownerId: ownerId || null,
  };
  restoreJobs.set(job.jobId, job);
  job.promise = (async () => {
    try {
      job.result = await restoreBackup({ token, confirm: true });
      job.state = 'done';
    } catch (e) {
      job.state = 'error';
      job.error = e?.message || String(e);
      job.rolledBack = e?.rolledBack === true;
    } finally {
      job.finishedAt = Date.now();
    }
  })();
  job.promise.catch(() => {});
  return { jobId: job.jobId, createdAt };
}

/** GET /api/backup/restore/status/:jobId */
export function getRestoreJobStatus(jobId, ownerId = null) {
  pruneRestoreJobs();
  const job = restoreJobs.get(String(jobId || ''));
  if (!job) throw new BackupError(404, '恢复任务不存在或已过期');
  if (ownerId && job.ownerId !== ownerId) throw new BackupError(404, '恢复任务不存在或已过期');
  return {
    jobId: job.jobId,
    state: job.state,
    error: job.error,
    rolledBack: job.rolledBack,
    result: job.state === 'done' ? job.result : null,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
  };
}

/** 列出最近恢复任务（设置页重开时恢复进度用） */
export function listRestoreJobs(ownerId = null) {
  pruneRestoreJobs();
  const out = [];
  for (const job of restoreJobs.values()) {
    if (ownerId && job.ownerId !== ownerId) continue;
    out.push({
      jobId: job.jobId,
      state: job.state,
      error: job.error,
      rolledBack: job.rolledBack,
      createdAt: job.createdAt,
      finishedAt: job.finishedAt,
    });
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

const restoreJobTimer = setInterval(() => pruneRestoreJobs(), 60_000);
restoreJobTimer.unref?.();

// ───────────── 恢复（F-SYS-04）─────────────

/** 计算恢复计划：当前/备份列交集 + 缺列默认值；备份有当前没有的列 → 「备份来自更新版本」 */
function buildRestorePlan(backupDbPath) {
  let bdb;
  try {
    bdb = new DatabaseSync(backupDbPath, { readOnly: true });
  } catch (e) {
    throw new BackupError(500, '备份数据库无法打开（文件可能损坏）：' + (e?.message || e), {
      rolledBack: true,
    });
  }
  try {
    const tables = [];
    const counts = {};
    for (const table of BACKUP_TABLES) {
      const curInfo = db.prepare(`PRAGMA table_info(${table})`).all();
      const curCols = curInfo.map((c) => String(c.name));
      const bakCols = tableColumns(bdb, table);

      const extra = bakCols.filter((c) => !curCols.includes(c));
      if (extra.length) {
        throw new BackupError(
          500,
          `备份来自更新版本：${table} 表包含当前版本没有的列（${extra.join(', ')}），请先升级 TravelMaps`,
          { rolledBack: true }
        );
      }

      const missing = curCols.filter((c) => !bakCols.includes(c));
      const defaults = {};
      for (const col of missing) {
        if (col in COLUMN_DEFAULTS) {
          defaults[col] = COLUMN_DEFAULTS[col];
          continue;
        }
        const info = curInfo.find((c) => c.name === col);
        if (info && Number(info.notnull) === 1) {
          throw new BackupError(
            500,
            `备份来自旧版本：${table}.${col} 是当前版本新增的必填列，无法恢复`,
            { rolledBack: true }
          );
        }
        defaults[col] = null;
      }

      const rows = bdb.prepare(`SELECT * FROM ${table}`).all();
      tables.push({ name: table, columns: curCols, backupColumns: bakCols, defaults, rows });
      counts[table] = rows.length;
    }
    return { tables, counts };
  } finally {
    try {
      bdb.close();
    } catch {
      /* ignore */
    }
  }
}

/** 行级事务替换：失败一定 ROLLBACK，当前数据保持原样 */
function executeRestore(plan) {
  db.exec('BEGIN IMMEDIATE');
  try {
    // 先清子表再清父表（DELETE 顺序与 FK 无关，但保持可读）
    db.exec('DELETE FROM media');
    db.exec('DELETE FROM visit');
    db.exec('DELETE FROM place');

    // place → visit → media 顺序插入，满足外键
    for (const t of plan.tables) {
      const quoted = t.columns.map((c) => `"${c}"`).join(',');
      const placeholders = t.columns.map(() => '?').join(',');
      const stmt = db.prepare(`INSERT INTO ${t.name} (${quoted}) VALUES (${placeholders})`);
      for (const row of t.rows) {
        const values = t.columns.map((col) =>
          Object.prototype.hasOwnProperty.call(row, col) ? row[col] : t.defaults[col]
        );
        stmt.run(...values);
      }
    }

    // 行数自检：插完必须和备份清单完全一致，否则不提交
    for (const table of BACKUP_TABLES) {
      const n = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n) || 0;
      if (n !== plan.counts[table]) {
        throw new Error(`恢复后 ${table} 行数 ${n} 与备份清单 ${plan.counts[table]} 不一致`);
      }
    }

    db.exec('COMMIT');
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 事务可能已自动回滚 */
    }
    throw e;
  }
}

/** 只恢复备份 config.json 里的 secret；没有（或格式坏）就清除当前 secret */
function applyBackupSecret(secret) {
  const warnings = [];
  let next = null;
  if (
    secret &&
    typeof secret === 'object' &&
    typeof secret.salt === 'string' &&
    secret.salt &&
    typeof secret.hash === 'string' &&
    secret.hash
  ) {
    next = {
      salt: secret.salt,
      hash: secret.hash,
      algo: typeof secret.algo === 'string' ? secret.algo : 'scrypt',
      updatedAt: toFiniteNumber(secret.updatedAt) ?? Date.now(),
    };
  } else if (secret != null) {
    warnings.push('备份里的秘密基地密码格式无法识别，已清除当前密码。');
  }
  if (!saveLocalConfig({ secret: next })) {
    warnings.push('写入 data/config.json 失败：秘密基地密码没有恢复，请检查磁盘权限。');
  }
  return warnings;
}

/**
 * 恢复备份里的「家」位置（data/config.json.home）。
 * 旧备份（M5.1 之前）没有这个字段 → 保留当前家的位置，不报错。
 */
function applyBackupHome(home) {
  const warnings = [];
  if (home === undefined || home === null) return warnings;
  const next = normalizeHome(home);
  if (!next) {
    warnings.push('备份里的家位置格式无法识别，已保留当前家的位置。');
    return warnings;
  }
  if (!setHome(next)) {
    warnings.push('写入 data/config.json 失败：家的位置没有恢复，请检查磁盘权限。');
  }
  return warnings;
}

/**
 * DB 事务提交成功后，把暂存素材移动到最终 rel_path：
 * - 目标不存在 → 移动；
 * - 目标已存在且大小相同 → 跳过（删掉暂存）；
 * - 目标已存在但大小不同 → 覆盖（先删旧文件再移动）；
 * - 目标已存在但不是普通文件 → 记为失败，绝不删目录；
 * 只写/覆盖备份里的文件，**绝不删除 B 里备份外的文件**。
 */
function commitStagedMedia(staged, stageDir) {
  const root = resolve(CONFIG.mediaRoot);
  const out = { written: 0, skipped: 0, failed: 0, warnings: [] };
  for (const item of staged) {
    const dest = resolve(root, ...item.segments);
    if (dest === root || !dest.startsWith(root + sep)) {
      out.failed++;
      out.warnings.push(`素材路径越界，已跳过：${item.relPath}`);
      continue;
    }
    try {
      mkdirSync(dirname(dest), { recursive: true });
      if (existsSync(dest)) {
        let st = null;
        try {
          st = statSync(dest);
        } catch {
          st = null;
        }
        if (!st || !st.isFile()) {
          out.failed++;
          out.warnings.push(`目标路径已存在且不是文件，已跳过：${item.relPath}`);
          continue;
        }
        if (st.size === item.size) {
          out.skipped++;
          safeUnlink(item.stagedPath);
          continue;
        }
        unlinkSync(dest); // 大小不同：覆盖
      }
      renameSync(item.stagedPath, dest);
      out.written++;
    } catch (e) {
      // 跨卷/被占用时退回复制
      try {
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(item.stagedPath, dest);
        safeUnlink(item.stagedPath);
        out.written++;
      } catch (e2) {
        out.failed++;
        out.warnings.push(`写入素材失败（${item.relPath}）：${e2?.message || e?.message || e2}`);
      }
    }
  }
  try {
    rmSync(stageDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  return out;
}

/**
 * 恢复后统计 B 里「不被当前 DB 引用」的文件数（孤儿文件）。
 * 排除 mediaRoot 顶层的 .restore-* 暂存目录；最多扫 20 万个文件（防止误选巨大目录卡死）。
 */
function countOrphanMediaFiles(limit = 200_000) {
  const out = { orphans: 0, scanned: 0, truncated: false, warnings: [] };
  const root = resolve(CONFIG.mediaRoot);
  if (!existsSync(root)) return out;
  const referenced = new Set(
    db
      .prepare('SELECT rel_path FROM media')
      .all()
      .map((r) => normalizeRelKey(r.rel_path))
      .filter(Boolean)
  );
  const stack = [root];
  try {
    while (stack.length) {
      const dir = stack.pop();
      let entries = [];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          if (dir === root && e.name.startsWith('.restore-')) continue;
          stack.push(p);
          continue;
        }
        if (!e.isFile()) continue;
        out.scanned++;
        if (out.scanned > limit) {
          out.truncated = true;
          stack.length = 0;
          break;
        }
        const rel = relative(root, p).split(sep).join('/');
        if (!referenced.has(rel)) out.orphans++;
      }
    }
  } catch (e) {
    out.warnings.push('扫描素材库孤儿文件失败：' + (e?.message || e));
  }
  if (out.truncated) {
    out.warnings.push(`素材库文件超过 ${limit} 个，孤儿文件统计可能不完整。`);
  }
  return out;
}

/**
 * 恢复素材前检查素材库所在盘空间：暂存目录也建在 mediaRoot 下，
 * 最多需要「备份素材总大小」的额外空间；不足时在动任何文件之前中止。
 */
function ensureRestoreDiskSpace(mediaBytes) {
  if (!(Number(mediaBytes) > 0)) return;
  let available = null;
  try {
    const st = statfsSync(resolve(CONFIG.mediaRoot));
    available = Number(st.bavail) * Number(st.bsize);
  } catch {
    return; // 平台不支持 statfs：交给写入失败兜底
  }
  if (!Number.isFinite(available)) return;
  if (available < Number(mediaBytes) + RESTORE_RESERVE_BYTES) {
    throw new BackupError(
      400,
      `素材库所在磁盘空间不足：恢复 ${formatBytes(Number(mediaBytes))} 素材另需预留 ${formatBytes(RESTORE_RESERVE_BYTES)}，当前可用 ${formatBytes(available)}`
    );
  }
}

/** 恢复后统计：当前素材库里缺多少原片 / 缩略图缓存 */
export function countMissingMedia() {
  return missingMediaForRows(db.prepare('SELECT rel_path FROM media').all());
}

export function countMissingThumbs() {
  return missingThumbsForRows(db.prepare('SELECT kind, thumb, poster FROM media').all());
}

/**
 * POST /api/backup/restore
 * 成功返回 { ok, restored, autoBackup, media:{packaged,written,skipped,failed}, orphans,
 *            missingMedia, missingThumbs, warnings }。
 * 失败抛 BackupError：400 参数/令牌/校验问题，409 并发恢复，500 已回滚（带 rolledBack:true）。
 * 含素材的恢复：先在 mediaRoot/.restore-<uuid>/ 暂存并逐条校验，DB 提交成功后才移动；
 * 只写/覆盖备份里的文件，绝不删除 B 里备份外的文件。
 */
export async function restoreBackup({ token, confirm } = {}) {
  if (confirm !== true) throw new BackupError(400, '恢复备份需要确认（confirm: true）');
  if (restoring) throw new BackupError(409, '正在恢复备份，请稍后再试');

  const rec = getTokenRecord(token);
  restoring = true;
  let inspected = null;
  try {
    // 重新完整校验一次：上传的文件在「检查」和「确认恢复」之间可能被替换/损坏
    try {
      inspected = await inspectBackupZip(rec.zipPath);
    } catch (e) {
      if (e instanceof BackupError) throw new BackupError(400, '备份文件校验失败：' + e.message);
      throw new BackupError(400, '备份文件校验失败：' + (e?.message || e));
    }
    const workDir = inspected.workDir;
    try {
      // 1) 恢复前自动备份当前数据（元数据 + 缩略图，不含素材；失败就中止）
      ensureBackupDirs();
      const stamp = fileStamp();
      let autoPath = resolve(backupsDir(), `pre-restore-${stamp}.zip`);
      if (existsSync(autoPath)) {
        let seq = 2;
        while (existsSync(resolve(backupsDir(), `pre-restore-${stamp}-${seq}.zip`))) seq++;
        autoPath = resolve(backupsDir(), `pre-restore-${stamp}-${seq}.zip`);
      }
      let auto;
      try {
        auto = await buildBackupZip({
          destPath: autoPath,
          includeThumbs: true,
          includeMedia: false,
          updateLastBackup: false, // 恢复前自动备份不算「用户主动备份」，不重置提醒
        });
      } catch (e) {
        safeUnlink(autoPath);
        throw new BackupError(
          500,
          '恢复前自动备份当前数据失败，已中止恢复：' + (e?.message || e),
          { rolledBack: true }
        );
      }
      pruneAutoBackups(KEEP_AUTO_BACKUPS);

      const includeMedia = inspected.summary.includeMedia === true;
      if (includeMedia) ensureRestoreDiskSpace(Number(inspected.summary.mediaBytes) || 0);

      // 2) 含素材的恢复：先把所有素材流式解压到 mediaRoot/.restore-<uuid>/ 暂存并逐条校验
      //    （大小 / zip CRC / sha256 前 16 位 == 备份 DB 的 media.hash）。
      //    任何失败 → 清暂存、返回 500；此时 DB 事务还没开始，当前数据与 B 都不变。
      let stageDir = null;
      let staged = [];
      if (includeMedia) {
        stageDir = resolve(CONFIG.mediaRoot, `.restore-${randomUUID()}`);
        try {
          rmSync(stageDir, { recursive: true, force: true });
          const expectations = new Map();
          for (const [entryName, info] of inspected.mediaEntries) {
            expectations.set(entryName, {
              size: info.size,
              hash: info.hash,
              segments: info.segments,
            });
          }
          staged = await stageMediaEntries(rec.zipPath, stageDir, expectations);
        } catch (e) {
          try {
            rmSync(stageDir, { recursive: true, force: true });
          } catch {
            /* ignore */
          }
          const msg = e instanceof ZipError ? e.message : e?.message || String(e);
          throw new BackupError(
            500,
            '恢复素材失败，已中止（当前数据与素材库保持原样）：' + msg,
            { rolledBack: true }
          );
        }
      }

      try {
        // 3) 列兼容 → 事务替换
        const plan = buildRestorePlan(inspected.dbPath);
        try {
          executeRestore(plan);
        } catch (e) {
          if (e instanceof BackupError) throw e;
          throw new BackupError(500, '恢复失败，已回滚，当前数据保持原样：' + (e?.message || e), {
            rolledBack: true,
          });
        }

        // 4) DB 提交成功后才把暂存素材移动到最终 rel_path（只写/覆盖，不删除 B 里其它文件）
        const extraWarnings = [];
        let mediaReport = { packaged: 0, written: 0, skipped: 0, failed: 0 };
        if (includeMedia) {
          const moved = commitStagedMedia(staged, stageDir);
          stageDir = null; // 暂存目录已在 commitStagedMedia 内清理
          mediaReport = {
            packaged: staged.length,
            written: moved.written,
            skipped: moved.skipped,
            failed: moved.failed,
          };
          extraWarnings.push(...moved.warnings);
        }

        // 5) 缩略图缓存（可选；写入失败只警告，已经提交的数据库不回滚）
        const thumbResult = inspected.thumbNames.length
          ? await extractThumbs(rec.zipPath, CONFIG.thumbDir)
          : { written: 0, failed: 0, warnings: [] };

        // 6) 只从备份 config.json 恢复 secret 和家的位置，其余本机配置保留
        const secretWarnings = applyBackupSecret(inspected.config?.secret);
        const homeWarnings = applyBackupHome(inspected.config?.home);

        // 7) 恢复后统计：缺失原片 / 缩略图、B 里不被当前 DB 引用的孤儿文件
        const missingMedia = countMissingMedia();
        const missingThumbs = countMissingThumbs();
        const orphanResult = countOrphanMediaFiles();
        extraWarnings.push(...orphanResult.warnings);
        const warnings = [
          ...inspected.summary.warnings,
          ...thumbResult.warnings,
          ...secretWarnings,
          ...homeWarnings,
          ...extraWarnings,
        ];

        // token 用后删除（同时删掉临时上传文件）
        dropInspectToken(token);

        return {
          ok: true,
          restored: {
            places: plan.counts.place,
            visits: plan.counts.visit,
            media: plan.counts.media,
          },
          autoBackup: { name: basename(auto.path), bytes: auto.size },
          media: mediaReport,
          orphans: orphanResult.orphans,
          missingMedia,
          missingThumbs,
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
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  } finally {
    restoring = false;
  }
}
