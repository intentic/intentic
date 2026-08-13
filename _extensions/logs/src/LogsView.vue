<script setup lang="ts">
import {
    cmp,
    Code,
    FilterBar,
    formatBytes,
    formatTimestamp,
    Icon,
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
import { computed, nextTick, ref, watch } from "vue";
import { useLogs, useLogTail } from "./useLogs";

/* The logs extension: the debug surface for everything the sandbox records under /history/logs — terminal
 * session captures (crashed ones included), intentic CLI run logs, and the daemon's own log. Read-only; the
 * files are written by the daemon/tmux only.
 *
 * Mounted as a tab on the sandbox hub (surface: "sandbox"), so it renders a BODY — the hub owns the Page and
 * the header above the tab strip, exactly as its built-in tabs assume. What would have been the page's
 * description rides the Files section's InfoHint instead.
 *
 * THE READER IS PINNED TO THE BOTTOM OF THE SCREEN, and that is the layout decision this file exists to
 * explain. The list and the reader used to be two blocks stacked down a page-scrolling hub body, which is fine
 * for the twelve files a fresh box has and unusable at the four hundred a working one accumulates: clicking a
 * row put the log's text below every remaining row, so reading what you just picked meant a scroll of several
 * screens, and picking the next one meant scrolling all the way back. The list, in other words, decided how
 * far away the content was.
 *
 * Two shapes fix that. An index BESIDE the reader is the usual one, and it is wrong here: the hub already
 * spends 16rem of a 72rem page on its section rail, so a second column would leave log lines ~85 characters
 * wide — narrower than the terminals that wrote them, in the one view whose content is lines of text. So the
 * panes stay stacked and the reader STICKS to the bottom of the scroll port instead:
 *
 *   · the list keeps the page's own scroll — one scrollbar for four hundred rows, PageDown works, and the
 *     group headings scroll past like the headings they are, rather than being trapped in a 9-row window;
 *   · the reader is on screen from the moment a row is picked, at the full width of the body;
 *   · nothing moves when it opens. It is the last child in flow, so rows above it keep their place — the jump
 *     an index-above-reader layout has to compensate for does not exist.
 *
 * The filter bar sticks at the top for the same reason: re-narrowing four hundred files must not start with a
 * scroll back to the top. Both pinned bands are what the rows' scroll-margin below is measured against. */

const { files, error, isLoading } = useLogs();

const selected = ref<string>();
// Segmented models strings; the daemon route takes the numeric byte count.
const bytesChoice = ref(`65536`);
const bytes = computed(() => Number(bytesChoice.value));
const { tail, error: tailError, isLoading: tailLoading } = useLogTail(selected, bytes);
const selectedFile = computed(() => files.value.find((file) => file.name === selected.value));

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

const instrument = ref<HTMLElement>();
const list = ref<HTMLElement>();
const reader = ref<HTMLElement>();
const rowOf = (name: string): HTMLElement | undefined => list.value?.querySelector<HTMLElement>(`[data-log="${name}"]`) ?? undefined;

/* A picked row has to end up in the clear band between the two pinned bands — the filter bar above it and the
 * reader below. Told to the browser as the row's own scroll-margin, which makes `nearest` do the whole job:
 * no scroll while the row is already in the clear, the smallest one that clears it otherwise, and no lurch
 * under the cursor on an ordinary click. The two heights are MEASURED at the moment of the scroll rather than
 * written as constants — the filter bar wraps to two rows as the body narrows, and the reader's height is
 * whatever its dvh cap resolves to on this screen. */
const reveal = (row: HTMLElement): void => {
    row.style.scrollMarginTop = `${instrument.value?.offsetHeight ?? 0}px`;
    row.style.scrollMarginBottom = `${reader.value?.offsetHeight ?? 0}px`;
    row.scrollIntoView({ block: `nearest` });
};
const pick = (name: string): void => {
    selected.value = name;
    // After the DOM settles: the reader mounting is what decides where the clear band now ends. Focus follows
    // the selection so ↑/↓ keeps stepping from wherever the pointer left off — Safari does not focus a clicked
    // button, so that cannot be left to the browser.
    void nextTick(() => {
        const row = rowOf(name);
        row?.focus({ preventScroll: true });
        if (row !== undefined) {
            reveal(row);
        }
    });
};
// ↑/↓ steps through the list AS RENDERED (grouped order, not the flat filter order) — triaging a run of
// timestamped captures is the job this view exists for, and it should not cost four hundred clicks.
const step = (delta: number): void => {
    const ordered = groups.value.flatMap((group) => group.entries);
    const at = ordered.findIndex((file) => file.name === selected.value);
    const next = ordered[Math.min(Math.max(at + delta, 0), ordered.length - 1)];
    if (next !== undefined) {
        pick(next.name);
    }
};

// Auto-scroll to the newest lines whenever a fresh tail arrives.
const pane = ref<HTMLElement>();
watch(tail, () => {
    requestAnimationFrame(() => pane.value?.scrollTo({ top: pane.value.scrollHeight }));
});
</script>

<template>
    <div class="flex flex-col">
        <div v-if="error" :class="cmp.alertDanger('mb-3 px-4 py-3 text-sm')">{{ error }}</div>

        <!-- The padding is what the rows scroll behind once this is pinned; the negative margin gives it back, so
             the band exists only when it is needed and the resting layout is unchanged. -->
        <div ref="instrument" class="sticky top-0 z-20 -mt-3 bg-canvas pb-3 pt-3">
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
        </div>

        <!-- The keys are bound here rather than on the window: arrows belong to the list only while a row of it
             holds focus, so they never take the page's own scrolling away from someone who is just reading. -->
        <div
            ref="list"
            class="flex flex-col gap-4"
            @keydown.down.prevent="step(1)"
            @keydown.up.prevent="step(-1)"
            @keydown.esc="selected = undefined"
        >
            <RowGroup
                v-for="group in groups"
                :key="group.title"
                :label="groupChoice === `all` ? group.title : undefined"
                :count="group.entries.length"
            >
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

                <!-- `data-log` is how the keyboard step finds the row to focus, and it is the file's own name
                     because that is already the list's identity (`:key`, the selection, the tail query). -->
                <Row
                    v-for="file in group.entries"
                    :key="file.name"
                    :data-log="file.name"
                    as="button"
                    density="dense"
                    icon="file"
                    :selected="selected === file.name"
                    @click="pick(file.name)"
                >
                    <template #title>
                        <span class="block truncate font-mono" :title="file.name">{{ displayName(file.name) }}</span>
                    </template>
                    <template #meta>
                        <span>{{ formatBytes(file.sizeBytes) }}</span>
                        <span :title="formatTimestamp(file.modifiedAt)">{{ timeAgo(file.modifiedAt) }}</span>
                    </template>
                </Row>
            </RowGroup>

            <p v-if="files.length === 0 && !isLoading" :class="cmp.emptyState(`py-6`)">
                Nothing yet. Logs appear as terminals run, infra commands execute, and the daemon works.
            </p>
            <p v-else-if="visible.length === 0" :class="cmp.emptyState(`py-6`)">No files match the current filters.</p>
        </div>

        <!-- The pinned reader. The wrapper is what the rows scroll behind — opaque, and it carries the gap so
             the panel's rounded corners sit on the page's own background rather than on half a row.
             `:scroll="false"` — the tail pane below drives its own scroll (it jumps to the newest lines on every
             refresh), and a panel scroller wrapped around a scroller gives you two scrollbars and neither works. -->
        <div v-if="selected !== undefined" ref="reader" class="sticky bottom-0 z-10 bg-canvas py-3">
            <Panel :scroll="false" class="max-h-panel-sm border-line-strong shadow-lg md:max-h-panel">
                <template #title
                    ><span class="font-mono text-xs">{{ selected }}</span></template
                >
                <template #meta>
                    <span v-if="tail">{{ formatBytes(tail.sizeBytes) }}</span>
                    <template v-if="selectedFile">
                        <span aria-hidden="true">·</span>
                        <span :title="formatTimestamp(selectedFile.modifiedAt)">written {{ timeAgo(selectedFile.modifiedAt) }}</span>
                    </template>
                    <template v-if="tail?.truncated">
                        <span aria-hidden="true">·</span>
                        <span>last {{ formatBytes(bytes) }} shown</span>
                    </template>
                </template>
                <template #actions>
                    <Segmented
                        v-model="bytesChoice"
                        size="xs"
                        :options="[
                            { label: `64 KB`, value: `65536` },
                            { label: `256 KB`, value: `262144` },
                            { label: `1 MB`, value: `1048576` },
                        ]"
                    />
                    <button type="button" :class="cmp.iconButton()" title="Close (Esc)" @click="selected = undefined">
                        <Icon name="times" />
                    </button>
                </template>

                <template v-if="tailError" #strips>
                    <div :class="cmp.alertDanger('m-4 mb-0')">{{ tailError }}</div>
                </template>

                <div ref="pane" class="scrollbar-thin min-h-0 flex-1 overflow-auto p-4">
                    <Code :code="tail?.text ?? (tailLoading ? `Loading…` : ``)" lang="log" :wrap="true" :copyable="false" />
                </div>
            </Panel>
        </div>
    </div>
</template>
