import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const local = readLocalConfig();

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
  /** 每用户默认存储配额（字节，默认 5 GiB，D-182 服务器 40G 盘 / 每人 5GB） */
  defaultQuotaBytes: 5 * 1024 ** 3,
  /** 首个管理员（AUTH_MODE=multi 且库里没有用户时自动创建；没有则只提示不创建） */
  adminUsername: typeof env.ADMIN_USERNAME === 'string' ? env.ADMIN_USERNAME.trim() : '',
  adminPassword: typeof env.ADMIN_PASSWORD === 'string' ? env.ADMIN_PASSWORD : '',
  tdtTk: localTdtTk || envTdtTk,
  dataDir,
  thumbDir,
  configPath,
  // 换电脑后可以在这里覆盖；留空则用 .env.local 里的值
  mediaRoot: local.mediaRoot ? resolve(local.mediaRoot) : defaultMediaRoot,
  // 家的位置（单点；null = 未设置）。只影响地图上的一个特殊标记，与 place 无关。
  home: normalizeHome(local.home),
  distDir: resolve(ROOT, 'dist'),
  publicDir: resolve(ROOT, 'public'),
};

for (const d of [CONFIG.dataDir, CONFIG.thumbDir, CONFIG.mediaRoot, CONFIG.publicDir]) {
  try {
    mkdirSync(d, { recursive: true });
  } catch (e) {
    console.error(`[config] 无法创建目录 ${d}：${e.message}`);
  }
}

/** 运行期切换素材库根目录，并持久化到 data/config.json */
export function setMediaRoot(p) {
  const abs = resolve(p);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    throw new Error('路径不存在或不是文件夹');
  }
  CONFIG.mediaRoot = abs;
  saveLocalConfig({ mediaRoot: abs });
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
