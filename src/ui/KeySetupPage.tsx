import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useT } from '../i18n';
import TdtGuideLink from './TdtGuideLink';
import CloseIcon from './CloseIcon';
import './LoginPage.css';

/** 天地图 Key：32 位字母或数字（与后端校验一致） */
const TDT_KEY_RE = /^[A-Za-z0-9]{32}$/;

/**
 * 配置天地图 Key（M6 P2-4，D-205；2026-11-08 D-313 改成欢迎页上的模态小窗）
 *
 * - multi 模式：已登录但当前账号还没填自己的 Key → 在欢迎页上弹出小窗（不再是整页替换）。
 * - local 模式（2026-11-07 D-238）：本机还没配置 Key → 同样弹出小窗。
 * 保存成功后整页刷新，重新走启动流程；点右上角 × / 按 Esc 关闭小窗（回到欢迎页）。
 * 2026-11-08 D-315（用户反馈「点填写 Key 后页面变灰」）：遮罩不再压暗 / 模糊页面，
 * 也取消了「点遮罩关闭」——关闭只走 × / Esc。
 * 2026-11-08 D-316（用户反馈「登录页鼠标能和地图互动、这里不能」）：遮罩层
 * `pointer-events: none`，小窗外完全穿透到欢迎页（地图标记 / 打标签等照常可交互），
 * 只有小窗卡片接收鼠标。
 */
export default function KeySetupPage({
  onDone,
  onClose,
  mode = 'multi',
}: {
  onDone: () => void;
  /** 关闭小窗（回到欢迎页；缺失 Key 时欢迎页右下按钮显示「请填写地图Key」） */
  onClose?: () => void;
  /** multi = 当前账号的 Key；local = 本机全局 Key（D-238） */
  mode?: 'multi' | 'local';
}) {
  const t = useT();
  const isLocal = mode === 'local';
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Esc 关闭小窗（键盘用户）
  useEffect(() => {
    if (!onClose) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const k = key.trim();
    // D-311 / D-312：不再依赖浏览器原生校验气泡，空值也给应用内联错误
    if (!k) {
      setError(t('请填写天地图 Key'));
      return;
    }
    if (!TDT_KEY_RE.test(k)) {
      setError(t('天地图 Key 必须是 32 位字母或数字'));
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api.setTdtKey(k);
      onDone();
    } catch (err: any) {
      setError(err?.message || String(err));
      setBusy(false);
    }
  };

  return (
    <div className="key-modal-backdrop" role="presentation">
      <div
        className="login-card key-modal-card"
        role="dialog"
        aria-modal="true"
        aria-label={t('配置天地图 Key')}
      >
        {/* 2026-11-08 D-312 / D-313：小窗可关掉（× / 点遮罩 / Esc），回到欢迎页
            2026-11-08 D-315（用户要求）：去掉灰色遮罩，点外部不再关闭，只留 × / Esc */}
        {onClose && (
          <button
            type="button"
            className="login-card-close"
            onClick={onClose}
            aria-label={t('关闭')}
            title={t('关闭')}
          >
            <CloseIcon />
          </button>
        )}
        <div className="login-brand" aria-label="Tread Horizon">
          <span className="login-brand-name" aria-hidden="true">
            Tread Horizon
          </span>
          <span className="login-brand-sub" aria-hidden="true">
            {t('脚步丈量世界')}
          </span>
        </div>

        <p className="login-lead">
          {isLocal
            ? t('这台电脑还没有配置天地图 Key，填一次就能加载地图。')
            : t('你的账号还没有配置天地图 Key。每个账号使用自己的 Key，地图才能加载。')}
        </p>

        <form className="login-form" onSubmit={submit} noValidate>
          <label className="login-field">
            <span>{t('天地图 Key（32 位）')}</span>
            <input
              value={key}
              onChange={(e) => {
                setKey(e.target.value);
                setError('');
              }}
              placeholder={t('粘贴 32 位天地图 Key')}
              autoComplete="off"
              spellCheck={false}
              maxLength={32}
              autoFocus
              aria-required="true"
            />
          </label>

          {error && (
            <div className="login-error" role="alert">
              {error}
            </div>
          )}

          <button type="submit" className="login-submit" disabled={busy}>
            {busy ? t('保存中…') : t('保存并继续')}
          </button>
        </form>

        <p className="login-foot">
          {t('申请地址：')}
          <a href="https://www.tianditu.gov.cn/" target="_blank" rel="noreferrer">
            www.tianditu.gov.cn
          </a>
        </p>
        {/* 2026-11-07 用户要求（D-222）：第一次配置 Key 时提供教程 PDF 入口 */}
        <p className="login-foot">
          {t('不知道怎么申请？')}
          <TdtGuideLink />
        </p>
        <p className="login-note">
          {isLocal
            ? t('Key 只保存在这台电脑上。')
            : t('Key 只保存在你自己的账号下，其他账号看不到。')}
        </p>
      </div>
    </div>
  );
}
