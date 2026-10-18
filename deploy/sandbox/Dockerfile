# hub-sandbox 镜像（docs/specs/002-sandbox-instance.md）。
# 构建上下文由 `instances.zsh deploy-sandbox` 组装：
#   app/      ← git archive <ref> 的 tmux-hub 源码
#   sandbox/  ← 本目录
#   bin/      ← 宿主的 bun、claude 二进制（与宿主同版本，构建时不再下载）
FROM debian:trixie-slim

# 构建期走宿主 mihomo（--network host）；不进最终镜像的 ENV。
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG TMUX_HUB_COMMIT=unknown

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tmux git curl ca-certificates procps less vim-tiny jq ripgrep python3 unzip \
 && rm -rf /var/lib/apt/lists/*

# hub 跑 tmux-hub、持有 GATE_INJECT_KEY；agent 跑 tmux server 与所有 pane。
# /home/agent 0711：hub 需要能 stat 模板 cwd（/home/agent/work），但读不了 agent 的文件。
RUN groupadd -g 1001 hub && useradd -u 1001 -g hub -M -d /var/lib/hub -s /usr/sbin/nologin hub \
 && groupadd -g 1002 agent && useradd -u 1002 -g agent -m -s /bin/bash agent \
 && chmod 0711 /home/agent && install -d -o agent -g agent -m 0755 /home/agent/work \
 && install -d -o hub -g hub -m 0700 /var/lib/hub \
 && install -d -o hub -g agent -m 2770 /var/log/hub-panes

COPY bin/bun bin/claude /usr/local/bin/

WORKDIR /opt/tmux-hub
COPY app/ ./
RUN bun install --frozen-lockfile && bun run build

COPY sandbox/entrypoint.sh /usr/local/sbin/entrypoint.sh
COPY sandbox/templates.yaml /etc/tmux-hub/templates.yaml

ENV LANG=C.UTF-8 \
    TMUX_HUB_COMMIT=${TMUX_HUB_COMMIT}

ENTRYPOINT ["/usr/local/sbin/entrypoint.sh"]
