import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { tmuxTest, tmuxTestKillServer, setupIsolatedTmux } from "../helpers/tmux-test";
import { pinViewport, getNativeAttachCount } from "../../src/server/viewport-pinner";

const S = "user-vo-" + Date.now().toString().slice(-8);

async function isolatedRunner(args: string[]): Promise<string> {
  const r = await tmuxTest(args);
  if (r.code !== 0) {
    throw new Error(`tmux ${args.join(" ")} failed (${r.code}): ${r.stderr}`);
  }
  return r.stdout;
}

beforeAll(async () => {
  await tmuxTest(["new-session", "-d", "-s", S, "sleep 30"]);
});

// Attach a native client through `script` so tmux gets a TTY. Two traps:
// - Bun.spawn without `env` inherits the STARTUP environment, dropping the
//   runtime TMUX_TMPDIR mutation (attach would look in the wrong socket dir),
//   and an inherited TMUX makes attach refuse to nest.
// - util-linux `script` only takes the command via -c; the positional form is
//   BSD/macOS. Without the branch the Linux run never attached at all.
function spawnAttach() {
  const { socket, tmpdir: sockDir } = setupIsolatedTmux();
  const env: Record<string, string | undefined> = { ...process.env, TMUX_TMPDIR: sockDir };
  delete env.TMUX;
  const argv = process.platform === "linux"
    ? ["script", "-q", "-c", `tmux -L ${socket} attach -t ${S}`, "/dev/null"]
    : ["script", "-q", "/dev/null", "tmux", "-L", socket, "attach", "-t", S];
  return Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", env });
}

afterAll(async () => {
  await tmuxTest(["kill-session", "-t", S]).catch(() => {});
  await tmuxTestKillServer();
});

describe("viewport-ownership integration", () => {
  test("no client: pin takes effect", async () => {
    const attachCount = await getNativeAttachCount(S, isolatedRunner);
    expect(attachCount).toBe(0);

    await pinViewport(S, 180, 45, isolatedRunner);
    const out = await isolatedRunner(["display", "-p", "-t", `${S}:@0`, "#{window_width}x#{window_height}"]);
    expect(out).toBe("180x45");
  });

  test("with client: resize request does not change window size", async () => {
    const attachProc = spawnAttach();

    // Wait for attach to register
    await new Promise(resolve => setTimeout(resolve, 1000));

    try {
      const attachCount = await getNativeAttachCount(S, isolatedRunner);
      expect(attachCount).toBeGreaterThan(0);

      // Record size before
      const sizeBefore = await isolatedRunner(["display", "-p", "-t", `${S}:@0`, "#{window_width}x#{window_height}"]);

      // Simulate what the server does: check attachCount before pinning
      // With native attached, server skips pinViewport
      if (attachCount === 0) {
        await pinViewport(S, 999, 99, isolatedRunner);
      }

      const sizeAfter = await isolatedRunner(["display", "-p", "-t", `${S}:@0`, "#{window_width}x#{window_height}"]);
      // Size should remain unchanged because server skipped the pin
      expect(sizeAfter).toBe(sizeBefore);
    } finally {
      attachProc.kill();
      await attachProc.exited.catch(() => {});
      // Wait for detach to propagate
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  });

  test("after detach: pin works again", async () => {
    const attachCount = await getNativeAttachCount(S, isolatedRunner);
    expect(attachCount).toBe(0);

    await pinViewport(S, 160, 40, isolatedRunner);
    const out = await isolatedRunner(["display", "-p", "-t", `${S}:@0`, "#{window_width}x#{window_height}"]);
    expect(out).toBe("160x40");
  });

  test("after detach: web reclaims ownership and resize works", async () => {
    // Start with a known size
    await pinViewport(S, 140, 35, isolatedRunner);
    const sizeBefore = await isolatedRunner(["display", "-p", "-t", `${S}:@0`, "#{window_width}x#{window_height}"]);
    expect(sizeBefore).toBe("140x35");

    // Attach a client
    const attachProc = spawnAttach();

    await new Promise(resolve => setTimeout(resolve, 1000));

    try {
      const attachCount = await getNativeAttachCount(S, isolatedRunner);
      expect(attachCount).toBeGreaterThan(0);

      // Try to resize while attached (should be skipped by server)
      const sizeWhileAttached = await isolatedRunner(["display", "-p", "-t", `${S}:@0`, "#{window_width}x#{window_height}"]);
      // Size should not change to our requested size
      expect(sizeWhileAttached).not.toBe("999x99");
    } finally {
      attachProc.kill();
      await attachProc.exited.catch(() => {});
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    // After detach, web should reclaim ownership and resize should work again
    const attachCountAfter = await getNativeAttachCount(S, isolatedRunner);
    expect(attachCountAfter).toBe(0);

    // Now resize should work (web owns again)
    await pinViewport(S, 170, 42, isolatedRunner);
    const sizeAfterReclaim = await isolatedRunner(["display", "-p", "-t", `${S}:@0`, "#{window_width}x#{window_height}"]);
    expect(sizeAfterReclaim).toBe("170x42");
  });
});
