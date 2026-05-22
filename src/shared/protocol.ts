export type SessionInfo = {
  name: string;
  activity: number;
  attached: number;
  windows: number;
  grammar_ok: boolean;
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
  | { kind: "resize"; cols: number; rows: number };
