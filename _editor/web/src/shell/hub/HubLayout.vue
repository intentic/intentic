<!-- Shared shell for a hub page — title, section index, and the active section's body — used by the sandbox hub and settings hub. -->
<script setup lang="ts">
import { type IconName, type NavGroup, NavRail, Row, SegmentedControl, SplitView } from "@intentic/ui";
import { areaIcon } from "@intentic/ui/icons";
import { computed, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { badgeChip } from "../../core-views/viewBadge";
import ViewBadgeChip from "../../core-views/ViewBadgeChip.vue";
import type { HubTab } from "./hubNav";

const {
    groups,
    routeName,
    defaultSlug,
    ready = true,
} = defineProps<{
    title: string;
    description?: string;
    /** The named route the sections live on: `/<path>/:tab?`. */
    routeName: string;
    /** The section the param-less URL shows. Its row writes no param, so no section has two URLs. */
    defaultSlug: string;
    groups: readonly NavGroup<HubTab>[];
/** Holds the unknown-slug redirect while the set is still filling in. */
    ready?: boolean;
}>();

const route = useRoute();
const router = useRouter();

const tabs = computed<readonly HubTab[]>(() => groups.flatMap((group) => group.items));
const slugs = computed<readonly string[]>(() => tabs.value.map((tab) => tab.slug));

const activeSlug = computed<string>(() => {
    const tab = route.params[`tab`];
    return typeof tab === `string` && slugs.value.includes(tab) ? tab : defaultSlug;
});

const linkTo = (slug: string) => ({ name: routeName, params: { tab: slug === defaultSlug ? undefined : slug } });

// The strip is a control, not a link, so the mobile branch still navigates by hand.
const select = (slug: string): void => {
    void router.push(linkTo(slug));
};

// The strip flattens the groups away: it has no headings, which is the other half of why it is the mobile
// answer only: the grouping this component exists to show is exactly what does not survive the trip.
const options = computed(() =>
    tabs.value.map((tab) => ({
        label: tab.label,
        value: tab.slug,
        badge: tab.badge?.count,
        mark: tab.badge?.mark as IconName | undefined,
    })),
);

// An unknown slug (/sandbox/nonsense) resolves to the default: clean the URL back to the canonical one.
watch(
    [() => route.params[`tab`], slugs, () => ready],
    ([tab, known, settled]) => {
        if (settled && typeof tab === `string` && tab.length > 0 && !known.includes(tab)) {
            void router.replace({ name: routeName });
        }
    },
    { immediate: true },
);
</script>

<template>
<!-- Wide because the index spends 14rem of it: at the 56rem default the body would be left narrower than it was before the column arrived. -->
    <SplitView :title="title" :description="description" scroll="page">
<!-- Mobile keeps the strip. -->
        <template #compact>
            <div class="overflow-x-auto border-b border-line-subtle pb-2">
                <SegmentedControl :model-value="activeSlug" :options="options" @update:model-value="select" />
            </div>
        </template>

        <template #rail>
            <NavRail aria-label="Sections" :groups="groups">
                <template #row="{ item: tab }">
                    <!-- Internal navigation wraps the presentational row to provide its href. -->
                    <RouterLink :key="tab.slug" :to="linkTo(tab.slug)" class="block">
                        <Row
                            as="div"
                            density="dense"
                            :icon="areaIcon(tab.slug, tab.icon)"
                            :title="tab.label"
                            :selected="tab.slug === activeSlug"
                            class="rounded-lg"
                        >
<!-- A fact about the section, so it rides the row's #meta cluster. -->
                            <!-- Chip only: a hub row is a section of one view, so it never speaks for a run in flight. -->
<!-- The test stays out here, unlike the corner badges, because `#meta` is a slot Row only draws when it is filled. -->
                            <template v-if="tab.badge !== undefined && badgeChip(tab.badge)" #meta>
                                <ViewBadgeChip :badge="tab.badge" class="text-2xs" />
                            </template>
                        </Row>
                    </RouterLink>
                </template>
            </NavRail>
        </template>

        <template #detail><slot :slug="activeSlug" /></template>
    </SplitView>
</template>
