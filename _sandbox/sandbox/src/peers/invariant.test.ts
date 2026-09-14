import { expect, test } from "vitest";
import { checks, type PeerRegistryDeps } from "./invariant.js";

/* Revocation is two calls, one on each record, and the one that matters for safety is the second. */

const fail = (message: string): never => {
    throw new Error(message);
};

const door = (enrolled: readonly string[], connected: readonly string[]) => ({
    store: { list: async () => enrolled.map((id) => ({ id })) },
    hub: { connected: () => connected },
});

const run = async (name: string, enrolled: readonly string[], connected: readonly string[]): Promise<void> => {
    const quiet = door([], []);
    const under = door(enrolled, connected);
    const deps: PeerRegistryDeps = {
        hosts: name === "live-hosts-are-enrolled" ? under.store : quiet.store,
        hostHub: name === "live-hosts-are-enrolled" ? under.hub : quiet.hub,
        webexts: name === "live-browsers-are-enrolled" ? under.store : quiet.store,
        webextHub: name === "live-browsers-are-enrolled" ? under.hub : quiet.hub,
        runners: name === "live-runners-are-enrolled" ? under.store : quiet.store,
        runnerHub: name === "live-runners-are-enrolled" ? under.hub : quiet.hub,
    };
    const check = checks(deps).find((entry) => entry.name === name);
    if (check === undefined) {
        throw new Error(`no check named ${name}`);
    }
    await check.run({ moment: "sweep", fail });
};

test("every live socket belonging to an enrolled peer reports nothing, and an offline enrolled peer is ordinary", async () => {
    await expect(run("live-hosts-are-enrolled", ["laptop", "rig"], ["laptop"])).resolves.toBeUndefined();
    await expect(run("live-runners-are-enrolled", ["rig"], [])).resolves.toBeUndefined();
});

test("a socket the store no longer vouches for is named, with the door's own stakes", async () => {
    await expect(run("live-browsers-are-enrolled", ["my-chrome"], ["old-chrome", "my-chrome"])).rejects.toThrow(/does not hold \(old-chrome\).*browser the owner disconnected/);
    await expect(run("live-runners-are-enrolled", ["laptop"], ["rig", "laptop"])).rejects.toThrow(/does not hold \(rig\).*revoked runner/);
    await expect(run("live-hosts-are-enrolled", [], ["ghost"])).rejects.toThrow(/does not hold \(ghost\).*device the owner disconnected/);
});

test("the three doors are checked independently: one door's stray is not another's", async () => {
    await expect(run("live-hosts-are-enrolled", ["laptop"], ["laptop"])).resolves.toBeUndefined();
});
