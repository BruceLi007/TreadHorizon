import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import type { Place } from '../lib/types';
import type { MyTrailFocus } from './MyTrailPanel';
import ConfirmDialog from './ConfirmDialog';
import SortToggle, { type SortOrder } from './SortToggle';
import PlaceThumb from './PlaceThumb';
import { FolderIcon } from './TreeIcons';
import { useT, useTp, type TFn } from '../i18n';
import CloseIcon from './CloseIcon';
import { isHmtProvince } from '../lib/region';

interface Props {
  onClose: () => void;
  onPick: (p: Place) => void;
  onChanged: () => void;
  /** My旅迹里嵌着显示：隐藏自带标题栏/关闭按钮，去掉面板定位与背景（参考 TrashPanel embedded） */
  embedded?: boolean;
  /** 清单数量变化时回调（My旅迹 tab 上显示想去数） */
  onCount?: (n: number) => void;
  /** D-290：从地点详情面包屑跳进来的定位请求（展开到省 / 市，滚到地点行并短暂高亮） */
  focus?: MyTrailFocus | null;
  /** D-290：定位应用完成（滚动 + 高亮播完）后通知父级清掉 focus，避免切 tab 回来重复高亮 */
  onFocusApplied?: () => void;
  /** 2026-11-09 D-335：只读样板会话——隐藏「选择 / 批量操作 / 转为去过 / 删除」等写入口 */
  readOnly?: boolean;
}

const NA = '未标注';
const createdOf = (p: Place) => p.created_at ?? 0;
const createdLabel = (p: Place) =>
  p.created_at ? new Date(p.created_at).toISOString().slice(0, 10).replace(/-/g, '.') : '';

export interface WishCityGroup {
  name: string;
  items: Place[];
  latest: number;
}
export interface WishProvGroup {
  name: string;
  cities: WishCityGroup[];
  count: number;
  latest: number;
}

/** 按 省 → 市 分组（纯函数，单测用）；order 默认最新的在前 */
export function groupWishlist(items: Place[], order: SortOrder = 'desc'): WishProvGroup[] {
  const byProv = new Map<string, WishProvGroup>();
  for (const p of items) {
    const provName = p.province || NA;
    const cityName = p.city || NA;
    let pg = byProv.get(provName);
    if (!pg) {
      pg = { name: provName, cities: [], count: 0, latest: 0 };
      byProv.set(provName, pg);
    }
    let cg = pg.cities.find((c) => c.name === cityName);
    if (!cg) {
      cg = { name: cityName, items: [], latest: 0 };
      pg.cities.push(cg);
    }
    cg.items.push(p);
    cg.latest = Math.max(cg.latest, createdOf(p));
    pg.count += 1;
    pg.latest = Math.max(pg.latest, createdOf(p));
  }

  const dir = order === 'desc' ? 1 : -1;
  const provinces = [...byProv.values()];
  for (const pg of provinces) {
    pg.cities.sort((a, b) => dir * (b.latest - a.latest));
    for (const cg of pg.cities) cg.items.sort((a, b) => dir * (createdOf(b) - createdOf(a)));
  }
  provinces.sort((a, b) => dir * (b.latest - a.latest));
  return provinces;
}

/**
 * 2026-11-08 D-283（用户反馈澳门出现「未标注」层级）：
 * 某省下所有地点都没有「市」时（如澳门，天地图逆地理只返回省级），
 * 不渲染「未标注」市分组，地点直接挂在省下面。
 */
const flattenCities = (pg: WishProvGroup) => pg.cities.length === 1 && pg.cities[0].name === NA;

/**
 * 2026-11-08 D-283：想去清单行里的区县文案。
 * 港澳台（如澳门）天地图只返回省级、没有区县属正常数据，不再显示「未标注区县」；
 * 主陆地点缺区县仍保留提示（与「补全地区」逻辑一致）。
 */
const countyLabel = (p: Place, t: TFn) =>
  p.county || (p.province && isHmtProvince(p.province) ? '' : t('未标注区县'));

/** 多选勾选框（2026-11-08 D-295）：三态 = 未选 / 部分 / 全选；点击阻止冒泡 */
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

/** 想去清单（F-PLC-07）：按 省 → 市 分组，默认只展开省级 */
export default function WishlistPanel({
  onClose,
  onPick,
  onChanged,
  embedded = false,
  onCount,
  focus = null,
  onFocusApplied,
  readOnly = false,
}: Props) {
  const t = useT();
  const tp = useTp();
  const [items, setItems] = useState<Place[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [expandedProv, setExpandedProv] = useState<string[]>([]);
  const [expandedCity, setExpandedCity] = useState<string[]>([]);
  /** 排序方向：默认最近加入的在前；asc 时省 / 市 / 地点整体反转 */
  const [order, setOrder] = useState<SortOrder>('desc');
  /** D-290：列表滚动容器（从详情面包屑定位时把目标滚到可视区） */
  const visitsScrollRef = useRef<HTMLDivElement | null>(null);
  /** 同一个 focus.token 只应用一次（切 tab / 重新加载不重复滚动） */
  const lastFocusToken = useRef(0);
  // ── 多选批量操作（2026-11-08 D-295，用户要求：省 / 市 / 地点三级都能多选批量操作）──
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkErr, setBulkErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const all = await api.places();
      const list = all.filter((p) => p.kind === 'wishlist');
      setItems(list);
      onCount?.(list.length);
    } catch (e: any) {
      setErr(t('读取失败：{msg}', { msg: e?.message || e }));
    } finally {
      setLoading(false);
    }
  }, [onCount, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const groups = groupWishlist(items, order);

  // D-290：从地点详情的地区面包屑跳进来 → 展开到目标省 / 市，滚到对应行并短暂高亮
  useEffect(() => {
    if (!focus || lastFocusToken.current === focus.token) return;
    const target = items.find((p) => p.id === focus.placeId);
    const prov = target?.province || focus.province || NA;
    const city = target?.city || focus.city || NA;
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
      // 找到目标、真正应用定位后才标记 token；找不到就等 items 加载后再试
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
  }, [focus, items, onFocusApplied]);
  /** 「全部展开 / 全部收起」（2026-11-04，D-94）：省 / 市两级分组一键全开或全收 */
  const allProvNames = groups.map((g) => g.name);
  const allCityKeys = groups.flatMap((g) => g.cities.map((c) => `${g.name}/${c.name}`));
  /** 有任何一级展开着 → 「全部收起」（部分展开也能一键收回）；全收起 → 「全部展开」 */
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
  const foldAllBtn = !loading && groups.length > 0 && (
    <button
      type="button"
      className="text-btn sm"
      onClick={toggleAll}
      title={anyOpen ? t('收起所有省 / 市分组') : t('展开所有省 / 市分组，直接看到全部地点')}
    >
      {anyOpen ? t('全部收起') : t('全部展开')}
    </button>
  );

  // ── 多选批量操作（D-295）：省 / 市 / 地点三级勾选，底部批量「转为去过 / 移到回收站」──
  const visibleIds = groups.flatMap((g) => g.cities.flatMap((c) => c.items.map((p) => p.id)));
  const selectedCount = selected.size;
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const idsOfProv = (pg: WishProvGroup) => pg.cities.flatMap((c) => c.items.map((p) => p.id));
  const idsOfCity = (cg: WishCityGroup) => cg.items.map((p) => p.id);
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
  /** 批量「转为去过」：逐个 PATCH kind（保留地点和想去记录，本体不删） */
  const runBulkConvert = async () => {
    const ids = [...selected];
    if (!ids.length) return;
    setBulkBusy(true);
    setBulkErr(null);
    const failed: string[] = [];
    for (const id of ids) {
      try {
        await api.updatePlace(id, { kind: 'visited' });
      } catch {
        failed.push(id);
      }
    }
    setBulkBusy(false);
    if (failed.length) {
      setSelected(new Set(failed));
      setBulkErr(t('有 {n} 个地点转换失败，请重试', { n: failed.length }));
    } else {
      setSelected(new Set());
      setSelectMode(false);
    }
    onChanged();
    await load();
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
    onChanged();
    await load();
  };

  // 数据刷新后把已不存在的选中项清掉，避免批量操作误操作看不见的地点
  useEffect(() => {
    setSelected((prev) => {
      if (!prev.size) return prev;
      const alive = new Set(items.map((p) => p.id));
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (alive.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [items]);
  const provOpen = (name: string) => expandedProv.includes(name);
  const cityOpen = (key: string) => expandedCity.includes(key);
  const toggleProv = (name: string) =>
    setExpandedProv((cur) =>
      cur.includes(name) ? cur.filter((x) => x !== name) : [...cur, name]
    );
  const toggleCity = (key: string) =>
    setExpandedCity((cur) => (cur.includes(key) ? cur.filter((x) => x !== key) : [...cur, key]));

  const toVisited = async (p: Place) => {
    setBusy(p.id);
    setErr(null);
    try {
      await api.updatePlace(p.id, { kind: 'visited' });
      onChanged();
      await load();
    } catch (e: any) {
      setErr(t('转换失败：{msg}', { msg: e?.message || e }));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (p: Place) => {
    setBusy(p.id);
    setErr(null);
    try {
      await api.deletePlace(p.id);
      setConfirmId(null);
      onChanged();
      await load();
    } catch (e: any) {
      setErr(t('删除失败：{msg}', { msg: e?.message || e }));
    } finally {
      setBusy(null);
    }
  };

  const row = (p: Place) => {
    const picked = selected.has(p.id);
    return (
      <div
        key={p.id}
        data-place-id={p.id}
        className={
          (selectMode ? 'place-row selectable' : 'place-row has-actions') + (picked ? ' picked' : '')
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
        </span>
        <span className="place-row-meta">
          {countyLabel(p, t) ? countyLabel(p, t) + ' · ' : ''}
          {createdLabel(p) ? t('加入 {date}', { date: createdLabel(p) }) : ''}
        </span>
        {!selectMode && !readOnly && (
          <span className="place-row-actions" onClick={(e) => e.stopPropagation()}>
            <button className="text-btn" onClick={() => toVisited(p)} disabled={busy === p.id}>
              {t('转为去过')}
            </button>
            {confirmId === p.id ? (
              <>
                <button
                  className="text-btn danger"
                  onClick={() => remove(p)}
                  disabled={busy === p.id}
                >
                  {t('确认删除')}
                </button>
                <button className="text-btn" onClick={() => setConfirmId(null)}>
                  {t('取消')}
                </button>
              </>
            ) : (
              <button className="text-btn danger" onClick={() => setConfirmId(p.id)}>
                {t('删除')}
              </button>
            )}
          </span>
        )}
      </div>
    );
  };

  return (
    <aside className={embedded ? 'panel mytrail-embedded' : 'panel'}>
      {embedded ? (
        <div className="mytrail-embedded-head">
          <span className="mytrail-hint">{t('按省 / 市分组')}</span>
          <div className="head-tools">
            {items.length > 0 && !readOnly && (
              <button
                type="button"
                className={
                  selectMode ? 'text-btn sm mytrail-select-btn on' : 'text-btn sm mytrail-select-btn'
                }
                onClick={selectMode ? exitSelect : enterSelect}
                title={selectMode ? t('取消选择') : t('多选（可批量删除 / 转为去过）')}
              >
                {selectMode ? t('取消选择') : t('选择')}
              </button>
            )}
            {foldAllBtn}
            <SortToggle
              order={order}
              onChange={setOrder}
              label={order === 'desc' ? t('最近加入在前') : t('最早加入在前')}
            />
            <button
              type="button"
              className="st-icon"
              onClick={() => void load()}
              disabled={loading}
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
            {t('想去清单')}
            {items.length > 0 && <span className="count-inline">{items.length}</span>}
          </span>
          <div className="head-tools">
            {foldAllBtn}
            <SortToggle
              order={order}
              onChange={setOrder}
              label={order === 'desc' ? t('最近加入在前') : t('最早加入在前')}
            />
            <button className="icon" onClick={onClose} aria-label={t('关闭')}>
              <CloseIcon />
            </button>
          </div>
        </div>
      )}

      <div className="visits" ref={visitsScrollRef} style={{ paddingTop: 10 }}>
        {loading && <div className="muted pad">{t('读取中…')}</div>}

        {!loading && items.length === 0 && (
          <div className="muted pad">
            {t('还没有标记「想去」的地方。')}
            <br />
            {t('新增足迹时选「想去」，或在任意地点里点「编辑」切换类型。')}
          </div>
        )}

        {!loading &&
          groups.map((pg) => (
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
                  <span className="grp-meta">{t('{n} 个地方', { n: pg.count })}</span>
                </span>
              </div>

              {provOpen(pg.name) &&
                (flattenCities(pg) ? (
                  // D-283：该省下所有地点都没有「市」→ 不显示「未标注」这一级，地点直接挂在省下
                  <div className="place-rows">{pg.cities[0].items.map(row)}</div>
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
                          <span className="grp-meta">
                            {t('{n} 个地方', { n: cg.items.length })}
                          </span>
                        </span>
                      </div>
                      {open && <div className="place-rows">{cg.items.map(row)}</div>}
                    </div>
                  );
                })))}
            </div>
          ))}

        {err && <p className="hint err pad">{err}</p>}
      </div>

      {!readOnly && selectMode && (
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
            className="text-btn sm"
            onClick={() => void runBulkConvert()}
            disabled={!selectedCount || bulkBusy}
          >
            {t('转为去过')}
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

      {!readOnly && confirmBulk && (
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
          <button className="ghost full" onClick={load} disabled={loading}>
            {t('刷新')}
          </button>
        </div>
      )}
    </aside>
  );
}
