import TrashPanel from '../TrashPanel';

interface Props {
  /** 恢复 / 彻底删除后让 App 刷新地图、时间轴与回收站角标 */
  onChanged: () => void | Promise<void>;
}

/**
 * 回收站分类（F-SYS-07）：嵌在设置窗口里，复用原 TrashPanel 的全部功能。
 * 2026-11-16 D-504：面板内的「回收站」小标题 + 整段说明已删除（用户：无关文字），
 * 顶部只留设置窗口自己的分类标题。
 */
export default function TrashSettings({ onChanged }: Props) {
  return (
    <div className="set-pane">
      <TrashPanel embedded onClose={() => {}} onChanged={onChanged} />
    </div>
  );
}
