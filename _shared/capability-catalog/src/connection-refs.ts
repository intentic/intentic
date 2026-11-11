import type { CapabilityField, ConnectionRef } from "@intentic/extension-manifest";
import type { CapabilityInstanceLike } from "./index.js";

// A field that names another of the owner's connections (`connection` on the field): which connections it may name, and
// which of a config's names name nothing. The web lists the first as the field's picker; the daemon refuses the second
// on add, so a name typed through the CLI cannot mint a reference to nothing either.

// Whether a connection is one a reference may name: its kind, and for a kind several cards share, the card it was added
// from (a cli card's `provider`, a site's `platform`).
export const refersTo = (ref: ConnectionRef, capability: CapabilityInstanceLike): boolean =>
    capability.kind === ref.kind &&
    (ref.provider === undefined || capability.config["provider"] === ref.provider || capability.config["platform"] === ref.provider);

// The names a reference may take, in the order the connections are listed.
export const connectionChoices = <T extends CapabilityInstanceLike & { readonly id: string }>(ref: ConnectionRef, capabilities: readonly T[]): string[] =>
    capabilities.filter((capability) => refersTo(ref, capability)).map((capability) => capability.id);

// Every answered reference in a config that names no connection it may name, as a sentence for the person who sent it.
// A field `when` has gated out is not looked at: its value is not in play.
export const danglingConnections = <T extends CapabilityInstanceLike & { readonly id: string }>(
    fields: readonly CapabilityField[],
    config: CapabilityInstanceLike["config"],
    capabilities: readonly T[],
    applies: (field: CapabilityField) => boolean,
): string[] => {
    const refused: string[] = [];
    for (const field of fields) {
        const value = config[field.key];
        if (field.connection === undefined || value === undefined || value === "" || !applies(field)) {
            continue;
        }
        if (!connectionChoices(field.connection, capabilities).includes(String(value))) {
            const what = field.connection.provider === undefined ? field.connection.kind : `${field.connection.kind} (${field.connection.provider})`;
            refused.push(`"${field.label}" names "${String(value)}", which is not a ${what} connection here`);
        }
    }
    return refused;
};
