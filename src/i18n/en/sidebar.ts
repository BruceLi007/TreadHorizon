import type { Dict } from '../index';

/**
 * 英文词条 · 侧栏域（T2 维护）：地点详情 / 到访列表侧栏、添加足迹面板、灯箱、
 * 搜索框与搜索结果、秘密基地密码框、错误边界。
 *
 * 写法：一行一条 `'中文原文': 'English',`，key 必须与代码里 t('…') 的中文逐字一致
 * （包括标点、空格、「」等）；插值占位符 {n} 等两边都要有。
 */
const dict: Dict = {
  // ── 通用动作 / 状态（多处复用）──
  '封面': 'Cover',
  '设为封面': 'Set as cover',
  '移动到别的到访': 'Move to another visit',
  '打开本地文件夹': 'Open local folder',
  '删除（移到回收站，可恢复）': 'Delete (moves to Trash, recoverable)',
  '取消': 'Cancel',
  '保存': 'Save',
  '保存中…': 'Saving…',
  '编辑': 'Edit',
  '删除': 'Delete',
  '删除中…': 'Deleting…',
  '确认删除': 'Confirm delete',
  '关闭': 'Close',
  '重试': 'Retry',
  '完成': 'Done',
  '失败': 'Failed',
  '已取消': 'Canceled',
  '等待中': 'Waiting',
  '上传中': 'Uploading',
  '跳过（重复）': 'Skipped (duplicate)',
  '处理中…': 'Processing…',
  '处理中（缩略图）…': 'Processing (thumbnail)…',
  '去过': 'Visited',
  '想去': 'Want to go',
  '家': 'Home',
  '秘密基地': 'Secret spot',
  '名称': 'Name',
  '类型': 'Type',
  '位置': 'Location',
  '坐标': 'Coordinates',
  '日期': 'Date',

  // ── Sidebar · 媒体格子（MediaTile）──
  '日期不能为空': 'Date is required',
  '名称不能为空': 'Name is required',

  // ── Sidebar · 到访编辑表单（VisitFormEditor）──
  '标题': 'Title',
  '可选': 'Optional',
  '评分': 'Rating',
  '{n} 星': '{n} stars',
  '同行人（用、或逗号分隔）': 'Companions (separate with commas)',
  '小王、小李': 'Alex, Sam',
  '笔记': 'Notes',
  '这次旅行…': 'About this trip…',

  // ── Sidebar · 上传 / 媒体操作提示 ──
  '文件已经不在素材库里了；已打开它原来所在的文件夹。':
    'The file is no longer in the media library; its original folder was opened instead.',
  '打开本地文件夹失败：{msg}': 'Failed to open local folder: {msg}',
  '添加到访失败：{msg}': 'Failed to add visit: {msg}',
  '请先在「设置 → 秘密基地」里设置密码': 'Set a password in Settings → Secret spot first',

  // ── Sidebar · 标题栏 / 地点编辑 ──
  '返回 My旅迹列表（保留列表的展开 / 滚动位置）':
    'Back to My Trail (keeps expanded and scroll position)',
  '返回': 'Back',
  '地图': 'Map',
  '这一簇': 'This cluster',
  '返回地图': 'Back to map',
  '返回这一簇': 'Back to this cluster',
  '在 My旅迹中查看 {name}': 'View {name} in My Trail',
  '在 My旅迹中查看并定位到这个地点': 'View this place in My Trail',
  // ── My旅迹多选批量操作（2026-11-08 D-295）──
  '选择 {name}': 'Select {name}',
  '多选（可批量删除）': 'Multi-select (bulk delete)',
  '多选（可批量删除 / 转为去过）': 'Multi-select (bulk delete / mark visited)',
  '移到回收站': 'Move to Trash',
  '删除选中的 {n} 个地点？': 'Delete the selected {n} places?',
  '选中的地点会连同到访和照片一起移到回收站，之后可在顶栏「回收站」恢复。':
    'The selected places, together with their visits and photos, will be moved to the Trash and can be restored from the top bar later.',
  '有 {n} 个地点删除失败，请重试': '{n} places failed to delete. Please try again.',
  '有 {n} 个地点转换失败，请重试': '{n} places failed to convert. Please try again.',
  '打开欢迎页': 'Open welcome page',
  '编辑地点': 'Edit place',
  '合并重复地点': 'Merge duplicate places',
  '合并': 'Merge',
  '还没有设置密码，可先去设置 → 安全里设置': 'No password set yet — set one in Settings → Security',
  '秘密基地：地图上紫色飞镖，点开详情需要密码':
    'Secret spot: a purple dart on the map; a password is required to see details',
  '取消秘密基地': 'Unset secret spot',
  '设为秘密基地': 'Set as secret spot',
  '家：全库唯一，地图上用青绿房子图标，功能和普通地点一样':
    'Home: unique across the library; shown as a teal house icon on the map, otherwise like a normal place',
  '取消家': 'Unset home',
  '设为家': 'Set as home',
  '未知位置': 'Unknown location',
  '坐标不可改，位置不对请删掉重加':
    'Coordinates cannot be changed; delete and re-add if the location is wrong',

  // ── Sidebar · 地点编辑 · 地区手动编辑（2026-11-08 D-284）──
  '地区（省 / 市 / 区县）': 'Region (province / city / district)',
  '识别不到或不准可以直接改，留空 = 未标注':
    'Edit it if detection fails or is inaccurate; leave empty for unlabeled',
  '重新识别': 'Detect again',
  '按坐标重新识别一次省 / 市 / 区县并填入':
    'Detect province / city / district again from the coordinates',
  '区 / 县': 'District / county',
  '如：浙江省': 'e.g. Zhejiang',
  '如：杭州市': 'e.g. Hangzhou',
  '如：西湖区': 'e.g. Xihu',
  '识别失败：{msg}': 'Detection failed: {msg}',

  // ── Sidebar · 地址行 / 到访汇总 ──
  ' 加入于 {date}': ' Added on {date}',
  '去过 {n} 次 · {m} 个文件': 'Visited {n} times · {m} files',
  '离家 {km} km': '{km} km from home',
  '照片每行': 'Photos per row',

  // ── Sidebar · 想去清单 ──
  '这是「想去」的地方，还没有记过到访。': 'This is a wishlist place; no visits recorded yet.',
  '转成「去过」之后，就能记录到访日期、笔记和照片了。':
    'Once marked as visited, you can record visit dates, notes and photos.',
  '转为去过': 'Mark as visited',
  '删除「{name}」？': 'Delete "{name}"?',
  '想去清单里的这条也会消失（软删，M3 回收站可恢复）':
    'This wishlist entry disappears too (soft delete; recoverable from Trash in M3)',
  '从想去清单删除': 'Remove from wishlist',

  // ── Sidebar · 到访列表 / 媒体移动与删除 ──
  '同行：{names}': 'Companions: {names}',
  '给这次到访（{date}）添加素材（图片 / 视频）':
    'Add media (photos / videos) to this visit ({date})',
  '添加素材': 'Add media',
  '移动到：': 'Move to:',
  '只有一个到访，先加一次再到别处': 'Only one visit — add another before moving photos elsewhere',
  '删除这次到访？': 'Delete this visit?',
  '{n} 个照片/视频会一起移到回收站，可恢复':
    '{n} photos/videos will be moved to Trash together (recoverable)',
  '这个地点还没有到访记录，可以加一次或直接拖照片进来。':
    'No visits for this place yet — add one, or just drag photos in.',
  // 2026-11-10 D-347（用户要求）：到访照片默认只显示一行，可展开 / 收起
  '展开全部 {n} 个照片/视频': 'Show all {n} photos/videos',
  '收起照片': 'Collapse photos',
  // 2026-11-10 D-348（用户要求）：到访列表多选批量操作（批量移到回收站）
  '多选（可批量移到回收站）': 'Multi-select (batch move to Trash)',
  '选择这次到访（{date}）': 'Select this visit ({date})',
  '取消选择这次到访（{date}）': 'Deselect this visit ({date})',
  '删除选中的 {n} 次到访？': 'Delete the {n} selected visits?',
  '选中的到访会连同照片/视频一起移到回收站，之后可在顶栏「回收站」恢复。':
    'The selected visits, together with their photos/videos, will be moved to Trash and can be restored from the top bar later.',
  '有 {n} 次到访删除失败，请重试': '{n} visits failed to delete; please try again',

  // ── Sidebar · 上传队列 ──
  '上传队列': 'Upload queue',
  '全部取消': 'Cancel all',
  '清除已完成': 'Clear finished',
  '关闭上传队列（未完成项会被取消）':
    'Close the upload queue (unfinished items will be cancelled)',
  '关闭上传队列': 'Close upload queue',
  // 2026-11-10（用户要求）：上传列表可展开 / 收起
  '展开上传列表': 'Expand upload list',
  '收起上传列表': 'Collapse upload list',
  '失败 {n}': '{n} failed',
  // D-261：有失败项时关闭队列的二次确认
  '还有 {n} 个文件上传失败，仍要关闭上传队列？':
    '{n} file(s) failed to upload. Close the upload queue anyway?',
  '关闭后，失败的文件需要重新选择上传（不会自动重试）。':
    'After closing, failed files must be selected again to upload (they will not retry automatically).',
  '仍然关闭': 'Close anyway',

  // ── Sidebar · 拖文件夹新建到访（D-246）──
  '松开鼠标：按文件夹名新建一次到访并上传':
    'Release to create a visit named after the folder and upload its media',
  '文件夹中的图片 / 视频会批量上传；日期默认今天，之后可编辑':
    'Photos / videos in the folder are uploaded in bulk; the date defaults to today and can be edited later',
  '正在按文件夹新建到访并加入上传队列…':
    'Creating visits from folders and adding files to the upload queue…',
  '这个地点还是「想去」，先转为「去过」再拖文件夹':
    'This place is still on the wishlist — mark it as visited before dropping folders',
  '文件夹「{name}」里没有可上传的图片 / 视频':
    'Folder "{name}" contains no photos / videos to upload',
  '新建到访后找不到它': 'Could not find the new visit after creating it',
  '按文件夹新建到访失败：{msg}': 'Failed to create a visit from the folder: {msg}',
  '先添加一次到访，再把零散文件拖进来':
    'Add a visit first, then drag individual files in',
  '已按文件夹名新建 {n} 次到访，开始上传 {files} 个文件':
    'Created {n} visit(s) from folder names; uploading {files} files',
  '已加入上传队列：{files} 个文件': 'Added {files} files to the upload queue',
  '没有识别到可上传的文件夹或图片 / 视频':
    'No folder or photos / videos found to upload',
  '已忽略 {n} 个非图片 / 视频文件': 'Ignored {n} non-media files',

  // ── Sidebar · 底部操作 / 删除地点确认 ──
  '+ 添加一次到访': '+ Add a visit',
  '这是最后一个到访，地点还在。': 'This was the last visit; the place still exists.',
  '要连这个地点一起移到回收站吗？地点里的内容也会一起进去，可恢复。':
    'Move the place to Trash as well? Everything in it goes along and can be recovered.',
  '保留地点': 'Keep place',
  '删除地点': 'Delete place',
  '{n} 次到访 · {m} 个照片/视频会一起移到回收站，可恢复':
    '{n} visits · {m} photos/videos will be moved to Trash together (recoverable)',
  '删除这个地点': 'Delete this place',

  // ── AddPanel · 添加足迹 ──
  '确认足迹': 'Confirm place',
  '+ 添加足迹': '+ Add visit',
  '搜地名：西湖 / 青海湖 / 杭州': 'Search places: West Lake / Qinghai Lake / Hangzhou',
  '搜索中…': 'Searching…',
  '搜索失败：{err}': 'Search failed: {err}',
  '多半是天地图接口限流，等 2 秒再试一次。':
    'Tianditu is probably rate-limiting; wait 2 seconds and try again.',
  '没有找到「{q}」。换个说法试试（比如加城市名）， 或者搜最近的镇，再把标记拖过去。':
    'No results for "{q}". Try different words (for example add a city name), or search for the nearest town and drag the marker there.',
  '行政区': 'Administrative area',
  '输入任意层级的地名：省、市、区县、景点都行。':
    'Enter a place name at any level: province, city, district or landmark.',
  '选中后地图会飞过去，再拖动标记微调位置。':
    'After picking, the map flies there; drag the marker to fine-tune.',
  '也可以直接在地图上点选位置（缩放 ≥ 6）——此刻光标已经是飞镖，点哪落哪。':
    'You can also click directly on the map (zoom ≥ 6) — the cursor is already a dart, so click to drop the marker.',
  '定位中…': 'Locating…',
  '今天': 'Today',
  '想去的地点不用填日期；之后真去了，在侧栏点「转为去过」再记日期。':
    'Wishlist places need no date. Once you actually go, click "Mark as visited" in the sidebar and add the date.',
  '地图上的大号标记可以拖动，拖到准确位置后会自动更新行政区和名称；手动改过的名称不会被覆盖。':
    'Drag the large marker; the administrative area and name update once it is in place. A name you edited manually is kept.',
  '保存并添加照片': 'Save & add photos',

  // ── Lightbox · 灯箱 ──
  '复位': 'Reset',
  '查看原图': 'View original',
  '在照片墙中查看': 'Show on the photo wall',
  '文件不在了，已打开所在文件夹': 'The file is gone; its folder was opened instead',
  '已在资源管理器中定位': 'Revealed in File Explorer',
  '打开失败：{msg}': 'Failed to open: {msg}',
  '已移到回收站（可在回收站恢复）': 'Moved to Trash (restore it in Trash)',
  '滚轮 / 双指缩放 · 双击放大 · 拖动平移':
    'Scroll / pinch to zoom · double-click to enlarge · drag to pan',
  '灯箱缩略图': 'Lightbox filmstrip',
  '第 {n} 项': 'Item {n}',

  // ── SearchBox · 全局搜索 ──
  '搜自己的足迹，或搜地名': 'Search your footprints or a place name',
  '我的足迹': 'My footprints',
  '去过 {n} 次': 'Visited {n} times',
  '地图地点': 'Map places',
  '+ 添加为足迹': '+ Add as place',
  '没找到「{term}」': 'No results for "{term}"',

  // ── SecretPrompt · 秘密基地密码框 ──
  '尝试次数过多，请稍后再试': 'Too many attempts. Please try again later.',
  '密码错误，请重试': 'Wrong password. Try again.',
  '请输入密码': 'Please enter the password',
  '这是秘密基地，输入密码后才能查看详情。':
    'This is a secret spot; enter the password to see the details.',
  '初始密码可到 设置 → 安全 里查看（也可以在那里重置）':
    'See the initial password in Settings → Security (you can also reset it there).',
  // D-332（用户选择方案 B）：云端版秘密基地用登录账号密码解锁
  '这是秘密基地。云端版需要重新输入你的登录账号密码来解锁。':
    'This is a secret spot. In the cloud version, re-enter your login password to unlock it.',
  '云端版用登录账号密码解锁；忘记登录密码时请联系管理员重置。':
    'The cloud version unlocks with your login password. If you forgot it, ask the administrator to reset it.',
  '登录密码': 'Login password',
  '输入登录密码': 'Enter login password',
  '密码': 'Password',
  '输入密码': 'Enter password',
  '密码错误只会提示错误，不会泄露任何地点信息。':
    'A wrong password only shows an error and never reveals any place information.',
  '解锁中…': 'Unlocking…',
  '解锁': 'Unlock',

  // ── ErrorBoundary · 错误边界（Provider 之外，用 tr()）──
  '页面出错了': 'Something went wrong',
  '把下面这段内容截图或复制给我，就能定位。':
    'Screenshot or copy the details below so I can find the cause.',
  '错误': 'Error',
  '调用栈': 'Stack trace',
  '组件栈': 'Component stack',
  '重新加载': 'Reload',
};

export default dict;
