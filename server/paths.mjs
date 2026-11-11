/**
 * 跨平台路径工具（2026-11-11 D-388 / backup/LOCAL-CROSSPLATFORM-BRIEF.md Phase 1）
 *
 * 背景：本地版以前把 `media.rel_path` 按本机分隔符入库（Windows 是 `\`），换到 macOS 后
 * `path.resolve(root, 'a\\b')` 会把整串当一个文件名 → 素材全部找不到。从本版起统一约定：
 *
 * 1. **数据库里的路径一律 POSIX `/`**：`media.rel_path` / `media.thumb` / `media.poster`
 *    两种模式（local / multi）都只存 `a/b/c` 形式；读写时用本文件的 helper 转本地绝对路径。
 * 2. **config.json 里的路径**（`mediaRoot` / `backupDir`）：
 *    - 程序默认值不落盘，运行期直接算（`.dev-media`、`data/backups`）；
 *    - 用户自定义路径若落在**程序目录内**，存「相对 ROOT 的 POSIX 路径」（整个文件夹拷到
 *      Mac / 另一台 Windows 都能直接用，见 BRIEF 迁移路径 B）；
 *    - 程序目录外的自定义路径存绝对路径（换系统后由启动自愈 / `scripts/migrate-paths.mjs` 处理）。
 *
 * 本模块只依赖 node:path，不 import 任何 server 模块 —— 这样 scripts / smoke / 迁移工具都能
 * 独立引用，不会意外拉起数据库或配置初始化。
 *
 * 约定（所有调用方都按这个来）：
 * - `relToAbs(root, rel)`：存储值 → 本机绝对路径（`\` 与 `/` 都接受，按 POSIX 先归一）；
 * - `absToRel(root, abs)`：本机绝对路径 → 存储值（POSIX `/`）；
 * - `safeResolve(root, rel)`：relToAbs + 越界校验（含 `..` 段一律拒绝），路由读文件用这个；
 * - `isInside(root, abs)`：严格在 root 内部（不含 root 自身）；`isInsideOrEqual` 含自身；
 * - `normalizeRel(rel)`：清洗存储值（`\`→`/`、折叠斜杠、去掉首尾 `/` 与 `./`）；
 * - `resolveConfigPath(root, value)` / `portableConfigPath(root, abs)`：config.json 路径读写；
 * - `isForeignAbsolute(value)`：明显来自另一个平台 / 另一种分隔符的绝对路径（启动自愈用）。
 */
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * 把数据库 / 备份包里的相对路径清洗成统一的 POSIX 形式。
 * 例：`a\\b/c` → `a/b/c`；`./a//b/` → `a/b`；空值 → `''`。
 * 注意：这里**不校验越界**（`..` 段保留，交给 safeResolve 拒绝），也不处理绝对路径。
 */
export function normalizeRel(rel) {
  if (rel == null) return '';
  let s = String(rel).replace(/\\/g, '/');
  s = s.replace(/\/+/g, '/');
  s = s.replace(/^\.\/+/, '');
  s = s.replace(/^\/+/, '');
  s = s.replace(/\/+$/, '');
  return s === '.' ? '' : s;
}

/** 存储值 → 路径分段数组（过滤空段；`..` 段保留，由 safeResolve 拒绝） */
export function relSegments(rel) {
  return normalizeRel(rel)
    .split('/')
    .filter((seg) => seg && seg !== '.');
}

/**
 * 存储值（POSIX `/`）→ 本机绝对路径。
 * 用 `/` 拆段再 `path.join`，所以在 Windows 上得到 `C:\\...\\a\\b`、在 macOS 上得到 `/.../a/b`。
 */
export function relToAbs(root, rel) {
  const base = resolve(String(root ?? ''));
  const segs = relSegments(rel);
  if (segs.length === 0) return base;
  return join(base, ...segs);
}

/** 本机绝对路径 → 存储值（POSIX `/`；路径不在 root 内时返回带 `../` 的相对值，调用方自行校验） */
export function absToRel(root, abs) {
  const base = resolve(String(root ?? ''));
  const target = resolve(String(abs ?? ''));
  return relative(base, target).split(sep).join('/');
}

/** target 是否严格在 root 内部（不含 root 自身） */
export function isInside(root, target) {
  const base = resolve(String(root ?? ''));
  const abs = resolve(String(target ?? ''));
  if (abs === base) return false;
  const prefix = base.endsWith(sep) ? base : base + sep;
  return abs.startsWith(prefix);
}

/** target 是否在 root 内部或就是 root 自身 */
export function isInsideOrEqual(root, target) {
  const base = resolve(String(root ?? ''));
  const abs = resolve(String(target ?? ''));
  return abs === base || isInside(base, abs);
}

/**
 * 存储值 → 绝对路径 + 越界校验（素材路由 / 缩略图 / 回收站删除等所有「按 DB 路径读盘」都要用）。
 * `..` 段一律拒绝；拼出来的绝对路径必须严格在 root 内部（root 自身允许传空 rel）。
 */
export function safeResolve(root, rel) {
  const base = resolve(String(root ?? ''));
  const segs = relSegments(rel);
  for (const seg of segs) {
    if (seg === '..') throw new Error(`非法相对路径（含 ..）：${rel}`);
  }
  const abs = segs.length === 0 ? base : join(base, ...segs);
  if (abs !== base && !isInside(base, abs)) throw new Error(`路径越界：${rel}`);
  return abs;
}

/** 当前平台路径里空值 / 相对路径的判定（config.json 读取时用） */
export function isAbsoluteAnyPlatform(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return false;
  return isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw) || /^\\\\/.test(raw);
}

/**
 * 读取 config.json 里用户自定义的路径：
 * - 相对路径 → 相对「程序目录 ROOT」解析（跨平台可移植的写法）；
 * - 绝对路径 → 原样 resolve（启动自愈负责判断异平台 / 不存在）；
 * - 空值 → 返回 ''（调用方用默认值）。
 */
export function resolveConfigPath(root, value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (isAbsoluteAnyPlatform(raw)) return resolve(raw);
  return resolve(String(root ?? ''), raw);
}

/**
 * 把用户刚选择的绝对路径转成 config.json 里的存储值：
 * - 落在程序目录内 → 「相对 ROOT 的 POSIX 路径」（整个文件夹拷贝跨平台可用）；
 * - 在程序目录外 / 就是 ROOT 本身 → 绝对路径（换系统后交给自愈 / migrate-paths）。
 */
export function portableConfigPath(root, abs) {
  const base = resolve(String(root ?? ''));
  const target = resolve(String(abs ?? ''));
  const rel = relative(base, target).split(sep).join('/');
  if (!rel || rel === '.' || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) return target;
  return rel;
}

/**
 * 是否为「明显不属于当前平台」的绝对路径，用于启动自愈判断 config.json 里的旧路径：
 * - 当前是 Windows：POSIX 绝对路径（`/Users/...`）视为异平台；
 * - 当前是 macOS / Linux：Win 盘符路径（`D:\\...`）、UNC（`\\\\server\\...`）或含 `\` 的路径视为异平台。
 * 说明：POSIX 上 `\` 是合法文件名字符，但本项目的数据只会来自 Windows 路径，按异平台处理更安全
 * （自愈只在「路径本身也不存在」时才会真正回落，见 config.mjs）。
 */
export function isForeignAbsolute(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return false;
  const winAbs = /^[A-Za-z]:[\\/]/.test(raw) || /^\\\\/.test(raw);
  const posixAbs = raw.startsWith('/');
  if (process.platform === 'win32') return posixAbs && !winAbs;
  return winAbs || raw.includes('\\');
}
