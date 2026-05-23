# Mobile Fixes R2 设计：Session Rename · 空提交回车 · 图片上传

日期：2026-05-23
范围：移动端 UX 补强 + 图片上传（前后端，桌面同步支持）
基础提交：`3265b2c` (PR #4, 移动端 quick-launch 合并后)

---

## 0. 第一性原理：要什么

**Session Rename（移动端）**
用户在移动端只能选择 session，不能改名；桌面端有 ✎ 内联重命名，移动端没有等价入口。要的是：在 mobile header 的 `<select>` 旁边补一个改名按钮，行为对齐桌面端，复用已有的 `POST /sessions/:name/rename` 接口和 `isGrammarOk` 校验。成功标志：移动端能完成一次合法改名、错误名给出 toast、SSE 自动重画后新名作为当前选中。

**空输入提交 = 纯回车**
现在移动端 drawer 的提交按钮在 textarea 为空时直接 return，导致用户想"只发一个回车"必须先展开 special-keys-bar 找 Enter。要的是：空提交时，提交按钮等价于发一次 `key: Enter`；非空时保持现行 `keys + Enter` 两步语义。成功标志：textarea 空 → 点提交 → tmux 收到 Enter；移动端"光发回车"零额外操作。

**图片上传**
TUI 时代的 claude-code、aider 等都接受"贴一个图片文件路径，自动作为附件加载"。tmux-hub 跑在远端 dev mac 上，移动端 / 桌面端的图片首先要落到 dev mac 的文件系统，再以**路径文本**的形式注入到目标 tmux session 当前 TUI。要的是：移动端能从相册选图、桌面端能从文件选 + 剪贴板粘贴；服务端把图存到由部署者配置的目录（用环境变量，默认 `~/Pictures/tmux-hub`，生产部署指向数据盘）；上传成功后路径以文本形式注入到当前 attach 的 session。成功标志：在移动端选一张图，drawer textarea 收到绝对路径，提交后 claude-code 把它识别为图片附件。

不在这一版范围内的：批量上传、HEIC→JPEG 转换、自动清理策略、上传进度条、桌面端拖拽、上传断点续传。

---

## 1. 现状

### 1.1 移动端 session 选择
`src/web/mobile/mobile-view.ts`：header 只有一个 `<select>`，change 事件触发 attach 切换。没有改名入口。

### 1.2 桌面端 Session Rename 实现
`src/web/desktop/session-list.ts:71-129`：每个 `<li>` 内嵌一个 ✎ 按钮，点开把名字 div 替换为 `<input>`，Enter 提交 / Esc 取消 / blur 提交。POST `/sessions/:name/rename` body `{to}`。服务端 `src/server/session-control.ts:35-45` 校验 grammar 后执行 `tmux rename-session`。SSE 经 `session_removed (old) + session_created (new)` 重画。

### 1.3 移动端输入箱
`src/web/mobile/input-box.ts:26-42`：submit handler 第一行 `if (!text) return;` 阻断空提交。非空时先 `keys` 后 `Enter`。

### 1.4 协议与输入路由
`src/shared/protocol.ts:18-22`：`ClientWsMessage = keys | key | resize`，无 binary。
`src/server/input-router.ts`：`keys` 走 `send-keys -l`（literal），`key` 走 `send-keys` 命名键，白名单含 Enter。

### 1.5 部署配置
`src/server/config.ts:44-50`：所有运行时参数走 `TMUX_HUB_*` env，默认值在 `config.ts` 集中，`expandHome` 工具已存在。`deploy/hub.env.example` 是部署者本机配置模板。

### 1.6 桌面端输入路径
`src/web/terminal.ts:281-284`：`term.onData` 把 xterm 接收到的所有字节（包括键盘输入和 textarea-helper 粘贴）直接通过 `kind: keys` 发出。

---

## 2. 设计

### 2.1 移动端 Session Rename

**UI 改动** — `src/web/mobile/mobile-view.ts`：

在 header 内现有 `<select>` 后追加一个 ✎ 按钮（class `mobile-shell__rename`）。点击 ✎ 进入"编辑模式"：

```
[selected session ▽] [✎]              ← 默认模式
            ↓ 点 ✎
[input:current-name] [保存] [取消]      ← 编辑模式
```

**为什么按钮而不是 blur 提交**：iOS Safari 上 input blur 的触发时机与 keyboard 收起、视图滚动会争抢；显式 "保存 / 取消" 让交互对手指操作可控。

**逻辑**：
- 编辑模式入口：点 ✎ → 当前 select 的值作为 input 预填值；input `type="text"`、`autocomplete="off"`、`autocapitalize="off"`、`spellcheck=false`；自动 focus + select。
- 保存：`isGrammarOk(input.value.trim())` 校验失败 → toast 错误信息，停留在编辑模式；通过 → 调用复用模块 `renameSession(from, to)`，成功后回退到默认模式（SSE 会重画 select）。
- 取消：恢复默认模式，不发请求。
- 网络错误：toast + 停留在编辑模式让用户重试。

**复用抽取** — 新文件 `src/web/shared/rename-controller.ts`：

```ts
export async function renameSession(from: string, to: string): Promise<void>;
```

桌面端 `session-list.ts` 内联实现的 `renameSession` 函数移过来；桌面端和移动端都 import 它。这是唯一一处跨视图共享逻辑，单独放 `shared/` 比放某一边视图模块更合理。

**键盘**：保留移动端 input 上 Enter→保存 / Escape→取消的 keydown 处理，与按钮等价；外接键盘用户友好。

**Toast 反馈**：复用 `src/web/ui/toast.ts`。

### 2.2 空输入提交 = 纯回车

**改动单点** — `src/web/mobile/input-box.ts:26-42`：

```ts
wrap.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = ta.value;
  if (text) send({ kind: "keys", literal: text });
  send({ kind: "key", name: "Enter" });
  ta.value = "";
});
```

去掉 `if (!text) return`。文本非空时发 keys 再发 Enter；为空时只发 Enter。

**协议层为什么不会出问题**：`{kind:"key", name:"Enter"}` 走 `send-keys Enter` 命名键路径，tmux 会根据 pane 当前应用模式（raw/cooked、normal/application keypad）发对应字节，这条路径在 commit `2870fbf` 中已经验证过 claude-code、vim、shell 都正确响应。

**桌面端不动**：桌面输入是 xterm.onData 直发字节流，键盘的 Enter 物理键已经是一字节 CR，本来就没有"空提交"概念。

**Accessibility**：提交按钮的 `aria-label` 维持原状（"提交"）；视觉文本保持 "提交 ↵"。这一改动对 aria 语义没有破坏：按钮在两种状态下行为虽然不同，但用户感知都是"发送下一步"。

### 2.3 图片上传 · 协议与服务端路由

**新增 HTTP 路由** — `src/server/session-control.ts`（或新建 `src/server/image-upload.ts`）：

```
POST /sessions/:name/upload-image
  Content-Type: multipart/form-data
  Body: file=<binary>
  →
  200 { ok: true, path: "<absolute>" }
  400 { error: "<reason>" }   // mime / session grammar / parse 失败
  413 { error: "file too large" }
  500 { error: "<errno or stderr>" }
```

**Session 名校验**：复用 `r.use("/sessions/:name/*")` 中间件，已经卡了 grammar，不需要再写。

**MIME 白名单**：`image/png | image/jpeg | image/gif | image/webp | image/heic`。在服务端**和**客户端各做一次校验（客户端拦截更友好的错误，服务端是安全底线）。

**大小上限**：`MAX_IMAGE_BYTES = 20 * 1024 * 1024`（20 MB）。理由：claude-code 实测对 >20MB 的图片容易处理超时；定一个稳定上限好过让用户碰运气。

**落盘路径**：`${IMAGE_DIR}/${YYYY-MM-DD}/${crypto.randomUUID()}.${ext}`。
- ext 由 mime 反查（`image/png → png` 等；`image/heic → heic`）。
- 不保留原文件名（避免文件名注入、路径穿越、字符集问题）。
- 用 UTC 还是本地时区：本地时区，与 server 启动日志、tmux activity 时间口径一致。
- 服务端启动**不**预创建 `IMAGE_DIR`；首次上传时 `mkdir -p ${IMAGE_DIR}/${date}`，失败 → 500。

**返回路径**：始终绝对路径（`expandHome` 解析后），客户端拿到直接当文本注入即可，TUI 不需要再做 tilde 展开。

**实现细节**：使用 Hono 的 `c.req.parseBody()` 获取 File；用 `Bun.write(absPath, file)` 落盘。先写后返回，避免赛跑。

### 2.4 图片上传 · 落盘配置（环境变量）

**新增 env 变量**：

```
TMUX_HUB_IMAGE_DIR
  描述：图片上传落盘根目录的绝对路径或 ~/... 形式
  默认：~/Pictures/tmux-hub
  生产建议：指向数据盘，例如 /Volumes/Data/tmux-hub-images
```

**`src/server/config.ts` 新增**：

```ts
export const IMAGE_DIR = expandHome(
  process.env.TMUX_HUB_IMAGE_DIR ?? "~/Pictures/tmux-hub",
);
export const MAX_IMAGE_BYTES = Number(
  process.env.TMUX_HUB_MAX_IMAGE_BYTES ?? 20 * 1024 * 1024,
);
```

启动时打一行：`console.error('[tmux-hub] image dir: ${IMAGE_DIR}');` 与现有 `effective templates` 日志风格一致。

**`deploy/hub.env.example` 追加**：

```bash
# 图片上传落盘根目录。建议指向数据盘，避免 ~ 空间紧张。
# 默认 $HOME/Pictures/tmux-hub
# TMUX_HUB_IMAGE_DIR=/Volumes/Data/tmux-hub-images
```

**为什么不强制必填**：现有 `TMUX_HUB_TEMPLATES_PATH` / `TMUX_HUB_PORT` 全部是软默认 + 部署者按需 override 的模式；强制必填会让 dev 一键 `bun run dev` 受阻。`~/Pictures/tmux-hub` 在没有数据盘的 fork 上是合理 fallback。

**Path containment 不需要做**：`IMAGE_DIR` 来自部署者本机配置不来自请求；UUID + 日期生成的子路径不含 `..`；不需要写 `path.relative` 防穿越。

### 2.5 图片上传 · 前端共享模块

新文件 `src/web/upload/image-upload.ts`：

```ts
export const IMAGE_MIME_WHITELIST = [
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/heic",
] as const;

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export function isImageFile(f: File | Blob): boolean;

export async function uploadImageForSession(
  session: string,
  file: File,
): Promise<string /* absolute path returned by server */>;
```

`uploadImageForSession` 内部：
1. 客户端预检：mime 在白名单内 + size ≤ MAX；不通过 throw 带可读错误（用于 toast）。
2. `FormData` + `hubFetch('/sessions/{name}/upload-image', { method: 'POST', body: form })`。
3. 解析响应，非 200 throw `await r.text()`。
4. 返回 `path`。

移动端 / 桌面端的入口模块只负责 UI 触发 + "成功后路径放哪儿"，上传 IO 共用一份。

### 2.6 图片上传 · 移动端 UX

**工具栏增加一个 📎 按钮** — `src/web/mobile/mobile-view.ts`：

工具栏当前顺序：`✎ toggle | 🚀 quick-launch | special-keys-bar`。在 quick-launch **右侧**插入 📎 按钮。

**新文件** `src/web/mobile/image-attach.ts`：

```ts
export function renderImageAttachButton(opts: {
  parent: HTMLElement;
  getSession: () => string | null;       // 当前 attach 的 session 名，未 attach 时返回 null
  getTextarea: () => HTMLTextAreaElement | null;
  openDrawer: () => void;                // 复用 mobile-view 内 setDrawer(true)
}): HTMLButtonElement;
```

行为：
- 渲染按钮 + 同级隐藏 `<input type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/heic">`（不加 `capture` 属性；iOS Safari 默认弹出"照片图库 / 拍照或录像 / 选取文件"三选一系统选择器）。
- 点按钮 → 触发 input click。
- input change → 拿 File → `uploadImageForSession()`。
- 上传期间：按钮 disabled，显示 "..."；防止 double-tap。
- 成功：
  1. 调用 `openDrawer()`（已开则无副作用）。
  2. 在 textarea 当前光标位置插入 ` ${path} `（前后各一空格，避免与上下文粘连）；维持选区为插入后位置。
  3. textarea focus。
- 失败：toast + 还原按钮状态。
- 未 attach 任何 session（`getSession() === null`）：toast "先选一个 session" + 不触发 picker。

**为什么放进 textarea 而不是直接 send-keys**：移动端用户经常想"贴张图 + 加几句问题"再一起提交。强行 send-keys 会绕过 textarea 这个组合缓冲区。

### 2.7 图片上传 · 桌面端 UX

桌面端没有 textarea 缓冲区，所有键入都通过 xterm 直发 tmux。两条入口：

**入口 A · session header 按钮**

`src/web/desktop/desktop-view.ts` 的 session header（kill/refresh/detach 那一行）追加 📎 按钮。

行为：触发隐藏 file input → 上传 → 成功后 `term.send({kind:"keys", literal: " " + path + " "})` 注入到当前 attach 的 session。前后空格避免与已输入文本粘连。失败 → toast。上传中 → 按钮 disabled。

**入口 B · 剪贴板粘贴**

在 `desktop-view.ts` 的 `right` (main) 元素上挂 `paste` 监听：

```ts
right.addEventListener("paste", async (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  const imageItem = Array.from(items).find((it) => it.type.startsWith("image/"));
  if (!imageItem) return;                  // 纯文本粘贴 → 不拦截，xterm 内置 textarea-helper 接管
  e.preventDefault();
  e.stopPropagation();
  const file = imageItem.getAsFile();
  if (!file) return;
  try {
    const path = await uploadImageForSession(currentSession, file);
    term?.send({ kind: "keys", literal: " " + path + " " });
  } catch (err) {
    showToast(`上传失败: ${(err as Error).message}`, "error");
  }
});
```

**关键约束**：
- 监听挂在 `right` 不挂 `document`，避免污染 session-list 内 rename input 的文本粘贴。
- `e.preventDefault()` **只在确实抓到图片** 时调用；纯文本粘贴零干扰，xterm 接管。
- xterm 的内置 textarea helper 在 `el` 内部，paste 事件会**先**冒泡到 `right`，确认不是图片再让它继续——所以监听必须用冒泡阶段（默认）而非 capture 阶段。

**为什么不在 `el` (terminal-host) 上挂**：terminal-host 也在 `right` 里面，挂在 `right` 同样接得到所有冒泡；挂在更外层利于解耦，且未来 session-header 区域也想支持粘贴时不用改。

### 2.8 错误处理 / 边界 / 限额

| 触发 | 客户端反馈 | 服务端反馈 |
|---|---|---|
| mime 不在白名单 | 上传前拦截 + toast | 400 `unsupported content-type` |
| 大小超 20MB | 上传前拦截 + toast | 413 `file too large` |
| 0 字节 / 损坏 | 浏览器 File API 通常不让选 | 400 `empty file` |
| session 不存在 | 现有 410 路径 | 410（中间件已卡 grammar，外部 session 不让 attach） |
| 磁盘写失败 | toast | 500 + errno |
| 并发同 session 上传 | 不限制 | UUID 保证不冲突；input-router 仍按 session 串行 |
| 上传期间 session detach | 文件落盘成功；注入 send-keys 走现有 410 | — |
| `IMAGE_DIR` 不存在且 mkdir 失败 | toast | 500 + 路径 |

**安全检查**（旁路）：
- 路径由 server 生成，请求方不能影响落盘位置。
- `IMAGE_DIR` 配置者 = 部署者；不接受用户输入。
- session 名经 `assertGrammar` 校验，不会越权访问别人的 tmux。
- 不返回 stack trace；errno 摘要足够诊断。

### 2.9 测试策略

**单元** — `tests/unit/`：
- `image-upload-mime.test.ts`: mime 白名单 + ext 推断（png/jpeg/gif/webp/heic）+ 异常 mime 拒绝。
- `image-upload-path.test.ts`: 路径生成确定性（mock UUID + 固定日期）；ext 选择；不出现 `..`。

**集成** — `tests/integration/`：
- `image-upload-route.test.ts`: 起一个 Hono test client，POST 一个 fixture PNG（base64 inline 几 KB 即可），断言：
  - 200 响应，path 字段绝对路径以 `${TMUX_HUB_IMAGE_DIR}` 起头。
  - 盘上文件确实存在且字节数 = 上传字节数。
  - 重复发同一文件 → 不同 UUID，两个文件都存在。
  - mime `text/plain` 的 multipart → 400。
  - 21MB body → 413。

**E2E** — `tests/e2e/`：
- `mobile-image-attach.spec.ts`: 模拟 file picker（Playwright `setInputFiles`）→ 断 drawer 自动开 → textarea 含路径。
- `desktop-image-attach.spec.ts`: 同上但走 session-header 按钮 → 断 WS message 含 path 文本。
- `desktop-image-paste.spec.ts`: `page.evaluate` 合成 `ClipboardEvent` 含图片 item → 断不触发 xterm 文本路径 + WS 收到 path 文本。
- `mobile-rename.spec.ts`: 进编辑模式 → 输入合法名 → 保存 → 断 select 重画 + 当前选中。
- `empty-submit-enter.spec.ts`: drawer 空 textarea → 点提交 → 断 WS 只发了一条 `kind:"key", name:"Enter"`，没有 keys。

**手动验证**（PR 描述里写清楚）：
- 移动端 iOS Safari 真机：rename / 空提交 Enter / 拍照上传 / 相册上传。
- 桌面 Chrome：rename / paste 截图 / 按钮上传。
- 在 claude-code 里：路径注入后是否被识别为图片附件。

---

## 3. 模块拆分总览

| 模块 | 文件 | 改动类型 |
|---|---|---|
| 协议 | `src/shared/protocol.ts` | 不动（无新 WS 消息类型） |
| 路由 | `src/server/session-control.ts` 或新 `image-upload.ts` | 新增 POST upload-image |
| 配置 | `src/server/config.ts` | 新增 `IMAGE_DIR` + `MAX_IMAGE_BYTES` |
| 部署 | `deploy/hub.env.example` | 追加注释行 |
| 共享逻辑 | `src/web/shared/rename-controller.ts` | 新建（抽离桌面端逻辑） |
| 共享逻辑 | `src/web/upload/image-upload.ts` | 新建 |
| 移动 view | `src/web/mobile/mobile-view.ts` | 加 ✎ rename + 📎 attach |
| 移动 input | `src/web/mobile/input-box.ts` | 去掉空文本守卫 |
| 移动 attach | `src/web/mobile/image-attach.ts` | 新建 |
| 桌面 view | `src/web/desktop/desktop-view.ts` | session header 加 📎 + paste 监听 |
| 桌面 list | `src/web/desktop/session-list.ts` | 改用 shared rename-controller（小重构） |
| 样式 | `src/web/style.css` | 新增 mobile rename 编辑态、attach 按钮样式 |

总体改动量：4 个新文件，6 个文件修改；服务端 1 个新路由 + 2 行 config；不引入新 npm 依赖。

---

## 4. 不在范围内

- 桌面端拖拽（DnD）：第一版只做按钮 + 剪贴板，DnD 后续视使用率再说。
- 多图批量：file input 不带 `multiple`，一次一张。
- HEIC → JPEG 服务端转换：依赖 ffmpeg/imagemagick，引入额外部署负担；claude-code 实测能处理 HEIC，先不做。
- 自动清理策略：用户明确选了"永久保留 + 手动清理"。
- 上传进度条：20MB 以下在局域网内瞬时完成，不值得。
- 缩略图预览：textarea 内只显示路径文本即可；用户自己能从路径判断哪张图。
- 协议层加新 WS 消息类型（如 `kind:"image"`）：HTTP multipart 走带外通道天然不阻塞 WS 串行队列。

---

## 5. References

- 桌面端 rename 现有实现：`src/web/desktop/session-list.ts:71-129`
- 服务端 rename 路由：`src/server/session-control.ts:35-45`
- WS 协议：`src/shared/protocol.ts`
- 输入路由：`src/server/input-router.ts`
- 配置体系：`src/server/config.ts:44-50`
- 部署模板：`deploy/hub.env.example`
- 桌面输入字节流：`src/web/terminal.ts:281-284`
- 移动端工具栏组合：`src/web/mobile/mobile-view.ts:155-205`
- 之前 Enter 键 cooked/raw mode fix：commit `2870fbf`
