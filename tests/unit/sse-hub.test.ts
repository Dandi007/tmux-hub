import { describe, test, expect } from "bun:test";
import { SseHub } from "../../src/server/sse";

type Ctl = { enqueue(b: Uint8Array): void };

describe("SseHub", () => {
  test("a client whose enqueue throws is dropped; the others still receive", async () => {
    const hub = new SseHub();
    const good = hub.attach().body!.getReader();
    hub.attach();
    expect(hub.clientCount()).toBe(2);

    // 模拟底层 stream 已关闭/出错但 cancel 没被调用：enqueue 抛 TypeError。
    const clients = [...(hub as unknown as { clients: Set<{ controller: Ctl }> }).clients];
    clients[1]!.controller = { enqueue() { throw new TypeError("Invalid state: Controller is already closed"); } };

    hub.emit({ type: "snapshot", sessions: [] } as never);
    expect(hub.clientCount()).toBe(1);

    const { value } = await good.read();
    expect(new TextDecoder().decode(value)).toContain('"snapshot"');
  });

  test("cancel removes the client", async () => {
    const hub = new SseHub();
    await hub.attach().body!.cancel();
    expect(hub.clientCount()).toBe(0);
  });
});
