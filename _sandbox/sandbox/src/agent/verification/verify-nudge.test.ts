import { type AgentTurn, isVerifyNudge, profileOf, type Rule } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import { waitFor, SETTLES } from "@intentic/testing/bun";
import { WORKSPACE_ROOT } from "@intentic/constants";
import { createFrameLedger, type FrameLedger } from "./agent-verification.js";
import { createViewFrameLedger, type ViewFrameLedger } from "./agent-viewing.js";
import type { SentTurn } from "../../seams/turn-starter.js";
import { memoryFleet } from "../../testing.js";
import { nudgeUnverifiedWork, startVerifyNudgeRuntime, type VerifyNudgeRuntime } from "./verify-nudge.js";

// Tests the follow-up a runtime with no Stop hooks is sent (a repository's red turn check, the look the frame ledger says
// was skipped), and the guards around spending a turn to deliver it.

const rule: Rule = {
    id: "repo-check-app-2",
    label: "Verify before you finish",
    moment: "turn.ending",
    action: { kind: "command", command: "pnpm verify:turn", timeoutMs: 900_000 },
    enabled: true,
};
const seed: AgentTurn = { prompt: "fix the parser", agent: "codex", model: "gpt-5.1-codex", effort: "high" };

const edited = (path: string): FrameLedger => {
    const ledger = createFrameLedger();
    ledger.note({ kind: "tool_call", id: "1", name: "Edit", category: "edit", status: "completed", locations: [{ path }] });
    return ledger;
};

// Built from the constant, not spelled: a new literal here is what the path-literals baseline exists to stop.
const PARSER = `${WORKSPACE_ROOT}/src/parser.ts`;

// What the daemon's own run of the turn check says when it goes red, already worded for the model.
const RED = [`Before finishing, "Verify before you finish" ran this and it exited 1:\n\`pnpm verify:turn\`\n${PARSER}: error TS2322`];

const logger = { info: () => {}, warn: () => {}, error: () => {} } as unknown as Logger;

let stop: (() => void) | undefined;
const runtimeWith = (overrides: Partial<VerifyNudgeRuntime> = {}): { started: (SentTurn & { conversationId: string })[] } => {
    const started: (SentTurn & { conversationId: string })[] = [];
    stop?.();
    stop = startVerifyNudgeRuntime({
        logger,
        // A fleet per runtime, so no conversation's nudge guard carries from one test into the next.
        conversations: memoryFleet().conversations,
        start: async (turn) => {
            started.push(turn);
            return "started";
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

test("a turn whose check went red is sent a follow-up, as its own turn", async () => {
    const { started } = runtimeWith();
    const message = await nudgeUnverifiedWork({
        conversationId: "c1",
        profile: profileOf(seed),
        rules: [rule],
        ledger: edited(PARSER),
        findings: RED,
    });

    expect(message).toContain(RED[0]);
    await waitFor(() => expect(started).toHaveLength(1), SETTLES);
    // Runs where the work ran and picks the thread back up; a new provider or session asks the wrong agent. Nobody sent it.
    expect(started[0]).toMatchObject({ conversationId: "c1", agent: "codex", model: "gpt-5.1-codex", effort: "high", sessionId: "session-7", byPerson: false });
    expect(started[0]?.prompt).toBe(message);
});

// A refusal that waiting cannot lift: the follow-up is not tried again, and the guard goes with it at once, where a busy
// conversation keeps the guard through every retry.
test("a conversation archived since its turn ended is sent no follow-up, and is left free", async () => {
    const tried: string[] = [];
    runtimeWith({
        start: async (turn) => {
            tried.push(turn.conversationId);
            return "archived";
        },
    });
    const nudge = { conversationId: "c1", profile: profileOf(seed), rules: [rule], ledger: edited(PARSER), findings: RED };
    await nudgeUnverifiedWork(nudge);
    await waitFor(() => expect(tried).toEqual(["c1"]), SETTLES);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await nudgeUnverifiedWork(nudge)).toContain(RED[0]);
    await waitFor(() => expect(tried).toEqual(["c1", "c1"]), SETTLES);
});

// The nudge goes out as an ordinary prompt, so the chat has only its opening to tell it from something the user typed.
// Sent without one it reaches the reader as their own words, in a bubble the edit pencil offers to rewind to.
test("a follow-up opens with the words the chat recognises it by", async () => {
    runtimeWith();
    const message = await nudgeUnverifiedWork({
        conversationId: "c1",
        profile: profileOf(seed),
        rules: [rule],
        ledger: edited(PARSER),
        findings: RED,
    });

    expect(isVerifyNudge(message ?? "")).toBe(true);
    // The findings still follow it whole: the opening is a preface, not a replacement.
    expect(message).toContain(RED[0]);
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
    await nudgeUnverifiedWork({ conversationId: "c1", profile: profileOf(persona), rules: [rule], ledger: edited(PARSER), findings: RED });

    await waitFor(() => expect(started).toHaveLength(1), SETTLES);
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
    await nudgeUnverifiedWork({ conversationId: "c1", profile: profileOf(seed), rules: [rule], ledger: edited(PARSER), findings: RED });

    await waitFor(() => expect(started).toHaveLength(1), SETTLES);
    expect(started[0]?.runRole).toBeUndefined();
});

test("a turn whose checks passed is left alone", async () => {
    const { started } = runtimeWith();
    expect(
        await nudgeUnverifiedWork({ conversationId: "c1", profile: profileOf(seed), rules: [rule], ledger: edited(PARSER), findings: [] }),
    ).toBeUndefined();
    expect(started).toHaveLength(0);
});

// Nothing here is on by default: with no rule standing, an unproven turn is just a turn that ended.
test("no rule standing means no follow-up, whatever was found", async () => {
    const { started } = runtimeWith();
    expect(
        await nudgeUnverifiedWork({ conversationId: "c1", profile: profileOf(seed), rules: [], ledger: edited(PARSER), findings: RED }),
    ).toBeUndefined();
    expect(started).toHaveLength(0);
});

// The loop guard: the follow-up runs as its own watched turn, so a model that answers it without running anything would
// be nudged again and again.
test("a nudge never answers a nudge", async () => {
    const { started } = runtimeWith();
    await nudgeUnverifiedWork({ conversationId: "c1", profile: profileOf(seed), rules: [rule], ledger: edited(PARSER), findings: RED });
    await waitFor(() => expect(started).toHaveLength(1), SETTLES);

    // The follow-up turn ends just as unproven as the one that triggered it, and is left alone.
    expect(
        await nudgeUnverifiedWork({ conversationId: "c1", profile: profileOf(seed), rules: [rule], ledger: edited(PARSER), findings: RED }),
    ).toBeUndefined();
    expect(started).toHaveLength(1);

    // The conversation is free again from the turn after that.
    await nudgeUnverifiedWork({ conversationId: "c1", profile: profileOf(seed), rules: [rule], ledger: edited(PARSER), findings: RED });
    await waitFor(() => expect(started).toHaveLength(2), SETTLES);
});

// `verify-ui-edits` reads what the turn drew against whether it looked, reaching a Codex or Cursor turn off frames.
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
        profile: profileOf(seed),
        rules: [viewRule],
        ledger: edited(`${WORKSPACE_ROOT}/src/App.vue`),
        view: drew(`${WORKSPACE_ROOT}/src/App.vue`),
    });
    expect(message).toContain(`${WORKSPACE_ROOT}/src/App.vue`);
    expect(message).toMatch(/never looked/i);
    await waitFor(() => expect(started).toHaveLength(1), SETTLES);
});

test("a turn that looked after its last surface edit is left alone", async () => {
    const { started } = runtimeWith();
    const nudged = await nudgeUnverifiedWork({
        conversationId: "c1",
        profile: profileOf(seed),
        rules: [viewRule],
        ledger: edited(`${WORKSPACE_ROOT}/src/App.vue`),
        view: looked(`${WORKSPACE_ROOT}/src/App.vue`),
    });
    expect(nudged).toBeUndefined();
    expect(started).toHaveLength(0);
});

// The built-in's conditions are read here, against what the turn touched, since nothing earlier knows that yet.
test("a look narrowed to paths this turn never touched stays quiet", async () => {
    const { started } = runtimeWith();
    const narrowed: Rule = { ...viewRule, when: { paths: ["docs/**"] } };
    expect(
        await nudgeUnverifiedWork({
            conversationId: "c1",
            profile: profileOf(seed),
            rules: [narrowed],
            ledger: edited(`${WORKSPACE_ROOT}/src/App.vue`),
            view: drew(`${WORKSPACE_ROOT}/src/App.vue`),
            cwd: WORKSPACE_ROOT,
        }),
    ).toBeUndefined();
    expect(started).toHaveLength(0);
});

// A caller with no view ledger must not fire this rule on an empty one: "you never looked" would be true of an empty
// record for the wrong reason, on every unwired runtime.
test("the rule cannot fire without the ledger it reads", async () => {
    const { started } = runtimeWith();
    expect(
        await nudgeUnverifiedWork({
            conversationId: "c1",
            profile: profileOf(seed),
            rules: [viewRule],
            ledger: edited(`${WORKSPACE_ROOT}/src/App.vue`),
        }),
    ).toBeUndefined();
    expect(started).toHaveLength(0);
});

// Two things to say is one turn: the follow-up is the expensive half.
test("a red check and a skipped look produce a single follow-up carrying both", async () => {
    const { started } = runtimeWith();
    const message = await nudgeUnverifiedWork({
        conversationId: "c1",
        profile: profileOf(seed),
        rules: [rule, viewRule],
        ledger: edited(`${WORKSPACE_ROOT}/src/App.vue`),
        view: drew(`${WORKSPACE_ROOT}/src/App.vue`),
        findings: RED,
    });
    expect(message).toContain(RED[0]);
    expect(message).toContain(`${WORKSPACE_ROOT}/src/App.vue`);
    expect(message).toMatch(/never looked/i);
    await waitFor(() => expect(started).toHaveLength(1), SETTLES);
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
    await nudgeUnverifiedWork({ conversationId: "c1", profile: profileOf(seed), rules: [rule], ledger: edited(PARSER), findings: RED });
    await waitFor(() => expect(attempts.length).toBeGreaterThan(0), SETTLES);
});
