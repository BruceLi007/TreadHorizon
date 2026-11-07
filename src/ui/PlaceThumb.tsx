import { useState } from 'react';
import { api } from '../lib/api';
import { homeMarkerSrc, readHomeColor } from '../lib/homeIcon';
import { markerSrc, readMarkerColors } from '../lib/markerColors';
import type { Place } from '../lib/types';

interface Props {
  place: Place;
  /** 额外类名：树形列表地点行的小封面用 `place-row-cover`（见 MyTrailPanel.css） */
  className?: string;
}

/**
 * 地点封面（2026-11-04，D-97；D-115 起用于 My旅迹树形列表的 32px 小封面）。
 *
 * 有封面（`place.cover_id`，服务端 COVER_SUBQUERY 会自动取显式封面或最早一张照片）
 * 就显示缩略图；没有封面 / 加载失败时用对应标记占位（去过 / 想去 / 秘密基地按设置里选的配色，
 * 家按「家图标配色」，2026-11-05 D-164 起三种普通图标也可配色），
 * 比灰色占位块更能一眼区分地点类型。只做展示，点击由外层行处理。
 *
 * 用法：传 `className="place-row-cover"` → 32×32 圆角小方图（My旅迹树形列表用）。
 * 配色偏好直接读 localStorage（与 D-161 家图标的做法一致），由 App 在切换配色时同步写入。
 */
export default function PlaceThumb({ place, className }: Props) {
  const [broken, setBroken] = useState(false);
  const cover = place.cover_id && !broken ? place.cover_id : null;
  const fallback =
    place.kind === 'wishlist'
      ? markerSrc('wishlist', readMarkerColors())
      : place.home === 1
        ? homeMarkerSrc(readHomeColor())
        : place.secret === 1
          ? markerSrc('secret', readMarkerColors())
          : markerSrc('visited', readMarkerColors());

  return (
    <div className={className ? `place-thumb ${className}` : 'place-thumb'} aria-hidden="true">
      {cover ? (
        <img
          className="pt-cover"
          src={api.thumbUrl(cover)}
          alt=""
          loading="lazy"
          onError={() => setBroken(true)}
        />
      ) : (
        <img className="pt-dart" src={fallback} alt="" loading="lazy" />
      )}
    </div>
  );
}
