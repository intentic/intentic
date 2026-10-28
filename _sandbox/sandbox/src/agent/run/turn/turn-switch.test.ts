import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../../../composition.js";
import { createHoldingsIndex, type LiveRun, RUNS, type Share } from "../../../conversations/actor/conversation-holdings.js";
import type { PersistedAgent,StoredProfile } from "../../../conversations/registry/agents-store.js";
import { conversationAfter, conversationEntry } from "../../../conversations/registry/agents-store.testing.js";
import { switchedFrame, switchFrames, type TurnSwitch, turnSwitchOf, withSwitchTold } from "./turn-switch.js";

// A turn says it switched only where the conversation's own record, before and after its begin, proves it did: never on
// a first turn, never for effort or thinking, and never for an account or model only one side names.

const CLAUDE: StoredProfile = { provider: "claude", harness: "native", account: "home", model: "claude-opus-5-5" };
// Two turns in, on a session the last one minted.
const before = (profile: StoredProfile = CLAUDE) => conversationAfter(2, { profile, sessionId: "s1" });
const after = (profile: StoredProfile) => conversationEntry({ profile });
const ON_SESSION = { sessionId: "s1" };

test("a provider switch is the provider's, whatever else moved with it, and opens a fresh session", () => {
    const codex: StoredProfile = { provider: "codex", harness: "native", model: "gpt-5-codex" };
    expect(turnSwitchOf(before(), after(codex), {})).toEqual({ segment: "provider", profile: codex, fresh: true });
});

test("an account switch on the same provider opens a fresh session", () => {
    const work = { ...CLAUDE, account: "work" };
    expect(turnSwitchOf(before(), after(work), {})).toEqual({ segment: "account", profile: work, fresh: true });
});

test("a loop switch on the same provider and account opens a fresh session", () => {
    const kimi: StoredProfile = { provider: "kimi", harness: "native", account: "k1" };
    const onOpenCode = { ...kimi, harness: "opencode" as const };
    expect(turnSwitchOf(before(kimi), after(onOpenCode), {})).toEqual({ segment: "loop", profile: onOpenCode, fresh: true });
    // Two names for one runtime are one loop (routing.ts sameLoop): Claude's native loop is Claude Code.
    expect(turnSwitchOf(before(), after({ ...CLAUDE, harness: "claude-code" }), ON_SESSION)).toBeUndefined();
});

test("a model switch alone goes on in the same session, or says it is fresh where there is none to go on in", () => {
    const sonnet = { ...CLAUDE, model: "claude-sonnet-5" };
    expect(turnSwitchOf(before(), after(sonnet), ON_SESSION)).toEqual({ segment: "model", profile: sonnet, fresh: false });
    // The previous turn minted no session, or this turn resumes none.
    expect(turnSwitchOf(conversationAfter(2, { profile: CLAUDE }), after(sonnet), ON_SESSION)?.fresh).toBe(true);
    expect(turnSwitchOf(before(), after(sonnet), {})?.fresh).toBe(true);
});

test("a conversation that has run no turn has nothing to switch from", () => {
    const codex: StoredProfile = { provider: "codex", harness: "native" };
    expect(turnSwitchOf(undefined, after(codex), {})).toBeUndefined();
    // A booked first message writes the record before any turn ran.
    expect(turnSwitchOf(conversationEntry({ profile: CLAUDE }), after(codex), {})).toBeUndefined();
});

test("nothing is a switch where provider, account, loop and model all stayed, effort and thinking included", () => {
    expect(turnSwitchOf(before(), after(CLAUDE), ON_SESSION)).toBeUndefined();
    expect(turnSwitchOf(before(), after({ ...CLAUDE, effort: "high", thinking: true, fast: true }), ON_SESSION)).toBeUndefined();
});

test("an account or model only one side names is not said to have changed", () => {
    const unlatched = { ...CLAUDE, account: undefined };
    expect(turnSwitchOf(before(unlatched), after(CLAUDE), {})).toBeUndefined();
    const defaultModel = { ...CLAUDE, model: undefined };
    expect(turnSwitchOf(before(defaultModel), after(CLAUDE), ON_SESSION)).toBeUndefined();
});

test("a re-run whose own row says it went on another account is not told twice; any other switch still is", () => {
    const work = { ...CLAUDE, account: "work" };
    expect(turnSwitchOf(before(), after(work), { resume: "switched" })).toBeUndefined();
    expect(turnSwitchOf(before(), after(work), { resume: "carried", sessionId: "s1" })).toBeUndefined();
    expect(turnSwitchOf(before(), after({ provider: "codex", harness: "native" }), { resume: "switched" })?.segment).toBe("provider");
});

const logger = unstubbed<Services["logger"]>("logger", { warn: () => {} });
const claudeAccounts = (accounts: readonly { readonly id: string; readonly label: string }[]) => ({
    claudeStore: unstubbed<Services["claudeStore"]>("claudeStore", {
        list: async () => accounts.map((account) => ({ ...account, connectedAt: 0 })),
    }),
    claudeSeats: unstubbed<Services["claudeSeats"]>("claudeSeats", { read: async () => ({}) }),
    accountUsage: unstubbed<Services["accountUsage"]>("accountUsage", { read: async () => ({}) }),
});
const deps = (accounts: readonly { readonly id: string; readonly label: string }[]) =>
    unstubbed<Services>("services", { logger, ...claudeAccounts(accounts) });

test("the frame names the account as the sandbox shows it, and the loop as a person reads it", async () => {
    const change: TurnSwitch = { segment: "account", profile: { ...CLAUDE, account: "work" }, fresh: true };
    expect(await switchedFrame(deps([{ id: "work", label: "Work" }]), change)).toEqual({
        kind: "switched",
        segment: "account",
        provider: "claude",
        model: "claude-opus-5-5",
        account: "Work",
        loop: "Claude Code",
        fresh: true,
    });
});

test("an account the sandbox has no name for, or whose rows cannot be read, goes without one", async () => {
    const change: TurnSwitch = { segment: "account", profile: { ...CLAUDE, account: "work" }, fresh: true };
    expect((await switchedFrame(deps([]), change)).account).toBeUndefined();
    const broken = unstubbed<Services>("services", {
        logger,
        ...claudeAccounts([]),
        claudeStore: unstubbed<Services["claudeStore"]>("claudeStore", { list: async () => { throw new Error("unreadable"); } }),
    });
    expect(await switchedFrame(broken, change)).not.toHaveProperty("account");
});

const frames = async (services: Parameters<typeof switchFrames>[0]) => {
    const told = [];
    for await (const frame of switchFrames(services, "c1", before(), ON_SESSION)) {
        told.push(frame);
    }
    return told;
};

test("a turn tells its switch once, and a runner's mirror leaves it to the parent that dispatched the turn", async () => {
    const sonnet = { ...CLAUDE, model: "claude-sonnet-5" };
    const agents = unstubbed<Services["agents"]>("agents", { entry: () => after(sonnet) });
    const local = unstubbed<Services>("services", { logger, agents, runnerParent: {}, ...claudeAccounts([{ id: "home", label: "Home" }]) });
    expect(await frames(local)).toEqual([
        { kind: "switched", segment: "model", provider: "claude", model: "claude-sonnet-5", account: "Home", loop: "Claude Code", fresh: false },
    ]);
    const mirror = unstubbed<Services>("services", { logger, agents, runnerParent: { current: unstubbed("parent", {}) } });
    expect(await frames(mirror)).toEqual([]);
});

// A run the door turned away is never written, its switch row with it, though its begin rewrote the record: the next
// turn is measured against the record from before it, so the switch is told where it lands and never invented.
test("a run the door turned away leaves the record from before it as what the next turn is measured against", async () => {
    const sonnet = { ...CLAUDE, model: "claude-sonnet-5" };
    // One conversation's share, as its actor would lend it.
    const share: Share = new Map();
    const { holdings } = createHoldingsIndex(() => share);
    let current = after(sonnet);
    const services = unstubbed<Services>("services", {
        logger,
        agents: unstubbed<Services["agents"]>("agents", { entry: () => current }),
        conversations: unstubbed<Services["conversations"]>("conversations", { holdings }),
        runnerParent: {},
        ...claudeAccounts([]),
    });
    // The turn's own placed frames, its run left turned away or written as the turn ends.
    async function* placed(ranNothing: boolean): AsyncGenerator<AgentEvent> {
        yield { kind: "done" };
        holdings(RUNS).hold("c1", "c1", unstubbed<LiveRun>("run", { done: false, ranNothing, expired: () => false }));
    }
    const turn = async (previous: PersistedAgent | undefined, ranNothing: boolean): Promise<readonly string[]> => {
        const kinds: string[] = [];
        for await (const frame of withSwitchTold(services, "c1", previous, ON_SESSION, placed(ranNothing))) {
            kinds.push(frame.kind === "switched" ? `switched to ${frame.model}` : frame.kind);
        }
        return kinds;
    };
    const onSonnet = conversationAfter(3, { profile: sonnet, sessionId: "s1" });

    // Opus to Sonnet, turned away; sent again on Sonnet, it is told again, where the record will keep it.
    expect(await turn(before(), true)).toEqual(["switched to claude-sonnet-5", "done"]);
    expect(await turn(onSonnet, false)).toEqual(["switched to claude-sonnet-5", "done"]);
    // Written now, so the next turn is measured from the record as it is.
    expect(await turn(onSonnet, false)).toEqual(["done"]);

    // Opus to Sonnet, turned away, then back to Opus: the record never left Opus, so nothing is said.
    expect(await turn(before(), true)).toEqual(["switched to claude-sonnet-5", "done"]);
    current = after(CLAUDE);
    expect(await turn(onSonnet, false)).toEqual(["done"]);

    // A first message on Sonnet, turned away, then sent on Opus: nothing was on the record to switch from.
    expect(await turn(undefined, true)).toEqual(["done"]);
    expect(await turn(onSonnet, false)).toEqual(["done"]);
});
