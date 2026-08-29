import { WORKSPACE_ROOT } from "@intentic/constants";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { describe, expect, test } from "vitest";
import { classifyCommand, createFrameLedger, createVerificationLedger } from "./agent-verification.js";

describe("command classification", () => {
    test.each([
        ["pnpm test", "test"],
        ["pnpm -C _sandbox/workspace-ignore test", "test"],
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

    // `echo test` must not read as a test run just because the word appears: the classifier keys on the
    // command position, not on a substring anywhere in the line.
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

    // The ordering case the counter exists for: verifying and THEN editing leaves the edits unproven.
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

    /* The two readers want different answers from the same record, and conflating them broke a real case: a
     * rule narrowed to `docs/**` could never fire, because the ledger had discarded the docs edit at the door
     * before any condition could see it. Nothing asks for proof of a README; nothing pretends it wasn't
     * written. */
    test("prose is remembered as edited even though no check is asked for it", () => {
        const ledger = createVerificationLedger();
        ledger.noteEdit(`${WORKSPACE_ROOT}/docs/intro.md`);
        expect(ledger.edited()).toEqual(["/work/docs/intro.md"]);
        expect(ledger.verdict()).toBeUndefined();
    });

    // The ordering question is about the last edit a check could SPEAK to: touching a README after a green
    // suite has not invalidated it.
    test("a prose edit after a passing check does not reopen the verdict", () => {
        const ledger = createVerificationLedger();
        ledger.noteEdit(`${WORKSPACE_ROOT}/src/a.ts`);
        ledger.noteCommand("pnpm test", true, "");
        ledger.noteEdit(`${WORKSPACE_ROOT}/README.md`);
        expect(ledger.verdict()).toBeUndefined();
    });
});

/* THE SAME LEDGER, FED FRAMES, which is the version every runtime can have: these are the shapes each adapter
 * normalizes to (agent/tool-calls.ts), so a case written here holds for a turn on any provider. The hook feeder
 * next door is the Claude Agent SDK's PostToolUse and reaches exactly one of six. */
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

    /* ORDER IS THE WHOLE POINT, and the frame stream is the only place that still knows it: `pnpm test` and then
     * three edits is a turn with no evidence for those edits, and it reads as verified under any scheme that
     * only asks whether a test ran this turn. */
    test("a check before the last edit proves nothing about it", () => {
        const ledger = createFrameLedger();
        ledger.note(shellCall("1", "pnpm test"));
        ledger.note(shellResult("1", "--- [exit 0, 2s]"));
        ledger.note(editCall("2", `${WORKSPACE_ROOT}/src/a.ts`));
        expect(ledger.standing().state).toBe("unproven");
    });

    // The exit code outranks the tool's own status: a suite that printed its failures and exited 1 is a
    // `completed` tool call, because the TOOL worked.
    test("a suite that exits non-zero is failing, whatever the tool call says", () => {
        const ledger = createFrameLedger();
        ledger.note(editCall("1", `${WORKSPACE_ROOT}/src/a.ts`));
        ledger.note(shellCall("2", "pnpm test"));
        ledger.note(shellResult("2", "1 failed\n--- [exit 1, 4s]", "completed"));
        expect(ledger.standing()).toEqual({ state: "failing", paths: ["/work/src/a.ts"], check: "pnpm test" });
    });

    // A refused or failed edit changed nothing, so it is not work waiting for proof. The hook feeder gets this
    // for free (PostToolUse only fires for a call that ran); here it is the reason a call is noted at its
    // RESULT rather than when it opens.
    test("an edit that failed is not work to be proven", () => {
        const ledger = createFrameLedger();
        ledger.note(editCall("1", `${WORKSPACE_ROOT}/src/a.ts`, "failed"));
        expect(ledger.standing().state).toBe("no-code");
    });

    // An ACP agent sends the change rather than the argument it came from, so a ledger reading only
    // `locations` would watch a Zed-driven turn edit nothing.
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
