import type { AgentEvent } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { services } from "../../harness/route-services.testing.js";
import type { Services } from "../../composition.js";
import { beginTurn, conversationEntry } from "../../testing.js";
import { switchAccount } from "./switch-account.js";

// The one command that moves who pays. A conversation's account is the daemon's record; this is the only write to it
// besides the session frame of a turn that ran.

const ID = "conv-switch";
const T0 = 1_700_000_000_000;

// A conversation that ran one turn on `acct-a`, its session `s-1` minted there.
const ranOnce = async (deps: Services): Promise<void> => {
    await beginTurn(deps.conversations, { conversationId: ID, prompt: "go", isolated: false, profile: { agent: "claude", harness: "native", account: "acct-a" }, byPerson: true }, T0);
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
    await beginTurn(deps.conversations, { conversationId: ID, prompt: "go", isolated: false, profile: { agent: "claude", harness: "native", account: "acct-a" }, byPerson: true }, T0);
    expect(await switchAccount(deps, { conversationId: ID, account: "acct-b" })).toEqual({ kind: "busy" });
    expect(deps.agents.entry(ID)?.profile.account).toBe("acct-a");
});

test("a held turn runs again at once on the account named, carried when asked", async () => {
    const pressed: unknown[] = [];
    const deps = {
        agents: unstubbed<Services["agents"]>("agents", { entry: () => conversationEntry({ id: ID }) }),
        conversations: unstubbed<Services["conversations"]>("conversations", {
            state: () => ({ resume: { held: { input: { conversationId: ID, prompt: "go", agent: "claude", harness: "native", account: "acct-a" }, reason: "limit", ran: true } } }) as never,
        }),
        turns: unstubbed<Services["turns"]>("turns", {
            resume: async (_id, byPerson, routing) => {
                pressed.push({ byPerson, routing });
                return { id: "run-2" } as never;
            },
        }),
    };
    expect(await switchAccount(deps, { conversationId: ID, account: "acct-b", carry: true })).toEqual({ kind: "moved", run: "run-2" });
    expect(pressed).toEqual([{ byPerson: true, routing: { agent: "claude", harness: "native", account: "acct-b", carry: true } }]);
});
