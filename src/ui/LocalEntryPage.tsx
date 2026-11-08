/**
 * 本地模式启动欢迎页（2026-11-08 D-281，用户要求：「本地版也把这个界面加上，只不过点击不需要登录」）。
 *
 * 本地版（默认 `AUTH_MODE=local`）也显示与云端登录页同一套界面：
 * Q 版 3D 中国地图背景 + 左上正式 Logo / 主题标语 + 右上太阳 + 34 省自动卡片 + 右下入口按钮；
 * 区别：没有登录卡 / 注册卡，点「开始记录我的旅迹」直接进入应用（不需要账号密码）。
 *
 * 样式全部复用 `LoginPage.css`（`.login-page` / `.login-launch` 等），
 * 背景与品牌行复用 `LoginBackdrop` / `LoginBrandRow`，与登录页、Key 引导页保持一致。
 * 只在 local 模式、且天地图 Key 已配置时显示（未配置 Key 时先走 KeySetupPage，避免首次使用被多挡一层）。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useT } from '../i18n';
import LoginBackdrop from './LoginBackdrop';
import LoginBrandRow from './LoginBrandRow';
import { ClimberMark } from './ClimberMark';
import { WiggleText } from './LoginSlogan';
import './LoginPage.css';

interface Props {
  /** 点按钮后真正进入应用（App 切换到主界面） */
  onEnter: () => void;
  /** 主题标语（设置 → 通用 → 主题，只存本机）；null = i18n 默认文案，空串 = 不显示 */
  slogan?: string | null;
  /**
   * 右下按钮文案（2026-11-08 D-312，用户要求）：缺天地图 Key 时复用本页，
   * 按钮显示「请填写地图Key」，点击重新打开 Key 小窗。
   */
  ctaLabel?: string;
  /** 点按钮后是否跳过淡出动画直接执行（D-313：Key 小窗用，避免像整页刷新） */
  instant?: boolean;
  /** 叠加在本页上的内容（D-313：Key 引导小窗，保持背景不换、页面不刷新） */
  overlay?: ReactNode;
}

/** 系统是否要求减少动态效果（此时不做淡出，点了立刻进入） */
const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** 淡出时长（与 CSS `.local-entry-page` 的 transition 一致） */
const LEAVE_MS = 240;

export default function LocalEntryPage({ onEnter, slogan, ctaLabel, instant, overlay }: Props) {
  const t = useT();
  const label = ctaLabel ?? t('开始记录我的旅迹');
  /** 点击后先淡出再进入应用，避免明亮欢迎页直接切到深色地图的硬切感 */
  const [leaving, setLeaving] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current != null) window.clearTimeout(timer.current);
    },
    []
  );

  const enter = () => {
    if (leaving) return;
    if (instant || prefersReducedMotion()) {
      onEnter();
      return;
    }
    setLeaving(true);
    timer.current = window.setTimeout(onEnter, LEAVE_MS);
  };

  return (
    <div
      className={leaving ? 'login-page local-entry-page is-leaving' : 'login-page local-entry-page'}
    >
      {/* 与登录页 / Key 引导页共用的中国地图品牌背景 */}
      <LoginBackdrop />
      {/* 左上角正式 Logo + 右侧缩小的主题标语 */}
      <LoginBrandRow slogan={slogan} />
      {/* 右下角入口按钮：点击不需要登录，直接进入应用 */}
      <button
        type="button"
        className="login-launch"
        onClick={enter}
        disabled={leaving}
        aria-label={label}
        title={label}
      >
        <span className="login-launch-mark" aria-hidden="true">
          <ClimberMark />
        </span>
        {/* 2026-11-08 D-303：文字逐字拆开做随机摇晃 / 悬停回正（小人物不动） */}
        <span className="login-launch-text" aria-hidden="true">
          <WiggleText text={label} />
        </span>
      </button>
      {/* 2026-11-08 D-313：Key 引导小窗叠加在本页上（背景不换、页面不刷新） */}
      {overlay}
    </div>
  );
}
