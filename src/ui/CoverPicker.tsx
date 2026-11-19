/**
 * 封面选择器（2026-11-18 D-524，用户要求）：
 * 照片墙式弹窗 —— 每行 4 / 6 / 8 / 10 可切、点图放大预览、选中一张当分享封面。
 */
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useT } from '../i18n';
import CloseIcon from './CloseIcon';
import './ShareSelection.css';

interface Props {
  open: boolean;
  mediaIds: string[];
  value: string | null;
  onPick: (id: string) => void;
  onClose: () => void;
}

const COLS = [4, 6, 8, 10] as const;

export default function CoverPicker({ open, mediaIds, value, onPick, onClose }: Props) {
  const t = useT();
  const [cols, setCols] = useState<number>(6);
  const [preview, setPreview] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(value);

  useEffect(() => {
    if (!open) return;
    setPreview(null);
    setPicked(value);
  }, [open, value]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (preview) setPreview(null);
        else onClose();
      }
      if (!preview) return;
      const i = mediaIds.indexOf(preview);
      if (e.key === 'ArrowLeft' && i > 0) setPreview(mediaIds[i - 1]);
      if (e.key === 'ArrowRight' && i >= 0 && i < mediaIds.length - 1) setPreview(mediaIds[i + 1]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, preview, mediaIds, onClose]);

  if (!open) return null;

  const previewIndex = preview ? mediaIds.indexOf(preview) : -1;

  return (
    <div className="share-modal-mask cover-picker-mask" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="share-modal cover-picker" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="share-modal-x" onClick={onClose} aria-label={t('关闭')}>
          <CloseIcon size={22} />
        </button>
        <h2>{t('选择封面')}</h2>
        <p className="share-note">{t('每行 4 / 6 / 8 / 10 可切；点图片放大预览，选中一张作为分享封面。')}</p>

        <div className="cover-cols" role="group" aria-label={t('每行张数')}>
          {COLS.map((n) => (
            <button
              key={n}
              type="button"
              className={cols === n ? 'on' : ''}
              onClick={() => setCols(n)}
            >
              {t('{n} 列', { n })}
            </button>
          ))}
        </div>

        <div
          className="cover-grid"
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
        >
          {mediaIds.map((id) => (
            <button
              key={id}
              type="button"
              className={picked === id ? 'cover-cell on' : 'cover-cell'}
              onClick={() => setPicked(id)}
              onDoubleClick={() => setPreview(id)}
              title={t('点一下选中，双击放大')}
            >
              <img src={api.thumbUrl(id)} alt="" loading="lazy" />
              {picked === id && <span className="cover-cell-badge">{t('封面')}</span>}
            </button>
          ))}
        </div>

        <div className="share-modal-actions">
          <button type="button" className="ghost" onClick={onClose}>
            {t('取消')}
          </button>
          <button
            type="button"
            className="primary"
            disabled={!picked}
            onClick={() => {
              if (picked) onPick(picked);
              onClose();
            }}
          >
            {t('使用这张')}
          </button>
        </div>

        {preview && (
          <div className="cover-preview-mask" onClick={() => setPreview(null)}>
            <div className="cover-preview" onClick={(e) => e.stopPropagation()}>
              <img src={api.previewUrl(preview)} alt="" />
              <div className="cover-preview-bar">
                <span>
                  {previewIndex + 1} / {mediaIds.length}
                </span>
                <button
                  type="button"
                  className="ghost"
                  disabled={previewIndex <= 0}
                  onClick={() => setPreview(mediaIds[previewIndex - 1])}
                >
                  {t('上一张')}
                </button>
                <button
                  type="button"
                  className="ghost"
                  disabled={previewIndex >= mediaIds.length - 1}
                  onClick={() => setPreview(mediaIds[previewIndex + 1])}
                >
                  {t('下一张')}
                </button>
                <button
                  type="button"
                  className="primary"
                  onClick={() => {
                    setPicked(preview);
                    setPreview(null);
                  }}
                >
                  {t('用这张做封面')}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
