import { useCallback, useEffect, useState } from 'react';
import { api, type MyShareRow } from '../../lib/api';
import { useT } from '../../i18n';
import '../ShareSelection.css';

const COLLAPSED = 3;

const fmtBytes = (n: number) => {
  const v = Number(n) || 0;
  if (v >= 1024 ** 2) return `${(v / 1024 ** 2).toFixed(1)} MB`;
  if (v >= 1024) return `${(v / 1024).toFixed(0)} KB`;
  return `${v} B`;
};

const pad = (n: number) => String(n).padStart(2, '0');
const fmtTime = (ms: number | null) => {
  if (ms == null) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/**
 * 2026-11-15 D-424（用户要求）：设置 → 素材库下方单独一栏「我的分享」。
 * 原来这块列表塞在「分享」上传弹窗里，弹窗太挤；现在搬到设置里，上传弹窗只负责上传。
 */
export default function SharesSettings() {
  const t = useT();
  const [rows, setRows] = useState<MyShareRow[]>([]);
  const [usage, setUsage] = useState<{
    sharesBytes: number;
    shareCount: number;
    views: number;
    visitors: number;
  } | null>(null);
  const [error, setError] = useState('');
  const [revokeId, setRevokeId] = useState<string | null>(null);
  const [openRows, setOpenRows] = useState<Set<string>>(() => new Set());
  const [listExpanded, setListExpanded] = useState(false);

  const load = useCallback(async () => {
    try {
      const [list, u] = await Promise.all([api.myShares(), api.shareUsage()]);
      setRows(list.items);
      setUsage(u);
      setError('');
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleRow = (id: string) =>
    setOpenRows((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* ignore */
    }
  };

  const revoke = async (id: string) => {
    try {
      await api.revokeShare(id);
      setRevokeId(null);
      await load();
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  };

  return (
    <section className="set-section">
      <p className="set-section-desc">
        {usage
          ? t('分享占用 {size} · 共 {n} 份 · 被打开 {views} 次 · 独立访客 {visitors} 人', {
              size: fmtBytes(usage.sharesBytes),
              n: usage.shareCount,
              views: usage.views,
              visitors: usage.visitors,
            })
          : t('已上传的分享链接：有效期、访问统计与撤销都在这里。')}
      </p>

      {error && <p className="share-error-text">{error}</p>}
      {rows.length === 0 && <p className="share-note">{t('还没有分享。')}</p>}

      {(listExpanded ? rows : rows.slice(0, COLLAPSED)).map((r) => (
        <div className={'myshare-row' + (openRows.has(r.id) ? ' open' : '')} key={r.id}>
          <div className="myshare-head">
            <div className="myshare-main">
              <div className="myshare-title-line">
                <b>{r.title || t('未命名分享')}</b>
              </div>
            </div>
            <div className="myshare-actions">
              <span
                className={
                  'myshare-status ' +
                  (r.status === 'ok' ? 'ok' : r.status === 'revoked' ? 'revoked' : 'expired')
                }
              >
                {r.status === 'ok' ? t('有效') : r.status === 'revoked' ? t('已撤销') : t('已过期')}
              </span>
              {r.status === 'ok' && (
                <>
                  <button type="button" className="ghost" onClick={() => void copy(r.url)}>
                    {t('复制链接')}
                  </button>
                  <a className="ghost link" href={r.url} target="_blank" rel="noreferrer">
                    {t('预览')}
                  </a>
                </>
              )}
              {/* D-428：详情按钮从标题行挪到右侧操作组，样式与「预览」一致（同为 .ghost 胶囊、同高） */}
              <button
                type="button"
                className="ghost"
                onClick={() => toggleRow(r.id)}
                aria-expanded={openRows.has(r.id)}
              >
                {openRows.has(r.id) ? t('收起') : t('详情')}
              </button>
              {r.status === 'ok' &&
                (revokeId === r.id ? (
                  <button type="button" className="danger" onClick={() => void revoke(r.id)}>
                    {t('确认撤销')}
                  </button>
                ) : (
                  <button type="button" className="ghost" onClick={() => setRevokeId(r.id)}>
                    {t('撤销')}
                  </button>
                ))}
            </div>
          </div>
          {openRows.has(r.id) && (
            <p className="myshare-meta">
              {r.expiresAt == null ? t('长期有效') : t('{time} 到期', { time: fmtTime(r.expiresAt) })}
              {' · '}
              {t('打开 {views} 次 · 独立访客 {visitors} 人', {
                views: r.viewCount,
                visitors: r.visitorCount,
              })}
              {' · '}
              {fmtBytes(r.bytes)}
              {r.hasSecret ? ` · ${t('含秘密基地')}` : ''}
            </p>
          )}
        </div>
      ))}

      {rows.length > COLLAPSED && (
        <button
          type="button"
          className="text-btn sm myshares-more"
          onClick={() => setListExpanded((v) => !v)}
        >
          {listExpanded ? t('收起') : t('展开全部 {n} 份', { n: rows.length })}
        </button>
      )}
    </section>
  );
}
