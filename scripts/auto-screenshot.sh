#!/usr/bin/env bash
# 自动化 UI before/after 截图对比
#
# 用法: bash scripts/auto-screenshot.sh [base-branch]
#   默认 base-branch = main
#
# 流程：
#   1. 记录当前分支
#   2. 切到 base-branch，启动 dev server，截图 → screenshots/before/
#   3. 切回 feature 分支，重启 dev server，截图 → screenshots/after/
#   4. 生成对比说明
#
# 前提：本机有 tmux 在跑（否则 session 列表为空）
set -euo pipefail

BASE=${1:-main}
FEATURE=$(git rev-parse --abbrev-ref HEAD)
PORT=3199
DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [ "$FEATURE" = "$BASE" ]; then
  echo "当前已在 $BASE 分支，请切到 feature 分支后再运行"
  exit 1
fi

cleanup() {
  if [ -n "${SERVER_PID:-}" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

take_shots() {
  local label=$1
  echo ">>> 截图: $label (port $PORT)"
  mkdir -p "$DIR/screenshots/$label"

  cd "$DIR"
  TMUX_HUB_PORT=$PORT TMUX_HUB_DEV_BIND_SECRET=1 bun run start &
  SERVER_PID=$!

  for i in $(seq 1 20); do
    if curl -sf "http://127.0.0.1:$PORT/system/health" >/dev/null 2>&1; then
      break
    fi
    sleep 0.5
  done

  SHOT_DIR="$label" SHOT_PORT="$PORT" \
    npx playwright test scripts/screenshot-compare.ts \
    --config scripts/screenshot-compare.config.ts 2>&1 || true

  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
  SERVER_PID=""
}

echo "=== UI Screenshot Compare ==="
echo "Base: $BASE"
echo "Feature: $FEATURE"
echo ""

echo "--- Step 1: 截图 $BASE ---"
git stash --include-untracked -q 2>/dev/null || true
git checkout "$BASE" -q
bun install --frozen-lockfile 2>/dev/null || bun install 2>/dev/null
bun run build 2>/dev/null
take_shots "before"

echo "--- Step 2: 截图 $FEATURE ---"
git checkout "$FEATURE" -q
git stash pop -q 2>/dev/null || true
bun install --frozen-lockfile 2>/dev/null || bun install 2>/dev/null
bun run build 2>/dev/null
take_shots "after"

echo ""
echo "截图完成！"
echo "  before: $DIR/screenshots/before/"
echo "  after:  $DIR/screenshots/after/"
echo ""
echo "对比方式："
echo "  macOS:       open screenshots/before/desktop-full.png screenshots/after/desktop-full.png"
echo "  ImageMagick: compare screenshots/before/desktop-full.png screenshots/after/desktop-full.png screenshots/diff-desktop.png"
