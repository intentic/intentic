import { type Device, hostRunningSandbox, type Machine, machinesOf } from "@intentic/sandbox-contract/schemas/devices";

// A MACHINE OF THE OWNER'S THAT A PRESS CAN REACH, through any of the owner's sandboxes rather than only the one open:
// a machine connected to a sibling, or to the sandbox the press is about (setup connects every sandbox to the machine
// it runs on), is as reachable as one connected here. Every screen that would otherwise print a command for that
// machine asks here first: the remove dialog, the recovery panel, the duplicate-copy notice, setup. Pure, so which
// sandbox carries a press is pinned by a test rather than by clicking through each screen.

/** One of the owner's sandboxes and the devices it reaches: a way to send a press to a machine. */
export interface DeviceRelay {
    readonly sandboxId: string;
    readonly devices: readonly Device[];
}

/** A connected, online door onto a machine, and the sandbox whose daemon carries a press through it. */
export interface MachineDoor {
    /** The sandbox whose daemon carries the call. */
    readonly relay: string;
    readonly hostId: string;
    /** The machine as that sandbox's Devices page addresses it. */
    readonly machineKey: string;
    readonly machineLabel: string;
    /** The relay is the sandbox the press acts on: its daemon dies mid-call, and that is the press landing. */
    readonly severs: boolean;
}

const machineOfDoor = (devices: readonly Device[], hostId: string): Machine | undefined =>
    machinesOf(devices).find((each) => each.environments.some((device) => device.hostId === hostId));

const doorThrough = (relay: DeviceRelay, hostId: string, affected: string | undefined): MachineDoor => {
    const machine = machineOfDoor(relay.devices, hostId);
    return {
        relay: relay.sandboxId,
        hostId,
        machineKey: machine?.key ?? hostId,
        machineLabel: machine?.label ?? hostId,
        severs: relay.sandboxId === affected,
    };
};

// A sandbox that outlives the press goes first, so the machine's own answer comes back to the screen; the one the press
// acts on carries it only when nothing else reaches that machine.
const outlivingFirst = (relays: readonly DeviceRelay[], affected: string | undefined): readonly DeviceRelay[] => [
    ...relays.filter((relay) => relay.sandboxId !== affected),
    ...relays.filter((relay) => relay.sandboxId === affected),
];

// The same computer seen through two sandboxes is one machine: by the id its doors said, else by its name.
const machineIdentity = (machine: Machine): string => machine.environments.find((device) => device.machineId !== undefined)?.machineId ?? machine.label;

/** The door onto the machine whose docker lists `slug`, or undefined while no relay reaches one. */
export const sandboxDoor = (relays: readonly DeviceRelay[], slug: string | undefined, affected: string | undefined): MachineDoor | undefined => {
    for (const relay of outlivingFirst(relays, affected)) {
        const hostId = hostRunningSandbox(relay.devices, slug);
        if (hostId !== undefined) {
            return doorThrough(relay, hostId, affected);
        }
    }
    return undefined;
};

/**
 * Every machine whose docker lists `slug`, once each: two copies of one sandbox on two computers is a fault only a
 * person can settle, by saying which copy goes.
 */
export const doorsHolding = (relays: readonly DeviceRelay[], slug: string | undefined, affected: string | undefined): readonly MachineDoor[] => {
    if (slug === undefined || slug === ``) {
        return [];
    }
    const seen = new Map<string, MachineDoor>();
    for (const relay of outlivingFirst(relays, affected)) {
        for (const machine of machinesOf(relay.devices)) {
            const identity = machineIdentity(machine);
            const hostId = seen.has(identity) ? undefined : hostRunningSandbox(machine.environments, slug);
            if (hostId !== undefined) {
                seen.set(identity, doorThrough(relay, hostId, affected));
            }
        }
    }
    return [...seen.values()];
};

/**
 * The machines that answered with the containers they hold, by name, once each: where "it isn't there" is a reading
 * rather than a guess. A machine that is offline, or whose sandbox switch is off, looked at nothing and is left out.
 */
export const machinesLooked = (relays: readonly DeviceRelay[]): readonly string[] => [
    ...new Set(
        relays.flatMap((relay) =>
            machinesOf(relay.devices)
                .filter((machine) => machine.environments.some(listed))
                .map((machine) => machine.label),
        ),
    ),
];

// Online and listed what its docker holds: proof that `ic` and an engine answer on that side, which a new sandbox needs.
const listed = (device: Device): boolean => device.hostId !== undefined && device.online === true && device.sandboxes !== undefined;

// How many of the containers this side lists are its own to keep (`keptElsewhere` names the other side that keeps one).
const keeps = (device: Device): number => (device.sandboxes ?? []).filter((box) => box.keptElsewhere === undefined).length;

// WHICH SIDE OF A PC A NEW SANDBOX IS MADE FROM. Windows and its WSL distros drive one engine, but only the side whose
// `ic` created a sandbox runs its background rounds; so the side already keeping the owner's sandboxes there is the
// one to add to. With none kept yet, a Linux side over Windows, as the owner's own sandboxes on such a PC live there.
const setupSide = (environments: readonly Device[]): Device | undefined =>
    environments
        .filter(listed)
        .toSorted((left, right) => keeps(right) - keeps(left) || Number(left.platform === `windows`) - Number(right.platform === `windows`))[0];

/** One door per machine a new sandbox could be brought up on now, through the first relay that reaches it. */
export const setupDoors = (relays: readonly DeviceRelay[]): readonly MachineDoor[] => {
    const seen = new Map<string, MachineDoor>();
    for (const relay of relays) {
        for (const machine of machinesOf(relay.devices)) {
            const identity = machineIdentity(machine);
            const side = seen.has(identity) ? undefined : setupSide(machine.environments);
            if (side?.hostId !== undefined) {
                seen.set(identity, { relay: relay.sandboxId, hostId: side.hostId, machineKey: machine.key, machineLabel: machine.label, severs: false });
            }
        }
    }
    return [...seen.values()];
};
