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

/* One repo's git-history graph: the committed side of the real-git story whose uncommitted side is the Changes
 * panel (this is NOT the Checkpoints safety timeline). A wide document, so it lives in the main editor area as a
 * tab (VSCode puts its SCM list in the sidebar and the graph in an editor tab; we mirror that). The lane
 * geometry is computed by graphLayout.ts; this file is the SVG mapping, the inline expandable commit detail
 * (click a row), and the commit context menu (right-click): VSCode "Git Graph" parity. Every write action is
 * auto-checkpointed daemon-side, so even a rebase / hard reset stays reversible from the Checkpoints timeline.
 *
 * The host binds `path` (a document provider renders per DIRECTORY), and the repo is what sits on it. There is
 * no repo switcher in here any more: the tree row IS the switcher, which is the whole point of the document
 * being per-directory rather than a single view with a dropdown inside it. */

const { path } = defineProps<{ path: string }>();

// The provider only offers this document for a directory that IS a repo, so the fallback is unreachable in
// practice: it exists so a tab restored against a repo that has since been deleted degrades to the root's
// history rather than to a broken request.
const repoRef = computed(() => repoAt(path) ?? `root`);
// This tab's root: the element a clipboard write is reached through, so it lands in the window the reader is
// actually looking at rather than the opener's (see clipboardOf).
const rootEl = ref<HTMLElement>();
const log = useGitLog(repoRef);
const { commits, branch, loading, error, hasMore, fetchingMore, loadMore, commitFiles, commitFileDiff, workingFileDiff } = log;
// A merge/rebase/cherry-pick/revert a TERMINAL left halted. Nothing this tab starts can cause one: every write
// it makes aborts cleanly daemon-side, which is exactly why the graph has to say so when something else did.
const operation = useOperation(repoRef);
/* The branch-level counterpart to the Checkpoints timeline: a checkpoint puts the FILES back, this puts the
 * BRANCH back. Offered in the header rather than behind a menu because the moment it is wanted: a rebase just
 * went somewhere unexpected: is the moment nobody wants to go looking for it. */
const undo = useUndo(repoRef);
// The same branch state BranchSwitcher renders: one query key, so vue-query serves both from one request. The
// tab needs it for the ref pills: which remotes exist, and the push/delete verbs behind a branch pill.
const branchState = useBranches(repoRef);
// Hard for anything that rewrote files (a rebase, a reset, a pull), soft for a commit or an amend, whose content
// is already in the tree and should stay there. The action itself says which it was.
const runUndo = (): Promise<void> => undo.undo(undo.action.value?.changesWorkingTree === true);

// Lane geometry. The gutter is laneCount columns wide; a node sits at the row's vertical center in its lane.
const LANE_W = 14;
const ROW_H = 28;
const NODE_R = 3.5;
const LANE_COLORS = [`#3b82f6`, `#22c55e`, `#eab308`, `#ef4444`, `#a855f7`, `#06b6d4`, `#f97316`, `#ec4899`];
const laneColor = (index: number): string => LANE_COLORS[index % LANE_COLORS.length] ?? LANE_COLORS[0]!;
const laneX = (lane: number): number => LANE_W / 2 + lane * LANE_W;

/* ROW ZERO: THE UNCOMMITTED WORK. The graph is the committed side of the story and the Changes panel is the
 * uncommitted side, and until this row existed the newest thing in the repository was never the newest thing in
 * the graph.
 *
 * It goes through the LAYOUT as an ordinary commit parented to HEAD rather than being drawn above it as a
 * detached header, because that is what makes it connect: the lane geometry draws the line down to HEAD for
 * free, and the row sits in HEAD's own column instead of floating beside it. `WORKING` is a sha no object can
 * have, so nothing else in the graph can collide with it. */
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
/* STASHES, drawn as what they are: commits that hang off the history rather than flowing down it.
 *
 * Each entry is spliced in DIRECTLY ABOVE the commit it was taken on, carrying only that commit as its parent:
 * its other parents (the index tree, and the untracked tree when `-u` was used) are not in the log and would be
 * dropped anyway. That placement is the whole trick: the existing lane algorithm then gives the stash a free
 * lane and its own colour, and draws its edge bending into the commit one row below. No special case in the
 * layout, and the picture is the true one: work set aside AT that commit.
 *
 * A stash whose parent commit is outside the fetched window is left out rather than floated: an edge to nothing
 * would read as a root commit, which is the one thing a stash is not. */
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
// Which rows ARE stashes, by sha: the renderer needs it for the pill and the detail, and a Map keeps the
// lookup out of the row loop.
const stashBySha = computed(() => new Map(stashes.stashes.value.map((entry) => [entry.sha, entry])));

/* SEARCH NARROWS THE ROWS, and it narrows them BEFORE the layout runs, so the lanes are recomputed over what
 * is actually on screen rather than drawn for the full history and then hidden. Hiding rows would leave edges
 * running to commits that are no longer there, which reads as corruption rather than as a filter.
 *
 * It searches the pages that have been LOADED, which is the honest scope and the one the header states: a
 * server-side search over a hundred-thousand-commit history is a different feature (`git log --grep`) with
 * different semantics, and pretending a client-side filter is that would be worse than saying so. */
const search = ref(``);
const words = computed(() => searchWords(search.value));
const searching = computed(() => words.value.length > 0);
const matched = computed(() => (searching.value ? commits.value.filter((commit) => matchesSearch(commit, words.value)) : commits.value));

const rowCommits = computed<readonly GitCommit[]>(() => {
    const byParent = stashRows.value;
    // A plain loop rather than a flatMap: almost no commit has a stash on it, and the map form would allocate a
    // throwaway array for every one that does not.
    // While searching, the synthetic rows are left out: neither the uncommitted work nor a stash is a commit
    // the reader typed a query about, and keeping them pinned to the top of a filtered list would be two rows
    // that never match and never go away.
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

/* HOVER TO TRACE A BRANCH. In a graph more than two or three lanes wide, following one line down through the
 * merges it crosses is genuinely hard: the eye loses the colour among its neighbours. Hovering a row fades
 * everything that is not on that row's branch, which turns a search into a glance.
 *
 * Keyed by the branch COLOUR rather than by walking the parent graph, and that is exact rather than an
 * approximation: the layout already assigns one colour per branch for its whole descent (see graphLayout), so
 * "same colour" IS "same branch": including where the branch changes column, which is precisely where a reader
 * loses it.
 *
 * Reactive, not a class mutated onto queried DOM: the rows are already a `v-for` over computed state, so an
 * opacity bound to a ref is both less code and correct through re-renders, scrolling and virtualisation. It also
 * cannot leak a stale `dimmed` class onto a row that has since become something else.
 */
const hovered = ref<number | undefined>(undefined);
// A row is dimmed when SOMETHING is hovered and it is not on that branch. Nothing hovered dims nothing, which is
// the resting state and must cost no work.
const dimmed = (color: number): boolean => hovered.value !== undefined && hovered.value !== color;

/* PULLING THE NEXT PAGE. An IntersectionObserver on a sentinel below the last row rather than a scroll
 * listener: it fires once when the row comes into view, costs nothing while it is off screen, and does not run
 * on every wheel event through a list that can be thousands of rows long.
 *
 * `rootMargin` starts the fetch a screenful early, so scrolling stays continuous instead of stopping at the
 * bottom to wait. The observer re-attaches when the sentinel element changes (it is `v-if`'d away on the last
 * page), and `fetchingMore` guards the re-entry an observer will otherwise fire while the request is in flight.
 */
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

// A ref decoration split into its kind, a branch pill vs a `tag: x` pill; HEAD is surfaced separately.
const refBadge = (decoration: string): { tag: boolean; label: string } =>
    decoration.startsWith(`tag: `) ? { tag: true, label: decoration.slice(`tag: `.length) } : { tag: false, label: decoration };

// --- inline expandable detail (accordion): one commit open at a time; its changed files load lazily ----------
const openSha = ref<string | undefined>(undefined);
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
    // Row zero's files are already in hand: they came from the same scan the Changes panel renders, so there
    // is nothing to fetch and nothing that can fail.
    if (sha === WORKING) {
        files.value = working.changes.value;
        return;
    }
    const token = (detailToken += 1);
    filesLoading.value = true;
    const stash = stashBySha.value.get(sha);
    try {
        // A stash's diff spans three parent trees (tracked, index, untracked), which only `git stash show` knows
        // how to read: hence its own route rather than the commit one.
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

/* The bytes behind a BINARY diff. The daemon's file-diff route ships text and can only FLAG an image
 * (`binary: true`), so the picture itself is fetched per side from /diff/raw, at this commit and its first
 * parent: the same pair the text diff compares. Which sides exist is read off git's status letter rather than
 * off the response: a binary diff ships no text to infer it from, an added file has no before, a deleted one no
 * after, and a rename's before side sits at a path this route cannot pair. */
const rawSides = (sha: string, change: GitChange): { beforeRaw?: string; afterRaw?: string } => {
    const side = (which: "before" | "after"): string =>
        `/diff/raw?${new URLSearchParams({ source: `commit`, repo: repoRef.value, sha, path: change.path, which }).toString()}`;
    return {
        ...(change.status === `added` || change.status === `renamed` ? {} : { beforeRaw: side(`before`) }),
        ...(change.status === `deleted` ? {} : { afterRaw: side(`after`) }),
    };
};

// Row zero's equivalent: the same route, a `working` source, and the git side the row came from, which is what
// distinguishes a partially staged file's two halves.
const workingRawSides = (change: GitChange, side: GitDiffSide): { beforeRaw?: string; afterRaw?: string } => {
    const url = (which: "before" | "after"): string =>
        `/diff/raw?${new URLSearchParams({ source: `working`, repo: repoRef.value, side, path: change.path, which }).toString()}`;
    return {
        ...(change.status === `added` || change.status === `renamed` ? {} : { beforeRaw: url(`before`) }),
        ...(change.status === `deleted` ? {} : { afterRaw: url(`after`) }),
    };
};

/* The host owns the tab strip; this hands it a diff and it lands beside the files it is about.
 *
 * Row zero opens a WORKING-TREE diff instead of a commit one, against the side the row came from: a partially
 * staged file's staged and unstaged halves are two different diffs, and opening whichever happened to be found
 * first would show the user the wrong one. Keyed `working:<repo>` so it is the same tab identity the app's own
 * Changes panel opens, which means clicking a file in either place focuses one tab rather than stacking two. */
// Awaited rather than fired and forgotten: the promise is what holds the row while the diff is fetched, so a
// second click on a slow one cannot open it twice.
const openFileDiff = async (commit: GitCommit, change: GitChange): Promise<void> => {
    if (commit.sha === WORKING) {
        const side = working.sideOf(change);
        await workingFileDiff(change.path, side).then((body) => {
            host().workspace.openDiff({
                key: `working:${repoRef.value}`,
                scope: repoRef.value,
                label: change.path,
                status: change.status,
                path: change.path,
                additions: change.additions,
                deletions: change.deletions,
                ...body,
                ...workingRawSides(change, side),
            });
        });
        return;
    }
    await commitFileDiff(commit.sha, change.path).then((body) => {
        host().workspace.openDiff({
            key: `commit:${repoRef.value}:${commit.sha}`,
            scope: repoRef.value,
            label: `${change.path} @ ${commit.short}`,
            status: change.status,
            path: change.path,
            additions: change.additions,
            deletions: change.deletions,
            ...body,
            ...rawSides(commit.sha, change),
        });
    });
};

/* Reached through this tab's root, not the module's `navigator`: a POPPED-OUT panel keeps its JS in the opener's
 * realm, whose document isn't focused, so an async clipboard write from there rejects and this catch swallowed
 * it: copying a SHA out of a popped-out history did nothing at all. See clipboardOf. */
const copy = (text: string): void =>
    void clipboardOf(rootEl.value)
        .writeText(text)
        .catch(() => undefined);

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
    // Row zero is not a commit: there is nothing to branch from, tag, cherry-pick or reset to. Its actions
    // (stage, discard, commit) are the Changes panel's, and duplicating them here would be two places to do one
    // thing with two different sets of confirmations.
    if (commit.sha === WORKING) {
        return;
    }
    // A stash is not on any branch, so branching from it, resetting to it or rebasing onto it are all
    // meaningless. Its own three verbs live on its pill instead.
    if (stashBySha.value.has(commit.sha)) {
        return;
    }
    menuCommit.value = commit;
    menu.value?.show(event);
};
// Whether the first read has lasted long enough to be worth drawing: see useLoadingReveal.
const outline = useLoadingReveal(
    computed(() => loading.value && commits.value.length === 0),
    computed(() => `git-history`),
);

const pending = ref<{ kind: ActionKind; commit: GitCommit } | undefined>(undefined);
const nameInput = ref(``);
const resetMode = ref<"soft" | "mixed" | "hard">(`mixed`);
const acting = ref(false);
const actionError = ref<string | undefined>(undefined);

// `target` lets the REF pill's menu drive the same dialogs the commit menu does, rather than the two growing
// separate copies of the branch/tag flow.
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

/* WHAT A REF PILL CAN DO. The pills were inert labels: a branch name you could read and not act on, a tag you
 * could create from the commit menu and then never touch again. Right-clicking the thing you want to act on is
 * the gesture people already try, so the pills answer it.
 *
 * The verbs differ by KIND because the nouns do. A branch is a place you can go (checkout), publish (push) or
 * stop keeping (delete). A tag is a marker you publish or remove. A remote-tracking pill is somebody else's
 * branch, so its only local verb is checking out a copy of it: deleting it is their repository's business.
 *
 * Deliberately NOT drag-and-drop, which is where git-go takes this next: dropping a branch on a branch to merge
 * is a large surface with its own hold-to-reveal vocabulary, and in a workspace where most refs move because an
 * agent moved them, a gesture that acts on a stale pill is a worse failure than an extra click. */
const refMenu = ref<{ show: (event: Event) => void }>();
const refTarget = ref<{ decoration: string; commit: GitCommit } | undefined>(undefined);
const openRefMenu = (event: Event, decoration: string, commit: GitCommit): void => {
    refTarget.value = { decoration, commit };
    refMenu.value?.show(event);
};

// Which remotes this repo has, deduplicated: the set a tag can be pushed to, and what tells `origin/main`
// apart from a local branch that happens to have a slash in its name.
const remoteNames = computed(() => [...new Set(branchState.remotes.value.map((entry) => entry.remote))]);

// A decoration is a tag, a remote-tracking branch (`origin/main`) or a local branch: three different sets of
// verbs, told apart the same way the pill's own styling tells them apart.
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
            // One remote or several: with one it is a verb, with several it is a choice, and a submenu is the
            // honest shape for "which remote" rather than picking one silently.
            ...remoteNames.value.map((remote) => ({ label: `Push to ${remote}`, command: () => void log.pushTag(label, remote) })),
            { separator: true },
            { label: `Delete tag`, command: () => void log.deleteTag(label) },
            ...remoteNames.value.map((remote) => ({ label: `Delete tag on ${remote}`, command: () => void log.deleteTag(label, remote) })),
        ];
    }
    if (kind === `remote`) {
        // `git checkout <branch>` creates the tracking local branch when exactly one remote has the name, which
        // is what a reader clicking a remote pill means.
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

// The result of a sequence/HEAD op is a GitActionResult (ok:false = a clean-apply conflict); a ref op resolves
// to something without an `ok:false`. Anything thrown (git error) is caught below.
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
        <!-- Header: checked-out branch · how many commits are drawn. Which repo this is lives on the tab. -->
        <div class="flex h-8 shrink-0 items-center gap-1.5 border-b border-line-subtle bg-card pl-1.5 pr-3">
            <!-- The checked-out branch, and the switch/create/delete popover behind it. A detached HEAD has
                 no branch to show as a pill, but the switcher is still the way BACK onto one. -->
            <BranchSwitcher :repo="repoRef" />
            <!-- How many rows are drawn, and, while searching: out of how many are loaded. Saying "of 300"
                 rather than "of all" is the honest scope: this filters the pages that have been fetched. -->
            <span class="shrink-0 rounded-full bg-overlay px-1.5 py-px text-2xs text-muted">{{
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
            <!-- Names the action it will undo, in git's own words on hover. Absent when there is nothing to walk
                 back: a fresh branch, a detached HEAD, or a halted operation (which ends by aborting instead). -->
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

        <!-- WHY THE GRAPH LOOKS WRONG. A halted rebase has replayed half its commits and left HEAD somewhere the
             reader did not put it; without this the graph shows the aftermath and explains none of it. Git also
             refuses almost every verb in this tab's menu until the operation ends, so the banner is what makes
             those refusals legible instead of mysterious. -->
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

        <!-- The graph: one row per commit (a per-row SVG gutter drawing lanes/edges/node, then metadata). Click a
             row to expand its detail inline (accordion); right-click for the commit action menu. -->
        <div class="scrollbar-thin min-h-0 flex-1 overflow-auto">
            <!-- "Loading history…" was one small grey line standing in for a full-height graph, so the panel
                 was empty in every way that shows and the whole log dropped in at once. The rows the log is
                 about to draw stand in: the lane gutter on the left, the subject, and the author line under
                 it. The gutter is a column of dots rather than lanes: the SHAPE of somebody's branch history
                 is what this view exists to show, and it is the last thing to invent. -->
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
            <!-- A @container per row: which of the author/date/sha columns fit is a fact about the row, and this
                 view is a workspace panel whose width the reader sets. -->
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
                        <!-- Each segment fades on ITS OWN branch's colour rather than the row's, so a hovered
                             branch stays lit through the rows of other branches it passes behind. -->
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
                        <!-- HOLLOW for row zero: it is not an object in the repository yet, and a filled dot
                             would claim it is. Filled for a real commit, ringed for HEAD. -->
                        <circle
                            :cx="laneX(row.col)"
                            :cy="ROW_H / 2"
                            :r="commit.head ? NODE_R + 1 : NODE_R"
                            :fill="commit.sha === WORKING ? 'var(--color-canvas)' : laneColor(row.color)"
                            :stroke="commit.sha === WORKING ? laneColor(row.color) : commit.head ? 'var(--color-content)' : 'none'"
                            stroke-width="1.5"
                        />
                    </svg>
                    <!-- A stash wears its ref as a pill, the way a branch or tag does: it is a named thing you
                         can act on, and the name (`stash@{0}`) is also the handle its verbs take. -->
                    <span
                        v-if="stashBySha.get(commit.sha)"
                        class="shrink-0 rounded bg-info/15 px-1 font-mono text-3xs text-info"
                        v-tooltip.top="'Work set aside without committing it'"
                        >{{ stashBySha.get(commit.sha)!.ref }}</span
                    >
                    <span v-if="commit.head" class="shrink-0 rounded bg-primary-600/20 px-1 text-3xs font-semibold text-link">HEAD</span>
                    <!-- Right-clickable: a pill is the thing you want to act on, so it answers the gesture
                         rather than sending you to the commit's menu to find a verb about a ref. -->
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
                    <!-- Row zero has no author, no date and no sha: none of them exist yet. What it has instead
                         is how much is uncommitted, and whether any of it is blocking. -->
                    <template v-if="commit.sha === WORKING">
                        <span v-if="working.conflicted.value > 0" class="shrink-0 text-2xs text-danger"
                            >{{ working.conflicted.value }} conflicted</span
                        >
                        <span class="shrink-0 text-2xs text-subtle">{{ working.changes.value.length }} changed</span>
                    </template>
                    <!-- A stash's three verbs, on the row rather than in a context menu: they are the only
                         things you can do with one, and a menu for three items nobody would guess are hidden
                         there is a menu nobody opens. `pop` is the common case, so it leads. -->
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

                <!-- Inline detail (accordion): commit metadata + the files it changed (click one for a diff at
                     that commit). Replaces the old bottom pane; the file list scrolls if it's long. -->
                <div v-if="commit.sha === openSha" class="border-y border-line bg-card px-3 py-2">
                    <!-- Row zero has no sha, no parents, no author and no date, so it opens straight into its
                         file list. Everything it WOULD say lives in the Changes panel, which is where it can
                         also be acted on. -->
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
                                        <Icon :name="row.expanded ? 'chevron-down' : 'chevron-right'" class="w-2.5 shrink-0 text-3xs text-subtle" />
                                        <Icon name="folder" class="shrink-0 text-2xs text-subtle" />
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
            <!-- The next page pulls itself in when this comes into view. Absent on the last page, which is
                 also how the observer knows to stop. -->
            <div v-if="hasMore" ref="sentinel" class="px-3 py-2 text-2xs text-subtle">
                <Icon v-if="fetchingMore" name="spinner" class="mr-1 text-2xs" spin />{{
                    fetchingMore ? "Loading older commits…" : "Scroll for older commits"
                }}
            </div>
        </div>

        <!-- Right-click commit menu (VSCode "Git Graph" parity), grouped with separators. -->
        <ContextMenu ref="menu" :model="menuItems" :min-width="14" />
        <!-- And the ref pills' own, whose verbs depend on whether the pill is a branch, a tag, or somebody
             else's remote-tracking branch. -->
        <ContextMenu ref="refMenu" :model="refMenuItems" :min-width="14" />

        <!-- One dialog for every action: a name input (branch/tag), a mode picker (reset), or a plain confirm.
             Destructive ops carry the auto-checkpoint reassurance; a clean-apply conflict shows inline. -->
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
