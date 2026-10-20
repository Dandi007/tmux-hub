import { existsSync, writeFileSync, rmSync } from "node:fs";

type Controls = { listSessions(): string[]; killSession(name: string): void };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Keep the stop file until the app acknowledges it or its private session exits. */
export async function stopOwnedGenerator(dir: string, name: string, controls: Controls, waitMs = 500): Promise<{ acknowledged: boolean; forced: boolean }> {
  writeFileSync(`${dir}/stop`, "stop");
  const deadline = Date.now() + waitMs;
  while (!existsSync(`${dir}/done`) && Date.now() < deadline) await sleep(10);
  const acknowledged = existsSync(`${dir}/done`);
  let forced = false;
  if (!acknowledged) {
    if (controls.listSessions().includes(name)) { controls.killSession(name); forced = true; }
    const stopped = Date.now() + 500;
    while (controls.listSessions().includes(name) && Date.now() < stopped) await sleep(10);
    if (controls.listSessions().includes(name)) throw new Error(`owned generator session still alive: ${name}`);
  }
  rmSync(dir, { recursive: true, force: true });
  return { acknowledged, forced };
}
