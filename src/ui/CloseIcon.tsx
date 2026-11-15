/**
 * 通用「关闭」图标（2026-11-05，D-166「按钮体系统一」第 1 步）。
 *
 * 用 SVG 而不是 `×` 文字：本项目界面有 11 种可选字体（含 5 款下载字体 /
 * 像素字体），`×` 是字形、缺字时会回退到别的字体，垂直居中和粗细也不一致。
 * 统一成一个矢量图标后，所有关闭按钮在任何字体 / 主题下都是同一个形状。
 *
 * 尺寸默认 14px（配合 28px 的圆形/方形按钮）；行内小按钮可传 12。
 */
interface Props {
  /** 图标边长（px），默认 20（2026-11-15 D-424：对齐分享页原来那个 22px 的细 ✕） */
  size?: number;
}

export default function CloseIcon({ size = 20 }: Props) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      <g fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round">
        <path d="M3.2 3.2 12.8 12.8" />
        <path d="M12.8 3.2 3.2 12.8" />
      </g>
    </svg>
  );
}
