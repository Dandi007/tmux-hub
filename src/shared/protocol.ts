export type SessionInfo = {
  name: string;
  activity: number;
  attached: number;
  windows: number;
  cols: number;
  rows: number;
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
  | { kind: "resize"; cols: number; rows: number }
  | { kind: "ping"; ts: number };

export type ServerWsMessage =
  | { kind: "pong"; ts: number }
  | { kind: "viewport"; cols: number; rows: number; owner: "native" | "web" };

/**
 * 移动端 quick-launch 按钮硬编码调用的 template id。
 * 用户机器 ~/.config/tmux-hub/templates.yaml 必须存在这条 template，
 * 否则 mount 时 /templates 列表里找不到、按钮 disabled。
 */
export const MOBILE_QUICK_LAUNCH_TEMPLATE_ID = "kb-cc";
