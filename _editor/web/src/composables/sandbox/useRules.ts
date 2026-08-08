import { type Rule, type RuleFirings, RuleFiringsSchema } from "@intentic-app/api-contract";
import { computed } from "vue";
import { NAMED_RULES } from "./rules";
import { sandboxJson } from "./sandboxClient";
import { sandboxKey } from "./useSandbox";
import { useSandboxQuery } from "./useSandboxQuery";
import { useSandboxSettings } from "./useSandboxSettings";

/* THE RULE TABLE, from the screen's side — one place that knows how a row becomes a rule, so no surface has to
 * hand-assemble one.
 *
 * The three rows with their own place on the Agent tab ("Verify before finishing", "Check before you push",
 * "Land finished work automatically") are ORDINARY RULES with well-known ids. That is the whole trick: the row
 * is a nicer way to write one rule, not a different mechanism sitting beside the table. It means the toggle and
 * the list can never disagree, and it means a user who outgrows a row can see exactly what it wrote.
 *
 * The rules live in the sandbox settings object, so everything here rides useSandboxSettings' one read, one
 * optimistic write and one "the daemon dropped a field" warning rather than adding a second of each. */

const FIRINGS_KEY = sandboxKey(`rule-firings`);

export function useRules() {
    const { settings, patch } = useSandboxSettings();

    // When each rule last did something. Its own read because a firing is not an edit — folding it into the
    // settings object would make every push a settings write, with a background job racing the owner's own
    // config.
    const { query: firingsQuery } = useSandboxQuery({
        queryKey: FIRINGS_KEY,
        queryFn: async (): Promise<RuleFirings> => RuleFiringsSchema.parse(await sandboxJson(`/settings/rule-firings`)),
    });

    const rules = computed<Rule[]>(() => settings.value?.rules ?? []);
    const firings = computed<RuleFirings>(() => firingsQuery.data.value ?? {});

    const byId = (id: string): Rule | undefined => rules.value.find((rule) => rule.id === id);

    /* Write one rule, creating it if this is the first time. Position matters — the list order IS the priority
     * at a deciding moment — so an existing rule is replaced IN PLACE and a new one goes on the end.
     *
     * The three named rows all come through here, which is why turning "Verify before finishing" off and on
     * again cannot silently move it below a rule the user put above it. */
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

    // Move a rule one place up or down. Only meaningful at a deciding moment, where first-match wins — but the
    // list is one list, and a control that appeared and vanished depending on a rule's moment would read as a
    // bug rather than as a distinction.
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

    // A free id from a label, so the add flow never asks the user for one. Suffixed until it is unused: an id
    // is what the activity feed names and what the firing stamps are keyed by, so a collision would quietly
    // merge two rules' histories.
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
        // What the general list shows: everything without a row of its own further up the page.
        listed: computed<Rule[]>(() => rules.value.filter((rule) => !Object.values(NAMED_RULES).includes(rule.id as never))),
    };
}
