import { STATE_DIR, WORKSPACE_ROOT } from "@intentic/constants";
import { expect, test } from "vitest";
import { delegationNote } from "./delegation.js";

test("no connected provider means no note", () => {
    expect(delegationNote({})).toBeUndefined();
});

test("codex-only note documents codex exec and resume with the hook-trust flag, and no opencode", () => {
    const note = delegationNote({ codexHome: `${WORKSPACE_ROOT}/${STATE_DIR}/auth/codex/a1` });
    expect(note).toContain("codex exec --sandbox danger-full-access --dangerously-bypass-hook-trust --skip-git-repo-check");
    // The resume command carries the flag too — a continued thread reports the same way a fresh one does.
    expect(note).toContain("--dangerously-bypass-hook-trust resume <threadId>");
    expect(note).toContain("CODEX_HOME");
    expect(note).not.toContain("opencode");
});

test("grok-only note attaches to the warm server under the delegation title, and no codex", () => {
    const note = delegationNote({ openCodeUrl: "http://127.0.0.1:4096", grokModel: "grok-4.20-0309-non-reasoning" });
    expect(note).toContain("opencode run --attach http://127.0.0.1:4096 --title intentic-delegation --model xai/grok-4.20-0309-non-reasoning");
    expect(note).toContain("--session <id>");
    // Attach mode is what replaced the per-command credential prefix — the server holds the credential.
    expect(note).not.toContain("XDG_DATA_HOME");
    expect(note).not.toContain("codex exec");
});

test("grok-only note without a resolved model omits the flag from the command and points at `opencode models`", () => {
    const note = delegationNote({ openCodeUrl: "http://127.0.0.1:4096" });
    // The run command carries no --model flag; the hint tells the agent how to pick one.
    expect(note).toContain("opencode run --attach http://127.0.0.1:4096 --title intentic-delegation '<task>'");
    expect(note).toContain("List xAI's current models with `opencode models`");
});

test("both providers ride one note with the shared delegation guidance, pointing at the wait tool", () => {
    const note = delegationNote({ codexHome: "/auth/codex/a1", openCodeUrl: "http://127.0.0.1:4096" });
    expect(note).toContain("codex exec");
    expect(note).toContain("opencode run");
    expect(note).toContain("self-contained prompt");
    // The supervision story: wait on the child instead of polling its terminal.
    expect(note).toContain("`wait` tool");
    expect(note).toContain("don't sleep or re-read its terminal in a loop");
});
