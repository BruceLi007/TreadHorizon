"""D-168 方案 B：全局强调色候选预览图（第二版：黑白 / 冷色调，两档成对）。"""
from PIL import Image, ImageDraw, ImageFont


def hex_rgb(v):
    return tuple(int(v[i:i + 2], 16) for i in (1, 3, 5))


def lum(hexv):
    def lin(c):
        c /= 255.0
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = hex_rgb(hexv)
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)


def contrast(a, b):
    la, lb = lum(a), lum(b)
    return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)


# (字母, 名称, 深色档, 浅色档, 说明)
CANDS = [
    ('F', '纯黑白', '#f2f4f7', '#161b22', '无彩色 · 高对比'),
    ('G', '石墨', '#cbd2db', '#3b4553', '无彩色 · 柔和'),
    ('H', '冰蓝', '#7bb1cd', '#317393', '冷色 · 清透蓝灰'),
    ('I', '冷青', '#26bbc5', '#1a787e', '冷色 · 青碧'),
    ('J', '靛蓝', '#9ca5ee', '#505ede', '冷色 · 蓝紫'),
]

# ── 主题常量（与 src/styles.css 一致）──
D_BG, D_PANEL, D_LINE = (11, 13, 16), (18, 21, 26), (38, 43, 51)
D_T1, D_T2, D_T3 = (233, 236, 239), (152, 162, 179), (92, 102, 117)
L_PANEL, L_LINE = (238, 241, 245), (193, 202, 212)
L_T1, L_T2 = (26, 32, 40), (72, 82, 95)
INK_DARK = hex_rgb('#17120c')
WHITE = (255, 255, 255)

F_B = 'C:/Windows/Fonts/msyhbd.ttc'
F_R = 'C:/Windows/Fonts/msyh.ttc'


def f(size, bold=False):
    try:
        return ImageFont.truetype(F_B if bold else F_R, size)
    except OSError:
        return ImageFont.load_default()


def rgba(hexv, a):
    return hex_rgb(hexv) + (int(a * 255),)


def mix(hexv, bg, a):
    r, g, b = hex_rgb(hexv)
    return tuple(round(c * a + bc * (1 - a)) for c, bc in zip((r, g, b), bg))


W, H = 1240, 1500
img = Image.new('RGB', (W, H), D_BG)
d = ImageDraw.Draw(img)


def rr(xy, radius, **kw):
    d.rounded_rectangle(xy, radius=radius, **kw)


# ── 头部 ──
d.text((32, 24), '全局强调色候选（第二版）· 黑白 / 冷色调', font=f(30, True), fill=D_T1)
d.text((32, 68), '每个候选两档：深色 / 纯黑档 = 亮的一档；浅色 / 纯白档 = 深的一档（沿用现在 #e8a15a → #c97c2e 的两档关系）。',
       font=f(14), fill=D_T2)
d.text((32, 92), '左 = 深色档面板 #12151a，右 = 浅色档面板 #eef1f5；两档都按「作文字 / 描边 / 填充都有足够对比」调过。',
       font=f(14), fill=D_T3)

ROW_X, ROW_W, ROW_H = 24, W - 48, 186
DARK_X, LIGHT_X = 300, 780
DEMO_W, DEMO_H = 440, 146


def draw_demo(x, y, accent, panel, line, t1, t2, ink, light_theme):
    """演示面板：计数 / 主按钮 / 封面角标 / 播放键 / 进度条 / 开关 / 焦点环 / 省份点亮。"""
    rr((x, y, x + DEMO_W, y + DEMO_H), 12, fill=panel)
    yy = y + 16
    d.text((x + 18, yy), '36 次到访', font=f(16, True), fill=accent)
    d.text((x + 118, yy + 2), '· 2024 年', font=f(13), fill=accent)
    rr((x + 210, yy - 3, x + 272, yy + 21), 999,
       fill=rgba(accent, 0.16 if not light_theme else 0.12), outline=accent, width=1)
    d.text((x + 228, yy + 1), '全部', font=f(13), fill=accent)
    bx = x + 292
    rr((bx, yy - 5, bx + 92, yy + 27), 999, fill=accent)
    d.text((bx + 17, yy + 2), '保存足迹', font=f(13, True), fill=ink)
    fx = x + 394
    rr((fx, yy - 4, fx + 50, yy + 16), 4, fill=accent)
    d.text((fx + 9, yy - 4), '封面', font=f(11, True), fill=ink)

    yy2 = y + 60
    rr((x + 18, yy2, x + 50, yy2 + 26), 999, fill=accent)
    d.polygon([(x + 30, yy2 + 8), (x + 30, yy2 + 18), (x + 40, yy2 + 13)], fill=ink)
    rail_y = yy2 + 14
    d.rounded_rectangle((x + 60, rail_y - 1, x + 250, rail_y + 2), 2, fill=line)
    d.rounded_rectangle((x + 60, rail_y - 1, x + 192, rail_y + 2), 2, fill=accent)
    tx = x + 266
    rr((tx, yy2 + 2, tx + 42, yy2 + 22), 999, fill=accent)
    d.ellipse((tx + 24, yy2 + 5, tx + 38, yy2 + 19), fill=ink)
    d.text((tx + 46, yy2 + 3), '跳空白', font=f(12), fill=t2)
    fo = x + 348
    rr((fo, yy2 + 1, fo + 28, yy2 + 29), 8, outline=accent, width=2)
    d.text((fo + 8, yy2 + 4), '×', font=f(13, True), fill=t2)

    px = x + 18
    for i, a in enumerate((0.22, 0.40, 0.60, 0.82)):
        tile = (px + i * 52, y + 112, px + i * 52 + 42, y + 132)
        rr(tile, 4, fill=mix(accent, panel, a), outline=accent if i == 4 else None, width=1)


def draw_label(x, y, letter, name, tag, dark_hex, light_hex):
    d.text((x, y), f'{letter} · {name}', font=f(24, True), fill=D_T1)
    d.text((x + 118, y + 8), tag, font=f(11), fill=D_T3)
    rr((x, y + 44, x + 34, y + 68), 6, fill=dark_hex, outline=(70, 76, 88))
    d.text((x + 44, y + 46), dark_hex, font=f(14), fill=D_T2)
    d.text((x + 44, y + 64), '深色 / 纯黑档', font=f(10.5), fill=D_T3)
    rr((x, y + 86, x + 34, y + 110), 6, fill=light_hex, outline=(70, 76, 88))
    d.text((x + 44, y + 88), light_hex, font=f(14), fill=D_T2)
    d.text((x + 44, y + 106), '浅色 / 纯白档', font=f(10.5), fill=D_T3)


ref_y = 128
d.text((32, ref_y - 2), '参考：现在的橙色（同样的两档，可对比观感）', font=f(12, True), fill=D_T3)
rr((ROW_X, ref_y - 20, ROW_X + ROW_W, ref_y + 186), 14, fill=(20, 23, 29), outline=D_LINE)
d.text((ROW_X + 20, ref_y + 8), '参考 · 现橙', font=f(22, True), fill=D_T1)
rr((ROW_X + 20, ref_y + 52, ROW_X + 54, ref_y + 76), 6, fill='#e8a15a', outline=(70, 76, 88))
d.text((ROW_X + 64, ref_y + 54), '#e8a15a', font=f(14), fill=D_T2)
rr((ROW_X + 20, ref_y + 94, ROW_X + 54, ref_y + 118), 6, fill='#c97c2e', outline=(70, 76, 88))
d.text((ROW_X + 64, ref_y + 96), '#c97c2e', font=f(14), fill=D_T2)
draw_demo(DARK_X, ref_y + 2, '#e8a15a', D_PANEL, D_LINE, D_T1, D_T2, INK_DARK, False)
draw_demo(LIGHT_X, ref_y + 2, '#c97c2e', L_PANEL, L_LINE, L_T1, L_T2, INK_DARK, True)

groups = [(0, '黑白（无彩色）'), (2, '冷色调')]
y = 330
for idx, (letter, name, dark_hex, light_hex, tag) in enumerate(CANDS):
    for start, gtitle in groups:
        if idx == start:
            d.text((32, y - 6), gtitle, font=f(13, True), fill=D_T3)
            y += 22
    rr((ROW_X, y, ROW_X + ROW_W, y + ROW_H), 14, fill=(20, 23, 29), outline=D_LINE)
    draw_label(ROW_X + 20, y + 18, letter, name, tag, dark_hex, light_hex)
    cd = contrast(dark_hex, '#12151a')
    cl = contrast(light_hex, '#ffffff')
    d.text((ROW_X + 20, y + 136), f'深色档对深底 {cd:.1f}:1', font=f(10.5), fill=D_T3)
    d.text((ROW_X + 20, y + 154), f'浅色档对白底 {cl:.1f}:1（深字改白字）', font=f(10.5), fill=D_T3)
    draw_demo(DARK_X, y + 20, dark_hex, D_PANEL, D_LINE, D_T1, D_T2, INK_DARK, False)
    draw_demo(LIGHT_X, y + 20, light_hex, L_PANEL, L_LINE, L_T1, L_T2, WHITE, True)
    y += ROW_H + 18

d.text((32, H - 68), '注 ①：浅色 / 纯白档强调色整体更深，「强调色底上的字」由现在的深棕 #17120c 改为白色；深色 / 纯黑档仍用深字。',
       font=f(12), fill=D_T3)
d.text((32, H - 44), '注 ②：黑白档的省界点亮会用中性灰（纯白在浅色地图上看不见）；冷色档跟强调色走。其余硬编码橙按 D-168 清单一并收敛。',
       font=f(12), fill=D_T3)

img.save('design/accent-candidates-20261106-v2.png')
print('saved design/accent-candidates-20261106-v2.png', img.size)
for letter, name, dk, lt, tag in CANDS:
    print(letter, name, dk, lt, f'dark/panel={contrast(dk, "#12151a"):.2f}', f'light/white={contrast(lt, "#ffffff"):.2f}')
