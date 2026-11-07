/**
 * My旅迹树形列表的占位图标（2026-11-04，D-115）。
 *
 * 用户说明：截图里那套图标先不要照抄，正式图标后期由用户自行替换。
 * 所以这里只放最中性、最简单的线性图标，并集中在「本文件」里：
 * 替换时只改下面的 <svg>（或换成 `<img src="/xxx.svg" />`）即可，
 * 颜色一律用 currentColor，由外层 CSS 控制灰阶 / 主题色。
 */

interface IconProps {
  className?: string;
}

/** 文件夹图标：用于「省 / 市」分组行 */
export function FolderIcon({ className }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      width="15"
      height="15"
      aria-hidden="true"
      focusable="false"
    >
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M2.3 5c0-.75.6-1.35 1.35-1.35h2.55L7.6 5.3h5.05c.75 0 1.35.6 1.35 1.35v5.05c0 .75-.6 1.35-1.35 1.35H3.65c-.75 0-1.35-.6-1.35-1.35V5Z" />
      </g>
    </svg>
  );
}
