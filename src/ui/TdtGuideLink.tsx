import { useT } from '../i18n';

/**
 * 天地图 Key 申请教程 PDF（2026-11-07 用户提供并入库，D-222）。
 *
 * 文件放在 `public/docs/tianditu-key-guide.pdf`：
 * - 开发（Vite 5173）：public/ 直接按根路径提供；
 * - 生产（Fastify 静态 dist/）：Vite 构建会把 public/ 拷进 dist/，同样按 /docs/... 提供；
 * - 云端多用户模式沿用同一套静态资源（nginx 反代到 Node）。
 * 点开是浏览器内置 PDF 预览（可直接下载），target=_blank 不打断当前页面。
 */
export const TDT_GUIDE_URL = '/docs/tianditu-key-guide.pdf';

/** 第一次配置 Key（KeySetupPage）与 设置 → 天地图 Key（TdtSettings）共用的教程链接 */
export default function TdtGuideLink() {
  const t = useT();
  const label = t('查看《天地图 Key 申请教程》');
  return (
    <a
      className="tdt-guide-link"
      href={TDT_GUIDE_URL}
      target="_blank"
      rel="noreferrer"
      title={label}
    >
      {label}
    </a>
  );
}
