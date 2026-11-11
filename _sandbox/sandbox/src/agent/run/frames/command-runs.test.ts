import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import { opt } from "../../../opt.js";
import { createCommandRuns, programOf } from "./command-runs.js";

// What a turn's shell calls leave in the command record: failures with the line that says why and what ran clean next,
// and the programs that ran clean, on any runtime's frames.

const call = (id: string, command: string, parent?: string): AgentEvent => ({
    kind: "tool_call",
    id,
    name: "Bash",
    category: "execute",
    status: "in_progress",
    target: command,
    ...opt("parentToolUseId", parent),
});

const result = (id: string, status: "completed" | "failed", text: string): AgentEvent => ({ kind: "tool_call_update", id, status, content: [{ type: "text", text }] });

const fold = (frames: readonly AgentEvent[]) => {
    const runs = createCommandRuns();
    for (const frame of frames) {
        runs.note(frame);
    }
    return runs.reading();
};

test("names the program a command runs, past setup and wrappers", () => {
    expect(programOf("cd _sandbox/sandbox && pnpm vitest run src/x.test.ts 2>&1 | tail -20")).toBe("pnpm vitest");
    expect(programOf("FOO=1 timeout 60 python -m pytest -q")).toBe("python -m pytest");
    expect(programOf("git -C /work push")).toBe("git");
    expect(programOf("node scripts/build.mjs")).toBe("node");
    expect(programOf("env CI=1 npx tsc --noEmit")).toBe("npx tsc");
});

test("keeps a failure with its reason and what the same agent ran clean right after it", () => {
    const runs = fold([
        call("a", "pytest -q"),
        result("a", "failed", "bash: line 1: pytest: command not found\n--- [exit 127, 0s]"),
        call("b", "python -m pytest -q"),
        result("b", "completed", "3 passed\n--- [exit 0, 2s]"),
    ]);
    expect(runs.failed).toBe(1);
    expect(runs.failures).toStrictEqual([
        {
            command: "pytest -q",
            program: "pytest",
            exit: 127,
            unstarted: true,
            error: "bash: line 1: pytest: command not found",
            tail: "bash: line 1: pytest: command not found",
            instead: "python -m pytest -q",
        },
    ]);
    expect(runs.ran).toStrictEqual({ "python -m pytest": 1 });
});

test("a predicate answering no is not a failure, and a subagent's failure is marked as its own", () => {
    const runs = fold([
        call("a", "test -f missing.txt"),
        result("a", "failed", "--- [exit 1, 0s]"),
        call("b", "pnpm vitest run", "task-1"),
        result("b", "failed", "FAIL src/a.test.ts\nError: expected 1 to be 2\n--- [exit 1, 4s]"),
        // The turn's own agent running clean does not answer the subagent's failure.
        call("c", "git status"),
        result("c", "completed", "clean\n--- [exit 0, 0s]"),
    ]);
    expect(runs.failed).toBe(1);
    expect(runs.failures).toStrictEqual([
        {
            command: "pnpm vitest run",
            program: "pnpm vitest",
            exit: 1,
            error: "Error: expected 1 to be 2",
            tail: "FAIL src/a.test.ts\nError: expected 1 to be 2",
            subagent: true,
        },
    ]);
    expect(runs.ran).toStrictEqual({ "git status": 1 });
});

test("a call interrupted or still running leaves nothing", () => {
    const runs = fold([call("a", "pnpm build"), { kind: "tool_call_update", id: "a", status: "interrupted" }, call("b", "sleep 100 && make")]);
    expect(runs).toStrictEqual({ failures: [], failed: 0, ran: {} });
});
