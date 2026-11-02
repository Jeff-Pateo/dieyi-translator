#!/usr/bin/env bash
# 叠译 · 发布打包脚本（include-list 固化）
# ------------------------------------------------------------------
# 为什么必须用脚本而不是人肉压缩：
#   仓库里的 tools/（6.3MB 测试基建）、docs/、README.md.bak、bench-*.json、
#   dist/ 自身都是开发资产，进包就是泄漏内部实现 + 白占用户体积。
#   本脚本的清单 = manifest.json 实际引用的目录 + README，白名单制：
#   **新增目录默认不进包**，要进包必须改这里并说明原因（上线评审会 2026-09-29 决议第 4 条）。
#
# 用法：
#   bash tools/package.sh [版本号]     # 缺省从 manifest.json 读
# 产物：
#   dist/dieyi-<版本>-beta.zip         # 内测包（解压后「加载已解压的扩展程序」）
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
cd "$ROOT"

VERSION="$(python -c "import json;print(json.load(open('manifest.json'))['version'])")"
[ $# -ge 1 ] && VERSION="$1"

python "tools/_package_impl.py" "$VERSION"
