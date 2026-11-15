import { useEffect, useRef, useState } from 'react';
import CloseIcon from '../ui/CloseIcon';
import { makeShareT, type ShareLang } from './i18n';

const SHARE_TDT_KEY_STORAGE = 'tm-share-tdt-key';
const isTdtKey = (s: string) => /^[A-Za-z0-9]{32}$/.test(s);

interface Props {
  lang: ShareLang;
  hasKey: boolean;
  onClose: () => void;
}

/**
 * 分享页的「填写天地图 Key」弹窗（2026-11-14 D-421）。
 * - 不登录、不注册：只让访客填自己的浏览器端 Key；
 * - Key 只写 localStorage（本机浏览器），不上传本站服务器、不写进链接；
 * - 保存后刷新页面，让天地图 SDK 用新 Key 重新加载。
 */
export default function ShareKeyDialog({ lang, hasKey, onClose }: Props) {
  const t = makeShareT(lang);
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = () => {
    const key = value.trim();
    if (!isTdtKey(key)) {
      setError(t('mapKeyInvalid'));
      inputRef.current?.focus();
      return;
    }
    try {
      localStorage.setItem(SHARE_TDT_KEY_STORAGE, key);
    } catch {
      setError(t('mapKeyPrivacy'));
      return;
    }
    // SDK 是全局单例，换 Key 必须重新加载页面
    window.location.reload();
  };

  const clear = () => {
    try {
      localStorage.removeItem(SHARE_TDT_KEY_STORAGE);
    } catch {
      /* ignore */
    }
    window.location.reload();
  };

  return (
    <div className="share-key-mask" role="dialog" aria-modal="true" onClick={onClose}>
      <form
        className="share-key-card"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <button type="button" className="share-key-x" onClick={onClose} aria-label={t('close')}>
          <CloseIcon size={22} />
        </button>
        <h2>{hasKey ? t('mapKeyChange') : t('mapKeyTitle')}</h2>
        <p>{hasKey ? t('mapKeySavedReload') : t('mapKeyBody')}</p>
        <input
          ref={inputRef}
          type="password"
          autoComplete="off"
          spellCheck={false}
          maxLength={32}
          value={value}
          placeholder={t('mapKeyPlaceholder')}
          onChange={(e) => {
            setValue(e.target.value.replace(/[^A-Za-z0-9]/g, ''));
            setError('');
          }}
        />
        {error && <p className="share-key-error">{error}</p>}
        <p className="share-key-privacy">{t('mapKeyPrivacy')}</p>
        <p className="share-key-hint">{t('mapKeyWhitelist')}</p>
        <div className="share-key-actions">
          {hasKey && (
            <button type="button" className="ghost danger" onClick={clear}>
              {t('mapKeyClear')}
            </button>
          )}
          <button type="button" className="ghost" onClick={onClose}>
            {hasKey ? t('close') : t('mapKeyCancel')}
          </button>
          <button type="submit" className="primary">
            {t('mapKeySave')}
          </button>
        </div>
      </form>
    </div>
  );
}
