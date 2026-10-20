import { spawn, type ChildProcess } from "node:child_process";

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
  child.on('error',e=>console.error('foreground child launch failed:',e.message));
`;

export function launchOwnedProcessGroup(command: string, args: string[], logFd: number, env = process.env): OwnedProcessGroup {
  const processOwner = spawn("node", ["-e", leader, "--", String(process.pid), command, ...args], {
    detached: true, env, stdio: ["ignore", "ignore", logFd],
  });
  let stopped: Promise<void> | undefined;
  const group: OwnedProcessGroup = {
    process: processOwner,
    stop() {
      return stopped ??= (async () => {
        if (!processOwner.pid || processOwner.exitCode !== null || processOwner.signalCode !== null) return;
        let deadline: ReturnType<typeof setTimeout> | undefined;
        const exited = new Promise<void>((resolve) => processOwner.once("exit", () => resolve()));
        // The live leader pins ownership. One group-wide KILL also ends a
        // descendant that ignores TERM; no signal escalation relies on Chrome.
        try {
          try { process.kill(-processOwner.pid, "SIGKILL"); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
          await Promise.race([exited, new Promise<never>((_, reject) => {
            deadline = setTimeout(() => reject(new Error("owned foreground group did not exit")), 2000);
          })]);
        } finally { clearTimeout(deadline); }
      })();
    },
  };
  processOwner.once("error", (error) => { group.error = error; });
  return group;
}
