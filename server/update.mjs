/**
 * 应用更新检查（2026-11-08 D-319，用户要求：本地安装版能提示有没有新版本）。
 *
 * 只做「检查 + 提示」：读 GitHub 仓库最新版本（Release 优先，没有 Release 时退回 tag 列表），
 * 和当前 package.json 版本比较；**不做自动下载 / 自动替换**（本地是 node 服务 + 浏览器，
 * 自动覆盖有文件占用、杀毒拦截风险）。
 *
 * 行为约定（任何失败都不影响应用正常使用）：
 * - 只由服务端发起请求（浏览器不直连 GitHub，避开跨域与大陆网络差异）；
 * - Release 与 tag 列表**并行**请求，超时默认 8s；失败静默返回 ok:false；
 * - 成功结果缓存 6 小时（GitHub 未登录 API 限额 60 次/小时/IP，缓存后远低于限额）；
 * - 失败结果缓存 10 分钟，避免反复等待超时；
 * - 可用 `.env.local` 的 `UPDATE_REPO` 换仓库（默认 BruceLi007/TreadHorizon）、
 *   `UPDATE_CHECK=0` 关闭检查（返回 disabled）、`UPDATE_TIMEOUT_MS` 调超时。
 */
import { appVersion } from './backup.mjs';

const DEFAULT_REPO = 'BruceLi007/TreadHorizon';
const CACHE_TTL_OK = 6 * 60 * 60 * 1000;
const CACHE_TTL_FAIL = 10 * 60 * 1000;
const TIMEOUT_MS =
  Number(process.env.UPDATE_TIMEOUT_MS) > 0 ? Number(process.env.UPDATE_TIMEOUT_MS) : 8000;

/** 缓存：{ at, data }（data 不含 currentVersion） */
let cache = null;
/** 同一时刻只允许一个上游请求 */
let inflight = null;

/** "v0.2.10" / "0.2.10-beta" → [0, 2, 10]（只比较前三段数字） */
function versionParts(v) {
  const m = String(v ?? '')
    .trim()
    .replace(/^v/i, '')
    .match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}

/** latest 是否比 current 新（只比较前三位） */
function isNewer(latest, current) {
  const a = versionParts(latest);
  const b = versionParts(current);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

const repoOf = () => String(process.env.UPDATE_REPO || DEFAULT_REPO).trim() || DEFAULT_REPO;
const cleanTag = (tag) =>
  String(tag ?? '')
    .trim()
    .replace(/^v/i, '');

async function fetchLatest() {
  const repo = repoOf();
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'tread-horizon-update-check',
  };
  const now = () => new Date().toISOString();

  // Release 与 tag 列表并行请求：本项目当前只打 tag、没有 GitHub Release，
  // 所以 tag 列表是主路径；以后若建了 Release，优先用 Release 的说明 / 链接。
  const [relSettled, tagsSettled] = await Promise.allSettled([
    fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }),
    fetch(`https://api.github.com/repos/${repo}/tags?per_page=100`, {
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }),
  ]);

  // 1) Release（有就用）
  try {
    const relRes = relSettled.status === 'fulfilled' ? relSettled.value : null;
    if (relRes?.ok) {
      const rel = await relRes.json();
      const latestVersion = cleanTag(rel?.tag_name || rel?.name);
      if (latestVersion) {
        return {
          ok: true,
          latestVersion,
          releaseUrl: typeof rel?.html_url === 'string' ? rel.html_url : '',
          publishedAt: typeof rel?.published_at === 'string' ? rel.published_at : null,
          checkedAt: now(),
        };
      }
    }
  } catch {
    /* 解析失败就继续走 tag 列表 */
  }

  // 2) tag 列表（退回方案）：取最高的语义化版本 tag
  try {
    const tagRes = tagsSettled.status === 'fulfilled' ? tagsSettled.value : null;
    if (tagRes?.ok) {
      const tags = await tagRes.json();
      const versions = (Array.isArray(tags) ? tags : [])
        .map((x) => cleanTag(x?.name))
        .filter((v) => /^\d+\.\d+\.\d+$/.test(v))
        .sort((a, b) => {
          const pa = versionParts(a);
          const pb = versionParts(b);
          for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
          return 0;
        });
      const latestVersion = versions[versions.length - 1];
      if (latestVersion) {
        return {
          ok: true,
          latestVersion,
          // 没有 Release 时链接到仓库 tag 列表，用户能看到每一版
          releaseUrl: `https://github.com/${repo}/tags`,
          publishedAt: null,
          checkedAt: now(),
        };
      }
      return { ok: false, error: 'no version tags' };
    }
    return { ok: false, error: 'unreachable' };
  } catch {
    // 超时 / 断网 / GitHub 不可达：静默失败，前端显示「无法检查（不影响使用）」
    return { ok: false, error: 'unreachable' };
  }
}

/**
 * 检查更新（带缓存）。返回：
 * { ok, disabled?, currentVersion, latestVersion?, hasUpdate?, releaseUrl?, publishedAt?, checkedAt?, error? }
 */
export async function checkForUpdate() {
  const currentVersion = appVersion();
  if (process.env.UPDATE_CHECK === '0') {
    return { ok: false, disabled: true, currentVersion };
  }

  const now = Date.now();
  if (cache && now - cache.at < (cache.data.ok ? CACHE_TTL_OK : CACHE_TTL_FAIL)) {
    return { ...cache.data, currentVersion };
  }
  if (inflight) return inflight;

  inflight = fetchLatest()
    .then((data) => {
      cache = { at: Date.now(), data };
      const hasUpdate = data.ok ? isNewer(data.latestVersion, currentVersion) : false;
      return { ...data, currentVersion, hasUpdate };
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}
