import type { AgentTurn, Rule } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import { afterEach, expect, test, vi } from "vitest";
import { SETTLES } from "@intentic/testing/vitest";
import { createFrameLedger, type FrameLedger } from "./agent-verification.js";
import { createViewFrameLedger, type ViewFrameLedger } from "./agent-viewing.js";
import { nudgeUnverifiedWork, startVerifyNudgeRuntime, type VerifyNudgeRuntime } from "./verify-nudge.js";

/* THE PROOF FOLLOW-UP ON A RUNTIME WITH NO STOP HOOKS. The decision is the same one the Claude arm makes in a
 * hook (rules/turn-ending.ts); what is tested here is that it is made at all off the frame ledger, and that
 * the guards around SPENDING A TURN to deliver it hold. */

const rule: Rule = { id: "verify", label: "Prove the edits", moment: "turn.ending", action: { kind: "builtin", name: "verify-edits" }, enabled: true };
const seed: AgentTurn = { prompt: "fix the parser", agent: "codex", model: "gpt-5.1-codex", effort: "high" };

const edited = (path: string): FrameLedger => {
    const ledger = createFrameLedger();
    ledger.note({ kind: "tool_call", id: "1", name: "Edit", category: "edit", status: "completed", locations: [{ path }] });
    return ledger;
};

const proved = (path: string): FrameLedger => {
    const ledger = edited(path);
    ledger.note({ kind: "tool_call", id: "2", name: "Bash", category: "execute", status: "in_progress", target: "pnpm test" });
    ledger.note({ kind: "tool_call_update", id: "2", status: "completed", content: [{ type: "text", text: "ok\n--- [exit 0, 1s]" }] });
    return ledger;
};

const logger = { info: () => {}, warn: () => {}, error: () => {} } as unknown as Logger;

let stop: (() => void) | undefined;
const runtimeWith = (overrides: Partial<VerifyNudgeRuntime> = {}): { started: (AgentTurn & { conversationId: string })[] } => {
    const started: (AgentTurn & { conversationId: string })[] = [];
    stop?.();
    stop = startVerifyNudgeRuntime({
        logger,
        start: async (turn) => {
            started.push(turn);
            return true;
        },
        sessionIdOf: () => "session-7",
        ...overrides,
    });
    return { started };
};

afterEach(() => {
    stop?.();
    stop = undefined;
});

test("a turn that changed code and proved nothing is sent a follow-up, as its own turn", async () => {
    const { started } = runtimeWith();
    const message = await nudgeUnverifiedWork({ conversationId: "c1", seed, rules: [rule], ledger: edited("/work/src/parser.ts") });

    expect(message).toContain("/work/src/parser.ts");
    await vi.waitFor(() => expect(started).toHaveLength(1), SETTLES);
    /* It runs WHERE THE WORK RAN and picks the thread back up: a follow-up on another provider, or against a
     * fresh session, is asking a different agent about somebody else's edits. */
    expect(started[0]).toMatchObject({ conversationId: "c1", agent: "codex", model: "gpt-5.1-codex", effort: "high", sessionId: "session-7" });
    expect(started[0]?.prompt).toBe(message);
});

test("a turn whose check passed after its last edit is left alone", async () => {
    const { started } = runtimeWith();
    expect(await nudgeUnverifiedWork({ conversationId: "c1", seed, rules: [rule], ledger: proved("/work/src/parser.ts") })).toBeUndefined();
    expect(started).toHaveLength(0);
});

// Nothing here is on by default: without the owner's rule standing at this moment, an unproven turn is simply
// a turn that ended.
test("no rule standing means no follow-up, however unproven the work", async () => {
    const { started } = runtimeWith();
    expect(await nudgeUnverifiedWork({ conversationId: "c1", seed, rules: [], ledger: edited("/work/src/parser.ts") })).toBeUndefined();
    expect(started).toHaveLength(0);
});

// The rule's own conditions are read HERE, against what the turn actually touched, which is the only moment
// they can be: a turn is planned before it runs, so nothing earlier knows which files it will edit.
test("a rule narrowed to paths this turn never touched stays quiet", async () => {
    const { started } = runtimeWith();
    const narrowed: Rule = { ...rule, when: { paths: ["docs/**"] } };
    expect(await nudgeUnverifiedWork({ conversationId: "c1", seed, rules: [narrowed], ledger: edited("/work/src/parser.ts"), cwd: "/work" })).toBeUndefined();
    expect(started).toHaveLength(0);
});

/* THE LOOP GUARD, and the reason it has to exist: the follow-up runs as its own turn, and that turn is watched
 * by the same code that sent it. A model that answers the nudge without running anything would be nudged
 * again, and again, spending the owner's allowance arguing with itself. */
test("a nudge never answers a nudge", async () => {
    const { started } = runtimeWith();
    await nudgeUnverifiedWork({ conversationId: "c1", seed, rules: [rule], ledger: edited("/work/src/parser.ts") });
    await vi.waitFor(() => expect(started).toHaveLength(1), SETTLES);

    // The follow-up turn ends just as unproven as the one that triggered it, and is left alone.
    expect(await nudgeUnverifiedWork({ conversationId: "c1", seed, rules: [rule], ledger: edited("/work/src/parser.ts") })).toBeUndefined();
    expect(started).toHaveLength(1);

    // …and the conversation is free again from the turn after that.
    await nudgeUnverifiedWork({ conversationId: "c1", seed, rules: [rule], ledger: edited("/work/src/parser.ts") });
    await vi.waitFor(() => expect(started).toHaveLength(2), SETTLES);
});

/* THE OTHER LEDGER, on the same road. `verify-ui-edits` reads what the turn DREW against whether it looked,
 * and it has to reach a Codex or Cursor turn the same way `verify-edits` does, off frames rather than a hook
 * that runtime does not have. */
const viewRule: Rule = {
    id: "verify-ui-edits",
    label: "Look at what it changed",
    moment: "turn.ending",
    action: { kind: "builtin", name: "verify-ui-edits" },
    enabled: true,
};

const drew = (path: string): ViewFrameLedger => {
    const ledger = createViewFrameLedger();
    ledger.note({ kind: "tool_call", id: "1", name: "Edit", category: "edit", status: "completed", locations: [{ path }] });
    return ledger;
};

const looked = (path: string): ViewFrameLedger => {
    const ledger = drew(path);
    ledger.note({ kind: "tool_call", id: "2", name: "mcp__web__browser_take_screenshot", category: "other", status: "completed" });
    return ledger;
};

test("a turn that changed a rendered surface and never looked is sent a follow-up", async () => {
    const { started } = runtimeWith();
    const message = await nudgeUnverifiedWork({
        conversationId: "c1",
        seed,
        rules: [viewRule],
        ledger: edited("/work/src/App.vue"),
        view: drew("/work/src/App.vue"),
    });
    expect(message).toContain("/work/src/App.vue");
    expect(message).toMatch(/never looked/i);
    await vi.waitFor(() => expect(started).toHaveLength(1), SETTLES);
});

test("a turn that looked after its last surface edit is left alone", async () => {
    const { started } = runtimeWith();
    const nudged = await nudgeUnverifiedWork({
        conversationId: "c1",
        seed,
        rules: [viewRule],
        ledger: edited("/work/src/App.vue"),
        view: looked("/work/src/App.vue"),
    });
    expect(nudged).toBeUndefined();
    expect(started).toHaveLength(0);
});

/* A caller that keeps no view ledger must not fire this rule on an empty one: "you never looked" is true of an
 * empty record for the wrong reason, and it would be told to every turn on every runtime that has not been
 * wired up yet. */
test("the rule cannot fire without the ledger it reads", async () => {
    const { started } = runtimeWith();
    expect(await nudgeUnverifiedWork({ conversationId: "c1", seed, rules: [viewRule], ledger: edited("/work/src/App.vue") })).toBeUndefined();
    expect(started).toHaveLength(0);
});

// Two rules standing is two things to say and ONE turn to say them in: the follow-up is the expensive half.
test("both builtins standing produce a single follow-up carrying both", async () => {
    const { started } = runtimeWith();
    const message = await nudgeUnverifiedWork({
        conversationId: "c1",
        seed,
        rules: [rule, viewRule],
        ledger: edited("/work/src/App.vue"),
        view: drew("/work/src/App.vue"),
    });
    expect(message).toMatch(/no check.*passed/i);
    expect(message).toContain("/work/src/App.vue");
    expect(message).toMatch(/never looked/i);
    await vi.waitFor(() => expect(started).toHaveLength(1), SETTLES);
});

// A conversation whose follow-up never landed must not be left holding a guard against one that is not coming.
test("a follow-up that cannot start releases the conversation instead of blocking it forever", async () => {
    const attempts: string[] = [];
    runtimeWith({
        start: async (turn) => {
            attempts.push(turn.conversationId);
            throw new Error("a turn is already running on that conversation");
        },
    });
    await nudgeUnverifiedWork({ conversationId: "c1", seed, rules: [rule], ledger: edited("/work/src/parser.ts") });
    await vi.waitFor(() => expect(attempts.length).toBeGreaterThan(0), SETTLES);
});
