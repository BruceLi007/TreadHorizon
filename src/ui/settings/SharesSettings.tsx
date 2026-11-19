import { useCallback, useEffect, useState } from 'react';
import { api, type MyShareRow } from '../../lib/api';
import { useT } from '../../i18n';
import { formatBytes } from '../../lib/bytes';
import '../ShareSelection.css';

const COLLAPSED = 3;

const pad = (n: number) => String(n).padStart(2, '0');
const fmtTime = (ms: number | null) => {
  if (ms == null) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** 复制链接：非安全上下文（云端 http）下 Clipboard API 不可用，退回 textarea + execCommand */
async function copyText(text: string): Promise<boolean> {
  try {
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 权限被拒 / 非安全上下文：走下面的兜底 */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

interface SnapshotInfo {
  exists: boolean;
  syncedAt?: number | null;
  bytes?: number;
  places?: number;
  visits?: number;
  photos?: number;
}

/**
 * 云端「我的分享」（2026-11-18 D-524 重做 + D-527 调整）：
 * - 顶部一行「主页快照」（同步时间 / 地点 / 到访 / 照片 / 占用，只读、不提供删除）；
 * - 分享列表：封面、密码状态、打开次数 / 独立访客，操作 = 预览 / 复制 / 设密码 / 撤销或上线 / 删除；
 * - 删除进 **设置 → 回收站**（用户要求「回收站直接用原有的」，本页不再单开一份分享回收站）。
 */
export default function SharesSettings() {
  const t = useT();
  const [rows, setRows] = useState<MyShareRow[]>([]);
  const [snapshot, setSnapshot] = useState<SnapshotInfo>({ exists: false });
  const [usage, setUsage] = useState<{
    sharesBytes: number;
    shareCount: number;
    quotaBytes: number;
    mediaBytes: number;
    views: number;
    visitors: number;
  } | null>(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [openRows, setOpenRows] = useState<Set<string>>(() => new Set());
  const [listExpanded, setListExpanded] = useState(false);
  const [copyHint, setCopyHint] = useState<{ ok: boolean } | null>(null);
  /** 删除后提示「去回收站恢复」；2026-11-18 D-527 起分享回收站不再在这里 */
  const [hint, setHint] = useState('');
  /** 设密码弹窗：{ id, value }；value 为空 = 清除密码（公开） */
  const [pw, setPw] = useState<{ id: string; value: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const [list, u, snap] = await Promise.all([
        api.myShares(),
        api.shareUsage(),
        api.snapshotInfo(),
      ]);
      setRows(list.items);
      setUsage(u);
      setSnapshot(snap as SnapshotInfo);
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
    const ok = await copyText(text);
    setCopyHint({ ok });
    window.setTimeout(() => setCopyHint(null), 2000);
  };

  const run = async (id: string, fn: () => Promise<unknown>) => {
    setBusyId(id);
    setError('');
    try {
      await fn();
      await load();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusyId(null);
    }
  };

  /** 删除 = 移进「设置 → 回收站」（2026-11-18 D-527：不在本页另开分享回收站） */
  const removeShare = async (id: string) => {
    setHint('');
    await run(id, () => api.trashShare(id));
    setHint(t('已移到回收站（设置 → 回收站 里可以恢复或彻底删除）'));
    window.setTimeout(() => setHint(''), 6000);
  };

  const savePassword = async () => {
    if (!pw) return;
    await run(pw.id, async () => {
      await api.setSharePassword(pw.id, pw.value);
      setPw(null);
    });
  };

  const active = listExpanded ? rows : rows.slice(0, COLLAPSED);

  return (
    <>
      <div className="set-section-head" style={{ marginBottom: 2 }}>
        <h3 className="set-section-title">{t('我的分享')}</h3>
        {usage && (
          <span className="set-section-tag">
            {t('已用 {used} / 上限 {quota} · 剩余 {free} · {n} 份 · 打开 {views} 次 · 访客 {visitors} 人', {
              used: formatBytes((usage.sharesBytes || 0) + (usage.mediaBytes || 0)),
              quota: formatBytes(usage.quotaBytes || 0),
              free: formatBytes(
                Math.max(
                  0,
                  (usage.quotaBytes || 0) - (usage.sharesBytes || 0) - (usage.mediaBytes || 0)
                )
              ),
              n: usage.shareCount,
              views: usage.views,
              visitors: usage.visitors,
            })}
          </span>
        )}
      </div>

      {error && <p className="share-error-text">{error}</p>}

      <section className="set-section">
        <div className="set-section-head">
          <h4 className="set-section-title" style={{ fontSize: 'var(--fs-h2)' }}>
            {t('主页快照')}
          </h4>
          <span className="set-section-tag">{t('只保留一份')}</span>
        </div>
        {snapshot.exists ? (
          <p className="set-hint">
            {t('同步于 {time} · {places} 地点 · {visits} 到访 · {photos} 张照片 · {size}', {
              time: fmtTime(snapshot.syncedAt ?? null),
              places: snapshot.places ?? 0,
              visits: snapshot.visits ?? 0,
              photos: snapshot.photos ?? 0,
              size: formatBytes(snapshot.bytes ?? 0),
            })}
          </p>
        ) : (
          <p className="set-hint">{t('还没有同步内容：请在本地客户端 设置 → 云端账号 里同步。')}</p>
        )}
      </section>

      <section className="set-section">
        <div className="set-section-head">
          <h4 className="set-section-title" style={{ fontSize: 'var(--fs-h2)' }}>
            {t('分享链接')}
          </h4>
          <span className="set-section-tag">{t('{n} 份', { n: rows.length })}</span>
        </div>

        {rows.length === 0 && <p className="share-note">{t('还没有分享。')}</p>}

        {active.map((r) => {
          const busy = busyId === r.id;
          return (
            <div className={'myshare-row' + (openRows.has(r.id) ? ' open' : '')} key={r.id}>
              <div className="myshare-head">
                {r.hasCover && (
                  <img className="myshare-cover" src={api.shareCoverUrl(r.id, r.createdAt)} alt="" />
                )}
                <div className="myshare-main">
                  <div className="myshare-title-line">
                    <b>{r.title || t('未命名分享')}</b>
                    {r.hasPassword && <span className="myshare-pw">{t('已设密码')}</span>}
                  </div>
                  <span className="myshare-time">{t('分享于 {time}', { time: fmtTime(r.createdAt) })}</span>
                  <span className="myshare-stat">
                    {t('打开 {views} 次 · 独立访客 {visitors} 人', {
                      views: r.viewCount,
                      visitors: r.visitorCount,
                    })}
                  </span>
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
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => setPw({ id: r.id, value: '' })}
                      >
                        {r.hasPassword ? t('改密码') : t('设密码')}
                      </button>
                      <button
                        type="button"
                        className="ghost"
                        disabled={busy}
                        onClick={() => void run(r.id, () => api.revokeShare(r.id))}
                      >
                        {t('撤销')}
                      </button>
                    </>
                  )}
                  {(r.status === 'revoked' || r.status === 'expired') && (
                    <button
                      type="button"
                      className="ghost"
                      disabled={busy || r.status === 'expired'}
                      title={r.status === 'expired' ? t('已过期，不能重新上线') : undefined}
                      onClick={() => void run(r.id, () => api.onlineShare(r.id))}
                    >
                      {t('重新上线')}
                    </button>
                  )}
                  <button
                    type="button"
                    className="ghost"
                    disabled={busy}
                    onClick={() => void removeShare(r.id)}
                  >
                    {t('删除')}
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => toggleRow(r.id)}
                    aria-expanded={openRows.has(r.id)}
                  >
                    {openRows.has(r.id) ? t('收起') : t('详情')}
                  </button>
                </div>
              </div>
              {openRows.has(r.id) && (
                <p className="myshare-meta">
                  {r.expiresAt == null ? t('长期有效') : t('{time} 到期', { time: fmtTime(r.expiresAt) })}
                  {' · '}
                  {formatBytes(r.bytes)}
                  {r.hasSecret ? ` · ${t('含秘密基地')}` : ''}
                </p>
              )}
            </div>
          );
        })}

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

      {hint && <p className="set-hint">{hint}</p>}

      <p className="set-hint">
        {t('删除的分享会进 设置 → 回收站，在那里恢复或彻底删除。')}
      </p>

      {copyHint && (
        <div className={copyHint.ok ? 'myshare-toast ok' : 'myshare-toast bad'} role="status">
          {copyHint.ok ? t('链接已复制') : t('复制失败，请手动复制')}
        </div>
      )}

      {pw && (
        <div className="share-modal-mask" role="dialog" aria-modal="true" onClick={() => setPw(null)}>
          <div className="share-modal" onClick={(e) => e.stopPropagation()}>
            <h2>{t('设置访问密码')}</h2>
            <p className="share-note">{t('留空保存 = 取消密码，任何人拿到链接都能看。')}</p>
            <label className="share-field">
              <span>{t('访问密码')}</span>
              <input
                value={pw.value}
                maxLength={128}
                autoFocus
                placeholder={t('留空 = 公开')}
                onChange={(e) => setPw({ ...pw, value: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void savePassword();
                }}
              />
            </label>
            <div className="share-modal-actions">
              <button type="button" className="ghost" onClick={() => setPw(null)}>
                {t('取消')}
              </button>
              <button type="button" className="primary" onClick={() => void savePassword()}>
                {t('保存')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
