# Source only from deploy-dogfood: prod retains its own deployment behavior.
wait_for_dogfood_health() {
  local url=$1 rc
  echo "── 等待 tmux-hub-dogfood 健康 ($url) ──"
  # The service manager can return before Bun binds the listener. Bound both
  # the retry window and each request; do not wait forever on a broken startup.
  if curl -fsS --connect-timeout 2 --max-time 2 \
    --retry 5 --retry-delay 1 --retry-max-time 10 --retry-connrefused "$url"; then
    echo ""
    echo "✓ tmux-hub-dogfood 健康"
  else
    rc=$?
    echo "" >&2
    echo "✗ tmux-hub-dogfood 健康等待失败（curl 退出码 $rc）；请检查服务日志" >&2
    return "$rc"
  fi
}
