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
  | { kind: "key"; name: string }
  | { kind: "resize"; cols: number; rows: number }
  // Mouse-wheel forwarding: alternate-screen TUI apps (claude code, vim, less)
  // own their off-screen content and run in mouse mode, so a mobile touch-drag
  // is translated into wheel reports the app scrolls itself. col/row are 1-based
  // cell coords of the touch point; notches is the number of wheel ticks.
  | { kind: "wheel"; direction: "up" | "down"; notches: number; col: number; row: number }
  | { kind: "ping"; ts: number }
  // Client render telemetry (opt-in via ?debug=perf). Logged server-side, never
  // forwarded to the pty — purely diagnostic.
  | { kind: "telemetry"; payload: Record<string, unknown> };

export type ServerWsMessage =
  | { kind: "pong"; ts: number }
  | { kind: "viewport"; cols: number; rows: number; owner: "native" | "web" };
