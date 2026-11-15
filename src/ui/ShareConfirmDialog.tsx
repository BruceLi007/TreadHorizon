import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type ShareExportStatus } from '../lib/api';
import { OFFICIAL_SITE_URL } from '../lib/site';
import { useT } from '../i18n';
import CloseIcon from './CloseIcon';
import './ShareSelection.css';

interface Props {
  open: boolean;
  placeIds: string[];
  mediaIds: string[];
  counts: { places: number; visits: number; photos: number };
  range: { from: string; to: string } | null;
  displayName?: string;
  onClose: () => void;
  onExported: () => void;
}

type Phase = 'confirm' | 'starting' | 'running' | 'done' | 'error';

const fmtBytes = (n: number) => {
  const v = Number(n) || 0;
  if (v >= 1024 ** 2) return `${(v / 1024 ** 2).toFixed(1)} MB`;
  if (v >= 1024) return `${(v / 1024).toFixed(0)} KB`;
  return `${v} B`;
};

export default function ShareConfirmDialog({
  open,
  placeIds,
  mediaIds,
  counts,
  range,
  displayName,
  onClose,
  onExported,
}: Props) {
  const t = useT();
  const [phase, setPhase] = useState<Phase>('confirm');
  const [includeNotes, setIncludeNotes] = useState(true);
  const [includeCompanions, setIncludeCompanions] = useState(true);
  const [dir, setDir] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState<ShareExportStatus | null>(null);
  const [error, setError] = useState('');
  const exportedRef = useRef(false);

  const estimate = useMemo(() => mediaIds.length * 99 * 1024, [mediaIds.length]);

  useEffect(() => {
    if (!open) return;
    setPhase('confirm');
    setDir('');
    setJobId(null);
    setStatus(null);
    setError('');
    exportedRef.current = false;
  }, [open]);

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
          timer = window.setTimeout(tick, 600);
          return;
        }
        setJobId(null);
        if (s.state === 'done') {
          setPhase('done');
          if (!exportedRef.current) {
            exportedRef.current = true;
            onExported();
          }
        } else {
          setPhase('error');
          setError(s.error || t('导出失败'));
        }
      } catch (e: any) {
        if (!alive) return;
        setJobId(null);
        setPhase('error');
        setError(e?.message || String(e));
      }
    };
    timer = window.setTimeout(tick, 400);
    return () => {
      alive = false;
      if (timer != null) window.clearTimeout(timer);
    };
  }, [jobId, onExported, t]);

  if (!open) return null;

  const begin = async () => {
    setError('');
    setPhase('starting');
    try {
      const picked = await api.pickShareDir();
      if (!picked?.dir) {
        setPhase('confirm');
        return;
      }
      setDir(picked.dir);
      const j = await api.startShareExport({
        placeIds,
        mediaIds,
        includeNotes,
        includeCompanions,
        title: '',
        dir: picked.dir,
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

  const copyPath = async () => {
    const p = status?.savedPath || '';
    if (!p) return;
    try {
      await navigator.clipboard.writeText(p);
    } catch {
      /* 剪贴板不可用就算了，路径已显示在页面上 */
    }
  };

  return (
    <div className="share-modal-mask" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="share-modal" onClick={(e) => e.stopPropagation()}>
        {phase !== 'done' && (
          <button type="button" className="share-modal-x" onClick={onClose} aria-label={t('关闭')}>
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
            </dl>
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
              {t('确认导出会生成一个压缩包。它不会自动上传，也不会删除或修改你的任何原数据。')}
            </p>
            {phase === 'starting' && (
              <p className="share-warn">
                {t('已弹出「浏览文件夹」窗口：如果没看到，按 Alt+Tab 或点任务栏里的「浏览文件夹」（它可能在浏览器后面）。')}
              </p>
            )}
            <div className="share-modal-actions">
              <button type="button" className="ghost" onClick={onClose} disabled={phase === 'starting'}>
                {t('取消')}
              </button>
              <button type="button" className="primary" onClick={() => void begin()} disabled={phase === 'starting'}>
                {phase === 'starting' ? t('正在准备…') : t('选择文件夹并导出')}
              </button>
            </div>
          </>
        )}

        {phase === 'running' && (
          <>
            <h2>{t('正在导出分享包…')}</h2>
            <p className="share-note">
              {status
                ? t('已处理 {done} / {total} 张照片', {
                    done: status.done,
                    total: Math.max(1, status.total),
                  })
                : t('正在读取照片…')}
            </p>
            <div className="share-progress">
              <span
                style={{
                  width: `${status && status.total > 0 ? Math.round((status.done / status.total) * 100) : 4}%`,
                }}
              />
            </div>
            {status && status.skipped > 0 && (
              <p className="share-warn">{t('已跳过 {n} 张无法读取的照片。', { n: status.skipped })}</p>
            )}
            <p className="share-note">{t('导出在后台进行，关掉这个窗口也不会中断。')}</p>
            <div className="share-modal-actions">
              <button type="button" className="ghost" onClick={() => void cancel()}>
                {t('取消导出')}
              </button>
            </div>
          </>
        )}

        {phase === 'done' && (
          <>
            <h2>{t('导出成功')}</h2>
            <p className="share-file-line">
              <b>{status?.savedName || ''}</b>
              <span>{fmtBytes(status?.bytes || 0)}</span>
            </p>
            <p className="share-path">{status?.savedPath || ''}</p>
            {status && status.skipped > 0 && (
              <p className="share-warn">{t('已跳过 {n} 张无法读取的照片。', { n: status.skipped })}</p>
            )}
            <div className="share-modal-actions wrap">
              <button
                type="button"
                className="ghost share-open-folder"
                onClick={() => {
                  if (dir) void api.revealShareDir(dir);
                }}
              >
                {t('打开文件夹')}
              </button>
              <button type="button" className="ghost" onClick={() => void copyPath()}>
                {t('复制路径')}
              </button>
            </div>
            <div className="share-next">
              <p>
                {t('下一步：打开官网 → 登录或注册（需邀请码）→ 我的分享 → 上传这个文件。')}
              </p>
              {OFFICIAL_SITE_URL && (
                <a className="share-site-btn" href={OFFICIAL_SITE_URL} target="_blank" rel="noreferrer">
                  {t('去官网登录 / 注册 →')}
                </a>
              )}
            </div>
            <div className="share-modal-actions">
              <button type="button" className="primary" onClick={onClose}>
                {t('完成')}
              </button>
            </div>
          </>
        )}

        {phase === 'error' && (
          <>
            <h2>{t('导出失败')}</h2>
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
      </div>
    </div>
  );
}
