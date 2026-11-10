import type { Dict } from '../index';

/**
 * 英文词条 · 设置域（T1 维护）：设置 → 备份与恢复 / 素材库 / 安全 / 天地图 Key / 回收站 / 关于，
 * 以及 `src/ui/BackupSection.tsx`。
 *
 * 写法：一行一条 `'中文原文': 'English',`，key 必须与代码里 t('…') 的中文逐字一致
 * （包括标点、空格、「」等）；插值占位符 {n} 等两边都要有。
 */
const dict: Dict = {
  // ── BackupSection：状态 / 提醒 ──
  '未知': 'Unknown',
  '{n} 天前': '{n} days ago',
  '无法连接后端服务（确认 npm run dev 正在运行）': 'Cannot reach the backend service (check that npm run dev is running)',
  '后端还没有备份接口（HTTP 404），请重启服务或更新到 M4 版本后再试': 'The backend does not have the backup API yet (HTTP 404). Restart the service or update to M4 and try again.',
  '未知错误': 'Unknown error',
  '读取备份状态…': 'Reading backup status…',
  '读取备份状态失败：': 'Failed to read backup status: ',
  '读取备份状态失败。': 'Failed to read backup status.',
  '上次备份': 'Last backup',
  '从未备份': 'Never backed up',
  '提醒阈值': 'Reminder threshold',
  '备份提醒阈值（天）': 'Backup reminder threshold (days)',
  '{n} 天': '{n} days',
  '超过这么久没备份就提醒': 'Remind me if there has been no backup for this long',
  '当前数据': 'Current data',
  '{places} 个地点 · {visits} 次到访 · {media} 张照片/视频': '{places} places · {visits} visits · {media} photos/videos',
  '（空库不会提醒备份）': ' (an empty library never triggers a backup reminder)',
  '还没有备份过：照片视频只有一份，数据丢了就找不回来，建议现在导出一份。':
    'No backup yet: the photos and videos exist only once, and lost data cannot be recovered. Export a backup now.',
  '已经 {days}没备份（阈值 {days2} 天），建议现在导出一份。': 'Last backup was {days} (threshold {days2} days) — export one now.',
  '稍后…': 'Snoozing…',
  '稍后提醒（24 小时）': 'Remind me in 24 hours',
  '已稍后提醒：24 小时内不再提示': 'Snoozed: no reminder for 24 hours',
  '稍后提醒失败：': 'Failed to snooze: ',
  '提醒阈值已改为 {n} 天': 'Reminder threshold set to {n} days',
  '修改提醒阈值失败：': 'Failed to change the reminder threshold: ',
  '最近自动备份：{name}（{size}）': 'Recent automatic backup: {name} ({size})',

  // ── BackupSection：导出 ──
  '导出备份': 'Export backup',
  '备份包：应用数据 + 缩略图 + 可选素材': 'Backup package: app data + thumbnails + optional media',
  '应用数据（必选）': 'App data (required)',
  '地点 / 到访 / 笔记 / 评分 / 回收站，备份的核心数据': 'Places / visits / notes / ratings / Trash — the core data of a backup',
  '缩略图 / 预览缓存': 'Thumbnails / preview cache',
  '默认包含；体积小，也可由素材库重建': 'Included by default; small, and can be rebuilt from the media library',
  '照片 / 视频素材': 'Photo / video media',
  '当前引用 {n} 个文件，约 {size}': 'Currently references {n} files, about {size}',
  '读取素材体积…': 'Reading media size…',
  '；会显著增大备份体积与打包时间，恢复时会写入当前素材库': '; significantly increases backup size and packaging time, and is written into the current media library on restore',
  '；默认不打包，恢复后需自己拷素材库': '; not included by default — copy the media library yourself after restoring',
  '含素材的备份会大很多：1.6GB 素材大约需要几分钟；恢复时会把素材写回当前素材库，同名同内容跳过、同名不同内容覆盖，不会删除其它文件。':
    'Backups with media are much larger: 1.6 GB of media takes a few minutes. Restoring writes the media back into the current media library: same name and content is skipped, same name with different content is overwritten, and no other files are deleted.',
  '正在准备…': 'Preparing…',
  '正在打包…': 'Packaging…',
  '恢复中，暂不能导出': 'Restoring — export unavailable',
  '备份打包进度': 'Backup packaging progress',
  '正在打包… {pct}%（{done} / {total} · 文件 {filesDone}/{filesTotal}）': 'Packaging… {pct}% ({done} / {total} · files {filesDone}/{filesTotal})',
  '取消中…': 'Canceling…',
  '正在准备导出…': 'Preparing the export…',
  '导出完成：备份包大小 {size}；文件名为「My旅迹素材备份-YYYY-MM-DD-（备份勿删）.zip」':
    'Export complete: backup size {size}; filename is "My Travel Backup-YYYY-MM-DD-(do not delete).zip"',
  '导出失败：': 'Export failed: ',
  '没有返回原因': 'no reason given',
  '导出已取消': 'Export canceled',
  '导出已取消（临时文件已清理）': 'Export canceled (temporary files cleaned up)',
  '读取导出进度失败：': 'Failed to read export progress: ',
  '开始导出失败：': 'Failed to start export: ',
  '取消导出失败：': 'Failed to cancel export: ',
  '如果浏览器没有自动开始下载，可': 'If the browser did not start downloading, ',
  '点这里重新下载': 'click here to download again',
  '（10 分钟内可以重新下载）。': '(you can download it again within 10 minutes).',
  '备份不会动你电脑上的原始文件。含素材时会逐个打包素材文件；恢复只写入 / 覆盖备份里的文件，不会删除素材库里的其它文件。':
    'Backups never touch the original files on your computer. With media, every media file is packaged individually; a restore only writes/overwrites files from the package and never deletes other files in the media library.',

  // ── BackupSection：从备份恢复 ──
  '从备份恢复': 'Restore from backup',
  '选择备份文件': 'Choose a backup file',
  '正在检查…': 'Checking…',
  '开始检查备份包': 'Inspect backup package',
  '取消选择': 'Clear selection',
  '导出进行中：完成后再从备份恢复（避免导出和恢复抢资源）。': 'Export in progress: restore after it finishes (so export and restore do not compete for resources).',
  '已选择：{name}': 'Selected: {name}',
  '（点「开始检查备份包」才会读取/校验，不会立刻改数据）': ' (data is only read/verified after clicking "Inspect backup package"; nothing is changed yet)',
  '正在校验备份包…（大文件可能要等一会儿）': 'Verifying the backup package… (large files may take a while)',
  '校验失败：': 'Verification failed: ',
  '备份包内容': 'Backup package contents',
  '备份时间': 'Backup time',
  ' · 版本 {v}': ' · version {v}',
  '数据量': 'Data',
  '（含回收站共 {places}/{visits}/{media}）': ' (including Trash: {places}/{visits}/{media})',
  '缩略图': 'Thumbnails',
  '包含 {n} 张': 'Includes {n}',
  '不含（恢复后按素材库重建）': 'Not included (rebuilt from the media library after restore)',
  '素材': 'Media',
  '{n} 个文件 / {size}': '{n} files / {size}',
  '不含素材（只恢复记录）': 'No media (records only)',
  ' · 导出时缺失 {n} 个': ' · {n} missing at export',
  '包含密码（恢复后沿用备份里的密码）': 'Includes the password (the password from the backup is used after restore)',
  '未设置密码（恢复后会清除当前密码）': 'No password set (restoring clears the current password)',
  '当前素材库缺 {n} 个素材文件：恢复后记录都在，但照片/视频要拷过来才能显示':
    'The current media library is missing {n} media files: records will be restored, but photos/videos only show after you copy them over',
  '素材齐全（0 个缺失）': 'All media files present (0 missing)',
  '缩略图缺失': 'Missing thumbnails',
  '{n} 张（打开时会按素材库重建）': '{n} (rebuilt from the media library when opened)',
  '从备份恢复…': 'Restore from backup…',
  '恢复会覆盖当前全部数据：': 'Restoring overwrites all current data: ',
  '地点、到访、笔记、媒体记录、秘密基地密码都会替换成备份里的内容。恢复前会自动备份当前数据；中途失败会回滚，当前数据保持原样。你电脑上的原始文件不会被删除。':
    'Places, visits, notes, media records and the secret spot password are all replaced with the contents of the backup. The current data is backed up automatically before restoring; a mid-way failure rolls back and leaves the current data untouched. The original files on your computer are never deleted.',
  '这是含素材的备份：恢复时会把 {n} 个素材文件写入当前素材库—— 同名同内容跳过、同名不同内容覆盖，': 'This backup includes media: restoring writes {n} media files into the current media library — same name and content is skipped, same name with different content is overwritten, ',
  '不会删除素材库里的其它文件': 'no other files in the media library are deleted',
  '恢复中…': 'Restoring…',
  '确认恢复': 'Confirm restore',
  '正在恢复': 'Restoring',
  '正在恢复…请不要关闭页面': 'Restoring… please do not close this page',
  '（已回滚，当前数据未被修改）': ' (rolled back; current data was not modified)',
  '恢复完成': 'Restore complete',
  '已恢复 {places} 个地点 · {visits} 次到访 · {media} 张照片/视频；地图和清单已刷新。': 'Restored {places} places · {visits} visits · {media} photos/videos; the map and lists are refreshed.',
  '恢复前已自动备份当前数据：': 'Current data was backed up automatically before restoring: ',
  '（{size}）': ' ({size})',
  '素材：写入 {written} 个 · 跳过 {skipped} 个（同名同内容）': 'Media: {written} written · {skipped} skipped (same name and content)',
  ' · 失败 {n} 个': ' · {n} failed',
  '素材库里有 {n} 个文件不被当前数据引用（可能来自旧数据或手工放置），已保留未删除；确认没用后可自行清理。': 'The media library has {n} files not referenced by current data (possibly from old data or placed manually). They were kept, not deleted; remove them yourself once you are sure they are unused.',
  '当前素材库还缺 {n} 个素材文件：记录已恢复，但对应照片/视频要等把素材库拷过来才能显示。':
    'The current media library is still missing {n} media files: records are restored, but the photos/videos only show once you copy the media library over.',
  '有 {n} 张缩略图缺失，打开照片墙时会按素材库重建。': '{n} thumbnails are missing; they are rebuilt from the media library when the photo wall opens.',
  '恢复只替换应用数据与缩略图缓存。不含素材的备份不写素材库；含素材的备份只写入 / 覆盖包内文件，不会删除素材库里的其它文件，也不会动你电脑上的原始文件。':
    'Restoring replaces only app data and the thumbnail cache. Backups without media never write to the media library; backups with media only write/overwrite files from the package, never delete other files in the media library, and never touch the original files on your computer.',

  // ── BackupSettings ──
  '备份只含应用数据（可选缩略图 / 照片视频素材）。恢复前会自动备份当前数据，中途失败会回滚；含素材的恢复只写入 / 覆盖备份里的文件，不删除素材库里的其它文件。':
    'A backup contains only app data (optional thumbnails / photo and video media). The current data is backed up automatically before a restore, and a mid-way failure rolls back; a restore with media only writes/overwrites files from the backup and never deletes other files in the media library.',

  // ── LibrarySettings ──
  // 2026-11-10（用户要求）：设置 → 素材库 展示支持上传的格式
  '支持上传的格式': 'Supported upload formats',
  '原始文件原样保存在素材库；缩略图和预览会自动生成，视频封面需要安装 ffmpeg。':
    'Original files are kept as-is in the media library. Thumbnails and previews are generated automatically; video posters require ffmpeg.',
  '相机 RAW（如 .nef）暂不支持，请先导出 JPG / TIFF 再上传。':
    'Camera RAW files (e.g. .nef) are not supported yet — export to JPG / TIFF first.',
  '读取失败：': 'Failed to read: ',
  '正在扫描素材库…': 'Scanning the media library…',
  '失败：': 'Failed: ',
  '扫描 {scanned} 个文件 · 重新关联 {matched} 个 · 仍缺失 {stillMissing} 个（{ms}ms）':
    'Scanned {scanned} files · relinked {matched} · still missing {stillMissing} ({ms}ms)',
  '切换路径…': 'Switching path…',
  '切换失败：': 'Switch failed: ',
  '素材库的位置。照片 / 视频上传时会把文件复制到素材库；缩略图、预览和播放都读素材库，你电脑上的原文件永远不动。切换路径时会把整个素材库同步到新位置。':
    'Location of the media library. On upload, photos/videos are copied into the media library; thumbnails, previews and playback all read from it, and the original files on your computer are never touched. Switching the path syncs the whole media library to the new location.',
  '多用户模式下素材库按账号独立：这里显示/修改的是你自己账号的素材库位置；切换路径会把你的素材同步过去，不影响其他账号。照片 / 视频上传时会把文件复制到素材库，缩略图、预览和播放都读素材库，你电脑上的原文件永远不动。':
    'In multi-user mode the media library is per-account: this page shows/changes your own account\'s location; switching it syncs your media over and does not affect other accounts. On upload, photos/videos are copied into the media library; thumbnails, previews and playback all read from it, and the original files on your computer are never touched.',
  '当前路径': 'Current path',
  '状态': 'Status',
  '{total} 个文件 · 丢失 ': '{total} files · missing ',
  ' 个': '',
  ' · 回收站 {n} 个': ' · {n} in Trash',
  ' · {n} 张缩略图待重建': ' · {n} thumbnails to rebuild',
  '重新关联（按文件名 → 大小 → 内容比对）': 'Relink (by name → size → content comparison)',
  '换电脑了？输入素材库的新路径': 'New PC? Enter the new media library path',
  '切换路径（自动同步素材）': 'Switch path (sync media automatically)',
  '切换路径时会把你自己账号的素材同步到新位置；换电脑后也可以先把素材库拷过去、再切换路径。':
    'Switching the path syncs your own account\'s media to the new location. When moving to a new PC you can also copy the media library over first, then switch the path.',
  '切换路径时会把整个素材库同步到新位置；换电脑也可以先把素材库文件夹拷到新机器，再切换路径并重新关联。': 'Switching the path syncs the whole media library to the new location. When moving to a new PC you can also copy the media library folder to the new machine first, then switch the path and relink.',
  '恢复默认路径': 'Restore default location',
  '没有需要同步的素材文件': 'No media files needed syncing',
  '已同步 {n} 个素材文件（{size}）': 'Synced {n} media files ({size})',
  '已切换素材库路径 · ': 'Media library path switched · ',
  '已恢复默认素材库位置 · ': 'Default media library location restored · ',
  '已在资源管理器中打开素材库文件夹（若没看到，请查看任务栏）': 'Opened the media library folder in File Explorer (check the taskbar if you do not see it)',
  '已在资源管理器中打开你的素材库文件夹（若没看到，请查看任务栏）': 'Opened your media library folder in File Explorer (check the taskbar if you do not see it)',
  '视频 · 封面帧': 'Video · Cover frame',
  '检测中…': 'Checking…',
  '已就绪：视频会生成封面帧和时长': 'Ready: videos get a cover frame and duration',
  '未检测到：视频仍能播放，但没有封面帧': 'Not detected: videos still play but have no cover frame',
  '安装视频封面组件后重启应用即可；不装也不影响视频播放。':
    'Install the video-cover component and restart the app; videos still play without it.',

  // ── LibrarySettings · 普通用户素材库信息（2026-11-07，D-211 / D-212 / D-213）──
  '我的素材': 'My media',
  '你的照片 / 视频保存在你账号专属的素材库里（按账号隔离，其他账号看不到也访问不到），按「省 / 市 / 区县 / 日期_地点名」归档。当前路径就是素材库在你电脑上的文件夹，可以直接打开，也可以换成别的文件夹（只影响你自己的账号）。':
    'Your photos / videos are stored in your account\'s own media library (isolated per account — other accounts cannot see or access it), organized by province / city / county / date_place. The current path is the media library folder on your computer — you can open it directly or switch it to another folder (affects your account only).',
  '提示：素材实际存放在这个文件夹下以你账号命名的子目录里；点「打开本地文件夹」会直接打开那个子目录。':
    'Note: the media actually lives in a subfolder named after your account inside this folder; "Open local folder" opens that subfolder directly.',
  '{photos} 张照片 · {videos} 段视频（共 {n} 个素材文件）':
    '{photos} photos · {videos} videos ({n} media files in total)',
  '说明': 'Notes',
  '视频封面、预览和缩略图会自动生成；上传只是把电脑里的文件复制一份到素材库，你电脑上的原文件不会被移动、修改或删除。':
    'Video covers, previews and thumbnails are generated automatically. Uploading only copies the file from your computer into the media library; the original files on your computer are never moved, modified or deleted.',
  '想完整带走素材：到「备份与恢复」里导出含素材的备份（也可以再恢复回来）。':
    'To take your media with you: export a backup that includes media from "Backup & restore" (you can restore it again later).',
  '素材库路径（仅你的账号）': 'Media library path (your account only)',
  '我的素材库路径、重新关联与用量': 'My media library path, relink and usage',
  '每个账号可以把自己素材库的存放位置切到自己的文件夹；切换只影响你自己的账号，其他账号的素材库不受影响。':
    'Each account can switch its own media library location to its own folder; the change only affects your account, other accounts are untouched.',
  '换电脑 / 想放到自己的文件夹？输入你的素材库新路径':
    'New PC / prefer your own folder? Enter your new media library path',
  '所选文件夹下会自动创建你的账号专属文件夹；切换时会自动把当前账号的素材同步到新位置。':
    'A folder for your account is created automatically under the chosen path; switching automatically syncs your account\'s media to the new location.',

  // ── SecuritySettings ──
  '读取秘密基地状态失败：': 'Failed to read secret spot status: ',
  '新密码不能为空': 'The new password cannot be empty',
  '新密码最多 128 位': 'The new password can be at most 128 characters',
  '两次输入的新密码不一致': 'The two new passwords do not match',
  '已设置密码：秘密基地已上锁': 'Password set: secret spots are now locked',
  '设置失败：': 'Failed to set the password: ',
  '请输入旧密码': 'Enter the old password',
  '密码已修改': 'Password changed',
  '修改失败：': 'Failed to change the password: ',
  '已重置密码：秘密基地不再上锁（地点标记和内容都保留）': 'Password reset: secret spots are no longer locked (markers and content are kept)',
  '重置失败：': 'Failed to reset the password: ',
  '秘密基地在地图上照常可见（只用紫罗兰色飞镖区分），点开详情需要密码。密码只保存在这台电脑上，不会上传。':
    'Secret spots stay visible on the map (only distinguished by the violet dart), and opening their details requires the password. The password is stored only on this computer and is never uploaded.',
  '读取中…': 'Loading…',
  '（初始密码为{v}）': '(initial password: {v})',
  '已设置密码 · {n} 个秘密基地': 'Password set · {n} secret spots',
  '未设置密码（秘密基地不会上锁）': 'No password set (secret spots are not locked)',
  ' · 已有 {n} 个地点标为秘密基地': ' · {n} places are already marked as secret spots',
  '修改密码需要旧密码。': 'Changing the password requires the old password.',
  '旧密码': 'Old password',
  '当前密码': 'Current password',
  '新密码（1–128 位）': 'New password (1–128 characters)',
  '新密码': 'New password',
  '确认新密码': 'Confirm new password',
  '再输一次新密码': 'Enter the new password again',
  '修改中…': 'Changing…',
  '修改密码': 'Change password',
  '重置秘密基地密码？': 'Reset the secret spot password?',
  '不需要旧密码；清掉之后秘密基地不再上锁，地点标记和照片都保留。': 'The old password is not needed. After resetting, secret spots are no longer locked; markers and photos are kept.',
  '重置中…': 'Resetting…',
  '确认重置': 'Confirm reset',
  '重置密码（忘记旧密码时用）': 'Reset password (use this if you forgot the old one)',
  '设置后，点开秘密基地的详情需要输入密码；地图上它们和普通地点只有飞镖颜色不同。': 'Once set, opening a secret spot requires the password; on the map they differ from ordinary places only by dart colour.',
  '设置密码': 'Set password',
  '确认密码': 'Confirm password',
  '再输一次': 'Enter it again',
  '设置中…': 'Setting…',
  '密码只保存在这台电脑上，不会上传，也不会显示在任何地方。【本地版应用的秘密基地密码其实是个摆设，忘记了就直接重置就行~~】':
    'The password is stored only on this computer; it is never uploaded or displayed anywhere. [Note: in the local version the secret-spot password is really just a soft screen — if you forget it, simply reset it.]',
  // ── D-332（用户选择方案 B）：云端版秘密基地用登录账号密码解锁 ──
  '云端版用登录账号密码解锁：打开秘密基地详情前需要重新输入你的登录账号密码；忘记登录密码时请联系管理员重置。':
    'In the cloud version, secret spots are unlocked with your login password: re-enter your account password before opening the details. If you forgot your login password, ask the administrator to reset it.',
  '已用登录密码保护 · {n} 个秘密基地':
    'Protected by your login password · {n} secret spot(s)',
  '还没有秘密基地': 'No secret spots yet',
  '秘密基地内容不加密，仅防止他人临时使用你已登录的浏览器时直接查看。':
    'Secret-spot content is not encrypted; this only stops someone casually using your already-signed-in browser from opening it directly.',

  // ── 图标配色（D-161 / D-164：家 + 去过 / 想去 / 秘密基地 共用一条十二色相条）──
  '图标配色': 'Icon colors',
  '选择要配色的图标': 'Icon to color',
  '色相条': 'Hue strip',
  '正在改：{name} · {color}': 'Editing: {name} · {color}',
  '恢复默认颜色': 'Reset to default color',
  '先点一种图标，再点下面色条里的颜色；「恢复默认颜色」回到每种图标的默认色；只改地图、聚合点和列表里的图标颜色。':
    'Pick an icon type first, then click a color in the strip below. “Reset to default color” restores that icon’s default. Changes only the icon colors on the map, clusters and lists.',
  '红': 'Red',
  '橙': 'Orange',
  '黄': 'Yellow',
  '黄绿': 'Lime',
  '绿': 'Green',
  '青绿': 'Teal',
  '青': 'Cyan',
  '天蓝': 'Sky blue',
  '靛蓝': 'Indigo',
  '紫罗兰': 'Violet',
  '品红': 'Magenta',
  '珊瑚红': 'Coral',

  // ── TdtSettings ──
  '读取 Key 状态失败：': 'Failed to read key status: ',
  '天地图 Key 必须是 32 位字母或数字': 'The Tianditu key must be 32 letters or digits',
  '已保存 · 刷新页面后地图使用新 Key': 'Saved · the map uses the new key after a page refresh',
  '保存失败：': 'Save failed: ',
  'Key 配置': 'Key configuration',
  '状态未知': 'Unknown',
  '读取中': 'Loading',
  '已配置': 'Configured',
  '未配置': 'Not configured',
  '已配置（输入新 Key 可替换）。修改后需要刷新页面，地图才会使用新 Key。': 'Configured (enter a new key to replace it). Refresh the page after changing it so the map uses the new key.',
  '当前未配置，地图无法加载。请粘贴在天地图控制台申请的 32 位 Key。': 'Not configured yet, so the map cannot load. Paste the 32-character key from the Tianditu console.',
  '无法读取 Key 状态；仍可以直接粘贴新 Key 保存。': 'Cannot read key status; you can still paste and save a new key.',
  '正在读取 Key 状态…': 'Reading key status…',
  '粘贴 32 位天地图 Key': 'Paste the 32-character Tianditu key',
  '保存 Key': 'Save key',
  '立即刷新': 'Refresh now',
  '刷新后地图使用新 Key。': 'The map uses the new key after a refresh.',
  '申请地址：': 'Apply at: ',
  '免费额度说明': 'Free quota',
  '为了尽量用上天地图的免费额度（让这个应用保持免费可用），建议你自己申请一个天地图 Key；个人使用目前是免费的。':
    'To make the most of Tianditu’s free quota (and keep this app free to use), we recommend applying for your own Tianditu key — it is currently free for personal use.',
  '免费 Key 每天有调用次数限制：只要不是频繁、长时间地使用地图（大量搜索、反复拖动、批量逆地理），日常记录完全够用；万一当天额度用完，地图可能暂时加载不出来，第二天额度重置后就恢复，已记录的数据不受影响。':
    'Free keys have a daily call limit. As long as you don’t use the map heavily (lots of searches, repeated panning, bulk reverse geocoding), everyday use is plenty. If the daily quota runs out, the map may temporarily fail to load and recovers after the reset — your recorded data is unaffected.',
  '素材与数据流转': 'How media is stored',
  '从电脑本地选择照片 / 视频上传时，应用会把原件复制一份到素材库 B，并按「省 / 市 / 区县 / 日期_地点名」的文件夹结构存放（例如 浙江省/杭州市/西湖区/2024-03-10_西湖/），方便在资源管理器里按地区和日期翻看。':
    'When you upload photos/videos from your computer, the app copies the originals into media library B and stores them under province / city / district / date_place folders (e.g. Zhejiang/Hangzhou/Xihu/2024-03-10_West Lake), so you can browse them by region in File Explorer.',
  '上传时你电脑上的原始文件不会被移动或修改，素材库会另存一份副本，上传前请确认磁盘空间足够。备份 / 恢复只涉及应用数据和素材库里的副本。':
    'Uploading never moves or modifies the original files on your computer — the media library keeps a copy, so make sure you have enough disk space. Backup/restore only touches app data and the copies in the media library.',

  // ── TrashSettings ──
  '删除的地点 / 到访 / 照片视频先放在这里，不会立刻释放空间；「彻底删除」（单条 / 所选 / 清空）才会真正删除并释放空间。你电脑上的原文件不会被删除。':
    'Deleted places / visits / photos and videos wait here and do not free space immediately; only Delete permanently (single / selected / empty Trash) actually deletes them and frees space. The original files on your computer are never touched.',

  // ── AboutSettings ──
  '读取运行状态失败：': 'Failed to read runtime status: ',
  'Tread Horizon 本地旅行足迹': 'Tread Horizon · Local travel map',
  '本地运行 · 无账号 · 无云': 'Runs locally · No account · No cloud',
  '一个纯本地的个人旅行足迹地图：数据保存在本机，照片 / 视频放在本地素材库，地图使用天地图。':
    'A purely local personal travel-footprint map: data stays on this computer, photos/videos live in the local media library, and the map uses Tianditu.',
  '地点': 'Places',
  '到访': 'Visits',
  '照片': 'Photos',
  '视频': 'Videos',
  '应用版本': 'App version',
  '运行模式': 'Run mode',
  '开发模式': 'Development mode',
  '正式模式': 'Production mode',
  '数据位置': 'Data location',
  '素材库位置': 'Media library location',
  '天地图 key': 'Tianditu key',
  '未配置（地图可能加载不出来）': 'Not configured (the map may fail to load)',
  '视频封面生成': 'Video cover generation',
  '可用': 'Available',
  '不可用（视频仍可播放）': 'Unavailable (videos still play)',
  '数据文件说明': 'Data files',
  '、': ', ',
  '缩略图缓存': 'Thumbnail cache',
  '恢复前自动备份': 'Auto backup before restore',

  // ── 设置 → 账号 / 邀请码（M6 P2-1，D-200）──
  '账号': 'Account',
  '账号信息与登录密码': 'Account info and sign-in password',
  '账号信息': 'Account info',
  '多用户模式下每个账号的数据完全独立；账号由管理员通过邀请码创建。':
    'In multi-user mode every account\'s data is fully isolated; accounts are created by the admin through invite codes.',
  '显示名': 'Display name',
  '角色': 'Role',
  '管理员': 'Admin',
  '普通用户': 'User',
  '加入时间': 'Joined',
  '最近登录': 'Last sign-in',
  '修改登录密码': 'Change sign-in password',
  '修改后请用新密码登录；密码会加密保存，任何人都看不到原文。':
    'Use the new password next time. Passwords are stored encrypted; nobody can see the original.',
  '新密码（至少 8 位）': 'New password (at least 8 characters)',
  '新密码至少 8 位': 'The new password must be at least 8 characters',
  '邀请码管理': 'Invite codes',
  '仅管理员': 'Admin only',
  '邀请码一次性使用、可设有效期；生成后只显示一次明文，请复制发给朋友。':
    'Invite codes are single-use and can expire. The plaintext is shown only once right after creation — copy it and send it to your friend.',
  '有效期（天）': 'Valid for (days)',
  '备注（可选）': 'Note (optional)',
  '例如：给小王': 'e.g. for Xiao Wang',
  '生成中…': 'Creating…',
  '生成邀请码': 'Create invite code',
  '新邀请码（只显示这一次）': 'New invite code (shown only once)',
  '已复制': 'Copied',
  '复制': 'Copy',
  '完成': 'Done',
  '还没有生成过邀请码。': 'No invite codes yet.',
  '已使用': 'Used',
  '已过期': 'Expired',
  '未使用': 'Unused',
  '创建 {created} · 到期 {expires}': 'Created {created} · expires {expires}',
  '使用人：{name}': 'Used by: {name}',
  '作废中…': 'Revoking…',
  '作废': 'Revoke',
  '退出登录': 'Sign out',
  '退出后需要重新输入用户名和密码；不会删除任何数据。':
    'You will need to enter your username and password again; no data is deleted.',
  '退出中…': 'Signing out…',

  // ── 设置 → 账号用量 / 用户管理 / 用户数据导出（M6 P2-3，D-204；D-209 去掉配额）──
  '存储用量': 'Storage usage',
  '已用空间': 'Used space',
  '只做统计，不限制上传': 'Statistics only — uploads are not limited',
  '{places} 个地点 · {visits} 次到访 · {photos} 张照片 · {videos} 段视频':
    '{places} places · {visits} visits · {photos} photos · {videos} videos',
  '管理员备份包含服务器上所有账号的数据（可选缩略图 / 素材）。恢复会覆盖整个服务器的数据，请先确认。':
    'The admin backup contains every account\'s data on the server (optional thumbnails / media). Restoring replaces all server data — please confirm first.',
  '导出我的数据': 'Export my data',
  '导出只包含你自己的账号数据（地点 / 到访 / 笔记 / 媒体记录，可选缩略图，可选照片视频文件），不会包含其他账号的数据。这个备份可以在下面「从我的备份恢复」里恢复回你自己的账号。':
    'The export contains only your own account data (places / visits / notes / media records, optional thumbnails, optional photo and video files) and never other accounts\' data. You can restore this backup into your own account with "Restore from my backup" below.',
  '从我的备份恢复': 'Restore from my backup',
  '选择你之前用「导出我的数据」下载的备份文件，检查通过后可以把地点 / 到访 / 照片视频记录恢复回当前账号。恢复会替换当前账号的全部数据（其他账号不受影响）；恢复前会自动导出当前数据作为备份。秘密基地密码和天地图 Key 不随导出恢复，需要的话恢复后请重新设置。':
    'Choose a backup file previously downloaded via "Export my data". After the check passes you can restore the places / visits / photo and video records back into your own account. Restoring replaces ALL data of your account (other accounts are untouched); the current data is exported automatically as a backup first. The secret-base password and Tianditu key are not part of the export — re-enter them in Settings if needed.',
  '检查失败：': 'Check failed: ',
  '导出时间': 'Exported at',
  '包含 {n} 个文件': '{n} files included',
  '不含（只恢复记录）': 'Not included (records only)',
  '缺 {n} 个素材文件': '{n} media files missing',
  '包含「家」设置（恢复后会跟着回来）': 'Includes the "Home" setting (it will be restored too)',
  '秘密基地密码 / 天地图 Key 不随导出恢复，需要的话请在设置里重新填写。':
    'The secret-base password and Tianditu key are not part of the export; re-enter them in Settings if needed.',
  '恢复会替换当前账号的全部数据，确定继续？':
    'Restoring will replace all data of your account. Continue?',
  '确认恢复（覆盖当前账号数据）': 'Restore now (replace my data)',
  '恢复失败：': 'Restore failed: ',
  '已恢复 {places} 个地点 / {visits} 次到访 / {media} 个媒体；恢复前自动备份：{name}':
    'Restored {places} places / {visits} visits / {media} media files; pre-restore backup: {name}',
  '恢复只替换你自己的账号数据；其他账号不受影响。恢复前会自动备份当前数据，恢复后如需回退可以用它再恢复一次。':
    'Restore only replaces your own account data; other accounts are untouched. The current data is backed up automatically before restoring; you can restore it again to roll back.',
  '包含缩略图 / 预览（推荐，体积小）': 'Include thumbnails / previews (recommended, small)',
  '包含照片 / 视频文件（体积可能很大）': 'Include photo / video files (may be large)',
  '下载导出包': 'Download export package',
  '文件包含应用数据、说明文件，以及可选的缩略图与素材；素材多时打包会久一点。':
    'The package contains app data, a readme, and optional thumbnails and media; packing takes longer with many media files.',
  '用户管理': 'User management',
  '账号、状态、已用空间、重置密码与邀请码': 'Accounts, status, used space, password resets and invite codes',
  '操作': 'Actions',
  '加入': 'Joined',
  '正常': 'Active',
  '已禁用': 'Disabled',
  '我': 'Me',
  '保存中…': 'Saving…',
  '重置密码': 'Reset password',
  '禁用': 'Disable',
  '启用': 'Enable',
  '不能禁用自己': 'You cannot disable your own account',
  '已禁用账号 {name}': 'Account {name} disabled',
  '已启用账号 {name}': 'Account {name} enabled',
  '已重置 {name} 的登录密码': 'Sign-in password reset for {name}',
  '重置后请把新密码告诉对方；不会退出对方已登录的会话。':
    'Tell the other person the new password afterwards; their signed-in sessions will not be signed out.',
  '只有管理员可以管理账号。': 'Only admins can manage accounts.',

  // ── 云端存储配额 + 扩容申请（2026-11-08 D-310，用户要求：默认 1 GB，可申请扩容）──
  '云端配额': 'Cloud quota',
  '云端版每个账号有独立存储配额（默认 1 GB）；回收站里还没彻底删除的素材也占用配额。空间用满后新的上传会被拒绝，可以删除不需要的素材或申请扩容。':
    'Each account has its own storage quota in cloud mode (1 GB by default); items still in Trash also count. When the quota is full, new uploads are rejected — delete unneeded media or request more space.',
  '已用 {used} / 上限 {quota}': 'Used {used} / quota {quota}',
  '空间已满：新的上传会被拒绝。请删除不需要的素材（回收站里的要彻底删除），或在下面申请扩容。':
    'Storage full: new uploads are rejected. Delete unneeded media (purge Trash to free space), or request more space below.',
  '扩容申请：待管理员审批': 'More space requested — awaiting admin approval',
  '申请将配额提高到 {size}': 'Quota requested: {size}',
  '取消申请': 'Cancel request',
  '申请扩容': 'Request more space',
  '希望的新配额（GB）': 'Requested new quota (GB)',
  '理由（可选）': 'Reason (optional)',
  '例如：旅行照片和视频比较多': 'e.g. lots of travel photos and videos',
  '提交申请': 'Submit request',
  '提交中…': 'Submitting…',
  '已提交扩容申请，等待管理员审批': 'Request submitted — waiting for admin approval',
  '请输入大于 0 的数字': 'Please enter a number greater than 0',
  '申请的空间必须大于当前配额（{size}）': 'The requested space must be larger than the current quota ({size})',
  '扩容申请已取消': 'Quota request cancelled',
  '申请记录': 'Request history',
  '待审批': 'Pending',
  '已批准': 'Approved',
  '已拒绝': 'Rejected',
  '已取消': 'Cancelled',
  '已超额': 'Over quota',
  '调整配额': 'Adjust quota',
  '配额（GB）': 'Quota (GB)',
  '保存配额': 'Save quota',
  '配额至少 1 GB': 'The quota must be at least 1 GB',
  '已把 {name} 的配额调整为 {size}': 'Quota for {name} set to {size}',
  '配额以 GB 为单位（整数）；回收站里还没彻底删除的素材也计入占用。':
    'Quota is in whole GB; media still in Trash also counts toward usage.',
  '已批准扩容到 {size}': 'Approved — quota raised to {size}',
  '已拒绝该扩容申请': 'The quota request was rejected',
  '扩容申请': 'Quota requests',
  '{n} 条待审批': '{n} pending',
  '暂无待审批': 'None pending',
  '用户空间用满后可以在「设置 → 账号」提交扩容申请；批准后按申请值提高配额。如需其它额度，可在上方账号列表里直接调整。':
    'Users can request more space under Settings → Account when their quota is full; approving raises the quota to the requested amount. To grant a different amount, adjust the quota directly in the account list above.',
  '暂无待审批的扩容申请。': 'No pending quota requests.',
  '申请将配额从 {current} 提高到 {requested}': 'Requests quota raised from {current} to {requested}',
  '理由：': 'Reason: ',
  '申请时间：': 'Requested at: ',
  '批准提高到 {size}': 'Approve — raise to {size}',
  '处理中…': 'Processing…',
  '拒绝': 'Reject',
  '每个账号的数据完全隔离；新用户通过下方「邀请码管理」生成的邀请码注册。这里可以禁用账号、重置登录密码、查看 / 调整各账号的存储配额，并审批扩容申请。':
    'Every account\'s data is fully isolated; new users sign up with invite codes generated in "Invite codes" below. Here you can disable accounts, reset sign-in passwords, view / adjust each account\'s storage quota and approve quota requests.',

  // ── 设置 → 关于（多用户角色分层，M6 P2-4，D-205）──
  'Tread Horizon': 'Tread Horizon',
  '云端多用户 · 数据按账号隔离': 'Cloud multi-user · data isolated per account',
  '数据保存在服务器上，每个账号的数据完全隔离、互不可见；照片 / 视频在服务器素材库，地图用天地图（每个账号用自己的 Key）。':
    'Data is stored on the server and fully isolated per account. Photos / videos live in the server media library, and the map uses Tianditu (each account uses its own key).',
  '我的地点': 'My places',
  '我的到访': 'My visits',
  '我的照片': 'My photos',
  '我的视频': 'My videos',
  '已配置（你账号自己的 Key）': 'Configured (your own account key)',
  '未配置：请到 设置 → 天地图 Key 填写（每个账号一份）':
    'Not configured: fill it under Settings → Tianditu key (one per account)',
  '数据备份': 'Data backup',
  '管理员可在「备份与恢复」里导出全量备份 / 恢复；普通用户可在那里导出自己的数据。':
    'The admin can export a full backup / restore under "Backup & Restore"; regular users can export their own data there.',
  '可在 设置 → 备份与恢复 里导出「我的数据」；需要恢复数据请联系管理员。':
    'You can export "My data" under Settings → Backup & Restore; contact the admin if you need to restore data.',
  '服务器信息（仅管理员可见）': 'Server info (admin only)',
  '全局数据量（所有账号）': 'Global data (all accounts)',
  '数据与备份说明（云端）': 'Data and backups (cloud)',
  '云端数据按账号隔离保存在服务器上，请不要直接在服务器上修改。备份与恢复由管理员处理，普通用户请使用「导出我的数据」。':
    'In cloud mode data is isolated per account on the server; do not edit it on the server. Backups and restores are handled by the admin; regular users should use "Export my data".',
  '换电脑 / 换浏览器不需要迁移数据：用同一个账号登录即可；界面偏好（主题 / 字体等）只存本机浏览器。':
    'Moving to a new PC / browser needs no data migration: just sign in with the same account. Interface preferences (theme / font, etc.) are stored only in the local browser.',
  '。Key 只保存在你自己的账号设置里，其他账号看不到；请不要把 Key 发到聊天或截图里。':
    'The key is stored only in your own account settings; no other account can see it. Please do not send the key in chats or screenshots.',

  // ── 设置 → 账号 → 头像（2026-11-07，D-224）──
  '头像': 'Avatar',
  '头像会显示在顶栏「+ 添加足迹」上方；点击下方头像或按钮上传 / 更换，上传后顶栏立即更新。':
    'The avatar is shown above the "+ Add footprint" button in the top bar; click the avatar or the button below to upload / change it — the top bar updates immediately.',
  '上传中…': 'Uploading…',
  '上传 / 更换头像': 'Upload / change avatar',
  '支持 JPG / PNG / WebP / GIF / AVIF，≤10MB；会自动裁成 128×128 的方形头像。没上传时用「去过」标记做默认头像（透明底）。':
    'Supports JPG / PNG / WebP / GIF / AVIF up to 10 MB; it is cropped to a 128×128 square. Until you upload one, the "visited" marker is used as the default avatar (transparent background).',
  '修改': 'Edit',
  '显示名称不能为空': 'Display name cannot be empty',
  '显示名称最多 40 个字': 'Display name can be at most 40 characters',
  '已保存': 'Saved',
  '。Key 只保存在这台电脑上；请不要把 Key 发到聊天或截图里。':
    'The key is stored only on this computer; please do not send it in chats or screenshots.',
  '数据说明': 'About your data',
  '旅行记录、到访、照片信息和应用设置都保存在本机数据目录里；缩略图等预览文件可以自动重建，不算正式数据。建议定期备份，恢复前应用也会自动保留最近的备份。':
    'Places, visits, photo info and app settings are stored in the local data folder; thumbnails and other previews can be rebuilt automatically and are not counted as real data. Back up regularly — the app also keeps a recent backup automatically before each restore.',
  '换电脑：把数据目录和素材库拷到新电脑，或使用「备份与恢复」里的完整备份（含素材）一次性带走。':
    'Moving to a new PC: copy the data folder and the media library, or take a full backup (with media) from "Backup & restore" in one go.',
  '确认程序已启动后刷新页面；如果仍然失败，请重新启动应用。':
    'Make sure the app is running and refresh the page; if it still fails, restart the app.',
  '请到 设置 → 天地图 Key 检查 Key 是否正确，并确认网络能访问天地图。':
    'Check the key under Settings → Tianditu key, and make sure the network can reach Tianditu.',

  '视频封面组件': 'Video cover component',

  '应用更新': 'App updates',
  '正在检查更新…': 'Checking for updates…',
  '发现新版本 {v}': 'New version {v} available',
  '查看更新': 'View update',
  '已是最新版本': 'Up to date',
  '无法检查更新（不影响使用）': 'Could not check for updates (the app still works)',
  '再检查一次': 'Check again',
  '不再提醒这个版本': 'Do not remind me about this version',
  '已忽略此版本提醒': 'Reminder for this version is off',
  '恢复提醒': 'Turn reminder back on',
  '升级前确认': 'Confirm before upgrading',
  '前往查看': 'Go and view',
  '升级需要关闭并重新启动程序；如果正在上传文件，升级会导致上传中断、失败，需要重新上传。建议先确认上传队列为空，并做好备份。':
    'Upgrading requires closing and restarting the app. If files are uploading right now, the upgrade will interrupt them and they will need to be uploaded again. Make sure the upload queue is empty and back up your data first.',

  // ── 2026-11-10 D-350（用户要求）：上传队列拆到「设置 → 上传」──
  '上传': 'Uploads',
  '上传队列、进度与失败重试': 'Upload queue, progress and retries',
  '在设置中查看': 'View in Settings',
  '正在上传 · 共 {total} 个 · 已完成 {done} 个':
    'Uploading · {total} files · {done} done',
  '上传结束 · 共 {total} 个 · 已完成 {done} 个':
    'Upload finished · {total} files · {done} done',
  '有 {n} 个文件上传失败': '{n} file(s) failed to upload',
  '设置 · {text}': 'Settings · {text}',
  '上传在后台继续，切换地点或关掉设置都不会中断。':
    'Uploads keep running in the background; switching places or closing Settings will not interrupt them.',
  '现在没有上传任务': 'No uploads right now',
  '在到访里添加素材（或把照片 / 文件夹拖进地点侧栏）后，上传进度和失败重试会显示在这里。':
    'Add media inside a visit (or drag photos / folders into the place sidebar); upload progress and retries will appear here.',
  '未知地点': 'Unknown place',
  '未标注日期': 'No date',
  '共 {n} 个 · 已完成 {done} 个': '{n} files · {done} done',
  '关闭队列': 'Close queue',

  // ── 2026-11-10 D-355（用户要求）：设置 → 素材库 → 重复照片检测 ──
  '重复照片检测': 'Duplicate detection',
  '扫描中…': 'Scanning…',
  '重新扫描': 'Scan again',
  '按内容查重（文件字节完全一致）：同一张照片 / 视频被上传到多个到访、或重复导入时，会归到同一组。默认每组保留最早添加的一份，勾选其余副本后可以移到回收站（可恢复，不会直接删除文件）；彻底删除才会释放磁盘空间。':
    'Duplicates are matched by content (byte-identical files): the same photo / video uploaded to several visits, or imported twice, is grouped together. The earliest copy is kept by default; select the other copies to move them to the Trash (recoverable — files are not deleted right away). Space is only freed after permanent deletion.',
  '没有发现重复素材。': 'No duplicates found.',
  '发现 {groups} 组重复 · 多出 {extra} 份 · 彻底删除后最多可释放约 {size}':
    '{groups} duplicate groups · {extra} extra copies · up to {size} can be freed after permanent deletion',
  '当前勾选 {n} 份（约 {size}）': '{n} selected ({size})',
  '重复内容 · {n} 份 · 每份约 {size}': 'Same content · {n} copies · about {size} each',
  '保留最早一份': 'Keep earliest one',
  '最早添加': 'Added first',
  '添加于 {time}': 'Added {time}',
  '把所选 {n} 份移到回收站': 'Move {n} selected copies to Trash',
  '每组至少保留一份；清理后可在 设置 → 回收站 恢复。':
    'At least one copy per group is always kept; you can restore them from Settings → Trash.',
  '把所选 {n} 份重复素材移到回收站？': 'Move the {n} selected duplicate copies to Trash?',
  '所选中包含 {n} 个文件，约 {size}。': 'Selection contains {n} files, about {size}.',
  '每组至少保留一份；移到回收站后可在 设置 → 回收站 恢复，彻底删除后才会真正释放磁盘空间。你电脑上的原文件不受影响。':
    'At least one copy per group is kept. Moved copies can be restored from Settings → Trash; disk space is only freed after permanent deletion. The original files on your computer are not affected.',
  '已把 {n} 份重复素材移到回收站（可在回收站恢复；彻底删除后约释放 {size}）':
    'Moved {n} duplicate copies to Trash (restorable from Trash; permanent deletion frees about {size})',
  ' · {n} 组因为勾选了全部副本，已自动保留每组最早的一份':
    ' · {n} group(s) had all copies selected, so the earliest copy was kept automatically',
  '扫描失败：{msg}': 'Scan failed: {msg}',
  '清理失败：{msg}': 'Cleanup failed: {msg}',
  // D-355 追加：重复组太多时默认折叠 + 分页加载
  '已显示 {shown}/{total} 组': 'Showing {shown}/{total} groups',
  '加载更多（还有 {n} 组）': 'Load more ({n} groups left)',
  '选中本组多余副本（保留最早一份）':
    'Select this group’s extra copies (keep the earliest one)',
  '取消本组多余副本的选择': 'Deselect this group’s extra copies',
};

export default dict;
