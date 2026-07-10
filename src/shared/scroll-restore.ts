// Scroll-restore decision — 纯函数，供 web client 在收到 server `scrollpos`
// 消息（= replay-done 信号 + DB 记忆值）后决定 viewport 落点。
//
// 背景：每次 attach/reconnect server 都发 RIS + capture-pane snapshot，client
// 的 scrollback 被清空重建为深度有限（≤ SNAPSHOT_SCROLLBACK_LINES）的 buffer。
// 持久化的 linesFromBottom（lfb）参照的却是重建前的无限 scrollback，直接
// scrollLines(-lfb) 会被 xterm clamp 到 buffer 顶——即"跳到最顶上"的字面成因。
//
// 不变量（见 spec）：
// - INV-1: 本地实时 lfb 是位置真值；server DB 值只在 fresh attach 时作初始化参考。
// - INV-2: 恢复目标超出重建 buffer 可滚动范围（> baseY）时，fresh attach 放弃
//   恢复留在底部；reconnect clamp 到 min(target, baseY)（本地值是用户真实位置，
//   clamp 是 best-effort；stale DB 值则直接放弃）。
// - INV-3: lfb == 0 的 client（跟底）在任何恢复路径下必须回到底部跟随。

export type RestoreDecision =
  | { action: "bottom" }                  // scrollToBottom（或保持跟底）
  | { action: "restore"; lines: number }  // scrollToBottom + scrollLines(-lines)
  | { action: "none" };                   // 什么都不做

// 防御性归一：负数 / NaN / Infinity 一律视同 0（DB 或私有 API 漂移的脏值
// 不应该产生任何滚动动作）。
const clampNonNegInt = (n: number): number =>
  Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;

export function decideScrollRestore(input: {
  /** 本次 attach 生命周期里第一个 scrollpos（fresh attach） */
  isFirstDelivery: boolean;
  /** server 下发的 DB 值（0 = 无记忆/跟底） */
  serverLfb: number;
  /** 断线瞬间快照的本地 lfb（fresh attach 时为 0） */
  localLfb: number;
  /** 恢复时刻重建 buffer 的可滚动深度 */
  baseY: number;
}): RestoreDecision {
  const serverLfb = clampNonNegInt(input.serverLfb);
  const localLfb = clampNonNegInt(input.localLfb);
  const baseY = clampNonNegInt(input.baseY);

  if (input.isFirstDelivery) {
    // Fresh attach：DB 值只是跨设备记忆的 best-effort 初始化（INV-1）。
    // 无记忆 → 保持默认在底，不需要任何动作。
    if (serverLfb === 0) return { action: "none" };
    // stale 超深值：目标不在重建 buffer 里，恢复没有意义——clamp 到顶正是
    // 跳顶 bug 的字面症状。诚实从底部开始（INV-2 fresh 分支，黄金律 1）。
    if (serverLfb > baseY) return { action: "none" };
    return { action: "restore", lines: serverLfb };
  }

  // Reconnect：只信断线瞬间的本地快照，无视 serverLfb——DB 值经过 1s 采样
  // 滞后 + 跨设备 LWW，永远不如本地快照准（INV-1）。
  // 断线前跟底 → 明确回底跟随（INV-3）；replay 可能把 viewport 留在中间态，
  // 所以这里是主动 scrollToBottom 而非 none。
  if (localLfb === 0) return { action: "bottom" };
  // 本地值是用户真实位置，超出重建深度时 clamp 到 baseY（INV-2 reconnect
  // 分支，best-effort）；baseY=0 时 clamp 结果为 0，等价于回底。
  const lines = Math.min(localLfb, baseY);
  if (lines === 0) return { action: "bottom" };
  return { action: "restore", lines };
}
