import { describe, test, expect } from "bun:test";
import { launchSession } from "../../src/server/template-runner";

// Capture the tmux args launchSession emits without touching real tmux.
function capturingTmux() {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "has-session") return { stdout: "", stderr: "", code: 1 }; // not exists
    return { stdout: "", stderr: "", code: 0 };
  };
  return { calls, run };
}

function newSessionArgs(calls: string[][]): string[] {
  return calls.find((c) => c[0] === "new-session")!;
}

describe("launchSession locale defaults", () => {
  test("injects UTF-8 LANG + LC_CTYPE into new-session (root cause fix: C locale garbles 中文 in zsh ZLE)", async () => {
    const { calls, run } = capturingTmux();
    await launchSession({ name: "user-loc-1", cwd: "~", cmd: "zsh", tmuxRun: run });
    const joined = newSessionArgs(calls).join(" ");
    expect(joined).toContain("-e LANG=en_US.UTF-8");
    expect(joined).toContain("-e LC_CTYPE=en_US.UTF-8");
  });

  test("caller env overrides the locale default", async () => {
    const { calls, run } = capturingTmux();
    await launchSession({ name: "user-loc-2", cwd: "~", cmd: "zsh", env: { LANG: "C" }, tmuxRun: run });
    const ns = newSessionArgs(calls);
    const langVals = ns.filter((a, i) => ns[i - 1] === "-e" && a.startsWith("LANG="));
    expect(langVals).toEqual(["LANG=C"]); // exactly one LANG, the caller's
  });
});
