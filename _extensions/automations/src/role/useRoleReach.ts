import type { AutomationSummary } from "@intentic/sandbox-contract/schemas/automations";
import { computed, type Ref } from "vue";
import { host } from "../host";
import { t } from "../i18n.js";
import { roleReach } from "./roleReach";
import { FULL_ACCESS_ROLE, NO_ACCOUNTS_ROLE } from "@intentic/sandbox-contract/schemas/roles";

// A built-in role's name, in this page's words; undefined for a card's id.
export const builtInLabel = (id: string): string | undefined =>
    id === FULL_ACCESS_ROLE ? t(`builtInRoles.fullAccess`) : id === NO_ACCOUNTS_ROLE ? t(`builtInRoles.noAccounts`) : undefined;

// roleReach.ts read against this sandbox's own roles and accounts, with the words the row and the editor say it
// in. The role list is returned for the editor's picker and the detail's "Runs as" too, so they share one fetch.
export const useRoleReach = (automation: Ref<Pick<AutomationSummary, `actsAs` | `senders` | `target`>>) => {
    const { query: roleList } = host().sandbox.query({
        queryKey: host().sandbox.readKey(`roles.list`),
        queryFn: () => host().sandbox.rpc.roles.list(),
    });
    const reach = computed(() =>
        roleReach(automation.value, {
            roles: roleList.data.value?.roles.map((role) => role.id),
            capabilityKinds: host()
                .workspace.capabilities()
                .map((capability) => capability.kind),
        }),
    );
    // Title and one sentence, for a tooltip: a page of automations is not a wall of warnings.
    const reachTip = computed(() => {
        const said = reach.value;
        if (said === undefined) {
            return undefined;
        }
        return said.kind === `missing`
            ? { title: t(`automationRow.roleMissing`), note: t(`automationRow.roleMissingNote`, { ids: said.ids.join(`, `) }) }
            : { title: t(`automationRow.noAccounts`), note: t(`automationRow.noAccountsNote`) };
    });
    // The editor's sentence under its role picker, for a card that is gone; No accounts says its own cost in the
    // picker, so it needs no second sentence here.
    const hint = computed(() => (reach.value?.kind === `missing` ? { text: t(`automationFields.roleGoneHint`), tone: `text-danger` } : undefined));
    return { roleList, reach, reachTip, hint };
};
