<script setup lang="ts">
import type { GitChange, GitCommit } from "@intentic-app/api-contract";
import { timeAgo } from "@intentic-app/ui";
import { computed, ref, watch } from "vue";
import { useGitLog } from "../../composables/workspace/useGitLog";
import { useRepos } from "../../composables/workspace/useRepos";
import { computeGraphLayout, type GraphRow } from "./graphLayout";
import { type DiffTabPayload, STATUS_CLASS, STATUS_LETTER } from "./workspaceTabs";

/* One repo's git-history graph — the committed side of the real-git story whose uncommitted side is the Changes
 * panel (this is NOT the Checkpoints safety timeline). A wide document, so it lives in the main editor area as
 * a tab (VSCode puts its SCM list in the sidebar and the graph in an editor tab; we mirror that). The lane
 * geometry is computed by graphLayout.ts; this file is the SVG mapping + the selected-commit detail panel.
 * Read-only in v1 (browse + copy + open a file's diff at a commit) — write actions (checkout / branch / revert)
 * are the deliberate next tier, gated behind an auto-checkpoint so even a reset stays recoverable. */

const { repo } = defineProps<{ repo: string }>();
const emit = defineEmits<{ "open-diff": [payload: DiffTabPayload]; "switch-repo": [repo: string] }>();

const repoRef = computed(() => repo);
const { commits, branch, loading, error, refresh, commitFiles, commitFileDiff } = useGitLog(repoRef);
const { options } = useRepos();

// Lane geometry. The gutter is laneCount columns wide; a node sits at the row's vertical center in its lane.
const LANE_W = 14;
const ROW_H = 28;
const NODE_R = 3.5;
const LANE_COLORS = [`#3b82f6`, `#22c55e`, `#eab308`, `#ef4444`, `#a855f7`, `#06b6d4`, `#f97316`, `#ec4899`];
const laneColor = (index: number): string => LANE_COLORS[index % LANE_COLORS.length] ?? LANE_COLORS[0]!;
const laneX = (lane: number): number => LANE_W / 2 + lane * LANE_W;

const layout = computed(() => computeGraphLayout(commits.value));
const gutterWidth = computed(() => Math.max(1, layout.value.laneCount) * LANE_W);
// rows and commits are index-aligned (the layout preserves order), so zip them for rendering.
const graphRows = computed(() => layout.value.rows.map((row, index): { row: GraphRow; commit: GitCommit } => ({ row, commit: commits.value[index]! })));

// A ref decoration split into its kind — a branch pill vs a `tag: x` pill; HEAD is surfaced separately.
const refBadge = (ref: string): { tag: boolean; label: string } =>
    ref.startsWith(`tag: `) ? { tag: true, label: ref.slice(`tag: `.length) } : { tag: false, label: ref };

// --- selection + lazy commit detail --------------------------------------------------------------------------
const selectedSha = ref<string | undefined>(undefined);
const selected = computed(() => commits.value.find((commit) => commit.sha === selectedSha.value));
const files = ref<readonly GitChange[]>([]);
const filesLoading = ref(false);
const filesError = ref<string | undefined>(undefined);

// Load the selected commit's changed files, guarding against out-of-order responses (a fast reselect).
let detailToken = 0;
watch(selectedSha, async (sha) => {
    files.value = [];
    filesError.value = undefined;
    if (sha === undefined) {
        return;
    }
    const token = (detailToken += 1);
    filesLoading.value = true;
    try {
        const result = await commitFiles(sha);
        if (token === detailToken) {
            files.value = result.files;
        }
    } catch (cause) {
        if (token === detailToken) {
            filesError.value = cause instanceof Error ? cause.message : `Failed to load commit.`;
        }
    } finally {
        if (token === detailToken) {
            filesLoading.value = false;
        }
    }
});
// Switching repos (the log re-keys) invalidates the old selection.
watch(repoRef, () => (selectedSha.value = undefined));

const openFileDiff = (commit: GitCommit, change: GitChange): void => {
    void commitFileDiff(commit.sha, change.path).then((body) => {
        emit(`open-diff`, {
            key: `commit:${repo}:${commit.sha}`,
            scope: repo,
            label: `${change.path} @ ${commit.short}`,
            status: change.status,
            path: change.path,
            ...body,
        });
    });
};

const copy = (text: string): void => void navigator.clipboard.writeText(text).catch(() => undefined);
</script>

<template>
    <div class="flex h-full min-h-0 flex-col bg-canvas text-content">
        <!-- Header: repo switcher (root + nested repos) · checked-out branch · refresh. The switcher navigates
             between per-repo graph tabs rather than mutating this one, so each repo keeps its own tab + query. -->
        <div class="flex h-8 shrink-0 items-center gap-2 border-b border-line bg-card px-2">
            <Icon name="sitemap" class="text-xs text-subtle" />
            <select
                :value="repo"
                class="max-w-48 rounded border border-line bg-canvas px-1.5 py-0.5 text-xs text-content focus:border-line-strong focus:outline-none"
                aria-label="Repository"
                @change="emit('switch-repo', ($event.target as HTMLSelectElement).value)"
            >
                <option v-for="option in options" :key="option" :value="option">{{ option }}</option>
            </select>
            <span v-if="branch" class="truncate text-2xs text-subtle" v-tooltip.bottom="'Checked-out branch'">
                <Icon name="code" class="mr-0.5 text-[0.6rem]" />{{ branch }}
            </span>
            <span class="rounded-full bg-overlay px-1.5 py-px text-2xs text-muted">{{ commits.length }}</span>
            <span class="flex-1"></span>
            <button
                type="button"
                class="flex h-6 w-6 items-center justify-center rounded-md text-muted transition-colors hover:bg-overlay hover:text-content"
                @click="refresh()"
                v-tooltip.bottom="'Refresh'"
                aria-label="Refresh history"
            >
                <Icon name="refresh" class="text-xs" :spin="loading" />
            </button>
        </div>

        <p v-if="error" class="shrink-0 truncate px-3 py-1 text-2xs text-danger" v-tooltip.bottom="error">{{ error }}</p>

        <!-- The graph: one row per commit, a per-row SVG gutter drawing the lanes/edges/node, then the commit
             metadata. Clicking a row loads its detail below. -->
        <div class="scrollbar-thin min-h-0 flex-1 overflow-auto">
            <p v-if="loading && commits.length === 0" class="px-3 py-3 text-2xs text-subtle">Loading history…</p>
            <p v-else-if="commits.length === 0" class="px-3 py-3 text-2xs text-subtle">No commits yet in this repository.</p>
            <button
                v-for="{ row, commit } in graphRows"
                :key="commit.sha"
                type="button"
                class="graphrow flex w-full items-center gap-2 pr-3 text-left"
                :class="{ 'graphrow-on': commit.sha === selectedSha }"
                :style="{ height: `${ROW_H}px` }"
                @click="selectedSha = commit.sha === selectedSha ? undefined : commit.sha"
            >
                <svg :width="gutterWidth" :height="ROW_H" class="shrink-0" aria-hidden="true">
                    <line
                        v-for="(edge, index) in row.up"
                        :key="`u${index}`"
                        :x1="laneX(edge.from)"
                        :y1="0"
                        :x2="laneX(edge.to)"
                        :y2="ROW_H / 2"
                        :stroke="laneColor(edge.color)"
                        stroke-width="1.5"
                    />
                    <line
                        v-for="(edge, index) in row.down"
                        :key="`d${index}`"
                        :x1="laneX(edge.from)"
                        :y1="ROW_H / 2"
                        :x2="laneX(edge.to)"
                        :y2="ROW_H"
                        :stroke="laneColor(edge.color)"
                        stroke-width="1.5"
                    />
                    <circle
                        :cx="laneX(row.col)"
                        :cy="ROW_H / 2"
                        :r="commit.head ? NODE_R + 1 : NODE_R"
                        :fill="laneColor(row.color)"
                        :stroke="commit.head ? 'var(--color-content)' : 'none'"
                        stroke-width="1.5"
                    />
                </svg>
                <!-- HEAD + ref decorations. -->
                <span v-if="commit.head" class="shrink-0 rounded bg-primary-600/20 px-1 text-[0.6rem] font-semibold text-link">HEAD</span>
                <span
                    v-for="ref in commit.refs.slice(0, 3)"
                    :key="ref"
                    class="shrink-0 rounded px-1 text-[0.6rem]"
                    :class="refBadge(ref).tag ? 'bg-warning/15 text-warning' : 'bg-overlay text-muted'"
                    v-tooltip.bottom="refBadge(ref).tag ? 'tag' : 'branch'"
                    >{{ refBadge(ref).label }}</span
                >
                <span class="min-w-0 flex-1 truncate text-xs" :class="commit.sha === selectedSha ? 'text-content' : 'text-content/90'">{{
                    commit.subject
                }}</span>
                <span class="hidden shrink-0 truncate text-2xs text-subtle lg:block lg:max-w-32">{{ commit.author }}</span>
                <span class="hidden shrink-0 text-2xs text-subtle sm:block">{{ timeAgo(commit.at) }}</span>
                <span class="shrink-0 font-mono text-[0.65rem] text-subtle">{{ commit.short }}</span>
            </button>
        </div>

        <!-- Selected-commit detail: message + metadata + the files it changed (click one for a diff at that
             commit). Docked at the bottom like a review pane; capped so the graph keeps most of the height. -->
        <div v-if="selected" class="flex max-h-[45%] min-h-0 shrink-0 flex-col border-t border-line bg-card">
            <div class="flex items-start gap-2 border-b border-line px-3 py-2">
                <div class="min-w-0 flex-1">
                    <p class="text-xs font-medium text-content">{{ selected.subject }}</p>
                    <p class="mt-0.5 flex flex-wrap items-center gap-x-2 text-2xs text-subtle">
                        <span>{{ selected.author }}</span>
                        <span v-if="selected.email">&lt;{{ selected.email }}&gt;</span>
                        <span>·</span>
                        <span>{{ timeAgo(selected.at) }}</span>
                        <span>·</span>
                        <button
                            type="button"
                            class="inline-flex items-center gap-1 font-mono hover:text-content"
                            @click="copy(selected.sha)"
                            v-tooltip.top="'Copy full SHA'"
                        >
                            <Icon name="copy" class="text-[0.6rem]" />{{ selected.short }}
                        </button>
                    </p>
                </div>
                <button
                    type="button"
                    class="shrink-0 rounded p-1 text-subtle transition-colors hover:bg-overlay hover:text-content"
                    aria-label="Close detail"
                    @click="selectedSha = undefined"
                >
                    <Icon name="times" class="text-2xs" />
                </button>
            </div>
            <div class="scrollbar-thin min-h-0 flex-1 overflow-auto px-3 py-2">
                <pre v-if="selected.body" class="mb-2 whitespace-pre-wrap font-sans text-2xs text-muted">{{ selected.body }}</pre>
                <p v-if="filesError" class="text-2xs text-danger">{{ filesError }}</p>
                <p v-else-if="filesLoading" class="text-2xs text-subtle">Loading changed files…</p>
                <template v-else>
                    <p class="mb-1 text-2xs font-medium uppercase tracking-wide text-subtle">
                        {{ files.length }} changed {{ files.length === 1 ? "file" : "files" }}
                    </p>
                    <button
                        v-for="change in files"
                        :key="change.path"
                        type="button"
                        class="flex w-full items-center gap-2 rounded py-0.5 text-left text-xs transition-colors hover:bg-overlay"
                        @click="openFileDiff(selected, change)"
                    >
                        <span class="w-3 shrink-0 text-center font-mono text-2xs" :class="STATUS_CLASS[change.status]">{{
                            STATUS_LETTER[change.status]
                        }}</span>
                        <span class="min-w-0 flex-1 truncate text-content/90">{{ change.path }}</span>
                    </button>
                </template>
            </div>
        </div>
    </div>
</template>

<style scoped>
.graphrow {
    transition: background-color 0.1s;
}
.graphrow:hover {
    background: color-mix(in srgb, var(--color-content) 6%, transparent);
}
.graphrow-on {
    background: color-mix(in srgb, var(--color-primary-500) 15%, transparent);
}
</style>
