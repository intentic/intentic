import { WORKSPACE_ROOT } from "@intentic/constants";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { describe, expect, test } from "vitest";
import { classifyCommand, createFrameLedger, createVerificationLedger } from "./agent-verification.js";

describe("command classification", () => {
    test.each([
        ["pnpm test", "test"],
        ["pnpm -C _shared/workspace-ignore test", "test"],
        ["./node_modules/.bin/vitest run src/a.test.ts", "test"],
        ["CI=1 npx vitest run", "test"],
        ["./node_modules/.bin/tsgo --noEmit -p tsconfig.json", "typecheck"],
        ["pnpm oxlint --deny-warnings", "lint"],
        ["cargo test", "test"],
        ["go build ./...", "build"],
        ["cd _editor/web && pnpm typecheck", "typecheck"],
    ])("%s proves %s", (command, kind) => {
        expect(
            command
                .split(/(?:&&|\|\||;|\|)/)
                .map(classifyCommand)
                .find((k) => k !== undefined),
        ).toBe(kind);
    });

    test.each(["ls -la", "git status", "cat package.json", "echo test", "rm -rf dist"])("%s proves nothing", (command) => {
        expect(classifyCommand(command)).toBeUndefined();
    });

    // Keys on command position, not a substring anywhere in the line, so `echo test` does not count as a test run.
    test("a check named only as an argument is not evidence", () => {
        expect(classifyCommand("echo test")).toBeUndefined();
        expect(classifyCommand("git commit -m 'add test'")).toBeUndefined();
    });
});

describe("the ledger", () => {
    test("a passing check after the last edit clears the verdict", () => {
        const ledger = createVerificationLedger();
        ledger.noteEdit(`${WORKSPACE_ROOT}/src/a.ts`);
        ledger.noteCommand("pnpm test", true, "");
        expect(ledger.verdict()).toBeUndefined();
    });

    test("a passing check BEFORE the last edit does not", () => {
        const ledger = createVerificationLedger();
        ledger.noteCommand("pnpm test", true, "");
        ledger.noteEdit(`${WORKSPACE_ROOT}/src/a.ts`);
        expect(ledger.verdict()?.paths).toEqual(["/work/src/a.ts"]);
    });

    test("a failing check is reported as the reason, distinct from never having checked", () => {
        const ledger = createVerificationLedger();
        ledger.noteEdit(`${WORKSPACE_ROOT}/src/a.ts`);
        ledger.noteCommand("pnpm test", false, "2 failed");
        const verdict = ledger.verdict();
        expect(verdict?.failed?.command).toBe("pnpm test");
        expect(verdict?.failed?.detail).toBe("2 failed");
    });

    test("editing only prose is not something a check can speak to", () => {
        const ledger = createVerificationLedger();
        ledger.noteEdit(`${WORKSPACE_ROOT}/README.md`);
        ledger.noteEdit(`${WORKSPACE_ROOT}/CHANGELOG`);
        expect(ledger.verdict()).toBeUndefined();
    });

    test("a prose edit alongside a code edit still needs proof", () => {
        const ledger = createVerificationLedger();
        ledger.noteEdit(`${WORKSPACE_ROOT}/README.md`);
        ledger.noteEdit(`${WORKSPACE_ROOT}/src/a.ts`);
        expect(ledger.verdict()?.paths).toEqual(["/work/src/a.ts"]);
    });

    test("the same file edited repeatedly is named once", () => {
        const ledger = createVerificationLedger();
        ledger.noteEdit(`${WORKSPACE_ROOT}/src/a.ts`);
        ledger.noteEdit(`${WORKSPACE_ROOT}/src/a.ts`);
        expect(ledger.verdict()?.paths).toEqual(["/work/src/a.ts"]);
    });

    test("a turn that edited nothing never asks for anything", () => {
        const ledger = createVerificationLedger();
        ledger.noteCommand("pnpm test", false, "broken");
        expect(ledger.verdict()).toBeUndefined();
    });

    test("prose is remembered as edited even though no check is asked for it", () => {
        const ledger = createVerificationLedger();
        ledger.noteEdit(`${WORKSPACE_ROOT}/docs/intro.md`);
        expect(ledger.edited()).toEqual(["/work/docs/intro.md"]);
        expect(ledger.verdict()).toBeUndefined();
    });

    // "Last edit" means the last one a check could speak to; a README touch afterward does not reopen anything.
    test("a prose edit after a passing check does not reopen the verdict", () => {
        const ledger = createVerificationLedger();
        ledger.noteEdit(`${WORKSPACE_ROOT}/src/a.ts`);
        ledger.noteCommand("pnpm test", true, "");
        ledger.noteEdit(`${WORKSPACE_ROOT}/README.md`);
        expect(ledger.verdict()).toBeUndefined();
    });
});

// Same ledger fed provider-normalized frames (agent/tool-calls.ts) instead of hook events, so a case proven here holds
// for any provider.
describe("the frame-fed ledger", () => {
    const editCall = (id: string, path: string, status: "completed" | "failed" = "completed"): AgentEvent => ({
        kind: "tool_call",
        id,
        name: "Edit",
        category: "edit",
        status,
        locations: [{ path }],
    });
    const shellCall = (id: string, command: string): AgentEvent => ({
        kind: "tool_call",
        id,
        name: "Bash",
        category: "execute",
        status: "in_progress",
        target: command,
    });
    const shellResult = (id: string, text: string, status: "completed" | "failed" = "completed"): AgentEvent => ({
        kind: "tool_call_update",
        id,
        status,
        content: [{ type: "text", text }],
    });

    test("edits with nothing after them are unproven, and name the files", () => {
        const ledger = createFrameLedger();
        ledger.note(editCall("1", `${WORKSPACE_ROOT}/src/a.ts`));
        ledger.note(editCall("2", `${WORKSPACE_ROOT}/src/b.ts`));
        expect(ledger.standing()).toEqual({ state: "unproven", paths: ["/work/src/a.ts", "/work/src/b.ts"], check: undefined });
    });

    test("a check that passes after the last edit verifies it, and says which check", () => {
        const ledger = createFrameLedger();
        ledger.note(editCall("1", `${WORKSPACE_ROOT}/src/a.ts`));
        ledger.note(shellCall("2", "pnpm test src/a.test.ts"));
        ledger.note(shellResult("2", "1 passed\n--- [exit 0, 2s]"));
        expect(ledger.standing()).toEqual({ state: "verified", paths: ["/work/src/a.ts"], check: "pnpm test src/a.test.ts" });
    });

    // Order matters, and the frame stream is the only place that still preserves it across tool calls.
    test("a check before the last edit proves nothing about it", () => {
        const ledger = createFrameLedger();
        ledger.note(shellCall("1", "pnpm test"));
        ledger.note(shellResult("1", "--- [exit 0, 2s]"));
        ledger.note(editCall("2", `${WORKSPACE_ROOT}/src/a.ts`));
        expect(ledger.standing().state).toBe("unproven");
    });

    // Exit code outranks the tool's own status: a suite that printed failures but exited 1 is still a completed call.
    test("a suite that exits non-zero is failing, whatever the tool call says", () => {
        const ledger = createFrameLedger();
        ledger.note(editCall("1", `${WORKSPACE_ROOT}/src/a.ts`));
        ledger.note(shellCall("2", "pnpm test"));
        ledger.note(shellResult("2", "1 failed\n--- [exit 1, 4s]", "completed"));
        expect(ledger.standing()).toEqual({ state: "failing", paths: ["/work/src/a.ts"], check: "pnpm test" });
    });

    // A refused or failed edit is not work to prove; noted at its result, not when it opens, since PostToolUse only
    // fires for a call that ran.
    test("an edit that failed is not work to be proven", () => {
        const ledger = createFrameLedger();
        ledger.note(editCall("1", `${WORKSPACE_ROOT}/src/a.ts`, "failed"));
        expect(ledger.standing().state).toBe("no-code");
    });

    // An ACP agent sends the change itself rather than the path it came from; reading only `locations` would miss it.
    test("an edit that carries only a structured diff still counts", () => {
        const ledger = createFrameLedger();
        ledger.note({
            kind: "tool_call",
            id: "1",
            name: "write",
            category: "edit",
            status: "completed",
            content: [{ type: "diff", path: `${WORKSPACE_ROOT}/src/a.ts`, newText: "next" }],
        });
        expect(ledger.standing().paths).toEqual(["/work/src/a.ts"]);
    });

    // Interim updates are snapshots of a running command, not its answer; only a terminal status settles one.
    test("a check still running is not evidence yet", () => {
        const ledger = createFrameLedger();
        ledger.note(editCall("1", `${WORKSPACE_ROOT}/src/a.ts`));
        ledger.note(shellCall("2", "pnpm test"));
        ledger.note({ kind: "tool_call_update", id: "2", status: "in_progress", content: [{ type: "text", text: "running…" }] });
        expect(ledger.standing().state).toBe("unproven");
    });

    // Reading a file is not editing one, and a turn that only read has nothing a check could speak to.
    test("frames that are neither an edit nor a check leave the ledger alone", () => {
        const ledger = createFrameLedger();
        ledger.note({ kind: "tool_call", id: "1", name: "Read", category: "read", status: "completed", locations: [{ path: "/work/src/a.ts" }] });
        ledger.note({ kind: "delta", text: "done" });
        expect(ledger.standing().state).toBe("no-code");
        expect(ledger.edited()).toEqual([]);
    });
});
