/**
 * 地理距离工具（2026-11-06 用户需求「离家距离」）
 *
 * 直线距离（Haversine），与 server/stats.mjs 里的公式一致：
 * 只用于展示「离家多远」，不是驾车 / 步行距离。
 */

/** 两点直线距离（km） */
export function haversineKm(lng1: number, lat1: number, lng2: number, lat2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 6371.0088;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** 距离展示：四舍五入到 1 位小数（1234.5 → "1,234.5"） */
export function fmtKm(km: number): string {
  return (Math.round(km * 10) / 10).toLocaleString('zh-CN', { maximumFractionDigits: 1 });
}
