import { type Automation, AutomationSchema, type AutomationSummary } from "@intentic/sandbox-contract/schemas/automations";
import { computed, inject, type InjectionKey, provide, ref, type Ref } from "vue";
import { useAutomations } from "../useAutomations";
import { t } from "../i18n.js";

/** A change to one setting, as the stored automation with that change made. */
export type AutomationChange = (stored: Automation) => Automation;

// AN AUTOMATION NOT SAVED YET: its settings are drawn and changed by the same components an opened one uses, and their
// changes go into the draft rather than to the daemon. Provided by the draft row (draft/AutomationDraft.vue).
const DRAFT: InjectionKey<(change: AutomationChange) => void> = Symbol(`automation-draft`);
export const provideDraftWriter = (write: (change: AutomationChange) => void): void => provide(DRAFT, write);
/** Whether what is drawn here is a draft: its panels settle a change ("Done") rather than save one. */
export const useDrafting = (): boolean => inject(DRAFT, undefined) !== undefined;

// ONE SETTING CHANGED WHERE IT IS SHOWN: the stored automation with that one change, written whole, since the daemon's
// upsert takes a whole automation. Read off the summary the list holds, less what only the list carries (its runs, its
// next fire, what its check saw, its door's token), which the schema's parse drops. A refusal stays on the setting that
// asked for it, in the daemon's own words, rather than in a banner over the page. Inside a draft, the change is the
// draft's and nothing is sent until it is created.
export const useAutomationPatch = (automation: Ref<AutomationSummary>) => {
    const { save } = useAutomations();
    const draft = inject(DRAFT, undefined);
    const error = ref<string | undefined>(undefined);
    const saving = computed(() => draft === undefined && save.isPending.value);
    const patch = async (change: AutomationChange): Promise<boolean> => {
        error.value = undefined;
        if (draft !== undefined) {
            draft(change);
            return true;
        }
        try {
            await save.mutateAsync(change(AutomationSchema.parse(automation.value)));
            return true;
        } catch (err) {
            error.value = err instanceof Error ? err.message : t(`automationRow.couldntSave`);
            return false;
        }
    };
    return { patch, error, saving, drafting: draft !== undefined };
};
