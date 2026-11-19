import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type ShareExportStatus } from '../lib/api';
import { useT } from '../i18n';
import CloseIcon from './CloseIcon';
import CoverPicker from './CoverPicker';
import './ShareSelection.css';

interface Props {
  open: boolean;
  placeIds: string[];
  mediaIds: string[];
  counts: { places: number; visits: number; photos: number };
  range: { from: string; to: string } | null;
  displayName?: string;
  /** 云端是否已登录（2026-11-18 D-524：登录后直接上传，不再导出 zip） */
  cloudReady: boolean;
  /** 已登录账号的显示名（按钮上显示） */
  cloudName?: string;
  onClose: () => void;
  /** 未登录时点「登录云端后上传」→ 打开 设置 → 云端账号 */
  onNeedLogin: () => void;
  /** 上传成功（弹窗还开着，结果页要留着给用户看链接） */
  onShared: () => void;
  /** 用户关掉「已上传到云端」结果页：这时才清空分享选择 */
  onDone?: () => void;
}

type Phase = 'confirm' | 'starting' | 'running' | 'done' | 'error';

const fmtBytes = (n: number) => {
  const v = Number(n) || 0;
  if (v >= 1024 ** 2) return `${(v / 1024 ** 2).toFixed(1)} MB`;
  if (v >= 1024) return `${(v / 1024).toFixed(0)} KB`;
  return `${v} B`;
};

const EXPIRY: { id: string; label: string }[] = [
  { id: '1h', label: '1 小时' },
  { id: '24h', label: '24 小时' },
  { id: '7d', label: '7 天' },
  { id: 'forever', label: '不限时' },
];

/**
 * 分享确认（2026-11-18 D-524 重做）：
 * - 选择流程不变，确认后**直接上传云端**（不再让用户挑文件夹导出 zip）；
 * - 密码不在本地设，上传后在云端「我的分享」里按条设置；
 * - 封面可选（默认第一张），只传 1280 长边缩略图。
 */
export default function ShareConfirmDialog({
  open,
  placeIds,
  mediaIds,
  counts,
  range,
  displayName,
  cloudReady,
  cloudName,
  onClose,
  onNeedLogin,
  onShared,
  onDone,
}: Props) {
  const t = useT();
  const [phase, setPhase] = useState<Phase>('confirm');
  const [includeNotes, setIncludeNotes] = useState(true);
  const [includeCompanions, setIncludeCompanions] = useState(true);
  const [expiresIn, setExpiresIn] = useState('24h');
  const [title, setTitle] = useState('');
  const [coverId, setCoverId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState<ShareExportStatus | null>(null);
  const [error, setError] = useState('');
  /** 2026-11-19 D-543：云端账号用量（分享限额 = 上限 − 已用；打开弹窗时拉一次） */
  const [usage, setUsage] = useState<{
    quotaBytes: number;
    mediaBytes: number;
    sharesBytes: number;
  } | null>(null);
  const sharedRef = useRef(false);
  /**
   * 2026-11-18 D-526：mediaIds 是 App 每次渲染都新建的数组，**不能**当 effect 依赖，
   * 否则上传完成时 onShared 引起的 App 重渲染会把弹窗重置回「确认分享」（结果页与链接全丢）。
   * effect 只跟 open；打开那一刻的媒体列表用 ref 取。
   */
  const mediaIdsRef = useRef(mediaIds);
  mediaIdsRef.current = mediaIds;

  const estimate = useMemo(() => mediaIds.length * 99 * 1024, [mediaIds.length]);

  /** 2026-11-19 D-543：本次可用 = 账号上限 − 已用（快照 + 已有分享） */
  const quota = Number(usage?.quotaBytes) || 0;
  const usedBytes = (Number(usage?.mediaBytes) || 0) + (Number(usage?.sharesBytes) || 0);
  const remaining = quota > 0 ? Math.max(0, quota - usedBytes) : 0;
  const overQuota = quota > 0 && estimate > remaining;

  useEffect(() => {
    if (!open) return;
    setPhase('confirm');
    setJobId(null);
    setStatus(null);
    setError('');
    setTitle('');
    setExpiresIn('24h');
    setIncludeNotes(true);
    setIncludeCompanions(true);
    setCoverId(mediaIdsRef.current[0] || null);
    setPickerOpen(false);
    sharedRef.current = false;
  }, [open]);

  /**
   * 2026-11-19 D-543：打开确认弹窗时拉云端用量，把「本次可用 = 上限 − 已用」直接显示出来；
   * 用户上传过分享后，下一次的可用额度会自然变小。
   */
  useEffect(() => {
    if (!open || !cloudReady) {
      setUsage(null);
      return;
    }
    let alive = true;
    api
      .cloudStatus()
      .then((st) => {
        if (alive) setUsage(st.usage || null);
      })
      .catch(() => {
        /* 拿不到用量：不显示限额，上传时由服务端兜底 */
      });
    return () => {
      alive = false;
    };
  }, [open, cloudReady]);

  useEffect(() => {
    if (!jobId) return;
    let alive = true;
    let timer: number | null = null;
    const tick = async () => {
      try {
        const s = await api.shareExportStatus(jobId);
        if (!alive) return;
        setStatus(s);
        if (s.state === 'running') {
          timer = window.setTimeout(tick, 700);
          return;
        }
        setJobId(null);
        if (s.state === 'done') {
          setPhase('done');
          if (!sharedRef.current) {
            sharedRef.current = true;
            onShared();
          }
        } else {
          setPhase('error');
          setError(s.error || t('上传失败'));
        }
      } catch (e: any) {
        if (!alive) return;
        setJobId(null);
        setPhase('error');
        setError(e?.message || String(e));
      }
    };
    timer = window.setTimeout(tick, 500);
    return () => {
      alive = false;
      if (timer != null) window.clearTimeout(timer);
    };
  }, [jobId, onShared, t]);

  if (!open) return null;

  const begin = async () => {
    if (!cloudReady) {
      onNeedLogin();
      return;
    }
    setError('');
    setPhase('starting');
    try {
      const j = await api.startShareExport({
        placeIds,
        mediaIds,
        includeNotes,
        includeCompanions,
        title: title.trim(),
        dir: '',
        cloud: true,
        expiresIn,
        coverMediaId: coverId || undefined,
        displayName,
      });
      setPhase('running');
      setJobId(j.jobId);
    } catch (e: any) {
      setPhase('error');
      setError(e?.message || String(e));
    }
  };

  const cancel = async () => {
    if (jobId) {
      try {
        await api.cancelShareExport(jobId);
      } catch {
        /* ignore */
      }
    }
    setPhase('confirm');
    setJobId(null);
    setStatus(null);
  };

  const copyLink = async () => {
    const u = status?.cloudUrl || '';
    if (!u) return;
    try {
      await navigator.clipboard.writeText(u);
    } catch {
      /* 非安全上下文时用户可手动复制 */
    }
  };

  /** 关弹窗：如果已经上传成功，顺手清空分享选择（下一次重新勾） */
  const closeSelf = () => {
    if (phase === 'done') onDone?.();
    onClose();
  };

  const progress =
    status?.phase === 'upload' && Number(status.bytes) > 0
      ? Math.round(((Number(status.uploaded) || 0) / Number(status.bytes)) * 100)
      : status?.phase === 'zip' && Number(status.zipTotal) > 0
        ? Math.round(((Number(status.zipDone) || 0) / Number(status.zipTotal)) * 100)
        : status && status.total > 0
          ? Math.round((status.done / status.total) * 100)
          : 4;

  return (
    <div className="share-modal-mask" role="dialog" aria-modal="true" onClick={closeSelf}>
      <div className="share-modal" onClick={(e) => e.stopPropagation()}>
        {phase !== 'done' && (
          <button type="button" className="share-modal-x" onClick={closeSelf} aria-label={t('关闭')}>
            <CloseIcon size={22} />
          </button>
        )}

        {(phase === 'confirm' || phase === 'starting') && (
          <>
            <h2>{t('确认分享')}</h2>
            <dl className="share-confirm-stats">
              <div>
                <dt>{t('时段')}</dt>
                <dd>{range ? `${range.from} ~ ${range.to}` : t('未选择到访')}</dd>
              </div>
              <div>
                <dt>{t('地点')}</dt>
                <dd>{t('{n} 个', { n: counts.places })}</dd>
              </div>
              <div>
                <dt>{t('到访')}</dt>
                <dd>{t('{n} 次', { n: counts.visits })}</dd>
              </div>
              <div>
                <dt>{t('照片')}</dt>
                <dd>
                  {t('{n} 张', { n: counts.photos })} · {t('约 {size}', { size: fmtBytes(estimate) })}
                </dd>
              </div>
              <div>
                <dt>{t('账号空间')}</dt>
                <dd>
                  {quota > 0
                    ? t('剩余 {free}（上限 {quota}，已用 {used}）', {
                        free: fmtBytes(remaining),
                        quota: fmtBytes(quota),
                        used: fmtBytes(usedBytes),
                      })
                    : t('未获取到')}
                </dd>
              </div>
            </dl>
            {overQuota && (
              <p className="share-error-text">
                {t('本次约 {size}，超过账号剩余空间 {free}；可以减少照片，或先在云端扩容。', {
                  size: fmtBytes(estimate),
                  free: fmtBytes(remaining),
                })}
              </p>
            )}

            <div className="share-field-row">
              <label className="share-field">
                <span>{t('有效期')}</span>
                <select value={expiresIn} onChange={(e) => setExpiresIn(e.target.value)}>
                  {EXPIRY.map((o) => (
                    <option key={o.id} value={o.id}>
                      {t(o.label)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="share-field">
                <span>{t('标题（可选）')}</span>
                <input
                  value={title}
                  maxLength={200}
                  placeholder={t('例如：2026 秋 · 川西')}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </label>
            </div>

            <div className="share-cover-row">
              <span className="share-cover-label">{t('封面')}</span>
              {coverId ? (
                <img className="share-cover-thumb" src={api.thumbUrl(coverId)} alt="" />
              ) : (
                <span className="share-cover-empty">{t('默认第一张')}</span>
              )}
              <button type="button" className="ghost" onClick={() => setPickerOpen(true)}>
                {t('选择封面…')}
              </button>
            </div>

            <div className="share-checks">
              <label>
                <input
                  type="checkbox"
                  checked={includeNotes}
                  onChange={(e) => setIncludeNotes(e.target.checked)}
                />
                {t('包含到访笔记')}
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={includeCompanions}
                  onChange={(e) => setIncludeCompanions(e.target.checked)}
                />
                {t('包含同行人')}
              </label>
            </div>

            <p className="share-note">
              {t('上传的是 1280 长边缩略图，不含原图 / 视频 / 秘密基地；上传后可在云端「我的分享」里设访问密码。')}
            </p>
            {!cloudReady && (
              <p className="share-warn">
                {t('还没有登录云端账号：登录后就能直接上传（设置 → 云端账号）。')}
              </p>
            )}

            <div className="share-modal-actions">
              <button type="button" className="ghost" onClick={onClose} disabled={phase === 'starting'}>
                {t('取消')}
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => void begin()}
                disabled={phase === 'starting'}
              >
                {phase === 'starting'
                  ? t('正在准备…')
                  : cloudReady
                    ? t('上传到云端{name}', { name: cloudName ? ` · ${cloudName}` : '' })
                    : t('登录云端后上传')}
              </button>
            </div>
          </>
        )}

        {phase === 'running' && (
          <>
            <h2>
              {status?.phase === 'upload'
                ? t('正在上传到云端…')
                : status?.phase === 'zip'
                  ? t('正在打包成 zip…')
                  : t('正在生成缩略图…')}
            </h2>
            <p className="share-note">
              {status
                ? status.phase === 'upload'
                  ? t('正在上传… {pct}%（{done} / {total}）', {
                      pct: progress,
                      done: fmtBytes(Number(status.uploaded) || 0),
                      total: fmtBytes(Number(status.bytes) || 0),
                    })
                  : status.phase === 'zip'
                    ? t('正在打包成 zip… {pct}%（{done} / {total}）', {
                        pct: progress,
                        done: fmtBytes(Number(status.zipDone) || 0),
                        total: fmtBytes(Number(status.zipTotal) || 0),
                      })
                    : t('已处理 {done} / {total} 张照片', {
                        done: status.done,
                        total: Math.max(1, status.total),
                      })
                : t('正在读取照片…')}
            </p>
            <div className="share-progress">
              <span style={{ width: `${progress}%` }} />
            </div>
            {status && status.skipped > 0 && (
              <p className="share-warn">{t('已跳过 {n} 张无法读取的照片。', { n: status.skipped })}</p>
            )}
            <p className="share-note">{t('上传在后台进行，关掉这个窗口也不会中断。')}</p>
            <div className="share-modal-actions">
              <button type="button" className="ghost" onClick={() => void cancel()}>
                {t('取消上传')}
              </button>
            </div>
          </>
        )}

        {phase === 'done' && (
          <>
            <h2>{t('已上传到云端')}</h2>
            <p className="share-path">{status?.cloudUrl || ''}</p>
            {status && status.bytes > 0 && (
              <p className="share-note">{t('分享包 {size}', { size: fmtBytes(status.bytes) })}</p>
            )}
            <div className="share-modal-actions wrap">
              <button type="button" className="primary" onClick={() => void copyLink()}>
                {t('复制链接')}
              </button>
              {status?.cloudUrl && (
                <a className="share-site-btn" href={status.cloudUrl} target="_blank" rel="noreferrer">
                  {t('打开预览')}
                </a>
              )}
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  setPhase('confirm');
                  setStatus(null);
                }}
              >
                {t('再传一份')}
              </button>
            </div>
            <p className="share-note">
              {t('这条分享已经出现在云端「设置 → 我的分享」里，可以在那里预览、设密码、撤销或删除。')}
            </p>
            <div className="share-modal-actions">
              <button type="button" className="primary" onClick={closeSelf}>
                {t('完成')}
              </button>
            </div>
          </>
        )}

        {phase === 'error' && (
          <>
            <h2>{t('上传失败')}</h2>
            <p className="share-error-text">{error}</p>
            <div className="share-modal-actions">
              <button type="button" className="ghost" onClick={onClose}>
                {t('关闭')}
              </button>
              <button type="button" className="primary" onClick={() => void begin()}>
                {t('重试')}
              </button>
            </div>
          </>
        )}

        <CoverPicker
          open={pickerOpen}
          mediaIds={mediaIds}
          value={coverId}
          onPick={(id) => setCoverId(id)}
          onClose={() => setPickerOpen(false)}
        />
      </div>
    </div>
  );
}
