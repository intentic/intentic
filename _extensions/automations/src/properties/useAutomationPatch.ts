import { type Automation, AutomationSchema, type AutomationSummary } from "@intentic/sandbox-contract/schemas/automations";
import { computed, ref, type Ref } from "vue";
import { useAutomations } from "../useAutomations";
import { t } from "../i18n.js";

// ONE SETTING CHANGED WHERE IT IS SHOWN: the stored automation with that one change, written whole, since the daemon's
// upsert takes a whole automation. Read off the summary the list holds, less what only the list carries (its runs, its
// next fire, what its check saw, its door's token), which the schema's parse drops. A refusal stays on the setting that
// asked for it, in the daemon's own words, rather than in a banner over the page.
export const useAutomationPatch = (automation: Ref<AutomationSummary>) => {
    const { save } = useAutomations();
    const error = ref<string | undefined>(undefined);
    const saving = computed(() => save.isPending.value);
    const patch = async (change: (stored: Automation) => Automation): Promise<boolean> => {
        error.value = undefined;
        try {
            await save.mutateAsync(change(AutomationSchema.parse(automation.value)));
            return true;
        } catch (err) {
            error.value = err instanceof Error ? err.message : t(`automationRow.couldntSave`);
            return false;
        }
    };
    return { patch, error, saving };
};
