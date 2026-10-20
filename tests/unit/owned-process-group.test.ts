import { expect, test } from "bun:test";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchOwnedProcessGroup, type OwnedProcessGroup } from "../helpers/owned-process-group";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean): Promise<void> {
  const start = Date.now();
  while (!check()) { if (Date.now() - start > 3000) throw new Error("owned fixture did not converge"); await sleep(20); }
}
function running(pid: number): boolean {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" });
  return result.status === 0 && Boolean(result.stdout.trim()) && !result.stdout.trim().startsWith("Z");
}

for (const ignoreTerm of [false, true]) {
  test(`group cleanup ends a surviving writer after its main process exits (ignore TERM=${ignoreTerm})`, async () => {
    const root = mkdtempSync(join(tmpdir(), "owned-group-test-"));
    const childFile = join(root, "child.pid"), mainFile = join(root, "main.pid"), writes = join(root, "writes");
    const writer = `const f=require('node:fs'); f.writeFileSync(${JSON.stringify(childFile)},String(process.pid));
      ${ignoreTerm ? 'process.on("SIGTERM",()=>{});' : ''}
      setInterval(()=>f.appendFileSync(${JSON.stringify(writes)},'x'),10);`;
    const main = `const f=require('node:fs'); f.writeFileSync(${JSON.stringify(mainFile)},String(process.pid));
      require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(writer)}],{stdio:['ignore','inherit','inherit']}).unref();
      process.exit(0);`;
    let group: OwnedProcessGroup | undefined, childPid = 0;
    const log = openSync(join(root, "process.log"), "w");
    try {
      group = launchOwnedProcessGroup("node", ["-e", main], log);
      await until(() => existsSync(childFile) && existsSync(mainFile) && existsSync(writes));
      childPid = Number(readFileSync(childFile, "utf8"));
      const mainPid = Number(readFileSync(mainFile, "utf8"));
      await until(() => !running(mainPid));
      expect(running(childPid)).toBe(true);
      await group.stop();
      await sleep(100);
      expect(running(childPid)).toBe(false);
      const stoppedSize = statSync(writes).size;
      await sleep(100);
      expect(statSync(writes).size).toBe(stoppedSize);
    } finally {
      // Red-case safety: this numeric PID came from this fixture's own writer.
      if (!childPid && existsSync(childFile)) childPid = Number(readFileSync(childFile, "utf8"));
      if (childPid && running(childPid)) { process.kill(childPid, "SIGKILL"); await until(() => !running(childPid)); }
      await group?.stop();
      closeSync(log);
      rmSync(root, { recursive: true, force: true });
    }
  });
}
