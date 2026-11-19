/**
 * 手机版只读展示（2026-11-19 D-533，用户要求：
 * 「手机版其实是云端的缩影，也不能添加地点、照片等，和云端一样」）。
 *
 * 口径：**视口 ≤820px（全站手机断点 `PHONE_MEDIA_QUERY`）就当「手机版」**，
 * 与云端 `CLOUD_DISPLAY_ONLY=1` 完全同一套规则 ——
 * - 前端把「+ 添加足迹 / + 添加素材」变灰（保留入口，悬停 / 长按有提示）；
 * - 同时写一个 `th_phone=1` Cookie，服务端 preHandler 据此对**其余写接口**返回 403
 *   （地点 / 到访 / 媒体 / 回收站 / 备份恢复 / 素材库路径 / 重复照片检测 / 立即同步…），
 *   也就是「点了会弹『手机版为只读展示，请在电脑端操作』」而不是偷偷改数据。
 * - 分享例外：手机上仍可勾地点 → 确认分享（与用户 2026-11-19 的决定一致）。
 *
 * 为什么用 Cookie 而不是请求头：`src/lib/api.ts` 里约 100 处各写各的 `fetch`，没有统一出口；
 * Cookie 由浏览器自动带，前端只在布局变化时写一次 / 清一次。
 * 电脑端（>820px）会立刻清掉 Cookie，行为与以前完全一致。
 */
import { useEffect, useState } from 'react';
import { isPhoneLayout, onPhoneLayoutChange } from '../ui/settings/types';

/** 手机布局标记 Cookie（服务端 server/index.mjs 的 preHandler 读它） */
export const PHONE_LOCK_COOKIE = 'th_phone';

/**
 * 把「当前是手机布局」同步到 Cookie，并返回当前状态。
 * 电脑端不会留下残留 Cookie（否则窗口拖宽后仍会被服务端拒写）。
 */
export function syncPhoneLockCookie(): boolean {
  const phone = isPhoneLayout();
  try {
    if (phone) {
      document.cookie = `${PHONE_LOCK_COOKIE}=1; Path=/; SameSite=Lax; Max-Age=31536000`;
    } else if (document.cookie.indexOf(`${PHONE_LOCK_COOKIE}=`) >= 0) {
      document.cookie = `${PHONE_LOCK_COOKIE}=; Path=/; SameSite=Lax; Max-Age=0`;
    }
  } catch {
    /* 没有 document（SSR / 单元测试）时忽略：纯前端标记，不影响渲染 */
  }
  return phone;
}

/** 手机版只读：视口 ≤820px 为 true，并让服务端同步进入只读展示 */
export function usePhoneReadOnly(): boolean {
  const [phone, setPhone] = useState<boolean>(() => isPhoneLayout());
  useEffect(() => {
    setPhone(syncPhoneLockCookie());
    return onPhoneLayoutChange(() => setPhone(syncPhoneLockCookie()));
  }, []);
  return phone;
}
