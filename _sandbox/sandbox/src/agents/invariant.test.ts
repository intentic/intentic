import { expect, test } from "vitest";
import type { AgentsRegistry } from "./agents-registry.js";
import { checks } from "./invariant.js";

/* The failure the user sees: a card at rest on the fleet board while the turn behind it spends the owner's
 * allowance. The turn path and the registry each keep their own record of "running", and nothing reconciles
 * them: a begin that did not happen leaves the two describing different worlds. */

const fail = (message: string): never => {
    throw new Error(message);
};

const NOW = 1_800_000_000_000;

const registryOf = (running: Readonly<Record<string, boolean>>): AgentsRegistry =>
    ({
        ids: () => Object.keys(running),
        running: (id: string) => running[id] === true,
    }) as unknown as AgentsRegistry;

// `async` on purpose: this check is synchronous today, so a bare `Promise.resolve(check.run(...))` would let its
// throw escape the helper instead of rejecting, and would silently start passing if the check ever went async.
const run = async (running: Readonly<Record<string, boolean>>, live: readonly { conversationId: string; startedAt: number }[]): Promise<void> => {
    const [check] = checks({ agents: registryOf(running), live: () => live, now: () => NOW });
    await check?.run({ moment: "sweep", fail });
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
