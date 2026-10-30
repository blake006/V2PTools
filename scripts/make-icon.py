"""生成 IPHealth 应用图标（build/icon.ico + icon.png）"""
from PIL import Image, ImageDraw
import os

S = 1024
SS = 4  # 超采样
W = S * SS

img = Image.new('RGBA', (W, W), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# 背景：圆角矩形 + 垂直渐变
bg = Image.new('RGBA', (W, W), (0, 0, 0, 0))
bd = ImageDraw.Draw(bg)
for y in range(W):
    t = y / W
    r = int(24 + (12 - 24) * t)
    g = int(30 + (16 - 30) * t)
    b = int(46 + (24 - 46) * t)
    bd.line([(0, y), (W, y)], fill=(r, g, b, 255))
mask = Image.new('L', (W, W), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, W - 1, W - 1], radius=int(W * 0.22), fill=255)
img.paste(bg, (0, 0), mask)

# 顶部高光
glow = Image.new('RGBA', (W, W), (0, 0, 0, 0))
gd = ImageDraw.Draw(glow)
for i in range(int(W * 0.45)):
    a = int(38 * (1 - i / (W * 0.45)))
    gd.ellipse([W * 0.1 - i, -W * 0.5 - i, W * 0.9 + i, W * 0.35 + i], fill=(79, 140, 255, max(0, a)))
img.alpha_composite(Image.composite(glow, Image.new('RGBA', (W, W), (0, 0, 0, 0)), mask))

d = ImageDraw.Draw(img)

# 盾牌
cx, cy = W / 2, W * 0.52
sw, sh = W * 0.46, W * 0.56
top = cy - sh / 2
shield = [
    (cx, top),
    (cx + sw / 2, top + sh * 0.13),
    (cx + sw / 2, top + sh * 0.52),
    (cx, top + sh),
    (cx - sw / 2, top + sh * 0.52),
    (cx - sw / 2, top + sh * 0.13),
]

# 盾牌渐变填充
shield_layer = Image.new('RGBA', (W, W), (0, 0, 0, 0))
sl = ImageDraw.Draw(shield_layer)
for y in range(int(top), int(top + sh) + 1):
    t = (y - top) / sh
    r = int(79 + (34 - 79) * t)
    g = int(140 + (211 - 140) * t)
    b = int(255 + (238 - 255) * t)
    sl.line([(0, y), (W, y)], fill=(r, g, b, 255))
smask = Image.new('L', (W, W), 0)
ImageDraw.Draw(smask).polygon(shield, fill=255)
img.paste(shield_layer, (0, 0), smask)

# 盾牌描边
d.line(shield + [shield[0]], fill=(150, 200, 255, 235), width=int(W * 0.016), joint='curve')

# 对勾
lw = int(W * 0.058)
p1 = (cx - sw * 0.20, cy + sh * 0.02)
p2 = (cx - sw * 0.03, cy + sh * 0.17)
p3 = (cx + sw * 0.22, cy - sh * 0.15)
d.line([p1, p2], fill=(255, 255, 255, 255), width=lw)
d.line([p2, p3], fill=(255, 255, 255, 255), width=lw)
for p in (p1, p2, p3):
    d.ellipse([p[0] - lw / 2, p[1] - lw / 2, p[0] + lw / 2, p[1] + lw / 2], fill=(255, 255, 255, 255))

img = img.resize((S, S), Image.LANCZOS)

os.makedirs('build', exist_ok=True)
img.save('build/icon.png')
img.save('build/icon.ico', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print('icon generated:', os.path.getsize('build/icon.ico'), 'bytes')
