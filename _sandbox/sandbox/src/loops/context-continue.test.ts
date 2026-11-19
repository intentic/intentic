import type { TranscriptRow } from "@intentic/sandbox-contract/events/transcript";
import type { PersistedAgent } from "../conversations/registry/agents-store.js";
import { conversationEntry, isolatedAgent } from "../conversations/registry/agents-store.testing.js";
import type { DomainEventMap } from "../seams/domain-events.js";
import type { TurnInput } from "../seams/turn-starter.js";
import {
    CONTEXT_CONTINUE_SOURCE,
    type ContextContinueDeps,
    contextStopOf,
    continuationPrompt,
    decideContextContinue,
    onRunSettled,
} from "./context-continue.js";

// The words a turn of the audited sandbox ended on, the shape this exists to recognise.
const STOPPED_ON_CONTEXT =
    "Steps 8-11 are still open on purpose. I stopped before them because this conversation's context is large. I'd continue in a fresh conversation, in the reordered sequence from my last message: 1. **#11 Cache that survives deploys.** 2. Look at real `load` events.";

describe("contextStopOf", () => {
    test.each([
        STOPPED_ON_CONTEXT,
        "Done: parser and lexer. Remaining: the emitter and its tests. I'm stopping here since the context window is nearly full; a fresh session can pick up the emitter.",
        "I'll wrap up here given the long context. Next steps: wire the cache, then run the bench.",
        "We stopped at group 5 because the context is getting large; groups 6-9 remain.",
    ])("recognises a turn that stopped on its own large context with work left: %s", (closing) => {
        expect(contextStopOf(closing)).toBe(true);
    });

    test.each([
        // Work about context windows is not a stop because of one.
        "The hook now stops the turn when the context window is full. Remaining: nothing, the tests pass.",
        "Fixed the context budget check in context-budget.ts and added a test.",
        // A stop for another reason, with work left.
        "I stopped because the build needs a token you have not given me. Remaining: the deploy step.",
        // A stop on a large context with nothing said to remain.
        "I stopped here because this conversation's context is large.",
    ])("leaves any other ending alone: %s", (closing) => {
        expect(contextStopOf(closing)).toBe(false);
    });
});

test("the cap counts continuations in a row, and zero only offers", () => {
    expect(decideContextContinue(1, 0)).toEqual({ kind: "offer" });
    expect(decideContextContinue(1, 2)).toEqual({ kind: "continue", count: 1, max: 2 });
    expect(decideContextContinue(2, 2)).toEqual({ kind: "continue", count: 2, max: 2 });
    expect(decideContextContinue(3, 2)).toEqual({ kind: "spent", max: 2 });
});

test("the fresh session is handed what the stopped turn said was left, and its place in the run", () => {
    const prompt = continuationPrompt(STOPPED_ON_CONTEXT, { count: 1, max: 3 });
    expect(prompt).toContain("continuation 1 of at most 3");
    expect(prompt).toContain("> Steps 8-11 are still open on purpose.");
});

// One conversation of its own, idle, on Claude.
const ENTRY = isolatedAgent([], { id: "rhino-pvf5", profile: { provider: "claude", harness: "claude-code", model: "claude-opus-5-5" } });

const settledOf = (run: string, closing = STOPPED_ON_CONTEXT, extra: Partial<DomainEventMap["run.settled"]> = {}): DomainEventMap["run.settled"] => ({
    conversationId: "rhino-pvf5",
    run,
    actor: undefined,
    speaker: undefined,
    failure: undefined,
    closing,
    ...extra,
});

const harness = (setting: number, entry: PersistedAgent = ENTRY, busy = false) => {
    const started: TurnInput[] = [];
    const notices: TranscriptRow[] = [];
    let next = 0;
    const deps: ContextContinueDeps = {
        entryOf: () => entry,
        busy: () => busy,
        start: async (turn) => {
            started.push(turn);
            next += 1;
            return { id: `continued-${String(next)}`, async *frames () {} };
        },
        note: async (_conversationId, row) => {
            notices.push(row);
        },
        allowed: async () => setting,
        logger: { info: () => undefined, warn: () => undefined },
    };
    return { deps, started, notices };
};

test("off by default: the stop is only noted, saying how to carry it on", async () => {
    const { deps, started, notices } = harness(0);
    expect(await onRunSettled(deps, settledOf("first"))).toEqual({ kind: "offer" });
    expect(started).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.role).toBe("notice");
    expect(notices[0]?.agentNotice?.source).toBe(CONTEXT_CONTINUE_SOURCE);
    expect(notices[0]?.text).toContain("agents continue rhino-pvf5");
});

test("allowed, it carries on in a fresh session as the sandbox, then stands down at the cap", async () => {
    const { deps, started, notices } = harness(2);
    expect(await onRunSettled(deps, settledOf("first"))).toEqual({ kind: "continue", count: 1, max: 2 });
    expect(started).toHaveLength(1);
    // No session named, so the daemon opens a fresh one seeded from the record.
    expect(started[0]?.sessionId).toBeUndefined();
    expect(started[0]?.speaker).toEqual({ kind: "sandbox", source: CONTEXT_CONTINUE_SOURCE });
    expect(started[0]?.agent).toBe("claude");
    expect(started[0]?.prompt).toContain("I stopped before them");
    // The continuation stopping the same way counts on; a third in a row is the owner's.
    expect(await onRunSettled(deps, settledOf("continued-1"))).toEqual({ kind: "continue", count: 2, max: 2 });
    expect(await onRunSettled(deps, settledOf("continued-2"))).toEqual({ kind: "spent", max: 2 });
    expect(started).toHaveLength(2);
    expect(notices.at(-1)?.text).toContain("already carried this conversation on 2 times in a row");
    // Any other run (a person's message) starts the count again.
    expect(await onRunSettled(deps, settledOf("a-person-wrote"))).toEqual({ kind: "continue", count: 1, max: 2 });
});

test.each([
    ["a failed turn", ENTRY, false, { failure: "boom" }],
    ["a stopped turn", ENTRY, false, { stopped: true as const }],
    ["a conversation with words waiting or a turn running", ENTRY, true, {}],
    ["a subagent", isolatedAgent([], { id: "rhino-pvf5", placement: { kind: "worktree", branch: "agent/rhino-pvf5", repos: [], parent: "boss-a1b2" } }), false, {}],
    ["a home", conversationEntry({ id: "rhino-pvf5", identity: { home: true } }), false, {}],
])("leaves %s alone", async (_what, entry, busy, extra) => {
    const { deps, started, notices } = harness(3, entry, busy);
    expect(await onRunSettled(deps, settledOf("first", STOPPED_ON_CONTEXT, extra))).toBeUndefined();
    expect(started).toEqual([]);
    expect(notices).toEqual([]);
});
