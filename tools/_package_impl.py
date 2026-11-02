# -*- coding: utf-8 -*-
"""
叠译打包实现（由 tools/package.sh 调用）
白名单制：manifest.json 实际引用的目录 + README；新增目录默认不进包。
"""
import json, os, sys, zipfile

VERSION = sys.argv[1] if len(sys.argv) > 1 else None
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)

m = json.load(open('manifest.json', encoding='utf-8'))
if not VERSION:
    VERSION = m['version']

# ---- 打包前自检：manifest 引用的文件必须全部存在 ----
missing = []
files = (list(m['icons'].values()) + list(m['action']['default_icon'].values())
         + [m['action']['default_popup'], m['options_page'], m['background']['service_worker']]
         + m['content_scripts'][0]['js'] + m['content_scripts'][0]['css'])
files += [r for r in m['web_accessible_resources'][0]['resources'] if '*' not in r]
for f in files:
    if not os.path.isfile(f.replace('/', os.sep)):
        missing.append(f)
if missing:
    print('!! manifest 引用缺失：', missing)
    sys.exit(1)
print('manifest 引用自检通过（%d 个文件）' % len(files))

# ---- 白名单（与 manifest.json 引用一一对应；新增目录须过评审） ----
INCLUDE = ['manifest.json', 'README.md', 'background', 'content', 'shared',
           'options', 'popup', 'pdf', 'icons']
# 排除开发残留（白名单目录内也可能混入杂物，二次兜底）
EXCLUDE_SUFFIX = ('.bak', '.log', '.map', '.md')
EXCLUDE_PART = ('.chrome-',)

out_dir = os.path.join(ROOT, 'dist')
os.makedirs(out_dir, exist_ok=True)
out = os.path.join(out_dir, 'dieyi-%s-beta.zip' % VERSION)
if os.path.exists(out):
    os.remove(out)

count = 0
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for item in INCLUDE:
        p = item.replace('/', os.sep)
        if os.path.isfile(p):
            z.write(p, item)
            count += 1
            continue
        for dirpath, dirnames, filenames in os.walk(p):
            for fn in sorted(filenames):
                if fn.endswith(EXCLUDE_SUFFIX):
                    continue
                if any(part in fn or part in dirpath for part in EXCLUDE_PART):
                    continue
                full = os.path.join(dirpath, fn)
                arc = os.path.relpath(full, '.').replace(os.sep, '/')
                z.write(full, arc)
                count += 1

# ---- 包内容核验：开发资产不许出现 ----
bad = []
size = 0
with zipfile.ZipFile(out) as z:
    for info in z.infolist():
        size += info.file_size
        n = info.filename
        # README.md 是白名单有意包含的（商店审核会看）；其余 .md/.bak 等都是泄漏
        if n == 'README.md':
            continue
        if n.startswith(('tools/', 'docs/', 'dist/')) or n.endswith(EXCLUDE_SUFFIX) \
                or 'bench-' in n or '.chrome-' in n:
            bad.append(n)

if bad:
    print('!! 开发资产漏进包了：', bad[:10])
    sys.exit(1)

print('✓ 内测包已产出: dist/dieyi-%s-beta.zip' % VERSION)
print('  条目 %d 个，解压后约 %.2f MB' % (count, size / 1024 / 1024))
print('  安装：Chrome → chrome://extensions → 开发者模式 → 加载已解压的扩展程序')
