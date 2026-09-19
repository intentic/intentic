<!-- Shared shell for a hub page — title, section index, and the active section's body — used by the sandbox hub and settings hub. -->
<script setup lang="ts">
import { type IconName, type NavGroup, NavRail, Row, SegmentedControl, SplitView } from "@intentic/ui";
import { areaIcon } from "@intentic/ui/icons";
import { computed, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { badgeSpeaks, RUNNING_MARK_CLASS } from "../../core-views/viewBadge";
import ViewBadgeChip from "../../core-views/ViewBadgeChip.vue";
import type { HubTab } from "./hubNav";
import { hubWorkKey, provideHubSection } from "./hubWork";
import { useT } from "@intentic/ui/i18n";

const t = useT();

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
    if (typeof tab !== `string` || tab.length === 0) {
        return defaultSlug;
    }
    // Unknown while the set is still filling means unknown YET: falling back would draw one section and swap it for
    // another under the reader — the same reason the redirect below waits for `ready`.
    return slugs.value.includes(tab) || !ready ? tab : defaultSlug;
});

const linkTo = (slug: string) => ({ name: routeName, params: { tab: slug === defaultSlug ? undefined : slug } });

// The address the section on screen reports its long-running work under, so no view has to be told which row it
// lives on. The hub draws the mark; what it says comes back through this hub's own badges.
provideHubSection(computed(() => hubWorkKey(routeName, activeSlug.value)));

// The strip is a control, not a link, so the mobile branch still navigates by hand.
const select = (slug: string): void => {
    void router.push(linkTo(slug));
};

// The strip flattens the groups away: it has no headings, which is the other half of why it is the mobile
// answer only: the grouping this component exists to show is exactly what does not survive the trip.
// A section's own mark keeps the chip; a run takes it only where there is none, turning, and says what it is in the
// pill's title — the strip has no second corner to put it in.
const options = computed(() =>
    tabs.value.map((tab) => {
        const running = tab.badge?.running;
        return {
            label: tab.label,
            value: tab.slug,
            badge: tab.badge?.count,
            mark: (tab.badge?.mark ?? (running === undefined ? undefined : `spinner`)) as IconName | undefined,
            markSpin: tab.badge?.mark === undefined && running !== undefined,
            ...(running === undefined ? {} : { markTitle: running }),
        };
    }),
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
        <!-- It wraps rather than scrolls: this is the index of everything the hub holds, and a section a reader can't see is a section they won't look for. -->
        <template #compact>
            <div class="border-b border-line-subtle pb-2">
                <SegmentedControl :model-value="activeSlug" :options="options" wrap @update:model-value="select" />
            </div>
        </template>

        <template #rail>
            <NavRail :aria-label="t(`shell.hubLayout.sections`)" :groups="groups">
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
                            <!-- The test stays out here, unlike the corner badges, because `#meta` is a slot Row only draws when it is filled. -->
                            <template v-if="tab.badge !== undefined && badgeSpeaks(tab.badge)" #meta>
                                <!-- Work in flight behind the section, in the rail tiles' own mark and ink: a hub mounts one section at a time,
     so this is all that is left on screen of a run the reader walked away from. The sentence rides the tooltip
     and the reader's screen reader — a 14rem row has no width to spend on it. -->
                                <span
                                    v-if="tab.badge.running !== undefined"
                                    class="inline-flex items-center"
                                    :class="RUNNING_MARK_CLASS"
                                    v-tooltip.right="tab.badge.running"
                                >
                                    <Icon name="spinner" spin aria-hidden="true" />
                                    <span class="sr-only">{{ tab.badge.running }}</span>
                                </span>
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
