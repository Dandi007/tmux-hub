// Scroll-restore decision — 纯函数，供 web client 在收到 server `scrollpos`
// 消息（= replay-done 信号 + DB 记忆值）后决定 viewport 落点。
//
// 背景：每次 attach/reconnect server 都发 RIS + capture-pane snapshot，client
// 的 scrollback 被清空重建为深度有限（≤ SNAPSHOT_SCROLLBACK_LINES）的 buffer。
// 持久化的 linesFromBottom（lfb）参照的却是重建前的无限 scrollback，直接
// scrollLines(-lfb) 会被 xterm clamp 到 buffer 顶——即"跳到最顶上"的字面成因。
//
// 不变量（见 spec，含 v2 增补）：
// - INV-1: 本地实时 lfb 是位置真值（v2 起 server DB 值不再参与任何决策）。
// - INV-2: reconnect 恢复目标超出重建 buffer 可滚动范围（> baseY）时 clamp 到
//   min(target, baseY)（本地值是用户真实位置，clamp 是 best-effort）。
// - INV-3: lfb == 0 的 client（跟底）在任何恢复路径下必须回到底部跟随。
// - INV-5: attach 后落点必须确定——fresh attach 一律显式钉底。

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
  /**
   * server 下发的 DB 值（0 = 无记忆/跟底）。v2 起不参与决策，参数保留：
   * 协议兼容（server 仍无条件下发）+ 未来可能恢复跨设备记忆 feature。
   */
  serverLfb: number;
  /** 断线瞬间快照的本地 lfb（fresh attach 时为 0） */
  localLfb: number;
  /** 恢复时刻重建 buffer 的可滚动深度 */
  baseY: number;
}): RestoreDecision {
  const localLfb = clampNonNegInt(input.localLfb);
  const baseY = clampNonNegInt(input.baseY);

  if (input.isFirstDelivery) {
    // Fresh attach：一律显式钉底（INV-5：attach 后落点必须确定）。
    // v1 曾假设"默认已在底部"（无记忆 → none），该假设被 hidden-slot attach
    // 竞态证伪——desktop pool 的 visibility:hidden slot 在 snapshot 大块写入
    // 期间 viewport 停在随机位置（实测过顶部/中间/底部三种，见 work folder
    // 2026/07/10/tmux-hub-scroll-jump-to-top-root-cause-fix findings v2 节）。
    // parse barrier 后显式 scrollToBottom 兜住该竞态；serverLfb（DB 记忆）
    // 无论 0/正常/超深/NaN 都不再消费（v2-3：跨设备记忆退役）。
    return { action: "bottom" };
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

// 断线瞬间的本地 lfb 快照决策——纯函数，供 enterReconnecting() 调用。
//
// 关键 invariant：bufferTrusted（= client 的 reportingEnabled gate）同时承担
// "buffer 是可信的用户状态" 的语义——只有上一次 scrollpos 恢复决策执行完毕后
// 它才为 true。若 replay 中间态（RIS 已清空 buffer、恢复决策尚未执行）发生
// 二次断线，此刻 buffer 是重建中间态，采样值是 0/垃圾——必须保留上一次快照，
// 否则用户位置被污染、最终恢复回底（弱网移动端高频场景）。
export function snapshotLocalLfb(input: {
  /** buffer 是否可信 = 上一次恢复决策已执行完（client 的 reportingEnabled） */
  bufferTrusted: boolean;
  /** 断线瞬间从 buffer 采样的 lfb（alt-screen 无 scrollback 语义，传 0） */
  currentLfb: number;
  /** 上一次快照值（buffer 不可信时原样保留） */
  previousSaved: number;
}): number {
  if (!input.bufferTrusted) return clampNonNegInt(input.previousSaved);
  return clampNonNegInt(input.currentLfb);
}
