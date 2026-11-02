"""生成扩展图标：圆角矩形渐变底 + 白色「译」字，输出 16/32/48/128 四种尺寸。"""
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'icons')
os.makedirs(OUT, exist_ok=True)

S = 512  # 先按大尺寸绘制，再降采样，边缘更干净


def lerp(a, b, t):
    return int(round(a + (b - a) * t))


def make_base():
    """竖向渐变的圆角方块。"""
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    grad = Image.new('RGBA', (S, S))
    d = ImageDraw.Draw(grad)
    top = (74, 158, 232)      # #4A9EE8
    bottom = (30, 88, 162)    # #1E58A2
    for y in range(S):
        t = y / (S - 1)
        d.line([(0, y), (S, y)], fill=(lerp(top[0], bottom[0], t),
                                       lerp(top[1], bottom[1], t),
                                       lerp(top[2], bottom[2], t), 255))
    mask = Image.new('L', (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=255)
    img.paste(grad, (0, 0), mask)
    return img


def load_font(size):
    candidates = [
        r'C:\Windows\Fonts\msyhbd.ttc',
        r'C:\Windows\Fonts\msyh.ttc',
        r'C:\Windows\Fonts\simhei.ttf',
        r'C:\Windows\Fonts\simsun.ttc',
    ]
    for path in candidates:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    return None


def draw_glyph(img):
    """优先画「译」字；中文字体缺失时退回几何图形（对话气泡 + 两横）。"""
    d = ImageDraw.Draw(img)
    font = load_font(int(S * 0.56))

    if font is not None:
        text = '译'
        box = d.textbbox((0, 0), text, font=font)
        w = box[2] - box[0]
        h = box[3] - box[1]
        x = (S - w) / 2 - box[0]
        y = (S - h) / 2 - box[1] - S * 0.015
        # 轻微投影，让字在渐变底上更立体
        d.text((x + S * 0.012, y + S * 0.014), text, font=font, fill=(12, 40, 78, 110))
        d.text((x, y), text, font=font, fill=(255, 255, 255, 255))
        return img

    # 兜底：白色圆角气泡 + 两条横线
    pad = int(S * 0.24)
    d.rounded_rectangle([pad, pad, S - pad, S - pad - int(S * 0.06)],
                        radius=int(S * 0.1), fill=(255, 255, 255, 255))
    bar_w = int(S * 0.28)
    bar_h = int(S * 0.055)
    cx = S // 2
    for i, cy in enumerate((int(S * 0.42), int(S * 0.56))):
        d.rounded_rectangle([cx - bar_w, cy, cx + bar_w, cy + bar_h],
                            radius=bar_h // 2, fill=(45, 110, 185, 255))
    return img


def main():
    base = draw_glyph(make_base())
    for size in (16, 32, 48, 128):
        resized = base.resize((size, size), Image.LANCZOS)
        path = os.path.join(OUT, 'icon%d.png' % size)
        resized.save(path, 'PNG', optimize=True)
        print('写出 %s  %d bytes' % (path, os.path.getsize(path)))


if __name__ == '__main__':
    main()
