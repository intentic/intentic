import type { Capability } from "@intentic/sandbox-contract";
import type { CapabilitiesStore } from "../capabilities/capabilities-store.js";

/* A TUNNEL is a capability the manifest stores and the machine either holds or does not: a VPN into somewhere of the user's (vpn/). */

export type TunnelKindName = "vpn" | "exit";

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
export const notCarriedYet = (missing: string, kind: TunnelKindName): Error =>
    new Error(
        `This sandbox doesn't carry ${missing} yet. Rebuild it from the Sandbox ▸ Environment card: the ${kind === "vpn" ? "VPN" : "exit"} capability's image fragment installs it, and ${
            kind === "vpn" ? "an auto-connect tunnel dials itself" : "an auto-start exit comes up"
        } once the sandbox restarts.`,
    );
