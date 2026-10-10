import type { ConversationActors } from "./actor/conversation-actors.js";
import type { AgentsRegistry } from "./registry/agents-registry.js";
import type { AgentWorktrees } from "./worktrees/worktrees.js";
import type { StrayStanding } from "./worktrees/stray-work.js";
import { checks } from "./invariant.js";
import { unstubbed } from "@intentic/testing";
import { conversationEntry, isolatedAgent } from "../testing.js";
import type { PersistedAgent } from "./registry/agents-store.js";
import { type HeldRecord, idleConversation } from "./actor/conversation-state.js";

/* The failure the user sees: a card at rest on the fleet board while the turn behind it spends the owner's allowance. */

const fail = (message: string): never => {
    throw new Error(message);
};

const NOW = 1_800_000_000_000;

const registryOf = (running: Readonly<Record<string, boolean>>): AgentsRegistry =>
    ({
        ids: () => Object.keys(running),
    }) as unknown as AgentsRegistry;

// Runs the actors hold are read only where `live` is not handed in, which every check here hands in. A conversation
// marked running entered that phase a minute before NOW unless `since` says otherwise.
const actorsOf = (
    running: Readonly<Record<string, boolean>>,
    since: Readonly<Record<string, number>> = {},
): Pick<ConversationActors, "running" | "holdings" | "state"> => ({
    holdings: unstubbed<ConversationActors>("conversations", {}).holdings,
    running: (id: string) => running[id] === true,
    state: (id: string) =>
        running[id] === true
            ? { ...idleConversation(), phase: { kind: "running", startedAt: since[id] ?? NOW - 60_000, parked: [], stopping: undefined } }
            : idleConversation(),
});

// Nothing strayed, for the checks that are not about checkouts.
const SETTLED = { elsewhere: async () => [] } as unknown as AgentWorktrees;

// By name, not by index: two checks share this owner, and picking position 0 would silently re-point every test here
// the next time one is added.
const checkNamed = (name: string, deps: Parameters<typeof checks>[0]) => {
    const found = checks(deps).find((check) => check.name === name);
    if (found === undefined) {
        throw new Error(`no check named ${name}`);
    }
    return found;
};

// `async` on purpose: this check is synchronous today, so a bare `Promise.resolve(check.run(...))` would let its
// throw escape the helper instead of rejecting, and would silently start passing if the check ever went async.
const run = async (
    running: Readonly<Record<string, boolean>>,
    live: readonly { conversationId: string; startedAt: number }[],
    since: Readonly<Record<string, number>> = {},
): Promise<void> => {
    const check = checkNamed("live-turns-are-running-on-the-board", {
        agents: registryOf(running),
        conversations: actorsOf(running, since),
        agentWorktrees: SETTLED,
        live: () => live,
        now: () => NOW,
    });
    await check.run({ moment: "sweep", fail });
};

test("the two records agreeing reports nothing", async () => {
    await expect(run({ c1: true }, [{ conversationId: "c1", startedAt: NOW - 60_000 }])).resolves.toBeUndefined();
});

test("a live turn the board shows as idle is named", async () => {
    await expect(run({ c1: false }, [{ conversationId: "c1", startedAt: NOW - 60_000 }])).rejects.toThrow(
        /read as not running on the fleet board.*c1/,
    );
});

test("a live turn the registry has no entry for at all is the louder finding", async () => {
    await expect(run({}, [{ conversationId: "ghost", startedAt: NOW - 60_000 }])).rejects.toThrow(/no entry for.*ghost/);
});

test("a turn younger than the grace is not yet due: begin may still be a tick away", async () => {
    await expect(run({}, [{ conversationId: "c1", startedAt: NOW - 1_000 }])).resolves.toBeUndefined();
});

// The mirror: a phase stuck at running answers every `begin` busy, so the conversation's queue never drains.
test("a conversation running on the board past the grace with no live turn behind it is named", async () => {
    await expect(run({ spinning: true }, [])).rejects.toThrow(/running on the fleet board with no live turn behind.*spinning/);
});

test("a conversation that entered running within the grace is not yet due: its run may be a tick from registering", async () => {
    await expect(run({ starting: true }, [], { starting: NOW - 1_000 })).resolves.toBeUndefined();
});

/* The second failure: work a turn committed on a branch of its own that its carry could not copy onto agent/<id>, the one
   branch review and land read. */

// Only `ids`, `entry` and the strayed list matter here; the composition is whatever the entry says it spans.
const fleetOf = (entries: Readonly<Record<string, PersistedAgent>>): AgentsRegistry =>
    ({
        ids: () => Object.keys(entries),
        entry: (id: string) => entries[id],
    }) as unknown as AgentsRegistry;

type Strayed = Readonly<Record<string, readonly StrayStanding[]>>;

const runCheckouts = async (entries: Readonly<Record<string, PersistedAgent>>, strayed: Strayed): Promise<void> => {
    const check = checkNamed("stray-work-reaches-its-own-branch", {
        agents: fleetOf(entries),
        conversations: actorsOf({}),
        agentWorktrees: SETTLED,
        live: () => [],
        now: () => NOW,
        strays: async (id) => strayed[id] ?? [],
    });
    await check.run({ moment: "turn-settled", fail });
};

const ONE_REPO = isolatedAgent([{ repo: "registry", base: "a".repeat(40) }]);

test("every checkout on its own branch reports nothing", async () => {
    await expect(runCheckouts({ c1: ONE_REPO }, {})).resolves.toBeUndefined();
});

// A CI branch to push, a pull request it was asked to work on: standing there is allowed, once what it wrote is carried.
test("a checkout on a branch of its own whose work is carried reports nothing, uncommitted edits or not", async () => {
    await expect(
        runCheckouts({ c1: ONE_REPO }, { c1: [{ repo: "registry", branch: "ci/extension-admission", carried: true, uncommitted: true }] }),
    ).resolves.toBeUndefined();
});

test("work its carry could not copy over is named, with the branch it stands on", async () => {
    await expect(
        runCheckouts({ c1: ONE_REPO }, { c1: [{ repo: "registry", branch: "ci/extension-admission", carried: false, uncommitted: false }] }),
    ).rejects.toThrow(/could not copy onto agent\/<id>.*: c1\/registry on ci\/extension-admission$/);
});

test("a detached HEAD is named as one: it is not a branch, so there is no name to print", async () => {
    await expect(runCheckouts({ c1: ONE_REPO }, { c1: [{ repo: "registry", carried: false, uncommitted: false }] })).rejects.toThrow(
        /c1\/registry on a detached HEAD$/,
    );
});

// A non-isolated conversation runs in the owner's own tree, which is on whatever branch the owner put it on. It has no
// branch of its own, so there is nothing for it to have strayed from.
test("a conversation with no branch of its own is not held to one", async () => {
    await expect(
        runCheckouts({ auto: conversationEntry({ id: "auto" }) }, { auto: [{ repo: "root", branch: "main", carried: false, uncommitted: false }] }),
    ).resolves.toBeUndefined();
});

test("the check runs at turn-settled, after the turn's carry, and on the sweep", () => {
    const check = checkNamed("stray-work-reaches-its-own-branch", { agents: fleetOf({}), conversations: actorsOf({}), agentWorktrees: SETTLED });
    expect([...check.on].sort()).toEqual(["sweep", "turn-settled"]);
});

// A spent allowance's hold the entry cannot keep lives only as long as the daemon; the check names it and the field the
// schema refused, and passes over every hold it can keep, every other hold and every fired one.
describe("held-limit-turns-are-kept-for-a-restart", () => {
    const files = (count: number): string[] => Array.from({ length: count }, (_, index) => `f${String(index)}.png`);
    const held = (attachments: number, over: Partial<HeldRecord> = {}): HeldRecord => ({
        input: { conversationId: "c1", prompt: "go", attachments: files(attachments) },
        reason: "limit",
        ran: true,
        reopensAt: 9_000,
        recordedAt: 1_000,
        fired: false,
        tries: 0,
        ...over,
    });
    const runWith = async (record: HeldRecord): Promise<void> => {
        const check = checkNamed("held-limit-turns-are-kept-for-a-restart", {
            agents: registryOf({ c1: false }),
            conversations: { ...actorsOf({}), state: () => ({ ...idleConversation(), resume: { ...idleConversation().resume, held: record } }) },
            agentWorktrees: SETTLED,
            live: () => [],
            now: () => NOW,
        });
        await check.run({ moment: "turn-settled", fail });
    };

    it("passes a hold the entry keeps, a hold of another wall, and a fired one", async () => {
        await runWith(held(20));
        await runWith(held(21, { reason: "stopped" }));
        await runWith(held(21, { fired: true }));
    });

    it("names a hold the schema refuses, and why", async () => {
        await expect(runWith(held(21))).rejects.toThrow(/c1 \(input\.attachments: /);
    });
});
