import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import type { PhotoWallData, PhotoWallItem, PhotoWallQuery } from '../lib/types';
import { useLang, useT, useTp, type TPfn } from '../i18n';
import SortToggle, { type SortOrder } from './SortToggle';
import Segmented from './Segmented';
import Lightbox from './Lightbox';
import CloseIcon from './CloseIcon';
import './PhotoWall.css';

/**
 * 照片墙（F-BRW-04 / F-BRW-05 正向）
 *
 * - 自己分页拉 /api/photos：limit=60 + offset 递增，IntersectionObserver 哨兵无限滚动，到底停止。
 * - 顶部年份 chip（响应里的 years）+ 全部；可选省份下拉；focus.placeId 时默认只看该地点（可清除）。
 * - 按月分组倒序（2026年11月 / 2026年10月…，组内日期倒序）；缩略图懒加载；视频 ▶ 角标 + 时长；hover 显示日期 · 地点名 · 省市区。
 * - 点击一张 → onPick(place.id, media.id)，由 App 负责关面板 / 飞地点 / 开侧栏。
 * - focus.mediaId：加载到它就滚动过去并高亮；没加载到就保留 focus.placeId 过滤，不报错。
 */

interface Props {
  onClose: () => void;
  onPick: (placeId: string, mediaId: string) => void;
  focus?: { mediaId?: string; placeId?: string } | null;
}

/** 每页条数（与服务端约定） */
const PAGE_SIZE = 60;
/** focus.mediaId 不在首屏时，自动往后翻页找它的最大次数（防止目标已删时无限请求） */
const MAX_AUTO_FOLLOW = 8;

/** 照片墙窗口尺寸偏好（D-136）：只存本机浏览器，关掉重开也沿用上次缩放 */
const PW_SIZE_KEY = 'tm-photowall-size';

const clampPhotoWallSize = (w: number, h: number) => {
  const maxW = Math.max(560, window.innerWidth - 32);
  const maxH = Math.max(400, window.innerHeight - 32);
  return {
    w: Math.min(Math.max(w, 640), maxW),
    h: Math.min(Math.max(h, 420), maxH),
  };
};

const readPhotoWallSize = (): { w: number; h: number } | null => {
  try {
    const raw = localStorage.getItem(PW_SIZE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (Number.isFinite(v?.w) && Number.isFinite(v?.h)) {
      return clampPhotoWallSize(Number(v.w), Number(v.h));
    }
  } catch {
    /* 隐私模式 / 旧数据损坏：按默认大小 */
  }
  return null;
};

const savePhotoWallSize = (s: { w: number; h: number } | null) => {
  try {
    if (s) localStorage.setItem(PW_SIZE_KEY, JSON.stringify(s));
    else localStorage.removeItem(PW_SIZE_KEY);
  } catch {
    /* 写不进去就算了，只影响记忆 */
  }
};

/** 照片墙每行照片张数（2026-11-06 用户要求）：4 / 6 / 8 / 10，默认 6；只存本机浏览器 */
const PW_COLS_KEY = 'tm-photowall-cols';
const PHOTOWALL_COLS = [4, 6, 8, 10] as const;
type PhotoWallCols = (typeof PHOTOWALL_COLS)[number];
const DEFAULT_PW_COLS: PhotoWallCols = 6;

const readPhotoWallCols = (): PhotoWallCols => {
  try {
    const n = Number(localStorage.getItem(PW_COLS_KEY));
    if ((PHOTOWALL_COLS as readonly number[]).includes(n)) return n as PhotoWallCols;
  } catch {
    /* 隐私模式 / 旧数据损坏：用默认 */
  }
  return DEFAULT_PW_COLS;
};

const fmtDuration = (s?: number | null): string => {
  if (s == null || !Number.isFinite(s) || s <= 0) return '';
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
};

const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 分组键：YYYY-MM（2026-11-07 D-251 用户要求照片墙按月分隔）；拿不到日期就归「未知月份」 */
const monthOf = (it: PhotoWallItem): string => {
  if (it.date && /^\d{4}-\d{2}/.test(it.date)) return it.date.slice(0, 7);
  const d = new Date(it.created_at);
  if (!Number.isFinite(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

const dateText = (it: PhotoWallItem): string => (it.date ? it.date.replace(/-/g, '.') : '');

const regionOf = (place: PhotoWallItem['place'], tp: TPfn): string =>
  [tp(place.province), place.city, place.county].filter(Boolean).join(' · ');

/** 一格：缩略图 / 视频角标 + 时长；点图片本身 = 预览，点下面的「在地图中查看」才飞地点 */
function Tile({
  item,
  active,
  onPick,
  onPreview,
  register,
}: {
  item: PhotoWallItem;
  active: boolean;
  onPick: (placeId: string, mediaId: string) => void;
  onPreview: (mediaId: string) => void;
  register: (id: string, el: HTMLElement | null) => void;
}) {
  const t = useT();
  const tp = useTp();
  const [broken, setBroken] = useState(false);
  const dur = fmtDuration(item.duration);
  const region = regionOf(item.place, tp);
  const when = dateText(item);
  const preview = () => onPreview(item.id);
  const kindLabel = t(item.kind === 'video' ? '视频||type' : '照片||type');
  const namePart = item.place.name ? ` · ${item.place.name}` : '';

  return (
    <div
      ref={(el) => register(item.id, el)}
      role="button"
      tabIndex={0}
      className={active ? 'pw-tile is-target' : 'pw-tile'}
      title={`${when}${namePart}${region ? t('（{region}）', { region }) : ''} · ${t('点击预览')}`}
      aria-label={t('{kind} {when} {name}：点击预览，下方按钮在地图中查看', {
        kind: kindLabel,
        when,
        name: item.place.name,
      })}
      onClick={preview}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          preview();
        }
      }}
    >
      {!broken ? (
        <img
          src={api.thumbUrl(item.id)}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setBroken(true)}
        />
      ) : (
        <span className="pw-broken">{item.kind === 'video' ? '▶' : t('未能加载')}</span>
      )}

      {item.kind === 'video' && !broken && <span className="pw-play">▶</span>}
      {item.kind === 'video' && dur && <span className="pw-dur">{dur}</span>}

      <span className="pw-meta">
        <span className="pw-meta-line">
          {when}
          {namePart}
        </span>
        {region && <span className="pw-meta-sub">{region}</span>}
        <span className="pw-meta-hint">{t('点击预览')}</span>
      </span>

      <button
        type="button"
        className="pw-map-btn"
        onClick={(e) => {
          e.stopPropagation();
          onPick(item.place.id, item.id);
        }}
        title={t('在地图中查看这个地点')}
      >
        {t('在地图中查看')}
      </button>

      {active && <span className="pw-target-flag">{t('目标照片')}</span>}
    </div>
  );
}

export default function PhotoWall({ onClose, onPick, focus }: Props) {
  const t = useT();
  const tp = useTp();
  const lang = useLang();
  const focusMediaId = focus?.mediaId ?? null;

  // ── 筛选 ──
  const [placeFilter, setPlaceFilter] = useState<string | null>(focus?.placeId ?? null);
  const [year, setYear] = useState<string | null>(null);
  const [province, setProvince] = useState<string | null>(null);
  /** 排序方向：desc = 最新/最近在前（默认），asc = 最早在前；只影响展示顺序，不影响分页请求 */
  const [order, setOrder] = useState<SortOrder>('desc');
  /** 递增以强制重拉第一页（错误重试 / focus 变化） */
  const [reload, setReload] = useState(0);
  /** 当前正在预览的媒体 id（点图片打开灯箱预览；不直接飞地点） */
  const [previewId, setPreviewId] = useState<string | null>(null);

  // ── 右下角拖拽缩放（D-135；D-136 记住上次大小）：size=null 时用 CSS 默认的自适应大小 ──
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(readPhotoWallSize);
  const [resizing, setResizing] = useState(false);
  const dragRef = useRef<{ sx: number; sy: number; w: number; h: number } | null>(null);

  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const el = panelRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const s = clampPhotoWallSize(r.width, r.height);
    setSize(s);
    dragRef.current = { sx: e.clientX, sy: e.clientY, w: s.w, h: s.h };
    setResizing(true);
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  const moveResize = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    setSize(clampPhotoWallSize(d.w + (e.clientX - d.sx), d.h + (e.clientY - d.sy)));
  };

  const endResize = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setResizing(false);
  };

  // 浏览器窗口变小 / 旋转时，把拖拽过的尺寸夹回可视范围
  useEffect(() => {
    const onWinResize = () => setSize((cur) => (cur ? clampPhotoWallSize(cur.w, cur.h) : cur));
    window.addEventListener('resize', onWinResize);
    return () => window.removeEventListener('resize', onWinResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 尺寸变化后写回 localStorage（拖拽结束时 resizing 变 false 才会写，避免拖动中狂写）；
  // size=null（双击复位）时删除记录，下次打开回到自适应默认。
  useEffect(() => {
    if (!resizing) savePhotoWallSize(size);
  }, [size, resizing]);

  // ── 每行照片张数（2026-11-06 用户要求；本机偏好，刷新 / 重开记住）──
  const [cols, setCols] = useState<PhotoWallCols>(readPhotoWallCols);
  useEffect(() => {
    try {
      localStorage.setItem(PW_COLS_KEY, String(cols));
    } catch {
      /* 写不进去就算了，只影响记忆 */
    }
  }, [cols]);

  // ── 数据 ──
  const [items, setItems] = useState<PhotoWallItem[]>([]);
  const [total, setTotal] = useState(0);
  const [yearChips, setYearChips] = useState<{ year: string; count: number }[]>([]);
  const [provinceOptions, setProvinceOptions] = useState<string[]>([]);
  const [firstLoading, setFirstLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── refs：分页 / 竞态 / 目标照片 ──
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const tileRefs = useRef(new Map<string, HTMLElement>());
  const genRef = useRef(0);
  const busyRef = useRef(false);
  const doneRef = useRef(false);
  const itemsRef = useRef<PhotoWallItem[]>([]);
  const autoFollowRef = useRef(focus?.mediaId ? MAX_AUTO_FOLLOW : 0);
  const didScrollRef = useRef(false);

  const focusKey = `${focus?.placeId ?? ''}|${focus?.mediaId ?? ''}`;
  const firstFocusRef = useRef(true);

  const registerTile = useCallback((id: string, el: HTMLElement | null) => {
    if (el) tileRefs.current.set(id, el);
    else tileRefs.current.delete(id);
  }, []);

  const buildQuery = useCallback(
    (offset: number): PhotoWallQuery => ({
      limit: PAGE_SIZE,
      offset,
      ...(year ? { from: `${year}-01-01`, to: `${year}-12-31` } : {}),
      ...(province ? { province } : {}),
      ...(placeFilter ? { place_id: placeFilter } : {}),
    }),
    [year, province, placeFilter]
  );

  /** 把一页响应合并进列表（分页只在筛选变化时重置，所以 offset 0 = 全新一页） */
  const ingest = useCallback(
    (d: PhotoWallData, offset: number) => {
      const list = Array.isArray(d.items) ? d.items : [];
      const next = offset === 0 ? list : [...itemsRef.current, ...list];
      itemsRef.current = next;
      setItems(next);

      const realTotal = typeof d.total === 'number' ? d.total : next.length;
      setTotal(realTotal);

      // 年份 chip：只在没有选年份时刷新（选了年份后响应里的 years 只剩那一年，不能覆盖）
      if (!year) setYearChips(Array.isArray(d.years) ? d.years : []);

      // 省份下拉：从已加载的 item 里聚合，只增不减
      setProvinceOptions((prev) => {
        const set = new Set(prev);
        let changed = false;
        for (const it of list) {
          const p = it.place?.province;
          if (p && !set.has(p)) {
            set.add(p);
            changed = true;
          }
        }
        return changed ? [...set].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')) : prev;
      });

      const end = list.length === 0 || list.length < PAGE_SIZE || next.length >= realTotal;
      doneRef.current = end;
      setDone(end);
    },
    [year]
  );

  // ── 第一页：筛选变化 / 重试 / focus 变化时重置分页 ──
  useEffect(() => {
    const gen = ++genRef.current;
    busyRef.current = true;
    doneRef.current = false;
    itemsRef.current = [];
    autoFollowRef.current = focus?.mediaId ? MAX_AUTO_FOLLOW : 0;
    didScrollRef.current = false;

    setItems([]);
    setTotal(0);
    setDone(false);
    setError(null);
    setFirstLoading(true);
    setLoadingMore(false);
    scrollRef.current?.scrollTo({ top: 0 });

    api
      .photos(buildQuery(0))
      .then((d) => {
        if (gen !== genRef.current) return;
        busyRef.current = false;
        ingest(d, 0);
        setFirstLoading(false);
      })
      .catch((e: any) => {
        if (gen !== genRef.current) return;
        busyRef.current = false;
        doneRef.current = true;
        setDone(true);
        setError(e?.message || String(e) || t('加载失败'));
        setFirstLoading(false);
      });
    // focus 变化走下面的 focusKey effect（会改筛选 + 触发 reload）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildQuery, ingest, reload]);

  // ── 下一页 ──
  const loadMore = useCallback(() => {
    if (busyRef.current || doneRef.current || firstLoading) return;
    const gen = genRef.current;
    const offset = itemsRef.current.length;
    if (offset === 0) return;
    busyRef.current = true;
    setLoadingMore(true);
    api
      .photos(buildQuery(offset))
      .then((d) => {
        if (gen !== genRef.current) return;
        busyRef.current = false;
        ingest(d, offset);
        setLoadingMore(false);
      })
      .catch((e: any) => {
        if (gen !== genRef.current) return;
        busyRef.current = false;
        setLoadingMore(false);
        setError(e?.message || String(e) || t('加载失败'));
      });
  }, [buildQuery, ingest, firstLoading]);

  // ── 无限滚动：哨兵进入视野就翻页 ──
  useEffect(() => {
    const root = scrollRef.current;
    const el = sentinelRef.current;
    if (!root || !el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((x) => x.isIntersecting)) loadMore();
      },
      { root, rootMargin: '600px 0px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore]);

  // ── 首屏不满一屏 / 哨兵贴着视口：继续拉，直到填满（或到底） ──
  useEffect(() => {
    if (firstLoading || done || error) return;
    const root = scrollRef.current;
    const el = sentinelRef.current;
    if (!root || !el) return;
    const rr = root.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    if (er.top < rr.bottom + 240) loadMore();
  }, [items.length, firstLoading, done, error, loadMore]);

  // ── focus.mediaId 的自动追页（目标可能不在第一页） ──
  const targetInList = focusMediaId ? items.some((it) => it.id === focusMediaId) : false;

  useEffect(() => {
    if (!focusMediaId || targetInList || firstLoading || done || loadingMore || error) return;
    if (autoFollowRef.current <= 0) return;
    autoFollowRef.current -= 1;
    loadMore();
  }, [focusMediaId, targetInList, firstLoading, done, loadingMore, error, items.length, loadMore]);

  // ── 找到目标照片后滚动过去（只滚一次；高亮由 is-target 常驻） ──
  useEffect(() => {
    if (!focusMediaId || !targetInList || didScrollRef.current) return;
    const el = tileRefs.current.get(focusMediaId);
    if (!el) return;
    didScrollRef.current = true;
    const timer = window.setTimeout(() => {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [focusMediaId, targetInList, items.length]);

  // ── focus 在打开期间变化：重设筛选并按新的目标重新定位 ──
  useEffect(() => {
    if (firstFocusRef.current) {
      firstFocusRef.current = false;
      return;
    }
    setPlaceFilter(focus?.placeId ?? null);
    setYear(null);
    setProvince(null);
    setReload((n) => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey]);

  // ── Esc 关闭（预览灯箱打开时交给灯箱自己处理，避免把照片墙一起关掉）──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !previewId) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, previewId]);

  // 打开时把焦点给滚动容器，方向键 / PageDown 可直接翻
  useEffect(() => {
    scrollRef.current?.focus({ preventScroll: true });
  }, []);

  // ── 分组：按月倒序（2026年11月 / 2026年10月…），组内日期倒序 ──
  const groups = useMemo(() => {
    const map = new Map<string, PhotoWallItem[]>();
    for (const it of items) {
      const k = monthOf(it) || t('未知月份');
      const arr = map.get(k);
      if (arr) arr.push(it);
      else map.set(k, [it]);
    }
    const entries = [...map.entries()];
    // 排序方向：desc = 最新月份在前；asc = 从早到晚。
    // 「未知月份」不参与方向反转，永远排在最后。
    const dir = order === 'desc' ? -1 : 1;
    entries.sort((a, b) => {
      const an = /^\d{4}-\d{2}$/.test(a[0]) ? a[0] : null;
      const bn = /^\d{4}-\d{2}$/.test(b[0]) ? b[0] : null;
      if (an === null && bn === null) return 0;
      if (an === null) return 1;
      if (bn === null) return -1;
      return an.localeCompare(bn) * dir;
    });
    // 组内同样按 date desc（再 created_at）排序，asc 时整体反转
    for (const [, arr] of entries) {
      arr.sort((a, b) => {
        const cmp = (a.date || '').localeCompare(b.date || '');
        return (cmp !== 0 ? cmp : a.created_at - b.created_at) * dir;
      });
    }
    return entries;
  }, [items, order, t]);

  // focus 地点名（item 加载到之后才能拿到；没加载到就显示「该地点」）
  const placeName = useMemo(() => {
    if (!placeFilter) return null;
    const hit = items.find((it) => it.place?.id === placeFilter);
    return hit?.place.name || null;
  }, [items, placeFilter]);

  const hasFilter = year !== null || province !== null || placeFilter !== null;

  /** 月份分组标题：中文「2026年11月」，英文「Nov 2026」；无日期归「未知月份」 */
  const groupLabel = (key: string): string => {
    if (!/^\d{4}-\d{2}$/.test(key)) return t('未知月份');
    const [y, m] = key.split('-');
    const mi = Number(m);
    return lang === 'en' ? `${MONTHS_EN[mi - 1]} ${y}` : `${y}年${mi}月`;
  };

  const resetFilters = () => {
    setYear(null);
    setProvince(null);
    setPlaceFilter(null);
  };

  /** 预览灯箱：在当前已加载列表里定位；筛选/重载后找不到就自动关闭 */
  const previewIndex = previewId ? items.findIndex((it) => it.id === previewId) : -1;

  return (
    <>
      <div className="pw-overlay" onClick={onClose} role="presentation">
      <div
        ref={panelRef}
        className={resizing ? 'pw-panel resizing' : 'pw-panel'}
        style={size ? { width: size.w, height: size.h, maxHeight: 'none' } : undefined}
        role="dialog"
        aria-modal="true"
        aria-label={t('照片墙')}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="pw-head">
          <div className="pw-title">
            {t('照片墙')}
            {total > 0 && (
              <span className="pw-count">{t('共 {total} 张', { total })}</span>
            )}
          </div>
          <button
            className="icon pw-close"
            onClick={onClose}
            aria-label={t('关闭照片墙')}
            title={t('关闭（Esc）')}
          >
            <CloseIcon />
          </button>
        </div>

        <div className="pw-filters">
          <div className="pw-years">
            <Segmented<string>
              size="sm"
              variant="radio"
              scrollable
              ariaLabel={t('按年份筛选')}
              options={[
                { id: 'all', label: t('全部') },
                ...yearChips.map((y) => ({
                  id: y.year,
                  label: y.year,
                  count: y.count,
                  title: t('{year} 年 · {count} 张', { year: y.year, count: y.count }),
                })),
              ]}
              value={year ?? 'all'}
              onChange={(id) => setYear(id === 'all' ? null : id)}
            />
          </div>

          <div className="pw-cols">
            <span className="pw-cols-label">{t('照片每行')}</span>
            <Segmented
              size="sm"
              variant="radio"
              ariaLabel={t('照片墙每行张数')}
              options={PHOTOWALL_COLS.map((n) => ({ id: String(n), label: t('{n} 张', { n }) }))}
              value={String(cols)}
              onChange={(id) => setCols(Number(id) as PhotoWallCols)}
            />
          </div>

          <div className="pw-filters-right">
            {placeFilter && (
              <button
                type="button"
                className="pw-chip pw-chip-place"
                title={t('清除地点筛选')}
                onClick={() => setPlaceFilter(null)}
              >
                {t('只看{place} ×', {
                  place: placeName ? t('「{name}」', { name: placeName }) : t('该地点'),
                })}
              </button>
            )}
            {provinceOptions.length > 0 && (
              <label className="pw-province">
                <span>{t('省份')}</span>
                <select value={province ?? ''} onChange={(e) => setProvince(e.target.value || null)}>
                  <option value="">{t('全部')}</option>
                  {provinceOptions.map((p) => (
                    <option key={p} value={p}>
                      {tp(p)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <SortToggle
              order={order}
              onChange={setOrder}
              title={order === 'desc' ? t('切换排序：最新在前') : t('切换排序：最早在前')}
            />
          </div>
        </div>

        <div className="pw-scroll" ref={scrollRef} tabIndex={-1}>
          {firstLoading && <div className="pw-state">{t('正在加载照片…')}</div>}

          {!firstLoading && error && items.length === 0 && (
            <div className="pw-state pw-state-error">
              <p>{t('照片加载失败：{error}', { error })}</p>
              <button type="button" className="pw-retry" onClick={() => setReload((n) => n + 1)}>
                {t('重试')}
              </button>
            </div>
          )}

          {!firstLoading && !error && items.length === 0 && (
            <div className="pw-state">
              <p>{hasFilter ? t('当前筛选下没有照片。') : t('还没有照片。')}</p>
              {hasFilter && (
                <button type="button" className="pw-retry" onClick={resetFilters}>
                  {t('清空筛选')}
                </button>
              )}
            </div>
          )}

          {groups.map(([key, list]) => (
            <section className="pw-group" key={key} aria-label={groupLabel(key)}>
              <h3 className="pw-group-title">
                {groupLabel(key)}
                <span className="pw-group-n">
                  {list.length} {t('张')}
                </span>
              </h3>
              <div
                className="pw-grid"
                style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
              >
                {list.map((it) => (
                  <Tile
                    key={it.id}
                    item={it}
                    active={it.id === focusMediaId}
                    onPick={onPick}
                    onPreview={setPreviewId}
                    register={registerTile}
                  />
                ))}
              </div>
            </section>
          ))}

          <div className="pw-sentinel" ref={sentinelRef} />

          <div className="pw-foot">
            {loadingMore && <span>{t('正在加载更多…')}</span>}
            {!firstLoading && !loadingMore && error && items.length > 0 && (
              <span className="pw-foot-err">
                {t('加载失败：{error}', { error })}
                <button
                  type="button"
                  className="pw-retry"
                  onClick={() => {
                    setError(null);
                    loadMore();
                  }}
                >
                  {t('重试')}
                </button>
              </span>
            )}
            {!firstLoading && !loadingMore && !error && done && items.length > 0 && (
              <span>
                {items.length < total
                  ? t('已加载 {loaded} / {total} 张', { loaded: items.length, total })
                  : t('共 {n} 张 · 已经到底了', { n: items.length })}
              </span>
            )}
            {!firstLoading && !loadingMore && !error && !done && items.length > 0 && (
              <span>{t('向下滚动加载更多')}</span>
            )}
            {done && focusMediaId && !targetInList && (
              <span className="pw-foot-note">{t('没有在当前筛选里找到目标照片')}</span>
            )}
          </div>
        </div>

        {/* 右下角拖拽缩放：拖动改变大小，双击恢复默认（D-135） */}
        <div
          className="pw-resize"
          role="separator"
          aria-label={t('拖动调整照片墙大小；双击恢复默认大小')}
          title={t('拖动调整大小（双击恢复默认）')}
          onPointerDown={startResize}
          onPointerMove={moveResize}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          onDoubleClick={() => setSize(null)}
        >
          <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true" focusable="false">
            <g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
              <path d="M12 6.6 6.6 12" />
              <path d="M12 9.8 9.8 12" />
            </g>
          </svg>
        </div>
      </div>
      </div>

      {previewIndex >= 0 && (
        <Lightbox
          items={items}
          index={previewIndex}
          onClose={() => setPreviewId(null)}
          onIndex={(i) => {
            const next = items[i];
            if (next) setPreviewId(next.id);
          }}
        />
      )}
    </>
  );
}
