import { type Capability, type HostSummary, hostRunningSandbox } from "@intentic/sandbox-contract";
import { sandboxSlugOf } from "@intentic/sandbox-run";
import type { Services } from "../composition.js";
import { heldHostDevices } from "./device-reports.js";
import { hostSummaries } from "./host-peer.js";

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

// One environment of a machine that has several, as a turn needs to know it: the key `run_command`'s `in` takes, and
// what that side is.
export interface EnvironmentReach {
    /** The environment key: `native` for the metal, `wsl:<distro>` for a distro. */
    readonly key: string;
    /** WSL's own name for the distro; absent on the native side. */
    readonly distro?: string | undefined;
    readonly shell?: string | undefined;
    readonly home?: string | undefined;
}

// A machine with more than one OS install on it. ONE card, one tool prefix, one grant — what varies is which
// environment a command lands in, which is an argument rather than another device.
export interface MachineReach {
    /** The card: the machine's id, and the prefix every tool of it is named after. */
    readonly id: string;
    /** Native first, as the summary orders them. */
    readonly environments: readonly EnvironmentReach[];
}

// How far out of this container a turn can act: the devices whose servers it carries, which one runs this sandbox when
// that is already known, this container's slug out there, and which of those machines have more than one environment.
// `self` undefined means unread, never "no such machine".
export interface HostDeviceReach {
    readonly ids: readonly string[];
    readonly self?: string | undefined;
    readonly slug?: string | undefined;
    readonly machines?: readonly MachineReach[] | undefined;
}

// Only the machines a turn could get wrong: one environment is a machine whose every command lands in the only place
// it could. Limited to the granted ids, since a machine this turn cannot reach is not one to describe.
export const machineReach = (summaries: readonly HostSummary[], ids: readonly string[]): MachineReach[] =>
    summaries
        .filter((summary) => ids.includes(summary.id) && summary.environments.length > 1)
        .map((summary) => ({
            id: summary.id,
            environments: summary.environments.map((environment) => ({
                key: environment.key,
                distro: environment.facts?.wsl?.distro,
                shell: environment.facts?.shell,
                home: environment.facts?.home,
            })),
        }));

// One entry per granted host card, which is exactly the set `peerToolsOf("host", …)` mounts for the turn; undefined
// with no card at all, so a prompt composed from it says nothing rather than promising tools that aren't there.
export const hostDeviceReach = async (services: Services, granted: readonly Capability[]): Promise<HostDeviceReach | undefined> => {
    const ids = granted.filter((capability) => capability.kind === "host").map((capability) => capability.id);
    if (ids.length === 0) {
        return undefined;
    }
    const held = await heldHostDevices(services);
    const machines = machineReach(await hostSummaries(services), ids);
    return { ids, self: hostRunningSandbox(held, ownSlug(services)), slug: ownSlug(services), ...(machines.length === 0 ? {} : { machines }) };
};
