# Spec — tmux-hub 移动端录音按钮:长按不再触发文字选中(wf-d5610d H6)

> 线:wf-d5610d。判据冻结自考卷 goal.md H6。仓:tmux-hub。基线 main f7582de。

## 根因(已定位)

`src/web/style.css` 的 `.input-bar__mic` 按钮缺少 `user-select:none / -webkit-user-select:none /
-webkit-touch-callout:none / touch-action:none`——移动端长按麦克风触发原生文字选择/放大镜,
`voice-input.ts` pointerdown 的 preventDefault 拦不住。

## 修复

1. `.input-bar__mic`(及其内部图标元素)补齐上述四条 CSS;
2. `src/web/mobile/voice-input.ts` 增加 `contextmenu` 事件抑制(长按在部分浏览器走 contextmenu 路径);
3. 不改录音逻辑本身(pointer 事件流、音频管道零改动)。

## 判据

1. 代码判据(本单可验收):CSS 四条 + contextmenu 抑制落地;`bun run test`(仓内 test script)全绿;lint 绿。
2. 真机判据(用户手机按住 3s+ 轻微移动不出现选区/放大镜):**归用户确认**,本单在 MR 描述标注待真机验证,不阻塞合入。

## 硬线

- 只碰上述两文件与必要测试;不动 voice pipeline/服务端;
- 判据口径=「相对当刻基线无新增失败」。

# References
- wf-d5610d goal.md H6(判据原文);tmux-hub f7582de

## r3 补充(2026-08-17 22:4x,监督面):验收面收窄的负控制依据

- r2 验收实证:setup(bun install 389 包)已过;全量套件 485 测试仅 1 失败——
  `tests/integration/viewport-ownership.test.ts:58`(resize 集成,Expected>0 Received 0)。
- **负控制**:同测试在宿主环境(全配置)4 pass/0 fail——该失败系验收沙箱缺集成环境
  (pty/tmux),非本单改动所致(本单只动 CSS user-select 系与 contextmenu 抑制,与窗口 resize 无交集)。
- 故本单验收收窄为可移植面:`bun run lint:tests && bun test tests/unit`;集成套件由监督面
  在部署侧宿主环境跑全量(含该文件)作为 deployed 判据,不入沙箱 acceptance。
- 打捞:r1 实现(subject cfe4c1f,双审通过)直接复用。
