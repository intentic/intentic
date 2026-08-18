import type { Capability } from "@intentic/sandbox-contract";
import type { ResolvedContribution } from "./contributions.js";
import { registry } from "./registry.js";

/* WHICH CONFIG KEYS OF ONE ENTRY HOLD A CREDENTIAL — derived from `echo` rather than declared a second time.
 *
 * `echo` already answers "what of this config may the browser see", and every kind is forced to answer it out
 * loud (capability.ts makes it required for exactly that reason). So the credential keys are its complement:
 * whatever a kind withholds from a browser is, by the same judgement, what must not sit in a file the agent
 * reads. Deriving the set means there is no second per-kind table to keep in step — a new kind that withholds a
 * new field starts vaulting it on the same commit, and a kind that starts echoing a field stops.
 *
 * Not `handler.secret()`: that names the ONE rotatable key /secrets offers to replace, which is a different
 * question. A two-credential connector (Slack's app token beside its bot token), an ssh entry carrying both a
 * key and a passphrase, or a vpn conf beside its pre-shared key would each leave a credential behind if this
 * followed the rotatable one.
 *
 * Exported because the LIST route answers the same question for a second reader: the edit form has to know
 * which of its boxes are holding a credential it will never be shown, and this is already the definition of
 * that set (CapabilitySummary.secrets).
 */
export const secretFieldsOf = (capability: Capability, connectors: Map<string, ResolvedContribution>): readonly string[] => {
    const config = capability.config as Record<string, unknown>;
    const echoed = new Set(Object.keys(registry[capability.kind].echo(config, connectors)));
    return Object.keys(config).filter((key) => !echoed.has(key));
};

/* The credential keys whose values can actually be vaulted: strings. Every credential shape in the union is one
 * today (a token, a password, an ssh key, a WireGuard conf, an agent's env block are all stored as text), and
 * the vault is a string map because that is what the readers put into an environment or a header.
 *
 * A non-string secret field is therefore a shape nobody has introduced yet, and it must not fail QUIETLY: left
 * in the manifest it would be exactly the leak this module exists to close, so the caller is handed the names
 * and says so in the log rather than writing the entry and moving on.
 */
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
