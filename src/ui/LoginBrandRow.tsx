/**
 * 登录 / Key 引导页左上角：正式品牌 Logo + 右侧缩小的主题标语（2026-11-08 D-277，用户要求）。
 * 之前左上角只有主题标语；现在把正式 Logo 放到左上角，标语缩小后放在 Logo 右侧。
 */
import { BrandLogo } from './BrandLogo';
import LoginSlogan from './LoginSlogan';

interface Props {
  slogan?: string | null;
}

export default function LoginBrandRow({ slogan }: Props) {
  return (
    <div className="login-brand-row">
      <span className="login-brand-logo">
        <BrandLogo />
      </span>
      <LoginSlogan slogan={slogan} />
    </div>
  );
}
