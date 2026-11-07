import type { ProvinceBoundaryData } from './types';
import { pointInFeature } from '../map/provinces';

/**
 * 「坐标是否在国内」判断（2026-11-06 用户要求：暂不支持国外到访记录）。
 *
 * 天地图只有很粗的全球底图、搜索 / 逆地理基本只覆盖国内，所以打点时如果落点在国外，
 * 直接提示「暂不支持国外到访记录」并拒绝落点 / 保存。
 *
 * 判定数据用 34 个省级行政区边界（public/province-boundaries-low.json，约 40KB 概化版，
 * 与统计面板省份点亮同源）做点在多边形内判定；首次需要时懒加载并缓存。
 * 加载失败时退化为「中国大致经纬度范围」兜底（偏严格），避免国外坐标漏过。
 */
let bounds: ProvinceBoundaryData | null = null;
let loading: Promise<ProvinceBoundaryData | null> | null = null;

/** 懒加载省界数据（幂等；失败返回 null，下次调用会重试） */
export function loadChinaBounds(): Promise<ProvinceBoundaryData | null> {
  if (bounds) return Promise.resolve(bounds);
  if (!loading) {
    loading = fetch('/province-boundaries-low.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: ProvinceBoundaryData | null) => {
        if (d && Array.isArray(d.features) && d.features.length > 0) {
          bounds = d;
          return d;
        }
        return null;
      })
      .catch(() => null)
      .finally(() => {
        loading = null;
      });
  }
  return loading;
}

/** 同步判定：需先 `await loadChinaBounds()`。
 *  边界数据还没加载到（或加载失败）时，退化为「中国大致经纬度范围」兜底判断，
 *  宁可挡住个别边缘坐标，也不让明显在国外的坐标落库。 */
export function isInsideChina(lng: number, lat: number): boolean {
  if (!bounds) {
    // 粗范围：主land + 海南 + 台湾 + 港澳（南海外岛不在此列；需要时等数据加载完再精确判断）
    return lng >= 73.0 && lng <= 135.6 && lat >= 18.0 && lat <= 54.0;
  }
  return bounds.features.some((f) => pointInFeature(lng, lat, f));
}
