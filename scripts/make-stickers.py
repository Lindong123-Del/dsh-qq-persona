#!/usr/bin/env python3
"""生成一套本地 QQ 表情包（不下载任何网络图片）。

用法：
    python scripts/make-stickers.py --out "%USERPROFILE%\\.dsh\\qq-bridge\\stickers"

默认输出到 ~/.dsh/qq-bridge/stickers/<tag>/<tag>_<n>.png。
每个标签 3 张，共 8 个标签；图片为 512x512 PNG，方便 QQ 直接发送。
"""

from __future__ import annotations

import argparse
import math
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

SIZE = 512
SCALE = 2
CANVAS = SIZE * SCALE

TAGS = {
    "happy": ("开心", "#FFD86B", "#FFF3C4"),
    "confused": ("无语", "#B9C7D6", "#E8EEF4"),
    "sleepy": ("晚安", "#8E9CD6", "#DDE2FA"),
    "refuse": ("拒绝", "#F08A8A", "#FFDCDC"),
    "hug": ("抱抱", "#F3A6C8", "#FFE0EE"),
    "cat": ("猫猫", "#F5C27A", "#FFF0D6"),
    "thanks": ("谢谢", "#8FD3B6", "#DFF6EC"),
    "sad": ("委屈", "#9FB6E8", "#E3EAFB"),
}

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\msyhbd.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
    r"C:\Windows\Fonts\simsun.ttc",
]


def load_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for path in FONT_CANDIDATES:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def rounded_rect(draw: ImageDraw.ImageDraw, box, radius: int, fill: str) -> None:
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def draw_eyes(draw: ImageDraw.ImageDraw, kind: str, cx: int, cy: int) -> None:
    eye_dx, eye_dy = 120 * SCALE // 2, 18 * SCALE // 2
    eye_r = 46 * SCALE // 2
    for sx in (-1, 1):
        ex = cx + sx * eye_dx
        if kind == "sleepy":
            draw.arc(
                [ex - eye_r, cy - eye_r // 2, ex + eye_r, cy + eye_r // 2],
                start=200, end=340, fill="#2B2B2B", width=9 * SCALE // 2,
            )
            continue
        if kind == "happy":
            draw.arc(
                [ex - eye_r, cy - eye_r, ex + eye_r, cy + eye_r // 2],
                start=200, end=340, fill="#2B2B2B", width=10 * SCALE // 2,
            )
            continue
        if kind == "confused":
            draw.line([ex - eye_r, cy - eye_dy, ex + eye_r, cy + eye_dy], fill="#2B2B2B", width=9 * SCALE // 2)
            continue
        draw.ellipse([ex - eye_r, cy - eye_r, ex + eye_r, cy + eye_r], fill="#2B2B2B")
        draw.ellipse(
            [ex - eye_r // 3, cy - eye_r // 2, ex + eye_r // 6, cy],
            fill="#FFFFFF",
        )


def draw_mouth(draw: ImageDraw.ImageDraw, kind: str, cx: int, cy: int) -> None:
    if kind == "happy":
        draw.arc([cx - 90 * SCALE // 2, cy - 30 * SCALE // 2, cx + 90 * SCALE // 2, cy + 80 * SCALE // 2],
                 start=20, end=160, fill="#2B2B2B", width=10 * SCALE // 2)
    elif kind in ("sad", "confused"):
        draw.arc([cx - 80 * SCALE // 2, cy + 10 * SCALE // 2, cx + 80 * SCALE // 2, cy + 110 * SCALE // 2],
                 start=200, end=340, fill="#2B2B2B", width=9 * SCALE // 2)
    elif kind == "sleepy":
        draw.ellipse([cx - 26 * SCALE // 2, cy - 6 * SCALE // 2, cx + 26 * SCALE // 2, cy + 42 * SCALE // 2],
                     fill="#2B2B2B")
    elif kind == "refuse":
        draw.line([cx - 70 * SCALE // 2, cy + 20 * SCALE // 2, cx + 70 * SCALE // 2, cy + 20 * SCALE // 2],
                  fill="#2B2B2B", width=10 * SCALE // 2)
    elif kind == "hug":
        draw.arc([cx - 70 * SCALE // 2, cy - 10 * SCALE // 2, cx + 70 * SCALE // 2, cy + 70 * SCALE // 2],
                 start=20, end=160, fill="#2B2B2B", width=10 * SCALE // 2)
    elif kind == "cat":
        draw.polygon([
            (cx - 26 * SCALE // 2, cy + 18 * SCALE // 2),
            (cx, cy + 40 * SCALE // 2),
            (cx + 26 * SCALE // 2, cy + 18 * SCALE // 2),
        ], fill="#E06A8A")
    else:
        draw.arc([cx - 70 * SCALE // 2, cy - 20 * SCALE // 2, cx + 70 * SCALE // 2, cy + 70 * SCALE // 2],
                 start=20, end=160, fill="#2B2B2B", width=9 * SCALE // 2)


def draw_cat_ears(draw: ImageDraw.ImageDraw, cx: int, cy: int) -> None:
    for sx in (-1, 1):
        base_x = cx + sx * 120 * SCALE // 2
        draw.polygon([
            (base_x - 50 * SCALE // 2, cy - 40 * SCALE // 2),
            (base_x, cy - 150 * SCALE // 2),
            (base_x + 50 * SCALE // 2, cy - 40 * SCALE // 2),
        ], fill="#E8A25C", outline="#B9772E", width=4 * SCALE // 2)


def make_sticker(tag: str, index: int, out_dir: Path) -> Path:
    label, bg, face = TAGS[tag]
    rng = random.Random(f"{tag}-{index}")
    img = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    margin = 26 * SCALE // 2
    rounded_rect(draw, [margin, margin, CANVAS - margin, CANVAS - margin], 90 * SCALE // 2, bg)
    inner = 96 * SCALE // 2
    rounded_rect(draw, [inner, inner, CANVAS - inner, CANVAS - inner], 70 * SCALE // 2, face)

    cx, cy = CANVAS // 2, CANVAS // 2 - 20 * SCALE // 2
    if tag == "cat":
        draw_cat_ears(draw, cx, cy)
    draw_eyes(draw, tag, cx, cy - 30 * SCALE // 2)
    draw_mouth(draw, tag, cx, cy + 60 * SCALE // 2)

    # 腮红
    blush = rng.choice(["#FFB3C1", "#FFC9D6", "#F7A8B8"])
    for sx in (-1, 1):
        ex = cx + sx * 165 * SCALE // 2
        draw.ellipse([ex - 30 * SCALE // 2, cy + 10 * SCALE // 2, ex + 30 * SCALE // 2, cy + 50 * SCALE // 2],
                     fill=blush)

    font = load_font(56 * SCALE // 2)
    bbox = draw.textbbox((0, 0), label, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    tx, ty = (CANVAS - tw) // 2, CANVAS - 130 * SCALE // 2
    draw.text((tx, ty), label, font=font, fill="#3A3A3A",
              stroke_width=3 * SCALE // 2, stroke_fill="#FFFFFF")

    final = img.resize((SIZE, SIZE), Image.LANCZOS)
    tag_dir = out_dir / tag
    tag_dir.mkdir(parents=True, exist_ok=True)
    path = tag_dir / f"{tag}_{index}.png"
    final.save(path, "PNG", optimize=True)
    return path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=str(Path.home() / ".dsh" / "qq-bridge" / "stickers"))
    parser.add_argument("--per-tag", type=int, default=3)
    args = parser.parse_args()

    out_dir = Path(args.out)
    count = 0
    for tag in TAGS:
        for index in range(1, max(1, args.per_tag) + 1):
            make_sticker(tag, index, out_dir)
            count += 1
    print(f"stickers: {count} files -> {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())