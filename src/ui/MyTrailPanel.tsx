import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { Place } from '../lib/types';
import { regionNeedsFill } from '../lib/region';
import type { RangeValue } from './Timeline';
import VisitedPanel from './VisitedPanel';
import WishlistPanel from './WishlistPanel';
import Segmented from './Segmented';
import CloseIcon from './CloseIcon';
import { useT } from '../i18n';
import './MyTrailPanel.css';

export type MyTrailTab = 'visited' | 'wishlist';
type SecretFilter = 'all' | 'normal' | 'secret';

/**
 * 地点详情面包屑 → My旅迹的定位请求（2026-11-08 D-290）：
 * My旅迹收到后展开到对应省 / 市（level 决定展开到哪一级），并把地点行滚到可视区 + 短暂高亮。
 */
export interface MyTrailFocus {
  /** 每次定位自增的 token：同一个对象重复传入不会重复触发 */
  token: number;
  level: 'province' | 'city' | 'place';
  placeId: string;
  province: string | null;
  city: string | null;
  kind: 'visited' | 'wishlist';
}

interface Props {
  /** 地图上的地点列表（已按时间轴/同行人筛选），去过 tab 直接沿用 */
  places: Place[];
  range: RangeValue | null;
  /** 当前 tab 由 App 持有（时间轴步进会强制切到「去过」） */
  tab: MyTrailTab;
  onTabChange: (t: MyTrailTab) => void;
  onClose: () => void;
  onPick: (p: Place) => void;
  /** 「+ 添加一次到访」：打开该地点侧栏并直接展开新增到访表单（D-109） */
  onAddVisit?: (p: Place) => void;
  onRefresh: () => void;
  /** 点「补全地区」：把缺省/空的省市区按坐标重新识别并写回（修复「未标注」分组） */
  onFillRegions?: () => Promise<void>;
  onClearRange: () => void;
  /** 想去清单里「转为去过 / 删除」之后让 App 刷新地图、时间轴与角标 */
  onChanged: () => void;
  /**
   * 从列表点进地点详情时，列表不卸载、只「停在后台」（visibility:hidden）：
   * 侧栏「返回」再显示时，展开状态、搜索词、滚动位置都还在（2026-11-04 D-94）。
   */
  parked?: boolean;
  /** 从地点详情面包屑跳进来时的定位请求（2026-11-08 D-290） */
  focus?: MyTrailFocus | null;
  /** D-290：定位应用完成（滚动 + 高亮播完）后通知 App 清掉 focus，避免切 tab 回来重复高亮 */
  onFocusApplied?: () => void;
}

/**
 * My旅迹（M5）：把原来的「去过清单」和「想去清单」合并成一个右侧抽屉。
 * - 顶部 tab：去过 / 想去（带数量）
 * - 去过 tab 再分 全部 / 普通打卡（secret≠1）/ 秘密基地（secret=1）
 * - 两个子清单都用 embedded 模式复用原面板的省→市分组、区间、搜索、排序与操作
 */
export default function MyTrailPanel({
  places,
  range,
  tab,
  onTabChange,
  onClose,
  onPick,
  onAddVisit,
  onRefresh,
  onFillRegions,
  onClearRange,
  onChanged,
  parked = false,
  focus = null,
  onFocusApplied,
}: Props) {
  const t = useT();
  const tabs: { id: MyTrailTab; label: string }[] = [
    { id: 'visited', label: t('去过') },
    { id: 'wishlist', label: t('想去') },
  ];
  const secretFilters: { id: SecretFilter; label: string }[] = [
    { id: 'all', label: t('全部') },
    { id: 'normal', label: t('普通打卡') },
    { id: 'secret', label: t('秘密基地') },
  ];
  const [secretFilter, setSecretFilter] = useState<SecretFilter>('all');
  const [wishCount, setWishCount] = useState(0);
  const [missingRegion, setMissingRegion] = useState(0);
  const [filling, setFilling] = useState(false);
  const visitedCount = places.filter((p) => p.kind !== 'wishlist').length;

  /** 想去数量 + 「未标注」数量：打开抽屉就取一次，补全后再刷新 */
  const refreshCounts = useCallback(async () => {
    try {
      const all = await api.places();
      setWishCount(all.filter((p) => p.kind === 'wishlist').length);
      // 2026-11-08 D-283：港澳台（如澳门）city 为空属正常，不计入「补全地区 N」
      setMissingRegion(all.filter(regionNeedsFill).length);
    } catch {
      /* 读不到就等用户切 tab / 手动刷新 */
    }
  }, []);

  useEffect(() => {
    void refreshCounts();
  }, [refreshCounts]);

  // D-290：从详情面包屑「在 My旅迹中查看」进来时，先把「全部 / 普通打卡 / 秘密基地」筛选复位，
  // 保证目标地点一定在列表里（否则可能被上一次的筛选藏起来）。
  useEffect(() => {
    if (focus) setSecretFilter('all');
  }, [focus]);

  const runFillRegions = async () => {
    if (!onFillRegions || filling) return;
    setFilling(true);
    try {
      await onFillRegions();
      await refreshCounts();
    } finally {
      setFilling(false);
    }
  };

  return (
    <aside
      className={parked ? 'panel mytrail-panel parked' : 'panel mytrail-panel'}
      aria-label={t('My旅迹')}
      aria-hidden={parked || undefined}
    >
      <div className="mytrail-head">
        <Segmented<MyTrailTab>
          className="mytrail-tabs-seg"
          variant="tabs"
          fill
          ariaLabel={t('My旅迹分类')}
          options={tabs.map((item) => ({
            id: item.id,
            label: item.label,
            count: item.id === 'visited' ? visitedCount : wishCount,
          }))}
          value={tab}
          onChange={onTabChange}
        />
        <button className="icon mytrail-close" onClick={onClose} aria-label={t('关闭')}>
          <CloseIcon />
        </button>
      </div>

      <div className="mytrail-body">
        {tab === 'visited' ? (
          <>
            <div className="mytrail-subfilters">
              <Segmented<SecretFilter>
                size="sm"
                variant="radio"
                ariaLabel={t('去过筛选')}
                options={secretFilters.map((f) => ({ id: f.id, label: f.label }))}
                value={secretFilter}
                onChange={setSecretFilter}
              />
              {missingRegion > 0 && onFillRegions && (
                <button
                  type="button"
                  className="mytrail-fixregion"
                  onClick={() => void runFillRegions()}
                  disabled={filling}
                  title={t('按坐标重新识别这些地点的省 / 市 / 区，修复「未标注」分组')}
                >
                  {filling ? t('识别中…') : t('补全地区 {n}', { n: missingRegion })}
                </button>
              )}
            </div>
            <VisitedPanel
              embedded
              places={places}
              range={range}
              focus={focus?.kind === 'visited' ? focus : null}
              onFocusApplied={onFocusApplied}
              onChanged={onChanged}
              secretFilter={secretFilter}
              onClose={onClose}
              onPick={onPick}
              onAddVisit={onAddVisit}
              onRefresh={onRefresh}
              onClearRange={onClearRange}
            />
          </>
        ) : (
          <WishlistPanel
            embedded
            focus={focus?.kind === 'wishlist' ? focus : null}
            onFocusApplied={onFocusApplied}
            onClose={onClose}
            onPick={onPick}
            onChanged={onChanged}
            onCount={setWishCount}
          />
        )}
      </div>
    </aside>
  );
}
