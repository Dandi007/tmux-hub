# 002 · hub-sandbox：Docker 隔离的 tmux-hub 实例

> 状态：草案，待评审（2026-10-18）
> 关联改动：tmux-hub（本 PR）· proxy-infra（mihomo listener）· edge-gateway（Caddy 站点 + gate-id app）

---

## 1 需求

### 1.1 背景

NUC 上现有两个 tmux-hub 实例：`hub`（prod，3101）和 `hub-dogfood`（3102）。两者都以宿主用户 `uther` 运行，每个 pane 都是 `uther` 的 shell。`uther` 属于 `sudo` 和 `docker` 组，所以从这两个实例开出的 pane 实际上等于宿主 root。

### 1.2 目标

新增第三个实例 `hub-sandbox`，满足：

1. **使用者**：仅限本人。用独立的 gate-id 账号登录，用本人的 Claude 账号跑 Claude Code。不提供给他人使用（受 Claude 消费者条款约束，见 §7）。
2. **隔离**：pane 里的进程（包括开了 bypass permissions 的 agent）碰不到宿主文件系统、宿主凭证、`docker.sock`，也碰不到局域网、tailnet 和宿主上的其他服务。
3. **出网**：所有出网流量只能经过 mihomo，由 mihomo 统一分流：国内直连，境外和 AI 走现有的选择组（当前为 `日本-TY-4-AT`）。
4. **入口**：`https://hub-sandbox.qinglinzhang.top`，复用现有的 Caddy `gated` 和 gate-id 鉴权。

### 1.3 非目标

- 不做多租户，也不为他人开放。
- 不上 KVM 虚拟机。威胁模型是"失控或被注入的 agent"，不是"内核级攻击者"，容器隔离已经够用。
- 不支持 SSH、裸 TCP 等不走代理的出网方式（git 一律用 https）。
- 本期不做 gate-id 按 app 分 inject key（列为后续项，见 §7）。

### 1.4 威胁模型

| 威胁 | 例子 | 对策 |
|---|---|---|
| agent 改宿主文件 | `rm -rf ~`、改 `~/.claude` | 不挂载任何宿主目录，只挂一个专用 volume |
| agent 提权 | `docker run -v /:/host` | 不挂 `docker.sock`；非 root 运行；`cap-drop ALL`；`no-new-privileges` |
| agent 访问内网服务 | curl `100.64.0.6:3101`、`192.168.8.1`、宿主 `127.0.0.1:*` | 防火墙只放行容器 → mihomo 专用端口；mihomo 专用规则 REJECT 私网 |
| agent 借代理绕回内网 | 通过 mihomo 去 CONNECT `127.0.0.1:3101` | 专用 listener 绑定专用 sub-rules，私网、回环、tailnet 第一条就 REJECT |
| agent 读出 `GATE_INJECT_KEY` | 读 hub 进程的 env 或 secret 文件，伪造其他 app 的身份 | 容器内 `hub` / `agent` 两个用户分离，key 只有 `hub` 能读 |
| 资源耗尽，拖垮 RSI loop 和 prod | fork 炸弹、内存泄漏 | `--cpus` / `--memory` / `--pids-limit` |
| Claude 凭证泄露 | agent 把 token 发出去 | 用独立的 `setup-token`，不复用宿主登录态；可以单独撤销 |

---

## 2 设计

### 2.1 拓扑

```mermaid
graph LR
  B["浏览器"] -->|"https"| C["ECS Caddy<br/>hub-sandbox.qinglinzhang.top<br/>import gated"]
  C -->|"forward_auth"| G["gate-id<br/>app=hub-sandbox"]
  C -->|"tailnet"| P["NUC 100.64.0.6:3103"]
  subgraph NUC
    P --> H
    subgraph CT["容器 hub-sandbox（网络 hub-sandbox 192.168.250.0/24）"]
      H["tmux-hub（user hub）"] -->|"tmux -S"| T["tmux server（user agent）"]
      T --> PANE["pane：shell / claude"]
    end
    PANE -->|"仅 192.168.250.1:7898"| M["mihomo listener sandbox<br/>sub-rules: sandbox"]
  end
  M -->|"私网/回环/tailnet"| X["REJECT"]
  M -->|"国内"| D["DIRECT"]
  M -->|"境外/AI"| J["✈️ / 🤖 选择组 → 日本-TY-4-AT"]
```

### 2.2 容器

- **镜像**：`deploy/sandbox/Dockerfile`。基于 Debian slim，包含 bun、tmux（与宿主同为 3.x）、git、curl、claude code 以及常用开发工具。tmux-hub 代码在构建时 COPY 进镜像（取 `accepted` tag），不挂载宿主 worktree。
- **运行参数**（`deploy/sandbox/compose.yaml`）：
  - `user`：由 entrypoint 降权，镜像内不保留 root shell
  - `cap_drop: [ALL]`，`security_opt: [no-new-privileges:true]`
  - `read_only: true` 根文件系统，加 tmpfs `/tmp`
  - volume：`hub-sandbox-home` → `/home/agent`（agent 的工作区），`hub-sandbox-state` → `/var/lib/hub`（hub 的 DB、secret、日志）
  - 资源：`cpus: 4`，`mem_limit: 8g`，`pids_limit: 1024`
  - 端口：`100.64.0.6:3103:3103`，只绑 tailnet
  - 网络：`hub-sandbox`，固定 subnet `192.168.250.0/24`（在 daemon 的 `192.168.224.0/19` 地址池内，且未被占用）
  - 不挂 `docker.sock`，也不挂任何宿主路径

### 2.3 容器内用户分离

| 用户 | 运行 | 能读 |
|---|---|---|
| `hub` | tmux-hub 进程 | `/var/lib/hub`（0700）：`GATE_INJECT_KEY`、`hub.secret`、DB |
| `agent` | tmux server 和所有 pane | `/home/agent`、`CLAUDE_CODE_OAUTH_TOKEN` |

- tmux server 由 `agent` 启动，socket 用固定路径（`/run/tmux-sandbox/default`），并执行 `server-access -a hub` 授权 `hub` 连接。tmux ≥ 3.3 默认拒绝其他 UID 的客户端。
- **代码改动**：tmux-hub 目前只支持 `TMUX_HUB_SOCKET`（即 `-L <name>`，socket 落在按 UID 区分的 `/tmp/tmux-<uid>/` 下，跨用户不可达）。需要新增 `TMUX_HUB_SOCKET_PATH`，对应 `-S <path>`；两者都设时报错退出。改动在 `src/server/tmux-cmd.ts`，`tmux-env.ts` 同步透传。
- pipe-pane 日志目录由 `agent` 写、`hub` 读（目录权限 `agent:hub 0750`）。agent 能篡改自己 pane 的日志，但只会影响自己的显示，可以接受。

### 2.4 网络（proxy-infra）

在 `client/profiles/nuc-mihomo.yaml` 中新增：

```yaml
listeners:
  - name: sandbox
    type: mixed
    listen: 192.168.250.1   # 只绑 sandbox bridge 网关，局域网和 tailnet 都不可达
    port: 7898
    rule: sandbox

sub-rules:
  sandbox:
    - IP-CIDR,127.0.0.0/8,REJECT,no-resolve
    - IP-CIDR,10.0.0.0/8,REJECT,no-resolve
    - IP-CIDR,172.16.0.0/12,REJECT,no-resolve
    - IP-CIDR,192.168.0.0/16,REJECT,no-resolve
    - IP-CIDR,100.64.0.0/10,REJECT,no-resolve
    - IP-CIDR,169.254.0.0/16,REJECT,no-resolve
    - IP-CIDR,198.18.0.0/15,REJECT,no-resolve
    - DOMAIN-SUFFIX,qinglinzhang.top,REJECT     # 防止绕回自家公网入口
    - DOMAIN-SUFFIX,qinglinzhang.xyz,REJECT
    - DOMAIN-SUFFIX,agibot.com,REJECT          # 公司内网
    - GEOSITE,category-ai-!cn,🤖 人工智能
    - GEOSITE,cn,DIRECT
    - GEOIP,CN,DIRECT
    - MATCH,✈️ 境外流量
```

- 最后两条引用现有的选择组。换节点只在 mihomo 里改，沙箱自动跟随。
- 私网 REJECT 规则在域名解析**之后**也必须生效：防止"域名解析到内网 IP"的绕过。实现时需要验证 `no-resolve` 与域名请求的组合行为，必要时改为 resolve 后再匹配 IP（见验收 A5）。
- 这个 listener 不设认证：它只绑在 sandbox bridge 网关上，配合防火墙，只有 sandbox 容器能连到它。
- 生成器 `clash_emitter` 需要能把 overlay 里的 `listeners` / `sub-rules` 透传到产物，不支持的话补上。

### 2.5 防火墙（tmux-hub `deploy/sandbox/firewall.sh` + systemd oneshot）

```
# 显式写位置号：多次 -I 不带位置会倒序插入，导致 DROP 跑到放行规则前面
# 容器 → 任意外部（FORWARD）：全部丢弃。出网只能经 mihomo
iptables -I DOCKER-USER 1 -s 192.168.250.0/24 -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
iptables -I DOCKER-USER 2 -s 192.168.250.0/24 -j DROP
# 容器 → 宿主（INPUT）：只放行 7898。用 -I 而不用 -A，防止被前面已有的 ACCEPT 规则抢先放行
iptables -I INPUT 1 -s 192.168.250.0/24 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -I INPUT 2 -s 192.168.250.0/24 -p tcp --dport 7898 -j ACCEPT
iptables -I INPUT 3 -s 192.168.250.0/24 -j DROP
```

- 入站方向（tailnet:3103 → 容器）走 Docker 的 DNAT，属于 ESTABLISHED 回包，不受影响。
- 容器 DNS：compose 里设 `dns: [192.168.250.1]`，而该地址只放行了 7898，所以 DNS 不可用。所有域名都交给代理解析，容器内设 `HTTP(S)_PROXY=http://192.168.250.1:7898`，`NO_PROXY=127.0.0.1,localhost`。
- 规则由 `hub-sandbox-firewall.service`（oneshot，`After=docker.service`）幂等地加载。脚本先清理再插入，重启后自动恢复。

### 2.6 鉴权

- **gate-id**：在 `accounts.json` 的 `apps` 里登记 `{"id": "hub-sandbox", "hosts": ["hub-sandbox.qinglinzhang.top"]}`。用 `gate invites create --app hub-sandbox --email <新邮箱>` 创建一个**新账号**，只授权 `hub-sandbox`。你现在的主账号**不授权**这个 app。
- **Caddy**：新增 `hub-sandbox.qinglinzhang.top { import gated 100.64.0.6:3103 }`。
- **tmux-hub**：`TMUX_HUB_GATE_APP=hub-sandbox`，用 `GATE_INJECT_KEY` 验签。签名绑定了 app，所以 `hub-sandbox` 的签名访问不了 `hub` 或 `hub-dogfood`。

### 2.7 Claude 凭证

- 在宿主另开一个终端执行 `claude setup-token`，**不要**在 agent 对话里用 `! ` 运行，否则 token 会进入 transcript。
- 结果写入 `~/.config/tmux-hub-sandbox/claude.env`（0600），内容为 `CLAUDE_CODE_OAUTH_TOKEN=...`。
- 部署时通过 `env_file` 注入容器；entrypoint 只把它放进 `agent` 的 tmux server 环境，`hub` 进程拿不到。
- 备份：按 agent-shell `secrets.zsh` 的 sops 流程加密入库（同 agent-shell#74）。全程只引用文件路径，agent 不读取明文。
- 撤销：在该 Claude 账号下撤销这个 token，宿主上的登录不受影响。具体入口实现时核实后补进本文。

---

## 3 改动清单

| 仓库 | 内容 |
|---|---|
| tmux-hub | `TMUX_HUB_SOCKET_PATH`（`-S`）支持及测试；`deploy/sandbox/{Dockerfile,compose.yaml,entrypoint.sh,firewall.sh,hub-sandbox-firewall.service,sandbox.env.example}`；`deploy/instances.zsh` 增加 `deploy-sandbox`；本文档 |
| proxy-infra | `nuc-mihomo.yaml` 增加 `listeners.sandbox` + `sub-rules.sandbox`；生成器透传；测试 |
| edge-gateway | Caddyfile 新站点；`accounts.json` 登记 app `hub-sandbox` |
| agent-shell | `secrets.zsh` 增加 sandbox Claude token（sops） |

---

## 4 验收

所有检查都在容器内以 `agent` 身份执行，除非另有注明。

| # | 项 | 期望 |
|---|---|---|
| A1 | `curl https://api.anthropic.com` | 经 7898 成功；mihomo 日志显示命中 `🤖 人工智能` → 日本节点 |
| A2 | `curl https://www.baidu.com` | 经 7898，DIRECT |
| A3 | `curl --noproxy '*' https://1.1.1.1` | 失败（FORWARD DROP） |
| A4 | `curl http://100.64.0.6:3101`、`http://192.168.8.1`、`http://192.168.250.1:9091` | 直连失败；经代理被 REJECT |
| A5 | 经代理访问一个解析到私网 IP 的域名（如 `localtest.me` → 127.0.0.1） | REJECT |
| A6 | 经代理访问 `hub.qinglinzhang.top` | REJECT |
| A7 | `nslookup example.com` | 失败（容器内无 DNS） |
| A8 | `cat /var/lib/hub/*`、`cat /proc/<hub pid>/environ` | Permission denied |
| A9 | `ls /var/run/docker.sock`、`sudo -n true`、`capsh --print` | 不存在 / 失败 / 无 capability |
| A10 | `:(){ :|:& };:` 或者 `stress --vm` 吃内存 | 被 pids / memory 上限截住；宿主上的 prod 和 dogfood `/system/health` 保持正常 |
| A11 | 在 pane 里跑 `claude -p "say ok"` | 正常返回 |
| A12 | 浏览器：新 gate-id 账号登录 `hub-sandbox.` | 能开 session、输入、看到回显 |
| A13 | 用新账号访问 `hub.` / `hub-dogfood.` | 被 gate-id 拒绝 |
| A14 | 用主账号访问 `hub-sandbox.` | 被 gate-id 拒绝 |
| A15 | 宿主 `systemctl restart docker` 和重启 NUC 后 | 防火墙规则和容器自动恢复，A3/A4 仍然成立 |
| A16 | tmux-hub CI | `bun test` 和 `tsc` 全部通过，包括新增的 `-S` socket 测试 |

---

## 5 部署

1. 合入 proxy-infra PR → 生成 → `deploy-config.sh` 部署到 `/etc/mihomo` → `systemctl restart mihomo` → 确认 `192.168.250.1:7898` 在监听。前提是 docker network 已经建好，否则 bridge 地址不存在；第 2 步因此要放在 mihomo 重启之前。
2. `docker network create --subnet 192.168.250.0/24 --gateway 192.168.250.1 hub-sandbox`。
3. 安装并启动 `hub-sandbox-firewall.service`。
4. 准备 `~/.config/tmux-hub-sandbox/{sandbox.env,claude.env}`，`GATE_INJECT_KEY` 取自宿主现有配置。
5. `zsh deploy/instances.zsh deploy-sandbox`：构建镜像并 `docker compose up -d`。
6. 合入 edge-gateway PR → 部署 Caddy 和 gate-auth（按 001-account-service-rollout 的流程刷新 `accounts.json`）→ `gate invites create` 创建新账号。
7. 逐项跑 §4 验收。

**回滚**：`docker compose down` + 停用防火墙 unit + 删除 Caddy 站点，三项都不影响现有的 prod 和 dogfood。mihomo 只是新增了一个 listener，不改现有规则，可以不回滚。

## 6 发布条件

- §4 的 A1–A16 全部通过，并把结果附到 PR。
- 三个 PR 的 CI 都通过。
- prod 和 dogfood 实例的 health 与 drift 没有变化。

## 7 风险与未决

- **账号条款**：只要始终是本人使用，就不涉及账号共用。一旦提供给他人，就违反 Claude 消费者条款，可能导致封号。
- **共用 inject key**：`GATE_INJECT_KEY` 是所有 app 共用的一把 key。§2.3 的用户分离挡住了 agent 读取它；更彻底的方案是 gate-auth 按 app 签发不同的 key，列为后续项。
- **tmux 跨用户 socket**：需要在实现时先做 spike，验证 `server-access` 在 tmux 3.x 下的 socket 权限行为。不可行的话，退路是 hub 以 `agent` 用户运行，同时把 key 改为通过 Caddy 侧的 bearer 校验，到时另行讨论。
- **未决**：新 gate-id 账号用哪个邮箱；资源上限（4 核 / 8G）是否合适。

## 8 被否方案

| 方案 | 否决原因 |
|---|---|
| 宿主上新建 Linux 用户，直接再起一个实例 | 和宿主共用 `/data` 与进程表，权限得一项项收，容易漏 |
| KVM 虚拟机 | 要多维护一套 OS，对当前的威胁模型来说过重 |
| 容器直接用宿主的 7897 | 7897 的规则让私网走 DIRECT，等于借代理绕回内网 |
| hub 跑在宿主、只把 tmux server 放进容器 | 宿主 tmux 客户端与容器 tmux server 的协议版本必须严格一致，pipe-pane 路径也要两边对齐，太脆弱 |
| 把宿主的 `~/.claude` 挂进容器 | 宿主登录态会暴露给 agent，出事只能整体重新登录 |
