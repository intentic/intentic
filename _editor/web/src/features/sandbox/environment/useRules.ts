import { type Rule, type RuleFirings, RuleFiringsSchema } from "@intentic/api-contract";
import { computed } from "vue";
import { NAMED_RULES } from "./rules";
import { sandboxJson } from "../client/sandboxClient";
import { RULE_FIRINGS } from "../../../lib/queryKeys";
import { useSandboxQuery } from "../client/useSandboxQuery";
import { useSandboxSettings } from "../overview/useSandboxSettings";

// One place that turns a row into a rule, so no surface hand-assembles one. The three rows with a dedicated place on
// the Agent tab are ordinary rules with well-known ids, so the toggle and the list can never disagree. Rules live in
// the sandbox settings object, riding useSandboxSettings' read and write.

const FIRINGS_KEY = RULE_FIRINGS.of();

export function useRules() {
    const { settings, patch } = useSandboxSettings();

    // Its own read: a firing isn't an edit, and folding it into settings would turn every push into a write racing the
    // owner's own config.
    const { query: firingsQuery } = useSandboxQuery({
        queryKey: FIRINGS_KEY,
        queryFn: async (): Promise<RuleFirings> => RuleFiringsSchema.parse(await sandboxJson(`/settings/rule-firings`)),
    });

    const rules = computed<Rule[]>(() => settings.value?.rules ?? []);
    const firings = computed<RuleFirings>(() => firingsQuery.data.value ?? {});

    const byId = (id: string): Rule | undefined => rules.value.find((rule) => rule.id === id);

    // Replaces an existing rule in place and appends a new one, since list order is the decision priority; toggling a
    // named row can't silently reorder it.
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

    // Only meaningful at a first-match moment, but shown regardless: hiding it per-moment would read as a bug, not a
    // distinction.
    const move = (id: string, by: -1 | 1): void => {
        const at = rules.value.findIndex((rule) => rule.id === id);
        const to = at + by;
        if (at === -1 || to < 0 || to >= rules.value.length) {
            return;
        }
        const next = [...rules.value];
        const [moved] = next.splice(at, 1);
        if (moved !== undefined) {
            next.splice(to, 0, moved);
            patch({ rules: next });
        }
    };

    // Suffixes until unique: an id is what firing stamps are keyed by, so a collision would merge two rules' histories.
    const freeId = (label: string): string => {
        const base =
            label
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, `-`)
                .replace(/^-|-$/g, ``) || `rule`;
        if (byId(base) === undefined) {
            return base;
        }
        for (let n = 2; ; n += 1) {
            if (byId(`${base}-${n}`) === undefined) {
                return `${base}-${n}`;
            }
        }
    };

    return {
        settings,
        rules,
        firings,
        byId,
        upsert,
        remove,
        setEnabled,
        move,
        freeId,
        // Everything without a dedicated row further up the page.
        listed: computed<Rule[]>(() => rules.value.filter((rule) => !Object.values(NAMED_RULES).includes(rule.id as never))),
    };
}
