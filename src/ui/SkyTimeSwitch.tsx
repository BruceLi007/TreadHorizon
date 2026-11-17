/**
 * 欢迎页左下角的「时段」小控件（2026-11-17，用户要求：加一个控件，不动的时候随时间自动变）。
 *
 * 五档：自动 / 日出 / 中午 / 日落 / 午夜。手绘线性小图标，选中项是墨色圆点；
 * 深色时段（日落 / 午夜）整枚控件自动换成深玻璃底 + 浅色图标（见 SkyTimeSwitch.css）。
 */
import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import { SKY_LABELS, SKY_TIMES, type SkyMode } from './skyTime';
import './SkyTimeSwitch.css';

function SkyModeIcon({ mode }: { mode: SkyMode }) {
  const common = {
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  if (mode === 'auto') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <circle cx="12" cy="12" r="7.6" {...common} />
        <path d="M12 7.8V12l3 1.8" {...common} />
        <path d="M12 2.6v1.2M12 20.2v1.2M2.6 12h1.2M20.2 12h1.2" {...common} strokeWidth={1.3} />
      </svg>
    );
  }
  if (mode === 'noon') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <circle cx="12" cy="12" r="3.6" {...common} />
        <path
          d="M12 3.2v2M12 18.8v2M3.2 12h2M18.8 12h2M5.9 5.9l1.4 1.4M16.7 16.7l1.4 1.4M18.1 5.9l-1.4 1.4M7.3 16.7l-1.4 1.4"
          {...common}
          strokeWidth={1.5}
        />
      </svg>
    );
  }
  if (mode === 'night') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M15.2 3.6a8.4 8.4 0 1 0 5.2 12.6 6.9 6.9 0 0 1-5.2-12.6Z" {...common} />
        <path d="M18.6 3.4l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7Z" {...common} strokeWidth={1.2} />
      </svg>
    );
  }
  // 日出 / 日落：地平线 + 半个太阳，箭头朝上 / 朝下区分
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M3 16.6h18" {...common} />
      <path d="M7 16.6a5 5 0 0 1 10 0" {...common} />
      {mode === 'sunrise' ? (
        <path d="M12 2.8v3.6M10.3 4.6 12 2.8l1.7 1.8" {...common} />
      ) : (
        <path d="M12 6.4V2.8M10.3 4.6 12 6.4l1.7-1.8" {...common} />
      )}
      <path d="M4.4 19.4h6M13.6 19.4h6" {...common} strokeWidth={1.2} opacity="0.55" />
    </svg>
  );
}

interface Props {
  mode: SkyMode;
  onChange: (mode: SkyMode) => void;
}

/** 点一下之后维持「完全显示」的时长（ms）——见下方 is-awake 说明 */
const AWAKE_MS = 2600;

export default function SkyTimeSwitch({ mode, onChange }: Props) {
  const t = useT();
  const order: SkyMode[] = ['auto', ...SKY_TIMES];
  /**
   * 2026-11-17 D-521（用户要求「半透明，点击变不透明」）：
   * 分享页把整个控件压到半透明（`html[data-share] .sky-switch{opacity:.45}`），
   * 但 iOS Safari 点按钮**不会**让按钮拿到焦点，只靠 `:focus-within` 会点完立刻退回半透明。
   * 所以这里点一下就把容器点亮 2.6s（`.is-awake`），四个时段都能看清后再淡回去；
   * 安装版欢迎页本来就是不透明的，这个 class 对那边没有可见影响。
   */
  const [awake, setAwake] = useState(false);
  const awakeTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (awakeTimer.current != null) window.clearTimeout(awakeTimer.current);
    },
    []
  );
  const pick = (m: SkyMode) => {
    onChange(m);
    setAwake(true);
    if (awakeTimer.current != null) window.clearTimeout(awakeTimer.current);
    awakeTimer.current = window.setTimeout(() => setAwake(false), AWAKE_MS);
  };
  return (
    <div className={awake ? 'sky-switch is-awake' : 'sky-switch'} role="group" aria-label={t('欢迎页时段')}>
      {order.map((m) => {
        const label = m === 'auto' ? t('自动（跟随当前时间）') : t(SKY_LABELS[m]);
        return (
          <button
            key={m}
            type="button"
            className={`sky-switch-btn${mode === m ? ' is-on' : ''}`}
            onClick={() => pick(m)}
            aria-pressed={mode === m}
            aria-label={label}
            title={label}
          >
            <SkyModeIcon mode={m} />
          </button>
        );
      })}
    </div>
  );
}
