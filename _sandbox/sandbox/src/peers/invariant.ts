import type { CapabilityKind } from "@intentic/sandbox-contract";
import type { CapabilitiesStore } from "../capabilities/capabilities-store.js";
import type { InvariantCheck } from "../invariants/invariants.js";
import type { PeerHub } from "./peer-hub.js";
import type { PeerStore } from "./peer-store.js";

// A live socket the enrollment store no longer holds is a peer the owner removed or renamed, still reachable under its
// old id: revocation is two uncoordinated calls (store forgets, hub disconnects), and skipping or reordering either
// leaves it live until its next reconnect is refused. The drift the other way is quieter and worse: an enrollment no
// card holds is a credential no screen lists, since both screens draw machines from the manifest.

type Roster = Pick<PeerStore<unknown>, "list">;
type Sockets = Pick<PeerHub<never, unknown, unknown, unknown>, "connected">;

export interface PeerRegistryDeps {
    readonly hosts: Roster;
    readonly hostHub: Sockets;
    readonly webexts: Roster;
    readonly webextHub: Sockets;
    readonly runners: Roster;
    readonly runnerHub: Sockets;
    // What the owner has actually granted; a runner has no card, so only the two gated doors are judged against it.
    readonly capabilities: Pick<CapabilitiesStore, "list">;
}

export const owner = "peers";

// One check per door, over the same rule: every live socket is one the store still holds.
const registryCheck = (name: string, store: Roster, hub: Sockets, stakes: string): InvariantCheck => ({
    name,
    // Not `boot`: the hub is empty then by construction, a socket does not survive a restart.
    on: ["sweep"],
    run: async ({ fail }) => {
        const connected = hub.connected();
        if (connected.length === 0) {
            return;
        }
        const enrolled = new Set((await store.list()).map((peer) => peer.id));
        const strays = connected.filter((id) => !enrolled.has(id));
        if (strays.length > 0) {
            fail(`${strays.length} socket(s) are live for ids the enrollment store does not hold (${strays.join(", ")}): ${stakes}`);
        }
    },
});

// The same rule for the doors whose grant is a capability card: nothing is enrolled that no card holds. Boot too, since
// the manifest is a workspace file a checkout or a land can rewrite while the daemon is not looking.
const grantCheck = (name: string, store: Roster, cards: Pick<CapabilitiesStore, "list">, kind: CapabilityKind, stakes: string): InvariantCheck => ({
    name,
    on: ["boot", "sweep"],
    run: async ({ fail }) => {
        const enrolled = await store.list();
        if (enrolled.length === 0) {
            return;
        }
        const granted = new Set((await cards.list()).flatMap((capability) => (capability.kind === kind ? [capability.id] : [])));
        const orphans = enrolled.flatMap((peer) => (granted.has(peer.id) ? [] : [peer.id]));
        if (orphans.length > 0) {
            fail(`${orphans.length} enrollment(s) are held by no capability card (${orphans.join(", ")}): ${stakes}`);
        }
    },
});

export const checks = (deps: PeerRegistryDeps): readonly InvariantCheck[] => [
    registryCheck("live-hosts-are-enrolled", deps.hosts, deps.hostHub, "a device the owner disconnected that the agent can still drive"),
    registryCheck("live-browsers-are-enrolled", deps.webexts, deps.webextHub, "a browser the owner disconnected that the agent can still drive"),
    registryCheck("live-runners-are-enrolled", deps.runners, deps.runnerHub, "a revoked runner still receiving this sandbox's turns and credentials"),
    grantCheck(
        "enrolled-devices-have-cards",
        deps.hosts,
        deps.capabilities,
        "device",
        "a key into this sandbox that no screen lists and no button can withdraw",
    ),
    grantCheck(
        "enrolled-browsers-have-cards",
        deps.webexts,
        deps.capabilities,
        "webext",
        "a browser extension still paired to a sandbox whose card for it is gone",
    ),
];
