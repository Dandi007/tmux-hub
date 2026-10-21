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

网页先连接后native attach/实际TTY resize属于本次既定独立发布验收。已在dogfood42c3adfe真实复现桌面197×47、手机56×42未采用native80×23/100×31；补同页无交互、无重连的grid+screen回归。SSE正向提示通过只读viewport_probe在串行WS上查询真实native状态，不凭SSE直接fit，也不因过期正向提示抢web pin；native尺寸发布给该session所有peer并调度对齐snapshot。隐藏页保存需求待激活；detach仍走已有条件resize。

补充独立审查路径：初始web pin失败必须关闭而不是以请求grid宣布成功；截断代理完整缓存HTTP101头后一次发送，显式分片测试与浏览器open计数证明实际Upgrade成功后才断流。

复核补充：native需求/在途对象明确kind、generation、requestId；peer只取消reclaim，probe保留。只读probe不依赖fit；失败保留需求，单一250/500/1000ms最多3次自动退避，后台/重连保留需求待重新可见/权威初始化。每次真实attached>0 activity或snapshot都登记probe需求，single-flight/代次合并在途工作。新增真实初始化peer交错及实际查询故障回归；晚接入用例记录连接创建/open/close，要求全程同一WS。

全量full6中continuous-exit weak历史wheel前置竞态：先前瞬时pending=false后，弱网队列又宣布resync，实际wheel before已pending=true。只修测试同步：代理按当前连接ID计queued/delivered，generator停止后正常历史操作等待当前队列清空、浏览器实际收到相同帧数、最后宣布resync解析完成。在DOM实际wheel事件捕获pending/resync/replay；若仍在replay归setup失败。只发一次wheel，不重试输入，不放宽原正滚动/重连保留断言；replay中输入仍由原确定性持帧用例覆盖。

Native实际TTY80×24→100×32→80×24的往返变化：当100×31的旧权威WS流尚在途，而较新80×23 SSE先到，即使新hint等于当前显示grid也要保留新代需求；旧completion只能消费自己代次。真实TTY调整、有序持帧、同一WS的桌面/手机回归，在冻结旧产品6c两端均实测browser100×31/pane80×23失败。修复仅补充“有未完成需求/在途时保留新hint”条件。

PR165首CI39540182006真实红：手机busy reconnect在overlapCount>3注入前置超时，121pass/1fail/24未运行；已真实重连，未进入画面/scroll验收。sleep0.008不保证5个30ms窗口都收到字节，任次quiet后不会再补overlap。覆盖拆分：新增真实WS+生产handlers/broadcaster/ResyncScheduler集成，在每次真实capture tap期间写私有log并等待poll确认，确证5captures/4retries/1overlap、随后静默同WS自动resync和scrollpos30契约；负控关闭onOverlap修复回调应使该集成失败。E2E保持真实busy输出进度、一次真实重连、停输出后screen==pane、scroll30及无额外WS，记录snapshot/retry/overlap而不再随机要求五次都重叠。

最终独审补充：往返提示屏障记录应用回调完成后的实际attached/cols/rows及序号，明确等本次80×23提示交付；不以任意正向事件计数代替。新增双网页路径：A实际SSE连接中断且重连受控暂停，B触发真实native100×31广播并延迟A整条WS流；TTY恢复80×23，A先采用旧广播，再恢复真实SSE snapshot。验证同一A WS无交互最终grid/screen收敛。失败诊断先保存原error及已有queue/barrier样本，各外部读取单独兜底，页面失效不能覆盖原始异常。

双网页冻结1d341ff（产品仍220）桌面/手机真实失败：A恢复snapshot已交付attached1/80×23，但显示100×31、pane80×23且同一WS。修复在没有未完成需求时允许相同hint纠正显示mismatch；在途相同hint只drain，不反复创建代次。

补充相反交付顺序：SSE恢复snapshot先到且显示仍80×23，随后旧peer广播100×31才到。snapshot来源作为显式source传到terminal，正向snapshot总安排一次有代次的只读probe；回复位于同一有序WS的旧广播之后，不依赖下一次交互或activity。活动提示仍沿用已有去重/有界退避。新增同一WS的snapshot-first两端回归。失败取证与generator清理各自保存错误，主行为已失败时保留主错误，独立清理失败仍使测试失败。

220精确CI39542391096：713单元过，112E2E过/1失败，其余未跑；手机continuous-exit weak在route分配连接ID时被旧应用导航reload销毁上下文，尚未执行scroll结果，取证也覆盖原异常。fidelity共用openSession改为health页认证+registry前置，再一次进入应用，避免旧导航创建目标WS；刻意fresh-attach reload仍发生在已确认连接/画面之后。原CI日志保留，不直接重跑。snapshot-first冻结aa2ad9a（产品9b）桌面/手机均实测同WS显示100×31/pane80×23。

最终收敛：删除全部正向hint/mismatch去重与snapshot source参数；attached>0每次真实activity或snapshot都requestNative(probe)，沿用single-flight+generation drain，隐藏不发送。Registry默认2秒轮询且仅真实字段变化emit；probe只query/广播/checked、不pin/不input/不emit SSE，因此没有query→SSE自激。三种往返顺序各在输出停止后观察超过两个registry周期，要求activity/probe/checked计数持续4.5秒不变，同WS、grid/screen断言保留。不扩展协议。

最终测试校准：关键往返提示交付后不再输入；marker在竞态前准备。随后暂停实际SSE并保持同一WS，必须先取得grid/screen收敛，再恢复真实SSE、观察4.5秒计数静止并复核最终尺寸/画面/连接数。避免额外activity掩盖丢需求。私有全套full8的vim WS错误已定位为测试写死3202、连接到另一个CI实例；vim测试改从本树emulator env文件读取端口，产品无变化。最终精确head CI仍作为完整门禁，原失败及未运行不计通过。

收尾断言同时固定native仍attached1、pane与browser均80×23，分别在暂停SSE的首次收敛点及静止窗口结束后验证，不能仅两端相等而允许共同错误pin。peer/detach/native子进程清理分别执行并收集错误，保留主异常；独立清理失败仍报错。产品源码继续与ccc相同。
