import { watch } from "vue";
import { defaultActsAs } from "./personaReach";
import type { ConditionKind, TriggerKind } from "../useAutomationForm";

// A NEW automation's persona follows its trigger and check until somebody picks one (personaReach.ts `defaultActsAs`):
// Full access for a schedule, a one-time wake or a workspace moment with no check, No accounts for anything that brings
// outside words into the prompt. Re-applied whenever the form moves it (a template resets it, the trigger changes), and
// never again once the picker was touched: a person's choice is never widened or narrowed behind their back. Only the
// composer calls this; an edit keeps what the automation already wears.
export const usePersonaDefault = (
    form: { kind: TriggerKind; condition: ConditionKind; actsAs: string },
    touched: { has: (key: string) => boolean },
): void => {
    watch(
        () => [form.kind, form.condition, form.actsAs] as const,
        ([kind, condition]) => {
            if (!touched.has(`actsAs`)) {
                form.actsAs = defaultActsAs(kind, condition);
            }
        },
        { immediate: true },
    );
};
