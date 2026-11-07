import { useState } from 'react';
import { api } from '../lib/api';
import { useT } from '../i18n';
import TdtGuideLink from './TdtGuideLink';
import './LoginPage.css';

/** 天地图 Key：32 位字母或数字（与后端校验一致） */
const TDT_KEY_RE = /^[A-Za-z0-9]{32}$/;

/**
 * 配置天地图 Key（M6 P2-4，D-205）
 *
 * - multi 模式：已登录但当前账号还没填自己的 Key → 全屏引导页（每个账号一份）。
 * - local 模式（2026-11-07 D-238）：本机还没配置 Key → 同样先显示本页（本机一份，保存到 data/config.json），
 *   不再让新用户先卡在「启动失败 / 服务端没有读到 TDT_TK」。
 * 保存成功后整页刷新，重新走启动流程。
 */
export default function KeySetupPage({
  onDone,
  mode = 'multi',
}: {
  onDone: () => void;
  /** multi = 当前账号的 Key；local = 本机全局 Key（D-238） */
  mode?: 'multi' | 'local';
}) {
  const t = useT();
  const isLocal = mode === 'local';
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const k = key.trim();
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
    <div className="login-page key-setup-page">
      <div className="login-card">
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

        <form className="login-form" onSubmit={submit}>
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
              required
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
          {t('（类型选「浏览器端」，域名白名单留空）')}
        </p>
        {/* 2026-11-07 用户要求（D-222）：第一次配置 Key 时提供教程 PDF 入口 */}
        <p className="login-foot">
          {t('不知道怎么申请？')}
          <TdtGuideLink />
        </p>
        <p className="login-note">
          {isLocal
            ? t('Key 只保存在本机，不会写进日志，也不会进导出 / 备份。')
            : t('Key 只保存在你自己的账号下，不会写进日志、不会出现在导出 / 备份里，也不会被其他账号看到。')}
        </p>
        {isLocal && (
          <p className="login-note">{t('也可以把 Key 写进 .env.local 的 TDT_TK，重启应用后生效。')}</p>
        )}
      </div>
    </div>
  );
}
