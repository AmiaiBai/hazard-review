# -*- coding: utf-8 -*-
"""把现场图再压一轮：900px/q76 → 720px/q72，文件名不变。"""
import os, glob
from PIL import Image

IMG_DIR = r"D:\Project\AI眼镜\hazard-review\data\images"
MAX_W = 720
Q = 72

files = sorted(glob.glob(os.path.join(IMG_DIR, "*.jpg")))
before = sum(os.path.getsize(f) for f in files)
done = 0
for f in files:
    try:
        im = Image.open(f).convert("RGB")
        if im.width > MAX_W:
            im = im.resize((MAX_W, int(im.height * MAX_W / im.width)), Image.LANCZOS)
        im.save(f, "JPEG", quality=Q, optimize=True, progressive=True)
        done += 1
    except Exception as e:
        print("失败", os.path.basename(f), e)
after = sum(os.path.getsize(f) for f in files)
print(f"压缩完成 {done}/{len(files)} 张")
print(f"总体积 {before/1024/1024:.1f}MB → {after/1024/1024:.1f}MB （-{(1-after/before)*100:.0f}%）")
print(f"单张平均 {after/len(files)/1024:.0f}KB")
