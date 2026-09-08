import type { Capability } from "@intentic/sandbox-contract";
import type { ResolvedContribution } from "./contributions.js";
import { registry } from "./registry.js";

// Credential keys are the complement of a kind's `echo`, not a second declared list, so echo alone decides what gets
// vaulted. Distinct from `handler.secret()` (the one rotatable key); also backs CapabilitySummary.secrets for the edit
// form.
export const secretFieldsOf = (capability: Capability, connectors: Map<string, ResolvedContribution>): readonly string[] => {
    const config = capability.config as Record<string, unknown>;
    const echoed = new Set(Object.keys(registry[capability.kind].echo(config, connectors)));
    return Object.keys(config).filter((key) => !echoed.has(key));
};

// Only string values are vaulted, since every credential shape today is stored as text. A non-string secret field is
// returned as `unvaultable` rather than silently left in the manifest.
export const partitionSecretValues = (
    capability: Capability,
    connectors: Map<string, ResolvedContribution>,
): { readonly values: Record<string, string>; readonly unvaultable: readonly string[] } => {
    const config = capability.config as Record<string, unknown>;
    const values: Record<string, string> = {};
    const unvaultable: string[] = [];
    for (const key of secretFieldsOf(capability, connectors)) {
        const value = config[key];
        if (typeof value === "string") {
            values[key] = value;
        } else if (value !== undefined) {
            unvaultable.push(key);
        }
    }
    return { values, unvaultable };
};
