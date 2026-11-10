/**
 * 2026-11-10 D-355（用户要求）：设置 → 素材库 →「重复照片检测」。
 *
 * 背景：上传查重已扩展到「同账号全库」（D-354），但历史库里已经存在的跨到访重复需要工具来清理。
 * 用户拍板：① 应用内做检测工具；② 每组默认保留**最早添加**的一份，其余副本默认预选，可手动改。
 *
 * 行为：
 * - 打开素材库页时自动扫描一次（只读 DB 查询，开销很小），也可点「重新扫描」；
 * - 按内容 hash 分组，列出每份的缩略图 / 文件名 / 地点 · 到访日期 / 大小 / 添加时间；
 * - 每组默认勾选「除最早添加以外的所有副本」，「保留最早一份」可重置该组；
 * - 点「把所选 N 份移到回收站」→ 二次确认 → 服务端软删（可恢复），每组至少保留 1 份；
 * - 清理后自动重新扫描并通知 App 刷新（回收站角标 / 照片墙等）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api';
import { formatBytes } from '../../lib/bytes';
import type { DuplicateMediaGroup, DuplicateScanResult } from '../../lib/types';
import { useT } from '../../i18n';
import ConfirmDialog from '../ConfirmDialog';

interface Props {
  /** 清理后通知 App 刷新回收站角标 / 地图 / 照片墙 */
  onChanged: () => void;
}

const pad2 = (n: number) => String(n).padStart(2, '0');
const fmtDate = (s?: string | null) => (s ? s.replace(/-/g, '.') : '—');
const fmtTime = (ms?: number) => {
  if (!Number.isFinite(ms ?? NaN)) return '—';
  const d = new Date(Number(ms));
  return `${d.getFullYear()}.${pad2(d.getMonth() + 1)}.${pad2(d.getDate())} ${pad2(
    d.getHours()
  )}:${pad2(d.getMinutes())}`;
};

export default function DuplicateMediaSettings({ onChanged }: Props) {
  const t = useT();
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState<DuplicateScanResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /**
   * 2026-11-10 D-355 追加（用户问「重复太多列表是不是很长」）：
   * 组默认**折叠**（只显示一行组头），点组头展开明细；一次最多渲染 20 组，底部「加载更多」。
   */
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const [visibleCount, setVisibleCount] = useState(20);

  const scan = useCallback(async () => {
    setScanning(true);
    setErr(null);
    try {
      const r = await api.duplicateMedia();
      setResult(r);
      // 默认预选：每组除「最早添加」那一份以外的全部副本
      const next = new Set<string>();
      for (const g of r.groups) for (const it of g.items.slice(1)) next.add(it.id);
      setSelected(next);
      setOpenGroups(new Set());
      setVisibleCount(20);
    } catch (e: any) {
      setErr(t('扫描失败：{msg}', { msg: e?.message || String(e) }));
    } finally {
      setScanning(false);
    }
  }, [t]);

  // 打开素材库页就扫描一次（只读、很快；失败不阻塞其它设置）
  useEffect(() => {
    void scan();
  }, [scan]);

  const extraCopies = result?.extraCopies ?? 0;
  const extraBytes = result?.extraBytes ?? 0;

  const selectedBytes = useMemo(() => {
    if (!result) return 0;
    let n = 0;
    for (const g of result.groups) {
      for (const it of g.items) if (selected.has(it.id)) n += it.bytes ?? 0;
    }
    return n;
  }, [result, selected]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /** 改回「保留最早一份」：该组只勾选最早那份以外的副本 */
  const keepEarliest = (g: DuplicateMediaGroup) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const it of g.items) next.delete(it.id);
      for (const it of g.items.slice(1)) next.add(it.id);
      return next;
    });

  const toggleGroupOpen = (hash: string) =>
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(hash)) next.delete(hash);
      else next.add(hash);
      return next;
    });

  /** 组头复选框：选中 / 取消本组全部「多余副本」（最早那份始终不自动勾选） */
  const extrasOf = (g: DuplicateMediaGroup) => g.items.slice(1);
  const groupExtrasAllSelected = (g: DuplicateMediaGroup) =>
    extrasOf(g).length > 0 && extrasOf(g).every((it) => selected.has(it.id));
  const toggleGroupExtras = (g: DuplicateMediaGroup) =>
    setSelected((prev) => {
      const next = new Set(prev);
      const all = groupExtrasAllSelected(g);
      for (const it of extrasOf(g)) {
        if (all) next.delete(it.id);
        else next.add(it.id);
      }
      return next;
    });

  const selectedCount = selected.size;

  const runTrash = async () => {
    if (!selectedCount) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const r = await api.trashDuplicateMedia([...selected]);
      setAsk(false);
      let text = t('已把 {n} 份重复素材移到回收站（可在回收站恢复；彻底删除后约释放 {size}）', {
        n: r.trashed,
        size: formatBytes(r.bytes ?? 0),
      });
      if (r.keptLast > 0) {
        text += t(' · {n} 组因为勾选了全部副本，已自动保留每组最早的一份', {
          n: r.keptLast,
        });
      }
      setMsg(text);
      onChanged();
      await scan();
    } catch (e: any) {
      setErr(t('清理失败：{msg}', { msg: e?.message || String(e) }));
      setAsk(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="set-section set-dup">
      <div className="set-section-head">
        <h3 className="set-section-title">{t('重复照片检测')}</h3>
        <button type="button" className="text-btn sm" onClick={() => void scan()} disabled={scanning || busy}>
          {scanning ? t('扫描中…') : t('重新扫描')}
        </button>
      </div>
      <p className="set-section-desc">
        {t(
          '按内容查重（文件字节完全一致）：同一张照片 / 视频被上传到多个到访、或重复导入时，会归到同一组。默认每组保留最早添加的一份，勾选其余副本后可以移到回收站（可恢复，不会直接删除文件）；彻底删除才会释放磁盘空间。'
        )}
      </p>

      {err && <p className="hint err">{err}</p>}

      {scanning && !result && <p className="hint">{t('加载中…')}</p>}

      {result && (
        <>
          {result.totalGroups === 0 ? (
            <p className="hint">{t('没有发现重复素材。')}</p>
          ) : (
            <>
              <p className="set-dup-summary">
                {t('发现 {groups} 组重复 · 多出 {extra} 份 · 彻底删除后最多可释放约 {size}', {
                  groups: result.totalGroups,
                  extra: extraCopies,
                  size: formatBytes(extraBytes),
                })}
                {selectedCount > 0 && (
                  <>
                    {' · '}
                    {t('当前勾选 {n} 份（约 {size}）', {
                      n: selectedCount,
                      size: formatBytes(selectedBytes),
                    })}
                  </>
                )}
                {' · '}
                {t('已显示 {shown}/{total} 组', {
                  shown: Math.min(visibleCount, result.totalGroups),
                  total: result.totalGroups,
                })}
              </p>

              <div className="set-dup-groups">
                {result.groups.slice(0, visibleCount).map((g) => {
                  const open = openGroups.has(g.hash);
                  const gAll = groupExtrasAllSelected(g);
                  return (
                    <div className="set-dup-group" key={g.hash}>
                      <div className="set-dup-head">
                        <input
                          type="checkbox"
                          className="set-dup-group-check"
                          checked={gAll}
                          onChange={() => toggleGroupExtras(g)}
                          disabled={busy}
                          title={
                            gAll
                              ? t('取消本组多余副本的选择')
                              : t('选中本组多余副本（保留最早一份）')
                          }
                          aria-label={
                            gAll
                              ? t('取消本组多余副本的选择')
                              : t('选中本组多余副本（保留最早一份）')
                          }
                        />
                        <button
                          type="button"
                          className="set-dup-head-toggle"
                          onClick={() => toggleGroupOpen(g.hash)}
                          aria-expanded={open}
                          title={open ? t('收起分组') : t('展开分组')}
                        >
                          <span
                            className={open ? 'set-dup-caret open' : 'set-dup-caret'}
                            aria-hidden="true"
                          />
                          <span className="set-dup-title">
                            {t('重复内容 · {n} 份 · 每份约 {size}', {
                              n: g.count,
                              size: formatBytes(g.items[0]?.bytes ?? 0),
                            })}
                          </span>
                          <span className="set-dup-places">
                            {g.items.map((it) => it.placeName).join(' / ')}
                          </span>
                        </button>
                        <button
                          type="button"
                          className="text-btn sm"
                          onClick={() => keepEarliest(g)}
                          disabled={busy}
                        >
                          {t('保留最早一份')}
                        </button>
                      </div>
                      {open && (
                        <div className="set-dup-rows">
                          {g.items.map((it, idx) => {
                            const picked = selected.has(it.id);
                            return (
                              <label
                                key={it.id}
                                className={picked ? 'set-dup-row on' : 'set-dup-row'}
                              >
                                <input
                                  type="checkbox"
                                  checked={picked}
                                  onChange={() => toggle(it.id)}
                                  disabled={busy}
                                />
                                {it.kind === 'video' ? (
                                  <span className="set-dup-thumb set-dup-thumb-video">
                                    {t('视频')}
                                  </span>
                                ) : (
                                  <img
                                    className="set-dup-thumb"
                                    src={api.thumbUrl(it.id)}
                                    alt=""
                                    loading="lazy"
                                    onError={(e) => {
                                      e.currentTarget.style.visibility = 'hidden';
                                    }}
                                  />
                                )}
                                <span className="set-dup-main">
                                  <span className="set-dup-name" title={it.name}>
                                    {it.name}
                                  </span>
                                  <span className="set-dup-meta">
                                    {it.placeName} · {fmtDate(it.visitDate)} ·{' '}
                                    {formatBytes(it.bytes)} ·{' '}
                                    {t('添加于 {time}', { time: fmtTime(it.createdAt) })}
                                  </span>
                                </span>
                                {idx === 0 && (
                                  <span className="set-dup-keep-tag">{t('最早添加')}</span>
                                )}
                              </label>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {result.groups.length > visibleCount && (
                <button
                  type="button"
                  className="ghost full"
                  onClick={() => setVisibleCount((n) => n + 20)}
                >
                  {t('加载更多（还有 {n} 组）', { n: result.groups.length - visibleCount })}
                </button>
              )}

              <button
                type="button"
                className="primary full"
                onClick={() => setAsk(true)}
                disabled={!selectedCount || busy}
              >
                {t('把所选 {n} 份移到回收站', { n: selectedCount })}
              </button>
              <p className="hint">{t('每组至少保留一份；清理后可在 设置 → 回收站 恢复。')}</p>
            </>
          )}

          {msg && <p className="hint">{msg}</p>}
        </>
      )}

      {ask && (
        <ConfirmDialog
          title={t('把所选 {n} 份重复素材移到回收站？', { n: selectedCount })}
          confirmText={t('移到回收站')}
          busy={busy}
          busyText={t('处理中…')}
          onCancel={() => {
            if (!busy) setAsk(false);
          }}
          onConfirm={() => void runTrash()}
        >
          <p>{t('所选中包含 {n} 个文件，约 {size}。', { n: selectedCount, size: formatBytes(selectedBytes) })}</p>
          <p>
            {t(
              '每组至少保留一份；移到回收站后可在 设置 → 回收站 恢复，彻底删除后才会真正释放磁盘空间。你电脑上的原文件不受影响。'
            )}
          </p>
        </ConfirmDialog>
      )}
    </section>
  );
}
