#!/usr/bin/env python3
"""
素材体检 —— 扫描 assets/art，报告每个文件能不能直接用

    python scripts/audit-assets.py
    python scripts/audit-assets.py assets/art/icons

检查项：
  · 格式是否在推荐范围内
  · 位图尺寸、颜色模式（CMYK 会发灰）、是否带透明通道
  · 白底不透明（放深色界面上会变成白方块）
  · 文件体积异常
  · SVG 是否内嵌位图 / 是否依赖字体
"""
from __future__ import annotations

import sys
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DIR = ROOT / "assets" / "art"

RASTER_OK = {".png", ".webp", ".jpg", ".jpeg", ".gif"}
VECTOR_OK = {".svg"}
FONT_OK = {".woff2", ".woff", ".ttf", ".otf"}
MOTION_OK = {".json", ".lottie"}

C = {
    "ok": "\033[92m", "warn": "\033[93m", "bad": "\033[91m",
    "dim": "\033[90m", "b": "\033[1m", "x": "\033[0m",
}


def human(n: int) -> str:
    for u in ("B", "KB", "MB"):
        if n < 1024:
            return f"{n:.0f}{u}"
        n /= 1024
    return f"{n:.1f}GB"


def check_svg(p: Path) -> list[tuple[str, str]]:
    issues = []
    try:
        txt = p.read_text(encoding="utf-8", errors="replace")
    except Exception as e:
        return [("bad", f"读不出来: {e}")]

    if "<image" in txt:
        issues.append(("bad", "内嵌了位图 <image>，放大还是会糊"))
    if "font-family" in txt or "<text" in txt:
        issues.append(("warn", "依赖字体文本，换机器可能变形（建议转曲）"))
    if "<filter" in txt:
        issues.append(("warn", "用了滤镜，部分浏览器渲染慢"))
    if "viewBox" not in txt:
        issues.append(("warn", "没有 viewBox，缩放可能出错"))
    if p.stat().st_size > 200 * 1024:
        issues.append(("warn", f"体积 {human(p.stat().st_size)}，建议压缩（SVGO）"))
    if not issues:
        issues.append(("ok", "干净可用"))
    return issues


def check_raster(p: Path) -> list[tuple[str, str]]:
    issues = []
    try:
        from PIL import Image
    except ImportError:
        return [("bad", "没装 Pillow，无法检查位图")]

    try:
        with Image.open(p) as im:
            fmt, size, mode = im.format, im.size, im.mode
            has_alpha = mode in ("RGBA", "LA") or (mode == "P" and "transparency" in im.info)

            # 颜色模式
            if mode == "CMYK":
                issues.append(("bad", "CMYK 颜色模式，浏览器里会发灰 → 转 sRGB"))
            elif mode not in ("RGB", "RGBA", "P", "L", "LA"):
                issues.append(("warn", f"颜色模式 {mode}，建议转 RGB/RGBA"))

            # 透明通道
            if p.suffix.lower() in (".png", ".webp") and not has_alpha:
                # 进一步看四角是不是纯白
                rgb = im.convert("RGB")
                w, h = rgb.size
                corners = [rgb.getpixel(pt) for pt in
                           [(0, 0), (w-1, 0), (0, h-1), (w-1, h-1)]]
                if all(c == (255, 255, 255) for c in corners):
                    issues.append(("bad", "白底且无透明通道 → 深色界面上会是个白方块"))
                else:
                    issues.append(("warn", "无透明通道，作为图标使用前需确认背景"))

            # 尺寸
            long_side = max(size)
            if long_side < 48:
                issues.append(("warn", f"尺寸 {size[0]}×{size[1]} 偏小，2x/3x 屏会糊"))
            if long_side > 2048:
                issues.append(("warn", f"尺寸 {size[0]}×{size[1]} 过大，建议先缩"))

            # 体积
            if p.stat().st_size > 1024 * 1024:
                issues.append(("warn", f"体积 {human(p.stat().st_size)}，建议转 WebP"))

            if not issues:
                issues.append(("ok", f"{fmt} {size[0]}×{size[1]} {mode}"
                                      + ("（带透明）" if has_alpha else "")))
    except Exception as e:
        issues.append(("bad", f"打不开: {e}"))
    return issues


def check_other(p: Path) -> list[tuple[str, str]]:
    ext = p.suffix.lower()
    if ext in FONT_OK:
        return [("ok", f"字体 {human(p.stat().st_size)}，我可以转 WOFF2")]
    if ext in MOTION_OK:
        return [("ok", "Lottie 动效")]
    if ext in (".psd", ".ai", ".sketch", ".fig", ".procreate"):
        return [("bad", "设计源文件，我读不了 → 请导出 SVG 或透明 PNG")]
    if ext in (".pdf",):
        return [("warn", "PDF 可以，但请优先给 SVG")]
    return [("warn", f"未知格式 {ext or '(无扩展名)'}")]


def main() -> int:
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_DIR
    if not target.exists():
        print(f"{C['bad']}目录不存在：{target}{C['x']}")
        print(f"{C['dim']}先建好 assets/art/，把素材丢进去再跑。{C['x']}")
        return 1

    files = sorted(
        f for f in target.rglob("*")
        if f.is_file() and not f.name.startswith(".")
    )
    if not files:
        print(f"{C['warn']}没有文件：{target}{C['x']}")
        return 0

    print(f"\n{C['b']}素材体检{C['x']}  {target}")
    print("─" * 78)

    tally = {"ok": 0, "warn": 0, "bad": 0}
    for f in files:
        ext = f.suffix.lower()
        if ext in VECTOR_OK:
            issues = check_svg(f)
        elif ext in RASTER_OK:
            issues = check_raster(f)
        else:
            issues = check_other(f)

        rel = f.relative_to(target)
        print(f"\n{C['b']}{rel}{C['x']}  {C['dim']}{human(f.stat().st_size)}{C['x']}")
        for level, msg in issues:
            mark = {"ok": "✔", "warn": "!", "bad": "✘"}[level]
            print(f"  {C[level]}{mark} {msg}{C['x']}")
            tally[level] += 1

    print("\n" + "─" * 78)
    print(f"{C['ok']}可用 {tally['ok']}{C['x']}  "
          f"{C['warn']}需处理 {tally['warn']}{C['x']}  "
          f"{C['bad']}要返工 {tally['bad']}{C['x']}")
    if tally["bad"]:
        print(f"{C['dim']}标 ✘ 的建议重新导出透明 PNG 或 SVG。{C['x']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
