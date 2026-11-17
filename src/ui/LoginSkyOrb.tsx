/**
 * 欢迎页右上角的「太阳 / 月亮」小挂件（2026-11-17，四时段欢迎页）。
 *
 * 四款都是同一套 Q 版语言：圆脸 + 表情 + 光晕 + 底部一条云带；
 * 四款同时挂在 DOM 里靠 opacity 交叉淡化（切时段不闪），隐藏的那几款动画暂停。
 * 2026-11-17（用户拍板「中午可以按你的思路改」）：顺手修掉原版 8 根光芒
 * 因 `transform-box: fill-box` 缩成头顶一枚小星花的问题 —— 现在绕太阳中心转。
 */
import type { ReactNode } from 'react';
import type { SkyTime } from './skyTime';
import './LoginSkyOrb.css';

/** 四款光晕渐变（id 固定，页面上只有一份） */
function OrbDefs() {
  return (
    <defs>
      <radialGradient id="lb-glow-noon">
        <stop offset="0%" stopColor="#fff3bf" stopOpacity="0.9" />
        <stop offset="60%" stopColor="#ffe89a" stopOpacity="0.35" />
        <stop offset="100%" stopColor="#ffe89a" stopOpacity="0" />
      </radialGradient>
      <radialGradient id="lb-glow-sunrise">
        <stop offset="0%" stopColor="#ffe4bb" stopOpacity="0.95" />
        <stop offset="55%" stopColor="#ffc68d" stopOpacity="0.4" />
        <stop offset="100%" stopColor="#ffb877" stopOpacity="0" />
      </radialGradient>
      <radialGradient id="lb-glow-sunset">
        <stop offset="0%" stopColor="#ffd79a" stopOpacity="0.95" />
        <stop offset="55%" stopColor="#ff9a5e" stopOpacity="0.42" />
        <stop offset="100%" stopColor="#ff7a45" stopOpacity="0" />
      </radialGradient>
      <radialGradient id="lb-glow-moon">
        <stop offset="0%" stopColor="#eef4ff" stopOpacity="0.6" />
        <stop offset="55%" stopColor="#a9c3ff" stopOpacity="0.22" />
        <stop offset="100%" stopColor="#8fb0ff" stopOpacity="0" />
      </radialGradient>
      <linearGradient id="lb-set-body" x1="0" y1="0" x2="0.25" y2="1">
        <stop offset="0%" stopColor="#ffc46b" />
        <stop offset="55%" stopColor="#ff9a55" />
        <stop offset="100%" stopColor="#ff7746" />
      </linearGradient>
      <linearGradient id="lb-moon-body" x1="0.2" y1="0" x2="0.8" y2="1">
        <stop offset="0%" stopColor="#fffbe8" />
        <stop offset="60%" stopColor="#f7eec9" />
        <stop offset="100%" stopColor="#e9ddb3" />
      </linearGradient>
      <linearGradient id="lb-cloudbank" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="#fffaf2" />
        <stop offset="100%" stopColor="#ffddc2" />
      </linearGradient>
      <linearGradient id="lb-cloudbank-set" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="#fff3da" />
        <stop offset="100%" stopColor="#ffbe8e" />
      </linearGradient>
      <linearGradient id="lb-cloudbank-moon" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="#f6faff" />
        <stop offset="100%" stopColor="#d6e4fa" />
      </linearGradient>
      <linearGradient id="lb-firecloud" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="#b85f86" />
        <stop offset="42%" stopColor="#f07f72" />
        <stop offset="100%" stopColor="#ffd79a" />
      </linearGradient>
    </defs>
  );
}

/** 中午：原来那款「圆脸 + 8 根光芒」，光芒改成真正绕太阳转 */
function NoonOrb() {
  return (
    <>
      <circle className="lb-sun-glow" r="96" fill="url(#lb-glow-noon)" />
      <g className="lb-sun-rays">
        {Array.from({ length: 8 }).map((_, i) => (
          <rect
            key={i}
            className="lb-sun-ray"
            x="-2.6"
            y="-66"
            width="5.2"
            height="16"
            rx="2.6"
            transform={`rotate(${i * 45})`}
          />
        ))}
      </g>
      <circle className="lb-sun-body" r="32" />
      <g className="lb-sun-face">
        <path d="M-12 -6 Q-9 -11 -6 -6" />
        <path d="M6 -6 Q9 -11 12 -6" />
        <path d="M-8 6 Q0 13 8 6" />
      </g>
    </>
  );
}

/** 日出：刚从云海里探出头，短光芒、困倦的小脸，云带托在下巴 */
function SunriseOrb() {
  return (
    <>
      <circle className="lb-orb-glow" r="94" fill="url(#lb-glow-sunrise)" />
      <g className="lb-orb-rays lb-orb-rays-short">
        {Array.from({ length: 7 }).map((_, i) => (
          <path key={i} d="M-3.8 -42 L0 -60 L3.8 -42 Z" transform={`rotate(${i * (360 / 7)})`} />
        ))}
      </g>
      <g transform="translate(0 -4)">
        <circle className="lb-rise-body" r="30" />
        <g className="lb-rise-face">
          <path d="M-12 -4 Q-9 0.5 -6 -4" />
          <path d="M6 -4 Q9 0.5 12 -4" />
          <path d="M-4 7 Q0 10 4 7" />
        </g>
        <ellipse className="lb-rise-blush" cx="-16" cy="3" rx="4.2" ry="2.4" />
        <ellipse className="lb-rise-blush" cx="16" cy="3" rx="4.2" ry="2.4" />
      </g>
      {/* 云带再抬高一点，盖住太阳下缘：读作「从云海里升起来」而不是「躺在云上」 */}
      <g transform="translate(0 -9)">
        <g className="lb-cloudbank lb-cloudbank-rise">
          <ellipse cx="-58" cy="34" rx="26" ry="10" />
          <ellipse cx="-28" cy="27" rx="28" ry="13" />
          <ellipse cx="6" cy="30" rx="32" ry="12" />
          <ellipse cx="40" cy="26" rx="24" ry="10" />
          <ellipse cx="66" cy="33" rx="17" ry="8" />
          <rect x="-72" y="31" width="148" height="12" rx="6" />
          <ellipse className="lb-cloudbank-hi" cx="-16" cy="20" rx="20" ry="5.6" />
        </g>
      </g>
    </>
  );
}

/** 日落：又大又低、下半被云带切住，长光芒 + 眨眼，左边三只归鸟，旁边两朵火烧云 */
function SunsetOrb() {
  return (
    <>
      <circle className="lb-orb-glow" r="104" fill="url(#lb-glow-sunset)" />
      <g className="lb-orb-fireclouds">
        <g transform="translate(-110 -66) scale(0.76)">
          <g className="lb-firecloud fc1">
            <circle className="lb-fc-puff" cx="-30" cy="6" r="22" />
            <circle className="lb-fc-puff" cx="2" cy="-8" r="28" />
            <circle className="lb-fc-puff" cx="34" cy="8" r="18" />
            <rect className="lb-fc-base" x="-38" y="4" width="78" height="18" rx="9" />
          </g>
        </g>
        <g transform="translate(96 -52) scale(0.4)">
          <g className="lb-firecloud fc2">
            <circle className="lb-fc-puff" cx="-28" cy="6" r="20" />
            <circle className="lb-fc-puff" cx="4" cy="-8" r="26" />
            <circle className="lb-fc-puff" cx="34" cy="8" r="17" />
            <rect className="lb-fc-base" x="-36" y="4" width="74" height="17" rx="8.5" />
          </g>
        </g>
        <g transform="translate(102 86) scale(0.5)">
          <g className="lb-firecloud fc3">
            <circle className="lb-fc-puff" cx="-26" cy="6" r="19" />
            <circle className="lb-fc-puff" cx="6" cy="-8" r="24" />
            <circle className="lb-fc-puff" cx="34" cy="8" r="16" />
            <rect className="lb-fc-base" x="-34" y="4" width="70" height="16" rx="8" />
          </g>
        </g>
      </g>
      <g className="lb-orb-rays lb-orb-rays-long">
        {Array.from({ length: 8 }).map((_, i) => (
          <path key={i} d="M-4.4 -46 L0 -72 L4.4 -46 Z" transform={`rotate(${i * 45})`} />
        ))}
      </g>
      <circle className="lb-set-ring" r="50" />
      <circle className="lb-set-body" r="34" fill="url(#lb-set-body)" />
      <g className="lb-set-face">
        <path d="M-13 -4 Q-9.5 -8.5 -6 -4" />
        <circle cx="9.5" cy="-5" r="1.9" />
        <path d="M-7 8 Q0 14 7 8" />
      </g>
      <ellipse className="lb-set-blush" cx="-17" cy="4" rx="4.6" ry="2.6" />
      <ellipse className="lb-set-blush" cx="17" cy="4" rx="4.6" ry="2.6" />
      <g className="lb-cloudbank lb-cloudbank-set">
        <ellipse cx="-54" cy="32" rx="28" ry="11" />
        <ellipse cx="-20" cy="26" rx="30" ry="13" />
        <ellipse cx="18" cy="30" rx="34" ry="12" />
        <ellipse cx="52" cy="26" rx="24" ry="10" />
        <ellipse cx="76" cy="34" rx="16" ry="7" />
        <rect x="-68" y="31" width="144" height="13" rx="6.5" />
        <ellipse className="lb-cloudbank-hi" cx="-12" cy="19" rx="20" ry="5.4" />
      </g>
      <g className="lb-set-birds" transform="translate(-4 2) scale(1.32)">
        <path className="lb-set-bird b1" d="M-100 46 q5 -5 10 0 q5 -5 10 0" />
        <path className="lb-set-bird b2" d="M-124 66 q4.4 -4.4 8.8 0 q4.4 -4.4 8.8 0" />
        <path className="lb-set-bird b3" d="M-76 74 q4 -4 8 0 q4 -4 8 0" />
      </g>
    </>
  );
}

/** 午夜：满月睡脸 + 月坑 + 云枕 + 旁边三颗小星 */
function MoonOrb() {
  return (
    <>
      <circle className="lb-orb-glow" r="100" fill="url(#lb-glow-moon)" />
      <g className="lb-moon-stars">
        <path className="lb-moon-star s1" d="M-72 -44 l3.2 7.4 7.4 3.2 -7.4 3.2 -3.2 7.4 -3.2 -7.4 -7.4 -3.2 7.4 -3.2 Z" />
        <path className="lb-moon-star s2" d="M64 -58 l2.4 5.6 5.6 2.4 -5.6 2.4 -2.4 5.6 -2.4 -5.6 -5.6 -2.4 5.6 -2.4 Z" />
        <path className="lb-moon-star s3" d="M54 42 l1.9 4.4 4.4 1.9 -4.4 1.9 -1.9 4.4 -1.9 -4.4 -4.4 -1.9 4.4 -1.9 Z" />
      </g>
      <circle className="lb-moon-body" r="34" fill="url(#lb-moon-body)" />
      <g className="lb-moon-craters">
        <circle cx="-19" cy="-17" r="6.2" />
        <circle cx="18" cy="-15" r="4.2" />
        <circle cx="-20" cy="12" r="3.4" />
        <circle cx="20" cy="17" r="5" />
      </g>
      <g className="lb-moon-face">
        <path d="M-13 -4 Q-9.5 -0.5 -6 -4" />
        <path d="M6 -4 Q9.5 -0.5 13 -4" />
        <ellipse cx="0" cy="7" rx="2" ry="2.6" />
      </g>
      <g className="lb-cloudbank lb-cloudbank-moon">
        <ellipse cx="-48" cy="34" rx="26" ry="10" />
        <ellipse cx="-18" cy="29" rx="28" ry="12" />
        <ellipse cx="16" cy="32" rx="30" ry="11" />
        <ellipse cx="46" cy="28" rx="22" ry="9" />
        <ellipse cx="66" cy="35" rx="14" ry="7" />
        <rect x="-62" y="33" width="128" height="12" rx="6" />
        <ellipse className="lb-cloudbank-hi" cx="-10" cy="23" rx="18" ry="5" />
      </g>
      <text className="lb-moon-zzz z1" x="34" y="-44">
        z
      </text>
      <text className="lb-moon-zzz z2" x="46" y="-56">
        z
      </text>
    </>
  );
}

/** 四款挂件（同时挂载，`.is-on` 的那款可见；CSS 负责动画暂停与交叉淡化） */
export default function LoginSkyOrb({ time }: { time: SkyTime }) {
  const orbs: { id: SkyTime; node: ReactNode }[] = [
    { id: 'sunrise', node: <SunriseOrb /> },
    { id: 'noon', node: <NoonOrb /> },
    { id: 'sunset', node: <SunsetOrb /> },
    { id: 'night', node: <MoonOrb /> },
  ];
  return (
    <svg className="lb-sun-page" viewBox="-160 -150 320 300" aria-hidden="true" focusable="false">
      <OrbDefs />
      {orbs.map((o) => (
        <g key={o.id} className={`lb-orb lb-orb-${o.id}${o.id === time ? ' is-on' : ''}`}>
          {o.node}
        </g>
      ))}
    </svg>
  );
}
