<script setup lang="ts">
import { extensionIdOf } from "@intentic/extension-manifest";
import type { ExtensionSummary } from "@intentic/sandbox-contract";
import { Button, ui, type NoticeModel, Row, RowGroup, SkeletonRows, StatusBadge } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { computed, ref, watch } from "vue";
import { type ExtensionSection, sectionsOf } from "../../composables/extensions/extensionCategories";
import { useExtensionList } from "../../composables/extensions/useExtensionList";
import { useSandboxOutline } from "../../composables/sandbox/useSandboxOutline";
import { reloadExtensions } from "../../extension-host/useExtensionHost";
import ExtensionRow from "./ExtensionRow.vue";

/* WHAT THIS SANDBOX HAS: every first-party and installed extension, the ones compiled into this bundle, the
 * ones baked into the sandbox image, the git-installed capabilities, and the workspace extensions living under
 * .intentic/config/workspace-extensions/, each with its on/off switch.
 *
 * It is one of the two halves of the Extensions section (Browse is the other), and the half that answers "what
 * do I have and is it working". The instrument above it, the search box, the state pills, the create and reload
 * buttons and the registry's freshness line, belongs to the SECTION rather than to this half, so it lives in
 * SandboxExtensions.vue and reaches this component as `query` / `mode`.
 *
 * IT IS A LIST OF SEVENTEEN THINGS, AND GROWING, so it is built to be scanned rather than read. Three decisions
 * follow from that, and they are the design:
 *
 *  1. The nominal case is silent. An extension that is on and working carries no badge: the switch says it is
 *     on and the absence of anything else says it is fine. What is left in colour is only what deserves the
 *     eye: a load failure, an engines mismatch, an image/app version drift. Those also LEAVE their section,
 *     into a pinned group at the top, so "is anything wrong?" is answered without reading a single row.
 *  2. One line per extension. Version, commit, contribution counts, the consequences of switching it off and
 *     the settings form are all real, and all below the fold: a row expands into its full record. Before, the
 *     tab paid for that detail on every row at all times, which is what made seventeen extensions unreadable.
 *  3. Sections by PURPOSE, declared in the manifest (see extensionCategories.ts). One alphabetical run of
 *     seventeen names asks the reader to know what each one is before they can find the one they want; five
 *     headings turn the same list into five short ones, and the heading is what a reader arrives with:
 *     "the CI thing", "whatever talks to Discord". */

const { query, mode, focus, publishedMatches } = defineProps<{
    /** The section's search text: matches the id AND everything the extension contributes. */
    query: string;
    /** The section's state pills: which of "I have it on" / "I switched it off" is being asked for. */
    mode: `all` | `on` | `off`;
    /** A row to open on arrival, how a just-created extension shows itself without this view owning the dialog. */
    focus?: string;
    /** How many PUBLISHED extensions the same search text matches: the section knows, this half cannot. */
    publishedMatches: number;
}>();
const emit = defineEmits<{
    /** This half's own failures, raised so the section keeps ONE notice region above the instrument. */
    notice: [NoticeModel | undefined];
    /** How many rows the section's query left, drawn on the search field. */
    matched: [number];
    /** The reader has nothing installed and is asking where extensions come from: switch to Browse. */
    browse: [];
    /** Their filter matched nothing and they pressed the way out. */
    clear: [];
}>();

const { entries, invalid, unlisted, setEnabled, isLoading, error } = useExtensionList();
const outline = useSandboxOutline(isLoading);
// The list query's own message, in the words of the view that asked for it.
watch(
    () => error.value,
    (failure) => emit(`notice`, failure === undefined ? undefined : { tone: `danger`, title: `Couldn't list this sandbox's extensions.`, detail: failure }),
    { immediate: true },
);

// One row open at a time: the list must not grow unpredictably under the pointer while it is being scanned.
const opened = ref<string | undefined>(undefined);
const pending = ref<string | undefined>(undefined);

// A row the section asked for, a freshly created extension naming the directory its two files are in.
watch(
    () => focus,
    (id) => {
        if (id !== undefined) {
            opened.value = id;
        }
    },
    { immediate: true },
);

const matches = computed(() => {
    const needle = query.trim().toLowerCase();
    return entries.value.filter(
        (entry) => (mode === `all` || (mode === `on`) === entry.extension.enabled) && (needle === `` || entry.search.includes(needle)),
    );
});
const attention = computed(() => matches.value.filter((entry) => entry.state.attention));
const healthy = computed(() => matches.value.filter((entry) => !entry.state.attention));
watch(() => matches.value.length, (count) => emit(`matched`, count), { immediate: true });

/* One list of sections, rendered by one loop. The exception group is a section like the others because it
 * behaves like one: a heading over rows, and pinning it first is the whole of its specialness. It overrides
 * the purpose taxonomy rather than sitting inside it: a broken extension is not something to find under the
 * heading you'd have looked for it under on a good day. */
const sections = computed<ExtensionSection[]>(() => [
    ...(attention.value.length === 0
        ? []
        : [
              {
                  id: `attention`,
                  label: `Needs attention`,
                  entries: attention.value,
              },
          ]),
    ...sectionsOf(healthy.value),
]);

/* What this half says when the sections hold no rows of their own: three different facts, and the wrong one is
 * a lie the reader can see. An attention row IS a match, so a filter that hits only a broken extension leaves
 * the purpose sections empty while a row sits visibly above them; "nothing matches" there would be flatly
 * contradicted by the screen. */
const emptyNote = computed<string | undefined>(() => {
    if (isLoading.value || healthy.value.length > 0) {
        return undefined;
    }
    if (entries.value.length === 0) {
        // The other half of this section, not another page. A surface for extensions whose empty state sends
        // the reader somewhere else to get extensions is the reason Browse is a pill and not a nav row.
        return `Nothing installed yet.`;
    }
    if (attention.value.length > 0) {
        return `Nothing else to show: see the group above.`;
    }
    return `Nothing matches that filter.`;
});

// Flip the switch, then converge the shell: the daemon has already stopped/started the extension's processes
// and dropped its contributions from every subsequent read, and reloadExtensions activates or retires it here
// without a page reload.
const toggle = async (extension: ExtensionSummary, enabled: boolean): Promise<void> => {
    pending.value = extension.id;
    emit(`notice`, undefined);
    try {
        await setEnabled(extension.id, enabled);
        await reloadExtensions();
    } catch (failure) {
        emit(`notice`, noticeFrom(failure, `Could not ${enabled ? `enable` : `disable`} ${extensionIdOf(extension.manifest)}.`));
    } finally {
        pending.value = undefined;
    }
};
</script>

<template>
    <div class="flex flex-col gap-5">
        <!-- Each count is what its section HOLDS, not the total: rows leave for the pinned group above and for
             the filter, and a header that kept claiming 17 over 13 rows is a header nobody trusts again.

             No tier stated, and none needed: a <RowGroup> is a list and a list is compact (see RowGroup's own
             note). This view is why that is the default — it was the one caller in the app that never passed the
             prop, so it drew settings-sized rows while <ExtensionRow>'s own note described "22px inside a 40px
             row", and the extensions list stood visibly taller than the secrets tab beside it. -->
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
             thing on screen. The outline gives it the shape of the list instead of a sentence about it. -->
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
            <!-- An empty list is the one moment a reader is unambiguously asking where extensions come from, so
                 it answers rather than describing another surface: the pill above. -->
            <button v-if="entries.length === 0" type="button" :class="ui.linkButton(`text-xs`)" @click="emit(`browse`)">
                Discover what people have published →
            </button>
            <!-- SEARCHED FOR SOMETHING THEY DON'T HAVE, and somebody has published it. The offer stands where
                 the disappointment is, above the way out of the filter, because it is the better answer to the
                 question that was actually asked: "do I have a thing that does this?" -->
            <button v-if="matches.length === 0 && publishedMatches > 0" type="button" :class="ui.linkButton(`text-xs`)" @click="emit(`browse`)">
                {{ publishedMatches }} published {{ publishedMatches === 1 ? `extension matches` : `extensions match` }} “{{ query.trim() }}” →
            </button>
            <Button v-if="matches.length === 0 && entries.length > 0" size="small" label="Clear filter" @click="emit(`clear`)" />
        </div>

        <!-- Workspace-extension directories the daemon could not enumerate: no manifest, one that does not
             parse, or an id something else already owns. Named per directory because nothing install-shaped
             ever rejected them: this group is where their author (usually an agent, via GET /extensions)
             learns why the row is missing. -->
        <RowGroup v-if="invalid.length > 0" label="Not loadable">
            <Row v-for="entry in invalid" :key="entry.dir">
                <template #title>
                    <span class="block truncate">.intentic/config/workspace-extensions/{{ entry.dir }}</span>
                </template>
                <template #description>
                    <span class="text-danger">{{ entry.error }}</span>
                </template>
                <template #meta><StatusBadge variant="danger" label="invalid" size="xs" /></template>
            </Row>
        </RowGroup>

        <!-- Running in this app build, absent from the daemon's list: no row to sit in, no switch to offer. -->
        <RowGroup v-if="unlisted.length > 0" label="Running but not listed">
            <Row v-for="status in unlisted" :key="status.id">
                <template #title>
                    <span class="block truncate">{{ status.extensionId }}</span>
                </template>
                <template v-if="status.detail" #description>
                    <span class="text-warning">{{ status.detail }}</span>
                </template>
                <template #meta>
                    <StatusBadge :variant="status.state === `error` ? `danger` : `warning`" :label="status.state" size="xs" />
                </template>
            </Row>
        </RowGroup>
    </div>
</template>
