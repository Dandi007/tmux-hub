import { spawn, spawnSync, type ChildProcess } from "node:child_process";

export type OwnedProcessGroup = { process: ChildProcess; error?: Error; stop(): Promise<void> };

// The group leader remains alive independently of the browser. That pins this
// PGID while cleanup kills descendants, even if the browser has already exited.
// If the calling worker dies, the leader kills its own still-owned group.
const leader = `
  const {spawn}=require('node:child_process');
  const parent=Number(process.argv[1]);
  process.on('SIGTERM',()=>{});
  setInterval(()=>{
    if(process.ppid!==parent) process.kill(-process.pid,'SIGKILL');
  },100);
  const child=spawn(process.argv[2],process.argv.slice(3),{stdio:['ignore','inherit','inherit']});
  const reaped=()=>{if(process.connected)process.send({kind:'child-exited'},()=>{});};
  child.on('error',e=>{console.error('foreground child launch failed:',e.message);reaped();});
  child.on('exit',reaped);
  process.on('message',m=>{
    if(m.kind!=='stop-child')return;
    if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
    else reaped();
  });
  process.on('disconnect',()=>process.kill(-process.pid,'SIGKILL'));
`;

export function launchOwnedProcessGroup(command: string, args: string[], logFd: number, env = process.env): OwnedProcessGroup {
  const processOwner = spawn("node", ["-e", leader, "--", String(process.pid), command, ...args], {
    detached: true, env, serialization: "json", stdio: ["ignore", "ignore", logFd, "ipc"],
  });
  let childReaped = false;
  let reaped!: () => void;
  const childExit = new Promise<void>((resolve) => { reaped = resolve; });
  processOwner.on("message", (message) => {
    if ((message as { kind?: string }).kind === "child-exited") { childReaped = true; reaped(); }
  });
  let stopped: Promise<void> | undefined;
  const group: OwnedProcessGroup = {
    process: processOwner,
    stop() {
      return stopped ??= (async () => {
        if (!processOwner.pid) return;
        let deadline: ReturnType<typeof setTimeout> | undefined;
        // The live leader pins ownership. One group-wide KILL also ends a
        // descendant that ignores TERM; no signal escalation relies on Chrome.
        try {
          if (processOwner.exitCode === null && processOwner.signalCode === null) {
            // Reap the direct Chrome child before ending its parent. Otherwise
            // a dead Chrome PID can remain orphaned while the host init reaps it.
            if (!childReaped) {
              processOwner.send({ kind: "stop-child" }, () => {});
              await Promise.race([childExit, new Promise<void>((resolve) => setTimeout(resolve, 1000))]);
            }
            // Re-check after the acknowledgement await. Once the owner has
            // exited, cleanup may only observe the old PGID, never signal it.
            if (processOwner.exitCode === null && processOwner.signalCode === null) {
              const exited = new Promise<void>((resolve) => processOwner.once("exit", () => resolve()));
              try { process.kill(-processOwner.pid, "SIGKILL"); }
              catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
              await Promise.race([exited, new Promise<never>((_, reject) => {
                deadline = setTimeout(() => reject(new Error("owned foreground owner did not exit")), 2000);
              })]);
            }
          }
          // Observation only after the pinned owner exits: never send another
          // signal using a potentially recycled PGID. Reuse can only make this
          // conservative check wait/fail; it cannot target an unrelated group.
          const start = Date.now();
          for (;;) {
            const ps = spawnSync("ps", ["-eo", "pgid=,stat="], { encoding: "utf8" });
            if (ps.status !== 0) throw new Error("could not confirm foreground group exit");
            const live = ps.stdout.trim().split("\n").some((line) => {
              const [pgid, state] = line.trim().split(/\s+/);
              return Number(pgid) === processOwner.pid && state && !state.startsWith("Z");
            });
            if (!live) break; // Zombies have exited and released their file descriptors.
            if (Date.now() - start >= 2000) throw new Error("foreground group members did not exit");
            await new Promise<void>((resolve) => setTimeout(resolve, 20));
          }
          if (!childReaped) throw new Error("foreground child exit was not acknowledged");
        } finally { clearTimeout(deadline); }
      })();
    },
  };
  processOwner.once("error", (error) => { group.error = error; });
  return group;
}
