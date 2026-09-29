import type { AgentEvent } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { services } from "../../../harness/route-services.testing.js";
import type { Services } from "../../../composition.js";
import { beginTurn, conversationEntry } from "../../../testing.js";
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

test("asked to run, a held turn runs again at once on the account named, carried when asked", async () => {
    const pressed: unknown[] = [];
    const reopened: string[] = [];
    const deps = {
        agents: unstubbed<Services["agents"]>("agents", {
            entry: () => conversationEntry({ id: ID }),
            clearArchived: async (ids) => void reopened.push(...ids),
        }),
        conversations: unstubbed<Services["conversations"]>("conversations", {
            state: () => ({ resume: { held: { input: { conversationId: ID, prompt: "go", agent: "claude", harness: "native", account: "acct-a" }, reason: "limit", ran: true } } }) as never,
        }),
        turns: unstubbed<Services["turns"]>("turns", {
            resume: async (_id, routing) => {
                pressed.push({ routing });
                return { id: "run-2" } as never;
            },
        }),
        claudeSeatCheck: unstubbed<Services["claudeSeatCheck"]>("claudeSeatCheck", { recheck: async () => true }),
        accountUsage: unstubbed<Services["accountUsage"]>("accountUsage", {}),
    };
    expect(await switchAccount(deps, { conversationId: ID, account: "acct-b", carry: true, run: true })).toEqual({ kind: "moved", run: "run-2" });
    expect(pressed).toEqual([{ routing: { agent: "claude", harness: "native", account: "acct-b", carry: true } }]);
    // A person's press reopens a conversation archived since the turn was held, at this door: the engine refuses every
    // archived one.
    expect(reopened).toEqual([ID]);
});

// A pick in the model picker moves the conversation and nothing else: a turn held by a limit, a stop or a memory
// refusal stays held until a press asks for it, never started by the pick itself. A limit hold's booking follows the
// pick, though: it re-runs on the picked account at that account's reopen, and the card's reset says the same instant.
const heldOnPick = (usage: Awaited<ReturnType<Services["accountUsage"]["read"]>>) => {
    const pressed: unknown[] = [];
    const moved: [string, { readonly resetsAt?: number } | undefined][] = [];
    const sent: unknown[] = [];
    const deps = {
        agents: unstubbed<Services["agents"]>("agents", {
            entry: () => conversationEntry({ id: ID }),
            switchAccount: async (_id, account, limit) => {
                moved.push([account, limit]);
                return undefined;
            },
        }),
        conversations: unstubbed<Services["conversations"]>("conversations", {
            state: () =>
                ({
                    phase: { kind: "idle" },
                    resume: {
                        held: {
                            input: { conversationId: ID, prompt: "go", agent: "claude", harness: "native", account: "acct-a", model: "opus" },
                            reason: "limit",
                            ran: false,
                            reopensAt: 1_700_020_000,
                            fired: false,
                        },
                    },
                }) as never,
            send: (_id, event) => {
                sent.push(event);
                return { settled: Promise.resolve(), reply: true } as never;
            },
        }),
        turns: unstubbed<Services["turns"]>("turns", {
            resume: async (_id, routing) => {
                pressed.push(routing);
                return { id: "run-2" } as never;
            },
        }),
        claudeSeatCheck: unstubbed<Services["claudeSeatCheck"]>("claudeSeatCheck", { recheck: async () => true }),
        accountUsage: unstubbed<Services["accountUsage"]>("accountUsage", { read: async () => usage }),
    };
    return { deps, pressed, moved, sent };
};

const window = (utilization: number, resetsAt: number) => ({ kind: "five_hour", label: "5h", utilization, resetsAt, gates: "all" }) as never;

test("without run, a held turn stays held, and its booking moves to the picked account's reopen", async () => {
    const { deps, pressed, moved, sent } = heldOnPick({ "acct-b": { windows: [window(100, 1_700_005_000)] } as never });
    expect(await switchAccount(deps, { conversationId: ID, account: "acct-b" }, T0)).toEqual({ kind: "moved" });
    expect(pressed).toEqual([]);
    expect(sent).toContainEqual({ kind: "held-repointed", account: "acct-b", carry: false, reopensAt: 1_700_005_000 });
    expect(moved).toEqual([["acct-b", { resetsAt: 1_700_005_000 }]]);
});

// An account with room has nothing to wait for: the booking is due now (an armed resend goes on the next pass, a
// `wait` answer still waits for a press), and the card states no clock at all.
test("a pick onto an account with room clears the wait rather than keeping the refused account's", async () => {
    const { deps, moved, sent } = heldOnPick({ "acct-b": { windows: [window(40, 1_700_005_000)] } as never });
    await switchAccount(deps, { conversationId: ID, account: "acct-b" }, T0);
    expect(sent).toContainEqual({ kind: "held-repointed", account: "acct-b", carry: false, reopensAt: Math.ceil(T0 / 1000) });
    expect(moved).toEqual([["acct-b", {}]]);
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
