import type { PostToolUseHookInput, StopHookInput } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import { MAIN_MOVED_SOURCE } from "@intentic/sandbox-contract/events/agent-ui";
import { syncHookOutput } from "./harness/harness-hooks.testing.js";
import { catchUpHooks, type MainCatchUp, mainMovedNote, type StopConflict, stopCatchUp } from "./main-catch-up.js";
import { turnCheckHooks, type TurnChecks } from "./turn-checks.js";
import { rulesOf, declarationOf } from "../../rules/repo-checks.js";

// Keeping a running turn on the main line: silently after a tool call, and once at the Stop, where a branch that no
// longer rebases is handed back to the model in the turn that still holds its context.

const FRAME: AgentEvent = { kind: "worktree", branch: "agent/c1", base: "abc1234", sync: { commits: 2, blocked: [] } };
const CONFLICT: StopConflict = { repo: "root", onto: "0123456789abcdef0123", overlap: ["src/app.ts"] };
const STOP: StopHookInput = { hook_event_name: "Stop", session_id: "s1", transcript_path: "s1.jsonl", cwd: ".", stop_hook_active: false };
const POST: PostToolUseHookInput = {
    hook_event_name: "PostToolUse",
    session_id: "s1",
    transcript_path: "s1.jsonl",
    cwd: ".",
    tool_name: "Read",
    tool_input: {},
    tool_response: {},
    tool_use_id: "t1",
};
const signal = { signal: new AbortController().signal };

const catchUpOf = (answers: { readonly frame?: AgentEvent; readonly conflicts?: readonly StopConflict[] } = {}) => {
    const calls = { midTurn: 0, atStop: 0 };
    const catchUp: MainCatchUp = {
        midTurn: async () => {
            calls.midTurn += 1;
            return answers.frame;
        },
        atStop: async () => {
            calls.atStop += 1;
            return answers.conflicts ?? [];
        },
    };
    return { catchUp, calls };
};

describe("catchUpHooks", () => {
    it("catches the main thread up after a tool call and shows the reader where the branch moved", async () => {
        const { catchUp, calls } = catchUpOf({ frame: FRAME });
        const pushed: AgentEvent[] = [];
        const hooks = catchUpHooks(catchUp, async () => true, (event) => pushed.push(event));
        expect(syncHookOutput(await hooks.PostToolUse![0]!.hooks[0]!(POST, "t1", signal))).toEqual({});
        expect(calls.midTurn).toBe(1);
        // Said to the reader only: nothing reaches the model, which would re-verify what did not move.
        expect(pushed).toEqual([FRAME]);
    });

    it("leaves a subagent's calls alone", async () => {
        const { catchUp, calls } = catchUpOf({ frame: FRAME });
        const hooks = catchUpHooks(catchUp, async () => true, () => undefined);
        await hooks.PostToolUse![0]!.hooks[0]!({ ...POST, agent_id: "sub-1", agent_type: "general-purpose" }, "t1", signal);
        expect(calls.midTurn).toBe(0);
    });

    it("wires nothing where the placement offers no catch-up", () => {
        expect(catchUpHooks(undefined, async () => true, () => undefined)).toEqual({});
    });
});

describe("stopCatchUp", () => {
    it("asks the model to resolve a branch that no longer rebases, once, and leaves a row in the transcript", async () => {
        const { catchUp, calls } = catchUpOf({ conflicts: [CONFLICT] });
        const pushed: AgentEvent[] = [];
        const step = stopCatchUp(catchUp, (event) => pushed.push(event))!;
        const note = await step();
        expect(note).toBe(mainMovedNote([CONFLICT]));
        expect(note).toContain("`git rebase 0123456789ab`");
        expect(note).toContain("1. `git add -A; git diff --cached --quiet || git commit -qm wip`");
        expect(note).toContain("  - src/app.ts");
        expect(pushed).toEqual([expect.objectContaining({ kind: "agent_notice", source: MAIN_MOVED_SOURCE, sent: note })]);
        // The second Stop is the model's answer; asking again would make it a gate.
        expect(await step()).toBeUndefined();
        expect(calls.atStop).toBe(1);
    });

    it("lets a turn whose branch rebased cleanly end", async () => {
        const { catchUp } = catchUpOf();
        expect(await stopCatchUp(catchUp, () => undefined)!()).toBeUndefined();
    });
});

describe("the Stop, with the catch-up first", () => {
    const [rule] = rulesOf(declarationOf("intentic", [{ when: "turn", run: "verify", label: "checks" }]));
    const checks = (ran: string[]): TurnChecks => ({
        rules: [rule!],
        change: async () => ({ paths: ["intentic/a.ts"], repos: ["intentic"] }),
        run: async (command) => {
            ran.push(command);
            return { status: "failed", output: "finding" };
        },
        onFired: () => undefined,
        logger: { warn: jest.fn() },
    });

    it("keeps the turn going on a clash and runs the repositories' checks only at the Stop after it", async () => {
        const ran: string[] = [];
        const { catchUp } = catchUpOf({ conflicts: [CONFLICT] });
        const hooks = turnCheckHooks(checks(ran), true, undefined, stopCatchUp(catchUp, () => undefined));
        const first = syncHookOutput(await hooks.Stop![0]!.hooks[0]!(STOP, "t", signal));
        expect(first).toEqual({ decision: "block", reason: mainMovedNote([CONFLICT]) });
        expect(ran).toEqual([]);
        const second = syncHookOutput(await hooks.Stop![0]!.hooks[0]!({ ...STOP, stop_hook_active: true }, "t", signal));
        expect(second.hookSpecificOutput).toMatchObject({ hookEventName: "Stop" });
        expect(ran).toEqual(["verify"]);
    });

    it("still stops on the catch-up alone where no repository declares a check", async () => {
        const { catchUp } = catchUpOf({ conflicts: [CONFLICT] });
        const hooks = turnCheckHooks(undefined, true, undefined, stopCatchUp(catchUp, () => undefined));
        expect(syncHookOutput(await hooks.Stop![0]!.hooks[0]!(STOP, "t", signal))).toMatchObject({ decision: "block" });
    });
});
