import { expect, test } from "bun:test";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchOwnedProcessGroup, readLiveGroup, type OwnedProcessGroup } from "../helpers/owned-process-group";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean): Promise<void> {
  const start = Date.now();
  while (!check()) { if (Date.now() - start > 3000) throw new Error("owned fixture did not converge"); await sleep(20); }
}
function running(pid: number, marker: string): boolean {
  const result = spawnSync("/bin/ps", ["-ww", "-p", String(pid), "-o", "stat=", "-o", "args="], { encoding: "utf8", timeout: 500, killSignal: "SIGKILL" });
  if (result.error) throw result.error;
  return result.status === 0 && result.stdout.includes(marker) && !result.stdout.trim().startsWith("Z");
}

test("group observation sees a worker after its native main thread exits", async () => {
  const root = mkdtempSync(join(tmpdir(), "owned-thread-test-"));
  const pidFile = join(root, "pid"), writes = join(root, "writes"), stop = join(root, "STOP");
  const code = `import ctypes,threading,time,os\ndef worker():\n open(${JSON.stringify(pidFile)},'w').write(str(os.getpid()))\n while not os.path.exists(${JSON.stringify(stop)}):\n  open(${JSON.stringify(writes)},'a').write('x')\n  time.sleep(.01)\n os._exit(0)\nthreading.Thread(target=worker).start()\nctypes.CDLL(None).pthread_exit(None)`;
  const log = openSync(join(root, "process.log"), "w");
  let group: OwnedProcessGroup | undefined;
  try {
    group = launchOwnedProcessGroup("python3", ["-c", code], log);
    await until(() => existsSync(pidFile) && existsSync(writes));
    const pid = Number(readFileSync(pidFile, "utf8"));
    if (process.platform === "linux") {
      await until(() => spawnSync("/bin/ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8", timeout: 500 }).stdout.trim().startsWith("Z"));
    }
    const before = statSync(writes).size;
    await sleep(40);
    expect(statSync(writes).size).toBeGreaterThan(before);
    expect(await readLiveGroup(group.process.pid!)).toContain(pid);
    await group.stop();
  } finally {
    writeFileSync(stop, "stop");
    try { await group?.stop(); }
    finally { closeSync(log); rmSync(root, { recursive: true, force: true }); }
  }
});

test("a non-returning group query times out without blocking the event loop", async () => {
  const root = mkdtempSync(join(tmpdir(), "owned-query-test-"));
  const pidFile = join(root, "pid"), stop = join(root, "STOP");
  const code = `const f=require('node:fs');f.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{if(f.existsSync(${JSON.stringify(stop)}))process.exit(0);},10);`;
  let ticks = 0;
  const heartbeat = setInterval(() => ticks++, 10);
  try {
    const query = readLiveGroup(1, { command: "node", args: ["-e", code, "--"], timeoutMs: 500 });
    const outcome = await Promise.race([query.then(() => "unexpected success", (e) => String(e)), sleep(2000).then(() => "external guard expired")]);
    expect(outcome).toContain("foreground process query timed out");
    expect(ticks).toBeGreaterThan(5);
    expect(existsSync(pidFile)).toBe(true);
    const pid = Number(readFileSync(pidFile, "utf8"));
    await until(() => !running(pid, root));
  } finally {
    clearInterval(heartbeat);
    writeFileSync(stop, "stop");
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, "utf8"));
      await until(() => !running(pid, root));
    }
    rmSync(root, { recursive: true, force: true });
  }
});

for (const ignoreTerm of [false, true]) {
  test(`group cleanup ends a surviving writer after its main process exits (ignore TERM=${ignoreTerm})`, async () => {
    const root = mkdtempSync(join(tmpdir(), "owned-group-test-"));
    const childFile = join(root, "child.pid"), mainFile = join(root, "main.pid"), writes = join(root, "writes"), stopFile = join(root, "STOP");
    const writer = `const f=require('node:fs'); f.writeFileSync(${JSON.stringify(childFile)},String(process.pid));
      ${ignoreTerm ? 'process.on("SIGTERM",()=>{});' : ''}
      setInterval(()=>{if(f.existsSync(${JSON.stringify(stopFile)}))process.exit(0);f.appendFileSync(${JSON.stringify(writes)},'x');},10);`;
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
      await until(() => !running(mainPid, root));
      expect(running(childPid, root)).toBe(true);
      await group.stop();
      expect(running(childPid, root)).toBe(false);
      const stoppedSize = statSync(writes).size;
      await sleep(100);
      expect(statSync(writes).size).toBe(stoppedSize);
    } finally {
      try {
        // Red-case safety uses only this fixture's private control path.
        if (!childPid && existsSync(childFile)) childPid = Number(readFileSync(childFile, "utf8"));
        writeFileSync(stopFile, "stop");
        if (childPid) await until(() => !running(childPid, root));
      } finally {
        try { await group?.stop(); }
        finally { closeSync(log); rmSync(root, { recursive: true, force: true }); }
      }
    }
  });
}
