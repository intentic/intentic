<!-- The index column: the kinds of password, the sandboxes whose agents may use some, and what wants a look. -->
<script setup lang="ts">
import { type IconName, type NavGroup, NavRail, Row } from "@intentic/extension-ui";
import { computed } from "vue";
import { t } from "../i18n.js";
import { filterKey, type IndexCounts, type PasswordFilter } from "./model.js";
import type { SandboxRef } from "./port.js";

const { counts, sandboxes, current } = defineProps<{
    counts: IndexCounts;
    /** Every sandbox that has access to at least one password, by its label. */
    sandboxes: readonly SandboxRef[];
    /** The filter key on screen (`all`, `site`, `sandbox:https://…`, `settings`). */
    current: string;
}>();
const emit = defineEmits<{ pick: [key: string] }>();

interface Entry {
    readonly key: string;
    readonly label: string;
    readonly icon: IconName;
    readonly count: number;
    /** Drawn as a call to look rather than a tally: requests waiting. */
    readonly loud?: boolean;
}

const entry = (filter: PasswordFilter, label: string, icon: IconName, count: number, loud = false): Entry => ({ key: filterKey(filter), label, icon, count, loud });

const groups = computed((): NavGroup<Entry>[] => {
    const kinds: Entry[] = [
        entry({ kind: `all` }, t(`app.index.all`), `key`, counts.all),
        entry({ kind: `category`, category: `site` }, t(`app.index.site`), `globe`, counts.category.site),
        entry({ kind: `category`, category: `app` }, t(`app.index.app`), `desktop`, counts.category.app),
        entry({ kind: `category`, category: `terminal` }, t(`app.index.terminal`), `terminal`, counts.category.terminal),
    ];
    // A phone's passwords are a kind only once there are any: most computers never pair one.
    if (counts.category.phone > 0) {
        kinds.push(entry({ kind: `category`, category: `phone` }, t(`app.index.phone`), `mobile`, counts.category.phone));
    }
    kinds.push(entry({ kind: `category`, category: `note` }, t(`app.index.note`), `file`, counts.category.note));
    const result: NavGroup<Entry>[] = [{ key: `kinds`, items: kinds }];
    const agents = sandboxes
        .filter((sandbox) => (counts.sandbox.get(sandbox.url) ?? 0) > 0)
        .map((sandbox) => entry({ kind: `sandbox`, url: sandbox.url }, sandbox.label, `robot`, counts.sandbox.get(sandbox.url) ?? 0));
    if (agents.length > 0) {
        result.push({ key: `agents`, label: t(`app.index.agents`), items: agents });
    }
    result.push({
        key: `attention`,
        label: t(`app.index.attention`),
        items: [
            entry({ kind: `fresh` }, t(`app.index.fresh`), `sparkles`, counts.fresh),
            entry({ kind: `requests` }, t(`app.index.requests`), `bolt`, counts.requests, counts.requests > 0),
            entry({ kind: `weak` }, t(`app.index.weak`), `shield`, counts.weak),
        ],
    });
    return result;
});
</script>

<template>
    <NavRail :groups="groups" :aria-label="t(`app.index.label`)">
        <template #row="{ item }">
            <Row
                as="button"
                density="dense"
                :icon="item.icon"
                :title="item.label"
                :selected="item.key === current"
                :aria-current="item.key === current ? `page` : undefined"
                class="w-full rounded-lg"
                @click="emit(`pick`, item.key)"
            />
        </template>
    </NavRail>
</template>
