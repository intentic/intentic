import type { AutomationSummary } from "@intentic/sandbox-contract/schemas/automations";
import { isSignedInAccount } from "@intentic/sandbox-contract/policy/role-capability";
import { FULL_ACCESS_ROLE, isBuiltInRole, NO_ACCOUNTS_ROLE } from "@intentic/sandbox-contract/schemas/roles";
import type { ConditionKind, TriggerKind } from "../useAutomationForm";

// What an automation's wakes can reach, as far as the owner needs telling: the two cases where a wake quietly gets less
// than the owner likely expects. Mirrors the daemon's rule (roles.ts `turnRole`): an unattended wake naming no
// role wears the built-in No accounts, every tool but no signed-in account, and one naming a card that is gone gets
// nothing at all. A built-in is never gone.
//   "missing"     a card it names (its own or a sender rule's) no longer exists: no tools, no accounts.
//   "no-accounts" it wears No accounts, named or by default, and this sandbox holds signed-in accounts it cannot use.
// Undefined is nothing worth saying: a role that exists, a wake that starts no agent, or no accounts to miss.
export type RoleReach = { readonly kind: `missing`; readonly ids: readonly string[] } | { readonly kind: `no-accounts` };

export interface RoleReachFacts {
    // Role ids that exist; undefined while the list is loading, so a slow read never flashes "missing".
    readonly roles: readonly string[] | undefined;
    // Kinds of the sandbox's capabilities, to know whether there are signed-in accounts to miss at all.
    readonly capabilityKinds: readonly string[];
}

export const roleReach = (
    automation: Pick<AutomationSummary, `actsAs` | `senders` | `target`>,
    { roles, capabilityKinds }: RoleReachFacts,
): RoleReach | undefined => {
    // A conversation runs as itself and a notification runs nothing, so neither wears the automation's role.
    if (automation.target !== undefined && automation.target.kind !== `agent`) {
        return undefined;
    }
    if (roles !== undefined) {
        const named = [automation.actsAs, ...(automation.senders?.rules.map((rule) => rule.actsAs) ?? [])].filter(
            (id): id is string => id !== undefined && !isBuiltInRole(id),
        );
        const missing = [...new Set(named.filter((id) => !roles.includes(id)))];
        if (missing.length > 0) {
            return { kind: `missing`, ids: missing };
        }
    }
    if ((automation.actsAs === undefined || automation.actsAs === NO_ACCOUNTS_ROLE) && capabilityKinds.some(isSignedInAccount)) {
        return { kind: `no-accounts` };
    }
    return undefined;
};

// The role a new automation starts on until somebody picks one, as the form holds it (blank is No accounts). Full
// access only where nothing from outside reaches its prompt: a schedule, a one-time wake or a workspace moment, with no
// check in front. A listener or a webhook carries somebody else's words, and a check's output rides into the prompt
// too (a page, a release, whatever a command printed), so those start on No accounts and are widened by a person, not
// by a default.
export const defaultActsAs = (kind: TriggerKind, condition: ConditionKind): string =>
    (kind === `schedule` || kind === `once` || kind === `workspace`) && condition === `none` ? FULL_ACCESS_ROLE : ``;
