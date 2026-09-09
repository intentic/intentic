import { type Capability, hostRunningSandbox } from "@intentic/sandbox-contract";
import { sandboxSlugOf } from "@intentic/sandbox-run";
import type { Services } from "../composition.js";
import { heldHostDevices } from "./device-reports.js";

// The machine THIS sandbox runs on, when the owner has connected it as a device. Anything that has to happen out there
// — a container restart, an image swap, a script in the checkout the dev container was launched from — is then ours to
// run, and a command written out for the owner to paste is the fallback for a machine we cannot reach.

// Slug docker knows this container by, or undefined on a bare dev run with no container name in the env.
export const ownSlug = (services: Services): string | undefined => sandboxSlugOf(services.config.sandbox.name);

// The checkout a dev container was launched from, as a path on the HOST, not in here (SANDBOX_DEV_ROOT, set by
// dev-sandbox.sh). Empty on every non-dev sandbox, which is what makes a dev-only action refuse itself.
export const devRoot = (services: Services): string | undefined => {
    const root = services.config.sandbox.devRoot.trim();
    return root === "" ? undefined : root;
};

// The connected device running this sandbox, from readings already held: never forces a pull, so composing a turn or
// answering a route costs no round trip to a laptop that may be asleep. Undefined also when nothing has been read yet,
// so a caller must treat it as "not known to be reachable", not as "no such machine".
export const hostRunningSelf = async (services: Services): Promise<string | undefined> =>
    hostRunningSandbox(await heldHostDevices(services), ownSlug(services));

// How far out of this container a turn can act: the devices whose servers it carries, which one runs this sandbox when
// that is already known, and this container's slug out there. `self` undefined means unread, never "no such machine".
export interface HostDeviceReach {
    readonly ids: readonly string[];
    readonly self?: string | undefined;
    readonly slug?: string | undefined;
}

// One entry per granted host card, which is exactly the set `peerToolsOf("host", …)` mounts for the turn; undefined
// with no card at all, so a prompt composed from it says nothing rather than promising tools that aren't there.
export const hostDeviceReach = async (services: Services, granted: readonly Capability[]): Promise<HostDeviceReach | undefined> => {
    const ids = granted.filter((capability) => capability.kind === "host").map((capability) => capability.id);
    return ids.length === 0 ? undefined : { ids, self: await hostRunningSelf(services), slug: ownSlug(services) };
};
