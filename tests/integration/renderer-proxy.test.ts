import { expect, test } from "bun:test";
import { connect, createServer } from "node:net";
import { holdWebSocketUpgrade } from "../e2e/renderer-proxy";

test("cut proxy forwards fragmented HTTP101 headers exactly once before closing", async () => {
  const header = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n";
  const upstream = createServer(client => client.once("data", () => client.write(header)));
  await new Promise<void>(r => upstream.listen(0, "127.0.0.1", r));
  const address = upstream.address(); if (!address || typeof address === "string") throw Error("no port");
  const proxy = await holdWebSocketUpgrade(address.port, true); proxy.release(); proxy.cutBeforeViewport(true);
  try {
    const bytes = await new Promise<string>((resolve, reject) => {
      const client = connect(proxy.port, "127.0.0.1"); let body = "";
      client.on("connect", () => client.write("GET /ws/session?rendererTestId=fragment HTTP/1.1\r\nHost: localhost\r\n\r\n"));
      client.on("data", data => { body += data.toString(); }); client.on("end", () => resolve(body)); client.on("error", reject);
    });
    expect(bytes).toBe(header); expect(proxy.rejections()).toBe(1);
  } finally { await proxy.close(); await new Promise<void>(r => upstream.close(() => r())); }
});
