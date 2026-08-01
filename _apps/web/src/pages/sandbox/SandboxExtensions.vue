<script setup lang="ts">
import { extensionIdOf } from "@intentic/extension-api";
import type { ExtensionSummary } from "@intentic/sandbox-contract";
import { cmp, RowGroup, SearchBar, Segmented, StatusBadge } from "@intentic-app/ui";
import { computed, ref } from "vue";
import { type ExtensionEntry, useExtensionList } from "../../composables/extensions/useExtensionList";
import { errorMessage } from "../../composables/useAsyncAction";
import { reloadExtensions } from "../../extension-host/useExtensionHost";
import ExtensionRow from "./ExtensionRow.vue";

/* The Sandbox hub's "Extensions" tab: EVERY first-party and installed extension — the ones compiled into this
 * bundle, the ones baked into the sandbox image, and the git-installed capabilities — each with its on/off
 * switch. Install/remove happens on the Capabilities page like every other capability; this tab is the
 * management surface.
 *
 * IT IS A LIST OF SIXTEEN THINGS, AND GROWING, so it is built to be scanned rather than read. Three decisions
 * follow from that, and they are the design:
 *
 *  1. The nominal case is silent. An extension that is on and working carries no badge — the switch says it is
 *     on and the absence of anything else says it is fine. What is left in colour is only what deserves the
 *     eye: a load failure, an engines mismatch, an image/app version drift. Those also LEAVE the list, into a
 *     pinned group at the top, so "is anything wrong?" is answered without reading a single row.
 *  2. One line per extension. Version, commit, contribution counts, the consequences of switching it off and
 *     the settings form are all real, and all below the fold — a row expands into its full record. Before, the
 *     tab paid for that detail on every row at all times, which is what made sixteen extensions unreadable.
 *  3. Find beats scroll past a dozen. The filter box matches the id AND everything the extension contributes,
 *     so "github" finds the connectors extension and ".docx" finds viewers; the segmented control answers
 *     "which ones did I switch off?", which is otherwise invisible in an alphabetical list. */

const { entries, unlisted, setEnabled, isLoading, error } = useExtensionList();

// Below this many rows the list IS the overview: a filter box and a state switcher would be more chrome than
// the thing they filter. The threshold is a display choice, so it lives here rather than in the row model.
const FILTERABLE_FROM = 8;

const query = ref(``);
const mode = ref<`all` | `on` | `off`>(`all`);
// One row open at a time — the list must not grow unpredictably under the pointer while it is being scanned.
const opened = ref<string | undefined>(undefined);
const pending = ref<string | undefined>(undefined);
const toggleError = ref<string | undefined>(undefined);
const reloading = ref(false);

const filterable = computed(() => entries.value.length >= FILTERABLE_FROM);
const enabledCount = computed(() => entries.value.filter((entry) => entry.extension.enabled).length);

const matches = computed<ExtensionEntry[]>(() => {
    const needle = query.value.trim().toLowerCase();
    return entries.value.filter(
        (entry) => (mode.value === `all` || (mode.value === `on`) === entry.extension.enabled) && (needle === `` || entry.search.includes(needle)),
    );
});
const attention = computed(() => matches.value.filter((entry) => entry.state.attention));
const healthy = computed(() => matches.value.filter((entry) => !entry.state.attention));

/* What the main group says when it holds no rows of its own — three different facts, and the wrong one is a
 * lie the reader can see. An attention row IS a match, so a filter that hits only a broken extension empties
 * this group while a row sits visibly above it; "nothing matches" there would be flatly contradicted by the
 * screen. */
const emptyNote = computed<string | undefined>(() => {
    if (isLoading.value || healthy.value.length > 0) {
        return undefined;
    }
    if (entries.value.length === 0) {
        return `No extensions installed. Add one from the Capabilities page — install is owner-only and pins an exact commit.`;
    }
    if (attention.value.length > 0) {
        return `Nothing else to show — see the group above.`;
    }
    return `Nothing matches that filter.`;
});

const clearFilters = (): void => {
    query.value = ``;
    mode.value = `all`;
};

// Flip the switch, then converge the shell: the daemon has already stopped/started the extension's processes
// and dropped its contributions from every subsequent read, and reloadExtensions activates or retires it here
// without a page reload.
const toggle = async (extension: ExtensionSummary, enabled: boolean): Promise<void> => {
    pending.value = extension.id;
    toggleError.value = undefined;
    try {
        await setEnabled(extension.id, enabled);
        await reloadExtensions();
    } catch (failure) {
        toggleError.value = errorMessage(failure, `Could not ${enabled ? `enable` : `disable`} ${extensionIdOf(extension.manifest)}.`);
    } finally {
        pending.value = undefined;
    }
};

// The way out of "reload to load" — an extension installed after the host booted has no status until the host
// runs again, and re-running it is cheaper and less destructive than the page reload it used to take.
const reload = async (): Promise<void> => {
    reloading.value = true;
    toggleError.value = undefined;
    try {
        await reloadExtensions();
    } catch (failure) {
        toggleError.value = errorMessage(failure, `Could not reload the extension host.`);
    } finally {
        reloading.value = false;
    }
};
</script>

<template>
    <div class="flex flex-col gap-4">
        <p v-if="error" :class="cmp.alertDanger()">{{ error }}</p>
        <p v-if="toggleError" :class="cmp.alertDanger()">{{ toggleError }}</p>

        <!-- Only ever populated when something actually went wrong — see the note on decision 1 above. It sits
             ABOVE the filter bar deliberately: a broken extension is not something to have to search for. -->
        <RowGroup
            v-if="attention.length > 0"
            label="Needs attention"
            :count="attention.length"
            caption="loaded with a problem, or built against a different version"
        >
            <ExtensionRow
                v-for="entry in attention"
                :key="entry.extension.id"
                :entry="entry"
                :expanded="opened === entry.extension.id"
                :pending="pending === entry.extension.id"
                @toggle="(enabled) => toggle(entry.extension, enabled)"
                @update:expanded="(open) => (opened = open ? entry.extension.id : undefined)"
            />
        </RowGroup>

        <!-- The count is what this group HOLDS, not the total: rows leave for the attention group above and for
             the filter, and a header that kept claiming 14 over 13 rows is a header nobody trusts again. The
             running total stays visible on the segmented control's "All" badge. -->
        <RowGroup label="Extensions" :count="healthy.length">
            <template #actions>
                <template v-if="filterable">
                    <!-- SearchBar rather than a `cmp.input`, even here: it is the one field in this tab a phone
                         will focus, and its 16px-below-md rule is what stops iOS zooming the whole hub. The
                         border it deliberately lacks (it is normally a panel's first row) is this wrapper's. -->
                    <div class="w-40 overflow-hidden rounded-md border border-line bg-canvas sm:w-56">
                        <SearchBar v-model="query" placeholder="Name or contribution…" class="border-b-0" />
                    </div>
                    <Segmented
                        v-model="mode"
                        :options="[
                            { label: `All`, value: `all`, badge: entries.length },
                            { label: `On`, value: `on`, badge: enabledCount },
                            { label: `Off`, value: `off`, badge: entries.length - enabledCount },
                        ]"
                    />
                </template>
                <button type="button" :class="cmp.iconButton()" :disabled="reloading" v-tooltip.top="`Reload extensions`" @click="reload">
                    <Icon name="refresh" :spin="reloading" />
                </button>
            </template>
            <div v-if="isLoading" class="px-4 py-6 text-center text-xs text-muted">Reading this sandbox's extensions…</div>
            <div v-else-if="emptyNote !== undefined" class="flex flex-col items-center gap-2 px-4 py-6 text-center text-xs text-muted">
                <span>{{ emptyNote }}</span>
                <button v-if="matches.length === 0 && entries.length > 0" type="button" :class="cmp.buttonPrimary()" @click="clearFilters">
                    Clear filter
                </button>
            </div>
            <ExtensionRow
                v-for="entry in healthy"
                :key="entry.extension.id"
                :entry="entry"
                :expanded="opened === entry.extension.id"
                :pending="pending === entry.extension.id"
                @toggle="(enabled) => toggle(entry.extension, enabled)"
                @update:expanded="(open) => (opened = open ? entry.extension.id : undefined)"
            />
        </RowGroup>

        <!-- Running in this app build, absent from the daemon's list: no row to sit in, no switch to offer. -->
        <RowGroup v-if="unlisted.length > 0" label="Running but not listed" caption="compiled into this app build, unknown to the sandbox image">
            <div v-for="status in unlisted" :key="status.id" class="flex items-center justify-between gap-3 px-3 py-2">
                <div class="min-w-0">
                    <p class="truncate text-sm font-medium text-content">{{ status.extensionId }}</p>
                    <p v-if="status.detail" class="text-2xs text-warning">{{ status.detail }}</p>
                </div>
                <StatusBadge :variant="status.state === `error` ? `danger` : `warning`" :label="status.state" size="xs" />
            </div>
        </RowGroup>
    </div>
</template>
