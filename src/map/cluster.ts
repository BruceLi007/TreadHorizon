import type { Place } from '../lib/types';
import { tr, tp, type TFn, type TPfn } from '../i18n';

export interface Cluster {
  lng: number;
  lat: number;
  /** 地点数 */
  count: number;
  /** 簇内「去过」的地点数 */
  visitedCount: number;
  /** 簇内「想去」的地点数 */
  wishCount: number;
  /** 到访次数合计（只算去过的，想去不计） */
  visits: number;
  /** 出现最多的省份 */
  province: string | null;
  /** 该省在本簇里的到访次数 */
  provinceVisits: number;
  /** 是否跨省 */
  mixed: boolean;
  /** 单点簇时代表那个地点 */
  place: Place;
  /** 簇内所有地点（点击缩放时要用它算"散开的级别"） */
  members: Place[];
  /** 最近去过的那一个（用于悬停气泡） */
  latestName: string | null;
  latestDate: string | null;
}

/** 网格边长（屏幕像素） */
const GRID = 60;
const SINGLE_SIZE = 30;
/** 单飞镖的锚点在底部（尖头），图标往上长 30px，所以视觉中心比坐标点高 15px */
const SINGLE_CENTER_LIFT = SINGLE_SIZE / 2;

/** 聚合点/单飞镖的直径 */
export function markerSize(count: number): number {
  if (count <= 1) return SINGLE_SIZE;
  return count < 10 ? 38 : count < 50 ? 46 : 54;
}

function toPixel(lng: number, lat: number, scale: number) {
  const x = ((lng + 180) / 360) * scale;
  const s = Math.sin((lat * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale;
  return { x, y };
}

interface Acc {
  /** 经纬度累加（用于质心） */
  sx: number;
  sy: number;
  /** 世界像素累加（用于判定视觉重叠） */
  px: number;
  py: number;
  n: number;
  /** 去过 / 想去各多少（混合簇要看比例） */
  visitedCount: number;
  wishCount: number;
  visits: number;
  byProvince: Map<string, { places: number; visits: number }>;
  first: Place;
  items: Place[];
  latestName: string | null;
  latestDate: string | null;
}

function newAcc(p: Place): Acc {
  return {
    sx: 0,
    sy: 0,
    px: 0,
    py: 0,
    n: 0,
    visitedCount: 0,
    wishCount: 0,
    visits: 0,
    byProvince: new Map(),
    first: p,
    items: [],
    latestName: null,
    latestDate: null,
  };
}

function addToAcc(acc: Acc, p: Place, x: number, y: number) {
  const v = Math.max(1, p.visit_count ?? 1);
  acc.sx += p.lng;
  acc.sy += p.lat;
  acc.px += x;
  acc.py += y;
  acc.n += 1;
  // 想去不算「去过几次」，但和去过一起参与聚合（否则两个标记会叠在一起）
  if (p.kind === 'wishlist') {
    acc.wishCount += 1;
  } else {
    acc.visitedCount += 1;
    acc.visits += v;
  }
  acc.items.push(p);

  const ld = p.last_date || '';
  if (ld && (!acc.latestDate || ld > acc.latestDate)) {
    acc.latestDate = ld;
    acc.latestName = p.name;
  }

  const prov = p.province || '';
  if (prov) {
    const e = acc.byProvince.get(prov) || { places: 0, visits: 0 };
    e.places += 1;
    e.visits += p.kind === 'wishlist' ? 0 : v;
    acc.byProvince.set(prov, e);
  }
}

function mergeAcc(into: Acc, from: Acc) {
  into.sx += from.sx;
  into.sy += from.sy;
  into.px += from.px;
  into.py += from.py;
  into.n += from.n;
  into.visitedCount += from.visitedCount;
  into.wishCount += from.wishCount;
  into.visits += from.visits;
  for (const [name, e] of from.byProvince) {
    const cur = into.byProvince.get(name) || { places: 0, visits: 0 };
    cur.places += e.places;
    cur.visits += e.visits;
    into.byProvince.set(name, cur);
  }
  into.items.push(...from.items);
  if (from.latestDate && (!into.latestDate || from.latestDate > into.latestDate)) {
    into.latestDate = from.latestDate;
    into.latestName = from.latestName;
  }
}

interface Footprint {
  cx: number;
  cy: number;
  w: number;
  h: number;
}

/**
 * 实际绘制出来的盒子（世界像素坐标）。
 * 单飞镖的锚点在底部坐标点上、图往上长，所以视觉中心要上移 15px；
 * 不把这个偏移算进去，就会出现「飞镖尖顶在靶盘下沿、看着叠在一起」。
 */
function footprint(acc: Acc): Footprint {
  const ax = acc.px / acc.n;
  const ay = acc.py / acc.n;
  if (acc.n === 1) {
    return { cx: ax, cy: ay - SINGLE_CENTER_LIFT, w: SINGLE_SIZE, h: SINGLE_SIZE };
  }
  const size = markerSize(acc.n);
  return { cx: ax, cy: ay, w: size, h: size };
}

function boxesOverlap(a: Footprint, b: Footprint): boolean {
  return (
    Math.abs(a.cx - b.cx) < (a.w + b.w) / 2 && Math.abs(a.cy - b.cy) < (a.h + b.h) / 2
  );
}

/**
 * 视觉重叠合并：
 * 光按 60px 网格分桶是不够的——两个地点落在相邻格子里时，
 * 质心可能只差几像素，于是「靶盘 + 单个飞镖」会叠在一起（2026-11-01 实测反馈）。
 * 这里在初分之后再按**实际绘制盒子**做迭代合并，直到任意两个标记互不重叠。
 */
function mergeTouching(list: Acc[]): Acc[] {
  // 大簇优先吸收，质心更稳定
  const out = [...list].sort((x, y) => y.n - x.n);
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 100) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const a = out[i];
      let j = i + 1;
      while (j < out.length) {
        const b = out[j];
        if (boxesOverlap(footprint(a), footprint(b))) {
          mergeAcc(a, b);
          out.splice(j, 1);
          changed = true;
          // a 长大/质心变了，继续拿同一个 j 比（splice 后 j 指向下一个）
        } else {
          j++;
        }
      }
    }
  }
  return out;
}

/**
 * 世界像素网格聚合 + 视觉重叠合并。
 *
 * 网格原点用「世界坐标」而不是「屏幕坐标」，
 * 这样拖动地图不会让点重新分桶（否则标记会在拖拽中闪烁重排）。
 * 只有 zoom 变化才重新聚合。
 */
export function clusterPlaces(places: Place[], zoom: number, grid = GRID): Cluster[] {
  if (!places.length) return [];
  // 保留小数缩放：渲染用的就是这个比例。
  // 四舍五入会让重叠判定偏差最多 2^0.5≈1.41 倍，正好漏掉「看起来已经叠住」的一对。
  const raw = Number.isFinite(zoom) ? zoom : 4;
  const z = Math.max(3, Math.min(18, raw));
  const scale = 256 * Math.pow(2, z);

  const buckets = new Map<string, Acc>();

  for (const p of places) {
    const { x, y } = toPixel(p.lng, p.lat, scale);
    const key = `${Math.floor(x / grid)},${Math.floor(y / grid)}`;
    let acc = buckets.get(key);
    if (!acc) {
      acc = newAcc(p);
      buckets.set(key, acc);
    }
    addToAcc(acc, p, x, y);
  }

  const merged = mergeTouching([...buckets.values()]);

  return merged.map((acc) => {
    let province: string | null = null;
    let provinceVisits = 0;
    let best = -1;
    for (const [name, e] of acc.byProvince) {
      if (e.visits > best) {
        best = e.visits;
        province = name;
        provinceVisits = e.visits;
      }
    }
    return {
      lng: acc.sx / acc.n,
      lat: acc.sy / acc.n,
      count: acc.n,
      visitedCount: acc.visitedCount,
      wishCount: acc.wishCount,
      visits: acc.visits,
      province,
      provinceVisits,
      mixed: acc.byProvince.size > 1,
      place: acc.first,
      members: acc.items,
      latestName: acc.latestName,
      latestDate: acc.latestDate,
    };
  });
}

export type ClusterKind = 'visited' | 'wishlist' | 'mixed';

/**
 * 簇的构成：纯去过 / 纯想去 / 两者混合。
 * 决定靶盘配色（琥珀 / 冷蓝 / 双色）和悬停文案。
 */
export function clusterKind(c: Cluster): ClusterKind {
  if (c.visitedCount > 0 && c.wishCount > 0) return 'mixed';
  return c.wishCount > 0 ? 'wishlist' : 'visited';
}

/**
 * 找到「这一簇刚好散开」的缩放级别。
 * 从当前级别往上试，直到每个地点都占到自己那一格。
 */
export function zoomToSpread(members: Place[], from: number, maxZoom = 17): number {
  if (members.length < 2) return Math.min(maxZoom, Math.max(3, Math.round(from) + 1));
  const start = Math.max(3, Math.floor(from) + 1);
  for (let z = start; z <= maxZoom; z++) {
    if (clusterPlaces(members, z, GRID).length >= members.length) return z;
  }
  return maxZoom;
}

/** 悬停气泡的主标题（纯函数：翻译函数由调用方传入，默认走模块级语言） */
export function clusterLabel(c: Cluster, t: TFn = tr, tpFn: TPfn = tp): string {
  const kind = clusterKind(c);
  if (kind === 'wishlist') return t('{n} 个想去的地方', { n: c.count });
  if (kind === 'mixed') {
    return t('{visited} 个去过 · {wish} 个想去', {
      visited: c.visitedCount,
      wish: c.wishCount,
    });
  }
  if (c.mixed) {
    return t('{province}等 {n} 个地方 · 一共去了 {visits} 次', {
      province: c.province ? tpFn(c.province) : t('多地'),
      n: c.count,
      visits: c.visits,
    });
  }
  if (c.province) {
    return t('在{province}玩过 {visits} 次 · {n} 个地方', {
      province: tpFn(c.province),
      visits: c.provinceVisits,
      n: c.count,
    });
  }
  return t('这一带有 {n} 个地方 · 一共去了 {visits} 次', {
    n: c.count,
    visits: c.visits,
  });
}

/** 悬停气泡的副标题：最近去过的地方 */
export function clusterSub(c: Cluster, t: TFn = tr): string {
  if (!c.latestDate || !c.latestName) return '';
  return t('最近：{name} · {date}', {
    name: c.latestName,
    date: c.latestDate.slice(0, 7).replace('-', '.'),
  });
}
