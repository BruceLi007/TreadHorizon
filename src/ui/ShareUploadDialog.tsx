import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import type { ShareUploadTask } from '../lib/types';
import CloseIcon from './CloseIcon';
import './ShareSelection.css';

interface Props {
  open: boolean;
  onClose: () => void;
  /**
   * App 层最近一条上传任务（2026-11-15 D-438）。
   * 弹窗只负责发起 / 展示，上传本身在 App 里跑 —— 关掉弹窗不会中断，
   * 进度和结果也能在 设置 → 后台任务 →「分享」里看到。
   */
  upload?: ShareUploadTask | null;
  /** 起上传并返回任务 id */
  onStart: (
    file: File,
    fields: { expiresIn: string; expiresHours?: number; password?: string; title?: string }
  ) => string;
  onCancel?: (id: string) => void;
  onRetry?: (id: string) => void;
}

const fmtBytes = (n: number) => {
  const v = Number(n) || 0;
  if (v >= 1024 ** 2) return `${(v / 1024 ** 2).toFixed(1)} MB`;
  if (v >= 1024) return `${(v / 1024).toFixed(0)} KB`;
  return `${v} B`;
};

export default function ShareUploadDialog({
  open,
  onClose,
  upload = null,
  onStart,
  onCancel,
  onRetry,
}: Props) {
  const t = useT();
  const [file, setFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [expiresIn, setExpiresIn] = useState('24h');
  const [customHours, setCustomHours] = useState('24');
  const [password, setPassword] = useState('');
  const [title, setTitle] = useState('');
  const [foreverOk, setForeverOk] = useState(false);
  const [error, setError] = useState('');
  /** 本弹窗发起的那条任务（App 层 uploads[0] 里按 id 找） */
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError('');
    setFile(null);
    setPassword('');
    setTitle('');
    setExpiresIn('24h');
    setCustomHours('24');
    setForeverOk(false);
    setActiveId(null);
  }, [open]);

  if (!open) return null;

  const active = activeId && upload && upload.id === activeId ? upload : null;

  const generate = () => {
    setPassword(`tread-${Math.floor(1000 + Math.random() * 9000)}`);
  };

  const start = () => {
    if (!file) return;
    if (expiresIn === 'forever' && !foreverOk) {
      setError(t('选「不限时」前请确认：链接会一直有效，直到你手动撤销。'));
      return;
    }
    if (expiresIn === 'custom') {
      const h = Number(customHours);
      if (!Number.isFinite(h) || h < 1 || h > 8760) {
        setError(t('自定义时效需要在 1–8760 小时之间。'));
        return;
      }
    }
    setError('');
    const id = onStart(file, {
      expiresIn,
      expiresHours: expiresIn === 'custom' ? Number(customHours) : undefined,
      password: password.trim(),
      title: title.trim(),
    });
    setActiveId(id);
    setFile(null);
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* ignore */
    }
  };

  const progress = active ? Math.max(0, Math.min(100, active.progress || 0)) : 0;

  return (
    <div className="share-modal-mask" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="share-modal share-upload-modal" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="share-modal-x" onClick={onClose} aria-label={t('关闭')}>
          <CloseIcon size={22} />
        </button>
        <h2>{t('分享')}</h2>

        {active && active.state === 'done' ? (
          <div className="share-upload-result">
            <h3>{t('上传成功')}</h3>
            <p className="share-path">{active.url}</p>
            <p className="share-note">
              {t('分享包已上传，可在 设置 → 我的分享 查看')}
            </p>
            <div className="share-modal-actions wrap">
              <button type="button" className="ghost" onClick={() => void copy(active.url || '')}>
                {t('复制链接')}
              </button>
              <a className="share-site-btn" href={active.url} target="_blank" rel="noreferrer">
                {t('打开预览')}
              </a>
              <button type="button" className="ghost" onClick={() => setActiveId(null)}>
                {t('再传一份')}
              </button>
            </div>
          </div>
        ) : active ? (
          <div className="share-upload-result">
            {active.state === 'uploading' ? (
              <>
                <h3>{t('上传中…')}</h3>
                <p className="share-note">
                  {t('可以关掉这个窗口，上传会在后台继续；可在 设置 → 后台任务 查看进度或取消。')}
                </p>
                <div
                  style={{
                    height: 6,
                    borderRadius: 999,
                    background: 'var(--accent-soft)',
                    overflow: 'hidden',
                    margin: '10px 0 6px',
                  }}
                >
                  <span
                    style={{
                      display: 'block',
                      height: '100%',
                      width: `${progress}%`,
                      background: 'var(--accent)',
                      transition: 'width 200ms ease',
                    }}
                  />
                </div>
                <p className="share-note">
                  {active.fileName} · {fmtBytes(active.bytes)} · {progress}%
                </p>
                <div className="share-modal-actions wrap">
                  <button type="button" className="ghost" onClick={() => onCancel?.(active.id)}>
                    {t('取消上传')}
                  </button>
                  <button type="button" className="primary" onClick={onClose}>
                    {t('关闭')}
                  </button>
                </div>
              </>
            ) : (
              <>
                <h3>{active.state === 'canceled' ? t('已取消上传') : t('上传失败')}</h3>
                <p className="share-note">
                  {active.fileName} · {fmtBytes(active.bytes)}
                </p>
                {active.error && <p className="share-error-text">{active.error}</p>}
                <div className="share-modal-actions wrap">
                  {active.state === 'error' && (
                    <button type="button" className="ghost" onClick={() => onRetry?.(active.id)}>
                      {t('重试')}
                    </button>
                  )}
                  <button type="button" className="primary" onClick={onClose}>
                    {t('关闭')}
                  </button>
                </div>
              </>
            )}
          </div>
        ) : (
          <>
            <p className="share-note">
              {t('导出分享包后，在这里上传；上传成功会得到免登录查看的链接。')}
            </p>
            <label className="share-field">
              <span>{t('分享包（.zip）')}</span>
              <div className="share-file-pick">
                <button
                  type="button"
                  className="ghost"
                  onClick={() => fileRef.current?.click()}
                >
                  {t('选择文件')}
                </button>
                <span className="share-file-name">
                  {file ? `${file.name} · ${fmtBytes(file.size)}` : t('未选择文件')}
                </span>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".zip,application/zip"
                  hidden
                  onChange={(e) => {
                    setFile(e.target.files?.[0] || null);
                  }}
                />
              </div>
            </label>
            <div className="share-upload-row">
              <label className="share-field">
                <span>{t('有效期')}</span>
                <select value={expiresIn} onChange={(e) => setExpiresIn(e.target.value)}>
                  <option value="1h">{t('1 小时')}</option>
                  <option value="24h">{t('24 小时')}</option>
                  <option value="7d">{t('7 天')}</option>
                  <option value="forever">{t('不限时')}</option>
                  <option value="custom">{t('自定义…')}</option>
                </select>
                {expiresIn === 'custom' && (
                  <div className="share-custom-expiry">
                    <input
                      type="number"
                      min={1}
                      max={8760}
                      step={1}
                      value={customHours}
                      onChange={(e) => setCustomHours(e.target.value)}
                      aria-label={t('自定义时长（小时）')}
                    />
                    <span>{t('小时')}</span>
                  </div>
                )}
              </label>
              <label className="share-field">
                <span>{t('访问密码（可选）')}</span>
                <div className="share-password-row">
                  <input
                    value={password}
                    maxLength={128}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={t('留空 = 不需要密码')}
                  />
                  <button type="button" className="ghost" onClick={generate}>
                    {t('自动生成')}
                  </button>
                </div>
              </label>
            </div>
            {expiresIn === 'forever' && (
              <label className="share-check-line">
                <input
                  type="checkbox"
                  checked={foreverOk}
                  onChange={(e) => setForeverOk(e.target.checked)}
                />
                {t('我确认：链接会一直有效，直到手动撤销；照片会持续占用配额。')}
              </label>
            )}
            <label className="share-field">
              <span>{t('标题（可选）')}</span>
              <input
                value={title}
                maxLength={200}
                placeholder={t('例如：2026 秋 · 川西')}
                onChange={(e) => {
                  setTitle(e.target.value);
                }}
              />
            </label>
            <p className="share-warn">
              {t('秘密基地不参与分享：含秘密基地的分享包无法上传。密码忘了无法找回，只能撤销重发。')}
            </p>
            {error && <p className="share-error-text">{error}</p>}
            <div className="share-modal-actions">
              <button type="button" className="ghost" onClick={onClose}>
                {t('关闭')}
              </button>
              <button type="button" className="primary" disabled={!file} onClick={start}>
                {t('上传并生成链接')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
