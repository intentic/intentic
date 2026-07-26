<script setup lang="ts">
import type { GitActionResult, GitChange, GitCommit } from "@intentic-app/api-contract";
import { Segmented, timeAgo } from "@intentic-app/ui";
import ContextMenu from "primevue/contextmenu";
import Dialog from "primevue/dialog";
import type { MenuItem } from "primevue/menuitem";
import { computed, ref, watch } from "vue";
import DiffStat from "../../components/DiffStat.vue";
import BranchSwitcher from "./BranchSwitcher.vue";
import { useGitLog } from "../../composables/workspace/useGitLog";
import { useRepos } from "../../composables/workspace/useRepos";
import { buildFileTree, flattenFileTree } from "./commitFileTree";
import { computeGraphLayout, type GraphRow } from "./graphLayout";
import { type DiffTabPayload, STATUS_CLASS, STATUS_LETTER } from "./workspaceTabs";

/* One repo's git-history graph — the committed side of the real-git story whose uncommitted side is the Changes
 * panel (this is NOT the Checkpoints safety timeline). A wide document, so it lives in the main editor area as a
 * tab (VSCode puts its SCM list in the sidebar and the graph in an editor tab; we mirror that). The lane
 * geometry is computed by graphLayout.ts; this file is the SVG mapping, the inline expandable commit detail
 * (click a row), and the commit context menu (right-click) — VSCode "Git Graph" parity. Every write action is
 * auto-checkpointed daemon-side, so even a rebase / hard reset stays reversible from the Checkpoints timeline. */

const { repo } = defineProps<{ repo: string }>();
const emit = defineEmits<{ "open-diff": [payload: DiffTabPayload]; "switch-repo": [repo: string] }>();

const repoRef = computed(() => repo);
const log = useGitLog(repoRef);
const { commits, branch, loading, error, commitFiles, commitFileDiff } = log;
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
const graphRows = computed(() =>
    layout.value.rows.map((row, index): { row: GraphRow; commit: GitCommit } => ({ row, commit: commits.value[index]! })),
);

// A ref decoration split into its kind — a branch pill vs a `tag: x` pill; HEAD is surfaced separately.
const refBadge = (ref: string): { tag: boolean; label: string } =>
    ref.startsWith(`tag: `) ? { tag: true, label: ref.slice(`tag: `.length) } : { tag: false, label: ref };

// --- inline expandable detail (accordion): one commit open at a time; its changed files load lazily ----------
const openSha = ref<string | undefined>(undefined);
const files = ref<readonly GitChange[]>([]);
const filesLoading = ref(false);
const filesError = ref<string | undefined>(undefined);
// Changed files as a collapsible directory tree (compact folders); collapse state resets per opened commit.
const collapsedDirs = ref<ReadonlySet<string>>(new Set());
const fileRows = computed(() => flattenFileTree(buildFileTree(files.value), collapsedDirs.value));
const toggleDir = (path: string): void => {
    const next = new Set(collapsedDirs.value);
    if (!next.delete(path)) {
        next.add(path);
    }
    collapsedDirs.value = next;
};

let detailToken = 0;
watch(openSha, async (sha) => {
    files.value = [];
    filesError.value = undefined;
    collapsedDirs.value = new Set();
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
watch(repoRef, () => (openSha.value = undefined));

const toggle = (sha: string): void => {
    openSha.value = openSha.value === sha ? undefined : sha;
};

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

// --- commit context menu + write actions (VSCode "Git Graph" parity) -----------------------------------------
type ActionKind = "branch" | "tag" | "checkout" | "cherry-pick" | "revert" | "drop" | "merge" | "rebase" | "reset";
// Header (dialog title), the confirm-button label, whether it needs a name input, and whether it's destructive
// (shows the auto-checkpoint reassurance). The body text is per-commit, computed below.
const ACTIONS: Record<ActionKind, { header: string; confirm: string; needsName?: boolean; placeholder?: string; danger?: boolean }> = {
    branch: { header: `Create branch`, confirm: `Create`, needsName: true, placeholder: `branch-name` },
    tag: { header: `Add tag`, confirm: `Add tag`, needsName: true, placeholder: `tag-name` },
    checkout: { header: `Checkout commit`, confirm: `Checkout`, danger: true },
    "cherry-pick": { header: `Cherry-pick commit`, confirm: `Cherry-pick`, danger: true },
    revert: { header: `Revert commit`, confirm: `Revert`, danger: true },
    drop: { header: `Drop commit`, confirm: `Drop`, danger: true },
    merge: { header: `Merge into current branch`, confirm: `Merge`, danger: true },
    rebase: { header: `Rebase current branch`, confirm: `Rebase`, danger: true },
    reset: { header: `Reset current branch`, confirm: `Reset`, danger: true },
};

const menu = ref<{ show: (event: Event) => void }>();
const menuCommit = ref<GitCommit | undefined>(undefined);
const openMenu = (event: Event, commit: GitCommit): void => {
    menuCommit.value = commit;
    menu.value?.show(event);
};
const menuItems = computed<MenuItem[]>(() => {
    const commit = menuCommit.value;
    if (commit === undefined) {
        return [];
    }
    return [
        { label: `Create Branch…`, command: () => start(`branch`) },
        { label: `Add Tag…`, command: () => start(`tag`) },
        { separator: true },
        { label: `Checkout…`, command: () => start(`checkout`) },
        { label: `Cherry Pick…`, command: () => start(`cherry-pick`) },
        { label: `Revert…`, command: () => start(`revert`) },
        { label: `Drop…`, command: () => start(`drop`) },
        { separator: true },
        { label: `Merge into current branch…`, command: () => start(`merge`) },
        { label: `Rebase current branch on this Commit…`, command: () => start(`rebase`) },
        { label: `Reset current branch to this Commit…`, command: () => start(`reset`) },
        { separator: true },
        { label: `Copy Commit Hash`, command: () => copy(commit.sha) },
        { label: `Copy Commit Subject`, command: () => copy(commit.subject) },
    ];
});

const pending = ref<{ kind: ActionKind; commit: GitCommit } | undefined>(undefined);
const nameInput = ref(``);
const resetMode = ref<"soft" | "mixed" | "hard">(`mixed`);
const acting = ref(false);
const actionError = ref<string | undefined>(undefined);

const start = (kind: ActionKind): void => {
    const commit = menuCommit.value;
    if (commit === undefined) {
        return;
    }
    nameInput.value = ``;
    resetMode.value = `mixed`;
    actionError.value = undefined;
    pending.value = { kind, commit };
};
const cancelAction = (): void => {
    pending.value = undefined;
    actionError.value = undefined;
};

const pendingBody = computed<string>(() => {
    const target = pending.value;
    if (target === undefined) {
        return ``;
    }
    const sha = target.commit.short;
    switch (target.kind) {
        case `checkout`:
            return `Check out ${sha} directly (detached HEAD). Uncommitted changes will block this.`;
        case `cherry-pick`:
            return `Copy ${sha}'s change onto the current branch as a new commit.`;
        case `revert`:
            return `Add a new commit that undoes ${sha}. Nothing is rewritten.`;
        case `drop`:
            return `Remove ${sha} from history, replaying the commits after it onto its parent.`;
        case `merge`:
            return `Merge ${sha} into the current branch (${branch.value ?? `HEAD`}).`;
        case `rebase`:
            return `Replay the current branch's commits on top of ${sha}.`;
        case `reset`:
            return `Move the current branch (${branch.value ?? `HEAD`}) to ${sha}.`;
        default:
            return ``;
    }
});

// The result of a sequence/HEAD op is a GitActionResult (ok:false = a clean-apply conflict); a ref op resolves
// to something without an `ok:false`. Anything thrown (git error) is caught below.
const isConflict = (result: unknown): boolean =>
    typeof result === `object` && result !== null && `ok` in result && (result as GitActionResult).ok === false;

const runPending = async (): Promise<void> => {
    const target = pending.value;
    if (target === undefined || acting.value) {
        return;
    }
    const { kind, commit } = target;
    const name = nameInput.value.trim();
    if (ACTIONS[kind].needsName && name === ``) {
        return;
    }
    acting.value = true;
    actionError.value = undefined;
    try {
        const result = await runAction(kind, commit, name);
        if (isConflict(result)) {
            actionError.value = `Couldn't ${ACTIONS[kind].confirm.toLowerCase()} cleanly — a conflict or uncommitted changes. Resolve it in a terminal.`;
            return; // keep the dialog open with the message
        }
        pending.value = undefined; // success
        if (kind === `checkout` || kind === `reset` || kind === `rebase` || kind === `drop`) {
            openSha.value = undefined; // HEAD moved / history rewrote — the open detail may be stale
        }
    } catch (cause) {
        actionError.value = cause instanceof Error ? cause.message : `Action failed.`;
    } finally {
        acting.value = false;
    }
};

const runAction = (kind: ActionKind, commit: GitCommit, name: string): Promise<unknown> => {
    switch (kind) {
        case `branch`:
            return log.createBranch(commit.sha, name);
        case `tag`:
            return log.createTag(commit.sha, name);
        case `checkout`:
            return log.checkout(commit.sha);
        case `cherry-pick`:
            return log.cherryPick(commit.sha);
        case `revert`:
            return log.revert(commit.sha);
        case `drop`:
            return log.drop(commit.sha);
        case `merge`:
            return log.merge(commit.sha);
        case `rebase`:
            return log.rebase(commit.sha);
        case `reset`:
            return log.reset(commit.sha, resetMode.value);
    }
};
</script>

<template>
    <div class="flex h-full min-h-0 flex-col bg-canvas text-content">
        <!-- Header: repo switcher (root + nested repos) · checked-out branch · refresh. The switcher navigates
             between per-repo graph tabs rather than mutating this one, so each repo keeps its own tab + query. -->
        <div class="flex h-8 shrink-0 items-center gap-1.5 border-b border-line bg-card px-3">
            <Icon name="sitemap" class="shrink-0 text-xs text-subtle" />
            <!-- Repo switcher (root + nested repos) — a clean borderless control; switching navigates between
                 per-repo graph tabs. A single-repo workspace shows the name as static text (nothing to pick). -->
            <div v-if="options.length > 1" class="relative flex items-center">
                <select
                    :value="repo"
                    class="max-w-48 cursor-pointer appearance-none rounded-md bg-transparent py-0.5 pl-1.5 pr-5 text-xs font-medium text-content transition-colors hover:bg-overlay focus:bg-overlay focus:outline-none"
                    aria-label="Repository"
                    @change="emit('switch-repo', ($event.target as HTMLSelectElement).value)"
                >
                    <option v-for="option in options" :key="option" :value="option">{{ option }}</option>
                </select>
                <Icon name="chevron-down" class="pointer-events-none absolute right-1.5 text-[0.5rem] text-subtle" />
            </div>
            <span v-else class="text-xs font-medium text-content">{{ repo }}</span>
            <!-- The checked-out branch, and the switch/create/delete popover behind it. A detached HEAD has
                 no branch to show as a pill, but the switcher is still the way BACK onto one. -->
            <BranchSwitcher :repo="repo" />
            <span class="shrink-0 rounded-full bg-overlay px-1.5 py-px text-2xs text-muted" v-tooltip.bottom="'Commits shown'">{{
                commits.length
            }}</span>
            <span class="flex-1"></span>
            <Icon v-if="loading" name="spinner" class="shrink-0 text-2xs text-subtle" spin />
        </div>

        <p v-if="error" class="shrink-0 truncate px-3 py-1 text-2xs text-danger" v-tooltip.bottom="error">{{ error }}</p>

        <!-- The graph: one row per commit (a per-row SVG gutter drawing lanes/edges/node, then metadata). Click a
             row to expand its detail inline (accordion); right-click for the commit action menu. -->
        <div class="scrollbar-thin min-h-0 flex-1 overflow-auto">
            <p v-if="loading && commits.length === 0" class="px-3 py-3 text-2xs text-subtle">Loading history…</p>
            <p v-else-if="commits.length === 0" class="px-3 py-3 text-2xs text-subtle">No commits yet in this repository.</p>
            <div v-for="{ row, commit } in graphRows" :key="commit.sha">
                <button
                    type="button"
                    class="graphrow flex w-full items-center gap-2 py-0 pl-3 pr-3 text-left"
                    :class="{ 'graphrow-on': commit.sha === openSha }"
                    :style="{ height: `${ROW_H}px` }"
                    @click="toggle(commit.sha)"
                    @contextmenu.prevent.stop="openMenu($event, commit)"
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
                    <span v-if="commit.head" class="shrink-0 rounded bg-primary-600/20 px-1 text-[0.6rem] font-semibold text-link">HEAD</span>
                    <span
                        v-for="ref in commit.refs.slice(0, 3)"
                        :key="ref"
                        class="shrink-0 rounded px-1 text-[0.6rem]"
                        :class="refBadge(ref).tag ? 'bg-warning/15 text-warning' : 'bg-overlay text-muted'"
                        v-tooltip.bottom="refBadge(ref).tag ? 'tag' : 'branch'"
                        >{{ refBadge(ref).label }}</span
                    >
                    <span class="min-w-0 flex-1 truncate text-xs" :class="commit.sha === openSha ? 'text-content' : 'text-content/90'">{{
                        commit.subject
                    }}</span>
                    <span class="hidden shrink-0 truncate text-2xs text-subtle lg:block lg:max-w-32">{{ commit.author }}</span>
                    <span class="hidden shrink-0 text-2xs text-subtle sm:block">{{ timeAgo(commit.at) }}</span>
                    <span class="shrink-0 font-mono text-[0.65rem] text-subtle">{{ commit.short }}</span>
                </button>

                <!-- Inline detail (accordion): commit metadata + the files it changed (click one for a diff at
                     that commit). Replaces the old bottom pane; the file list scrolls if it's long. -->
                <div v-if="commit.sha === openSha" class="border-y border-line bg-card px-3 py-2">
                    <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-2xs">
                        <dt class="text-subtle">Commit</dt>
                        <dd class="flex items-center gap-1 font-mono text-muted">
                            {{ commit.sha }}
                            <button type="button" class="text-subtle hover:text-content" @click="copy(commit.sha)" v-tooltip.top="'Copy full SHA'">
                                <Icon name="copy" class="text-[0.6rem]" />
                            </button>
                        </dd>
                        <template v-if="commit.parents.length > 0">
                            <dt class="text-subtle">Parents</dt>
                            <dd class="font-mono text-muted">{{ commit.parents.map((parent) => parent.slice(0, 8)).join(", ") }}</dd>
                        </template>
                        <dt class="text-subtle">Author</dt>
                        <dd class="text-muted">
                            {{ commit.author }}<span v-if="commit.email" class="text-subtle"> &lt;{{ commit.email }}&gt;</span>
                        </dd>
                        <dt class="text-subtle">Date</dt>
                        <dd class="text-muted">{{ timeAgo(commit.at) }}</dd>
                    </dl>
                    <pre v-if="commit.body" class="mt-1.5 whitespace-pre-wrap font-sans text-2xs text-muted">{{ commit.body }}</pre>

                    <div class="mt-2 border-t border-line pt-1.5">
                        <p v-if="filesError" class="text-2xs text-danger">{{ filesError }}</p>
                        <p v-else-if="filesLoading" class="text-2xs text-subtle">Loading changed files…</p>
                        <template v-else>
                            <p class="mb-1 text-2xs font-medium uppercase tracking-wide text-subtle">
                                {{ files.length }} changed {{ files.length === 1 ? "file" : "files" }}
                            </p>
                            <!-- Changed files as a collapsible directory tree (compact folders), each file with
                                 its +/- line stat; clicking a file opens its diff at this commit. -->
                            <div class="scrollbar-thin max-h-64 overflow-auto">
                                <template v-for="row in fileRows" :key="`${row.kind}:${row.path}`">
                                    <button
                                        v-if="row.kind === 'dir'"
                                        type="button"
                                        class="flex w-full items-center gap-1.5 py-0.5 text-left text-xs text-muted transition-colors hover:bg-overlay"
                                        :style="{ paddingLeft: `${0.25 + row.depth * 0.85}rem` }"
                                        @click="toggleDir(row.path)"
                                    >
                                        <Icon
                                            :name="row.expanded ? 'chevron-down' : 'chevron-right'"
                                            class="w-2.5 shrink-0 text-[0.55rem] text-subtle"
                                        />
                                        <Icon name="folder" class="shrink-0 text-[0.7rem] text-subtle" />
                                        <span class="min-w-0 flex-1 truncate">{{ row.name }}</span>
                                    </button>
                                    <button
                                        v-else
                                        type="button"
                                        class="flex w-full items-center gap-1.5 py-0.5 text-left text-xs transition-colors hover:bg-overlay"
                                        :style="{ paddingLeft: `${0.25 + row.depth * 0.85}rem` }"
                                        @click="openFileDiff(commit, row.file)"
                                    >
                                        <span class="w-2.5 shrink-0"></span>
                                        <span class="w-3 shrink-0 text-center font-mono text-2xs" :class="STATUS_CLASS[row.file.status]">{{
                                            STATUS_LETTER[row.file.status]
                                        }}</span>
                                        <span class="min-w-0 flex-1 truncate text-content/90">{{ row.name }}</span>
                                        <DiffStat :additions="row.file.additions" :deletions="row.file.deletions" />
                                    </button>
                                </template>
                            </div>
                        </template>
                    </div>
                </div>
            </div>
        </div>

        <!-- Right-click commit menu (VSCode "Git Graph" parity), grouped with separators. -->
        <ContextMenu
            ref="menu"
            :model="menuItems"
            :pt="{ root: '!min-w-56 !text-xs', rootList: '!p-1', itemLink: '!rounded !px-2 !py-1 !text-xs', separator: '!my-1' }"
        />

        <!-- One dialog for every action: a name input (branch/tag), a mode picker (reset), or a plain confirm.
             Destructive ops carry the auto-checkpoint reassurance; a clean-apply conflict shows inline. -->
        <Dialog
            :visible="pending !== undefined"
            :modal="true"
            :draggable="false"
            :dismissable-mask="true"
            :style="{ width: '26rem' }"
            :header="pending ? ACTIONS[pending.kind].header : ''"
            @update:visible="cancelAction"
        >
            <template v-if="pending">
                <p class="text-xs text-content">
                    {{ pending.commit.subject }} <span class="font-mono text-2xs text-subtle">{{ pending.commit.short }}</span>
                </p>
                <p v-if="pendingBody" class="mt-1.5 text-xs text-muted">{{ pendingBody }}</p>

                <input
                    v-if="ACTIONS[pending.kind].needsName"
                    v-model="nameInput"
                    type="text"
                    :placeholder="ACTIONS[pending.kind].placeholder"
                    class="mt-3 w-full rounded-md border border-line bg-canvas px-2 py-1 text-xs text-content placeholder:text-subtle focus:border-line-strong focus:outline-none"
                    @keydown.enter="runPending"
                    autofocus
                />

                <div v-if="pending.kind === 'reset'" class="mt-3 flex flex-col gap-1.5">
                    <Segmented
                        v-model="resetMode"
                        size="xs"
                        :options="[
                            { label: 'Soft', value: 'soft', title: 'Keep the worktree and the index' },
                            { label: 'Mixed', value: 'mixed', title: 'Keep the worktree, reset the index' },
                            { label: 'Hard', value: 'hard', title: 'Discard worktree changes' },
                        ]"
                    />
                    <p class="text-2xs text-subtle">
                        {{
                            resetMode === "hard"
                                ? "Hard: discards uncommitted changes in the worktree."
                                : resetMode === "soft"
                                  ? "Soft: keeps your changes staged."
                                  : "Mixed: keeps your changes unstaged."
                        }}
                    </p>
                </div>

                <p v-if="ACTIONS[pending.kind].danger" class="mt-3 text-2xs text-subtle">
                    <Icon name="shield" class="mr-0.5 text-[0.6rem]" />A checkpoint is saved first, so this is reversible from Checkpoints.
                </p>
                <p v-if="actionError" class="mt-2 text-2xs text-danger">{{ actionError }}</p>
            </template>
            <template #footer>
                <button type="button" class="rounded px-3 py-1 text-xs text-muted hover:text-content" @click="cancelAction">Cancel</button>
                <button
                    v-if="pending"
                    type="button"
                    class="rounded px-3 py-1 text-xs font-medium text-white transition-colors disabled:opacity-40"
                    :class="ACTIONS[pending.kind].danger ? 'bg-warning hover:bg-warning/85' : 'bg-success hover:bg-success/85'"
                    :disabled="acting || (ACTIONS[pending.kind].needsName && nameInput.trim() === '')"
                    @click="runPending"
                >
                    {{ ACTIONS[pending.kind].confirm }}
                </button>
            </template>
        </Dialog>
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
