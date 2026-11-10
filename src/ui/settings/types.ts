/**
 * 外观档位（2026-11-04：原「浅色 / 深色」两档合并为 4 档轴）：
 * white 纯白 → light 浅色 → dark 深色 → black 纯黑。
 */
export type ThemeLevel = 'white' | 'light' | 'dark' | 'black';

/** 主题偏好：4 个固定档位 或「跟随系统」 */
export type Theme = ThemeLevel | 'system';

/** 轴的 4 个停靠点（从左到右 = 由纯白到纯黑） */
export const THEME_LEVELS: ThemeLevel[] = ['white', 'light', 'dark', 'black'];

/** 每个档位的展示名 */
export const THEME_LEVEL_LABEL: Record<ThemeLevel, string> = {
  white: '纯白',
  light: '浅色',
  dark: '深色',
  black: '纯黑',
};

/**
 * 界面字体（2026-11-04，D-92；2026-11-05 D-140 增加用户下载字体；
 * **2026-11-07 D-227（公开发布准备，用户确认）**：只保留 2 款 SIL OFL 字体（喵咛狗爬黑 / 嗷呜碎瘾黑）
 * 随仓库发布，默认字体改为「喵咛狗爬黑」；乐米栀夏浅风体 / 乐米清砚方墨体 / 方塘像素体
 * 与系统「仿宋」选项已按用户要求删除（乐米两款 © 乐米 All rights reserved、方塘像素体无许可声明，
 * 不适合放公开仓库；仿宋是系统字体、不再提供选项）。
 * 常规字体可选，只存本机浏览器偏好（和主题一样，不写 data/、不进备份）。
 * 取值对应 src/styles.css 里 `html[data-font='…']` 使用的 `--font-ui`，
 * 以及各选项预览用的 `--font-opt-*`。
 * 系统自带字体只写字体族名；OFL 下载字体是 public/fonts/ 里本地 @font-face 加载的
 * （随仓库发布，许可见 public/fonts/LICENSES.md）。
 *
 * **2026-11-08 D-298（用户提供 6 款猫啃网下载字体）**：新增 猫啃什锦黑 / 荆南波波黑 /
 * 游趣体 / 铁蒺藜体 / 呆萌手写体 / 字魂扁桃体，均为 SIL OFL 1.1，随仓库发布；
 * 下载字体从 2 款变为 8 款（设置里共 12 档：8 款 OFL + 4 款系统字体）。
 * **2026-11-08 D-299（用户要求「嗷呜碎瘾黑彻底删除」）**：删除 嗷呜碎瘾黑 →
 * 现在下载字体 **7 款**（设置里共 **11 档**：7 款 OFL + 4 款系统字体）。
 */
export type AppFont =
  | 'yahei'
  | 'songti'
  | 'heiti'
  | 'kaiti'
  | 'miao-goupa'
  | 'maoken-shijin'
  | 'jingnan-bobohei'
  | 'childfun-sans'
  | 'tiejili'
  | 'dymon-shouxieti'
  | 'zihun-biantaoti';

export interface FontOption {
  id: AppFont;
  label: string;
}

/** 选项顺序 = 设置页里的展示顺序；每个选项用对应字体渲染自己的名字，所见即所得。
 *  默认字体（2026-11-10 D-359 起 = 猫啃什锦黑）排第一；不提供「系统默认」一项
 *  （旧偏好 tm-font='system' 或已删除字体，读的时候校验不通过、自动回落到默认字体）。 */
export const APP_FONTS: FontOption[] = [
  // 2026-11-10 D-359：用户要求默认字体改为猫啃什锦黑 → 排第一
  { id: 'maoken-shijin', label: '猫啃什锦黑' },
  // 2026-11-08 D-298：用户提供、猫啃网下载的 6 款 SIL OFL 1.1 字体
  // 2026-11-08 D-299：嗷呜碎瘾黑按用户要求彻底删除；现为 7 款下载字体 + 4 款系统字体
  { id: 'miao-goupa', label: '喵咛狗爬黑' },
  { id: 'jingnan-bobohei', label: '荆南波波黑' },
  { id: 'childfun-sans', label: '游趣体' },
  { id: 'tiejili', label: '铁蒺藜体' },
  { id: 'dymon-shouxieti', label: '呆萌手写体' },
  { id: 'zihun-biantaoti', label: '字魂扁桃体' },
  { id: 'yahei', label: '微软雅黑' },
  { id: 'songti', label: '宋体' },
  { id: 'heiti', label: '黑体' },
  { id: 'kaiti', label: '楷体' },
];

/** 默认界面字体（2026-11-10 D-359 用户要求：改为猫啃什锦黑；此前 2026-11-07 D-227 起为喵咛狗爬黑）
 *  仍随仓库发布（SIL OFL 1.1，public/fonts/） */
export const DEFAULT_FONT: AppFont = 'maoken-shijin';

/** localStorage 里的值可能来自旧版本/手改，读的时候统一校验 */
export const isAppFont = (v: string | null): v is AppFont =>
  v !== null && APP_FONTS.some((f) => f.id === v);

/**
 * 到访照片网格「每行几张」（2026-11-04，D-116，用户要求：
 * 地点侧栏里的照片太大，希望能选一行放几张）。
 *
 * 只影响地点侧栏中每次到访的照片网格（以及末尾的「+ 添加素材」格），
 * 不改原图、不改数据；和主题 / 字体一样只存本机浏览器（localStorage），
 * 通过 `<html>` 上的 CSS 变量 `--visit-cols` 生效。
 */
export type MediaCols = 2 | 3 | 4 | 5;

export const MEDIA_COLS: MediaCols[] = [2, 3, 4, 5];

/** 默认 3 张/行 = 改动前的网格，避免升级后突然变样 */
export const DEFAULT_MEDIA_COLS: MediaCols = 3;

export const isMediaCols = (v: number | null | undefined): v is MediaCols =>
  v === 2 || v === 3 || v === 4 || v === 5;

/**
 * 界面字号（2026-11-05，D-142）：小 / 中 / 大三档。
 *
 * 只缩放「界面文字」：styles.css 里全站 font-size 都写成
 * `calc(Npx * var(--fs-scale))`，由 `html[data-fontsize='sm|md|lg']` 设系数
 * （1.0 / 1.2 / 1.4；D-299 用户要求中档再大一个字号、大档再大两个字号，此前为 1.0 / 1.1 / 1.2）。
 * 图片、图标、地图、布局盒子比例都不变；
 * 顶栏 6 键（宽度受 632px 轨道约束）宽度固定、文字跟随缩放。
 * 默认「中」= 2026-11-08 D-282 曾改为「大」，2026-11-10 D-359 用户要求改回「中」；
 * 偏好只存本机浏览器 `tm-font-size`（不写 data/、不进备份）。
 */
export type FontSize = 'sm' | 'md' | 'lg';

export const FONT_SIZES: FontSize[] = ['sm', 'md', 'lg'];

/** 三档的展示名（英文界面在 i18n 字典里翻译） */
export const FONT_SIZE_LABEL: Record<FontSize, string> = {
  sm: '小',
  md: '中',
  lg: '大',
};

export const DEFAULT_FONT_SIZE: FontSize = 'md';

export const isFontSize = (v: string | null | undefined): v is FontSize =>
  v === 'sm' || v === 'md' || v === 'lg';

/**
 * 界面字重（2026-11-06 用户要求：字号旁边加「常规 / 加粗」两档）。
 *
 * 常规 = 正文 400（和原来一致）；加粗 = 正文 600。标题 / 按钮等本来写死字重的元素不变。
 * 由 `html[data-fontweight='normal|bold']` 的 `--font-weight-ui` 生效。
 * 只存本机浏览器 `tm-font-weight`（不写 data/、不进备份）。
 */
export type FontWeight = 'normal' | 'bold';

export const FONT_WEIGHTS: FontWeight[] = ['normal', 'bold'];

/** 两档的展示名（英文界面在 i18n 字典里翻译） */
export const FONT_WEIGHT_LABEL: Record<FontWeight, string> = {
  normal: '常规',
  bold: '加粗',
};

/**
 * 默认界面字重（2026-11-10 D-359 用户要求：默认「常规」；
 * D-282 起为「加粗」；此前 2026-11-06 起默认是「常规」）。
 */
export const DEFAULT_FONT_WEIGHT: FontWeight = 'normal';

export const isFontWeight = (v: string | null | undefined): v is FontWeight =>
  v === 'normal' || v === 'bold';

/**
 * 应用主题标语（2026-11-05，D-146 / D-147）：显示在顶栏大按钮组上方的那一句主题文字。
 *
 * 用户可在 设置 → 通用 → 主题 里用**一个输入框**自定义（D-147 起不再分两段）；
 * 默认文案来自 i18n（中文「世界辣 ~ ~ ~ 么大」/「我想 · · · 总得去看一看吧 ! ! !」，
 * 界面英文时显示对应英文）。
 * - 留空 = 不显示标语。
 * - 只存本机浏览器 `tm-slogan`（纯文本；旧版两段 JSON 会自动拼成一句迁移），
 *   不写 data/、不进备份，和主题 / 字体 / 字号一样属于本机 UI 偏好。
 * - 窄屏（<1420px）标语本来就不显示。
 */
export type Slogan = string;

/** 标语最大长度（2026-11-07 D-226 用户要求：限定 **40 字以内**；同日先定 30、后按用户反馈改为 40；此前 D-147 为 80） */
export const SLOGAN_MAX_LEN = 40;
