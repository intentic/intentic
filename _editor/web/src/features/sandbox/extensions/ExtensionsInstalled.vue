<script setup lang="ts">
import { extensionIdOf } from "@intentic/extension-manifest";
import type { ExtensionSummary } from "@intentic/sandbox-contract";
import { Button, ui, type NoticeModel, Row, RowGroup, SkeletonRows, StatusBadge } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { computed, ref, watch } from "vue";
import { type ExtensionSection, sectionsOf } from "../../extensions/extensionCategories";
import { useExtensionList } from "../../extensions/useExtensionList";
import { useSandboxOutline } from "../overview/useSandboxOutline";
import { reloadExtensions } from "../../../extension-host/useExtensionHost";
import ExtensionRemoveDialog from "./ExtensionRemoveDialog.vue";
import ExtensionRow from "./ExtensionRow.vue";
import { useT } from "@intentic/ui/i18n";

// Every extension this sandbox has (first-party, baked, git-installed, workspace), the half of the Extensions section
// answering 'what do I have and is it working' (Browse is the other half). Built to be scanned: the nominal case is
// silent, exceptions pin to a group at the top, and sections group by manifest-declared purpose.

const t = useT();

const { query, mode, focus, publishedMatches } = defineProps<{
    /** The section's search text: matches the id and everything the extension contributes. */
    query: string;
    /** The section's state pills: which of 'I have it on' / 'I switched it off' is asked for. */
    mode: `all` | `on` | `off`;
    /** A row to open on arrival, how a just-created extension reveals itself without this view owning the dialog. */
    focus?: string;
    /** How many published extensions the same search matches; the section knows, this half doesn't. */
    publishedMatches: number;
}>();
const emit = defineEmits<{
    /** This half's own failures, raised so the section keeps one notice region above the instrument. */
    notice: [NoticeModel | undefined];
    /** How many rows the section's query left, drawn on the search field. */
    matched: [number];
    /** The reader has nothing installed and is asking where extensions come from: switch to Browse. */
    browse: [];
    /** Their filter matched nothing and they pressed the way out. */
    clear: [];
}>();

const { entries, invalid, unlisted, setEnabled, remove, isLoading, error } = useExtensionList();
const outline = useSandboxOutline(isLoading);
// The list query's own message, in the words of the view that asked for it.
watch(
    () => error.value,
    (failure) =>
        emit(
            `notice`,
            failure === undefined
                ? undefined
                : { tone: `danger`, title: t(`sandbox.extensionsInstalled.couldntListSandboxsExtensions`), detail: failure },
        ),
    { immediate: true },
);

// One row open at a time: the list must not grow unpredictably under the pointer while scanned.
const opened = ref<string | undefined>(undefined);
const pending = ref<string | undefined>(undefined);

// A row the section asked for: a freshly created extension, naming the directory its files are in.
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
watch(
    () => matches.value.length,
    (count) => emit(`matched`, count),
    { immediate: true },
);

// The exception group is an ordinary section, just pinned first, overriding the purpose taxonomy: a broken extension
// shouldn't hide under the heading you'd look for it on a good day.
const sections = computed<ExtensionSection[]>(() => [
    ...(attention.value.length === 0
        ? []
        : [
              {
                  id: `attention`,
                  label: t(`sandbox.extensionsInstalled.needsAttention`),
                  entries: attention.value,
              },
          ]),
    ...sectionsOf(healthy.value),
]);

// Three distinct empty reasons: an attention row still counts as a match, so 'nothing matches' would be visibly false
// while one sits above.
const emptyNote = computed<string | undefined>(() => {
    if (isLoading.value || healthy.value.length > 0) {
        return undefined;
    }
    if (entries.value.length === 0) {
        // The other half of this section, not another page: why Browse is a pill, not a nav row.
        return `Nothing installed yet.`;
    }
    if (attention.value.length > 0) {
        return `Nothing else to show: see the group above.`;
    }
    return `Nothing matches that filter.`;
});

// The daemon has already stopped or started the processes; reloadExtensions activates or retires the row here, without
// a page reload.
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

// Removal lives here rather than on the row: the row is torn down by the refetch that removal causes, so a component
// that unmounts mid-call is the wrong place to hold the call's outcome.
const removing = ref<ExtensionSummary | undefined>(undefined);
const removingNow = ref(false);
const confirmRemove = async (): Promise<void> => {
    const extension = removing.value;
    if (extension === undefined || removingNow.value) {
        return;
    }
    removingNow.value = true;
    emit(`notice`, undefined);
    try {
        const removed = await remove(extension.id);
        removing.value = undefined;
        // Retires its views and commands in this browser without a page reload, the same reconcile the switch performs.
        await reloadExtensions();
        // Said plainly and afterwards: the dialog stated the plan, this states what the plan turned out to be. A
        // pending rebuild is a warning rather than a note, since until it runs the image still carries what it baked.
        const said = [
            ...(removed.connections.length === 0
                ? []
                : [`${removed.connections.length === 1 ? `Connection` : `Connections`} ${removed.connections.join(`, `)} went with it.`]),
            ...(removed.rebuildNeeded === true ? [`What it added to the sandbox image is still there until the next environment rebuild.`] : []),
        ];
        emit(`notice`, {
            tone: removed.rebuildNeeded === true ? `warning` : `info`,
            title: t(`sandbox.extensionsInstalled.removed`, { manifest: extensionIdOf(extension.manifest) }),
            ...(said.length === 0 ? {} : { detail: said.join(` `) }),
        });
    } catch (failure) {
        emit(`notice`, noticeFrom(failure, `Could not remove ${extensionIdOf(extension.manifest)}.`));
    } finally {
        removingNow.value = false;
    }
};
</script>

<template>
    <div class="flex flex-col gap-5">
        <RowGroup v-for="section in sections" :key="section.id" :label="section.label" :caption="section.caption">
            <ExtensionRow
                v-for="entry in section.entries"
                :key="entry.extension.id"
                :entry="entry"
                :expanded="opened === entry.extension.id"
                :pending="pending === entry.extension.id"
                @toggle="(enabled) => toggle(entry.extension, enabled)"
                @remove="removing = entry.extension"
                @update:expanded="(open) => (opened = open ? entry.extension.id : undefined)"
            />
        </RowGroup>

        <!-- Sections render nothing while the read is out, so this outline gives the wait the list's own shape instead of a sentence. -->
        <template v-if="isLoading">
            <RowGroup v-if="outline" :label="t(`sandbox.extensionsInstalled.installed`)">
                <div role="status" aria-busy="true">
                    <span class="sr-only">{{ t(`sandbox.extensionsInstalled.readingSandboxsExtensions`) }}</span>
                    <SkeletonRows :rows="3" description control />
                </div>
            </RowGroup>
        </template>
        <div v-else-if="emptyNote !== undefined" :class="ui.emptyState(`flex flex-col items-center gap-2 py-6`)">
            <span>{{ emptyNote }}</span>
            <!-- An empty list is the moment to answer 'where do extensions come from', not just point at another surface. -->
            <button v-if="entries.length === 0" type="button" :class="ui.linkButton(`text-xs`)" @click="emit(`browse`)">
                {{ t(`sandbox.extensionsInstalled.discoverWhatPeoplePublished`) }}
            </button>
            <!-- The empty state answers the active filter before offering reset. -->
            <button v-if="matches.length === 0 && publishedMatches > 0" type="button" :class="ui.linkButton(`text-xs`)" @click="emit(`browse`)">
                {{ t(`sandbox.extensionsInstalled.publishedMatches`, { count: publishedMatches, query: query.trim() }, publishedMatches) }}
            </button>
            <Button
                v-if="matches.length === 0 && entries.length > 0"
                size="small"
                :label="t(`sandbox.extensionsInstalled.clearFilter`)"
                @click="emit(`clear`)"
            />
        </div>

        <!-- Unenumerated workspace extensions are listed with their reason. -->
        <RowGroup v-if="invalid.length > 0" :label="t(`sandbox.extensionsInstalled.notLoadable`)">
            <Row v-for="entry in invalid" :key="entry.dir">
                <template #title>
                    <span class="block truncate">.intentic/config/workspace-extensions/{{ entry.dir }}</span>
                </template>
                <template #description>
                    <span class="text-danger">{{ entry.error }}</span>
                </template>
                <template #meta><StatusBadge variant="danger" :label="t(`sandbox.extensionsInstalled.invalid`)" size="xs" /></template>
            </Row>
        </RowGroup>

        <!-- Running in this app build, absent from the daemon's list: no row to sit in, no switch to offer. -->
        <RowGroup v-if="unlisted.length > 0" :label="t(`sandbox.extensionsInstalled.runningNotListed`)">
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

        <!-- Removal takes state the owner configured themselves, so it is never one click: the dialog reads the plan
             first and names every connection, credential and file that goes with it. -->
        <ExtensionRemoveDialog :extension="removing" :busy="removingNow" @close="removing = undefined" @confirm="void confirmRemove()" />
    </div>
</template>
