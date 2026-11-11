import { CAPABILITY_CATALOG, contributionEntry, danglingConnections, instancesOf } from "@intentic/capability-catalog";
import { fieldApplies } from "@intentic/extension-manifest";
import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import { ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import { contributionRegistry, type ResolvedContribution } from "./contributions.js";

// An add whose answers name another connection (a field declaring `connection`: a disk's `via`, an identity's mailbox
// and exit) must name one that exists, of the kind the field asks for. The form only offers those; this is the same
// rule for every other caller (the agent's CLI, a script), whose typo would otherwise be stored as a reference to
// nothing and found only when the disk will not mount.

// The fields of the card a connection was added from: its contribution's (with the core fields its kind adds), else the
// built-in tile's.
const cardFields = (registry: ReadonlyMap<string, ResolvedContribution>, capability: Capability) => {
    const tiles = [...[...registry.values()].map((resolved) => contributionEntry(resolved.spec)), ...CAPABILITY_CATALOG];
    return tiles.find((tile) => instancesOf(tile, [capability]).length > 0)?.fields ?? [];
};

export const refuseDanglingConnections = async (services: Services, capability: Capability): Promise<void> => {
    const { config } = capability;
    const fields = cardFields(await contributionRegistry(services), capability);
    if (!fields.some((field) => field.connection !== undefined)) {
        return;
    }
    const refused = danglingConnections(fields, config, await services.capabilities.list(), (field) => fieldApplies(field, config));
    if (refused.length > 0) {
        throw new ORPCError("BAD_REQUEST", { message: `${refused.join("; ")}: pick one of the connections listed on its card, or leave it empty` });
    }
};
