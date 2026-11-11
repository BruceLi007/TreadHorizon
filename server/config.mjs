import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, statSync, accessSync, constants as fsConstants } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isAbsoluteAnyPlatform,
  isForeignAbsolute,
  portableConfigPath,
  resolveConfigPath,
} from './paths.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// 读取 .env.local（Node 20.12+ 原生支持，不需要 dotenv 包）
const envPath = resolve(ROOT, '.env.local');
if (existsSync(envPath)) {
  try {
    process.loadEnvFile(envPath);
  } catch (e) {
    console.warn('[config] .env.local 读取失败：', e.message);
  }
}

const env = process.env;
const isDev = process.argv.includes('--dev');

const dataDir = env.DATA_DIR ? resolve(env.DATA_DIR) : resolve(ROOT, 'data');
const thumbDir = resolve(dataDir, 'thumbs');
const configPath = resolve(dataDir, 'config.json');

// 应用自己管理的配置（优先级高于 .env.local，方便运行期改媒体库路径）
export function readLocalConfig() {
  try {
    return JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    return {};
  }
}

export function saveLocalConfig(patch) {
  const next = { ...readLocalConfig(), ...patch };
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify(next, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('[config] 写入 config.json 失败：', e.message);
    return false;
  }
}

// 默认路径：开发期用仓内 .dev-media，正式运行用 MEDIA_ROOT
const defaultMediaRoot = isDev
  ? resolve(env.MEDIA_ROOT_DEV || resolve(ROOT, '.dev-media'))
  : resolve(env.MEDIA_ROOT || resolve(ROOT, '.dev-media'));

/** 默认备份目录（恢复前自动备份写这里）；2026-11-11 D-364 起可在设置里改到其它盘 */
const defaultBackupDir = resolve(dataDir, 'backups');

const local = readLocalConfig();

// ─────────── data/config.json 里的路径启动自愈（2026-11-11 D-388）───────────
//
// 背景（LOCAL-CROSSPLATFORM-BRIEF §3.4 / §3.5）：老版本的 data/config.json 把 mediaRoot /
// backupDir 存成**本机绝对路径**（`D:\\图片`、`/Users/me/…`）。换电脑 / 换系统后：
// - 该路径不存在（Windows 用户换 Mac、外接盘没插）；
// - 或者是另一个系统的写法（Mac 上 `D:\\图片` 会被当普通文件名 mkdir 出怪目录）。
// 处理口径：**相对路径**（本版起程序目录内的自定义路径按相对形式存）= 相对程序目录解析，
// 整个文件夹拷到另一台机器也能用；**绝对路径**若明显异平台 / 目录不存在 → 回落默认值，
// 并先把原 config.json 备份成 `config.json.bak-YYYYMMDD-HHmmss`（换回旧机器后可用
// scripts/migrate-paths.mjs 重新映射，不会悄悄丢用户配置）。

/** 本地时间 YYYYMMDD-HHmmss（备份文件名用，跟项目里备份 zip 的命名习惯一致） */
function timestampStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(
    d.getSeconds()
  )}`;
}

/**
 * 启动自愈前先把原 data/config.json 留档（config.json.bak-YYYYMMDD-HHmmss）。
 * 失败只打日志、不阻断启动；返回备份文件名（失败 / 没有原文件返回 null）。
 */
function backupConfigFile(reason) {
  if (!existsSync(configPath)) return null;
  const name = `config.json.bak-${timestampStamp()}`;
  const target = resolve(dirname(configPath), name);
  try {
    copyFileSync(configPath, target);
    return name;
  } catch (e) {
    console.warn(`[config] 备份 data/config.json 失败（${reason}）：`, e?.message || e);
    return null;
  }
}

/**
 * 从 data/config.json 读一个「目录路径」配置项，并就地做跨平台自愈。
 *
 * @param {'mediaRoot'|'backupDir'} key config.json 里的字段名
 * @param {string} defaultValue 回落用的默认绝对路径（默认值仍按 ROOT / dataDir / 环境变量算）
 * @returns {{ value: string, source: 'default'|'relative'|'absolute'|'fallback', detail: string }}
 *   source=fallback 时 detail 是回落原因（用于日志）；value 是实际生效的绝对路径。
 */
function readConfigDir(key, defaultValue) {
  const raw = typeof local[key] === 'string' ? local[key].trim() : '';
  if (!raw) return { value: defaultValue, source: 'default', detail: '' };

  // 1) 明显是另一个系统的绝对路径（盘符 / UNC / 含 `\` 的路径 / POSIX 绝对路径）→ 回落默认
  if (isForeignAbsolute(raw)) {
    return { value: defaultValue, source: 'fallback', detail: `是其它操作系统的绝对路径「${raw}」` };
  }

  // 2) 相对路径：相对程序目录 ROOT 解析（跨平台可移植写法）
  if (!isAbsoluteAnyPlatform(raw)) {
    return { value: resolveConfigPath(ROOT, raw), source: 'relative', detail: `「${raw}」` };
  }

  // 3) 本机绝对路径：目录必须存在（换电脑 / 移动硬盘没插时不强行 mkdir 出旧路径）
  const abs = resolveConfigPath(ROOT, raw);
  let isDir = false;
  try {
    isDir = existsSync(abs) && statSync(abs).isDirectory();
  } catch {
    /* 读不到 = 不可用 */
  }
  if (!isDir) {
    return { value: defaultValue, source: 'fallback', detail: `目录不存在或不是文件夹「${raw}」` };
  }
  return { value: abs, source: 'absolute', detail: '' };
}

const mediaRootConfig = readConfigDir('mediaRoot', defaultMediaRoot);
const backupDirConfig = readConfigDir('backupDir', defaultBackupDir);

{
  const fallbacks = [
    ['mediaRoot', mediaRootConfig],
    ['backupDir', backupDirConfig],
  ].filter(([, r]) => r.source === 'fallback');
  if (fallbacks.length) {
    const reason = fallbacks.map(([k, r]) => `${k} ${r.detail}`).join('；');
    const backupName = backupConfigFile(reason);
    // 原值已留档到 .bak；把不可用的键从 config.json 摘掉，避免每次启动重复回落 / 重复备份。
    // （不改成默认值：默认值本来就运行时算，摘掉即回落默认；旧值在 .bak 里可供 migrate-paths 使用）
    if (backupName) {
      const rest = { ...readLocalConfig() };
      for (const [k] of fallbacks) delete rest[k];
      try {
        writeFileSync(configPath, JSON.stringify(rest, null, 2), 'utf8');
      } catch (e) {
        console.warn('[config] 清理 data/config.json 里不可用的路径失败：', e?.message || e);
      }
    }
    for (const [k, r] of fallbacks) {
      console.warn(
        `[config] ⚠️ data/config.json 的 ${k} 不可用（${r.detail}），已回落到默认：${r.value}` +
          (backupName
            ? `；原配置已备份为 ${backupName}（换回原机器后可用 scripts/migrate-paths.mjs 重新映射）`
            : '；原配置备份失败，文件保持原样')
      );
    }
  }
  if (mediaRootConfig.source === 'relative') {
    console.log(`[config] 素材库路径来自 data/config.json（相对程序目录）${mediaRootConfig.detail}`);
  }
  if (backupDirConfig.source === 'relative') {
    console.log(`[config] 备份目录来自 data/config.json（相对程序目录）${backupDirConfig.detail}`);
  }
}

// 天地图 Key 优先级：data/config.json 的 tdtTk（设置页写入）> .env.local 的 TDT_TK。
// 注意：key 只进 CONFIG / 下发给前端地图，绝不写日志。
const localTdtTk = typeof local.tdtTk === 'string' ? local.tdtTk.trim() : '';
const envTdtTk = typeof env.TDT_TK === 'string' ? env.TDT_TK.trim() : '';

/**
 * 家（M5.1）：一个单独的地图坐标点，存在 data/config.json.home = { lng, lat }。
 * 不是地点记录：不参与聚合/统计/清单；非法值一律按「未设置」处理。
 */
export function normalizeHome(v) {
  if (!v || typeof v !== 'object') return null;
  const lng = Number(v.lng);
  const lat = Number(v.lat);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  if (lng < -180 || lng > 180 || lat < -90 || lat > 90) return null;
  return { lng, lat };
}

export const CONFIG = {
  root: ROOT,
  isDev,
  port: Number(env.PORT || 4000),
  /**
   * 2026-11-07 D-248（用户反馈「上传大文件报 Payload Too Large」）：
   * 单文件上传上限，默认 8 GiB；.env.local 里可用 MAX_UPLOAD_GB 调整（例如 16 / 4 / 2）。
   * 旧版硬编码 2 GiB，超过会被截断成 2 GiB 的半截文件并可能入库。
   */
  maxUploadBytes: (() => {
    const gb = Number(env.MAX_UPLOAD_GB);
    return Number.isFinite(gb) && gb > 0 ? Math.floor(gb * 1024 ** 3) : 8 * 1024 ** 3;
  })(),
  /**
   * 账号模式（2026-11-06 M6 P2-1，D-200）：
   * - `local`（默认）：单机本地模式，行为与以前完全一致，不需要登录；
   * - `multi`：云端多用户模式，启用账号 / 会话 / 邀请码（P2-2 起所有数据接口按用户隔离）。
   * 只认 local / multi 两个值，非法值回落到 local。
   */
  authMode: env.AUTH_MODE === 'multi' ? 'multi' : 'local',
  /** 会话有效期（天，默认 30；滚动续期） */
  sessionDays: Number(env.SESSION_DAYS) > 0 ? Number(env.SESSION_DAYS) : 30,
  /** 云端 HTTPS 部署时置 1：会话 Cookie 加 Secure（本地 http 调试不要开） */
  cookieSecure: env.COOKIE_SECURE === '1',
  /**
   * 每用户默认存储配额（2026-11-08 D-310，用户要求：云端版每人默认 1 GB，可以申请扩容）。
   * - 只在 `AUTH_MODE=multi` 生效：上传按「已用空间 + 本文件 ≤ 配额」拦截；回收站里还没彻底
   *   删除的素材也计入（反映磁盘真实占用）；
   * - `local` 单机模式不受限（行为与以前一致）；
   * - `.env.local` 里可用 `DEFAULT_QUOTA_GB` 调整默认值（例如 2 / 5），账号自己的
   *   `user.quota_bytes > 0` 时优先用自己的值（管理员可在用户管理里调整）。
   */
  defaultQuotaBytes: (() => {
    const gb = Number(env.DEFAULT_QUOTA_GB);
    return Number.isFinite(gb) && gb > 0 ? Math.floor(gb * 1024 ** 3) : 1 * 1024 ** 3;
  })(),
  /** 首个管理员（AUTH_MODE=multi 且库里没有用户时自动创建；没有则只提示不创建） */
  adminUsername: typeof env.ADMIN_USERNAME === 'string' ? env.ADMIN_USERNAME.trim() : '',
  adminPassword: typeof env.ADMIN_PASSWORD === 'string' ? env.ADMIN_PASSWORD : '',
  /**
   * 首次初始化示例足迹（2026-11-09）：本地版启动 / 云端版首次登录时，若该作用域还是空库，
   * 自动生成 34 个省级行政区省会的示例数据（各 1 次到访 + 1 张卡通贴照片）。
   * 默认开启；.env.local 里 `STARTER_DATA=0` 可关闭（已有数据的库 / 账号只补标记、不会写入）。
   */
  starterData: env.STARTER_DATA !== '0',
  /**
   * 秘密基地的初始密码（2026-11-09 D-328 / D-329）：首次初始化时自动设置。
   * 默认 12345678；`.env.local` 的 `STARTER_SECRET_PASSWORD` 可覆盖（云端部署建议改掉）。
   * 设置 → 安全 页面会显示「（初始密码为…）」提示，用户可自行修改 / 重置。
   */
  starterSecretPassword: (() => {
    const p = String(env.STARTER_SECRET_PASSWORD || '').trim();
    return p || '12345678';
  })(),
  /**
   * 只读样板展示（2026-11-09 D-335，用户要求「把云端版当样板展示窗口」）：
   * 配置 DEMO_USERNAME 后（仅 AUTH_MODE=multi 生效），登录页出现「浏览样板展示（只读）」入口：
   * 访客无需密码即可创建该账号的**只读会话**（不能打点 / 上传 / 删除 / 改密码）；
   * 账号本人仍可用密码正常登录维护展示内容。留空 = 关闭（默认，local 模式完全不受影响）。
   */
  demoUsername: typeof env.DEMO_USERNAME === 'string' ? env.DEMO_USERNAME.trim() : '',
  tdtTk: localTdtTk || envTdtTk,
  dataDir,
  thumbDir,
  configPath,
  /**
   * 素材库根目录（2026-11-11 D-388）：data/config.json 里的值先过启动自愈
   * （相对路径相对程序目录解析；异平台 / 不存在的绝对路径回落到默认并备份原配置）。
   */
  mediaRoot: mediaRootConfig.value,
  /**
   * 备份目录（2026-11-11 D-364 用户要求）：恢复前自动备份（pre-restore-*.zip）写到这里，
   * 可在 设置 → 备份与恢复 里选择（仅本地模式）。默认 data/backups，存 data/config.json.backupDir。
   * 读取时同样过启动自愈（D-388）。
   */
  backupDir: backupDirConfig.value,
  // 家的位置（单点；null = 未设置）。只影响地图上的一个特殊标记，与 place 无关。
  home: normalizeHome(local.home),
  distDir: resolve(ROOT, 'dist'),
  publicDir: resolve(ROOT, 'public'),
};

for (const d of [CONFIG.dataDir, CONFIG.thumbDir, CONFIG.mediaRoot, CONFIG.backupDir, CONFIG.publicDir]) {
  try {
    mkdirSync(d, { recursive: true });
  } catch (e) {
    console.error(`[config] 无法创建目录 ${d}：${e.message}`);
  }
}

/** 默认备份目录（未自定义时） */
export function getDefaultBackupDir() {
  return defaultBackupDir;
}

/**
 * 运行期切换备份目录（设置 → 备份与恢复 → 选择备份目录），持久化到 data/config.json.backupDir。
 * - 目录不存在时自动创建；创建 / 写入失败抛出可读错误（前端提示）。
 * - 只改「以后写备份的位置」，不移动已有备份文件。
 * - 2026-11-11 D-388：持久化时用 portableConfigPath —— 程序目录内的路径存「相对 ROOT 的
 *   POSIX 路径」（整个文件夹拷贝到 Mac / 另一台 Windows 后仍然指得到），程序目录外存绝对路径。
 */
export function setBackupDir(p) {
  const raw = String(p ?? '').trim();
  if (!raw) throw new Error('备份目录不能为空');
  const abs = resolveConfigPath(ROOT, raw);
  try {
    if (!existsSync(abs)) mkdirSync(abs, { recursive: true });
    if (!statSync(abs).isDirectory()) throw new Error('路径不是文件夹');
    accessSync(abs, fsConstants.W_OK);
  } catch (e) {
    throw new Error('目录不存在或不可写：' + (e?.message || String(e)));
  }
  if (!saveLocalConfig({ backupDir: portableConfigPath(ROOT, abs) })) {
    throw new Error('写入 data/config.json 失败');
  }
  CONFIG.backupDir = abs;
  return abs;
}

/**
 * 运行期切换素材库根目录，并持久化到 data/config.json。
 * 2026-11-11 D-388：持久化同样用 portableConfigPath（程序目录内存相对 POSIX / 外部存绝对）。
 */
export function setMediaRoot(p) {
  const raw = String(p ?? '').trim();
  const abs = resolveConfigPath(ROOT, raw);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    throw new Error('路径不存在或不是文件夹');
  }
  CONFIG.mediaRoot = abs;
  saveLocalConfig({ mediaRoot: portableConfigPath(ROOT, abs) });
  return abs;
}

/**
 * 运行期写入天地图 Key（设置页用）：持久化到 data/config.json 并更新 CONFIG.tdtTk。
 * 只返回是否成功，绝不打印 / 回显 key。
 */
export function setTdtKey(key) {
  const next = String(key ?? '').trim();
  if (!next) return false;
  if (!saveLocalConfig({ tdtTk: next })) return false;
  CONFIG.tdtTk = next;
  return true;
}

/**
 * 运行期写入「家」的位置（顶栏「家」→ 地图打点）：持久化到 data/config.json.home
 * 并更新 CONFIG.home。只有一个家；再次调用 = 覆盖。
 * @returns {{lng:number,lat:number}|null} 保存成功返回归一化后的点，失败返回 null
 */
export function setHome(home) {
  const next = normalizeHome(home);
  if (!next) return null;
  if (!saveLocalConfig({ home: next })) return null;
  CONFIG.home = next;
  return next;
}

/**
 * 清除旧版「家坐标」（2026-11-04 起家改为普通地点 place.home=1；
 * 这个坐标只用于把用户之前设置过的家一次性迁移成地点，迁移完客户端会调这里清掉）。
 */
export function clearHome() {
  saveLocalConfig({ home: null });
  CONFIG.home = null;
  return null;
}

if (!CONFIG.tdtTk) {
  console.warn(
    '[config] ⚠️  没有读到天地图 Key（TDT_TK），地图会加载不出来。请在设置页填写，或写到 .env.local。'
  );
}
console.log(`[config] ${CONFIG.isDev ? '开发' : '运行'}模式，素材库：${CONFIG.mediaRoot}`);
