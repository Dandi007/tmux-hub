# H6 — tmux-hub 按住录音长按不再选中文字（attempt-context/v1 spec）

> Work folder: wf-d5610d
> 目标仓: Dandi007/tmux-hub
> base_ref: refs/heads/release/tmux-hub @ f7582dea37e2b0d0302b45a340fbad19d292102c（**非 main/master**，硬线 1）
> spec_revision_id: hub-h6-longpress-noselect-20260816_2240
> 关联 goal.md H6：tmux-hub `.input-bar__mic` 补齐 user-select 等 + 抑制 contextmenu。

## 0. 背景（根因已钉）

移动端按住录音按钮（`.input-bar__mic`）3s+ 轻微移动 → 触发原生文字选择/放大镜。根因（findings.md / goal.md H6）：
- `src/web/style.css` `.input-bar__mic` 规则块**缺** `user-select:none / -webkit-user-select:none / -webkit-touch-callout:none / touch-action:none`；
- `src/web/mobile/voice-input.ts:142` `pointerdown` 的 `e.preventDefault()` **拦不住原生长按选中**（iOS/Android 长按选中是独立手势，preventDefault on pointerdown 不够）。

## 1. 范围（In Scope）

仅改 `src/web/style.css`（`.input-bar__mic` 规则块补 4 个属性）+ `src/web/mobile/voice-input.ts`（抑制 contextmenu）+ `tests/`（若可测则加单测，否则至少 lint 不破）。不动其它 CSS 规则、不动 voice 录音逻辑、不动 server。

## 2. 终点判据（goal.md H6，不得放宽）

1. `.input-bar__mic` CSS 规则块含 `user-select:none`、`-webkit-user-select:none`、`-webkit-touch-callout:none`、`touch-action:none`；
2. voice-input.ts 抑制 `contextmenu` 事件（addEventListener contextmenu preventDefault）；
3. tmux-hub 重启后 `/system/health` 200；
4. 真机长按验收（按住 3s+ 轻微移动不出现选区/放大镜）属**用户确认项**——implementer/caller 不代替用户判绿，列为遗留。

## 3. 不变量（不得违反）

- INV-A — 不破坏现有录音逻辑：pointerdown/pointerup/pointercancel 现有逻辑保留；contextmenu 抑制是新增 listener，不改 pointerdown。
- INV-B — 不影响其它元素：user-select:none 只加在 `.input-bar__mic`（及必要时 `.input-bar__attach` 同款按钮），不加在全局或 textarea。
- INV-C — 最小改动：CSS 加 4 行属性；voice-input.ts 加 1 个 contextmenu listener。不重构。
- INV-D — 测试不破：现有 538 个 unit/integration 测试全绿；若加新测试须通过。

## 4. 实现要求（spec 所有权在此，实现方式交给 implementer）

### 4.1 CSS（src/web/style.css）

在 `.input-bar__mic` 规则块内补：
```css
.input-bar__mic {
  ...现有属性...
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
  touch-action: none;
}
```
- 建议同款属性也加到 `.input-bar__attach`（同为 pill 内圆形按钮，长按附件按钮也会触发选中）——implementer 判断，若 attach 也受影响则加，否则只 mic。**至少 mic 必加**。

### 4.2 contextmenu 抑制（src/web/mobile/voice-input.ts）

在 btn 的 listener 区（:142 附近）加：
```ts
btn.addEventListener("contextmenu", (e) => e.preventDefault());
```
- 抑制长按弹出的系统菜单（选中/复制/分享等）。

### 4.3 测试（可选）

若 tmux-hub 有 CSS/voice-input 的单测框架则加断言；否则确保 `bun run lint:tests && bun test tests/unit tests/integration` 全绿。CSS 属性存在性可在 voice-input 相关测试里断言 btn.style 或直接 grep 风格断言——implementer 判断是否有现成测试钩子，无则不强加（CSS 改动靠部署后真机+回显验证）。

## 5. 验收命令（acceptance）

```bash
cd <worktree>
bun run lint:tests && bun test tests/unit tests/integration
```

全绿。

## 6. 现状基线（implementer 起点必读）

- `git log -- src/web/style.css` HEAD = f7582de。
- style.css:882 `.input-bar__mic` 规则块（缺 4 属性）。
- voice-input.ts:142 pointerdown listener（preventDefault 拦不住长按选中）。
- 现有 538 pass（unit+integration）。
- /system/health 在 src/server/main.ts:107。

## 7. 终点判据映射

- ① CSS 4 属性 → 4.1 + 部署后回显规则块；
- ② contextmenu 抑制 → 4.2 + 回显代码；
- ③ /system/health 200 → 部署后验证；
- ④ 真机长按 → 用户确认项，列遗留。
