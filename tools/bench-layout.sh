#!/usr/bin/env bash
# 布局保真基准运行器
# ------------------------------------------------------------------
# 为什么必须在真实浏览器里跑：这个基准测的全是布局结果 ——
# 元素宽度有没有被挤压、行内级元素高度有没有被撑高、父子关系有没有变。
# jsdom 没有布局引擎，这些量一律取不到。
#
# 用法：bash tools/bench-layout.sh [输出文件]
set -u

OUT="${1:-}"

CHROME="/c/Users/Administrator/AppData/Local/Google/Chrome/Application/chrome.exe"
[ -f "$CHROME" ] || CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
[ -f "$CHROME" ] || { echo "!! 未找到 Chrome"; exit 1; }

HERE="$(cd "$(dirname "$0")" && pwd)"
WINPATH="$(cygpath -m "$HERE" 2>/dev/null || pwd -W)"

# 同 bench.sh：临时 profile 放系统临时目录，避免 5 MB+ 的 .chrome-* 残留在扩展目录里
PROFILE="$(mktemp -d "${TMPDIR:-/tmp}/ct-layout-XXXXXX")"
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
    --window-size=1280,2400 \
    --user-data-dir="$(cygpath -m "$PROFILE" 2>/dev/null || echo "$PROFILE")" \
    --dump-dom \
    "file:///$WINPATH/bench-layout.html" 2>/dev/null
)"
RC=$?
cleanup

# 只取 <pre id="out"> 的内容：标记字符串只出现在真实 DOM 里，脚本源码里没有
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
