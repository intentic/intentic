<!-- Shared shell for a hub page — title, section index, and the active section's body — used by the sandbox hub and settings hub. -->
<script setup lang="ts">
import { type IconName, type NavGroup, NavRail, providePageBack, Row, SegmentedControl, SplitView, useDevice, usePageBack } from "@intentic/ui";
import { sectionIcon } from "@intentic/ui/icons";
import { computed, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { badgeSpeaks } from "../views/viewBadge";
import { hubDrills, hubSectionParam } from "./hubDrill";
import type { HubTab } from "./hubNav";
import HubIndex from "./HubIndex.vue";
import HubRowBadge from "./HubRowBadge.vue";
import { hubWorkKey, provideHubSection } from "./hubWork";
import { useT } from "@intentic/ui/i18n";

const t = useT();

const {
    title,
    description,
    groups,
    routeName,
    defaultSlug,
    addressable = false,
    ready = true,
} = defineProps<{
    title: string;
    description?: string;
    /** The named route the sections live on: `/<path>/:tab?`. */
    routeName: string;
    /** The section the param-less URL shows. Its row writes no param, so no section has two URLs. */
    defaultSlug: string;
    /**
     * Whether every row must name its own slug, param-less form included. Set when the param-less URL is not one this
     * reader may stand on — a guest's hub root is a path the shell fence sends it home from, so the one row it has
     * would otherwise link somewhere it is bounced off.
     */
    addressable?: boolean;
    groups: readonly NavGroup<HubTab>[];
    /** Holds the unknown-slug redirect while the set is still filling in. */
    ready?: boolean;
}>();

const route = useRoute();
const router = useRouter();

const tabs = computed<readonly HubTab[]>(() => groups.flatMap((group) => group.items));
const slugs = computed<readonly string[]>(() => tabs.value.map((tab) => tab.slug));

// The section the address names, if it names one: the param-less URL is the default section on a desktop and the
// index itself on a phone.
const named = computed<string | undefined>(() => {
    const tab = route.params[`tab`];
    return typeof tab === `string` && tab.length > 0 ? tab : undefined;
});

const activeSlug = computed<string>(() => {
    const tab = named.value;
    if (tab === undefined) {
        return defaultSlug;
    }
    // Unknown while the set is still filling means unknown YET: falling back would draw one section and swap it for
    // another under the reader — the same reason the redirect below waits for `ready`.
    return slugs.value.includes(tab) || !ready ? tab : defaultSlug;
});

// A PHONE DRILLS DOWN: the hub's root is its index, and a section is a page of its own with a way back to it. The
// strip this replaced wrapped every section into a cloud of pills above every page (seventeen on a sandbox with
// extensions), which put the whole index between the reader and the page they had already picked. A reader who may
// not stand on the root (a guest, `addressable`) or a hub of one section has no index worth a page of its own.
const { mobile } = useDevice();
const drill = computed(() => hubDrills(mobile.value, addressable, tabs.value.length));
const onIndex = computed(() => drill.value && named.value === undefined);

// Drilling names every section, the default one included: its param-less URL is the index there.
const linkTo = (slug: string) => ({ name: routeName, params: { tab: hubSectionParam(slug, defaultSlug, addressable || drill.value) } });
const indexLink = { name: routeName, params: { tab: undefined } };

// A drilled section wears its own name; the hub's moves to the way back.
const activeLabel = computed(() => tabs.value.find((tab) => tab.slug === activeSlug.value)?.label);
const pageTitle = computed(() => (drill.value && !onIndex.value ? (activeLabel.value ?? title) : title));
const pageDescription = computed(() => (drill.value && !onIndex.value ? undefined : description));

// Back from a section is back to the index: a step back when that is where the reader came from, so history holds no
// loop, and a replace otherwise (a link from a chat straight into a section), so the index's own way back still leads
// to wherever they were before.
const backToIndex = (): void => {
    if (router.options.history.state[`back`] === router.resolve(indexLink).fullPath) {
        router.back();
        return;
    }
    void router.replace(indexLink);
};
const shellBack = usePageBack();
providePageBack(
    computed(() => (drill.value && !onIndex.value ? { label: t(`shell.hubLayout.backTo`, { title }), go: backToIndex } : shellBack.value)),
);

// The address the section on screen reports its long-running work under, so no view has to be told which row it
// lives on. The hub draws the mark; what it says comes back through this hub's own badges.
provideHubSection(computed(() => hubWorkKey(routeName, activeSlug.value)));

// The strip is a control, not a link, so it navigates by hand.
const select = (slug: string): void => {
    void router.push(linkTo(slug));
};

// The strip flattens the groups away: it has no headings, which is why it is only the answer for a desktop pane too
// narrow for the rail: the grouping this component exists to show is exactly what does not survive the trip.
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

// An unknown slug (/sandbox/nonsense) resolves to the default: clean the URL back to the canonical one, which on a
// phone is the index.
watch(
    [() => route.params[`tab`], slugs, () => ready],
    ([tab, known, settled]) => {
        if (settled && typeof tab === `string` && tab.length > 0 && !known.includes(tab)) {
            void router.replace(drill.value ? indexLink : linkTo(defaultSlug));
        }
    },
    { immediate: true },
);
</script>

<template>
    <!-- Wide because the index spends 14rem of it: at the 56rem default the body would be left narrower than it was before the column arrived. -->
    <!-- A phone swaps: the index or one section, never both on screen (see `drill`). -->
    <SplitView :title="pageTitle" :description="pageDescription" scroll="page" :mobile="drill ? `swap` : `collapse`" :detail-open="!onIndex">
        <!-- A desktop pane too narrow for the rail keeps the strip. It wraps rather than scrolls: this is the index of everything the hub holds, and a section a reader can't see is a section they won't look for. -->
        <template v-if="!drill" #compact>
            <div class="border-b border-line-subtle pb-2">
                <SegmentedControl :model-value="activeSlug" :options="options" wrap @update:model-value="select" />
            </div>
        </template>

        <template #rail>
            <HubIndex v-if="drill" :groups="groups" :link-to="linkTo" />
            <NavRail v-else :aria-label="t(`shell.hubLayout.sections`)" :groups="groups">
                <template #row="{ item: tab }">
                    <!-- Internal navigation wraps the presentational row to provide its href. -->
                    <RouterLink :key="tab.slug" :to="linkTo(tab.slug)" class="block">
                        <Row
                            as="div"
                            density="dense"
                            :icon="sectionIcon(tab.slug, tab.icon)"
                            :title="tab.label"
                            :selected="tab.slug === activeSlug"
                            class="rounded-lg"
                        >
                            <!-- A fact about the section, so it rides the row's #meta cluster. -->
                            <!-- The test stays out here, unlike the corner badges, because `#meta` is a slot Row only draws when it is filled. -->
                            <template v-if="tab.badge !== undefined && badgeSpeaks(tab.badge)" #meta>
                                <HubRowBadge :badge="tab.badge" />
                            </template>
                        </Row>
                    </RouterLink>
                </template>
            </NavRail>
        </template>

        <!-- Nothing mounts under the index: a section is a page a phone goes to, not one it keeps under the list. -->
        <template #detail><slot v-if="!onIndex" :slug="activeSlug" /></template>
    </SplitView>
</template>
