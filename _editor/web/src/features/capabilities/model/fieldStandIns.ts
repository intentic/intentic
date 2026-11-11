import type { CapabilityCatalogEntry } from "@intentic/capability-catalog";
import type { CapabilityField } from "@intentic/extension-manifest";
import type { CapabilitySummary } from "@intentic/sandbox-contract/schemas/capabilities";
import { reactive, type Ref } from "vue";
import { type StandIn, standInOf } from "../../../models/capabilities/fieldStandIn";
import type { FormValues, StoredSecrets } from "../../../models/capabilities/form";
import { signsInToMcp, useMcpAuth } from "../../../models/capabilities/signIn/mcpSignIn";
import { readsWithConnection } from "./gitConnection";

// WHICH ROW STANDS IN FOR A FIELD'S BOX on the capability form (FieldStandIn.vue), and everything that row is handed: the
// GitHub or GitLab card a private repository is read with, a key or a sign-in the field declares (fieldStandIn.ts), or
// an MCP server's own OAuth sign-in, which only the address typed so far can tell (mcpSignIn.ts). Undefined: a plain box.

export type FormStandIn = StandIn | `gitConnection` | `mcpSignIn`;

export interface StandInContext {
    readonly selected: Ref<CapabilityCatalogEntry | undefined>;
    readonly editing: Ref<CapabilitySummary | undefined>;
    readonly values: FormValues;
    readonly kept: Ref<StoredSecrets>;
    readonly alarm: (field: CapabilityField) => string | undefined;
}

export const useFieldStandIns = ({ selected, editing, values, kept, alarm }: StandInContext) => {
    // What an MCP tile's address asks of a client, read as it is typed: a sign-in turns its token box into a button.
    const mcpAuth = reactive(useMcpAuth(() => (selected.value?.kind === `mcp` ? values[`url`] : undefined)));

    const kindOf = (tile: CapabilityCatalogEntry, field: CapabilityField): FormStandIn | undefined => {
        if (readsWithConnection(tile, field)) {
            return `gitConnection`;
        }
        return standInOf(tile, field, values) ?? (signsInToMcp(tile, field, mcpAuth, editing.value) ? `mcpSignIn` : undefined);
    };

    /** The stand-in row's props for a field of the selected tile, or undefined for a plain box. */
    const of = (field: CapabilityField) => {
        const tile = selected.value;
        const kind = tile === undefined ? undefined : kindOf(tile, field);
        return tile === undefined || kind === undefined
            ? undefined
            : { kind, tile, field, values, instance: editing.value, mcpCheck: mcpAuth.check, kept: kept.value, alarm: alarm(field) };
    };

    // "Paste a token instead" on an MCP sign-in: the box comes back until the address changes.
    const paste = (): void => {
        mcpAuth.pasting = true;
    };

    return { of, paste };
};
