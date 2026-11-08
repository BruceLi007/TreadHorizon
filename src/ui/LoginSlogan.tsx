/**
 * 登录 / Key 引导页的「主题标语」（2026-11-08 D-269 初版，D-272 按用户图框改为单行）。
 *
 * 内容与 设置 → 通用 → 主题 里的标语完全一致（本机偏好 `tm-slogan`，只存本机）：
 * - `slogan === null`：用 i18n 默认文案（两段，**单行**显示、字体字号完全一致）；
 * - 自定义字符串（≤40 字）：单行显示（与默认同一套字体字号）；
 * - 空串：不显示（与顶栏逻辑一致）。
 * 位置按用户 2026-11-08 图框：左上方（`LoginPage.css` 里 `left 4.7vw / top 5.9vh`），
 * 不跟随深色主题变暗——登录页整体是明亮 Q 版场景。
 */
import { type CSSProperties } from 'react';
import { useT } from '../i18n';

/**
 * 2026-11-08 D-303 / D-304（用户要求）：把一段文字拆成逐字 span，做随机左右摇晃。
 * - 每个字独立相位 / 周期 / 摆幅（由字符码 + 下标派生，稳定不闪）；
 * - `minRot` / `maxRot` 控制摆幅：欢迎页按钮 2°~4.7°，主题标语 4°~10°（用户要求「幅度大一点」）；
 * - 只影响视觉；调用方负责给整句提供 aria-label / 可读文本。
 * 放在 LoginSlogan.tsx 里避免 LoginPage → LoginBrandRow → LoginSlogan → LoginPage 的循环引用。
 */
export function WiggleText({
  text,
  minRot = 2,
  maxRot = 4.7,
}: {
  text: string;
  minRot?: number;
  maxRot?: number;
}) {
  return (
    <>
      {Array.from(text).map((ch, i) => {
        const seed = ((ch.codePointAt(0) ?? 0) * 31 + i * 97) % 1000;
        const dur = 1.15 + (seed % 45) / 100; // 1.15s ~ 1.59s
        const delay = -((seed % 70) / 100); // 0 ~ -0.69s：每字随机相位
        const rot = minRot + (((seed * 7) % 100) / 100) * (maxRot - minRot);
        return (
          <span
            key={i}
            className="login-char"
            aria-hidden="true"
            style={
              {
                '--wiggle-dur': `${dur.toFixed(2)}s`,
                '--wiggle-delay': `${delay.toFixed(2)}s`,
                '--wiggle-rot': `${rot.toFixed(2)}deg`,
              } as CSSProperties
            }
          >
            {ch === ' ' ? '\u00a0' : ch}
          </span>
        );
      })}
    </>
  );
}

interface Props {
  slogan?: string | null;
}

/** 2026-11-08 D-304（用户要求「这个字也做动效，幅度大一点」）：
 *  主题标语逐字做随机左右摇晃（与欢迎页按钮同一套 `WiggleText`，摆幅更大 4°~10°），
 *  不跟随鼠标回正（标语本身 `pointer-events: none`，只做背景动效）。 */
const SLOGAN_MIN_ROT = 4;
const SLOGAN_MAX_ROT = 10;

export default function LoginSlogan({ slogan }: Props) {
  const t = useT();
  const custom = typeof slogan === 'string';
  if (custom && slogan.trim() === '') return null;
  const defaultText = `${t('世界辣 ~ ~ ~ 么大')} ${t('我想 · · · 总得去看一看吧 ! ! !')}`;
  return (
    <div className="login-slogan" aria-label={custom ? slogan : defaultText}>
      {custom ? (
        <span className="login-slogan-custom">
          <WiggleText text={slogan} minRot={SLOGAN_MIN_ROT} maxRot={SLOGAN_MAX_ROT} />
        </span>
      ) : (
        // 两段默认文案放在同一行、同一套字体字号（用户要求「不要两行、字体要一样」）
        <span className="login-slogan-line">
          <span>
            <WiggleText text={t('世界辣 ~ ~ ~ 么大')} minRot={SLOGAN_MIN_ROT} maxRot={SLOGAN_MAX_ROT} />
          </span>
          <span>
            <WiggleText
              text={t('我想 · · · 总得去看一看吧 ! ! !')}
              minRot={SLOGAN_MIN_ROT}
              maxRot={SLOGAN_MAX_ROT}
            />
          </span>
        </span>
      )}
    </div>
  );
}
