import { hubFetch } from "../hub-fetch";

export type PaneModeResult = { mode: "shell" | "other"; enabled: boolean };
export type SuggestResult =
  | { translated: true; command: string }
  | { translated: false }
  | { error: string };

export async function getPaneMode(session: string): Promise<PaneModeResult> {
  try {
    const r = await hubFetch(`/sessions/${encodeURIComponent(session)}/pane-mode`);
    if (!r.ok) return { mode: "other", enabled: false };
    const b = (await r.json()) as { mode?: string; enabled?: boolean };
    return { mode: b.mode === "shell" ? "shell" : "other", enabled: b.enabled !== false };
  } catch {
    return { mode: "other", enabled: false };
  }
}

export async function requestSuggestion(
  session: string, text: string, signal: AbortSignal,
): Promise<SuggestResult> {
  const r = await hubFetch(`/sessions/${encodeURIComponent(session)}/suggest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
    signal,
  });
  if (!r.ok) return { error: `HTTP ${r.status}` };
  const b = (await r.json()) as { translated?: boolean; command?: string };
  if (b.translated && typeof b.command === "string") return { translated: true, command: b.command };
  return { translated: false };
}
