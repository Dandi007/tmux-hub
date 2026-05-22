#!/bin/zsh
set -eu
export PATH="/opt/homebrew/bin:/Users/uther/.bun/bin:/usr/local/bin:/usr/bin:/bin"
ulimit -n 16384

ENV_FILE="${TMUX_HUB_ENV_FILE:-/Users/uther/.config/tmux-hub/hub.env}"
if [ -f "$ENV_FILE" ]; then
  set -a
  . "$ENV_FILE"
  set +a
fi

REPO_DIR="${TMUX_HUB_REPO_DIR:-/Volumes/Data/code/self/tmux-hub}"
cd "$REPO_DIR"

print -r -- "[wrapper] starting tmux-hub at $(date '+%Y-%m-%d %H:%M:%S') from $REPO_DIR"

if [ ! -d "$REPO_DIR/dist/web" ]; then
  print -r -- "[wrapper] dist/web missing, building first"
  bun run build || { print -r -- "[wrapper] build failed"; exit 1; }
fi

set +e
RESTART_COUNT=0
while true; do
  START_TS=$(date +%s)
  bun run start
  RC=$?
  END_TS=$(date +%s)
  RAN=$((END_TS - START_TS))

  if [ "$RC" = "0" ] || [ "$RC" = "143" ] || [ "$RC" = "130" ]; then
    print -r -- "[wrapper] hub exited cleanly (rc=$RC, ran=${RAN}s); stopping supervisor"
    break
  fi

  if [ "$RAN" -lt 10 ]; then
    RESTART_COUNT=$((RESTART_COUNT + 1))
  else
    RESTART_COUNT=0
  fi

  if [ "$RESTART_COUNT" -ge 5 ]; then
    print -r -- "[wrapper] 5 consecutive fast crashes (rc=$RC), giving up"
    exit 1
  fi

  print -r -- "[wrapper] hub crashed (rc=$RC, ran=${RAN}s); restarting in 2s"
  sleep 2
done
