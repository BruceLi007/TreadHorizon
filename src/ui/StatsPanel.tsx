import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import type {
  BackupStatus,
  ProvinceLightData,
  StatsCityRow,
  StatsData,
  StatsPlaceRow,
  StatsProvinceRow,
  StatsQuery,
  StatsTimePoint,
  StatsTotals,
} from '../lib/types';
import { useT, useTp, type TFn } from '../i18n';
import { fmtKm } from '../lib/geo';
import './StatsPanel.css';
import SortToggle, { type SortOrder } from './SortToggle';
import Segmented from './Segmented';
import CloseIcon from './CloseIcon';

type Tab = 'time' | 'region' | 'places' | 'provinces' | 'distance';
type MetricKey = 'visits' | 'places' | 'first' | 'photos' | 'videos';
type Bucket = 'year' | 'quarter' | 'month';
type SeriesBy = 'province' | 'city';
type RegionMode = 'province' | 'city';
type RegionRow = StatsProvinceRow | StatsCityRow;

/** 与后端 /api/stats 的 limit 上限（1~100）保持一致 */
const QUERY_LIMIT = 100;
const REGION_LIMIT = 20;
const PLACE_LIMIT = 20;
/** 省级行政区总数：23 省 + 5 自治区 + 4 直辖市 + 2 特别行政区 */
const PROVINCE_TOTAL = 34;

const METRIC_DEFS: Record<MetricKey, { label: string; unit: string }> = {
  visits: { label: '到访次数', unit: '次' },
  places: { label: '不同地点数', unit: '个' },
  first: { label: '首次到访', unit: '个' },
  photos: { label: '照片数', unit: '张' },
  videos: { label: '视频数', unit: '段' },
};
const METRIC_ORDER: MetricKey[] = ['visits', 'places', 'first', 'photos', 'videos'];

const TABS: { key: Tab; label: string }[] = [
  { key: 'time', label: '时间趋势' },
  { key: 'region', label: '地区分布' },
  { key: 'places', label: '地点排行' },
  { key: 'provinces', label: '省份点亮' },
  { key: 'distance', label: '离家距离' },
];

/** 每个视图切换时套用的默认指标（主 + 次）；离家距离视图不用指标，留空 */
const DEFAULT_METRICS: Record<Tab, MetricKey[]> = {
  time: ['visits', 'places'],
  region: ['visits', 'places'],
  places: ['visits', 'photos'],
  provinces: ['places', 'visits'],
  distance: [],
};

/** 每个视图能表达的指标；不支持的指标在筛选区禁用（离家距离视图不显示指标行） */
const AVAILABLE_METRICS: Record<Tab, MetricKey[]> = {
  time: ['visits', 'places', 'first', 'photos', 'videos'],
  region: ['visits', 'places', 'photos', 'videos'],
  places: ['visits', 'photos', 'videos'],
  provinces: ['places', 'visits'],
  distance: [],
};

const BUCKETS: { key: Bucket; label: string }[] = [
  { key: 'year', label: '年' },
  { key: 'quarter', label: '季' },
  { key: 'month', label: '月' },
];

const GROUPS: { key: SeriesBy | null; label: string }[] = [
  { key: null, label: '不分组' },
  { key: 'province', label: '按省' },
  { key: 'city', label: '按市' },
];

const BAR_LABEL: Record<'visits' | 'places', string> = {
  visits: '到访次数',
  places: '不同地点数',
};

/** 分组序列配色：强调色 / 冷蓝 / 绿 / 紫 / 棕 / 蓝灰 / 黄 / 灰 */
const SERIES_COLORS = [
  'var(--accent)',
  'var(--wish)',
  '#4cc38a',
  '#b07cc8',
  '#d98b6a',
  '#7d8aa8',
  '#c9a227',
  'var(--text-3)',
];

/** 省份点亮 4 档图例（按 places 固定分档，与主地图着色口径需保持一致） */
const PROVINCE_TIERS: { n: number; label: string }[] = [
  { n: 1, label: '1 个' },
  { n: 2, label: '2–3 个' },
  { n: 3, label: '4–9 个' },
  { n: 4, label: '10+ 个' },
];

const TOTAL_ITEMS: { key: keyof StatsTotals; label: string }[] = [
  { key: 'provinces', label: '省份' },
  { key: 'cities', label: '城市' },
  { key: 'places', label: '地点' },
  { key: 'visits', label: '到访' },
  { key: 'photos', label: '照片' },
  { key: 'videos', label: '视频' },
];

const fmt = (n: number | null | undefined): string =>
  n == null || !Number.isFinite(n) ? '0' : n.toLocaleString('zh-CN');

/** 备份提醒文案：0 天说「今天」，其余「N 天前」 */
const backupDaysText = (days: number | null | undefined, t: TFn): string =>
  days == null || !Number.isFinite(days)
    ? t('未知')
    : days <= 0
      ? t('今天')
      : t('{n} 天前', { n: days });

const widthOf = (v: number, max: number): string =>
  max > 0 && v > 0 ? `${Math.max(1.5, Math.min(100, (v / max) * 100))}%` : '0%';

/** 2024-03-08 → 2024.03 */
const ym = (d?: string | null): string => (d ? d.slice(0, 7).replace('-', '.') : '');
/** 2024-03-08 → 2024.03.08 */
const ymd = (d?: string | null): string => (d ? d.replace(/-/g, '.') : '');

const timeVal = (p: StatsTimePoint, k: MetricKey): number => {
  switch (k) {
    case 'visits':
      return p.visits;
    case 'places':
      return p.places;
    case 'first':
      return p.first_visits;
    case 'photos':
      return p.photos;
    case 'videos':
      return p.videos;
    default:
      return 0;
  }
};

const regionVal = (row: RegionRow, k: MetricKey): number => {
  switch (k) {
    case 'visits':
      return row.visits;
    case 'places':
      return row.places;
    case 'photos':
      return row.photos;
    case 'videos':
      return row.videos;
    default:
      return row.places;
  }
};

const placeVal = (row: StatsPlaceRow, k: MetricKey): number => {
  switch (k) {
    case 'photos':
      return row.photos;
    case 'videos':
      return row.videos;
    default:
      return row.visits;
  }
};

/** 点亮档位：固定分档，便于和地图图例对上 */
const tierOf = (places: number): number => {
  if (!Number.isFinite(places) || places <= 0) return 0;
  if (places <= 1) return 1;
  if (places <= 3) return 2;
  if (places <= 9) return 3;
  return 4;
};

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** 排序键 title：说明当前方向 + 点按后会变成什么 */
const sortTitleOf = (t: TFn, o: SortOrder, descText: string, ascText: string): string =>
  o === 'desc'
    ? t('切换排序：当前{cur}，点按改为{next}', { cur: descText, next: ascText })
    : t('切换排序：当前{cur}，点按改为{next}', { cur: ascText, next: descText });

const mergeStrings = (prev: string[], next: string[]): string[] => {
  const seen = new Set(prev);
  const out = [...prev];
  for (const s of next) {
    if (s && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
};

interface CityOption {
  name: string;
  province: string;
}

const mergeCities = (prev: CityOption[], next: CityOption[]): CityOption[] => {
  const seen = new Set(prev.map((c) => `${c.province}|${c.name}`));
  const out = [...prev];
  for (const c of next) {
    const key = `${c.province}|${c.name}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(c);
    }
  }
  return out;
};

interface TimeSeg {
  name: string;
  value: number;
  color: string;
  weak: boolean;
}

interface TimeRow {
  key: string;
  label: string;
  total: number;
  segs: TimeSeg[];
  dot: number | null;
  point: StatsTimePoint;
}

interface Props {
  onClose: () => void;
  /** 备份提醒行的「去备份」：由 App 关闭统计并打开设置页（F-SYS-05） */
  onOpenBackup?: () => void;
  /**
   * 家的位置签名（2026-11-06 D-185）：换家 / 移动家后变化，用来触发统计重新拉取，
   * 让「离家最远」不用关掉统计面板就能刷新。
   */
  homeKey?: string;
}

/**
 * 统计面板（F-STA / D-60）
 * 统计模式下的右侧固定列：备份提醒行 + 总量数字 + 首访/最近 + 5 个视图
 * （时间趋势 / 地区分布 / 地点排行 / 省份点亮 / 离家距离）。
 * 默认全量数据，筛选状态由面板自己管理；不跟随时间轴/随行筛选。
 * 时间趋势按用户拍板做成「年度横向条 + 地点数点」（纯 CSS/div 自绘，不引图表库）。
 * 离家距离（2026-11-06 D-199）：按到「家」的直线距离排行，服务端算距离、前端只排序展示。
 */
export default function StatsPanel({ onClose, onOpenBackup, homeKey = '' }: Props) {
  const t = useT();
  const tp = useTp();
  const [tab, setTab] = useState<Tab>('time');
  const [metrics, setMetrics] = useState<MetricKey[]>(DEFAULT_METRICS.time);
  const [bucket, setBucket] = useState<Bucket>('year');
  const [seriesBy, setSeriesBy] = useState<SeriesBy | null>(null);
  const [regionMode, setRegionMode] = useState<RegionMode>('province');
  const [fromYear, setFromYear] = useState<number | null>(null);
  const [toYear, setToYear] = useState<number | null>(null);
  const [province, setProvince] = useState<string | null>(null);
  const [city, setCity] = useState<string | null>(null);
  const [hover, setHover] = useState<StatsTimePoint | null>(null);
  // 每张图各自的排序方向（desc = 从高到低 / 从晚到早 / 从多到少）
  const [timeOrder, setTimeOrder] = useState<SortOrder>('desc');
  const [regionOrder, setRegionOrder] = useState<SortOrder>('desc');
  const [placeOrder, setPlaceOrder] = useState<SortOrder>('desc');
  const [provinceOrder, setProvinceOrder] = useState<SortOrder>('desc');
  /** 离家距离排行排序（2026-11-06 D-199）：desc = 从远到近（默认），asc = 从近到远 */
  const [distanceOrder, setDistanceOrder] = useState<SortOrder>('desc');

  const [data, setData] = useState<StatsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);

  const [provData, setProvData] = useState<ProvinceLightData | null>(null);
  const [provLoading, setProvLoading] = useState(true);
  const [provError, setProvError] = useState<string | null>(null);
  const [provTick, setProvTick] = useState(0);

  // 备份提醒（F-SYS-05）：读不到状态就整行隐藏，不影响统计功能
  const [backup, setBackup] = useState<BackupStatus | null>(null);

  // 年份范围 / 省 / 市选项只增不减：避免筛选后下拉选项被当前结果「吃掉」而无法再放开
  const [yearSpan, setYearSpan] = useState<{ min: number; max: number } | null>(null);
  const [provinceOpts, setProvinceOpts] = useState<string[]>([]);
  const [cityOpts, setCityOpts] = useState<CityOption[]>([]);

  const absorbOptions = useCallback((d: StatsData) => {
    const years: number[] = [];
    const pushYear = (s?: string | null) => {
      if (!s) return;
      const y = Number.parseInt(s.slice(0, 4), 10);
      if (Number.isFinite(y)) years.push(y);
    };
    pushYear(d.range?.from);
    pushYear(d.range?.to);
    pushYear(d.first?.date);
    pushYear(d.last?.date);
    if (years.length > 0) {
      const min = Math.min(...years);
      const max = Math.max(...years);
      setYearSpan((prev) =>
        prev ? { min: Math.min(prev.min, min), max: Math.max(prev.max, max) } : { min, max }
      );
    }

    const provNames = (d.provinces ?? []).map((p) => p.name).filter(Boolean);
    if (provNames.length > 0) setProvinceOpts((prev) => mergeStrings(prev, provNames));

    const cities = (d.cities ?? [])
      .map((c) => ({ name: c.name, province: c.province ?? '' }))
      .filter((c) => c.name && c.province);
    if (cities.length > 0) setCityOpts((prev) => mergeCities(prev, cities));
  }, []);

  const query = useMemo<StatsQuery>(
    () => ({
      from: fromYear != null ? `${fromYear}-01-01` : undefined,
      to: toYear != null ? `${toYear}-12-31` : undefined,
      province: province ?? undefined,
      city: city ?? undefined,
      bucket,
      seriesBy: seriesBy ?? undefined,
      limit: QUERY_LIMIT,
    }),
    [fromYear, toYear, province, city, bucket, seriesBy]
  );

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    api
      .stats(query)
      .then((d) => {
        if (!alive) return;
        setData(d);
        absorbOptions(d);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setError(errText(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [query, retryTick, absorbOptions, homeKey]);

  useEffect(() => {
    let alive = true;
    setProvLoading(true);
    setProvError(null);
    api
      .statsProvinces()
      .then((d) => {
        if (alive) setProvData(d);
      })
      .catch((e: unknown) => {
        if (alive) setProvError(errText(e));
      })
      .finally(() => {
        if (alive) setProvLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [provTick]);

  // 备份提醒（F-SYS-05）：失败静默隐藏，统计面板其他功能不受影响
  useEffect(() => {
    let alive = true;
    api
      .backupStatus()
      .then((s) => {
        if (alive) setBackup(s);
      })
      .catch(() => {
        /* 后端没起来 / 接口 404：不显示提醒行即可 */
      });
    return () => {
      alive = false;
    };
  }, []);

  const effMetrics = useMemo<MetricKey[]>(() => {
    const allowed = AVAILABLE_METRICS[tab];
    const kept = metrics.filter((m) => allowed.includes(m));
    return kept.length > 0 ? kept : DEFAULT_METRICS[tab];
  }, [metrics, tab]);

  const yearChoices = useMemo<number[]>(() => {
    if (!yearSpan) return [];
    const out: number[] = [];
    for (let y = yearSpan.min; y <= yearSpan.max; y += 1) out.push(y);
    return out;
  }, [yearSpan]);

  const provinceChoices = useMemo(
    () => provinceOpts.slice().sort((a, b) => a.localeCompare(b, 'zh')),
    [provinceOpts]
  );

  const cityChoices = useMemo<string[]>(() => {
    if (!province) return [];
    return cityOpts
      .filter((c) => c.province === province)
      .map((c) => c.name)
      .sort((a, b) => a.localeCompare(b, 'zh'));
  }, [cityOpts, province]);

  const hasFilter = fromYear != null || toYear != null || province != null || city != null;

  const scopeText = useMemo(() => {
    const parts: string[] = [];
    if (fromYear != null && toYear != null)
      parts.push(t('{from}–{to} 年', { from: fromYear, to: toYear }));
    else if (fromYear != null) parts.push(t('{from} 年起', { from: fromYear }));
    else if (toYear != null) parts.push(t('截至 {to} 年', { to: toYear }));
    if (city) parts.push(`${province ? tp(province) : ''}${city}`);
    else if (province) parts.push(tp(province));
    return parts.length > 0 ? parts.join(' · ') : t('全部数据');
  }, [fromYear, toYear, province, city, t, tp]);

  const switchTab = (next: Tab) => {
    if (next === tab) return;
    setTab(next);
    setHover(null);
    // 离家距离视图不用指标：切过去时保留原指标选择，切回其它视图再套用该视图默认值
    const defaults = DEFAULT_METRICS[next];
    if (defaults.length > 0) setMetrics(defaults);
    if (next !== 'region') setRegionMode('province');
    // 时间视图默认回到「年 · 不分组」，避免上一个视图的粒度设置让人困惑
    if (next === 'time') {
      setBucket('year');
      setSeriesBy(null);
    }
  };

  const toggleMetric = (k: MetricKey) => {
    if (!AVAILABLE_METRICS[tab].includes(k)) return;
    setMetrics((prev) => {
      const base = prev.filter((m) => AVAILABLE_METRICS[tab].includes(m));
      if (base.includes(k)) {
        // 至少保留一个指标
        return base.length <= 1 ? base : base.filter((m) => m !== k);
      }
      // 最多 2 个：勾第 3 个时只替换「次指标」，主指标保持不变
      //（用户反馈：原来替换最早勾的那个，会把正在看的「主指标」也换掉）
      if (base.length >= 2) return [base[0], k];
      return [...base, k];
    });
  };

  const resetFilters = () => {
    setFromYear(null);
    setToYear(null);
    setProvince(null);
    setCity(null);
  };

  const pickProvince = (name: string) => {
    setProvince((cur) => (cur === name ? null : name));
    setCity(null);
  };

  const pickCity = (row: StatsCityRow) => {
    const prov = row.province ?? province;
    if (prov) setProvince(prov);
    setCity((cur) => (cur === row.name ? null : row.name));
  };

  const timeChart = useMemo(() => {
    const points = data?.time ?? [];
    const primary = effMetrics[0] ?? 'visits';
    const secondary = effMetrics[1] ?? null;
    const seriesList = data?.series ?? [];
    const grouped = seriesBy !== null && seriesList.length > 0;
    const barField: 'visits' | 'places' = primary === 'places' ? 'places' : 'visits';
    const groupedFallback = grouped && primary !== 'visits' && primary !== 'places';

    const seriesIndex = new Map<string, number>();
    seriesList.forEach((s, i) => seriesIndex.set(s.name, i));
    const bucketSeries = new Map<string, Map<string, { visits: number; places: number }>>();
    if (grouped) {
      for (const s of seriesList) {
        for (const pt of s.points) {
          let m = bucketSeries.get(pt.bucket);
          if (!m) {
            m = new Map();
            bucketSeries.set(pt.bucket, m);
          }
          m.set(s.name, { visits: pt.visits, places: pt.places });
        }
      }
    }

    const rows: TimeRow[] = points.map((pt) => {
      let segs: TimeSeg[] = [];
      let total = 0;
      if (grouped) {
        const m = bucketSeries.get(pt.bucket);
        for (const s of seriesList) {
          const v = m?.get(s.name)?.[barField] ?? 0;
          if (v <= 0) continue;
          segs.push({
            name: s.name,
            value: v,
            color: SERIES_COLORS[(seriesIndex.get(s.name) ?? 0) % SERIES_COLORS.length],
            weak: false,
          });
          total += v;
        }
      } else if (primary === 'visits') {
        const first = Math.max(0, Math.min(pt.first_visits, pt.visits));
        const repeat = Math.max(0, pt.visits - first);
        if (first > 0) {
          segs.push({ name: t('首次到访'), value: first, color: 'var(--accent)', weak: false });
        }
        if (repeat > 0) {
          segs.push({ name: t('重复到访'), value: repeat, color: 'var(--accent)', weak: true });
        }
        total = first + repeat;
      } else {
        const v = Math.max(0, timeVal(pt, primary));
        if (v > 0) {
          segs.push({
            name: t(METRIC_DEFS[primary].label),
            value: v,
            color: 'var(--accent)',
            weak: false,
          });
        }
        total = v;
      }
      const dot = secondary ? timeVal(pt, secondary) : null;
      return { key: pt.bucket, label: pt.label || pt.bucket, total, segs, dot, point: pt };
    });

    // 时间桶按 bucket 升序排好；desc 倒过来 = 从晚到早（asc = 从早到晚）
    const ordered = rows.slice().sort((a, b) => a.key.localeCompare(b.key));
    if (timeOrder === 'desc') ordered.reverse();

    const maxBar = ordered.reduce((m, r) => Math.max(m, r.total), 0);
    const maxDot = secondary ? ordered.reduce((m, r) => Math.max(m, r.dot ?? 0), 0) : 0;
    return {
      rows: ordered,
      maxBar,
      maxDot,
      primary,
      secondary,
      grouped,
      groupedFallback,
      seriesList,
      barField,
    };
  }, [data, effMetrics, seriesBy, timeOrder, t]);

  const regionChart = useMemo(() => {
    const primary = effMetrics[0] ?? 'visits';
    const secondary = effMetrics[1] ?? null;
    const src: RegionRow[] = regionMode === 'province' ? (data?.provinces ?? []) : (data?.cities ?? []);
    // 始终按指标从高到低取前 N 个（条形用同一量级归一化），asc 时只把展示顺序反过来
    const sorted = src.slice().sort(
      (a, b) =>
        regionVal(b, primary) - regionVal(a, primary) ||
        b.visits - a.visits ||
        a.name.localeCompare(b.name, 'zh')
    );
    const shown = sorted.slice(0, REGION_LIMIT);
    if (regionOrder === 'asc') shown.reverse();
    const max1 = sorted.reduce((m, r) => Math.max(m, regionVal(r, primary)), 0);
    const max2 = secondary ? sorted.reduce((m, r) => Math.max(m, regionVal(r, secondary)), 0) : 0;
    return { rows: shown, total: sorted.length, max1, max2, primary, secondary };
  }, [data, regionMode, effMetrics, regionOrder]);

  const placeChart = useMemo(() => {
    const primary = effMetrics[0] ?? 'visits';
    const secondary = effMetrics[1] ?? null;
    // 始终按指标从高到低取前 N 个，asc 时只把展示顺序反过来
    const sorted = (data?.places ?? []).slice().sort(
      (a, b) =>
        placeVal(b, primary) - placeVal(a, primary) ||
        b.visits - a.visits ||
        a.name.localeCompare(b.name, 'zh')
    );
    const shown = sorted.slice(0, PLACE_LIMIT).map((row, i) => ({ row, rank: i + 1 }));
    // asc 只反转展示顺序；rank 仍保留按指标从高到低的名次
    if (placeOrder === 'asc') shown.reverse();
    const max = sorted.reduce((m, r) => Math.max(m, placeVal(r, primary)), 0);
    return { rows: shown, total: sorted.length, max, primary, secondary };
  }, [data, effMetrics, placeOrder]);

  /** 离家距离排行（2026-11-06 D-199）：服务端已按从远到近排好，前端只做 limit 截断 + 方向翻转 */
  const distanceChart = useMemo(() => {
    const sorted = data?.distance_places ?? [];
    const shown = sorted.slice(0, PLACE_LIMIT).map((row, i) => ({ row, rank: i + 1 }));
    // asc = 从近到远：只反转展示顺序；rank 仍保留从远到近的名次（和地点排行一致）
    if (distanceOrder === 'asc') shown.reverse();
    const max = sorted.reduce((m, r) => Math.max(m, r.distance_km), 0);
    return {
      rows: shown,
      total: data?.distance_total ?? sorted.length,
      max,
      home: data?.home ?? null,
    };
  }, [data, distanceOrder]);

  const provinceChart = useMemo(() => {
    const sorted = (provData?.provinces ?? [])
      .slice()
      .sort((a, b) => b.places - a.places || b.visits - a.visits || a.name.localeCompare(b.name, 'zh'));
    if (provinceOrder === 'asc') sorted.reverse();
    // 只排行已点亮（places > 0）的省份；asc 时从少到多
    const litRows = sorted.filter((p) => p.places > 0);
    const fallbackMax = sorted.reduce((m, p) => Math.max(m, p.places), 0);
    const maxPlaces = provData && provData.maxPlaces > 0 ? provData.maxPlaces : fallbackMax;
    return { list: litRows, lit: litRows.length, maxPlaces };
  }, [provData, provinceOrder]);

  const first = data?.first ?? null;
  const last = data?.last ?? null;
  const farthest = data?.farthest ?? null;

  return (
    <aside className="st-panel" aria-label={t('统计')}>
      <div className="st-head">
        <div className="st-head-main">
          <span className="st-title">{t('统计')}</span>
          {loading && <span className="st-syncing">{t('更新中…')}</span>}
        </div>
        <button type="button" className="icon" onClick={onClose} aria-label={t('关闭')}>
          <CloseIcon />
        </button>
      </div>

      <div className="st-scroll">
        {backup && (
          <div className={backup.due ? 'st-backup due' : 'st-backup'}>
            <span className="st-backup-dot" aria-hidden="true" />
            <span className="st-backup-text" title={backup.lastBackupAtISO ?? undefined}>
              {backup.lastBackupAt == null
                ? t('从未备份')
                : t('上次备份：{when}', {
                    when: backupDaysText(backup.daysSinceBackup, t),
                  })}
              {backup.due ? t(' · 该备份了') : ''}
            </span>
            {onOpenBackup && (
              <button type="button" className="st-backup-btn" onClick={onOpenBackup}>
                {t('去备份')}
              </button>
            )}
          </div>
        )}

        <div className="st-summary">
          <div className="st-fl">
            <span
              className="st-fl-item"
              title={
                first
                  ? [first.date, tp(first.province), first.city, first.place_name]
                      .filter(Boolean)
                      .join(' · ')
                  : undefined
              }
            >
              <b>{t('第一站')}</b>
              {first ? (
                <>
                  {ym(first.date)} <span className="st-fl-place">{first.place_name}</span>
                </>
              ) : (
                <span className="st-fl-none">{t('暂无')}</span>
              )}
            </span>
            <span className="st-fl-sep" aria-hidden="true">
              ·
            </span>
            <span
              className="st-fl-item"
              title={
                last
                  ? [last.date, tp(last.province), last.city, last.place_name]
                      .filter(Boolean)
                      .join(' · ')
                  : undefined
              }
            >
              <b>{t('最近')}</b>
              {last ? (
                <>
                  {ym(last.date)} <span className="st-fl-place">{last.place_name}</span>
                </>
              ) : (
                <span className="st-fl-none">{t('暂无')}</span>
              )}
            </span>
            {farthest && (
              <>
                <span className="st-fl-sep" aria-hidden="true">
                  ·
                </span>
                <span
                  className="st-fl-item"
                  title={[tp(farthest.province), farthest.city, farthest.name]
                    .filter(Boolean)
                    .join(' · ')}
                >
                  <b>{t('离家最远')}</b>
                  <span className="st-fl-place">{farthest.name}</span> · {fmtKm(farthest.distance_km)} km
                </span>
              </>
            )}
          </div>

          <div className="st-scope-row">
            <span className="st-scope">{t('统计范围：{scope}', { scope: scopeText })}</span>
            {hasFilter && (
              <button type="button" className="st-reset" onClick={resetFilters}>
                {t('重置筛选')}
              </button>
            )}
          </div>

          <div className="st-totals">
            {TOTAL_ITEMS.map((it) => (
              <div className="st-total" key={it.key}>
                <div className="st-total-n">{data ? fmt(data.totals[it.key]) : '—'}</div>
                <div className="st-total-l">{t(it.label)}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="st-tabs">
          <Segmented<Tab>
            fill
            scrollable
            variant="tabs"
            ariaLabel={t('统计视图')}
            options={TABS.map((tabDef) => ({ id: tabDef.key, label: t(tabDef.label) }))}
            value={tab}
            onChange={switchTab}
          />
        </div>

        {error && data && (
          <div className="st-banner">
            <span className="st-banner-msg">{t('刷新失败：{error}', { error })}</span>
            <button type="button" onClick={() => setRetryTick((n) => n + 1)}>
              {t('重试')}
            </button>
          </div>
        )}

        {!data ? (
          error ? (
            <div className="st-state">
              <div className="st-err-msg">{t('读取统计失败：{error}', { error })}</div>
              <button type="button" className="st-retry" onClick={() => setRetryTick((n) => n + 1)}>
                {t('重试')}
              </button>
            </div>
          ) : (
            <div className="st-state st-state-loading">
              <span className="st-pulse" />
              {t('正在统计…')}
            </div>
          )
        ) : (
          <>
            {tab !== 'provinces' && (
              <div className="st-filters">
                <div className="st-field">
                  <span className="st-field-label">{t('年份')}</span>
                  <div className="st-field-ctl">
                    <select
                      className="st-select"
                      aria-label={t('起始年份')}
                      value={fromYear ?? ''}
                      disabled={yearChoices.length === 0}
                      onChange={(e) => {
                        const y = e.target.value ? Number(e.target.value) : null;
                        setFromYear(y);
                        if (y != null && toYear != null && y > toYear) setToYear(y);
                      }}
                    >
                      <option value="">{t('全部')}</option>
                      {yearChoices.map((y) => (
                        <option key={y} value={y}>
                          {y}
                        </option>
                      ))}
                    </select>
                    <span className="st-dash">–</span>
                    <select
                      className="st-select"
                      aria-label={t('结束年份')}
                      value={toYear ?? ''}
                      disabled={yearChoices.length === 0}
                      onChange={(e) => {
                        const y = e.target.value ? Number(e.target.value) : null;
                        setToYear(y);
                        if (y != null && fromYear != null && y < fromYear) setFromYear(y);
                      }}
                    >
                      <option value="">{t('全部')}</option>
                      {yearChoices.map((y) => (
                        <option key={y} value={y}>
                          {y}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="st-field">
                  <span className="st-field-label">{t('地区')}</span>
                  <div className="st-field-ctl">
                    <select
                      className="st-select"
                      aria-label={t('省份')}
                      value={province ?? ''}
                      onChange={(e) => {
                        const v = e.target.value;
                        setProvince(v || null);
                        setCity(null);
                      }}
                    >
                      <option value="">{t('全国')}</option>
                      {provinceChoices.map((p) => (
                        <option key={p} value={p}>
                          {tp(p)}
                        </option>
                      ))}
                    </select>
                    <select
                      className="st-select"
                      aria-label={t('城市')}
                      value={city ?? ''}
                      disabled={!province || cityChoices.length === 0}
                      onChange={(e) => {
                        const v = e.target.value;
                        setCity(v || null);
                      }}
                    >
                      <option value="">{t('全部城市')}</option>
                      {cityChoices.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {tab !== 'distance' && (
                  <div className="st-field is-top">
                    <span className="st-field-label">{t('指标')}</span>
                    <div className="st-field-ctl st-metrics">
                      {METRIC_ORDER.map((k) => {
                        const selected = effMetrics.includes(k);
                        const orderIdx = effMetrics.indexOf(k);
                        const enabled = AVAILABLE_METRICS[tab].includes(k);
                        const cls = `st-metric${selected ? ' on' : ''}${enabled ? '' : ' off'}`;
                        return (
                          <label
                            key={k}
                            className={cls}
                            title={enabled ? undefined : t('当前视图不支持该指标')}
                          >
                            <input
                              type="checkbox"
                              checked={selected}
                              disabled={!enabled}
                              onChange={() => toggleMetric(k)}
                            />
                            <span className="st-metric-name">{t(METRIC_DEFS[k].label)}</span>
                            {selected && (
                              <span className="st-metric-flag">
                                {orderIdx === 0 ? (
                                  t('主||metric')
                                ) : (
                                  <>
                                    {/* 次指标 = 图上的蓝色标记（时间趋势的圆点 / 地区分布的第二条细线） */}
                                    <i className="st-metric-dot" aria-hidden="true" />
                                    {t('次||metric')}
                                  </>
                                )}
                              </span>
                            )}
                          </label>
                        );
                      })}
                    </div>
                  </div>
                )}

                {tab === 'time' && (
                  <>
                    <div className="st-field">
                      <span className="st-field-label">{t('粒度')}</span>
                      <div className="st-field-ctl">
                        <Segmented<Bucket>
                          size="sm"
                          variant="radio"
                          ariaLabel={t('时间粒度')}
                          options={BUCKETS.map((b) => ({ id: b.key, label: t(b.label) }))}
                          value={bucket}
                          onChange={setBucket}
                        />
                      </div>
                    </div>
                    <div className="st-field">
                      <span className="st-field-label">{t('分组')}</span>
                      <div className="st-field-ctl">
                        <Segmented<string>
                          size="sm"
                          variant="radio"
                          ariaLabel={t('分组方式')}
                          options={GROUPS.map((g) => ({
                            id: g.key ?? 'none',
                            label: t(g.label),
                          }))}
                          value={seriesBy ?? 'none'}
                          onChange={(id) => setSeriesBy(id === 'none' ? null : (id as SeriesBy))}
                        />
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}

            {tab === 'time' && (
              <div className="st-chart">
                <div className="st-chart-head">
                  <span className="st-chart-title">{t('时间趋势')}</span>
                  <div className="st-chart-tools">
                    <span className="st-chart-note">
                      {bucket === 'year' ? t('按年') : bucket === 'quarter' ? t('按季') : t('按月')}
                      {' · '}
                      {t('{n} 个时间点', { n: timeChart.rows.length })}
                    </span>
                    <SortToggle
                      order={timeOrder}
                      onChange={setTimeOrder}
                      title={sortTitleOf(t, timeOrder, t('从晚到早'), t('从早到晚'))}
                    />
                  </div>
                </div>

                <div className="st-legend">
                  {timeChart.grouped ? (
                    <span className="st-legend-item">
                      <i className="st-swatch" style={{ background: 'var(--accent)' }} />
                      {t('条 = {metric}（堆叠）', { metric: t(BAR_LABEL[timeChart.barField]) })}
                    </span>
                  ) : timeChart.primary === 'visits' ? (
                    <>
                      <span className="st-legend-item">
                        <i className="st-swatch" style={{ background: 'var(--accent)' }} />
                        {t('首次到访')}
                      </span>
                      <span className="st-legend-item">
                        <i className="st-swatch is-weak" style={{ background: 'var(--accent)' }} />
                        {t('重复到访')}
                      </span>
                    </>
                  ) : (
                    <span className="st-legend-item">
                      <i className="st-swatch" style={{ background: 'var(--accent)' }} />
                      {t('条 = {metric}', { metric: t(METRIC_DEFS[timeChart.primary].label) })}
                    </span>
                  )}
                  {timeChart.secondary && (
                    <span className="st-legend-item">
                      <i className="st-swatch is-dot" style={{ background: 'var(--wish)' }} />
                      {t('点 = {metric}', {
                        metric: t(METRIC_DEFS[timeChart.secondary].label),
                      })}
                      {timeChart.maxDot > 0
                        ? t('（最大 {n}）', { n: fmt(timeChart.maxDot) })
                        : ''}
                    </span>
                  )}
                </div>

                {timeChart.groupedFallback && (
                  <p className="st-note">
                    {t('分组模式只返回「到访次数 / 不同地点数」两个指标，条长按到访次数显示；照片、视频、首次到访请切回「不分组」。')}
                  </p>
                )}

                {timeChart.grouped && timeChart.seriesList.length > 0 && (
                  <div className="st-series-legend">
                    {timeChart.seriesList.map((s, i) => (
                      <span className="st-series-item" key={s.name}>
                        <i
                          className="st-swatch"
                          style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }}
                        />
                        {seriesBy === 'province' ? tp(s.name) : s.name}
                      </span>
                    ))}
                  </div>
                )}

                {timeChart.rows.length === 0 ? (
                  <div className="st-state">
                    {t('当前范围内没有到访记录，可以放宽年份或地区筛选。')}
                  </div>
                ) : (
                  <div className="st-time-rows">
                    {timeChart.rows.map((row) => {
                      const width =
                        timeChart.maxBar > 0
                          ? Math.max(
                              row.total > 0 ? 1.5 : 0,
                              Math.min(100, (row.total / timeChart.maxBar) * 100)
                            )
                          : 0;
                      const tip = t('{label} · {visits} 次到访 · {places} 个地点 · {new} 个新地方 · {photos} 张照片 · {videos} 段视频', {
                        label: row.label,
                        visits: fmt(row.point.visits),
                        places: fmt(row.point.places),
                        new: fmt(row.point.first_visits),
                        photos: fmt(row.point.photos),
                        videos: fmt(row.point.videos),
                      });
                      return (
                        <div
                          key={row.key}
                          className="st-row"
                          tabIndex={0}
                          title={tip}
                          onMouseEnter={() => setHover(row.point)}
                          onMouseLeave={() =>
                            setHover((cur) => (cur && cur.bucket === row.point.bucket ? null : cur))
                          }
                          onFocus={() => setHover(row.point)}
                          onBlur={() => setHover(null)}
                        >
                          <span className="st-row-label">{row.label}</span>
                          <span className="st-row-track">
                            <span className="st-row-bar" style={{ width: `${width}%` }}>
                              {row.segs.map((seg, i) => (
                                <span
                                  key={`${seg.name}-${i}`}
                                  className={seg.weak ? 'st-row-seg is-weak' : 'st-row-seg'}
                                  style={{ flexGrow: seg.value, background: seg.color }}
                                />
                              ))}
                            </span>
                            {row.dot != null && timeChart.maxDot > 0 && (
                              <span
                                className="st-row-dot"
                                style={{
                                  left: `${Math.min(100, (row.dot / timeChart.maxDot) * 100)}%`,
                                }}
                              />
                            )}
                          </span>
                          <span className="st-row-val">{fmt(row.total)}</span>
                        </div>
                      );
                    })}
                  </div>
                )}

                <div className="st-hoverline">
                  {hover ? (
                    <>
                      <b>{hover.label}</b>
                      {t(' · {visits} 次到访 · {places} 个地点 · {new} 个新地方 · {photos} 张照片 · {videos} 段视频', {
                        visits: fmt(hover.visits),
                        places: fmt(hover.places),
                        new: fmt(hover.first_visits),
                        photos: fmt(hover.photos),
                        videos: fmt(hover.videos),
                      })}
                    </>
                  ) : (
                    t('悬停或聚焦某一行查看明细')
                  )}
                </div>
              </div>
            )}

            {tab === 'region' && (
              <div className="st-chart">
                <div className="st-chart-head">
                  <span className="st-chart-title">{t('地区分布')}</span>
                  <div className="st-chart-tools">
                    <Segmented<RegionMode>
                      size="sm"
                      variant="radio"
                      ariaLabel={t('地区层级')}
                      options={[
                        { id: 'province', label: t('省') },
                        { id: 'city', label: t('市') },
                      ]}
                      value={regionMode}
                      onChange={setRegionMode}
                    />
                    <SortToggle
                      order={regionOrder}
                      onChange={setRegionOrder}
                      title={sortTitleOf(t, regionOrder, t('从高到低'), t('从低到高'))}
                    />
                  </div>
                </div>

                <div className="st-legend">
                  <span className="st-legend-item">
                    <i className="st-swatch" style={{ background: 'var(--accent)' }} />
                    {t('条 = {metric}', { metric: t(METRIC_DEFS[regionChart.primary].label) })}
                  </span>
                  {regionChart.secondary && (
                    <span className="st-legend-item">
                      <i className="st-swatch" style={{ background: 'var(--wish)' }} />
                      {t('条 = {metric}', {
                        metric: t(METRIC_DEFS[regionChart.secondary].label),
                      })}
                    </span>
                  )}
                  <span className="st-legend-note">
                    {regionMode === 'province'
                      ? t('共 {n} 个省份', { n: regionChart.total })
                      : t('共 {n} 个城市', { n: regionChart.total })}
                    {regionChart.total > REGION_LIMIT
                      ? t('，显示前 {n} 个', { n: REGION_LIMIT })
                      : ''}
                  </span>
                </div>

                {regionChart.rows.length === 0 ? (
                  <div className="st-state">{t('当前范围内没有地区数据。')}</div>
                ) : (
                  <div className="st-bars">
                    {regionChart.rows.map((row) => {
                      const active =
                        regionMode === 'province' ? province === row.name : city === row.name;
                      const sub =
                        regionMode === 'city'
                          ? tp((row as StatsCityRow).province ?? '')
                          : '';
                      const displayName = regionMode === 'province' ? tp(row.name) : row.name;
                      const v1 = regionVal(row, regionChart.primary);
                      const v2 = regionChart.secondary
                        ? regionVal(row, regionChart.secondary)
                        : null;
                      const rowTitle = sub
                        ? t('{name}（{sub}） · {places} 个地点 · {visits} 次到访', {
                            name: displayName,
                            sub,
                            places: fmt(row.places),
                            visits: fmt(row.visits),
                          })
                        : t('{name} · {places} 个地点 · {visits} 次到访', {
                            name: displayName,
                            places: fmt(row.places),
                            visits: fmt(row.visits),
                          });
                      return (
                        <button
                          key={`${regionMode}-${row.name}-${sub}`}
                          type="button"
                          className={active ? 'st-bar-row on' : 'st-bar-row'}
                          title={rowTitle}
                          onClick={() => {
                            if (regionMode === 'province') pickProvince(row.name);
                            else pickCity(row as StatsCityRow);
                          }}
                        >
                          <span className="st-bar-top">
                            <span className="st-bar-name">
                              {displayName}
                              {sub && <em className="st-bar-sub">{sub}</em>}
                            </span>
                            <span className="st-bar-val">
                              {fmt(v1)}
                              <small>{t(METRIC_DEFS[regionChart.primary].unit)}</small>
                              {v2 != null && regionChart.secondary && (
                                <>
                                  <span className="st-bar-dot-sep"> · </span>
                                  {fmt(v2)}
                                  <small>{t(METRIC_DEFS[regionChart.secondary].unit)}</small>
                                </>
                              )}
                            </span>
                          </span>
                          <span className="st-bar-dual">
                            <span className="st-bar-line">
                              <span
                                className="st-bar-fill"
                                style={{ width: widthOf(v1, regionChart.max1) }}
                              />
                            </span>
                            {v2 != null && (
                              <span className="st-bar-line is-secondary">
                                <span
                                  className="st-bar-fill"
                                  style={{ width: widthOf(v2, regionChart.max2) }}
                                />
                              </span>
                            )}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}

                <p className="st-hint-line">{t('点一行可按该省 / 市收窄统计范围。')}</p>
              </div>
            )}

            {tab === 'places' && (
              <div className="st-chart">
                <div className="st-chart-head">
                  <span className="st-chart-title">{t('地点排行')}</span>
                  <div className="st-chart-tools">
                    <span className="st-chart-note">
                      {placeChart.total > PLACE_LIMIT
                        ? t('显示前 {limit} / 共 {total} 个', {
                            limit: PLACE_LIMIT,
                            total: placeChart.total,
                          })
                        : t('共 {n} 个地点', { n: placeChart.total })}
                    </span>
                    <SortToggle
                      order={placeOrder}
                      onChange={setPlaceOrder}
                      title={sortTitleOf(t, placeOrder, t('从高到低'), t('从低到高'))}
                    />
                  </div>
                </div>

                <div className="st-legend">
                  <span className="st-legend-item">
                    <i className="st-swatch" style={{ background: 'var(--accent)' }} />
                    {t('条 = {metric}', { metric: t(METRIC_DEFS[placeChart.primary].label) })}
                  </span>
                  {placeChart.secondary && (
                    <span className="st-legend-item">
                      <i className="st-swatch is-dot" style={{ background: 'var(--wish)' }} />
                      {t('次指标 = {metric}', {
                        metric: t(METRIC_DEFS[placeChart.secondary].label),
                      })}
                    </span>
                  )}
                </div>

                {placeChart.rows.length === 0 ? (
                  <div className="st-state">{t('当前范围内没有地点。')}</div>
                ) : (
                  <div className="st-places">
                    {placeChart.rows.map(({ row, rank }) => {
                      const region = [row.province ? tp(row.province) : '', row.city]
                        .filter(Boolean)
                        .join(' · ');
                      const meta = [
                        region,
                        t('{n} 次到访', { n: fmt(row.visits) }),
                        t('{n} 张照片', { n: fmt(row.photos) }),
                        t('{n} 段视频', { n: fmt(row.videos) }),
                        row.last_date ? t('最近 {date}', { date: ymd(row.last_date) }) : '',
                      ]
                        .filter(Boolean)
                        .join(' · ');
                      return (
                        <div className="st-place-row" key={row.id}>
                          <span className="st-rank">{rank}</span>
                          <div className="st-place-main">
                            <div className="st-place-head">
                              <span className="st-place-name" title={row.name}>
                                {row.name}
                              </span>
                              {(row.secret ?? 0) > 0 && (
                                <span className="st-tag-secret">{t('秘密基地')}</span>
                              )}
                              <span className="st-place-val">
                                <span className="st-place-val-main">
                                  {fmt(placeVal(row, placeChart.primary))}
                                  <small>{t(METRIC_DEFS[placeChart.primary].unit)}</small>
                                </span>
                                {placeChart.secondary && (
                                  <span className="st-place-sub">
                                    {fmt(placeVal(row, placeChart.secondary))}{' '}
                                    {t(METRIC_DEFS[placeChart.secondary].unit)}
                                  </span>
                                )}
                              </span>
                            </div>
                            <div className="st-place-track">
                              <div
                                className="st-place-fill"
                                style={{ width: widthOf(placeVal(row, placeChart.primary), placeChart.max) }}
                              />
                            </div>
                            <div className="st-place-meta" title={meta}>
                              {meta}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {tab === 'distance' && (
              <div className="st-chart">
                <div className="st-chart-head">
                  <span className="st-chart-title">{t('离家距离')}</span>
                  <div className="st-chart-tools">
                    {distanceChart.home && (
                      <span className="st-chart-note">
                        {distanceChart.total > PLACE_LIMIT
                          ? t('显示前 {limit} / 共 {total} 个', {
                              limit: PLACE_LIMIT,
                              total: distanceChart.total,
                            })
                          : t('共 {n} 个地点', { n: distanceChart.total })}
                      </span>
                    )}
                    {distanceChart.home && (
                      <SortToggle
                        order={distanceOrder}
                        onChange={setDistanceOrder}
                        title={sortTitleOf(t, distanceOrder, t('从远到近'), t('从近到远'))}
                      />
                    )}
                  </div>
                </div>

                {!distanceChart.home ? (
                  <div className="st-state">
                    {t('还没有设置家：打开一个地点 → 编辑 → 设为家，就能按离家距离排行。')}
                  </div>
                ) : (
                  <>
                    <div className="st-legend">
                      <span className="st-legend-item">
                        <i className="st-swatch" style={{ background: 'var(--accent)' }} />
                        {t('条 = 到「家」的直线距离（{home}）', {
                          home: distanceChart.home.name,
                        })}
                      </span>
                    </div>
                    <p className="st-note">
                      {t('直线距离，不是驾车 / 步行距离；按当前筛选口径统计。')}
                    </p>

                    {distanceChart.rows.length === 0 ? (
                      <div className="st-state">{t('当前范围内没有地点。')}</div>
                    ) : (
                      <div className="st-places">
                        {distanceChart.rows.map(({ row, rank }) => {
                          const region = [row.province ? tp(row.province) : '', row.city]
                            .filter(Boolean)
                            .join(' · ');
                          const meta = [
                            region,
                            t('{n} 次到访', { n: fmt(row.visits) }),
                            t('{n} 张照片', { n: fmt(row.photos) }),
                            t('{n} 段视频', { n: fmt(row.videos) }),
                            row.last_date ? t('最近 {date}', { date: ymd(row.last_date) }) : '',
                          ]
                            .filter(Boolean)
                            .join(' · ');
                          return (
                            <div className="st-place-row" key={row.id}>
                              <span className="st-rank">{rank}</span>
                              <div className="st-place-main">
                                <div className="st-place-head">
                                  <span className="st-place-name" title={row.name}>
                                    {row.name}
                                  </span>
                                  {(row.secret ?? 0) > 0 && (
                                    <span className="st-tag-secret">{t('秘密基地')}</span>
                                  )}
                                  <span className="st-place-val">
                                    <span className="st-place-val-main">
                                      {fmtKm(row.distance_km)}
                                      <small>km</small>
                                    </span>
                                  </span>
                                </div>
                                <div className="st-place-track">
                                  <div
                                    className="st-place-fill"
                                    style={{ width: widthOf(row.distance_km, distanceChart.max) }}
                                  />
                                </div>
                                <div className="st-place-meta" title={meta}>
                                  {meta}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {tab === 'provinces' && (
              <>
                <div className="st-prov-card">
                  <div className="st-lit">
                    <div className="st-lit-main">
                      <b>{provinceChart.lit}</b>
                      <span>/ {PROVINCE_TOTAL}</span>
                      <em>{t('已点亮')}</em>
                    </div>
                    <div className="st-lit-track">
                      <div
                        className="st-lit-fill"
                        style={{ width: `${(provinceChart.lit / PROVINCE_TOTAL) * 100}%` }}
                      />
                    </div>
                  </div>
                </div>

                <div className="st-tier-legend">
                  <span className="st-tier-title">{t('点亮程度（按地点数）')}</span>
                  <div className="st-tier-items">
                    {PROVINCE_TIERS.map((tierDef) => (
                      <span className="st-tier-item" key={tierDef.n}>
                        <i className={`st-tier-swatch st-t${tierDef.n}`} />
                        {t(tierDef.label)}
                      </span>
                    ))}
                  </div>
                </div>

                {provLoading && !provData ? (
                  <div className="st-state st-state-loading">
                    <span className="st-pulse" />
                    {t('正在读取省份点亮…')}
                  </div>
                ) : provError && !provData ? (
                  <div className="st-state">
                    <div className="st-err-msg">
                      {t('读取省份点亮失败：{error}', { error: provError })}
                    </div>
                    <button
                      type="button"
                      className="st-retry"
                      onClick={() => setProvTick((n) => n + 1)}
                    >
                      {t('重试')}
                    </button>
                  </div>
                ) : provinceChart.list.length === 0 ? (
                  <div className="st-state">
                    {t('还没有点亮任何省份，新增一条到访记录后就会亮起。')}
                  </div>
                ) : (
                  <>
                    <div className="st-chart-head st-prov-rank-head">
                      <span className="st-chart-title">{t('省份排行')}</span>
                      <div className="st-chart-tools">
                        <SortToggle
                          order={provinceOrder}
                          onChange={setProvinceOrder}
                          title={sortTitleOf(t, provinceOrder, t('从多到少'), t('从少到多'))}
                        />
                      </div>
                    </div>
                    <div className="st-prov-list">
                      {provinceChart.list.map((p) => {
                        const tier = tierOf(p.places);
                        return (
                          <div className="st-prov-row" key={`${p.code ?? p.name}`}>
                            <span className={`st-tier-dot st-t${tier}`} />
                            <span className="st-prov-name" title={tp(p.name)}>
                              {tp(p.name)}
                            </span>
                            <span className="st-prov-track">
                              <span
                                className={`st-prov-fill st-t${tier}`}
                                style={{ width: widthOf(p.places, provinceChart.maxPlaces) }}
                              />
                            </span>
                            <span className="st-prov-val">
                              {t('{places} 地点 · {visits} 次', {
                                places: fmt(p.places),
                                visits: fmt(p.visits),
                              })}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}

                <p className="st-prov-hint">
                  {t('省份点亮在主地图上查看 · hover 地图省份看详情。')}
                  <br />
                  {t('本视图按全量数据统计，不受上方筛选影响。')}
                </p>
              </>
            )}

            <p className="st-foot-note">
              {t('只统计「去过」的地点；照片、视频按到访归户。')}
              {tab !== 'provinces' ? t('当前范围：{scope}。', { scope: scopeText }) : ''}
            </p>
          </>
        )}
      </div>
    </aside>
  );
}
