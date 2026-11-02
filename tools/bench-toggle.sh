#!/usr/bin/env bash
# 页内开关性能预算基准运行器
# ------------------------------------------------------------------
# 量的是新控件自身的成本与布局中立性（PRD 守门指标 G9）。
# 必须在真实浏览器里跑：jsdom 没有布局引擎，「挂载后正文区高度没变」
# 这句话在 jsdom 里恒真 —— 恒真的断言等于没有断言。
#
# 用法：bash tools/bench-toggle.sh [输出文件]
set -u

OUT="${1:-}"

CHROME="/c/Users/Administrator/AppData/Local/Google/Chrome/Application/chrome.exe"
[ -f "$CHROME" ] || CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
[ -f "$CHROME" ] || { echo "!! 未找到 Chrome"; exit 1; }

HERE="$(cd "$(dirname "$0")" && pwd)"
WINPATH="$(cygpath -m "$HERE" 2>/dev/null || pwd -W)"

# 同 bench.sh / bench-layout.sh：临时 profile 放系统临时目录，
# 避免 5 MB+ 的 .chrome-* 残留在扩展目录里被一起打进 .crx
PROFILE="$(mktemp -d "${TMPDIR:-/tmp}/ct-toggle-XXXXXX")"
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
    --window-size=1280,900 \
    --user-data-dir="$(cygpath -m "$PROFILE" 2>/dev/null || echo "$PROFILE")" \
    --dump-dom \
    "file:///$WINPATH/bench-toggle.html" 2>/dev/null
)"
RC=$?
cleanup

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
