/**
 * 三种普通地图标记（去过 / 想去 / 秘密基地）的配色（2026-11-05，D-164）。
 *
 * 用户要求：在 设置 → 通用 → 外观 的「家图标配色」右侧，也能给这三种图标选颜色，
 * 可选配色与「家」一致。**修订后（同日）**：四组图标共用一条「十二色相环」长色条
 * （见 markerPalette.ts），设置里先选图标类型、再点色条上的颜色。
 *
 * 约定：
 * - **默认色 = 用户截图指定的配色**（2026-11-05 深夜）：去过 **绿** `#22c55e` /
 *   想去 **红** `#ef4444` / 秘密基地 **品红** `#e879f9`（都是 12 色条里的颜色）；
 *   没改动过时地图就是这三色，色条上会选中对应的色段；
 * - 选了其他颜色 → 用 public/marker-color-<id>.svg（三种图标默认形状相同，只换填充色）；
 * - 只存本机浏览器 `tm-marker-colors`（JSON），不写 data/、不进备份；
 * - 影响范围：地图单点、聚合点里对应类型的图标、点击涟漪 / 秘密基地发光、My旅迹列表占位图标。
 *   草稿飞镖和打点光标是「打点工具」，保持琥珀色，不跟随这里的设置。
 */
import {
  MARKER_COLOR_OPTIONS,
  markerColorHex,
  normalizeMarkerColorId,
  type MarkerColorId,
} from './markerPalette';

/** 供设置页直接 `import type { MarkerColorId } from '../../lib/markerColors'` */
export type { MarkerColorId };

export type MarkerKind = 'visited' | 'wishlist' | 'secret';

export const MARKER_KINDS: MarkerKind[] = ['visited', 'wishlist', 'secret'];

/** 中文类型名（英文界面由 i18n 字典翻译） */
export const MARKER_KIND_LABEL: Record<MarkerKind, string> = {
  visited: '去过',
  wishlist: '想去',
  secret: '秘密基地',
};

/**
 * 默认配色（2026-11-05 深夜用户截图指定）：去过 绿 / 想去 红 / 秘密基地 品红。
 * 三个都是 12 色条里的颜色，所以色条上会选中对应色段；「恢复默认颜色」回到这里。
 */
export const DEFAULT_MARKER_COLOR_ID: Record<MarkerKind, MarkerColorId> = {
  visited: 'green',
  wishlist: 'red',
  secret: 'fuchsia',
};

/** 默认色值（来自公共调色板） */
export const MARKER_DEFAULT_HEX: Record<MarkerKind, string> = {
  visited: markerColorHex(DEFAULT_MARKER_COLOR_ID.visited),
  wishlist: markerColorHex(DEFAULT_MARKER_COLOR_ID.wishlist),
  secret: markerColorHex(DEFAULT_MARKER_COLOR_ID.secret),
};

export const MARKER_COLOR_KEY = 'tm-marker-colors';

/** null = 使用该类型的默认配色（DEFAULT_MARKER_COLOR_ID） */
export type MarkerColorPrefs = Record<MarkerKind, MarkerColorId | null>;

export const DEFAULT_MARKER_COLORS: MarkerColorPrefs = {
  visited: null,
  wishlist: null,
  secret: null,
};

/** 当前生效的颜色 id：没选过就是该类型的默认色 */
export function markerColorOf(kind: MarkerKind, prefs: MarkerColorPrefs): MarkerColorId {
  return prefs[kind] ?? DEFAULT_MARKER_COLOR_ID[kind];
}

/** 读偏好：容错——旧 7 色 id 自动迁移，坏 JSON / 手改值回落默认（不抛错） */
export function readMarkerColors(): MarkerColorPrefs {
  const out: MarkerColorPrefs = { ...DEFAULT_MARKER_COLORS };
  try {
    const raw = localStorage.getItem(MARKER_COLOR_KEY);
    if (!raw) return out;
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object') return out;
    for (const kind of MARKER_KINDS) {
      out[kind] = normalizeMarkerColorId(parsed[kind]);
    }
  } catch {
    /* 隐私模式 / 坏 JSON：用默认色 */
  }
  return out;
}

export function saveMarkerColors(prefs: MarkerColorPrefs): void {
  try {
    localStorage.setItem(MARKER_COLOR_KEY, JSON.stringify(prefs));
  } catch {
    /* 隐私模式下可能写不进去，忽略 */
  }
}

/** 地图 / 列表用的图标地址：按当前生效颜色取 12 色相 SVG */
export function markerSrc(kind: MarkerKind, prefs: MarkerColorPrefs): string {
  return `/marker-color-${markerColorOf(kind, prefs)}.svg`;
}

/** 当前生效色值（点击涟漪 / 秘密基地发光 / 设置预览） */
export function markerHex(kind: MarkerKind, prefs: MarkerColorPrefs): string {
  return markerColorHex(markerColorOf(kind, prefs));
}

/** 设置 → 外观 的类型预览图 */
export function markerPreviewSrc(kind: MarkerKind, prefs: MarkerColorPrefs): string {
  return markerSrc(kind, prefs);
}

/** `#rrggbb` → `rgba(r,g,b,a)`：秘密基地发光等少数地方要带透明度 */
export function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return `rgba(167, 139, 250, ${alpha})`;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** 相对亮度（WCAG 定义），用于给自定义配色的色块挑可读文字色 */
function relativeLuminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const r = channel((n >> 16) & 255);
  const g = channel((n >> 8) & 255);
  const b = channel(n & 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * 在给定底色（标记配色 hex）上可读性最好的文字颜色（2026-11-09，D-325）。
 * 地点编辑里的「设为秘密基地 / 设为家」按钮背景会跟随用户选的标记配色，
 * 12 种色相明暗不一（青 / 品红偏亮用深墨字，靛蓝 / 紫罗兰偏暗用白字），
 * 这里按 WCAG 对比度在「深墨」和「白色」里取对比度更高的一个。
 */
export function readableTextOn(hex: string): string {
  const ink = '#0b1220';
  const white = '#ffffff';
  const contrast = (a: string, b: string) => {
    const la = relativeLuminance(a);
    const lb = relativeLuminance(b);
    const hi = Math.max(la, lb);
    const lo = Math.min(la, lb);
    return (hi + 0.05) / (lo + 0.05);
  };
  return contrast(hex, ink) >= contrast(hex, white) ? ink : white;
}

/** 色条顺序（设置页按十二色相环从左到右渲染） */
export const MARKER_COLOR_CHOICES = MARKER_COLOR_OPTIONS;
