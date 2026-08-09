import { STATE_DIR, WORKSPACE_ROOT } from "@intentic/constants";
import { expect, test } from "vitest";
import { delegationNote } from "./delegation.js";

test("no connected provider means no note", () => {
    expect(delegationNote({})).toBeUndefined();
});

test("codex-only note documents codex exec and resume, and no opencode", () => {
    const note = delegationNote({ codexHome: `${WORKSPACE_ROOT}/${STATE_DIR}/auth/codex/a1` });
    expect(note).toContain("codex exec --sandbox danger-full-access --skip-git-repo-check");
    expect(note).toContain("resume <threadId>");
    expect(note).toContain("CODEX_HOME");
    expect(note).not.toContain("opencode");
});

test("grok-only note names the resolved xAI model, inlines the XDG path per command, and no codex", () => {
    const note = delegationNote({ openCodeXdg: `${WORKSPACE_ROOT}/${STATE_DIR}`, grokModel: "grok-4.20-0309-non-reasoning" });
    expect(note).toContain("XDG_DATA_HOME=/work/.intentic opencode run --model xai/grok-4.20-0309-non-reasoning");
    expect(note).toContain("--session <id>");
    expect(note).not.toContain("codex exec");
});

test("grok-only note without a resolved model omits the flag from the command and points at `opencode models`", () => {
    const note = delegationNote({ openCodeXdg: `${WORKSPACE_ROOT}/${STATE_DIR}` });
    // The run command carries no --model flag; the hint tells the agent how to pick one.
    expect(note).toContain("XDG_DATA_HOME=/work/.intentic opencode run '<task>'");
    expect(note).toContain("List xAI's current models with `opencode models`");
});

test("both providers ride one note with the shared delegation guidance", () => {
    const note = delegationNote({ codexHome: "/auth/codex/a1", openCodeXdg: "/auth" });
    expect(note).toContain("codex exec");
    expect(note).toContain("opencode run");
    expect(note).toContain("self-contained prompt");
    expect(note).toContain("follow log");
});
