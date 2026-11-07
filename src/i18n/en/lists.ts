import type { Dict } from '../index';

/**
 * 英文词条 · 列表与地图域（T4 维护）：My旅迹抽屉、去过 / 想去清单、省市分组列表、
 * 封面缩略图、合并面板、聚合簇面板、分段控件、排序键、地图提示（含 cluster.ts）、
 * 前端接口层错误文案（api.ts / tdt.ts）。
 *
 * 写法：一行一条 `'中文原文': 'English',`，key 必须与代码里 t('…') 的中文逐字一致
 * （包括标点、空格、「」等）；插值占位符 {n} 等两边都要有。
 */
const dict: Dict = {
  // ── My旅迹抽屉（MyTrailPanel）──
  'My旅迹': 'My Trail',
  'My旅迹分类': 'My Trail categories',
  '关闭': 'Close',
  '去过': 'Visited',
  '想去': 'Want to go',
  '全部': 'All',
  '普通打卡': 'Regular check-ins',
  '秘密基地': 'Secret spot',
  '去过筛选': 'Visited filters',
  '按坐标重新识别这些地点的省 / 市 / 区，修复「未标注」分组':
    'Re-detect the province / city / district of these places from their coordinates to fix the "Unlabeled" group',
  '识别中…': 'Detecting…',
  '补全地区 {n}': 'Fill in regions {n}',

  // ── 去过清单（VisitedPanel）──
  '按名称 / 省市区过滤': 'Filter by name / province / city / district',
  '最近到访在前': 'Latest visit first',
  '最早到访在前': 'Earliest visit first',
  '刷新列表': 'Refresh list',
  '去过清单': 'Visited list',
  '点一下清除时间筛选': 'Click to clear the time filter',
  '时间轴：{from} – {to}': 'Timeline: {from} – {to}',
  '收起所有省 / 市分组': 'Collapse all province / city groups',
  '展开所有省 / 市分组，直接看到全部地点':
    'Expand all province / city groups to show every place',
  '全部收起': 'Collapse all',
  '全部展开': 'Expand all',
  '区间内 {rangeSum} 次 · 共 {totalSum} 次 · {n} 个地方':
    'In range: {rangeSum} visits · {totalSum} total · {n} places',
  '区间内 {rangeSum} 次 · 共 {totalSum} 次': 'In range: {rangeSum} visits · {totalSum} total',
  '共 {totalSum} 次 · {n} 个地方': '{totalSum} visits · {n} places',
  '共 {totalSum} 次': '{totalSum} visits',
  '还没有秘密基地。': 'No secret spots yet.',
  '打开任意地点的「编辑」，点「设为秘密基地」后会出现在这里。':
    'Open “Edit” on any place and choose “Set as secret spot” to list it here.',
  '还没有普通打卡地点（所有去过的地方都被标成秘密基地了）。':
    'No regular check-in places yet (all visited places are marked as secret spots).',
  '还没有去过的地点。': 'No visited places yet.',
  '新增足迹时默认就是「去过」，保存后会出现在这里。':
    'New places are marked “Visited” by default and show up here once saved.',
  '没有匹配「{q}」的地点。': 'No places matching “{q}”.',
  '当前筛选下没有地点。': 'No places under the current filter.',
  '未标注': 'Unlabeled',
  '区间 {range} 次 · 共 {total} 次': 'In range: {range} visits · {total} total',
  '{n} 次': '{n} visits',
  '照片 {photos} · 视频 {videos}': '{photos} photos · {videos} videos',
  '最近 {date}': 'Latest {date}',
  '给「{name}」添加一次到访': 'Add a visit to “{name}”',
  '+ 到访': '+ Visit',
  '刷新': 'Refresh',

  // ── 想去清单（WishlistPanel）──
  '读取失败：{msg}': 'Failed to load: {msg}',
  '转换失败：{msg}': 'Failed to convert: {msg}',
  '删除失败：{msg}': 'Failed to delete: {msg}',
  '未标注区县': 'Unmarked district',
  '加入 {date}': 'Added {date}',
  '转为去过': 'Mark as visited',
  '确认删除': 'Confirm delete',
  '取消': 'Cancel',
  '删除': 'Delete',
  '按省 / 市分组': 'Grouped by province / city',
  '最近加入在前': 'Latest added first',
  '最早加入在前': 'Earliest added first',
  '想去清单': 'Want to go list',
  '读取中…': 'Loading…',
  '还没有标记「想去」的地方。': 'No places marked “Want to go” yet.',
  '新增足迹时选「想去」，或在任意地点里点「编辑」切换类型。':
    'Choose “Want to go” when adding a place, or open “Edit” on any place to switch its type.',
  '{n} 个地方': '{n} places',

  // ── 省市分组列表（PlaceGroupList）──
  '没有地点。': 'No places.',
  '去过 {n} 次': 'Visited {n} times',

  // ── 合并重复地点（MergePanel）──
  '未标注地区': 'Region not set',
  '读取地点失败：{msg}': 'Failed to load places: {msg}',
  '合并重复地点': 'Merge duplicate places',
  '把「{name}」合并到下面选中的地点': 'Merge “{name}” into a place selected below',
  '（保留目标名称/坐标，来源软删）':
    '(target name and coordinates kept; source soft-deleted)',
  '按名称 / 省市区找目标地点': 'Find the target place by name / province / city / district',
  '候选地点': 'Candidate places',
  '切换候选地点排序：最近去过的在前 / 最早去过的在前':
    'Toggle candidate sort: latest visited first / earliest visited first',
  '读取地点…': 'Loading places…',
  '没有可合并的同类地点。合并要求两个地点类型相同（都去过或都想去）。':
    'No mergeable places of the same type. Merging requires both places to have the same type (both visited or both want to go).',
  '合并到：': 'Merge into: ',
  '（{region}）': ' ({region})',
  '这两个地点的省/市不一致': 'These two places have different provinces / cities',
  '来源：{province} {city}': 'Source: {province} {city}',
  '目标：{province} {city}': 'Target: {province} {city}',
  '确认不是误合并再继续；合并后到访会全部迁到目标地点，来源软删（M3 回收站可恢复）。':
    'Continue only if this is not a mistaken merge. All visits move to the target place and the source is soft-deleted (restorable from Trash).',
  '仍然合并': 'Merge anyway',
  '合并中…': 'Merging…',
  '确认合并': 'Confirm merge',
  '合并只调整数据库归属：到访和照片记录搬到目标地点，素材库文件不会移动或删除。':
    'Merging only changes database ownership: visits and photo records move to the target place; files in the media library are not moved or deleted.',

  // ── 聚合簇面板（ClusterPanel）──
  '切换排序：最近去过的在前 / 最早去过的在前':
    'Toggle sort: latest visited first / earliest visited first',
  '这一簇 {n} 个地方 · 按省 → 市分组': 'This cluster: {n} places · grouped by province → city',
  '这一簇没有地点。': 'No places in this cluster.',
  '地图已飞到「刚好散开」的级别；列表保持点击那一刻的成员快照，点空白处可收起。':
    'The map zoomed to the level where this cluster spreads out; the list keeps the members from the moment you clicked. Click empty space to dismiss.',

  // ── 排序小按键（SortToggle）──
  '当前排序：{label}，点按切换排序方向': 'Current sort: {label}. Click to toggle the sort direction',
  '切换排序：当前最新在前，点按改为最早在前':
    'Toggle sort: currently latest first. Click for earliest first',
  '切换排序：当前最早在前，点按改为最新在前':
    'Toggle sort: currently earliest first. Click for latest first',

  // ── 地图（MapView）──
  '{places} 个地点 · {visits} 次到访': '{places} places · {visits} visits',
  '还没去过': 'Not visited yet',
  '{name}（秘密基地）': '{name} (Secret spot)',
  '{name}（家）': '{name} (Home)',
  '省界数据为空': 'Province boundary data is empty',
  '省界数据加载失败：{msg}': 'Failed to load province boundaries: {msg}',
  '统计面板里的省份排行仍然可用。': 'Province rankings in the Stats panel are still available.',
  '地图加载失败': 'Map failed to load',
  '检查': 'Check',
  '里的': 'and',
  '，以及网络能否访问天地图。': ', then make sure the network can reach Tianditu.',

  // ── 聚合簇提示（cluster.ts）──
  '{n} 个想去的地方': '{n} places to go',
  '{visited} 个去过 · {wish} 个想去': '{visited} visited · {wish} to go',
  '{province}等 {n} 个地方 · 一共去了 {visits} 次':
    '{n} places around {province} · {visits} visits in total',
  '多地': 'multiple regions',
  '在{province}玩过 {visits} 次 · {n} 个地方':
    'Visited {province} {visits} times · {n} places',
  '这一带有 {n} 个地方 · 一共去了 {visits} 次':
    '{n} places in this area · {visits} visits in total',
  '最近：{name} · {date}': 'Latest: {name} · {date}',

  // ── 天地图加载（tdt.ts）──
  '脚本加载失败：{src}': 'Failed to load script: {src}',
  '没有配置天地图 key（.env.local 里的 TDT_TK）':
    'No Tianditu key configured (TDT_TK in .env.local)',
  '天地图 SDK 初始化失败：window.T 不存在':
    'Tianditu SDK initialization failed: window.T is missing',

  // ── 接口层前端错误文案（api.ts）──
  '上传失败（HTTP {status}）': 'Upload failed (HTTP {status})',
  '网络错误，上传失败': 'Network error, upload failed',
  '已取消': 'Canceled',
  '恢复失败（HTTP {status}）': 'Restore failed (HTTP {status})',
};

export default dict;
