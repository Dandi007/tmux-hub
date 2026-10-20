# 浏览器真实后台重连后的历史位置恢复

## 1 第一性原理：要什么
桌面或手机把浏览器页切到后台、后台完成重连，再返回该页时，应保留用户离底60行的历史位置；跟底页仍回到真实输出尾部。后台resize不能抢占pane，回前台后尺寸与落点都应收敛。保留弱网中间态保护和隐藏会话slot规则。

## 2 现状与根因
5039896在真实Chromium hidden→visible事件下，桌面/手机历史页后台重连后恢复失败。后台replay-done会把恢复决策挂在pendingDecision，但只有TerminalHandle.fit()消费；document.visibilitychange/focus走onResize，不消费pendingDecision。同尺寸回前台无新snapshot，所以用户仍在0而不是60；如再次resync，可信采样也可能把挂起的历史目标覆盖为0。

先前headless用例的会话slot隐藏不等同于document隐藏。Playwright默认focus emulation使页面保持visible；本轮用外部完整Chromium加connectOverCDP(noDefaults:true)和默认context，直接观测浏览器真实事件，不替换visibilityState或注入事件。Node连接可用，Bun的CDP连接超时不作为产品失败。

## 3 方案设计
让每个可见性恢复路径在fit后、发布resize前消费同一挂起落点；pool激活继续共用该逻辑。挂起决策期间的buffer仍是未恢复态，后续replay快照须保留已记忆目标，不能以buffer中间落点覆盖它。只在normal且可见时应用。已完成回放后的真实alternate-buffer切换清除旧normal挂起决策并记忆0；通过xterm解析队列中的barrier标记数据来源，断线前已入队的实时alt切换仍清目标，回放/RIS中间切换保持旧快照。不能用解析时的网络reportingEnabled状态猜测字节来源。alternate最终回放屏障也清除savedLocalLfb；前台未完成新回放期间的真实导航可以取代旧pending，并由观察器清除过时决策。新增buffer监听在关闭时dispose；保持fresh attach、alt-screen和用户显式滚动语义。

数据流：后台replay→pendingDecision→真实visible/focus→fit→消费恢复→publish resize。每次新回放开始先立即关闭采样，再在parse队列入口重关一次，覆盖排在此前的旧完成回调重新开门；新回放parse期间不消费旧pending。后台连续replay保持原目标；真实进入alt-screen使旧normal目标失效。

## 4 改动清单
- `src/web/terminal.ts`：统一pendingDecision消费及挂起态的可信快照门禁。
- `tests/e2e/foreground-browser.ts`：独立Chromium默认context的真实可见性测试工具，每个自有临时profile使用basic password store避免宿主桌面密钥环冷启动等待；阶段日志记录导航/恢复/清理耗时；直接CDP抓屏并断言截图前后行列数不变，避免Playwright重置外设CDP视口。临时profile和进程有界清理；回调独立40秒deadline，挂起也进入清理。
- `tests/e2e/fidelity-foreground.ts`、`fidelity-suite.ts`：真实后台重连/后台resize的桌面、移动触摸视口行为回归，跟底/无输入对照与隐藏事件断言；十种场景覆盖normal/alternate重叠回放、前台真实wheel覆盖旧pending。只冷导航一次，通过产品自身EventSource呈现的真实tab/picker等待fixture就绪并点击选择一次；不另外开SSE读取器，不重复debug open制造入口竞争。
- `tests/unit/foreground-browser.test.ts`：初始化日志失败时清理已获得的profile。
- `tests/e2e/foreground-cleanup.ts`：CDP已断开但进程仍活时，永不返回的回调独立超时后，实际浏览器PID退出且profile删除；红测持有自有进程组对象兜底，独立存活的组所有者在Chrome退出后仍固定PGID，stop一次杀掉整组并幂等；不依赖CDP或已退出Chrome的PID。所有者发现测试worker死亡也清理自有组；目录回收置于finally。
- `tests/helpers/owned-process-group.ts`、`tests/unit/owned-process-group.test.ts`：独立进程组所有者；真实子进程在主进程已退出后继续写入（正常/忽略TERM）先红后绿，并检查写入停止。
- 本spec和`AGENTS.md`索引。

## 5 测试计划与部署条件
先在5039896真实browser上失败回归，再实现。用例必须实际看到hidden/visible，不能把带focus emulation的无效入口计为通过。包含历史60、跟底0、新wheel位置25及无输入保留60、后台重连、连续后台回放、后台resize、旧完成消息延后到新resync之前、真实新快照仅放行RIS前缀后再次断线，最终仍60；挂起normal决策后真实alt切换再断线退出、实时alt字节入队未解析即close的受控交错；后者保持真实WS字节与真正transport close，仅把close通知固定在同task，不计为自然网络证据；resize明确要求前台两个网格轴均增大，不能只匹配两端旧尺寸；保留原屏幕与尺寸断言，输出完成匹配完整末行。
每个后台回归总生命周期预算90秒容纳独立browser启动和清理，应用行为poll仍为原5/10秒，不增加收敛等待。
完整build/lint/unit/integration、desktop/emulator/emulator-mobile E2E；独立审查通过，精确SHA的PR/main CI绿后部署dogfood。重跑本轮headed真实后台十场景及十场景受控弱网，保存原失败与新截图并亲眼核对，再复核#159的流式跟底和真实触摸场景。prod/accepted由主控人工验收授权执行，本loop不操作。

另：alternate重叠回放的受控用例采用生产`SessionEmulator.snapshot()`在Bun中生成模式完整的fallback字节，不冒充常规capture-pane路径的自然证据。常规capture-pane快照未保留alternate模式的独立缺口不在本PR修复范围，须另行真实观测与跟进；不能据此宣布完整TUI验收完成。

## 6 非目标
不改语音、harness、外部infra、生产权限或浏览器安装配置。不把Chromium移动模拟当作物理手机/iOS验收。
