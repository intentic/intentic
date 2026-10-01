<!-- The Needs you list: one short row per thing waiting, grouped by whether an agent is standing still on it. Picking a
     row opens it beside the list (or in its place on a phone); nothing is answered in the row itself. -->
<script setup lang="ts">
import { BrandMark, type NavGroup, NavRail, Row, timeAgo, useNow } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import type { InboxItem, InboxSection } from "./inboxItems";

const t = useT();

const { sections, selected } = defineProps<{
    sections: readonly InboxSection[];
    /** The key of the row open beside the list; absent on a phone's list, where nothing is. */
    selected: string | undefined;
}>();
const emit = defineEmits<{ select: [key: string] }>();

const groups = computed<NavGroup<InboxItem>[]>(() =>
    sections.map((section) => ({
        key: section.group,
        label: section.group === `blocking` ? t(`needs.inbox.groupBlocking`) : t(`needs.inbox.groupWaiting`),
        count: section.items.length,
        items: [...section.items],
    })),
);

// Ages move while the page is open, off the one shared clock.
const now = useNow();
const age = (item: InboxItem): string | undefined =>
    item.createdAt === undefined ? undefined : timeAgo(item.createdAt, { now: now.value, days: true });

// The lead says how pressing it will feel: an agent stopped on it wears the warning ink, a broken one the danger ink.
const tone = (item: InboxItem): `danger` | `warning` | `default` =>
    item.broken === true ? `danger` : item.group === `blocking` ? `warning` : `default`;
const KIND_INK = { danger: `text-danger`, warning: `text-warning`, default: `text-muted` } as const;
</script>

<template>
    <NavRail :groups="groups" :aria-label="t(`needs.inbox.title`)">
        <template #row="{ item }">
            <Row
                :key="item.key"
                as="button"
                density="dense"
                :icon="item.logo === undefined ? item.icon : undefined"
                :tone="tone(item)"
                :selected="item.key === selected"
                class="rounded-lg"
                @click="emit(`select`, item.key)"
            >
                <template v-if="item.logo !== undefined" #lead="{ mark }"><BrandMark :size="mark" :name="item.kind" :logo="item.logo" /></template>
                <!-- The title gets the row's whole width; its age rides the second line, beside what it is and who asked. -->
                <template #title
                    ><span class="block truncate" v-tooltip.right.overflow="item.title">{{ item.title }}</span></template
                >
                <template #description>
                    <span class="flex min-w-0 items-center gap-1">
                        <span class="shrink-0 font-medium" :class="KIND_INK[tone(item)]">{{ item.kind }}</span>
                        <template v-if="item.context"
                            ><span class="shrink-0 text-subtle">·</span><span class="min-w-0 truncate">{{ item.context }}</span></template
                        >
                        <span v-if="age(item)" class="ml-auto shrink-0 pl-2 tabular-nums text-subtle">{{ age(item) }}</span>
                    </span>
                </template>
            </Row>
        </template>
    </NavRail>
</template>
