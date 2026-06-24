# Mobile Header Voice Status Relayout

## §1 第一性原理：要什么

移动端顶部应该只承载当前最必要、最稳定的会话控制；语音输入的运行态反馈必须继续存在，但不能继续放在容易被安全区和浏览器 UI 遮挡的位置。

本次改动要达到三个直接结果：

1. 移动端顶部只保留会话选择与会话控制：session picker、`+` 新建会话、`⏻` 关闭当前 session。
2. 去掉当前顶部的两个次要入口：`🎙` 语音历史入口、`✎` 重命名入口。
3. 现有语音状态显示（`录音中` / `转写中` / `整理中` / 完成或失败后的短暂结果提示）保留原有状态机与文案语义，只把承载位置迁到 `+` 按钮下方的 header 次行。

换句话说：**不改语音链路，不改状态逻辑，只收敛顶部按钮并重排状态条位置。**

## §2 现状与根因

### 2.1 当前移动端 header 结构

当前 `src/web/mobile/mobile-view.ts` 在 header 内放了一个 `🎙` 按钮；该按钮打开 `voice-history` overlay。`src/web/mobile/session-picker.ts` 则把 session picker、`✎` 重命名按钮、`⏻` 关闭按钮放在同一行，`+` 新建会话按钮由 `renderQuickLaunchButton()` 动态 append 到同一个 action row。

因此当前顶部一行实际承担了四类职责：

- 会话选择
- 会话新建
- 会话管理（rename / kill）
- 语音历史入口

在移动端窄视口下，这一行已经接近拥挤上限。

### 2.2 当前语音状态承载方式

当前 `renderVoiceButton()` 的 `onStatus` 回调在 `src/web/mobile/mobile-view.ts` 内部把语音状态映射成 sticky toast：

- `recording` → `🎤 录音中`
- `transcribing` → `📝 转写中…`
- `cleaning` → `✨ 整理中…`
- `idle` / `error` → 更新为终态文案后延时消失

状态机本身已经满足需求，问题不在语音逻辑，而在**状态显示位置属于页面最上层 toast 区域**。在移动端真实使用中，这个位置更容易被浏览器顶部 UI / safe area / 粘性 header 共同影响，造成提示被遮挡或注意力路径不稳定。

### 2.3 根因

根因不是功能缺失，而是**信息层级与布局承载不匹配**：

- `🎙` 历史入口和 `✎` 重命名都不是移动端最高频动作，却与核心会话控制竞争顶部空间。
- 语音运行态是“当前操作反馈”，更适合挂在当前操作区附近；现在却通过全局 toast 漂浮在顶部，与 `+` / picker 没有稳定空间关系。

## §3 方案设计

### 3.1 目标布局

调整后，移动端 header 改为“两层结构”：

```text
┌──────────────────────────┐
│ [ Session Picker ▾ ][+][⏻] │  ← 主操作行
│   录音中 / 转写中 / 整理中   │  ← 语音状态次行（默认隐藏）
├──────────────────────────┤
│       Terminal / TUI      │
└──────────────────────────┘
```

关键点：

- 第一行只保留与“当前会话”直接相关的控制。
- 第二行是 header 内部的语音状态条；只在语音链路运行中或终态短暂停留时显示。
- 状态条整体视觉尽量贴近现有 toast 文案，不引入新的交互模型。

### 3.2 DOM 与职责边界

#### `src/web/mobile/session-picker.ts`

- 删除 `renameBtn` 的创建、事件绑定与 `onRename` 导出。
- 保留 `killBtn`，并继续通过 `onKill` 回调与外层 `mobile-view` 通信。
- `triggerRow` 继续作为 picker 主操作行容器，供外层把 `+` 按钮 append 进来。

这样 session picker 的职责收敛为：

- 选择当前 session
- 显示当前 session / Claude Code pane title
- 暴露 `kill` 控制入口
- 为外层 `+` 按钮提供 action row 挂载点

#### `src/web/mobile/mobile-view.ts`

- 删除 `historyBtn` 与 `openVoiceHistory()` 的 header 入口接线。
- 在 header 内新增独立的 `voiceStatusRow` 元素，位于主操作行之后。
- 把当前 `onStatus` 中的 toast 驱动逻辑替换为“更新 `voiceStatusRow` 的文本、状态类名与显隐”。
- `renderVoiceButton()`、`voice-input.ts`、SSE 事件流本身保持不变。

这里的设计原则是：

- **语音状态属于 mobile header 的页面内状态，而不是全局浮层消息。**
- session picker 不知道语音状态；语音状态由 mobile view 统一编排，避免跨组件耦合。

### 3.3 状态条行为

状态条沿用当前时序，不新增业务分支：

| VoiceStatus | 展示文案 | 行为 |
|---|---|---|
| `recording` | `🎤 录音中`（或沿用 detail） | 立即显示 |
| `transcribing` | `📝 转写中…` | 继续显示 |
| `cleaning` | `✨ 整理中…` | 继续显示 |
| `idle` with detail | 沿用现有耗时/完成文案 | 显示一小段时间后自动隐藏 |
| `idle` without detail | 无 | 立即隐藏 |
| `error` | 沿用现有错误文案 | 短暂显示后隐藏 |

也就是说：**只改位置，不改状态机，不改文案来源，不改隐藏时机。**

### 3.4 样式策略

`src/web/style.css` 做以下布局调整：

1. `.mobile-shell__header` 从单行 `flex` 调整为可容纳“主操作行 + 次行”的纵向容器。
2. 给 `session-picker__trigger-row` 保持第一行横向布局；`+` 与 `⏻` 仍然继承 `header-action` 风格。
3. 新增 `.mobile-shell__voice-status`（命名可微调）样式：
   - 默认隐藏
   - 出现时位于主操作行下方
   - 视觉上延续当前信息提示风格，不抢占主操作行层级
4. 删除 `.mobile-history-btn` 在移动端顶部的占位需求。

### 3.5 对已有功能的影响

- `voice-history` overlay 与 `/api/voice/history` 不删除；只是移动端顶部不再提供该入口。
- rename 流程代码可以从移动端路径移除；桌面端如无依赖，不受影响。
- `+` 模板选择器的锚定逻辑保持不变，仍然以 `+` 按钮为 anchor；语音状态条只是位于其下方的稳定页面元素，不参与 popover 定位。

## §4 改动清单

| 文件 | 改动要点 |
|------|------|
| `src/web/mobile/mobile-view.ts` | 删除语音历史按钮；新增 header 次行状态条；把语音状态显示从 toast 改为页面内状态条 |
| `src/web/mobile/session-picker.ts` | 删除移动端 rename 按钮与 `onRename` 接口；保留 kill 按钮与 action row |
| `src/web/style.css` | 调整移动端 header 为两层布局；新增语音状态条样式；清理顶部语音历史按钮相关样式 |
| `tests/e2e/mobile.e2e.ts` | 删除/更新 rename 相关断言；新增顶部按钮组合与语音状态条位置/显示行为断言 |

## §5 测试计划

- [ ] Mobile header 只显示 session picker、`+`、`⏻`，不再显示 `🎙` 和 `✎`
- [ ] 点击 `+` 仍能打开 template picker，并成功新建会话
- [ ] 点击 `⏻` 仍能关闭当前 session
- [ ] 触发语音状态流时，状态文案显示在 header 次行，而不是旧的顶部承载位置
- [ ] `recording → transcribing → cleaning → idle/error` 的显示/隐藏时序与当前逻辑一致
- [ ] `bun run test:e2e` 中 mobile 相关用例通过

## §6 非目标

- 不改 `src/web/mobile/voice-input.ts` 的录音、上传、SSE、状态机逻辑
- 不改 `src/web/mobile/voice-history.ts` 的 overlay 实现与后端接口
- 不在本次改动中为语音历史寻找新的入口位置
- 不改 desktop header / session list 行为
