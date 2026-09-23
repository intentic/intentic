import type { Rule } from "@intentic/api-contract";
import { computed } from "vue";
import { useSandboxSettings } from "../overview/useSandboxSettings";

// One place that turns a toggle into a rule, so no surface hand-assembles one. Each toggle is an ordinary rule with a
// well-known id (rules.ts NAMED_RULES), riding useSandboxSettings' read and write.

export function useRules() {
    const { settings, patch } = useSandboxSettings();

    const rules = computed<Rule[]>(() => settings.value?.rules ?? []);

    const byId = (id: string): Rule | undefined => rules.value.find((rule) => rule.id === id);

    // Replaces an existing rule in place and appends a new one, since list order is the decision priority.
    const upsert = (rule: Rule): void => {
        const at = rules.value.findIndex((existing) => existing.id === rule.id);
        patch({ rules: at === -1 ? [...rules.value, rule] : rules.value.map((existing, index) => (index === at ? rule : existing)) });
    };

    const remove = (id: string): void => patch({ rules: rules.value.filter((rule) => rule.id !== id) });

    const setEnabled = (id: string, enabled: boolean): void => {
        const rule = byId(id);
        if (rule !== undefined) {
            upsert({ ...rule, enabled });
        }
    };

    return { settings, byId, upsert, remove, setEnabled };
}
