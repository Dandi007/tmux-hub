#!/usr/bin/env zsh
# deploy/instances.zsh — 实例部署薄脚本（双平台）。
#
# 平台拓扑：
#   macOS  ── dogfood(3102, svc tmux-hub-dogfood) + prod(3101, svc tmux-hub)，
#             金丝雀流程：deploy-dogfood 跟 main 头 → 验证 → promote 钉 commit 到 prod
#   Linux  ── NUC dogfood(3102, tmux-hub-dogfood.service) + prod(3101, tmux-hub.service)，
#             dogfood 跟 main 头；prod 只部署人类验收过的 `accepted` tag
#             （promote 前移 tag 即验收）。
#
# 用法：
#   zsh deploy/instances.zsh deploy-dogfood      # 拉 main 头 → build → restart dogfood
#   zsh deploy/instances.zsh promote [<ref>]     # macOS：dogfood HEAD（或 ref）→ prod
#                                                # Linux：accepted tag 前移到 ref 并推远端 → deploy-prod
#   zsh deploy/instances.zsh deploy-prod         # Linux：checkout accepted → build → restart prod
#   zsh deploy/instances.zsh drift               # dogfood 领先 accepted 多少、都是什么
set -eu

PLATFORM=$(uname -s)

# ── 路径（环境变量可覆盖）────────────────────────────────────────────────────
# dogfood worktree（跟 origin/main 头，用于验证新代码）。
# prod worktree。macOS 钉已验证 commit；Linux 即主 checkout，钉 accepted tag。
if [ "$PLATFORM" = "Darwin" ]; then
  DOGFOOD_WT=${TMUX_HUB_DOGFOOD_WT:-$HOME/code/worktrees/tmux-hub/dogfood-live}
  PROD_WT=${TMUX_HUB_PROD_WT:-$HOME/code/tmux-hub}
else
  DOGFOOD_WT=${TMUX_HUB_DOGFOOD_WT:-/data/code/worktrees/tmux-hub/dogfood-live}
  PROD_WT=${TMUX_HUB_PROD_WT:-/data/code/self/tmux-hub}
fi
# 人类验收的基线 tag；Linux prod 只从它部署。
ACCEPTED_TAG=accepted
# 每次部署追加一行（时间 实例 commit），供 drift 回答「dogfood 自迭代了几个版本」。
DEPLOY_LOG=${TMUX_HUB_DEPLOY_LOG:-$HOME/.local/state/tmux-hub/deploys.log}
# ────────────────────────────────────────────────────────────────────────────

_usage() {
  cat <<'USAGE'
用法：
  zsh deploy/instances.zsh deploy-dogfood      拉 origin/main → build → restart tmux-hub-dogfood
  zsh deploy/instances.zsh promote [<ref>]     macOS：将 dogfood HEAD（或指定 ref）checkout 到 prod → build → restart
                                               Linux：accepted tag 前移到 dogfood HEAD（或 ref）并推远端 → deploy-prod
  zsh deploy/instances.zsh deploy-prod         Linux：checkout accepted tag → build → systemctl --user restart tmux-hub.service
  zsh deploy/instances.zsh drift               accepted 与 dogfood 的差距（commit 列表 + 期间 dogfood 部署次数）

环境变量覆盖路径（可选）：
  TMUX_HUB_DOGFOOD_WT=<path>   dogfood worktree（macOS 默认 ~/code/worktrees/tmux-hub/dogfood-live；Linux 默认 /data/code/worktrees/tmux-hub/dogfood-live）
  TMUX_HUB_PROD_WT=<path>      prod worktree（macOS 默认 ~/code/tmux-hub；Linux 默认 /data/code/self/tmux-hub）
  TMUX_HUB_DEPLOY_LOG=<path>   部署记录（默认 ~/.local/state/tmux-hub/deploys.log）
USAGE
}

_require_darwin() {
  if [ "$PLATFORM" != "Darwin" ]; then
    echo "错误：'$1' 是 macOS 金丝雀流程（本机无 dogfood 实例）。Linux/NUC 请用 deploy-prod。" >&2
    exit 1
  fi
}

_restart_dogfood() {
  if [ "$PLATFORM" = "Darwin" ]; then
    svc restart tmux-hub-dogfood
  else
    systemctl --user restart tmux-hub-dogfood.service
  fi
}

_restart_prod() {
  if [ "$PLATFORM" = "Darwin" ]; then
    svc restart tmux-hub
  else
    systemctl --user restart tmux-hub.service
  fi
}

# 健康检查地址：优先读 env 文件的 HOST/PORT（NUC 绑在非 loopback 地址上）。
_health_url() {
  local envf=$1
  local host=127.0.0.1 port=$2
  if [ -f "$envf" ]; then
    local h p
    h=$(grep -E '^TMUX_HUB_HOST=' "$envf" | tail -1 | cut -d= -f2- || true)
    p=$(grep -E '^TMUX_HUB_PORT=' "$envf" | tail -1 | cut -d= -f2- || true)
    [ -n "${h:-}" ] && host=$h
    [ -n "${p:-}" ] && port=$p
  fi
  echo "http://$host:$port/system/health"
}
_prod_health_url() { _health_url "$HOME/.config/tmux-hub/hub.env" 3101; }
_dogfood_health_url() { _health_url "$HOME/.config/tmux-hub/dogfood.env" 3102; }

# 健康检查之外再核对进程报告的 commit：防「build 了但跑的还是旧进程」。
_verify_commit() {
  local url=$1 want=$2 got
  got=$(curl -fsS "$url" | sed -n 's/.*"commit":"\([0-9a-f]*\)".*/\1/p')
  if [ "$got" != "$want" ]; then
    echo "✗ 运行中 commit=${got:-（未上报）}，期望 $want" >&2
    return 1
  fi
  echo "✓ 运行中 commit 与部署一致（${want[1,7]}）"
}

_log_deploy() {
  mkdir -p "${DEPLOY_LOG:h}"
  print -r -- "$(date -Iseconds) $1 $2" >> "$DEPLOY_LOG"
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
      echo "✗ $label 健康检查失败（curl 退出码 $?）；请检查 journalctl --user -u $label.service" >&2
    fi
    return 1
  fi
}

case "${1:-}" in

  deploy-dogfood)
    echo "=== deploy-dogfood: 拉 origin/main → build → restart tmux-hub-dogfood ==="
    echo "worktree: $DOGFOOD_WT"
    cd "$DOGFOOD_WT"
    if [ "$PLATFORM" = "Darwin" ]; then
      git pull --ff-only origin main
    else
      # NUC 上 main 不钉在任何 checkout，dogfood 以 detached HEAD 跟 origin/main。
      git fetch origin
      git checkout --detach origin/main
    fi
    bun install --frozen-lockfile
    bun run build
    _restart_dogfood
    _health_check "$(_dogfood_health_url)" "tmux-hub-dogfood"
    if [ "$PLATFORM" != "Darwin" ]; then
      sleep 1
      _verify_commit "$(_dogfood_health_url)" "$(git rev-parse HEAD)"
      _log_deploy dogfood "$(git rev-parse HEAD)"
    fi
    echo ""
    echo "dogfood 部署完成。已验证后请运行 promote 推到 prod。"
    ;;

  promote)
    REF=${2:-$(git -C "$DOGFOOD_WT" rev-parse HEAD)}
    if [ "$PLATFORM" != "Darwin" ]; then
      echo "=== promote: $ACCEPTED_TAG → $REF（人类验收），随后 deploy-prod ==="
      git -C "$PROD_WT" fetch origin
      git -C "$PROD_WT" tag -f "$ACCEPTED_TAG" "$REF"
      git -C "$PROD_WT" push -f origin "refs/tags/$ACCEPTED_TAG"
      exec zsh "$0" deploy-prod
    fi
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
    echo "=== deploy-prod: checkout $ACCEPTED_TAG → build → restart tmux-hub.service ==="
    echo "worktree: $PROD_WT"
    cd "$PROD_WT"
    git fetch --force origin "refs/tags/${ACCEPTED_TAG}:refs/tags/$ACCEPTED_TAG"
    git checkout --detach "$ACCEPTED_TAG"
    bun install --frozen-lockfile
    bun run build
    _restart_prod
    _health_check "$(_prod_health_url)" "tmux-hub"
    sleep 1
    _verify_commit "$(_prod_health_url)" "$(git rev-parse HEAD)"
    _log_deploy prod "$(git rev-parse HEAD)"
    echo ""
    echo "prod 部署完成（$(git rev-parse --short HEAD) = $ACCEPTED_TAG）。"
    ;;

  drift)
    git -C "$PROD_WT" fetch -q --force origin "refs/tags/${ACCEPTED_TAG}:refs/tags/$ACCEPTED_TAG"
    base=$(git -C "$PROD_WT" rev-parse "$ACCEPTED_TAG^{commit}")
    head=$(git -C "$DOGFOOD_WT" rev-parse HEAD)
    n=$(git -C "$PROD_WT" rev-list --count --first-parent "$base..$head")
    echo "accepted ${base[1,7]} → dogfood ${head[1,7]}：领先 $n 个合入"
    if [ -f "$DEPLOY_LOG" ]; then
      since=$(git -C "$PROD_WT" log -1 --format=%cI "$base")
      deploys=$(awk -v s="$since" '$2 == "dogfood" && $1 >= s' "$DEPLOY_LOG" | wc -l)
      echo "期间 dogfood 部署 ${deploys// /} 次"
    fi
    git -C "$PROD_WT" log --first-parent --format='  %h %cs %s' "$base..$head"
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
