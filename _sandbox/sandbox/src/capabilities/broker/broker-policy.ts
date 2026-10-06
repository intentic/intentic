import { type BrokerRule, BrokerRuleSchema } from "@intentic/extension-manifest";
import { z } from "zod";
import { defineDocument } from "../../store/evolution/documents.js";
import { openDocument } from "../../store/open-document.js";

// The owner's own say over how one card's credential is used, kept off the workspace beside the vault (mode 0600), since
// `.intentic/config/` is agent-editable and a turn must not loosen its own rules:
// - `rules` replace the connector's method and path rules whole; present and empty lifts them entirely.
// - `delivery: "raw"` hands the agent the credential itself instead of a gateway address, for a tool that cannot work
//   without the real value. It is the owner's explicit choice, shown as such, and the gateway's checks no longer apply
//   to what the agent does with it.

export const CredentialDeliverySchema = z.enum(["gateway", "raw"]);
export type CredentialDelivery = z.infer<typeof CredentialDeliverySchema>;

export const credentialPolicyDocument = defineDocument({
    root: "auth",
    path: "credential-policy.json",
    schema: z.object({ rules: z.array(BrokerRuleSchema).optional(), delivery: CredentialDeliverySchema.optional() }),
    granularity: "record",
});

export interface CardPolicy {
    readonly rules?: readonly BrokerRule[] | undefined;
    readonly delivery?: CredentialDelivery | undefined;
}

export interface CredentialPolicyStore {
    // The owner's setting for one card; an empty object where none was written. Throws when the file exists but cannot be
    // read: reading that as "nothing set" would hand back a connector's looser defaults, or a raw credential.
    readonly of: (capability: string) => Promise<CardPolicy>;
    readonly setRules: (capability: string, rules: readonly BrokerRule[] | undefined) => Promise<void>;
    readonly setDelivery: (capability: string, delivery: CredentialDelivery) => Promise<void>;
    // A card's removal takes its policy with it, so a later card reusing the id inherits nothing.
    readonly forget: (capability: string) => Promise<void>;
}

interface StoredEntry {
    rules?: BrokerRule[] | undefined;
    delivery?: CredentialDelivery | undefined;
}
type Stored = Record<string, StoredEntry>;

// An entry that says nothing is dropped rather than kept as `{}`.
const tidy = (current: Stored, capability: string, entry: StoredEntry): Stored => {
    const { [capability]: _previous, ...rest } = current;
    const kept = { ...(entry.rules !== undefined ? { rules: entry.rules } : {}), ...(entry.delivery === "raw" ? { delivery: entry.delivery } : {}) };
    return Object.keys(kept).length === 0 ? rest : { ...rest, [capability]: kept };
};

export const fileCredentialPolicy = (path: string): CredentialPolicyStore => {
    const file = openDocument(credentialPolicyDocument, path, {
        fallback: (): Stored => ({}),
        mode: 0o600,
        // A fresh policy over an unreadable one would put back every connector default and drop every raw opt-out.
        onUnreadable: "refuse",
    });
    return {
        of: async (capability) => {
            const state = await file.state();
            if (state.unreadable) {
                throw new Error(`the credential policy at ${path} could not be read (${state.detail})`);
            }
            return state.value[capability] ?? {};
        },
        setRules: async (capability, rules) => {
            await file.update((current) =>
                tidy(current, capability, { ...current[capability], rules: rules === undefined ? undefined : [...rules] }),
            );
        },
        setDelivery: async (capability, delivery) => {
            await file.update((current) => tidy(current, capability, { ...current[capability], delivery }));
        },
        forget: async (capability) => {
            await file.update((current) => (capability in current ? tidy(current, capability, {}) : current));
        },
    };
};
