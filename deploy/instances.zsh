#!/usr/bin/env zsh
# deploy/instances.zsh — dogfood 与 prod 双实例管理薄脚本。
#
# 用法：
#   zsh deploy/instances.zsh deploy-dogfood      # 拉 main 头 → build → restart dogfood
#   zsh deploy/instances.zsh promote [<ref>]     # dogfood HEAD（或指定 ref）→ build → restart prod
#
# 在使用前修改下方两个常量（worktree 的绝对路径）：
set -eu

# ── 用户配置（修改为本机实际路径）──────────────────────────────────────────
# dogfood worktree（跟 origin/main 头，用于验证新代码）。
DOGFOOD_WT=${TMUX_HUB_DOGFOOD_WT:-$HOME/code/worktrees/tmux-hub/dogfood-live}
# prod worktree（钉已验证 commit，生产流量入口）。
PROD_WT=${TMUX_HUB_PROD_WT:-$HOME/code/tmux-hub}
# ────────────────────────────────────────────────────────────────────────────

_usage() {
  cat <<'USAGE'
用法：
  zsh deploy/instances.zsh deploy-dogfood      拉 origin/main → build → svc restart tmux-hub-dogfood
  zsh deploy/instances.zsh promote [<ref>]     将 dogfood HEAD（或指定 ref）checkout 到 prod → build → restart

环境变量覆盖 worktree 路径（可选）：
  TMUX_HUB_DOGFOOD_WT=<path>   dogfood worktree（默认 ~/code/worktrees/tmux-hub/dogfood-live）
  TMUX_HUB_PROD_WT=<path>      prod worktree（默认 ~/code/tmux-hub）
USAGE
}

_health_check() {
  local url=$1
  local label=$2
  echo "── 健康检查 $label ($url) ──"
  if curl -fsS "$url"; then
    echo ""
    echo "✓ $label 健康"
  else
    echo ""
    echo "✗ $label 健康检查失败（curl 退出码 $?）；请检查 svc logs $label" >&2
    return 1
  fi
}

case "${1:-}" in

  deploy-dogfood)
    echo "=== deploy-dogfood: 拉 origin/main → build → restart tmux-hub-dogfood ==="
    echo "worktree: $DOGFOOD_WT"
    cd "$DOGFOOD_WT"
    git pull --ff-only origin main
    bun install --frozen-lockfile
    bun run build
    svc restart tmux-hub-dogfood
    _health_check "http://127.0.0.1:3102/system/health" "tmux-hub-dogfood"
    echo ""
    echo "dogfood 部署完成。已验证后请运行 promote 推到 prod。"
    ;;

  promote)
    REF=${2:-$(git -C "$DOGFOOD_WT" rev-parse HEAD)}
    echo "=== promote: $REF → prod ==="
    echo "dogfood worktree: $DOGFOOD_WT"
    echo "prod    worktree: $PROD_WT"
    cd "$PROD_WT"
    git fetch origin
    git checkout "$REF"
    bun install --frozen-lockfile
    bun run build
    svc restart tmux-hub
    _health_check "http://127.0.0.1:3101/system/health" "tmux-hub"
    echo ""
    echo "promoted $REF → prod"
    ;;

  help|--help|-h)
    _usage
    ;;

  *)
    echo "错误：未知子命令 '${1:-（空）}'" >&2
    echo "" >&2
    _usage >&2
    exit 1
    ;;

esac
