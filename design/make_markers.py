"""生成标记样式方案图 —— 飞镖 / 图钉形态对比"""
from PIL import Image, ImageDraw, ImageFilter, ImageFont

SS = 4  # 超采样倍数，抗锯齿

BG     = (11, 13, 16)
PANEL  = (18, 21, 26)
LINE   = (38, 43, 51)
TEXT1  = (233, 236, 239)
TEXT2  = (152, 162, 179)
TEXT3  = (92, 102, 117)
AMBER  = (232, 161, 90)
AMBER_L= (255, 196, 138)
WISH   = (106, 169, 216)

F_B = "C:/Windows/Fonts/msyhbd.ttc"
F_R = "C:/Windows/Fonts/msyh.ttc"

def f(size, bold=False):
    return ImageFont.truetype(F_B if bold else F_R, size)

# 归一化坐标：尖端在 (0.5, 1.0)，整个形状落在 [0,1] x [0,1]
SHAPES = {
    "dart":    [(0.5,1.0),(0.335,0.54),(0.10,0.20),(0.345,0.32),(0.5,0.20),
                (0.655,0.32),(0.90,0.20),(0.665,0.54)],
    "arrow":   [(0.5,1.0),(0.13,0.18),(0.5,0.40),(0.87,0.18)],
    "kite":    [(0.5,1.0),(0.13,0.42),(0.5,0.05),(0.87,0.42)],
    "feather": [(0.5,1.0),(0.30,0.56),(0.15,0.24),(0.41,0.41),(0.5,0.09),
                (0.59,0.41),(0.85,0.24),(0.70,0.56)],
    "trail":   [(0.5,0.99),(0.355,0.84),(0.435,0.04),(0.565,0.04),(0.645,0.84)],
}

def draw_marker(d, cx, top, h, name, fill, outline=None, lw=0, halo=False,
                halo_col=None, halo_r=0.62):
    w = h * 0.72
    left = cx - w / 2

    if name == "pin":
        r = h * 0.30
        cy = top + h * 0.30
        d.ellipse([cx-r, cy-r, cx+r, cy+r], fill=fill,
                  outline=outline, width=lw)
        d.polygon([(cx - r*0.72, cy + r*0.62),
                   (cx + r*0.72, cy + r*0.62),
                   (cx, top + h)], fill=fill, outline=outline)
    else:
        poly = [(left + px*w, top + py*h) for px, py in SHAPES[name]]
        d.polygon(poly, fill=fill, outline=outline, width=lw)

    # 拖尾款加一个圆头，否则缩小时只剩一根线
    if name == "trail":
        r = h * 0.155
        cy = top + h * 0.845
        d.ellipse([cx-r, cy-r, cx+r, cy+r], fill=fill, outline=outline, width=lw)

    if halo:
        r = h * halo_r
        cy = top + h * 0.52
        d.ellipse([cx-r, cy-r, cx+r, cy+r],
                  outline=halo_col or fill, width=max(1, int(h*0.045)))

def marker_img(h, name, fill, **kw):
    """返回带发光的高清标记小图，尺寸 h*2"""
    pad = int(h * 0.55)
    S = int(h * 2.1)
    layer = Image.new("RGBA", (S*1, S*1), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx = S / 2
    top = (S - h) / 2
    draw_marker(d, cx, top, h, name, fill, **kw)

    # 发光
    glow = layer.filter(ImageFilter.GaussianBlur(h * 0.10))
    out = Image.new("RGBA", layer.size, (0, 0, 0, 0))
    out.alpha_composite(glow)
    out.alpha_composite(layer)
    return out

# ─────────────────────────────────────────────
W, H = 1520, 1010
img = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(img)

# 标题
d.text((44, 36), "标记样式 · 飞镖方向", font=f(30, True), fill=TEXT1)
d.text((44, 80), "6 种形态 + 真实地图尺寸对比 + 状态示例", font=f(14), fill=TEXT3)
d.line([(44, 112), (W-44, 112)], fill=LINE, width=1)

# ── A. 大图 ──
VARIANTS = [
    ("pin",     "图钉",     "最经典，识别度高"),
    ("dart",    "尖角飞镖", "有尾翼，方向感强"),
    ("arrow",   "极简箭头", "最克制，块面大"),
    ("kite",    "菱形镖",   "对称，最锐利"),
    ("feather", "羽毛镖",   "细节多，偏插画"),
    ("trail",   "光点拖尾", "像流星，动感最强"),
]

cell_w = (W - 88) / 6
big_h = 150
base_y = 150

for i, (key, title, desc) in enumerate(VARIANTS):
    cx = 44 + cell_w * i + cell_w / 2
    m = marker_img(big_h, key, AMBER)
    img.paste(m, (int(cx - m.width/2), int(base_y + big_h*0.5 - m.height/2)), m)
    d.text((cx, 340), title, font=f(16, True), fill=TEXT1, anchor="mm")
    d.text((cx, 364), desc, font=f(12), fill=TEXT3, anchor="mm")

# ── B. 真实地图尺寸 ──
sec_y = 410
d.text((44, sec_y), "真实地图尺寸 · 约 30px（实际观感）", font=f(15, True), fill=TEXT2)

strip_x, strip_y, strip_w, strip_h = 44, sec_y + 34, W - 88, 210

# 假底图：深色 + 细网格 + 若干模糊色块
fake = Image.new("RGB", (strip_w, strip_h), (14, 17, 21))
fd = ImageDraw.Draw(fake)
for gx in range(0, strip_w, 52):
    fd.line([(gx, 0), (gx, strip_h)], fill=(20, 24, 29), width=1)
for gy in range(0, strip_h, 52):
    fd.line([(0, gy), (strip_w, gy)], fill=(20, 24, 29), width=1)
blobs = [((180, 90), 130, (23, 30, 27)), ((520, 160), 110, (26, 25, 22)),
         ((900, 60), 150, (22, 27, 31)), ((1240, 150), 120, (28, 25, 23))]
for (bx, by), br, col in blobs:
    fd.ellipse([bx-br, by-br, bx+br, by+br], fill=col)
fake = fake.filter(ImageFilter.GaussianBlur(26))
img.paste(fake, (strip_x, strip_y))
d.rectangle([strip_x, strip_y, strip_x+strip_w-1, strip_y+strip_h-1], outline=LINE)

# 在假底图上放小标记
small = 30
spots = [70, 270, 470, 670, 880, 1090, 1290]
for i, key in enumerate(["pin", "dart", "arrow", "kite", "feather", "trail"]):
    m = marker_img(small, key, AMBER)
    x = strip_x + spots[i]
    y = strip_y + 70 + (i % 2) * 60
    img.paste(m, (int(x - m.width/2), int(y - m.height/2)), m)

# 聚合点示例
agg_x = strip_x + spots[6]
agg_y = strip_y + 135
r = 26
d.ellipse([agg_x-r, agg_y-r, agg_x+r, agg_y+r], fill=(232, 161, 90, 255))
d.text((agg_x, agg_y-2), "18", font=f(24, True), fill=(20, 22, 26), anchor="mm")
d.text((agg_x, agg_y + r + 16), "浙江", font=f(12), fill=TEXT2, anchor="mm")

# ── C. 状态 ──
sec2 = 700
d.text((44, sec2), "状态示例（以尖角飞镖为例）", font=f(15, True), fill=TEXT2)

states = [
    ("去过 · 1 次",  dict(name="dart", fill=AMBER)),
    ("常去 · 3 次",  dict(name="dart", fill=AMBER, halo=True, halo_col=(232,161,90))),
    ("想去",         dict(name="dart", fill=(30, 34, 41), outline=WISH, lw=3)),
    ("选中",         dict(name="dart", fill=AMBER_L)),
    ("聚合",         None),
]
cell2 = (W - 88) / 5
by = sec2 + 46
bh = 130

for i, (label, kw) in enumerate(states):
    cx = 44 + cell2 * i + cell2 / 2
    if kw is None:
        r = 34
        cy = by + bh * 0.48
        d.ellipse([cx-r, cy-r, cx+r, cy+r], fill=AMBER)
        d.text((cx, cy - 2), "18", font=f(30, True), fill=(20, 22, 26), anchor="mm")
        d.text((cx, cy + r + 18), "浙江", font=f(12), fill=TEXT2, anchor="mm")
    else:
        m = marker_img(bh, **kw)
        img.paste(m, (int(cx - m.width/2), int(by + bh*0.5 - m.height/2)), m)
        if label == "选中":
            d.text((cx, by + bh + 14), "西湖", font=f(13, True), fill=TEXT1, anchor="mm")
    d.text((cx, by + bh + 44), label, font=f(13), fill=TEXT2, anchor="mm")

# 底注
d.line([(44, H-64), (W-44, H-64)], fill=LINE, width=1)
d.text((44, H-48), "所有形状尖端均对齐真实坐标点；琥珀 = 去过，冷蓝 = 想去",
       font=f(12), fill=TEXT3)

img.save("D:/Project/TravelMaps/design/markers.png", quality=95)
print("saved", img.size)

# ─────────────────────────────────────────────
# 导出 SVG（矢量，放大不糊；锚点统一在 50,100）
# ─────────────────────────────────────────────
import os
os.makedirs("D:/Project/TravelMaps/design/svg", exist_ok=True)

def svg_of(name, color="#e8a15a"):
    if name == "pin":
        body = ('<circle cx="50" cy="30" r="21" fill="{c}"/>'
                '<polygon points="34.9,43.0 65.1,43.0 50,100" fill="{c}"/>').format(c=color)
    else:
        pts = " ".join(f"{px*100:.2f},{py*100:.2f}" for px, py in SHAPES[name])
        body = f'<polygon points="{pts}" fill="{color}"/>'
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" '
        'width="100" height="100">\n'
        '  <!-- 锚点：尖端 (50,100) -->\n'
        f'  {body}\n'
        '</svg>\n'
    )

names = ["pin", "dart", "arrow", "kite", "feather", "trail"]
for n in names:
    with open(f"D:/Project/TravelMaps/design/svg/{n}.svg", "w", encoding="utf-8") as fh:
        fh.write(svg_of(n))
    with open(f"D:/Project/TravelMaps/design/svg/{n}-wish.svg", "w", encoding="utf-8") as fh:
        fh.write(svg_of(n, "#6aa9d8"))
print("svg exported:", ", ".join(names))
