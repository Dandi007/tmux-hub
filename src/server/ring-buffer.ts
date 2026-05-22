export class RingBuffer {
  private buf: Uint8Array;
  private head = 0;        // next write index
  private size = 0;        // current bytes stored
  private totalWritten = 0;
  private wasTruncated = false;

  constructor(public readonly capacity: number) {
    if (capacity <= 0) throw new Error("RingBuffer capacity must be > 0");
    this.buf = new Uint8Array(capacity);
  }

  append(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    this.totalWritten += bytes.length;

    // If incoming chunk alone is larger than capacity, only keep its tail.
    let src = bytes;
    if (src.length > this.capacity) {
      src = src.subarray(src.length - this.capacity);
      this.wasTruncated = true;
    }

    if (this.size + src.length > this.capacity) this.wasTruncated = true;

    // Write into circular buffer
    const firstLen = Math.min(src.length, this.capacity - this.head);
    this.buf.set(src.subarray(0, firstLen), this.head);
    if (src.length > firstLen) this.buf.set(src.subarray(firstLen), 0);
    this.head = (this.head + src.length) % this.capacity;

    this.size = Math.min(this.capacity, this.size + src.length);
  }

  dump(): Uint8Array {
    if (this.size === 0) return new Uint8Array(0);
    const out = new Uint8Array(this.size);
    if (this.size < this.capacity) {
      // No wrap-around yet; head equals size, data is buf[0..head]
      out.set(this.buf.subarray(0, this.size));
    } else {
      // Buffer full; oldest byte is at head
      const tailLen = this.capacity - this.head;
      out.set(this.buf.subarray(this.head), 0);
      out.set(this.buf.subarray(0, this.head), tailLen);
    }
    return out;
  }

  truncated(): boolean {
    return this.wasTruncated;
  }

  bytesWritten(): number {
    return this.totalWritten;
  }

  reset(): void {
    this.head = 0;
    this.size = 0;
    this.totalWritten = 0;
    this.wasTruncated = false;
    this.buf.fill(0);
  }
}
