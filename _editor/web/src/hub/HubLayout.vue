<!-- A HUB PAGE: a title, an index of the hub's sections, and the active section's body. The sandbox hub and the
     settings hub were the same page twice: each carried its own TABS tuple, its own route↔slug resolution, its
     own "unknown slug goes home" watcher and its own copy of the strip markup, and the two had already drifted
     on whether the redirect waits for anything. All of that is here now; a hub declares its groups and renders
     its body.

     THE INDEX IS A COLUMN, NOT A STRIP, and that is the whole point of this component. A <SegmentedControl> is a row of
     toggle pills for a few exclusive views of ONE thing: Preview/Source, Linux/Windows, and the sandbox hub
     had grown twelve destinations in it, nine built-in and one per extension that registers a `sandbox` view.
     Measured, the strip came to ~740px inside a 720px content column, so it scrolled: the pills that were still
     legible were the ones that happened to fit, and the rest were behind a horizontal scrollbar nobody looks
     for. Growing the page wider only moves that number. Three things follow from switching axis:

      1. VERTICAL IS WHERE THE ROOM IS. Twelve rows is a short column and a broken strip.
      2. GROUPS BECOME POSSIBLE, and they are the actual repair: "This box / Configuration / Reach / Added by
         extensions" is four things to choose between, where twelve equal-weight words in a row is a search.
      3. ROWS BECOME LINKS. The strip was <button> + router.push, so twelve URL-addressable destinations: three
         of which the shell itself deep-links into: had no href, no middle-click and no copyable address.

     Mobile keeps the strip, unchanged. At phone width there is no column to put beside anything, and a
     scrolling row of pills is the idiom every mobile tab bar already uses; the failure above is a desktop
     failure, caused by a 56rem content cap that does not apply once the page is the whole screen. -->
<script setup lang="ts">
import { type IconName, type NavGroup, NavRail, Row, SegmentedControl, SplitView } from "@intentic/ui";
import { computed, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { badgeClass, badgeText } from "../core-views/viewBadge";
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
    /** Holds the unknown-slug redirect while the set is still filling in: a hub whose rows come from extension
     *  detect() cannot judge a deep link until the workspace facts have landed, and redirecting earlier would
     *  bounce a perfectly good one. Hubs with a fixed set leave it alone. */
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
    <!-- Wide because the index spends 14rem of it: at the 56rem default the body would be left narrower than it
         was before the column arrived. `scroll="page"` because a hub's body is a long FORM, not a document beside
         an index: Usage and Secrets both run past a screen, and clamping them would put a scrollbar inside a
         card inside a page. The rail sticks instead, which is how you leave the section you are in.

         Everything else (the shell, the header, the gap, the rail width, the page cap, the phone behaviour) is <SplitView>'s
         now. This component is what remains once the layout is shared: route ↔ slug, and nothing else. -->
    <SplitView :title="title" :description="description" scroll="page">
        <!-- Mobile keeps the strip. At phone width there is no column to put beside anything, and a scrolling row
             of pills is the idiom every mobile tab bar already uses; the width failure that killed the strip on
             desktop is caused by a content cap that does not apply once the page is the whole screen. -->
        <template #compact>
            <div class="scrollbar-thin overflow-x-auto border-b border-line-subtle pb-2">
                <SegmentedControl :model-value="activeSlug" :options="options" @update:model-value="select" />
            </div>
        </template>

        <template #rail>
            <NavRail aria-label="Sections" :groups="groups">
                <template #row="{ item: tab }">
                    <!-- <Row> is presentational by design and owns no router, so an internal-nav row wraps it:
                         which is what buys back the href the strip never had. -->
                    <RouterLink :key="tab.slug" :to="linkTo(tab.slug)" class="block">
                        <Row as="div" density="dense" :icon="tab.icon" :title="tab.label" :selected="tab.slug === activeSlug" class="rounded-lg">
                            <!-- A fact about the section, so it rides the row's #meta cluster. Same chip the
                                 rail's tiles wear, same tone table: a count here and a count there are the
                                 same claim and should not be two shades apart. -->
                            <template v-if="tab.badge !== undefined" #meta>
                                <span class="min-w-4 rounded-full px-1 text-center text-2xs font-semibold leading-4" :class="badgeClass(tab.badge)">
                                    <Icon v-if="tab.badge.mark !== undefined" :name="tab.badge.mark as IconName" />
                                    <template v-else>{{ badgeText(tab.badge) }}</template>
                                </span>
                            </template>
                        </Row>
                    </RouterLink>
                </template>
            </NavRail>
        </template>

        <template #detail><slot :slug="activeSlug" /></template>
    </SplitView>
</template>
