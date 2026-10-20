# 回放期间保留新的滚动位置

## 1 第一性原理：要什么

用户在可读的普通终端历史中滚动后，回放完成或连接再次断开都应保留这个新位置，包括明确回底。RIS 清空/重建缓冲造成的程序位置变化仍不得污染断线快照。隐藏页、alternate screen 和 fresh attach 的既有落点规则保持有效。

## 2 现状与根因

第28轮 f0530b7 的16个滚动用例中桌面4/8、手机8/8失败：初始resync已开始、replay尚未完成，实际滚到60行后断线，恢复为0。12个失败重连都只发送当前尺寸，属于回放期间的新位置丢失。

resync 将 reportingEnabled 置 false；snapshotLocalLfb 为防弱网二次断线采到 RIS 中间态而保留旧 savedLocalLfb。期间用户的真实滚动也被当作中间态丢弃。不能简单移除这一保护。

本地 xterm 5.3 源码核对：回放追加历史会改变 baseY，RIS/alternate 切换触发 buffer change；普通滚动只改变 viewportY。公共 onScroll 覆盖 API/键盘滚动，但 viewport 的原生 scroll 请求 suppressScrollEvent，因此还需要在 xterm 自己的 DOM scroll 处理之后观察 viewport。产品的 scrollback 上限为 MAX_SAFE_INTEGER，不依赖有限环形缓冲的 trim 行为。

## 3 方案设计

```text
xterm onScroll / viewport DOM scroll -> 采样(baseY, viewportY, type)
  baseY稳定且viewportY实际改变，normal且可见且已有完成回放 -> 新用户位置 -> savedLocalLfb
  buffer reset / 追加历史 / resize / 恢复动作 / hidden / alternate -> 只同步采样基线
resync/重连 -> 保留既有snapshotLocalLfb不可信缓冲保护
replay-done -> 按最新savedLocalLfb恢复，程序恢复期间禁止反向记为用户滚动
```

新增独立观察器，使用公开 onScroll/onResize/buffer.onBufferChange 与 viewport DOM scroll，直接识别实际位置变化，无需读取 xterm 私有 parser 或更改 WS 协议。允许观察的前提为已有完成的初次回放、可见、没有待消费的 hidden 决策。使用同步程序动作门禁包住 executeScrollDecision，finally 重置采样基线；销毁时解除全部订阅和 DOM listener。

不改 reportingEnabled 对远端上报的门禁，也不改 snapshotLocalLfb 的原有决策表。记录实际新的位置是独立于缓冲可信度的输入，不把 RIS 的0或重建中的历史深度当新用户意图。

## 4 改动清单

| 文件 | 内容 |
| --- | --- |
| src/web/scroll-intent.ts | 位置采样决策和公开 xterm/DOM 事件接线 |
| src/web/terminal.ts | 观察新位置更新本地快照，恢复动作门禁和销毁清理 |
| tests/unit/scroll-intent.test.ts | 用户上滚/回底、RIS与历史追加、程序恢复和不允许观察场景 |
| tests/e2e/fidelity-scroll-intent.ts | 真实重绘回放中的滚轮/API滚动与二次断线；无用户操作的弱网对照 |
| tests/e2e/fidelity-suite.ts | 注册桌面/手机共享行为回归 |
| AGENTS.md | 设计文档导航 |

## 5 测试与部署验收

先写失败回归。Playwright只延迟真实服务器回放帧或完成信号，保持消息顺序，不伪造 resync/scrollpos；从真实 resize 触发回放。覆盖快照之前真实鼠标滚轮上滚、快照解析后而完成信号前的scrollLines上滚、回底，以及无用户操作时回放期间断线仍保留旧60行。对恢复结果断言实际 linesFromBottom，同时核对屏幕。

保留原有弱网 snapshotLocalLfb 的0/37中间态保护、隐藏页、alternate screen 和回底回归。执行独立 socket 的 build、lint、全unit/integration及desktop/emulator，补emulator-mobile。精确head的PR CI成功才squash合入，精确merge的main push CI成功才直接部署dogfood。用第28轮原始无拦截时序（200ms窗口）复验桌面/手机，保留帧序、截图并亲眼检查；不得以1500ms等待代替修复验收。

## 6 非目标

不改服务端、上报协议、fresh attach固定回底规则或全局scrollback策略。不将没有实际viewport变化的手势扩展成新的滚动目标。不修改语音、prod、harness或外部infra。
