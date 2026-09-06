import type { AgentEvent } from "@intentic/sandbox-contract";
import { beforeEach, describe, expect, test } from "vitest";
import { childVerification, childVerificationNote, forgetChild, noteChildWork, resetChildVerification } from "./child-verification.js";

/* The feeder is fed FRAMES, which is the whole point of it: these are the shapes every adapter normalizes to
 * (agent/tool-calls.ts), so a case written here is a case that holds for a child on any provider. */

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

beforeEach(resetChildVerification);

describe("what a child's frames prove", () => {
    test("edits with no check are unproven, and name the files", () => {
        noteChildWork(editCall("c1", "src/parser.ts"), "child-1");
        noteChildWork(editCall("c2", "src/lexer.ts"), "child-1");
        expect(childVerification("child-1")).toEqual({ state: "unproven", paths: ["src/parser.ts", "src/lexer.ts"] });
    });

    test("a check that passes after the last edit verifies it, and says which check", () => {
        noteChildWork(editCall("c1", "src/parser.ts"), "child-1");
        noteChildWork(shellCall("c2", "pnpm test src/parser.test.ts"), "child-1");
        noteChildWork(shellResult("c2", "2 passed\n--- [exit 0, 3s]"), undefined);
        expect(childVerification("child-1")).toEqual({
            state: "verified",
            paths: ["src/parser.ts"],
            check: "pnpm test src/parser.test.ts",
        });
    });

    /* The exit code outranks the tool's own status, and this is the case that makes the difference: a suite
     * that printed its failures and exited 1 is a `completed` tool call, because the TOOL worked. */
    test("a suite that exits non-zero is failing, whatever the tool call says", () => {
        noteChildWork(editCall("c1", "src/parser.ts"), "child-1");
        noteChildWork(shellCall("c2", "pnpm test"), "child-1");
        noteChildWork(shellResult("c2", "1 failed\n--- [exit 1, 4s]", "completed"), undefined);
        expect(childVerification("child-1")?.state).toBe("failing");
    });

    // No footer to read (output filtering off, a truncated tail), so the frame's own status is the answer.
    test("without a footer the frame's status decides", () => {
        noteChildWork(editCall("c1", "src/parser.ts"), "child-1");
        noteChildWork(shellCall("c2", "pnpm test"), "child-1");
        noteChildWork(shellResult("c2", "no footer here", "failed"), undefined);
        expect(childVerification("child-1")?.state).toBe("failing");
    });

    /* An edit that was REFUSED or that failed changed nothing, so it is not work waiting for proof: counting
     * it would warn the parent about a child that did nothing at all. */
    test("a failed edit is not work", () => {
        noteChildWork({ ...editCall("c1", "src/parser.ts"), status: "in_progress" }, "child-1");
        noteChildWork({ kind: "tool_call_update", id: "c1", status: "failed" }, undefined);
        expect(childVerification("child-1")?.state).toBe("no-code");
    });

    // Some adapters name the file only on the structured diff (an ACP agent sends the change, not the input
    // it came from), so reading `locations` alone would see that child edit nothing.
    test("an edit known only by its diff still counts", () => {
        noteChildWork(
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
        expect(childVerification("child-1")).toEqual({ state: "unproven", paths: ["src/parser.ts"] });
    });

    test("a child that edited no code is no-code, not verified", () => {
        noteChildWork(shellCall("c1", "rg needle src"), "child-1");
        noteChildWork(shellResult("c1", "--- [exit 0, 0s]"), undefined);
        expect(childVerification("child-1")).toEqual({ state: "no-code" });
    });

    // Prose is not code, and a turn that only wrote markdown is done when it says it is (the ledger's rule).
    test("editing only prose is no-code", () => {
        noteChildWork(editCall("c1", "docs/architecture/repo.md"), "child-1");
        expect(childVerification("child-1")?.state).toBe("no-code");
    });

    // The ordering the ledger's counter exists for, arriving here as frames rather than as hooks.
    test("checking and then editing again leaves the new edit unproven", () => {
        noteChildWork(editCall("c1", "src/parser.ts"), "child-1");
        noteChildWork(shellCall("c2", "pnpm test"), "child-1");
        noteChildWork(shellResult("c2", "--- [exit 0, 3s]"), undefined);
        noteChildWork(editCall("c3", "src/lexer.ts"), "child-1");
        expect(childVerification("child-1")?.state).toBe("unproven");
    });

    test("two children are two ledgers", () => {
        noteChildWork(editCall("c1", "src/parser.ts"), "child-1");
        noteChildWork(editCall("c2", "src/other.ts"), "child-2");
        noteChildWork(shellCall("c3", "pnpm test"), "child-2");
        noteChildWork(shellResult("c3", "--- [exit 0, 1s]"), undefined);
        expect(childVerification("child-1")?.state).toBe("unproven");
        expect(childVerification("child-2")?.state).toBe("verified");
    });

    /* A frame the daemon cannot attribute must not invent a child: the parent's OWN tool calls arrive at the
     * same seam carrying no parent id, and a ledger opened for them would report the parent's work as a
     * child's verdict. */
    test("an unattributable call opens no ledger", () => {
        noteChildWork(editCall("c1", "src/parser.ts"), undefined);
        noteChildWork(shellResult("c1", "--- [exit 0, 1s]"), undefined);
        expect(childVerification("child-1")).toBeUndefined();
    });

    test("nothing seen is undefined, which is not the same as no-code", () => {
        expect(childVerification("never-heard-of-it")).toBeUndefined();
    });

    test("forgetting a child drops its ledger and its pending calls", () => {
        noteChildWork(editCall("c1", "src/parser.ts"), "child-1");
        noteChildWork(shellCall("c2", "pnpm test"), "child-1");
        forgetChild("child-1");
        // The result of a call whose owner is gone settles nothing, rather than reopening a ledger for it.
        noteChildWork(shellResult("c2", "--- [exit 0, 1s]"), undefined);
        expect(childVerification("child-1")).toBeUndefined();
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

    /* The deliberate silence: these two ride the wire for anyone who asks, and spend none of the parent's
     * context. An Explore child that edited nothing is the commonest child there is. */
    test.each(["verified", "no-code"] as const)("%s says nothing in the parent's context", (state) => {
        expect(childVerificationNote({ state, check: "pnpm test" })).toBeUndefined();
    });
});
