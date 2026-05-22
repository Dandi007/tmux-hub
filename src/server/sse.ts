import type { ServerEvent } from "../shared/protocol";

type Client = { controller: ReadableStreamDefaultController<Uint8Array> };

export class SseHub {
  private clients = new Set<Client>();

  attach(initial?: ServerEvent): Response {
    const enc = new TextEncoder();
    const client: Client = { controller: null as unknown as ReadableStreamDefaultController<Uint8Array> };
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        client.controller = controller;
        this.clients.add(client);
        if (initial) controller.enqueue(enc.encode(`data: ${JSON.stringify(initial)}\n\n`));
      },
      cancel: () => { this.clients.delete(client); },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "connection": "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  }

  emit(event: ServerEvent) {
    const bytes = new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
    for (const c of this.clients) {
      try { c.controller.enqueue(bytes); } catch { /* client gone */ }
    }
  }

  clientCount(): number {
    return this.clients.size;
  }
}
