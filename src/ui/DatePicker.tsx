/**
 * 2026-11-07 D-247：自定义日期选择器（替换浏览器原生 <input type="date">）。
 * 2026-11-10 D-343（用户要求，参考 Windows 经典日期选择器）：升级为「日 → 月 → 年」三级钻取交互——
 *   - 弹层默认「日」视图：‹ › 翻月，点标题（2026年11月）升到「月」视图；
 *   - 「月」视图：‹ › 翻年，点标题（2026年）升到「年」视图；
 *   - 「年」视图：‹ › 翻十年（2020–2029），点某一年 → 回到「月」视图；选月 → 回到「日」视图；选日 → 关闭。
 * 其余保持：Portal 挂 body 防裁切、深浅主题变量、中英文、Esc / 点外部关闭、今天按钮。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLang, useT } from '../i18n';
import './DatePicker.css';

const pad = (n: number) => String(n).padStart(2, '0');

const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_ZH = MONTHS_EN.map((_, i) => `${i + 1}月`);
const WEEKDAYS_EN = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const WEEKDAYS_ZH = ['一', '二', '三', '四', '五', '六', '日'];

type Mode = 'days' | 'months' | 'years';

const toISO = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

interface DateParts {
  y: number;
  m: number;
  d: number;
}

const parseISO = (value: string): DateParts | null => {
  const hit = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!hit) return null;
  const y = Number(hit[1]);
  const m = Number(hit[2]);
  const d = Number(hit[3]);
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return { y, m, d };
};

const todayParts = (): DateParts => {
  const d = new Date();
  return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() };
};

const daysInMonth = (y: number, m: number) => new Date(y, m, 0).getDate();

/** 周一为一周第一天：0=周一 … 6=周日 */
const mondayIndex = (y: number, m: number) => (new Date(y, m - 1, 1).getDay() + 6) % 7;

const shiftMonth = (view: { y: number; m: number }, delta: number) => {
  const total = view.y * 12 + (view.m - 1) + delta;
  return { y: Math.floor(total / 12), m: (total % 12) + 1 };
};

const decadeStart = (year: number) => Math.floor(year / 10) * 10;

interface Props {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
}

export default function DatePicker({ value, onChange, disabled = false, className = '' }: Props) {
  const t = useT();
  const lang = useLang();
  const selected = parseISO(value);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>('days');
  const [view, setView] = useState<{ y: number; m: number }>(() => {
    const p = selected ?? todayParts();
    return { y: p.y, m: p.m };
  });
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const close = useCallback((refocus = false) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  const openPop = () => {
    if (disabled) return;
    const p = selected ?? todayParts();
    setView({ y: p.y, m: p.m });
    setMode('days');
    setOpen(true);
  };

  // 弹层定位：优先在触发器下方，空间不够翻到上方；窗口尺寸 / 滚动时重新定位
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const update = () => {
      const el = triggerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const width = 272;
      const height = 344;
      const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
      let top = r.bottom + 6;
      if (top + height > window.innerHeight - 8) top = Math.max(8, r.top - height - 6);
      setPos({ left, top });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open]);

  // 点外部 / Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (popRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      close(true);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);

  const choose = (iso: string) => {
    onChange(iso);
    close(true);
  };

  const weekdays = lang === 'en' ? WEEKDAYS_EN : WEEKDAYS_ZH;
  const months = lang === 'en' ? MONTHS_EN : MONTHS_ZH;
  const today = todayParts();
  const todayIso = toISO(today.y, today.m, today.d);

  // 当前月网格（含前后补位，周一开头）
  const cells: { iso: string; day: number; outside: boolean }[] = [];
  const leading = mondayIndex(view.y, view.m);
  const prev = shiftMonth(view, -1);
  const prevDays = daysInMonth(prev.y, prev.m);
  for (let i = leading; i > 0; i -= 1) {
    const day = prevDays - i + 1;
    cells.push({ iso: toISO(prev.y, prev.m, day), day, outside: true });
  }
  const total = daysInMonth(view.y, view.m);
  for (let day = 1; day <= total; day += 1) {
    cells.push({ iso: toISO(view.y, view.m, day), day, outside: false });
  }
  const next = shiftMonth(view, 1);
  let nextDay = 1;
  while (cells.length % 7 !== 0) {
    cells.push({ iso: toISO(next.y, next.m, nextDay), day: nextDay, outside: true });
    nextDay += 1;
  }

  // ── 三级视图的标题 / 导航文案 ──
  const start = decadeStart(view.y);
  const title =
    mode === 'days'
      ? lang === 'en'
        ? `${months[view.m - 1]} ${view.y}`
        : `${view.y}年${view.m}月`
      : mode === 'months'
        ? lang === 'en'
          ? String(view.y)
          : `${view.y}年`
        : `${start} – ${start + 9}`;

  const prevLabel =
    mode === 'days' ? t('上个月') : mode === 'months' ? t('上一年') : t('上十年');
  const nextLabel =
    mode === 'days' ? t('下个月') : mode === 'months' ? t('下一年') : t('下十年');

  /** 按当前级别翻页：日=翻月，月=翻年，年=翻十年 */
  const step = (delta: number) =>
    setView((v) => {
      if (mode === 'days') return shiftMonth(v, delta);
      if (mode === 'months') return { ...v, y: v.y + delta };
      return { ...v, y: v.y + delta * 10 };
    });

  /** 标题点击：日 → 月 → 年（年视图已是最高级，不再上钻） */
  const drillUp = () => {
    if (mode === 'days') setMode('months');
    else if (mode === 'months') setMode('years');
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`date-trigger ${className}`.trim()}
        onClick={() => (open ? close(false) : openPop())}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('选择日期')}
        title={t('选择日期')}
      >
        <span className="date-trigger-text">{selected ? value : t('选择日期')}</span>
        <svg className="date-trigger-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="3" y="5.5" width="18" height="15" rx="3" stroke="currentColor" strokeWidth="1.6" />
          <path d="M3 10.5h18M8 3v4.5M16 3v4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            className="date-pop"
            ref={popRef}
            role="dialog"
            aria-label={t('选择日期')}
            style={{ left: pos.left, top: pos.top }}
          >
            <div className="date-pop-head">
              <button
                type="button"
                className="dp-nav"
                aria-label={prevLabel}
                title={prevLabel}
                onClick={() => step(-1)}
              >
                ‹
              </button>
              {mode === 'years' ? (
                <span className="dp-title dp-title-static">{title}</span>
              ) : (
                <button
                  type="button"
                  className="dp-title"
                  aria-label={mode === 'days' ? t('选择年月') : t('选择年份')}
                  title={mode === 'days' ? t('选择年月') : t('选择年份')}
                  onClick={drillUp}
                >
                  {title}
                </button>
              )}
              <button
                type="button"
                className="dp-nav"
                aria-label={nextLabel}
                title={nextLabel}
                onClick={() => step(1)}
              >
                ›
              </button>
            </div>

            {mode === 'days' && (
              <>
                <div className="date-pop-week">
                  {weekdays.map((w) => (
                    <span key={w}>{w}</span>
                  ))}
                </div>
                <div className="date-pop-grid">
                  {cells.map((cell) => {
                    const on = Boolean(
                      selected &&
                        selected.y === Number(cell.iso.slice(0, 4)) &&
                        selected.m === Number(cell.iso.slice(5, 7)) &&
                        selected.d === Number(cell.iso.slice(8, 10))
                    );
                    const isToday = cell.iso === todayIso;
                    return (
                      <button
                        key={cell.iso + (cell.outside ? 'o' : '')}
                        type="button"
                        className={
                          'dp-day' +
                          (cell.outside ? ' outside' : '') +
                          (on ? ' on' : '') +
                          (isToday ? ' today' : '')
                        }
                        aria-label={cell.iso}
                        aria-pressed={on}
                        onClick={() => choose(cell.iso)}
                      >
                        {cell.day}
                      </button>
                    );
                  })}
                </div>
                <div className="date-pop-foot">
                  <button type="button" className="dp-today" onClick={() => choose(todayIso)}>
                    {t('今天')}
                  </button>
                </div>
              </>
            )}

            {mode === 'months' && (
              <div className="date-pop-months">
                {months.map((label, i) => (
                  <button
                    key={label}
                    type="button"
                    className={'dp-month' + (i + 1 === view.m ? ' on' : '')}
                    aria-pressed={i + 1 === view.m}
                    onClick={() => {
                      setView((v) => ({ ...v, m: i + 1 }));
                      setMode('days');
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}

            {mode === 'years' && (
              <div className="date-pop-years">
                {Array.from({ length: 10 }, (_, i) => start + i).map((year) => (
                  <button
                    key={year}
                    type="button"
                    className={'dp-year' + (year === view.y ? ' on' : '')}
                    aria-pressed={year === view.y}
                    onClick={() => {
                      setView((v) => ({ ...v, y: year }));
                      setMode('months');
                    }}
                  >
                    {year}
                  </button>
                ))}
              </div>
            )}
          </div>,
          document.body
        )}
    </>
  );
}
