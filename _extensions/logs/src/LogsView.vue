<script setup lang="ts">
import {
    cmp,
    Code,
    FilterBar,
    formatBytes,
    InfoHint,
    Panel,
    Row,
    RowGroup,
    Segmented,
    sinceOf,
    TIME_WINDOWS,
    type TimeWindow,
    timeAgo,
} from "@intentic/extension-ui";
import { computed, ref, watch } from "vue";
import { useLogs, useLogTail } from "./useLogs";

/* The logs extension: the debug surface for everything the sandbox records under /history/logs — terminal
 * session captures (crashed ones included), intentic CLI run logs, and the daemon's own log. Read-only; the
 * files are written by the daemon/tmux only.
 *
 * Mounted as a tab on the sandbox hub (surface: "sandbox"), so it renders a BODY — the hub owns the Page and
 * the header above the tab strip, exactly as its built-in tabs assume. What would have been the page's
 * description rides the Files section's InfoHint instead. */

const { files, error, isLoading } = useLogs();

const selected = ref<string>();
// Segmented models strings; the daemon route takes the numeric byte count.
const bytesChoice = ref(`65536`);
const bytes = computed(() => Number(bytesChoice.value));
const { tail, error: tailError, isLoading: tailLoading } = useLogTail(selected, bytes);

// Datetime filter over the FILE LIST (by mtime). The presets are the app's shared window vocabulary (Activity
// asks the same question of its feed); an optional custom range (native datetime-local, browser-local -> epoch
// ms) overrides the preset when a `from` is set. Only the file-level modifiedAt is filterable — the log text
// carries no per-line timestamps.
const windowChoice = ref<TimeWindow>(`all`);
const customFrom = ref(``);
const customTo = ref(``);
const parseLocal = (value: string): number | undefined => {
    const ms = new Date(value).getTime();
    return Number.isNaN(ms) ? undefined : ms;
};
const range = computed(() => {
    const from = parseLocal(customFrom.value);
    if (from !== undefined) {
        return { since: from, until: parseLocal(customTo.value) ?? Infinity };
    }
    return { since: sinceOf(windowChoice.value, Date.now()), until: Infinity };
});
const timeFiltered = computed(() => files.value.filter((file) => file.modifiedAt >= range.value.since && file.modifiedAt <= range.value.until));

// Name filter + group tabs over the time-filtered list. Tabs derive from ALL files (sorted, so they never
// appear/disappear as filters change); badges count the current time+name matches per group.
const groupOf = (file: { name: string }): string => (file.name.includes(`/`) ? file.name.split(`/`)[0]! : `daemon`);
const query = ref(``);
const groupChoice = ref(`all`);
const queryFiltered = computed(() => {
    const needle = query.value.trim().toLowerCase();
    return needle === `` ? timeFiltered.value : timeFiltered.value.filter((file) => file.name.toLowerCase().includes(needle));
});
const groupTabs = computed(() => [
    { label: `All`, value: `all`, badge: queryFiltered.value.length },
    ...[...new Set(files.value.map(groupOf))].toSorted().map((name) => ({
        label: name,
        value: name,
        badge: queryFiltered.value.filter((file) => groupOf(file) === name).length,
    })),
]);
const visible = computed(() =>
    groupChoice.value === `all` ? queryFiltered.value : queryFiltered.value.filter((file) => groupOf(file) === groupChoice.value),
);

// Group the visible list by its top-level dir so the All tab reads as sections; a specific tab renders as
// one flat list with the redundant group prefix stripped from displayed names.
const groups = computed(() => {
    const byGroup = new Map<string, typeof files.value>();
    for (const file of visible.value) {
        const group = groupOf(file);
        byGroup.set(group, [...(byGroup.get(group) ?? []), file]);
    }
    return [...byGroup.entries()].map(([title, entries]) => ({ title, entries }));
});
const displayName = (name: string): string => (groupChoice.value === `all` ? name : name.slice(name.indexOf(`/`) + 1));

// Auto-scroll to the newest lines whenever a fresh tail arrives.
const pane = ref<HTMLElement>();
watch(tail, () => {
    requestAnimationFrame(() => pane.value?.scrollTo({ top: pane.value.scrollHeight }));
});
</script>

<template>
    <div class="flex min-h-0 flex-col gap-4">
        <div v-if="error" :class="cmp.alertDanger('px-4 py-3 text-sm')">{{ error }}</div>

        <FilterBar v-model="query" placeholder="Filter by name…" :count="visible.length">
            <template #controls>
                <Segmented v-model="groupChoice" size="xs" :options="groupTabs" />
                <span class="h-4 w-px bg-line" aria-hidden="true"></span>
                <Segmented v-model="windowChoice" size="xs" :options="TIME_WINDOWS" />
            </template>
            <template #actions>
                <input v-model="customFrom" type="datetime-local" title="Modified after" :class="cmp.input(`h-8 px-2 py-0 text-2xs`)" />
                <input v-model="customTo" type="datetime-local" title="Modified before" :class="cmp.input(`h-8 px-2 py-0 text-2xs`)" />
            </template>
        </FilterBar>

        <RowGroup v-for="group in groups" :key="group.title" :label="groupChoice === `all` ? group.title : undefined" :count="group.entries.length">
            <template v-if="group === groups[0]" #info>
                <InfoHint label="Logs">
                    <span class="block text-sm font-medium text-content">Sandbox logs</span>
                    <span class="mt-1 block text-xs text-muted">
                        Everything the sandbox records for debugging: <b>terminals</b> — every tmux session's output (crashed ones included),
                        <b>intentic-runs</b> — infra plan/apply runs, and the <b>daemon</b>'s own log. Stored outside the agent's workspace and
                        survives rebuilds.
                    </span>
                </InfoHint>
            </template>

            <Row
                v-for="file in group.entries"
                :key="file.name"
                as="button"
                density="dense"
                icon="file"
                :selected="selected === file.name"
                @click="selected = file.name"
            >
                <template #title>
                    <span class="block truncate font-mono" :title="file.name">{{ displayName(file.name) }}</span>
                </template>
                <template #meta>
                    <span>{{ formatBytes(file.sizeBytes) }}</span>
                    <span :title="new Date(file.modifiedAt).toLocaleString()">{{ timeAgo(file.modifiedAt) }}</span>
                </template>
            </Row>
        </RowGroup>

        <p v-if="files.length === 0 && !isLoading" :class="cmp.emptyState(`py-6`)">
            Nothing yet. Logs appear as terminals run, infra commands execute, and the daemon works.
        </p>
        <p v-else-if="visible.length === 0" :class="cmp.emptyState(`py-6`)">No files match the current filters.</p>

        <!-- `:scroll="false"` — the tail pane below drives its own scroll (it jumps to the newest lines on every
             refresh), and a panel scroller wrapped around a scroller gives you two scrollbars and neither works. -->
        <Panel v-if="selected" :scroll="false">
            <template #title
                ><span class="font-mono text-xs">{{ selected }}</span></template
            >
            <template #actions>
                <span v-if="tail?.truncated" class="text-2xs text-subtle">tail of {{ formatBytes(tail.sizeBytes) }}</span>
                <Segmented
                    v-model="bytesChoice"
                    :options="[
                        { label: `64 KB`, value: `65536` },
                        { label: `256 KB`, value: `262144` },
                        { label: `1 MB`, value: `1048576` },
                    ]"
                />
            </template>

            <template v-if="tailError" #strips>
                <div :class="cmp.alertDanger('m-4 mb-0')">{{ tailError }}</div>
            </template>

            <!-- The pane keeps its own ref and max height: the tail auto-scrolls to the newest lines, which is a
                 scroll this component drives rather than one the panel merely provides. -->
            <div ref="pane" class="max-h-128 overflow-auto p-4">
                <Code :code="tail?.text ?? (tailLoading ? `Loading…` : ``)" lang="log" :wrap="true" :copyable="false" />
            </div>
        </Panel>
    </div>
</template>
