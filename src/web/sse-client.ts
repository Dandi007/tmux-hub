import type { ServerEvent } from "@shared/protocol";

export function subscribeEvents(onEvent: (e: ServerEvent) => void): () => void {
  let es: EventSource | null = null;
  let stopped = false;

  const connect = () => {
    if (stopped) return;
    es = new EventSource("/events");
    es.onmessage = (m) => {
      try { onEvent(JSON.parse(m.data) as ServerEvent); } catch { /* drop bad frames */ }
    };
    es.onerror = () => {
      es?.close();
      es = null;
      if (!stopped) setTimeout(connect, 1000);
    };
  };

  connect();
  return () => { stopped = true; es?.close(); es = null; };
}
