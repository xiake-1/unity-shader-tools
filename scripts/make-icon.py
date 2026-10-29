# 生成扩展 icon（256x256 PNG）v3：深色底 + 官方 Unity 2021 立方标 + 「Shader」字样。
# 立方标取自 scripts/assets/unity2021.svg（Wikimedia Commons 上的官方 logo 矢量版，
# 公有领域标记但含商标——见 https://unity.com/legal/branding-trademarks，本扩展为第三方工具，
# 使用官方标需遵守 Unity 商标指引）。脚本只解析立方标部分（x<600 的 path），跳过文字 wordmark。
# 一次性资产脚本：产物 client/images/icon.png 入库（Marketplace 列表图标）。
import math
import os
import re
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(__file__)
S = 256

# ---------- SVG path 解析（M/L/H/V/C 绝对 + m/l/h/v/c 相对 + Z；C 展平为折线） ----------
TOK = re.compile(r"[MmLlHhVvCcZz]|[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?")


def parse_path(d):
    toks = TOK.findall(d)
    subs, cur, i = [], [], 0
    x = y = 0.0
    sx = sy = 0.0
    cmd = None
    while i < len(toks):
        t = toks[i]
        if not t[0].isdigit() and t[0] not in "+-.":
            cmd = t
            i += 1
            if cmd in "Zz":
                if len(cur) > 2:
                    subs.append(cur)
                cur, x, y = [], sx, sy
                continue
        if cmd in ("M", "m"):
            nx, ny = float(toks[i]), float(toks[i + 1])
            i += 2
            if cmd == "m":
                nx, ny = x + nx, y + ny
            if len(cur) > 2:
                subs.append(cur)
            cur = [(nx, ny)]
            x, y, sx, sy, cmd = nx, ny, nx, ny, ("L" if cmd == "M" else "l")
        elif cmd in ("L", "l"):
            nx, ny = float(toks[i]), float(toks[i + 1])
            i += 2
            if cmd == "l":
                nx, ny = x + nx, y + ny
            cur.append((nx, ny))
            x, y = nx, ny
        elif cmd in ("H", "h"):
            nx = float(toks[i])
            i += 1
            if cmd == "h":
                nx += x
            cur.append((nx, y))
            x = nx
        elif cmd in ("V", "v"):
            ny = float(toks[i])
            i += 1
            if cmd == "v":
                ny += y
            cur.append((x, ny))
            y = ny
        elif cmd in ("C", "c"):
            c = [float(v) for v in toks[i : i + 6]]
            i += 6
            if cmd == "c":
                c = [c[0] + x, c[1] + y, c[2] + x, c[3] + y, c[4] + x, c[5] + y]
            x0, y0 = x, y
            for k in range(1, 13):
                t = k / 12.0
                mt = 1 - t
                bx = mt**3 * x0 + 3 * mt * mt * t * c[0] + 3 * mt * t * t * c[2] + t**3 * c[4]
                by = mt**3 * y0 + 3 * mt * mt * t * c[1] + 3 * mt * t * t * c[3] + t**3 * c[5]
                cur.append((bx, by))
            x, y = c[4], c[5]
        else:
            raise ValueError("unsupported svg cmd: " + str(cmd))
    if len(cur) > 2:
        subs.append(cur)
    return subs


svg = open(os.path.join(HERE, "assets", "unity2021.svg"), encoding="utf-8").read()
paths = re.findall(r'<path[^>]*\bd="([^"]+)"', svg)
polys = []
for d in paths:
    subs = parse_path(d)
    xs = [p[0] for s in subs for p in s]
    if not xs or max(xs) > 600:  # wordmark 部分跳过，只留立方标
        continue
    polys.extend(subs)

xs = [p[0] for s in polys for p in s]
ys = [p[1] for s in polys for p in s]
minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
scale = 150.0 / max(maxx - minx, maxy - miny)
ox, oy = 128 - (minx + maxx) / 2 * scale, 104 - (miny + maxy) / 2 * scale


def xf(p):
    return (p[0] * scale + ox, p[1] * scale + oy)


# ---------- 画布 ----------
img = Image.new("RGB", (S, S))
px = img.load()
bg_a, bg_b = (22, 27, 38), (34, 42, 60)
cx0, cy0 = S / 2, S * 0.44
for yy in range(S):
    for xx in range(S):
        dd = math.hypot(xx - cx0, yy - cy0) / (S * 0.75)
        t = max(0.0, 1.0 - dd)
        px[xx, yy] = (
            int(bg_a[0] + (bg_b[0] - bg_a[0]) * t),
            int(bg_a[1] + (bg_b[1] - bg_a[1]) * t),
            int(bg_a[2] + (bg_b[2] - bg_a[2]) * t),
        )

draw = ImageDraw.Draw(img)
for s in polys:
    draw.polygon([xf(p) for p in s], fill=(245, 247, 250))

# ---------- 「Shader」字样 ----------
font = None
for cand in ("arialbd.ttf", "segoeui-bold.ttf", "arial.ttf"):
    p = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts", cand)
    if os.path.exists(p):
        font = ImageFont.truetype(p, 52)
        break
if font is None:
    font = ImageFont.load_default()
text = "Shader"
col = (56, 214, 240)
tb = draw.textbbox((0, 0), text, font=font)
tw, th = tb[2] - tb[0], tb[3] - tb[1]
tx, ty = (S - tw) / 2 - tb[0], 196 - tb[1]
for dx in (-2, 0, 2):
    for dy in (-2, 0, 2):
        if dx or dy:
            draw.text((tx + dx, ty + dy), text, font=font, fill=(10, 14, 22))
draw.text((tx, ty), text, font=font, fill=col)

out = os.path.join(HERE, "..", "client", "images", "icon.png")
os.makedirs(os.path.dirname(out), exist_ok=True)
img.save(out, "PNG")
print("wrote", out, img.size, "| polys:", len(polys))
