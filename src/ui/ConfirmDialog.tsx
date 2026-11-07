/**
 * 2026-11-07 D-256：通用确认弹窗（用户要求「确认框做成单独弹出窗口，样式统一」）。
 * 用于照片墙批量删除、回收站彻底删除 / 恢复等危险或不可逆操作。
 * 通过 Portal 挂到 body，深浅主题都使用 .cd-* 样式与全局主题变量。
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../i18n';
import CloseIcon from './CloseIcon';
import './ConfirmDialog.css';

interface Props {
  title: string;
  children?: ReactNode;
  confirmText?: string;
  cancelText?: string;
  /** 危险操作（删除）：确认按钮用 danger 样式 */
  danger?: boolean;
  busy?: boolean;
  busyText?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({
  title,
  children,
  confirmText,
  cancelText,
  danger = false,
  busy = false,
  busyText,
  onConfirm,
  onCancel,
}: Props) {
  const t = useT();
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    cardRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (!busy) onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  return createPortal(
    <div
      className="cd-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div
        ref={cardRef}
        className="cd-card"
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="cd-head">
          <h3 className="cd-title">{title}</h3>
          <button
            type="button"
            className="icon cd-close"
            onClick={onCancel}
            disabled={busy}
            aria-label={t('关闭')}
            title={t('关闭')}
          >
            <CloseIcon size={12} />
          </button>
        </div>
        {children && <div className="cd-body">{children}</div>}
        <div className="cd-actions">
          <button type="button" className="ghost" onClick={onCancel} disabled={busy}>
            {cancelText ?? t('取消')}
          </button>
          <button
            type="button"
            className={danger ? 'danger-btn' : 'primary'}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? (busyText ?? t('处理中…')) : (confirmText ?? t('确认'))}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
