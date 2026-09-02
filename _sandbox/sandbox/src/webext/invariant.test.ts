import { expect, test } from "vitest";
import { checks } from "./invariant.js";
import type { WebExtHub } from "./webext-hub.js";
import type { WebExtStore } from "./webext-store.js";

const fail = (message: string): never => {
    throw new Error(message);
};

const run = async (enrolled: readonly string[], connected: readonly string[]): Promise<void> => {
    const webexts = { enrolled: async (id: string) => enrolled.includes(id) } as unknown as WebExtStore;
    const webextHub = { connected: () => connected } as unknown as WebExtHub;
    const [check] = checks({ webexts, webextHub });
    await check?.run({ moment: "sweep", fail });
};

test("every live socket belonging to an enrolled browser reports nothing", async () => {
    await expect(run(["my-chrome"], ["my-chrome"])).resolves.toBeUndefined();
});

test("a socket the store no longer vouches for is named as a browser the agent can still drive", async () => {
    // The rename handler and the revoke route each disconnect the hub beside the store write; this is what a
    // caller that forgot the second half looks like from the outside.
    await expect(run(["my-chrome"], ["old-chrome", "my-chrome"])).rejects.toThrow(/does not hold \(old-chrome\).*still drive/);
});
