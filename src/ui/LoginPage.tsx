import { useState } from 'react';
import { api } from '../lib/api';
import { useT } from '../i18n';
import Segmented from './Segmented';
import './LoginPage.css';

type Mode = 'login' | 'register';

interface Props {
  /** 登录 / 注册成功后由 App 处理（当前实现：整页 reload，重新走启动流程） */
  onLoggedIn: () => void;
}

/**
 * 登录 / 邀请码注册页（2026-11-06 M6 P2-1，D-200）
 *
 * 只在 `AUTH_MODE=multi`（云端多用户）且未登录时显示；本地模式（默认）不会走到这里。
 * 登录成功后服务端下发 HttpOnly + SameSite=Lax 会话 Cookie，前端不需要保存 token。
 */
export default function LoginPage({ onLoggedIn }: Props) {
  const t = useT();
  const [mode, setMode] = useState<Mode>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const switchMode = (next: Mode) => {
    if (next === mode) return;
    setMode(next);
    setError('');
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      if (mode === 'login') {
        await api.login(username.trim(), password);
      } else {
        await api.register({
          inviteCode: inviteCode.trim(),
          username: username.trim(),
          password,
          displayName: displayName.trim() || undefined,
        });
      }
      onLoggedIn();
    } catch (err: any) {
      setError(err?.message || String(err));
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
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
          {mode === 'login'
            ? t('登录你的账号，继续记录足迹。')
            : t('用一个邀请码创建账号，数据只有你自己能看到。')}
        </p>

        <div className="login-tabs">
          <Segmented<Mode>
            fill
            variant="tabs"
            ariaLabel={t('登录或注册')}
            options={[
              { id: 'login', label: t('登录') },
              { id: 'register', label: t('邀请码注册') },
            ]}
            value={mode}
            onChange={switchMode}
          />
        </div>

        <form className="login-form" onSubmit={submit}>
          {mode === 'register' && (
            <label className="login-field">
              <span>{t('邀请码')}</span>
              <input
                value={inviteCode}
                onChange={(e) => {
                  setInviteCode(e.target.value);
                  setError('');
                }}
                placeholder="XXXX-XXXX-XXXX-XXXX"
                autoComplete="one-time-code"
                spellCheck={false}
                autoFocus
                required
              />
            </label>
          )}

          <label className="login-field">
            <span>{t('用户名')}</span>
            <input
              value={username}
              onChange={(e) => {
                setUsername(e.target.value);
                setError('');
              }}
              autoComplete="username"
              spellCheck={false}
              maxLength={24}
              autoFocus={mode === 'login'}
              required
            />
          </label>

          {mode === 'register' && (
            <label className="login-field">
              <span>{t('显示名（可选）')}</span>
              <input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                autoComplete="nickname"
                maxLength={40}
              />
            </label>
          )}

          <label className="login-field">
            <span>{t('密码')}</span>
            <input
              type="password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setError('');
              }}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              spellCheck={false}
              maxLength={128}
              minLength={mode === 'register' ? 8 : undefined}
              required
            />
          </label>

          {error && (
            <div className="login-error" role="alert">
              {error}
            </div>
          )}

          <button type="submit" className="login-submit" disabled={busy}>
            {busy
              ? mode === 'login'
                ? t('登录中…')
                : t('注册中…')
              : mode === 'login'
                ? t('登录')
                : t('注册')}
          </button>
        </form>

        <p className="login-foot">
          {mode === 'login'
            ? t('还没有账号？向管理员索要邀请码后注册。')
            : t('邀请码由管理员生成，一次性使用；注册后自动登录。')}
        </p>

        <p className="login-note">{t('数据保存在你自己的账号下，只有你能看到。')}</p>
      </div>
    </div>
  );
}
