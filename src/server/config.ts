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
