import { useMemo, useState } from 'react';
import type { Place } from '../lib/types';
import type { SortOrder } from './SortToggle';
import { useT, useTp, type TFn, type TPfn } from '../i18n';

interface Props {
  places: Place[];
  onPick: (p: Place) => void;
  /** 高亮选中的地点（合并面板用） */
  selectedId?: string | null;
  /** 有过滤关键词时强制展开（和去过/想去清单一致） */
  forceExpand?: boolean;
  /** 默认是否展开省市（簇列表点开就想看成员，默认展开；合并列表默认收起到省） */
  defaultOpen?: boolean;
  emptyText?: string;
  /** 排序方向：desc = 最新优先（默认），asc = 最早优先（省市、组内一起反转） */
  sortOrder?: SortOrder;
}

const NA = '未标注';
const latest = (p: Place) => (p.last_date || p.total_last_date || '') as string;
const created = (p: Place) => Number(p.created_at ?? 0);

const regionOf = (p: Place, t: TFn, tp: TPfn) =>
  [tp(p.province), p.city, p.county].filter(Boolean).join(' · ') || t('未标注');
const visitText = (p: Place, t: TFn) =>
  p.kind === 'wishlist' ? t('想去') : t('去过 {n} 次', { n: Math.max(1, p.visit_count ?? 1) });

interface CityGroup {
  name: string;
  items: Place[];
  latest: string;
}
interface ProvGroup {
  name: string;
  cities: CityGroup[];
  count: number;
  latest: string;
}

/**
 * 地点列表的通用「省 → 市」两级分组 + 折叠（D-38/D-42/D-43 的延伸）
 * 所有地点列表（去过/想去/簇成员/合并候选）统一用这套层级，避免出现散列表。
 */
export default function PlaceGroupList({
  places,
  onPick,
  selectedId,
  forceExpand,
  defaultOpen = false,
  emptyText,
  sortOrder = 'desc',
}: Props) {
  const t = useT();
  const tp = useTp();
  const [openProv, setOpenProv] = useState<string[]>([]);
  const [openCity, setOpenCity] = useState<string[]>([]);

  const groups = useMemo<ProvGroup[]>(() => {
    const byProv = new Map<string, ProvGroup>();
    for (const p of places) {
      const provName = p.province || NA;
      const cityName = p.city || NA;
      let pg = byProv.get(provName);
      if (!pg) {
        pg = { name: provName, cities: [], count: 0, latest: '' };
        byProv.set(provName, pg);
      }
      let cg = pg.cities.find((c) => c.name === cityName);
      if (!cg) {
        cg = { name: cityName, items: [], latest: '' };
        pg.cities.push(cg);
      }
      cg.items.push(p);
      const lat = latest(p);
      if (lat > cg.latest) cg.latest = lat;
      if (lat > pg.latest) pg.latest = lat;
      pg.count += 1;
    }
    const dir = sortOrder === 'desc' ? 1 : -1;
    const provinces = [...byProv.values()];
    for (const pg of provinces) {
      for (const cg of pg.cities) {
        cg.items.sort(
          (a, b) => dir * (latest(b).localeCompare(latest(a)) || created(b) - created(a))
        );
      }
      pg.cities.sort(
        (a, b) => dir * (b.latest.localeCompare(a.latest) || b.items.length - a.items.length)
      );
    }
    provinces.sort(
      (a, b) => dir * (b.latest.localeCompare(a.latest) || b.count - a.count)
    );
    return provinces;
  }, [places, sortOrder]);

  const provOpen = (name: string) => Boolean(forceExpand) || defaultOpen || openProv.includes(name);
  const cityOpen = (key: string) => Boolean(forceExpand) || defaultOpen || openCity.includes(key);
  const toggleProv = (name: string) =>
    setOpenProv((cur) => (cur.includes(name) ? cur.filter((x) => x !== name) : [...cur, name]));
  const toggleCity = (key: string) =>
    setOpenCity((cur) => (cur.includes(key) ? cur.filter((x) => x !== key) : [...cur, key]));

  if (!places.length) return <div className="muted pad">{emptyText ?? t('没有地点。')}</div>;

  return (
    <div className="place-groups">
      {groups.map((pg) => (
        <div key={pg.name} className="grp">
          <div
            className="grp-prov"
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
            <span>
              <span className={provOpen(pg.name) ? 'grp-caret open' : 'grp-caret'} />
              {pg.name === NA ? t('未标注') : tp(pg.name)}
            </span>
            <span className="grp-meta">{t('{n} 个地方', { n: pg.count })}</span>
          </div>

          {provOpen(pg.name) &&
            pg.cities.map((cg) => {
              const key = `${pg.name}/${cg.name}`;
              const open = cityOpen(key);
              return (
                <div key={key} className="grp-city-wrap">
                  <div
                    className="grp-city"
                    role="button"
                    tabIndex={0}
                    onClick={() => toggleCity(key)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        toggleCity(key);
                      }
                    }}
                  >
                    <span>
                      <span className={open ? 'grp-caret open' : 'grp-caret'} />
                      {cg.name === NA ? t('未标注') : cg.name}
                    </span>
                    <span className="grp-meta">
                      {t('{n} 个地方', { n: cg.items.length })}
                    </span>
                  </div>

                  {open &&
                    cg.items.map((p) => (
                      <div
                        key={p.id}
                        className={
                          selectedId === p.id ? 'wish-row merge-row chosen' : 'wish-row merge-row'
                        }
                        onClick={() => onPick(p)}
                      >
                        <div className="wish-main">
                          <div className="wish-name">
                            {p.kind === 'wishlist' && (
                              <span className="kind-wish">{t('想去')}</span>
                            )}
                            {p.name}
                          </div>
                          <div className="wish-meta">
                            {regionOf(p, t, tp)} · {visitText(p, t)}
                            {p.last_date
                              ? ' · ' +
                                t('最近 {date}', {
                                  date: p.last_date.slice(0, 7).replace('-', '.'),
                                })
                              : ''}
                          </div>
                        </div>
                        {selectedId === p.id && <span className="merge-check">✓</span>}
                      </div>
                    ))}
                </div>
              );
            })}
        </div>
      ))}
    </div>
  );
}
