import { useT } from '../i18n';
import './SortToggle.css';

/** 排序方向：desc = 最新 / 最近在前；asc = 最早 / 最久在前 */
export type SortOrder = 'desc' | 'asc';

interface Props {
  order: SortOrder;
  onChange: (o: SortOrder) => void;
  /** 鼠标悬停提示，不传时用按当前方向生成的中文说明 */
  title?: string;
  /**
   * 当前排序方式文字（如「最近在前」）。传了就把按键变成「文字 + 单向箭头」的小胶囊，
   * 让用户一眼看出现在按什么排序（2026-11-04 D-113，用户反馈只看图标分不清排序方式）。
   * 不传则保持原来的双向半箭头图标按键。
   */
  label?: string;
}

/** 带文字版本里的单向箭头：desc 向下（最新/最多在前），asc 向上（最早/最少在前） */
function DirectionArrow({ desc }: { desc: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {desc ? (
          <>
            <path d="M8 3.2v9.6" />
            <path d="M4.4 9.4 8 13l3.6-3.6" />
          </>
        ) : (
          <>
            <path d="M8 12.8V3.2" />
            <path d="M4.4 6.6 8 3l3.6 3.6" />
          </>
        )}
      </g>
    </svg>
  );
}

/**
 * 时间列表的排序小按键（24~26px）
 *
 * 两种外观：
 * - 默认：双向半箭头图标（左升 / 右降），当前方向高亮、另一个变淡；点一下切换方向。
 * - 传 `label`：显示当前排序方式文字 + 单向箭头（如「最近在前 ↓」），点一下切换方向。
 * 只负责外观与切换，排序逻辑由各面板自己处理。
 */
export default function SortToggle({ order, onChange, title, label }: Props) {
  const t = useT();
  const desc = order === 'desc';
  const labelText = label
    ? t('当前排序：{label}，点按切换排序方向', { label })
    : desc
      ? t('切换排序：当前最新在前，点按改为最早在前')
      : t('切换排序：当前最早在前，点按改为最新在前');

  if (label) {
    return (
      <button
        type="button"
        className={desc ? 'st-sort labeled' : 'st-sort labeled asc'}
        onClick={() => onChange(desc ? 'asc' : 'desc')}
        aria-label={labelText}
        title={title ?? labelText}
      >
        <span className="st-sort-text">{label}</span>
        <DirectionArrow desc={desc} />
      </button>
    );
  }

  return (
    <button
      type="button"
      className={desc ? 'st-sort' : 'st-sort asc'}
      onClick={() => onChange(desc ? 'asc' : 'desc')}
      aria-label={labelText}
      title={title ?? labelText}
    >
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
        <g
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {/* 左：向上 = 升序（最早/最少在前） */}
          <g className={desc ? 'st-arrow' : 'st-arrow on'}>
            <path d="M4.9 12.7V3.8" />
            <path d="M2.7 6 4.9 3.8 7.1 6" />
          </g>
          {/* 右：向下 = 降序（最新/最多在前） */}
          <g className={desc ? 'st-arrow on' : 'st-arrow'}>
            <path d="M11.1 3.3v8.9" />
            <path d="M8.9 10 11.1 12.2 13.3 10" />
          </g>
        </g>
      </svg>
    </button>
  );
}
