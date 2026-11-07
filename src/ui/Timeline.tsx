import { useEffect, useMemo, useRef, useState } from 'react';
import CompanionFilter from './CompanionFilter';
import CloseIcon from './CloseIcon';
import { useT } from '../i18n';

export interface RangeValue {
  from: string;
  to: string;
}

export type Granularity = 'day' | 'week' | 'month' | 'quarter' | 'year';

export const GRANULARITIES: { key: Granularity; label: string }[] = [
  { key: 'day', label: '天' },
  { key: 'week', label: '周' },
  { key: 'month', label: '月' },
  { key: 'quarter', label: '季度' },
  { key: 'year', label: '年' },
];

const DAY = 86400000;
/** 'YYYY-MM-DD' → 自 1970-01-01 起的天数（UTC，避免时区/夏令时干扰） */
export function dayOf(date: string): number {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return Math.floor(Date.UTC(y, m - 1, d) / DAY);
}

export function dateOf(day: number): string {
  return new Date(day * DAY).toISOString().slice(0, 10);
}

function addMonths(day: number, months: number): number {
  const src = new Date(day * DAY);
  const y = src.getUTCFullYear();
  const m = src.getUTCMonth();
  const d = src.getUTCDate();
  const first = new Date(Date.UTC(y, m + months, 1));
  const daysInMonth = new Date(
    Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)
  ).getUTCDate();
  first.setUTCDate(Math.min(d, daysInMonth));
  return Math.floor(first.getTime() / DAY);
}

/** 播放步长：按天/周/月/季度/年推进一个单位（月末会做夹取，如 1-31 +1 月 → 2-28） */
export function stepDay(day: number, gran: Granularity): number {
  switch (gran) {
    case 'day':
      return day + 1;
    case 'week':
      return day + 7;
    case 'month':
      return addMonths(day, 1);
    case 'quarter':
      return addMonths(day, 3);
    case 'year':
      return addMonths(day, 12);
  }
}

/** 与 stepDay 相反：退回一个单位（月末/闰日同样夹取） */
export function prevDay(day: number, gran: Granularity): number {
  switch (gran) {
    case 'day':
      return day - 1;
    case 'week':
      return day - 7;
    case 'month':
      return addMonths(day, -1);
    case 'quarter':
      return addMonths(day, -3);
    case 'year':
      return addMonths(day, -12);
  }
}

/** 「跳空白天」：返回严格大于 day 的下一个到访日；没有更晚的到访就落到最后一天 */
export function nextEventDay(day: number, eventDays: number[], maxDay: number): number {
  for (const d of eventDays) if (d > day) return Math.min(d, maxDay);
  return maxDay;
}

/** 「跳空白天」：返回严格小于 day 的上一个到访日；没有更早的到访就落到第一天 */
export function prevEventDay(day: number, eventDays: number[], minDay: number): number {
  for (let i = eventDays.length - 1; i >= 0; i--) {
    if (eventDays[i] < day) return Math.max(eventDays[i], minDay);
  }
  return minDay;
}

/**
 * 开「跳空白」时的前进一步：
 * 先按粒度走一格——这一格里有到访就正常走；整格都没有到访，才跳到下一个到访日。
 * 这样有到访的密集区间仍能按天/月细看，空白区间直接跳过。
 */
export function nextStepDay(
  cur: number,
  gran: Granularity,
  eventDays: number[],
  maxDay: number
): number {
  const step = Math.min(maxDay, stepDay(cur, gran));
  const hasEvent = eventDays.some((d) => d > cur && d <= step);
  if (hasEvent || step >= maxDay) return step;
  return Math.min(maxDay, nextEventDay(cur, eventDays, maxDay));
}

/** 开「跳空白」时的后退一步：逻辑与 nextStepDay 对称 */
export function prevStepDay(
  cur: number,
  gran: Granularity,
  eventDays: number[],
  minDay: number
): number {
  const step = Math.max(minDay, prevDay(cur, gran));
  const hasEvent = eventDays.some((d) => d > step && d <= cur);
  if (hasEvent || step <= minDay) return step;
  return Math.max(minDay, prevEventDay(cur, eventDays, minDay));
}

/** 播放节奏（毫秒/步）：粒度越小越快 */
const TICK: Record<Granularity, number> = {
  day: 120,
  week: 200,
  month: 260,
  quarter: 420,
  year: 620,
};

interface Props {
  meta: { first: string; last: string };
  /** 所有到访日期（用于播放时跳过空白） */
  eventDates?: string[];
  value: RangeValue | null;
  onChange: (v: RangeValue | null) => void;
  /** 点 ‹ / › 步进时通知外面（用于自动打开「去过清单」）；moved=false 表示已在时间轴两端 */
  onStep?: (moved: boolean) => void;
  /** F-BRW-06 随行人员筛选：当前选中的同行人（可多选，并集；空数组 = 不筛选）；过滤本身由 App 负责 */
  companions: string[];
  /** 选中/清除同行人（空数组 = 全部） */
  onCompanionsChange: (v: string[]) => void;
}

/**
 * 底部时间轴（F-BRW-03）
 * 双手柄框选区间；拖动时本地跟手，150ms 节流后才通知外面拉数据。
 * 播放：按选择的步长（天/周/月/季度/年）推进右手柄，地图上的点逐个浮现。
 */
export default function Timeline({
  meta,
  eventDates,
  value,
  onChange,
  onStep,
  companions,
  onCompanionsChange,
}: Props) {
  const t = useT();
  const minD = dayOf(meta.first);
  const maxD = dayOf(meta.last);
  const span = Math.max(1, maxD - minD);

  const [fromD, setFromD] = useState(() => (value ? dayOf(value.from) : dayOf(meta.first)));
  const [toD, setToD] = useState(() => (value ? dayOf(value.to) : dayOf(meta.last)));
  const [drag, setDrag] = useState<'from' | 'to' | null>(null);
  const [playing, setPlaying] = useState(false);
  const [gran, setGran] = useState<Granularity>('quarter');
  const [skipBlank, setSkipBlank] = useState(false);
  const trackRef = useRef<HTMLDivElement>(null);
  const throttle = useRef<number | null>(null);
  const playTimer = useRef<number | null>(null);

  /** 去重、排序后的到访日（天索引），播放「跳空白」时用 */
  const eventDays = useMemo(() => {
    const set = new Set<number>();
    for (const d of eventDates ?? []) {
      const n = dayOf(d);
      if (n >= minD && n <= maxD) set.add(n);
    }
    return [...set].sort((a, b) => a - b);
  }, [eventDates, minD, maxD]);

  // 外部值变化（点「全部」、外面清理筛选）时把本地手柄同步回去
  useEffect(() => {
    if (!value) {
      setFromD(minD);
      setToD(maxD);
    } else {
      setFromD(dayOf(value.from));
      setToD(dayOf(value.to));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value?.from, value?.to, meta.first, meta.last]);

  const emit = (f: number, t: number) => {
    if (throttle.current) window.clearTimeout(throttle.current);
    throttle.current = window.setTimeout(() => {
      if (f <= minD && t >= maxD) onChange(null);
      else onChange({ from: dateOf(f), to: dateOf(t) });
    }, 150);
  };

  const stopPlay = () => {
    setPlaying(false);
    if (playTimer.current) window.clearInterval(playTimer.current);
    playTimer.current = null;
  };

  useEffect(() => () => stopPlay(), []);

  // 播放：按当前粒度推进；开了「跳空白」时，整格空白就直接跳到下一个到访日
  useEffect(() => {
    if (!playing) return;
    const useSkip = skipBlank && eventDays.length > 0;
    const tickMs = useSkip ? 420 : TICK[gran];
    playTimer.current = window.setInterval(() => {
      setToD((cur) => {
        const next = useSkip
          ? nextStepDay(cur, gran, eventDays, maxD)
          : Math.min(maxD, stepDay(cur, gran));
        setFromD(minD);
        if (next >= maxD) {
          setPlaying(false);
          if (playTimer.current) window.clearInterval(playTimer.current);
          playTimer.current = null;
        }
        onChange(next >= maxD ? null : { from: dateOf(minD), to: dateOf(next) });
        return next;
      });
    }, tickMs);
    return () => {
      if (playTimer.current) window.clearInterval(playTimer.current);
      playTimer.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, gran, minD, maxD, skipBlank, eventDays]);

  useEffect(() => {
    if (!drag) return;
    const onMove = (e: PointerEvent) => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect) return;
      const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      const d = Math.round(minD + ratio * span);
      if (drag === 'from') {
        const next = Math.min(d, toD);
        setFromD(next);
        emit(next, toD);
      } else {
        const next = Math.max(d, fromD);
        setToD(next);
        emit(fromD, next);
      }
    };
    const onUp = () => {
      setDrag(null);
      // 松手时立刻用最终位置通知一次，不用再等 150ms 节流
      emit(fromD, toD);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [drag, minD, maxD, span, fromD, toD]);

  const startDrag = (e: React.PointerEvent, which: 'from' | 'to') => {
    e.preventDefault();
    stopPlay();
    setDrag(which);
  };

  /** 步进按钮：把「结束时间」往前/后挪一格；开关「跳空白」时，整格无到访则跳到到访日 */
  const stepRange = (dir: 1 | -1) => {
    stopPlay();
    const useSkip = skipBlank && eventDays.length > 0;
    const nextTo =
      dir > 0
        ? useSkip
          ? nextStepDay(toD, gran, eventDays, maxD)
          : Math.min(maxD, stepDay(toD, gran))
        : useSkip
          ? prevStepDay(toD, gran, eventDays, minD)
          : Math.max(minD, prevDay(toD, gran));
    const nextFrom = Math.min(fromD, nextTo);
    const moved = nextTo !== toD;
    setFromD(nextFrom);
    setToD(nextTo);
    if (nextTo >= maxD && nextFrom <= minD) onChange(null);
    else onChange({ from: dateOf(nextFrom), to: dateOf(nextTo) });
    // 步进时顺手打开右侧清单，方便对照这个区间里有哪些地点
    onStep?.(moved);
  };

  const granLabel = t(GRANULARITIES.find((g) => g.key === gran)?.label ?? '');

  const leftPct = ((fromD - minD) / span) * 100;
  const rightPct = ((toD - minD) / span) * 100;
  const filtered = fromD > minD || toD < maxD;
  /** 时间轴区间或随行筛选任一生效，都让时间轴保持高亮（复用已有的 .timeline.active） */
  const active = filtered || companions.length > 0;

  /** 时间轴上的筛选 chip：最多显示前两位，后面的用「+N」表示（完整名单在 title 里） */
  const companionChipText = companions.slice(0, 2).join(t('、'));
  const companionMore = Math.max(0, companions.length - 2);

  // 时间轴文字始终精确到「日」，无论跨度多长
  const label = (day: number) => dateOf(day).replace(/-/g, '.');

  return (
    <div className={active ? 'timeline active' : 'timeline'}>
      <div className="tl-head">
        <span className="tl-range">
          {label(fromD)} – {label(toD)}
        </span>
        {companions.length > 0 && (
          <button
            type="button"
            className="cf-chip"
            onClick={() => onCompanionsChange([])}
            title={t('清除随行人员筛选（{names}）', { names: companions.join(t('、')) })}
          >
            <span className="cf-chip-label">{t('已筛选：')}</span>
            <span className="cf-chip-names">{companionChipText}</span>
            {companionMore > 0 && <span className="cf-chip-more">+{companionMore}</span>}
            <span className="cf-chip-x" aria-hidden="true">
              <CloseIcon size={10} />
            </span>
          </button>
        )}
        <select
          className="tl-gran"
          value={gran}
          onChange={(e) => {
            stopPlay();
            setGran(e.target.value as Granularity);
          }}
          title={t('播放 / 步进的粒度')}
          aria-label={t('播放和步进的粒度')}
        >
          {GRANULARITIES.map((g) => (
            <option key={g.key} value={g.key}>
              {t(g.label)}
            </option>
          ))}
        </select>
        <button
          className={toD <= minD ? 'tl-step prev at-bound' : 'tl-step prev'}
          onClick={() => stepRange(-1)}
          title={
            toD <= minD
              ? t('已在最早时间（点一下打开去过清单）')
              : t('退一步（1 {gran}）', { gran: granLabel })
          }
          aria-label={
            toD <= minD ? t('已在最早时间') : t('退一步（1 {gran}）', { gran: granLabel })
          }
        />
        <button
          className={toD >= maxD ? 'tl-step next at-bound' : 'tl-step next'}
          onClick={() => stepRange(1)}
          title={
            toD >= maxD
              ? t('已在最晚时间（点一下打开去过清单）')
              : t('进一步（1 {gran}）', { gran: granLabel })
          }
          aria-label={
            toD >= maxD ? t('已在最晚时间') : t('进一步（1 {gran}）', { gran: granLabel })
          }
        />
        <button
          className={skipBlank ? 'tl-switch on' : 'tl-switch'}
          role="switch"
          aria-checked={skipBlank}
          onClick={() => setSkipBlank((v) => !v)}
          disabled={eventDays.length === 0}
          title={t('播放和步进时跳过没有到访的空白日期')}
        >
          <span className="tl-switch-track">
            <span className="tl-switch-knob" />
          </span>
          <span className="tl-switch-label">{t('跳空白')}</span>
        </button>
        <button
          className="tl-play"
          onClick={() => {
            if (playing) {
              stopPlay();
              return;
            }
            setFromD(minD);
            setToD(minD);
            setPlaying(true);
          }}
          title={
            playing
              ? t('暂停')
              : t('播放：每{gran}推进一格', {
                  gran: t(GRANULARITIES.find((g) => g.key === gran)?.label ?? ''),
                })
          }
        >
          {playing ? '❚❚' : '▶'}
        </button>
        <button
          className="tl-all"
          onClick={() => {
            stopPlay();
            onChange(null);
          }}
          disabled={!filtered}
          title={t('恢复全部时间')}
        >
          {t('全部')}
        </button>
        <CompanionFilter value={companions} onChange={onCompanionsChange} />
      </div>

      <div className="tl-track" ref={trackRef}>
        <div className="tl-rail" />
        <div className="tl-fill" style={{ left: `${leftPct}%`, width: `${rightPct - leftPct}%` }} />
        <button
          className="tl-handle from"
          style={{ left: `${leftPct}%` }}
          onPointerDown={(e) => startDrag(e, 'from')}
          aria-label={t('起始时间')}
        />
        <button
          className="tl-handle to"
          style={{ left: `${rightPct}%` }}
          onPointerDown={(e) => startDrag(e, 'to')}
          aria-label={t('结束时间')}
        />
      </div>

      <div className="tl-years">
        <span>{meta.first.slice(0, 4)}</span>
        <span>{meta.last.slice(0, 4)}</span>
      </div>
    </div>
  );
}
