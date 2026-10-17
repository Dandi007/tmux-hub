// src/server/title-seq-filter.ts
// Strips GNU screen's window-name sequence `ESC k <name> ST` (ST = `ESC \`,
// BEL accepted too) from the live byte stream. zsh (oh-my-zsh termsupport)
// emits it before every command under TERM=tmux*/screen*; tmux consumes it as
// a window rename, but xterm.js does not know it and prints <name> as text —
// "printf" landed on the command's output line and was only partly
// overwritten (RSI round 9). Stateful because pipe-pane chunks split anywhere.

const ESC = 0x1b;
const BEL = 0x07;
const K = 0x6b;
const BACKSLASH = 0x5c;
// An unterminated name must not swallow the stream: give up after this many
// bytes and pass the rest through (tmux caps its input strings similarly).
const MAX_NAME_BYTES = 1024;

const enum State { Normal, Esc, Name, NameEsc }

export class TitleSeqFilter {
  private state = State.Normal;
  private nameBytes = 0;

  push(chunk: Uint8Array): Uint8Array {
    const out = new Uint8Array(chunk.length + 1); // +1: a held ESC from the previous chunk
    let n = 0;
    for (const b of chunk) {
      switch (this.state) {
        case State.Normal:
          if (b === ESC) this.state = State.Esc;
          else out[n++] = b;
          break;
        case State.Esc:
          if (b === K) { this.state = State.Name; this.nameBytes = 0; }
          else if (b === ESC) out[n++] = ESC; // ESC ESC: emit the first, keep holding
          else { out[n++] = ESC; out[n++] = b; this.state = State.Normal; }
          break;
        case State.Name:
          if (b === ESC) this.state = State.NameEsc;
          else if (b === BEL) this.state = State.Normal;
          else if (++this.nameBytes > MAX_NAME_BYTES) { out[n++] = b; this.state = State.Normal; }
          break;
        case State.NameEsc:
          if (b === BACKSLASH) this.state = State.Normal;
          // Any other escape ends the name and is itself kept.
          else if (b === ESC) this.state = State.Esc;
          else { out[n++] = ESC; out[n++] = b; this.state = State.Normal; }
          break;
      }
    }
    return out.subarray(0, n);
  }

  // A lone ESC held at the end of a chunk is released once no more bytes
  // follow (the caller flushes on an idle poll), so it is never stuck.
  flush(): Uint8Array {
    if (this.state !== State.Esc) return new Uint8Array(0);
    this.state = State.Normal;
    return Uint8Array.of(ESC);
  }
}
