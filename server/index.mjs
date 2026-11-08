import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import sharp from 'sharp';
import { randomUUID, createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync, statfsSync, readdirSync, unlinkSync, rmSync, renameSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { join, extname, basename, relative, resolve, sep, dirname } from 'node:path';
import { CONFIG, clearHome, setHome, setMediaRoot, setTdtKey } from './config.mjs';
import {
  AuthError,
  bootstrapAdmin,
  changePassword,
  clearLoginFailures,
  clearSessionCookie,
  consumeInvite,
  createInvite,
  createSession,
  createUser,
  destroySession,
  findUsableInvite,
  findUserByUsername,
  getUserSetting,
  listInvites,
  listUsersWithUsage,
  loginKey,
  loginLockRemaining,
  pruneSessions,
  publicUser,
  QUOTA_MAX_BYTES,
  quotaBytesOf,
  readCookie,
  recordLoginFailure,
  resetPassword,
  revokeInvite,
  sameOrigin,
  saveUserSetting,
  sessionCookie,
  updateOwnDisplayName,
  updateUserByAdmin,
  userFromRequest,
  userUsage,
  verifyPassword,
} from './auth.mjs';
import { db, now, listPlaces, getPlace, stats, placesInRange, timeline, listTrash, trashCount, listCompanions } from './db.mjs';
// 2026-11-08 D-310：云端版每账号配额 + 扩容申请（申请 / 审批都在服务端）
import {
  cancelQuotaRequest,
  decideQuotaRequest,
  getQuotaRequest,
  insertQuotaRequest,
  listQuotaRequests,
  listQuotaRequestsForUser,
  pendingQuotaRequest,
  resolvePendingQuotaRequests,
} from './db.mjs';
import { parseStatsQuery, buildStats, provinceLight } from './stats.mjs';
import { parsePhotosQuery, buildPhotos } from './photos.mjs';
import { secretStatus, setSecretPassword, verifySecret } from './secret.mjs';
import { searchPlace, reverseGeocode } from './tdt.mjs';
import { PHOTO_EXT, VIDEO_EXT, scanLibrary, buildPreview, publicPreview } from './importer.mjs';
// D-307（2026-11-08）：HEIC / HEIF 真实支持——sharp 预编译版没有 HEVC 解码器，
// 这里用 heic-convert（libheif-js wasm）先解成 JPEG 再交给 sharp 生成缩略图 / 预览 / 头像。
import { decodeHeicToJpeg, isHeicExt } from './heic.mjs';
// D-319（2026-11-08）：应用更新检查（本地安装版「设置 → 关于」显示是否有新版本）
import { checkForUpdate } from './update.mjs';
// M6 D-212 / D-213（2026-11-07）：每个账号自己的素材库根目录（普通用户 + 管理员各自管理自己的）
import {
  mediaBaseCustomized,
  mediaBaseFor,
  migrateMediaRoot,
} from './media-root.mjs';
import {
  BACKUP_UPLOAD_MAX_BYTES,
  BackupError,
  appVersion,
  backupFileName,
  buildBackupZip,
  cancelExportJob,
  getBackupStatus,
  getExportDownload,
  getExportStatus,
  inspectBackupZip,
  isRestoring,
  newTmpZipPath,
  restoreBackup,
  setReminderDays,
  setSnooze,
  startExport,
  storeInspectToken,
} from './backup.mjs';
// M6 P2-3：普通用户导出自己的数据（另一位工程师并行实现的模块）+ zip 层错误类型（消息可直接给用户看）
import { UserExportError, buildUserExportZip, userExportFileName } from './user-export.mjs';
// M6 P2-3+（2026-11-07 D-210）：普通用户「从我的备份恢复」（按账号范围替换自己的数据）
import {
  UserRestoreError,
  inspectUserBackupZip,
  restoreUserBackup,
  storeUserRestoreToken,
} from './user-restore.mjs';
import { ZipError } from './zip.mjs';

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.gif': 'image/gif', '.bmp': 'image/bmp', '.heic': 'image/heic', '.heif': 'image/heif',
  '.avif': 'image/avif', '.mp4': 'video/mp4', '.mov': 'video/quicktime',
  '.m4v': 'video/mp4', '.webm': 'video/webm', '.avi': 'video/x-msvideo', '.mkv': 'video/x-matroska',
};

const app = Fastify({ logger: false, bodyLimit: 4 * 1024 * 1024, trustProxy: true });

// ───────────── M6 P2-2（D-202）：登录守卫 + 数据归属 ─────────────

/**
 * 全局登录守卫（只在 AUTH_MODE=multi 生效）：
 * - `/api/health` 与 `/api/auth/*` 免登录（登录页 / 健康检查）;
 * - 其它 `/api/*` 未登录一律 401，并把 req.authUser 设为 publicUser(userFromRequest)；
 * - `/api/*` 的非 GET 请求继续做 sameOrigin CSRF 校验（P2-1 的 auth 路由里已有，这里统一兜住）。
 * local 模式（默认）：req.authUser = null、放行所有请求，旧行为逐字不变。
 *
 * 注意：hook 必须在任何路由注册之前挂到根实例上，才会覆盖所有子路由（含 static / auth）。
 */
app.addHook('preHandler', async (req, reply) => {
  req.authUser = null;
  const path = String(req.url || '').split('?')[0];
  if (path !== '/api' && !path.startsWith('/api/')) return; // 静态资源 / 前端页面不解析会话
  const user = userFromRequest(req); // local 模式直接返回 null，不查库
  req.authUser = user;
  if (CONFIG.authMode !== 'multi') return;
  if (path === '/api/health' || path.startsWith('/api/auth/')) return;
  if (!user) return reply.code(401).send({ error: '请先登录' });
  if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) {
    return reply.code(403).send({ error: '请求来源不合法' });
  }
});

/** 当前请求的数据归属：multi = 登录用户 id；local = null（数据层不过滤、写入 NULL，旧行为） */
const ownerOf = (req) => (CONFIG.authMode === 'multi' && req.authUser ? req.authUser.id : null);

/** 缩略图 / 1600 预览 / 视频封面帧根目录：multi = data/thumbs/<owner>/；local = data/thumbs（旧路径不变） */
const thumbRootFor = (owner) => (owner ? join(CONFIG.thumbDir, owner) : CONFIG.thumbDir);

/** 账号头像（2026-11-07 D-224）：<dataDir>/avatars/<userId>.webp；上传时统一转 128×128 webp */
const avatarDir = () => join(CONFIG.dataDir, 'avatars');
const avatarPathFor = (userId) => join(avatarDir(), `${userId}.webp`);
const AVATAR_MAX_BYTES = 10 * 1024 * 1024;

/** 字节数 → 人类可读（服务端提示文案用；前端有 formatBytes 展示） */
function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1024 ** 3) return `${(v / 1024 ** 3).toFixed(2)} GB`;
  if (v >= 1024 ** 2) return `${(v / 1024 ** 2).toFixed(1)} MB`;
  if (v >= 1024) return `${(v / 1024).toFixed(0)} KB`;
  return `${v} B`;
}

/** 扩容申请行 → 前端 camelCase（2026-11-08 D-310） */
function publicQuotaRequest(r) {
  if (!r) return null;
  return {
    id: r.id,
    userId: r.user_id,
    requestedBytes: r.requested_bytes,
    currentBytes: r.current_bytes,
    reason: r.reason || '',
    status: r.status,
    createdAt: r.created_at,
    decidedAt: r.decided_at ?? null,
    approvedBytes: r.approved_bytes ?? null,
    adminNote: r.admin_note ?? null,
    ...(r.username !== undefined ? { username: r.username, displayName: r.display_name || '' } : {}),
  };
}

/**
 * 同一账号的上传串行处理（2026-11-08 D-310）。
 * 配额检查是「已用空间 + 本文件 ≤ 配额」，同一账号并发上传（多标签页 / 多设备）时
 * 如果不串行，两个请求可能同时通过检查而超额；前端上传队列本身是逐文件串行的，
 * 这里只兜住并发场景。不同账号之间不受影响。
 */
const ownerUploadChains = new Map();
function runSerializedUpload(owner, task) {
  const prev = ownerUploadChains.get(owner) || Promise.resolve();
  const run = prev.then(task, task);
  const tail = run.then(
    () => undefined,
    () => undefined
  );
  ownerUploadChains.set(owner, tail);
  tail.then(() => {
    if (ownerUploadChains.get(owner) === tail) ownerUploadChains.delete(owner);
  });
  return run;
}

/** 归属过滤 SQL 片段：owner 非空时追加 ` AND <col> = ?`；local 返回空串（SQL 与旧版一致） */
const ownerSql = (owner, col = 'user_id') => (owner ? ` AND ${col} = ?` : '');

/** 与 ownerSql 配套的参数列表 */
const ownerArgs = (owner, ...args) => (owner ? [...args, owner] : args);

/**
 * P2-2 阶段的多用户限制：备份导出/恢复/inspect/snooze/settings 与素材库管理（/api/library*、/api/scan*）
 * 在 P2-3 之前只给管理员（普通用户 403）；local 模式不限制（旧行为）。
 */
function requireAdminInMulti(req, reply) {
  if (CONFIG.authMode !== 'multi') return true;
  if (req.authUser?.role === 'admin') return true;
  reply.code(403).send({ error: '该功能在云端模式（AUTH_MODE=multi）下仅管理员可用' });
  return false;
}

/**
 * 搜索 / 逆地理用的天地图 Key（M6 P2-4，D-205）：
 * - multi：只认当前账号 user_setting.tdt_tk（D-182「每个人自填自己的 Key」，不回落全局）；
 * - local：用全局 CONFIG.tdtTk，行为与以前完全一致。
 */
function tdtKeyFor(req) {
  if (CONFIG.authMode !== 'multi') return CONFIG.tdtTk;
  const st = getUserSetting(req.authUser?.id || null);
  return typeof st?.tdt_tk === 'string' ? st.tdt_tk.trim() : '';
}

/** multi 模式下当前用户还没填自己的天地图 Key 时，搜索 / 逆地理统一返回这个提示（400） */
const NEED_OWN_TDT_KEY = '请先在 设置 → 天地图 Key 里填写你自己的天地图 Key（每个账号一份）';

await app.register(fastifyMultipart, { limits: { fileSize: CONFIG.maxUploadBytes } });

// ───────────── 工具 ─────────────

const safeName = (s) =>
  String(s || '地点').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '').slice(0, 60) || '地点';

/** 目录级名称（省/市/区县）：清洗非法字符、限长，缺省用「未标注」 */
const safeSeg = (s) =>
  String(s || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 48) || '未标注';

function uniquePath(dir, filename) {
  const ext = extname(filename);
  const base = basename(filename, ext);
  let p = join(dir, filename);
  let i = 1;
  while (existsSync(p)) p = join(dir, `${base}-${i++}${ext}`);
  return p;
}

const hashFile = (path) =>
  new Promise((res, rej) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', (d) => h.update(d))
      .on('end', () => res(h.digest('hex').slice(0, 16)))
      .on('error', rej);
  });

// ───────────── 视频封面（F-MED-04）─────────────
// 有 ffmpeg 就抽首帧 + 读时长；没有就静默跳过，视频仍然能播。
// 二进制路径：优先环境变量（便于排查/自带分发），否则走 PATH。
const execFileAsync = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
let ffmpegState = null;

async function hasFfmpeg() {
  if (ffmpegState !== null) return ffmpegState;
  try {
    await execFileAsync(FFMPEG, ['-version'], { windowsHide: true, timeout: 5000 });
    ffmpegState = true;
  } catch (e) {
    ffmpegState = false;
    console.warn(
      `[media] 没找到 ffmpeg（${FFMPEG}）：视频仍可播放，但不会生成封面帧。` +
        ` 装好后重启服务即可；也可以设置 FFMPEG_PATH 指向 exe。${e?.code ? ` (${e.code})` : ''}`
    );
  }
  return ffmpegState;
}

async function probeDuration(absPath) {
  try {
    const { stdout } = await execFileAsync(
      FFPROBE,
      ['-v', 'error', '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1', absPath],
      { windowsHide: true, timeout: 15000 }
    );
    const n = Number(String(stdout).trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

let posterWarned = false;

/**
 * 生成视频封面帧。
 * thumbRoot：缓存根目录（multi = data/thumbs/<owner>，local = data/thumbs）；列里存相对 thumbRoot 的文件名。
 */
async function makePoster(absPath, id, thumbRoot = CONFIG.thumbDir) {
  if (!(await hasFfmpeg())) return { poster: null, duration: null };
  mkdirSync(thumbRoot, { recursive: true });
  const out = join(thumbRoot, `${id}_poster.webp`);
  const duration = await probeDuration(absPath);
  // 先试第 1 秒（避开黑场），太短的视频退回首帧
  const attempts = [
    ['-y', '-ss', '1', '-i', absPath, '-frames:v', '1', '-vf', 'scale=400:-2', out],
    ['-y', '-ss', '0', '-i', absPath, '-frames:v', '1', '-vf', 'scale=400:-2', out],
  ];
  let lastErr = '';
  for (const args of attempts) {
    try {
      await execFileAsync(FFMPEG, args, { windowsHide: true, timeout: 120000 });
      if (existsSync(out)) return { poster: relative(thumbRoot, out), duration };
    } catch (e) {
      lastErr = String(e?.stderr || e?.message || e).slice(-400);
    }
  }
  if (!posterWarned) {
    posterWarned = true;
    console.warn(`[media] 封面帧生成失败（${basename(absPath)}）：${lastErr}`);
  }
  return { poster: null, duration };
}

/**
 * 统一的图片解码入口（D-307，2026-11-08）：HEIC / HEIF 先走 wasm 解成 JPEG buffer
 * 再交给 sharp；其它格式（jpg / png / webp / gif / bmp / avif …）直接走 sharp，
 * 行为与以前一致。返回 { img: sharp 实例, width, height }，宽高只在 HEIC 时给出
 * （解码后的真实像素尺寸；非 HEIC 沿用原来的 metadata 取值路径，不改旧行为）。
 */
async function imageSource(absPath) {
  if (isHeicExt(extname(absPath))) {
    const jpeg = await decodeHeicToJpeg(absPath);
    const meta = await sharp(jpeg, { failOn: 'none' }).metadata();
    return { img: sharp(jpeg, { failOn: 'none' }), width: meta.width ?? null, height: meta.height ?? null };
  }
  return { img: sharp(absPath, { failOn: 'none' }), width: null, height: null };
}

async function makeThumb(absPath, id, thumbRoot = CONFIG.thumbDir) {
  mkdirSync(thumbRoot, { recursive: true });
  const out = join(thumbRoot, `${id}.webp`);
  const src = await imageSource(absPath);
  const info = await src.img
    .rotate()
    .resize({ width: 400, height: 400, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 78 })
    .toFile(out);
  return { path: out, width: info.width, height: info.height, srcWidth: src.width, srcHeight: src.height };
}

async function ensurePreview(id, absPath, thumbRoot = CONFIG.thumbDir) {
  mkdirSync(thumbRoot, { recursive: true });
  const out = join(thumbRoot, `${id}_p.webp`);
  if (existsSync(out)) return out;
  const src = await imageSource(absPath);
  await src.img
    .rotate()
    .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82 })
    .toFile(out);
  return out;
}

function sendRange(req, reply, filePath, type) {
  const size = statSync(filePath).size;
  const range = req.headers.range;
  if (!range) {
    return reply
      .header('content-type', type)
      .header('content-length', size)
      .header('accept-ranges', 'bytes')
      .header('cache-control', 'private, max-age=3600')
      .send(createReadStream(filePath));
  }
  const m = /bytes=(\d*)-(\d*)/.exec(range) || [];
  let start = m[1] ? parseInt(m[1], 10) : 0;
  let end = m[2] ? parseInt(m[2], 10) : size - 1;
  if (start >= size) start = Math.max(0, size - 1);
  end = Math.min(end, size - 1);
  return reply
    .code(206)
    .header('content-range', `bytes ${start}-${end}/${size}`)
    .header('content-length', end - start + 1)
    .header('accept-ranges', 'bytes')
    .header('content-type', type)
    .send(createReadStream(filePath, { start, end }));
}

// ───────────── 基础 ─────────────

/**
 * /api/health 是唯一免登录的数据接口。
 * local 模式（默认）：字段与以前完全一致（前端「关于」页 / 启动文案依赖它）。
 * multi 模式按角色分层（M6 P2-4，D-205）：
 * - 未登录：只返回 ok / authMode（登录页不需要更多）；
 * - 普通用户：只返回自己的 Key 状态 + 自己的数据量，**不下发服务器绝对路径 / ffmpeg / 全局数据**；
 * - 管理员：额外返回数据目录 / 素材库 / ffmpeg / 全局数据量，供「关于」页管理视图。
 */
app.get('/api/health', async (req) => {
  const owner = ownerOf(req);
  if (CONFIG.authMode !== 'multi') {
    return {
      ok: true,
      hasTk: Boolean(CONFIG.tdtTk),
      mediaRoot: CONFIG.mediaRoot,
      dataDir: CONFIG.dataDir,
      version: appVersion(),
      mode: CONFIG.isDev ? 'dev' : 'prod',
      /** 账号模式（2026-11-06 M6 P2-1，D-200）：local = 单机无账号；multi = 云端多用户 */
      authMode: CONFIG.authMode,
      ffmpeg: await hasFfmpeg(),
      stats: stats(),
    };
  }
  // multi：未登录（登录页 / 探活）不暴露任何账号或服务器信息
  if (!owner) return { ok: true, authMode: CONFIG.authMode };
  const self = {
    ok: true,
    authMode: CONFIG.authMode,
    version: appVersion(),
    mode: CONFIG.isDev ? 'dev' : 'prod',
    hasTk: Boolean(tdtKeyFor(req)),
    stats: stats(owner),
  };
  if (req.authUser?.role !== 'admin') return self;
  return {
    ...self,
    mediaRoot: CONFIG.mediaRoot,
    dataDir: CONFIG.dataDir,
    ffmpeg: await hasFfmpeg(),
    /** 管理员额外看全局数据量（所有账号合计） */
    globalStats: stats(),
  };
});

// 前端启动时读：天地图 Key + 旧版「家坐标」（只用于一次性迁移成 place.home=1 地点）。
// multi 模式（D-202 / D-205）：Key 只返回当前账号自己的（D-182 每人自填；不回落全局），
// 没填时前端显示「配置天地图 Key」引导页；home 一律 null —— 家是 place.home=1 的地点。
app.get('/api/config', async (req) => {
  if (CONFIG.authMode !== 'multi') {
    return { tdtTk: CONFIG.tdtTk, home: CONFIG.home, maxUploadBytes: CONFIG.maxUploadBytes };
  }
  const st = getUserSetting(ownerOf(req));
  const ownTk = typeof st?.tdt_tk === 'string' ? st.tdt_tk.trim() : '';
  return { tdtTk: ownTk, home: null, maxUploadBytes: CONFIG.maxUploadBytes };
});

// 设置页写入天地图 Key（F-SYS-02 / M5）：只校验并保存，绝不回显 key、绝不写日志。
// 优先级：data/config.json 的 tdtTk > .env.local 的 TDT_TK（见 server/config.mjs）。
// multi 模式（D-202）：写当前账号 user_setting.tdt_tk，不碰全局 config.json。
app.post('/api/config/tdt-key', async (req, reply) => {
  const raw = req.body?.key;
  const key = typeof raw === 'string' ? raw.trim() : '';
  if (!/^[A-Za-z0-9]{32}$/.test(key)) {
    // 错误信息不含 key 本身
    return reply.code(400).send({ error: '天地图 Key 必须是 32 位字母或数字' });
  }
  if (CONFIG.authMode === 'multi') {
    const owner = ownerOf(req);
    try {
      saveUserSetting(owner, { tdt_tk: key });
    } catch {
      return reply.code(500).send({ error: '保存天地图 Key 失败，请稍后重试' });
    }
    return { ok: true, hasTk: true };
  }
  if (!setTdtKey(key)) {
    return reply.code(500).send({ error: '保存天地图 Key 失败，请检查 data/config.json 权限' });
  }
  return { ok: true, hasTk: true };
});

// 家的位置（M5.1）：单个坐标点，存 data/config.json.home；不再是地点属性、不参与聚合。
// 只接受数字经纬度；错误信息不含坐标以外的内容，也不写日志。
// multi 模式（D-202）：已废弃（家 = place.home=1），POST/DELETE 都返回 400。
app.post('/api/config/home', async (req, reply) => {
  if (CONFIG.authMode === 'multi') {
    return reply.code(400).send({ error: '云端多用户模式不再使用全局「家坐标」：家是 place.home=1 的地点' });
  }
  const lng = req.body?.lng;
  const lat = req.body?.lat;
  if (
    typeof lng !== 'number' ||
    typeof lat !== 'number' ||
    !Number.isFinite(lng) ||
    !Number.isFinite(lat) ||
    Math.abs(lng) > 180 ||
    Math.abs(lat) > 90
  ) {
    return reply.code(400).send({ error: '家的位置需要有效的经纬度' });
  }
  const home = setHome({ lng, lat });
  if (!home) {
    return reply.code(500).send({ error: '保存家的位置失败，请检查 data/config.json 权限' });
  }
  return { ok: true, home };
});

// 清除旧版「家坐标」（2026-11-04：家改为普通地点 place.home=1，客户端迁移完会调用）
// multi 模式（D-202）：已废弃 → 400（旧数据迁移由迁移脚本处理，不再走这个接口）。
app.delete('/api/config/home', async (req, reply) => {
  if (CONFIG.authMode === 'multi') {
    return reply.code(400).send({ error: '云端多用户模式不再使用全局「家坐标」：家是 place.home=1 的地点' });
  }
  clearHome();
  return { ok: true, home: null };
});

// ── 应用更新检查（2026-11-08 D-319）──
// 本地安装版：设置 → 关于 显示「是否有新版本」（只提示，不自动更新）。
// 云端不需要：服务器后台更新 + npm run build 后，用户刷新页面就是新版；这里仅管理员可查。
app.get('/api/update/check', async (req, reply) => {
  if (CONFIG.authMode === 'multi' && req.authUser?.role !== 'admin') {
    return reply.code(403).send({ error: '仅管理员可检查更新' });
  }
  return checkForUpdate();
});

// ───────────── 账号 / 会话 / 邀请码（2026-11-06 M6 P2-1，D-200）─────────────
// 只在 AUTH_MODE=multi（云端多用户）启用；AUTH_MODE=local（默认）下登录 / 注册返回 400，
// /api/auth/me 固定返回 { mode:'local', user:null }，旧行为完全不变。
// P2-2 起这里会扩展成「所有数据接口强制登录 + 按 user_id 隔离」。

/** 多用户模式必须登录：成功返回 publicUser，失败时已写好 401 响应并返回 null */
function requireAuth(req, reply) {
  if (CONFIG.authMode !== 'multi') {
    reply.code(400).send({ error: '本地模式没有账号（AUTH_MODE=multi 才启用登录）' });
    return null;
  }
  const user = req.authUser || userFromRequest(req);
  if (!user) {
    reply.code(401).send({ error: '请先登录' });
    return null;
  }
  return user;
}

/** 管理员接口：先登录再校验 role=admin（403） */
function requireAdmin(req, reply) {
  const user = requireAuth(req, reply);
  if (!user) return null;
  if (user.role !== 'admin') {
    reply.code(403).send({ error: '需要管理员权限' });
    return null;
  }
  return user;
}

/** 当前模式与登录用户（前端启动时先调它决定是否显示登录页） */
app.get('/api/auth/me', async (req) => ({ mode: CONFIG.authMode, user: userFromRequest(req) }));

/** 登录：按「IP + 用户名」限速；成功后下发 HttpOnly 会话 Cookie */
app.post('/api/auth/login', async (req, reply) => {
  if (CONFIG.authMode !== 'multi') {
    return reply.code(400).send({ error: '本地模式不需要登录（AUTH_MODE=multi 才启用账号）' });
  }
  if (!sameOrigin(req)) return reply.code(403).send({ error: '请求来源不合法' });
  const username = String(req.body?.username ?? '').trim();
  const password = String(req.body?.password ?? '');
  if (!username || !password) return reply.code(400).send({ error: '请输入用户名和密码' });
  const key = loginKey(req, username);
  const wait = loginLockRemaining(key);
  if (wait > 0) {
    return reply
      .code(429)
      .send({ error: `尝试次数过多，请 ${Math.ceil(wait / 60000)} 分钟后再试` });
  }
  const row = findUserByUsername(username);
  if (!row || row.status !== 'active' || !verifyPassword(row, password)) {
    recordLoginFailure(key);
    return reply.code(401).send({ error: '用户名或密码错误' });
  }
  clearLoginFailures(key);
  const { token, expiresAt } = createSession(row.id, {
    ip: req.ip,
    ua: req.headers['user-agent'],
  });
  db.prepare('UPDATE user SET last_login_at = ? WHERE id = ?').run(now(), row.id);
  return reply
    .header('set-cookie', sessionCookie(token, expiresAt))
    .send({ ok: true, user: publicUser({ ...row, last_login_at: now() }) });
});

/** 邀请码注册：一次性邀请码 → 建普通用户 → 直接登录（下发会话 Cookie） */
app.post('/api/auth/register', async (req, reply) => {
  if (CONFIG.authMode !== 'multi') {
    return reply.code(400).send({ error: '本地模式没有账号（AUTH_MODE=multi 才启用注册）' });
  }
  if (!sameOrigin(req)) return reply.code(403).send({ error: '请求来源不合法' });
  const body = req.body || {};
  try {
    const invite = findUsableInvite(body.inviteCode);
    const user = createUser({
      username: body.username,
      password: body.password,
      displayName: body.displayName,
      role: 'user',
    });
    try {
      consumeInvite(invite.id, user.id);
    } catch (e) {
      // 极端的并发抢码：把刚建的用户删掉，避免留下一个没有邀请码的账号
      db.prepare('DELETE FROM user WHERE id = ?').run(user.id);
      throw e;
    }
    const { token, expiresAt } = createSession(user.id, {
      ip: req.ip,
      ua: req.headers['user-agent'],
    });
    db.prepare('UPDATE user SET last_login_at = ? WHERE id = ?').run(now(), user.id);
    return reply
      .header('set-cookie', sessionCookie(token, expiresAt))
      .send({ ok: true, user: publicUser({ ...user, last_login_at: now() }) });
  } catch (e) {
    if (e instanceof AuthError) return reply.code(e.status || 400).send({ error: e.message });
    return reply.code(500).send({ error: '注册失败：' + (e?.message || String(e)) });
  }
});

/** 登出：删会话 + 清 Cookie（本地模式直接返回 ok，前端不会走到这里） */
app.post('/api/auth/logout', async (req, reply) => {
  if (!sameOrigin(req)) return reply.code(403).send({ error: '请求来源不合法' });
  if (CONFIG.authMode === 'multi') {
    const token = readCookie(req);
    if (token) destroySession(token);
  }
  return reply.header('set-cookie', clearSessionCookie()).send({ ok: true });
});

/** 修改自己的密码（需要旧密码） */
app.post('/api/auth/password', async (req, reply) => {
  const user = requireAuth(req, reply);
  if (!user) return;
  if (!sameOrigin(req)) return reply.code(403).send({ error: '请求来源不合法' });
  try {
    changePassword(user.id, req.body?.oldPassword, req.body?.newPassword);
    return { ok: true };
  } catch (e) {
    if (e instanceof AuthError) return reply.code(e.status || 400).send({ error: e.message });
    return reply.code(500).send({ error: '修改密码失败：' + (e?.message || String(e)) });
  }
});

// 管理员：邀请码管理（生成一次性码 / 列表 / 作废）
app.get('/api/admin/invites', async (req, reply) => {
  const admin = requireAdmin(req, reply);
  if (!admin) return;
  return { items: listInvites() };
});

app.post('/api/admin/invites', async (req, reply) => {
  const admin = requireAdmin(req, reply);
  if (!admin) return;
  if (!sameOrigin(req)) return reply.code(403).send({ error: '请求来源不合法' });
  try {
    const { invite, code } = createInvite(admin.id, {
      days: req.body?.days,
      note: req.body?.note,
    });
    return { invite, code };
  } catch (e) {
    if (e instanceof AuthError) return reply.code(e.status || 400).send({ error: e.message });
    return reply.code(500).send({ error: '生成邀请码失败' });
  }
});

app.delete('/api/admin/invites/:id', async (req, reply) => {
  const admin = requireAdmin(req, reply);
  if (!admin) return;
  if (!sameOrigin(req)) return reply.code(403).send({ error: '请求来源不合法' });
  try {
    revokeInvite(req.params.id);
    return { ok: true };
  } catch (e) {
    if (e instanceof AuthError) return reply.code(e.status || 400).send({ error: e.message });
    return reply.code(500).send({ error: '作废邀请码失败' });
  }
});

// 启动时初始化首个管理员（仅 multi 模式 + 空库 + 配置了 ADMIN_USERNAME/PASSWORD）
bootstrapAdmin();
// 清理过期会话（重启后顺手回收）
pruneSessions();

// ───────────── M6 P2-3：用量 / 管理后台 / 用户数据导出（仅 AUTH_MODE=multi）─────────────
// 全部 multi-only：local 模式由 requireAuth / requireAdmin 直接 400「本地模式没有账号」。
// 账号操作复用 P2-1 的 createUser / resetPassword；非 GET 的 CSRF 已由全局 preHandler 统一处理。

/** 自己的存储用量 + 配额（设置 → 账号；D-310 起云端按配额拦截上传，可申请扩容） */
app.get('/api/account/summary', async (req, reply) => {
  const user = requireAuth(req, reply);
  if (!user) return;
  return {
    user,
    quotaBytes: quotaBytesOf(user),
    usage: userUsage(user.id),
    pendingQuotaRequest: publicQuotaRequest(pendingQuotaRequest(user.id)),
  };
});

// ── 扩容申请（2026-11-08 D-310，用户要求「默认 1G 空间，可以申请扩容」）─────────
// multi-only（requireAuth 在 local 模式返回 400）。用户申请「把配额提高到 N 字节」，
// 管理员在设置 → 用户管理里批准 / 拒绝；同一时间最多一条 pending。

/** 申请理由的长度上限（字） */
const QUOTA_REASON_MAX = 200;

/** 我的配额 + 申请记录（设置 → 账号的「申请扩容」板块） */
app.get('/api/account/quota-requests', async (req, reply) => {
  const user = requireAuth(req, reply);
  if (!user) return;
  return {
    quotaBytes: quotaBytesOf(user),
    usedBytes: userUsage(user.id).mediaBytes,
    pending: publicQuotaRequest(pendingQuotaRequest(user.id)),
    history: listQuotaRequestsForUser(user.id, 10).map(publicQuotaRequest),
  };
});

/** 提交扩容申请：requestedBytes = 希望调整到的配额（字节） */
app.post('/api/account/quota-requests', async (req, reply) => {
  const user = requireAuth(req, reply);
  if (!user) return;
  const current = quotaBytesOf(user);
  const requested = Number(req.body?.requestedBytes);
  if (!Number.isInteger(requested) || requested <= 0) {
    return reply.code(400).send({ error: '要申请的空间必须是正整数（字节）' });
  }
  if (requested <= current) {
    return reply.code(400).send({ error: `申请的空间必须大于当前配额（${fmtBytes(current)}）` });
  }
  if (requested > QUOTA_MAX_BYTES) {
    return reply.code(400).send({ error: `申请不能超过 ${fmtBytes(QUOTA_MAX_BYTES)}` });
  }
  if (pendingQuotaRequest(user.id)) {
    return reply.code(409).send({ error: '你已有一条待审批的扩容申请，请等待管理员处理' });
  }
  const reason = String(req.body?.reason ?? '').trim().slice(0, QUOTA_REASON_MAX);
  const row = insertQuotaRequest({
    id: randomUUID(),
    userId: user.id,
    requestedBytes: requested,
    currentBytes: current,
    reason,
  });
  return { ok: true, request: publicQuotaRequest(row) };
});

/** 取消自己的待审批申请 */
app.delete('/api/account/quota-requests/:id', async (req, reply) => {
  const user = requireAuth(req, reply);
  if (!user) return;
  if (!cancelQuotaRequest(req.params.id, user.id)) {
    return reply.code(404).send({ error: '没有找到这条待审批的申请' });
  }
  return { ok: true };
});

// ── 账号头像（2026-11-07 D-224，用户要求：顶栏显示头像 + 名称）─────────────
// multi-only（local 模式没有账号，requireAuth 会返回 400）；只读写当前登录账号自己的头像。

/** 当前账号头像（webp；没有上传过则 404，前端显示首字母占位） */
app.get('/api/account/avatar', async (req, reply) => {
  const user = requireAuth(req, reply);
  if (!user) return;
  const p = avatarPathFor(user.id);
  if (!existsSync(p)) return reply.code(404).send({ error: '没有头像' });
  return reply
    .header('content-type', 'image/webp')
    .header('cache-control', 'private, max-age=86400')
    .send(createReadStream(p));
});

/** 上传 / 替换自己的头像：图片先经 sharp 统一成 128×128 webp（10MB 上限） */
app.post('/api/account/avatar', async (req, reply) => {
  const user = requireAuth(req, reply);
  if (!user) return;
  let part;
  try {
    part = await req.file({ limits: { fileSize: AVATAR_MAX_BYTES } });
  } catch {
    return reply.code(413).send({ error: '图片太大，请选择 10MB 以内的图片' });
  }
  if (!part) return reply.code(400).send({ error: '请选择图片文件' });
  const ext = extname(part.filename || '').toLowerCase();
  if (!PHOTO_EXT.has(ext)) {
    part.file.resume();
    return reply
      .code(400)
      .send({ error: '头像只支持图片文件（jpg / png / webp / gif / avif / heic）' });
  }
  let buf;
  try {
    buf = await part.toBuffer();
  } catch {
    return reply.code(413).send({ error: '图片太大，请选择 10MB 以内的图片' });
  }
  if (!buf?.length) return reply.code(400).send({ error: '空文件' });
  mkdirSync(avatarDir(), { recursive: true });
  const tmp = join(avatarDir(), `${user.id}.${randomUUID()}.tmp`);
  try {
    // D-307：HEIC 头像也要能传——先 wasm 解成 JPEG，再统一 128×128 webp
    const avatarSrc = isHeicExt(ext)
      ? sharp(await decodeHeicToJpeg(buf), { failOn: 'none' })
      : sharp(buf, { failOn: 'none' });
    await avatarSrc
      .rotate()
      .resize({ width: 128, height: 128, fit: 'cover' })
      .webp({ quality: 82 })
      .toFile(tmp);
    renameSync(tmp, avatarPathFor(user.id));
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    return reply.code(400).send({ error: '无法读取这个图片，请换一张试试' });
  }
  const ts = now();
  db.prepare('UPDATE user SET avatar_updated_at = ? WHERE id = ?').run(ts, user.id);
  return { ok: true, avatarUpdatedAt: ts };
});

/** 修改自己的显示名（2026-11-07 D-224 追加：顶栏头像旁的名称） */
app.patch('/api/account/profile', async (req, reply) => {
  const user = requireAuth(req, reply);
  if (!user) return;
  try {
    const row = updateOwnDisplayName(user.id, req.body?.displayName);
    return { ok: true, user: publicUser(row) };
  } catch (e) {
    if (e instanceof AuthError) return reply.code(e.status || 400).send({ error: e.message });
    return reply.code(500).send({ error: '保存显示名失败：' + (e?.message || String(e)) });
  }
});

/** 管理员：全部账号 + 用量（回收站里还没彻底删除的媒体也计入磁盘占用） */
app.get('/api/admin/users', async (req, reply) => {
  const admin = requireAdmin(req, reply);
  if (!admin) return;
  return { items: listUsersWithUsage() };
});

/**
 * 管理员：改显示名 / 启用禁用 / 存储配额（quotaBytes=0 表示回落到服务端默认，D-310 起默认 1 GiB）。
 * 2026-11-08（D-310）：配额重新生效（云端 multi 上传按配额拦截）；管理员在这里直接改配额时，
 * 该账号待审批的扩容申请会按新配额自动结案（approved），避免重复审批。
 */
app.patch('/api/admin/users/:id', async (req, reply) => {
  const admin = requireAdmin(req, reply);
  if (!admin) return;
  try {
    const body = req.body || {};
    const row = updateUserByAdmin(admin.id, req.params.id, body);
    if (Object.prototype.hasOwnProperty.call(body, 'quotaBytes')) {
      resolvePendingQuotaRequests(row.id, {
        approvedBytes: quotaBytesOf(publicUser(row)),
        decidedBy: admin.id,
        adminNote: '管理员在用户管理中直接调整了配额',
      });
    }
    const usage = userUsage(row.id);
    return { ok: true, user: { ...publicUser(row), usedBytes: usage.mediaBytes, usage } };
  } catch (e) {
    if (e instanceof AuthError) return reply.code(e.status || 400).send({ error: e.message });
    return reply.code(500).send({ error: '修改账号失败：' + (e?.message || String(e)) });
  }
});

/** 管理员：扩容申请列表（默认 pending；?status=all 查看全部） */
app.get('/api/admin/quota-requests', async (req, reply) => {
  const admin = requireAdmin(req, reply);
  if (!admin) return;
  const statusRaw = String(req.query?.status ?? 'pending');
  const status = ['pending', 'approved', 'rejected', 'cancelled'].includes(statusRaw)
    ? statusRaw
    : null;
  return { items: listQuotaRequests({ status, limit: 200 }).map(publicQuotaRequest) };
});

/**
 * 管理员：批准 / 拒绝扩容申请。
 * - approve：可带 quotaBytes（不传 = 按用户申请值）；批准后写回 user.quota_bytes；
 * - reject：只改状态，可带 note。
 */
app.patch('/api/admin/quota-requests/:id', async (req, reply) => {
  const admin = requireAdmin(req, reply);
  if (!admin) return;
  const row = getQuotaRequest(req.params.id);
  if (!row) return reply.code(404).send({ error: '申请不存在' });
  if (row.status !== 'pending') return reply.code(409).send({ error: '这条申请已经处理过了' });
  const action = String(req.body?.action || '').toLowerCase();
  const note = String(req.body?.note ?? '').trim().slice(0, QUOTA_REASON_MAX) || null;
  try {
    if (action === 'approve') {
      const target = Number(req.body?.quotaBytes ?? row.requested_bytes);
      if (!Number.isInteger(target) || target <= row.current_bytes) {
        return reply
          .code(400)
          .send({ error: '批准后的配额必须是大于当前配额的整数（字节）' });
      }
      if (target > QUOTA_MAX_BYTES) {
        return reply.code(400).send({ error: `配额不能超过 ${fmtBytes(QUOTA_MAX_BYTES)}` });
      }
      db.prepare('UPDATE user SET quota_bytes = ? WHERE id = ?').run(target, row.user_id);
      const updated = decideQuotaRequest(row.id, {
        status: 'approved',
        approvedBytes: target,
        decidedBy: admin.id,
        adminNote: note,
      });
      return { ok: true, request: publicQuotaRequest(updated), quotaBytes: target };
    }
    if (action === 'reject') {
      const updated = decideQuotaRequest(row.id, {
        status: 'rejected',
        approvedBytes: null,
        decidedBy: admin.id,
        adminNote: note,
      });
      return { ok: true, request: publicQuotaRequest(updated) };
    }
    return reply.code(400).send({ error: 'action 只能是 approve / reject' });
  } catch (e) {
    return reply.code(500).send({ error: '处理扩容申请失败：' + (e?.message || String(e)) });
  }
});

/** 管理员：重置任意账号的登录密码（不需要旧密码；新密码规则在 auth.resetPassword 里校验） */
app.post('/api/admin/users/:id/password', async (req, reply) => {
  const admin = requireAdmin(req, reply);
  if (!admin) return;
  try {
    resetPassword(req.params.id, req.body?.newPassword);
    return { ok: true };
  } catch (e) {
    if (e instanceof AuthError) return reply.code(e.status || 400).send({ error: e.message });
    return reply.code(500).send({ error: '重置密码失败：' + (e?.message || String(e)) });
  }
});

/**
 * 导出自己的数据（P2-3）：临时 zip → 流式下载 → 响应结束后删临时文件。
 * thumbs 默认包含（=0 排除）；media 需显式 =1（体积大，交由前端勾选，与备份导出口径一致）。
 * 中文文件名走 RFC 5987 filename*，同时给 ASCII fallback 兼容旧客户端。
 */
app.get('/api/account/export', async (req, reply) => {
  const user = requireAuth(req, reply);
  if (!user) return;
  const q = req.query || {};
  const includeThumbs = String(q.thumbs ?? '1') !== '0';
  const includeMedia = String(q.media ?? '0') === '1';

  let built;
  try {
    built = await buildUserExportZip({ ownerId: user.id, includeThumbs, includeMedia });
  } catch (e) {
    if (e instanceof ZipError || e instanceof AuthError || e instanceof UserExportError) {
      return reply.code(e.status || 400).send({ error: e.message });
    }
    return reply.code(500).send({ error: '导出失败：' + (e?.message || String(e)) });
  }

  // 响应结束后删临时 zip（finish / close / 流 close 任一先到都行；Windows 上句柄没释放时下一个事件再试）
  const zipPath = built.zipPath;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    try {
      unlinkSync(zipPath);
      cleaned = true;
    } catch {
      /* 句柄可能还占着：交给下一个事件重试；删不掉也不影响这次下载 */
    }
  };
  const stream = createReadStream(zipPath);
  stream.once('close', cleanup);
  stream.once('error', cleanup);
  reply.raw.once('finish', cleanup);
  reply.raw.once('close', cleanup);

  const filename = userExportFileName(user.displayName, user.username);
  return reply
    .header('content-type', 'application/zip')
    .header('content-length', built.size)
    .header(
      'content-disposition',
      `attachment; filename="user-export.zip"; filename*=UTF-8''${encodeURIComponent(filename)}`
    )
    .send(stream);
});

/**
 * 从「我的数据导出」zip 恢复（2026-11-07 D-210，普通用户自己恢复自己的数据）：
 * 第一步上传 zip → 全套校验 → 返回 10 分钟有效的 token + 摘要。
 * multi-only：local 模式本来就有完整的「备份与恢复」（管理员整库恢复），不需要这个接口。
 */
app.post('/api/account/restore/inspect', async (req, reply) => {
  const user = requireAuth(req, reply);
  if (!user) return;

  const declaredBytes = Number(req.headers['content-length']);
  if (Number.isFinite(declaredBytes) && declaredBytes > 0) {
    if (declaredBytes > BACKUP_UPLOAD_MAX_BYTES) {
      return reply.code(400).send({
        error: `备份包超过上限（${(BACKUP_UPLOAD_MAX_BYTES / 1024 ** 3).toFixed(0)} GB）`,
      });
    }
    try {
      const st = statfsSync(resolve(CONFIG.dataDir));
      const available = Number(st.bavail) * Number(st.bsize);
      if (Number.isFinite(available) && available < declaredBytes + 200 * 1024 * 1024) {
        return reply.code(400).send({
          error: `磁盘空间不足：读取备份包需要约 ${(declaredBytes / 1024 ** 3).toFixed(2)} GB（另需预留 200 MB），当前可用 ${(available / 1024 ** 3).toFixed(2)} GB`,
        });
      }
    } catch {
      /* statfs 不可用就交给写入失败兜底 */
    }
  }

  let part;
  try {
    part = await req.file({ limits: { fileSize: BACKUP_UPLOAD_MAX_BYTES } });
  } catch (e) {
    return reply.code(400).send({ error: '无法读取上传的备份包：' + (e?.message || e) });
  }
  if (!part) return reply.code(400).send({ error: '缺少备份包文件（multipart 字段名 file）' });
  if (part.fieldname !== 'file') {
    part.file.resume();
    return reply.code(400).send({ error: '备份文件字段名必须是 file' });
  }

  const zipPath = newTmpZipPath('user-restore');
  try {
    await pipeline(part.file, createWriteStream(zipPath));
    if (part.file.truncated) {
      throw new UserRestoreError(
        400,
        `备份包超过上限（${(BACKUP_UPLOAD_MAX_BYTES / 1024 ** 3).toFixed(0)} GB）`
      );
    }
    const inspected = await inspectUserBackupZip(zipPath, user);
    const tokenInfo = storeUserRestoreToken(zipPath, inspected.summary, user.id);
    return { token: tokenInfo.token, expiresAt: tokenInfo.expiresAt, summary: inspected.summary };
  } catch (e) {
    try {
      unlinkSync(zipPath);
    } catch {
      /* ignore */
    }
    if (e instanceof UserRestoreError) return reply.code(e.status || 400).send({ error: e.message });
    if (e instanceof ZipError) return reply.code(400).send({ error: e.message });
    return reply.code(400).send({ error: '备份包校验失败：' + (e?.message || String(e)) });
  }
});

/** 从「我的数据导出」zip 恢复（D-210）：第二步带 token + confirm:true 执行；只替换当前账号自己的数据 */
app.post('/api/account/restore/apply', async (req, reply) => {
  const user = requireAuth(req, reply);
  if (!user) return;
  const body = req.body || {};
  try {
    return await restoreUserBackup({ token: body.token, confirm: body.confirm === true, user });
  } catch (e) {
    if (e instanceof UserRestoreError) {
      return reply.code(e.status || 500).send({ error: e.message });
    }
    if (e instanceof BackupError) return reply.code(e.status || 500).send({ error: e.message });
    return reply
      .code(500)
      .send({ error: '恢复失败，已回滚，当前数据保持原样：' + (e?.message || String(e)) });
  }
});

// ───────────── 地名搜索（服务端代理） ─────────────
// 为什么放服务端：天地图的 key 是浏览器端类型、QPS 很低，
// 放服务端才能统一限速、重试、缓存，也便于排查问题。

app.get('/api/search', async (req, reply) => {
  const q = String(req.query?.q || '').trim();
  if (!q) return { results: [] };
  // multi 模式（D-205）：搜索要用「当前账号自己的」天地图 Key；没填时明确提示去设置里填
  if (CONFIG.authMode === 'multi' && !tdtKeyFor(req)) {
    return reply.code(400).send({ error: NEED_OWN_TDT_KEY, needTdtKey: true });
  }
  try {
    return { results: await searchPlace(q, tdtKeyFor(req)) };
  } catch (e) {
    return { results: [], error: e.message };
  }
});

app.get('/api/reverse', async (req, reply) => {
  const lng = Number(req.query?.lng);
  const lat = Number(req.query?.lat);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
    return { address: null, error: '坐标无效' };
  }
  if (CONFIG.authMode === 'multi' && !tdtKeyFor(req)) {
    return reply.code(400).send({ error: NEED_OWN_TDT_KEY, needTdtKey: true });
  }
  try {
    return { address: await reverseGeocode(lng, lat, tdtKeyFor(req)) };
  } catch (e) {
    return { address: null, error: e.message };
  }
});

// ───────────── 地点 ─────────────
// M6 P2-2（D-202）：所有数据接口把 owner 传给数据层（multi = 登录用户 id；local = null 保持旧行为）。

app.get('/api/places', async (req) =>
  listPlaces(
    String(req.query?.q || '').trim(),
    String(req.query?.companion || '').trim(),
    ownerOf(req)
  )
);

// 时间轴过滤（F-BRW-03）：只返回区间内有到访的地点
app.get('/api/map/visits', async (req) => {
  const from = String(req.query?.from || '0000-00-00');
  const to = String(req.query?.to || '9999-12-31');
  return placesInRange(from, to, String(req.query?.companion || '').trim(), ownerOf(req));
});

// 时间轴刻度：首末日期 + 按季度的到访数
app.get('/api/timeline', async (req) => timeline(ownerOf(req)));

// ───────────── M3：统计 / 照片墙 / 随行人员 / 秘密基地 ─────────────

/** F-STA 统计（D-60）：按筛选 / 粒度 / 分组；默认全量 */
app.get('/api/stats', async (req, reply) => {
  const parsed = parseStatsQuery(req.query || {});
  if (parsed.error) return reply.code(400).send({ error: parsed.error });
  return buildStats(parsed.value, ownerOf(req));
});

/** 省份点亮（F-STA-01）：全量口径，独立于统计面板筛选 */
app.get('/api/stats/provinces', async (req) => provinceLight(ownerOf(req)));

/** 照片墙（F-BRW-04） */
app.get('/api/photos', async (req, reply) => {
  const parsed = parsePhotosQuery(req.query || {});
  if (parsed.error) return reply.code(400).send({ error: parsed.error });
  return buildPhotos(parsed.value, ownerOf(req));
});

/** 随行人员聚合（F-BRW-06） */
app.get('/api/companions', async (req) => ({ items: listCompanions(ownerOf(req)) }));

/** 秘密基地（F-PLC-11）：状态 / 设置修改清除密码 / 验证（密码按账号存 user_setting，D-202） */
app.get('/api/secret/status', async (req) => secretStatus(ownerOf(req)));

app.post('/api/secret/password', async (req, reply) => {
  const r = setSecretPassword(req.body || {}, ownerOf(req));
  return reply.code(r.status).send(r.body);
});

app.post('/api/secret/verify', async (req, reply) => {
  const r = verifySecret(req.body || {}, ownerOf(req));
  return reply.code(r.status).send(r.body);
});

app.post('/api/places', async (req, reply) => {
  const b = req.body || {};
  if (!Number.isFinite(b.lng) || !Number.isFinite(b.lat)) {
    return reply.code(400).send({ error: '坐标无效' });
  }
  const owner = ownerOf(req);
  const id = randomUUID();
  const t = now();
  const date = typeof b.date === 'string' && b.date ? b.date : new Date().toISOString().slice(0, 10);
  const kind = b.kind === 'wishlist' ? 'wishlist' : 'visited';

  db.prepare(`
    INSERT INTO place (id,user_id,name,lng,lat,province,city,county,province_code,city_code,county_code,kind,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    id, owner, String(b.name || '').trim() || '未命名地点', b.lng, b.lat,
    b.province ?? null, b.city ?? null, b.county ?? null,
    b.province_code ?? null, b.city_code ?? null, b.county_code ?? null,
    kind, t, t
  );

  // 只有「去过」才自动建一条到访。
  // 「想去」只是计划，建了空到访会让侧栏显示「去过 1 次」、还会污染时间轴和统计（D-31）。
  if (kind === 'visited') {
    db.prepare(
      'INSERT INTO visit (id,user_id,place_id,date,title,created_at,updated_at) VALUES (?,?,?,?,?,?,?)'
    ).run(randomUUID(), owner, id, date, b.title ?? null, t, t);
  }

  return getPlace(id, owner);
});

app.get('/api/places/:id', async (req, reply) => {
  const owner = ownerOf(req);
  const p = getPlace(req.params.id, owner);
  return p || reply.code(404).send({ error: 'not found' });
});

app.patch('/api/places/:id', async (req, reply) => {
  const b = req.body || {};
  const owner = ownerOf(req);
  // multi：带 owner 过滤 —— 别的账号的地点当作不存在（404，不泄露存在性，D-202）
  const p = db
    .prepare(`SELECT * FROM place WHERE id=? AND deleted_at IS NULL${ownerSql(owner)}`)
    .get(...ownerArgs(owner, req.params.id));
  if (!p) return reply.code(404).send({ error: 'not found' });

  // F-PLC-11：secret 只接受 true/1 → 1，false/0 → 0
  const secret =
    b.secret === undefined
      ? Number(p.secret) || 0
      : b.secret === true || b.secret === 1 || b.secret === '1'
        ? 1
        : 0;

  // F-PLC-12：home 只接受 true/false/1/0，归一成 0/1；其它值 400
  let home;
  if (b.home === undefined) home = Number(p.home) || 0;
  else if (b.home === true || b.home === 1) home = 1;
  else if (b.home === false || b.home === 0) home = 0;
  else return reply.code(400).send({ error: 'home 必须是布尔值' });

  // 「家」现在是普通地点（只有一个，home=1）：允许顶栏「家」重新打点时更新坐标。
  // 已有地点的拖动编辑仍然不做（D-21），这里只给家的重定位用。
  let lng = p.lng;
  let lat = p.lat;
  if (b.lng !== undefined || b.lat !== undefined) {
    const nlng = b.lng === undefined ? Number(p.lng) : Number(b.lng);
    const nlat = b.lat === undefined ? Number(p.lat) : Number(b.lat);
    if (
      typeof (b.lng === undefined ? 0 : b.lng) !== 'number' ||
      typeof (b.lat === undefined ? 0 : b.lat) !== 'number' ||
      !Number.isFinite(nlng) ||
      !Number.isFinite(nlat) ||
      Math.abs(nlng) > 180 ||
      Math.abs(nlat) > 90
    ) {
      return reply.code(400).send({ error: 'lng / lat 必须是有效经纬度' });
    }
    lng = nlng;
    lat = nlat;
  }

  // 地区信息补全（2026-11-04）：只接受字符串 / null，缺省保持原值。
  // 用于把旧数据里空的省/市/区按坐标重新识别后写回（修复 My旅迹里的「未标注」）。
  const REGION_FIELDS = {
    province: 64,
    city: 64,
    county: 64,
    province_code: 32,
    city_code: 32,
    county_code: 32,
  };
  const region = {};
  for (const [key, max] of Object.entries(REGION_FIELDS)) {
    if (b[key] === undefined) {
      region[key] = p[key];
      continue;
    }
    if (b[key] === null || b[key] === '') {
      region[key] = null;
      continue;
    }
    if (typeof b[key] !== 'string') {
      return reply.code(400).send({ error: `${key} 必须是字符串` });
    }
    const v = b[key].trim();
    if (v.length > max) return reply.code(400).send({ error: `${key} 太长` });
    region[key] = v || null;
  }

  // multi：封面必须是当前账号自己的媒体；跨用户引用一律 404（不泄露存在性，D-202）
  const coverMediaId = b.cover_media_id !== undefined ? b.cover_media_id : p.cover_media_id;
  if (owner && coverMediaId) {
    const cm = db.prepare('SELECT user_id FROM media WHERE id = ?').get(coverMediaId);
    if (!cm || cm.user_id !== owner) return reply.code(404).send({ error: 'not found' });
  }

  const t = now();
  // 「家」只能有一个：设置某个地点为家时，把其它活着的家的标记清掉
  // multi：只清当前账号的旧家（别的账号的家不动，D-202）
  if (home === 1) {
    db.prepare(
      `UPDATE place SET home=0, updated_at=? WHERE id<>? AND home=1${ownerSql(owner)}`
    ).run(...ownerArgs(owner, t, p.id));
  }

  db.prepare(
    `UPDATE place SET name=?, kind=?, cover_media_id=?, secret=?, home=?, lng=?, lat=?,
       province=?, city=?, county=?, province_code=?, city_code=?, county_code=?, updated_at=?
     WHERE id=?`
  ).run(
    b.name ?? p.name,
    b.kind ?? p.kind,
    coverMediaId,
    secret,
    home,
    lng,
    lat,
    region.province,
    region.city,
    region.county,
    region.province_code,
    region.city_code,
    region.county_code,
    t,
    p.id
  );
  return getPlace(p.id, owner);
});

app.delete('/api/places/:id', async (req, reply) => {
  const owner = ownerOf(req);
  const p = db
    .prepare(`SELECT id FROM place WHERE id = ? AND deleted_at IS NULL${ownerSql(owner)}`)
    .get(...ownerArgs(owner, req.params.id));
  if (!p) return reply.code(404).send({ error: 'not found' });
  const t = now();
  db.prepare('UPDATE place SET deleted_at=?, updated_at=? WHERE id=?').run(t, t, p.id);
  // 只给「当前还没删」的到访打时间戳：之前单独删掉的到访保留原删除时间，
  // 这样回收站恢复地点时不会把它们顺手复活（F-SYS-07）。
  db.prepare(
    `UPDATE visit SET deleted_at=?, updated_at=? WHERE place_id=? AND deleted_at IS NULL${ownerSql(owner)}`
  ).run(...ownerArgs(owner, t, t, p.id));
  // 地点下的媒体一起进回收站（只动还没删的，保留更早单独删除的时间戳）
  db.prepare(`
    UPDATE media SET deleted_at = ?
    WHERE deleted_at IS NULL
      AND visit_id IN (SELECT id FROM visit WHERE place_id = ?)${ownerSql(owner)}
  `).run(...ownerArgs(owner, t, p.id));
  return { ok: true };
});

// 合并重复地点（F-PLC-08）：把 fromId 的到访全部迁到 intoId，来源地点软删。
// 保留目标地点的名称 / 坐标（D-28）；省/市不一致要前端二次确认（force）。
// multi（D-202）：两个地点都必须是当前账号的，否则 404。
app.post('/api/places/merge', async (req, reply) => {
  const b = req.body || {};
  const fromId = String(b.fromId || '');
  const intoId = String(b.intoId || '');
  const force = Boolean(b.force);
  if (!fromId || !intoId || fromId === intoId) {
    return reply.code(400).send({ error: '源地点和目标地点无效' });
  }
  const owner = ownerOf(req);
  const from = db
    .prepare(`SELECT * FROM place WHERE id = ? AND deleted_at IS NULL${ownerSql(owner)}`)
    .get(...ownerArgs(owner, fromId));
  const into = db
    .prepare(`SELECT * FROM place WHERE id = ? AND deleted_at IS NULL${ownerSql(owner)}`)
    .get(...ownerArgs(owner, intoId));
  if (!from || !into) return reply.code(404).send({ error: '地点不存在或已删除' });
  if (from.kind !== into.kind) {
    return reply
      .code(400)
      .send({ error: '两个地点类型不同（去过 / 想去），先把类型改成一致再合并' });
  }
  const provDiff =
    from.province_code && into.province_code && from.province_code !== into.province_code;
  const cityDiff = from.city_code && into.city_code && from.city_code !== into.city_code;
  if ((provDiff || cityDiff) && !force) {
    return reply.code(409).send({
      error: '两个地点的省/市不一致，请确认不是误合并',
      needConfirm: true,
      from: { name: from.name, province: from.province, city: from.city, county: from.county },
      into: { name: into.name, province: into.province, city: into.city, county: into.county },
    });
  }
  const t = now();
  try {
    db.exec('BEGIN');
    // 连软删的到访也一起迁，保留将来回收站恢复时的归属
    db.prepare(
      `UPDATE visit SET place_id = ?, updated_at = ? WHERE place_id = ?${ownerSql(owner)}`
    ).run(...ownerArgs(owner, into.id, t, from.id));
    // 目标没有封面时继承来源封面（来源软删后那张图仍属于迁过来的到访）
    if (!into.cover_media_id && from.cover_media_id) {
      db.prepare('UPDATE place SET cover_media_id = ?, updated_at = ? WHERE id = ?').run(
        from.cover_media_id,
        t,
        into.id
      );
    }
    // F-PLC-11：合并后只要有一边是秘密基地，目标就是秘密基地（OR，取 1）
    const mergedSecret = Number(from.secret) || Number(into.secret) ? 1 : 0;
    if (mergedSecret !== (Number(into.secret) || 0)) {
      db.prepare('UPDATE place SET secret = ?, updated_at = ? WHERE id = ?').run(
        mergedSecret,
        t,
        into.id
      );
    }
    // F-PLC-12：合并后只要有一边是「家」，目标就是「家」（OR，取 1）
    const mergedHome = Number(from.home) || Number(into.home) ? 1 : 0;
    if (mergedHome !== (Number(into.home) || 0)) {
      db.prepare('UPDATE place SET home = ?, updated_at = ? WHERE id = ?').run(
        mergedHome,
        t,
        into.id
      );
    }
    db.prepare('UPDATE place SET deleted_at = ?, updated_at = ? WHERE id = ?').run(t, t, from.id);
    db.exec('COMMIT');
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    return reply.code(500).send({ error: '合并失败：' + e.message });
  }
  return { ok: true, fromId: from.id, place: getPlace(into.id, owner) };
});

app.post('/api/places/:id/visits', async (req, reply) => {
  const b = req.body || {};
  const owner = ownerOf(req);
  const p = db
    .prepare(`SELECT id FROM place WHERE id=? AND deleted_at IS NULL${ownerSql(owner)}`)
    .get(...ownerArgs(owner, req.params.id));
  if (!p) return reply.code(404).send({ error: 'not found' });
  const t = now();
  const vid = randomUUID();
  const companions = Array.isArray(b.companions)
    ? JSON.stringify(b.companions.map((s) => String(s).trim()).filter(Boolean))
    : null;
  db.prepare(`
    INSERT INTO visit (id,user_id,place_id,date,title,note,rating,companions,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(vid, owner, p.id, b.date || new Date().toISOString().slice(0, 10),
         b.title ?? null, b.note ?? null, b.rating ?? null, companions, t, t);
  return getPlace(p.id, owner);
});

// 编辑到访（F-VST-03）：日期 / 标题 / 笔记 / 评分 / 同行人
// multi（D-202）：别的账号的到访一律 404。
app.patch('/api/visits/:id', async (req, reply) => {
  const owner = ownerOf(req);
  const v = db
    .prepare(`SELECT * FROM visit WHERE id = ? AND deleted_at IS NULL${ownerSql(owner)}`)
    .get(...ownerArgs(owner, req.params.id));
  if (!v) return reply.code(404).send({ error: 'not found' });
  const b = req.body || {};
  const companions = Array.isArray(b.companions)
    ? JSON.stringify(b.companions.map((s) => String(s).trim()).filter(Boolean))
    : v.companions;
  db.prepare(`
    UPDATE visit SET date=?, title=?, note=?, rating=?, companions=?, updated_at=? WHERE id=?
  `).run(
    typeof b.date === 'string' && b.date ? b.date : v.date,
    b.title !== undefined ? b.title : v.title,
    b.note !== undefined ? b.note : v.note,
    b.rating !== undefined ? (b.rating === null ? null : Number(b.rating)) : v.rating,
    companions,
    now(),
    v.id
  );
  return getPlace(v.place_id, owner);
});

// 删除到访（F-VST-04）：软删，连同这次到访的媒体记录一起软删（文件不动）
app.delete('/api/visits/:id', async (req, reply) => {
  const owner = ownerOf(req);
  const v = db
    .prepare(`SELECT * FROM visit WHERE id = ? AND deleted_at IS NULL${ownerSql(owner)}`)
    .get(...ownerArgs(owner, req.params.id));
  if (!v) return reply.code(404).send({ error: 'not found' });
  const t = now();
  db.prepare('UPDATE visit SET deleted_at = ? WHERE id = ?').run(t, v.id);
  db.prepare('UPDATE media SET deleted_at = ? WHERE visit_id = ? AND deleted_at IS NULL').run(t, v.id);
  const left = db.prepare(
    'SELECT COUNT(*) AS n FROM visit WHERE place_id = ? AND deleted_at IS NULL'
  ).get(v.place_id).n;
  // lastVisit === true 时前端会问「要不要连地点一起删」
  return { ok: true, placeId: v.place_id, lastVisit: left === 0 };
});

// ───────────── 回收站（F-SYS-07 / D-57）─────────────
// 按「删除动作」分层：父级删除只带走当时还活着的子项；此前单独删的子项留在原层级。
// 恢复父级可选 restoreEarlier；彻底删除总是删 B 文件 + 缓存（D-56）。A 原件永远不动。

/** 校验并去重 { items: [{ type, id, restoreEarlier? }] } */
function parseTrashItems(body) {
  const raw = Array.isArray(body?.items) ? body.items : [];
  if (!raw.length) return { error: '请选择要处理的项目' };
  const seen = new Set();
  const items = [];
  for (const it of raw) {
    const type = String(it?.type || '');
    const id = String(it?.id || '');
    if (type !== 'place' && type !== 'visit' && type !== 'media') {
      return { error: '项目类型无效' };
    }
    if (!id) return { error: '项目 id 无效' };
    const key = `${type}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ type, id, restoreEarlier: it?.restoreEarlier === true });
  }
  return { items };
}

const trashErr = (status, message) => {
  const e = new Error(message);
  e.status = status;
  return e;
};

// 回收站查询都要带 owner（multi 下别的账号的条目当作不存在 → 404，D-202）；
// owner = null 时 SQL 与旧版一致。
function getTrashPlace(id, owner = null) {
  return db
    .prepare(`SELECT * FROM place WHERE id = ? AND deleted_at IS NOT NULL${ownerSql(owner)}`)
    .get(...ownerArgs(owner, id));
}

function getTrashVisit(id, owner = null) {
  return db.prepare(`
    SELECT v.*, p.deleted_at AS place_deleted_at
    FROM visit v JOIN place p ON p.id = v.place_id
    WHERE v.id = ? AND v.deleted_at IS NOT NULL${ownerSql(owner, 'v.user_id')}
  `).get(...ownerArgs(owner, id));
}

function getTrashMedia(id, owner = null) {
  return db.prepare(`
    SELECT m.*, v.deleted_at AS visit_deleted_at, p.deleted_at AS place_deleted_at
    FROM media m
    JOIN visit v ON v.id = m.visit_id
    JOIN place p ON p.id = v.place_id
    WHERE m.id = ? AND m.deleted_at IS NOT NULL${ownerSql(owner, 'm.user_id')}
  `).get(...ownerArgs(owner, id));
}

/**
 * 收集彻底删除要处理的媒体记录。
 * 地点 = 其下全部到访的媒体；到访 = 它自己的媒体；媒体 = 那一条。
 */
function collectTrashMedia(placeIds, visitIds, mediaRows) {
  const byId = new Map();
  for (const m of mediaRows) byId.set(m.id, m);
  if (placeIds.length) {
    const ph = placeIds.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT m.* FROM media m JOIN visit v ON v.id = m.visit_id
      WHERE v.place_id IN (${ph})
    `).all(...placeIds);
    for (const r of rows) byId.set(r.id, r);
  }
  if (visitIds.length) {
    const ph = visitIds.map(() => '?').join(',');
    const rows = db.prepare(`SELECT * FROM media WHERE visit_id IN (${ph})`).all(...visitIds);
    for (const r of rows) byId.set(r.id, r);
  }
  return [...byId.values()];
}

/**
 * 彻底删除时删素材库原片 + 缩略图/1600 预览/视频封面帧缓存（D-56：这一动作总是释放空间）。
 * 只允许操作 mediaRoot / thumbDir 内的文件；删不掉的记进 errors，不阻断数据库清理
 * （用户的主诉求是清记录 + 释放空间，残留文件不会让数据状态变坏）。
 * multi（D-202）：缩略图在 data/thumbs/<owner>/，缓存文件名仍存相对文件名，这里按 owner 拼根目录。
 */
function deleteMediaFiles(mediaRows, owner = null) {
  // D-212：multi 下每个账号可能自定义了自己的素材库根目录
  const root = resolve(mediaBaseFor(owner));
  const thumbRoot = resolve(thumbRootFor(owner));
  const inside = (base, abs) => abs !== base && abs.startsWith(base + sep);
  const out = { deleted: 0, missing: 0, errors: [] };
  for (const m of mediaRows) {
    // multi：只处理当前账号的记录（防御性过滤，正常路径进来的都已经按 owner 查过）
    if (owner && m.user_id !== owner) continue;
    const abs = resolve(root, String(m.rel_path || ''));
    if (!m.rel_path || !inside(root, abs)) {
      out.errors.push(`${m.id}：路径异常，已跳过`);
      continue;
    }
    try {
      if (existsSync(abs)) {
        unlinkSync(abs);
        out.deleted++;
      } else {
        out.missing++;
      }
    } catch (e) {
      out.errors.push(`${m.rel_path}：${e.message}`);
    }
    for (const f of [m.thumb, m.poster, `${m.id}_p.webp`]) {
      if (!f) continue;
      const cache = resolve(thumbRoot, f);
      if (!inside(thumbRoot, cache)) continue;
      try {
        unlinkSync(cache);
      } catch {
        /* 缓存不在就算了 */
      }
    }
  }
  return out;
}

app.get('/api/trash', async (req) => listTrash(ownerOf(req)));

app.get('/api/trash/count', async (req) => trashCount(ownerOf(req)));

app.post('/api/trash/restore', async (req, reply) => {
  const parsed = parseTrashItems(req.body);
  if (parsed.error) return reply.code(400).send({ error: parsed.error });
  const owner = ownerOf(req);
  const places = parsed.items.filter((it) => it.type === 'place');
  const visits = parsed.items.filter((it) => it.type === 'visit');
  const media = parsed.items.filter((it) => it.type === 'media');

  const t = now();
  const out = {
    ok: true,
    restoredPlaces: 0,
    restoredVisits: 0,
    restoredMedia: 0,
    restoredEarlierVisits: 0,
    restoredEarlierMedia: 0,
  };
  const restoredVisitIds = new Set();
  const restoredMediaIds = new Set();

  try {
    db.exec('BEGIN');
    // 先恢复地点，再恢复到访，最后恢复媒体：同一请求里父级+子项一起选中也能处理。
    for (const it of places) {
      const p = getTrashPlace(it.id, owner);
      if (!p) throw trashErr(404, `地点不存在或不在回收站：${it.id}`);

      // 先记下「默认会恢复」和「勾选 restoreEarlier 后会额外恢复」的子项
      const defaultVisits = db.prepare(
        'SELECT id FROM visit WHERE place_id = ? AND deleted_at = ?'
      ).all(p.id, p.deleted_at);
      const defaultMedia = db.prepare(`
        SELECT m.id FROM media m JOIN visit v ON v.id = m.visit_id
        WHERE v.place_id = ? AND m.deleted_at = ?
      `).all(p.id, p.deleted_at);
      let childVisits = defaultVisits;
      let childMedia = defaultMedia;
      if (it.restoreEarlier) {
        childVisits = db.prepare(
          'SELECT id FROM visit WHERE place_id = ? AND deleted_at IS NOT NULL'
        ).all(p.id);
        childMedia = db.prepare(`
          SELECT m.id FROM media m JOIN visit v ON v.id = m.visit_id
          WHERE v.place_id = ? AND m.deleted_at IS NOT NULL
        `).all(p.id);
        out.restoredEarlierVisits += Math.max(0, childVisits.length - defaultVisits.length);
        out.restoredEarlierMedia += Math.max(0, childMedia.length - defaultMedia.length);
      }
      for (const v of childVisits) restoredVisitIds.add(v.id);
      for (const m of childMedia) restoredMediaIds.add(m.id);

      db.prepare('UPDATE place SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(t, p.id);
      if (it.restoreEarlier) {
        db.prepare(
          'UPDATE visit SET deleted_at = NULL, updated_at = ? WHERE place_id = ? AND deleted_at IS NOT NULL'
        ).run(t, p.id);
        db.prepare(`
          UPDATE media SET deleted_at = NULL
          WHERE deleted_at IS NOT NULL
            AND visit_id IN (SELECT id FROM visit WHERE place_id = ?)
        `).run(p.id);
      } else {
        db.prepare(
          'UPDATE visit SET deleted_at = NULL, updated_at = ? WHERE place_id = ? AND deleted_at = ?'
        ).run(t, p.id, p.deleted_at);
        db.prepare(`
          UPDATE media SET deleted_at = NULL
          WHERE deleted_at = ?
            AND visit_id IN (SELECT id FROM visit WHERE place_id = ? AND deleted_at IS NULL)
        `).run(p.deleted_at, p.id);
      }
      out.restoredPlaces++;
    }

    for (const it of visits) {
      if (restoredVisitIds.has(it.id)) continue;
      const v = getTrashVisit(it.id, owner);
      if (!v) throw trashErr(404, `到访不存在或不在回收站：${it.id}`);
      if (v.place_deleted_at !== null) {
        throw trashErr(409, '所属地点还在回收站，请先恢复地点');
      }

      if (it.restoreEarlier) {
        const defaultMedia = db.prepare(
          'SELECT id FROM media WHERE visit_id = ? AND deleted_at = ?'
        ).all(v.id, v.deleted_at);
        const childMedia = db.prepare(
          'SELECT id FROM media WHERE visit_id = ? AND deleted_at IS NOT NULL'
        ).all(v.id);
        for (const m of childMedia) restoredMediaIds.add(m.id);
        out.restoredEarlierMedia += Math.max(0, childMedia.length - defaultMedia.length);
        db.prepare('UPDATE visit SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(t, v.id);
        db.prepare(
          'UPDATE media SET deleted_at = NULL WHERE visit_id = ? AND deleted_at IS NOT NULL'
        ).run(v.id);
      } else {
        const defaultMedia = db.prepare(
          'SELECT id FROM media WHERE visit_id = ? AND deleted_at = ?'
        ).all(v.id, v.deleted_at);
        for (const m of defaultMedia) restoredMediaIds.add(m.id);
        db.prepare('UPDATE visit SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(t, v.id);
        db.prepare(
          'UPDATE media SET deleted_at = NULL WHERE visit_id = ? AND deleted_at = ?'
        ).run(v.id, v.deleted_at);
      }
      out.restoredVisits++;
    }

    for (const it of media) {
      if (restoredMediaIds.has(it.id)) continue;
      const m = getTrashMedia(it.id, owner);
      if (!m) throw trashErr(404, `媒体不存在或不在回收站：${it.id}`);
      if (m.visit_deleted_at !== null || m.place_deleted_at !== null) {
        throw trashErr(409, '所属到访/地点还在回收站，请先恢复');
      }
      db.prepare('UPDATE media SET deleted_at = NULL WHERE id = ?').run(m.id);
      out.restoredMedia++;
    }
    db.exec('COMMIT');
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    if (e.status) return reply.code(e.status).send({ error: e.message });
    return reply.code(500).send({ error: '恢复失败：' + e.message });
  }

  out.remaining = trashCount(owner);
  return out;
});

app.post('/api/trash/purge', async (req, reply) => {
  const b = req.body || {};
  if (b.confirm !== true) {
    return reply.code(400).send({ error: '彻底删除需要确认（confirm: true）' });
  }
  const parsed = parseTrashItems(b);
  if (parsed.error) return reply.code(400).send({ error: parsed.error });
  const owner = ownerOf(req);

  // 彻底删除不要求父级已恢复：任何在回收站里的条目都可以单独永久删除。
  const places = [];
  const visits = [];
  const media = [];
  try {
    for (const it of parsed.items) {
      if (it.type === 'place') {
        const p = getTrashPlace(it.id, owner);
        if (!p) throw trashErr(404, `地点不存在或不在回收站：${it.id}`);
        places.push(p);
      } else if (it.type === 'visit') {
        const v = getTrashVisit(it.id, owner);
        if (!v) throw trashErr(404, `到访不存在或不在回收站：${it.id}`);
        visits.push(v);
      } else {
        const m = getTrashMedia(it.id, owner);
        if (!m) throw trashErr(404, `媒体不存在或不在回收站：${it.id}`);
        media.push(m);
      }
    }
  } catch (e) {
    return reply.code(e.status || 400).send({ error: e.message });
  }

  // 彻底删除 = 释放空间：数据库记录和 B 库原片/缓存一起删。先删文件，尽量保留统计。
  const mediaRows = collectTrashMedia(
    places.map((p) => p.id),
    visits.map((v) => v.id),
    media
  );
  const files = deleteMediaFiles(mediaRows, owner);

  try {
    db.exec('BEGIN');
    for (const m of media) db.prepare('DELETE FROM media WHERE id = ?').run(m.id);
    for (const v of visits) db.prepare('DELETE FROM visit WHERE id = ?').run(v.id);
    // place 上有 ON DELETE CASCADE：连带它的全部到访和媒体记录（含此前单独删除的）
    for (const p of places) db.prepare('DELETE FROM place WHERE id = ?').run(p.id);
    db.exec('COMMIT');
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    return reply.code(500).send({ error: '彻底删除失败：' + e.message });
  }

  return {
    ok: true,
    purgedPlaces: places.length,
    purgedVisits: visits.length,
    purgedMedia: media.length,
    files,
    remaining: trashCount(owner),
  };
});

// ───────────── 媒体 ─────────────

app.post('/api/media/upload', async (req, reply) => {
  const owner = ownerOf(req);
  // 2026-11-08（D-310，用户要求）：云端 multi 恢复每账号配额拦截（默认 1 GiB、可申请扩容）。
  // local 模式不受限（行为与以前一致）；同一账号的请求串行处理，保证配额判断准确。
  if (owner) return runSerializedUpload(owner, () => handleMediaUpload(req, reply, owner));
  return handleMediaUpload(req, reply, owner);
});

async function handleMediaUpload(req, reply, owner) {
  // D-310：multi 下先算好配额，已经超了就直接拒绝整个请求（前端上传队列按单文件请求，
  // 会把这条错误显示在该文件上）；逐文件落盘时再按「已用 + 本文件」检查一次。
  const quota = owner ? quotaBytesOf(req.authUser) : null;
  const usedAtStart = owner ? userUsage(owner).mediaBytes : 0;
  if (quota && usedAtStart >= quota) {
    return reply.code(400).send({
      code: 'quota_exceeded',
      error: `存储空间不足：已用 ${fmtBytes(usedAtStart)} / 上限 ${fmtBytes(quota)}。请先删除不需要的素材（回收站里的要彻底删除），或在设置 → 账号里申请扩容。`,
      usedBytes: usedAtStart,
      quotaBytes: quota,
    });
  }
  const visitId = req.query?.visitId;
  const v = visitId
    ? db.prepare(`
        SELECT v.id, v.date, p.id AS place_id, p.name AS place_name,
               p.province, p.city, p.county
        FROM visit v JOIN place p ON p.id = v.place_id
        WHERE v.id = ? AND v.deleted_at IS NULL${ownerSql(owner, 'v.user_id')}
      `).get(...ownerArgs(owner, visitId))
    : null;
  if (!v) return reply.code(400).send({ error: 'visitId 无效' });

  // 落盘结构：省 / 市 / 区县 / 日期_地点名（D-35）
  // 末级「YYYY-MM-DD_地点名」不变，M2 扫描仍然只认这一级。
  // multi（D-202）：根目录多一级 `<owner>/`，DB 的 rel_path 也带这个前缀；缩略图在 data/thumbs/<owner>/。
  // D-212：multi 下每个账号可以有自己自定义的素材库根目录（默认 = 服务器 mediaRoot）
  const mediaBase = resolve(mediaBaseFor(owner));
  const mediaRootForOwner = owner ? join(mediaBase, owner) : mediaBase;
  const thumbRoot = thumbRootFor(owner);
  const dir = join(
    mediaRootForOwner,
    safeSeg(v.province),
    safeSeg(v.city),
    safeSeg(v.county),
    `${v.date}_${safeName(v.place_name)}`
  );
  mkdirSync(dir, { recursive: true });
  mkdirSync(thumbRoot, { recursive: true });

  const added = [];
  const skipped = [];
  const errors = [];

  // D-248：单文件上限可配置（CONFIG.maxUploadBytes）；throwFileSizeLimit: false 让超限时
  // 走「流被截断」而不是直接抛错，这样下面能检测 truncated、删掉半截文件并给中文提示。
  for await (const part of req.files({
    limits: { fileSize: CONFIG.maxUploadBytes },
    throwFileSizeLimit: false,
  })) {
    const original = part.filename || 'file';
    const ext = extname(original).toLowerCase();
    const isPhoto = PHOTO_EXT.has(ext);
    const isVideo = VIDEO_EXT.has(ext);
    if (!isPhoto && !isVideo) {
      errors.push(`${original}：不支持的格式`);
      part.file.resume();
      continue;
    }

    const dest = uniquePath(dir, basename(original));
    let inserted = false;
    try {
      await pipeline(part.file, createWriteStream(dest));
      // D-248：超限文件会在上限处被截断，必须删掉半截文件且不入库。
      if (part.file.truncated) {
        errors.push(
          `${original}：文件超过单文件上限（${(CONFIG.maxUploadBytes / 1024 ** 3).toFixed(0)} GB）`
        );
        try { unlinkSync(dest); } catch { /* ignore */ }
        continue;
      }
      const st = statSync(dest);
      if (st.size === 0) {
        errors.push(`${original}：空文件`);
        try { unlinkSync(dest); } catch { /* ignore */ }
        continue;
      }

      // 2026-11-08（D-310）：云端每账号配额——按「已用 + 本文件」检查（回收站里没彻底删除的也计入）
      if (quota) {
        const usedNow = userUsage(owner).mediaBytes;
        if (usedNow + st.size > quota) {
          try { unlinkSync(dest); } catch { /* ignore */ }
          errors.push(
            `${original}：存储空间不足（已用 ${fmtBytes(usedNow)} / 上限 ${fmtBytes(quota)}），请删除素材或申请扩容`
          );
          continue;
        }
      }

      const id = randomUUID();
      const hash = await hashFile(dest);

      // F-MED-07 上传查重：同一到访内同内容只留一份（D-46 定稿）。
      // 只删掉自己刚落盘的那份，绝不碰已有文件。
      if (hash) {
        const active = db.prepare(
          'SELECT id FROM media WHERE visit_id = ? AND hash = ? AND deleted_at IS NULL'
        ).get(v.id, hash);
        if (active) {
          try { unlinkSync(dest); } catch { /* 删不掉也不影响已有记录 */ }
          skipped.push({ name: original, reason: 'duplicate', mediaId: active.id });
          continue;
        }
        // 同内容的那份在回收站里：直接恢复旧记录，不再占第二份磁盘（D-56）。
        const trashed = db.prepare(`
          SELECT id, rel_path FROM media
          WHERE visit_id = ? AND hash = ? AND deleted_at IS NOT NULL
          ORDER BY deleted_at DESC LIMIT 1
        `).get(v.id, hash);
        if (trashed && existsSync(resolve(mediaBase, trashed.rel_path))) {
          try { unlinkSync(dest); } catch { /* ignore */ }
          db.prepare('UPDATE media SET deleted_at = NULL WHERE id = ?').run(trashed.id);
          added.push({ id: trashed.id, name: original, restored: true });
          continue;
        }
      }

      let width = null, height = null, thumb = null, poster = null, duration = null;

      if (isPhoto) {
        const heic = isHeicExt(ext);
        try {
          const t = await makeThumb(dest, id, thumbRoot);
          thumb = relative(thumbRoot, t.path);
          if (heic) {
            // HEIC 容器里的宽高与旋转后可能不一致，这里直接用解码后的真实像素尺寸
            width = t.srcWidth ?? t.width;
            height = t.srcHeight ?? t.height;
          } else {
            const meta = await sharp(dest, { failOn: 'none' }).metadata();
            width = meta.width ?? t.width;
            height = meta.height ?? t.height;
          }
        } catch (e) {
          if (heic) {
            // HEIC 解不开 = 这张图在应用里永远显示不出来；不留下破图记录，
            // 删掉刚复制的文件，并把明确错误返回给上传队列（D-307）。
            try { unlinkSync(dest); } catch { /* ignore */ }
            errors.push(`${original}：HEIC 图片解码失败（文件可能损坏或编码不受支持）`);
            continue;
          }
          errors.push(`${original}：缩略图失败（${e.message}）`);
        }
      } else {
        const p = await makePoster(dest, id, thumbRoot);
        poster = p.poster;
        duration = p.duration;
      }

      // rel_path 一律相对 mediaRoot；multi 用 `/` 分隔（D-202 的 `<userId>/省/市/…` 约定，
      // 也让不同平台/备份/迁移脚本的路径比较稳定）；local 保持原来的平台分隔符不变。
      const relToRoot = relative(mediaBase, dest);
      const relPath = owner ? relToRoot.split(sep).join('/') : relToRoot;
      db.prepare(`
        INSERT INTO media (id,user_id,visit_id,kind,rel_path,hash,bytes,width,height,duration,thumb,poster,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(id, owner, v.id, isPhoto ? 'photo' : 'video', relPath,
             hash, st.size, width, height, duration, thumb, poster, now());
      inserted = true;

      added.push({ id, name: basename(dest) });
    } catch (e) {
      // 上传中断/出错：清掉自己刚落盘的半截文件，别在素材库里留孤儿
      if (!inserted) {
        try { unlinkSync(dest); } catch { /* ignore */ }
      }
      const tooLarge = e?.code === 'FST_REQ_FILE_TOO_LARGE';
      errors.push(
        `${original}：${
          tooLarge
            ? `文件超过单文件上限（${(CONFIG.maxUploadBytes / 1024 ** 3).toFixed(0)} GB）`
            : e.message
        }`
      );
    }
  }

  return { added, skipped, errors };
}

// 媒体读取（thumb / preview / orig）：multi 先校验 media 属于当前账号，别的账号一律 404（D-202）；
// 缓存根目录按 owner 拼（data/thumbs/<owner>/），local 路径完全不变。
app.get('/api/media/:id/:variant', async (req, reply) => {
  const { id, variant } = req.params;
  const owner = ownerOf(req);
  const m = db
    .prepare(`SELECT * FROM media WHERE id = ?${ownerSql(owner)}`)
    .get(...ownerArgs(owner, id));
  if (!m) return reply.code(404).send({ error: 'not found' });
  const thumbRoot = thumbRootFor(owner);

  // D-212：按账号自己的素材库根目录解析（默认 = 服务器 mediaRoot）
  const mediaBase = resolve(mediaBaseFor(owner));
  const abs = resolve(mediaBase, m.rel_path);
  if (!abs.startsWith(mediaBase)) return reply.code(403).send({ error: 'forbidden' });

  if (variant === 'thumb') {
    // 视频：封面帧就是它的「缩略图」（F-MED-04）。老视频没封面时，装了 ffmpeg 之后现场补抽。
    if (m.kind === 'video') {
      let posterPath = m.poster ? join(thumbRoot, m.poster) : '';
      if ((!posterPath || !existsSync(posterPath)) && existsSync(abs) && (await hasFfmpeg())) {
        const p = await makePoster(abs, m.id, thumbRoot);
        if (p.poster) {
          db.prepare('UPDATE media SET poster = ?, duration = COALESCE(?, duration) WHERE id = ?')
            .run(p.poster, p.duration, m.id);
          posterPath = join(thumbRoot, p.poster);
        }
      }
      if (!posterPath || !existsSync(posterPath)) return reply.code(404).send({ error: 'no poster' });
      return sendRange(req, reply, posterPath, 'image/webp');
    }
    let thumbPath = m.thumb ? join(thumbRoot, m.thumb) : '';
    // 缩略图丢了（换了电脑、只拷了原片）就现场重建，不用手动处理
    if (!thumbPath || !existsSync(thumbPath)) {
      if (m.kind !== 'photo' || !existsSync(abs)) {
        return reply.code(404).send({ error: 'no thumb' });
      }
      try {
        const t = await makeThumb(abs, m.id, thumbRoot);
        // D-307：顺手补上宽高（HEIC 支持前入库的历史记录是 null，无副作用）
        db.prepare(
          'UPDATE media SET thumb = ?, width = COALESCE(width, ?), height = COALESCE(height, ?) WHERE id = ?'
        ).run(relative(thumbRoot, t.path), t.srcWidth ?? t.width, t.srcHeight ?? t.height, m.id);
        thumbPath = t.path;
      } catch (e) {
        return reply.code(500).send({ error: 'thumb failed: ' + e.message });
      }
    }
    return sendRange(req, reply, thumbPath, 'image/webp');
  }
  if (variant === 'preview') {
    if (m.kind !== 'photo' || !existsSync(abs)) return reply.code(404).send({ error: 'no preview' });
    try {
      const p = await ensurePreview(m.id, abs, thumbRoot);
      return sendRange(req, reply, p, 'image/webp');
    } catch {
      return reply.code(500).send({ error: 'preview failed' });
    }
  }
  if (variant === 'orig') {
    if (!existsSync(abs)) return reply.code(404).send({ error: 'file missing' });
    const type = MIME[extname(abs).toLowerCase()] || 'application/octet-stream';
    return sendRange(req, reply, abs, type);
  }
  return reply.code(400).send({ error: 'unknown variant' });
});

app.delete('/api/media/:id', async (req, reply) => {
  const owner = ownerOf(req);
  const m = db
    .prepare(`SELECT * FROM media WHERE id = ? AND deleted_at IS NULL${ownerSql(owner)}`)
    .get(...ownerArgs(owner, req.params.id));
  if (!m) return reply.code(404).send({ error: 'not found' });

  // 软删进回收站（D-56，推翻 D-34 的物理删除）：记录 + B 原片 + 缓存都保留，
  // 用户之后可以在回收站恢复，或点「彻底删除」真正释放空间。
  db.prepare('UPDATE media SET deleted_at = ? WHERE id = ?').run(now(), m.id);
  // 如果它正好是某个地点的封面，清掉引用（恢复时不自动抢回封面）；multi 只清自己账号的
  db.prepare(`UPDATE place SET cover_media_id = NULL WHERE cover_media_id = ?${ownerSql(owner)}`).run(
    ...ownerArgs(owner, m.id)
  );

  return { ok: true, trashed: true, mediaId: m.id, visitId: m.visit_id, bytes: m.bytes ?? 0 };
});

app.patch('/api/media/:id', async (req, reply) => {
  const owner = ownerOf(req);
  const m = db
    .prepare(`SELECT * FROM media WHERE id = ? AND deleted_at IS NULL${ownerSql(owner)}`)
    .get(...ownerArgs(owner, req.params.id));
  if (!m) return reply.code(404).send({ error: 'not found' });
  const b = req.body || {};
  if (b.visit_id !== undefined) {
    // multi：目标到访也必须是自己的，否则按无效参数处理（不泄露对方到访存在性）
    const v = db
      .prepare(`SELECT id FROM visit WHERE id = ? AND deleted_at IS NULL${ownerSql(owner)}`)
      .get(...ownerArgs(owner, b.visit_id));
    if (!v) return reply.code(400).send({ error: '目标到访无效' });
    db.prepare('UPDATE media SET visit_id = ? WHERE id = ?').run(v.id, m.id);
  }
  return { ok: true };
});

// 打开本地文件夹（F-MED-09）：由服务端调系统文件管理器定位原片（D-36）。
// 绝对路径不下发前端；只允许操作 mediaRoot 内的文件。
app.post('/api/media/:id/reveal', async (req, reply) => {
  const owner = ownerOf(req);
  const m = db
    .prepare(`SELECT id, rel_path FROM media WHERE id = ?${ownerSql(owner)}`)
    .get(...ownerArgs(owner, req.params.id));
  if (!m) return reply.code(404).send({ error: 'not found' });
  // D-212：按账号自己的素材库根目录解析
  const root = resolve(mediaBaseFor(owner));
  const abs = resolve(root, m.rel_path);
  if (abs === root || !abs.startsWith(root + sep)) {
    return reply.code(403).send({ error: '路径异常，拒绝打开' });
  }
  const parent = dirname(abs);
  const exists = existsSync(abs);
  const target = exists ? abs : parent;
  if (!existsSync(target)) {
    return reply.code(404).send({ error: '文件不存在，所在目录也不存在' });
  }
  const dryRun = Boolean(req.body?.dryRun);
  try {
    if (!dryRun) {
      const opts = { detached: true, stdio: 'ignore' };
      let child;
      if (process.platform === 'win32') {
        child = spawn('explorer.exe', [exists ? `/select,${abs}` : parent], opts);
      } else if (process.platform === 'darwin') {
        child = spawn('open', exists ? ['-R', abs] : [parent], opts);
      } else {
        child = spawn('xdg-open', [parent], opts);
      }
      child.on('error', () => {
        /* 文件管理器打不开不要在服务端崩 */
      });
      child.unref();
    }
  } catch (e) {
    return reply.code(500).send({ error: '无法打开文件管理器：' + e.message });
  }
  return { ok: true, missing: !exists, opened: exists ? 'select' : 'folder' };
});

// ───────────── 素材库（换电脑 / 换路径后的重连） ─────────────

const MEDIA_RE = /\.(jpe?g|png|webp|gif|bmp|heic|heif|avif|mp4|mov|m4v|webm|avi|mkv)$/i;

function walkMediaFiles(root, limit = 200000) {
  const out = [];
  const stack = [root];
  while (stack.length && out.length < limit) {
    const dir = stack.pop();
    let ents;
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      const full = join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (MEDIA_RE.test(e.name)) out.push(full);
    }
  }
  return out;
}

// 素材库管理（换电脑 / 换路径后的重连）。
// 2026-11-07（D-212 / D-213，用户要求）：素材库路径是**每个账号自己的管理**（含管理员）：
//   - multi：每个账号可查看自己的素材库状态、打开自己的素材库文件夹（资源管理器）、
//     重新关联、切换**自己账号**的素材库根目录（存 user_setting.media_root；只影响自己）；
//     切换 / 恢复默认路径时默认把该账号现有素材同步到新位置（见 migrateMediaRoot）；
//   - local：仍是服务器默认素材库路径（切换时同步整个库），并新增「打开本地文件夹」；
//   - 普通用户未自定义路径时不下发服务器绝对路径（D-205）。
// 已知边界（D-212）：管理员整库备份 / 恢复、scan、运维脚本仍只认服务器默认素材库路径。
app.get('/api/library', async (req, reply) => {
  const owner = ownerOf(req);
  if (CONFIG.authMode === 'multi') {
    const user = requireAuth(req, reply);
    if (!user) return;
  }
  const root = resolve(mediaBaseFor(owner));
  const customized = mediaBaseCustomized(owner);
  const thumbRoot = thumbRootFor(owner);
  const rows = db
    .prepare(`SELECT id, kind, rel_path, thumb, poster FROM media WHERE deleted_at IS NULL${ownerSql(owner)}`)
    .all(...ownerArgs(owner));
  const deleted = db
    .prepare(`SELECT COUNT(*) AS n FROM media WHERE deleted_at IS NOT NULL${ownerSql(owner)}`)
    .get(...ownerArgs(owner)).n;
  const missing = rows.filter((r) => !existsSync(resolve(root, r.rel_path)));
  const thumbMissing = rows.filter((r) => {
    const cached = r.kind === 'video' ? r.poster : r.thumb;
    return !cached || !existsSync(join(thumbRoot, cached));
  });
  return {
    // 2026-11-07（D-215，用户要求）：素材库就是用户机器上的一个文件夹，当前路径对所有人都直接显示
    root,
    customized,
    total: rows.length,
    deleted,
    missing: missing.length,
    thumbMissing: thumbMissing.length,
    sample: missing.slice(0, 3).map((r) => r.rel_path),
  };
});

/**
 * 校验 / 准备「切换素材库根目录」的目标路径（D-213）：
 * - 路径不能是应用 data/ 目录或其子 / 父目录；
 * - 文件夹不存在时自动创建（用户直接输入一个新文件夹即可）；
 * - 存在但不是文件夹 → 报错。
 */
function prepareMediaRoot(p) {
  const abs = resolve(p);
  const dataDir = resolve(CONFIG.dataDir);
  const thumbDir = resolve(CONFIG.thumbDir);
  const inside = (base, target) => target === base || target.startsWith(base + sep);
  if (inside(dataDir, abs) || inside(thumbDir, abs) || inside(abs, dataDir) || inside(abs, thumbDir)) {
    throw new Error('不能选择应用数据目录（data/）作为素材库');
  }
  if (existsSync(abs) && !statSync(abs).isDirectory()) {
    throw new Error('该路径已存在但不是文件夹');
  }
  if (!existsSync(abs)) mkdirSync(abs, { recursive: true });
  return abs;
}

/**
 * 切换素材库根目录（D-212 / D-213）：
 * - multi：每个账号（含管理员）只改自己的素材库根目录，并把现有素材同步到新位置；
 * - local：改服务器默认素材库路径，并把整个素材库同步到新位置。
 * 响应里的 synced = { files, moved, skipped, bytes, mode }。
 */
app.post('/api/library/root', async (req, reply) => {
  const p = String(req.body?.root || '').trim();
  if (!p) return reply.code(400).send({ error: '路径不能为空' });
  const isMulti = CONFIG.authMode === 'multi';
  let user = null;
  if (isMulti) {
    user = requireAuth(req, reply);
    if (!user) return;
  }
  const owner = ownerOf(req);
  let abs;
  try {
    abs = prepareMediaRoot(p);
  } catch (e) {
    return reply.code(400).send({ error: e.message });
  }
  const oldBase = resolve(mediaBaseFor(owner));
  try {
    // 默认把当前账号 / 当前库的素材同步到新位置（同盘 rename，跨盘复制并校验后删旧文件）
    const synced = migrateMediaRoot(owner, oldBase, abs);
    if (isMulti) saveUserSetting(user.id, { media_root: abs });
    else setMediaRoot(abs);
    return { ok: true, root: abs, customized: isMulti, synced };
  } catch (e) {
    return reply.code(400).send({
      error: e.message,
      syncedFrom: oldBase,
      syncedTo: abs,
      // 同步中途失败：设置未落库，已搬过的文件留在新位置，重试可继续
      retryable: true,
    });
  }
});

/** 恢复默认素材库路径（multi：清掉自己的自定义路径，并把素材同步回默认位置） */
app.delete('/api/library/root', async (req, reply) => {
  if (CONFIG.authMode !== 'multi') {
    return reply.code(400).send({ error: '本地模式没有账号素材库路径' });
  }
  const user = requireAuth(req, reply);
  if (!user) return;
  const oldBase = resolve(mediaBaseFor(user.id));
  const defaultBase = resolve(CONFIG.mediaRoot);
  try {
    const synced = migrateMediaRoot(user.id, oldBase, defaultBase);
    saveUserSetting(user.id, { media_root: null });
    return { ok: true, root: defaultBase, customized: false, synced };
  } catch (e) {
    return reply.code(400).send({ error: e.message, retryable: true });
  }
});

/**
 * 打开素材库文件夹（D-213，用户要求「当前路径边上加一个链接到本地文件夹的按钮」）：
 * multi = 打开当前账号的素材库目录（自定义路径或默认路径下的账号目录，不存在会自动创建）；
 * local = 打开服务器默认素材库目录。绝对路径不下发前端。
 * 注意：这是「在服务器所在机器上打开资源管理器」，云端部署时只对能登录服务器的人有意义。
 */
app.post('/api/library/reveal', async (req, reply) => {
  if (CONFIG.authMode === 'multi') {
    const user = requireAuth(req, reply);
    if (!user) return;
  }
  const owner = ownerOf(req);
  try {
    const base = resolve(mediaBaseFor(owner));
    const dir = owner ? join(base, owner) : base;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (req.body?.dryRun) return { ok: true, dryRun: true };
    // 启动系统文件管理器时等一小会，把「起不来」的错误报给前端（否则会静默失败）
    const cmd =
      process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = process.platform === 'win32' ? [dir] : [dir];
    const spawnErr = await new Promise((finish) => {
      let settled = false;
      const settle = (v) => {
        if (settled) return;
        settled = true;
        finish(v);
      };
      try {
        const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
        child.once('spawn', () => setTimeout(() => settle(null), 250));
        child.once('error', (e) => settle(e));
        child.unref();
      } catch (e) {
        settle(e);
      }
      setTimeout(() => settle(null), 1500);
    });
    if (spawnErr) {
      return reply.code(500).send({
        error:
          '无法打开文件夹（' +
          (spawnErr.code || '') +
          '）：' +
          (spawnErr.message || String(spawnErr)),
      });
    }
    return { ok: true };
  } catch (e) {
    return reply.code(500).send({ error: '无法打开文件夹：' + (e?.message || e) });
  }
});

/**
 * 重新关联：把数据库里的记录和磁盘上的文件重新对上。
 *
 * 三步，越往后越贵：
 *   1. 按文件名匹配（换电脑最常见的场景：只是盘符变了）
 *   2. 同名多个时，再用文件大小区分
 *   3. 还找不到的，算 sha256 按内容匹配（改名也能找回来）
 *
 * multi（D-202）：只处理当前账号的记录；扫描范围限定在 mediaRoot/<owner>，
 * 命中的路径仍存相对 mediaRoot 的形式（带 owner 前缀）。
 */
app.post('/api/library/relink', async (req, reply) => {
  if (CONFIG.authMode === 'multi') {
    const user = requireAuth(req, reply);
    if (!user) return;
  }
  const owner = ownerOf(req);
  // D-212：按账号自己的素材库根目录（普通用户可自定义；默认 = 服务器 mediaRoot）
  const root = resolve(mediaBaseFor(owner));
  const scanRoot = owner ? join(root, owner) : root;
  // multi：写回 rel_path 时统一用 `/`（与上传一致，D-202）；local 保持原来的平台分隔符
  const storeRel = (abs) => {
    const rel = relative(root, abs);
    return owner ? rel.split(sep).join('/') : rel;
  };
  const t0 = Date.now();
  const rows = db
    .prepare(`SELECT id, rel_path, hash, bytes FROM media WHERE deleted_at IS NULL${ownerSql(owner)}`)
    .all(...ownerArgs(owner));
  const missing = rows.filter((r) => !existsSync(resolve(root, r.rel_path)));

  if (!missing.length) {
    return {
      root,
      scanned: 0,
      matched: 0,
      byName: 0,
      byHash: 0,
      stillMissing: 0,
      ms: Date.now() - t0,
    };
  }

  const files = walkMediaFiles(scanRoot);
  const byName = new Map();
  for (const f of files) {
    const n = basename(f);
    const arr = byName.get(n);
    if (arr) arr.push(f);
    else byName.set(n, [f]);
  }

  const claimed = new Set();
  const update = db.prepare('UPDATE media SET rel_path = ? WHERE id = ?');
  const still = [];
  let byNameCount = 0;

  for (const r of missing) {
    const name = basename(r.rel_path);
    const cands = (byName.get(name) || []).filter((p) => !claimed.has(p));
    let hit = null;
    if (cands.length === 1) {
      hit = cands[0];
    } else if (cands.length > 1) {
      hit =
        cands.find((p) => {
          try {
            return statSync(p).size === r.bytes;
          } catch {
            return false;
          }
        }) || null;
    }
    if (hit) {
      update.run(storeRel(hit), r.id);
      claimed.add(hit);
      byNameCount++;
    } else {
      still.push(r);
    }
  }

  // 内容哈希兜底
  let byHashCount = 0;
  if (still.length) {
    const pool = files.filter((f) => !claimed.has(f));
    const hashIndex = new Map();
    for (const f of pool) {
      try {
        hashIndex.set(await hashFile(f), f);
      } catch {
        /* 读不了就跳过 */
      }
    }
    for (const r of still) {
      if (!r.hash) continue;
      const hit = hashIndex.get(r.hash);
      if (hit && !claimed.has(hit)) {
        update.run(storeRel(hit), r.id);
        claimed.add(hit);
        byHashCount++;
      }
    }
  }

  return {
    root,
    scanned: files.length,
    matched: byNameCount + byHashCount,
    byName: byNameCount,
    byHash: byHashCount,
    stillMissing: still.length - byHashCount,
    ms: Date.now() - t0,
  };
});

// ───────────── 素材库扫描预览（F-IMP-01 / F-IMP-02）─────────────
// 只读：解析目录 + 给候选文件算 hash + 读库做判重，不写数据库、不动素材库文件。
// 计划留在内存里，给下一步 POST /api/scan/import 复用（F-IMP-03）。
// multi（D-202）：P2-3 前仅管理员；扫描范围是 mediaRoot/<owner>，判重只看当前账号的数据。
const scanPlans = new Map();
const KEEP_PLANS = 3;

app.get('/api/scan/preview', async (req, reply) => {
  if (!requireAdminInMulti(req, reply)) return;
  const owner = ownerOf(req);
  try {
    const scanRoot = owner ? join(CONFIG.mediaRoot, owner) : CONFIG.mediaRoot;
    const scan = scanLibrary(scanRoot);
    const preview = await buildPreview(scan, owner);
    const planId = randomUUID();
    scanPlans.set(planId, { preview, createdAt: Date.now() });
    while (scanPlans.size > KEEP_PLANS) {
      const oldest = scanPlans.keys().next().value;
      scanPlans.delete(oldest);
    }
    return { planId, ...publicPreview(preview) };
  } catch (e) {
    return reply.code(500).send({ error: e?.message || String(e) });
  }
});

// ───────────── M4 / M4.1：备份 / 恢复 / 提醒（F-SYS-03 / F-SYS-04 / F-SYS-05）─────────────
// 备份分三块可选：元数据（恒包含）+ 缩略图缓存 + 照片视频素材；A 原件永不读写。
// 含素材的恢复只写/覆盖备份里的文件，绝不删除 B 里备份外的文件；恢复 = 行级事务替换，失败自动回滚。
// 大文件用两阶段导出任务（start → status 轮询进度 → download），旧的 one-shot 导出保留作兼容。
//
// M6 P2-2（D-202）：备份提醒按用户（getBackupStatus/snooze/settings 传 owner）；
// 导出 / 恢复 / inspect / 导出任务 / 素材库管理在 P2-3 前仅管理员，普通用户 403。

/** 备份提醒状态（F-SYS-05）：上次备份 / 距今天数 / 阈值 / 稍后提醒 / 是否该备份了（每账号独立） */
app.get('/api/backup/status', async (req) => getBackupStatus(ownerOf(req)));

/** 导出备份（F-SYS-03）：生成 zip 到临时文件后流式下载，成功后记 lastBackupAt（multi 记到 user_setting） */
app.post('/api/backup/export', async (req, reply) => {
  if (!requireAdminInMulti(req, reply)) return;
  const owner = ownerOf(req);
  if (isRestoring()) {
    return reply.code(409).send({ error: '正在恢复备份，请稍后再导出' });
  }
  const body = req.body || {};
  const includeThumbs = body.includeThumbs === true;
  const zipPath = newTmpZipPath('export');
  try {
    const built = await buildBackupZip({ destPath: zipPath, includeThumbs, ownerId: owner });
    const stream = createReadStream(built.path);
    const cleanup = () => {
      try {
        unlinkSync(built.path);
      } catch {
        /* 已被清理 */
      }
    };
    stream.once('close', cleanup);
    stream.once('error', cleanup);
    // 与两阶段导出同名（2026-11-06 用户指定）：中文文件名走 RFC 5987 filename*
    const legacyName = backupFileName();
    return reply
      .header('content-type', 'application/zip')
      .header('content-length', built.size)
      .header(
        'content-disposition',
        `attachment; filename="travel-backup.zip"; filename*=UTF-8''${encodeURIComponent(legacyName)}`
      )
      .send(stream);
  } catch (e) {
    try {
      unlinkSync(zipPath);
    } catch {
      /* ignore */
    }
    return reply.code(500).send({ error: '导出备份失败：' + (e?.message || String(e)) });
  }
});

// 两阶段导出（M4.1）：start 起后台打包任务，status 轮询进度，download 流式下载，DELETE 取消/清理。
// 大素材包不再占着一个 HTTP 响应，前端也能显示真实进度。
app.post('/api/backup/export/start', async (req, reply) => {
  if (!requireAdminInMulti(req, reply)) return;
  const owner = ownerOf(req);
  const b = req.body || {};
  try {
    return startExport(
      {
        includeThumbs: b.includeThumbs === true,
        includeMedia: b.includeMedia === true,
      },
      owner
    );
  } catch (e) {
    if (e instanceof BackupError) return reply.code(e.status || 500).send({ error: e.message });
    return reply.code(500).send({ error: '启动导出失败：' + (e?.message || String(e)) });
  }
});

app.get('/api/backup/export/status/:jobId', async (req, reply) => {
  if (!requireAdminInMulti(req, reply)) return;
  try {
    return getExportStatus(req.params.jobId, ownerOf(req));
  } catch (e) {
    if (e instanceof BackupError) return reply.code(e.status || 500).send({ error: e.message });
    return reply.code(500).send({ error: '读取导出进度失败：' + (e?.message || String(e)) });
  }
});

app.get('/api/backup/export/download/:jobId', async (req, reply) => {
  if (!requireAdminInMulti(req, reply)) return;
  let info;
  try {
    info = getExportDownload(req.params.jobId, ownerOf(req));
  } catch (e) {
    if (e instanceof BackupError) return reply.code(e.status || 500).send({ error: e.message });
    return reply.code(500).send({ error: '下载导出文件失败：' + (e?.message || String(e)) });
  }
  const stream = createReadStream(info.zipPath);
  stream.once('error', () => {
    /* 客户端断开 / 文件被清理：不要在服务端崩 */
  });
  // 文件保留到 TTL 或 DELETE，不在下载后立即删除
  // 文件名含中文（My旅迹素材备份-YYYY-MM-DD-（备份勿删）.zip）：按 RFC 5987 用 filename* 下发，
  // 同时带一个 ASCII fallback，兼容不认 filename* 的旧客户端。
  const encodedName = encodeURIComponent(info.filename);
  return reply
    .header('content-type', 'application/zip')
    .header('content-length', info.size)
    .header(
      'content-disposition',
      `attachment; filename="travel-backup.zip"; filename*=UTF-8''${encodedName}`
    )
    .send(stream);
});

app.delete('/api/backup/export/:jobId', async (req, reply) => {
  if (!requireAdminInMulti(req, reply)) return;
  try {
    return await cancelExportJob(req.params.jobId, ownerOf(req));
  } catch (e) {
    if (e instanceof BackupError) return reply.code(e.status || 500).send({ error: e.message });
    return reply.code(500).send({ error: '取消导出任务失败：' + (e?.message || String(e)) });
  }
});

/** 检查备份（F-SYS-04 第一步）：上传 zip → 全套校验 → 返回 10 分钟有效的 token + 摘要 */
app.post('/api/backup/inspect', async (req, reply) => {
  if (!requireAdminInMulti(req, reply)) return;
  // 素材备份包可能远超 2GB：先按 Content-Length 检查 data/tmp 所在盘空间，再放宽单文件上限。
  const declaredBytes = Number(req.headers['content-length']);
  if (Number.isFinite(declaredBytes) && declaredBytes > 0) {
    if (declaredBytes > BACKUP_UPLOAD_MAX_BYTES) {
      return reply.code(400).send({
        error: `备份文件超过上限（${(BACKUP_UPLOAD_MAX_BYTES / 1024 ** 3).toFixed(0)} GB）`,
      });
    }
    try {
      const st = statfsSync(resolve(CONFIG.dataDir));
      const available = Number(st.bavail) * Number(st.bsize);
      if (Number.isFinite(available) && available < declaredBytes + 200 * 1024 * 1024) {
        return reply.code(400).send({
          error: `磁盘空间不足：读取备份 zip 需要约 ${(declaredBytes / 1024 ** 3).toFixed(2)} GB（另需预留 200 MB），当前可用 ${(available / 1024 ** 3).toFixed(2)} GB`,
        });
      }
    } catch {
      /* statfs 不可用就交给写入失败兜底 */
    }
  }
  let part;
  try {
    part = await req.file({ limits: { fileSize: BACKUP_UPLOAD_MAX_BYTES } });
  } catch (e) {
    return reply.code(400).send({ error: '无法读取上传的备份文件：' + (e?.message || e) });
  }
  if (!part) return reply.code(400).send({ error: '缺少备份文件（multipart 字段名 file）' });
  if (part.fieldname !== 'file') {
    part.file.resume();
    return reply.code(400).send({ error: '备份文件字段名必须是 file' });
  }

  const zipPath = newTmpZipPath('inspect');
  try {
    await pipeline(part.file, createWriteStream(zipPath));
    if (part.file.truncated) {
      throw new BackupError(
        400,
        `备份文件超过上限（${(BACKUP_UPLOAD_MAX_BYTES / 1024 ** 3).toFixed(0)} GB）`
      );
    }
    const inspected = await inspectBackupZip(zipPath);
    let tokenInfo;
    try {
      tokenInfo = storeInspectToken(zipPath, inspected.summary);
    } finally {
      rmSync(inspected.workDir, { recursive: true, force: true });
    }
    return { token: tokenInfo.token, expiresAt: tokenInfo.expiresAt, summary: inspected.summary };
  } catch (e) {
    try {
      unlinkSync(zipPath);
    } catch {
      /* ignore */
    }
    if (e instanceof BackupError) return reply.code(e.status || 400).send({ error: e.message });
    return reply.code(400).send({ error: '备份校验失败：' + (e?.message || String(e)) });
  }
});

/** 从备份恢复（F-SYS-04 第二步）：必须先 inspect 拿 token，再带 confirm:true 确认覆盖 */
app.post('/api/backup/restore', async (req, reply) => {
  if (!requireAdminInMulti(req, reply)) return;
  const b = req.body || {};
  try {
    return await restoreBackup({ token: b.token, confirm: b.confirm === true });
  } catch (e) {
    if (e instanceof BackupError) {
      return reply.code(e.status || 500).send({ error: e.message, ...e.extra });
    }
    return reply
      .code(500)
      .send({ error: '恢复失败，已回滚：' + (e?.message || String(e)), rolledBack: true });
  }
});

/** 稍后提醒（F-SYS-05）：默认 1 天，clamp 1..30；multi 写当前账号的 user_setting */
app.post('/api/backup/snooze', async (req, reply) => {
  if (!requireAdminInMulti(req, reply)) return;
  try {
    return setSnooze(req.body || {}, ownerOf(req));
  } catch (e) {
    if (e instanceof BackupError) return reply.code(e.status || 400).send({ error: e.message });
    return reply.code(500).send({ error: e?.message || String(e) });
  }
});

/** 备份提醒阈值（F-SYS-05）：只允许 7 / 14 / 30 / 60 / 90 天；multi 写当前账号的 user_setting */
app.post('/api/backup/settings', async (req, reply) => {
  if (!requireAdminInMulti(req, reply)) return;
  try {
    return setReminderDays(req.body || {}, ownerOf(req));
  } catch (e) {
    if (e instanceof BackupError) return reply.code(e.status || 400).send({ error: e.message });
    return reply.code(500).send({ error: e?.message || String(e) });
  }
});

// ───────────── 静态资源 ─────────────

if (existsSync(CONFIG.distDir)) {
  await app.register(fastifyStatic, { root: CONFIG.distDir, prefix: '/' });
}

app.setNotFoundHandler((req, reply) => {
  if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
  const index = join(CONFIG.distDir, 'index.html');
  if (existsSync(index)) return reply.type('text/html').send(createReadStream(index));
  return reply.type('text/html').send(`<!doctype html><meta charset="utf-8">
    <body style="font:15px/1.8 system-ui;background:#0b0d10;color:#e9ecef;padding:60px">
    <h2>服务已启动，但前端还没构建</h2>
    <p>开发时请用 <code>npm run dev</code>（Vite 在 5173）。</p>
    <p>或者先 <code>npm run build</code> 再访问这里。</p>
    <p style="color:#98a2b3">API 健康检查：<a style="color:#e8a15a" href="/api/health">/api/health</a></p>
    </body>`);
});

app.listen({ port: CONFIG.port, host: '127.0.0.1' })
  .then(async () => {
    console.log(`[api] http://127.0.0.1:${CONFIG.port}`);
    const ok = await hasFfmpeg();
    console.log(
      ok
        ? '[media] ffmpeg 已就绪：视频会生成封面帧和时长'
        : '[media] ffmpeg 不可用：视频能播，但没有封面帧（装好后重启服务即可）'
    );
  })
  .catch((e) => { console.error('[api] 启动失败：', e); process.exit(1); });
