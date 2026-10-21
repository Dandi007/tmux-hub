# Native ownership across independently delivered events

## 1. 第一性原理：要什么

Native TTY attached 时浏览器始终显示实际 pane grid；旧网页 pinner 关闭不应改动它。Native 离开后，真实 SSE 与 WebSocket 谁先交付都应恢复当前可见网页的测量尺寸及一致画面。保留隐藏标签、最新显式激活和流式滚动契约。

## 2. 现状与根因

PR164 merge push CI39530842019 的 CONNECTING hidden activation 在调用 renderer 前 pane 已由80×24变177×47。旧夹具 open 自带两次导航又 reload；代理只挡返回方向，旧导航仍能在服务端 pin，buffered 还包含已关闭连接。buildWsUrl 在 auth await 后读取 visible，过早激活也会合法产生 pin=1。需记录当前导航的真实 Upgrade 并在服务端101到达、A active/B hidden 后才激活，不改80×24断言。

两个已实测产品缺口：web released 通知会把已有 native owner 直接改成 web 并本地 fit；detach SSE 先于旧 native WS 时，SSE 看见当前 web 而不 reclaim，随后旧消息把 owner 留在 native。SSE 和 WS 不共享顺序，不能用其中一个的瞬时 owner 判断是否需要权威复核。

## 3. 方案设计

- released 仅是旧 web pinner 退出的提示，当前 native 状态保持不动，等待真正 detach。
- SSE attached→0（或首次0且 native 状态尚未交付）请求当前测量 grid 的真实 resize；本地不提前 fit，等同一有序 WS 上 applied/native 回复决定显示。普通 attached0 不产生 pin；已采用 native 时复核，若 native 元数据迟于 detach SSE 则在实际收到它后复核一次。复核 resize 标记 afterNative，服务端在串行 mutation 中只允许 native 确认后没有更新 web pin 的请求；较新 peer pin 的有序通知继续获胜。隐藏 slot 记住复核请求，激活后再发布。
- 每个复核有独立 requestId，完成回复只消费匹配的在途请求，peer取消不会让旧 completion 归到新请求。WS Upgrade不重置重试预算，只有当前连接已确认viewport并解析回放才恢复健康预算；初始化前连续关闭累计8次失败、退避并进入dead，人工retry/定时probe按既有路径重试。
- 每次新 detach 需求有独立代次，旧回复只能消费发送时覆盖的代次。初始化无法取得权威尺寸则关闭该WS重试，不维持无权威但心跳正常的连接。SSE恢复snapshot向已有终端同步attached状态。
- 复核保留到显式 viewport_checked 回复；在途 resize 保留最新测量，成功后仍为自身 web pin 才有条件补发。错误保留需求供下一次交互重试，跨连接等待新初始权威回复再复核；新连接的 pinVersion 在初始化建立，自己的 applied 更新基准。
- 测试代理只计活连接，解析并保存无凭据的测试连接ID、pin/grid和101状态。当前导航/连接的真实101作为 CONNECTING 前置 barrier；取消该用例多余导航。
- native race 回归仅暂缓真实 WS 的整个有序消息队列，SSE正常交付；不伪造 viewport/snapshot 字节。

## 4. 改动清单

- `src/shared/protocol.ts` / `src/server/session-peers.ts` / `src/server/ws-handlers.ts`：native 确认记录 web pin 代次，条件复核不覆盖较新 peer。
- `src/web/desktop/desktop-view.ts` / `src/web/mobile/mobile-view.ts`：SSE恢复snapshot同步native状态。
- `src/web/viewport-owner.ts`：native 状态忽略 web released。
- `src/web/terminal.ts`：detach 状态变化请求权威 resize，保持显示直到回复。
- `tests/e2e/desktop-reconnect-budget.ts`：真实HTTP101前缀后断流，记录原调度间隔并加速执行，验证8次预算、dead按钮与健康恢复。
- `tests/e2e/helpers.ts` / `renderer-proxy.ts` / `desktop-renderer-fit.ts`：活连接/导航握手前置。
- `tests/e2e/native-recheck-progress.ts`：在途再resize、隐藏跨重连激活、一次明确标注的客户端错误注入与交互重试。
- 新 native 所有权顺序 E2E：真实 TTY、桌面/手机、延迟顺序及尺寸/画面验证。
- `tests/unit/viewport-ownership.test.ts` / `tests/integration/ws-viewport.test.ts`：native release 与迟到复核保护 peer 行为。
- `AGENTS.md`：登记本 spec。

## 5. 测试计划与发布条件

先在未改产品代码上实跑 detach-first/release 两类回归并保留失败；握手夹具保留80×24、可见性和实际renderer测量变化断言，增加受控 auth 延迟证明旧前置问题。修复后完整 build/lint/unit/integration、desktop/emulator 与 CI emulator-mobile；原生 dogfood 桌面/手机流式跟底、主动历史保留、hidden恢复、resize/弱网及 native 在线/退出场景实际运行并看截图。独立冻结审查、精确head PR CI 和 merge push CI成功才 deploy-dogfood。记录准确SHA与未完成HIL交给主控。

## 6. 非目标

不改语音、prod/accepted、harness、外部infra；非发布阻断生命周期/VT细节单列backlog。移动视口是Chromium模拟，不冒充物理手机/WebKit/HIL。

未改路径的“网页先连接、native后来接入/调尺寸”SSE正向同步是独立审查发现的静态既有缺口，单列backlog与handoff待真实复核。本spec的native先连接、退出/旧pinner关闭验收不代替该方向；不据此声明完整生产验收通过。
