import type { AutomationSummary } from "@intentic/sandbox-contract/schemas/automations";
import { isSignedInAccount } from "@intentic/sandbox-contract/policy/persona-capability";

// What an automation's wakes can reach, as far as the owner needs telling: the two cases where a wake quietly gets less
// than the owner likely expects. Mirrors the daemon's rule (personas.ts `turnPersona`): an unattended wake naming no
// persona keeps every tool but no signed-in account, and one naming a card that is gone gets nothing at all.
//   "missing"     a persona it names (its own or a sender rule's) no longer exists: no tools, no accounts.
//   "no-accounts" it names none, and this sandbox holds signed-in accounts it therefore cannot use.
// Undefined is nothing worth saying: a persona that exists, a wake that starts no agent, or no accounts to miss.
export type PersonaReach = { readonly kind: `missing`; readonly ids: readonly string[] } | { readonly kind: `no-accounts` };

export interface PersonaReachFacts {
    // Persona ids that exist; undefined while the list is loading, so a slow read never flashes "missing".
    readonly personas: readonly string[] | undefined;
    // Kinds of the sandbox's capabilities, to know whether there are signed-in accounts to miss at all.
    readonly capabilityKinds: readonly string[];
}

export const personaReach = (
    automation: Pick<AutomationSummary, `actsAs` | `senders` | `target`>,
    { personas, capabilityKinds }: PersonaReachFacts,
): PersonaReach | undefined => {
    // A conversation runs as itself and a notification runs nothing, so neither wears the automation's persona.
    if (automation.target !== undefined && automation.target.kind !== `agent`) {
        return undefined;
    }
    if (personas !== undefined) {
        const named = [automation.actsAs, ...(automation.senders?.rules.map((rule) => rule.actsAs) ?? [])].filter(
            (id): id is string => id !== undefined,
        );
        const missing = [...new Set(named.filter((id) => !personas.includes(id)))];
        if (missing.length > 0) {
            return { kind: `missing`, ids: missing };
        }
    }
    if (automation.actsAs === undefined && capabilityKinds.some(isSignedInAccount)) {
        return { kind: `no-accounts` };
    }
    return undefined;
};
