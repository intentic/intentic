<script setup lang="ts">
import { extensionIdOf } from "@intentic/extension-manifest";
import { Button, ui, FilterBar, type NoticeModel, NoticeStack, SegmentedControl, timeAgo, vAction } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { startAgent } from "../../composables/agents/agentActions";
import { useExtensionList } from "../../composables/extensions/useExtensionList";
import { useExtensions } from "../../composables/extensions/useExtensions";
import { useRegistry } from "../../composables/extensions/useRegistry";
import { reloadExtensions } from "../../extension-host/useExtensionHost";
import { toListing, updateCount } from "./discoverListing";
import { extensionBrief } from "./extensionBrief";
import ExtensionsBrowse from "./ExtensionsBrowse.vue";
import ExtensionsInstalled from "./ExtensionsInstalled.vue";
import NewExtensionDialog from "./NewExtensionDialog.vue";

/* THE SANDBOX HUB'S "EXTENSIONS" SECTION: what this box has, and what other people have published, as two
 * pills over one search box.
 *
 * THEY USED TO BE TWO ROWS in the hub's index, Extensions and Discover, adjacent and described as adjacent on
 * purpose. Adjacency was the weaker form of the true thing: finding an extension, installing it, managing it
 * and switching it off are ONE subject, and splitting them across two index rows cost three specific things.
 *
 *  1. THE UPDATE STORY WAS CUT IN HALF. The badge (how many installed extensions the registry has a newer
 *     commit for) hung on Discover, while the "updates checked …" line and the host reload that finishes an
 *     update lived on Extensions. Following the badge landed the reader in a grid of OTHER people's extensions
 *     to resolve a fact about their own. Both are here now, on one surface, stated once.
 *  2. EACH HALF'S EMPTY STATE HAD TO POINT AT THE OTHER ROW. A surface for extensions that sends you elsewhere
 *     for extensions is exactly what the Discover work set out to end; it ended it for the Capabilities page
 *     and left one seam behind. Now the way out is the pill above, and the two halves cannot drift apart.
 *  3. ONE SEARCH, TWO LISTS. `query` lives HERE and is shared, so typing "invoices", finding nothing installed
 *     and switching to Browse keeps the word: "do I have it" and "has anyone published it" are one gesture.
 *
 * WHAT THE SECTION OWNS is the instrument: the pills, the search box, creating and reloading, and the
 * registry's freshness line. What each half owns is its own list, its own states and its own actions. The
 * mode rides the URL (`?view=browse`) rather than component state, next to Browse's own `?ext=` deep link,
 * so a reload and a pasted link both land where the reader was. */

const VIEWS = [`installed`, `browse`] as const;
type View = (typeof VIEWS)[number];

const route = useRoute();
const router = useRouter();

// `installed` is the param-less URL: the recurring visit is "what do I have", and browsing is the errand.
const view = computed<View>(() => (route.query[`view`] === `browse` ? `browse` : `installed`));
/* Switching halves drops `ext` with it: a listing panel is Browse's own state, and leaving its name in the
 * address while the installed list is on screen is a query param that silently does nothing. */
const show = (next: View): void => {
    void router.replace({ query: { ...route.query, view: next === `installed` ? undefined : next, ext: undefined } });
};

const { entries, create, checkUpdates, updatesCheckedAt, updatedSinceLoaded } = useExtensionList();
const { extensions } = useExtensions();
/* The registry read follows the pills: enabled while Browse is on screen, observed-but-not-caused otherwise,
 * so the update count below costs nothing on the installed half (see useRegistry's note on `read`). Reading
 * it here rather than only inside Browse is what lets the pill wear the count and the refresh button work. */
const { entries: listed, isFetching, refetch } = useRegistry({ read: computed(() => view.value === `browse`) });
const listings = computed(() => listed.value.map((entry) => toListing(entry, extensions.value)));
const updatable = computed(() => updateCount(listings.value));

// Below this many rows the list IS the overview: a filter box and a state switcher would be more chrome than
// the thing they filter. Per half, because a catalogue of six cards is already a wall and eight rows are not.
const FILTERABLE_FROM: Record<View, number> = { installed: 8, browse: 6 };

const query = ref(``);
const mode = ref<`all` | `on` | `off`>(`all`);
const trust = ref<`all` | `verified`>(`all`);
// What the half the reader is looking at left after the query: drawn on the field that did the narrowing.
const matched = ref(0);
// Whichever half is mounted raises its own failures here, so the section keeps ONE notice region.
const viewNotice = ref<NoticeModel | undefined>(undefined);

/* THE ONE FACT NEITHER HALF CAN STATE ALONE, and the clearest thing a shared search box buys: how many
 * PUBLISHED extensions match what the reader typed while looking at what they have. "Nothing matches that
 * filter" over an installed list is true and useless when somebody has published exactly that thing, and
 * before the merge there was no surface that knew both numbers. Deliberately ignoring the trust pills: the
 * offer is about the catalogue, and narrowing it here would make the offer disappear on a setting the reader
 * changed on the other half. Zero while the registry cache is cold, which is honest, nothing is known yet. */
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

/* THE PILLS. Both badges are inventories, "how many things are here", so they mean the same thing on both
 * pills; the update count is a MARK instead, because it is not the size of the list behind the pill and a
 * second number in the same chip shape would read as one. Its tooltip is the sentence, and the freshness line
 * at the foot of the section is the same fact in full. */
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

// The way out of "reload to load": an extension installed after the host booted has no status until the host
// runs again, and re-running it is cheaper and less destructive than the page reload it used to take.
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

/* An update landed while this browser kept running the old bundle: applied by the auto rung, another member,
 * or another tab. The daemon is already wholly on the new version; the prompt's button is the host reload this
 * section already owns, which is what finishes the update HERE. A notice rather than an auto-reload: yanking a
 * view out from under someone mid-use is the one part of "seamless" that isn't. */
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

// The comparison's honesty line: when it last ran, and the way to run it now, re-rendered with every refetch,
// which is exactly as fresh as the fact it states.
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
// The row a just-created extension opens on: passed down rather than reached into, so the dialog can live up
// here beside the button that opens it while the row it names belongs to the installed half.
const focused = ref<string | undefined>(undefined);
/* The new extension's row exists the moment the daemon answers, but nothing is RUNNING until the host runs
 * again, so creating it ends in the same reload this section already offers, and the row opens on arrival,
 * naming the directory its two files are in.
 *
 * If the author said what they wanted, that hands off to an agent as an ordinary chat: a new conversation with
 * the brief enqueued as a user message, so it lands in the transcript to be read, corrected and continued.
 * Deliberately not an isolated unattended run like the acceptance and maintenance surfaces start: those check
 * something against a rubric and report, while this is the first minute of authoring, where the author's own
 * "no, more like…" is the most valuable input there is and an isolated worktree would put it behind a landing. */
const created = async (extension: { id: string; dir: string; wish: string }): Promise<void> => {
    // Authoring is about what this box HAS, so the created row must not land behind the other pill.
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

        <!-- THE SECTION'S INSTRUMENT, not either half's. The pills lead because they say which list is being
             looked at; the search box takes the row's slack after them (one left edge and one right edge down
             the whole view), and each half's own narrowing rides `#controls` so the two read as one thing.
             Acting on the list, creating, reloading, re-reading the registry, stays chromeless beside them.

             Below the filterable threshold there is no field to grow, so a spacer keeps the buttons at the
             right edge rather than letting them slide in beside the pills. -->
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
                <!-- Suppressed while nothing is verified: a filter that can only ever empty the page is a
                     control that lies about the catalogue. -->
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

            <!-- Authoring sits beside reloading rather than in a section header for the same reason the filter
                 does: it acts on the whole surface, not on any one group. It is a labelled button and not a
                 third icon because it is the only control here that CREATES something: the others narrow or
                 refresh a list that already exists, and none of them leaves a directory behind. -->
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

        <!-- THE REGISTRY COMPARISON'S HONESTY LINE, and the one row of this section that used to be split
             across two index rows: how many installed extensions have a newer listed commit, when that was
             last checked, and the two ways to act on it, all in the same sentence. Absent until the first
             check has run: a blank claim is worse than none. -->
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
