# -*- coding: utf-8 -*-
"""生成 Tread Horizon M6 架构总览图（本地 / 云端同一份代码，2000×1580 PNG）。

用法：python design/make_architecture.py
输出：design/architecture-m6-20261107.png（同目录）
依赖：Pillow；中文用 Windows 自带微软雅黑（其他平台改 REG/BOLD 路径）。
"""
import math
import os
import re
from PIL import Image, ImageDraw, ImageFont

W, H = 2000, 1580
S = 2
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "architecture-m6-20261107.png")

img = Image.new("RGB", (W * S, H * S), "#f6f7fb")
d = ImageDraw.Draw(img)

REG = r"C:\Windows\Fonts\msyh.ttc"
BOLD = r"C:\Windows\Fonts\msyhbd.ttc"
_fonts = {}


def sc(v):
    return int(round(v * S))


def font(size, bold=False):
    key = (size, bold)
    if key not in _fonts:
        _fonts[key] = ImageFont.truetype(BOLD if bold else REG, sc(size))
    return _fonts[key]


def text(x, y, s, size, color, bold=False, anchor="la"):
    d.text((sc(x), sc(y)), s, font=font(size, bold), fill=color, anchor=anchor)


def tw(s, size, bold=False):
    return d.textlength(s, font=font(size, bold)) / S


def rrect(x, y, w, h, r, fill, outline=None, width=2, shadow=False):
    if shadow:
        d.rounded_rectangle(
            [sc(x + 2), sc(y + 3), sc(x + w + 2), sc(y + h + 3)],
            radius=sc(r), fill="#e9ecf3",
        )
    d.rounded_rectangle(
        [sc(x), sc(y), sc(x + w), sc(y + h)],
        radius=sc(r), fill=fill, outline=outline,
        width=max(1, int(round(width * S))) if outline else 0,
    )


def dashed_rect(x, y, w, h, color, width=2, dash=10, gap=7):
    lw = max(1, int(round(width * S)))

    def seg(x1, y1, x2, y2):
        length = math.hypot(x2 - x1, y2 - y1)
        if length == 0:
            return
        ux, uy = (x2 - x1) / length, (y2 - y1) / length
        pos = 0.0
        while pos < length:
            e = min(pos + dash, length)
            d.line([sc(x1 + ux * pos), sc(y1 + uy * pos),
                    sc(x1 + ux * e), sc(y1 + uy * e)], fill=color, width=lw)
            pos += dash + gap

    seg(x, y, x + w, y)
    seg(x + w, y, x + w, y + h)
    seg(x + w, y + h, x, y + h)
    seg(x, y + h, x, y)


def arrow(x1, y1, x2, y2, color="#94a3b8", width=2.2, head=11):
    d.line([sc(x1), sc(y1), sc(x2), sc(y2)], fill=color, width=max(1, int(round(width * S))))
    ang = math.atan2(y2 - y1, x2 - x1)
    p1 = (x2 - head * math.cos(ang - 0.45), y2 - head * math.sin(ang - 0.45))
    p2 = (x2 - head * math.cos(ang + 0.45), y2 - head * math.sin(ang + 0.45))
    d.polygon([(sc(x2), sc(y2)), (sc(p1[0]), sc(p1[1])), (sc(p2[0]), sc(p2[1]))], fill=color)


def wrap(s, size, max_w, bold=False):
    f = font(size, bold)
    maxw = max_w * S
    tokens = re.findall(r"\s+|[^\s]+", s)
    lines, cur = [], ""
    for tok in tokens:
        if tok.isspace():
            if cur:
                cur += tok
            continue
        cand = cur + tok
        if d.textlength(cand, font=f) <= maxw:
            cur = cand
            continue
        if cur.strip():
            lines.append(cur.rstrip())
            cur = ""
        if d.textlength(tok, font=f) <= maxw:
            cur = tok
            continue
        piece = ""
        for ch in tok:
            if d.textlength(piece + ch, font=f) <= maxw:
                piece += ch
            else:
                lines.append(piece)
                piece = ch
        cur = piece
    if cur.strip():
        lines.append(cur.rstrip())
    return lines


def paragraph(x, y, w, s, size, color, line_h, bold=False):
    for ln in wrap(s, size, w, bold):
        text(x, y, ln, size, color, bold)
        y += line_h
    return y


def bullets(x, y, w, items, size, color, line_h, indent=19):
    for it in items:
        for i, ln in enumerate(wrap(it, size, w - indent)):
            text(x + (indent if i else 0), y, ln, size, color)
            y += line_h
    return y


def pill(x, y, h, label, size=16, bold=True, fill="#eef2ff", outline="#c7d2fe",
         color="#3730a3", pad=17, right=None, dashed=False):
    f = font(size, bold)
    w = d.textlength(label, font=f) / S + pad * 2
    if right is not None:
        x = right - w
    if dashed:
        rrect(x, y, w, h, h / 2, fill, None)
        dashed_rect(x, y + 2, w, h - 4, outline, width=1.6, dash=7, gap=6)
    else:
        rrect(x, y, w, h, h / 2, fill, outline, 1.6)
    d.text((sc(x + w / 2), sc(y + h / 2)), label, font=f, fill=color, anchor="mm")
    return w


def chip(x, y, h, label, size=15.5, fill="#ffffff", outline="#cfdff3",
         color="#1e3a8a", dashed=False):
    f = font(size)
    w = d.textlength(label, font=f) / S + 30
    rrect(x, y, w, h, h / 2, fill, None)
    if dashed:
        dashed_rect(x + 1, y + 1, w - 2, h - 2, outline, width=1.5, dash=6, gap=5)
    else:
        d.rounded_rectangle([sc(x), sc(y), sc(x + w), sc(y + h)], radius=sc(h / 2),
                            outline=outline, width=max(1, int(round(1.5 * S))))
    d.text((sc(x + w / 2), sc(y + h / 2)), label, font=f, fill=color, anchor="mm")
    return w


def panel_head(x, y, s, color, size=19.5):
    text(x, y, s, size, color, bold=True)


def bullet_dot(x, y, color="#94a3b8"):
    d.ellipse([sc(x), sc(y + 8), sc(x + 5), sc(y + 13)], fill=color)


# ───────────────────────── header ─────────────────────────
text(60, 26, "Tread Horizon · 架构总览", 40, "#0f172a", bold=True)
text(62, 84, "同一份源码 / 同一个构建：本地版与云端版只差一个环境变量 AUTH_MODE（默认 local）",
     18, "#475569")
pill(None, 36, 40, "同一份源码 · 同一个构建", 16.5, bold=True, right=1940)

# legend
lx = 1940
legend = [("#6b7280", "未实现（虚线）"), ("#1d4ed8", "multi 分支"),
          ("#15803d", "local 分支"), ("#94a3b8", "共用模块")]
for color, label in legend:
    twidth = tw(label, 14.5)
    lx -= twidth
    text(lx, 92, label, 14.5, "#475569")
    if color == "#6b7280":
        dashed_rect(lx - 26, 94, 15, 13, color, width=1.6, dash=4, gap=3)
    else:
        d.rounded_rectangle([sc(lx - 25), sc(94), sc(lx - 12), sc(107)], radius=sc(3), fill=color)
    lx -= 38

d.line([sc(60), sc(126), sc(1940), sc(126)], fill="#e2e8f0", width=sc(1.2))

# ───────────────────────── ① browser ─────────────────────────
rrect(60, 132, 1880, 158, 16, "#eef5fd", "#c5d5ea", 1.8, shadow=True)
text(84, 148, "① 用户浏览器 · 同一份前端构建（React 19 + Vite 8 → dist/）", 21.5, "#1e3a8a", bold=True)

chips = [
    ("天地图 JS 地图（标记层自绘）", False),
    ("侧栏 / 灯箱", False),
    ("照片墙 / My旅迹", False),
    ("统计 / 时间轴", False),
    ("设置窗口", False),
    ("登录页（仅 multi）", False),
    ("分享页 /s/<token>（P3）", True),
]
chip_h = 34
chip_gap = 15
total = sum(tw(c[0], 15.5) + 30 for c in chips) + chip_gap * (len(chips) - 1)
cx = 60 + (1880 - total) / 2
for label, dashed in chips:
    cx += chip(cx, 183, chip_h, label, dashed=dashed, color=("#6b7280" if dashed else "#1e3a8a")) + chip_gap

paragraph(84, 232, 1770,
          "multi：启动先调 /api/auth/me —— 未登录只渲染登录页、不加载业务数据；首次登录必须自填天地图 Key（每人一份）。"
          "local：无登录，启动流程与以前完全一致。",
          15.5, "#475569", 23)

# ───────────────────────── ② server ─────────────────────────
rrect(60, 344, 1880, 470, 16, "#ffffff", "#cbd5e1", 1.8, shadow=True)
text(84, 360, "② Node 服务 · Fastify 5（server/index.mjs —— 同一份后端代码）", 21.5, "#0f172a", bold=True)
pill(None, 356, 38, "启动开关：AUTH_MODE = local（默认） ｜ multi（云端）", 15.5,
     fill="#eef2ff", outline="#c7d2fe", color="#3730a3", right=1916)

# local panel
rrect(84, 406, 896, 300, 13, "#edf7f2", "#b5d9c6", 1.8)
panel_head(106, 422, "local · 单机模式（默认，行为与以前完全一致）", "#15803d", 19.5)
bullets(106, 466, 856, [
    "• 无登录 / 无账号 / 无用户隔离",
    "• place / visit / media 的 user_id 写 NULL，查询不过滤",
    "• 全局设置：data/config.json（家 / 秘密基地密码 / 备份提醒）",
    "• 天地图 Key：全局一份（.env.local 或 设置 → 天地图 Key）",
    "• 素材路径：<素材库>/省/市/区县/日期_地点名",
    "• 备份 / 恢复：完整备份（元数据 + 可选缩略图 / 原片）",
    "• 设置分类无「账号 / 用户管理」；关于页 = 本地版",
], 15.5, "#1f2937", 31)

# multi panel
rrect(1012, 406, 904, 300, 13, "#eef4fe", "#b6c8ea", 1.8)
panel_head(1034, 422, "multi · 云端多用户模式（P2 已验收）", "#1d4ed8", 19.5)
bullets(1034, 466, 860, [
    "• 全局登录守卫 + 会话 Cookie 30 天滚动 / 邀请码注册",
    "• 服务端按 user_id 隔离：跨用户访问一律 404",
    "• 每用户独立：家 / 秘密基地密码 / 天地图 Key / 备份提醒",
    "• 素材库：<素材库>/<账号ID>/…；切换路径自动同步素材",
    "• 管理员：用户管理 / 邀请码；普通用户：导出 + 按账号恢复",
    "• 登录态可被禁用 / 重置密码撤销；管理操作不越权看数据",
    "• 设置多「账号 / 用户管理」；关于页按角色分层",
], 15.5, "#1f2937", 31)

# shared band
rrect(84, 722, 1832, 74, 11, "#f8fafc", "#e2e8f0", 1.6)
paragraph(104, 733, 1792,
          "共用业务模块：places · visits · media（上传 / 缩略图 / 1600 预览 / 视频封面）· stats · photos · timeline · "
          "secret · backup · user-export / user-restore · share（P3 预留）",
          14.5, "#334155", 24)
paragraph(104, 761, 1792,
          "共用接口：/api/*（multi 下除 /api/health、/api/auth/* 外均需登录）· /api/admin/* 仅管理员 · /api/account/* 个人",
          14.5, "#334155", 24)

# ───────────────────────── arrows / storage ─────────────────────────
arrow(1000, 290, 1000, 340, "#94a3b8", 2.4, 11)
text(1016, 300, "HTTP / JSON · 同源 API（multi 带 Cookie 会话）", 14.5, "#64748b")

arrow(522, 814, 522, 856, "#94a3b8", 2.2, 10)
arrow(1480, 814, 1480, 856, "#94a3b8", 2.2, 10)
text(538, 823, "查询 / 写入", 13.5, "#64748b")
text(1496, 823, "读写素材文件", 13.5, "#64748b")

rrect(60, 860, 900, 215, 14, "#fdf8ed", "#e6d6b4", 1.8, shadow=True)
text(84, 876, "③ 本机数据 · SQLite（node:sqlite · WAL）与配置", 19.5, "#a16207", bold=True)
bullets(84, 916, 852, [
    "• travel.db：place / visit / media（含 user_id）+ user / session / invite + user_setting",
    "• data/thumbs/ 缩略图缓存（multi 按账号分目录）· data/config.json（local 全局设置）",
    "• data/backups/：恢复前 / 迁移前自动备份；data/tmp/ 导出临时文件",
], 14.5, "#1f2937", 27)

rrect(1000, 860, 940, 215, 14, "#f8f3fc", "#dbc9ed", 1.8, shadow=True)
text(1024, 876, "④ 素材库 B 与 A 原件（媒体唯一导入入口）", 19.5, "#7e22ce", bold=True)
bullets(1024, 916, 892, [
    "• 上传 = 复制 A 原件到素材库 B；A 原件永远不碰、不进备份",
    "• B 路径：local 省/市/区县/日期_地点名；multi <账号ID>/省/市/…",
    "• sharp：缩略图 / 1600 预览；ffmpeg：视频封面与时长（未装自动跳过）",
    "• 备份 / 恢复 / 彻底删除只动 data/ 与 B；B 里备份外文件永不删除",
], 14.5, "#1f2937", 27)

# ───────────────────────── ⑤ external ─────────────────────────
rrect(60, 1105, 1880, 72, 12, "#f1f5f9", "#dbe2ea", 1.6)
text(84, 1121, "⑤ 外部依赖", 17.5, "#475569", bold=True)
paragraph(250, 1121, 1660,
          "天地图 API：浏览器底图 + 服务端搜索 / 逆地理（浏览器端 Key，QPS 很低，服务端统一限速 + 缓存）"
          "· sharp（缩略图 / 预览）· ffmpeg（视频封面 / 时长）",
          15, "#334155", 26)

# ───────────────────────── deployment ─────────────────────────
rrect(60, 1207, 800, 200, 14, "#f3f4f6", "#d1d5db", 1.8, shadow=True)
text(84, 1223, "本地部署（现在即可用）", 19.5, "#374151", bold=True)
bullets(84, 1263, 752, [
    "• npm run dev → API :4000 + Vite :5173（浏览器开 http://localhost:5173）",
    "• npm start → 先 vite build，再由 :4000 提供 dist + API",
    "• AUTH_MODE=local（默认）；真实 data/、.dev-media、.env.local",
    "• 测试隔离：DATA_DIR + 临时 MEDIA_ROOT + 非 4000 端口",
], 14.5, "#1f2937", 26)

rrect(880, 1207, 1060, 200, 14, "#fff7ed", "#f0cfa8", 1.8, shadow=True)
text(904, 1223, "云端部署（P1，等 ICP 备案 / 服务器窗口）", 19.5, "#b45309", bold=True)
bullets(904, 1263, 1012, [
    "• Docker Compose（app + nginx + certbot）→ Nginx（HTTPS）→ 同一 Node 镜像",
    "• AUTH_MODE=multi + ADMIN_USERNAME / ADMIN_PASSWORD + COOKIE_SECURE=1；Volume 挂 data/ 与素材库",
    "• 阿里云 北京：2 vCPU / 2 GiB / 3 Mbps / 40 GiB ESSD；域名需 ICP 备案",
    "• 上云窗口：先副本 dry-run（migrate:multiuser），不真机部署、不在真实库执行",
], 14.5, "#1f2937", 26)

# ───────────────────────── P3 share strip (dashed) ─────────────────────────
rrect(60, 1437, 1880, 104, 14, "#fbfbfc", None)
dashed_rect(60, 1437, 1880, 104, "#9ca3af", width=1.8, dash=12, gap=8)
text(84, 1453, "P3 分享 · F-SHR-01（未实现；云上同服务只读路由）", 18, "#4b5563", bold=True)
paragraph(84, 1484, 1832,
          "同一 Node 服务新增只读路由 /s/<token>：快照冻结（VACUUM INTO + 冻结缩略图 / 预览，原片不复制）"
          "· 只读三层保证 · 有效期精确到小时（无永久）· 查看者自填天地图 Key · 秘密基地服务端门禁",
          14.5, "#4b5563", 25)

# ───────────────────────── footer ─────────────────────────
text(60, 1556, "Tread Horizon · M6 架构总览（2026-11-07，P2 已验收）", 13.5, "#94a3b8")
text(1940, 1556, "本地版与云端版是同一份源码，不存在两套代码；P1 / P3 尚未实现",
     13.5, "#94a3b8", anchor="ra")

img = img.resize((W, H), Image.LANCZOS)
img.save(OUT, "PNG")
print("saved:", OUT, img.size)
