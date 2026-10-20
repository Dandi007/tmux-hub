export type SessionInfo = {
  name: string;
  activity: number;
  attached: number;
  windows: number;
  cols: number;
  rows: number;
  grammar_ok: boolean;
  /** Active pane's terminal title — Claude Code sets this dynamically via OSC sequences. */
  pane_title: string;
  /** tmux `#{session_id}` ("$3"): tells a session apart from a newer one reusing its name. */
  id?: string;
};

export type ServerEvent =
  | { event: "snapshot"; payload: SessionInfo[] }
  | { event: "session_created"; payload: SessionInfo }
  | { event: "session_removed"; payload: { name: string } }
  | { event: "session_activity"; payload: SessionInfo }
  | { event: "server_down" }
  | { event: "server_up" }
  | { event: "replay_truncated"; payload: { name: string } };

export type ClientWsMessage =
  | { kind: "keys"; literal: string }
  // xterm onBinary carries Latin1 bytes (legacy mouse), not UTF8 text.
  | { kind: "binary"; data: string }
  | { kind: "key"; name: string }
  | { kind: "resize"; cols: number; rows: number; ifPinned?: true }
  // Mouse-wheel forwarding: alternate-screen TUI apps (claude code, vim, less)
  // own their off-screen content and run in mouse mode, so a mobile touch-drag
  // is translated into wheel reports the app scrolls itself. col/row are 1-based
  // cell coords of the touch point; notches is the number of wheel ticks.
  | { kind: "wheel"; direction: "up" | "down"; notches: number; col: number; row: number }
  | { kind: "ping"; ts: number }
  // Client render telemetry (opt-in via ?debug=perf). Logged server-side, never
  // forwarded to the pty — purely diagnostic.
  | { kind: "telemetry"; payload: Record<string, unknown> }
  // Scroll position recovery: client reports cursor position relative to buffer bottom
  // for cross-device scroll memory (linesFromBottom = viewport top distance to buffer bottom,
  // 0 = following buffer tail).
  | { kind: "scrollpos"; linesFromBottom: number };

export type ServerWsMessage =
  // After an applied resize (client opted in with `?resync=1`): the server is
  // about to re-send an aligned snapshot (RIS + capture), followed by the usual
  // scrollpos replay-done message. The client treats it like a reconnect.
  | { kind: "resync" }
  | { kind: "pong"; ts: number }
  // owner "web" + peer: another page pinned the pane to cols×rows (adopt it, a
  // resync follows). applied: acknowledgement of our own applied size (also
  // adopt: an intervening peer update may have changed our local grid).
  // released: the page that last pinned it left (reclaim).
  | { kind: "viewport"; cols: number; rows: number; owner: "native" | "web"; peer?: true; applied?: true; released?: true }
  // Scroll position recovery: server sends restored scroll position to client after attach,
  // allowing cross-device memory of user's viewing location in buffer history.
  | { kind: "scrollpos"; linesFromBottom: number };
