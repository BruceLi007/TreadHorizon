import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useT, useTp, type TFn, type TPfn } from '../i18n';
import SortToggle, { type SortOrder } from './SortToggle';
import Segmented from './Segmented';
import CloseIcon from './CloseIcon';
import type {
  PurgeTrashResult,
  RestoreTrashResult,
  TrashData,
  TrashItem,
  TrashSelection,
} from '../lib/types';

interface Props {
  onClose: () => void;
  /** 恢复/彻底删除之后让 App 刷新地图、时间轴和顶部角标 */
  onChanged: () => void | Promise<void>;
  /** 嵌在设置窗口里时隐藏自带的标题栏/关闭按钮，去掉面板定位与背景 */
  embedded?: boolean;
}

type Tab = 'all' | 'place' | 'visit' | 'media';

const pad2 = (n: number) => String(n).padStart(2, '0');
const fmtTime = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}.${pad2(d.getMonth() + 1)}.${pad2(d.getDate())} ${pad2(
    d.getHours()
  )}:${pad2(d.getMinutes())}`;
};
const fmtDate = (s?: string | null) => (s ? s.replace(/-/g, '.') : '');
const fmtBytes = (n: number) => {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
};
const regionOf = (
  it: {
    province?: string | null;
    city?: string | null;
    county?: string | null;
  },
  tp: TPfn
) => [tp(it.province), it.city, it.county].filter(Boolean).join(' · ');
const itemKey = (it: TrashItem): string => `${it.type}:${it.id}`;
const typeLabel = (it: TrashItem, t: TFn) => {
  if (it.type === 'place') return t('地点||type');
  if (it.type === 'visit') return t('到访||type');
  return it.kind === 'video' ? t('视频||type') : t('照片||type');
};
const rowTitle = (it: TrashItem, t: TFn) => {
  if (it.type === 'place') return it.name;
  if (it.type === 'visit') return it.title || t('{date} 的到访', { date: fmtDate(it.date) });
  return it.name || t('{date} 的照片', { date: fmtDate(it.date) });
};
const mediaText = (n: number, t: TFn) => (n > 0 ? t('{n} 个照片/视频', { n }) : t('无媒体'));
const isRestorable = (it: TrashItem) => {
  if (it.type === 'place') return true;
  if (it.type === 'visit') return it.place_deleted_at == null;
  return !it.parent_visit_deleted && !it.parent_place_deleted;
};
const selOf = (it: TrashItem, restoreEarlier = false): TrashSelection =>
  restoreEarlier ? { type: it.type, id: it.id, restoreEarlier: true } : { type: it.type, id: it.id };
const earlierOf = (it: TrashItem) => {
  if (it.type === 'place') return { visits: it.earlier_visit_count, media: it.earlier_media_count };
  if (it.type === 'visit') return { visits: 0, media: it.earlier_media_count };
  return { visits: 0, media: 0 };
};
const earlierSizeOf = (it: TrashItem) =>
  it.type === 'place' || it.type === 'visit' ? it.earlier_size : 0;

/**
 * 回收站（F-SYS-07 / D-57）
 * 按删除动作分层：地点/到访/照片视频都留在自己当初被删的层级。
 * 父级行只统计随本次删除的子项；恢复父级时可选择是否连带此前单独删除的子项。
 * 彻底删除才删 B 库文件并释放空间；A 原件永远不动。
 */
export default function TrashPanel({ onClose, onChanged, embedded = false }: Props) {
  const t = useT();
  const tp = useTp();
  const [data, setData] = useState<TrashData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('all');
  /** 排序方向：默认最近删除的在前；asc 时只反转渲染顺序，计数/选择仍按原 items */
  const [order, setOrder] = useState<SortOrder>('desc');
  const [selected, setSelected] = useState<string[]>([]);
  const [purge, setPurge] = useState<{ items: TrashItem[]; all: boolean } | null>(null);
  /** 恢复父级时是否连带此前单独删除的子项 */
  const [restoreAsk, setRestoreAsk] = useState<{
    items: TrashItem[];
    includeEarlier: boolean;
    skipped: number;
  } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const next = await api.trash();
      setData(next);
      const alive = new Set(next.items.map(itemKey));
      setSelected((cur) => cur.filter((k) => alive.has(k)));
    } catch (e: any) {
      setErr(t('读取回收站失败：{msg}', { msg: e?.message || e }));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const items = data?.items ?? [];
  /** 服务端按删除时间倒序返回；asc 时客户端反转，不影响 selected 的 id 逻辑 */
  const orderedItems = useMemo(
    () => (order === 'desc' ? items : items.slice().reverse()),
    [items, order]
  );
  const tabItems = useMemo(() => {
    if (tab === 'all') return orderedItems;
    return orderedItems.filter((it) => it.type === tab);
  }, [orderedItems, tab]);
  const selectedItems = useMemo(
    () => items.filter((it) => selected.includes(itemKey(it))),
    [items, selected]
  );
  const allSelected = tabItems.length > 0 && tabItems.every((it) => selected.includes(itemKey(it)));
  const restorableSelected = selectedItems.filter(isRestorable);
  const skippedSelected = selectedItems.length - restorableSelected.length;

  const switchTab = (next: Tab) => {
    setTab(next);
    // 选择只对当前标签有效，避免“选了看不见的东西”
    setSelected([]);
    setRestoreAsk(null);
    setPurge(null);
  };

  const toggle = (key: string) =>
    setSelected((cur) => (cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]));
  const toggleAll = () => {
    const keys = tabItems.map(itemKey);
    setSelected((cur) =>
      allSelected ? cur.filter((k) => !keys.includes(k)) : [...new Set([...cur, ...keys])]
    );
  };

  const finishRestore = async (targets: TrashItem[], includeEarlier: boolean, skipped = 0) => {
    setBusy('restore');
    setErr(null);
    setMsg(null);
    try {
      const r: RestoreTrashResult = await api.restoreTrash(
        targets.map((it) =>
          selOf(it, includeEarlier && (it.type === 'place' || it.type === 'visit'))
        )
      );
      const keys = targets.map(itemKey);
      setSelected((cur) => cur.filter((k) => !keys.includes(k)));
      setRestoreAsk(null);
      const parts = [
        r.restoredPlaces ? t('{n} 个地点', { n: r.restoredPlaces }) : '',
        r.restoredVisits ? t('{n} 次到访', { n: r.restoredVisits }) : '',
        r.restoredMedia ? t('{n} 个照片/视频', { n: r.restoredMedia }) : '',
      ].filter(Boolean);
      let text = t('已恢复 {parts}', { parts: parts.join(' · ') || t('项目') });
      const extra = [
        r.restoredEarlierVisits
          ? t('{n} 次此前单独删除的到访', { n: r.restoredEarlierVisits })
          : '',
        r.restoredEarlierMedia
          ? t('{n} 张此前单独删除的照片', { n: r.restoredEarlierMedia })
          : '',
      ].filter(Boolean);
      if (extra.length) text += t(' · 含 {items}', { items: extra.join(' · ') });
      if (skipped) text += t(' · 跳过 {n} 项（需先恢复父级）', { n: skipped });
      setMsg(text);
      await load();
      await onChanged();
    } catch (e: any) {
      setErr(t('恢复失败：{msg}', { msg: e?.message || e }));
    } finally {
      setBusy(null);
    }
  };

  const requestRestore = (targets: TrashItem[]) => {
    const list = targets.filter(isRestorable);
    if (!list.length) return;
    if (list.length < targets.length) {
      setMsg(
        t('已跳过 {n} 项需要先恢复父级的记录', { n: targets.length - list.length })
      );
    } else {
      setMsg(null);
    }
    setErr(null);
    const earlier = list.reduce(
      (acc, it) => {
        const e = earlierOf(it);
        acc.visits += e.visits;
        acc.media += e.media;
        return acc;
      },
      { visits: 0, media: 0 }
    );
    if (earlier.visits || earlier.media) {
      setRestoreAsk({ items: list, includeEarlier: false, skipped: targets.length - list.length });
    } else {
      void finishRestore(list, false, targets.length - list.length);
    }
  };

  const startPurge = (targets: TrashItem[], all = false) => {
    if (!targets.length) return;
    setMsg(null);
    setErr(null);
    setRestoreAsk(null);
    setPurge({ items: targets, all });
  };

  const doPurge = async () => {
    if (!purge) return;
    setBusy('purge');
    setErr(null);
    setMsg(null);
    // 父级行可能还会带走此前单独删除的子项；用总占用封顶，避免显示超过实际
    const freeing = Math.min(
      data?.size ?? 0,
      purge.items.reduce((n, it) => n + it.size + earlierSizeOf(it), 0)
    );
    const keys = purge.items.map(itemKey);
    try {
      const r: PurgeTrashResult = await api.purgeTrash(purge.items.map((it) => selOf(it)));
      setSelected((cur) => cur.filter((k) => !keys.includes(k)));
      setPurge(null);
      const parts = [
        r.purgedPlaces ? t('{n} 个地点', { n: r.purgedPlaces }) : '',
        r.purgedVisits ? t('{n} 次到访', { n: r.purgedVisits }) : '',
        r.purgedMedia ? t('{n} 个照片/视频', { n: r.purgedMedia }) : '',
      ].filter(Boolean);
      let text = t('已彻底删除 {parts}，释放约 {size}', {
        parts: parts.join(' · ') || t('项目'),
        size: fmtBytes(freeing),
      });
      if (r.files) {
        text += t(' · 删除文件 {n} 个', { n: r.files.deleted });
        if (r.files.missing) text += t(' · 文件本就不在 {n} 个', { n: r.files.missing });
        if (r.files.errors?.length) text += t(' · {n} 个文件删除失败', { n: r.files.errors.length });
      }
      setMsg(text);
      if (r.files?.errors?.length) {
        setErr(
          t('部分文件没删掉（记录已清理，素材库里可能残留）：\n{items}', {
            items: r.files.errors.slice(0, 3).join('\n'),
          })
        );
      }
      await load();
      await onChanged();
    } catch (e: any) {
      setErr(t('彻底删除失败：{msg}', { msg: e?.message || e }));
    } finally {
      setBusy(null);
    }
  };

  const purgeSize = purge
    ? Math.min(
        data?.size ?? 0,
        purge.items.reduce((n, it) => n + it.size + earlierSizeOf(it), 0)
      )
    : 0;
  const purgeEarlier = purge
    ? purge.items.reduce(
        (acc, it) => {
          const e = earlierOf(it);
          acc.visits += e.visits;
          acc.media += e.media;
          return acc;
        },
        { visits: 0, media: 0 }
      )
    : { visits: 0, media: 0 };
  const restoreEarlierTotals = restoreAsk
    ? restoreAsk.items.reduce(
        (acc, it) => {
          const e = earlierOf(it);
          acc.visits += e.visits;
          acc.media += e.media;
          return acc;
        },
        { visits: 0, media: 0 }
      )
    : { visits: 0, media: 0 };

  const tabs: { key: Tab; label: string; count: number }[] = [
    { key: 'all', label: t('全部'), count: items.length },
    { key: 'place', label: t('地点'), count: data?.placeCount ?? 0 },
    { key: 'visit', label: t('到访'), count: data?.visitCount ?? 0 },
    { key: 'media', label: t('照片视频'), count: data?.mediaCount ?? 0 },
  ];

  const emptyText: Record<Tab, string> = {
    all: t('回收站是空的。删除的地点 / 到访 / 照片视频会先来到这里，确认不要了再彻底删除释放空间。'),
    place: t('没有单独删除的地点。'),
    visit: t('没有单独删除的到访。'),
    media: t('没有单独删除的照片/视频。'),
  };

  return (
    <aside className={embedded ? 'panel trash-panel-embedded' : 'panel'}>
      {embedded ? (
        <div className="trash-embedded-head">
          <span className="muted">
            {items.length > 0
              ? t('{n} 项待处理', { n: items.length })
              : t('暂无待处理内容')}
          </span>
          <div className="head-tools">
            <SortToggle
              order={order}
              onChange={setOrder}
              title={t('切换排序：最近删除的在前 / 最早删除的在前')}
            />
          </div>
        </div>
      ) : (
        <div className="panel-head">
          <span className="title">
            {t('回收站')}
            {items.length > 0 && <span className="count-inline">{items.length}</span>}
          </span>
          <div className="head-tools">
            <SortToggle
              order={order}
              onChange={setOrder}
              title={t('切换排序：最近删除的在前 / 最早删除的在前')}
            />
            <button className="icon" onClick={onClose} aria-label={t('关闭')}>
              <CloseIcon />
            </button>
          </div>
        </div>
      )}

      <div className="trash-summary">
        <div className="trash-summary-main">
          <span className="trash-size">{fmtBytes(data?.size ?? 0)}</span>
          <span className="muted">{t('回收站占用（原片 + 缩略图/预览缓存）')}</span>
        </div>
        <div className="trash-sub muted">
          {t('{media} 个照片/视频 · {places} 个地点 · {visits} 次到访', {
            media: data?.mediaTotal ?? 0,
            places: data?.placeCount ?? 0,
            visits: data?.visitCount ?? 0,
          })}
        </div>
      </div>

      <p className="hint trash-hint">
        {t('删除的内容先放这里，')}
        <b>{t('不会立刻释放空间')}</b>
        {t('；点「彻底删除」才会删 B 库文件并释放空间。 父级删除只带走当时还在的内容，之前单独删的会留在原层级。')}
      </p>

      <div className="trash-tabs">
        <Segmented<Tab>
          fill
          variant="tabs"
          ariaLabel={t('回收站分类')}
          options={tabs.map((tabDef) => ({
            id: tabDef.key,
            label: tabDef.label,
            count: tabDef.count,
          }))}
          value={tab}
          onChange={switchTab}
          disabled={!!busy}
        />
      </div>

      <div className="trash-toolbar">
        <label className="trash-selectall">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={toggleAll}
            disabled={!tabItems.length}
          />
          {t('全选')}
        </label>
        <span className="muted">{t('已选 {n} 项', { n: selectedItems.length })}</span>
        <span style={{ flex: 1 }} />
        <button
          className="text-btn danger"
          onClick={() => startPurge(items, true)}
          disabled={!items.length || !!busy}
        >
          {t('清空回收站')}
        </button>
        <button className="text-btn" onClick={load} disabled={loading || !!busy}>
          {t('刷新')}
        </button>
      </div>

      {restoreAsk && (
        <div className="confirm-del trash-confirm">
          <div className="confirm-text">
            {t('恢复 {n} 项？', { n: restoreAsk.items.length })}
            <small>
              {t('所选中有')}{' '}
              {[
                restoreEarlierTotals.visits
                  ? t('{n} 次到访', { n: restoreEarlierTotals.visits })
                  : '',
                restoreEarlierTotals.media
                  ? t('{n} 张照片/视频', { n: restoreEarlierTotals.media })
                  : '',
              ]
                .filter(Boolean)
                .join(' / ')}{' '}
              {t('是此前单独删除的，默认不随父级恢复。')}
            </small>
          </div>
          <label className="trash-file-opt">
            <input
              type="checkbox"
              checked={restoreAsk.includeEarlier}
              onChange={(e) => setRestoreAsk({ ...restoreAsk, includeEarlier: e.target.checked })}
            />
            <span>
              {t('同时恢复此前单独删除的子项')}
              <small>{t('不勾选的话，它们会继续留在回收站里，之后可单独恢复。')}</small>
            </span>
          </label>
          <div className="row">
            <button className="ghost" onClick={() => setRestoreAsk(null)} disabled={!!busy}>
              {t('取消')}
            </button>
            <button
              className="primary"
              onClick={() =>
                finishRestore(
                  restoreAsk.items,
                  restoreAsk.includeEarlier,
                  restoreAsk.skipped
                )
              }
              disabled={!!busy}
            >
              {busy === 'restore' ? t('恢复中…') : t('恢复')}
            </button>
          </div>
        </div>
      )}

      {purge && (
        <div className="confirm-del trash-confirm">
          <div className="confirm-text">
            {purge.all
              ? t('清空回收站')
              : t('彻底删除 {n} 项', { n: purge.items.length })}
            {t('，释放约')} <b>{fmtBytes(purgeSize)}</b>
            {t('？')}
            <small>
              {t('数据库记录和 B 库里的原片、缩略图/预览/封面帧缓存会')}
              <b>{t('永久删除，无法恢复')}</b>
              {t('； 你的本地原件 A 不受影响。')}
              {purgeEarlier.visits || purgeEarlier.media
                ? t(' 会连带清理此前单独删除的 {items}。', {
                    items: [
                      purgeEarlier.visits
                        ? t('{n} 次到访', { n: purgeEarlier.visits })
                        : '',
                      purgeEarlier.media
                        ? t('{n} 张照片/视频', { n: purgeEarlier.media })
                        : '',
                    ]
                      .filter(Boolean)
                      .join(' / '),
                  })
                : ''}
            </small>
          </div>
          <div className="row">
            <button className="ghost" onClick={() => setPurge(null)} disabled={!!busy}>
              {t('取消')}
            </button>
            <button className="danger-btn" onClick={doPurge} disabled={!!busy}>
              {busy === 'purge' ? t('删除中…') : t('确认彻底删除')}
            </button>
          </div>
        </div>
      )}

      <div className="visits">
        {loading && !data && <div className="muted pad">{t('读取中…')}</div>}

        {!loading && tabItems.length === 0 && <div className="muted pad">{emptyText[tab]}</div>}

        {tab === 'all' && (data?.mediaTotal ?? 0) > (data?.mediaCount ?? 0) && (
          <p className="hint trash-note">
            {t('另有 {n} 个照片/视频随已删地点/到访折叠； 恢复父级时可以选择是否一并恢复。', {
              n: Math.max(0, (data?.mediaTotal ?? 0) - (data?.mediaCount ?? 0)),
            })}
          </p>
        )}

        {tabItems.map((it) => {
          const key = itemKey(it);
          const isSel = selected.includes(key);
          const restorable = isRestorable(it);
          const earlier = earlierOf(it);
          return (
            <div
              key={key}
              className={isSel ? 'trash-row on' : 'trash-row'}
              role="checkbox"
              aria-checked={isSel}
              tabIndex={0}
              onClick={() => toggle(key)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  toggle(key);
                }
              }}
            >
              <input
                className="trash-check"
                type="checkbox"
                checked={isSel}
                onClick={(e) => e.stopPropagation()}
                onChange={() => toggle(key)}
              />
              {it.type === 'media' && (
                <img
                  className="trash-thumb"
                  src={api.thumbUrl(it.id)}
                  alt=""
                  loading="lazy"
                  onError={(e) => {
                    e.currentTarget.style.visibility = 'hidden';
                  }}
                />
              )}
              <div className="trash-main">
                <div className="trash-title">
                  <span className={`trash-type ${it.type}`}>{typeLabel(it, t)}</span>
                  {rowTitle(it, t)}
                  {it.type === 'place' && it.kind === 'wishlist' && (
                    <span className="kind-wish">{t('想去')}</span>
                  )}
                </div>
                <div className="trash-meta">
                  {it.type === 'place' && (
                    <>
                      {regionOf(it, tp) || t('未标注地区')}
                      {t(' · 本次删除 {n} 次到访 · ', { n: it.visit_count })}
                      {mediaText(it.media_count, t)}
                      {earlier.visits > 0 &&
                        t(' · 另有 {n} 次到访此前单独删除', { n: earlier.visits })}
                      {earlier.media > 0 &&
                        t(' · 另有 {n} 张照片此前单独删除', { n: earlier.media })}
                    </>
                  )}
                  {it.type === 'visit' && (
                    <>
                      {it.place_name}
                      {it.province
                        ? t('（{region}）', {
                            region: [tp(it.province), it.city].filter(Boolean).join(' '),
                          })
                        : ''}{' '}
                      · {fmtDate(it.date)}
                      {t(' · 本次删除 ')}
                      {mediaText(it.media_count, t)}
                      {earlier.media > 0 &&
                        t(' · 另有 {n} 张照片此前单独删除', { n: earlier.media })}
                    </>
                  )}
                  {it.type === 'media' && (
                    <>
                      {it.place_name} · {fmtDate(it.date)} · {fmtBytes(it.size)}
                      {it.parent_place_deleted
                        ? t(' · 所属地点在回收站，需先恢复地点')
                        : it.parent_visit_deleted
                          ? t(' · 所属到访在回收站，需先恢复到访')
                          : ''}
                    </>
                  )}
                </div>
                <div className="trash-meta deleted-at">
                  {t('删除于 {time}', { time: fmtTime(it.deleted_at) })}
                  {it.type !== 'media'
                    ? t(' · 本次占 {size}', { size: fmtBytes(it.size) })
                    : ''}
                </div>
              </div>
              <div className="trash-actions" onClick={(e) => e.stopPropagation()}>
                <button
                  className="text-btn"
                  onClick={() => requestRestore([it])}
                  disabled={!!busy || !restorable}
                  title={
                    restorable ? t('恢复这条记录') : t('所属父级还在回收站，请先恢复父级')
                  }
                >
                  {t('恢复')}
                </button>
                <button
                  className="text-btn danger"
                  onClick={() => startPurge([it])}
                  disabled={!!busy}
                  title={t('彻底删除并释放空间，无法恢复')}
                >
                  {t('彻底删除')}
                </button>
              </div>
            </div>
          );
        })}

        {msg && <p className="hint pad">{msg}</p>}
        {err && (
          <p className="hint err pad" style={{ whiteSpace: 'pre-line' }}>
            {err}
          </p>
        )}
      </div>

      <div className="panel-foot">
        <button
          className="ghost"
          onClick={() => requestRestore(selectedItems)}
          disabled={!restorableSelected.length || !!busy}
          title={
            skippedSelected
              ? t('{n} 项需要先恢复父级，已跳过', { n: skippedSelected })
              : undefined
          }
        >
          {t('恢复所选')}
          {restorableSelected.length ? ` (${restorableSelected.length})` : ''}
        </button>
        <button
          className="danger-btn"
          onClick={() => startPurge(selectedItems)}
          disabled={!selectedItems.length || !!busy}
        >
          {t('彻底删除所选')}
        </button>
      </div>
    </aside>
  );
}
