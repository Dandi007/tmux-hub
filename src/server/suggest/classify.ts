// tmux pane_current_command → 是否停在交互式 shell 提示符。
// 前台进程就是 shell 本身 = 光标在提示符（可翻译）；其它一切（TUI / 前台命令在跑）= other。
const SHELL_COMMANDS = new Set(["zsh", "bash", "fish", "sh"]);

export type PaneMode = "shell" | "other";

export function classifyPaneCommand(cmd: string): PaneMode {
  return SHELL_COMMANDS.has(cmd.trim()) ? "shell" : "other";
}
