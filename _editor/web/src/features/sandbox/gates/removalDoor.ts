import { type Device, hostRunningSandbox, machinesOf } from "@intentic/sandbox-contract";

// WHERE A REMOVED SANDBOX'S CONTAINER CAN BE DELETED WITH A PRESS rather than a command typed out there. Any of the
// owner's sandboxes can carry the call, not only the one open: a machine connected to a sibling, or to the sandbox
// being removed (setup connects every sandbox to the machine it runs on), is as reachable as one connected here.
// Pure, so which sandbox carries it is pinned by a test rather than by clicking through the dialog.

/** One of the owner's sandboxes and the devices it reaches: a way to send a removal to a machine. */
export interface RemovalRelay {
    readonly sandboxId: string;
    readonly devices: readonly Device[];
}

/** A connected machine whose docker holds the container, and the sandbox that reaches it. */
export interface RemovalDoor {
    /** The sandbox whose daemon carries the call. */
    readonly relay: string;
    readonly hostId: string;
    /** The machine as that sandbox's Devices page addresses it. */
    readonly machineKey: string;
    readonly machineLabel: string;
    /** The relay is the sandbox being removed: its daemon dies mid-call, and that is the removal landing. */
    readonly severs: boolean;
}

/**
 * The first relay whose online device lists `slug`. A sandbox that outlives the removal goes first, so the machine's own
 * answer comes back to the dialog; the sandbox being removed carries it only when nothing else reaches that machine.
 */
export const removalDoor = (relays: readonly RemovalRelay[], slug: string | undefined, removing: string): RemovalDoor | undefined => {
    const ordered = [...relays.filter((relay) => relay.sandboxId !== removing), ...relays.filter((relay) => relay.sandboxId === removing)];
    for (const relay of ordered) {
        const hostId = hostRunningSandbox(relay.devices, slug);
        if (hostId === undefined) {
            continue;
        }
        const machine = machinesOf(relay.devices).find((each) => each.environments.some((device) => device.hostId === hostId));
        return {
            relay: relay.sandboxId,
            hostId,
            machineKey: machine?.key ?? hostId,
            machineLabel: machine?.label ?? hostId,
            severs: relay.sandboxId === removing,
        };
    }
    return undefined;
};

/**
 * The machines that answered with the containers they hold, by name, once each: where "it isn't there" is a reading
 * rather than a guess. A machine that is offline, or whose sandbox switch is off, looked at nothing and is left out.
 */
export const machinesLooked = (relays: readonly RemovalRelay[]): readonly string[] => [
    ...new Set(
        relays.flatMap((relay) =>
            machinesOf(relay.devices)
                .filter((machine) => machine.environments.some((device) => device.online === true && device.sandboxes !== undefined))
                .map((machine) => machine.label),
        ),
    ),
];
