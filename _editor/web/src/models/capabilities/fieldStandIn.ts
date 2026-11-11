import type { CapabilityCatalogEntry } from "@intentic/capability-catalog";
import type { CapabilityField } from "@intentic/extension-manifest";
import type { FormValues } from "./form";
import { signsIn } from "./googleConnect";
import { generatesKey } from "./sshKey";

// A field the form answers by doing rather than typing, and what does it: a key the sandbox makes (an ssh tile's private
// key), or a sign-in through the platform's own OAuth client (a field declaring `signIn`). Undefined is a plain box.
export type StandIn = `sshKey` | `googleSignIn`;

export const standInOf = (entry: CapabilityCatalogEntry, field: CapabilityField, values: Readonly<FormValues>): StandIn | undefined => {
    if (generatesKey(entry, field, values)) {
        return `sshKey`;
    }
    return signsIn(field, values) ? `googleSignIn` : undefined;
};
