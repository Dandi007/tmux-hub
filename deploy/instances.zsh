#!/usr/bin/env zsh
# deploy/instances.zsh — 实例部署薄脚本（双平台）。
#
# 平台拓扑：
#   macOS  ── dogfood(3102, svc tmux-hub-dogfood) + prod(3101, svc tmux-hub)，
#             金丝雀流程：deploy-dogfood 跟 main 头 → 验证 → promote 钉 commit 到 prod
#   Linux  ── NUC 单 prod 实例：systemd user unit `tmux-hub.service` 直跑
#             /data/code/self/tmux-hub，无 dogfood；deploy-prod 拉 main → build → restart
#
# 用法：
#   zsh deploy/instances.zsh deploy-dogfood      # macOS：拉 main 头 → build → restart dogfood
#   zsh deploy/instances.zsh promote [<ref>]     # macOS：dogfood HEAD（或指定 ref）→ prod
#   zsh deploy/instances.zsh deploy-prod         # Linux：拉 origin/main → build → restart prod
set -eu

PLATFORM=$(uname -s)

# ── 路径（环境变量可覆盖）────────────────────────────────────────────────────
# dogfood worktree（跟 origin/main 头，用于验证新代码；仅 macOS）。
DOGFOOD_WT=${TMUX_HUB_DOGFOOD_WT:-$HOME/code/worktrees/tmux-hub/dogfood-live}
# prod worktree。macOS 钉已验证 commit；Linux 即主 checkout。
if [ "$PLATFORM" = "Darwin" ]; then
  PROD_WT=${TMUX_HUB_PROD_WT:-$HOME/code/tmux-hub}
else
  PROD_WT=${TMUX_HUB_PROD_WT:-/data/code/self/tmux-hub}
fi
# ────────────────────────────────────────────────────────────────────────────

_usage() {
  cat <<'USAGE'
用法：
  zsh deploy/instances.zsh deploy-dogfood      macOS：拉 origin/main → build → svc restart tmux-hub-dogfood
  zsh deploy/instances.zsh promote [<ref>]     macOS：将 dogfood HEAD（或指定 ref）checkout 到 prod → build → restart
  zsh deploy/instances.zsh deploy-prod         Linux：拉 origin/main → build → systemctl --user restart tmux-hub.service

环境变量覆盖路径（可选）：
  TMUX_HUB_DOGFOOD_WT=<path>   dogfood worktree（默认 ~/code/worktrees/tmux-hub/dogfood-live，仅 macOS）
  TMUX_HUB_PROD_WT=<path>      prod worktree（macOS 默认 ~/code/tmux-hub；Linux 默认 /data/code/self/tmux-hub）
USAGE
}

_require_darwin() {
  if [ "$PLATFORM" != "Darwin" ]; then
    echo "错误：'$1' 是 macOS 金丝雀流程（本机无 dogfood 实例）。Linux/NUC 请用 deploy-prod。" >&2
    exit 1
  fi
}

_restart_prod() {
  if [ "$PLATFORM" = "Darwin" ]; then
    svc restart tmux-hub
  else
    systemctl --user restart tmux-hub.service
  fi
}

# prod 健康检查地址：优先读 hub.env 的 HOST/PORT（NUC 绑在非 loopback 地址上）。
_prod_health_url() {
  local envf=$HOME/.config/tmux-hub/hub.env
  local host=127.0.0.1 port=3101
  if [ -f "$envf" ]; then
    local h p
    h=$(grep -E '^TMUX_HUB_HOST=' "$envf" | tail -1 | cut -d= -f2- || true)
    p=$(grep -E '^TMUX_HUB_PORT=' "$envf" | tail -1 | cut -d= -f2- || true)
    [ -n "${h:-}" ] && host=$h
    [ -n "${p:-}" ] && port=$p
  fi
  echo "http://$host:$port/system/health"
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
    if [ "$PLATFORM" = "Darwin" ]; then
      echo "✗ $label 健康检查失败（curl 退出码 $?）；请检查 svc logs $label" >&2
    else
      echo "✗ $label 健康检查失败（curl 退出码 $?）；请检查 journalctl --user -u tmux-hub.service" >&2
    fi
    return 1
  fi
}

case "${1:-}" in

  deploy-dogfood)
    _require_darwin deploy-dogfood
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
    _require_darwin promote
    REF=${2:-$(git -C "$DOGFOOD_WT" rev-parse HEAD)}
    echo "=== promote: $REF → prod ==="
    echo "dogfood worktree: $DOGFOOD_WT"
    echo "prod    worktree: $PROD_WT"
    cd "$PROD_WT"
    git fetch origin
    git checkout "$REF"
    bun install --frozen-lockfile
    bun run build
    _restart_prod
    _health_check "$(_prod_health_url)" "tmux-hub"
    echo ""
    echo "promoted $REF → prod"
    ;;

  deploy-prod)
    if [ "$PLATFORM" = "Darwin" ]; then
      echo "错误：macOS 上 prod 只接受 promote 钉已验证 commit（金丝雀流程），不直接 deploy。" >&2
      exit 1
    fi
    echo "=== deploy-prod: 拉 origin/main → build → restart tmux-hub.service ==="
    echo "worktree: $PROD_WT"
    cd "$PROD_WT"
    git pull --ff-only origin main
    bun install --frozen-lockfile
    bun run build
    _restart_prod
    _health_check "$(_prod_health_url)" "tmux-hub"
    echo ""
    echo "prod 部署完成（$(git rev-parse --short HEAD)）。"
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
