import { api } from '../lib/api';
import type { Place } from '../lib/types';
import type { Cluster } from './cluster';

/**
 * 2026-11-12 T12（用户新需求）：地图标记上方封面缩略图。
 *
 * - 尺寸用户拍板：45×40、圆角 6px、间隙 4px（封面在上、飞镖在下，飞镖尖仍落在坐标点）；
 *   2026-11-12 用户看过预览后要求「图片太长，长度缩小一半」→ 宽度 90 → 45（高度保持 40）。
 * - 单点 / 聚合 / 家都显示；**秘密基地不显示**（防剧透）、想去 / 无照片（cover_id=null）不显示；
 * - 图上节点由 MapView 自己建 DOM，这里只放纯函数 + 建封面小工具，避免 MapView 里散落字符串。
 */

/** 封面宽度（px，2026-11-12 用户改为 45：原 90 太长，长度减半） */
export const COVER_W = 45;
/** 封面高度（px，用户拍板） */
export const COVER_H = 40;
/** 封面与飞镖之间的间隙（px） */
export const COVER_GAP = 4;
/** 有封面时 pin 在飞镖之上多出来的高度 */
export const COVER_EXTRA = COVER_H + COVER_GAP;

/**
 * 单点 / 家的封面缩略图 id：
 * - 秘密基地一律不显示（防剧透）；
 * - 想去（kind=wishlist）不显示；
 * - 无照片时服务端给 cover_id=null，不显示。
 */
export function coverIdOf(place: Place | null | undefined): string | null {
  if (!place) return null;
  if (place.secret) return null;
  if (place.kind === 'wishlist') return null;
  return place.cover_id || null;
}

/**
 * 聚合点的封面：用户拍板「也显示簇内封面」——取簇内**最近去过的成员**的封面：
 * 只从 kind=visited、非秘密基地、cover_id 非空 的成员里挑；last_date 最大者优先，
 * 全都没有封面时返回 null（聚合点回退为原来的纯图标尺寸）。
 */
export function clusterCoverId(c: Cluster): string | null {
  let bestId: string | null = null;
  let bestDate = '';
  for (const m of c.members) {
    if (!m || m.kind === 'wishlist' || m.secret) continue;
    const id = m.cover_id;
    if (!id) continue;
    const d = m.last_date || '';
    if (!bestId || d > bestDate) {
      bestId = id;
      bestDate = d;
    }
  }
  return bestId;
}

/**
 * 创建封面缩略图节点（由 MapView 插到 .pin 里、飞镖上方）：
 * - 懒加载（loading="lazy"）+ decoding="async"；加载成功后由 CSS 淡入（.loaded）；
 * - 加载失败（404 / 视频没抽到 poster 等）→ 移除节点并回调 onFail，让 pin 回退到无封面尺寸；
 * - 无封面返回 null（调用方不建节点，尺寸保持原样）。
 */
export function makeCover(coverId: string | null, onFail: () => void): HTMLDivElement | null {
  if (!coverId) return null;
  const box = document.createElement('div');
  box.className = 'pin-cover';
  const img = document.createElement('img');
  img.className = 'pin-cover-img';
  img.alt = '';
  img.draggable = false;
  img.loading = 'lazy';
  img.decoding = 'async';
  const show = () => img.classList.add('loaded');
  img.addEventListener('load', show, { once: true });
  img.addEventListener(
    'error',
    () => {
      box.remove();
      onFail();
    },
    { once: true }
  );
  box.appendChild(img);
  // 先挂监听再赋 src，避免缓存命中时错过 load 事件；仍在缓存中的同步完成兜底补一次
  img.src = api.thumbUrl(coverId);
  if (img.complete && img.naturalWidth > 0) show();
  return box;
}
