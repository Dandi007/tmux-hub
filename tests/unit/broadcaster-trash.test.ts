// tests/unit/broadcaster-trash.test.ts
// stop({deleteLog: true}) must move the replay log into <LOG_DIR>/.trash
// instead of unlinking it, so a false session_removed (2026-07-10 incident)
// never destroys history irrecoverably.
import { describe, test, expect } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SessionBroadcaster } from "../../src/server/output-broadcaster";

const stubRun = async () => ({ stdout: "", stderr: "", code: 0 });

describe("broadcaster deleteLog → trash", () => {
  test("moves the log into .trash with content intact", async () => {
    const b = new SessionBroadcaster("trash-test-move", stubRun, false);
    writeFileSync(b.logPath, "precious scrollback");

    await b.stop({ deleteLog: true });

    expect(existsSync(b.logPath)).toBe(false);
    const trashDir = resolve(join(b.logPath, "..", ".trash"));
    const trashed = readdirSync(trashDir).filter((f) => f.startsWith("trash-test-move"));
    expect(trashed).toHaveLength(1);
    expect(readFileSync(join(trashDir, trashed[0]!), "utf8")).toBe("precious scrollback");
  });

  test("stop without deleteLog keeps the log in place", async () => {
    const b = new SessionBroadcaster("trash-test-keep", stubRun, false);
    writeFileSync(b.logPath, "keep me");

    await b.stop();

    expect(existsSync(b.logPath)).toBe(true);
    expect(readFileSync(b.logPath, "utf8")).toBe("keep me");
  });
});
