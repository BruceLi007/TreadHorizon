import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import MapView, { type MapApi } from './map/MapView';
import type { Cluster } from './map/cluster';
import Sidebar from './ui/Sidebar';
import { haversineKm } from './lib/geo';
import SettingsModal, { type Theme, type ThemeLevel, type TabId } from './ui/settings/SettingsModal';
import {
  DEFAULT_FONT,
  DEFAULT_FONT_WEIGHT,
  SLOGAN_MAX_LEN,
  isAppFont,
  isFontSize,
  isFontWeight,
  isMediaCols,
  type AppFont,
  type FontSize,
  type FontWeight,
  type MediaCols,
  type Slogan,
} from './ui/settings/types';
import MyTrailPanel, { type MyTrailTab } from './ui/MyTrailPanel';
import AddPanel from './ui/AddPanel';
import Lightbox from './ui/Lightbox';
import ClusterPanel from './ui/ClusterPanel';
import MergePanel from './ui/MergePanel';
import SearchBox from './ui/SearchBox';
import Timeline, { type RangeValue } from './ui/Timeline';
import StatsPanel from './ui/StatsPanel';
import PhotoWall from './ui/PhotoWall';
import LoginPage from './ui/LoginPage';
import KeySetupPage from './ui/KeySetupPage';
import SecretPrompt from './ui/SecretPrompt';
import { api } from './lib/api';
import type { AuthMe } from './lib/types';
import { normalizeRegion } from './lib/region';
import { isInsideChina, loadChinaBounds } from './lib/chinaBounds';
import {
  HOME_COLOR_KEY,
  homeMarkerSrc,
  readHomeColor,
  type HomeColor,
} from './lib/homeIcon';
import {
  readMarkerColors,
  saveMarkerColors,
  markerSrc,
  type MarkerColorPrefs,
} from './lib/markerColors';
import {
  I18nContext,
  isLang,
  makeT,
  makeTp,
  setCurrentLang,
  tr,
  type Lang,
} from './i18n';
import type { Addr, BackupStatus, Place, PlaceDetail, Poi, ProvinceLight, UploadItem } from './lib/types';

export interface DraftState {
  lng: number;
  lat: number;
  name: string;
  addr: Addr | null;
  date: string;
  kind: 'visited' | 'wishlist';
  nameTouched: boolean;
}

const today = () => new Date().toISOString().slice(0, 10);
const THEME_KEY = 'tm-theme';
const isTheme = (v: string | null): v is Theme =>
  v === 'white' || v === 'light' || v === 'dark' || v === 'black' || v === 'system';
/** 主题偏好：4 档外观轴（纯白→浅色→深色→纯黑）+ 跟随系统；默认深色（保持原有行为） */
const readTheme = (): Theme => {
  try {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem(THEME_KEY) : null;
    return isTheme(v) ? v : 'dark';
  } catch {
    return 'dark';
  }
};
/**
 * 界面字体（2026-11-04，D-92；2026-11-07 D-227：默认改为「喵咛狗爬黑」，字体选项精简为 2 款 OFL + 系统 4 款）。
 * 默认 = DEFAULT_FONT；只存本机浏览器，不写 data/。
 * 旧偏好里可能还存着 'system'（已删除的「系统默认」）或已删除字体（乐米 / 方塘像素体 / 仿宋）——
 * 校验不通过，自动回落到默认字体。
 */
const FONT_KEY = 'tm-font';
const readFont = (): AppFont => {
  try {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem(FONT_KEY) : null;
    if (isAppFont(v)) return v;
  } catch {
    /* 隐私模式读不到：用默认 */
  }
  return DEFAULT_FONT;
};
/** 界面字号（2026-11-05，D-142）：小 / 中 / 大三档，默认「中」；只存本机浏览器 */
const FONT_SIZE_KEY = 'tm-font-size';
const readFontSize = (): FontSize => {
  try {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem(FONT_SIZE_KEY) : null;
    return isFontSize(v) ? v : 'md';
  } catch {
    return 'md';
  }
};
/** 界面字重（2026-11-06 用户要求）：常规 / 加粗；只存本机浏览器 */
const FONT_WEIGHT_KEY = 'tm-font-weight';
const readFontWeight = (): FontWeight => {
  try {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem(FONT_WEIGHT_KEY) : null;
    return isFontWeight(v) ? v : DEFAULT_FONT_WEIGHT;
  } catch {
    return DEFAULT_FONT_WEIGHT;
  }
};
/** 应用主题标语（2026-11-05 D-146 / D-147）：一句话，可在 设置 → 通用 → 主题 自定义；只存本机。
 *  null = 用 i18n 默认文案；字符串 = 用户自定义（空串 = 不显示标语）。
 *  D-147 起改为单句存储；旧版（D-146 两段式 {left,right} JSON）读取时自动拼成一句迁移。 */
const SLOGAN_KEY = 'tm-slogan';
const readSlogan = (): Slogan | null => {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(SLOGAN_KEY) : null;
    if (!raw) return null;
    // D-226（2026-11-07）：标语统一限 30 字——读取时夹断旧记录（旧上限 80，可能超长）。
    if (raw.trim().startsWith('{')) {
      const v = JSON.parse(raw);
      if (v && typeof v.left === 'string' && typeof v.right === 'string') {
        const merged = [v.left.trim(), v.right.trim()].filter(Boolean).join(' ');
        return merged.slice(0, SLOGAN_MAX_LEN);
      }
      return null;
    }
    return raw.slice(0, SLOGAN_MAX_LEN);
  } catch {
    /* 坏数据 / 隐私模式 → 用默认标语 */
    return null;
  }
};
/** 到访照片每行张数（2026-11-04，D-116）：默认 3（= 改动前网格）；只存本机浏览器 */
const MEDIA_COLS_KEY = 'tm-media-cols';
const readMediaCols = (): MediaCols => {
  try {
    const n =
      typeof localStorage !== 'undefined' ? Number(localStorage.getItem(MEDIA_COLS_KEY)) : NaN;
    return isMediaCols(n) ? n : 3;
  } catch {
    return 3;
  }
};
/** 界面语言（2026-11-04，D-138）：简体中文 / English；默认中文，只存本机浏览器 */
const LANG_KEY = 'tm-lang';
const readLang = (): Lang => {
  try {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem(LANG_KEY) : null;
    return isLang(v) ? v : 'zh';
  } catch {
    return 'zh';
  }
};
/** 系统当前是否浅色（不支持 matchMedia 时按深色） */
const systemPrefersLight = (): boolean =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: light)').matches
    : false;

export default function App() {
  const [tk, setTk] = useState('');
  const [boot, setBoot] = useState<'loading' | 'ready' | 'error'>('loading');
  const [bootError, setBootError] = useState('');

  const [places, setPlaces] = useState<Place[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PlaceDetail | null>(null);

  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [saving, setSaving] = useState(false);

  const [lightbox, setLightbox] = useState<{ visitId: string; index: number } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 设置窗口打开时默认落在哪个分类（2026-11-07 D-224：点头像 / 名称 → 设置 · 账号） */
  const [settingsInitialTab, setSettingsInitialTab] = useState<TabId | undefined>(undefined);
  /** 点聚合靶盘后的「这一簇」列表快照（F-BRW-07）；与地点侧栏互斥 */
  const [cluster, setCluster] = useState<Cluster | null>(null);
  /** F-PLC-08：当前要合并掉的地点 */
  const [mergeFrom, setMergeFrom] = useState<PlaceDetail | null>(null);
  /** 地图打点模式 */
  const [pinMode, setPinMode] = useState(false);
  /** 顶栏搜索图标是否展开（D-130：点图标向左展开搜索框） */
  const [hudSearch, setHudSearch] = useState(false);
  /** 顶栏 6 键的滑动选中块（D-158）：位置/宽度由当前选中键实测，像 Segmented 一样滑动 */
  const [actionThumb, setActionThumb] = useState<{ x: number; w: number; visible: boolean }>({
    x: 0,
    w: 0,
    visible: false,
  });
  const [actionThumbReady, setActionThumbReady] = useState(false);
  /** 家（2026-11-04 改为普通地点）：最多一个 place.home=1；缓存一份用于顶栏「家」飞过去/迁移 */
  const [homePlace, setHomePlace] = useState<Place | null>(null);
  /** 顶栏「总览 / 家」点过之后也显示为选中（黑色）；打开其它面板时清掉（D-128） */
  const [topAction, setTopAction] = useState<'overview' | 'home' | null>(null);
  /** My旅迹（M5）：去过 + 想去合并成一个抽屉；tab 由 App 持有（时间轴步进会切到去过） */
  const [myTrailOpen, setMyTrailOpen] = useState(false);
  /** 从 My旅迹列表点进地点时，把列表「停在后台」：点侧栏「返回」可原样回到那一层列表 */
  const [myTrailParked, setMyTrailParked] = useState(false);
  /** 从 My旅迹「+ 添加一次到访」进入时，记下要自动展开新增到访表单的地点（D-109） */
  const [autoAddVisitFor, setAutoAddVisitFor] = useState<string | null>(null);
  const [myTrailTab, setMyTrailTab] = useState<MyTrailTab>('visited');
  const [trashCount, setTrashCount] = useState(0);
  /** 备份提醒（F-SYS-05）：启动时取一次；设置页关闭 / 恢复 / 导出后刷新 */
  const [backupStatus, setBackupStatus] = useState<BackupStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // 统计模式（F-STA / D-60）：主地图切省份点亮，右侧统计面板；默认全量、不跟随时间轴
  const [statsOpen, setStatsOpen] = useState(false);
  const [provinceStats, setProvinceStats] = useState<ProvinceLight[] | null>(null);
  // 照片墙（F-BRW-04/05）
  const [photoWall, setPhotoWall] = useState<{
    focus?: { mediaId?: string; placeId?: string } | null;
  } | null>(null);
  // 随行人员筛选（F-BRW-06）：多选，选中的任意一人一起去过即算（并集）
  const [companions, setCompanions] = useState<string[]>([]);
  // 秘密基地（F-PLC-11）：密码是否已配置 + 当前会话是否已解锁
  const [secretStatus, setSecretStatus] = useState<{ configured: boolean; places: number }>({
    configured: false,
    places: 0,
  });
  const [secretUnlocked, setSecretUnlocked] = useState(false);
  const [secretTarget, setSecretTarget] = useState<{ id: string; name: string } | null>(null);

  // 时间轴（F-BRW-03）
  const [range, setRange] = useState<RangeValue | null>(null);
  const [tlMeta, setTlMeta] = useState<{
    first: string;
    last: string;
    dates?: string[];
  } | null>(null);

  // 主题（F-SYS-02）：偏好 dark / light / system；system 时跟随系统外观
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [systemLight, setSystemLight] = useState<boolean>(systemPrefersLight);
  // 界面字体（2026-11-04，D-92）：常规字体可选，只存 localStorage
  const [font, setFont] = useState<AppFont>(readFont);
  // 界面字号（2026-11-05，D-142）：小 / 中 / 大三档，只改文字大小；只存 localStorage
  const [fontSize, setFontSize] = useState<FontSize>(readFontSize);
  // 界面字重（2026-11-06 用户要求）：常规 / 加粗，只改文字粗细；只存 localStorage
  const [fontWeight, setFontWeight] = useState<FontWeight>(readFontWeight);
  // 「家」地图图标配色（2026-11-05，D-161）：7 色可选，只存本机 localStorage
  const [homeColor, setHomeColor] = useState<HomeColor>(readHomeColor);
  // 去过 / 想去 / 秘密基地图标配色（2026-11-05，D-164）：同一套 7 色，null = 原色
  const [markerColors, setMarkerColors] = useState<MarkerColorPrefs>(readMarkerColors);
  // 应用主题标语（2026-11-05，D-146）：null = 默认文案；自定义只存 localStorage
  const [slogan, setSlogan] = useState<Slogan | null>(readSlogan);
  // 到访照片每行张数（2026-11-04，D-116）：2/3/4/5，默认 3；只存 localStorage
  const [mediaCols, setMediaCols] = useState<MediaCols>(readMediaCols);
  // 界面语言（2026-11-04，D-138）：简体中文 / English；只存 localStorage
  const [lang, setLang] = useState<Lang>(readLang);
  /**
   * 账号模式与当前用户（2026-11-06 M6 P2-1，D-200）：
   * null = 还没拿到；local = 单机无账号（默认，行为与以前完全一致）；
   * multi 且 user=null = 需要先登录，整页显示登录 / 邀请码注册页。
   */
  const [authMe, setAuthMe] = useState<AuthMe | null>(null);
  /** multi 模式已登录、但当前账号还没填自己的天地图 Key → 全屏「配置 Key」引导页（P2-4，D-205） */
  const [needTdtKey, setNeedTdtKey] = useState(false);
  // ── 中英文切换（2026-11-04，D-138）──
  // t / tp 给 App 自己用；i18n 通过 Context 给所有子组件（值变化即整棵树重渲染，切换立即生效）。
  // setCurrentLang 让纯模块（cluster.ts / tdt.ts / api.ts）里的 tr()/tp() 也同步当前语言。
  // <html lang> 在渲染阶段就写好（D-139）：英文模式有专门的顶栏排紧样式，
  // 若等 effect 再写，首帧会先按中文内边距渲染一次英文按钮、可能闪一下溢出。
  const t = useMemo(() => makeT(lang), [lang]);
  const tp = useMemo(() => makeTp(lang), [lang]);
  const i18n = useMemo(() => ({ lang, t, tp }), [lang, t, tp]);
  setCurrentLang(lang);
  document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';

  // D-158：顶栏 6 键当前选中的 index（0 总览 / 1 家 / 2 My旅迹 / 3 统计 / 4 照片墙 / 5 设置）
  const activeActionIndex =
    topAction === 'overview'
      ? 0
      : topAction === 'home'
        ? 1
        : myTrailOpen
          ? 2
          : statsOpen
            ? 3
            : photoWall
              ? 4
              : settingsOpen
                ? 5
                : -1;

  const mapApi = useRef<MapApi | null>(null);
  const geoTimer = useRef<number | null>(null);
  /** 顶栏搜索展开区（点外面收起，D-130） */
  const hudSearchRef = useRef<HTMLDivElement | null>(null);
  /** 顶栏 6 键容器 / 按钮 ref：用于测量滑动块的 left/width（D-158） */
  const actionsRef = useRef<HTMLDivElement | null>(null);
  const actionBtnRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const actionThumbReadyRef = useRef(false);

  // D-158：顶栏 6 键的滑动选中块（与 Segmented 同一套思路）——
  // 测量当前选中键的 offsetLeft / offsetWidth，写入滑块 transform / width；
  // 选中键本身用 scale(1.1, 1) 横向放大，所以滑块宽度乘 1.1 并按中心对齐。
  useLayoutEffect(() => {
    const wrap = actionsRef.current;
    if (!wrap) return;
    const measure = () => {
      if (activeActionIndex < 0) {
        setActionThumb((cur) => (cur.visible ? { ...cur, visible: false } : cur));
        return;
      }
      const el = actionBtnRefs.current[activeActionIndex];
      if (!el) return;
      const rawW = el.offsetWidth;
      const w = rawW * 1.1;
      const x = el.offsetLeft + rawW / 2 - w / 2;
      setActionThumb((cur) =>
        cur.x === x && cur.w === w && cur.visible ? cur : { x, w, visible: true }
      );
    };
    measure();
    if (activeActionIndex >= 0 && !actionThumbReadyRef.current) {
      actionThumbReadyRef.current = true;
      window.requestAnimationFrame(() => setActionThumbReady(true));
    }
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(wrap);
    actionBtnRefs.current.forEach((btn) => btn && ro?.observe(btn));
    window.addEventListener('resize', measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [activeActionIndex, boot]);

  const say = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 3200);
  }, []);

  /** D-161：切换家图标配色时先同步写 localStorage，保证同一次渲染里的 PlaceThumb 立刻读到新值 */
  const changeHomeColor = useCallback((c: HomeColor) => {
    try {
      localStorage.setItem(HOME_COLOR_KEY, c);
    } catch {
      /* 隐私模式忽略 */
    }
    setHomeColor(c);
  }, []);

  /** D-164：三种图标配色同样先同步写 localStorage，再更新 state（地图 / 列表 / 聚合一起生效） */
  const changeMarkerColors = useCallback((next: MarkerColorPrefs) => {
    saveMarkerColors(next);
    setMarkerColors(next);
  }, []);

  /** 只刷新回收站角标（F-SYS-07）；失败不影响主流程 */
  const refreshTrashCount = useCallback(async () => {
    try {
      setTrashCount((await api.trashCount()).total);
    } catch {
      /* 角标只是提示 */
    }
  }, []);

  /** 秘密基地密码状态（F-PLC-11）：是否已设置 + 秘密基地数量 */
  const refreshSecretStatus = useCallback(async () => {
    try {
      setSecretStatus(await api.secretStatus());
    } catch {
      /* 读不到状态按「未设置密码」处理 */
    }
  }, []);

  /** 备份提醒状态（F-SYS-05）：失败静默（顶栏不显示红点，不影响主流程） */
  const refreshBackupStatus = useCallback(async () => {
    try {
      setBackupStatus(await api.backupStatus());
    } catch {
      setBackupStatus(null);
    }
  }, []);

  // ── 主题：监听系统外观（仅「跟随系统」时会用到）──
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => setSystemLight(mq.matches);
    setSystemLight(mq.matches);
    if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onChange);
    else mq.addListener(onChange);
    return () => {
      if (typeof mq.removeEventListener === 'function') mq.removeEventListener('change', onChange);
      else mq.removeListener(onChange);
    };
  }, []);

  // ── 主题：把偏好解析成实际档位（4 档轴）并写 data-theme ──
  const effectiveTheme: ThemeLevel =
    theme === 'system' ? (systemLight ? 'light' : 'dark') : theme;
  useEffect(() => {
    document.documentElement.dataset.theme = effectiveTheme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* 隐私模式下可能写不进去，忽略 */
    }
  }, [theme, effectiveTheme]);

  // ── 字体：写 data-font 到 <html>，由 styles.css 的 --font-ui 生效 ──
  // 用 useLayoutEffect：默认字体是下载字体，首帧就带上 data-font，避免先按系统字体闪一下
  useLayoutEffect(() => {
    document.documentElement.dataset.font = font;
    try {
      localStorage.setItem(FONT_KEY, font);
    } catch {
      /* 隐私模式下可能写不进去，忽略 */
    }
  }, [font]);

  // ── 界面字号（2026-11-05，D-142）：写 html[data-fontsize]，由 styles.css 的 --fs-scale 生效 ──
  // 用 useLayoutEffect：首帧就用上存档档位，避免先按「中」渲染再跳成小/大
  useLayoutEffect(() => {
    document.documentElement.dataset.fontsize = fontSize;
    try {
      localStorage.setItem(FONT_SIZE_KEY, fontSize);
    } catch {
      /* 隐私模式下可能写不进去，忽略 */
    }
  }, [fontSize]);

  // ── 界面字重（2026-11-06 用户要求）：写 html[data-fontweight]，由 styles.css 的 --font-weight-ui 生效 ──
  useLayoutEffect(() => {
    document.documentElement.dataset.fontweight = fontWeight;
    try {
      localStorage.setItem(FONT_WEIGHT_KEY, fontWeight);
    } catch {
      /* 隐私模式下可能写不进去，忽略 */
    }
  }, [fontWeight]);

  // ── 省界数据预取（2026-11-06 国外打点限制用；约 40KB，一次就够）──
  useEffect(() => {
    void loadChinaBounds();
  }, []);

  // ── 家图标配色（2026-11-05，D-161）：只存本机 localStorage，和主题 / 字体一致 ──
  useEffect(() => {
    try {
      localStorage.setItem(HOME_COLOR_KEY, homeColor);
    } catch {
      /* 隐私模式下可能写不进去，忽略 */
    }
  }, [homeColor]);

  // ── 应用主题标语（2026-11-05，D-146）：写 localStorage；null = 恢复默认（删记录）──
  useEffect(() => {
    try {
      if (slogan === null) localStorage.removeItem(SLOGAN_KEY);
      else localStorage.setItem(SLOGAN_KEY, slogan);
    } catch {
      /* 隐私模式下可能写不进去，忽略 */
    }
  }, [slogan]);

  // ── 到访照片每行张数（2026-11-04，D-116）：写 --visit-cols，由 styles.css 的 .grid 使用 ──
  // 用 useLayoutEffect：首帧就用上存档值，避免先按 3 列画一帧再跳成别的列数
  useLayoutEffect(() => {
    document.documentElement.style.setProperty('--visit-cols', String(mediaCols));
    try {
      localStorage.setItem(MEDIA_COLS_KEY, String(mediaCols));
    } catch {
      /* 隐私模式下可能写不进去，忽略 */
    }
  }, [mediaCols]);

  // ── 界面语言（2026-11-04，D-138）：写标题 / localStorage ──
  // 组件文案由 I18nContext 驱动（切换即时生效）；纯模块用模块级 currentLang（下面渲染时同步）；
  // <html lang> 在渲染阶段已写好（见上方，D-139 为避免英文按钮首帧溢出闪动）。
  useEffect(() => {
    // 2026-11-06 D-181：项目正式命名 Tread Horizon，浏览器标签标题同步（品牌不翻译）
    document.title = 'Tread Horizon';
    try {
      localStorage.setItem(LANG_KEY, lang);
    } catch {
      /* 隐私模式下可能写不进去，忽略 */
    }
  }, [lang]);

  // ── 顶栏搜索（D-130）：展开后点外面自动收起 ──
  useEffect(() => {
    if (!hudSearch) return;
    const onDown = (e: MouseEvent) => {
      const el = hudSearchRef.current;
      if (el && !el.contains(e.target as Node)) setHudSearch(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [hudSearch]);

  // ── 启动 ──
  useEffect(() => {
    (async () => {
      try {
        // 先确认账号模式（M6 P2-1，D-200）：multi 且未登录 → 只渲染登录页，不加载业务数据；
        // local（默认）继续走原来的启动流程，行为完全不变。
        const me = await api.authMe();
        setAuthMe(me);
        if (me.mode === 'multi' && !me.user) return;
        const cfg = await api.config();
        if (!cfg.tdtTk) {
          // 没读到天地图 Key：multi（每账号一份）与 local（本机一份）都先显示全屏「配置天地图 Key」引导页，
          // 由用户在页面里填写（2026-11-07 D-238：local 模式不再抛「启动失败」，新用户无需先改 .env.local）。
          setNeedTdtKey(true);
          return;
        }
        setTk(cfg.tdtTk);
        const list = await api.places();
        let hp = list.find((p) => p.home === 1) ?? null;
        // 一次性迁移：M5.1 把家存成过 data/config.json.home（独立坐标）；现在家是普通地点。
        // 如果旧坐标还在、又没有 home 地点，就按那个坐标创建「家」地点（今天一次到访），
        // 之后清除旧坐标，避免下次启动重复创建。
        if (!hp && cfg.home) {
          try {
            const { address } = await api.reverse(cfg.home.lng, cfg.home.lat);
            const region = normalizeRegion(address);
            const created = await api.createPlace({
              name: '家',
              lng: cfg.home.lng,
              lat: cfg.home.lat,
              ...region,
              kind: 'visited',
              date: today(),
            });
            hp = await api.updatePlace(created.id, { home: 1 });
            list.push(hp);
            await api.clearHome();
          } catch {
            /* 迁移失败不阻塞启动；用户再点「家」重新打点即可 */
          }
        }
        setPlaces(list);
        setHomePlace(hp);
        const tl = await api.timeline();
        if (tl.first && tl.last) setTlMeta({ first: tl.first, last: tl.last, dates: tl.dates });
        void refreshTrashCount();
        void refreshSecretStatus();
        void refreshBackupStatus();
        setBoot('ready');
      } catch (e: any) {
        setBootError(e?.message || String(e));
        setBoot('error');
      }
    })();
  }, []);

  // ── 刷新地点列表（时间轴区间 + 随行筛选叠加时走区间接口）──
  const fetchSeq = useRef(0);
  const refreshPlaces = useCallback(async () => {
    const seq = ++fetchSeq.current;
    const companion = companions.length ? companions : null;
    const next = range
      ? await api.mapVisits(range.from, range.to, companion)
      : await api.places(companion);
    // 拖时间轴会连续发请求，只接受最后一次的结果，避免旧响应盖掉新结果
    if (seq === fetchSeq.current) setPlaces(next);
  }, [range, companions]);

  // 时间轴区间 / 随行人员变化 → 重新拉地图上的地点（F-BRW-03 + F-BRW-06）
  const lastFilter = useRef<string | null>(null);
  useEffect(() => {
    if (boot !== 'ready') return;
    const key = `${range?.from ?? ''}|${range?.to ?? ''}|${companions.join(',')}`;
    if (lastFilter.current === key) return;
    lastFilter.current = key;
    void refreshPlaces();
  }, [range, companions, boot, refreshPlaces]);

  /** 刷新「家」缓存（家 = 普通地点，顶栏按钮和地图需要知道哪个是家） */
  const refreshHomePlace = useCallback(async () => {
    try {
      const all = await api.places();
      setHomePlace(all.find((p) => p.home === 1) ?? null);
    } catch {
      /* 读不到保持原值，不阻塞主流程 */
    }
  }, []);

  /** 顶栏的几个列表面板互斥；打开地点侧栏 / 聚合点列表时也一起收起 */
  const closePanels = useCallback(() => {
    setMyTrailOpen(false);
    setSettingsOpen(false);
    setSettingsInitialTab(undefined);
    setCluster(null);
    setMergeFrom(null);
  }, []);

  /** 退出「添加足迹」：关面板 + 收起地图点选状态（光标恢复） */
  const exitAdd = useCallback(() => {
    setAdding(false);
    setPinMode(false);
    setDraft(null);
  }, []);

  /** 从地点详情返回 My旅迹列表（列表一直挂载在后台，展开 / 滚动位置不丢） */
  const returnToMyTrail = useCallback(() => {
    setDetail(null);
    setSelectedId(null);
    setMyTrailParked(false);
    setMyTrailOpen(true);
  }, []);

  /**
   * 打开一个地点的侧栏（统一入口）。
   * F-PLC-11：秘密基地在密码未配置时不设门禁；已配置且当前会话未解锁时先弹密码框。
   * fly=true 时同时把地图飞过去（照片墙 / 搜索用）。
   */
  const openPlaceById = useCallback(
    async (id: string, opts?: { fly?: boolean }) => {
      let p: PlaceDetail | null = null;
      try {
        p = await api.place(id);
      } catch {
        p = null;
      }
      if (!p) {
        say(tr('地点不存在或已删除'));
        return;
      }
      if (p.secret && secretStatus.configured && !secretUnlocked) {
        setSecretTarget({ id: p.id, name: p.name });
        return;
      }
      const fromMyTrail = myTrailOpen;
      closePanels();
      exitAdd();
      setPhotoWall(null);
      setStatsOpen(false);
      setSelectedId(p.id);
      setDetail(p);
      if (fromMyTrail) setMyTrailParked(true);
      if (opts?.fly) {
        mapApi.current?.flyTo(p.lng, p.lat, Math.max(13, Number(mapApi.current.getZoom()) || 13));
      }
    },
    [closePanels, exitAdd, myTrailOpen, secretStatus.configured, secretUnlocked, say]
  );

  const selectPlace = useCallback(
    (id: string) => {
      void openPlaceById(id);
    },
    [openPlaceById]
  );

  /** My旅迹「+ 添加一次到访」：打开该地点侧栏，并让侧栏自动展开新增到访表单（D-109） */
  const addVisitForPlace = useCallback(
    (p: Place) => {
      setAutoAddVisitFor(p.id);
      selectPlace(p.id);
    },
    [selectPlace]
  );

  /** 秘密基地密码验证通过：当前会话解锁，并继续打开刚才点的那条 */
  const onSecretUnlocked = useCallback(async () => {
    const target = secretTarget;
    setSecretTarget(null);
    setSecretUnlocked(true);
    if (!target) return;
    const fromMyTrail = myTrailOpen;
    try {
      const p = await api.place(target.id);
      closePanels();
      exitAdd();
      setStatsOpen(false);
      setSelectedId(p.id);
      setDetail(p);
      if (fromMyTrail) setMyTrailParked(true);
    } catch {
      say(tr('地点不存在或已删除'));
    }
  }, [secretTarget, closePanels, exitAdd, myTrailOpen, say]);

  // 搜索里点「我的足迹」→ 飞过去 + 开侧栏（秘密基地会先弹密码）
  const openPlaceOnMap = useCallback(
    (p: Place) => {
      mapApi.current?.flyTo(p.lng, p.lat, Math.max(12, Number(mapApi.current.getZoom()) || 12));
      selectPlace(p.id);
    },
    [selectPlace]
  );

  // ── 新增：地理编码补全（走服务端，服务端负责限流与缓存） ──
  const refreshAddr = useCallback((lng: number, lat: number) => {
    if (geoTimer.current) window.clearTimeout(geoTimer.current);
    geoTimer.current = window.setTimeout(async () => {
      try {
        const { address } = await api.reverse(lng, lat);
        if (!address) return;
        setDraft((d) => {
          if (!d) return d;
          // 已有名字就不覆盖：
          // 搜索带过来的「杭州」比逆地理返回的「杭州市人民政府」更有意义。
          // 只有名称为空时才用逆地理结果兜底。
          const hasName = d.nameTouched || d.name.trim().length > 0;
          return {
            ...d,
            addr: address,
            name: hasName ? d.name : address.poi || address.formatted || '',
          };
        });
      } catch {
        /* 逆地理失败不阻塞流程 */
      }
    }, 400);
  }, []);

  /**
   * 添加足迹（2026-11-04 合并打点，D-93）：点一下 = 打开右侧搜索面板 +
   * 地图进入点选状态（光标换成飞镖）。既可以搜地名定位，也可以直接在地图上点；
   * 再点一次按钮 / Esc / 面板取消 = 退出。
   */
  const openAdd = useCallback(() => {
    if (adding || pinMode) {
      exitAdd();
      return;
    }
    closePanels();
    setStatsOpen(false);
    setPhotoWall(null);
    setAdding(true);
    setPinMode(true);
    setDraft(null);
    setSelectedId(null);
    setDetail(null);
    // 预取省界数据（约 40KB）：第一次在地图上打点时立刻能判断「国内 / 国外」
    void loadChinaBounds();
  }, [adding, pinMode, closePanels, exitAdd]);

  /**
   * 补全「未标注」地区（2026-11-04）：找出没有省/市（或 city 为空）的活地点，
   * 按保存的坐标重新逆地理 → 归一化（直辖市/兵团城市用区县兜底 city）→ PATCH 回地点。
   * 用于修复历史上「保存时逆地理还没回来」留下的空省市区。
   */
  const fillMissingRegions = useCallback(async () => {
    try {
      const all = await api.places();
      const targets = all.filter((p) => !p.province || !p.city);
      if (!targets.length) {
        say(tr('没有需要补全地区的地点'));
        return;
      }
      let ok = 0;
      let failed = 0;
      for (const p of targets) {
        try {
          const { address } = await api.reverse(p.lng, p.lat);
          const region = normalizeRegion(address);
          if (!region.province) {
            failed++;
            continue;
          }
          await api.updatePlace(p.id, { ...region });
          ok++;
        } catch {
          failed++;
        }
      }
      await refreshPlaces();
      const tl = await api.timeline();
      if (tl.first && tl.last) setTlMeta({ first: tl.first, last: tl.last, dates: tl.dates });
      say(
        failed
          ? tr('已补全 {ok} 个地点，{failed} 个识别失败（可稍后再试）', { ok, failed })
          : tr('已补全 {ok} 个地点的省 / 市 / 区', { ok })
      );
    } catch (e: any) {
      say(tr('补全地区失败：{msg}', { msg: e?.message || e }));
    }
  }, [refreshPlaces, say]);

  // ── 地图点选（F-PLC-09，2026-11-04 并入「+ 添加足迹」）──
  const startPinDraft = useCallback(
    async (lng: number, lat: number) => {
      const z = Number(mapApi.current?.getZoom() || 0);
      // D-156：打点门槛由 z≥10（街区级）放宽到 z≥8（城市级）；
      // 2026-11-06 用户再放宽到 z≥6（能看到省 / 地级范围即可打点）
      if (!Number.isFinite(z) || z < 6) {
        say(tr('请先放大（缩放 ≥ 6）再点选位置'));
        return;
      }
      // 2026-11-06 用户要求：暂不支持国外到访记录（天地图全球数据太粗、搜索/逆地理只覆盖国内）
      await loadChinaBounds();
      if (!isInsideChina(lng, lat)) {
        say(tr('暂不支持国外到访记录'));
        return;
      }
      setSelectedId(null);
      setDetail(null);
      setCluster(null);
      setMergeFrom(null);
      setAdding(true);
      setDraft({
        lng,
        lat,
        name: '',
        addr: null,
        date: today(),
        kind: 'visited',
        nameTouched: false,
      });
      refreshAddr(lng, lat);
    },
    [refreshAddr, say]
  );

  // 「添加足迹」点选状态下按 Esc 退出：
  // 用 capture 阶段监听，避免被搜索框、别的浮层或地图组件的 Esc 处理器吞掉。
  // （2026-11-04 D-93：打点并入添加足迹，Esc 直接退出整个添加流程）
  useEffect(() => {
    if (!pinMode && !adding) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' && e.key !== 'Esc') return;
      e.preventDefault();
      e.stopPropagation();
      exitAdd();
      say(tr('已退出添加足迹'));
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [pinMode, adding, exitAdd, say]);

  /**
   * 顶栏「家」（2026-11-04 用户再调整）：只负责**飞到家的坐标**；
   * 家本身是普通地点，在侧栏「编辑」里用「设为家 / 取消家」按钮设置（全库唯一）。
   */
  const goHome = useCallback(() => {
    if (!homePlace) {
      say(tr('还没有设置家：打开一个地点 → 编辑 → 设为家'));
      return;
    }
    closePanels();
    exitAdd();
    mapApi.current?.flyTo(homePlace.lng, homePlace.lat, 13);
    say(tr('已飞到家的位置：{name}', { name: homePlace.name }));
  }, [homePlace, closePanels, exitAdd, say]);

  const pickPoi = useCallback(
    async (poi: Poi) => {
      const [lngS, latS] = String(poi.lnglat).split(',');
      const lng = Number(lngS);
      const lat = Number(latS);
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
      // 2026-11-06 用户要求：搜索/添加足迹时也拦国外坐标（天地图搜索偶尔会给到境外 POI）
      await loadChinaBounds();
      if (!isInsideChina(lng, lat)) {
        say(tr('暂不支持国外到访记录'));
        return;
      }
      setDraft({
        lng,
        lat,
        name: poi.name,
        addr: { formatted: poi.address, poi: poi.name },
        date: today(),
        kind: 'visited',
        nameTouched: false,
      });
      mapApi.current?.flyTo(lng, lat, 12);
      refreshAddr(lng, lat);
    },
    [refreshAddr, say]
  );

  // 顶栏搜索里点「添加为足迹」
  const addFromPoi = useCallback(
    (poi: Poi) => {
      setAdding(true);
      setDetail(null);
      setSelectedId(null);
      setStatsOpen(false);
      setPhotoWall(null);
      pickPoi(poi);
    },
    [pickPoi]
  );

  const onDraftMoved = useCallback(
    async (lng: number, lat: number) => {
      // 2026-11-06 用户要求：拖到国外 → 提示并保持上一个国内位置（不更新 draft 坐标）
      await loadChinaBounds();
      if (!isInsideChina(lng, lat)) {
        say(tr('暂不支持国外到访记录'));
        // 触发一次重渲染：MapView 会按 draft 里的旧坐标把草稿飞镖摆回去
        setDraft((d) => (d ? { ...d } : d));
        return;
      }
      setDraft((d) => (d ? { ...d, lng, lat } : d));
      refreshAddr(lng, lat);
    },
    [refreshAddr, say]
  );

  const saveDraft = useCallback(async () => {
    if (!draft || saving) return;
    // 2026-11-06 用户要求：国外坐标不落库（点击 / 拖拽已有拦截，这里再兜底一次）
    await loadChinaBounds();
    if (!isInsideChina(draft.lng, draft.lat)) {
      say(tr('暂不支持国外到访记录'));
      return;
    }
    setSaving(true);
    try {
      // 2026-11-04：保存前兜底补全省/市/区。添加面板里的逆地理是 400ms 防抖异步的，
      // 用户很快点保存时 addr 可能还没回来 → 会留下「未标注」地点；这里缺省时再同步取一次。
      let addr = draft.addr;
      if (!addr?.province || !addr?.city) {
        try {
          const r = await api.reverse(draft.lng, draft.lat);
          if (r.address) addr = r.address;
        } catch {
          /* 逆地理失败也不阻塞保存，坐标仍然是准的 */
        }
      }
      const region = normalizeRegion(addr);
      const p = await api.createPlace({
        name: draft.name.trim() || tr('未命名地点'),
        lng: draft.lng,
        lat: draft.lat,
        ...region,
        kind: draft.kind,
        date: draft.date,
      });
      await refreshPlaces();
      const tl = await api.timeline();
      if (tl.first && tl.last) setTlMeta({ first: tl.first, last: tl.last, dates: tl.dates });
      setAdding(false);
      setPinMode(false);
      setDraft(null);
      setSelectedId(p.id);
      setDetail(p);
      say(tr('已保存 · 侧栏里可以拖入照片'));
    } catch (e: any) {
      say(tr('保存失败：{msg}', { msg: e?.message || e }));
    } finally {
      setSaving(false);
    }
  }, [draft, saving, refreshPlaces, say]);

  // ── 上传队列（F-MED-10）：串行上传、逐文件进度、取消、失败重试 ──
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const uploadsRef = useRef<UploadItem[]>([]);
  const uploadingRef = useRef(false);
  const abortRef = useRef<null | (() => void)>(null);
  const uploadRefreshTimer = useRef<number | null>(null);

  const commitUploads = useCallback((next: UploadItem[]) => {
    uploadsRef.current = next;
    setUploads(next);
  }, []);

  const patchUpload = useCallback(
    (key: string, patch: Partial<UploadItem>) => {
      commitUploads(uploadsRef.current.map((x) => (x.key === key ? { ...x, ...patch } : x)));
    },
    [commitUploads]
  );

  /** 上传成功几个后统一刷新一次侧栏/地图（防抖，避免每个文件都打接口） */
  const refreshAfterUpload = useCallback(() => {
    if (uploadRefreshTimer.current) window.clearTimeout(uploadRefreshTimer.current);
    uploadRefreshTimer.current = window.setTimeout(async () => {
      await refreshPlaces();
      void refreshTrashCount();
      if (detail) {
        try {
          setDetail(await api.place(detail.id));
        } catch {
          /* 地点可能已被删 */
        }
      }
    }, 260);
  }, [detail, refreshPlaces, refreshTrashCount]);

  const processUploadQueue = useCallback(async () => {
    if (uploadingRef.current) return;
    uploadingRef.current = true;
    setBusy(tr('正在上传…'));
    try {
      for (;;) {
        const next = uploadsRef.current.find((x) => x.status === 'queued');
        if (!next) break;
        patchUpload(next.key, { status: 'uploading', progress: 0, error: undefined });
        try {
          const r = await api.uploadOne(
            next.visitId,
            next.file,
            (p) => patchUpload(next.key, { progress: p }),
            (abort) => {
              abortRef.current = abort;
            }
          );
          if (r.added.length) {
            patchUpload(next.key, { status: 'done', progress: 1, mediaId: r.added[0]?.id });
            refreshAfterUpload();
          } else if (r.skipped.length) {
            patchUpload(next.key, {
              status: 'skipped',
              progress: 1,
              error: tr('已存在（同内容），跳过'),
            });
          } else {
            patchUpload(next.key, { status: 'error', error: r.errors?.[0] || tr('上传失败') });
          }
        } catch (e: any) {
          if (e?.aborted) patchUpload(next.key, { status: 'canceled', error: tr('已取消') });
          else patchUpload(next.key, { status: 'error', error: e?.message || String(e) });
        } finally {
          abortRef.current = null;
        }
      }
    } finally {
      uploadingRef.current = false;
      setBusy(null);
      const items = uploadsRef.current;
      const done = items.filter((x) => x.status === 'done').length;
      const skipped = items.filter((x) => x.status === 'skipped').length;
      const errored = items.filter((x) => x.status === 'error').length;
      if (items.length) {
        const parts = [tr('成功 {n}', { n: done })];
        if (skipped) parts.push(tr('跳过 {n}', { n: skipped }));
        if (errored) parts.push(tr('失败 {n}', { n: errored }));
        say(tr('上传结束：') + parts.join(' · '));
      }
      refreshAfterUpload();
    }
  }, [patchUpload, refreshAfterUpload, say]);

  const enqueueUploads = useCallback(
    (visitId: string, files: File[]) => {
      if (!files.length) return;
      const items: UploadItem[] = files.map((file) => ({
        key: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        file,
        visitId,
        status: 'queued',
        progress: 0,
      }));
      commitUploads([...uploadsRef.current, ...items]);
      void processUploadQueue();
    },
    [commitUploads, processUploadQueue]
  );

  const cancelUpload = useCallback(
    (key: string) => {
      const item = uploadsRef.current.find((x) => x.key === key);
      if (!item) return;
      if (item.status === 'queued') patchUpload(key, { status: 'canceled', error: tr('已取消') });
      else if (item.status === 'uploading') abortRef.current?.();
    },
    [patchUpload]
  );

  const cancelAllUploads = useCallback(() => {
    for (const item of uploadsRef.current) {
      if (item.status === 'queued') patchUpload(item.key, { status: 'canceled', error: tr('已取消') });
    }
    abortRef.current?.();
  }, [patchUpload]);

  const retryUpload = useCallback(
    (key: string) => {
      patchUpload(key, { status: 'queued', progress: 0, error: undefined });
      void processUploadQueue();
    },
    [patchUpload, processUploadQueue]
  );

  const clearFinishedUploads = useCallback(() => {
    commitUploads(
      uploadsRef.current.filter((x) => x.status === 'queued' || x.status === 'uploading')
    );
  }, [commitUploads]);

  /** 关闭上传队列卡片：取消未完成项并清空列表 */
  const closeUploadQueue = useCallback(() => {
    for (const item of uploadsRef.current) {
      if (item.status === 'queued') patchUpload(item.key, { status: 'canceled', error: tr('已取消') });
    }
    abortRef.current?.();
    commitUploads([]);
  }, [commitUploads, patchUpload]);

  const backToChina = () => mapApi.current?.flyTo(104.0, 35.0, 4);

  // ── 统计模式（F-STA / D-60）──
  const enterStats = useCallback(async () => {
    closePanels();
    setAdding(false);
    setDraft(null);
    setSelectedId(null);
    setDetail(null);
    setCluster(null);
    setPinMode(false);
    setMyTrailParked(false);
    setPhotoWall(null);
    setLightbox(null);
    setStatsOpen(true);
    try {
      const d = await api.statsProvinces();
      setProvinceStats(d.provinces);
    } catch {
      // 省份点亮数据失败不阻塞统计数字；地图层会降级为灰色省界
      setProvinceStats(null);
    }
  }, [closePanels]);

  // ── 照片墙（F-BRW-04 / F-BRW-05）──
  const openPhotoWall = useCallback(
    (focus?: { mediaId?: string; placeId?: string } | null) => {
      closePanels();
      exitAdd();
      setStatsOpen(false);
      setLightbox(null);
      setPhotoWall({ focus: focus ?? null });
    },
    [closePanels, exitAdd]
  );

  // ── 备份提醒（F-SYS-05）：due 时顶栏「设置」按钮加红点 ──
  const backupDue = backupStatus?.due === true;
  const backupDueText = !backupStatus
    ? ''
    : backupStatus.reason === 'never'
      ? t('从未备份过（当前 {n} 个地点）', { n: backupStatus.dataCounts.places })
      : t('距离上次备份已 {days} 天（提醒阈值 {threshold} 天）', {
          days: backupStatus.daysSinceBackup ?? 0,
          threshold: backupStatus.thresholdDays,
        });

  const lightboxVisit = detail?.visits.find((v) => v.id === lightbox?.visitId);
  const lightboxItems = lightboxVisit?.media ?? [];
  /** 右侧抽屉（My旅迹 / 统计 / 地点 / 添加足迹 / 聚合簇 / 合并）打开时，抽屉下移让开顶部大按钮组（D-125） */
  const topbarPanelOpen = Boolean(
    adding || detail || mergeFrom || cluster || statsOpen || myTrailOpen
  );

  /** 顶栏右上角用户信息（2026-11-07 D-224）：只有 multi 模式已登录才有；local 模式不显示 */
  const topbarUser = authMe?.mode === 'multi' ? authMe.user : null;

  /** 点头像 / 名称都打开 设置 → 账号（D-224：头像上传移到设置里，顶栏只负责展示） */
  const openAccountSettings = () => {
    setTopAction(null);
    closePanels();
    exitAdd();
    setSettingsInitialTab('account');
    setSettingsOpen(true);
    void refreshBackupStatus();
    void refreshTrashCount();
  };

  // 多用户模式且未登录：整页显示登录 / 邀请码注册页（本地模式不会走到这里）
  if (authMe?.mode === 'multi' && !authMe.user) {
    return (
      <I18nContext.Provider value={i18n}>
        <LoginPage onLoggedIn={() => window.location.reload()} />
      </I18nContext.Provider>
    );
  }

  // 还没配置天地图 Key：multi（当前账号）与 local（本机）都先显示配置引导页（P2-4 D-205；local D-238）
  if (needTdtKey) {
    return (
      <I18nContext.Provider value={i18n}>
        <KeySetupPage
          mode={authMe?.mode === 'multi' ? 'multi' : 'local'}
          onDone={() => window.location.reload()}
        />
      </I18nContext.Provider>
    );
  }

  return (
    <I18nContext.Provider value={i18n}>
      <div className={topbarPanelOpen ? 'app app-panel-open' : 'app'}>
      {boot === 'ready' && (
        <MapView
          tk={tk}
          places={places}
          selectedId={selectedId}
          draft={draft}
          apiRef={mapApi}
          onPick={selectPlace}
          onDraftMoved={onDraftMoved}
          onCluster={(c) => {
            // F-BRW-07：靶盘列表与地点侧栏互斥；内容用点击这一刻的成员快照
            setSelectedId(null);
            setDetail(null);
            setMyTrailParked(false);
            closePanels();
            setCluster(c);
          }}
          onBlank={() => setCluster(null)}
          pinMode={pinMode && !draft}
          onMapClick={startPinDraft}
          statsMode={statsOpen}
          provinceStats={provinceStats}
          homeColor={homeColor}
          markerColors={markerColors}
          onStatus={(s) => {
            if (!s.ready && s.error) {
              setBoot('error');
              setBootError(s.error);
            }
          }}
        />
      )}

      <header className="topbar">
        {/* 2026-11-06 D-181（用户指定）：项目正式命名 Tread Horizon，左上角放纯文字 logo：
            第一行品牌名、第二行「脚步丈量世界」释义（中英文界面各有词条）。
            绝对定位不参与顶栏 flex；字体跟随设置里的界面字体（--font-ui）；4 档主题用文字色 token。
            D-190（用户指定）：两行要一样宽——第二行按字符 / 单词拆成多个 span，
            用 flex space-between 均分，自动对齐第一行的宽度（换字体 / 字号也不用重调字距）。 */}
        <div
          className="brand-logo"
          aria-label={`Tread Horizon · ${t('脚步丈量世界')}`}
        >
          <span className="brand-logo-name" aria-hidden="true">
            Tread Horizon
          </span>
          <span className="brand-logo-sub" aria-hidden="true">
            {(() => {
              const sub = t('脚步丈量世界');
              const parts = /\s/.test(sub) ? sub.split(/\s+/) : Array.from(sub);
              return parts.map((part, i) => <span key={i}>{part}</span>);
            })()}
          </span>
        </div>
        {/* 2026-11-04 D-131 / D-133：左上角不再放「旅行地图」，标语居右对齐大按钮组。
            2026-11-05 D-145（用户指定）：文案按用户原话改为「世界辣 ~ ~ ~ 么大」+
            「我想 · · · 总得去看一看吧 ! ! !」（保留用户打的空格与三个叹号，去掉中间逗号）。
            2026-11-05 D-146：可在 设置 → 通用 → 主题 里自定义两段文字（只存本机）；
            slogan 为 null 时用上面这组 i18n 默认文案；自定义两段都留空则整条标语不显示。 */}
        {(slogan === null || slogan.trim() !== '') && (
          <div className="hud-slogan">
            {slogan !== null ? (
              <span>{slogan}</span>
            ) : (
              <>
                <span>{t('世界辣 ~ ~ ~ 么大')}</span>
                <span>{t('我想 · · · 总得去看一看吧 ! ! !')}</span>
              </>
            )}
          </div>
        )}

        {boot === 'ready' && (
          <div className="hud">
            {/* 左侧：搜索图标（点开向左展开搜索）+ 独立的「+ 添加足迹」按钮（和大按钮组反色，D-130） */}
            <div className="hud-tools">
              <div className="hud-search" ref={hudSearchRef}>
                <button
                  type="button"
                  className={hudSearch ? 'hud-icon on' : 'hud-icon'}
                  onClick={() => setHudSearch((v) => !v)}
                  title={hudSearch ? t('收起搜索') : t('搜索地址 / 足迹')}
                  aria-expanded={hudSearch}
                >
                  <svg
                    viewBox="0 0 16 16"
                    width="15"
                    height="15"
                    aria-hidden="true"
                    focusable="false"
                  >
                    <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                      <circle cx="7.2" cy="7.2" r="4.4" />
                      <path d="M10.6 10.6 14 14" />
                    </g>
                  </svg>
                </button>
                {hudSearch && (
                  <div className="hud-search-panel">
                    <SearchBox
                      autoFocus
                      onPickPlace={openPlaceOnMap}
                      onFlyTo={(lng, lat, zoom) => mapApi.current?.flyTo(lng, lat, zoom ?? 13)}
                      onAddPoi={addFromPoi}
                      onClose={() => setHudSearch(false)}
                    />
                  </div>
                )}
              </div>
              <div className="hud-add-wrap">
                <button
                  type="button"
                  className={pinMode ? 'hud-add on' : 'hud-add'}
                  onClick={() => {
                    setHudSearch(false);
                    openAdd();
                  }}
                  title={
                    pinMode
                      ? t('退出添加足迹（Esc）')
                      : t('添加足迹（搜地名定位，或直接在地图上点选）')
                  }
                  aria-pressed={pinMode}
                >
                  {t('+ 添加足迹')}
                </button>

                {/* 2026-11-07 D-224（用户指定，修订）：头像 + 名称放在「+ 添加足迹」上方、
                    与主题标语同一水平线、左缘与「+ 添加足迹」对齐；没传过头像时默认用
                    「去过」标记（透明底）；点头像 / 名称都打开 设置 → 账号。 */}
                {topbarUser && (
                  <div className="hud-user">
                    <div className="hud-avatar-wrap">
                      <button
                        type="button"
                        className="hud-avatar"
                        onClick={openAccountSettings}
                        aria-label={t('更换头像')}
                      >
                        {topbarUser.avatarUpdatedAt ? (
                          <img
                            className="hud-avatar-photo"
                            src={api.avatarUrl(topbarUser.avatarUpdatedAt)}
                            alt={t('用户头像')}
                          />
                        ) : (
                          <img
                            className="hud-avatar-marker"
                            src={markerSrc('visited', markerColors)}
                            alt=""
                            aria-hidden="true"
                          />
                        )}
                      </button>
                      <span className="hud-avatar-tip" role="tooltip">
                        {t('更换头像')}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="hud-username"
                      title={t('打开设置 · 账号')}
                      onClick={openAccountSettings}
                    >
                      {topbarUser.displayName || topbarUser.username}
                    </button>
                  </div>
                )}
              </div>
            </div>

            <div className="actions" ref={actionsRef}>
          <span
            className={actionThumbReady ? 'actions-thumb ready' : 'actions-thumb'}
            aria-hidden="true"
            style={{
              width: actionThumb.w,
              transform: `translate(${actionThumb.x}px, -50%)`,
              opacity: actionThumb.visible ? 1 : 0,
            }}
          />
          <button
            ref={(el) => {
              actionBtnRefs.current[0] = el;
            }}
            className={topAction === 'overview' ? 'ghost on' : 'ghost'}
            onClick={() => {
              // 保证同一时间只有一个键是「选中的黑色」：先收起其它面板再选总览（D-128 修正）
              closePanels();
              setStatsOpen(false);
              exitAdd();
              setTopAction('overview');
              backToChina();
            }}
            title={t('总览（回到全国视野）')}
            aria-pressed={topAction === 'overview'}
          >
            {t('总览')}
          </button>
          <button
            ref={(el) => {
              actionBtnRefs.current[1] = el;
            }}
            className={
              (homePlace ? 'ghost home-btn' : 'ghost home-btn empty') +
              (topAction === 'home' ? ' on' : '')
            }
            onClick={() => {
              closePanels();
              setStatsOpen(false);
              exitAdd();
              setTopAction(homePlace ? 'home' : null);
              goHome();
            }}
            title={
              homePlace
                ? t('飞到家的位置：{name}', { name: homePlace.name })
                : t('还没有设置家（打开一个地点 → 编辑 → 设为家）')
            }
            aria-pressed={topAction === 'home'}
          >
            <img src={homeMarkerSrc(homeColor)} alt="" />
            {t('家')}
          </button>
          <button
            ref={(el) => {
              actionBtnRefs.current[2] = el;
            }}
            className={myTrailOpen ? 'ghost on' : 'ghost'}
            onClick={() => {
              setTopAction(null);
              setStatsOpen(false);
              setPhotoWall(null);
              closePanels();
              exitAdd();
              setDetail(null);
              setSelectedId(null);
              setMyTrailTab('visited');
              setMyTrailParked(false);
              setMyTrailOpen(true);
            }}
            title={t('My旅迹（去过 / 想去）')}
            aria-pressed={myTrailOpen}
          >
            {t('My旅迹')}
          </button>
          <button
            ref={(el) => {
              actionBtnRefs.current[3] = el;
            }}
            className={statsOpen ? 'ghost stats-btn on' : 'ghost stats-btn'}
            onClick={() => {
              setTopAction(null);
              if (statsOpen) setStatsOpen(false);
              else void enterStats();
            }}
            title={t('统计模式（省份点亮 / 年份 / 排行）')}
            aria-pressed={statsOpen}
          >
            {t('统计')}
          </button>
          <button
            ref={(el) => {
              actionBtnRefs.current[4] = el;
            }}
            className={photoWall ? 'ghost on' : 'ghost'}
            onClick={() => {
              setTopAction(null);
              openPhotoWall();
            }}
            title={t('照片墙（全部照片按时间铺开）')}
            aria-pressed={Boolean(photoWall)}
          >
            {t('照片墙')}
          </button>
          <button
            ref={(el) => {
              actionBtnRefs.current[5] = el;
            }}
            className={settingsOpen ? 'ghost settings-btn on' : 'ghost settings-btn'}
            onClick={() => {
              setTopAction(null);
              closePanels();
              exitAdd();
              setSettingsInitialTab(undefined);
              setSettingsOpen(true);
              void refreshBackupStatus();
              void refreshTrashCount();
            }}
            title={backupDue ? t('设置 · 该备份了：{text}', { text: backupDueText }) : t('设置')}
            aria-pressed={settingsOpen}
          >
            {t('设置')}
            {backupDue && (
              <span
                className="backup-dot"
                title={t('该备份了：{text}', { text: backupDueText })}
                aria-label={t('该备份了：{text}', { text: backupDueText })}
              />
            )}
          </button>
            </div>
          </div>
        )}
      </header>

      {boot === 'ready' && places.length === 0 && !adding && !range && !statsOpen && (
        // 空地图引导（2026-11-07 P2 验收反馈）：只保留一个按钮，
        // 不再有「你还没有留下任何足迹」小字、也不再有长方形底色。
        <div className="map-empty">
          <button className="primary" onClick={openAdd}>
            {t('添加第一个地方')}
          </button>
        </div>
      )}

      {adding && (
        <AddPanel
          draft={draft}
          saving={saving}
          onSearch={async (q) => {
            const r = await api.search(q);
            return r.results ?? [];
          }}
          onPick={pickPoi}
          onChange={(patch) => setDraft((d) => (d ? { ...d, ...patch } : d))}
          onSave={saveDraft}
          onCancel={exitAdd}
        />
      )}

      {detail && !adding && !mergeFrom && (
        <Sidebar
          detail={detail}
          onClose={() => {
            setDetail(null);
            setSelectedId(null);
            setAutoAddVisitFor(null);
            // 从 My旅迹列表点进来的：关掉详情 = 回到列表层，而不是回到光秃秃的地图
            if (myTrailParked) setMyTrailOpen(true);
            setMyTrailParked(false);
          }}
          onBackToList={myTrailParked ? returnToMyTrail : undefined}
          autoAddVisit={autoAddVisitFor === detail.id}
          onAutoAddVisitHandled={() => setAutoAddVisitFor(null)}
          uploads={uploads}
          onPickFiles={enqueueUploads}
          onCancelUpload={cancelUpload}
          onCancelAllUploads={cancelAllUploads}
          onRetryUpload={retryUpload}
          onClearFinishedUploads={clearFinishedUploads}
          onCloseUploadQueue={closeUploadQueue}
          onOpenLightbox={(visitId, index) => setLightbox({ visitId, index })}
          onTrashed={() => say(tr('已移到回收站 · 可在顶栏恢复'))}
          secretConfigured={secretStatus.configured}
          homeDistanceKm={
            detail.home === 1 || !homePlace
              ? null
              : haversineKm(homePlace.lng, homePlace.lat, detail.lng, detail.lat)
          }
          mediaCols={mediaCols}
          onMediaColsChange={setMediaCols}
          onMerge={(p) => {
            setMergeFrom(p);
          }}
          onChanged={async () => {
            await refreshPlaces();
            if (detail) setDetail(await api.place(detail.id));
            const tl = await api.timeline();
            if (tl.first && tl.last) setTlMeta({ first: tl.first, last: tl.last, dates: tl.dates });
            void refreshTrashCount();
            void refreshSecretStatus();
            void refreshHomePlace();
          }}
          onDeleted={async () => {
            setDetail(null);
            setSelectedId(null);
            // 从 My旅迹列表点进来再删除：删完回到列表层（列表会随 refreshPlaces 更新）
            if (myTrailParked) {
              setMyTrailOpen(true);
              setMyTrailParked(false);
            }
            await refreshPlaces();
            const tl = await api.timeline();
            setTlMeta(tl.first && tl.last ? { first: tl.first, last: tl.last, dates: tl.dates } : null);
            void refreshTrashCount();
            void refreshHomePlace();
            say(tr('已删除 · 可在顶栏「回收站」恢复'));
          }}
        />
      )}

      {mergeFrom && (
        <MergePanel
          from={mergeFrom}
          onClose={() => setMergeFrom(null)}
          onMerged={async (p) => {
            setMergeFrom(null);
            setSelectedId(p.id);
            setDetail(p);
            await refreshPlaces();
            const tl = await api.timeline();
            setTlMeta(tl.first && tl.last ? { first: tl.first, last: tl.last, dates: tl.dates } : null);
            void refreshTrashCount();
            void refreshHomePlace();
            say(tr('已合并 · 到访和照片都迁到目标地点了'));
          }}
        />
      )}

      {cluster && (
        <ClusterPanel
          cluster={cluster}
          onClose={() => setCluster(null)}
          onPick={(p) => {
            setCluster(null);
            mapApi.current?.flyTo(p.lng, p.lat, Math.max(13, Number(mapApi.current.getZoom()) || 13));
            selectPlace(p.id);
          }}
        />
      )}

      {(myTrailOpen || myTrailParked) && (
        <MyTrailPanel
          places={places}
          range={range}
          tab={myTrailTab}
          /* 从列表点进地点时列表不卸载，只「停在后台」→ 返回时展开 / 滚动位置原样保留 */
          parked={!myTrailOpen}
          onTabChange={setMyTrailTab}
          onClose={() => {
            setMyTrailOpen(false);
            setMyTrailParked(false);
          }}
          onPick={(p) => {
            setMyTrailOpen(false);
            setMyTrailParked(true);
            mapApi.current?.flyTo(p.lng, p.lat, 13);
            selectPlace(p.id);
          }}
          onAddVisit={addVisitForPlace}
          onRefresh={refreshPlaces}
          onFillRegions={fillMissingRegions}
          onClearRange={() => setRange(null)}
          onChanged={async () => {
            await refreshPlaces();
            if (detail) setDetail(await api.place(detail.id));
            const tl = await api.timeline();
            setTlMeta(tl.first && tl.last ? { first: tl.first, last: tl.last, dates: tl.dates } : null);
            void refreshTrashCount();
            void refreshHomePlace();
          }}
        />
      )}

      {settingsOpen && (
        <SettingsModal
          initialTab={settingsInitialTab}
          onClose={() => {
            setSettingsOpen(false);
            setSettingsInitialTab(undefined);
            void refreshBackupStatus();
            void refreshTrashCount();
          }}
          onChanged={async () => {
            await refreshPlaces();
            if (detail) setDetail(await api.place(detail.id));
            const tl = await api.timeline();
            setTlMeta(tl.first && tl.last ? { first: tl.first, last: tl.last, dates: tl.dates } : null);
            void refreshSecretStatus();
            await refreshTrashCount();
            void refreshHomePlace();
          }}
          onRestored={async () => {
            // 恢复是整库替换：先清掉当前侧栏 / 详情 / 轻量浮层，再全量刷新
            setSelectedId(null);
            setDetail(null);
            setLightbox(null);
            setCluster(null);
            setMergeFrom(null);
            setAdding(false);
            setDraft(null);
            setPhotoWall(null);
            setStatsOpen(false);
            setSecretUnlocked(false);
            try {
              await refreshPlaces();
              const tl = await api.timeline();
              setTlMeta(
                tl.first && tl.last ? { first: tl.first, last: tl.last, dates: tl.dates } : null
              );
              // 家（普通地点）也随备份恢复 → 刷新缓存
              await refreshHomePlace();
            } catch (e: any) {
              say(tr('已从备份恢复，但刷新地图失败：{msg}', { msg: e?.message || e }));
            }
            void refreshTrashCount();
            void refreshSecretStatus();
            void refreshBackupStatus();
            say(tr('已从备份恢复 · 地图和清单已刷新'));
          }}
          onBackupStatus={setBackupStatus}
          trashCount={trashCount}
          theme={theme}
          effectiveTheme={effectiveTheme}
          onTheme={setTheme}
          font={font}
          onFont={setFont}
          fontSize={fontSize}
          onFontSize={setFontSize}
          fontWeight={fontWeight}
          onFontWeight={setFontWeight}
          slogan={slogan}
          onSlogan={setSlogan}
          lang={lang}
          onLang={setLang}
          homeColor={homeColor}
          onHomeColor={changeHomeColor}
          markerColors={markerColors}
          onMarkerColors={changeMarkerColors}
          authMode={authMe?.mode ?? 'local'}
          currentUser={authMe?.user ?? null}
          onProfileChanged={() => {
            void api.authMe().then((me) => setAuthMe(me));
          }}
          onLoggedOut={() => window.location.reload()}
        />
      )}

      {statsOpen && (
        <StatsPanel
          homeKey={homePlace ? `${homePlace.id}:${homePlace.lng}:${homePlace.lat}` : ''}
          onClose={() => setStatsOpen(false)}
          onOpenBackup={() => {
            setStatsOpen(false);
            setSettingsInitialTab(undefined);
            setSettingsOpen(true);
            void refreshBackupStatus();
            void refreshTrashCount();
          }}
        />
      )}

      {photoWall && (
        <PhotoWall
          onClose={() => setPhotoWall(null)}
          onPick={(placeId) => {
            setPhotoWall(null);
            void openPlaceById(placeId, { fly: true });
          }}
          focus={photoWall.focus}
        />
      )}

      {secretTarget && (
        <SecretPrompt
          title={secretTarget.name}
          onSuccess={onSecretUnlocked}
          onCancel={() => setSecretTarget(null)}
        />
      )}

      {lightbox && lightboxItems.length > 0 && (
        <Lightbox
          items={lightboxItems}
          index={Math.min(lightbox.index, lightboxItems.length - 1)}
          onClose={() => setLightbox(null)}
          onIndex={(i) => setLightbox({ visitId: lightbox.visitId, index: i })}
          onGotoWall={(mediaId) => openPhotoWall({ mediaId, placeId: detail?.id })}
        />
      )}

      {boot === 'ready' && !statsOpen && tlMeta && (
        <Timeline
          meta={tlMeta}
          eventDates={tlMeta.dates}
          value={range}
          onChange={setRange}
          companions={companions}
          onCompanionsChange={(list) => {
            setCompanions(list);
            if (list.length === 1)
              say(tr('只看和「{name}」一起去过的地方', { name: list[0] }));
            else if (list.length > 1)
              say(
                tr('只看和「{names}」等 {n} 人一起去过的地方', {
                  names: list.slice(0, 2).join(lang === 'en' ? ', ' : '、'),
                  n: list.length,
                })
              );
          }}
          onStep={(moved) => {
            closePanels();
            setMyTrailTab('visited');
            setMyTrailOpen(true);
            if (!moved) say(tr('已经是最早 / 最晚时间了'));
          }}
        />
      )}

      {boot === 'error' && (
        <div className="fatal">
          <h2>{t('启动失败')}</h2>
          <p>{bootError}</p>
          <p className="hint">
            {t('确认服务已启动（')}
            <code>npm run dev</code>
            {t(' 或 ')}
            <code>npm start</code>
            {t('），并检查 ')}
            <code>.env.local</code>
            {t(' 里的 ')}
            <code>TDT_TK</code>
            {t('。')}
          </p>
        </div>
      )}

      {boot === 'loading' && <div className="loading">{t('正在连接天地图…')}</div>}

      {busy && <div className="busy">{busy}</div>}
      {toast && <div className="toast">{toast}</div>}
      </div>
    </I18nContext.Provider>
  );
}
