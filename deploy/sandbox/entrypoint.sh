#!/bin/bash
# hub-sandbox 入口：root 只做两件事——按用户拆环境变量、降权启动 tmux server（agent）
# 与 tmux-hub（hub）。容器只给了 SETUID/SETGID 两个 capability，降权后即清空。
set -euo pipefail

SOCK_DIR=/run/tmux-sandbox
SOCK=$SOCK_DIR/default
AGENT_PATH=/home/agent/.local/bin:/usr/local/bin:/usr/bin:/bin

# agent 只拿到运行 pane 所需的变量：Claude token 与代理。GATE_*/TMUX_HUB_* 一律不给。
as_agent() {
  setpriv --reuid=agent --regid=agent --init-groups --inh-caps=-all -- \
    env -i HOME=/home/agent USER=agent LOGNAME=agent SHELL=/bin/bash PATH="$AGENT_PATH" \
      LANG=C.UTF-8 TERM=xterm-256color \
      HTTP_PROXY="$SANDBOX_PROXY" HTTPS_PROXY="$SANDBOX_PROXY" \
      http_proxy="$SANDBOX_PROXY" https_proxy="$SANDBOX_PROXY" \
      NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost \
      CLAUDE_CODE_OAUTH_TOKEN="${CLAUDE_CODE_OAUTH_TOKEN:-}" DISABLE_AUTOUPDATER=1 \
      "$@"
}

# hub 只拿 TMUX_HUB_* / GATE_*（含 GATE_INJECT_KEY），不拿 Claude token。
# DEV_BIND_SECRET 一律丢弃：开着它，未鉴权的 /system/auth-check 会把 hub secret 交给 pane 里的 agent（#150）。
hub_env=(HOME=/var/lib/hub USER=hub PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8
         TMUX_HUB_SOCKET_PATH="$SOCK")
for v in $(compgen -e); do
  case $v in TMUX_HUB_SOCKET|TMUX_HUB_SOCKET_PATH|TMUX_HUB_DEV_BIND_SECRET) ;; TMUX_HUB_*|GATE_*) hub_env+=("$v=${!v}") ;; esac
done
if [ -n "${TMUX_HUB_DEV_BIND_SECRET:-}" ]; then echo "warning: ignoring TMUX_HUB_DEV_BIND_SECRET in hub-sandbox" >&2; fi

# -N：server 不在时不要顺手拉起一个（show 会自启 server 并立刻退出、返回成功）。
tmux_alive() { as_agent tmux -N -S "$SOCK" show -g exit-empty >/dev/null 2>&1; }

# SOCK_DIR 是 setgid=hub 的 tmpfs，socket 建出来即属 hub 组；hub 自己无写权限，
# 因此 agent 的 server 挂掉时 hub 也无法以 hub 身份另起一个 server。
start_tmux() {
  as_agent tmux -S "$SOCK" start-server \; set -g exit-empty off
  as_agent tmux -S "$SOCK" server-access -a hub
  as_agent chmod 0660 "$SOCK"
}

start_tmux
# umask 0002：hub 预建的 pane 日志要让 agent（setgid 目录下同组）可追加，
# 否则 hub 抢先 touch 时 pipe-pane 写不进去，浏览器收不到输出。
(umask 0002; exec setpriv --reuid=hub --regid=hub --init-groups --inh-caps=-all -- \
  env -i "${hub_env[@]}" bun run /opt/tmux-hub/src/server/main.ts) &
hub_pid=$!

# root 没有 CAP_KILL，不能直接给 hub/agent 的进程发信号：降权成属主再发，存活看 /proc。
as_hub() { setpriv --reuid=hub --regid=hub --init-groups --inh-caps=-all -- "$@"; }
trap 'as_hub kill -TERM "$hub_pid" 2>/dev/null; as_agent tmux -S "$SOCK" kill-server 2>/dev/null; exit 0' TERM INT

# hub 退出 → 容器退出，交给 restart 策略；tmux server 被 pane 里的进程杀掉 → 原地拉起。
while [ -d "/proc/$hub_pid" ]; do
  tmux_alive || { echo "tmux server gone, restarting" >&2; start_tmux; }
  sleep 5 & wait $! || true
done
wait "$hub_pid"
