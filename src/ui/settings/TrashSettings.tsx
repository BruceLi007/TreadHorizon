import TrashPanel from '../TrashPanel';
import { useT } from '../../i18n';

interface Props {
  /** 恢复 / 彻底删除后让 App 刷新地图、时间轴与回收站角标 */
  onChanged: () => void | Promise<void>;
}

/** 回收站分类（F-SYS-07）：嵌在设置窗口里，复用原 TrashPanel 的全部功能 */
export default function TrashSettings({ onChanged }: Props) {
  const t = useT();
  return (
    <div className="set-pane">
      <section className="set-section">
        <div className="set-section-head">
          <h3 className="set-section-title">{t('回收站')}</h3>
        </div>
        <p className="set-section-desc">
          {t('删除的地点 / 到访 / 照片视频先放在这里，不会立刻释放空间；「彻底删除」（单条 / 所选 / 清空） 才会删 B 库文件 + 缓存并释放空间。A 原件永远不动。')}
        </p>
      </section>
      <TrashPanel embedded onClose={() => {}} onChanged={onChanged} />
    </div>
  );
}
