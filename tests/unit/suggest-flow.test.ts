import { describe, test, expect } from "bun:test";
import { createSuggestFlow, type SuggestResult } from "../../src/web/mobile/suggest-flow";
import type { ClientWsMessage } from "../../src/shared/protocol";

function harness(opts: {
  mode?: "shell" | "other";
  session?: string | null;
  result?: SuggestResult | (() => Promise<SuggestResult>);
}) {
  let text = "";
  const sent: ClientWsMessage[] = [];
  const phases: string[] = [];
  const toasts: string[] = [];
  const flow = createSuggestFlow({
    getText: () => text,
    setText: (s) => { text = s; },
    send: (m) => sent.push(m),
    getSession: () => (opts.session === undefined ? "s1" : opts.session),
    getMode: () => opts.mode ?? "shell",
    requestSuggestion: async () => {
      const r = opts.result ?? { translated: true, command: "git push" };
      return typeof r === "function" ? r() : r;
    },
    onPhaseChange: (p) => phases.push(p),
    toast: (m) => toasts.push(m),
  });
  return { flow, setText: (s: string) => { text = s; }, getText: () => text, sent, phases, toasts };
}

describe("suggest-flow", () => {
  test("shell：NL→Review（填回命令，不发送）", async () => {
    const h = harness({ mode: "shell" });
    h.setText("把分支推上去");
    await h.flow.primary();
    expect(h.flow.phase()).toBe("review");
    expect(h.getText()).toBe("git push");
    expect(h.sent).toEqual([]);
  });
  test("Review→发送：字面发送命令 + Enter，回 draft 清空", async () => {
    const h = harness({ mode: "shell" });
    h.setText("把分支推上去");
    await h.flow.primary();           // → review
    await h.flow.primary();           // → send
    expect(h.sent).toEqual([{ kind: "keys", literal: "git push" }, { kind: "key", name: "Enter" }]);
    expect(h.flow.phase()).toBe("draft");
    expect(h.getText()).toBe("");
  });
  test("Review 内手改后发送，发的是改后文本", async () => {
    const h = harness({ mode: "shell" });
    h.setText("把分支推上去");
    await h.flow.primary();
    h.setText("git push --force");
    await h.flow.primary();
    expect(h.sent[0]).toEqual({ kind: "keys", literal: "git push --force" });
  });
  test("撤销：还原原文回 draft", async () => {
    const h = harness({ mode: "shell" });
    h.setText("把分支推上去");
    await h.flow.primary();
    h.flow.undo();
    expect(h.flow.phase()).toBe("draft");
    expect(h.getText()).toBe("把分支推上去");
  });
  test("other 模式：直接字面发送，不过模型", async () => {
    const h = harness({ mode: "other" });
    h.setText("ls -la");
    await h.flow.primary();
    expect(h.sent).toEqual([{ kind: "keys", literal: "ls -la" }, { kind: "key", name: "Enter" }]);
    expect(h.flow.phase()).toBe("draft");
  });
  test("空提交：裸 Enter，不过模型", async () => {
    const h = harness({ mode: "shell" });
    h.setText("");
    await h.flow.primary();
    expect(h.sent).toEqual([{ kind: "key", name: "Enter" }]);
  });
  test("translated:false（服务端复检非 shell）→ 字面发送", async () => {
    const h = harness({ mode: "shell", result: { translated: false } });
    h.setText("ls");
    await h.flow.primary();
    expect(h.sent).toEqual([{ kind: "keys", literal: "ls" }, { kind: "key", name: "Enter" }]);
    expect(h.flow.phase()).toBe("draft");
  });
  test("模型失败：toast + 原文留存，回 draft，不发送", async () => {
    const h = harness({ mode: "shell", result: { error: "boom" } });
    h.setText("把分支推上去");
    await h.flow.primary();
    expect(h.toasts.length).toBe(1);
    expect(h.getText()).toBe("把分支推上去");
    expect(h.flow.phase()).toBe("draft");
    expect(h.sent).toEqual([]);
  });
  test("loading 中 session 切走 → 丢弃结果，不进 review", async () => {
    let session: string | null = "s1";
    let text = "";
    const sent: ClientWsMessage[] = [];
    const flow = createSuggestFlow({
      getText: () => text, setText: (s) => { text = s; }, send: (m) => sent.push(m),
      getSession: () => session, getMode: () => "shell",
      requestSuggestion: async () => { session = "s2"; return { translated: true, command: "git push" }; },
      onPhaseChange: () => {}, toast: () => {},
    });
    text = "把分支推上去";
    await flow.primary();
    expect(flow.phase()).toBe("draft");
    expect(sent).toEqual([]);
  });
});
