import { connect, createServer, type Socket } from "node:net";

// Hold real server→browser TCP bytes, including HTTP 101, so the native
// browser WebSocket stays CONNECTING. No viewport or replay bytes are invented.
export async function holdWebSocketUpgrade(targetPort: number) {
  const sockets = new Set<Socket>();
  const waiting: Array<{ client: Socket; chunks: Buffer[] }> = [];
  let held = true;
  const server = createServer(client => {
    const upstream = connect(targetPort, "127.0.0.1");
    sockets.add(client); sockets.add(upstream);
    const queue = { client, chunks: [] as Buffer[] }; waiting.push(queue);
    client.pipe(upstream);
    upstream.on("data", chunk => { if (held) queue.chunks.push(chunk); else client.write(chunk); });
    for (const socket of [client, upstream]) {
      socket.on("error", () => { client.destroy(); upstream.destroy(); });
      socket.on("close", () => { sockets.delete(socket); client.destroy(); upstream.destroy(); });
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("proxy did not bind TCP");
  return {
    port: address.port,
    buffered: () => waiting.reduce((n, q) => n + q.chunks.reduce((a, b) => a + b.length, 0), 0),
    release() { held = false; for (const q of waiting) { for (const c of q.chunks) q.client.write(c); q.chunks = []; } },
    async close() { for (const s of sockets) s.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
