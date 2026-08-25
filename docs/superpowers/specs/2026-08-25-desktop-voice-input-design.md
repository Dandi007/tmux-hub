# Desktop / PWA Voice Input

## §1 第一性原理：要什么

语音转写目前只在移动端可用。桌面版网页与安装后的 PWA 走的是同一份 bundle，但视口判定落到 `desktop-view`，那条路径上没有麦克风入口 —— 于是「桌面上说话」这件事根本不存在，不是坏了，是没接。

本次改动要达到三个直接结果：

1. 桌面输入栏出现 🎤，录音 → 转写 → 整理后的文本落进输入框待复核（**不自动发送**，与移动端语义一致）。
2. 交互统一改为 **按一下开始录音、再按一下结束并转写**，移动端与桌面端同一套手势（原「按住说话」全线退役）。
3. 顺带把已存在但全站没有入口的「我的语音历史」面板（`voice-history.ts`）接到桌面输入栏。

**不改语音链路**：`/api/voice` 的 SSE、voice-intake 编排、落库与回放一律不动。

## §2 现状与根因

### 2.1 桌面为什么没有语音

`src/web/main.ts` 按视口分流：窄屏 / coarse pointer → `mobile-view`，否则 → `desktop-view`。`renderVoiceButton()` 只在 `mobile-view.ts` 里被调用过一次。桌面输入栏（`.desktop-input-bar`）本身已经具备承载条件：它复用 `.mobile-input-bar` 的 flex 容器，已经挂了 📎 上传与 textarea。

所以根因是**装配缺失**，不是能力缺失。

### 2.2 PWA 不需要单独做

PWA 与桌面网页是同一份代码：装到桌面上就是 `desktop-view`，装到手机上就是 `mobile-view`。链路侧也已经就位 —— `src/web/sw.ts` 的 `API_PREFIXES` 含 `/api/`，`fetch` 事件对它直接 `return` 不拦截，POST `/api/voice` 的 SSE 不会被 Service Worker 破坏。麦克风权限按 origin 授予，standalone 模式继承。

**结论：桌面接上 = PWA 同时接上，无需 manifest / SW 改动。**

### 2.3 「按住说话」在桌面不成立

`renderVoiceButton()` 现有交互是 `pointerdown` 开录、`pointerup` 停录。鼠标上「按住左键十几秒说完一段话」是不可用的姿势；而移动端长按还要额外靠 CSS 压制原生放大镜与文字选择。两端都在为「按住」付代价，收益却只有「省一次点击」。

## §3 方案设计

### 3.1 交互：toggle 取代 hold（两端统一）

| | 旧 | 新 |
|---|---|---|
| 开始 | `pointerdown` 按下 | `pointerdown` 按一下 |
| 结束 | `pointerup` 松手 | 再按一下 |
| 取消 | 松手太快 → 放弃本次 | 授权在途时再按一次 → 取消本次 |

仍然挂在 `pointerdown` 而不是 `click`：`preventDefault()` 要继续抑制焦点转移与移动端的原生文字选择/放大镜 —— 移动端上若让按钮抢走焦点，键盘会收起、输入栏退出 `is-editing`。

`getUserMedia` 的异步竞态处理（`wantRecording` / `starting`）原样保留，只是语义从「人已经松手了」变成「人已经取消了」。

### 3.2 桌面布局

```text
┌────────────────────────────────────┐
│  录音中 / 转写中… / 整理中…          │ ← 语音状态条（独占一行，默认隐藏）
│ [📎] [ 输入... ] [🎤] [🕘]           │ ← 桌面输入栏
└────────────────────────────────────┘
```

状态条挂在 `.desktop-input-bar` 内、作为首个子元素；容器本身是 `flex-wrap: wrap`，给状态条 `flex: 1 0 100%` 即可独占首行，隐藏时不占位。状态映射与移动端 header 状态条同语义（`录音中` / `📝 转写中…` / `✨ 整理中…` / 完成或失败后延时消失）。

### 3.3 文本落位

沿用移动端写法：在光标处**插入**而非覆盖（连说多段会累加），插入后 focus textarea 并把光标移到插入尾部。桌面没有 `is-editing` 抽屉态，少一步 `setEditing`。

### 3.4 语音历史

🕘 按钮调用现有 `openVoiceHistory()`（历史入口刻意不用话筒类图标——与录音的 🎤 并排会变成两个话筒），overlay 样式（`.voice-history*`）已在 `style.css` 中且非移动端限定，直接可用。

## §4 影响面

| 文件 | 改动 |
|---|---|
| `src/web/mobile/voice-input.ts` | hold → toggle；取消文案；移除 `pointerup` / `pointercancel` / `setPointerCapture` |
| `src/web/desktop/desktop-view.ts` | 装配 🎤 / 🕘 / 状态条 |
| `src/web/style.css` | 新增 `.desktop-input-bar__voice-status`；按钮补 `cursor: pointer` |
| `tests/unit/voice-input-race.test.ts` | 竞态用例改用 toggle 手势表达（意图不变），补「按一下开始、再按一下结束」用例 |

不改：`src/server/voice-*`、`src/web/sw.ts`、`manifest.webmanifest`、`voice-history.ts`。

`voice-input.ts` / `voice-history.ts` 留在 `src/web/mobile/` 不搬去 `shared/`：桌面已经在跨目录引 `mobile/image-attach.ts`，只搬语音会让同一类「两端共用但住在 mobile/」的文件出现两种摆法。要搬就连 image-attach 一起搬，那是独立的一次目录整理，不夹带进本 MR。

## §5 验收

- 桌面网页点 🎤 → 按钮变红 → 再点 → 文本落进输入框，不自动发送。
- 安装为 PWA 后同上（同一份 bundle，无额外改动）。
- 移动端手势由「按住」变为「点一下 / 再点一下」，转写链路与状态文案不变。
- `bun test` 全绿；`bun run build` 通过。
