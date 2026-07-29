<script setup lang="ts">
import { cmp, Code, formatBytes, Icon, InfoHint, Segmented, timeAgo } from "@intentic/extension-ui";
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

// Datetime filter over the FILE LIST (by mtime). Presets cover the common recent windows; an optional custom
// range (native datetime-local, browser-local -> epoch ms) overrides the preset when a `from` is set. Only the
// file-level modifiedAt is filterable — the log text carries no per-line timestamps.
const PRESET_MS = new Map<string, number>([
    [`1h`, 3_600_000],
    [`24h`, 86_400_000],
    [`7d`, 604_800_000],
]);
const windowChoice = ref(`all`);
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
    const span = PRESET_MS.get(windowChoice.value);
    return { since: span === undefined ? -Infinity : Date.now() - span, until: Infinity };
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

        <section class="rounded-lg border border-line bg-card p-4">
            <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
                <div class="flex items-center gap-2">
                    <h3 :class="cmp.sectionLabel()">Files</h3>
                    <InfoHint label="Logs">
                        <span class="block text-sm font-medium text-content">Sandbox logs</span>
                        <span class="mt-1 block text-xs text-muted">
                            Everything the sandbox records for debugging: <b>terminals</b> — every tmux session's output (crashed ones included),
                            <b>intentic-runs</b> — infra plan/apply runs, and the <b>daemon</b>'s own log. Stored outside the agent's workspace and
                            survives rebuilds.
                        </span>
                    </InfoHint>
                </div>
                <Segmented v-model="groupChoice" size="xs" :options="groupTabs" />
            </div>
            <div class="mb-3 flex flex-wrap items-center gap-2">
                <input v-model="query" type="search" placeholder="Filter by name…" :class="cmp.input(`h-7 w-44 px-2 py-0 text-2xs`)" />
                <Segmented
                    v-model="windowChoice"
                    size="xs"
                    :options="[
                        { label: `1h`, value: `1h` },
                        { label: `24h`, value: `24h` },
                        { label: `7d`, value: `7d` },
                        { label: `All`, value: `all` },
                    ]"
                />
                <input v-model="customFrom" type="datetime-local" title="Modified after" :class="cmp.input(`h-7 px-2 py-0 text-2xs`)" />
                <input v-model="customTo" type="datetime-local" title="Modified before" :class="cmp.input(`h-7 px-2 py-0 text-2xs`)" />
            </div>
            <!-- Fixed default height, natively resizable (drag the bottom-right grip) so the user can trade
                 list height against the viewer below; only mounted when there are rows, so the empty state
                 never sits under a tall empty box. Height is an inline style, not a Tailwind class: the app's
                 tailwind @source globs don't scan _extensions, so a novel height utility would be dropped. -->
            <div v-if="visible.length > 0" class="resize-y overflow-auto" style="height: 20rem; min-height: 8rem">
                <div v-for="group in groups" :key="group.title" class="mb-2">
                    <p v-if="groupChoice === `all`" class="mb-1 font-mono text-2xs uppercase text-subtle/70">{{ group.title }}</p>
                    <div class="flex flex-col divide-y divide-line">
                        <button
                            v-for="file in group.entries"
                            :key="file.name"
                            type="button"
                            class="flex items-center gap-3 py-1.5 text-left hover:bg-hover"
                            :class="selected === file.name ? `text-content` : `text-muted`"
                            @click="selected = file.name"
                        >
                            <Icon name="file" class="text-xs" :class="selected === file.name ? `text-link` : `text-subtle`" />
                            <span class="min-w-0 flex-1 truncate font-mono text-xs" :title="file.name">{{ displayName(file.name) }}</span>
                            <span class="shrink-0 text-2xs text-subtle">{{ formatBytes(file.sizeBytes) }}</span>
                            <span class="shrink-0 text-2xs text-subtle" :title="new Date(file.modifiedAt).toLocaleString()">
                                {{ timeAgo(file.modifiedAt) }}
                            </span>
                        </button>
                    </div>
                </div>
            </div>
            <p v-else-if="files.length === 0 && !isLoading" class="py-6 text-center text-sm text-muted">
                Nothing yet. Logs appear as terminals run, infra commands execute, and the daemon works.
            </p>
            <p v-else-if="files.length > 0" class="py-6 text-center text-sm text-muted">No files match the current filters.</p>
        </section>

        <section v-if="selected" class="rounded-lg border border-line bg-card p-4">
            <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
                <h3 class="min-w-0 truncate font-mono text-xs text-content">{{ selected }}</h3>
                <div class="flex items-center gap-2">
                    <span v-if="tail?.truncated" class="text-2xs text-subtle">tail of {{ formatBytes(tail.sizeBytes) }}</span>
                    <Segmented
                        v-model="bytesChoice"
                        :options="[
                            { label: `64 KB`, value: `65536` },
                            { label: `256 KB`, value: `262144` },
                            { label: `1 MB`, value: `1048576` },
                        ]"
                    />
                </div>
            </div>
            <div v-if="tailError" :class="cmp.alertDanger('mb-2')">
                {{ tailError }}
            </div>
            <div ref="pane" class="max-h-128 overflow-auto">
                <Code :code="tail?.text ?? (tailLoading ? `Loading…` : ``)" lang="log" :wrap="true" :copyable="false" />
            </div>
        </section>
    </div>
</template>
