/**
 * 地图标记共用的「十二色相环」调色板（2026-11-05，D-164 修订）。
 *
 * 用户反馈：设置里 7 个色点在四个图标分组下重复出现了 4 次，希望「做成一条放到下面」，
 * 并且「按照十二色相环铺成一个长条」。所以调色板改为 **12 个等距色相**：
 * 红 → 橙 → 黄 → 黄绿 → 绿 → 青绿 → 青 → 天蓝 → 靛蓝 → 紫罗兰 → 品红 → 珊瑚红，
 * 设置页渲染为**一条连续的长色条**，四组图标共用（先选图标类型，再点色条上的颜色）。
 *
 * 图标都是 public/ 下的静态 SVG（<img> 引用，不能靠 CSS 改色），所以每种颜色
 * 各一个文件（由 `scripts/build-marker-colors.mjs` 生成，改色值需重跑脚本）；
 * `homeIcon.ts`（家）与 `markerColors.ts`（去过 / 想去 / 秘密基地）共用本文件。
 * 偏好只存本机 localStorage，不写 data/、不进备份。
 */
export type MarkerColorId =
  | 'red'
  | 'orange'
  | 'yellow'
  | 'lime'
  | 'green'
  | 'teal'
  | 'cyan'
  | 'sky'
  | 'indigo'
  | 'violet'
  | 'fuchsia'
  | 'coral';

export interface MarkerColorOption {
  id: MarkerColorId;
  /** 中文展示名（英文界面由 i18n 字典翻译） */
  label: string;
  hex: string;
}

/** 顺序 = 十二色相环顺序，也是设置页色条从左到右的顺序 */
export const MARKER_COLOR_OPTIONS: MarkerColorOption[] = [
  { id: 'red', label: '红', hex: '#ef4444' },
  { id: 'orange', label: '橙', hex: '#f97316' },
  { id: 'yellow', label: '黄', hex: '#eab308' },
  { id: 'lime', label: '黄绿', hex: '#84cc16' },
  { id: 'green', label: '绿', hex: '#22c55e' },
  { id: 'teal', label: '青绿', hex: '#34d399' },
  { id: 'cyan', label: '青', hex: '#22d3ee' },
  { id: 'sky', label: '天蓝', hex: '#38bdf8' },
  { id: 'indigo', label: '靛蓝', hex: '#6366f1' },
  { id: 'violet', label: '紫罗兰', hex: '#a78bfa' },
  { id: 'fuchsia', label: '品红', hex: '#e879f9' },
  { id: 'coral', label: '珊瑚红', hex: '#fb7185' },
];

export function isMarkerColorId(v: string | null | undefined): v is MarkerColorId {
  return !!v && MARKER_COLOR_OPTIONS.some((o) => o.id === v);
}

export function markerColorHex(id: MarkerColorId): string {
  return MARKER_COLOR_OPTIONS.find((o) => o.id === id)?.hex ?? '#34d399';
}

/**
 * 旧 7 色 id → 新 12 色 id（D-161 / D-164 第一版的本地偏好迁移）：
 * 用户已经在浏览器里选过的颜色尽量映射到最接近的新色，避免「刷新后突然回默认」。
 * teal / sky / indigo / coral 四色在新色板里保留了同名 id，不需要映射。
 */
export const LEGACY_COLOR_ID_MAP: Record<string, MarkerColorId> = {
  forest: 'green',
  pine: 'teal',
  amber: 'orange',
};

/** 把 localStorage 里读到的值规范成新色板 id；无法识别返回 null（调用方回退默认） */
export function normalizeMarkerColorId(v: unknown): MarkerColorId | null {
  if (typeof v !== 'string') return null;
  if (isMarkerColorId(v)) return v;
  return LEGACY_COLOR_ID_MAP[v] ?? null;
}
