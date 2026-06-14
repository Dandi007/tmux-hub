import { parse } from "yaml";
import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createLogger } from "./logger";

const logger = createLogger("config");

export const TemplateSchema = z.object({
  id: z.string().min(1).max(16).regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().min(1),
  cwd_choices: z.array(z.string().min(1)).min(1),
  cmd: z.string().min(1),
});

export const TemplatesFileSchema = z.object({
  templates: z.array(TemplateSchema),
});

export type Template = z.infer<typeof TemplateSchema>;

export function parseTemplatesYaml(yaml: string): Template[] {
  const raw = parse(yaml);
  const parsed = TemplatesFileSchema.parse(raw);
  return parsed.templates;
}

export function loadTemplates(): Template[] {
  const path = process.env.TMUX_HUB_TEMPLATES_PATH ??
    resolve(homedir(), ".config/tmux-hub/templates.yaml");
  if (!existsSync(path)) {
    logger.warn({ path }, "templates file not found; using empty list");
    return [];
  }
  const yaml = readFileSync(path, "utf8");
  const templates = parseTemplatesYaml(yaml);
  logger.info({ templates: templates.map((t) => t.id) }, "templates loaded");
  return templates;
}

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  return p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : p;
}

export const HUB_PORT = Number(process.env.TMUX_HUB_PORT ?? 3101);
export const HUB_HOST = process.env.TMUX_HUB_HOST ?? "127.0.0.1";
export const WINDOW_COLS = Number(process.env.TMUX_HUB_COLS ?? 200);
export const WINDOW_ROWS = Number(process.env.TMUX_HUB_ROWS ?? 50);
// Locale injected into every launched session's env (LANG + LC_CTYPE). Without a
// UTF-8 locale the launched shell runs in C locale, where zsh's line editor
// mangles multibyte UTF-8 input (Chinese pasted/sent to the prompt garbles into
// U+FFFD + literal <00xx> bytes). Set "" to disable injection. macOS ships
// en_US.UTF-8; on a Linux deploy without it, override to C.UTF-8.
export const SESSION_LANG = process.env.TMUX_HUB_SESSION_LANG ?? "en_US.UTF-8";
export const REGISTRY_INTERVAL_MS = Number(process.env.TMUX_HUB_REGISTRY_INTERVAL_MS ?? 2000);
export const RING_BUFFER_BYTES = Number(process.env.TMUX_HUB_RING_BUFFER_BYTES ?? 1024 * 1024);
export const CAPTURE_PANE_LINES = Number(process.env.TMUX_HUB_CAPTURE_LINES ?? 2000);
const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024;

function parsePositiveInt(raw: string | undefined, fallback: number, envName: string): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    logger.warn({ envName, raw, fallback }, "invalid env var; using fallback");
    return fallback;
  }
  return parsed;
}

export const IMAGE_DIR = expandHome(
  process.env.TMUX_HUB_IMAGE_DIR ?? "~/Pictures/tmux-hub",
);
if (IMAGE_DIR.includes(" ")) {
  logger.warn({ imageDir: IMAGE_DIR }, "IMAGE_DIR contains spaces; injected paths will be split by TUI parsers");
}
export const MAX_IMAGE_BYTES = parsePositiveInt(
  process.env.TMUX_HUB_MAX_IMAGE_BYTES,
  DEFAULT_MAX_IMAGE_BYTES,
  "TMUX_HUB_MAX_IMAGE_BYTES",
);

// Per-connection replay cap: tail of session log sent on ws attach.
// Default 256KB keeps mobile xterm parsers from choking on large histories.
// Full history is still preserved on disk; this only limits a single replay.
export const REPLAY_CAP_BYTES = parsePositiveInt(
  process.env.TMUX_HUB_REPLAY_CAP_BYTES,
  256 * 1024,
  "TMUX_HUB_REPLAY_CAP_BYTES",
);

// Feature flag: when set, attach sends a coherent server-emulator snapshot
// instead of a raw byte-slice replay. Dual-path so the legacy path stays
// available for instant rollback (svc restart with the flag unset).
export const EMULATOR_ENABLED = process.env.TMUX_HUB_EMULATOR === "1";

// Lines of scrollback included in an attach snapshot. Capped because a full
// 5000-line serialize is ~287KB/41ms; 1000 lines is ~59KB/3.6ms (measured).
export const SNAPSHOT_SCROLLBACK_LINES = parsePositiveInt(
  process.env.TMUX_HUB_SNAPSHOT_SCROLLBACK_LINES,
  1000,
  "TMUX_HUB_SNAPSHOT_SCROLLBACK_LINES",
);

// === NL→command suggest (flag-gated, default off) ===
// 整功能开关；关闭时 pane-mode 恒返回 other、suggest 恒 translated:false，前端因此走字面直发。
export const SUGGEST_ENABLED = process.env.TMUX_HUB_SUGGEST === "1";
// CC Switch chat/completions 端点（本机统一 LLM 网关，见 cc-switch-proxy 记忆卡）。
export const SUGGEST_ENDPOINT =
  process.env.TMUX_HUB_SUGGEST_ENDPOINT ?? "http://127.0.0.1:15721/v1/chat/completions";
// 小模型名（CC Switch model-prefix 路由）。部署时按灵智实际小模型名覆盖；留空则调用失败→前端降级字面发送。
export const SUGGEST_MODEL = process.env.TMUX_HUB_SUGGEST_MODEL ?? "";
// 协议：chat（默认，OpenAI /v1/chat/completions，如 lingzhi/*）| responses（Codex /v1/responses SSE，
// 如 gpt/* GPT-OAuth 反代——它 404 on chat/completions，见 cc-switch-proxy 记忆卡）。
// 用 gpt/* 时三者须一致：PROTOCOL=responses + ENDPOINT=.../v1/responses + MODEL=gpt/<model>。
export const SUGGEST_PROTOCOL: "chat" | "responses" =
  process.env.TMUX_HUB_SUGGEST_PROTOCOL === "responses" ? "responses" : "chat";
// 喂给模型的 capture-pane 尾行数。
export const SUGGEST_CAPTURE_LINES = parsePositiveInt(
  process.env.TMUX_HUB_SUGGEST_CAPTURE_LINES, 40, "TMUX_HUB_SUGGEST_CAPTURE_LINES",
);
// 模型调用超时（ms）。
export const SUGGEST_TIMEOUT_MS = parsePositiveInt(
  process.env.TMUX_HUB_SUGGEST_TIMEOUT_MS, 6000, "TMUX_HUB_SUGGEST_TIMEOUT_MS",
);
