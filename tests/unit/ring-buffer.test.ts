import { describe, test, expect } from "bun:test";
import { RingBuffer } from "../../src/server/ring-buffer";

describe("RingBuffer", () => {
  test("appends and reads back under capacity", () => {
    const rb = new RingBuffer(10);
    rb.append(new Uint8Array([1, 2, 3]));
    rb.append(new Uint8Array([4, 5]));
    expect(Array.from(rb.dump())).toEqual([1, 2, 3, 4, 5]);
    expect(rb.truncated()).toBe(false);
    expect(rb.bytesWritten()).toBe(5);
  });

  test("drops oldest on overflow", () => {
    const rb = new RingBuffer(5);
    rb.append(new Uint8Array([1, 2, 3]));
    rb.append(new Uint8Array([4, 5, 6, 7]));
    expect(Array.from(rb.dump())).toEqual([3, 4, 5, 6, 7]);
    expect(rb.truncated()).toBe(true);
    expect(rb.bytesWritten()).toBe(7);
  });

  test("single append larger than capacity is tail-truncated", () => {
    const rb = new RingBuffer(3);
    rb.append(new Uint8Array([1, 2, 3, 4, 5]));
    expect(Array.from(rb.dump())).toEqual([3, 4, 5]);
    expect(rb.truncated()).toBe(true);
    expect(rb.bytesWritten()).toBe(5);
  });

  test("empty initial state", () => {
    const rb = new RingBuffer(8);
    expect(Array.from(rb.dump())).toEqual([]);
    expect(rb.truncated()).toBe(false);
    expect(rb.bytesWritten()).toBe(0);
  });

  test("reset clears state but preserves capacity", () => {
    const rb = new RingBuffer(4);
    rb.append(new Uint8Array([1, 2, 3, 4, 5]));
    expect(rb.truncated()).toBe(true);
    rb.reset();
    expect(Array.from(rb.dump())).toEqual([]);
    expect(rb.truncated()).toBe(false);
    expect(rb.bytesWritten()).toBe(0);
    rb.append(new Uint8Array([9, 9]));
    expect(Array.from(rb.dump())).toEqual([9, 9]);
  });

  test("multiple appends preserving order across wraparound", () => {
    const rb = new RingBuffer(5);
    rb.append(new Uint8Array([1, 2, 3]));
    rb.append(new Uint8Array([4, 5]));
    rb.append(new Uint8Array([6]));
    expect(Array.from(rb.dump())).toEqual([2, 3, 4, 5, 6]);
    rb.append(new Uint8Array([7, 8, 9, 10]));
    expect(Array.from(rb.dump())).toEqual([6, 7, 8, 9, 10]);
  });

  test("zero-length append is no-op", () => {
    const rb = new RingBuffer(4);
    rb.append(new Uint8Array([1, 2]));
    rb.append(new Uint8Array([]));
    expect(Array.from(rb.dump())).toEqual([1, 2]);
    expect(rb.bytesWritten()).toBe(2);
  });
});
