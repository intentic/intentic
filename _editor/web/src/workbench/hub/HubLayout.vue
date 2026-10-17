<!-- Shared shell for a hub page — title, section index, and the active section's body — used by the sandbox hub and settings hub. -->
<script setup lang="ts">
import { type IconName, type NavGroup, NavRail, providePageBack, Row, SegmentedControl, SplitView, useDevice, usePageBack } from "@intentic/ui";
import { sectionIcon } from "@intentic/ui/icons";
import { computed, useId, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { badgeSpeaks } from "../views/viewBadge";
import { hubDrills, hubSectionParam } from "./hubDrill";
import { type HubTab, hubRowOf, hubRowSections } from "./hubNav";
import HubIndex from "./HubIndex.vue";
import HubRowBadge from "./HubRowBadge.vue";
import { hubWorkKey, provideHubSection } from "./hubWork";
import { settingOfHash } from "./hubSearch";
import HubSearchField from "./HubSearchField.vue";
import HubSearchResults from "./HubSearchResults.vue";
import { seekSetting } from "./settingAnchor";
import type { HubSearchPanel } from "./useHubSearchPanel";
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
    search,
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
    /**
     * The hub's search over both hubs' pages and settings (useHubSearchPanel.ts), drawn above the index; while
     * something is typed its answers stand in the index's place. Made by the hub, so this stays a layout.
     */
    search?: HubSearchPanel;
}>();

const route = useRoute();
const router = useRouter();

// The index's rows, and the sections behind them: a row with parts is one row in the index and a section per part,
// each at an address of its own.
const rows = computed<readonly HubTab[]>(() => groups.flatMap((group) => group.items));
const tabs = computed<readonly HubTab[]>(() => rows.value.flatMap(hubRowSections));
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
const drill = computed(() => hubDrills(mobile.value, addressable, rows.value.length));
const onIndex = computed(() => drill.value && named.value === undefined);

// Drilling names every section, the default one included: its param-less URL is the index there.
const linkTo = (slug: string) => ({ name: routeName, params: { tab: hubSectionParam(slug, defaultSlug, addressable || drill.value) } });
const indexLink = { name: routeName, params: { tab: undefined } };
// A row with parts opens its first; it is current while any of them is open, whichever the reader went to.
const rowLink = (row: HubTab) => linkTo(hubRowSections(row)[0]?.slug ?? row.slug);
const activeRow = computed<HubTab | undefined>(() => hubRowOf(rows.value, activeSlug.value));

// The tabs above a section whose row stands for several: the row's parts, in its order. A row down to one part (the
// rest withheld from this reader) draws none, since a single tab switches to nothing.
const parts = computed<readonly HubTab[]>(() => activeRow.value?.parts ?? []);

// A drilled section wears its row's name (a part's own is the tab under it); the hub's moves to the way back.
const activeLabel = computed(() => activeRow.value?.label);
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

// The strip and the tabs are controls, not links, so they navigate by hand.
const select = (slug: string): void => {
    void router.push(linkTo(slug));
};
const selectRow = (slug: string): void => {
    const row = rows.value.find((entry) => entry.slug === slug);
    if (row !== undefined) {
        void router.push(rowLink(row));
    }
};

// The strip flattens the groups away: it has no headings, which is why it is only the answer for a desktop pane too
// narrow for the rail: the grouping this component exists to show is exactly what does not survive the trip.
// A section's own mark keeps the chip; a run takes it only where there is none, turning, and says what it is in the
// pill's title — the strip has no second corner to put it in.
// A row with parts is one pill, as it is one row: its tabs are drawn above the section either way.
const optionOf = (tab: HubTab) => {
    const running = tab.badge?.running;
    return {
        label: tab.label,
        value: tab.slug,
        badge: tab.badge?.count,
        mark: (tab.badge?.mark ?? (running === undefined ? undefined : `spinner`)) as IconName | undefined,
        markSpin: tab.badge?.mark === undefined && running !== undefined,
        ...(running === undefined ? {} : { markTitle: running }),
    };
};
const options = computed(() => rows.value.map(optionOf));
const partOptions = computed(() => parts.value.map(optionOf));

// An address that names a card (`#setting-<id>`, a search answer or a link to one) lands on it once the section has
// drawn it: the router's own scroll gives up while the section is still reading what it shows (settingAnchor.ts).
watch(
    () => route.hash,
    (hash) => {
        const setting = settingOfHash(hash);
        if (setting !== undefined) {
            void seekSetting(setting);
        }
    },
    { immediate: true },
);

const searchList = useId();
const searching = computed(() => search?.searching.value === true);

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
            <div class="flex flex-col gap-2 border-b border-line-subtle pb-2">
                <HubSearchField v-if="search" :search="search" :list-id="searchList" />
                <HubSearchResults v-if="search && searching" :search="search" :list-id="searchList" look="rail" />
                <SegmentedControl v-else :model-value="activeRow?.slug ?? activeSlug" :options="options" wrap @update:model-value="selectRow" />
            </div>
        </template>

        <template #rail>
            <div v-if="drill" class="flex flex-col gap-4">
                <HubSearchField v-if="search" :search="search" :list-id="searchList" />
                <HubSearchResults v-if="search && searching" :search="search" :list-id="searchList" look="page" />
                <HubIndex v-else :groups="groups" :link-to="rowLink" />
            </div>
            <!-- While a search is typed the rail's groups give way to its answers, drawn where the rail draws an empty index; the field stays pinned, so typing never loses it. -->
            <NavRail v-else :aria-label="t(`shell.hubLayout.sections`)" :groups="searching ? [] : groups">
                <template v-if="search" #pinned>
                    <HubSearchField :search="search" :list-id="searchList" />
                </template>
                <template v-if="search && searching" #empty>
                    <HubSearchResults :search="search" :list-id="searchList" look="rail" />
                </template>
                <template #row="{ item: tab }">
                    <!-- Internal navigation wraps the presentational row to provide its href. -->
                    <RouterLink :key="tab.slug" :to="rowLink(tab)" class="block">
                        <Row
                            as="div"
                            density="dense"
                            :icon="sectionIcon(tab.slug, tab.icon)"
                            :title="tab.label"
                            :selected="tab.slug === activeRow?.slug"
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
        <template #detail>
            <template v-if="!onIndex">
                <!-- A row standing for several sections: its parts as tabs, underlined since they say what the pane is, then the one open. -->
                <div v-if="partOptions.length > 1" class="flex flex-col gap-6">
                    <SegmentedControl
                        :model-value="activeSlug"
                        :options="partOptions"
                        variant="underline"
                        wrap
                        :aria-label="activeRow?.label"
                        @update:model-value="select"
                    />
                    <slot :slug="activeSlug" />
                </div>
                <slot v-else :slug="activeSlug" />
            </template>
        </template>
    </SplitView>
</template>
