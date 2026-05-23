import type { ServerEvent } from "@shared/protocol";

export type SseHandle = {
  stop: () => void;
  reconnect: () => void;
};

export type SseDeps = {
  url?: string;
  EventSourceCtor?: typeof EventSource;
};

export function subscribeEvents(
  onEvent: (e: ServerEvent) => void,
  deps: SseDeps = {},
): SseHandle {
  const url = deps.url ?? "/events";
  const ES = deps.EventSourceCtor ?? EventSource;

  let es: EventSource | null = null;
  let stopped = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const connect = (): void => {
    if (stopped) return;
    es = new ES(url);
    es.onmessage = (m) => {
      try { onEvent(JSON.parse(m.data) as ServerEvent); } catch { /* drop bad frames */ }
    };
    es.onerror = () => {
      es?.close();
      es = null;
      if (stopped) return;
      retryTimer = setTimeout(() => { retryTimer = null; connect(); }, 1000);
    };
  };

  const stop = (): void => {
    stopped = true;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    es?.close();
    es = null;
  };

  const reconnect = (): void => {
    if (stopped) return;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    es?.close();
    es = null;
    connect();
  };

  connect();
  return { stop, reconnect };
}
