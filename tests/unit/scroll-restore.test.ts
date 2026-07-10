import { describe, test, expect } from "bun:test";
import { decideScrollRestore } from "../../src/shared/scroll-restore";

// 决策表（spec：tmux-hub 滚动跳顶修复）逐行验证 + 边界。
// fresh attach（isFirstDelivery=true）：server DB 值仅作 best-effort 初始化（INV-1）；
// reconnect（isFirstDelivery=false）：只信断线瞬间的本地快照 localLfb，无视 serverLfb。
describe("decideScrollRestore — 决策表", () => {
  test("fresh，无记忆（serverLfb=0）→ none（默认在底）", () => {
    expect(decideScrollRestore({ isFirstDelivery: true, serverLfb: 0, localLfb: 0, baseY: 900 }))
      .toEqual({ action: "none" });
    // baseY 任意值都不影响
    expect(decideScrollRestore({ isFirstDelivery: true, serverLfb: 0, localLfb: 0, baseY: 0 }))
      .toEqual({ action: "none" });
  });

  test("fresh，正常恢复（serverLfb=300 ≤ baseY=900）→ restore 300", () => {
    expect(decideScrollRestore({ isFirstDelivery: true, serverLfb: 300, localLfb: 0, baseY: 900 }))
      .toEqual({ action: "restore", lines: 300 });
  });

  test("fresh，stale 超深值（serverLfb=4000 > baseY=900）→ none（留在底部，不跳顶，INV-2）", () => {
    expect(decideScrollRestore({ isFirstDelivery: true, serverLfb: 4000, localLfb: 0, baseY: 900 }))
      .toEqual({ action: "none" });
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
  test("fresh，serverLfb 恰好等于 baseY → restore（边界含等号）", () => {
    expect(decideScrollRestore({ isFirstDelivery: true, serverLfb: 900, localLfb: 0, baseY: 900 }))
      .toEqual({ action: "restore", lines: 900 });
  });

  test("baseY=0：fresh 有记忆 → none；reconnect 有本地位置 → clamp 到 0 即回底", () => {
    expect(decideScrollRestore({ isFirstDelivery: true, serverLfb: 300, localLfb: 0, baseY: 0 }))
      .toEqual({ action: "none" });
    expect(decideScrollRestore({ isFirstDelivery: false, serverLfb: 0, localLfb: 300, baseY: 0 }))
      .toEqual({ action: "bottom" });
  });

  test("负输入 clamp 到 0：负 serverLfb/localLfb 视同 0，负 baseY 视同 0", () => {
    expect(decideScrollRestore({ isFirstDelivery: true, serverLfb: -5, localLfb: 0, baseY: 900 }))
      .toEqual({ action: "none" });
    expect(decideScrollRestore({ isFirstDelivery: false, serverLfb: 0, localLfb: -5, baseY: 900 }))
      .toEqual({ action: "bottom" });
    // baseY 为负（异常态）→ 可滚动深度按 0 算，恢复放弃/回底
    expect(decideScrollRestore({ isFirstDelivery: true, serverLfb: 300, localLfb: 0, baseY: -1 }))
      .toEqual({ action: "none" });
    expect(decideScrollRestore({ isFirstDelivery: false, serverLfb: 0, localLfb: 300, baseY: -1 }))
      .toEqual({ action: "bottom" });
  });

  test("非有限输入（NaN/Infinity 防御）视同 0", () => {
    expect(decideScrollRestore({ isFirstDelivery: true, serverLfb: Number.NaN, localLfb: 0, baseY: 900 }))
      .toEqual({ action: "none" });
    expect(decideScrollRestore({ isFirstDelivery: false, serverLfb: 0, localLfb: Number.NaN, baseY: 900 }))
      .toEqual({ action: "bottom" });
  });
});
