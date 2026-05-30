# 通用 Launch 能力（CLI + endpoint）— Design Spec

**Date:** 2026-05-30
**Status:** Draft (awaiting user review)
**Branch:** `feat/launch-cli`（worktree from `origin/main` @ `c37f997`）

---

## 1. 第一性原理：我们到底要什么

要在一台机器上、用一行命令起一个进程，并让它**立刻成为 tmux-hub 的 managed 会话**——能在 web/mobile 看、attach、kill、回放。指定三样东西就够：

1. 创建一个会话（窗口）
2. 设工作路径（cwd）
3. 跑一条**任意命令**

目前 tmux-hub 起会话只有 Template（"Card"）一条路：

- 模板定义在 `~/.config/tmux-hub/templates.yaml`，**server 启动时一次性 `loadTemplates()` 读进内存**，之后不热加载 → 改/加模板必须改 yaml 再**重启 server**。
- 起会话只有 `POST /templates/:id/run`，body 只能给 `{cwd, env?}`：cwd 必须在模板的 `cwd_choices` 白名单内，**cmd 完全由模板写死，调用方无法指定**。

对"每次命令都不一样"的临时进程（典型：dev-dispatch 的 worker `zsh -ic '... claude -p ... < prompt'`），这条路要么得预先写死模板（命令拼不进去），要么靠 env 在模板 cmd 里拼，且任何调整都要重启 hub——"先建 Card 再重启"。dev-dispatch v0.1 因此**绕过 hub 直起 subprocess**，代价是 worker/judge 进程不在 hub 里、手机看不到、不能 attach、不能回放。

> 本 spec 给 tmux-hub 补一条**不依赖预定义模板**的通用启动路径：一个本机门禁的 `POST /sessions` endpoint + 一个薄 CLI `tmux-hub launch`。

---

## 2. 用户故事

**S1（程序化调用，dispatch 动机）**：dev-dispatch 这类协调器在同一台 Mac 上，`POST http://127.0.0.1:3101/sessions {cmd, cwd, name?, env?}`（带 admin secret 头）→ 拿回 `{name}`。worker 进程即刻是 managed 会话，协调器轮询会话是否消失判完成，命令退出后回读保留的日志拿最终输出。

**S2（手动调用）**：用户在终端 `tmux-hub launch --cwd /path -- some-long-running-cmd`，回车后该进程成了 hub 会话，掏出手机在 web UI 里就能看它跑、能 attach。

**S3（安全）**：手机过了 Cloudflare Access、握着 `hub.secret`，**仍然无法**调用 launch——admin secret 永不下发，CF 隧道来的请求被直接拒。任意命令执行只对**本机文件系统可达**的进程开放。

---

## 3. 范围 / 非目标

**In scope（本 spec，tmux-hub 侧）**

- 新增本机门禁 endpoint `POST /sessions`（任意 cmd+cwd+env 起 managed 会话）。
- 新增独立的 local **admin secret**（`~/.config/tmux-hub/hub.admin.secret`，0600，永不下发）+ launch 专用门禁。
- ad-hoc 会话**退出后保留日志**（in-memory retain set）。
- 薄 CLI `bin/tmux-hub`，**仅 `launch` 子命令**。
- 单元 + 集成（真 tmux）测试。

**Out of scope（不做 / 单独 follow-up）**

- **dev-dispatch 改造**（worker/judge 走 `tmux-hub launch`）= 单独 spec/PR，在 dev-dispatch 仓库走自举流程。本 spec 只交付被它调用的能力。
- CLI 的 `ls` / `kill` / `logs` 子命令——YAGNI，这些 endpoint 已存在（`/events`、`/sessions/:name/kill`）或可后补；先只做 launch。
- server 侧的 exit-code 跟踪 / Job 抽象——薄约定，exit code 由调用方包 sentinel。
- 保留日志的 GC（按时长/数量清理）——列 follow-up，v1 先保留。
- 模板热加载——不在本 spec（另一条独立改进）。
- 把 launch 暴露到 web UI（按钮）——本 spec 不加前端入口。

---

## 4. 关键发现：现有 `x-hub-secret` 区分不了"本机 vs 手机"

现有 `auth.ts` 的写操作门禁认两样之一：Cloudflare Access JWT，**或** `x-hub-secret`（= `~/.config/tmux-hub/hub.secret`）。而 `GET /system/auth-check` 在浏览器过了 CF Access（有 email identity）后会**把 hub.secret 发给浏览器**（`main.ts` auth-check：`ident && ident !== "local-secret"` 即下发）。

→ 结论：**手机过了 Cloudflare Access 就握着 hub.secret**。拿 `x-hub-secret` 当 launch 门禁，等于手机也能起任意命令，违背"仅本机"。必须用一个**永不下发到线缆上**的独立 secret。

---

## 5. 设计

### 5.1 门禁：独立 local admin secret

- 新增 `~/.config/tmux-hub/hub.admin.secret`（env 可覆盖 `TMUX_HUB_ADMIN_SECRET_PATH`），server 启动时 `loadOrCreateSecret` 同款逻辑生成（32 字节 hex，0600）。
- **没有任何 endpoint 返回它**——`auth-check` 不发、CF 浏览器拿不到、cloudflared 拿不到。
- launch endpoint 的门禁（独立于 `authGate`，或 `authGate` 加一条 admin 分支）：
  1. 必须头 `x-hub-admin-secret` 且 `safeEqual` 匹配 admin secret；否则 401。
  2. **纵深防御**：请求若带 `cf-access-jwt-assertion` 或 `x-forwarded-for` 头 → 直接 403（经 Cloudflare 隧道来的请求一律拒，即便 token 泄漏）。
- 语义：**能读到这个磁盘文件 = 本机进程**。CLI 和 dispatch 直接读文件，跟 server 读 hub.secret 一个套路。

### 5.2 launch endpoint：`POST /sessions`

- body：`{ cmd: string, cwd: string, name?: string, env?: Record<string,string> }`
- 校验：
  - `cmd` 非空字符串（任意内容）。
  - `cwd`：`expandHome` 后 `existsSync`，否则 400。（**无 `cwd_choices` 白名单**——这是与模板的关键区别，门禁靠 admin secret 而非 cwd 白名单。）
  - `name`：可选，grammar `[A-Za-z0-9_-]{1,64}`（复用 `isGrammarOk`）；缺省自动生成 `adhoc-<ts14>`（复用 `formatTs14`）。
  - `env`：复用现有 `buildEnvArgs` 校验（key 符合 POSIX 名、value 非 NUL），展成 `-e KEY=VAL`。
- 执行（复用 `TemplateRunner.run` 同款 tmux 调用，抽出共享函数）：
  - `tmux has-session -t <name>` 命中 → 409。
  - `tmux new-session -d -s <name> -c <expanded-cwd> [-e…] <cmd>`，失败 → 500。
  - `managedDb.add(name, null)`（**template_id = NULL 标记 ad-hoc**）。
  - 加入 in-memory `retainLog` 集合（见 5.3）。
  - `broadcasters.get(name)`（prime） + `registry.pollNow()`。
- 返回 `201 { name }`。

实现落点：把 `template-runner.ts` 里 new-session + grammar + env + has-session 的核心抽成一个 `launchSession(...)`（参数 `{name, cwd, cmd, env}`），`TemplateRunner.run` 和 `POST /sessions` 都调它，避免逻辑分叉。

### 5.3 日志保留（薄约定的"保留日志"）

- 现状：`main.ts` 里 `registry.subscribe` 的 `session_removed` 分支 → `broadcasters.stop(name, { deleteLog: true })`，命令一结束日志（`~/.cache/tmux-hub/logs/<name>.log`）就删。
- 改：server 维护一个 in-memory `Set<string> retainLog`：
  - launch endpoint 创建 ad-hoc 会话时 `retainLog.add(name)`。
  - **启动时重建**：从 managedDb 取 `template_id IS NULL` 的会话名灌入（跨 hub 重启不丢）。需 `ManagedSessionDb` 加一个 `adhocNames(): string[]` 查询（`SELECT name WHERE template_id IS NULL`）。
  - `session_removed` 时：`broadcasters.stop(name, { deleteLog: !retainLog.has(name) })`，并 `retainLog.delete(name)`。
- 结果：ad-hoc 会话退出后**日志保留**，协调器可回读最终输出；模板会话行为不变（仍删）。
- 完成探测 = 轮询会话消失（`GET /events` 快照 / 后续 CLI）；exit code = 调用方把 cmd 包成 `…; echo $? > <path>/exit.code`（server 不掺和）。

### 5.4 CLI：`bin/tmux-hub`（薄客户端，bun 脚本）

- 仅 `launch` 子命令：
  ```
  tmux-hub launch --cwd PATH [--name NAME] [--env K=V]... -- <cmd...>
  ```
- 行为：读 `~/.config/tmux-hub/hub.admin.secret`（不存在则报错提示 server 未起过）→ `POST http://127.0.0.1:3101/sessions`（端口取 `TMUX_HUB_PORT`，默认 3101）带 `x-hub-admin-secret` → 成功打印 name 到 stdout、exit 0；失败打印 server 的 error + 非零 exit。
- `--` 之后全部当 cmd（保留空格/引号，join 成一条 `cmd` 字符串传给 endpoint）。
- 装：symlink 到 PATH 或 `bun link`（README 写明）。

---

## 6. 改动清单

| 文件 | 改动 |
|---|---|
| `src/server/secret.ts` | 抽 `loadOrCreateSecret(path)` 可传路径 / 加 `loadOrCreateAdminSecret()`；导出 admin secret 路径常量 |
| `src/server/auth.ts` | 加 launch 专用 admin 门禁（admin secret 匹配 + 拒 CF/forwarded 头）；可做成独立 middleware |
| `src/server/template-runner.ts` | 抽出共享 `launchSession({name,cwd,cmd,env})`，`TemplateRunner.run` 改为调它 |
| `src/server/managed-db.ts` | 加 `adhocNames(): string[]`（`template_id IS NULL`） |
| `src/server/main.ts` | 注册 `POST /sessions`；引入 `retainLog` set（启动从 `adhocNames()` 重建）；`session_removed` 改 `deleteLog: !retainLog.has(name)` |
| `bin/tmux-hub` | 新增薄 CLI（仅 launch） |
| `tests/unit/*` | launch 路由、admin gate、name 生成/grammar、retain set 逻辑 |
| `tests/integration/*` | 真 tmux：launch→managed+日志在；退出→会话消失但日志保留；env 注入 |
| `README.md` | launch endpoint + CLI 用法、admin secret 说明 |

---

## 7. 测试计划

**Unit（bun:test，mock tmuxRun）**

- launch 路由：合法 body → 201 + name；cwd 不存在 → 400；name 非法 grammar → 400；重名 → 409；缺 name → 自动 `adhoc-<ts14>`。
- admin gate：无 `x-hub-admin-secret` → 401；错 secret → 401；对 secret → 通过；带 `cf-access-jwt-assertion` / `x-forwarded-for` → 403。
- retain set：launch 后 set 含该 name；session_removed 后 `deleteLog` 取反正确、name 从 set 移除。
- `adhocNames()` 只返回 `template_id IS NULL` 的行。

**Integration（真 tmux，非默认 socket）**

- launch 一个短命令（`sh -c 'echo hi'`）→ 会话存在、在 managedDb（template_id NULL）、日志文件存在且含 `hi`。
- 命令退出 → 轮询后会话从快照消失，但 `~/.cache/.../logs/<name>.log` **仍在**且内容完整。
- 带 `--env FOO=bar` → 会话内 `$FOO` 为 `bar`（命令写文件断言）。
- 模板会话退出仍删日志（回归，不被本改动影响）。

**E2E**：可选，不阻塞——ad-hoc 会话出现在 UI 可 attach。

---

## 8. 风险 / 注意

- **admin secret 文件权限**：必须 0600，且确保 server 进程用户 = CLI/dispatch 调用用户（本机同一用户，成立）。
- **纵深防御头检查**：需确认 cloudflared 转发请求确实带 `cf-access-jwt-assertion`（生产）或至少 `x-forwarded-for`；本机 curl 不带。若未来 CF JWT 校验落地（`cf-access.ts` stub），admin 门禁逻辑与之独立、不受影响。
- **任意 cmd = 设计上的 RCE**：已由"仅本机文件系统可达"边界承重，README 须显式标注此 endpoint 的信任模型。
- **retain 日志无界增长**：v1 不 GC，长期需 follow-up（按时长/数量清理 ad-hoc 日志）。
