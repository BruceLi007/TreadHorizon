/**
 * 应用更新提醒的本地偏好（2026-11-09 D-327，用户要求：GitHub 有更新时在设置上弹小红点）。
 *
 * 只存本机浏览器：用户点「不再提醒这个版本」后，这个版本的红点隐藏；
 * 升级到更新的版本 / 点「恢复提醒」后重新生效。不写 data/、不进备份。
 */
import type { UpdateCheckResult } from './types';

/** localStorage key：被用户忽略的那个版本号（空 = 没有忽略任何版本） */
export const UPDATE_IGNORE_KEY = 'tm-update-ignore-version';

/** 读被忽略的版本号；隐私模式 / 坏数据一律返回空串 */
export function readIgnoredUpdateVersion(): string {
  try {
    return (localStorage.getItem(UPDATE_IGNORE_KEY) || '').trim();
  } catch {
    return '';
  }
}

/** 记住 / 清除被忽略的版本号（null = 恢复提醒） */
export function saveIgnoredUpdateVersion(version: string | null): void {
  try {
    if (version) localStorage.setItem(UPDATE_IGNORE_KEY, version);
    else localStorage.removeItem(UPDATE_IGNORE_KEY);
  } catch {
    /* 隐私模式下可能写不进去，忽略 */
  }
}

/**
 * 是否应该显示「有新版本」提醒（顶栏「设置」红点 / 设置导航「关于」红点）：
 * 检查成功、确实有更新、且用户没有忽略这个具体版本。
 */
export function updateReminder(
  result: UpdateCheckResult | null,
  ignoredVersion: string
): boolean {
  if (!result?.ok || !result.hasUpdate || !result.latestVersion) return false;
  return result.latestVersion !== ignoredVersion;
}
