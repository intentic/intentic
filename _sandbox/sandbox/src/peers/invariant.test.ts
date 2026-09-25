import type { Capability, CapabilityKind } from "@intentic/sandbox-contract";
import { HOST_CARD_RULE } from "../hosts/host-peer.js";
import { checks, type PeerRegistryDeps } from "./invariant.js";

/* Revocation is two calls, one on each record, and the one that matters for safety is the second. */

const fail = (message: string): never => {
    throw new Error(message);
};

// Records as the hosts door writes them (card, environment and a derived machine id, read off the id once at pairing);
// a browser's card is its id, which the same rule answers for an id with no environment.
const door = (enrolled: readonly string[], connected: readonly string[]) => ({
    store: { list: async () => enrolled.map((id) => ({ id, ...HOST_CARD_RULE.pairing(id) })) },
    hub: { connected: () => connected },
});

// Only id and kind are read; the config each kind carries is another check's subject.
const card = (id: string, kind: CapabilityKind): Capability => ({ id, kind, config: {} }) as unknown as Capability;

// Which door each check reads, so one fixture can be pointed at any of them and the others stay empty.
const DOORS: Record<string, "hosts" | "webexts" | "runners"> = {
    "live-hosts-are-enrolled": "hosts",
    "enrolled-devices-have-cards": "hosts",
    "live-browsers-are-enrolled": "webexts",
    "enrolled-browsers-have-cards": "webexts",
    "live-runners-are-enrolled": "runners",
    "one-card-per-machine-environment": "hosts",
};

// `cards` defaults to the enrolled ids, so a test about live sockets never trips the grant checks by accident.
const run = async (
    name: string,
    enrolled: readonly string[],
    connected: readonly string[],
    cards: readonly Capability[] = enrolled.flatMap((id) => [card(id, "device"), card(id, "webext")]),
): Promise<void> => {
    const quiet = door([], []);
    const under = door(enrolled, connected);
    const at = (which: string) => (DOORS[name] === which ? under : quiet);
    const deps: PeerRegistryDeps = {
        hosts: at("hosts").store,
        hostHub: at("hosts").hub,
        webexts: at("webexts").store,
        webextHub: at("webexts").hub,
        runners: at("runners").store,
        runnerHub: at("runners").hub,
        capabilities: { list: async () => [...cards] },
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
    await expect(run("live-browsers-are-enrolled", ["my-chrome"], ["old-chrome", "my-chrome"])).rejects.toThrow(
        /does not hold \(old-chrome\).*browser the owner disconnected/,
    );
    await expect(run("live-runners-are-enrolled", ["laptop"], ["rig", "laptop"])).rejects.toThrow(/does not hold \(rig\).*revoked runner/);
    await expect(run("live-hosts-are-enrolled", [], ["ghost"])).rejects.toThrow(/does not hold \(ghost\).*device the owner disconnected/);
});

test("the three doors are checked independently: one door's stray is not another's", async () => {
    await expect(run("live-hosts-are-enrolled", ["laptop"], ["laptop"])).resolves.toBeUndefined();
});

test("an enrollment every card still holds reports nothing, connected or not", async () => {
    await expect(run("enrolled-devices-have-cards", ["laptop", "rig"], [])).resolves.toBeUndefined();
    await expect(run("enrolled-browsers-have-cards", ["my-chrome"], ["my-chrome"])).resolves.toBeUndefined();
});

test("an enrollment no card holds is named, since nothing on either screen would list it", async () => {
    await expect(run("enrolled-devices-have-cards", ["laptop", "ghost"], [], [card("laptop", "device")])).rejects.toThrow(
        /no capability card \(ghost\).*no screen lists/,
    );
    await expect(run("enrolled-browsers-have-cards", ["old-chrome"], [], [])).rejects.toThrow(/no capability card \(old-chrome\)/);
});

// One card is one computer; its WSL distros enroll as `<card>::wsl:<distro>` and are withdrawn with the card.
test("a machine's other OS installs are held by the machine's card, and named when the machine has none", async () => {
    await expect(run("enrolled-devices-have-cards", ["rig", "rig::wsl:archlinux"], [], [card("rig", "device")])).resolves.toBeUndefined();
    await expect(run("enrolled-devices-have-cards", ["rig", "gone::wsl:Ubuntu-22.04"], [], [card("rig", "device")])).rejects.toThrow(
        /1 enrollment\(s\) are held by no capability card \(gone::wsl:Ubuntu-22\.04\)/,
    );
});

test("a card of another kind is not a grant: same name, different door", async () => {
    await expect(run("enrolled-devices-have-cards", ["laptop"], [], [card("laptop", "webext")])).rejects.toThrow(/\(laptop\)/);
});

// ONE OS INSTALL, ONE CARD. Two cards over the same computer's same install are two grants over one agent; only ids
// the agents said count, since a derived id is its own card's by construction.
test("names a machine environment enrolled under two cards, and nothing when each card has its own", async () => {
    const identity = { listing: [] as { id: string; card: string; environment: string; machineId: string }[] };
    const deps = (): PeerRegistryDeps => ({
        hosts: { list: async () => identity.listing },
        hostHub: { connected: () => [] },
        webexts: { list: async () => [] },
        webextHub: { connected: () => [] },
        runners: { list: async () => [] },
        runnerHub: { connected: () => [] },
        capabilities: { list: async () => [] },
    });
    const check = checks(deps()).find((entry) => entry.name === "one-card-per-machine-environment");
    identity.listing = [
        { id: "rog", card: "rog", environment: "native", machineId: "m-rog-0123456789" },
        { id: "rog::wsl:Arch", card: "rog", environment: "wsl:Arch", machineId: "m-rog-0123456789" },
        { id: "omen", card: "omen", environment: "native", machineId: "card:omen" },
        { id: "radarsu-omen", card: "radarsu-omen", environment: "native", machineId: "card:radarsu-omen" },
    ];
    await expect(check?.run({ moment: "sweep", fail })).resolves.toBeUndefined();
    identity.listing.push({ id: "radarsu-rog", card: "radarsu-rog", environment: "native", machineId: "m-rog-0123456789" });
    await expect(check?.run({ moment: "sweep", fail })).rejects.toThrow(
        "1 machine environment(s) are enrolled under more than one card (native of machine m-rog-0123456789 under radarsu-rog and rog): two grants over one agent, whose switches can disagree",
    );
});
