import { useMemo, useState } from 'react';
import type { Place } from '../lib/types';
import type { RangeValue } from './Timeline';
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
  onClearRange: () => void;
  /** 「+ 添加一次到访」入口：打开该地点的侧栏并直接展开新增到访表单（D-109） */
  onAddVisit?: (p: Place) => void;
  /** My旅迹里嵌着显示：隐藏自带标题栏/关闭按钮，去掉面板定位与背景（参考 TrashPanel embedded） */
  embedded?: boolean;
  /** 去过 tab 下的小筛选：全部 / 普通打卡（secret≠1）/ 秘密基地（secret=1） */
  secretFilter?: 'all' | 'normal' | 'secret';
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
  onClearRange,
  onAddVisit,
  embedded = false,
  secretFilter = 'all',
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

      <div className="visits" style={{ paddingTop: 4 }}>
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
              role="button"
              tabIndex={0}
              onClick={() => toggleProv(pg.name)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  toggleProv(pg.name);
                }
              }}
            >
              <span className="grp-main">
                <span className={provOpen(pg.name) ? 'grp-caret open' : 'grp-caret'} />
                <FolderIcon className="grp-icon" />
                <span className="grp-name">{pg.name === NA ? t('未标注') : tp(pg.name)}</span>
                <span className="grp-dot">·</span>
                <span className="grp-meta">{meta(pg.rangeSum, pg.totalSum, pg.count)}</span>
              </span>
            </div>

            {provOpen(pg.name) &&
              pg.cities.map((cg) => {
                const ckey = `${pg.name}/${cg.name}`;
                const open = cityOpen(ckey);
                return (
                  <div key={ckey} className="grp-city-wrap">
                    <div
                      className={open ? 'grp-city open' : 'grp-city'}
                      role="button"
                      tabIndex={0}
                      onClick={() => toggleCity(ckey)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          toggleCity(ckey);
                        }
                      }}
                    >
                      <span className="grp-main">
                        <span className={open ? 'grp-caret open' : 'grp-caret'} />
                        <FolderIcon className="grp-icon" />
                        <span className="grp-name">{cg.name === NA ? t('未标注') : cg.name}</span>
                        <span className="grp-dot">·</span>
                        <span className="grp-meta">{meta(cg.rangeSum, cg.totalSum)}</span>
                      </span>
                    </div>

                    {open && (
                      <div className="place-rows">
                        {cg.items.map((p) => (
                          <div
                            key={p.id}
                            className={onAddVisit ? 'place-row has-actions' : 'place-row'}
                            role="button"
                            tabIndex={0}
                            onClick={() => onPick(p)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                onPick(p);
                              }
                            }}
                          >
                            <PlaceThumb place={p} className="place-row-cover" />
                            <span className="place-row-name">
                              <span className="place-row-title">{p.name}</span>
                              {p.secret === 1 && (
                                <span className="sec-mini">{t('秘密基地')}</span>
                              )}
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
                              {recentOf(p)
                                ? ' · ' + t('最近 {date}', { date: shortDate(recentOf(p)) })
                                : ''}
                            </span>
                            {onAddVisit && (
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
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
        ))}
      </div>

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
