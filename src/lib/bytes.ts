/**
 * 字节数展示（M6 P2-3，D-204）
 *
 * 设置 → 账号 / 用户管理里的「已用空间」显示用；只做展示，不做业务判断。
 * （formatQuota 为配额展示预留：2026-11-07 D-209 起当前 UI 不再显示配额，等 P1 上云后启用。）
 */

/** 1024 进制，保留 1 位小数：999 B / 1.5 KB / 12.3 MB / 5.0 GB / 1.2 TB */
export function formatBytes(bytes: number | null | undefined): string {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** 配额展示：≥1 GB 用 GB（1 位小数），否则 MB；0 / 空返回 — */
export function formatQuota(bytes: number | null | undefined): string {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(n / 1024 ** 2))} MB`;
}
