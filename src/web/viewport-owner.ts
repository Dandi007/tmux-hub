import type { ServerWsMessage } from "../shared/protocol";

export type ViewportOwner = "web" | "native";

export type ViewportState = {
  owner: ViewportOwner;
  cols: number;
  rows: number;
};

export type ViewportAction =
  | { type: "resize"; cols: number; rows: number }
  | { type: "suppress" }
  | { type: "none" };

/**
 * Pure function: determine what action to take when receiving a viewport message
 */
export function handleViewportMessage(
  msg: Extract<ServerWsMessage, { kind: "viewport" }>,
  current: ViewportState,
): { next: ViewportState; action: ViewportAction } {
  const next: ViewportState = {
    owner: msg.owner,
    cols: msg.cols,
    rows: msg.rows,
  };

  if (msg.owner === "native") {
    // Native owns: suppress local resize, adopt server's viewport
    return { next, action: { type: "resize", cols: msg.cols, rows: msg.rows } };
  } else {
    // Web owns: we control viewport, no action needed
    return { next, action: { type: "none" } };
  }
}

/**
 * Pure function: determine if we should send a resize request
 */
export function shouldSendResize(
  state: ViewportState,
  requestedCols: number,
  requestedRows: number,
): boolean {
  // Only send resize if web owns the viewport
  return state.owner === "web";
}
