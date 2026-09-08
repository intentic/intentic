<script setup lang="ts">
import { extensionIdOf } from "@intentic/extension-manifest";
import { Button, ui, FilterBar, type NoticeModel, NoticeStack, SegmentedControl, timeAgo, vAction } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { startAgent } from "../../agents/fleet/agentActions";
import { useExtensionList } from "../../extensions/useExtensionList";
import { useExtensions } from "../../extensions/useExtensions";
import { useRegistry } from "../../extensions/useRegistry";
import { reloadExtensions } from "../../../extension-host/useExtensionHost";
import { toListing, updateCount } from "./discoverListing";
import { extensionBrief } from "./extensionBrief";
import ExtensionsBrowse from "./ExtensionsBrowse.vue";
import ExtensionsInstalled from "./ExtensionsInstalled.vue";
import NewExtensionDialog from "./NewExtensionDialog.vue";

// The sandbox hub's Extensions section: installed and published listings as two pills over one shared search box,
// previously two separate index rows. The mode rides the URL (`?view=browse`) rather than component state, so a
// reload or pasted link lands on the same view.

const VIEWS = [`installed`, `browse`] as const;
type View = (typeof VIEWS)[number];

const route = useRoute();
const router = useRouter();

// `installed` is the param-less URL: the recurring visit is what's installed; browsing is the errand.
const view = computed<View>(() => (route.query[`view`] === `browse` ? `browse` : `installed`));
// Switching views drops `ext`: it's Browse's own deep-link state, useless while the installed list is shown.
const show = (next: View): void => {
    void router.replace({ query: { ...route.query, view: next === `installed` ? undefined : next, ext: undefined } });
};

const { entries, create, checkUpdates, updatesCheckedAt, updatedSinceLoaded } = useExtensionList();
const { extensions } = useExtensions();
// Reads the registry only while Browse is shown; the update count then costs nothing on the installed view.
const { entries: listed, isFetching, refetch } = useRegistry({ read: computed(() => view.value === `browse`) });
const listings = computed(() => listed.value.map((entry) => toListing(entry, extensions.value)));
const updatable = computed(() => updateCount(listings.value));

// Below this many rows a filter box would be more chrome than the list itself; the threshold differs per view.
const FILTERABLE_FROM: Record<View, number> = { installed: 8, browse: 6 };

const query = ref(``);
const mode = ref<`all` | `on` | `off`>(`all`);
const trust = ref<`all` | `verified`>(`all`);
// How many rows the current view's filter left, drawn on the field that did the narrowing.
const matched = ref(0);
// Whichever view is mounted raises its failures here, keeping one notice region for the section.
const viewNotice = ref<NoticeModel | undefined>(undefined);

// How many published listings match the query, ignoring the trust pills; zero while the registry cache is cold.
const publishedMatches = computed(() => {
    const needle = query.value.trim().toLowerCase();
    return needle === `` ? 0 : listings.value.filter((listing) => listing.search.includes(needle)).length;
});

const total = computed(() => (view.value === `installed` ? entries.value.length : listings.value.length));
const filterable = computed(() => total.value >= FILTERABLE_FROM[view.value]);
const enabledCount = computed(() => entries.value.filter((entry) => entry.extension.enabled).length);
const verifiedCount = computed(() => listings.value.filter((listing) => listing.entry.trust === `verified`).length);

const clearFilters = (): void => {
    query.value = ``;
    mode.value = `all`;
    trust.value = `all`;
};

// Both counts are inventories; the update count is a mark instead, since it isn't the size of either list.
const viewOptions = computed(() => [
    { label: `Installed`, value: `installed` as View, badge: entries.value.length },
    {
        label: `Browse`,
        value: `browse` as View,
        badge: listings.value.length,
        ...(updatable.value > 0
            ? {
                  mark: `arrow-circle-up` as const,
                  markTitle: `${updatable.value} installed ${updatable.value === 1 ? `extension has` : `extensions have`} a newer listed commit`,
              }
            : {}),
    },
]);

// Re-runs the extension host so a newly installed extension gets picked up, cheaper than a full page reload.
const reloading = ref(false);
const reload = async (): Promise<void> => {
    reloading.value = true;
    viewNotice.value = undefined;
    try {
        await reloadExtensions();
    } catch (failure) {
        viewNotice.value = noticeFrom(failure, `Could not reload the extension host.`);
    } finally {
        reloading.value = false;
    }
};

// An update landed elsewhere while this tab still runs the old bundle; the button here is the same host reload,
// shown as a notice rather than auto-reloading since replacing the view mid-use is unwanted.
const staleNotice = computed<NoticeModel | undefined>(() => {
    if (updatedSinceLoaded.value.length === 0) {
        return undefined;
    }
    const names = updatedSinceLoaded.value.map((extension) => extensionIdOf(extension.manifest)).join(`, `);
    const plural = updatedSinceLoaded.value.length === 1 ? `was` : `were`;
    return {
        tone: `info`,
        title: `Reload to finish updating.`,
        detail: `${names} ${plural} updated, this browser is still running the previous code until the extensions reload.`,
        action: { label: `Reload now`, run: () => void reload() },
    };
});

// States when updates were last checked, re-rendered on every refetch so it stays as fresh as the check.
const checking = ref(false);
const checkNow = async (): Promise<void> => {
    checking.value = true;
    viewNotice.value = undefined;
    try {
        await checkUpdates();
    } catch (failure) {
        viewNotice.value = noticeFrom(failure, `Could not check the registry for updates.`);
    } finally {
        checking.value = false;
    }
};

const creating = ref(false);
// The row a newly created extension opens on, passed down to the installed half rather than reached into.
const focused = ref<string | undefined>(undefined);
// Reloads the extension host so the new extension actually runs, then opens on its row; a wish hands off to an
// ordinary agent chat, not an isolated run, since a first draft benefits from the author's corrections.
const created = async (extension: { id: string; dir: string; wish: string }): Promise<void> => {
    // Switches to the installed view so the newly created row isn't hidden behind the other pill.
    if (view.value !== `installed`) {
        show(`installed`);
    }
    focused.value = extension.id;
    await reload();
    if (extension.wish !== ``) {
        startAgent(extensionBrief(extension));
    }
};
</script>

<template>
    <div class="flex flex-col gap-5">
        <NoticeStack :of="[viewNotice, staleNotice]" />

        <!--
            The section's instrument, not either half's: pills lead, the search box takes the row's slack, and filters ride
            #controls. Below the filterable threshold a spacer keeps the buttons at the right edge.
        -->
        <div class="flex flex-wrap items-center gap-2">
            <SegmentedControl :model-value="view" :options="viewOptions" @update:model-value="show" />

            <FilterBar
                v-if="filterable"
                v-model="query"
                :placeholder="view === `installed` ? `Name or contribution…` : `Name, publisher, what it does…`"
                :count="matched"
                :aria-label="view === `installed` ? `Filter installed extensions` : `Search published extensions`"
                class="flex-1"
            >
                <template v-if="view === `installed`" #controls>
                    <SegmentedControl
                        v-model="mode"
                        :options="[
                            { label: `All`, value: `all`, badge: entries.length },
                            { label: `On`, value: `on`, badge: enabledCount },
                            { label: `Off`, value: `off`, badge: entries.length - enabledCount },
                        ]"
                    />
                </template>
                <!-- Hidden while nothing is verified: a filter that could only empty the page misrepresents the catalogue. -->
                <template v-else-if="verifiedCount > 0" #controls>
                    <SegmentedControl
                        v-model="trust"
                        :options="[
                            { label: `All`, value: `all`, badge: listings.length },
                            { label: `Verified`, value: `verified`, badge: verifiedCount },
                        ]"
                    />
                </template>
            </FilterBar>
            <div v-else class="flex-1"></div>

            <!-- A labelled button, not an icon: it creates something, unlike the others which only narrow or refresh. -->
            <template v-if="view === `installed`">
                <Button label="New extension" size="small" @click="creating = true">
                    <template #icon><Icon name="plus" /></template>
                </Button>
                <button type="button" :class="ui.iconButton(`h-8 w-8`)" :disabled="reloading" v-tooltip.top="`Reload extensions`" v-action="reload">
                    <Icon name="refresh" :spin="reloading" />
                </button>
            </template>
            <button
                v-else
                type="button"
                :class="ui.iconButton(`h-8 w-8`)"
                :disabled="isFetching"
                v-tooltip.top="`Re-read the registry`"
                @click="refetch"
            >
                <Icon name="refresh" :spin="isFetching" />
            </button>
        </div>

        <NewExtensionDialog v-model="creating" :create="create" @created="created" />

        <ExtensionsInstalled
            v-if="view === `installed`"
            :query="query"
            :mode="mode"
            :focus="focused"
            :published-matches="publishedMatches"
            @notice="viewNotice = $event"
            @matched="matched = $event"
            @browse="show(`browse`)"
            @clear="clearFilters"
        />
        <ExtensionsBrowse v-else :query="query" :trust="trust" @notice="viewNotice = $event" @matched="matched = $event" @clear="clearFilters" />

        <!-- How many installed extensions have a newer commit and when that was checked; absent until first check runs. -->
        <p v-if="updatesCheckedAt !== undefined" class="text-right text-2xs text-subtle">
            <template v-if="updatable > 0">
                <button v-if="view === `installed`" type="button" :class="ui.linkButton(`text-2xs`)" @click="show(`browse`)">
                    {{ updatable }} {{ updatable === 1 ? `update` : `updates` }} to install
                </button>
                <span v-else class="text-content">{{ updatable }} {{ updatable === 1 ? `update` : `updates` }} to install</span>
                ·
            </template>
            Updates checked {{ timeAgo(Date.parse(updatesCheckedAt)) }} ·
            <button type="button" :class="ui.linkButton(`text-2xs`)" :disabled="checking" v-action="checkNow">
                {{ checking ? `Checking…` : `Check now` }}
            </button>
        </p>
    </div>
</template>
