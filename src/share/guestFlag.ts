/** 2026-11-15 D-423：分享页「只读访客模式」的全局标记（App 内用它决定顶栏入口的禁用提示） */
export const GUEST_TIP = '当前为只读模式，未开放权限';

let guest = false;

export const setGuestMode = (v: boolean): void => {
  guest = v;
};

export const isGuestMode = (): boolean => guest;
