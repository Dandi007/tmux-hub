import { connect, createServer, type Socket } from "node:net";

type Upgrade = { id: string; cols: string | null; rows: string | null; pin: string; accepted: boolean };

// Hold real server→browser TCP bytes, including HTTP101. The upstream request
// still runs: tests must await THIS live navigation's101 before activating it.
export async function holdWebSocketUpgrade(targetPort: number) {
  const sockets = new Set<Socket>();
  const waiting = new Set<{ client: Socket; chunks: Buffer[]; upgrade?: Upgrade }>();
  let held = true;
  const server = createServer(client => {
    const upstream = connect(targetPort, "127.0.0.1");
    sockets.add(client); sockets.add(upstream);
    const queue: { client: Socket; chunks: Buffer[]; upgrade?: Upgrade } = { client, chunks: [] }; waiting.add(queue);
    let request = "", response = "";
    client.on("data", chunk => {
      if (queue.upgrade) return;
      request += chunk.toString("latin1");
      if (!request.includes("\r\n\r\n")) return;
      const path = request.split("\r\n", 1)[0]?.split(" ")[1];
      if (path) {
        const u = new URL(path, "http://localhost");
        // Retain only nonsecret fields. Never expose request URLs/headers.
        queue.upgrade = { id: u.searchParams.get("rendererTestId") ?? "", cols: u.searchParams.get("cols"), rows: u.searchParams.get("rows"), pin: u.searchParams.get("pin") ?? "1", accepted: false };
      }
      request = "";
    });
    client.pipe(upstream);
    upstream.on("data", chunk => {
      if (!queue.upgrade?.accepted) {
        response += chunk.toString("latin1");
        if (response.includes("\r\n\r\n")) {
          if (queue.upgrade) queue.upgrade.accepted = /^HTTP\/1\.[01] 101\b/.test(response);
          response = "";
        }
      }
      if (held) queue.chunks.push(chunk); else client.write(chunk);
    });
    const close = () => { waiting.delete(queue); sockets.delete(client); sockets.delete(upstream); client.destroy(); upstream.destroy(); };
    for (const socket of [client, upstream]) { socket.on("error", close); socket.on("close", close); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("proxy did not bind TCP");
  return {
    port: address.port,
    upgrades: () => [...waiting].flatMap(q => q.upgrade ? [{ ...q.upgrade }] : []),
    buffered: () => [...waiting].reduce((n, q) => n + q.chunks.reduce((a, b) => a + b.length, 0), 0),
    hold() { held = true; },
    release() { held = false; for (const q of waiting) { for (const c of q.chunks) q.client.write(c); q.chunks = []; } },
    async close() { for (const s of sockets) s.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
