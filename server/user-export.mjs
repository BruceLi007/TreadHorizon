/**
 * M6 P2-3：普通用户导出自己的数据（个人数据导出 zip）
 *
 * 只导出 ownerId 这个账号自己的数据，绝不读别的账号：
 * - place / visit / media 只查 `user_id = ownerId` 的行（含回收站里的软删记录，deleted_at 原样保留）；
 * - user_setting 只导出「是否配置」的布尔值，绝不导出秘密基地密码哈希 / 天地图 Key 明文；
 * - 缩略图只从 `data/thumbs/<ownerId>/` 取该用户 media 行引用的文件；
 * - 原片只从 `mediaRoot/<rel_path>` 取，且 rel_path 必须以 `<ownerId>/` 开头
 *   （zip 条目名去掉 ownerId 前缀，即 `media/省/市/…`），越出素材库 / 别的账号目录一律不打包。
 *
 * 这是「给人看 / 留档 + 可恢复到自己的账号」的个人数据导出（2026-11-07 D-210 起支持按账号恢复：
 * 在 设置 → 备份与恢复 → 从我的备份恢复 里选这个 zip，只替换当前账号自己的数据）。
 * 本模块只读数据库和磁盘文件，唯一写操作是生成目标 zip；不写日志里的 Key / 密码。
 *
 * ZIP 结构（格式标识 USER_EXPORT_FORMAT v1）：
 *   manifest.json   包清单：格式 / 版本 / 账号 / 行数 / 是否含缩略图、原片 / 缺失数
 *   data.json       该用户的表和脱敏设置（内存拼，小文件量级）
 *   README.txt      中文说明
 *   thumbs/<文件名>  可选（includeThumbs）：缩略图 / 1600 预览 / 视频封面帧
 *   media/<去掉 ownerId 前缀的 rel_path>  可选（includeMedia）：原片应用副本（store 不压缩）
 *
 * 依赖约定（M6 P2-2，D-202）：multi 模式下媒体原片在 `mediaRoot/<ownerId>/省/市/…`、rel_path 存
 * `<ownerId>/省/市/…`（`/` 分隔）；缩略图 / 1600 预览（`<mediaId>_p.webp`）/ 视频封面帧在
 * `data/thumbs/<ownerId>/`，media.thumb / media.poster 存裸文件名。
 */
import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CONFIG } from './config.mjs';
import { db } from './db.mjs';
import { appVersion } from './backup.mjs';
import { mediaBaseFor } from './media-root.mjs';
import { formatBytes, writeZip } from './zip.mjs';

export const USER_EXPORT_FORMAT = 'travel-horizon-user-export';
export const USER_EXPORT_VERSION = 1;
/** 给用户看的一句话：个人数据导出（2026-11-07 D-210 起可以恢复到自己的账号） */
export const USER_EXPORT_NOTE = '个人数据导出 · 可在「设置 → 备份与恢复 → 从我的备份恢复」里恢复回自己的账号';

/** 个人数据导出的可预期错误（带 HTTP 状态码，路由层可直接 reply.code(e.status)） */
export class UserExportError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = 'UserExportError';
    this.status = status;
  }
}

const THUMB_PREFIX = 'thumbs/';
const MEDIA_PREFIX = 'media/';
/** zip 条目名总长上限（对齐 zip.mjs 的素材条目校验） */
const MAX_ENTRY_NAME = 2048;
/** 文件名里的安全名称最多 60 个字符（按码点截断） */
const MAX_SAFE_NAME = 60;
/** Windows 文件名非法字符（路径分隔符、通配符、控制字符） */
const WIN_ILLEGAL_CHARS = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;
/** 文件名首尾的空白 / 点（Windows 上会丢或变成非法名） */
const EDGE_JUNK = /^[\s.]+|[\s.]+$/g;

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** null / undefined / 空串 / 非数字都算「没有」 */
function toFiniteNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 导出文件名（已带 .zip）：`My旅迹数据导出-<安全名称>-YYYY-MM-DD.zip`
 * - 安全名称 = displayName || username，去掉 Windows 非法字符 `\/:*?"<>|` 和首尾空白 / 点，
 *   ≤60 字符，清洗后为空则用 'user'；
 * - 日期用本地时间（与 backupFileName 一致），非法 date 回落到当前时间。
 */
export function userExportFileName(displayName, username, date = new Date()) {
  const raw = String(displayName ?? '').trim() || String(username ?? '').trim();
  const cleaned = raw.replace(WIN_ILLEGAL_CHARS, '').replace(EDGE_JUNK, '');
  const safe =
    Array.from(cleaned).slice(0, MAX_SAFE_NAME).join('').replace(EDGE_JUNK, '') || 'user';
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  return `My旅迹数据导出-${safe}-${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}.zip`;
}

/**
 * 校验 zip 里的「裸文件名」（thumb / poster / `<id>_p.webp` 都必须是裸文件名）。
 * 不合法返回 null，调用方计入缺失（绝不把带路径的值塞进 zip 条目名）。
 */
function safeBareName(value) {
  if (typeof value !== 'string') return null;
  const base = value.trim();
  if (!base || base.length > 255) return null;
  if (base === '.' || base === '..') return null;
  if (base.includes('/') || base.includes('\\') || base.includes('\0')) return null;
  if (/^[A-Za-z]:/.test(base)) return null;
  if (/[\u0000-\u001f\u007f]/.test(base)) return null;
  return base;
}

/**
 * 校验素材 rel_path（`<ownerId>/省/市/…/文件`，`/` 分隔）：返回路径段数组，不合法返回 null。
 * 拒绝反斜杠 / NUL / 空段 / `.` / `..` / 盘符，并限制总长（防止路径穿越和超长条目名）。
 */
function safeRelSegments(value) {
  if (typeof value !== 'string') return null;
  const rel = value.trim();
  if (!rel || rel.length > MAX_ENTRY_NAME) return null;
  if (rel.includes('\\') || rel.includes('\0')) return null;
  const segs = rel.split('/');
  for (const seg of segs) {
    if (!seg || seg === '.' || seg === '..') return null;
    if (seg.length > 255) return null;
    if (/^[A-Za-z]:/.test(seg)) return null;
  }
  return segs;
}

/** README.txt（UTF-8 中文）：说明账号 / 时间 / 包含什么 / 与备份的区别 / A、B 关系 / 安全提示 */
function buildReadme({
  createdAtISO,
  createdAtLocal,
  appVersion: version,
  user,
  counts,
  includeThumbs,
  thumbsCount,
  thumbsBytes,
  missingThumbs,
  includeMedia,
  mediaCount,
  mediaBytes,
  missingMedia,
}) {
  const thumbState = includeThumbs
    ? `已包含 ${thumbsCount} 个缓存文件${thumbsBytes ? `（共 ${formatBytes(thumbsBytes)}）` : ''}${
        missingThumbs ? `；另有 ${missingThumbs} 个引用的缓存文件在服务器上缺失，未打包` : ''
      }`
    : '本次未包含（只导出记录）';
  const mediaState = includeMedia
    ? `已包含 ${mediaCount} 个应用副本${mediaBytes ? `（共 ${formatBytes(mediaBytes)}）` : ''}${
        missingMedia ? `；另有 ${missingMedia} 个引用的文件在服务器上缺失，未打包` : ''
      }`
    : '本次未包含（只导出记录与可选的缩略图缓存）';

  return `Tread Horizon 个人数据导出（${USER_EXPORT_FORMAT} v${USER_EXPORT_VERSION}）
================================================================

账号：${user.displayName}（用户名 ${user.username}）
用户 ID：${user.id}
导出时间：${createdAtISO}（服务器本地时间 ${createdAtLocal}）
应用版本：${version}
数据行数：地点 ${counts.places} / 到访 ${counts.visits} / 媒体 ${counts.media}
（数量含回收站里的软删记录）

这个包里有什么
- manifest.json   包清单：格式版本、账号、行数、是否包含缩略图 / 原片、缺失文件数
- data.json       你自己的数据（UTF-8 JSON，可直接用文本编辑器打开）：
                  - user：账号信息
                  - settings：秘密基地密码是否已设置 / 天地图 Key 是否已填写 / 备份提醒设置。
                    只有「是否配置」的布尔值，不含密码哈希，也不含天地图 Key 明文
                  - tables.place / tables.visit / tables.media：地点 / 到访 / 媒体记录，数据库原样字段
                  - deleted_at 不为空 = 已删除但还在回收站里的记录，也一并导出，方便你阅读 / 留档
- README.txt      本说明
- thumbs/         缩略图 / 1600 预览 / 视频封面帧缓存：${thumbState}
- media/          照片视频原片的应用副本：${mediaState}

可以恢复回你自己的账号（2026-11-07 起）
- 这个 zip 不只能看：登录你自己的账号后，在「设置 → 备份与恢复 → 从我的备份恢复」里选择这个 zip，
  检查通过后就能把地点 / 到访 / 媒体记录恢复回你的账号。
- 恢复范围只限你自己的账号：会替换你当前账号的全部数据，其他账号的数据不受影响。
- 恢复前应用会自动把你当前的数据再导出一份（放在服务器的 data/backups 里，保留最近 5 份），
  如果恢复结果不满意，可以再恢复那份自动备份。
- 建议包含缩略图、素材多时也勾上原片，恢复后照片视频才能完整显示；只含记录的包恢复后
  这些素材可能只显示记录或缩略图。
- 秘密基地密码和天地图 Key 不随导出（安全设计），恢复后如需使用请在设置里重新填写。
- 管理员另有「整库备份 / 恢复」用于服务器整体迁移，与这个个人包互不影响。

原片 A 与素材库 B 的关系（重要）
- A 原件：你自己电脑 / 手机里的照片视频原文件。应用从不读取、复制或删除 A 原件，这个导出也不会包含它们。
- B 素材库：应用在导入时复制的一份「应用副本」，存放在服务器的 mediaRoot/<你的用户 ID>/省/市/区县/…。
  含原片时，本包的 media/ 就是这份副本（去掉了最外层「你的用户 ID」目录），不是 A 原件。
- 缩略图 / 1600 预览 / 视频封面帧是应用根据素材生成的缓存，可由原片重新生成；本包 thumbs/ 里就是这些缓存。
- 恢复时：包里的 media/ 会写回当前账号的素材库目录、thumbs/ 写回缩略图缓存；
  包外的其它素材文件不会被删除（可能留下不被引用的旧文件，可让管理员清理）。

换机器 / 留档建议
- 这个 zip 只是本地文件，请自己再备份一份到移动硬盘 / 网盘；包含原片时体积可能很大。
- 换电脑后：登录同一个账号 →「从我的备份恢复」选这个 zip，即可把记录与素材一起恢复；
  换账号 / 换服务器也可以这样迁移（前提是用户名一致：账号被删后重建、id 变了也允许）。
- data.json 里 media.rel_path 是素材相对路径（带你的用户 ID 前缀），可以直接对照素材库里的文件。

安全提示
- 本包不含密码哈希，也不含天地图 Key 明文；但仍包含你的旅行轨迹和（可选的）照片视频，
  请像照片一样妥善保管，不要发到不可信的群里 / 公网上。
`;
}

/**
 * 生成该用户自己的数据导出 zip（只含 ownerId 的数据，绝不读别的账号）。
 *
 * @param {{
 *   ownerId: string,            // 必填：账号 id（multi 模式当前登录用户）
 *   includeThumbs?: boolean,    // 是否打包 data/thumbs/<ownerId>/ 下被引用到的缩略图 / 预览 / 封面帧
 *   includeMedia?: boolean,     // 是否打包 mediaRoot 下该账号的原片应用副本（store 不压缩）
 *   zipPath?: string,           // 输出路径；不传则自建 data/tmp/user-export-<uuid>.zip（目录 mkdir -p）
 * }} opts
 * @returns {Promise<{
 *   zipPath: string,            // 实际写出的 zip 绝对路径（由调用方负责下载后删除）
 *   size: number,               // zip 文件本身的字节数（writeZip 返回的 size）
 *   filesTotal: number,         // zip 条目数（manifest + data + README + 缩略图 + 原片）
 *   bytesTotal: number,         // 源数据未压缩字节总数（writeZip 返回的 bytesDone，不等于 size）
 *   counts: {places:number, visits:number, media:number},  // 该用户三张表的行数（含软删）
 *   includeThumbs: boolean,
 *   includeMedia: boolean,
 *   missingMedia: number,       // 应打包但文件缺失/路径非法的原片数（仅 includeMedia 时统计）
 *   missingThumbs: number       // 应打包但文件缺失/文件名非法的缓存数（仅 includeThumbs 时统计）
 * }>}
 */
export async function buildUserExportZip({
  ownerId,
  includeThumbs = false,
  includeMedia = false,
  zipPath,
} = {}) {
  const owner = typeof ownerId === 'string' ? ownerId.trim() : '';
  if (!owner) {
    // 绝不回落成全库导出：ownerId 缺失直接报错
    throw new UserExportError('缺少导出用户（ownerId），已拒绝导出', 400);
  }
  if (owner.length > 200 || /[\\/\0]/.test(owner) || owner === '.' || owner === '..') {
    throw new UserExportError('导出用户标识不合法，已拒绝导出', 400);
  }

  const userRow = db
    .prepare('SELECT id, username, display_name FROM user WHERE id = ?')
    .get(owner);
  if (!userRow) throw new UserExportError('账号不存在，无法导出', 404);

  const userId = String(userRow.id);
  const username = String(userRow.username ?? '');
  const displayName = String(userRow.display_name ?? '').trim() || username;

  const createdAt = Date.now();
  const createdAtISO = new Date(createdAt).toISOString();
  const created = new Date(createdAt);
  const createdAtLocal =
    `${created.getFullYear()}-${pad2(created.getMonth() + 1)}-${pad2(created.getDate())} ` +
    `${pad2(created.getHours())}:${pad2(created.getMinutes())}:${pad2(created.getSeconds())}`;
  const version = appVersion();

  // ── 该用户的三张表：只按 user_id 过滤，含软删行（deleted_at 保留）──
  const placeRows = db
    .prepare('SELECT * FROM place WHERE user_id = ? ORDER BY created_at, id')
    .all(userId);
  const visitRows = db
    .prepare('SELECT * FROM visit WHERE user_id = ? ORDER BY created_at, id')
    .all(userId);
  const mediaRows = db
    .prepare('SELECT * FROM media WHERE user_id = ? ORDER BY created_at, id')
    .all(userId);
  const counts = {
    places: placeRows.length,
    visits: visitRows.length,
    media: mediaRows.length,
  };

  // ── 设置：只给「是否配置」，绝不导出 secret 哈希 / 天地图 Key 明文 ──
  const settingRow = db
    .prepare(
      `SELECT secret, tdt_tk, last_backup_at, backup_threshold_days, backup_snooze_until
       FROM user_setting WHERE user_id = ?`
    )
    .get(userId);
  const settings = {
    secretConfigured: Boolean(settingRow && String(settingRow.secret ?? '').trim()),
    tdtKeyConfigured: Boolean(settingRow && String(settingRow.tdt_tk ?? '').trim()),
  };
  const hasBackupInfo =
    Boolean(settingRow) &&
    [settingRow.last_backup_at, settingRow.backup_threshold_days, settingRow.backup_snooze_until].some(
      (v) => v !== null && v !== undefined
    );
  if (hasBackupInfo) {
    settings.backup = {
      lastBackupAt: toFiniteNumber(settingRow.last_backup_at),
      backupThresholdDays: toFiniteNumber(settingRow.backup_threshold_days),
      backupSnoozeUntil: toFiniteNumber(settingRow.backup_snooze_until),
    };
  }

  const data = {
    format: USER_EXPORT_FORMAT,
    version: USER_EXPORT_VERSION,
    exportedAt: createdAtISO,
    user: { id: userId, username, displayName },
    settings,
    tables: { place: placeRows, visit: visitRows, media: mediaRows },
  };
  const dataText = JSON.stringify(data, null, 2) + '\n';

  // ── 缩略图 / 1600 预览 / 视频封面帧（仅该账号目录，且只打被 media 行引用到的文件）──
  const thumbEntries = [];
  const seenThumbNames = new Set();
  let missingThumbs = 0;
  let thumbsBytes = 0;
  if (includeThumbs) {
    const thumbRoot = join(CONFIG.thumbDir, userId);
    for (const row of mediaRows) {
      // 与 db.mjs / index.mjs 的口径一致：thumb + poster + <mediaId>_p.webp
      for (const raw of [row.thumb, row.poster, `${row.id}_p.webp`]) {
        if (raw === null || raw === undefined || String(raw).trim() === '') continue;
        const base = safeBareName(raw);
        if (!base) {
          missingThumbs += 1;
          continue;
        }
        if (seenThumbNames.has(base)) continue;
        seenThumbNames.add(base);
        const abs = join(thumbRoot, base);
        try {
          const st = await stat(abs);
          if (!st.isFile()) {
            missingThumbs += 1;
            continue;
          }
          thumbEntries.push({ name: THUMB_PREFIX + base, path: abs });
          thumbsBytes += st.size;
        } catch {
          missingThumbs += 1;
        }
      }
    }
  }

  // ── 原片应用副本（仅该账号目录：rel_path 必须以 <ownerId>/ 开头；条目名去掉该前缀）──
  const mediaEntries = [];
  const seenMediaNames = new Set();
  let missingMedia = 0;
  let mediaBytes = 0;
  if (includeMedia) {
    // D-212：每个账号可能自定义了自己的素材库根目录（默认 = 服务器 CONFIG.mediaRoot）
    const mediaRoot = resolve(mediaBaseFor(userId));
    for (const row of mediaRows) {
      const segs = safeRelSegments(row.rel_path);
      if (!segs || segs.length < 2 || segs[0] !== userId) {
        // 路径不合法 / 不属于当前账号：绝不打包（宁可记缺失，也不读别的账号目录）
        missingMedia += 1;
        continue;
      }
      const entryName = MEDIA_PREFIX + segs.slice(1).join('/');
      if (entryName.length > MAX_ENTRY_NAME || seenMediaNames.has(entryName)) {
        missingMedia += 1;
        continue;
      }
      const abs = resolve(mediaRoot, ...segs);
      if (abs === mediaRoot || !abs.startsWith(mediaRoot + sep)) {
        missingMedia += 1;
        continue;
      }
      try {
        const st = await stat(abs);
        if (!st.isFile()) {
          missingMedia += 1;
          continue;
        }
        seenMediaNames.add(entryName);
        mediaEntries.push({ name: entryName, path: abs, compress: false });
        mediaBytes += st.size;
      } catch {
        missingMedia += 1;
      }
    }
  }

  const manifest = {
    format: USER_EXPORT_FORMAT,
    version: USER_EXPORT_VERSION,
    createdAt,
    createdAtISO,
    appVersion: version,
    user: { id: userId, username, displayName },
    counts,
    includes: { thumbs: Boolean(includeThumbs), media: Boolean(includeMedia) },
    mediaMissing: { files: missingMedia, thumbs: missingThumbs },
    note: USER_EXPORT_NOTE,
  };
  const manifestText = JSON.stringify(manifest, null, 2) + '\n';

  const readme = buildReadme({
    createdAtISO,
    createdAtLocal,
    appVersion: version,
    user: manifest.user,
    counts,
    includeThumbs,
    thumbsCount: thumbEntries.length,
    thumbsBytes,
    missingThumbs,
    includeMedia,
    mediaCount: mediaEntries.length,
    mediaBytes,
    missingMedia,
  });

  const entries = [
    { name: 'manifest.json', data: manifestText },
    { name: 'data.json', data: dataText },
    { name: 'README.txt', data: readme },
    ...thumbEntries,
    ...mediaEntries,
  ];

  const providedPath = typeof zipPath === 'string' && zipPath.trim() ? resolve(zipPath) : '';
  const destPath = providedPath || join(CONFIG.dataDir, 'tmp', `user-export-${randomUUID()}.zip`);
  await mkdir(dirname(destPath), { recursive: true });

  let written;
  try {
    written = await writeZip(destPath, entries);
  } catch (err) {
    // 失败时清掉自己写的半截 zip（成功时由调用方下载完后删除）
    await rm(destPath, { force: true }).catch(() => {});
    throw err;
  }

  return {
    zipPath: destPath,
    size: written.size,
    filesTotal: entries.length,
    // 口径：bytesDone = 源数据未压缩字节数（小 JSON 按 UTF-8 长度、磁盘文件按实际读出字节），不是 zip 大小
    bytesTotal: written.bytesDone,
    counts,
    includeThumbs: Boolean(includeThumbs),
    includeMedia: Boolean(includeMedia),
    missingMedia,
    missingThumbs,
  };
}
