import { expect, test } from "vitest";
import { checks } from "./invariant.js";
import type { RunnerHub } from "./runner-hub.js";
import type { RunnersStore } from "./runners-store.js";

/* Revocation is two calls, one on each record, and the one that matters for safety is the second: a socket
 * the store has forgotten is a runner that still receives work. */

const fail = (message: string): never => {
    throw new Error(message);
};

const run = async (enrolled: readonly string[], connected: readonly string[]): Promise<void> => {
    const runners = { list: async () => enrolled.map((id) => ({ id })) } as unknown as RunnersStore;
    const runnerHub = { connected: () => connected } as unknown as RunnerHub;
    const [check] = checks({ runners, runnerHub });
    await check?.run({ moment: "sweep", fail });
};

test("every live socket belonging to an enrolled runner reports nothing", async () => {
    await expect(run(["rig", "laptop"], ["rig"])).resolves.toBeUndefined();
});

test("an enrolled runner that is offline is ordinary", async () => {
    await expect(run(["rig"], [])).resolves.toBeUndefined();
});

test("a socket the store no longer vouches for is named as a revoked runner still receiving work", async () => {
    await expect(run(["laptop"], ["rig", "laptop"])).rejects.toThrow(/does not hold \(rig\).*revoked runner/);
});
