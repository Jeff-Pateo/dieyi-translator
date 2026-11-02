#!/usr/bin/env bash
# 真实 Chrome 性能基准运行器
# ------------------------------------------------------------------
# 为什么不用 jsdom：jsdom 没有布局引擎，innerText 在其中退化为 textContent，
# 而「强制重排」恰恰是本次优化的主要目标，必须在真实浏览器里测量。
#
# 用法：bash tools/bench.sh [块数] [输出文件]
#   bash tools/bench.sh 800
#   bash tools/bench.sh 2500 baseline.json
set -u

N="${1:-800}"
OUT="${2:-}"

CHROME="/c/Users/Administrator/AppData/Local/Google/Chrome/Application/chrome.exe"
[ -f "$CHROME" ] || CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
[ -f "$CHROME" ] || { echo "!! 未找到 Chrome"; exit 1; }

HERE="$(cd "$(dirname "$0")" && pwd)"
WINPATH="$(cygpath -m "$HERE" 2>/dev/null || pwd -W)"

# 临时 profile 必须放在系统临时目录，不能放在扩展目录里 ——
# Chrome 退出时会异步写盘，脚本里的 rm -rf 常常删不干净（Windows 上尤其明显），
# 留下的 .chrome-* 目录有 5 MB 以上，一旦被「打包扩展」带上就进了发布产物。
PROFILE="$(mktemp -d "${TMPDIR:-/tmp}/ct-bench-XXXXXX")"
cleanup() { rm -rf "$PROFILE" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

RAW="$(
  "$CHROME" \
    --headless=new \
    --disable-gpu \
    --no-first-run \
    --no-default-browser-check \
    --disable-extensions \
    --allow-file-access-from-files \
    --user-data-dir="$(cygpath -m "$PROFILE" 2>/dev/null || echo "$PROFILE")" \
    --dump-dom \
    "file:///$WINPATH/bench.html?n=$N" 2>/dev/null
)"
RC=$?
cleanup

# 只取 <pre id="out"> 的内容：页面在测量结束后会删掉合成 DOM，只留下这一块
JSON="$(printf '%s' "$RAW" | tr -d '\r\n' | sed -n 's/.*<pre id="out">\(.*\)<\/pre>.*/\1/p')"

if [ -z "$JSON" ]; then
  echo "!! 未取到基准数据（Chrome exit=$RC）。原始输出前 30 行："
  printf '%s\n' "$RAW" | head -30
  exit 1
fi

if [ -n "$OUT" ]; then
  printf '%s' "$JSON" > "$OUT"
  echo "已写入 $OUT"
fi
printf '%s' "$JSON"
