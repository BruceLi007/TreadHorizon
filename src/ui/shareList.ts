import type { Place, PlaceDetail } from '../lib/types';

/**
 * 2026-11-14 D-422（用户验收反馈）：
 * 分享选择态**直接复用 My旅迹 的省 → 市 → 地点列表**（VisitedPanel / WishlistPanel 原样），
 * 只在每个地点行前多一个三态勾选框；不再维护单独的扁平 SharePlaceList。
 *
 * 2026-11-15 D-427（用户拍板「秘密基地还是不参与分享吧，默认不允许分享」）：
 * 秘密基地**不可勾**（行仍显示，勾选框禁用并提示），省 / 市整组勾选也跳过它们；
 * 服务端导出 / 导入各有一道拒绝做兜底。
 */
export interface ShareListBinding {
  selectedPlaceIds: Set<string>;
  selectedMediaIds: Set<string>;
  detailMap: Map<string, PlaceDetail>;
  /** 地点级：切换该地点的全部照片（三态） */
  onToggle: (p: Place) => void;
  /** 省 / 市分组级：整组选中（select=true）或整组取消 */
  onSelectPlaces: (places: Place[], select: boolean) => void;
  /** 到访级：切换这一次到访的全部照片 */
  onToggleVisit: (ids: string[]) => void;
  /** 单张照片 */
  onTogglePhoto: (id: string) => void;
}

/** 一个地点下可分享的照片 id（视频不参与分享，直接排除） */
export function sharePhotoIds(detail?: PlaceDetail): string[] {
  if (!detail) return [];
  const out: string[] = [];
  for (const v of detail.visits || []) {
    for (const m of v.media || []) {
      if (m.kind === 'photo') out.push(m.id);
    }
  }
  return out;
}

/**
 * 地点行的三态：0 未选 / 1 部分 / 2 全选。
 * 详情已加载时按「照片 id 命中数」算；还没加载（或没有照片的地点，如家 / 想去）时退回地点级选择集。
 */
export function sharePlaceState(p: Place, b: ShareListBinding): 0 | 1 | 2 {
  const ids = sharePhotoIds(b.detailMap.get(p.id));
  if (ids.length > 0) {
    let n = 0;
    for (const id of ids) if (b.selectedMediaIds.has(id)) n += 1;
    return n === 0 ? 0 : n === ids.length ? 2 : 1;
  }
  return b.selectedPlaceIds.has(p.id) ? 2 : 0;
}

/** 一组照片 id 的三态（省 / 市 / 到访共用） */
export function shareIdsState(ids: string[], selected: Set<string>): 0 | 1 | 2 {
  if (!ids.length) return 0;
  let n = 0;
  for (const id of ids) if (selected.has(id)) n += 1;
  return n === 0 ? 0 : n === ids.length ? 2 : 1;
}

/** 秘密基地：不参与分享（D-427），行内勾选框禁用 */
export function sharePlaceSecret(p: Place): boolean {
  return p.secret === 1;
}

/** 仅视频的地点（视频不参与分享）→ 不可勾 */
export function sharePlaceVideoOnly(p: Place): boolean {
  return (p.photos ?? 0) === 0 && (p.videos ?? 0) > 0;
}

/** 不可勾：秘密基地 或 仅视频 */
export function sharePlaceDisabled(p: Place): boolean {
  return sharePlaceSecret(p) || sharePlaceVideoOnly(p);
}
