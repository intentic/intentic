import type { AutomationSummary } from "@intentic/sandbox-contract/schemas/automations";
import { computed, type Ref } from "vue";
import { host } from "../host";
import { t } from "../i18n.js";
import { personaReach } from "./personaReach";
import { FULL_ACCESS_PERSONA, NO_ACCOUNTS_PERSONA } from "@intentic/sandbox-contract/schemas/personas";

// A built-in persona's name, in this page's words; undefined for a card's id.
export const builtInLabel = (id: string): string | undefined =>
    id === FULL_ACCESS_PERSONA ? t(`builtInPersonas.fullAccess`) : id === NO_ACCOUNTS_PERSONA ? t(`builtInPersonas.noAccounts`) : undefined;

// personaReach.ts read against this sandbox's own personas and accounts, with the words the row and the editor say it
// in. The persona list is returned for the editor's picker and the detail's "Runs as" too, so they share one fetch.
export const usePersonaReach = (automation: Ref<Pick<AutomationSummary, `actsAs` | `senders` | `target`>>) => {
    const { query: personaList } = host().sandbox.query({
        queryKey: host().sandbox.readKey(`personas.list`),
        queryFn: () => host().sandbox.rpc.personas.list(),
    });
    const reach = computed(() =>
        personaReach(automation.value, {
            personas: personaList.data.value?.personas.map((persona) => persona.id),
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
            ? { title: t(`automationRow.personaMissing`), note: t(`automationRow.personaMissingNote`, { ids: said.ids.join(`, `) }) }
            : { title: t(`automationRow.noAccounts`), note: t(`automationRow.noAccountsNote`) };
    });
    // The editor's sentence under its persona picker, for a card that is gone; No accounts says its own cost in the
    // picker, so it needs no second sentence here.
    const hint = computed(() => (reach.value?.kind === `missing` ? { text: t(`automationFields.personaGoneHint`), tone: `text-danger` } : undefined));
    return { personaList, reach, reachTip, hint };
};
