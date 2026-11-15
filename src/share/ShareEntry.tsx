/**
 * 2026-11-15 D-423（用户验收反馈）：
 * 分享页改为**复用正式版前端**——欢迎页用正式版欢迎页（LocalEntryPage），
 * 进入后就是同一个 App（只读），界面 / 交互与正式版一致。
 * 数据来自分享 manifest，通过 guestApi 适配成正式版的数据形状。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import App from '../App';
import LocalEntryPage from '../ui/LocalEntryPage';
import LoginBackdrop from '../ui/LoginBackdrop';
import LoginBrandRow from '../ui/LoginBrandRow';
import { applyUiPrefs } from '../lib/uiPrefs';
import ShareKeyDialog from './ShareKeyDialog';
import { loadShare, unlockShare, type PublicShare } from './api';
import { buildShareSource, type ShareSource } from './shareSource';
import { patchGuestApi, SHARE_KEY_STORAGE } from './guestApi';
import { GUEST_TIP, setGuestMode } from './guestFlag';
import { makeShareT, type ShareLang } from './i18n';
import './share.css';

const SHARE_LANG: ShareLang = 'zh';
type Stage = 'loading' | 'password' | 'welcome' | 'app' | 'expired' | 'revoked' | 'notfound' | 'error';

function tokenFromPath(): string {
  const m = window.location.pathname.match(/^\/s\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

const readKey = () => {
  try {
    return localStorage.getItem(SHARE_KEY_STORAGE) || '';
  } catch {
    return '';
  }
};

/** 进入 App 后，把顶栏上「只读不可用」的入口置灰并挂上只读提示 */
function lockHud(): void {
  const sel = '.hud-share-btn, .hud-add, .settings-btn, .hud-avatar, .hud-username, .hud-icon';
  for (const el of document.querySelectorAll<HTMLElement>(sel)) {
    if (el.dataset.guestLocked === '1') continue;
    el.dataset.guestLocked = '1';
    el.classList.add('guest-locked');
    el.setAttribute('title', GUEST_TIP);
    el.setAttribute('aria-disabled', 'true');
    if (el instanceof HTMLButtonElement) el.disabled = true;
  }
}

export default function ShareEntry() {
  const token = useMemo(tokenFromPath, []);
  const t = makeShareT(SHARE_LANG);
  const [stage, setStage] = useState<Stage>('loading');
  const [pub, setPub] = useState<PublicShare | null>(null);
  const [source, setSource] = useState<ShareSource | null>(null);
  const [pw, setPw] = useState('');
  const [pwErr, setPwErr] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const [keyOpen, setKeyOpen] = useState(false);
  const [hasKey, setHasKey] = useState(Boolean(readKey()));

  // D-426：密码门 / 状态页在 App 挂载之前就要出图，先把正式版的主题 / 字体 / 字号档写到 <html>，
  // 否则会退化成系统字体，和正式版登录页 / Key 弹窗不是一套。
  useLayoutEffect(() => {
    applyUiPrefs();
  }, []);

  const load = useCallback(async () => {
    if (!token) {
      setStage('notfound');
      return;
    }
    const r = await loadShare(token);
    if (r.kind === 'ok') {
      const src = buildShareSource(token, r.data.manifest, r.data.expiresAt);
      // 先把 api 换成只读数据源，再挂载 App（App 的启动 effect 只在挂载时跑一次）
      patchGuestApi(src);
      setGuestMode(true);
      setPub(r.data);
      setSource(src);
      setStage('welcome');
      if (!readKey()) setKeyOpen(true);
      return;
    }
    if (r.kind === 'password') setStage('password');
    else if (r.kind === 'expired') setStage('expired');
    else if (r.kind === 'revoked') setStage('revoked');
    else if (r.kind === 'notfound') setStage('notfound');
    else setStage('error');
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  // 分享数据就绪后：App 已经在下面挂着（欢迎页盖在上面），这里持续把顶栏只读入口锁住
  useEffect(() => {
    if (!source) return;
    lockHud();
    const timer = window.setInterval(lockHud, 400);
    const mo = new MutationObserver(() => lockHud());
    mo.observe(document.body, { childList: true, subtree: true });
    return () => {
      window.clearInterval(timer);
      mo.disconnect();
    };
  }, [source]);

  // 欢迎页：量一下「开始浏览」按钮宽度，写进 --share-btn-w，让信息卡按按钮中心对齐（字号不同宽度会变）
  useEffect(() => {
    if (stage !== 'welcome') return;
    const measure = () => {
      const btn = document.querySelector<HTMLElement>('.login-launch');
      if (btn) {
        document.documentElement.style.setProperty('--share-btn-w', `${btn.offsetWidth}px`);
      }
    };
    measure();
    const timer = window.setInterval(measure, 600);
    window.addEventListener('resize', measure);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('resize', measure);
    };
  }, [stage]);

  const enter = () => setStage('app');

  if (!source) {
    if (stage === 'loading') {
      return (
        <div className="share-app">
          <div className="share-stage">
            <div className="share-spinner" />
          </div>
        </div>
      );
    }
    if (stage === 'password') {
      // D-426（用户验收反馈「这个界面样式没统一，字体不居中」）：
      // 密码门不再用 share.css 的裸卡片，改成与正式版登录页 / Key 引导页同一套外壳
      // （LoginBackdrop + LoginBrandRow + login-card），文案居中、控件走 login-field/login-submit 的 38px。
      return (
        <div className="login-page local-entry-page share-gate-page">
          <LoginBackdrop />
          <LoginBrandRow slogan={null} />
          <div className="key-modal-backdrop">
            <form
              className="login-card key-modal-card share-gate-card"
              onSubmit={async (e) => {
                e.preventDefault();
                if (pwBusy) return;
                setPwBusy(true);
                setPwErr('');
                const r = await unlockShare(token, pw);
                setPwBusy(false);
                if (r.ok) {
                  await load();
                  return;
                }
                setPwErr(r.status === 429 ? t('rateLimited') : t('wrongPassword'));
              }}
            >
              <div className="login-brand" aria-label="Tread Horizon">
                <span className="login-brand-name" aria-hidden="true">
                  Tread Horizon
                </span>
                <span className="login-brand-sub" aria-hidden="true">
                  {t('privateTitle')}
                </span>
              </div>
              <p className="login-lead">{t('privateHint')}</p>
              <div className="login-form">
                <label className="login-field">
                  <span>{t('passwordPlaceholder')}</span>
                  <input
                    type="password"
                    value={pw}
                    autoFocus
                    placeholder="••••••••"
                    onChange={(e) => {
                      setPw(e.target.value);
                      setPwErr('');
                    }}
                  />
                </label>
                {pwErr && (
                  <div className="login-error" role="alert">
                    {pwErr}
                  </div>
                )}
                <button type="submit" className="login-submit" disabled={pwBusy || !pw.trim()}>
                  {pwBusy ? t('unlocking') : t('unlock')}
                </button>
              </div>
            </form>
          </div>
        </div>
      );
    }
    const title =
      stage === 'expired'
        ? t('expiredTitle')
        : stage === 'revoked'
          ? t('revokedTitle')
          : stage === 'notfound'
            ? t('notFoundTitle')
            : t('errorTitle');
    const body =
      stage === 'expired'
        ? t('expiredBody')
        : stage === 'revoked'
          ? t('revokedBody')
          : stage === 'notfound'
            ? t('notFoundBody')
            : t('errorBody');
    return (
      <div className="login-page local-entry-page share-gate-page">
        <LoginBackdrop />
        <LoginBrandRow slogan={null} />
        <div className="key-modal-backdrop">
          <div className="login-card key-modal-card share-gate-card">
            <div className="login-brand" aria-label="Tread Horizon">
              <span className="login-brand-name" aria-hidden="true">
                Tread Horizon
              </span>
            </div>
            <p className="login-lead">{title}</p>
            <p className="login-foot">{body}</p>
          </div>
        </div>
      </div>
    );
  }

  const rawTitle = (pub?.title || '').trim();
  // 老分享的标题可能被导出侧回退成「起止日期」，那种就当作没标题，只在下面以「时段」展示
  const shareTitle = /^\d{4}-\d{2}-\d{2}\s*~\s*\d{4}-\d{2}-\d{2}$/.test(rawTitle) ? '' : rawTitle;
  const range = (() => {
    const r = source.manifest.range;
    if (r?.from && r?.to) return r;
    const dates = source.manifest.places
      .flatMap((p) => p.visits.map((v) => v.date))
      .filter(Boolean)
      .sort();
    return dates.length ? { from: dates[0], to: dates[dates.length - 1] } : null;
  })();

  const exp = pub?.expiresAt
    ? new Date(pub.expiresAt).toLocaleString('zh-CN', { hour12: false })
    : '';

  return (
    <>
      {/* App 一开始就挂载：地图按正式版的方式在页面加载时初始化，进入后不会因为换容器而错位 */}
      <App />
      {stage === 'welcome' && (
        <div className="share-cover">
          <LocalEntryPage
            onEnter={enter}
            ctaLabel="开始浏览"
            overlay={
              <>
                <div className="share-welcome-card">
                  <p className="share-welcome-by">
                    分享自 <b>{source.displayName || 'Traveler'}</b>
                  </p>
                  {shareTitle ? <p className="share-welcome-title">{shareTitle}</p> : null}
                  {range ? (
                    <p className="share-welcome-range">
                      {range.from === range.to ? `时段 ${range.from}` : `时段 ${range.from} ~ ${range.to}`}
                    </p>
                  ) : null}
                  <p className="share-welcome-meta">
                    {`${source.manifest.counts.places} 个地点 · ${source.manifest.counts.visits} 次到访 · ${source.manifest.counts.photos} 张照片`}
                    {exp ? ` · ${exp} 失效` : ' · 长期有效'}
                  </p>
                  <button
                    type="button"
                    className="share-welcome-key"
                    onClick={() => setKeyOpen(true)}
                  >
                    {hasKey ? '更换地图 Key' : '填写地图 Key'}
                  </button>
                </div>
                {keyOpen && (
                  <ShareKeyDialog
                    lang={SHARE_LANG}
                    hasKey={hasKey}
                    onClose={() => {
                      setHasKey(Boolean(readKey()));
                      setKeyOpen(false);
                    }}
                  />
                )}
              </>
            }
          />
        </div>
      )}
    </>
  );
}
