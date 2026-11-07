import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { Place } from '../lib/types';
import SortToggle, { type SortOrder } from './SortToggle';
import PlaceThumb from './PlaceThumb';
import { FolderIcon } from './TreeIcons';
import { useT, useTp } from '../i18n';
import CloseIcon from './CloseIcon';

interface Props {
  onClose: () => void;
  onPick: (p: Place) => void;
  onChanged: () => void;
  /** My旅迹里嵌着显示：隐藏自带标题栏/关闭按钮，去掉面板定位与背景（参考 TrashPanel embedded） */
  embedded?: boolean;
  /** 清单数量变化时回调（My旅迹 tab 上显示想去数） */
  onCount?: (n: number) => void;
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

/** 想去清单（F-PLC-07）：按 省 → 市 分组，默认只展开省级 */
export default function WishlistPanel({
  onClose,
  onPick,
  onChanged,
  embedded = false,
  onCount,
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

  const row = (p: Place) => (
    <div
      key={p.id}
      className="place-row has-actions"
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
      </span>
      <span className="place-row-meta">
        {p.county || t('未标注区县')}
        {createdLabel(p) ? ' · ' + t('加入 {date}', { date: createdLabel(p) }) : ''}
      </span>
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
    </div>
  );

  return (
    <aside className={embedded ? 'panel mytrail-embedded' : 'panel'}>
      {embedded ? (
        <div className="mytrail-embedded-head">
          <span className="mytrail-hint">{t('按省 / 市分组')}</span>
          <div className="head-tools">
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

      <div className="visits" style={{ paddingTop: 10 }}>
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
                  <span className="grp-meta">{t('{n} 个地方', { n: pg.count })}</span>
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
                          <span className="grp-meta">
                            {t('{n} 个地方', { n: cg.items.length })}
                          </span>
                        </span>
                      </div>
                      {open && <div className="place-rows">{cg.items.map(row)}</div>}
                    </div>
                  );
                })}
            </div>
          ))}

        {err && <p className="hint err pad">{err}</p>}
      </div>

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
