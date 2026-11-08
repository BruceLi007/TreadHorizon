import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import type { Place, PlaceDetail } from '../lib/types';
import PlaceGroupList from './PlaceGroupList';
import SortToggle, { type SortOrder } from './SortToggle';
import { useT, useTp, type TFn, type TPfn } from '../i18n';
import CloseIcon from './CloseIcon';

interface Props {
  /** 要被合并掉的地点（来源） */
  from: PlaceDetail;
  onClose: () => void;
  onMerged: (place: PlaceDetail) => void;
}

const region = (
  p: { province?: string | null; city?: string | null; county?: string | null },
  t: TFn,
  tp: TPfn
) => [tp(p.province), p.city, p.county].filter(Boolean).join(' · ') || t('未标注地区');

/**
 * 合并重复地点（F-PLC-08 / D-28）
 *
 * 选一个已有地点作为目标：所有到访/媒体迁过去，来源地点软删；保留目标名称和坐标。
 * 省市不一致时服务端返回 needConfirm，这里做二次确认。
 */
export default function MergePanel({ from, onClose, onMerged }: Props) {
  const t = useT();
  const tp = useTp();
  const [all, setAll] = useState<Place[]>([]);
  const [q, setQ] = useState('');
  const [chosen, setChosen] = useState<Place | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /** 候选列表排序方向：默认最近在前；asc 时省 / 市 / 地点整体反转 */
  const [order, setOrder] = useState<SortOrder>('desc');
  const [needConfirm, setNeedConfirm] = useState<null | {
    from?: { name?: string | null; province?: string | null; city?: string | null; county?: string | null };
    into?: { name?: string | null; province?: string | null; city?: string | null; county?: string | null };
  }>(null);

  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const list = await api.places();
        if (!dead) setAll(list);
      } catch (e: any) {
        if (!dead) setErr(t('读取地点失败：{msg}', { msg: e?.message || e }));
      } finally {
        if (!dead) setLoading(false);
      }
    })();
    return () => {
      dead = true;
    };
  }, []);

  const candidates = useMemo(() => {
    const term = q.trim();
    return all.filter((p) => {
      if (p.id === from.id) return false;
      if (p.kind !== from.kind) return false;
      if (!term) return true;
      return [p.name, p.province, p.city, p.county].filter(Boolean).join(' ').includes(term);
    });
  }, [all, q, from.id, from.kind]);

  const doMerge = async (force = false) => {
    if (!chosen) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.mergePlaces(from.id, chosen.id, force);
      if (r.needConfirm) {
        setNeedConfirm({ from: r.from, into: r.into });
        return;
      }
      if (r.place) onMerged(r.place);
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="panel merge-panel">
      <div className="panel-head">
        <span className="title">{t('合并重复地点')}</span>
        <button className="icon" onClick={onClose} aria-label={t('关闭')}>
          <CloseIcon />
        </button>
      </div>

      <div className="subhead">
        <div className="region">
          {t('把「{name}」合并到下面选中的地点', { name: from.name })}
          <span className="merge-hint-inline">{t('（保留目标名称/坐标，来源软删）')}</span>
        </div>
      </div>

      <div className="search" style={{ paddingTop: 10 }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('按名称 / 省市区找目标地点')}
          spellCheck={false}
        />
      </div>

      <div className="st-list-head">
        <span className="st-list-title">{t('候选地点')}</span>
        <SortToggle
          order={order}
          onChange={setOrder}
          title={t('切换候选地点排序：最近去过的在前 / 最早去过的在前')}
        />
      </div>

      <div className="visits" style={{ paddingTop: 4 }}>
        {loading && <div className="muted pad">{t('读取地点…')}</div>}
        {!loading && (
          <PlaceGroupList
            places={candidates}
            forceExpand={q.trim().length > 0}
            selectedId={chosen?.id ?? null}
            sortOrder={order}
            onPick={(p) => {
              setChosen(p);
              setNeedConfirm(null);
              setErr(null);
            }}
            emptyText={t('没有可合并的同类地点。合并要求两个地点类型相同（都去过或都想去）。')}
          />
        )}
      </div>

      {chosen && (
        <div className="merge-target">
          {t('合并到：')}
          <b>{chosen.name}</b>
          {t('（{region}）', { region: region(chosen, t, tp) })}
        </div>
      )}

      {needConfirm && (
        <div className="confirm-del merge-warn">
          <div className="confirm-text">
            <b>{t('这两个地点的省/市不一致')}</b>
            <small>
              {t('来源：{province} {city}', {
                province: tp(needConfirm.from?.province) || '?',
                city: needConfirm.from?.city || '',
              })}
              <br />
              {t('目标：{province} {city}', {
                province: tp(needConfirm.into?.province) || '?',
                city: needConfirm.into?.city || '',
              })}
              <br />
              {t('确认不是误合并再继续；合并后到访会全部迁到目标地点，来源软删（M3 回收站可恢复）。')}
            </small>
          </div>
          <div className="row">
            <button className="ghost" onClick={() => setNeedConfirm(null)} disabled={busy}>
              {t('取消')}
            </button>
            <button className="danger-btn" onClick={() => doMerge(true)} disabled={busy}>
              {busy ? t('合并中…') : t('仍然合并')}
            </button>
          </div>
        </div>
      )}

      {err && <p className="hint err merge-err">{err}</p>}

      <div className="panel-foot">
        <button className="ghost" onClick={onClose} disabled={busy}>
          {t('取消')}
        </button>
        <button
          className="primary"
          onClick={() => doMerge(false)}
          disabled={!chosen || busy || Boolean(needConfirm)}
        >
          {busy ? t('合并中…') : t('确认合并')}
        </button>
      </div>
      <div className="merge-hint">
        {t('合并只会把到访和照片记录移到目标地点，不会移动或删除素材库里的文件。')}
      </div>
    </aside>
  );
}
