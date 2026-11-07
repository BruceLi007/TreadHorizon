import { useCallback, useEffect, useRef, useState } from 'react';
import { loadTdt } from '../lib/tdt';
import { homeMarkerHex, homeMarkerSrc, type HomeColor } from '../lib/homeIcon';
import {
  DEFAULT_MARKER_COLORS,
  hexToRgba,
  markerHex,
  markerSrc,
  type MarkerColorPrefs,
  type MarkerKind,
} from '../lib/markerColors';
import { useT, useTp, useLang, tr } from '../i18n';
import { fmtKm, haversineKm } from '../lib/geo';
import {
  clusterPlaces,
  clusterLabel,
  clusterSub,
  clusterKind,
  zoomToSpread,
  markerSize,
  type Cluster,
} from './cluster';
import type { Place, ProvinceBoundaryData, ProvinceBoundaryFeature, ProvinceLight } from '../lib/types';
import {
  PROVINCE_FILLS,
  PROVINCE_STROKES,
  buildLightIndex,
  featureBBox,
  pointInFeature,
  provinceLevel,
} from './provinces';

/** 与天地图投影同一基准的墨卡托纬度函数（只差一个常数，标定时会被吸收） */
function mercY(lat: number): number {
  const s = Math.sin((lat * Math.PI) / 180);
  return Math.log((1 + s) / (1 - s)) / 2;
}

/**
 * 2026-11-05 D-150：由稳定 seed（地点 id / 聚合 key）派生确定性的呼吸相位。
 * 标记节点在「选中 / 数据变化 / 切语言」时会被重建；如果相位随机，重建会「跳一下」。
 * 用哈希算出的固定时长 + 负延迟，重建后仍停在同一相位，视觉上是连续的。
 */
function animPhase(seed: string): { dur: number; delay: number } {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const u = (h >>> 0) / 4294967296;
  // 3.6–5.8s 一个呼吸周期；负延迟把每个点的起始相位错开（避免整张图像机器人一样同步）
  return { dur: 3.6 + u * 2.2, delay: -(u * 6.4) };
}

/** 把相位写到外层 .pin 上，内层动画通过继承的 CSS 变量读取 */
function applyPhase(el: HTMLElement, prefix: 'breath' | 'pulse', seed: string) {
  const { dur, delay } = animPhase(seed);
  el.style.setProperty(`--${prefix}-dur`, `${dur.toFixed(2)}s`);
  el.style.setProperty(`--${prefix}-delay`, `${delay.toFixed(2)}s`);
}

/** 聚合图标颜色类型（D-153）：普通打卡 / 想去 / 秘密基地（秘密基地必为去过，优先判紫） */
type ClusterColor = 'visited' | 'wishlist' | 'secret';

/** 单个地点的标记类型（D-164：三种图标都可选配色，秘密基地优先判类，其次想去） */
function markerKindOf(place: Place): MarkerKind {
  return place.secret ? 'secret' : place.kind === 'wishlist' ? 'wishlist' : 'visited';
}

/** 聚合配色在 key 里的稳定签名：换设置后按新颜色重建节点 */
function markerColorsKey(prefs: MarkerColorPrefs): string {
  return `${prefs.visited ?? '-'}/${prefs.wishlist ?? '-'}/${prefs.secret ?? '-'}`;
}

/** FNV-1a 取模：给聚合第 3 个图标做「稳定随机」（同一簇刷新不变色） */
function hashIndex(seed: string, n: number): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % n;
}

/**
 * 聚合点最多显示 3 个单点图标（D-153，用户指定；D-155 按截图修正）：
 * - 必须包含簇内出现的所有颜色类型；
 * - 2 个点：显示 2 个（同色两个 / 两色各一个）；
 * - ≥3 个点：显示 3 个；
 *   - 两色时按**实际数量**显示 2 个多数色 + 1 个少数色（不再随机复制少数色），
 *     且**多数色放中间**；相等时用稳定哈希挑一个当多数色，左右侧也稳定哈希；
 *   - 三色时各一个（中间放秘密基地紫）。
 * 返回顺序固定为 [左, 右, 中]；只有 2 个图标时是 [左, 右]。
 */
function clusterIconColors(c: Cluster): ClusterColor[] {
  const counts = new Map<ClusterColor, number>();
  for (const m of c.members) {
    const t: ClusterColor = m.secret ? 'secret' : m.kind === 'wishlist' ? 'wishlist' : 'visited';
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const types = (['visited', 'wishlist', 'secret'] as const).filter((t) => counts.has(t));
  if (types.length === 0) return ['visited', 'visited', 'visited'];
  if (c.count <= 2) {
    if (types.length === 1) return [types[0], types[0]];
    return [types[0], types[1]];
  }
  if (types.length === 1) return [types[0], types[0], types[0]];
  if (types.length === 2) {
    const [a, b] = types;
    const ca = counts.get(a)!;
    const cb = counts.get(b)!;
    const seed = `${c.lng.toFixed(3)},${c.lat.toFixed(3)},${c.count},${c.visitedCount},${c.wishCount},${types.join('-')}`;
    // 相等时稳定挑一个当「多数色」，保证刷新不跳色
    const major: ClusterColor = ca === cb ? (hashIndex(seed, 2) === 0 ? a : b) : ca > cb ? a : b;
    const minor: ClusterColor = major === a ? b : a;
    // 多数色必须占中间（index 2）；另一个多数色 + 少数色分居左右，左右用稳定哈希
    const minorRight = hashIndex(`${seed}-side`, 2) === 1;
    return minorRight ? [major, minor, major] : [minor, major, major];
  }
  // 三种颜色：左 / 右各一，中间秘密基地
  return ['visited', 'wishlist', 'secret'];
}

// ── 缩放动画（省份点亮层跟随地图）──
// 天地图缩放是 250ms 左右的 CSS transition（作用在它自己的图层上），
// 我们的手绘 SVG 层不在它的图层里，所以自己按「同样的时长 + 缓动」做 rAF 插值，
// 起止状态都是精确的仿射变换；这样不用依赖它的内部 Ge 事件细节，也不会像 CSS transition
// 那样在 SVG <g> 上失效。

/** CSS 缓动关键字 / cubic-bezier() → 进度函数 */
function cssEasing(spec: string): ((t: number) => number) | null {
  const s = spec.trim();
  let x1 = 0;
  let y1 = 0;
  let x2 = 1;
  let y2 = 1;
  if (s === 'linear') return (t) => t;
  if (s === 'ease') {
    x1 = 0.25;
    y1 = 0.1;
    x2 = 0.25;
    y2 = 1;
  } else if (s === 'ease-in') {
    x1 = 0.42;
    y1 = 0;
    x2 = 1;
    y2 = 1;
  } else if (s === 'ease-out') {
    x1 = 0;
    y1 = 0;
    x2 = 0.58;
    y2 = 1;
  } else if (s === 'ease-in-out') {
    x1 = 0.42;
    y1 = 0;
    x2 = 0.58;
    y2 = 1;
  } else {
    const m = /cubic-bezier\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/.exec(
      s
    );
    if (!m) return null;
    x1 = Number(m[1]);
    y1 = Number(m[2]);
    x2 = Number(m[3]);
    y2 = Number(m[4]);
  }
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const sampleDX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    // Newton-Raphson 求 t 使 sampleX(t)=x，失败再二分兜底
    let t = x;
    for (let i = 0; i < 6; i++) {
      const dx = sampleDX(t);
      if (Math.abs(dx) < 1e-6) break;
      const err = sampleX(t) - x;
      if (Math.abs(err) < 1e-6) return sampleY(t);
      t -= err / dx;
    }
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < 24; i++) {
      const v = sampleX(t);
      if (Math.abs(v - x) < 1e-6) break;
      if (v < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return sampleY(t);
  };
}

/** 读天地图自己缩放动画的时长/缓动（从它创建的 .tdt-proxy 计算样式拿），拿不到用 250ms ease-out */
function readZoomAnimationTiming(map: any): { dur: number; ease: (t: number) => number } {
  let dur = 250;
  let ease: (t: number) => number = (t) => 1 - Math.pow(1 - t, 3);
  try {
    const panes = typeof map?.getPanes === 'function' ? map.getPanes() : null;
    const mapPane: HTMLElement | null = panes?.mapPane ?? null;
    const proxy = mapPane?.querySelector?.('.tdt-proxy') as HTMLElement | null;
    if (!proxy) return { dur, ease };
    const cs = getComputedStyle(proxy);
    const durStr = String(cs.transitionDuration || '').split(',')[0].trim();
    if (durStr) {
      const n = parseFloat(durStr);
      if (Number.isFinite(n) && n > 0) dur = durStr.endsWith('ms') ? n : n * 1000;
    }
    const fnStr = String(cs.transitionTimingFunction || '').split(',')[0].trim();
    if (fnStr) ease = cssEasing(fnStr) ?? ease;
  } catch {
    /* 读不到就用默认值 */
  }
  return { dur: Math.min(600, Math.max(120, dur)), ease };
}

/**
 * 地图组件
 *
 * ⚠️ 重要：不使用天地图的覆盖物系统（T.Marker / T.Icon / addOverLay）。
 * 实测这套 SDK（4.1.6）在任何时机调用 map.addOverLay() 都会抛
 * RangeError: Maximum call stack size exceeded，且会让地图之后无法缩放/拖动。
 * 纯净测试页已验证：裸地图正常，一旦添加覆盖物就崩。
 *
 * 所以标记层自己实现：一个绝对定位的 DOM 层，用 map.lngLatToContainerPoint()
 * 把经纬度换算成容器坐标，再用 transform 摆放。
 * 好处：完全绕开 SDK 的坑，样式/动画/点击也全在自己手里。
 */

export interface MapApi {
  flyTo(lng: number, lat: number, zoom?: number): void;
  getZoom(): number;
}

// ── 记住上次视野（F-MAP-06）──
const VIEW_KEY = 'tm-view';

/**
 * 2026-11-06 用户要求：中国以外不能打点，地图视野限制在中国范围附近（含南海海域）。
 * 用户三次反馈「限制太死」后连续放宽：
 *   初版 73~136°E / 3.5~54.5°N + minZoom 4
 *   → 65~145°E / 0~58°N + minZoom 3
 *   → 50~160°E / -10~65°N + minZoom 2
 *   → 现在 30~180°E / -30~75°N + minZoom 4（与「总览」默认一致，D-196 用户要求不再缩得更小）
 */
const CHINA_VIEW_BOUNDS = {
  minLng: 30.0,
  minLat: -30.0,
  maxLng: 180.0,
  maxLat: 75.0,
};

function readView(): { lng: number; lat: number; zoom: number } | null {
  try {
    const raw = localStorage.getItem(VIEW_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    const { lng, lat, zoom } = v || {};
    if (![lng, lat, zoom].every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
    // 非法值（贴到角落、缩放过界之类）直接回退默认
    if (Math.abs(lng) > 180 || Math.abs(lat) > 85 || zoom < 1 || zoom > 17) return null;
    // 旧视野如果超出限制范围（例如以前拖到国外看过），直接回退到默认中国全境
    if (
      lng < CHINA_VIEW_BOUNDS.minLng - 2 ||
      lng > CHINA_VIEW_BOUNDS.maxLng + 2 ||
      lat < CHINA_VIEW_BOUNDS.minLat - 2 ||
      lat > CHINA_VIEW_BOUNDS.maxLat + 2
    ) {
      return null;
    }
    // D-196（用户要求）：最低缩放回到 4，和「总览」默认一致
    return { lng, lat, zoom: Math.max(4, zoom) };
  } catch {
    return null;
  }
}

export interface Draft {
  lng: number;
  lat: number;
}

interface Props {
  tk: string;
  places: Place[];
  selectedId: string | null;
  draft: Draft | null;
  apiRef: React.MutableRefObject<MapApi | null>;
  onPick: (id: string) => void;
  onDraftMoved: (lng: number, lat: number) => void;
  onStatus: (s: { ready: boolean; error?: string }) => void;
  /** 单击聚合靶盘：App 用它打开「这一簇」列表（F-BRW-07）；成员是点击那一刻的快照 */
  onCluster?: (cluster: Cluster) => void;
  /** 单击地图空白处：App 用它收起簇列表（F-BRW-07） */
  onBlank?: () => void;
  /** F-PLC-09（2026-11-04 并入「+ 添加足迹」）：地图点选模式；开启后单击地图落一个草稿点，光标为飞镖 */
  pinMode?: boolean;
  onMapClick?: (lng: number, lat: number) => void;
  /** F-STA-01：统计模式。隐藏普通飞镖/聚合，主地图切省份点亮 */
  statsMode?: boolean;
  /** 省份点亮数据（全量口径，来自 GET /api/stats/provinces）；null 时只画灰色省界 */
  provinceStats?: ProvinceLight[] | null;
  /** 家图标配色（2026-11-05 D-161）：7 色可选，只影响 <img src> */
  homeColor?: HomeColor;
  /** 去过 / 想去 / 秘密基地的图标配色（2026-11-05 D-164）：7 色可选；null = 原色 */
  markerColors?: MarkerColorPrefs;
}

interface PinNode {
  el: HTMLDivElement;
  lng: number;
  lat: number;
  w: number;
  h: number;
  anchorBottom: boolean;
  /** 普通地点节点记下 place.id：选中态改为「原地更新尺寸 / class」，不再靠 key 变化重建节点 */
  placeId?: string;
}

export default function MapView({
  tk,
  places,
  selectedId,
  draft,
  apiRef,
  onPick,
  onDraftMoved,
  onStatus,
  onCluster,
  onBlank,
  pinMode,
  onMapClick,
  statsMode,
  provinceStats,
  homeColor = 'teal',
  markerColors = DEFAULT_MARKER_COLORS,
}: Props) {
  const t = useT();
  const tp = useTp();
  const lang = useLang();
  const TRef = useRef<any>(null);
  const mapRef = useRef<any>(null);
  const layerRef = useRef<HTMLDivElement | null>(null);
  const pins = useRef<Map<string, PinNode>>(new Map());
  const draftPin = useRef<HTMLDivElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const flyRef = useRef<(lng: number, lat: number, zoom: number) => void>(() => {});
  const placesRef = useRef<Place[]>([]);
  const selectedRef = useRef<string | null>(null);
  /** 家（普通地点，不参与聚合）：单独一个 DOM 节点，key 变化时重建 */
  const homePin = useRef<PinNode | null>(null);
  const homePinKey = useRef<string | null>(null);

  // 省份点亮（F-STA-01）：自绘 SVG 层。
  // 性能关键：所有顶点只在「进入统计模式 / 每次 zoomend」投影一次，
  // 拖动时只改一个 CSS transform（合成层平移，不再每帧重算 1.2 万顶点）。
  const statsModeRef = useRef(false);
  const provinceLayerRef = useRef<HTMLDivElement | null>(null);
  /** 承载所有省界 path 的 <g>：拖动/缩放只改它的 transform，不重算 path */
  const provinceGRef = useRef<SVGGElement | null>(null);
  const provinceSvgRef = useRef<SVGSVGElement | null>(null);
  const provinceDataRef = useRef<ProvinceBoundaryData | null>(null);
  /** 低缩放（z<7）用概化版省界：天地图低缩放底图的省界更平滑，直接用高精度数据会显得不齐 */
  const provinceLowDataRef = useRef<ProvinceBoundaryData | null>(null);
  const provincePathsRef = useRef<Map<string, SVGPathElement>>(new Map());
  const provinceStatsRef = useRef<ProvinceLight[]>([]);
  /** 参考投影标定：path 坐标 = aR*lng+bR / cR*mercY(lat)+dR（参考视野下的容器坐标） */
  const provinceCalRef = useRef<{
    aR: number;
    bR: number;
    cR: number;
    dR: number;
    zRef: number;
  } | null>(null);
  /** 最近一次写进 <g> 的变换（缩放动画的起点） */
  const provinceLastTransformRef = useRef({ s: 1, tx: 0, ty: 0 });
  /** 缩放动画进行中：此时由动画 rAF 独占写 transform，拖动/其他更新要跳过 */
  const provinceZoomAnimRef = useRef(false);
  const hoverProvinceRef = useRef<string | null>(null);
  const [provinceError, setProvinceError] = useState<string | null>(null);

  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cbs = useRef({ onPick, onDraftMoved, onCluster, onBlank, pinMode, onMapClick });
  cbs.current = { onPick, onDraftMoved, onCluster, onBlank, pinMode, onMapClick };

  placesRef.current = places;
  selectedRef.current = selectedId;
  statsModeRef.current = Boolean(statsMode);
  provinceStatsRef.current = provinceStats ?? [];

  // ── 把当前所有标记摆到正确位置 ──
  const positionAll = useCallback(() => {
    const map = mapRef.current;
    const T = TRef.current;
    if (!map || !T) return;
    try {
      for (const p of pins.current.values()) {
        const pt = map.lngLatToContainerPoint(new T.LngLat(p.lng, p.lat));
        if (!pt) continue;
        const x = pt.x - p.w / 2;
        const y = p.anchorBottom ? pt.y - p.h : pt.y - p.h / 2;
        p.el.style.transform = `translate(${x}px, ${y}px)`;
      }
      if (draftPin.current) {
        const d = draftPin.current;
        const lng = Number(d.dataset.lng);
        const lat = Number(d.dataset.lat);
        if (Number.isFinite(lng) && Number.isFinite(lat)) {
          const pt = map.lngLatToContainerPoint(new T.LngLat(lng, lat));
          if (pt) d.style.transform = `translate(${pt.x - 23}px, ${pt.y - 46}px)`;
        }
      }
      if (homePin.current) {
        const h = homePin.current;
        const pt = map.lngLatToContainerPoint(new T.LngLat(h.lng, h.lat));
        if (pt) h.el.style.transform = `translate(${pt.x - h.w / 2}px, ${pt.y - h.h}px)`;
      }
    } catch (e) {
      console.error('[map] 标记定位失败', e);
    }
  }, []);

  // ── 聚合点悬停气泡 ──
  const hideTip = useCallback(() => {
    if (tipRef.current) tipRef.current.style.opacity = '0';
  }, []);

  const showTip = useCallback(
    (title: string, sub: string, lng: number, lat: number, anchorTop: number, dist = '') => {
      const map = mapRef.current;
      const T = TRef.current;
      const layer = layerRef.current;
      if (!map || !T || !layer) return;

      let tip = tipRef.current;
      if (!tip) {
        tip = document.createElement('div');
        tip.className = 'map-tip';
        layer.appendChild(tip);
        tipRef.current = tip;
      }

      // 地名是用户输入，转义后再拼
      const esc = (s: string) =>
        s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
      // 2026-11-06 D-185：离家距离放在第一行、名称右侧（用户指定），第二行仍是地区 / 去过次数 / 最近
      const distHtml = dist ? `<span class="tip-dist">${esc(dist)}</span>` : '';
      tip.innerHTML =
        `<div class="tip-t"><span class="tip-name">${esc(title)}</span>${distHtml}</div>` +
        (sub ? `<div class="tip-s">${esc(sub)}</div>` : '');

      tip.style.opacity = '1';
      try {
        const pt = map.lngLatToContainerPoint(new T.LngLat(lng, lat));
        const w = tip.offsetWidth || 180;
        const h = tip.offsetHeight || 28;
        tip.style.transform =
          `translate(${Math.round(pt.x - w / 2)}px, ` +
          `${Math.round(pt.y - anchorTop - h - 10)}px)`;
      } catch {
        /* ignore */
      }
    },
    []
  );

  // ── 省份点亮层（F-STA-01 / D-60）──
  // 省界多边形用自绘 SVG 层跟随地图投影；绝不用 addOverLay / T.Marker（三条铁律）。
  const applyProvinceColors = useCallback(() => {
    const data = provinceDataRef.current;
    if (!data) return;
    const { byName, byCode } = buildLightIndex(provinceStatsRef.current);
    for (const f of data.features) {
      const path = provincePathsRef.current.get(f.name);
      if (!path) continue;
      const light = byName.get(f.name.replace(/(壮族自治区|回族自治区|维吾尔自治区|特别行政区|自治区|省|市)$/g, '')) || byCode.get(f.adcode);
      const level = provinceLevel(light?.places ?? 0);
      path.style.fill = PROVINCE_FILLS[level];
      path.style.stroke = PROVINCE_STROKES[level];
      path.dataset.level = String(level);
      if (light) path.dataset.places = String(light.places);
      else delete path.dataset.places;
      if (light) path.dataset.visits = String(light.visits);
      else delete path.dataset.visits;
    }
  }, []);

  const buildProvinceLayer = useCallback(() => {
    const g = provinceGRef.current;
    const data = provinceDataRef.current;
    if (!g || !data) return;
    g.replaceChildren();
    const map = new Map<string, SVGPathElement>();
    for (const f of data.features) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('class', 'province-path');
      path.setAttribute('data-province', f.name);
      g.appendChild(path);
      map.set(f.name, path);
    }
    provincePathsRef.current = map;
    applyProvinceColors();
  }, [applyProvinceColors]);

  /** 写 <g> 的 transform，并记下起点（缩放动画从这里插值） */
  const setProvinceGTransform = useCallback((s: number, tx: number, ty: number) => {
    const g = provinceGRef.current;
    if (!g) return;
    const next = `translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px) scale(${s.toFixed(6)})`;
    if (g.style.transform !== next) g.style.transform = next;
    provinceLastTransformRef.current = { s, tx, ty };
  }, []);

  // 初始化 effect 里用 ref 拿到最新函数
  const provinceSetGRef = useRef(setProvinceGTransform);
  provinceSetGRef.current = setProvinceGTransform;

  /**
   * 拖动 / 缩放动画时只改这一条 CSS transform：
   *   newContainer = 容器中心 + s * (参考坐标 - 参考坐标(当前中心))
   * s = 2^(当前 zoom - 参考 zoom)。不再遍历顶点。
   */
  const applyProvinceTransform = useCallback(() => {
    // 缩放动画期间由动画 rAF 独占写 transform，避免被旧 zoom 的普通更新覆盖
    if (provinceZoomAnimRef.current) return;
    const map = mapRef.current;
    const layer = provinceLayerRef.current;
    const cal = provinceCalRef.current;
    if (!map || !layer || !cal) return;
    const zoom = Number(map.getZoom());
    if (!Number.isFinite(zoom)) return;
    const c = map.getCenter();
    const lng = c.getLng();
    const lat = c.getLat();
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
    const s = Math.pow(2, zoom - cal.zRef);
    const w = layer.clientWidth || 1;
    const h = layer.clientHeight || 1;
    const tx = w / 2 - s * (cal.aR * lng + cal.bR);
    const ty = h / 2 - s * (cal.cR * mercY(lat) + cal.dR);
    setProvinceGTransform(s, tx, ty);
  }, [setProvinceGTransform]);

  /**
   * 按当前视野重新标定投影并重写 34 条省界 path（一次性 ~1.2 万点纯算术，不调 SDK）。
   * 只在进入统计模式 / 每次 zoomend / 窗口尺寸变化时调用。
   */
  const reprojectProvinces = useCallback(() => {
    const map = mapRef.current;
    const T = TRef.current;
    const layer = provinceLayerRef.current;
    const full = provinceDataRef.current;
    const low = provinceLowDataRef.current;
    if (!map || !T || !full || !layer) return;
    // 低缩放用概化版省界（更接近天地图低缩放底图的平滑省界）；z>=7 用高精度版
    const useLow = Boolean(low && Number(map.getZoom()) < 7);
    const data = useLow && low ? low : full;
    layer.classList.toggle('lod-low', useLow);
    // 低缩放：填充边缘羽化（filter 在 SVG defs 里），放大后再恢复硬边 + 精确描边
    provinceGRef.current?.classList.toggle('soft', useLow);
    const center = map.getCenter();
    const lngC = center.getLng();
    const latC = center.getLat();
    const p0 = map.lngLatToContainerPoint(new T.LngLat(lngC, latC));
    const px = map.lngLatToContainerPoint(new T.LngLat(lngC + 1, latC));
    const py = map.lngLatToContainerPoint(new T.LngLat(lngC, latC + 1));
    if (!p0 || !px || !py) return;
    // 参考投影标定（3 次 SDK 调用代替 1.2 万次）
    const aR = px.x - p0.x;
    const bR = p0.x - aR * lngC;
    const f0 = mercY(latC);
    const f1 = mercY(latC + 1);
    const cR = f1 === f0 ? 0 : (py.y - p0.y) / (f1 - f0);
    const dR = p0.y - cR * f0;
    provinceCalRef.current = { aR, bR, cR, dR, zRef: Number(map.getZoom()) };

    for (const f of data.features) {
      const path = provincePathsRef.current.get(f.name);
      if (!path) continue;
      let d = '';
      for (const ring of f.rings) {
        for (let i = 0; i < ring.length; i++) {
          const [lng, lat] = ring[i];
          const x = aR * lng + bR;
          const y = cR * mercY(lat) + dR;
          d += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1);
        }
        d += 'Z';
      }
      path.setAttribute('d', d);
    }
    // 新参考视野下变换归零（path 已按当前视野重写，视觉与动画终点一致）
    setProvinceGTransform(1, 0, 0);
  }, [setProvinceGTransform]);

  // 地图初始化 effect 只跑一次，用 ref 拿到最新函数
  const provinceRedrawRef = useRef(applyProvinceTransform);
  provinceRedrawRef.current = applyProvinceTransform;
  const provinceReprojectRef = useRef(reprojectProvinces);
  provinceReprojectRef.current = reprojectProvinces;

  // 进入统计模式时按需加载省界（静态资源，缓存进内存；失败只降级不阻塞）
  useEffect(() => {
    let dead = false;
    if (!statsMode) {
      if (provinceLayerRef.current) provinceLayerRef.current.style.display = 'none';
      hideTip();
      return;
    }
    (async () => {
      if (!provinceDataRef.current) {
        try {
          const [rFull, rLow] = await Promise.all([
            fetch('/province-boundaries.json'),
            fetch('/province-boundaries-low.json').catch(() => null),
          ]);
          if (!rFull.ok) throw new Error(`HTTP ${rFull.status}`);
          const data = (await rFull.json()) as ProvinceBoundaryData;
          if (!data || !Array.isArray(data.features) || !data.features.length) {
            throw new Error(tr('省界数据为空'));
          }
          provinceDataRef.current = data;
          // 概化版是可选优化：拿不到就只用高精度版（只是低缩放观感差一点）
          try {
            if (rLow && rLow.ok) {
              const lowData = (await rLow.json()) as ProvinceBoundaryData;
              if (lowData && Array.isArray(lowData.features) && lowData.features.length) {
                provinceLowDataRef.current = lowData;
              }
            }
          } catch {
            /* 概化版加载失败不影响主流程 */
          }
          setProvinceError(null);
        } catch (e: any) {
          if (!dead) setProvinceError(e?.message || String(e));
          return;
        }
      }
      if (dead) return;
      if (provinceLayerRef.current) provinceLayerRef.current.style.display = 'block';
      buildProvinceLayer();
      reprojectProvinces();
    })();
    return () => {
      dead = true;
    };
  }, [statsMode, buildProvinceLayer, reprojectProvinces, hideTip]);

  // 省份点亮数据到达 / 变化时只改颜色，不重建节点
  useEffect(() => {
    if (!statsMode) return;
    provinceStatsRef.current = provinceStats ?? [];
    applyProvinceColors();
    applyProvinceTransform();
  }, [provinceStats, statsMode, applyProvinceColors, applyProvinceTransform]);

  // 统计模式下用多边形命中测试做 hover；层本身 pointer-events:none，不挡地图拖动
  useEffect(() => {
    if (!statsMode) return;
    let raf = 0;
    let last: MouseEvent | null = null;
    const hit = () => {
      raf = 0;
      const data = provinceDataRef.current;
      const map = mapRef.current;
      const T = TRef.current;
      const layer = provinceLayerRef.current;
      const layerEl = layerRef.current;
      const ev = last;
      if (!data || !map || !T || !layerEl || !ev) return;
      let lng = NaN;
      let lat = NaN;
      try {
        const pt = map.containerPointToLngLat(new T.Point(ev.clientX - layerEl.getBoundingClientRect().left, ev.clientY - layerEl.getBoundingClientRect().top));
        lng = pt.getLng();
        lat = pt.getLat();
      } catch {
        return;
      }
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
      let hitFeature: ProvinceBoundaryFeature | null = null;
      for (const f of data.features) {
        const [x0, y0, x1, y1] = featureBBox(f);
        if (lng < x0 || lng > x1 || lat < y0 || lat > y1) continue;
        if (pointInFeature(lng, lat, f)) {
          hitFeature = f;
          break;
        }
      }
      if (!hitFeature) {
        hoverProvinceRef.current = null;
        provincePathsRef.current.forEach((p) => p.classList.remove('hover'));
        hideTip();
        return;
      }
      if (hoverProvinceRef.current !== hitFeature.name) {
        hoverProvinceRef.current = hitFeature.name;
        provincePathsRef.current.forEach((p, name) => p.classList.toggle('hover', name === hitFeature!.name));
      }
      const { byName, byCode } = buildLightIndex(provinceStatsRef.current);
      const light =
        byName.get(hitFeature.name.replace(/(壮族自治区|回族自治区|维吾尔自治区|特别行政区|自治区|省|市)$/g, '')) ||
        byCode.get(hitFeature.adcode);
      const title = tp(light?.name || hitFeature.name);
      const sub = light
        ? t('{places} 个地点 · {visits} 次到访', { places: light.places, visits: light.visits })
        : t('还没去过');
      showTip(title, sub, lng, lat, 0);
    };
    const onMove = (ev: MouseEvent) => {
      last = ev;
      if (raf) return;
      raf = requestAnimationFrame(hit);
    };
    const onLeave = () => {
      hoverProvinceRef.current = null;
      provincePathsRef.current.forEach((p) => p.classList.remove('hover'));
      hideTip();
    };
    const mapEl = document.getElementById('map');
    mapEl?.addEventListener('mousemove', onMove);
    mapEl?.addEventListener('mouseleave', onLeave);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      mapEl?.removeEventListener('mousemove', onMove);
      mapEl?.removeEventListener('mouseleave', onLeave);
      hoverProvinceRef.current = null;
      provincePathsRef.current.forEach((p) => p.classList.remove('hover'));
    };
  }, [statsMode, hideTip, showTip, t, tp]);

  // ── 点击涟漪（D-150）：3D 地面波纹 —— 椭圆（透视）+ 双环错峰扩散 ──
  // 独立临时节点，标记即使马上被重建也不影响它播完；中心落在杖尖（地面坐标）上。
  const spawnRipple = useCallback((lng: number, lat: number, size: number, color: string) => {
    const layer = layerRef.current;
    const map = mapRef.current;
    const T = TRef.current;
    if (!layer || !map || !T) return;
    try {
      const pt = map.lngLatToContainerPoint(new T.LngLat(lng, lat));
      if (!pt) return;
      const ring = document.createElement('div');
      const w = Math.max(42, Math.round(size * 1.6));
      const h = Math.max(14, Math.round(w * 0.36));
      ring.className = 'pin-ripple';
      ring.style.left = `${pt.x - w / 2}px`;
      ring.style.top = `${pt.y - h / 2}px`;
      ring.style.width = `${w}px`;
      ring.style.height = `${h}px`;
      ring.style.setProperty('--ripple', color);
      layer.appendChild(ring);
      // 双环由 ::before / ::after 播放（最晚 110 + 560ms），统一 900ms 后清理；
      // reduced-motion 下 CSS 直接隐藏，超时仍会移除节点。
      const kill = () => ring.remove();
      window.setTimeout(kill, 900);
    } catch {
      /* 地图未就绪时忽略 */
    }
  }, []);

  // 页面切到后台时暂停呼吸/脉冲（省电；切回来继续）
  useEffect(() => {
    const onVis = () => layerRef.current?.classList.toggle('is-hidden', document.hidden);
    document.addEventListener('visibilitychange', onVis);
    onVis();
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  // ── 建 / 删 / 复用标记节点 ──
  const rebuild = useCallback(() => {
    const layer = layerRef.current;
    const map = mapRef.current;
    const T = TRef.current;
    if (!layer || !map || !T) return;

    hideTip();

    // 统计模式：普通飞镖/聚合全部隐藏，主地图只留省份点亮层（D-60）
    if (statsModeRef.current) {
      for (const node of pins.current.values()) node.el.remove();
      pins.current.clear();
      draftPin.current?.remove();
      draftPin.current = null;
      homePin.current?.el.remove();
      homePin.current = null;
      homePinKey.current = null;
      if (layer.classList.contains('zooming')) layer.classList.remove('zooming');
      layer.classList.remove('interacting');
      return;
    }

    let clusters: ReturnType<typeof clusterPlaces> = [];
    try {
      // 去过和想去一起参与聚合：同位置的两个标记不会再叠在一起；
      // 簇的配色/文案按「纯去过 / 纯想去 / 混合」区分（D-32）。
      // 家是普通地点，但**不参与聚合**（2026-11-04）：先剔除，下面单独画。
      clusters = clusterPlaces(
        placesRef.current.filter((p) => p.home !== 1),
        map.getZoom(),
        60
      );
    } catch {
      clusters = [];
    }

    const alive = new Set<string>();

    // 2026-11-06 D-185：悬停卡片里也显示「离家 X km」；把家的坐标放进单点 key，
    // 换家 / 移动家之后会重建节点、tooltip 立即用新距离（家本身不显示距离）。
    const homeForTip = placesRef.current.find((q) => q.home === 1) ?? null;
    const homeTipSig = homeForTip
      ? `${homeForTip.id}:${homeForTip.lng.toFixed(5)}:${homeForTip.lat.toFixed(5)}`
      : 'no-home';

    for (const c of clusters) {
      const isCluster = c.count > 1;
      const kind = clusterKind(c);
      // key 里带上会显示出来的可变字段：数据一变就重建节点。
      // 否则改名 / 删除 / 改变类型后，复用旧节点会留着过时的配色和 tooltip。
      const key = isCluster
        ? `c:${c.lng.toFixed(3)},${c.lat.toFixed(3)}:${c.count}:${c.visitedCount}:${c.wishCount}:${
            c.visits
          }:${c.latestDate ?? ''}:${lang}:${markerColorsKey(markerColors)}`
        // 注意：key 里不再带选中态（D-150）。选中只改尺寸/class，由下方 syncSelection 原地更新，
        // 节点不再重建——否则点击动画会被截断，也容易产生视觉重叠。
        // D-164：带当前类型配色，改设置后按新颜色重建图标。
        : `p:${c.place.id}:${c.place.name}:${c.place.kind}:${c.place.visit_count ?? 1}:${
            c.place.last_date ?? ''
          }:${c.place.secret ? 1 : 0}:${lang}:${markerColors[markerKindOf(c.place)] ?? 'default'}:${homeTipSig}`;

      alive.add(key);

      if (pins.current.has(key)) continue;

      const el = document.createElement('div');
      el.className = 'pin';

      if (isCluster) {
        // D-153：聚合最多 3 个单点图标（用户指定，方案 B）——
        // 必须包含簇内出现的所有颜色；2 个点显示 2 个；≥3 个点显示 3 个；
        // 两色 + 3 图标时「单独那个颜色」放中间；三色时中间放秘密基地紫。
        // 左 / 右内倾 ±20°、缩到 0.76；中间 0.80 最后画（z 序在上）。
        const size = markerSize(c.count);
        el.classList.add('cluster');
        el.style.width = el.style.height = `${size}px`;
        const clusterBody = document.createElement('div');
        clusterBody.className = 'cluster-body';
        applyPhase(el, 'pulse', key);
        const colors = clusterIconColors(c);
        // D-154：2 个图标时把角度从 ±20° 收到 ±12°，两个图标更靠近、不显得分太开
        const rots = colors.length === 2 ? [12, -12] : [20, -20, 0];
        colors.forEach((color, i) => {
          const im = document.createElement('img');
          im.className = 'cluster-pin';
          // D-164：聚合里每种类型也跟随「图标配色」设置
          im.src = markerSrc(color, markerColors);
          im.alt = '';
          im.draggable = false;
          im.style.transform = `rotate(${rots[i]}deg) scale(${i === 2 ? 0.8 : 0.76})`;
          clusterBody.appendChild(im);
        });
        el.appendChild(clusterBody);
        const label = clusterLabel(c, t, tp);
        const sub = kind === 'wishlist' ? '' : clusterSub(c, t);
        // 3 个图标共底尖，容器也改为底尖对齐坐标点（anchorBottom: true），tooltip 抬到整组上方
        el.addEventListener('mouseenter', () => showTip(label, sub, c.lng, c.lat, size));
        el.addEventListener('mouseleave', hideTip);
        el.addEventListener('click', (ev) => {
          ev.stopPropagation();
          hideTip();
          // F-BRW-07（D-33）：单击靶盘 = 自动飞到「刚好散开」的级别 + 右侧列出簇内地点。
          // 两个动作同时发生；列表用点击这一刻的成员快照，散开后聚合重算不会改它。
          const snapshot = c;
          cbs.current.onCluster?.(snapshot);
          const target = zoomToSpread(c.members, Number(map.getZoom()));
          flyRef.current(c.lng, c.lat, target);
        });
        pins.current.set(key, { el, lng: c.lng, lat: c.lat, w: size, h: size, anchorBottom: true });
      } else {
        const p = c.place;
        const size = p.id === selectedRef.current ? 38 : markerSize(1);
        el.style.width = el.style.height = `${size}px`;
        if (p.kind === 'wishlist') el.classList.add('wish');
        // F-PLC-11：秘密基地飞镖用不同颜色（用户确认：形状不变，只颜色区分）
        if (p.secret) el.classList.add('secret');
        if (p.id === selectedRef.current) el.classList.add('selected');
        // D-150：外层定位；pin-body 呼吸、img 悬停、pin-media 点击回弹（选中不再重建节点）
        applyPhase(el, 'breath', p.id);
        const pinBody = document.createElement('div');
        pinBody.className = 'pin-body';
        const pinMedia = document.createElement('div');
        pinMedia.className = 'pin-media';
        const img = document.createElement('img');
        // D-164：三种单点图标都跟随「图标配色」设置（默认 = 各自原色）
        const markerKind = markerKindOf(p);
        img.src = markerSrc(markerKind, markerColors);
        if (markerKind === 'secret') {
          // 秘密基地原来的紫罗兰发光也跟着所选颜色走（CSS 用 --pin-glow 变量，见 styles.css）
          const secretHex = markerHex(markerKind, markerColors);
          img.style.setProperty('--pin-glow', hexToRgba(secretHex, 0.55));
          img.style.setProperty('--pin-glow-strong', hexToRgba(secretHex, 0.75));
        }
        img.alt = '';
        img.draggable = false;
        pinMedia.appendChild(img);
        pinBody.appendChild(pinMedia);
        el.appendChild(pinBody);
        el.title = p.secret ? t('{name}（秘密基地）', { name: p.name }) : p.name;

        // 单个飞镖也带描述：省份 · 去过几次 / 想去 · 最近什么时候
        const region = [tp(p.province), p.city].filter(Boolean).join(' · ');
        const bits: string[] = [];
        if (region) bits.push(region);
        if (p.kind === 'wishlist') {
          bits.push(t('想去'));
        } else {
          const n = Math.max(1, p.visit_count ?? 1);
          bits.push(t('去过 {n} 次', { n }));
        }
        if (p.last_date) {
          bits.push(t('最近 {date}', { date: p.last_date.slice(0, 7).replace('-', '.') }));
        }
        // 2026-11-06 D-185：离家距离放卡片第一行、名称右侧（家本身不显示）
        const homeDist =
          homeForTip && homeForTip.id !== p.id
            ? t('离家 {km} km', {
                km: fmtKm(haversineKm(homeForTip.lng, homeForTip.lat, p.lng, p.lat)),
              })
            : '';
        const sub = bits.join(' · ');

        el.addEventListener('mouseenter', () => showTip(p.name, sub, p.lng, p.lat, size, homeDist));
        el.addEventListener('mouseleave', hideTip);

        el.addEventListener('click', (ev) => {
          ev.stopPropagation();
          // D-150：点击 = 原节点压扁回弹 + 脚下 3D 涟漪；选中态不再重建节点，动画能完整播完
          el.classList.add('is-clicked');
          window.setTimeout(() => el.classList.remove('is-clicked'), 480);
          spawnRipple(p.lng, p.lat, size, markerHex(markerKind, markerColors));
          cbs.current.onPick(p.id);
        });
        pins.current.set(key, {
          el,
          lng: p.lng,
          lat: p.lat,
          w: size,
          h: size,
          anchorBottom: true,
          placeId: p.id,
        });
      }

      layer.appendChild(el);
    }

    for (const [key, node] of pins.current) {
      if (!alive.has(key)) {
        node.el.remove();
        pins.current.delete(key);
      }
    }

    // D-150：选中态原地更新（节点不再因选中重建）——只改尺寸 + selected 类，
    // 这样点击压扁回弹能在原节点上完整播完，也不会出现「底下多一层图标」的重叠。
    for (const node of pins.current.values()) {
      if (!node.placeId) continue;
      const on = node.placeId === selectedRef.current;
      const size = on ? 38 : markerSize(1);
      if (node.w !== size) {
        node.w = size;
        node.h = size;
        node.el.style.width = `${size}px`;
        node.el.style.height = `${size}px`;
      }
      node.el.classList.toggle('selected', on);
    }

    // 家（2026-11-04 改为普通地点）：从当前地点列表里找 home=1 的那个，
    // 单独画一个青绿房子飞镖（不参与聚合）；点击行为和普通地点一样：打开它的侧栏。
    const homePlace = placesRef.current.find((p) => p.home === 1) ?? null;
    // 家同样不在 key 里带选中态：选中只原地改尺寸 / class（D-150）
    // D-161：key 里带上 homeColor，切换配色时重建家的节点（<img> 不能靠 CSS 改色）
    const homeKey = homePlace
      ? `h:${homePlace.id}:${homePlace.name}:${homePlace.lng}:${homePlace.lat}:${lang}:${homeColor}`
      : null;
    if (!homePlace) {
      homePin.current?.el.remove();
      homePin.current = null;
      homePinKey.current = null;
    } else if (homePin.current && homePinKey.current === homeKey) {
      homePin.current.lng = homePlace.lng;
      homePin.current.lat = homePlace.lat;
    } else {
      homePin.current?.el.remove();
      const size = homePlace.id === selectedRef.current ? 38 : markerSize(1);
      const el = document.createElement('div');
      el.className = 'pin home';
      el.style.width = el.style.height = `${size}px`;
      if (homePlace.id === selectedRef.current) el.classList.add('selected');
      // D-150：与普通单点一致的呼吸/悬停/点击动效
      applyPhase(el, 'breath', homePlace.id);
      const pinBody = document.createElement('div');
      pinBody.className = 'pin-body';
      const pinMedia = document.createElement('div');
      pinMedia.className = 'pin-media';
      const img = document.createElement('img');
      img.src = homeMarkerSrc(homeColor);
      img.alt = '';
      img.draggable = false;
      pinMedia.appendChild(img);
      pinBody.appendChild(pinMedia);
      el.appendChild(pinBody);
      el.title = t('{name}（家）', { name: homePlace.name });
      const region = [tp(homePlace.province), homePlace.city].filter(Boolean).join(' · ');
      const bits: string[] = [];
      if (region) bits.push(region);
      if (homePlace.kind === 'wishlist') bits.push(t('想去'));
      else bits.push(t('去过 {n} 次', { n: Math.max(1, homePlace.visit_count ?? 1) }));
      if (homePlace.last_date) {
        bits.push(
          t('最近 {date}', { date: homePlace.last_date.slice(0, 7).replace('-', '.') })
        );
      }
      el.addEventListener('mouseenter', () =>
        showTip(
          t('{name}（家）', { name: homePlace.name }),
          bits.join(' · '),
          homePlace.lng,
          homePlace.lat,
          size
        )
      );
      el.addEventListener('mouseleave', hideTip);
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        hideTip();
        // D-150：原节点压扁回弹（选中不再重建节点）+ 3D 地面涟漪
        el.classList.add('is-clicked');
        window.setTimeout(() => el.classList.remove('is-clicked'), 480);
        spawnRipple(homePlace.lng, homePlace.lat, size, homeMarkerHex(homeColor));
        cbs.current.onPick(homePlace.id);
      });
      layer.appendChild(el);
      homePin.current = {
        el,
        lng: homePlace.lng,
        lat: homePlace.lat,
        w: size,
        h: size,
        anchorBottom: true,
      };
      homePinKey.current = homeKey;
    }

    // 家的选中态也原地更新（不重建节点）
    if (homePin.current && homePlace) {
      const on = homePlace.id === selectedRef.current;
      const size = on ? 38 : markerSize(1);
      if (homePin.current.w !== size) {
        homePin.current.w = size;
        homePin.current.h = size;
        homePin.current.el.style.width = `${size}px`;
        homePin.current.el.style.height = `${size}px`;
      }
      homePin.current.el.classList.toggle('selected', on);
    }

    positionAll();

    // 缩放结束后把标记层淡回来（淡出是在 zoomstart 做的）
    if (layer.classList.contains('zooming')) {
      requestAnimationFrame(() => layer.classList.remove('zooming'));
    }
  }, [positionAll, t, tp, lang, spawnRipple, homeColor, markerColors]);

  // 让地图事件能拿到最新的 rebuild（避免闭包捕获旧数据）
  const rebuildRef = useRef(rebuild);
  rebuildRef.current = rebuild;

  // ── 初始化地图 ──
  useEffect(() => {
    let dead = false;
    let loopId = 0;
    let pinClickTimer = 0;
    let detachMapPointer: (() => void) | null = null;
    let provinceAnimCancel: (() => void) | null = null;

    // 拖动/缩放期间持续刷新标记位置，不依赖 move 事件的触发频率
    const startLoop = () => {
      if (loopId) return;
      const step = () => {
        positionAll();
        provinceRedrawRef.current();
        loopId = requestAnimationFrame(step);
      };
      loopId = requestAnimationFrame(step);
    };
    const stopLoop = () => {
      if (loopId) cancelAnimationFrame(loopId);
      loopId = 0;
      positionAll();
    };

    (async () => {
      try {
        const T = await loadTdt(tk);
        if (dead) return;
        TRef.current = T;

        const map = new T.Map('map', {
          // 2026-11-06 用户要求（中国以外不能打点 → 地图也不展示国外区域）：
          // maxBounds 把地图限制在中国范围附近（含南海海域），拖出范围会弹回；
          // 平移范围 30~180°E / -30~75°N；D-196（用户要求）最小缩放回到 4，和「总览」默认一致。
          minZoom: 4,
          maxBounds: new T.LngLatBounds(
            new T.LngLat(CHINA_VIEW_BOUNDS.minLng, CHINA_VIEW_BOUNDS.minLat),
            new T.LngLat(CHINA_VIEW_BOUNDS.maxLng, CHINA_VIEW_BOUNDS.maxLat)
          ),
        });
        // 上次的视野优先，没有或非法就回中国全境
        const savedView = readView();
        map.centerAndZoom(
          new T.LngLat(savedView?.lng ?? 104.0, savedView?.lat ?? 35.0),
          savedView?.zoom ?? 4
        );
        map.enableScrollWheelZoom();
        map.enableDrag();

        try {
          map.addControl(new T.Control.Scale());
        } catch {
          /* ignore */
        }

        mapRef.current = map;

        // 缩放策略：先试一次直达，没到位再逐级补。
        // 这套 SDK 多级跳有时只生效 1 级，直接逐级飞的话 +2 级就会看到两段动画。
        let flyTimer = 0;
        const flyStepped = (lng: number, lat: number, target: number) => {
          window.clearTimeout(flyTimer);
          const tz = Math.max(3, Math.min(17, Math.round(target)));
          const dest = () => new T.LngLat(lng, lat);

          const start = Math.round(Number(map.getZoom()) || 4);
          if (start === tz) {
            map.centerAndZoom(dest(), tz);
            return;
          }

          // ① 先直接跳一次
          map.centerAndZoom(dest(), tz);

          // ② 动画结束后检查，没到位就补一级再试
          let guard = 0;
          const verify = () => {
            const now = Math.round(Number(map.getZoom()) || 4);
            if (now === tz || guard++ >= 8) return;
            map.centerAndZoom(dest(), now + (tz > now ? 1 : -1));
            flyTimer = window.setTimeout(verify, 320);
          };
          flyTimer = window.setTimeout(verify, 340);
        };
        flyRef.current = flyStepped;

        apiRef.current = {
          flyTo: (lng, lat, zoom) => flyStepped(lng, lat, zoom ?? map.getZoom()),
          getZoom: () => map.getZoom(),
        };

        // 恢复的视野可能被 SDK 的「多级跳只生效一级」吃掉，稍后校验补级（F-MAP-06）
        if (savedView) {
          window.setTimeout(() => {
            const cur = Math.round(Number(map.getZoom()) || 4);
            if (Math.abs(cur - savedView.zoom) >= 1) {
              flyStepped(savedView.lng, savedView.lat, savedView.zoom);
            }
          }, 500);
        }

        // 移动/缩放过程中持续跟随（不增删节点，只改 transform）
        let raf = 0;
        const follow = () => {
          if (raf) return;
          raf = requestAnimationFrame(() => {
            raf = 0;
            positionAll();
            provinceRedrawRef.current();
          });
        };
        map.addEventListener('move', follow);
        map.addEventListener('zoom', follow);
        map.addEventListener('moveend', follow);
        // 平移中按仿射变换跟随；松手后按当前视野重投影一次（41k→27k 点的纯算术，几毫秒），
        // 保证任何情况下静止状态的省界都与底图精确对齐（不依赖平移公式的累积假设）
        map.addEventListener('moveend', () => provinceReprojectRef.current());

        // 天地图的缩放动画只作用于它自己的图层，我们的标记层在外层跟不动。
        // 期间也收不到逐帧事件，硬跟会「先停住、再瞬移」。
        // 所以缩放时让标记层淡出，缩停后重建并淡回来。
        map.addEventListener('movestart', () => {
          hideTip();
          // D-162：拖动期间暂停标记的呼吸/脉冲，减少合成压力（松手恢复）
          layerRef.current?.classList.add('interacting');
          startLoop();
        });
        map.addEventListener('moveend', () => {
          layerRef.current?.classList.remove('interacting');
          stopLoop();
        });

        // 单击地图：普通模式收起「这一簇」列表（F-BRW-07）；添加足迹的点选状态落一个草稿点（F-PLC-09）
        // 自己记 4px 阈值：按下到抬起位移超过 4px 视为拖动平移，不落点（D-29）
        const mapEl = document.getElementById('map');
        let downX = 0;
        let downY = 0;
        let dragged = false;
        const onPointerDown = (ev: PointerEvent) => {
          downX = ev.clientX;
          downY = ev.clientY;
          dragged = false;
        };
        const onPointerMove = (ev: PointerEvent) => {
          if (Math.hypot(ev.clientX - downX, ev.clientY - downY) > 4) dragged = true;
        };
        mapEl?.addEventListener('pointerdown', onPointerDown);
        mapEl?.addEventListener('pointermove', onPointerMove);
        detachMapPointer = () => {
          mapEl?.removeEventListener('pointerdown', onPointerDown);
          mapEl?.removeEventListener('pointermove', onPointerMove);
        };

        map.addEventListener('click', (e: any) => {
          if (dragged) {
            dragged = false;
            return;
          }
          if (!cbs.current.pinMode) {
            cbs.current.onBlank?.();
            return;
          }
          const ll = e?.lnglat;
          let lng = NaN;
          let lat = NaN;
          if (ll && typeof ll.getLng === 'function') {
            lng = ll.getLng();
            lat = ll.getLat();
          } else if (e?.containerPoint) {
            try {
              const pt = map.containerPointToLngLat(
                new T.Point(e.containerPoint.x, e.containerPoint.y)
              );
              lng = pt.getLng();
              lat = pt.getLat();
            } catch {
              /* ignore */
            }
          }
          if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
          // 双击缩放也会先触发 click：延迟 240ms，等 dblclick 取消，避免双击误落点
          window.clearTimeout(pinClickTimer);
          pinClickTimer = window.setTimeout(() => {
            if (dead) return;
            cbs.current.onMapClick?.(lng, lat);
          }, 240);
        });
        map.addEventListener('dblclick', () => window.clearTimeout(pinClickTimer));

        // ── 省份点亮层的缩放跟随（F-STA-01 性能优化）──
        // 天地图的缩放动画作用在它自己的图层上（约 250ms CSS transition）；我们的 SVG 层不在里面，
        // 所以用 rAF 按同样的时长/缓动自己插值：从当前 <g> 变换 → 目标视野变换。
        // 起止都是精确仿射变换，scale/translate 线性插值与 CSS 矩阵插值一致，缩放期间能贴合底图。
        let provinceAnimRaf = 0;
        let provinceAnimWatchdog = 0;
        let provinceAnim: {
          fromS: number;
          fromTx: number;
          fromTy: number;
          toS: number;
          toTx: number;
          toTy: number;
          start: number;
          dur: number;
          ease: (t: number) => number;
        } | null = null;

        const cancelProvinceAnim = () => {
          if (provinceAnimRaf) cancelAnimationFrame(provinceAnimRaf);
          if (provinceAnimWatchdog) window.clearTimeout(provinceAnimWatchdog);
          provinceAnimRaf = 0;
          provinceAnimWatchdog = 0;
          provinceAnim = null;
          provinceZoomAnimRef.current = false;
        };
        provinceAnimCancel = cancelProvinceAnim;

        /** 兜底：万一某个环境里 zoomend 没来/动画被打断，最多 600ms 后强制解除动画锁并按当前视野校正 */
        const armProvinceAnimWatchdog = (ms: number) => {
          if (provinceAnimWatchdog) window.clearTimeout(provinceAnimWatchdog);
          provinceAnimWatchdog = window.setTimeout(() => {
            provinceAnimWatchdog = 0;
            if (!provinceZoomAnimRef.current) return;
            cancelProvinceAnim();
            provinceReprojectRef.current();
          }, Math.min(1200, ms + 400));
        };

        const tickProvinceAnim = () => {
          provinceAnimRaf = 0;
          const a = provinceAnim;
          if (!a) {
            provinceZoomAnimRef.current = false;
            return;
          }
          const raw = a.dur > 0 ? (performance.now() - a.start) / a.dur : 1;
          const e = a.ease(Math.min(1, Math.max(0, raw)));
          provinceSetGRef.current(
            a.fromS + (a.toS - a.fromS) * e,
            a.fromTx + (a.toTx - a.fromTx) * e,
            a.fromTy + (a.toTy - a.fromTy) * e
          );
          if (raw < 1) provinceAnimRaf = requestAnimationFrame(tickProvinceAnim);
        };

        const startProvinceZoomAnim = (center: any, zoom: number) => {
          const cal = provinceCalRef.current;
          const layer = provinceLayerRef.current;
          if (!cal || !layer) return;
          let lng = NaN;
          let lat = NaN;
          if (center) {
            lng = typeof center.getLng === 'function' ? center.getLng() : Number(center.lng);
            lat = typeof center.getLat === 'function' ? center.getLat() : Number(center.lat);
          }
          if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
          const s1 = Math.pow(2, zoom - cal.zRef);
          const w = layer.clientWidth || 1;
          const h = layer.clientHeight || 1;
          const toTx = w / 2 - s1 * (cal.aR * lng + cal.bR);
          const toTy = h / 2 - s1 * (cal.cR * mercY(lat) + cal.dR);
          const from = provinceLastTransformRef.current;
          const timing = readZoomAnimationTiming(map);
          provinceAnim = {
            fromS: from.s,
            fromTx: from.tx,
            fromTy: from.ty,
            toS: s1,
            toTx,
            toTy,
            start: performance.now(),
            dur: timing.dur,
            ease: timing.ease,
          };
          provinceZoomAnimRef.current = true;
          if (provinceAnimRaf) cancelAnimationFrame(provinceAnimRaf);
          provinceAnimRaf = requestAnimationFrame(tickProvinceAnim);
          armProvinceAnimWatchdog(timing.dur);
        };

        map.addEventListener('Ge', (e: any) => {
          if (!statsModeRef.current) return;
          const center = e?.center;
          const zoom = Number(e?.zoom);
          if (!center || !Number.isFinite(zoom)) return;
          startProvinceZoomAnim(center, zoom);
        });

        map.addEventListener('zoomstart', () => {
          hideTip();
          startLoop();
          layerRef.current?.classList.add('zooming');
          layerRef.current?.classList.add('interacting');
        });

        // 缩放一结束就用最新 zoom 重建，不等 React 走一轮 setState→render→effect。
        // 那一轮至少要 1～2 帧，正是「停一下才跳」的来源。
        map.addEventListener('zoomend', () => {
          stopLoop();
          rebuildRef.current();
          // 省界：动画结束后按新视野重新投影（矢量，保证放大后依然清晰）；
          // 无动画的瞬时缩放 / 不触发 Ge 的情况也在这里一次性校正。
          cancelProvinceAnim();
          provinceReprojectRef.current();
          layerRef.current?.classList.remove('zooming');
          layerRef.current?.classList.remove('interacting');
        });
        map.addEventListener('resize', follow);

        // 记住视野：移动/缩放停下 300ms 后存一次，别在拖动过程中反复写
        let saveTimer = 0;
        const saveView = () => {
          window.clearTimeout(saveTimer);
          saveTimer = window.setTimeout(() => {
            try {
              const c = map.getCenter();
              localStorage.setItem(
                VIEW_KEY,
                JSON.stringify({ lng: c.getLng(), lat: c.getLat(), zoom: map.getZoom() })
              );
            } catch {
              /* 隐私模式写不进去就算了 */
            }
          }, 300);
        };
        map.addEventListener('moveend', saveView);
        map.addEventListener('zoomend', saveView);

        setReady(true);
        onStatus({ ready: true });
      } catch (e: any) {
        const msg = e?.message || String(e);
        setError(msg);
        onStatus({ ready: false, error: msg });
      }
    })();
    return () => {
      dead = true;
      window.clearTimeout(pinClickTimer);
      detachMapPointer?.();
      provinceAnimCancel?.();
      stopLoop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tk]);

  // ── 数据或选中态变化时重建标记（家现在也是 places 里的一员，不再单列依赖）──
  useEffect(() => {
    if (!ready) return;
    rebuild();
  }, [ready, places, selectedId, statsMode, rebuild]);

  // ── 草稿标记（自己实现拖拽） ──
  useEffect(() => {
    const layer = layerRef.current;
    const map = mapRef.current;
    const T = TRef.current;
    if (!ready || !layer || !map || !T) return;

    if (!draft) {
      draftPin.current?.remove();
      draftPin.current = null;
      return;
    }

    let el = draftPin.current;

    if (!el) {
      el = document.createElement('div');
      el.className = 'pin draft';
      // D-150：草稿只做「松手回弹」，不做常驻呼吸（它正在被拖动/定位）
      const draftBody = document.createElement('div');
      draftBody.className = 'pin-body';
      const img = document.createElement('img');
      img.src = '/marker.svg';
      img.alt = '';
      img.draggable = false;
      draftBody.appendChild(img);
      el.appendChild(draftBody);
      layer.appendChild(el);
      draftPin.current = el;

      let dragging = false;
      let moved = false;
      let startX = 0;
      let startY = 0;

      el.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        dragging = true;
        moved = false;
        startX = ev.clientX;
        startY = ev.clientY;
        el!.setPointerCapture(ev.pointerId);
        el!.classList.add('dragging');
      });

      el.addEventListener('pointermove', (ev) => {
        if (!dragging) return;
        // D-160：4px 拖动阈值——单纯点击（哪怕手抖 1~2px）不算拖动，
        // 否则 pointerup 会把草稿锚点改到「点击图标的位置」，视觉上向上跳一截。
        if (!moved) {
          const dx = ev.clientX - startX;
          const dy = ev.clientY - startY;
          if (Math.hypot(dx, dy) < 4) return;
          moved = true;
        }
        const rect = layer.getBoundingClientRect();
        const x = ev.clientX - rect.left;
        const y = ev.clientY - rect.top;
        el!.style.transform = `translate(${x - 23}px, ${y - 46}px)`;
      });

      el.addEventListener('pointerup', (ev) => {
        if (!dragging) return;
        dragging = false;
        el!.classList.remove('dragging');
        // 只有真正拖动过才更新草稿坐标；点击图标本体不改变落点。
        if (moved) {
          const rect = layer.getBoundingClientRect();
          const x = ev.clientX - rect.left;
          const y = ev.clientY - rect.top;
          try {
            const ll = map.containerPointToLngLat(new T.Point(x, y));
            const lng = ll.getLng();
            const lat = ll.getLat();
            el!.dataset.lng = String(lng);
            el!.dataset.lat = String(lat);
            cbs.current.onDraftMoved(lng, lat);
          } catch (e) {
            console.error('[map] 拖动换算失败', e);
          }
          positionAll();
        }
        // D-150 / D-160：松手（含单击）播一次向下的回弹，不改变落点
        el!.classList.add('is-settling');
        window.setTimeout(() => el?.classList.remove('is-settling'), 260);
      });
    }

    el.dataset.lng = String(draft.lng);
    el.dataset.lat = String(draft.lat);
    positionAll();
  }, [draft, ready, positionAll]);

  return (
    <div
      className={
        'map-wrap' + (pinMode ? ' pin-mode' : '') + (statsMode ? ' stats-mode' : '')
      }
    >
      <div id="map" className="map" />
      {statsMode && (
        <div className="province-layer" ref={provinceLayerRef}>
          <svg className="province-svg" ref={provinceSvgRef}>
            <defs>
              {/* 低缩放时给填充边缘做羽化：天地图低缩放底图省界是概化的，硬边缘会显得“对不齐” */}
              <filter id="province-soft" x="-30%" y="-30%" width="160%" height="160%">
                <feGaussianBlur stdDeviation="5" />
              </filter>
            </defs>
            <g className="province-g" ref={provinceGRef} />
          </svg>
        </div>
      )}
      <div className="pin-layer" ref={layerRef} />
      {statsMode && provinceError && (
        <div className="province-warn">
          {t('省界数据加载失败：{msg}', { msg: provinceError })}
          <br />
          {t('统计面板里的省份排行仍然可用。')}
        </div>
      )}
      {error && (
        <div className="map-error">
          <h3>{t('地图加载失败')}</h3>
          <p>{error}</p>
          <p className="hint">
            {t('检查')} <code>.env.local</code> {t('里的')} <code>TDT_TK</code>
            {t('，以及网络能否访问天地图。')}
          </p>
        </div>
      )}
    </div>
  );
}
