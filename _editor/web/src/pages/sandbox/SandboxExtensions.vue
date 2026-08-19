<script setup lang="ts">
import Button from "primevue/button";
import { extensionIdOf } from "@intentic/extension-manifest";
import type { ExtensionSummary } from "@intentic/sandbox-contract";
import { ui, FilterBar, Notice, type NoticeModel, NoticeStack, RowGroup, SegmentedControl, SkeletonRows, StatusBadge, timeAgo } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { computed, ref } from "vue";
import { startAgent } from "../../composables/agents/agentActions";
import { type ExtensionSection, sectionsOf } from "../../composables/extensions/extensionCategories";
import { useExtensionList } from "../../composables/extensions/useExtensionList";
import { useSandboxOutline } from "../../composables/sandbox/useSandboxOutline";
import { reloadExtensions } from "../../extension-host/useExtensionHost";
import ExtensionRow from "./ExtensionRow.vue";
import { extensionBrief } from "./extensionBrief";
import NewExtensionDialog from "./NewExtensionDialog.vue";

/* The Sandbox hub's "Extensions" tab: EVERY first-party and installed extension — the ones compiled into this
 * bundle, the ones baked into the sandbox image, the git-installed capabilities, and the workspace extensions
 * living under .intentic/config/workspace-extensions/ — each with its on/off switch. Install/remove happens on the
 * Capabilities page like every other capability (a workspace extension is instead created and deleted as files,
 * typically by an agent); this tab is the management surface.
 *
 * IT IS A LIST OF SEVENTEEN THINGS, AND GROWING, so it is built to be scanned rather than read. Four decisions
 * follow from that, and they are the design:
 *
 *  1. The nominal case is silent. An extension that is on and working carries no badge — the switch says it is
 *     on and the absence of anything else says it is fine. What is left in colour is only what deserves the
 *     eye: a load failure, an engines mismatch, an image/app version drift. Those also LEAVE their section,
 *     into a pinned group at the top, so "is anything wrong?" is answered without reading a single row.
 *  2. One line per extension. Version, commit, contribution counts, the consequences of switching it off and
 *     the settings form are all real, and all below the fold — a row expands into its full record. Before, the
 *     tab paid for that detail on every row at all times, which is what made seventeen extensions unreadable.
 *  3. Find beats scroll past a dozen. The filter box matches the id AND everything the extension contributes,
 *     so "github" finds the connectors extension and ".docx" finds viewers; the segmented control answers
 *     "which ones did I switch off?", which is otherwise invisible in an alphabetical list.
 *  4. Sections by PURPOSE, declared in the manifest (see extensionCategories.ts). One alphabetical run of
 *     seventeen names asks the reader to know what each one is before they can find the one they want; five
 *     headings turn the same list into five short ones, and the heading is what a reader arrives with —
 *     "the CI thing", "whatever talks to Discord". The filter and the switcher moved OUT of a group header
 *     and above the sections for it: they narrow the whole tab, and each section is now only a part of it. */

const { entries, invalid, unlisted, setEnabled, create, checkUpdates, updatesCheckedAt, updatedSinceLoaded, isLoading, error } = useExtensionList();
const outline = useSandboxOutline(isLoading);
// The list query's own message, in the words of the page that asked for it.
const listNotice = computed<NoticeModel | undefined>(() =>
    error.value === undefined ? undefined : { tone: `danger`, title: `Couldn't list this sandbox's extensions.`, detail: error.value },
);

// Below this many rows the list IS the overview: a filter box and a state switcher would be more chrome than
// the thing they filter. The threshold is a display choice, so it lives here rather than in the row model.
const FILTERABLE_FROM = 8;

const query = ref(``);
const mode = ref<`all` | `on` | `off`>(`all`);
// One row open at a time — the list must not grow unpredictably under the pointer while it is being scanned.
const opened = ref<string | undefined>(undefined);
const pending = ref<string | undefined>(undefined);
const toggleError = ref<NoticeModel | undefined>(undefined);
const reloading = ref(false);

const filterable = computed(() => entries.value.length >= FILTERABLE_FROM);
const enabledCount = computed(() => entries.value.filter((entry) => entry.extension.enabled).length);

const matches = computed(() => {
    const needle = query.value.trim().toLowerCase();
    return entries.value.filter(
        (entry) => (mode.value === `all` || (mode.value === `on`) === entry.extension.enabled) && (needle === `` || entry.search.includes(needle)),
    );
});
const attention = computed(() => matches.value.filter((entry) => entry.state.attention));
const healthy = computed(() => matches.value.filter((entry) => !entry.state.attention));

/* One list of sections, rendered by one loop. The exception group is a section like the others because it
 * behaves like one — a heading over rows — and pinning it first is the whole of its specialness. It overrides
 * the purpose taxonomy rather than sitting inside it: a broken extension is not something to find under the
 * heading you'd have looked for it under on a good day. */
const sections = computed<ExtensionSection[]>(() => [
    ...(attention.value.length === 0
        ? []
        : [
              {
                  id: `attention`,
                  label: `Needs attention`,
                  caption: `loaded with a problem, or built against a different version`,
                  entries: attention.value,
              },
          ]),
    ...sectionsOf(healthy.value),
]);

/* What the tab says when the sections hold no rows of their own — three different facts, and the wrong one is a
 * lie the reader can see. An attention row IS a match, so a filter that hits only a broken extension leaves the
 * purpose sections empty while a row sits visibly above them; "nothing matches" there would be flatly
 * contradicted by the screen. */
const emptyNote = computed<string | undefined>(() => {
    if (isLoading.value || healthy.value.length > 0) {
        return undefined;
    }
    if (entries.value.length === 0) {
        // The row beneath this tab, not another page. A surface for extensions whose empty state sends the
        // reader somewhere else to get extensions is the reason Discover exists.
        return `Nothing installed yet.`;
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
        toggleError.value = noticeFrom(failure, `Could not ${enabled ? `enable` : `disable`} ${extensionIdOf(extension.manifest)}.`);
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
        toggleError.value = noticeFrom(failure, `Could not reload the extension host.`);
    } finally {
        reloading.value = false;
    }
};

/* An update landed while this browser kept running the old bundle — applied by the auto rung, another member,
 * or another tab. The daemon is already wholly on the new version; the prompt's button is the host reload the
 * tab already owns, which is what finishes the update HERE. A notice rather than an auto-reload: yanking a
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
        detail: `${names} ${plural} updated — this browser is still running the previous code until the extensions reload.`,
        action: { label: `Reload now`, run: () => void reload() },
    };
});

// The comparison's honesty line: when it last ran, and the way to run it now — re-rendered with every refetch,
// which is exactly as fresh as the fact it states.
const checking = ref(false);
const checkNow = async (): Promise<void> => {
    checking.value = true;
    toggleError.value = undefined;
    try {
        await checkUpdates();
    } catch (failure) {
        toggleError.value = noticeFrom(failure, `Could not check the registry for updates.`);
    } finally {
        checking.value = false;
    }
};

const creating = ref(false);
/* The new extension's row exists the moment the daemon answers, but nothing is RUNNING until the host runs again
 * — so creating it ends in the same reload the tab already offers, and the row opens on arrival, naming the
 * directory its two files are in.
 *
 * If the author said what they wanted, that hands off to an agent as an ordinary chat: a new conversation with
 * the brief enqueued as a user message, so it lands in the transcript to be read, corrected and continued.
 * Deliberately not an isolated unattended run like the acceptance and maintenance surfaces start — those check
 * something against a rubric and report, while this is the first minute of authoring, where the author's own
 * "no, more like…" is the most valuable input there is and an isolated worktree would put it behind a landing. */
const created = async (extension: { id: string; dir: string; wish: string }): Promise<void> => {
    opened.value = extension.id;
    await reload();
    if (extension.wish !== ``) {
        startAgent(extensionBrief(extension));
    }
};
</script>

<template>
    <div class="flex flex-col gap-5">
        <NoticeStack :of="[listNotice, toggleError, staleNotice]" />

        <!-- The tab's instrument, not any one section's. This row's layout reasoning became <FilterBar>'s: the
             filter and the state switcher narrow every section below and read as one instrument, while reloading
             the host does not and stays chromeless beside them. No heading on the left — the hub's own tab
             already says "Extensions", and the running total is on the "All" pill.

             Below the filterable threshold there is no field to grow, so the lone reload button sits alone on
             the right rather than under an empty track. -->
        <div class="flex flex-wrap items-center justify-end gap-2">
            <FilterBar v-if="filterable" v-model="query" placeholder="Name or contribution…" class="flex-1">
                <template #controls>
                    <SegmentedControl
                        v-model="mode"
                        :options="[
                            { label: `All`, value: `all`, badge: entries.length },
                            { label: `On`, value: `on`, badge: enabledCount },
                            { label: `Off`, value: `off`, badge: entries.length - enabledCount },
                        ]"
                    />
                </template>
            </FilterBar>
            <!-- Authoring sits beside reloading rather than in a section header for the same reason the filter
                 does: it acts on the tab, not on any one group. It is a labelled button and not a third icon
                 because it is the only control here that CREATES something — the others narrow or refresh a list
                 that already exists, and none of them leaves a directory behind. -->
            <Button label="New extension" size="small" @click="creating = true">
                <template #icon><Icon name="plus" /></template>
            </Button>
            <button type="button" :class="ui.iconButton(`h-8 w-8`)" :disabled="reloading" v-tooltip.top="`Reload extensions`" @click="reload">
                <Icon name="refresh" :spin="reloading" />
            </button>
        </div>

        <NewExtensionDialog v-model="creating" :create="create" @created="created" />

        <!-- Each count is what its section HOLDS, not the total: rows leave for the pinned group above and for
             the filter, and a header that kept claiming 17 over 13 rows is a header nobody trusts again. -->
        <RowGroup v-for="section in sections" :key="section.id" :label="section.label" :count="section.entries.length" :caption="section.caption">
            <ExtensionRow
                v-for="entry in section.entries"
                :key="entry.extension.id"
                :entry="entry"
                :expanded="opened === entry.extension.id"
                :pending="pending === entry.extension.id"
                @toggle="(enabled) => toggle(entry.extension, enabled)"
                @update:expanded="(open) => (opened = open ? entry.extension.id : undefined)"
            />
        </RowGroup>

        <!-- `sections` is empty while the read is out, so the groups above render nothing and this is the only
             thing on the tab. The outline gives it the shape of the list instead of a sentence about it. -->
        <template v-if="isLoading">
            <RowGroup v-if="outline" label="Installed">
                <div role="status" aria-busy="true">
                    <span class="sr-only">Reading this sandbox's extensions…</span>
                    <SkeletonRows :rows="3" description control />
                </div>
            </RowGroup>
        </template>
        <div v-else-if="emptyNote !== undefined" :class="ui.emptyState(`flex flex-col items-center gap-2 py-6`)">
            <span>{{ emptyNote }}</span>
            <!-- An empty tab is the one moment a reader is unambiguously asking where extensions come from, so
                 it answers rather than describing another page: the next row down. -->
            <RouterLink v-if="entries.length === 0" to="/sandbox/discover" class="text-xs text-link hover:underline">
                Discover what people have published →
            </RouterLink>
            <Button v-if="matches.length === 0 && entries.length > 0" size="small" label="Clear filter" @click="clearFilters" />
        </div>

        <!-- The registry comparison's honesty line: update badges above are only as fresh as this. Absent
             until the first check has run — a blank claim is worse than none. -->
        <p v-if="updatesCheckedAt !== undefined" class="text-right text-2xs text-subtle">
            Updates checked {{ timeAgo(Date.parse(updatesCheckedAt)) }} ·
            <button type="button" :class="ui.linkButton(`text-2xs`)" :disabled="checking" @click="checkNow">
                {{ checking ? `Checking…` : `Check now` }}
            </button>
        </p>

        <!-- Workspace-extension directories the daemon could not enumerate: no manifest, one that does not
             parse, or an id something else already owns. Named per directory because nothing install-shaped
             ever rejected them — this group is where their author (usually an agent, via GET /extensions)
             learns why the row is missing. -->
        <RowGroup v-if="invalid.length > 0" label="Not loadable" caption="workspace-extension directories the sandbox could not read">
            <div v-for="entry in invalid" :key="entry.dir" class="flex items-start justify-between gap-3 px-3 py-2">
                <div class="min-w-0">
                    <p class="truncate text-sm font-medium text-content">.intentic/config/workspace-extensions/{{ entry.dir }}</p>
                    <p class="text-2xs text-danger">{{ entry.error }}</p>
                </div>
                <StatusBadge variant="danger" label="invalid" size="xs" />
            </div>
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
