import type { AgentEvent } from "@intentic/sandbox-contract";
import { describe, test, expect, beforeEach } from "bun:test";
import { childVerification, childVerificationNote, forgetChild, noteChildWork, resetChildVerification } from "./child-verification.js";
import { memoryFleet } from "../../testing.js";

// One fleet's actors, which hold every record the registry under test files.
const actors = memoryFleet().conversations;

// The feeder is fed frames, the shapes every adapter normalizes to (agent/tool-calls.ts); a case here holds for any
// provider.

const editCall = (id: string, path: string): Extract<AgentEvent, { kind: "tool_call" }> => ({
    kind: "tool_call",
    id,
    name: "Edit",
    category: "edit",
    status: "completed",
    locations: [{ path }],
});

const shellCall = (id: string, command: string): Extract<AgentEvent, { kind: "tool_call" }> => ({
    kind: "tool_call",
    id,
    name: "Bash",
    category: "execute",
    status: "in_progress",
    target: command,
});

const shellResult = (id: string, text: string, status: "completed" | "failed" = "completed"): Extract<AgentEvent, { kind: "tool_call_update" }> => ({
    kind: "tool_call_update",
    id,
    status,
    content: [{ type: "text", text }],
});

beforeEach(() => resetChildVerification(actors));

describe("what a child's frames prove", () => {
    test("edits with no check are unproven, and name the files", () => {
        noteChildWork(actors, editCall("c1", "src/parser.ts"), "child-1");
        noteChildWork(actors, editCall("c2", "src/lexer.ts"), "child-1");
        expect(childVerification(actors, "child-1")).toEqual({ state: "unproven", paths: ["src/parser.ts", "src/lexer.ts"] });
    });

    test("a check that passes after the last edit verifies it, and says which check", () => {
        noteChildWork(actors, editCall("c1", "src/parser.ts"), "child-1");
        noteChildWork(actors, shellCall("c2", "pnpm test src/parser.test.ts"), "child-1");
        noteChildWork(actors, shellResult("c2", "2 passed\n--- [exit 0, 3s]"), undefined);
        expect(childVerification(actors, "child-1")).toEqual({
            state: "verified",
            paths: ["src/parser.ts"],
            check: "pnpm test src/parser.test.ts",
        });
    });

    test("a suite that exits non-zero is failing, whatever the tool call says", () => {
        noteChildWork(actors, editCall("c1", "src/parser.ts"), "child-1");
        noteChildWork(actors, shellCall("c2", "pnpm test"), "child-1");
        noteChildWork(actors, shellResult("c2", "1 failed\n--- [exit 1, 4s]", "completed"), undefined);
        expect(childVerification(actors, "child-1")?.state).toBe("failing");
    });

    test("without a footer the frame's status decides", () => {
        noteChildWork(actors, editCall("c1", "src/parser.ts"), "child-1");
        noteChildWork(actors, shellCall("c2", "pnpm test"), "child-1");
        noteChildWork(actors, shellResult("c2", "no footer here", "failed"), undefined);
        expect(childVerification(actors, "child-1")?.state).toBe("failing");
    });

    test("a failed edit is not work", () => {
        noteChildWork(actors, { ...editCall("c1", "src/parser.ts"), status: "in_progress" }, "child-1");
        noteChildWork(actors, { kind: "tool_call_update", id: "c1", status: "failed" }, undefined);
        expect(childVerification(actors, "child-1")?.state).toBe("no-code");
    });

    // Some adapters name the file only on the diff, not `locations`, so this must count too.
    test("an edit known only by its diff still counts", () => {
        noteChildWork(
            actors,
            {
                kind: "tool_call",
                id: "c1",
                name: "Edit",
                category: "edit",
                status: "completed",
                content: [{ type: "diff", path: "src/parser.ts", newText: "next" }],
            },
            "child-1",
        );
        expect(childVerification(actors, "child-1")).toEqual({ state: "unproven", paths: ["src/parser.ts"] });
    });

    test("a child that edited no code is no-code, not verified", () => {
        noteChildWork(actors, shellCall("c1", "rg needle src"), "child-1");
        noteChildWork(actors, shellResult("c1", "--- [exit 0, 0s]"), undefined);
        expect(childVerification(actors, "child-1")).toEqual({ state: "no-code" });
    });

    test("editing only prose is no-code", () => {
        noteChildWork(actors, editCall("c1", "docs/architecture/repo.md"), "child-1");
        expect(childVerification(actors, "child-1")?.state).toBe("no-code");
    });

    test("checking and then editing again leaves the new edit unproven", () => {
        noteChildWork(actors, editCall("c1", "src/parser.ts"), "child-1");
        noteChildWork(actors, shellCall("c2", "pnpm test"), "child-1");
        noteChildWork(actors, shellResult("c2", "--- [exit 0, 3s]"), undefined);
        noteChildWork(actors, editCall("c3", "src/lexer.ts"), "child-1");
        expect(childVerification(actors, "child-1")?.state).toBe("unproven");
    });

    test("two children are two ledgers", () => {
        noteChildWork(actors, editCall("c1", "src/parser.ts"), "child-1");
        noteChildWork(actors, editCall("c2", "src/other.ts"), "child-2");
        noteChildWork(actors, shellCall("c3", "pnpm test"), "child-2");
        noteChildWork(actors, shellResult("c3", "--- [exit 0, 1s]"), undefined);
        expect(childVerification(actors, "child-1")?.state).toBe("unproven");
        expect(childVerification(actors, "child-2")?.state).toBe("verified");
    });

    // No parent id must not open a ledger, or the parent's own calls would report as a child's verdict.
    test("an unattributable call opens no ledger", () => {
        noteChildWork(actors, editCall("c1", "src/parser.ts"), undefined);
        noteChildWork(actors, shellResult("c1", "--- [exit 0, 1s]"), undefined);
        expect(childVerification(actors, "child-1")).toBeUndefined();
    });

    test("nothing seen is undefined, which is not the same as no-code", () => {
        expect(childVerification(actors, "never-heard-of-it")).toBeUndefined();
    });

    test("forgetting a child drops its ledger and its pending calls", () => {
        noteChildWork(actors, editCall("c1", "src/parser.ts"), "child-1");
        noteChildWork(actors, shellCall("c2", "pnpm test"), "child-1");
        forgetChild(actors, "child-1");
        // A call whose owner is forgotten settles nothing, rather than reopening a ledger.
        noteChildWork(actors, shellResult("c2", "--- [exit 0, 1s]"), undefined);
        expect(childVerification(actors, "child-1")).toBeUndefined();
    });
});

describe("what the parent is told", () => {
    test("unproven work is spoken, with the files and the warning", () => {
        const note = childVerificationNote({ state: "unproven", paths: ["src/a.ts", "src/b.ts"] });
        expect(note).toContain("UNPROVEN");
        expect(note).toContain("src/a.ts");
        expect(note).toContain("claim");
    });

    test("failing work names the check that broke", () => {
        expect(childVerificationNote({ state: "failing", paths: ["src/a.ts"], check: "pnpm test" })).toContain("`pnpm test`");
    });

    // Deliberate: these ride the wire for callers that ask, but cost nothing in the parent's context.
    test.each(["verified", "no-code"] as const)("%s says nothing in the parent's context", (state) => {
        expect(childVerificationNote({ state, check: "pnpm test" })).toBeUndefined();
    });
});
