import type { AutomationSummary } from "@intentic/sandbox-contract/schemas/automations";
import { computed, type Ref } from "vue";
import { host } from "../host";
import { t } from "../i18n.js";
import { type ShelfOf, type ShelfWords, shelfOf, shelvesOf } from "./grouping";
import { builtInLabel } from "../persona/usePersonaReach";

// grouping.ts read against this sandbox's own personas, in the words this page says its two unnamed shelves in. The
// persona list is the same read the rows' reach check makes, so one fetch serves both.
export const useShelves = (automations: Ref<readonly AutomationSummary[]>) => {
    const { query: personaList } = host().sandbox.query({
        queryKey: host().sandbox.readKey(`personas.list`),
        queryFn: () => host().sandbox.rpc.personas.list(),
    });
    const words = computed<ShelfWords>(() => {
        const labels = new Map((personaList.data.value?.personas ?? []).map((persona) => [persona.id, persona.label]));
        return { chores: t(`automationsView.codeChores`), other: t(`automationsView.other`), personaLabel: (id) => labels.get(id) ?? builtInLabel(id) };
    });
    const shelves = computed(() => shelvesOf(automations.value, words.value));
    // Which shelf an automation sits on and by what (a group it names, its persona, the chores), for a row that says its
    // gist without repeating the shelf's name and for the opened automation saying where it is filed.
    const placeOf = (automation: AutomationSummary): ShelfOf => shelfOf(automation, words.value);
    const shelfLabelOf = (automation: AutomationSummary): string => placeOf(automation).label;
    return { shelves, shelfLabelOf, placeOf };
};
