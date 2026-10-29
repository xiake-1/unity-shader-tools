# 生成扩展 icon（256x256 PNG）v2：深色底 + Unity 风格圆环三弦 Y 标 + 「Shader」字样。
# 一次性资产脚本：产物 client/images/icon.png 入库（Marketplace 列表图标）。
# v1（着色球）保留在 git 历史里。
import math
import os
from PIL import Image, ImageDraw, ImageFont

S = 256
img = Image.new("RGB", (S, S))
px = img.load()

# 背景：深色 + 轻微径向提亮
bg_a, bg_b = (22, 27, 38), (34, 42, 60)
cx0, cy0 = S / 2, S * 0.44
for y in range(S):
    for x in range(S):
        d = math.hypot(x - cx0, y - cy0) / (S * 0.75)
        t = max(0.0, 1.0 - d)
        px[x, y] = (
            int(bg_a[0] + (bg_b[0] - bg_a[0]) * t),
            int(bg_a[1] + (bg_b[1] - bg_a[1]) * t),
            int(bg_a[2] + (bg_b[2] - bg_a[2]) * t),
        )

draw = ImageDraw.Draw(img)

# Unity 风格标记：圆环 + 字母 Y 三弦（两臂向上、一臂向下），臂端留缺口不触环
# （和平标志的读法来自「臂触环 + 一臂向上」，Unity 标是 Y 形 + 缺口）
MCX, MCY, MR = 128, 104, 66
ring = 11
draw.ellipse([MCX - MR, MCY - MR, MCX + MR, MCY + MR], outline=(245, 247, 250), width=ring)
arm = 15
tip = 0.82  # 臂端停在环内 82% 半径处，留可见缺口


def cap(x, y, r, color):
    draw.ellipse([x - r, y - r, x + r, y + r], fill=color)


for ang in (-150, -30, 90):  # 左上、右上、下（字母 Y）
    a = math.radians(ang)
    ex, ey = MCX + MR * tip * math.cos(a), MCY + MR * tip * math.sin(a)
    draw.line([MCX, MCY, ex, ey], fill=(245, 247, 250), width=arm)
    cap(ex, ey, arm / 2 - 1, (245, 247, 250))
cap(MCX, MCY, arm / 2 + 2, (245, 247, 250))  # 中心圆帽，让三臂衔接圆润

# 前景：「Shader」字样（青色，粗体）
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
# 深色描边保证小尺寸可读
for dx in (-2, 0, 2):
    for dy in (-2, 0, 2):
        if dx or dy:
            draw.text((tx + dx, ty + dy), text, font=font, fill=(10, 14, 22))
draw.text((tx, ty), text, font=font, fill=col)

out = os.path.join(os.path.dirname(__file__), "..", "client", "images", "icon.png")
os.makedirs(os.path.dirname(out), exist_ok=True)
img.save(out, "PNG")
print("wrote", out, img.size)
