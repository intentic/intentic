<script setup lang="ts">
import {
    Button,
    ChangeStatusMark,
    clipboardOf,
    ContextMenu,
    DiffStat,
    Icon,
    type MenuItem,
    Modal,
    SegmentedControl,
    timeAgo,
    ui,
    useLoadingReveal,
    vAction,
} from "@intentic/extension-ui";
import type { GitActionResult, GitChange, GitCommit, GitDiffSide } from "@intentic/sandbox-contract";
import { computed, onScopeDispose, ref, watch } from "vue";
import BranchSwitcher from "./BranchSwitcher.vue";
import { host } from "./host.js";
import { repoAt } from "./repos.js";
import { useBranches } from "./useBranches.js";
import { useGitLog } from "./useGitLog.js";
import { useOperation } from "./useOperation.js";
import { useUndo } from "./useUndo.js";
import { useStashes } from "./useStashes.js";
import { useWorking } from "./useWorking.js";
import { buildFileTree, flattenFileTree } from "./commitFileTree.js";
import { computeGraphLayout, type GraphRow } from "./graphLayout.js";
import { matchesSearch, searchWords } from "./searchCommits.js";

// One repo's git-history graph: the committed-side story (Changes panel is uncommitted, Checkpoints the safety
// timeline). A tab in the main editor, mirroring VSCode's graph/SCM split; graphLayout.ts computes lanes, this file
// draws the SVG, inline detail and the context menu. Per-directory, so the tree row is the switcher.

const { path } = defineProps<{ path: string }>();

// Unreachable in practice; exists only so a deleted repo's restored tab degrades to root history.
const repoRef = computed(() => repoAt(path) ?? `root`);
// This tab's root element, so a clipboard write lands in the window the reader is looking at, not the opener's.
const rootEl = ref<HTMLElement>();
const log = useGitLog(repoRef);
const { commits, branch, loading, error, hasMore, fetchingMore, loadMore, commitFiles, commitFileDiff, workingFileDiff } = log;
// A halted merge/rebase/cherry-pick/revert left by a terminal; nothing here causes one, but it must still show.
const operation = useOperation(repoRef);
// Branch-level counterpart to Checkpoints: restores the branch; in the header for when a rebase goes wrong.
const undo = useUndo(repoRef);
// Same branch state BranchSwitcher renders, one query key; needed here for the ref pills' push/delete verbs.
const branchState = useBranches(repoRef);
// Hard undo for anything that rewrote files, soft for a commit or amend whose content should stay in the tree.
const runUndo = (): Promise<void> => undo.undo(undo.action.value?.changesWorkingTree === true);

// Lane geometry: the gutter is laneCount columns wide, a node centered vertically in its lane.
const LANE_W = 14;
const ROW_H = 28;
const NODE_R = 3.5;
const LANE_COLORS = [`#3b82f6`, `#22c55e`, `#eab308`, `#ef4444`, `#a855f7`, `#06b6d4`, `#f97316`, `#ec4899`];
const laneColor = (index: number): string => LANE_COLORS[index % LANE_COLORS.length] ?? LANE_COLORS[0]!;
const laneX = (lane: number): number => LANE_W / 2 + lane * LANE_W;

// Uncommitted work as an ordinary row parented to HEAD, not a detached header, so the lane layout connects it for free.
// `WORKING` is a sha no real object can have.
const WORKING = `working`;
const working = useWorking(repoRef);
const headSha = computed(() => commits.value.find((commit) => commit.head)?.sha);
const workingRow = computed<GitCommit | undefined>(() =>
    !working.dirty.value || headSha.value === undefined
        ? undefined
        : {
              sha: WORKING,
              short: ``,
              parents: [headSha.value],
              subject: `Uncommitted changes`,
              body: ``,
              author: ``,
              email: ``,
              at: Date.now(),
              refs: [],
              head: false,
          },
);
// Stashes splice directly above the commit they were taken on, so the lane algorithm gives each a free lane with no
// special case. One outside the fetched window is dropped, since an edgeless node would read as a root commit.
const stashes = useStashes(repoRef);
const stashRows = computed(() => {
    const inWindow = new Set(commits.value.map((commit) => commit.sha));
    const byParent = new Map<string, GitCommit[]>();
    for (const entry of stashes.stashes.value) {
        const parent = entry.parents[0];
        if (parent === undefined || !inWindow.has(parent)) {
            continue;
        }
        const row: GitCommit = {
            sha: entry.sha,
            short: entry.short,
            parents: [parent],
            subject: entry.subject,
            body: ``,
            author: ``,
            email: ``,
            at: entry.at,
            refs: [],
            head: false,
        };
        byParent.set(parent, [...(byParent.get(parent) ?? []), row]);
    }
    return byParent;
});
// Which rows are stashes, by sha, for the pill and detail; a Map keeps the lookup out of the row loop.
const stashBySha = computed(() => new Map(stashes.stashes.value.map((entry) => [entry.sha, entry])));

// Narrows rows before the layout runs, since hiding them after would leave edges pointing at commits no longer there.
// Searches only loaded pages; a full server-side search is a different feature.
const search = ref(``);
const words = computed(() => searchWords(search.value));
const searching = computed(() => words.value.length > 0);
const matched = computed(() => (searching.value ? commits.value.filter((commit) => matchesSearch(commit, words.value)) : commits.value));

const rowCommits = computed<readonly GitCommit[]>(() => {
    const byParent = stashRows.value;
    // A plain loop, not flatMap, since almost no commit has a stash. Synthetic rows (working, stashes) are excluded
    // while searching, since they'd never match and never leave a filtered list.
    const rows: GitCommit[] = workingRow.value === undefined || searching.value ? [] : [workingRow.value];
    for (const commit of matched.value) {
        if (!searching.value) {
            rows.push(...(byParent.get(commit.sha) ?? []));
        }
        rows.push(commit);
    }
    return rows;
});

const layout = computed(() => computeGraphLayout(rowCommits.value));
const gutterWidth = computed(() => Math.max(1, layout.value.laneCount) * LANE_W);
// rows and commits are index-aligned (the layout preserves order), so zip them for rendering.
const graphRows = computed(() =>
    layout.value.rows.map((row, index): { row: GraphRow; commit: GitCommit } => ({ row, commit: rowCommits.value[index]! })),
);

// Hovering fades every branch but its own colour, via reactive state rather than a mutated DOM class.
const hovered = ref<number | undefined>(undefined);
// Dimmed when something is hovered and not on that row's branch; nothing hovered costs nothing.
const dimmed = (color: number): boolean => hovered.value !== undefined && hovered.value !== color;

// IntersectionObserver on a sentinel, not a scroll listener, so it costs nothing off-screen and doesn't run per wheel
// event. `rootMargin` starts the fetch a screenful early; `fetchingMore` guards re-entry mid-request.
const sentinel = ref<HTMLElement | undefined>(undefined);
let observer: IntersectionObserver | undefined;
watch(sentinel, (element) => {
    observer?.disconnect();
    observer = undefined;
    if (element === undefined) {
        return;
    }
    observer = new IntersectionObserver(
        (entries) => {
            if (entries.some((entry) => entry.isIntersecting) && !fetchingMore.value) {
                loadMore();
            }
        },
        { rootMargin: `400px` },
    );
    observer.observe(element);
});
onScopeDispose(() => observer?.disconnect());

// A ref decoration split into its kind: a branch pill vs a `tag: x` pill; HEAD is surfaced separately.
const refBadge = (decoration: string): { tag: boolean; label: string } =>
    decoration.startsWith(`tag: `) ? { tag: true, label: decoration.slice(`tag: `.length) } : { tag: false, label: decoration };

// Inline expandable detail: one commit open at a time, its files loaded lazily.
const openSha = ref<string | undefined>(undefined);
// Which row's diff the companion pane shows; kept by sha+path, since a path repeats across commits.
const showing = ref<{ sha: string; path: string } | undefined>(undefined);
const files = ref<readonly GitChange[]>([]);
const filesLoading = ref(false);
const filesError = ref<string | undefined>(undefined);
// Changed files as a collapsible directory tree (compact folders); collapse state resets per opened commit.
const collapsedDirs = ref<ReadonlySet<string>>(new Set());
const fileRows = computed(() => flattenFileTree(buildFileTree(files.value), collapsedDirs.value));
const toggleDir = (dir: string): void => {
    const next = new Set(collapsedDirs.value);
    if (!next.delete(dir)) {
        next.add(dir);
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
    // Row zero's files are already in hand, from the same scan the Changes panel renders; nothing to fetch.
    if (sha === WORKING) {
        files.value = working.changes.value;
        return;
    }
    const token = (detailToken += 1);
    filesLoading.value = true;
    const stash = stashBySha.value.get(sha);
    try {
        // A stash's diff spans three parent trees, which only `git stash show` reads; hence its own route.
        const result = stash === undefined ? await commitFiles(sha) : await stashes.files(stash.ref);
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

// Binary image bytes, fetched per side from /diff/raw since the text-diff route can only flag one (`binary: true`).
// Which sides exist comes from git's status letter, not the response.
const rawSides = (sha: string, change: GitChange): { beforeRaw?: string; afterRaw?: string } => {
    const side = (which: "before" | "after"): string =>
        `/diff/raw?${new URLSearchParams({ source: `commit`, repo: repoRef.value, sha, path: change.path, which }).toString()}`;
    return {
        ...(change.status === `added` || change.status === `renamed` ? {} : { beforeRaw: side(`before`) }),
        ...(change.status === `deleted` ? {} : { afterRaw: side(`after`) }),
    };
};

// Row zero's equivalent: the same route with a `working` source and the side the row came from, distinguishing a
// partially staged file's two halves.
const workingRawSides = (change: GitChange, side: GitDiffSide): { beforeRaw?: string; afterRaw?: string } => {
    const url = (which: "before" | "after"): string =>
        `/diff/raw?${new URLSearchParams({ source: `working`, repo: repoRef.value, side, path: change.path, which }).toString()}`;
    return {
        ...(change.status === `added` || change.status === `renamed` ? {} : { beforeRaw: url(`before`) }),
        ...(change.status === `deleted` ? {} : { afterRaw: url(`after`) }),
    };
};

// Opens a diff beside the graph; click peeks (transient), double-click keeps the tab, same grammar as Changes. Row zero
// opens a working-tree diff for its side, keyed `working:<repo>` to match Changes' own tab.
const openFileDiff = (commit: GitCommit, change: GitChange, mode: "peek" | "keep" = `peek`): void => {
    const preview = mode === `peek`;
    showing.value = { sha: commit.sha, path: change.path };
    if (commit.sha === WORKING) {
        const side = working.sideOf(change);
        const tab = {
            key: `working:${repoRef.value}`,
            scope: repoRef.value,
            label: change.path,
            status: change.status,
            path: change.path,
            additions: change.additions,
            deletions: change.deletions,
            preview,
            ...workingRawSides(change, side),
        };
        host().workspace.openDiff({ ...tab, pending: true });
        void workingFileDiff(change.path, side).then((body) => host().workspace.fillDiff({ ...tab, ...body }));
        return;
    }
    const tab = {
        key: `commit:${repoRef.value}:${commit.sha}`,
        scope: repoRef.value,
        label: `${change.path} @ ${commit.short}`,
        status: change.status,
        path: change.path,
        additions: change.additions,
        deletions: change.deletions,
        preview,
        ...rawSides(commit.sha, change),
    };
    host().workspace.openDiff({ ...tab, pending: true });
    void commitFileDiff(commit.sha, change.path).then((body) => host().workspace.fillDiff({ ...tab, ...body }));
};

// Reached through this tab's root, not the module's `navigator`: a popped-out panel's document isn't focused, so a bare
// clipboard write there would silently reject.
const copy = (text: string): void =>
    void clipboardOf(rootEl.value)
        .writeText(text)
        .catch(() => undefined);

// Commit context menu and write actions (VSCode Git Graph parity).
type ActionKind = "branch" | "tag" | "checkout" | "cherry-pick" | "revert" | "drop" | "merge" | "rebase" | "reset";
// Dialog header, confirm label, whether it needs a name, and whether it's destructive; body text computed below.
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
    // Row zero is not a commit; its actions (stage, discard, commit) belong to the Changes panel, not this menu.
    if (commit.sha === WORKING) {
        return;
    }
    // A stash is on no branch, so branch/reset/rebase verbs don't apply; its own three verbs live on its pill.
    if (stashBySha.value.has(commit.sha)) {
        return;
    }
    menuCommit.value = commit;
    menu.value?.show(event);
};
// Whether the first read has lasted long enough to be worth drawing.
const outline = useLoadingReveal(
    computed(() => loading.value && commits.value.length === 0),
    computed(() => `git-history`),
);

const pending = ref<{ kind: ActionKind; commit: GitCommit } | undefined>(undefined);
const nameInput = ref(``);
const resetMode = ref<"soft" | "mixed" | "hard">(`mixed`);
const acting = ref(false);
const actionError = ref<string | undefined>(undefined);

// `target` lets the ref pill's menu reuse these same dialogs, instead of a second copy of the branch/tag flow.
const start = (kind: ActionKind, target?: GitCommit): void => {
    const commit = target ?? menuCommit.value;
    if (commit === undefined) {
        return;
    }
    menuCommit.value = commit;
    nameInput.value = ``;
    resetMode.value = `mixed`;
    actionError.value = undefined;
    pending.value = { kind, commit };
};
const cancelAction = (): void => {
    pending.value = undefined;
    actionError.value = undefined;
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

// Right-click a ref pill to act on it directly; verbs differ by kind (branch/tag/remote), since a remote pill is
// somebody else's branch. Not drag-and-drop: a stale pill acting on a drop target is a worse failure than an extra
// click.
const refMenu = ref<{ show: (event: Event) => void }>();
const refTarget = ref<{ decoration: string; commit: GitCommit } | undefined>(undefined);
const openRefMenu = (event: Event, decoration: string, commit: GitCommit): void => {
    refTarget.value = { decoration, commit };
    refMenu.value?.show(event);
};

// Deduplicated remote names: what a tag can push to, and what tells `origin/main` apart from a slashed branch.
const remoteNames = computed(() => [...new Set(branchState.remotes.value.map((entry) => entry.remote))]);

// A decoration is a tag, a remote branch, or a local one; told apart the same way the pill's styling does.
const refKind = (decoration: string): "tag" | "remote" | "local" => {
    if (refBadge(decoration).tag) {
        return `tag`;
    }
    return remoteNames.value.some((remote) => decoration.startsWith(`${remote}/`)) ? `remote` : `local`;
};

const refMenuItems = computed<MenuItem[]>(() => {
    const target = refTarget.value;
    if (target === undefined) {
        return [];
    }
    const { label } = refBadge(target.decoration);
    const kind = refKind(target.decoration);
    if (kind === `tag`) {
        return [
            // One remote is a verb, several are a choice; a submenu names the choice rather than picking one silently.
            ...remoteNames.value.map((remote) => ({ label: `Push to ${remote}`, command: () => void log.pushTag(label, remote) })),
            { separator: true },
            { label: `Delete tag`, command: () => void log.deleteTag(label) },
            ...remoteNames.value.map((remote) => ({ label: `Delete tag on ${remote}`, command: () => void log.deleteTag(label, remote) })),
        ];
    }
    if (kind === `remote`) {
        // `git checkout <branch>` creates the tracking local branch when exactly one remote has that name.
        const local = target.decoration.slice(target.decoration.indexOf(`/`) + 1);
        return [{ label: `Checkout ${local}`, command: () => void log.checkout(local) }];
    }
    return [
        { label: `Checkout`, command: () => void log.checkout(label) },
        { label: `New branch from here…`, command: () => start(`branch`, target.commit) },
        { separator: true },
        { label: `Push`, command: () => void branchState.push(label) },
        { label: `Delete branch`, command: () => void branchState.remove(label) },
    ];
});

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

// A sequence/HEAD op resolves to a GitActionResult (`ok:false` = a clean-apply conflict); a ref op never has that
// shape.
const isConflict = (result: unknown): boolean =>
    typeof result === `object` && result !== null && `ok` in result && (result as GitActionResult).ok === false;

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
            actionError.value = `Couldn't ${ACTIONS[kind].confirm.toLowerCase()} cleanly: a conflict or uncommitted changes. Resolve it in a terminal.`;
            return; // keep the dialog open with the message
        }
        pending.value = undefined; // success
        if (kind === `checkout` || kind === `reset` || kind === `rebase` || kind === `drop`) {
            openSha.value = undefined; // HEAD moved / history rewrote: the open detail may be stale
        }
    } catch (cause) {
        actionError.value = cause instanceof Error ? cause.message : `Action failed.`;
    } finally {
        acting.value = false;
    }
};
</script>

<template>
    <div ref="rootEl" class="flex h-full min-h-0 flex-col bg-canvas text-content">
        <!-- Header: checked-out branch and how many commits are drawn; which repo this is lives on the tab. -->
        <div class="flex h-8 shrink-0 items-center gap-1.5 border-b border-line-subtle bg-card pl-1.5 pr-3">
            <!-- Checked-out branch with its switch/create/delete popover; detached HEAD shows no pill but keeps the switcher. -->
            <BranchSwitcher :repo="repoRef" />
            <!-- Rows drawn, and while searching, out of how many are loaded; scoped to fetched pages, not the whole history. -->
            <span class="ui-status-pill shrink-0 bg-overlay text-2xs text-muted">{{
                searching ? `${matched.length} of ${commits.length}` : commits.length
            }}</span>
            <div class="relative min-w-0 flex-1 max-w-44">
                <Icon
                    name="search"
                    class="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-2xs text-subtle"
                    aria-hidden="true"
                />
                <input
                    v-model="search"
                    type="text"
                    placeholder="Filter commits…"
                    aria-label="Filter commits by message, author, or sha"
                    :class="ui.inputSm('w-full min-w-0 pl-7', search ? 'pr-7' : 'pr-2')"
                    @keydown.esc="search = ''"
                />
                <button
                    v-if="search"
                    type="button"
                    class="absolute top-1/2 right-1.5 flex -translate-y-1/2 items-center rounded text-2xs text-subtle transition-colors hover:text-content"
                    aria-label="Clear filter"
                    @click="search = ''"
                >
                    <Icon name="times" />
                </button>
            </div>
            <!-- Names the action it would undo; absent for a fresh branch, detached HEAD, or a halted op that aborts instead. -->
            <Button
                v-if="undo.label.value"
                size="small"
                severity="secondary"
                :text="true"
                class="shrink-0"
                :disabled="undo.busy.value"
                @click="runUndo"
                v-tooltip.bottom="
                    `${undo.action.value?.description ?? ''}: moves ${undo.action.value?.branch ?? 'the branch'} back. A restore point is saved first.`
                "
            >
                <Icon name="undo" class="mr-0.5 text-3xs" />{{ undo.label.value }}
            </Button>
            <Icon v-if="loading" name="spinner" class="shrink-0 text-2xs text-subtle" spin />
        </div>

        <p v-if="error" class="shrink-0 truncate px-3 py-1 text-2xs text-danger" v-tooltip.bottom.overflow="error">{{ error }}</p>
        <p v-if="undo.actionError.value" class="shrink-0 truncate px-3 py-1 text-2xs text-danger">{{ undo.actionError.value }}</p>
        <p v-if="stashes.actionError.value" class="shrink-0 px-3 py-1 text-2xs text-danger">{{ stashes.actionError.value }}</p>
        <p v-if="branchState.actionError.value" class="shrink-0 px-3 py-1 text-2xs text-danger">{{ branchState.actionError.value }}</p>

        <!--
            A halted rebase leaves HEAD somewhere unexpected with half its commits replayed; this explains the aftermath the graph alone doesn't. Git
            also refuses most menu verbs until the operation ends, which this banner makes legible.
        -->
        <div v-if="operation.operation.value" class="flex shrink-0 items-start gap-1.5 border-b border-warning/40 bg-warning/10 px-3 py-1.5">
            <Icon name="exclamation-triangle" class="mt-0.5 shrink-0 text-2xs text-warning" />
            <div class="min-w-0 flex-1">
                <p class="text-2xs font-medium text-warning">A {{ operation.operation.value }} is in progress</p>
                <p class="text-2xs text-muted">
                    Resolve the conflicts in the Changes panel and stage them to continue, or abort to return this repository to where the
                    {{ operation.operation.value }} began.
                </p>
                <p v-if="operation.actionError.value" class="text-2xs text-danger">{{ operation.actionError.value }}</p>
            </div>
            <Button
                size="small"
                severity="warn"
                class="shrink-0"
                :disabled="operation.busy.value"
                @click="operation.abort()"
                v-tooltip.bottom="'A restore point is saved first, so this is reversible from Restore points'"
            >
                Abort
            </Button>
        </div>

        <!-- One row per commit: an SVG gutter (lanes/edges/node) then metadata. Click to expand detail inline, right-click for the action menu. -->
        <div class="scrollbar-thin min-h-0 flex-1 overflow-auto">
            <!--
                Skeleton rows stand in for the ones about to load: a gutter dot, a subject line, an author line. The gutter is a column of plain
                dots, not invented lanes, since the branch shape itself is what this view exists to show.
            -->
            <div v-if="loading && commits.length === 0" role="status" aria-busy="true">
                <span class="sr-only">Reading this repository's history…</span>
                <div v-for="row in outline ? 8 : 0" :key="row" class="flex items-center gap-2 px-3 py-1.5" aria-hidden="true">
                    <span class="skeleton block h-2 w-2 shrink-0 rounded-full" />
                    <div class="flex min-w-0 flex-1 flex-col gap-1">
                        <span class="skeleton block h-2.5" :class="[`w-64`, `w-48`, `w-72`, `w-56`][row % 4]" />
                        <span class="skeleton block h-2" :class="[`w-28`, `w-36`][row % 2]" />
                    </div>
                </div>
            </div>
            <p v-else-if="commits.length === 0" class="px-3 py-3 text-2xs text-subtle">No commits yet in this repository.</p>
            <p v-else-if="searching && matched.length === 0" class="px-3 py-3 text-2xs text-subtle">
                No loaded commit matches. Scroll to load more of the history, then search again.
            </p>
            <!-- A @container per row: which columns fit depends on this panel's width, which the reader controls. -->
            <div v-for="{ row, commit } in graphRows" :key="commit.sha" class="@container">
                <button
                    type="button"
                    class="ui-row-select flex w-full items-center gap-2 py-0 pl-3 pr-3 text-left transition-opacity"
                    :class="{ 'ui-row-select-on': commit.sha === openSha, 'opacity-40': dimmed(row.color) }"
                    :style="{ height: `${ROW_H}px` }"
                    @click="toggle(commit.sha)"
                    @contextmenu.prevent.stop="openMenu($event, commit)"
                    @mouseenter="hovered = row.color"
                    @mouseleave="hovered = undefined"
                >
                    <svg :width="gutterWidth" :height="ROW_H" class="shrink-0" aria-hidden="true">
                        <!-- Each segment fades by its own branch colour, not the row's, so a hovered branch stays lit behind others. -->
                        <line
                            v-for="(edge, index) in row.up"
                            :key="`u${index}`"
                            :x1="laneX(edge.from)"
                            :y1="0"
                            :x2="laneX(edge.to)"
                            :y2="ROW_H / 2"
                            :stroke="laneColor(edge.color)"
                            :opacity="dimmed(edge.color) ? 0.25 : 1"
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
                            :opacity="dimmed(edge.color) ? 0.25 : 1"
                            stroke-width="1.5"
                        />
                        <!-- Hollow for row zero, since it isn't a real object yet; filled for a commit, ringed for HEAD. -->
                        <circle
                            :cx="laneX(row.col)"
                            :cy="ROW_H / 2"
                            :r="commit.head ? NODE_R + 1 : NODE_R"
                            :fill="commit.sha === WORKING ? 'var(--color-canvas)' : laneColor(row.color)"
                            :stroke="commit.sha === WORKING ? laneColor(row.color) : commit.head ? 'var(--color-content)' : 'none'"
                            stroke-width="1.5"
                        />
                    </svg>
                    <!-- A stash wears its ref as a pill, like a branch or tag; the name is also the handle its verbs take. -->
                    <span
                        v-if="stashBySha.get(commit.sha)"
                        class="shrink-0 rounded bg-info/15 px-1 font-mono text-3xs text-info"
                        v-tooltip.top="'Work set aside without committing it'"
                        >{{ stashBySha.get(commit.sha)!.ref }}</span
                    >
                    <span v-if="commit.head" class="shrink-0 rounded bg-primary-600/20 px-1 text-3xs font-semibold text-link">HEAD</span>
                    <!-- Right-clickable, so acting on a ref doesn't mean hunting for it in the commit's own menu. -->
                    <span
                        v-for="ref in commit.refs.slice(0, 3)"
                        :key="ref"
                        class="shrink-0 cursor-context-menu rounded px-1 text-3xs"
                        :class="refBadge(ref).tag ? 'bg-warning/15 text-warning' : 'bg-overlay text-muted'"
                        v-tooltip.top="`Right-click for ${refBadge(ref).label} actions`"
                        @contextmenu.prevent.stop="openRefMenu($event, ref, commit)"
                        >{{ refBadge(ref).label }}</span
                    >
                    <span class="min-w-0 flex-1 truncate text-xs" :class="commit.sha === openSha ? 'text-content' : 'text-content/90'">{{
                        commit.subject
                    }}</span>
                    <!-- Row zero has no author, date or sha yet; instead it shows how much is uncommitted and whether any is blocking. -->
                    <template v-if="commit.sha === WORKING">
                        <span v-if="working.conflicted.value > 0" class="shrink-0 text-2xs text-danger"
                            >{{ working.conflicted.value }} conflicted</span
                        >
                        <span class="shrink-0 text-2xs text-subtle">{{ working.changes.value.length }} changed</span>
                    </template>
                    <!-- A stash's three verbs sit on the row, not a menu nobody would open for them; Pop leads as the common case. -->
                    <template v-else-if="stashBySha.get(commit.sha)">
                        <span class="hidden shrink-0 text-2xs text-subtle @md:block">{{ timeAgo(commit.at) }}</span>
                        <span
                            v-for="verb in [
                                {
                                    label: 'Pop',
                                    title: 'Put this work back and remove the stash',
                                    run: () => stashes.apply(stashBySha.get(commit.sha)!.ref, true),
                                },
                                {
                                    label: 'Apply',
                                    title: 'Put this work back and keep the stash',
                                    run: () => stashes.apply(stashBySha.get(commit.sha)!.ref, false),
                                },
                                {
                                    label: 'Drop',
                                    title: 'Discard this stash, a restore point is saved first',
                                    run: () => stashes.drop(stashBySha.get(commit.sha)!.ref),
                                },
                            ]"
                            :key="verb.label"
                            class="shrink-0 cursor-pointer rounded px-1 text-2xs text-subtle transition-colors hover:bg-overlay hover:text-content"
                            :class="{ 'pointer-events-none opacity-40': stashes.busy.value }"
                            v-tooltip.top="verb.title"
                            @click.stop="verb.run()"
                            >{{ verb.label }}</span
                        >
                    </template>
                    <template v-else>
                        <span class="hidden shrink-0 truncate text-2xs text-subtle @2xl:block @2xl:max-w-32">{{ commit.author }}</span>
                        <span class="hidden shrink-0 text-2xs text-subtle @md:block">{{ timeAgo(commit.at) }}</span>
                        <span class="shrink-0 font-mono text-3xs text-subtle">{{ commit.short }}</span>
                    </template>
                </button>

                <!-- Inline detail: commit metadata and its changed files; click a file for a diff at that commit. -->
                <div v-if="commit.sha === openSha" class="border-y border-line bg-card px-3 py-2">
                    <!-- Row zero has no sha, parents, author or date; it opens straight to its file list, the rest lives in Changes. -->
                    <dl v-if="commit.sha !== WORKING" class="grid grid-cols-facts gap-x-3 gap-y-0.5 text-2xs">
                        <dt class="text-subtle">Commit</dt>
                        <dd class="flex items-center gap-1 font-mono text-muted">
                            {{ commit.sha }}
                            <button type="button" class="text-subtle hover:text-content" @click="copy(commit.sha)" v-tooltip.top="'Copy full SHA'">
                                <Icon name="copy" class="text-3xs" />
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

                    <div class="mt-2 pt-1.5" :class="commit.sha === WORKING ? '' : 'border-t border-line-subtle'">
                        <p v-if="filesError" class="text-2xs text-danger">{{ filesError }}</p>
                        <p v-else-if="filesLoading" class="text-2xs text-subtle">Loading changed files…</p>
                        <template v-else>
                            <p class="mb-1 text-2xs font-medium uppercase tracking-wide text-subtle">
                                {{ files.length }} changed {{ files.length === 1 ? "file" : "files" }}
                            </p>
                            <!--
                                Collapsible directory tree of changed files; click peeks a diff beside this pane, double-click keeps the tab, and the
                                row stays marked while showing.
                            -->
                            <div class="scrollbar-thin max-h-64 overflow-auto">
                                <template v-for="row in fileRows" :key="`${row.kind}:${row.path}`">
                                    <button
                                        v-if="row.kind === 'dir'"
                                        type="button"
                                        class="flex w-full items-center gap-1.5 py-0.5 text-left text-xs text-muted transition-colors hover:bg-overlay"
                                        :style="{ paddingLeft: `${0.25 + row.depth * 0.85}rem` }"
                                        @click="toggleDir(row.path)"
                                    >
                                        <Icon :name="row.expanded ? 'chevron-down' : 'chevron-right'" class="w-2.5 shrink-0 text-3xs text-subtle" />
                                        <Icon name="folder" class="shrink-0 text-2xs text-subtle" />
                                        <span class="min-w-0 flex-1 truncate">{{ row.name }}</span>
                                    </button>
                                    <button
                                        v-else
                                        type="button"
                                        class="ui-row-select flex w-full items-center gap-1.5 py-0.5 text-left text-xs transition-colors"
                                        :class="{
                                            'ui-row-select-on': showing?.sha === commit.sha && showing?.path === row.file.path,
                                        }"
                                        :style="{ paddingLeft: `${0.25 + row.depth * 0.85}rem` }"
                                        v-tooltip.top="'Click to peek · double-click to keep the tab'"
                                        @click="openFileDiff(commit, row.file)"
                                        @dblclick="openFileDiff(commit, row.file, 'keep')"
                                    >
                                        <span class="w-2.5 shrink-0"></span>
                                        <ChangeStatusMark :status="row.file.status" />
                                        <span class="min-w-0 flex-1 truncate text-content/90">{{ row.name }}</span>
                                        <DiffStat :additions="row.file.additions" :deletions="row.file.deletions" />
                                    </button>
                                </template>
                            </div>
                        </template>
                    </div>
                </div>
            </div>
            <!-- Pulls in the next page when this comes into view; absent on the last page, which is how the observer knows to stop. -->
            <div v-if="hasMore" ref="sentinel" class="px-3 py-2 text-2xs text-subtle">
                <Icon v-if="fetchingMore" name="spinner" class="mr-1 text-2xs" spin />{{
                    fetchingMore ? "Loading older commits…" : "Scroll for older commits"
                }}
            </div>
        </div>

        <!-- Right-click commit menu (VSCode "Git Graph" parity), grouped with separators. -->
        <ContextMenu ref="menu" :model="menuItems" :min-width="14" />
        <!-- The ref pills' own menu, whose verbs depend on whether the pill is a branch, tag, or remote-tracking. -->
        <ContextMenu ref="refMenu" :model="refMenuItems" :min-width="14" />

        <!--
            One dialog per action: a name input, a mode picker, or a plain confirm; destructive ones carry the checkpoint reassurance, a conflict
            shows inline.
        -->
        <Modal :open="pending !== undefined" size="sm" :header="pending ? ACTIONS[pending.kind].header : ''" @update:open="cancelAction">
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
                    class="ui-field-box ui-field-sm mt-3 w-full"
                    @keydown.enter="runPending"
                    autofocus
                />

                <div v-if="pending.kind === 'reset'" class="mt-3 flex flex-col gap-1.5">
                    <SegmentedControl
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
                    <Icon name="shield" class="mr-0.5 text-3xs" />A restore point is saved first, so this is reversible from Restore points.
                </p>
                <p v-if="actionError" class="mt-2 text-2xs text-danger">{{ actionError }}</p>
            </template>
            <template #footer>
                <Button size="small" severity="secondary" :text="true" label="Cancel" @click="cancelAction" />
                <Button
                    v-if="pending"
                    size="small"
                    :severity="ACTIONS[pending.kind].danger ? `warn` : `success`"
                    :label="ACTIONS[pending.kind].confirm"
                    :disabled="acting || (ACTIONS[pending.kind].needsName && nameInput.trim() === '')"
                    @click="runPending"
                />
            </template>
        </Modal>
    </div>
</template>
