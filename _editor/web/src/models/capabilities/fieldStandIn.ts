import type { CapabilityCatalogEntry } from "@intentic/capability-catalog";
import type { CapabilityField } from "@intentic/extension-manifest";
import type { FormValues } from "./form";
import { signsIn } from "./googleConnect";
import { signsInWithMicrosoft } from "./signIn/microsoftSignIn";
import { generatesKey } from "./sshKey";

// A field the form answers by doing rather than typing, and what does it: a key the sandbox makes (an ssh tile's private
// key, or one a certificate request is made for), or a sign-in with the provider a field declares in `signIn` (Google
// through the platform's own OAuth client, Microsoft through the sandbox's device code). Undefined is a plain box.
export type StandIn = `sshKey` | `googleSignIn` | `microsoftSignIn` | `certificateRequest`;

export const standInOf = (entry: CapabilityCatalogEntry, field: CapabilityField, values: Readonly<FormValues>): StandIn | undefined => {
    if (generatesKey(entry, field, values)) {
        return `sshKey`;
    }
    // A key the sandbox makes with a certificate request for it (`keyRequest`), shown as the request.
    if (field.keyRequest !== undefined) {
        return `certificateRequest`;
    }
    if (signsIn(field, values)) {
        return `googleSignIn`;
    }
    return signsInWithMicrosoft(entry, field, values) ? `microsoftSignIn` : undefined;
};
