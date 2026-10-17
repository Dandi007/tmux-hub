# 测试不受外部 hub env 影响

> RSI loop 第 2 轮自主选题（backlog P0 后半）。loop 级目标已与用户确认；本 spec 记录 agent 自己得出的需求。

## 需求

如果开发 shell 由 hub 拉起，或者 source 过 hub.env，环境里就会带着全部 `TMUX_HUB_*` 和 `GATE_*`。#114 之后，新 session 不再泄漏这些变量，但老进程和手工 export 的仍会带着。测试在这种 shell 里跑，会出现两个问题：

- bun test：preload 只覆盖 DB_PATH、LOG_DIR、TMUX_TMPDIR、SOCKET，其余变量原样透传。实测 `suggest-config.test.ts` 的默认值用例会失败（`TMUX_HUB_SUGGEST=1` 等）。
- Playwright：webServer 和 worker 继承 runner 的 env，hubCommand 只覆盖部分 key。于是 E2E hub 会继承 prod 的 `TMUX_HUB_HOST`（绑到 prod 地址），以及 `TMUX_HUB_VOICE_DB_PATH`、`TMUX_HUB_IMAGE_DIR`（打开 prod 的 voice.db 和图片目录）。

要求：无论外部 env 是什么，测试都要看到与 CI 相同的 env。

## 设计

- 新增 `tests/helpers/scrub-env.ts`，提供 `scrubAmbientHubEnv()`：删除 `GATE_*`，以及除 `TMUX_HUB_E2E_*`（playwright.config 自己设置的管道变量）以外的全部 `TMUX_HUB_*`。
- `tests/helpers/preload.ts` 在设置隔离变量之前先调用它，并把调用后的 env 快照存到 `globalThis.__preloadEnv`。之所以要存快照，是因为各测试文件会在进程内修改 process.env，事后再检查 process.env 会受测试顺序影响。
- `playwright.config.ts` 在模块顶部调用它，这样 webServer 和 worker 都继承干净的 env。

## 验收

- `tests/unit/test-isolation.test.ts`：preload 快照里只剩 preload 自己设置的 3 个 `TMUX_HUB_*`，没有任何 `GATE_*`；`scrubAmbientHubEnv` 的删除和保留规则正确。
- 在 source 过 `hub.env` 的 shell 里运行 `bun test tests/unit`，全部通过（修复前有 1 个失败）；在同样的 shell 里运行 E2E（desktop + emulator），全部通过。
- 常规全量回归通过。

## 部署

只改测试，不改运行时代码。合入后照常部署 dogfood，运行代码不变。
