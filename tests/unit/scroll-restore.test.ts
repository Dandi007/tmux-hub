import { describe, test, expect } from "bun:test";
import { decideScrollRestore, snapshotLocalLfb } from "../../src/shared/scroll-restore";

// 决策表（spec v2 增补：tmux-hub 滚动跳顶修复 v2）逐行验证 + 边界。
// fresh attach（isFirstDelivery=true）：一律 bottom（INV-5：attach 后落点必须确定；
// serverLfb 不再影响决策——DB 记忆消费在 v2-3 退役，参数仅保留协议兼容）；
// reconnect（isFirstDelivery=false）：只信断线瞬间的本地快照 localLfb，无视 serverLfb。
describe("decideScrollRestore — 决策表", () => {
  test("fresh attach → 一律 bottom（INV-5，serverLfb × baseY 全组合）", () => {
    // serverLfb ∈ {0, 300, 4000, NaN, -5} × baseY ∈ {0, 900}：
    // 无记忆 / 正常值 / stale 超深值 / 脏值 / 负值，无论重建深度，全部显式钉底——
    // "默认已在底部"的假设被 hidden-slot attach 竞态证伪（findings v2）。
    for (const serverLfb of [0, 300, 4000, Number.NaN, -5]) {
      for (const baseY of [0, 900]) {
        expect(decideScrollRestore({ isFirstDelivery: true, serverLfb, localLfb: 0, baseY }))
          .toEqual({ action: "bottom" });
      }
    }
  });

  test("reconnect，断线前跟底（localLfb=0）→ bottom（INV-3，serverLfb 任意）", () => {
    expect(decideScrollRestore({ isFirstDelivery: false, serverLfb: 0, localLfb: 0, baseY: 900 }))
      .toEqual({ action: "bottom" });
    // serverLfb 有 stale 值也必须回底，不得被拽进历史
    expect(decideScrollRestore({ isFirstDelivery: false, serverLfb: 4000, localLfb: 0, baseY: 900 }))
      .toEqual({ action: "bottom" });
  });

  test("reconnect，断线前读历史（localLfb=500 ≤ baseY=900）→ restore 500，无视 serverLfb", () => {
    expect(decideScrollRestore({ isFirstDelivery: false, serverLfb: 0, localLfb: 500, baseY: 900 }))
      .toEqual({ action: "restore", lines: 500 });
    expect(decideScrollRestore({ isFirstDelivery: false, serverLfb: 9999, localLfb: 500, baseY: 900 }))
      .toEqual({ action: "restore", lines: 500 });
  });

  test("reconnect，本地位置超出重建深度（localLfb=4000 > baseY=900）→ restore 900（clamp，best-effort，INV-2）", () => {
    expect(decideScrollRestore({ isFirstDelivery: false, serverLfb: 0, localLfb: 4000, baseY: 900 }))
      .toEqual({ action: "restore", lines: 900 });
  });
});

describe("decideScrollRestore — 边界", () => {
  test("fresh，异常输入（localLfb 脏值 / baseY 负值）→ 仍是 bottom（INV-5 无条件）", () => {
    // fresh 时 localLfb 理论上恒 0，但脏值也不得改变落点
    expect(decideScrollRestore({ isFirstDelivery: true, serverLfb: 900, localLfb: 4000, baseY: 900 }))
      .toEqual({ action: "bottom" });
    expect(decideScrollRestore({ isFirstDelivery: true, serverLfb: 300, localLfb: 0, baseY: -1 }))
      .toEqual({ action: "bottom" });
    expect(decideScrollRestore({ isFirstDelivery: true, serverLfb: Number.POSITIVE_INFINITY, localLfb: 0, baseY: 900 }))
      .toEqual({ action: "bottom" });
  });

  test("reconnect，baseY=0：有本地位置 → clamp 到 0 即回底", () => {
    expect(decideScrollRestore({ isFirstDelivery: false, serverLfb: 0, localLfb: 300, baseY: 0 }))
      .toEqual({ action: "bottom" });
  });

  test("reconnect，负输入 clamp 到 0：负 localLfb 视同 0，负 baseY 视同 0", () => {
    expect(decideScrollRestore({ isFirstDelivery: false, serverLfb: 0, localLfb: -5, baseY: 900 }))
      .toEqual({ action: "bottom" });
    // baseY 为负（异常态）→ 可滚动深度按 0 算，回底
    expect(decideScrollRestore({ isFirstDelivery: false, serverLfb: 0, localLfb: 300, baseY: -1 }))
      .toEqual({ action: "bottom" });
  });

  test("reconnect，非有限输入（NaN/Infinity 防御）视同 0", () => {
    expect(decideScrollRestore({ isFirstDelivery: false, serverLfb: 0, localLfb: Number.NaN, baseY: 900 }))
      .toEqual({ action: "bottom" });
  });
});

// enterReconnecting() 的快照决策：bufferTrusted = client 的 reportingEnabled gate，
// 同时承担 "buffer 可信" 的语义（上一次恢复决策已执行完）。
describe("snapshotLocalLfb — 断线快照决策", () => {
  test("buffer 可信（bufferTrusted=true）→ 用当前采样值更新快照", () => {
    expect(snapshotLocalLfb({ bufferTrusted: true, currentLfb: 500, previousSaved: 0 })).toBe(500);
    // 用户已回底：跟底状态也要如实覆盖旧快照（INV-3 的输入来源）
    expect(snapshotLocalLfb({ bufferTrusted: true, currentLfb: 0, previousSaved: 500 })).toBe(0);
  });

  test("replay 中间态二次断线（bufferTrusted=false）→ 保留上一次快照，不被中间态污染", () => {
    // 场景：读历史 lfb=500 → 断线快照 500 → 重连 replay 进行中（RIS 已清空
    // buffer，采样是 0/垃圾）→ 再次断线。快照必须仍是 500。
    expect(snapshotLocalLfb({ bufferTrusted: false, currentLfb: 0, previousSaved: 500 })).toBe(500);
    expect(snapshotLocalLfb({ bufferTrusted: false, currentLfb: 37, previousSaved: 500 })).toBe(500);
    // fresh attach 首个恢复决策前断线：previousSaved 初值 0，保持 0
    expect(snapshotLocalLfb({ bufferTrusted: false, currentLfb: 123, previousSaved: 0 })).toBe(0);
  });

  test("防御性归一：负数/NaN 视同 0（两条路径都过 clamp）", () => {
    expect(snapshotLocalLfb({ bufferTrusted: true, currentLfb: -5, previousSaved: 500 })).toBe(0);
    expect(snapshotLocalLfb({ bufferTrusted: true, currentLfb: Number.NaN, previousSaved: 500 })).toBe(0);
    expect(snapshotLocalLfb({ bufferTrusted: false, currentLfb: 500, previousSaved: -5 })).toBe(0);
    expect(snapshotLocalLfb({ bufferTrusted: false, currentLfb: 500, previousSaved: Number.NaN })).toBe(0);
  });
});
