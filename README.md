<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/readme/tread-horizon-logo-dark.png">
    <img src="assets/readme/tread-horizon-logo-light.png" width="620" alt="Tread Horizon · 脚步丈量世界">
  </picture>
</p>

# Tread Horizon · 脚步丈量世界

把去过的地方、看过的风景、拍下的照片和视频，钉在地图上。多年以后打开，就是一张**只属于你自己的旅行足迹地图**。

- **纯本地运行**：数据存在自己电脑里，不需要账号，也不会上传云端
- **地图用天地图**：需要自己申请一个免费 Key，申请一次、填进去就能用

<p align="center"><img src="assets/readme/00-welcome.gif" width="900" alt="Tread Horizon 启动欢迎页（Q 版中国地图 / 34 省景点 / 开始记录我的旅迹）"></p>

<p align="center"><img src="assets/readme/01-demo.gif" width="900" alt="Tread Horizon 功能演示（地图 / My旅迹 / 照片墙 / 统计 / 设置）"></p>


![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![Node.js >= 22.13](https://img.shields.io/badge/Node.js-%E2%89%A5%2022.13-339933.svg)
![Local-first](https://img.shields.io/badge/local--first-%E6%95%B0%E6%8D%AE%E4%B8%8D%E4%B8%8A%E4%BA%91-success.svg)

> 仓库地址：<https://github.com/BruceLi007/TreadHorizon> · 许可：[MIT](LICENSE)

---

## 能做什么

<p align="center"><img src="assets/readme/v2/00-overview.webp" width="900" alt="Tread Horizon 主界面：地图上的足迹总览"></p>


### 在地图上打点，记录足迹

- **搜索打点**：搜地名 → 地图飞过去 → 落下足迹；也可以直接在地图上点选位置，拖动飞镖微调

<p align="center"><img src="assets/readme/v2/02-search-and-add.webp" width="900" alt="搜地名打点：确认足迹（地址 / 坐标 / 日期 / 类型）"></p>


- **四种标记**：去过（绿）、想去（红）、家（小房子）、秘密基地（紫，打开详情需要密码）；**标记会动**：静置时轻轻呼吸，悬停会轻跳，点击时压扁回弹并在地面荡开一圈涟漪；**自动聚合**：地点多的时候，地图上会按类型抱成一簇，点一下展开该区域的地点列表

<p align="center"><img src="assets/readme/v2/03-map-markers.webp" width="900" alt="地图上的四种标记：去过 / 想去 / 家 / 秘密基地"></p>
<p align="center"><img src="assets/readme/v2/04-marker-cluster.webp" width="900" alt="地点自动聚合：点开一簇查看地点列表"></p>
<p align="center"><img src="assets/readme/v2/05-secret-base.webp" width="900" alt="秘密基地：输入密码才能查看详情"></p>


- **家**：地图上唯一一个「家」标记，不参与聚合，点顶栏「家」一键飞回去

<p align="center"><img src="assets/readme/v2/06-home.webp" width="900" alt="顶栏「家」一键飞回家"></p>


- **不会点歪**：地图缩得太远时不允许打点；暂不支持记录国外坐标

### 照片和视频，一次传好

- **记录结构**：地点 → 到访（日期 / 标题 / 笔记 / 评分 / 同行人）→ 照片、视频；**上传省心**：拖进侧栏或点选即可，支持批量；每个文件显示进度，可取消，失败能重试；**大文件也能传**：单个文件默认上限 8GB（`.env.local` 里可用 `MAX_UPLOAD_GB` 调整）；**自动查重**：同一张图再传一次会跳过，不重复占空间；**视频也有封面**：自动截取封面帧并显示时长（装好 ffmpeg 才有；没装视频照样能播放）；**iPhone 的 HEIC / HEIF 照片直接传**：服务端自动转码生成缩略图与灯箱预览，原始 `.heic` 文件仍原样保存在素材库（点「查看原图」时浏览器本身不能直接渲染 HEIC，属浏览器限制）

<p align="center"><img src="assets/readme/v2/07-visit-detail.webp" width="900" alt="到访详情：日期 / 标题 / 同行人 / 照片"></p>
<p align="center"><img src="assets/readme/v2/08-upload-queue.webp" width="900" alt="上传队列：逐文件进度 / 完成状态"></p>

- **拖文件夹上传**：把整个文件夹拖进侧栏 → 自动按文件夹名新建一次到访，并批量上传里面的图片 / 视频（日期默认今天，之后可编辑）

- **归档整齐**：上传时复制一份到素材库，按「省 / 市 / 区县 / 日期_地点名」自动分好文件夹；电脑里的原片不会被移动

<p align="center"><img src="assets/readme/v2/09-archive-library.webp" width="900" alt="素材库：按「省 / 市 / 区县 / 日期_地点名」自动归档"></p>


### 看照片的体验

- **相册网格**：地点侧栏的照片每行可切换 2 / 3 / 4 / 5 张

<p align="center"><img src="assets/readme/v2/10-photo-grid.webp" width="900" alt="相册网格：地点照片每行可切换 2 / 3 / 4 / 5 张"></p>

- **灯箱**：左右翻页、缩放，底部有一条缩略图胶片带——点一下就切，翻页时会自动滚到当前那张

<p align="center"><img src="assets/readme/v2/11-lightbox.webp" width="900" alt="灯箱：大图预览 + 底部缩略图胶片带"></p>

- **照片墙**：全屏按年份浏览、无限滚动、年份快捷筛选，每行可切 4 / 6 / 8 / 10 张

<p align="center"><img src="assets/readme/v2/12-photo-wall.webp" width="900" alt="照片墙：按年份 → 月份浏览全部照片"></p>

- **双向跳转**：照片墙里点「在地图中查看」直接飞到对应地点；地点灯箱里也能跳回照片墙定位

<p align="center"><img src="assets/readme/v2/13-photo-wall-jump.webp" width="900" alt="照片墙「在地图中查看」直达对应地点"></p>

- **可调大小**：照片墙窗口右下角可以拖动缩放，会记住上次的大小

<p align="center"><img src="assets/readme/v2/14-photo-wall-resize.webp" width="900" alt="照片墙窗口可拖动缩放"></p>


### My旅迹：所有去过 / 想去的地方

- **树形整理**：「去过」按 省 → 市 → 地点 分组，地点行显示次数、照片数、视频数、最近到访时间

<p align="center"><img src="assets/readme/v2/15-my-trail-visited.webp" width="900" alt="My旅迹：按省 → 市 → 地点整理的「去过」"></p>

- **想去清单**：想以后去的地方单独一份，可以随时「转为去过」

<p align="center"><img src="assets/readme/v2/16-my-trail-wishlist.webp" width="900" alt="My旅迹：想去清单（可转为去过）"></p>

- **一键展开 / 收起**、按最近 / 最早到访排序、按名称或省市搜索；**和时间轴联动**：框选一段时间后，My旅迹会显示「这段时间去过几次 · 共几次」


### 时间轴：看「什么时候去过哪」

- **双手柄框选**：拖动底部时间轴的两个手柄，地图、清单、统计一起跟着变

<p align="center"><img src="assets/readme/v2/17-timeline-range.webp" width="900" alt="时间轴：双手柄框选时间范围"></p>

- **自动回放**：按 天 / 周 / 月 / 季度 / 年 步长播放足迹动画；也可以 `‹` `›` 手动步进

<p align="center"><img src="assets/readme/v2/18-timeline-play.webp" width="900" alt="时间轴：按步长自动回放足迹"></p>

- **跳过空白**：可只走有记录的时间段；一个按钮回到「全部」


### 统计：回顾你的旅行

- **省份点亮**：去过的省份在地图上按到访次数分 4 档点亮（橙色），一眼看出走过哪片山河

<p align="center"><img src="assets/readme/v2/19-stats-provinces.webp" width="900" alt="统计：省份点亮"></p>


- **总览数字**：省份 / 城市 / 地点 / 到访 / 照片 / 视频 六个数字

<p align="center"><img src="assets/readme/v2/20-stats-trend.webp" width="900" alt="统计：总览数字与时间趋势"></p>

- **时间趋势**：按年 / 季 / 月看访问走势
- **地区分布**和**地点排行**：哪个省去得最多、哪些地方反复去

<p align="center"><img src="assets/readme/v2/21-stats-region.webp" width="900" alt="统计：地区分布"></p>
<p align="center"><img src="assets/readme/v2/22-stats-ranking.webp" width="900" alt="统计：地点排行"></p>


- **离家距离**：离家最远的地点，以及按距离排序的「离家距离」榜

<p align="center"><img src="assets/readme/v2/23-stats-distance.webp" width="900" alt="统计：离家距离排行"></p>


### 用着顺手

- **中英文**：设置里一键切换，立即生效

<p align="center"><img src="assets/readme/v2/24-settings-general.webp" width="900" alt="设置 → 通用：语言与顶栏标语"></p>

- **字体**：11 档界面字体（7 款随仓库附带的 SIL OFL 字体 + 4 款系统字体）、字号 3 档、字重 2 档

<p align="center"><img src="assets/readme/v2/26-settings-fonts.webp" width="900" alt="设置 → 通用：界面字体 / 字号 / 字重"></p>

- **外观**：纯白 / 浅色 / 深色 / 纯黑 4 档明暗，也可以跟随系统

<p align="center"><img src="assets/readme/v2/25-settings-look.webp" width="900" alt="设置 → 通用：外观明暗与图标配色"></p>

- **主题标语**：顶栏那句标语可以自己改
- **图标配色**：家 / 去过 / 想去 / 秘密基地 四种地图图标都能换颜色


### 整理与清理

- **回收站**：删除先进回收站，误删可恢复；确认不要了再「彻底删除」，才会真正释放素材空间

<p align="center"><img src="assets/readme/v2/27-trash.webp" width="900" alt="回收站：已删除的地点 / 到访 / 照片"></p>

- **合并重复地点**：不小心把同一个地方记成两个？选两条合并即可

<p align="center"><img src="assets/readme/v2/28-merge-places.webp" width="900" alt="合并重复地点"></p>

- **素材管理**：移动、删除、设为封面、一键打开素材所在文件夹

<p align="center"><img src="assets/readme/v2/29-media-actions.webp" width="900" alt="素材管理：设为封面 / 移动 / 打开文件夹 / 删除"></p>


### 备份与迁移

- **导出备份**：元数据必选，缩略图 / 照片视频可选；后台打包，有进度，可取消；大包不占页面内存

<p align="center"><img src="assets/readme/v2/31-backup-export.webp" width="900" alt="导出备份：应用数据 / 缩略图 / 素材可选"></p>

- **从备份恢复**：先「检查备份包」看摘要 → 二次确认 → 自动把当前数据备份一份 → 再恢复；含素材会做内容校验

<p align="center"><img src="assets/readme/v2/32-backup-restore.webp" width="900" alt="从备份恢复：先检查备份包再恢复"></p>

- **备份提醒**：可设 7 / 14 / 30 / 60 / 90 天提醒

<p align="center"><img src="assets/readme/v2/30-backup-reminder.webp" width="900" alt="备份提醒：提醒阈值与待备份提示"></p>

- **换电脑 / 跨系统迁移（Windows ↔ macOS）**：两种方式任选
  1. **应用内备份（推荐）**：老电脑「设置 → 备份与恢复 → 导出备份」（勾选需要打包的素材）→ 把 zip 拷到新电脑 → 「检查备份包」→「从备份恢复」。跨系统也不会丢，照片 / 视频可选打包进去。
  2. **整个文件夹拷贝**：退出应用后，把**程序目录**（含 `data/`）+ **素材库目录**（默认 `.dev-media/`）整个拷到新电脑同一位置即可。如果换系统后路径变了（比如自定义过素材库目录），运行 `npm run migrate:paths` 按提示重新映射，或在「设置 → 素材库」里重新选择目录。

###

---

## 快速开始

### 环境要求

- **Node.js ≥ 22.13**（推荐 24 LTS）和 npm
- **ffmpeg**：可选。装了视频会有封面帧和时长，没装也能正常上传 / 播放
- **天地图 Key**：免费，浏览器端类型。申请地址 <https://www.tianditu.gov.cn/>；仓库里有作者的《天地图 Key 申请教程》PDF：[`public/docs/tianditu-key-guide.pdf`](public/docs/tianditu-key-guide.pdf)

### 安装（第一次用，装一次就够）

先装好 Node.js（建议 24 LTS），然后在程序目录里安装依赖：

```bash
npm install        # 第一次使用需要；更新版本后一般用 npm run update 即可
```

### 一键启动（日常使用，Windows / macOS 通用）

之后每天用的时候，**双击启动器**就行（会自动检查依赖、构建、后台启动服务并打开浏览器）：

| 系统 | 启动 | 停止 |
| --- | --- | --- |
| **Windows** | 双击 `TreadHorizon-Start.bat` | 双击 `TreadHorizon-Stop.bat` |
| **macOS** | 双击 `TreadHorizon-Start.command` | 双击 `TreadHorizon-Stop.command` |

> - 服务在后台运行，**关掉终端窗口不会停止服务**；要停止请用上面的停止器，或命令行 `npm run stop`。
> - 第一次启动如果还没有 `dist/` 会自动构建（需要等 1~2 分钟），之后再启动就很快。
> - 命令行也可以：`npm start`（前台构建并启动，Ctrl+C 停止）、`npm run launch`（后台启动，等同双击启动器）、`npm run serve`（已经构建过时直接启动，不用重复构建）。

首次打开会先出现「配置天地图 Key」引导页，粘贴 32 位 Key 即可进入应用（之后可以在 **设置 → 天地图 Key** 修改）。想提前写进配置文件的话：

```bash
cp .env.example .env.local      # Windows 用：copy .env.example .env.local
# 然后在 .env.local 里把 TDT_TK= 后面填上你的 32 位 Key
```

> **端口**：默认 **4000**，可用 `PORT` 修改（例如 `PORT=4001 npm start`）；服务只监听 `127.0.0.1`，所以只有本机能打开。
> 已经构建过之后，可以用 `npm run serve` 直接启动（不用重复构建）；端口在运行中被人占用时，启动器会提示已运行或端口冲突。

### macOS 安装说明

1. 安装 **Node.js 24 LTS**：官网 <https://nodejs.org/> 下载 `.pkg` 安装，或 `brew install node@24`；终端里 `node -v` 能看到版本（需 ≥ 22.13）即可。
2. 把发布包解压到一个**固定的目录**（例如 `~/Applications/TreadHorizon`，不要放在下载文件夹里，免得被清理）。
3. 在该目录打开终端执行一次 `npm install`（国内网络慢可先 `npm config set registry https://registry.npmmirror.com`）。
4. 之后双击 `TreadHorizon-Start.command` 启动、双击 `TreadHorizon-Stop.command` 停止；更新用 `npm run update`。
5. ffmpeg 可选：`brew install ffmpeg` 后视频会有封面帧，不装也能正常使用。
6. 第一次双击 `.command` 如果提示「无法打开，因为它来自身份不明的开发者」：右键 → 打开；或到 系统设置 → 隐私与安全性 → 仍要打开。若提示没有执行权限，在终端执行一次：
   `chmod +x TreadHorizon-Start.command TreadHorizon-Stop.command`

> Windows 和 macOS 的启动方式一一对应（`.bat` ↔ `.command`），数据格式完全一样，`data/` 目录可以直接在两边拷贝。

### 更新到新版本

- **源码目录（git clone）**：在程序目录执行

  ```bash
  npm run update                   # 拉取代码 → 安装依赖 → 构建 → 重启服务
  npm run update -- --no-restart   # 只更新文件，不停止 / 不重启服务
  ```

  要求目录里有 `.git`；本地有未提交改动时 `git pull --ff-only` 会失败并提示（先提交或备份改动）。
- **解压发布包 / 安装版**：下载新版本，解压覆盖程序文件即可；**保留** `data/` 和素材库目录（默认 `.dev-media/`），数据不会丢。
- 更新前建议先在应用里「设置 → 备份与恢复 → 导出备份」。

### 开发 / 改代码

```bash
npm run dev        # 前端 http://localhost:5173（API 自动跑在 4000，并把 /api 代理过去）
```

### 不想自己装？把下面这段话发给你的 AI 助手

> 把下面这段话发给你的 AI 助手，让它帮你安装好：

```text
帮我安装这个开源项目到本地并跑起来：https://github.com/BruceLi007/TreadHorizon
我的系统是：Windows（macOS 用户改成 macOS）帮我检查下部署环境。
请按仓库 README 的步骤来；注意它要求 Node.js ≥ 22.13（推荐 Node 24 LTS）。
装完请给我启动方式！
```

---

## 数据放在哪 / 隐私

| 内容                  | 位置                                      |
| ------------------- | --------------------------------------- |
| 数据库、缩略图、自动备份        | `data/`                                 |
| 素材库（上传时复制一份原片，原片不动） | 默认 `.dev-media/`，可在设置里或 `MEDIA_ROOT` 修改 |
| 导出的备份 zip           | 备份目录（默认 `data/backups/`）和 / 或浏览器下载        |

- 第一次启动会自动创建 `data/`、`data/thumbs/` 和素材库目录，不用手动建
- **macOS 上目录结构完全相同**：`data/`、`.dev-media/` 都在程序目录里，从 Windows 拷过来可以直接用
- 公开仓库里**不含任何人的真实数据**：每个人第一次打开都是自己的空库
- 所有数据都在你自己的电脑上，不联网也不上传
- 删除 `data/` = 清空应用数据（不可恢复，请先备份）；删除素材库只删应用副本，电脑里的原片不受影响

---

## 本地版 vs 云端版

同一个项目有两种用法，功能一致、数据格式相同：

|  | **本地版**（默认） | **云端版** |
| --- | --- | --- |
| 运行位置 | 自己的电脑，双击启动器即可 | 服务器 / 云主机，浏览器访问网址 |
| 账号 | 不需要账号，打开就能用（`AUTH_MODE=local`） | 多用户，需要登录 / 邀请码（`AUTH_MODE=multi`），每个账号数据互相隔离 |
| 数据 | 全部在本机 `data/` + 素材库目录 | 在服务器上，按账号隔离 |
| 升级 | `npm run update`（源码目录）或覆盖发布包 | 服务器升级一次，所有用户自动用新版 |
| 适合 | 个人记录、离线、隐私优先 | 分享给家人朋友一起用、多设备访问 |

> 云端版数据按账号隔离：普通账号的备份入口在「设置 → 账号 → 下载我的数据」；管理员可在「设置 → 备份与恢复」导出 / 恢复整个实例的数据。云端没有本地「备份目录」，导出走浏览器下载。
> 两种模式的数据可以互相迁移：用应用内「备份与恢复」导出 zip 再导入即可。

---

## 常见问题

**地图一片空白 / 加载不出来？**
检查天地图 Key 是否已填写、是否填错；免费 Key 有每日调用次数限制，用完后当天可能加载不出，第二天恢复。如果 Key 在天地图控制台设了域名白名单，记得把访问地址加进去。

**视频没有封面？**
装好 ffmpeg 后重启服务即可；没装也能正常播放视频。

**第一次打开只看到「配置天地图 Key」页面？**
这是正常的：应用需要先填一个免费的天地图 Key 才能加载地图。按页面提示粘贴 32 位 Key 即可进入；也可以提前写进 `.env.local` 的 `TDT_TK`。

**端口 4000 或 5173 被占用？**
换一个端口，例如 `PORT=4001 npm start`；开发模式可用 `npm run dev -- --port 5174`（或关掉占用端口的程序）。

**想换电脑 / 备份数据？**
两条路：① 在「设置 → 备份与恢复」导出备份 zip，新电脑上「检查备份包」→「从备份恢复」（推荐，跨 Windows / macOS 都行）；② 退出应用后直接拷贝程序目录（含 `data/`）+ 素材库目录。换系统后如果自定义过素材库路径，用 `npm run migrate:paths` 重新映射，或在「设置 → 素材库」里重选目录。

**macOS 上双击 `.command` 没反应 / 提示没有执行权限？**
右键 →「打开」；或在终端执行一次 `chmod +x TreadHorizon-Start.command TreadHorizon-Stop.command`；也可以直接在程序目录运行 `npm run launch` / `npm run stop`。

**`npm run update` 提示「不是 Git 源码目录」？**
更新脚本只适用于 `git clone` 的源码目录（目录里有 `.git`）。解压发布包 / 安装版请下载新版本覆盖程序文件，**保留 `data/` 与素材库目录**即可，数据不会丢。

**想分享自己的足迹给别人看？**
只读分享链接还在计划中，后续版本推出。

**数据会被上传吗？**
不会，所有数据都在你自己的电脑上。

---

## 已知限制 / 路线图

- **国外记录**：暂不支持，打点只在中国及周边范围内
- 个人维护的开源项目，欢迎提 Issue 交流

---

## 技术栈与目录（给开发者）

- 前端：React 19 + Vite 8 + TypeScript
- 后端：Fastify 5 + Node 内置 `node:sqlite` + sharp；视频封面可选 ffmpeg
- 地图：天地图（底图 / 搜索 / 逆地理）
- 运行模式：默认单机本地模式（`AUTH_MODE=local`，数据全部在本机）；`AUTH_MODE=multi` 为云端多用户模式
- 跨平台回归（Windows / macOS 通用，不需要浏览器）：`npm run smoke:crossplatform`

```text
server/    后端（含 paths.mjs 跨平台路径归一化）
src/       前端
public/    静态资源（地图标记、省界数据、7 款 SIL OFL 字体、天地图 Key 教程 PDF）
scripts/   启动 / 停止 / 更新 / 迁移 / 测试脚本
design/    设计预览图与生成脚本
data/      运行期数据（不进 Git）
```

---

## 第三方资源与许可

- **字体**：`public/fonts/` 随仓库附带 7 款 **SIL OFL 1.1** 字体——默认界面字体**猫啃什锦黑**，另有**喵咛狗爬黑 / 荆南波波黑 / 游趣体 / 铁蒺藜体 / 呆萌手写体 / 字魂扁桃体**，版权与 OFL 全文见 [`public/fonts/LICENSES.md`](public/fonts/LICENSES.md)；设置里的微软雅黑 / 宋体 / 黑体 / 楷体由操作系统提供，不随仓库分发
- **地图与地理编码**：天地图官方服务（需自备浏览器端 Key；审图号由天地图瓦片自带）
- **省界数据**：`public/province-boundaries*.json` 由 geojson.cn「天地图-国家标准矢量地图」整理，仅用于省份点亮
- **开源依赖**：React / Vite / Fastify / sharp 等第三方库遵循各自许可（见 `package-lock.json`）；**HEIC / HEIF 解码**使用 [`heic-convert`](https://www.npmjs.com/package/heic-convert)（ISC）与 `libheif-js`（LGPL-3.0）——仅作为 npm 运行时依赖安装，不随仓库 / 发布包分发源码
- 其余美术资源（地图标记 SVG、光标、`design/` 下的设计图）为项目自绘 / 自生成；`public/docs/tianditu-key-guide.pdf` 为作者编写的教程

## License

本项目**源代码**（含仓库内 README 等文本）采用 **MIT License**：见 [LICENSE](LICENSE)。

```text
Copyright (c) 2026 李其阳 (GitHub: @BruceLi007)
```

> 第三方资源（字体、地图数据、开源依赖等）不在此 MIT 授权范围内，分别遵循其自身许可（见上方「第三方资源与许可」与 `public/fonts/LICENSES.md`）。
