import { type Capability, type Device, hostRunningSandbox, machinesOf } from "@intentic/sandbox-contract";
import { sandboxSlugOf } from "@intentic/sandbox-run";
import type { Services } from "../composition.js";
import { heldHostDevices } from "./device-reports.js";

// The machine THIS sandbox runs on, when the owner has connected it as a device. Anything that has to happen out there
// — a container restart, an image swap, a script in the checkout the dev container was launched from — is then ours to
// run, and a command written out for the owner to paste is the fallback for a machine we cannot reach.

// Slug docker knows this container by, or undefined on a bare dev run with no container name in the env.
export const ownSlug = (services: Services): string | undefined => sandboxSlugOf(services.config.sandbox.name);

// The connected device running this sandbox, from readings already held: never forces a pull, so composing a turn or
// answering a route costs no round trip to a laptop that may be asleep. Undefined also when nothing has been read yet,
// so a caller must treat it as "not known to be reachable", not as "no such machine".
export const hostRunningSelf = async (services: Services): Promise<string | undefined> =>
    hostRunningSandbox(await heldHostDevices(services), ownSlug(services));

// One door onto a machine that has several: the tool prefix, and what that side is.
export interface DoorReach {
    readonly id: string;
    /** WSL's name for the distro; absent on the Windows side. */
    readonly distro?: string | undefined;
    readonly shell?: string | undefined;
    readonly home?: string | undefined;
}

// A PC connected through more than one door: Windows and the distros on it, each a device of its own to the tools.
export interface MachineReach {
    readonly label: string;
    /** Windows first, as `machinesOf` orders them. */
    readonly doors: readonly DoorReach[];
}

// How far out of this container a turn can act: the devices whose servers it carries, which one runs this sandbox when
// that is already known, this container's slug out there, and which of those devices are one computer. `self`
// undefined means unread, never "no such machine".
export interface HostDeviceReach {
    readonly ids: readonly string[];
    readonly self?: string | undefined;
    readonly slug?: string | undefined;
    readonly machines?: readonly MachineReach[] | undefined;
}

const doorOf = (device: Device): DoorReach[] =>
    device.hostId === undefined
        ? []
        : [
              {
                  id: device.hostId,
                  distro: (device.facts?.wsl ?? device.report?.wsl)?.distro,
                  shell: device.facts?.shell,
                  home: device.facts?.home,
              },
          ];

// Only the machines a turn could mistake for two: one door is one computer already. Limited to the granted ids, since
// a door this turn cannot open is not one to describe.
export const machineReach = (devices: readonly Device[], ids: readonly string[]): MachineReach[] =>
    machinesOf(devices.filter((device) => device.hostId !== undefined && ids.includes(device.hostId)))
        .map((machine) => ({ label: machine.label, doors: machine.environments.flatMap(doorOf) }))
        .filter((machine) => machine.doors.length > 1);

// One entry per granted host card, which is exactly the set `peerToolsOf("host", …)` mounts for the turn; undefined
// with no card at all, so a prompt composed from it says nothing rather than promising tools that aren't there.
export const hostDeviceReach = async (services: Services, granted: readonly Capability[]): Promise<HostDeviceReach | undefined> => {
    const ids = granted.filter((capability) => capability.kind === "host").map((capability) => capability.id);
    if (ids.length === 0) {
        return undefined;
    }
    const held = await heldHostDevices(services);
    const machines = machineReach(held, ids);
    return { ids, self: hostRunningSandbox(held, ownSlug(services)), slug: ownSlug(services), ...(machines.length === 0 ? {} : { machines }) };
};
