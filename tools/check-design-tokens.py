#!/usr/bin/env python3
"""检查界面样式的间距 / 圆角 / 字号是否全部来自刻度 token。

背景：UI 规范要求「间距必须遵循一致的比例刻度」。只靠人眼审一遍不算验证 ——
换个值、加一条样式，很容易又滑回 13px / 18px / 7px 这种随手值。
所以把判据写成可执行的形式：样式表里除 token 之外，不允许出现裸像素间距。

用法：
    python tools/check-design-tokens.py

退出码 0 表示全部通过；1 表示有未走 token 的值（会逐条列出）。
"""

import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SPACING = [
    'gap', 'row-gap', 'column-gap',
    'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
]
RADIUS = [
    'border-radius', 'border-top-left-radius', 'border-top-right-radius',
    'border-bottom-left-radius', 'border-bottom-right-radius',
]
FONT = ['font-size']

# (相对路径, 查间距, 查圆角, 查字号)
TARGETS = [
    ('popup/popup.css', True, True, False),
    ('options/options.css', True, True, False),
    ('docs/布局保全设计说明.html', True, True, True),
]


def read_css(path):
    """从 CSS 文件或 HTML 里取出样式文本，并剥掉注释。"""
    text = open(path, encoding='utf-8').read()
    m = re.search(r'<style>(.*?)</style>', text, re.S)
    css = m.group(1) if m else text
    return re.sub(r'/\*.*?\*/', '', css, flags=re.S)


def raw_px(css, props):
    """返回所有「没走 var(--*) 却带 px」的声明（去重排序）。"""
    pattern = '|'.join(sorted(props, key=len, reverse=True))
    hits = []
    for m in re.finditer(r'(?:^|[;{\s])(' + pattern + r')\s*:\s*([^;}{]+)', css):
        value = m.group(2).strip()
        if 'var(--' in value:
            continue
        if re.search(r'(?<![\w.\-])\d+(?:\.\d+)?px', value):
            hits.append('%s: %s' % (m.group(1), value))
    return sorted(set(hits))


def main():
    failed = 0
    for rel, do_spacing, do_radius, do_font in TARGETS:
        full = os.path.join(ROOT, rel)
        if not os.path.exists(full):
            print('✗ 找不到 %s' % rel)
            failed = 1
            continue

        css = read_css(full)
        print('── %s' % rel)

        checks = []
        if do_spacing:
            checks.append(('间距', SPACING))
        if do_radius:
            checks.append(('圆角', RADIUS))
        if do_font:
            checks.append(('字号', FONT))

        for label, props in checks:
            bad = raw_px(css, props)
            if bad:
                failed = 1
                print('   ✗ %s：%d 处未走 token' % (label, len(bad)))
                for item in bad:
                    print('       %s' % item)
            else:
                print('   ✔ %s：全部来自 token' % label)

    print()
    if failed:
        print('结果：存在未走刻度 token 的样式值 ✗')
    else:
        print('结果：间距 / 圆角 / 字号全部来自刻度 token ✔')
    return failed


if __name__ == '__main__':
    sys.exit(main())
