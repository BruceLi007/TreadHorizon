/**
 * 英文字典合并入口（2026-11-04，D-138）。
 *
 * 每个域一个文件、各由一组人维护（避免多人同时改同一个文件）：
 * - common.ts  顶栏 HUD / App 全局 toast / 设置窗口框架（Lead）
 * - settings.ts 设置里的备份与恢复、素材库、安全、天地图 Key、回收站、关于（T1）
 * - sidebar.ts  地点侧栏 / 添加足迹面板 / 灯箱 / 搜索 / 秘密基地密码 / 错误边界（T2）
 * - panels.ts   统计 / 照片墙 / 回收站 / 随行筛选 / 时间轴（T3）
 * - lists.ts    My旅迹 / 去过·想去 / 分组列表 / 合并·聚合面板 / 分段控件 / 排序键 /
 *               地图提示 / cluster.ts / api.ts / tdt.ts（T4）
 *
 * 约定：同一中文 key 出现在多处时，译文必须一致（合并后按下面顺序覆盖，后面的赢）；
 * 插值占位符（{n} 等）键与译文保持一致。
 */
import type { Dict } from '../index';
import common from './common';
import settings from './settings';
import sidebar from './sidebar';
import panels from './panels';
import lists from './lists';

export const EN: Dict = {
  ...common,
  ...settings,
  ...sidebar,
  ...panels,
  ...lists,
};
