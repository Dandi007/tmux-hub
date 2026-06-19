import { describe, test, expect } from "bun:test";
import { InputRouter, type TmuxRun } from "../../src/server/input-router";
import { encodeWheel } from "../../src/server/mouse-encode";

function recordingRun(): { run: TmuxRun; calls: string[][] } {
  const calls: string[][] = [];
  const run: TmuxRun = async (args) => {
    calls.push(args);
    return { stdout: "", stderr: "", code: 0 };
  };
  return { run, calls };
}

describe("InputRouter wheel", () => {
  test("sends the SGR wheel report to the pane via send-keys -l", async () => {
    const { run, calls } = recordingRun();
    const router = new InputRouter(run);

    await router.send("worksess", {
      kind: "wheel",
      direction: "down",
      notches: 2,
      col: 3,
      row: 4,
    } as any);

    expect(calls).toEqual([
      ["send-keys", "-t", "worksess:0.0", "-l", encodeWheel("down", 2, 3, 4)],
    ]);
  });

  test("clamps notches to a sane maximum", async () => {
    const { run, calls } = recordingRun();
    const router = new InputRouter(run);

    await router.send("worksess", {
      kind: "wheel",
      direction: "up",
      notches: 9999,
      col: 1,
      row: 1,
    } as any);

    const literal = calls[0]![4]!;
    // one report is 9 chars: ESC [ < 6 4 ; 1 ; 1 M
    const reportCount = literal.split("M").length - 1;
    expect(reportCount).toBe(20);
  });

  test("clamps col/row to >= 1", async () => {
    const { run, calls } = recordingRun();
    const router = new InputRouter(run);

    await router.send("worksess", {
      kind: "wheel",
      direction: "up",
      notches: 1,
      col: 0,
      row: -5,
    } as any);

    expect(calls[0]![4]).toBe(encodeWheel("up", 1, 1, 1));
  });

  test("no-op when notches resolve to zero (no tmux call)", async () => {
    const { run, calls } = recordingRun();
    const router = new InputRouter(run);

    await router.send("worksess", {
      kind: "wheel",
      direction: "up",
      notches: 0,
      col: 1,
      row: 1,
    } as any);

    expect(calls).toEqual([]);
  });
});
