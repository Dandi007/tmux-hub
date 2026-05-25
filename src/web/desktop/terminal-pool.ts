import { attachTerminal, type TerminalHandle, type TerminalState } from "../terminal";
import type { ClientWsMessage } from "@shared/protocol";

export type TerminalPoolHandle = {
  activate: (name: string) => void;
  getActive: () => string | null;
  ensure: (name: string) => void;
  remove: (name: string) => void;
  send: (msg: ClientWsMessage) => void;
  destroy: () => void;
  onActiveStateChange: (cb: (state: TerminalState, attempt?: number) => void) => void;
  retryActive: () => void;
  probeActive: () => void;
};

type Slot = {
  container: HTMLElement;
  handle: TerminalHandle | null;
  pending: boolean;
};

export function createTerminalPool(parent: HTMLElement): TerminalPoolHandle {
  const slots = new Map<string, Slot>();
  let activeName: string | null = null;
  let stateListeners: Array<(state: TerminalState, attempt?: number) => void> = [];

  const notifyState = (state: TerminalState, attempt?: number): void => {
    for (const cb of stateListeners) {
      try { cb(state, attempt); } catch {}
    }
  };

  const ensureSlot = (name: string): Slot => {
    let slot = slots.get(name);
    if (slot) return slot;
    const container = document.createElement("div");
    container.className = "term-slot";
    container.dataset.session = name;
    parent.appendChild(container);
    slot = { container, handle: null, pending: false };
    slots.set(name, slot);
    return slot;
  };

  const attachSlot = (name: string, slot: Slot): void => {
    if (slot.handle || slot.pending) return;
    slot.pending = true;
    void attachTerminal({ sessionName: name, parent: slot.container }).then(
      (handle) => {
        slot.pending = false;
        slot.handle = handle;
        handle.onStateChange((state, attempt) => {
          if (activeName === name) notifyState(state, attempt);
        });
        if (activeName === name) {
          handle.fit();
          notifyState(handle.state);
        }
      },
      (err) => {
        slot.pending = false;
        console.error(`[pool] attach failed for ${name}:`, err);
        if (activeName === name) notifyState("dead");
      },
    );
  };

  return {
    activate: (name) => {
      const slot = ensureSlot(name);
      attachSlot(name, slot);
      for (const [n, s] of slots) {
        s.container.classList.toggle("is-active", n === name);
      }
      activeName = name;
      if (slot.handle) {
        slot.handle.fit();
        notifyState(slot.handle.state);
      } else if (slot.pending) {
        notifyState("reconnecting", 0);
      }
    },

    getActive: () => activeName,

    ensure: (name) => {
      const slot = ensureSlot(name);
      attachSlot(name, slot);
    },

    remove: (name) => {
      const slot = slots.get(name);
      if (!slot) return;
      if (slot.handle) try { slot.handle.close(); } catch {}
      try { slot.container.remove(); } catch {}
      slots.delete(name);
      if (activeName === name) activeName = null;
    },

    send: (msg) => {
      if (!activeName) return;
      slots.get(activeName)?.handle?.send(msg);
    },

    onActiveStateChange: (cb) => { stateListeners.push(cb); },

    retryActive: () => {
      if (!activeName) return;
      slots.get(activeName)?.handle?.retry();
    },

    probeActive: () => {
      if (!activeName) return;
      slots.get(activeName)?.handle?.probeNow();
    },

    destroy: () => {
      for (const [, slot] of slots) {
        if (slot.handle) try { slot.handle.close(); } catch {}
        try { slot.container.remove(); } catch {}
      }
      slots.clear();
      stateListeners = [];
      activeName = null;
    },
  };
}
