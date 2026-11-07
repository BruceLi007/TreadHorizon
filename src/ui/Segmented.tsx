import { useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import './Segmented.css';

export interface SegmentedOption<T extends string> {
  id: T;
  label: ReactNode;
  /** 右侧小数字（可选，如数量 / 张数） */
  count?: number;
  /** 悬停提示 */
  title?: string;
}

interface Props<T extends string> {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (id: T) => void;
  ariaLabel?: string;
  /** tabs = 选项卡语义；radio = 单选筛选语义（默认 tabs） */
  variant?: 'tabs' | 'radio';
  size?: 'sm' | 'md';
  /** 均分宽度；默认按内容宽度 */
  fill?: boolean;
  /** 超宽时横向滚动（年份等长列表） */
  scrollable?: boolean;
  disabled?: boolean;
  className?: string;
}

/**
 * 统一的「并列按钮」分段控件（2026-11-04，D-98）。
 *
 * 外观：一条浅色轨道 + 一个滑动的白色/浅色滑块（滑块随选中项左右滑动），
 * 取代项目里原先「每个选项一个胶囊、选中变琥珀描边」的样式（如 My旅迹筛选）。
 *
 * 滑块位置/宽度用按钮实际几何测量（ResizeObserver + window resize），
 * 所以选项文字长短不一、或放进可横向滚动的容器（照片墙年份）也能贴合。
 * 只负责展示与单选回调，不改任何业务逻辑。
 */
export default function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  variant = 'tabs',
  size = 'md',
  fill = false,
  scrollable = false,
  disabled = false,
  className,
}: Props<T>) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [geo, setGeo] = useState<{ x: number; w: number }>({ x: 0, w: 0 });
  const [ready, setReady] = useState(false);
  const idx = Math.max(0, options.findIndex((o) => o.id === value));

  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const measure = () => {
      const el = btnRefs.current[idx];
      if (!el) return;
      setGeo((cur) =>
        cur.x === el.offsetLeft && cur.w === el.offsetWidth
          ? cur
          : { x: el.offsetLeft, w: el.offsetWidth }
      );
    };
    measure();
    // 首帧只定位不做动画（避免宽高从 0 长出来），下一帧再打开过渡
    const raf = window.requestAnimationFrame(() => setReady(true));
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(wrap);
    btnRefs.current.forEach((b) => b && ro?.observe(b));
    window.addEventListener('resize', measure);
    return () => {
      window.cancelAnimationFrame(raf);
      ro?.disconnect();
      window.removeEventListener('resize', measure);
    };
    // 选项数量 / 选中项 / 尺寸档变化时重新测量
  }, [idx, options.length, size]);

  const cls = [
    'seg',
    size === 'sm' ? 'seg-sm' : '',
    fill ? 'seg-fill' : '',
    scrollable ? 'seg-scroll' : '',
    disabled ? 'seg-disabled' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      ref={wrapRef}
      className={cls}
      role={variant === 'radio' ? 'radiogroup' : 'tablist'}
      aria-label={ariaLabel}
    >
      <span
        className={ready ? 'seg-thumb ready' : 'seg-thumb'}
        aria-hidden="true"
        style={{ width: geo.w, transform: `translateX(${geo.x}px)` }}
      />
      {options.map((o, i) => {
        const active = o.id === value;
        return (
          <button
            key={o.id}
            ref={(el) => {
              btnRefs.current[i] = el;
            }}
            type="button"
            role={variant === 'radio' ? 'radio' : 'tab'}
            aria-checked={variant === 'radio' ? active : undefined}
            aria-selected={variant === 'radio' ? undefined : active}
            disabled={disabled}
            className={active ? 'seg-btn on' : 'seg-btn'}
            title={o.title}
            onClick={() => {
              if (!active) onChange(o.id);
            }}
          >
            <span className="seg-label">{o.label}</span>
            {o.count != null && (
              <span className="seg-count">{o.count > 99 ? '99+' : o.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
