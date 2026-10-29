# 生成扩展 icon（256x256 PNG）：深色底 + 青→品红渐变着色球 + 高亮与经纬线。
# 一次性资产脚本：产物 client/images/icon.png 入库（Marketplace 列表图标）。
import math
from PIL import Image, ImageDraw

S = 256
img = Image.new("RGB", (S, S))
px = img.load()

# 背景：深色 + 轻微径向提亮
bg_a, bg_b = (22, 27, 38), (34, 42, 60)
cx0, cy0 = S / 2, S * 0.46
for y in range(S):
    for x in range(S):
        d = math.hypot(x - cx0, y - cy0) / (S * 0.75)
        t = max(0.0, 1.0 - d)
        r = int(bg_a[0] + (bg_b[0] - bg_a[0]) * t)
        g = int(bg_a[1] + (bg_b[1] - bg_a[1]) * t)
        b = int(bg_a[2] + (bg_b[2] - bg_a[2]) * t)
        px[x, y] = (r, g, b)

# 着色球：中心 (128,120)，半径 78；颜色 = 水平渐变（青→品红），亮度 = 球面光照
R, BCX, BCY = 78, 128, 120
c1, c2 = (34, 211, 238), (232, 121, 249)  # cyan → fuchsia
lx, ly, lz = -0.55, -0.60, 0.58  # 光源方向（左上前方）
ln = math.sqrt(lx * lx + ly * ly + lz * lz)
lx, ly, lz = lx / ln, ly / ln, lz / ln
for y in range(BCY - R, BCY + R + 1):
    for x in range(BCX - R, BCX + R + 1):
        dx, dy = (x - BCX) / R, (y - BCY) / R
        d2 = dx * dx + dy * dy
        if d2 > 1.0:
            continue
        dz = math.sqrt(1.0 - d2)
        t = (dx + 1.0) / 2.0  # 水平渐变参数
        cr = c1[0] + (c2[0] - c1[0]) * t
        cg = c1[1] + (c2[1] - c1[1]) * t
        cb = c1[2] + (c2[2] - c1[2]) * t
        diff = max(0.0, dx * lx + dy * ly + dz * lz)
        shade = 0.32 + 0.68 * diff
        # 边缘压暗（菲涅尔近似）
        fres = 0.75 + 0.25 * dz
        r = min(255, int(cr * shade * fres))
        g = min(255, int(cg * shade * fres))
        b = min(255, int(cb * shade * fres))
        # 镜面高光
        spec = max(0.0, dz * 2 - 1.0)
        hx, hy = dx + 0.42, dy + 0.45
        h = math.exp(-(hx * hx + hy * hy) * 9.0) * 120 * dz
        r = min(255, int(r + h))
        g = min(255, int(g + h))
        b = min(255, int(b + h))
        px[x, y] = (r, g, b)

draw = ImageDraw.Draw(img)
# 经纬线（着色器球体的暗示）：两条纬线 + 一条中央经线，低对比
for k in (-0.45, 0.45):
    ry = BCY + k * R
    rx = math.sqrt(max(0.0, 1 - k * k)) * R
    draw.ellipse([BCX - rx, ry - rx * 0.16, BCX + rx, ry + rx * 0.16], outline=(255, 255, 255, 40), width=2)
draw.ellipse([BCX - R * 0.28, BCY - R, BCX + R * 0.28, BCY + R], outline=(255, 255, 255, 36), width=2)

# 底部接地阴影
sh = Image.new("RGBA", (S, S), (0, 0, 0, 0))
ImageDraw.Draw(sh).ellipse([BCX - R * 0.9, BCY + R * 1.02, BCX + R * 0.9, BCY + R * 1.28], fill=(0, 0, 0, 70))
img = Image.alpha_composite(img.convert("RGBA"), sh).convert("RGB")

import os
os.makedirs(os.path.join(os.path.dirname(__file__), "..", "client", "images"), exist_ok=True)
out = os.path.join(os.path.dirname(__file__), "..", "client", "images", "icon.png")
img.save(out, "PNG")
print("wrote", out, img.size)
