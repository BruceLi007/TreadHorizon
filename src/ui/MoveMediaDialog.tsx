import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../lib/api';
import type { Place, PlaceDetail } from '../lib/types';
import { useT, useTp } from '../i18n';
import CloseIcon from './CloseIcon';
import './ConfirmDialog.css';

interface Props {
  open: boolean;
  /** 要移动的文件数（标题与确认文案用） */
  count: number;
  /** 当前地点：排除，不能把照片「移动」到原地 */
  fromPlaceId: string;
  onClose: () => void;
  /** 确认移动；返回 true 表示全部成功（父层负责收尾 / 关闭） */
  onConfirm: (visitId: string) => Promise<boolean>;
}

type Step = 'province' | 'city' | 'place' | 'visit';

/**
 * 2026-11-15 D-439（用户要求）：把选中的照片/视频移动到**其他省 / 市 / 地点 / 到访**。
 *
 * 原来的「移动到别的到访」只能在同一地点内换到访；这个弹窗按 省 → 市 → 地点 → 到访
 * 四级下钻，也可以直接在搜索框里找地点。只列「去过」的地点（想去的地点没有到访可落）。
 */
export default function MoveMediaDialog({ open, count, fromPlaceId, onClose, onConfirm }: Props) {
  const t = useT();
  const tp = useTp();
  const [places, setPlaces] = useState<Place[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [prov, setProv] = useState<string | null>(null);
  const [city, setCity] = useState<string | null>(null);
  const [place, setPlace] = useState<Place | null>(null);
  const [detail, setDetail] = useState<PlaceDetail | null>(null);
  const [visitId, setVisitId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setQ('');
    setProv(null);
    setCity(null);
    setPlace(null);
    setDetail(null);
    setVisitId(null);
    setErr('');
    let dead = false;
    setLoading(true);
    api
      .places()
      .then((list) => {
        if (!dead) {
          setPlaces(list.filter((p) => p.id !== fromPlaceId && p.kind !== 'wishlist'));
        }
      })
      .catch((e: any) => {
        if (!dead) setErr(t('读取地点失败：{msg}', { msg: e?.message || e }));
      })
      .finally(() => {
        if (!dead) setLoading(false);
      });
    return () => {
      dead = true;
    };
  }, [open, fromPlaceId, t]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, busy, onClose]);

  const NA = t('未标注');
  const step: Step = place ? 'visit' : city ? 'place' : prov ? 'city' : 'province';

  const provinces = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of places) {
      const k = p.province || NA;
      m.set(k, (m.get(k) || 0) + 1);
    }
    return [...m].sort((a, b) => a[0].localeCompare(b[0], 'zh-CN'));
  }, [places, NA]);

  const cities = useMemo(() => {
    if (!prov) return [];
    const m = new Map<string, number>();
    for (const p of places) {
      if ((p.province || NA) !== prov) continue;
      const k = p.city || NA;
      m.set(k, (m.get(k) || 0) + 1);
    }
    return [...m].sort((a, b) => a[0].localeCompare(b[0], 'zh-CN'));
  }, [places, prov, NA]);

  const inCity = useMemo(() => {
    if (!prov || !city) return [];
    return places
      .filter((p) => (p.province || NA) === prov && (p.city || NA) === city)
      .sort((a, b) => String(b.last_date || '').localeCompare(String(a.last_date || '')));
  }, [places, prov, city, NA]);

  const hits = useMemo(() => {
    const kw = q.trim().toLowerCase();
    if (!kw) return [];
    return places
      .filter((p) =>
        [p.name, p.province, p.city, p.county]
          .filter(Boolean)
          .some((x) => String(x).toLowerCase().includes(kw))
      )
      .slice(0, 60);
  }, [places, q]);

  const pickPlace = async (p: Place) => {
    setPlace(p);
    setVisitId(null);
    setErr('');
    setLoading(true);
    try {
      const d = await api.place(p.id);
      setDetail(d);
      if (d.visits.length === 1) setVisitId(d.visits[0].id);
    } catch (e: any) {
      setErr(t('读取到访失败：{msg}', { msg: e?.message || e }));
    } finally {
      setLoading(false);
    }
  };

  const goProvince = () => {
    setProv(null);
    setCity(null);
    setPlace(null);
    setDetail(null);
    setVisitId(null);
    setQ('');
  };
  const goCity = () => {
    setCity(null);
    setPlace(null);
    setDetail(null);
    setVisitId(null);
  };
  const goPlace = () => {
    setPlace(null);
    setDetail(null);
    setVisitId(null);
  };

  const doMove = async () => {
    if (!visitId || busy) return;
    setBusy(true);
    setErr('');
    const ok = await onConfirm(visitId);
    setBusy(false);
    if (ok) onClose();
    else setErr(t('移动失败，请重试'));
  };

  if (!open) return null;

  const placeRow = (p: Place) => (
    <button type="button" className="move-item" key={p.id} onClick={() => void pickPlace(p)}>
      <span className="name">{p.name}</span>
      <span className="meta">
        {[p.county, p.last_date].filter(Boolean).join(' · ')}
      </span>
    </button>
  );

  return createPortal(
    <div
      className="cd-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        className="cd-card move-dialog-card"
        role="dialog"
        aria-modal="true"
        aria-label={t('移动 {n} 个文件到…', { n: count })}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="cd-head">
          <h3 className="cd-title">{t('移动 {n} 个文件到…', { n: count })}</h3>
          <button
            type="button"
            className="icon cd-close"
            onClick={onClose}
            disabled={busy}
            aria-label={t('关闭')}
            title={t('关闭')}
          >
            <CloseIcon size={12} />
          </button>
        </div>

        <div className="move-crumbs">
          <button type="button" className={step === 'province' ? 'on' : ''} onClick={goProvince}>
            {t('全部省份')}
          </button>
          {prov && (
            <>
              <span className="sep">›</span>
              <button type="button" className={step === 'city' ? 'on' : ''} onClick={() => { setCity(null); setPlace(null); setDetail(null); setVisitId(null); }}>
                {tp(prov)}
              </button>
            </>
          )}
          {city && (
            <>
              <span className="sep">›</span>
              <button type="button" className={step === 'place' ? 'on' : ''} onClick={goCity}>
                {city}
              </button>
            </>
          )}
          {place && (
            <>
              <span className="sep">›</span>
              <button type="button" className={step === 'visit' ? 'on' : ''} onClick={goPlace}>
                {place.name}
              </button>
            </>
          )}
        </div>

        {(step === 'province' || q.trim()) && (
          <div className="move-search">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('搜索地点 / 省 / 市')}
              aria-label={t('搜索地点 / 省 / 市')}
            />
          </div>
        )}

        <div className="move-dialog-body">
          {err && <p className="share-error-text">{err}</p>}
          {loading ? (
            <p className="move-empty">{t('正在读取…')}</p>
          ) : q.trim() ? (
            hits.length ? (
              <div className="move-list">{hits.map(placeRow)}</div>
            ) : (
              <p className="move-empty">{t('没有匹配的地点')}</p>
            )
          ) : step === 'province' ? (
            <div className="move-list">
              {provinces.map(([name, n]) => (
                <button
                  type="button"
                  className="move-item"
                  key={name}
                  onClick={() => {
                    setProv(name);
                    setCity(null);
                  }}
                >
                  <span className="name">{tp(name)}</span>
                  <span className="meta">{t('{n} 个地点', { n })}</span>
                </button>
              ))}
              {!provinces.length && <p className="move-empty">{t('还没有可移动到的地点')}</p>}
            </div>
          ) : step === 'city' ? (
            <div className="move-list">
              {cities.map(([name, n]) => (
                <button
                  type="button"
                  className="move-item"
                  key={name}
                  onClick={() => {
                    setCity(name);
                  }}
                >
                  <span className="name">{name}</span>
                  <span className="meta">{t('{n} 个地点', { n })}</span>
                </button>
              ))}
              {!cities.length && <p className="move-empty">{t('这个省还没有其它地点')}</p>}
            </div>
          ) : step === 'place' ? (
            <div className="move-list">
              {inCity.map(placeRow)}
              {!inCity.length && <p className="move-empty">{t('这个市还没有其它地点')}</p>}
            </div>
          ) : (
            <div className="move-list">
              {(detail?.visits ?? []).map((v) => (
                <button
                  type="button"
                  className={'move-item' + (visitId === v.id ? ' on' : '')}
                  key={v.id}
                  onClick={() => setVisitId(v.id)}
                  aria-pressed={visitId === v.id}
                >
                  <span className="name">
                    {v.date}
                    {v.title ? ` · ${v.title}` : ''}
                  </span>
                  <span className="meta">{t('{n} 个文件', { n: v.media.length })}</span>
                </button>
              ))}
              {detail && detail.visits.length === 0 && (
                <p className="move-empty">{t('这个地点还没有到访记录，换一个地点吧')}</p>
              )}
            </div>
          )}
        </div>

        <div className="cd-actions">
          <button type="button" className="ghost" onClick={onClose} disabled={busy}>
            {t('取消')}
          </button>
          {step !== 'province' && !q.trim() && (
            <button
              type="button"
              className="ghost"
              disabled={busy}
              onClick={step === 'city' ? goProvince : step === 'place' ? goCity : goPlace}
            >
              {t('返回')}
            </button>
          )}
          <button
            type="button"
            className="primary"
            onClick={() => void doMove()}
            disabled={!visitId || busy}
            title={visitId ? '' : t('先选一次到访')}
          >
            {busy ? t('移动中…') : t('移动到这次到访')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
