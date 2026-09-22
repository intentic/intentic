import { test, expect } from "bun:test";
import type { AgentsRegistry } from "./registry/agents-registry.js";
import type { AgentWorktrees } from "./worktrees/worktrees.js";
import { checks } from "./invariant.js";

/* The failure the user sees: a card at rest on the fleet board while the turn behind it spends the owner's allowance. */

const fail = (message: string): never => {
    throw new Error(message);
};

const NOW = 1_800_000_000_000;

const registryOf = (running: Readonly<Record<string, boolean>>): AgentsRegistry =>
    ({
        ids: () => Object.keys(running),
        running: (id: string) => running[id] === true,
    }) as unknown as AgentsRegistry;

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
const run = async (running: Readonly<Record<string, boolean>>, live: readonly { conversationId: string; startedAt: number }[]): Promise<void> => {
    const check = checkNamed("live-turns-are-running-on-the-board", {
        agents: registryOf(running),
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

test("a registry entry running with no live turn is deliberately not a finding here", async () => {
    // The mirror direction needs a stamp the registry does not keep, so it cannot be told apart from a turn one
    // tick from registering. Pinned so that a later change adding the stamp finds this waiting rather than
    // discovering the omission was accidental.
    await expect(run({ spinning: true }, [])).resolves.toBeUndefined();
});

/* The second failure: a checkout standing on a branch of its own, where the turn keeps writing and nothing reads. */

// Only `ids`, `entry` and the strayed list matter here; the composition is whatever the entry says it spans.
const fleetOf = (entries: Readonly<Record<string, { branch?: string; repos: readonly { repo: string }[] }>>): AgentsRegistry =>
    ({
        ids: () => Object.keys(entries),
        entry: (id: string) => entries[id],
    }) as unknown as AgentsRegistry;

const standingOff = (strayed: Readonly<Record<string, readonly { repo: string; branch?: string }[]>>): AgentWorktrees =>
    ({ elsewhere: async (id: string) => strayed[id] ?? [] }) as unknown as AgentWorktrees;

const runCheckouts = async (
    entries: Readonly<Record<string, { branch?: string; repos: readonly { repo: string }[] }>>,
    strayed: Readonly<Record<string, readonly { repo: string; branch?: string }[]>>,
): Promise<void> => {
    const check = checkNamed("checkouts-stand-on-their-own-branch", {
        agents: fleetOf(entries),
        agentWorktrees: standingOff(strayed),
        live: () => [],
        now: () => NOW,
    });
    await check.run({ moment: "turn-settled", fail });
};

const ONE_REPO = { branch: "agent/c1", repos: [{ repo: "registry" }] };

test("every checkout on its own branch reports nothing", async () => {
    await expect(runCheckouts({ c1: ONE_REPO }, {})).resolves.toBeUndefined();
});

test("a checkout left on a branch of its own is named, with the branch it stands on", async () => {
    await expect(runCheckouts({ c1: ONE_REPO }, { c1: [{ repo: "registry", branch: "ci/extension-admission" }] })).rejects.toThrow(
        /c1\/registry on ci\/extension-admission/,
    );
});

test("a detached HEAD is named as one: it is not a branch, so there is no name to print", async () => {
    await expect(runCheckouts({ c1: ONE_REPO }, { c1: [{ repo: "registry" }] })).rejects.toThrow(/c1\/registry on a detached HEAD/);
});

// A non-isolated conversation runs in the owner's own tree, which is on whatever branch the owner put it on. It has no
// branch of its own, so there is nothing for it to have strayed from.
test("a conversation with no branch of its own is not held to one", async () => {
    await expect(runCheckouts({ auto: { repos: [{ repo: "root" }] } }, { auto: [{ repo: "root", branch: "main" }] })).resolves.toBeUndefined();
});

test("the check runs at turn-settled, when a switch stops being transient, and on the sweep", () => {
    const check = checkNamed("checkouts-stand-on-their-own-branch", { agents: fleetOf({}), agentWorktrees: SETTLED });
    expect([...check.on].sort()).toEqual(["sweep", "turn-settled"]);
});
