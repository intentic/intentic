import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { AccountUsage, ProviderRefusal } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import type { OauthAccount } from "@intentic/sandbox-contract/schemas/providers/provider-oauth";
import { claudeLimitRefusal, claudeReading } from "../claude/claude-usage.testing.js";
import { unstubbed } from "@intentic/testing";
import { services } from "../../../harness/route-services.testing.js";
import type { Services } from "../../../composition.js";
import { beginTurn } from "../../../conversations/actor/conversation-actors.testing.js";
import { conversationEntry } from "../../../conversations/registry/agents-store.testing.js";
import type { ConversationState } from "../../../conversations/actor/conversation-state.js";
import { onHeldRepointed } from "../../../conversations/actor/held-decide.js";
import { limitBooking } from "../../../conversations/actor/limit-booking.js";
import { switchAccount } from "./switch-account.js";

// The one command that moves who pays. A conversation's account is the daemon's record; this is the only write to it
// besides the session frame of a turn that ran.

const ID = "conv-switch";
const T0 = 1_700_000_000_000;

// A conversation that ran one turn on `acct-a`, its session `s-1` minted there.
const ranOnce = async (deps: Services): Promise<void> => {
    await beginTurn(deps.conversations, { conversationId: ID, prompt: "go", isolated: false, profile: { agent: "claude", harness: "native", account: "acct-a" } }, T0);
    const frame: AgentEvent = { kind: "session", sessionId: "s-1", account: "acct-a" };
    deps.conversations.send(ID, { kind: "frame", frame }, T0);
    await deps.conversations.send(ID, { kind: "settle" }, T0).settled;
};

test("re-points the conversation and retires the session another account minted", async () => {
    const deps = services();
    await ranOnce(deps);
    expect(deps.agents.entry(ID)?.sessionId).toBe("s-1");
    expect(await switchAccount(deps, { conversationId: ID, account: "acct-b" })).toEqual({ kind: "moved" });
    expect(deps.agents.entry(ID)?.profile.account).toBe("acct-b");
    expect(deps.agents.entry(ID)?.sessionId).toBeUndefined();
    expect(deps.agents.get(ID)?.account).toBe("acct-b");
});

test("keeps the session when asked to carry it, and when the account does not change", async () => {
    const carried = services();
    await ranOnce(carried);
    await switchAccount(carried, { conversationId: ID, account: "acct-b", carry: true });
    expect([carried.agents.entry(ID)?.profile.account, carried.agents.entry(ID)?.sessionId]).toEqual(["acct-b", "s-1"]);
    const same = services();
    await ranOnce(same);
    await switchAccount(same, { conversationId: ID, account: "acct-a" });
    expect(same.agents.entry(ID)?.sessionId).toBe("s-1");
});

test("refuses a conversation it does not know, and one whose turn is running", async () => {
    const deps = services();
    expect(await switchAccount(deps, { conversationId: "nobody", account: "acct-b" })).toEqual({ kind: "unknown" });
    await beginTurn(deps.conversations, { conversationId: ID, prompt: "go", isolated: false, profile: { agent: "claude", harness: "native", account: "acct-a" } }, T0);
    expect(await switchAccount(deps, { conversationId: ID, account: "acct-b" })).toEqual({ kind: "busy" });
    expect(deps.agents.entry(ID)?.profile.account).toBe("acct-a");
});

// What the daemon's verdict on an account is judged from (serviceability.ts): both accounts connected, no seat marks,
// the reading, and the refusals on file.
// SAFETY: the verdict reads only an account's id; the rest of a stored row is the store's own business.
const ACCOUNTS = [{ id: "acct-a", label: "a" }, { id: "acct-b", label: "b" }] as OauthAccount[];
const verdictOf = (usage: Record<string, AccountUsage>, refusals: readonly ProviderRefusal[]) => ({
    accountUsage: unstubbed<Services["accountUsage"]>("accountUsage", { read: async () => usage }),
    claudeStore: unstubbed<Services["claudeStore"]>("claudeStore", { list: async () => [...ACCOUNTS] }),
    claudeSeats: unstubbed<Services["claudeSeats"]>("claudeSeats", { read: async () => ({}) }),
    providerRefusals: unstubbed<Services["providerRefusals"]>("providerRefusals", { onFile: async () => ({ claude: refusals }) }),
    cliProxy: unstubbed<Services["cliProxy"]>("cliProxy", {}),
    providerAccounts: async () => [],
});

test("asked to run, a held turn runs again at once on the account named, carried when asked", async () => {
    const pressed: unknown[] = [];
    const reopened: string[] = [];
    const sent: unknown[] = [];
    const deps = {
        agents: unstubbed<Services["agents"]>("agents", {
            entry: () => conversationEntry({ id: ID }),
            clearArchived: async (ids) => void reopened.push(...ids),
        }),
        conversations: unstubbed<Services["conversations"]>("conversations", {
            state: () => ({ resume: { held: { input: { conversationId: ID, prompt: "go", agent: "claude", harness: "native", account: "acct-a" }, reason: "limit", ran: true } } }) as never,
            send: (_id, event) => {
                sent.push(event);
                return { settled: Promise.resolve(), reply: undefined } as never;
            },
        }),
        turns: unstubbed<Services["turns"]>("turns", {
            resume: async (_id, routing) => {
                pressed.push({ routing });
                return { id: "run-2" } as never;
            },
        }),
        claudeSeatCheck: unstubbed<Services["claudeSeatCheck"]>("claudeSeatCheck", { recheck: async () => true }),
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", {}),
        ...verdictOf({}, []),
    };
    expect(await switchAccount(deps, { conversationId: ID, account: "acct-b", carry: true, run: true })).toEqual({ kind: "moved", run: "run-2" });
    expect(pressed).toEqual([{ routing: { agent: "claude", harness: "native", account: "acct-b", carry: true } }]);
    // A person's press reopens a conversation archived since the turn was held, at this door: the engine refuses every
    // archived one.
    expect(reopened).toEqual([ID]);
    // What their words wait with goes on the account the press named, too.
    expect(sent).toEqual([{ kind: "queue-rerouted", routing: { agent: "claude", harness: "native", account: "acct-b" } }]);
});

// Everything a person's words wait with follows the pick: a message the door refused (an expired account), and one booked
// for later. Left on the account they were sent with, a memory release or a booking's time sent them on the account the
// person had just moved off (2026-10-17). Each keeps its own model, and nothing goes out: a pick is never a press.
test("a pick re-points the words that wait, held and booked, and sends none of them", async () => {
    const deps = services();
    await ranOnce(deps);
    const turn = (prompt: string) => ({ conversationId: ID, prompt, agent: "claude" as const, harness: "native" as const, account: "acct-a", model: "opus" });
    deps.conversations.send(ID, { kind: "queue-returned", items: [{ id: "held", voice: "person", queuedAt: T0, turn: turn("refused at the door") }] }, T0);
    deps.conversations.send(ID, { kind: "queue-scheduled", item: { id: "later", voice: "person", queuedAt: T0, turn: turn("at five") }, booking: { until: T0 + 3_600_000 } }, T0);
    deps.conversations.send(ID, { kind: "queue-joined", item: { id: "wake", voice: "sandbox", queuedAt: T0, turn: turn("a watch fired") } }, T0);
    expect(await switchAccount(deps, { conversationId: ID, account: "acct-b" })).toEqual({ kind: "moved" });
    const queue = deps.conversations.queued(ID);
    expect(queue.items.map((item) => [item.id, item.turn.account, item.turn.model])).toEqual([
        ["held", "acct-b", "opus"],
        ["later", "acct-b", "opus"],
        // The sandbox's own words take the conversation's routing when they go (onCurrentRouting), never their own.
        ["wake", "acct-a", "opus"],
    ]);
    // Still held and still booked: the pick let nothing go.
    expect(queue.paused).toBe("refused");
    expect(queue.items.find((item) => item.id === "later")?.until).toBe(T0 + 3_600_000);
    // A second pick of the same account changes nothing, and writes nothing.
    const revision = queue.revision;
    await switchAccount(deps, { conversationId: ID, account: "acct-b" });
    expect(deps.conversations.queued(ID).revision).toBe(revision);
});

// A pick in the model picker moves the conversation and nothing else: a turn held by a limit, a stop or a memory
// refusal stays held until a press asks for it, never started by the pick itself. A limit hold's booking follows the
// pick, though: it re-runs on the picked account at that account's reopen, and the card's reset says the same instant.
const heldOnPick = (usage: Record<string, AccountUsage>, refusals: readonly ProviderRefusal[] = []) => {
    const pressed: unknown[] = [];
    const moved: [string, { readonly resetsAt?: number; readonly booking?: { readonly at: number } } | undefined][] = [];
    const sent: unknown[] = [];
    // The refused account's hold, re-pointed by the actor's own rule (held-decide.ts onHeldRepointed), since the booking
    // the pick leaves is read back off the hold the pick made.
    // SAFETY: switchAccount and onHeldRepointed read only the phase and the held-turn records of the state.
    let state = {
        phase: { kind: "idle" },
        resume: {
            held: {
                input: { conversationId: ID, prompt: "go", agent: "claude", harness: "native", account: "acct-a", model: "opus" },
                reason: "limit",
                ran: false,
                reopensAt: 1_700_020_000,
                recordedAt: T0 - 60_000,
                fired: false,
                tries: 0,
            },
            authFiring: false,
            stopTries: 0,
        },
    } as ConversationState;
    const deps = {
        agents: unstubbed<Services["agents"]>("agents", {
            entry: () => conversationEntry({ id: ID }),
            switchAccount: async (_id, account, limit) => {
                moved.push([account, limit]);
                return undefined;
            },
        }),
        conversations: unstubbed<Services["conversations"]>("conversations", {
            state: () => state,
            send: (_id, event) => {
                sent.push(event);
                if (event.kind === "held-repointed") {
                    state = onHeldRepointed(state, event).state;
                }
                // SAFETY: switchAccount reads neither the reply nor the settlement of a repoint beyond awaiting it.
                return { settled: Promise.resolve(), reply: true } as never;
            },
        }),
        // SAFETY: the booking reads only the sandbox-wide answer to a spent allowance.
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: async () => ({ limitPolicy: "resend" }) as never }),
        turns: unstubbed<Services["turns"]>("turns", {
            resume: async (_id, routing) => {
                pressed.push(routing);
                return { id: "run-2" } as never;
            },
        }),
        claudeSeatCheck: unstubbed<Services["claudeSeatCheck"]>("claudeSeatCheck", { recheck: async () => true }),
        ...verdictOf(usage, refusals),
    };
    return { deps, pressed, moved, sent };
};

// acct-b as the Claude reader files it (claude-usage.testing.ts): every pool rounded, so a full one reads at the line, and
// the refusal on file is what proves it spent until the reopen it named.
const REOPEN_B = 1_700_005_000;
const FULL_B = claudeReading({ five_hour: { utilization: 100, resetsAt: REOPEN_B } }, T0);
const REFUSED_B = claudeLimitRefusal({ account: "acct-b", resetsAt: REOPEN_B, at: T0 - 60_000, model: "opus" });

// Read off the bare reading, every spent Claude account looked open: a pick from one spent account to another booked the
// held turn for now, and the next pass sent it to be refused within seconds (2026-10-19, grand-alder-29zo, kind-lynx-7jba).
test("without run, a held turn stays held, and its booking moves to the picked account's reopen", async () => {
    const { deps, pressed, moved, sent } = heldOnPick({ "acct-b": FULL_B }, [REFUSED_B]);
    expect(await switchAccount(deps, { conversationId: ID, account: "acct-b" }, T0)).toEqual({ kind: "moved" });
    expect(pressed).toEqual([]);
    expect(sent).toContainEqual({ kind: "held-repointed", account: "acct-b", carry: false, reopensAt: REOPEN_B });
    // The card is re-stated in the same write: the picked account's reset; the re-run its `next` derives is the hold's.
    expect(moved).toEqual([["acct-b", { resetsAt: REOPEN_B }]]);
    expect(limitBooking(deps.conversations.state(ID)?.resume.held, "resend")).toEqual({ at: REOPEN_B * 1000 });
});

// An account with room has nothing to wait for: the booking is due now (an armed resend goes on the next pass, a
// `wait` answer still waits for a press), and the card states no clock at all.
test("a pick onto an account with room clears the wait rather than keeping the refused account's", async () => {
    const { deps, moved, sent } = heldOnPick({ "acct-b": claudeReading({ five_hour: { utilization: 40, resetsAt: REOPEN_B } }, T0) });
    await switchAccount(deps, { conversationId: ID, account: "acct-b" }, T0);
    expect(sent).toContainEqual({ kind: "held-repointed", account: "acct-b", carry: false, reopensAt: Math.ceil(T0 / 1000) });
    // No clock on the card, and the re-run booked for now: the next pass sends it.
    expect(moved).toEqual([["acct-b", {}]]);
    expect(limitBooking(deps.conversations.state(ID)?.resume.held, "resend")).toEqual({ at: Math.ceil(T0 / 1000) * 1000 });
});

// At the line with no refusal standing is not spent: the pool may hold a sliver, so the booked re-run goes now and the
// provider answers, as it would for any account the records cannot call spent.
test("a pick onto an account only at the line, with no refusal standing, books the held turn for now", async () => {
    const { deps, moved } = heldOnPick({ "acct-b": FULL_B });
    await switchAccount(deps, { conversationId: ID, account: "acct-b" }, T0);
    expect(moved).toEqual([["acct-b", {}]]);
    expect(limitBooking(deps.conversations.state(ID)?.resume.held, "resend")).toEqual({ at: Math.ceil(T0 / 1000) * 1000 });
});

// Picking an account is an attempt on it: a seat-marked one is re-tested at once, not on the rationed schedule, so access
// an admin turned back on is found without waiting (claude-seat-check.ts).
test("a pick re-tests the account's seat at once", async () => {
    const asked: [string, { readonly force?: boolean } | undefined][] = [];
    const deps = services({
        claudeSeatCheck: {
            recheck: async (id, options) => {
                asked.push([id, options]);
                return true;
            },
        },
    });
    await ranOnce(deps);
    await switchAccount(deps, { conversationId: ID, account: "acct-a" });
    expect(asked).toEqual([["acct-a", { force: true }]]);
});
