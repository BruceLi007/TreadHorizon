import { useEffect, useMemo, useRef, useState } from 'react';
import type { Place } from '../lib/types';
import type { RangeValue } from './Timeline';
import type { MyTrailFocus } from './MyTrailPanel';
import { api } from '../lib/api';
import ConfirmDialog from './ConfirmDialog';
import SortToggle, { type SortOrder } from './SortToggle';
import PlaceThumb from './PlaceThumb';
import { FolderIcon } from './TreeIcons';
import { useT, useTp } from '../i18n';
import CloseIcon from './CloseIcon';
// 秘密基地共用样式（styles.css 由 Lead 维护，本任务不改）
import './SecretPrompt.css';

interface Props {
  places: Place[];
  range: RangeValue | null;
  onClose: () => void;
  onPick: (p: Place) => void;
  onRefresh: () => void;
  /** 批量操作（删除）后通知 App 刷新地图 / 时间轴 / 回收站角标（D-295） */
  onChanged?: () => void;
  onClearRange: () => void;
  /** 「+ 添加一次到访」入口：打开该地点的侧栏并直接展开新增到访表单（D-109） */
  onAddVisit?: (p: Place) => void;
  /** My旅迹里嵌着显示：隐藏自带标题栏/关闭按钮，去掉面板定位与背景（参考 TrashPanel embedded） */
  embedded?: boolean;
  /** 去过 tab 下的小筛选：全部 / 普通打卡（secret≠1）/ 秘密基地（secret=1） */
  secretFilter?: 'all' | 'normal' | 'secret';
  /** D-290：从地点详情面包屑跳进来的定位请求（展开到省 / 市，滚到地点行并短暂高亮） */
  focus?: MyTrailFocus | null;
  /** D-290：定位应用完成（滚动 + 高亮播完）后通知父级清掉 focus，避免切 tab 回来重复高亮 */
  onFocusApplied?: () => void;
}

const NA = '未标注';

const totalVisits = (p: Place) => Math.max(1, p.total_visit_count ?? p.visit_count ?? 1);
const rangeVisits = (p: Place) => p.visit_count ?? 0;
/** 排序用：优先总体的最近日期；区间筛选时接口也会给区间内的 last_date */
const latestDate = (p: Place) => (p.total_last_date || p.last_date || '') as string;
const shortDate = (d?: string | null) => (d ? d.slice(0, 7).replace('-', '.') : '');
const fullDate = (d?: string | null) => (d ? d.replace(/-/g, '.') : '');
const maxStr = (a: string, b: string) => (a > b ? a : b);

interface CityGroup {
  name: string;
  items: Place[];
  rangeSum: number;
  totalSum: number;
  latest: string;
}
interface ProvGroup {
  name: string;
  cities: CityGroup[];
  rangeSum: number;
  totalSum: number;
  latest: string;
  count: number;
}

/**
 * 2026-11-08 D-283（用户反馈澳门出现「未标注」层级）：
 * 如果某个省下面**所有地点都没有「市」**，就不渲染「未标注」市分组，地点直接挂在省下面。
 * 典型：澳门——天地图逆地理只返回「澳门特别行政区」，city / county 都为空；
 * 香港多数地点能返回区（如油尖旺区，经 normalizeRegion 兜底成 city），不受影响。
 */
const flattenCities = (pg: ProvGroup) => pg.cities.length === 1 && pg.cities[0].name === NA;

/**
 * 多选勾选框（2026-11-08 D-295）：三态 = 未选 / 部分（省市下只选了部分地点）/ 全选。
 * 点击时阻止冒泡，避免顺手触发「展开 / 选中整组」。
 */
function TriPick({
  state,
  onClick,
  label,
}: {
  state: 0 | 1 | 2;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      className={state === 2 ? 'pick on' : state === 1 ? 'pick some' : 'pick'}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      aria-label={label}
      title={label}
      aria-pressed={state === 2}
    >
      {state === 2 ? (
        <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true" focusable="false">
          <path
            d="M2 6.4 4.6 9 10 3.2"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : state === 1 ? (
        <span className="pick-dash" aria-hidden="true" />
      ) : null}
    </button>
  );
}

/**
 * 去过清单（F-PLC-10）
 * 数据来自 App：单一时序来源，和地图上的标记完全一致（受时间轴 range 过滤）。
 * 按 省 → 市 分组；有区间时同时显示「区间内 N 次 / 共 M 次」。
 */
export default function VisitedPanel({
  places,
  range,
  onClose,
  onPick,
  onRefresh,
  onChanged,
  onClearRange,
  onAddVisit,
  embedded = false,
  secretFilter = 'all',
  focus = null,
  onFocusApplied,
}: Props) {
  const t = useT();
  const tp = useTp();
  const [q, setQ] = useState('');
  /** 排序方向：默认最近在前；asc 时省 / 市 / 地点整体反转 */
  const [order, setOrder] = useState<SortOrder>('desc');
  // 默认只展示最高一级（省份），城市/地点需要手动展开
  const [expandedProv, setExpandedProv] = useState<string[]>([]);
  const [expandedCity, setExpandedCity] = useState<string[]>([]);
  const filtering = q.trim().length > 0;
  /** D-290：列表滚动容器（从详情面包屑定位时把目标滚到可视区） */
  const visitsScrollRef = useRef<HTMLDivElement | null>(null);
  /** 同一个 focus.token 只应用一次（places 刷新 / 重渲染不重复滚动） */
  const lastFocusToken = useRef(0);
  // ── 多选批量操作（2026-11-08 D-295，用户要求：省 / 市 / 地点三级都能多选批量操作）──
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkErr, setBulkErr] = useState<string | null>(null);

  /** 过滤时强制展开，避免用户搜了东西却看不到结果 */
  const provOpen = (name: string) => filtering || expandedProv.includes(name);
  const cityOpen = (key: string) => filtering || expandedCity.includes(key);
  const toggleProv = (name: string) =>
    setExpandedProv((cur) =>
      cur.includes(name) ? cur.filter((x) => x !== name) : [...cur, name]
    );
  const toggleCity = (key: string) =>
    setExpandedCity((cur) => (cur.includes(key) ? cur.filter((x) => x !== key) : [...cur, key]));

  const groups = useMemo<ProvGroup[]>(() => {
    const term = q.trim();
    const visible = places.filter((p) => {
      if (p.kind === 'wishlist') return false;
      if (secretFilter === 'secret' && p.secret !== 1) return false;
      if (secretFilter === 'normal' && p.secret === 1) return false;
      if (!term) return true;
      return [p.name, p.province, p.city, p.county]
        .filter(Boolean)
        .join(' ')
        .includes(term);
    });

    const byProv = new Map<string, ProvGroup>();
    for (const p of visible) {
      const provName = p.province || NA;
      const cityName = p.city || NA;

      let pg = byProv.get(provName);
      if (!pg) {
        pg = { name: provName, cities: [], rangeSum: 0, totalSum: 0, latest: '', count: 0 };
        byProv.set(provName, pg);
      }
      let cg = pg.cities.find((c) => c.name === cityName);
      if (!cg) {
        cg = { name: cityName, items: [], rangeSum: 0, totalSum: 0, latest: '' };
        pg.cities.push(cg);
      }

      const r = rangeVisits(p);
      const tv = totalVisits(p);
      const latest = latestDate(p);

      cg.items.push(p);
      cg.rangeSum += r;
      cg.totalSum += tv;
      cg.latest = maxStr(cg.latest, latest);

      pg.rangeSum += r;
      pg.totalSum += tv;
      pg.latest = maxStr(pg.latest, latest);
      pg.count += 1;
    }

    const dir = order === 'desc' ? 1 : -1;
    const provinces = [...byProv.values()];
    for (const pg of provinces) {
      pg.cities.sort((a, b) => dir * b.latest.localeCompare(a.latest));
      for (const cg of pg.cities) {
        cg.items.sort((a, b) => dir * latestDate(b).localeCompare(latestDate(a)));
      }
    }
    provinces.sort((a, b) => dir * b.latest.localeCompare(a.latest));
    return provinces;
  }, [places, q, order, secretFilter]);

  // D-290：从地点详情的地区面包屑跳进来 → 展开到目标省 / 市，滚到对应行并短暂高亮
  useEffect(() => {
    if (!focus || lastFocusToken.current === focus.token) return;
    const target = places.find((p) => p.id === focus.placeId);
    const prov = target?.province || focus.province || NA;
    const city = target?.city || focus.city || NA;
    setQ('');
    setExpandedProv((cur) => (cur.includes(prov) ? cur : [...cur, prov]));
    if (focus.level !== 'province') {
      const key = `${prov}/${city}`;
      setExpandedCity((cur) => (cur.includes(key) ? cur : [...cur, key]));
    }
    const timer = window.setTimeout(() => {
      const box = visitsScrollRef.current;
      if (!box) return;
      const find = (sel: string, dataKey: 'prov' | 'city' | 'placeId', value: string) =>
        [...box.querySelectorAll<HTMLElement>(sel)].find((el) => el.dataset[dataKey] === value) ??
        null;
      let el: HTMLElement | null = null;
      if (focus.level === 'province') el = find('[data-prov]', 'prov', prov);
      if (!el && focus.level !== 'place') el = find('[data-city]', 'city', `${prov}/${city}`);
      if (!el) el = find('[data-place-id]', 'placeId', focus.placeId);
      if (!el) return;
      // 找到目标、真正应用定位后才标记 token；找不到就等 places 更新后再试
      lastFocusToken.current = focus.token;
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      el.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
      el.classList.add('focus-flash');
      window.setTimeout(() => {
        el?.classList.remove('focus-flash');
        onFocusApplied?.();
      }, 1800);
    }, 90);
    return () => window.clearTimeout(timer);
  }, [focus, places, onFocusApplied]);

  // 数据刷新后把已不在当前列表里的选中项清掉，避免批量操作误删看不见的地点
  useEffect(() => {
    setSelected((prev) => {
      if (!prev.size) return prev;
      const alive = new Set(places.map((p) => p.id));
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (alive.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [places]);

  const totalPlaces = groups.reduce((n, g) => n + g.count, 0);
  /** 「全部展开 / 全部收起」（2026-11-04，D-94）：省 / 市两级分组一键全开或全收 */
  const allProvNames = groups.map((g) => g.name);
  const allCityKeys = groups.flatMap((g) => g.cities.map((c) => `${g.name}/${c.name}`));
  /** 只要有任何一级展开着，按钮就是「全部收起」（部分展开也能一键收回）；全收起时才显示「全部展开」 */
  const anyOpen = expandedProv.length > 0 || expandedCity.length > 0;
  const toggleAll = () => {
    if (anyOpen) {
      setExpandedProv([]);
      setExpandedCity([]);
    } else {
      setExpandedProv(allProvNames);
      setExpandedCity(allCityKeys);
    }
  };
  const foldAllBtn = !filtering && groups.length > 0 && (
    <button
      type="button"
      className="text-btn sm"
      onClick={toggleAll}
      title={anyOpen ? t('收起所有省 / 市分组') : t('展开所有省 / 市分组，直接看到全部地点')}
    >
      {anyOpen ? t('全部收起') : t('全部展开')}
    </button>
  );

  // ── 多选批量操作（2026-11-08 D-295）：省 / 市 / 地点三级勾选，底部批量「移到回收站」──
  const visiblePlaces = useMemo(
    () => groups.flatMap((g) => g.cities.flatMap((c) => c.items)),
    [groups]
  );
  const visibleIds = useMemo(() => visiblePlaces.map((p) => p.id), [visiblePlaces]);
  const selectedCount = selected.size;
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const idsOfProv = (pg: ProvGroup) => pg.cities.flatMap((c) => c.items.map((p) => p.id));
  const idsOfCity = (cg: CityGroup) => cg.items.map((p) => p.id);
  const selState = (ids: string[]): 0 | 1 | 2 => {
    if (!ids.length) return 0;
    let n = 0;
    for (const id of ids) if (selected.has(id)) n += 1;
    return n === 0 ? 0 : n === ids.length ? 2 : 1;
  };
  const toggleIds = (ids: string[]) => {
    setBulkErr(null);
    setSelected((prev) => {
      const next = new Set(prev);
      const all = ids.length > 0 && ids.every((id) => next.has(id));
      for (const id of ids) {
        if (all) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  };
  const toggleAllVisible = () =>
    setSelected(allSelected ? new Set<string>() : new Set(visibleIds));
  const enterSelect = () => {
    setBulkErr(null);
    setSelected(new Set());
    setSelectMode(true);
  };
  const exitSelect = () => {
    setBulkErr(null);
    setSelected(new Set());
    setSelectMode(false);
  };
  /** 批量删除：逐个走单点 DELETE 接口（地点 + 到访 + 照片一起进回收站，可恢复） */
  const runBulkDelete = async () => {
    const ids = [...selected];
    if (!ids.length) return;
    setBulkBusy(true);
    setBulkErr(null);
    const failed: string[] = [];
    for (const id of ids) {
      try {
        await api.deletePlace(id);
      } catch {
        failed.push(id);
      }
    }
    setBulkBusy(false);
    setConfirmBulk(false);
    if (failed.length) {
      setSelected(new Set(failed));
      setBulkErr(t('有 {n} 个地点删除失败，请重试', { n: failed.length }));
    } else {
      setSelected(new Set());
      setSelectMode(false);
    }
    if (onChanged) onChanged();
    else onRefresh();
  };

  /** 当前筛选口径下有没有「去过」的地点（用于空状态文案） */
  const inSecretScope = (p: Place) =>
    secretFilter === 'all' ||
    (secretFilter === 'secret' ? p.secret === 1 : p.secret !== 1);
  const hasAnyVisited = places.some((p) => p.kind !== 'wishlist' && inSecretScope(p));
  /** 区间筛选时优先显示「区间内最近一次」，否则显示整体最近一次 */
  const recentOf = (p: Place) =>
    (range ? p.last_date || p.total_last_date : p.total_last_date || p.last_date) || '';

  const meta = (rangeSum: number, totalSum: number, n?: number) => {
    if (range) {
      return n != null
        ? t('区间内 {rangeSum} 次 · 共 {totalSum} 次 · {n} 个地方', { rangeSum, totalSum, n })
        : t('区间内 {rangeSum} 次 · 共 {totalSum} 次', { rangeSum, totalSum });
    }
    return n != null
      ? t('共 {totalSum} 次 · {n} 个地方', { totalSum, n })
      : t('共 {totalSum} 次', { totalSum });
  };

  /** 地点行（正常「省 → 市 → 地点」与「省下直接挂地点」两种结构共用） */
  const placeRow = (p: Place) => {
    const picked = selected.has(p.id);
    return (
      <div
        key={p.id}
        data-place-id={p.id}
        className={
          (onAddVisit && !selectMode ? 'place-row has-actions' : 'place-row') +
          (selectMode ? ' selectable' : '') +
          (picked ? ' picked' : '')
        }
        role="button"
        tabIndex={0}
        aria-pressed={selectMode ? picked : undefined}
        onClick={() => (selectMode ? toggleIds([p.id]) : onPick(p))}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (selectMode) toggleIds([p.id]);
            else onPick(p);
          }
        }}
      >
        {selectMode && (
          <TriPick
            state={picked ? 2 : 0}
            onClick={() => toggleIds([p.id])}
            label={t('选择 {name}', { name: p.name })}
          />
        )}
        <PlaceThumb place={p} className="place-row-cover" />
        <span className="place-row-name">
          <span className="place-row-title">{p.name}</span>
          {p.secret === 1 && <span className="sec-mini">{t('秘密基地')}</span>}
        </span>
        <span className="place-row-meta">
          {range
            ? t('区间 {range} 次 · 共 {total} 次', {
                range: rangeVisits(p),
                total: totalVisits(p),
              })
            : t('{n} 次', { n: totalVisits(p) })}
          {(p.photos ?? 0) + (p.videos ?? 0) > 0
            ? ' · ' +
              t('照片 {photos} · 视频 {videos}', {
                photos: p.photos ?? 0,
                videos: p.videos ?? 0,
              })
            : ''}
          {recentOf(p) ? ' · ' + t('最近 {date}', { date: shortDate(recentOf(p)) }) : ''}
        </span>
        {onAddVisit && !selectMode && (
          <span className="place-row-actions" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="row-action"
              onClick={() => onAddVisit(p)}
              title={t('给「{name}」添加一次到访', { name: p.name })}
            >
              {t('+ 到访')}
            </button>
          </span>
        )}
      </div>
    );
  };

  return (
    <aside className={embedded ? 'panel mytrail-embedded' : 'panel'}>
      {embedded ? (
        <div className="mytrail-embedded-head">
          <div className="mytrail-search">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('按名称 / 省市区过滤')}
              spellCheck={false}
              aria-label={t('按名称 / 省市区过滤')}
            />
          </div>
          <div className="head-tools">
            {totalPlaces > 0 && (
              <button
                type="button"
                className={
                  selectMode ? 'text-btn sm mytrail-select-btn on' : 'text-btn sm mytrail-select-btn'
                }
                onClick={selectMode ? exitSelect : enterSelect}
                title={selectMode ? t('取消选择') : t('多选（可批量删除）')}
              >
                {selectMode ? t('取消选择') : t('选择')}
              </button>
            )}
            {foldAllBtn}
            <SortToggle
              order={order}
              onChange={setOrder}
              label={order === 'desc' ? t('最近到访在前') : t('最早到访在前')}
            />
            <button
              type="button"
              className="st-icon"
              onClick={onRefresh}
              title={t('刷新列表')}
              aria-label={t('刷新列表')}
            >
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
                <g
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M13.1 8a5.1 5.1 0 1 1-1.5-3.6" />
                  <path d="M13.1 2.9v3.3h-3.3" />
                </g>
              </svg>
            </button>
          </div>
        </div>
      ) : (
        <div className="panel-head">
          <span className="title">
            {t('去过清单')}
            {totalPlaces > 0 && <span className="count-inline">{totalPlaces}</span>}
          </span>
          <div className="head-tools">
            {foldAllBtn}
            <SortToggle
              order={order}
              onChange={setOrder}
              label={order === 'desc' ? t('最近到访在前') : t('最早到访在前')}
            />
            <button className="icon" onClick={onClose} aria-label={t('关闭')}>
              <CloseIcon />
            </button>
          </div>
        </div>
      )}

      {range && (
        <div className="range-chip" onClick={onClearRange} title={t('点一下清除时间筛选')}>
          {t('时间轴：{from} – {to}', { from: fullDate(range.from), to: fullDate(range.to) })}
          <span className="range-x" aria-hidden="true">
            <CloseIcon size={10} />
          </span>
        </div>
      )}

      {!embedded && (
        <div className="search" style={{ paddingTop: 10 }}>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('按名称 / 省市区过滤')}
            spellCheck={false}
          />
        </div>
      )}

      <div className="visits" ref={visitsScrollRef} style={{ paddingTop: 4 }}>
        {!hasAnyVisited && (
          <div className="muted pad">
            {secretFilter === 'secret' ? (
              <>
                {t('还没有秘密基地。')}
                <br />
                {t('打开任意地点的「编辑」，点「设为秘密基地」后会出现在这里。')}
              </>
            ) : secretFilter === 'normal' ? (
              <>{t('还没有普通打卡地点（所有去过的地方都被标成秘密基地了）。')}</>
            ) : (
              <>
                {t('还没有去过的地点。')}
                <br />
                {t('新增足迹时默认就是「去过」，保存后会出现在这里。')}
              </>
            )}
          </div>
        )}

        {hasAnyVisited && totalPlaces === 0 && (
          <div className="muted pad">
            {filtering ? t('没有匹配「{q}」的地点。', { q }) : t('当前筛选下没有地点。')}
          </div>
        )}

        {groups.map((pg) => (
          <div key={pg.name} className="grp">
            <div
              className={provOpen(pg.name) ? 'grp-prov open' : 'grp-prov'}
              data-prov={pg.name}
              role="button"
              tabIndex={0}
              onClick={() => (selectMode ? toggleIds(idsOfProv(pg)) : toggleProv(pg.name))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  if (selectMode) toggleIds(idsOfProv(pg));
                  else toggleProv(pg.name);
                }
              }}
            >
              <span className="grp-main">
                {selectMode && (
                  <TriPick
                    state={selState(idsOfProv(pg))}
                    onClick={() => toggleIds(idsOfProv(pg))}
                    label={t('选择 {name}', {
                      name: pg.name === NA ? t('未标注') : tp(pg.name),
                    })}
                  />
                )}
                <span
                  className={provOpen(pg.name) ? 'grp-caret open' : 'grp-caret'}
                  onClick={
                    selectMode
                      ? (e) => {
                          e.stopPropagation();
                          toggleProv(pg.name);
                        }
                      : undefined
                  }
                />
                <FolderIcon className="grp-icon" />
                <span className="grp-name">{pg.name === NA ? t('未标注') : tp(pg.name)}</span>
                <span className="grp-dot">·</span>
                <span className="grp-meta">{meta(pg.rangeSum, pg.totalSum, pg.count)}</span>
              </span>
            </div>

            {provOpen(pg.name) &&
              (flattenCities(pg) ? (
                // D-283：该省下所有地点都没有「市」→ 不显示「未标注」这一级，地点直接挂在省下
                <div className="place-rows">{pg.cities[0].items.map(placeRow)}</div>
              ) : (
                pg.cities.map((cg) => {
                const ckey = `${pg.name}/${cg.name}`;
                const open = cityOpen(ckey);
                return (
                  <div key={ckey} className="grp-city-wrap">
                    <div
                      className={open ? 'grp-city open' : 'grp-city'}
                      data-city={ckey}
                      role="button"
                      tabIndex={0}
                      onClick={() => (selectMode ? toggleIds(idsOfCity(cg)) : toggleCity(ckey))}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          if (selectMode) toggleIds(idsOfCity(cg));
                          else toggleCity(ckey);
                        }
                      }}
                    >
                      <span className="grp-main">
                        {selectMode && (
                          <TriPick
                            state={selState(idsOfCity(cg))}
                            onClick={() => toggleIds(idsOfCity(cg))}
                            label={t('选择 {name}', {
                              name: cg.name === NA ? t('未标注') : cg.name,
                            })}
                          />
                        )}
                        <span
                          className={open ? 'grp-caret open' : 'grp-caret'}
                          onClick={
                            selectMode
                              ? (e) => {
                                  e.stopPropagation();
                                  toggleCity(ckey);
                                }
                              : undefined
                          }
                        />
                        <FolderIcon className="grp-icon" />
                        <span className="grp-name">{cg.name === NA ? t('未标注') : cg.name}</span>
                        <span className="grp-dot">·</span>
                        <span className="grp-meta">{meta(cg.rangeSum, cg.totalSum)}</span>
                      </span>
                    </div>

                    {open && <div className="place-rows">{cg.items.map(placeRow)}</div>}
                  </div>
                );
              })))}
          </div>
        ))}
      </div>

      {selectMode && (
        <div className="mytrail-bulkbar">
          <span className="mytrail-bulk-count">{t('已选 {n} 项', { n: selectedCount })}</span>
          <button type="button" className="text-btn sm" onClick={toggleAllVisible}>
            {allSelected ? t('取消全选') : t('全选')}
          </button>
          {bulkErr && <span className="mytrail-bulk-err">{bulkErr}</span>}
          <span className="mytrail-bulk-spacer" />
          <button type="button" className="text-btn sm" onClick={exitSelect} disabled={bulkBusy}>
            {t('取消选择')}
          </button>
          <button
            type="button"
            className="danger-btn"
            onClick={() => setConfirmBulk(true)}
            disabled={!selectedCount || bulkBusy}
          >
            {t('移到回收站')}
          </button>
        </div>
      )}

      {confirmBulk && (
        <ConfirmDialog
          title={t('删除选中的 {n} 个地点？', { n: selectedCount })}
          danger
          busy={bulkBusy}
          busyText={t('删除中…')}
          confirmText={t('移到回收站')}
          onCancel={() => {
            if (!bulkBusy) setConfirmBulk(false);
          }}
          onConfirm={() => void runBulkDelete()}
        >
          <p>{t('选中的地点会连同到访和照片一起移到回收站，之后可在顶栏「回收站」恢复。')}</p>
        </ConfirmDialog>
      )}

      {!embedded && (
        <div className="panel-foot">
          <button className="ghost full" onClick={onRefresh}>
            {t('刷新')}
          </button>
        </div>
      )}
    </aside>
  );
}
