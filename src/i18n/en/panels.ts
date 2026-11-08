import type { Dict } from '../index';

/**
 * 英文词条 · 面板域（T3 维护）：统计面板、照片墙、回收站面板、随行人员筛选、时间轴。
 *
 * 写法：一行一条 `'中文原文': 'English',`，key 必须与代码里 t('…') 的中文逐字一致
 * （包括标点、空格、「」等）；插值占位符 {n} 等两边都要有。
 *
 * 注意：本文件同时收录「标签常量数组经 t(变量) 渲染」的动态词条
 * （StatsPanel 的 METRIC_DEFS / TABS / BUCKETS / GROUPS / BAR_LABEL / PROVINCE_TIERS / TOTAL_ITEMS，
 * Timeline 的 GRANULARITIES.label），i18n-check 静态扫描不到这类用法，改动常量时记得同步这里。
 */
const dict: Dict = {
  // ── 通用（面板域共用）──
  '全部': 'All',
  '关闭': 'Close',
  '重试': 'Retry',
  '取消': 'Cancel',
  '恢复': 'Restore',
  '刷新': 'Refresh',
  '筛选': 'Filter',
  '统计': 'Stats',
  '照片墙': 'Photo wall',
  '回收站': 'Trash',
  '主||metric': 'Primary',
  // 「次」在统计面板里既是单位（12 次 → 12 visits）又是「次要指标」小角标：
  // 角标用上下文限定 key `次||metric`，中文模式仍渲染「次」，英文模式取 Secondary。
  '次': 'visits',
  '次||metric': 'Secondary',
  '？': '?',
  '、': ', ',

  // ── 标签常量 / 单位（StatsPanel 常量数组，经 t(变量) 渲染）──
  '到访次数': 'Visits',
  '不同地点数': 'Distinct places',
  '首次到访': 'First visits',
  '重复到访': 'Repeat visits',
  '照片数': 'Photos',
  '视频数': 'Videos',
  '个': 'places',
  '张': 'photos',
  '段': 'videos',
  '年': 'Year',
  '季': 'Quarter',
  '月': 'Month',
  '天': 'Day',
  '周': 'Week',
  '季度': 'Quarter',
  '不分组': 'No grouping',
  '按省': 'By province',
  '按市': 'By city',
  '时间趋势': 'Time trend',
  '地区分布': 'Regional distribution',
  '地点排行': 'Top places',
  '省份点亮': 'Province lighting',
  '1 个': '1 place',
  '2–3 个': '2–3',
  '4–9 个': '4–9',
  '10+ 个': '10+',
  '省份': 'Provinces',
  '城市': 'Cities',
  '地点': 'Places',
  '到访': 'Visits',
  '照片': 'Photos',
  '视频': 'Videos',
  // 单条记录的类型标签 / 缩略图无障碍名称用单数（同一中文、不同语境 → 上下文限定 key）
  '地点||type': 'Place',
  '到访||type': 'Visit',
  '照片||type': 'Photo',
  '视频||type': 'Video',
  // ── 统计面板 · 头部 / 备份提醒 / 概览 ──
  '更新中…': 'Updating…',
  '从未备份': 'Never backed up',
  '上次备份：{when}': 'Last backup: {when}',
  '未知': 'Unknown',
  '今天': 'Today',
  '{n} 天前': '{n} days ago',
  ' · 该备份了': ' · backup due',
  '去备份': 'Back up now',
  '第一站': 'First stop',
  '最近': 'Latest',
  '离家最远': 'Farthest from home',
  '暂无': 'None',
  '统计范围：{scope}': 'Scope: {scope}',
  '{from}–{to} 年': '{from}–{to}',
  '{from} 年起': 'Since {from}',
  '截至 {to} 年': 'Until {to}',
  '全部数据': 'All data',
  '重置筛选': 'Reset filters',
  '统计视图': 'Stats views',
  '刷新失败：{error}': 'Refresh failed: {error}',
  '读取统计失败：{error}': 'Failed to read stats: {error}',
  '正在统计…': 'Computing stats…',

  // ── 统计面板 · 筛选区 ──
  '年份': 'Year',
  '起始年份': 'Start year',
  '结束年份': 'End year',
  '地区': 'Region',
  '全国': 'All regions',
  '全部城市': 'All cities',
  '指标': 'Metrics',
  '当前视图不支持该指标': 'This view does not support this metric',
  '粒度': 'Granularity',
  '时间粒度': 'Time granularity',
  '分组': 'Grouping',
  '分组方式': 'Grouping mode',
  '按年': 'By year',
  '按季': 'By quarter',
  '按月': 'By month',
  '{n} 个时间点': '{n} time points',
  '从晚到早': 'latest first',
  '从早到晚': 'earliest first',
  '从高到低': 'highest first',
  '从低到高': 'lowest first',
  '从多到少': 'most first',
  '从少到多': 'fewest first',
  '切换排序：当前{cur}，点按改为{next}':
    'Switch sorting: currently {cur}; click to change to {next}',
  '条 = {metric}': 'Bar = {metric}',
  '条 = {metric}（堆叠）': 'Bar = {metric} (stacked)',
  '点 = {metric}': 'Dot = {metric}',
  '（最大 {n}）': ' (max {n})',
  '分组模式只返回「到访次数 / 不同地点数」两个指标，条长按到访次数显示；照片、视频、首次到访请切回「不分组」。':
    'Grouped mode only returns the “visits / distinct places” metrics, so bar length shows visits; switch back to “No grouping” for photos, videos and first visits.',
  '当前范围内没有到访记录，可以放宽年份或地区筛选。':
    'No visits in the current range. Try widening the year or region filters.',
  '{label} · {visits} 次到访 · {places} 个地点 · {new} 个新地方 · {photos} 张照片 · {videos} 段视频':
    '{label} · {visits} visits · {places} places · {new} new places · {photos} photos · {videos} videos',
  ' · {visits} 次到访 · {places} 个地点 · {new} 个新地方 · {photos} 张照片 · {videos} 段视频':
    ' · {visits} visits · {places} places · {new} new places · {photos} photos · {videos} videos',
  '悬停或聚焦某一行查看明细': 'Hover or focus a row to see details',

  // ── 统计面板 · 地区分布 ──
  '地区层级': 'Region level',
  '省': 'Province',
  '市': 'City',
  '共 {n} 个省份': '{n} provinces in total',
  '共 {n} 个城市': '{n} cities in total',
  '，显示前 {n} 个': ', showing the first {n}',
  '当前范围内没有地区数据。': 'No regional data in the current range.',
  '{name}（{sub}） · {places} 个地点 · {visits} 次到访':
    '{name} ({sub}) · {places} places · {visits} visits',
  '{name} · {places} 个地点 · {visits} 次到访':
    '{name} · {places} places · {visits} visits',
  '点一行可按该省 / 市收窄统计范围。':
    'Click a row to narrow the stats by that province / city.',

  // ── 统计面板 · 地点排行 ──
  '显示前 {limit} / 共 {total} 个': 'Showing {limit} of {total}',
  '共 {n} 个地点': '{n} places',
  '次指标 = {metric}': 'Secondary metric = {metric}',
  '当前范围内没有地点。': 'No places in the current range.',
  '{n} 次到访': '{n} visits',
  '{n} 张照片': '{n} photos',
  '{n} 段视频': '{n} videos',
  '最近 {date}': 'Latest {date}',
  '秘密基地': 'Secret spot',

  // ── 统计面板 · 离家距离（2026-11-06 用户需求：按离家距离排序）──
  '离家距离': 'Distance from home',
  '从远到近': 'farthest first',
  '从近到远': 'nearest first',
  '条 = 到「家」的直线距离（{home}）': 'Bar = straight-line distance from home ({home})',
  '直线距离，不是驾车 / 步行距离；按当前筛选口径统计。':
    'Straight-line distance, not driving / walking distance; based on the current filters.',
  '还没有设置家：打开一个地点 → 编辑 → 设为家，就能按离家距离排行。':
    'No home set yet: open a place → Edit → Set as home to rank places by distance from home.',

  // ── 统计面板 · 省份点亮 ──
  '已点亮': 'lit up',
  '点亮程度（按地点数）': 'Lit level (by number of places)',
  '正在读取省份点亮…': 'Loading province lighting…',
  '读取省份点亮失败：{error}': 'Failed to load province lighting: {error}',
  '还没有点亮任何省份，新增一条到访记录后就会亮起。':
    'No provinces lit up yet. Add a visit and they will light up.',
  '省份排行': 'Province ranking',
  '{places} 地点 · {visits} 次': '{places} places · {visits} visits',
  '省份点亮在主地图上查看 · hover 地图省份看详情。':
    'Province lighting is shown on the main map · hover a province for details.',
  '本视图按全量数据统计，不受上方筛选影响。':
    'This view uses all data and is not affected by the filters above.',
  '只统计「去过」的地点；照片、视频按到访归户。':
    'Only “visited” places are counted; photos and videos are grouped under their visits.',
  '当前范围：{scope}。': 'Current range: {scope}.',

  // ── 时间轴（Timeline）──
  '播放 / 步进的粒度': 'Granularity for playback / stepping',
  '播放和步进的粒度': 'Granularity for playback and stepping',
  '已在最早时间（点一下打开去过清单）':
    'At the earliest date (click to open the visited list)',
  '已在最早时间': 'At the earliest date',
  '退一步（1 {gran}）': 'Step back (1 {gran})',
  '已在最晚时间（点一下打开去过清单）':
    'At the latest date (click to open the visited list)',
  '已在最晚时间': 'At the latest date',
  '进一步（1 {gran}）': 'Step forward (1 {gran})',
  '播放和步进时跳过没有到访的空白日期':
    'Skip blank dates without visits during playback and stepping',
  '跳空白': 'Skip gaps',
  '暂停': 'Pause',
  '播放：每{gran}推进一格': 'Play: advance one {gran} at a time',
  '恢复全部时间': 'Restore full time range',
  '起始时间': 'Start time',
  '结束时间': 'End time',
  '清除随行人员筛选（{names}）': 'Clear companion filter ({names})',
  '已筛选：': 'Filtered: ',

  // ── 随行人员筛选（CompanionFilter）──
  '按随行人员筛选（已选 {n} 人）': 'Filter by companions ({n} selected)',
  '按随行人员筛选': 'Filter by companions',
  '随行人员筛选': 'Companion filter',
  '随行人员': 'Companions',
  '已选 {selected} 人 · 共 {total} 人': '{selected} selected · {total} total',
  '搜索同行人': 'Search companions',
  '全部（清除筛选）': 'All (clear filter)',
  '加载失败': 'Failed to load',
  '加载中…': 'Loading…',
  '同行人列表加载失败': 'Failed to load companions',
  '还没有记录过同行人；编辑到访时填「同行人」即可。':
    'No companions recorded yet. Add “Companions” when editing a visit.',
  '没有匹配「{q}」的同行人': 'No companions matching “{q}”',
  '{places} 个共同地点 · {visits} 次到访': '{places} shared places · {visits} visits',

  // ── 照片墙（PhotoWall）──
  '共 {total} 张': '{total} photos',
  '照片墙每行张数': 'Photos per row in the photo wall',
  '关闭照片墙': 'Close photo wall',
  '关闭（Esc）': 'Close (Esc)',
  '上一张': 'Previous',
  '下一张': 'Next',
  '按年份筛选': 'Filter by year',
  '{year} 年 · {count} 张': '{year} · {count} photos',
  '清除地点筛选': 'Clear place filter',
  '只看{place} ×': 'Showing {place} ×',
  '「{name}」': '“{name}”',
  '该地点': 'this place',
  '切换排序：最新在前': 'Switch sorting: newest first',
  '切换排序：最早在前': 'Switch sorting: oldest first',
  '正在加载照片…': 'Loading photos…',
  '照片加载失败：{error}': 'Failed to load photos: {error}',
  '当前筛选下没有照片。': 'No photos match the current filter.',
  '还没有照片。': 'No photos yet.',
  '清空筛选': 'Clear filters',
  '正在加载更多…': 'Loading more…',
  '加载失败：{error}': 'Failed to load: {error}',
  '已加载 {loaded} / {total} 张': 'Loaded {loaded} / {total} photos',
  '共 {n} 张 · 已经到底了': '{n} photos · you have reached the end',
  '向下滚动加载更多': 'Scroll down to load more',
  '没有在当前筛选里找到目标照片': 'Target photo not found in the current filter',
  '拖动调整照片墙大小；双击恢复默认大小':
    'Drag to resize the photo wall; double-click to reset',
  '拖动调整大小（双击恢复默认）': 'Drag to resize (double-click to reset)',
  '点击预览': 'Click to preview',
  '（{region}）': ' ({region})',
  '{kind} {when} {name}：点击预览，下方按钮在地图中查看':
    '{kind} {when} {name}: click to preview; use the button below to view it on the map',
  '未能加载': 'Failed to load',
  '在地图中查看这个地点': 'View this place on the map',
  '在地图中查看': 'View on map',
  '目标照片': 'Target photo',

  // ── 回收站（TrashPanel）──
  '{date} 的到访': 'Visit on {date}',
  '{date} 的照片': 'Photo on {date}',
  '{n} 个照片/视频': '{n} photos/videos',
  '无媒体': 'No media',
  '读取回收站失败：{msg}': 'Failed to read trash: {msg}',
  '{n} 个地点': '{n} places',
  '已恢复 {parts}': 'Restored {parts}',
  '项目': 'items',
  '{n} 次此前单独删除的到访': '{n} visits deleted separately earlier',
  '{n} 张此前单独删除的照片': '{n} photos deleted separately earlier',
  ' · 含 {items}': ' · including {items}',
  ' · 跳过 {n} 项（需先恢复父级）': ' · skipped {n} items (restore the parent first)',
  '恢复失败：{msg}': 'Restore failed: {msg}',
  '已跳过 {n} 项需要先恢复父级的记录':
    'Skipped {n} items that need their parent restored first',
  '已彻底删除 {parts}，释放约 {size}':
    'Permanently deleted {parts}, freeing about {size}',
  ' · 删除文件 {n} 个': ' · deleted {n} files',
  ' · 文件本就不在 {n} 个': ' · {n} files were already missing',
  ' · {n} 个文件删除失败': ' · failed to delete {n} files',
  '部分文件没删掉（记录已清理，素材库里可能残留）：\n{items}':
    'Some files could not be deleted (records are cleaned up; files may remain in the library):\n{items}',
  '彻底删除失败：{msg}': 'Permanent delete failed: {msg}',
  '照片视频': 'Photos & videos',
  '回收站是空的。删除的地点 / 到访 / 照片视频会先来到这里，确认不要了再彻底删除释放空间。':
    'Trash is empty. Deleted places, visits, photos and videos land here first; delete them permanently to free up space.',
  '没有单独删除的地点。': 'No separately deleted places.',
  '没有单独删除的到访。': 'No separately deleted visits.',
  '没有单独删除的照片/视频。': 'No separately deleted photos or videos.',
  '{n} 项待处理': '{n} pending',
  '暂无待处理内容': 'Nothing pending',
  '切换排序：最近删除的在前 / 最早删除的在前':
    'Switch sorting: most recently deleted first / earliest deleted first',
  '回收站占用（照片 / 视频 + 缩略图缓存）': 'Trash size (photos/videos + thumbnail caches)',
  '{media} 个照片/视频 · {places} 个地点 · {visits} 次到访':
    '{media} photos/videos · {places} places · {visits} visits',
  '删除的内容先放这里，': 'Deleted items land here first — ',
  '不会立刻释放空间': 'space is not freed immediately',
  '；点「彻底删除」才会真正释放空间。父级删除只带走当时还在的内容，之前单独删的会留在原层级。':
    '; only “Delete permanently” actually frees space. Deleting a parent only takes what was present at the time; items deleted separately earlier stay at their original level.',
  '回收站分类': 'Trash categories',
  '全选': 'Select all',
  '已选 {n} 项': '{n} selected',
  '清空回收站': 'Empty trash',
  '恢复 {n} 项？': 'Restore {n} items?',
  '所选中有': 'Selection includes',
  '{n} 张照片/视频': '{n} photos/videos',
  '是此前单独删除的，默认不随父级恢复。':
    'that were deleted separately earlier; they are not restored with the parent by default.',
  '同时恢复此前单独删除的子项': 'Also restore child items deleted separately',
  '不勾选的话，它们会继续留在回收站里，之后可单独恢复。':
    'If unchecked, they stay in the trash and can be restored separately later.',
  '恢复中…': 'Restoring…',
  '彻底删除 {n} 项': 'Delete {n} items permanently',
  '，释放约': ', freeing about',
  '永久删除，无法恢复': 'permanently deleted and cannot be recovered',
  '；你电脑上的原文件不受影响。': '; the original files on your computer are untouched.',
  ' 会连带清理此前单独删除的 {items}。':
    ' It will also clean up {items} that were deleted separately earlier.',
  '删除中…': 'Deleting…',
  '确认彻底删除': 'Delete permanently',
  '读取中…': 'Loading…',
  '另有 {n} 个照片/视频随已删地点/到访折叠； 恢复父级时可以选择是否一并恢复。':
    '{n} photos/videos are folded under deleted places/visits; you can choose whether to restore them along with the parent.',
  '想去': 'Want to go',
  '未标注地区': 'Region not set',
  ' · 本次删除 {n} 次到访 · ': ' · {n} visits removed this time · ',
  ' · 另有 {n} 次到访此前单独删除': ' · plus {n} visits deleted separately earlier',
  ' · 另有 {n} 张照片此前单独删除': ' · plus {n} photos deleted separately earlier',
  ' · 本次删除 ': ' · deleted this time: ',
  ' · 所属地点在回收站，需先恢复地点':
    ' · its place is in the trash; restore the place first',
  ' · 所属到访在回收站，需先恢复到访':
    ' · its visit is in the trash; restore the visit first',
  '删除于 {time}': 'Deleted {time}',
  ' · 本次占 {size}': ' · takes up {size}',
  '恢复这条记录': 'Restore this item',
  '所属父级还在回收站，请先恢复父级':
    'Its parent is still in the trash; restore the parent first',
  '彻底删除并释放空间，无法恢复':
    'Delete permanently and free up space; this cannot be undone',
  '彻底删除': 'Delete permanently',
  '{n} 项需要先恢复父级，已跳过': '{n} items skipped: restore their parent first',
  '恢复所选': 'Restore selected',
  '彻底删除所选': 'Delete selected permanently',
};

export default dict;
