import type { AgentTurn, Rule } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import { afterEach, expect, test, vi } from "vitest";
import { WORKSPACE_ROOT } from "@intentic/constants";
import { SETTLES } from "@intentic/testing/vitest";
import { createFrameLedger, type FrameLedger } from "./agent-verification.js";
import { createViewFrameLedger, type ViewFrameLedger } from "./agent-viewing.js";
import { nudgeUnverifiedWork, startVerifyNudgeRuntime, type VerifyNudgeRuntime } from "./verify-nudge.js";

// Tests the proof follow-up made off the frame ledger on a runtime with no Stop hooks, and the guards around spending a
// turn to deliver it.

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

// Built from the constant, not spelled: a new literal here is what the path-literals baseline exists to stop.
const PARSER = `${WORKSPACE_ROOT}/src/parser.ts`;

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
    // Runs where the work ran and picks the thread back up; a new provider or session asks the wrong agent.
    expect(started[0]).toMatchObject({ conversationId: "c1", agent: "codex", model: "gpt-5.1-codex", effort: "high", sessionId: "session-7" });
    expect(started[0]?.prompt).toBe(message);
});

// Carries every field of the turn it nudges, not just provider/model/effort: `thinking`, `fast`, `actsAs` too, or a
// persona's follow-up loses its toolbox and accounts. Inherits `runRole` from the nudged turn; a `verify-nudge` role
// would only ever bind to an unattended, model-less turn, the opposite of this one.
test("the follow-up carries the whole identity of the turn it nudges, and invents no role of its own", async () => {
    const { started } = runtimeWith();
    const persona: AgentTurn = {
        ...seed,
        thinking: false,
        fast: true,
        actsAs: "reviewer",
        unattended: true,
        harness: "claude-code",
        account: "work",
        runRole: "maintenance-chore",
    };
    await nudgeUnverifiedWork({ conversationId: "c1", seed: persona, rules: [rule], ledger: edited(PARSER) });

    await vi.waitFor(() => expect(started).toHaveLength(1), SETTLES);
    expect(started[0]).toMatchObject({
        agent: "codex",
        model: "gpt-5.1-codex",
        effort: "high",
        harness: "claude-code",
        account: "work",
        thinking: false,
        fast: true,
        actsAs: "reviewer",
        unattended: true,
        runRole: "maintenance-chore",
    });
});

// A turn with no job leaves the follow-up with none either: absent stays absent.
test("a nudged turn with no job gives the follow-up no job", async () => {
    const { started } = runtimeWith();
    await nudgeUnverifiedWork({ conversationId: "c1", seed, rules: [rule], ledger: edited(PARSER) });

    await vi.waitFor(() => expect(started).toHaveLength(1), SETTLES);
    expect(started[0]?.runRole).toBeUndefined();
});

test("a turn whose check passed after its last edit is left alone", async () => {
    const { started } = runtimeWith();
    expect(await nudgeUnverifiedWork({ conversationId: "c1", seed, rules: [rule], ledger: proved("/work/src/parser.ts") })).toBeUndefined();
    expect(started).toHaveLength(0);
});

// Nothing here is on by default: with no rule standing, an unproven turn is just a turn that ended.
test("no rule standing means no follow-up, however unproven the work", async () => {
    const { started } = runtimeWith();
    expect(await nudgeUnverifiedWork({ conversationId: "c1", seed, rules: [], ledger: edited("/work/src/parser.ts") })).toBeUndefined();
    expect(started).toHaveLength(0);
});

// The rule's conditions are read here, against what the turn touched, since nothing earlier knows that yet.
test("a rule narrowed to paths this turn never touched stays quiet", async () => {
    const { started } = runtimeWith();
    const narrowed: Rule = { ...rule, when: { paths: ["docs/**"] } };
    expect(await nudgeUnverifiedWork({ conversationId: "c1", seed, rules: [narrowed], ledger: edited("/work/src/parser.ts"), cwd: "/work" })).toBeUndefined();
    expect(started).toHaveLength(0);
});

// The loop guard: the follow-up runs as its own watched turn, so a model that answers it without running anything would
// be nudged again and again.
test("a nudge never answers a nudge", async () => {
    const { started } = runtimeWith();
    await nudgeUnverifiedWork({ conversationId: "c1", seed, rules: [rule], ledger: edited("/work/src/parser.ts") });
    await vi.waitFor(() => expect(started).toHaveLength(1), SETTLES);

    // The follow-up turn ends just as unproven as the one that triggered it, and is left alone.
    expect(await nudgeUnverifiedWork({ conversationId: "c1", seed, rules: [rule], ledger: edited("/work/src/parser.ts") })).toBeUndefined();
    expect(started).toHaveLength(1);

    // The conversation is free again from the turn after that.
    await nudgeUnverifiedWork({ conversationId: "c1", seed, rules: [rule], ledger: edited("/work/src/parser.ts") });
    await vi.waitFor(() => expect(started).toHaveLength(2), SETTLES);
});

// The other ledger on the same road: `verify-ui-edits` reads what the turn drew against whether it looked, reaching a
// Codex or Cursor turn off frames, the way `verify-edits` does.
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

// A caller with no view ledger must not fire this rule on an empty one: "you never looked" would be true of an empty
// record for the wrong reason, on every unwired runtime.
test("the rule cannot fire without the ledger it reads", async () => {
    const { started } = runtimeWith();
    expect(await nudgeUnverifiedWork({ conversationId: "c1", seed, rules: [viewRule], ledger: edited("/work/src/App.vue") })).toBeUndefined();
    expect(started).toHaveLength(0);
});

// Two rules standing is two things to say in one turn: the follow-up is the expensive half.
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

// A conversation whose follow-up never started must not be left guarding one that isn't coming.
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
