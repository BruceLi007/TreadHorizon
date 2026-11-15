import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useT } from '../i18n';
import CloseIcon from './CloseIcon';
import './ShareSelection.css';

interface Props {
  open: boolean;
  onClose: () => void;
}

const fmtBytes = (n: number) => {  const v = Number(n) || 0;
  if (v >= 1024 ** 2) return `${(v / 1024 ** 2).toFixed(1)} MB`;
  if (v >= 1024) return `${(v / 1024).toFixed(0)} KB`;
  return `${v} B`;
};

const fmtTime = (ms: number | null) => {
  if (ms == null) return '';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

export default function ShareUploadDialog({ open, onClose }: Props) {
  const t = useT();
  const [file, setFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [expiresIn, setExpiresIn] = useState('24h');
  const [customHours, setCustomHours] = useState('24');
  const [password, setPassword] = useState('');
  const [title, setTitle] = useState('');
  const [foreverOk, setForeverOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ url: string; expiresAt: number | null } | null>(null);

  useEffect(() => {
    if (!open) return;
    setResult(null);
    setError('');
    setFile(null);
    setPassword('');
    setTitle('');
    setExpiresIn('24h');
    setCustomHours('24');
    setForeverOk(false);
  }, [open]);

  if (!open) return null;

  const generate = () => {
    setPassword(`tread-${Math.floor(1000 + Math.random() * 9000)}`);
  };

  const upload = async () => {
    if (!file || busy) return;
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
    setBusy(true);
    setError('');
    try {
      const r = await api.importShare(file, {
        expiresIn,
        expiresHours: expiresIn === 'custom' ? Number(customHours) : undefined,
        password: password.trim(),
        title: title.trim(),
      });
      setResult({ url: r.url, expiresAt: r.expiresAt });
      setFile(null);
      setPassword('');
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="share-modal-mask" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="share-modal share-upload-modal" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="share-modal-x" onClick={onClose} aria-label={t('关闭')}>
          <CloseIcon size={22} />
        </button>
        <h2>{t('分享')}</h2>
        <p className="share-note">
          {t('在本地版导出分享包后，在这里上传；上传成功会得到免登录查看的链接。')}
        </p>

        {result ? (
          <div className="share-upload-result">
            <h3>{t('上传成功')}</h3>
            <p className="share-path">{result.url}</p>
            <p className="share-note">
              {result.expiresAt == null
                ? t('长期有效 · 直到你手动撤销')
                : t('链接 {time} 失效', { time: fmtTime(result.expiresAt) })}
            </p>
            <div className="share-modal-actions wrap">
              <button type="button" className="ghost" onClick={() => void copy(result.url)}>
                {t('复制链接')}
              </button>
              <a className="share-site-btn" href={result.url} target="_blank" rel="noreferrer">
                {t('打开预览')}
              </a>
              <button type="button" className="ghost" onClick={() => setResult(null)}>
                {t('再传一份')}
              </button>
            </div>
          </div>
        ) : (
          <>
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
              <button type="button" className="primary" disabled={!file || busy} onClick={() => void upload()}>
                {busy ? t('上传中…') : t('上传并生成链接')}
              </button>
            </div>
          </>
        )}

      </div>
    </div>
  );
}
