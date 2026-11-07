import type { Dict } from '../index';

/**
 * 英文词条 · 通用域（Lead 维护）：顶栏 HUD / 标语 / App 全局 toast 与启动失败页 /
 * 设置窗口框架 / 设置 → 通用（语言 / 外观 / 字体 / 图标配色）。
 *
 * 写法：一行一条 `'中文原文': 'English',`，key 必须与代码里 t('…') 的中文逐字一致
 * （包括标点、空格、「」等）；插值占位符 {n} 等两边都要有。
 * 注意：SettingsModal / GeneralSettings 里有些 key 是「常量 → 渲染处 t(常量)」，
 * 静态脚本检测不到，改文案时两边要一起改（TABS / THEME_LEVEL_LABEL / APP_FONTS）。
 */
const dict: Dict = {
  // ── 设置窗口框架（SettingsModal）──
  '设置': 'Settings',
  '设置分类': 'Settings sections',
  '关闭设置': 'Close settings',
  '拖动调整设置窗口大小；双击恢复默认大小': 'Drag to resize the settings window; double-click to reset',
  '拖动调整大小（双击恢复默认）': 'Drag to resize (double-click to reset)',
  '通用': 'General',
  '备份与恢复': 'Backup & Restore',
  '导出备份 / 从备份恢复 / 备份提醒': 'Export, restore and backup reminders',
  '素材库': 'Media Library',
  '素材库路径、重新关联与视频封面': 'Library path, relinking and video covers',
  '回收站': 'Trash',
  '已删除的地点 / 到访 / 照片视频': 'Deleted places, visits, photos and videos',
  '天地图 Key': 'Map Key',
  '天地图 Key（Key 只存本机）': 'Tianditu key (key stays on this device)',
  '安全': 'Security',
  '秘密基地密码': 'Secret spot password',
  '关于': 'About',
  '版本、运行环境与数据位置': 'Version, environment and data location',
  '{n} 项待处理': '{n} pending',

  // ── 设置 → 通用：语言（D-138）──
  '语言': 'Language',
  '界面语言，点一下立即生效；和主题、字体一样只存在本机浏览器里，不写 data/、不进备份。':
    'UI language — applied instantly. Like the theme and font, it is stored only in this browser: nothing is written to data/ or included in backups.',
  '界面语言': 'UI language',

  // ── 设置 → 通用：主题标语（D-146 / D-147；D-147 起一句话 + 单输入框）──
  '主题': 'Theme',
  '顶栏标语': 'Top-bar slogan',
  '标语': 'Slogan',
  '显示在顶栏大按钮组上方，作为这个应用的主题标语（一句话）。留空则不显示标语。只存本机浏览器（不写 data/、不进备份）；自定义内容不随界面语言翻译；窄屏（<1420px）下标语本来就不显示。':
    'Shown above the big button group in the top bar as the theme line of this app (one sentence). Leave it empty to hide the slogan. Stored only in this browser (not in data/, not in backups). Custom text is not translated with the UI language. On narrow screens (<1420px) the slogan is hidden anyway.',
  '顶栏标语预览': 'Slogan preview',
  '留空 → 顶栏不显示标语': 'Empty → the top-bar slogan is hidden',
  '恢复默认标语': 'Reset to default',
  '当前使用默认文案': 'Using the default text',
  '已自定义（只存本机）': 'Customized (this browser only)',
  '最多 40 字': 'Up to 40 characters',
  '外观明暗、界面语言、主题与字体': 'Appearance, language, theme and font',

  // ── 设置 → 通用：外观 ──
  '外观': 'Appearance',
  '跟随操作系统的深浅色自动切换': 'Follow the system light/dark setting automatically',
  '跟随系统': 'Follow system',
  '左右拖动选择界面明暗：最左「纯白」、最右「纯黑」，中间是「浅色 / 深色」，共 4 档。 偏好只存在本机浏览器里，下一次打开自动沿用。':
    'Drag to pick the UI brightness: far left is Pure white, far right is Pure black, with Light and Dark in between — 4 levels. The preference is stored only in this browser and reused next time.',
  '界面明暗档位（纯白 / 浅色 / 深色 / 纯黑）': 'UI brightness level (pure white / light / dark / pure black)',
  '纯白': 'Pure white',
  '浅色': 'Light',
  '深色': 'Dark',
  '纯黑': 'Pure black',
  '跟随系统：当前显示「{level}」（随 Windows 设置 → 个性化 → 颜色 变化）；拖动滑块会退出跟随系统。':
    'Following system: currently showing "{level}" (tracks Windows Settings → Personalization → Colors); dragging the slider turns this off.',
  '当前：{level}': 'Current: {level}',

  // ── 设置 → 通用：字体 ──
  '字体': 'Font',
  '微软雅黑': 'Microsoft YaHei',
  '宋体': 'SimSun',
  '黑体': 'SimHei',
  '楷体': 'KaiTi',
  // D-140 / D-227：随仓库发布的两款 SIL OFL 字体（喵咛狗爬黑为默认）
  '喵咛狗爬黑': 'Miorning Goupa Hei',
  '嗷呜碎瘾黑': 'Howl Shattered',
  // D-142：界面字号三档
  '字号': 'Text size',
  '界面字号': 'UI text size',
  '小': 'Small',
  '中': 'Medium',
  '大': 'Large',
  // D-168 追加：界面字重（常规 / 加粗）
  '字重': 'Weight',
  '界面字重': 'UI font weight',
  '常规': 'Regular',
  '加粗': 'Bold',
  '只改界面文字大小与粗细，不动图片 / 图标 / 布局比例':
    'Only scales UI text size and weight — images, icons and layout stay the same',
  '选择界面文字使用的常规字体，点一下立即生效。偏好和主题一样只存在本机浏览器里， 不写进 data/、不进备份；代码和等宽数字仍保持等宽字体。':
    'Choose the regular font for UI text — clicking applies instantly. Like the theme, this preference is stored only in this browser: nothing is written to data/ or included in backups. Code and tabular numbers keep a monospace font.',
  '界面字体': 'UI font',
  'Tread Horizon Aa 2026': 'Tread Horizon Aa 2026',
  '当前：{font} · 预览：山河远阔，人间烟火。 2026.11.04':
    'Current: {font} · Preview: wide rivers and mountains, everyday life. 2026.11.04',

  // ── 到访照片每行张数（只在地点侧栏顶部快捷切换；D-165 从设置里移除）──
  '到访照片每行张数': 'Photos per row for visits',
  '{n} 张': '{n} per row',

  // ── App：启动 / 添加足迹 ──
  '服务端没有读到 TDT_TK': 'The server could not read TDT_TK',
  '地点不存在或已删除': 'This place does not exist or has been deleted',
  '没有需要补全地区的地点': 'No places need their region filled in',
  '已补全 {ok} 个地点，{failed} 个识别失败（可稍后再试）':
    'Filled in {ok} places; {failed} could not be identified (try again later)',
  '已补全 {ok} 个地点的省 / 市 / 区': 'Filled in province / city / district for {ok} places',
  '补全地区失败：{msg}': 'Failed to fill in regions: {msg}',
  '请先放大（缩放 ≥ 6）再点选位置': 'Zoom in (zoom ≥ 6) before picking a location',
  '暂不支持国外到访记录': 'Overseas visits are not supported yet',
  '已退出添加足迹': 'Add visit canceled',
  '还没有设置家：打开一个地点 → 编辑 → 设为家':
    'No home set yet: open a place → Edit → Set as home',
  '已飞到家的位置：{name}': 'Flew to home: {name}',
  '未命名地点': 'Untitled place',
  '已保存 · 侧栏里可以拖入照片': 'Saved · drop photos into the sidebar',
  '保存失败：{msg}': 'Save failed: {msg}',

  // ── App：上传队列（F-MED-10）──
  '正在上传…': 'Uploading…',
  '已存在（同内容），跳过': 'Already exists (same content), skipped',
  '上传失败': 'Upload failed',
  '已取消': 'Canceled',
  '上传结束：': 'Upload finished: ',
  '成功 {n}': '{n} succeeded',
  '跳过 {n}': '{n} skipped',
  '失败 {n}': '{n} failed',

  // ── App：顶栏 HUD / 按钮 ──
  '脚步丈量世界': 'Every step, a wider horizon',
  '世界辣 ~ ~ ~ 么大': 'The world is so ~ ~ ~ big',
  '我想 · · · 总得去看一看吧 ! ! !': 'I want · · · to go see it all ! ! !',
  '收起搜索': 'Hide search',
  '搜索地址 / 足迹': 'Search addresses / footprints',
  '退出添加足迹（Esc）': 'Cancel add visit (Esc)',
  '添加足迹（搜地名定位，或直接在地图上点选）':
    'Add visit (search a place, or click on the map)',
  '+ 添加足迹': '+ Add visit',
  '总览（回到全国视野）': 'Overview (back to the whole country)',
  '总览': 'Overview',
  '飞到家的位置：{name}': 'Fly to home: {name}',
  '还没有设置家（打开一个地点 → 编辑 → 设为家）':
    'No home set (open a place → Edit → Set as home)',
  '家': 'Home',
  'My旅迹（去过 / 想去）': 'My Trail (visited / want to go)',
  'My旅迹': 'My Trail',
  '统计模式（省份点亮 / 年份 / 排行）': 'Stats mode (province lighting / years / ranking)',
  '统计': 'Stats',
  '照片墙（全部照片按时间铺开）': 'Photo wall (all photos arranged by date)',
  '照片墙': 'Photo wall',
  '设置 · 该备份了：{text}': 'Settings · backup due: {text}',
  '该备份了：{text}': 'Backup due: {text}',
  '添加第一个地方': 'Add your first place',

  // ── App：备份提醒 / 恢复 / 合并 / 隐私 / 删除 toast ──
  '从未备份过（当前 {n} 个地点）': 'No backup yet ({n} places)',
  '距离上次备份已 {days} 天（提醒阈值 {threshold} 天）':
    '{days} days since the last backup (reminder threshold: {threshold} days)',
  '已移到回收站 · 可在顶栏恢复': 'Moved to Trash · restore it from the top bar',
  '已删除 · 可在顶栏「回收站」恢复': 'Deleted · restore it from Trash in the top bar',
  '已合并 · 到访和照片都迁到目标地点了':
    'Merged · visits and photos moved to the target place',
  '已从备份恢复，但刷新地图失败：{msg}':
    'Restored from backup, but refreshing the map failed: {msg}',
  '已从备份恢复 · 地图和清单已刷新': 'Restored from backup · map and lists refreshed',
  '只看和「{name}」一起去过的地方': 'Only showing places you visited with "{name}"',
  '只看和「{names}」等 {n} 人一起去过的地方':
    'Only showing places you visited with "{names}" and {n} others',
  '已经是最早 / 最晚时间了': 'Already at the earliest / latest time',

  // ── App：启动失败页 ──
  '启动失败': 'Failed to start',
  '确认服务已启动（': 'Make sure the server is running (',
  ' 或 ': ' or ',
  '），并检查 ': '), and check ',
  ' 里的 ': ' in ',
  '。': '.',
  '正在连接天地图…': 'Connecting to Tianditu…',

  // ── 登录 / 邀请码注册页（M6 P2-1，D-200）──
  '登录': 'Sign in',
  '邀请码注册': 'Sign up with invite code',
  '登录或注册': 'Sign in or sign up',
  '登录你的账号，继续记录足迹。': 'Sign in to your account and keep recording your footprints.',
  '用一个邀请码创建账号，数据只有你自己能看到。':
    'Create an account with an invite code — only you can see your data.',
  '用户名': 'Username',
  '显示名（可选）': 'Display name (optional)',
  '邀请码': 'Invite code',
  '登录中…': 'Signing in…',
  '注册中…': 'Signing up…',
  '注册': 'Sign up',
  '还没有账号？向管理员索要邀请码后注册。':
    'No account yet? Ask the admin for an invite code, then sign up.',
  '邀请码由管理员生成，一次性使用；注册后自动登录。':
    'Invite codes are created by the admin and can be used only once; you are signed in right after signing up.',
  '数据保存在你自己的账号下，只有你能看到。':
    'Your data lives under your own account and only you can see it.',

  // ── 通知 / 提示（M6 P2-1）──
  '当前没有登录账号。': 'No account is currently signed in.',

  // ── 配置天地图 Key 引导页（M6 P2-4，D-205）──
  '你的账号还没有配置天地图 Key。每个账号使用自己的 Key，地图才能加载。':
    'Your account has no Tianditu key yet. Each account uses its own key for the map to load.',
  // ── 本地模式首次启动配置天地图 Key 引导页（2026-11-07，D-238）──
  '这台电脑还没有配置天地图 Key，填一次就能加载地图。':
    'This computer has no Tianditu key yet. Add one once and the map will load.',
  'Key 只保存在本机，不会写进日志，也不会进导出 / 备份。':
    'The key is stored only on this computer; it never appears in logs, exports or backups.',
  '也可以把 Key 写进 .env.local 的 TDT_TK，重启应用后生效。':
    'You can also put the key in TDT_TK inside .env.local; it takes effect after a restart.',
  '天地图 Key（32 位）': 'Tianditu key (32 characters)',
  '保存并继续': 'Save and continue',
  '（类型选「浏览器端」，域名白名单留空）': ' (choose the "Browser" type, leave the domain allowlist empty)',
  'Key 只保存在你自己的账号下，不会写进日志、不会出现在导出 / 备份里，也不会被其他账号看到。':
    'The key is stored only under your own account; it never appears in logs, exports or backups, and no other account can see it.',

  // ── 天地图 Key 申请教程 PDF（2026-11-07，D-222）──
  '不知道怎么申请？': 'Not sure how to apply? ',
  '查看《天地图 Key 申请教程》（PDF，新窗口打开）':
    'Read the Tianditu key guide (PDF, opens in a new window)',

  // ── 顶栏账号头像 / 名称（2026-11-07，D-224）──
  '更换头像': 'Change avatar',
  '用户头像': 'User avatar',
  '打开设置 · 账号': 'Open Settings · Account',
  '请选择图片文件': 'Please choose an image file',
  '图片太大，请选择 10MB 以内的图片': 'The image is too large — choose one under 10 MB',
  '头像已更新': 'Avatar updated',
  '头像上传失败：{msg}': 'Avatar upload failed: {msg}',

  // ── 自定义日期选择器（2026-11-07，D-247）──
  '选择日期': 'Choose date',
  '选择年月': 'Choose month and year',
  '返回日期选择': 'Back to date selection',
  '上个月': 'Previous month',
  '下个月': 'Next month',
  '上一年': 'Previous year',
  '下一年': 'Next year',

  // ── 上传单文件上限（2026-11-07，D-248）──
  '有 {n} 个文件超过单文件上限（{gb} GB），已跳过':
    'Skipped {n} file(s) larger than the single-file limit ({gb} GB)',

  // ── 照片墙按月分组（2026-11-07，D-251）──
  '未知月份': 'Unknown month',
  // ── 照片墙多选删除（2026-11-07，D-255）──
  '选择': 'Select',
  '取消全选': 'Deselect all',
  '删除所选': 'Delete selected',
  '点击选择': 'Click to select',
  '已选 {n} 张': '{n} selected',
  '删除选中的 {n} 张照片/视频？': 'Delete the selected {n} photos/videos?',
  '会移到回收站，可恢复。': 'They will be moved to Trash and can be restored.',
  '有 {n} 张删除失败，请重试': 'Failed to delete {n} item(s); please try again.',

  // ── 回收站恢复 / 彻底删除确认弹窗（2026-11-07，D-256）──
  '恢复后会回到原来的位置。': 'It will be restored to its original position.',
  '清空回收站？': 'Empty Trash?',
  '彻底删除 {n} 项，释放约 {size}？': 'Permanently delete {n} item(s) and free about {size}?',
  '数据库记录和 B 库里的原片、缩略图/预览/封面帧缓存会被':
    'Database records and the copies, thumbnails/previews/cover frames in library B will be',
  '确认': 'Confirm',

  // ── 照片墙按月全选（2026-11-07，D-257）──
  '全选本月': 'Select this month',
  '取消本月': 'Deselect this month',
};

export default dict;
