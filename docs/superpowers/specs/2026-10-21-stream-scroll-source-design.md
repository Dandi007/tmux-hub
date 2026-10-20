# 流式输出重连后的跟底保真（#159）

## 1 第一性原理：要什么
无用户导航的桌面和手机终端在输出、重连、隐藏恢复、resize 后保持跟底。真实上滚与回底意图在回放中断后保留；弱网 RIS 中间状态不能污染位置记忆。

## 2 现状与根因
162316e 的真实 dogfood 已在手机、桌面复现无导航时离底 28/43/44 行。本轮仅日志诊断在桌面第24组复现离底38行，并确定事件来源：bottom 决策后 buffer baseY=viewportY=1004，DOM scrollTop=17000（行高17，即旧底1000），xterm ignoreNextScrollEvent=false、lastScrollTop=0。native scroll 将 viewportY 改为1000；观察器保存4行，后续可信快照保存10并恢复10，输出继续累积至38行。

xterm 5.3 的 Viewport._innerRefresh 先缩短 scroll-area，高度收缩会由浏览器直接钳制 scrollTop 到新底。由于随后要写的 scrollTop 与被钳制的值相同，不设置 ignoreNextScrollEvent。新输出在 native scroll 交付前已解析，DOM旧底被当成导航。这是位置本身被改变，单独忽略意图记录不足以修复。

## 3 方案设计
在 viewport 的 scroll **capture** listener 中检查：normal buffer 正跟底、可见 viewport 的 DOM 也正处底部（容许1px舍入）。此时在 xterm 的 bubble listener 前调用其即时 viewport geometry sync，使 scroll-area 与当前 buffer 对齐，再让原 scroll 事件正常交付。没有 stopPropagation、没有定时重试，也不改变 parser/reportingEnabled、snapshotLocalLfb 或滚动恢复决策。

用户主动离开 DOM 底部，或 buffer 已在历史位置，均保持原生导航路径。同步入口采用受限类型声明访问已锁定的 xterm 5.3 `_core.viewport.syncScrollArea(true)`；该版本没有公开的即时同步 API。访问使用 optional chaining，依赖升级时由真实浏览器回归检测行为变化。

数据流：快照收缩 → native scroll 排队 → 新输出 parse → scroll capture 条件检查/即时同步 → xterm scroll listener → 原位置观察器。

## 4 改动清单
- `src/web/scroll-intent.ts`：增加仅共享底部时的捕获阶段 geometry sync，与现有 observer 一同释放。
- `tests/e2e/fidelity-scroll-intent.ts`：真实浏览器/xterm 重现快照收缩、即时 render 与 live chunk 的交错，断言后续输出仍跟底，并覆盖 DOM 上滚、读历史时输出、回底。
- 本 spec 与 `AGENTS.md` 文档地图。

## 5 测试计划与发布条件
回归在旧生产 observer 上得到 afterReplay=4（预期0）。测试用安装的 xterm bundle 和 TypeScript 编译的真实 observer，不复制实现；唯一私有调用用于固定一次 render 的时序，无伪造 WS/控制消息。保留现有桌面/手机真实 wheel、回放中上滚/回底、无操作弱网回归。

完整 build/lint/unit/integration、desktop/emulator 与 emulator-mobile E2E；独立审查、精确 SHA 的 PR/main CI 成功后部署 dogfood。原自然桌面/手机各30组全部实际执行，核对 viewport、pane 尺寸与屏幕、隐藏恢复、resize、reload，保留截图与失败样本；另实际运行保序弱网延迟。生产及停 loop 由主控验收执行。

本轮另一组重日志诊断曾在上滚分支失败（60→0），尚不能证明与此根因相同；保留证据并要求自然验收继续覆盖，不把它视为已修复。

## 6 非目标
不改语音、prod、accepted、harness 或外部 infra。
