import type { ServerWsMessage } from "../shared/protocol";

export type ViewportOwner = "web" | "native";

export type ViewportState = {
  owner: ViewportOwner;
  cols: number;
  rows: number;
};

export type ViewportAction =
  | { type: "resize"; cols: number; rows: number }
  | { type: "reclaim" }
  | { type: "none" };

/**
 * Pure function: determine what action to take when receiving a viewport message
 */
export function handleViewportMessage(
  msg: Extract<ServerWsMessage, { kind: "viewport" }>,
  current: ViewportState,
): { next: ViewportState; action: ViewportAction } {
  // This only announces a former web pinner's departure. It does not say
  // that the native TTY detached, even when the sender labels it web.
  if (msg.released && current.owner === "native") {
    return { next: current, action: { type: "none" } };
  }
  const next: ViewportState = {
    owner: msg.owner,
    cols: msg.cols,
    rows: msg.rows,
  };

  if (msg.owner === "native") {
    // Native owns: suppress local resize, adopt server's viewport
    return { next, action: { type: "resize", cols: msg.cols, rows: msg.rows } };
  } else if (msg.released) {
    // The page that last pinned the pane left: pin it back to our size.
    return { next, action: { type: "reclaim" } };
  } else if (msg.peer || msg.applied) {
    // Another page pinned the pane: show it at that size (an aligned resync
    // follows) without sending a resize back — that would make the pages fight.
    // Own applied acknowledgements must restore the same authoritative grid
    // if a peer notification arrived while our resize request was pending.
    // We still own it: our next fit / focus / click re-pins it to our size.
    return { next, action: { type: "resize", cols: msg.cols, rows: msg.rows } };
  } else {
    // Web owns: we control viewport, no action needed
    return { next, action: { type: "none" } };
  }
}

/**
 * Pure function: determine if we should send a resize request
 */
export function shouldSendResize(state: ViewportState): boolean {
  // Only send resize if web owns the viewport
  return state.owner === "web";
}

/** SSE is a hint to recheck ownership on the ordered viewport WS stream. */
export function handleSessionActivity(
  current: ViewportState,
  attached: number,
): { next: ViewportState; action: ViewportAction } {
  // Keep the displayed native grid until the WS confirms actual authority.
  // Ordinary attached0 activity must not steal a confirmed web peer.
  return {
    next: current,
    action: attached === 0 && current.owner === "native" ? { type: "reclaim" } : { type: "none" },
  };
}
