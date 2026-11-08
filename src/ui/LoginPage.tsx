import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useT } from '../i18n';
import Segmented from './Segmented';
import LoginBackdrop from './LoginBackdrop';
import LoginBrandRow from './LoginBrandRow';
import { WiggleText } from './LoginSlogan';
import { ClimberMark } from './ClimberMark';
import CloseIcon from './CloseIcon';
import './LoginPage.css';

type Mode = 'login' | 'register';

interface Props {
  /** 登录 / 注册成功后由 App 处理（当前实现：整页 reload，重新走启动流程） */
  onLoggedIn: () => void;
  /** 主题标语（设置 → 通用 → 主题，只存本机）；null = i18n 默认文案，空串 = 不显示（D-269） */
  slogan?: string | null;
}

/**
 * 登录 / 邀请码注册页（2026-11-06 M6 P2-1，D-200）
 *
 * 只在 `AUTH_MODE=multi`（云端多用户）且未登录时显示；本地模式（默认）不会走到这里。
 * 登录成功后服务端下发 HttpOnly + SameSite=Lax 会话 Cookie，前端不需要保存 token。
 */
export default function LoginPage({ onLoggedIn, slogan }: Props) {
  const t = useT();
  const [mode, setMode] = useState<Mode>('login');
  /** 2026-11-08（用户要求）：登录卡默认折叠在左下角按钮里，点「开始记录我的旅迹」才弹出 */
  const [open, setOpen] = useState(false);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const launchRef = useRef<HTMLButtonElement | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // 打开卡片后再聚焦第一个输入框（折叠状态下不能靠 autoFocus 抢焦点）
  useEffect(() => {
    if (!open) return;
    const first = cardRef.current?.querySelector<HTMLInputElement>('input');
    first?.focus({ preventScroll: true });
  }, [open, mode]);

  /** 收起卡片并把焦点还给左下角按钮（键盘 / 读屏用户不会丢焦点） */
  const closeCard = () => {
    setOpen(false);
    requestAnimationFrame(() => launchRef.current?.focus());
  };

  const switchMode = (next: Mode) => {
    if (next === mode) return;
    setMode(next);
    setError('');
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError('');
    // D-311 / D-312（用户截图反馈「填写此字段」原生气泡样式不统一）：表单加 noValidate，
    // 空值 / 长度在提交时用应用内联错误提示，不再弹浏览器原生校验气泡。
    if (!username.trim()) {
      setError(t('请输入用户名'));
      return;
    }
    if (!password) {
      setError(t('请输入密码'));
      return;
    }
    if (mode === 'register') {
      if (!inviteCode.trim()) {
        setError(t('请填写邀请码'));
        return;
      }
      if (password.length < 8) {
        setError(t('密码至少 8 位'));
        return;
      }
    }
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
    <div className={mode === 'register' ? 'login-page is-register' : 'login-page'}>
      {/* 2026-11-08 D-266：中国地图品牌背景（省界自绘 + 项目图标，无 Key 依赖） */}
      <LoginBackdrop />
      {/* 2026-11-08 D-277（用户要求）：左上角改为「正式 Logo + 右侧缩小的主题标语」 */}
      <LoginBrandRow slogan={slogan} />
      <div
        ref={cardRef}
        id="login-card"
        className={open ? 'login-card login-card-collapsible is-open' : 'login-card login-card-collapsible'}
        inert={!open}
        aria-hidden={!open}
      >
        {/* 2026-11-08（用户要求）：折叠回左下角按钮 */}
        <button
          type="button"
          className="login-card-close"
          onClick={closeCard}
          aria-label={t('关闭')}
          title={t('关闭')}
        >
          <CloseIcon />
        </button>
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

        <form className="login-form" onSubmit={submit} noValidate>
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
                aria-required="true"
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
              aria-required="true"
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
              aria-required="true"
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

      {/* 2026-11-08（用户要求）：左下角「开始记录我的旅迹」按钮（大按钮组单个按钮观感），
          点击弹出 / 收起登录卡；登录卡右上角 × 也能收起 */}
      <button
        type="button"
        ref={launchRef}
        className={open ? 'login-launch is-open' : 'login-launch'}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="login-card"
        aria-label={t('开始记录我的旅迹')}
      >
        {/* 2026-11-08 D-277（用户要求）：图标换成刚刚定稿的徒步者小人物（纯黑，白底按钮上可读），
            悬停时小人物轻跳一下；按钮整体更大、字重更粗。
            2026-11-08 D-303：文字逐字拆开做随机摇晃 / 悬停回正（小人物不动）。 */}
        <span className="login-launch-mark" aria-hidden="true">
          <ClimberMark />
        </span>
        <span className="login-launch-text" aria-hidden="true">
          <WiggleText text={t('开始记录我的旅迹')} />
        </span>
      </button>
    </div>
  );
}
