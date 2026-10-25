import type { AutomationSummary } from "@intentic/sandbox-contract/schemas/automations";
import { computed, type Ref } from "vue";
import { host } from "./host";
import { t } from "./i18n.js";
import { personaReach } from "./personaReach";

// personaReach.ts read against this sandbox's own personas and accounts, with the words the row and the editor say it
// in. The persona list is returned for the editor's picker too, so every row and the form share one fetch.
export const usePersonaReach = (
    automation: Ref<Pick<AutomationSummary, `actsAs` | `senders` | `target`>>,
    // Whether its wakes start an agent: a conversation runs as itself and a notification runs nothing. The editor asks
    // only where they do, so it leaves this out.
    startsAgent: Ref<boolean> = computed(() => true),
) => {
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
    // Who its wakes act as, said for every wake that starts an agent: blank is a choice with a cost, not an absence.
    const runsAs = computed<string | undefined>(() => {
        const id = automation.value.actsAs;
        if (id !== undefined) {
            return reach.value?.kind === `missing` && reach.value.ids.includes(id) ? t(`automationRow.runsAsMissing`, { id }) : id;
        }
        return startsAgent.value ? t(`automationRow.runsAsNobody`) : undefined;
    });
    // The editor's sentence under its persona picker: why blank or a vanished card costs something, while it can be changed.
    const hint = computed(() => {
        const said = reach.value;
        if (said === undefined) {
            return undefined;
        }
        return said.kind === `missing`
            ? { text: t(`automationFields.personaGoneHint`), tone: `text-danger` }
            : { text: t(`automationFields.noPersonaHint`), tone: `text-subtle` };
    });
    return { personaList, reach, reachTip, runsAs, hint };
};
