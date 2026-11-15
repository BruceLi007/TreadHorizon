import type { Dict } from '../index';

/**
 * 2026-11-14 D-416：分享选择 / 本地导出（P3 / P4）的界面文案。
 * 只读分享页（src/share/）有自己的独立小字典，不在这里。
 */
const dict: Dict = {
  '分享': 'Share',
  '退出分享': 'Exit share',
  '退出分享选择': 'Exit share selection',
  '分享（选择地点 / 到访 / 照片导出分享包）':
    'Share (pick places / visits / photos and export a package)',
  '云端版请在「我的分享」里上传本地导出的分享包':
    'On the cloud version, upload the package exported locally from “My shares”.',
  '已恢复上次选择（{n} 张照片）': 'Restored your last selection ({n} photos)',
  '勾选地点 → 点开后在右侧抽屉里勾到访和照片 · 视频暂不可分享':
    'Tick places → open one to pick visits and photos in the right drawer · videos can’t be shared yet',
  '在列表里逐级勾选：省 / 市 / 地点 / 到访 / 单张照片 · 点地点展开到访，点日期展开照片 · 视频暂不可分享':
    'Tick level by level in the list: province / city / place / visit / single photo — tap a place to expand its visits, tap a date to expand photos · videos can’t be shared yet',
  '正在读取到访…': 'Loading visits…',
  '这个地点还没有到访。': 'No visits at this place yet.',
  '选择 {name} 的全部照片': 'Select all photos in {name}',
  '退出选择': 'Exit selection',
  '已选 {places} 地点 · {visits} 到访 · {photos} 照片':
    '{places} places · {visits} visits · {photos} photos selected',
  '清空': 'Clear',
  '确认分享': 'Confirm share',
  '没有可分享的地点': 'No places to share',
  '选择这个地点的全部照片': 'Select all photos of this place',
  '仅视频，暂不可分享': 'Video only — can’t be shared yet',
  '秘密基地不参与分享': 'Secret spots are not shared',
  '秘密基地不参与分享：含秘密基地的分享包无法上传。密码忘了无法找回，只能撤销重发。':
    'Secret spots are excluded from sharing: a package containing a secret spot cannot be uploaded. Share passwords cannot be recovered — revoke and upload again.',
  '分享选择：{name}': 'Share selection: {name}',
  '已选 {n} / {total} 张照片': '{n} / {total} photos selected',
  '这个地点还没有照片。': 'This place has no photos yet.',
  '选择这次到访的全部照片': 'Select all photos of this visit',
  '选择这张照片': 'Select this photo',
  '视频暂不可分享': 'Videos can’t be shared yet',
  '确认导出会生成一个压缩包。它不会自动上传，也不会删除或修改你的任何原数据。':
    'This creates a zip file. It won’t be uploaded automatically and won’t change or delete any of your data.',
  '已弹出「浏览文件夹」窗口：如果没看到，按 Alt+Tab 或点任务栏里的「浏览文件夹」（它可能在浏览器后面）。':
    'The “Browse for folder” dialog is open. If you don’t see it, press Alt+Tab or click it in the taskbar — it may be behind the browser.',
  '{n} 个': '{n}',
  '未选择到访': 'No visits selected',
  '时段': 'Date range',
  '约 {size}': 'about {size}',
  '分享标题（可选）': 'Share title (optional)',
  '例如：2026 秋 · 川西': 'e.g. Autumn 2026 · Western Sichuan',
  '包含到访笔记': 'Include visit notes',
  '包含同行人': 'Include companions',
  '选择文件夹并导出': 'Choose folder and export',
  '取消导出': 'Cancel export',
  '正在导出分享包…': 'Exporting share package…',
  '正在读取照片…': 'Reading photos…',
  '已处理 {done} / {total} 张照片': 'Processed {done} / {total} photos',
  '已跳过 {n} 张无法读取的照片。': 'Skipped {n} unreadable photos.',
  '导出在后台进行，关掉这个窗口也不会中断。':
    'Export runs in the background; closing this window won’t stop it.',
  '导出成功': 'Export complete',
  '打开文件夹': 'Open folder',
  '复制路径': 'Copy path',
  '下一步：打开官网 → 登录或注册（需邀请码）→ 我的分享 → 上传这个文件。':
    'Next: open the official site → sign in or register (invite code required) → My shares → upload this file.',
  '去官网登录 / 注册 →': 'Sign in / register on the site →',
  '导出失败': 'Export failed',
  '在本地版导出分享包后，在这里上传；上传成功会得到免登录查看的链接。':
    'Export a package in the local version, then upload it here to get a public read-only link.',
  '分享占用 {size} · 共 {n} 份 · 被打开 {views} 次 · 独立访客 {visitors} 人':
    'Shares use {size} · {n} links · {views} opens · {visitors} unique visitors',
  '分享包（.zip）': 'Share package (.zip)',
  '有效期': 'Valid for',
  '1 小时': '1 hour',
  '24 小时': '24 hours',
  '7 天': '7 days',
  '不限时': 'No expiry',
  '访问密码（可选）': 'Access password (optional)',
  '留空 = 不需要密码': 'Leave empty = no password',
  '自动生成': 'Generate',
  '我确认：链接会一直有效，直到手动撤销；照片会持续占用配额。':
    'I understand: this link stays active until revoked, and its photos keep using quota.',
  '标题（可选）': 'Title (optional)',
  '上传中…': 'Uploading…',
  '上传并生成链接': 'Upload and create link',
  '上传成功': 'Upload complete',
  '长期有效 · 直到你手动撤销': 'Active until you revoke it',
  '链接 {time} 失效': 'Link expires {time}',
  '复制链接': 'Copy link',
  '打开预览': 'Open preview',
  '再传一份': 'Upload another',
  '我的分享': 'My shares',
  '还没有分享。': 'No shares yet.',
  '未命名分享': 'Untitled share',
  '{time} 到期': 'Expires {time}',
  '打开 {views} 次 · 独立访客 {visitors} 人': '{views} opens · {visitors} unique visitors',
  '含秘密基地': 'Secret base',
  '有效': 'Active',
  '已撤销': 'Revoked',
  '已过期': 'Expired',
  '撤销': 'Revoke',
  '确认撤销': 'Confirm revoke',
  '预览': 'Preview',
  '选「不限时」前请确认：链接会一直有效，直到你手动撤销。':
    'Before choosing “No expiry”: the link stays active until you revoke it.',
  '长期有效': 'No expiry',
  '分享占用 {size} · {n} 份 · 被打开 {views} 次 · 独立访客 {visitors} 人':
    'Shares use {size} · {n} links · {views} opens · {visitors} unique visitors',
};

export default dict;
