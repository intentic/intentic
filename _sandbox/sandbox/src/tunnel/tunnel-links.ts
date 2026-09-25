import { errorMessage } from "@intentic/base/errors";
import type { Capability, IntenticLine } from "@intentic/sandbox-contract";
import type { CapabilitiesStore } from "../capabilities/capabilities-store.js";
import { markUp } from "./tunnel-state.js";

/* A TUNNEL is a capability the manifest stores and the machine either holds or does not: a VPN into somewhere of the user's (vpn/), a geo exit (exit/), a mounted network disk (netdisk/). */

export type TunnelKindName = "vpn" | "exit" | "netdisk";

// A tunnel-kind capability, narrowed: the manifest is a discriminated union over `kind`, so this is the one
// cast the tunnel modules need and every driver can take its own config without re-checking.
export interface TunnelEntry<Config> {
    readonly id: string;
    readonly config: Config;
}

type ConfigOf<K extends TunnelKindName> = Extract<Capability, { readonly kind: K }>["config"];

export const tunnelEntries = <K extends TunnelKindName>(capabilities: readonly Capability[], kind: K): TunnelEntry<ConfigOf<K>>[] =>
    capabilities.flatMap((capability) => (capability.kind === kind ? [{ id: capability.id, config: capability.config as ConfigOf<K> }] : []));

export const tunnelEntry = async <K extends TunnelKindName>(
    capabilities: Pick<CapabilitiesStore, "get">,
    kind: K,
    id: string,
): Promise<TunnelEntry<ConfigOf<K>> | undefined> => {
    const capability = await capabilities.get(id);
    return capability === undefined || capability.kind !== kind ? undefined : { id: capability.id, config: capability.config as ConfigOf<K> };
};

// What a dial answers with when the client is not on PATH yet: the pre-rebuild state, in which the capability's
// own image fragment is what installs it, so the sentence points at the rebuild and says what comes back after.
const CARRIED_WORDING: Record<TunnelKindName, { readonly card: string; readonly comesBack: string }> = {
    vpn: { card: "VPN", comesBack: "an auto-connect tunnel dials itself" },
    exit: { card: "exit", comesBack: "an auto-start exit comes up" },
    netdisk: { card: "network disk", comesBack: "an auto-mount disk mounts itself" },
};

export const notCarriedYet = (missing: string, kind: TunnelKindName): Error =>
    new Error(
        `This sandbox doesn't carry ${missing} yet. Rebuild it from the Sandbox ▸ Environment card: the ${CARRIED_WORDING[kind].card} capability's image fragment installs it, and ${CARRIED_WORDING[kind].comesBack} once the sandbox restarts.`,
    );

// Brings one tunnel up: refused while its client isn't carried yet, and marked up only once the driver succeeded, so
// the marker never contradicts a probe.
export async function* tunnelUp(
    kind: TunnelKindName,
    missing: string | undefined,
    dial: () => AsyncGenerator<IntenticLine>,
    marker: { readonly dir: string; readonly path: string },
): AsyncGenerator<IntenticLine> {
    if (missing !== undefined) {
        throw notCarriedYet(missing, kind);
    }
    yield* dial();
    await markUp(marker.dir, marker.path);
}

export interface TunnelRestore<Config> {
    readonly automatic: (config: Config) => boolean;
    // Up or on its way up: nothing to restore.
    readonly isUp: (entry: TunnelEntry<Config>) => Promise<boolean>;
    readonly up: (entry: TunnelEntry<Config>) => AsyncGenerator<IntenticLine>;
    readonly words: { readonly done: string; readonly failed: string };
}

// Boot restore: tunnels die with the container while the manifest survives on /work, so every automatic one is brought
// back. Best-effort, one at a time: a tunnel that can't be read or dialled is logged and never strands the rest.
export const restoreTunnels = async <K extends TunnelKindName>(
    capabilities: CapabilitiesStore,
    logger: { info: (message: string) => void; warn: (message: string) => void },
    kind: K,
    restore: TunnelRestore<ConfigOf<K>>,
): Promise<void> => {
    for (const entry of tunnelEntries(await capabilities.list(), kind)) {
        if (!restore.automatic(entry.config)) {
            continue;
        }
        try {
            if (await restore.isUp(entry)) {
                continue;
            }
            for await (const line of restore.up(entry)) {
                void line;
            }
            logger.info(`${kind} ${entry.id}: ${restore.words.done}`);
        } catch (error) {
            logger.warn(`${kind} ${entry.id}: ${restore.words.failed}: ${errorMessage(error)}`);
        }
    }
};
