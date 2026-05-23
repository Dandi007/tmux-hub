import { describe, test, expect } from "bun:test";
import { subscribeEvents } from "../../src/web/sse-client";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  url: string;
  closed = false;
  readyState = 1; // OPEN
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  close(): void { this.closed = true; this.readyState = 2; }
}

function freshFake(): typeof EventSource {
  FakeEventSource.instances = [];
  return FakeEventSource as unknown as typeof EventSource;
}

describe("sse-client", () => {
  test("subscribeEvents returns { stop, reconnect } and opens initial ES at /events", () => {
    const ES = freshFake();
    const handle = subscribeEvents(() => {}, { EventSourceCtor: ES });
    expect(typeof handle.stop).toBe("function");
    expect(typeof handle.reconnect).toBe("function");
    expect(FakeEventSource.instances.length).toBe(1);
    expect(FakeEventSource.instances[0]!.url).toBe("/events");
    handle.stop();
  });

  test("reconnect() closes old ES and opens a new one immediately", () => {
    const ES = freshFake();
    const handle = subscribeEvents(() => {}, { EventSourceCtor: ES });
    const first = FakeEventSource.instances[0]!;
    expect(first.closed).toBe(false);

    handle.reconnect();

    expect(first.closed).toBe(true);
    expect(FakeEventSource.instances.length).toBe(2);
    expect(FakeEventSource.instances[1]!.closed).toBe(false);
    handle.stop();
  });

  test("reconnect() cancels a pending onerror retry so no double-connect 1s later", async () => {
    const ES = freshFake();
    const handle = subscribeEvents(() => {}, { EventSourceCtor: ES });
    const first = FakeEventSource.instances[0]!;

    // Simulate transport error → schedules setTimeout(connect, 1000).
    first.onerror?.();
    expect(FakeEventSource.instances.length).toBe(1); // still 1, retry pending

    handle.reconnect();
    expect(FakeEventSource.instances.length).toBe(2);

    // Wait > 1s and confirm no third instance was opened by the cancelled retry.
    await new Promise((r) => setTimeout(r, 1500));
    expect(FakeEventSource.instances.length).toBe(2);
    handle.stop();
  });

  test("reconnect() called twice in a row is idempotent (no leaked open ES)", () => {
    const ES = freshFake();
    const handle = subscribeEvents(() => {}, { EventSourceCtor: ES });

    handle.reconnect();
    handle.reconnect();

    expect(FakeEventSource.instances.length).toBe(3);
    // Only the latest ES should be open; earlier two closed.
    expect(FakeEventSource.instances[0]!.closed).toBe(true);
    expect(FakeEventSource.instances[1]!.closed).toBe(true);
    expect(FakeEventSource.instances[2]!.closed).toBe(false);
    handle.stop();
  });

  test("stop() after reconnect prevents further auto-retry on subsequent errors", async () => {
    const ES = freshFake();
    const handle = subscribeEvents(() => {}, { EventSourceCtor: ES });
    handle.reconnect();
    handle.stop();

    // Simulate error on the latest (now closed via stop) ES; should NOT schedule a retry.
    FakeEventSource.instances[1]!.onerror?.();
    await new Promise((r) => setTimeout(r, 1500));
    expect(FakeEventSource.instances.length).toBe(2);
  });

  test("isConnected() returns true when ES is open", () => {
    const ES = freshFake();
    const handle = subscribeEvents(() => {}, { EventSourceCtor: ES });
    expect(handle.isConnected()).toBe(true);
    handle.stop();
    expect(handle.isConnected()).toBe(false);
  });

  test("reconnectIfNeeded() skips reconnect when ES is still open", () => {
    const ES = freshFake();
    const handle = subscribeEvents(() => {}, { EventSourceCtor: ES });
    expect(FakeEventSource.instances.length).toBe(1);

    handle.reconnectIfNeeded();

    expect(FakeEventSource.instances.length).toBe(1);
    expect(FakeEventSource.instances[0]!.closed).toBe(false);
    handle.stop();
  });

  test("reconnectIfNeeded() reconnects when ES is closed", () => {
    const ES = freshFake();
    const handle = subscribeEvents(() => {}, { EventSourceCtor: ES });
    const first = FakeEventSource.instances[0]!;

    // Simulate the ES being closed (e.g. network drop)
    first.close();
    expect(handle.isConnected()).toBe(false);

    handle.reconnectIfNeeded();

    expect(FakeEventSource.instances.length).toBe(2);
    expect(FakeEventSource.instances[1]!.closed).toBe(false);
    handle.stop();
  });

  test("onmessage parses JSON ServerEvent payloads", () => {
    const ES = freshFake();
    const received: unknown[] = [];
    const handle = subscribeEvents((e) => received.push(e), { EventSourceCtor: ES });
    const first = FakeEventSource.instances[0]!;

    first.onmessage?.({ data: JSON.stringify({ event: "snapshot", payload: [] }) });
    expect(received).toEqual([{ event: "snapshot", payload: [] }]);
    handle.stop();
  });
});
