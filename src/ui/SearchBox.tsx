import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useT, useTp } from '../i18n';
import type { Place, Poi } from '../lib/types';

interface Props {
  onPickPlace: (p: Place) => void;
  onFlyTo: (lng: number, lat: number, zoom?: number) => void;
  onAddPoi: (poi: Poi) => void;
  /** 展开搜索时自动聚焦输入框（顶栏搜索图标用，D-130） */
  autoFocus?: boolean;
  /** 收起搜索栏（按 Esc / 选中「我的足迹」时通知父级收起，D-130） */
  onClose?: () => void;
  /** 2026-11-09 D-335：只读样板会话隐藏「+ 添加为足迹」（搜索照常可用） */
  readOnly?: boolean;
}

const parseLngLat = (s: string) => {
  const [lngS, latS] = String(s).split(',');
  const lng = Number(lngS);
  const lat = Number(latS);
  return Number.isFinite(lng) && Number.isFinite(lat) ? { lng, lat } : null;
};

/**
 * 顶栏全局搜索（F-BRW-02）
 * 结果分两组：我的足迹（本地 name / 到访笔记）+ 地图地点（天地图 POI 前 5 条）。
 */
export default function SearchBox({ onPickPlace, onFlyTo, onAddPoi, autoFocus = false, onClose, readOnly = false }: Props) {
  const t = useT();
  const tp = useTp();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [local, setLocal] = useState<Place[]>([]);
  const [pois, setPois] = useState<Poi[]>([]);
  const [pending, setPending] = useState<Poi | null>(null);
  const timer = useRef<number | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false);
        setPending(null);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  useEffect(() => {
    if (timer.current) window.clearTimeout(timer.current);
    const term = q.trim();
    if (!term) {
      setLocal([]);
      setPois([]);
      setLoading(false);
      return;
    }
    timer.current = window.setTimeout(async () => {
      setLoading(true);
      try {
        const [mine, poi] = await Promise.all([api.searchPlaces(term), api.search(term)]);
        setLocal((mine ?? []).slice(0, 6));
        setPois((poi.results ?? []).slice(0, 5));
        setOpen(true);
        setPending(null);
      } catch {
        setLocal([]);
        setPois([]);
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [q]);

  const pickPlace = (p: Place) => {
    onPickPlace(p);
    setOpen(false);
    setQ('');
    setPending(null);
    onClose?.();
  };

  const pickPoi = (p: Poi) => {
    const ll = parseLngLat(p.lnglat);
    if (!ll) return;
    onFlyTo(ll.lng, ll.lat, 13);
    setPending(p);
  };

  const term = q.trim();
  const empty = !loading && local.length === 0 && pois.length === 0;

  return (
    <div className="searchbox" ref={boxRef}>
      <input
        autoFocus={autoFocus}
        value={q}
        placeholder={t('搜自己的足迹，或搜地名')}
        spellCheck={false}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => term && setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setQ('');
            setOpen(false);
            setPending(null);
            onClose?.();
          }
          if (e.key === 'Enter' && local[0]) pickPlace(local[0]);
        }}
      />

      {open && term && (
        <div className="search-results">
          {loading && <div className="sr-empty">{t('搜索中…')}</div>}

          {!loading && local.length > 0 && (
            <>
              <div className="sr-group">{t('我的足迹')}</div>
              {local.map((p) => (
                <button key={p.id} className="sr-item" onClick={() => pickPlace(p)}>
                  <span className="sr-name">{p.name}</span>
                  <span className="sr-meta">
                    {[tp(p.province), p.city].filter(Boolean).join(' · ')}
                    {p.kind === 'wishlist'
                      ? ' · ' + t('想去')
                      : p.visit_count
                        ? ' · ' + t('去过 {n} 次', { n: p.visit_count })
                        : ''}
                  </span>
                </button>
              ))}
            </>
          )}

          {!loading && pois.length > 0 && (
            <>
              <div className="sr-group">{t('地图地点')}</div>
              {pois.map((p) => {
                const key = `${p.name}-${p.lnglat}`;
                const isPending = pending?.name === p.name && pending?.lnglat === p.lnglat;
                return (
                  <div key={key} className="sr-poi">
                    <button className="sr-item" onClick={() => pickPoi(p)}>
                      <span className="sr-name">
                        {p.name}
                        {p.source === 'geocode' && <span className="r-tag">{t('行政区')}</span>}
                      </span>
                      <span className="sr-meta">{p.address || '—'}</span>
                    </button>
                    {isPending && !readOnly && (
                      <button
                        className="sr-add"
                        onClick={() => {
                          onAddPoi(p);
                          setOpen(false);
                          setQ('');
                          setPending(null);
                        }}
                      >
                        {t('+ 添加为足迹')}
                      </button>
                    )}
                  </div>
                );
              })}
            </>
          )}

          {!loading && empty && <div className="sr-empty">{t('没找到「{term}」', { term })}</div>}
        </div>
      )}
    </div>
  );
}
