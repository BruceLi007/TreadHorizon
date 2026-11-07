import { useState } from 'react';
import type { Cluster } from '../map/cluster';
import { clusterLabel } from '../map/cluster';
import type { Place } from '../lib/types';
import PlaceGroupList from './PlaceGroupList';
import SortToggle, { type SortOrder } from './SortToggle';
import { useT, useTp } from '../i18n';
import CloseIcon from './CloseIcon';

interface Props {
  /** 点击靶盘那一刻的聚合快照（地图散开后会重算聚合，列表不跟着变） */
  cluster: Cluster;
  onClose: () => void;
  onPick: (p: Place) => void;
}

/**
 * 「这一簇」聚合点展开列表（F-BRW-07 / D-33）
 *
 * 单击聚合靶盘 → 地图自动飞到「刚好散开」的级别，同时右侧列出簇内全部地点；
 * 点一条 → 面板收起，飞到该地点并打开它的侧栏。
 * 列表按「省 → 市」分组、可折叠（和其他地点列表统一），默认展开因为用户是点进来找成员的。
 */
export default function ClusterPanel({ cluster, onClose, onPick }: Props) {
  const t = useT();
  const tp = useTp();
  const title = clusterLabel(cluster, t, tp);
  /** 组内排序方向：默认最近在前 */
  const [order, setOrder] = useState<SortOrder>('desc');

  return (
    <aside className="panel cluster-panel">
      <div className="panel-head">
        <span className="title" title={title}>
          {title}
        </span>
        <div className="head-tools">
          <SortToggle
            order={order}
            onChange={setOrder}
            title={t('切换排序：最近去过的在前 / 最早去过的在前')}
          />
          <button className="icon" onClick={onClose} aria-label={t('关闭')}>
            <CloseIcon />
          </button>
        </div>
      </div>

      <div className="subhead">
        <span className="region">
          {t('这一簇 {n} 个地方 · 按省 → 市分组', { n: cluster.count })}
        </span>
      </div>

      <div className="visits">
        <PlaceGroupList
          places={cluster.members}
          onPick={onPick}
          defaultOpen
          sortOrder={order}
          emptyText={t('这一簇没有地点。')}
        />
      </div>

      <div className="panel-foot">
        <button className="ghost full" onClick={onClose}>
          {t('关闭')}
        </button>
      </div>
      <div className="cluster-hint">
        {t('地图已飞到「刚好散开」的级别；列表保持点击那一刻的成员快照，点空白处可收起。')}
      </div>
    </aside>
  );
}
