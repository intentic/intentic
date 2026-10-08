<script setup lang="ts">
import {
    Button,
    ChangeStatusMark,
    EmptyState,
    explorerColorClass,
    iconForEntry,
    isTypingTarget,
    Notice,
    ResizeSeam,
    SegmentedControl,
    type Tip,
    toneWash,
    ui,
    useDevice,
    useExplorerStyle,
    useLoadingReveal,
} from "@intentic/ui";
import { isTestPath, type WorkspaceModule, type FileDiff } from "@intentic/sandbox-contract";
import type { LineStat } from "@intentic/code-read";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, type Ref, watch } from "vue";
import { useRouter } from "vue-router";
import ReviewStat from "../../workspace/changes/ReviewStat.vue";
import { draftStrayAsk, stopAgent } from "../fleet/agentActions";
import { boxNameOf, openInSandbox } from "../fleet/fleetScope";
import { CONFLICT_ICON, reasonCopy } from "./conflictResolution";
import { AGENT_FILE_DIFF_OPTIONS, agentFileDiffKey, type AgentReviewFile, readAgentFileDiff, useAgentChanges } from "./useAgentChanges";
import { useAgentHistory } from "../fleet/useAgentHistory";
import { documentsAt } from "../../../workbench/views/documentRegistry";
import { GIT_TAB } from "../../workspace/directory-ui/directoryTabs";
import { useDirectoryTabs } from "../../workspace/directory-ui/useDirectoryTabs";
import { useSandboxQuery } from "../../../client/sandbox/useSandboxQuery";
import { defaultReviewListWidth, MAX_REVIEW_LIST_WIDTH, MIN_REVIEW_LIST_WIDTH, useLayout } from "../../../workbench/window/useLayout";
import { toAppPx, toScreenPx, uiLength } from "../../../workbench/window/uiScale";
import { diffRawUrls } from "../../workspace/changes/diffRaw";
// Where the user's own conflict half is resolved: the Changes panel, the same deep-link the card and the badges use.
import { openChanges } from "../../workspace/changes/openChanges";
import { useWorkspaceTabs } from "../../workspace/tabs/useWorkspaceTabs";
import DiffToolbar from "../../workspace/viewers/DiffToolbar.vue";
import FileDiffPane from "../../workspace/viewers/FileDiffPane.vue";
import { EMPTY_MODULE_VIEW, moduleView, type ModuleGroup, type ModuleView } from "../../workspace/changes/changeModules";
import { useChangeGrouping } from "../../workspace/changes/useChangeGrouping";
import { addedIn, sumCode, sumShown, useChangeWeight, type ShownStat } from "../../workspace/changes/changeWeight";
import ChangeRowName from "../../../components/ChangeRowName.vue";
import ModuleLabel from "../../../components/ModuleLabel.vue";
import AgentConflictReport from "./AgentConflictReport.vue";
import AgentScratchReport from "./AgentScratchReport.vue";
import AgentHistoryChip from "./AgentHistoryChip.vue";
import AgentReviewOutline from "./AgentReviewOutline.vue";
import ReviewWaitLine from "./ReviewWaitLine.vue";
import ReviewGroupCheck from "./ReviewGroupCheck.vue";
import { groupCountLabel, groupPassOn, rowAfterGroup, viewedIn } from "./reviewGroupPass";
import { basename } from "@intentic/ui/path";
import { useT } from "@intentic/ui/i18n";
import { formatChord, isApplePlatform } from "../../../workbench/commands/keybindings";

// One agent's work as a review: file list on the left, that file's diff on the right, the shape every code review
// has. Replaces the old panel's mistakes:
// - the diff renders here instead of navigating to /workspace
// - each column (list, diff) carries its own bar instead of one shared strip
// - the list shows what still differs from main, landed or not, not just the unlanded remainder
// - files and headings can be ticked as viewed, and headings collapse per repo and per package
// - conflicted rows are pinned above every repo, each with the conflict glyph and its cause on hover
//
// Keyboard (outside text fields and Monaco): arrows/j/k move, v marks viewed and advances, Shift+V marks a
// heading's rows and advances past them.

const t = useT();

// The review pass's hovers: its one-key peers as key caps (the keydown handler below reads the same keys).
const mac = isApplePlatform();
const reviewedTip = (keys?: string): Tip => ({
    title: t(`agents.agentReviewPanel.reviewed`),
    tone: `success`,
    keys,
    note: t(`agents.agentReviewPanel.clickToUnmark`),
});
const markTip = computed((): Tip => ({
    title: t(`agents.agentReviewPanel.markReviewed`),
    keys: formatChord(`v`, mac),
    rows: [{ label: t(`agents.agentReviewPanel.wholeGroup`), value: formatChord(`Shift+v`, mac) }],
    note: t(`agents.agentReviewPanel.thenNextFile`),
}));
const previousTip = computed((): Tip => ({ title: t(`agents.agentReviewPanel.previousFile`), keys: formatChord(`k`, mac) }));
const nextTip = computed((): Tip => ({ title: t(`agents.agentReviewPanel.nextFile`), keys: formatChord(`j`, mac) }));

const { agentId, at, changes } = defineProps<{
    agentId: string;
    // Owned by AgentDetail; this panel fires the conflict ladder through it, not Land/archive/discard.
    changes: ReturnType<typeof useAgentChanges>;
    // Whether this browser is streaming the agent's turn; what "have the agent resolve it" waits on.
    streaming: boolean;
    // Agent is mid-write, so a land would catch it half-done; what the merge offer waits on.
    writing: boolean;
    // Sandbox this agent's worktree is on, absent for the active one; feeds the per-file diff read directly.
    at?: string;
}>();
// "Watch it work" link to the started turn; mobile-only, since desktop's chat is already on screen.
const emit = defineEmits<{ chat: [] }>();
const router = useRouter();
const { mobile } = useDevice();
const { explorerStyle } = useExplorerStyle();
const shell = useLayout();
const { openDiff, openDirectory, openDocument } = useWorkspaceTabs();
const { tabsFor } = useDirectoryTabs();

// What the review can no longer show because the user committed it (`absorbed`). Enabled off that count alone,
// and its rows arrive already shaped like the review's own (useAgentHistory).
const history = useAgentHistory(
    computed(() => agentId),
    computed(() => changes.absorbed.value > 0),
    computed(() => at),
);

// The two waits with nothing on screen behind them, told apart because they promise different things: the first read
// of the branch, and (on an agent whose work the reader has already committed) the walk through history that finds
// where it went. A refresh is neither, whether or not it has rows behind it: it keeps the spinner in the list header,
// since replacing an answer the reader is using with bars would be a loss of place, not a promise.
// An error is an answer too: it renders above, and waiting under it would promise a list that isn't coming.
const firstRead = computed(() => !changes.loaded.value && changes.error.value === undefined);
const historyRead = computed(() => changes.count.value === 0 && changes.absorbed.value > 0 && !history.loaded.value);
const waiting = computed(() => firstRead.value || historyRead.value);
const waitLabel = computed(() => (firstRead.value ? t(`agents.agentReviewPanel.readingChanges`) : t(`agents.agentReviewPanel.findingInHistory`)));
// Same thresholds every other skeleton in the app answers to, keyed on the agent so walking from one review to the
// next starts a fresh wait rather than continuing the old one's hold.
const outline = useLoadingReveal(
    waiting,
    computed(() => agentId),
);

// The list.
// Narrowing options, each shown only when it would tell the reader something not already visible:
// - Conflicts: what refused, shown first since it's the reason to be here
// - Code/Tests: shown only when the review holds both
// - Not landed: the Land now remainder, shown only as a proper subset
// - In history: committed work, a second body of work rather than a narrowing, so it sits last
type ReviewFilter = `all` | `blocked` | `code` | `tests` | `pending` | `history`;
const filter = ref<ReviewFilter>(`all`);
// Some landed and some not: the only state in which "not landed" tells one file apart from its neighbours, and so the
// only state that earns a narrowing option, a row dot or a badge on the open file. With nothing landed yet — the
// ordinary case for an agent still holding its work — the mark would sit on every row while saying nothing, and the
// header's Land button already says it once for the whole review.
const mixedLanding = computed(() => changes.pending.value.length > 0 && changes.pending.value.length < changes.count.value);
const filterOptions = computed<{ label: string; value: ReviewFilter }[]>(() => [
    ...(changes.count.value > 0 ? [{ label: t(`agents.agentReviewPanel.all`, { count: changes.count.value }), value: `all` as const }] : []),
    ...(changes.blocked.value.length > 0
        ? [{ label: t(`agents.agentReviewPanel.conflicts`, { count: changes.blocked.value.length }), value: `blocked` as const }]
        : []),
    ...(changes.testStat.value.files > 0 && changes.codeStat.value.files > 0
        ? [
              { label: t(`agents.agentReviewPanel.code`, { files: changes.codeStat.value.files }), value: `code` as const },
              { label: t(`agents.agentReviewPanel.tests`, { files: changes.testStat.value.files }), value: `tests` as const },
          ]
        : []),
    ...(mixedLanding.value
        ? [{ label: t(`agents.agentReviewPanel.notLanded2`, { count: changes.pending.value.length }), value: `pending` as const }]
        : []),
    ...(history.count.value > 0
        ? [{ label: t(`agents.agentReviewPanel.inHistory`, { count: history.count.value }), value: `history` as const }]
        : []),
]);
// Falls back to the first available option (not `all`) when the current filter's option disappears, since `all`
// itself can be the one missing option (nothing left to be all of).
watch(
    filterOptions,
    (options) => {
        if (options.length > 0 && !options.some((option) => option.value === filter.value)) {
            filter.value = options[0]?.value ?? `all`;
        }
    },
    // Immediate, since the panel can open already needing this fallback, before any option ever changes.
    { immediate: true },
);

// Folded state at two scopes (repo, package), since a package name can repeat across repos. Not persisted, since
// which packages are noise is a property of this change, not a lasting preference.
const collapsed = ref<ReadonlySet<string>>(new Set());
const collapsedModules = ref<ReadonlySet<string>>(new Set());
const moduleKey = (repo: string, bucket: string): string => `${repo}/${bucket}`;
const moduleCollapsed = (repo: string, bucket: string): boolean => collapsedModules.value.has(moduleKey(repo, bucket));
// A new Set per toggle, since the render's computeds only re-run on identity change.
const flip = (set: Ref<ReadonlySet<string>>, key: string): void => {
    const next = new Set(set.value);
    if (!next.delete(key)) {
        next.add(key);
    }
    set.value = next;
};
const toggleGroup = (repo: string): void => flip(collapsed, repo);
const toggleModule = (repo: string, bucket: string): void => flip(collapsedModules, moduleKey(repo, bucket));

const filtered = computed<readonly AgentReviewFile[]>(() => {
    // Not a narrowing of `changes.files`: a separate body of work, rows now in the user's own commits.
    if (filter.value === `history`) {
        return history.files.value;
    }
    if (filter.value === `blocked`) {
        return changes.blocked.value;
    }
    if (filter.value === `pending`) {
        return changes.files.value.filter((file) => !file.change.landed);
    }
    // Code vs. tests: the contract's isTestPath, the same classifier the header chips total.
    if (filter.value === `code` || filter.value === `tests`) {
        return changes.files.value.filter((file) => isTestPath(file.change.path) === (filter.value === `tests`));
    }
    return changes.files.value;
});

// Rail scale is the most-added row in `filtered` (what's on screen), not every file, since comparing a narrowed
// set to hidden work would be meaningless. Counts arrive already computed on each row (git/code-counts.ts).
const { readingOf, bySize } = useChangeWeight();
const readingOfRow = (file: AgentReviewFile): ShownStat => readingOf(file.change.code, file.change.additions, file.change.deletions);
const heaviest = computed(() => filtered.value.reduce((most, file) => Math.max(most, addedIn(readingOfRow(file))), 0));

// Box name read here, not threaded through props, so a sandbox rename can't go stale between components.
const remoteName = computed(() => (at === undefined ? undefined : boxNameOf.value.get(at)));
const cross = (): void => {
    if (at !== undefined) {
        openInSandbox(at, agentId);
    }
};

// The other empty state: "already committed", not "wrote nothing"; shown only when no commit can be found for it.
const absorbedNote = computed(() => {
    const whose =
        remoteName.value === undefined ? t(`agents.agentReviewPanel.yourHistory`) : t(`agents.agentReviewPanel.boxHistory`, { name: remoteName.value });
    return t(`agents.agentReviewPanel.absorbedNote`, { count: changes.absorbed.value, whose }, changes.absorbed.value);
});

// The committed work: clicking a row here reads it directly instead of pushing a workspace tab and hunting
// through a commit graph. The graph is still offered as a secondary act for questions a file list can't answer
// (what else was in that commit, what came before).
// Shown only with several commits; with one the summary above has already named it.
const manyCommits = computed(() => history.commits.value.length > 1);

// Both ways in are discovered rather than hard-coded, since the graph comes from an extension and nothing should
// render when it's off: a repository has it as the Git tab of its management panel, and the workspace root, which has
// no panel, keeps it as a document. Never offered for a cross-sandbox review, since "the workspace" is this box's own
// /work.
const HISTORY_DOCUMENT = `git-history`;
const graphAt = (repo: string): (() => void) | undefined => {
    if (at !== undefined) {
        return undefined;
    }
    if (repo !== `root`) {
        return tabsFor(repo).some(({ extension }) => extension.id === GIT_TAB) ? (): void => openDirectory(repo, GIT_TAB) : undefined;
    }
    // The workspace root is the empty path, which is the only path this document is offered for.
    const found = documentsAt(``).find((entry) => entry.provider.id === HISTORY_DOCUMENT);
    return found === undefined
        ? undefined
        : (): void => openDocument(found.provider.owner, found.provider.id, ``, found.offer.title, found.offer.icon);
};
// Resolved once per commit, not per binding, since each ask runs every detect(); stays reactive.
const graphs = computed(() => new Map(history.commits.value.map((commit) => [commit.repo, graphAt(commit.repo)])));
const openGitHistory = (repo: string): void => {
    const open = graphs.value.get(repo);
    if (open === undefined) {
        return;
    }
    open();
    void router.push({ name: `workspace` });
};

// What a heading says about its folded rows, at both scopes: a collapsed heading is all that's left of them, so
// it must carry their size and how much refused.
interface GroupStats {
    readonly additions: number;
    readonly deletions: number;
    // Same span with comments excluded, matching what the diff shows by default.
    readonly code: LineStat;
    readonly blocked: number;
    // What most-added-first ranks this heading by: its rows' reading, summed to the same measure.
    readonly order: ShownStat;
}
const codeSumOf = (files: readonly AgentReviewFile[]): LineStat => sumCode(files.map((file) => file.change));
// What the header's totals track: every filter but `history` narrows the review; `history` swaps in other work.
const bodyFiles = computed<readonly AgentReviewFile[]>(() => (filter.value === `history` ? history.files.value : changes.files.value));
const bodyViewed = computed(() => bodyFiles.value.filter((file) => changes.viewed.value.has(file.key)).length);
const statsOf = (files: readonly AgentReviewFile[]): GroupStats => ({
    additions: files.reduce((total, file) => total + (file.change.additions ?? 0), 0),
    deletions: files.reduce((total, file) => total + (file.change.deletions ?? 0), 0),
    code: codeSumOf(files),
    blocked: files.filter((file) => file.blocked !== undefined).length,
    order: sumShown(files.map(readingOfRow)),
});
// The whole body of work for the header, not the filtered rows: every file, exactly as git counted it.
const reviewCode = computed(() => codeSumOf(bodyFiles.value));
const bodyAdditions = computed(() => bodyFiles.value.reduce((total, file) => total + (file.change.additions ?? 0), 0));
const bodyDeletions = computed(() => bodyFiles.value.reduce((total, file) => total + (file.change.deletions ?? 0), 0));

interface RepoGroup extends GroupStats {
    // What folding and the module views key on: the repo, or CONFLICTS for the pinned group.
    readonly key: string;
    readonly title: string;
    readonly repo: string;
    readonly files: readonly AgentReviewFile[];
    readonly conflicts: boolean;
}

// Conflicted rows are pinned in a group of their own above every repo: they are why the reader is here, and spread
// through the packages by size they were the hardest rows on the page to find. The Conflicts filter needs no pin, since
// every row in it is one.
const CONFLICTS = `\u0000conflicts`;
const pinned = computed<readonly AgentReviewFile[]>(() =>
    filter.value === `blocked` || filter.value === `history` ? [] : filtered.value.filter((file) => file.blocked !== undefined),
);

// Repo groups in the daemon's order, rebuilt from filtered rows so an emptied group loses its heading too.
const groups = computed<readonly RepoGroup[]>(() => {
    const byRepo = new Map<string, AgentReviewFile[]>();
    for (const file of filtered.value) {
        if (pinned.value.length > 0 && file.blocked !== undefined) {
            continue;
        }
        const bucket = byRepo.get(file.repo);
        if (bucket === undefined) {
            byRepo.set(file.repo, [file]);
        } else {
            bucket.push(file);
        }
    }
    const built: RepoGroup[] = [];
    for (const [repo, files] of byRepo) {
        built.push({ key: repo, title: repo, repo, files, conflicts: false, ...statsOf(files) });
    }
    // Most-added-first reaches repos too, unlike the workspace's Changes panel, where a repo row is operable (its own
    // sync/discard) and reordering it would be a different kind of surprise.
    const ranked = bySize(built, (group) => group.order);
    if (pinned.value.length === 0) {
        return ranked;
    }
    const files = pinned.value;
    const conflicts: RepoGroup = { key: CONFLICTS, title: t(`agents.agentReviewPanel.conflictsHeading`), repo: ``, files, conflicts: true, ...statsOf(files) };
    return [conflicts, ...ranked];
});

// Same grouping preference and rule as the workspace's Changes panel (useChangeGrouping, changeModules), so both
// review surfaces name a file the same way. Modules come from the agent's own diff, not the workspace-wide read,
// since a new package may not exist in /work yet.
const { groupByModule } = useChangeGrouping();

// Can't rely on the review alone: a fully-committed repo has no review entry, so its rows would group under no
// package. Falls back to history's own module map, whichever read has an answer.
const modulesOf = (repo: string): readonly WorkspaceModule[] => {
    const reviewed = changes.modulesOf(repo);
    return reviewed.length > 0 ? reviewed : history.modulesOf(repo);
};

// A package's rows plus heading totals, summed here so folding is a class change, not a row-by-row pass.
interface ReviewBucket extends ModuleGroup<AgentReviewFile>, GroupStats {}
// `named` also gates folding: an unnamed bucket has no heading of its own to fold from.
type RepoView = ModuleView<ReviewBucket>;

// Built once per review change, not per call: rows read `named` too, and a per-row pass would be quadratic.
const repoViews = computed<ReadonlyMap<string, RepoView>>(() => {
    const views = new Map<string, RepoView>();
    for (const group of groups.value) {
        // One flat run for the pinned group: its rows come from many packages, and each row names its own.
        if (group.conflicts) {
            const rows = bySize(group.files, readingOfRow);
            views.set(group.key, { buckets: [{ key: ``, name: ``, packaged: false, rows, ...statsOf(rows) }], named: false });
            continue;
        }
        const view = moduleView(group.files, (file) => file.change.path, modulesOf(group.repo), group.repo, groupByModule.value);
        const buckets: ReviewBucket[] = [];
        for (const bucket of view.buckets) {
            // Biggest first inside a package, before the packages themselves are ranked too.
            const rows = bySize(bucket.rows, readingOfRow);
            buckets.push({ ...bucket, rows, ...statsOf(rows) });
        }
        views.set(group.key, { buckets: bySize(buckets, (bucket) => bucket.order), named: view.named });
    }
    return views;
});
const viewOf = (key: string): RepoView => repoViews.value.get(key) ?? EMPTY_MODULE_VIEW;

// What the keyboard walks: only rows actually on screen, in render order. A collapsed repo or package contributes
// nothing, since stepping onto a hidden row would silently undo the fold.
const visibleRows = computed<readonly AgentReviewFile[]>(() =>
    groups.value.flatMap((group) =>
        collapsed.value.has(group.key)
            ? []
            : viewOf(group.key).buckets.flatMap((bucket) => (moduleCollapsed(group.key, bucket.key) ? [] : bucket.rows)),
    ),
);

const selectedKey = ref<string | undefined>(undefined);
// Resolved against filtered rows, not visible ones: collapsing a group frees space, not the open file.
const selected = computed(() => filtered.value.find((file) => file.key === selectedKey.value));

const rowEls = new Map<string, HTMLElement>();
const setRowEl = (key: string, el: unknown): void => {
    if (el) {
        rowEls.set(key, el as HTMLElement);
    } else {
        rowEls.delete(key);
    }
};

const select = (file: AgentReviewFile): void => {
    selectedKey.value = file.key;
    rowEls.get(file.key)?.scrollIntoView({ block: `nearest` });
};

// The conflict bar's "Show": narrows the list to the conflicts and opens the first, so the reader lands on one.
const showConflicts = async (): Promise<void> => {
    filter.value = `blocked`;
    collapsed.value = new Set();
    collapsedModules.value = new Set();
    await nextTick();
    const first = visibleRows.value[0];
    if (first !== undefined) {
        select(first);
    }
};

// Desktop opens on the first file, since an empty diff pane beside a full list wastes the screen; mobile doesn't,
// since its diff is a full-screen takeover. A refresh that keeps the same path keeps the selection.
watch(
    [filtered, visibleRows, mobile],
    ([rows, visible, isMobile]) => {
        if (selectedKey.value !== undefined && rows.some((file) => file.key === selectedKey.value)) {
            return;
        }
        const first = visible[0];
        selectedKey.value = isMobile || first === undefined ? undefined : first.key;
    },
    { immediate: true },
);

const move = (delta: number): void => {
    const rows = visibleRows.value;
    if (rows.length === 0) {
        return;
    }
    const index = rows.findIndex((file) => file.key === selectedKey.value);
    // Clamped, not wrapped: wrapping past the last file back to the first reads as losing your place.
    const next = rows[Math.min(rows.length - 1, Math.max(0, index + delta))];
    if (next !== undefined) {
        select(next);
    }
};

// The viewed pass.
const isViewed = (file: AgentReviewFile): boolean => changes.viewed.value.has(file.key);
const toggleViewed = (file: AgentReviewFile): void => changes.setViewed([file.key], !isViewed(file));
// The scanning loop: tick this file and drop onto the next, one key per file.
const viewAndAdvance = (): void => {
    const file = selected.value;
    if (file !== undefined) {
        changes.setViewed([file.key], true);
        move(1);
    }
};

// Same tick at a heading's scope (rules in reviewGroupPass); this panel supplies the scope: filtered rows (so
// Code can't tick a package's tests) and grouped (module, not whole repo, when grouping is on).
const groupProgress = (rows: readonly AgentReviewFile[]): number => viewedIn(rows, changes.viewed.value);
const groupLabel = (rows: readonly AgentReviewFile[]): string => groupCountLabel(rows, changes.viewed.value);
const toggleGroupViewed = (rows: readonly AgentReviewFile[]): void =>
    changes.setViewed(
        rows.map((file) => file.key),
        groupPassOn(rows, changes.viewed.value),
    );

// Innermost group holding the selection: the module bucket when grouped, else the repo's one bucket.
const selectedGroup = computed<readonly AgentReviewFile[]>(() => {
    const file = selected.value;
    if (file === undefined) {
        return [];
    }
    // Searched across every group, since a conflicted row sits in the pinned one rather than its repo's.
    const buckets = groups.value.flatMap((group) => viewOf(group.key).buckets);
    return buckets.find((bucket) => bucket.rows.some((row) => row.key === file.key))?.rows ?? [];
});

// Shift+V, the heading tick's keyboard peer: accepts the rest of this group and lands on the next, so a pass over
// packages costs one key each, same as files.
const viewGroupAndAdvance = (): void => {
    const rows = selectedGroup.value;
    if (rows.length === 0) {
        return;
    }
    // Always on, unlike the heading's click: this key must never un-accept an already-finished group.
    changes.setViewed(
        rows.map((file) => file.key),
        true,
    );
    const next = rowAfterGroup(visibleRows.value, rows);
    if (next !== undefined) {
        select(next);
    }
};

const onKey = (event: KeyboardEvent): void => {
    if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
    }
    // Typing beats navigating: this guard leaves arrows and F7 to the chat composer or Monaco when focused.
    if (isTypingTarget(event.target)) {
        return;
    }
    if (event.key === `ArrowDown` || event.key === `j`) {
        event.preventDefault();
        move(1);
        return;
    }
    if (event.key === `ArrowUp` || event.key === `k`) {
        event.preventDefault();
        move(-1);
        return;
    }
    if (event.key === `v`) {
        event.preventDefault();
        viewAndAdvance();
        return;
    }
    if (event.key === `V`) {
        event.preventDefault();
        viewGroupAndAdvance();
    }
};
onMounted(() => window.addEventListener(`keydown`, onKey));
onBeforeUnmount(() => window.removeEventListener(`keydown`, onKey));

// The diff.
// Shares its cache key with the background loader (AGENT_FILE_DIFF_OPTIONS), so a warmed row paints without a
// re-read. Keyed by selection too, so a slow earlier fetch can't land on the file now chosen.
const { query: diffQuery, error: diffError } = useSandboxQuery(
    {
        queryKey: computed(() => agentFileDiffKey(agentId, selected.value?.repo ?? ``, selected.value?.change.path ?? ``, at)),
        queryFn: () => readAgentFileDiff(agentId, selected.value!.repo, selected.value!.change.path, at),
        enabled: computed(() => selected.value !== undefined),
        ...AGENT_FILE_DIFF_OPTIONS,
    },
    () => at,
);
const diff = computed(() => diffQuery.data.value);
const diffLoading = diffQuery.isFetching;
// Keyed on the row, not the agent: stepping down the list is a new wait each time, so a held outline can never sit
// over the file after the one it was drawn for.
const diffOutline = useLoadingReveal(
    computed(() => diff.value === undefined && diffLoading.value),
    computed(() => selectedKey.value ?? ``),
);
// Monaco is uncontrolled, so a genuinely different file must remount, not re-render. vue-query keeps `diff` the
// same object across a no-op refetch, so that identity (numbered only because :key needs a string) is what
// distinguishes files.
const diffIds = new WeakMap<FileDiff, number>();
let diffSeq = 0;
const diffKey = computed(() => {
    const body = diff.value;
    if (body === undefined) {
        return ``;
    }
    let id = diffIds.get(body);
    if (id === undefined) {
        diffIds.set(body, (id = ++diffSeq));
    }
    return `${selectedKey.value ?? ``}:${id}`;
});

// Reading ahead now happens in the app's background loader (composables/prefetch), not this panel, so a review
// opens with rows already warm instead of paying a round trip on the first click. Per-file counts come from the
// same read (useAgentChanges' readAgentFileDiff), so there's no separate walk or limit to be past.

// Binary sides' locations, from the row's status letter: a binary diff has no content to infer them from.
const rawSides = computed(() =>
    selected.value === undefined
        ? {}
        : diffRawUrls({ source: `agent`, agent: agentId, repo: selected.value.repo }, selected.value.change.path, selected.value.change.status),
);

// Escape hatch to the full editor (same diff as a workspace tab); no longer what a row click does by default. Reads
// the selection itself rather than taking it, since its press now comes from inside a slot, where the template's
// `selected !== undefined` no longer narrows.
const openInWorkspace = (): void => {
    const body = diff.value;
    const file = selected.value;
    if (body === undefined || file === undefined) {
        return;
    }
    openDiff(
        {
            key: `agent:${agentId}:${file.repo}`,
            scope: file.repo,
            label: file.label,
            status: file.change.status,
            path: file.change.path,
            ...body,
            ...diffRawUrls({ source: `agent`, agent: agentId, repo: file.repo }, file.change.path, file.change.status),
        },
        // "Open this over there": a tab that vanished on the next look would say the opposite.
        `keep`,
    );
    void router.push({ name: `workspace` });
};

// Presentation.

// Kit's toolbar icon button, plus this panel's own disabled treatment.
const ICON_BUTTON = ui.iconButton(`disabled:opacity-40`);
// A notice that needs no decision: one line under the bar, no box, so only the bar reads as something to act on.
const NOTE_LINE = `mx-2 mt-1.5 flex shrink-0 items-center gap-1.5 px-2 text-2xs text-muted`;

// What a refused land left behind; causes and the action ladder are AgentConflictReport's to own.
const resolvingPaths = computed(() => (changes.resolving.value ?? []).flatMap((entry) => entry.paths));

// Copies on a branch of their own whose commits there did not reach this conversation's branch: work no land carries.
// A copy that was carried is not news to the reader (it lands like the rest), so only the stranded ones are said.
// Absent `carried` is a sandbox too old to copy them, which never did.
const stranded = computed(() => changes.elsewhere.value.filter((stray) => stray.carried !== true));
const strandedRepos = computed(() => stranded.value.map((stray) => stray.repo).join(`, `));
// Where each copy stands, for whoever wants the git of it; the line itself says only what it means.
const strandedTip = computed(
    (): Tip => ({
        title: t(`agents.agentReviewPanel.offBranch`),
        rows: stranded.value.map((stray) => ({ label: stray.repo, value: stray.branch ?? t(`agents.agentReviewPanel.noBranch`) })),
    }),
);

// What landing the work takes on: per manifest that gained any, the dependency names it declares now and did not
// before, labelled the way the rows are. This is where a new dependency is approved, since a conversation installs
// freely in its own copy.
const addedDependencies = computed(() =>
    changes.repos.value.flatMap((group) =>
        (group.addedDependencies ?? []).map((manifest) => ({
            key: `${group.repo}\u0000${manifest.path}`,
            label: group.repo === `root` ? manifest.path : `${group.repo}/${manifest.path}`,
            added: manifest.added,
        })),
    ),
);

// The file list's width is the reviewer's own call (a flat repo vs. a deep monorepo), sized and persisted exactly
// like the workspace explorer's edge (drag, double-click reset, ResizeSeam). The seam speaks in pointer
// coordinates while the stored width is in app pixels, so this computed is where the two meet.
const seamWidth = computed<number>({
    get: () => toScreenPx(shell.reviewListWidth.value),
    set: (px) => shell.setReviewListWidth(toAppPx(px)),
});
</script>

<template>
    <div class="flex min-h-0 flex-1 flex-col">
        <Notice v-if="changes.error.value" tone="danger" size="sm" class="mx-2 mt-2 shrink-0">
            <span class="block font-medium">{{ t(`agents.agentReviewPanel.couldntReadAgentsChanges`) }}</span>
            <span class="block break-words text-muted">{{ changes.error.value }}</span>
        </Notice>

        <!-- The one decision a refused land leaves, first: what conflicts, why, and what happens next. -->
        <AgentConflictReport
            v-if="changes.conflicts.value !== undefined && changes.conflicts.value.length > 0"
            class="mx-2 mt-2"
            :conflicts="changes.conflicts.value"
            :streaming="streaming"
            :writing="writing"
            :busy="changes.actionBusy.value"
            :asked="changes.asked.value"
            :queued="changes.fixQueued.value"
            :box="remoteName"
            @merge="changes.land('merge')"
            @commit="openChanges"
            @save-settings="(paths: readonly string[]) => changes.land(`check`, undefined, false, paths)"
            @stop="stopAgent(agentId, at)"
            @cancel="changes.cancelFix()"
            @cross="cross"
            @chat="emit('chat')"
            @show="showConflicts"
        />

        <!-- What a merge land left behind: everything else applied, these files carry markers to finish in the workspace. -->
        <div v-if="resolvingPaths.length > 0" :class="NOTE_LINE">
            <Icon name="info-circle" class="shrink-0 text-2xs text-info" />
            <span class="min-w-0 flex-1 truncate" v-tooltip.bottom.overflow="resolvingPaths.join(`, `)">{{
                t(`agents.agentReviewPanel.markersLeft`, { count: resolvingPaths.length }, resolvingPaths.length)
            }}</span>
            <button type="button" class="shrink-0 text-link underline-offset-2 hover:underline" @click="openChanges">
                {{ t(`agents.agentConflictReport.openChanges`) }}
            </button>
        </div>

        <!-- Work no land carries, said as what it means; where each copy stands is the hover's. The ask goes into the
             agent's composer, not straight to it, so a running turn is never steered by a press made here. -->
        <div v-if="stranded.length > 0" :class="NOTE_LINE">
            <Icon name="exclamation-triangle" class="shrink-0 text-2xs text-warning" />
            <span class="min-w-0 flex-1" v-tooltip.bottom="strandedTip">{{
                t(`agents.agentReviewPanel.strandedWork`, { repos: strandedRepos })
            }}</span>
            <button
                v-if="at === undefined"
                type="button"
                class="shrink-0 text-link underline-offset-2 hover:underline"
                @click="draftStrayAsk(agentId, stranded)"
            >
                {{ t(`agents.agentReviewPanel.askAgent`) }}
            </button>
        </div>

        <!-- What no land carries: files that look like scratch, left in the conversation's copy until included or deleted. -->
        <AgentScratchReport
            v-if="changes.scratch.value.length > 0"
            class="mx-2 mt-2"
            :scratch="changes.scratch.value"
            :busy="changes.actionBusy.value"
            :streaming="streaming"
            @include="changes.includeScratch"
            @delete="changes.deleteScratch"
        />

        <!-- What landing this work takes on: one quiet line per manifest. Nothing is wrong, so nothing is tinted. -->
        <div v-for="manifest in addedDependencies" :key="manifest.key" :class="NOTE_LINE">
            <Icon name="box" class="shrink-0 text-2xs text-subtle" />
            <span class="min-w-0 flex-1 truncate" v-tooltip.bottom.overflow="manifest.added.join(`, `)">{{
                t(`agents.agentReviewPanel.addsTo`, { names: manifest.added.join(`, `), manifest: manifest.label })
            }}</span>
        </div>

        <!-- History loads only once absorbed work is reported, skipping a flash of "nothing here" first. -->
        <!-- The review's frame and one line for the wait, the same one AgentDetail's own wait draws. -->
        <template v-if="waiting">
            <AgentReviewOutline v-if="outline" :label="waitLabel" />
        </template>
        <!-- An empty list is two opposite facts needing different next moves: nothing written, or everything already committed.
             "Ask it in chat" only applies where a chat for this agent exists; a remote review has none on screen, so the
             sentence points at the crossing instead. -->
        <EmptyState
            v-else-if="changes.count.value === 0 && history.count.value === 0"
            :icon="changes.absorbed.value > 0 ? 'check' : 'file-edit'"
            :line="
                changes.absorbed.value > 0
                    ? t(`agents.agentReviewPanel.anythingWritesNextShows`, { absorbedNote })
                    : remoteName !== undefined
                      ? t(`agents.agentReviewPanel.agentHasntChangedAny`, { remoteName })
                      : t(`agents.agentReviewPanel.agentHasntChangedAny2`)
            "
            class="min-h-0 flex-1 p-6"
        >
            <template v-if="remoteName !== undefined" #actions>
                <Button size="small" tier="boring" @click="cross">
                    <Icon name="arrow-right" />{{ t(`agents.words.openIn`) }} {{ remoteName }}
                </Button>
            </template>
        </EmptyState>

        <!-- List | diff share one screen on a phone: the diff takes over on pick, with no route change either way. -->
        <!-- No select-none while dragging: ResizeSeam already claims the whole document's selection for the drag. -->
        <div v-else class="flex min-h-0 flex-1">
            <aside
                v-if="!mobile || selected === undefined"
                class="flex min-h-0 min-w-0 flex-col"
                :class="mobile ? 'flex-1' : 'shrink-0 border-r border-line'"
                :style="mobile ? undefined : { width: uiLength(shell.reviewListWidth.value) }"
            >
                <!-- The list's own header (count, filter, pass progress), the same height as the diff's toolbar so both align. -->
                <!-- Wraps inside a one-line box: the totals take the line only when they fit beside the filter, and
                     otherwise drop to a second line the box clips, rather than spilling over the diff's toolbar. Each
                     group heading keeps its own totals either way. -->
                <div class="h-8 shrink-0 overflow-hidden border-b border-line max-md:h-12">
                    <div class="flex flex-wrap items-center gap-x-1.5 px-2 *:h-8 max-md:*:h-12">
                        <div v-if="filterOptions.length > 1" class="flex max-w-full items-center overflow-x-auto [scrollbar-width:none]">
                            <SegmentedControl v-model="filter" :options="filterOptions" size="xs" />
                        </div>
                        <span v-else class="inline-flex items-center whitespace-nowrap text-2xs text-muted">
                            <span class="font-medium text-content">{{ bodyFiles.length }}</span>&nbsp;{{ t(`agents.agentReviewPanel.files`, {}, bodyFiles.length) }}
                        </span>
                        <span v-if="changes.fetching.value" class="inline-flex items-center"><Icon name="spinner" class="text-2xs text-muted" spin /></span>
                        <span class="ml-auto inline-flex shrink-0 items-center gap-1.5">
                            <!-- Totals for the whole review; the code/tests split is carried by the filter options instead. -->
                            <ReviewStat :code="reviewCode" :additions="bodyAdditions" :deletions="bodyDeletions" />
                            <!-- A check and "N/total" reads as reviewed-of-total on its own, no hover-only shortcut hint needed here. -->
                            <span class="inline-flex items-center gap-0.5 whitespace-nowrap text-2xs text-subtle">
                                <Icon name="check" class="text-2xs" />{{ bodyViewed }}/{{ bodyFiles.length }}
                            </span>
                        </span>
                    </div>
                </div>

                <div class="min-h-0 flex-1 overflow-auto">
                    <div v-for="group in groups" :key="group.key">
                        <!-- Sticky, since scrolling is what takes the repo context away. -->
                        <div
                            class="group/head sticky top-0 z-10 flex w-full items-center border-b border-line/60 bg-canvas pr-1 transition-colors hover:bg-overlay"
                        >
                            <button
                                type="button"
                                class="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1 text-left"
                                @click="toggleGroup(group.key)"
                            >
                                <Icon class="shrink-0 text-2xs text-subtle" :name="collapsed.has(group.key) ? 'chevron-right' : 'chevron-down'" />
                                <Icon v-if="group.conflicts" :name="CONFLICT_ICON" class="shrink-0 text-2xs text-warning" />
                                <span
                                    class="min-w-0 truncate text-2xs font-semibold uppercase tracking-wide"
                                    :class="group.conflicts ? `text-warning` : `text-muted`"
                                    >{{ group.title }}</span
                                >
                                <span class="shrink-0 ui-status-pill bg-overlay text-2xs text-muted">{{ groupLabel(group.files) }}</span>
                                <span
                                    v-if="group.blocked > 0 && !group.conflicts"
                                    class="inline-flex shrink-0 items-center gap-0.5 ui-status-pill text-2xs font-medium"
                                    :class="toneWash(`warning`)"
                                >
                                    <Icon name="exclamation-triangle" class="text-2xs" />{{ group.blocked }}
                                </span>
                                <span class="flex-1"></span>
                                <ReviewStat :code="group.code" :additions="group.additions" :deletions="group.deletions" />
                            </button>
                            <ReviewGroupCheck
                                :name="group.title"
                                :total="group.files.length"
                                :viewed="groupProgress(group.files)"
                                @toggle="toggleGroupViewed(group.files)"
                            />
                        </div>

                        <template v-if="!collapsed.has(group.key)">
                            <template v-for="bucket in viewOf(group.key).buckets" :key="`${group.key}/${bucket.key}`">
                                <!-- The package a run of rows belongs to, stated once: same fold-left/sweep-right/totals-between heading as the repo's, one scope down. -->
                                <div v-if="viewOf(group.key).named" class="group/head flex items-center border-b border-line/40 bg-canvas/60 pr-1.5">
                                    <button
                                        type="button"
                                        class="flex min-w-0 flex-1 items-center gap-2 py-1 pl-2 pr-1.5 text-left"
                                        @click="toggleModule(group.key, bucket.key)"
                                    >
                                        <Icon
                                            class="shrink-0 text-[0.6rem] text-subtle"
                                            :name="moduleCollapsed(group.key, bucket.key) ? 'chevron-right' : 'chevron-down'"
                                        />
                                        <!-- One way to name a module, shared with the workspace's own Changes list (ModuleLabel). -->
                                        <ModuleLabel :name="bucket.name" :packaged="bucket.packaged" />
                                        <span class="shrink-0 text-2xs text-subtle">{{ groupLabel(bucket.rows) }}</span>
                                        <!-- A folded package can't hide a refusal either: same badge, same glyph, one scope down. -->
                                        <span
                                            v-if="bucket.blocked > 0"
                                            class="inline-flex shrink-0 items-center gap-0.5 ui-status-pill text-2xs font-medium"
                                            :class="toneWash(`warning`)"
                                        >
                                            <Icon name="exclamation-triangle" class="text-2xs" />{{ bucket.blocked }}
                                        </span>
                                        <span class="flex-1"></span>
                                        <!-- Its size, always: the only place a folded package's +/- survives, and what marks it worth folding. -->
                                        <ReviewStat :code="bucket.code" :additions="bucket.additions" :deletions="bucket.deletions" />
                                    </button>
                                    <ReviewGroupCheck
                                        :name="bucket.name"
                                        :total="bucket.rows.length"
                                        :viewed="groupProgress(bucket.rows)"
                                        @toggle="toggleGroupViewed(bucket.rows)"
                                    />
                                </div>
                                <template v-if="!moduleCollapsed(group.key, bucket.key)">
                                    <div
                                        v-for="file in bucket.rows"
                                        :key="file.key"
                                        :ref="(el) => setRowEl(file.key, el)"
                                        class="group/file flex items-center transition-colors"
                                        :class="[
                                            // Tint only, no edge stripe: the same way the workspace's Changes list marks its picked row.
                                            file.key === selectedKey ? 'bg-primary-600/10' : 'hover:bg-overlay',
                                            // Under a header the rows step in, so the module reads as holding them.
                                            viewOf(group.key).named ? 'pl-2' : '',
                                        ]"
                                    >
                                        <button
                                            type="button"
                                            class="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-2.5 pr-1.5 text-left max-md:min-h-11"
                                            :class="isViewed(file) ? 'opacity-50' : ''"
                                            @click="select(file)"
                                        >
                                            <ChangeStatusMark :status="file.change.status" />
                                            <Icon
                                                :name="iconForEntry(basename(file.change.path), 'file', false)"
                                                class="shrink-0 text-2xs"
                                                :class="explorerColorClass(explorerStyle, basename(file.change.path), 'file', false)"
                                            />
                                            <!-- How a changed file is named, shared with the workspace's Changes list (ChangeRowName). -->
                                            <ChangeRowName :path="file.change.path" :label="file.label" :named="viewOf(group.key).named" />
                                            <!-- A glyph, not a word: the name is what the reader needs, and the cause is the hover's. -->
                                            <span
                                                v-if="file.blocked !== undefined"
                                                class="inline-flex shrink-0 items-center text-2xs text-warning"
                                                v-tooltip.right="reasonCopy()[file.blocked].row"
                                                :aria-label="t(`agents.agentReviewPanel.conflict`)"
                                            >
                                                <Icon :name="CONFLICT_ICON" class="text-2xs" />
                                            </span>
                                            <!-- Which commit took this file; silent with only one, already named by the summary above (`manyCommits`). -->
                                            <span
                                                v-else-if="file.carriedBy !== undefined && manyCommits"
                                                class="shrink-0 rounded bg-overlay px-1 py-px font-mono text-2xs text-subtle"
                                                v-tooltip.right="t(`agents.agentReviewPanel.yourCommit`)"
                                                >{{ file.carriedBy.short }}</span
                                            >
                                            <span
                                                v-else-if="mixedLanding && file.carriedBy === undefined && !file.change.landed"
                                                class="h-1.5 w-1.5 shrink-0 rounded-full bg-warning"
                                                v-tooltip.right="t(`agents.agentReviewPanel.unlanded`)"
                                            ></span>
                                            <!-- `of` turns the badge into a rail: weight against the heaviest file on screen, scanned rather than read digit by digit. -->
                                            <ReviewStat
                                                :code="file.change.code"
                                                :additions="file.change.additions"
                                                :deletions="file.change.deletions"
                                                :of="heaviest"
                                            />
                                        </button>
                                        <button
                                            type="button"
                                            :class="
                                                ui.iconButton(
                                                    { size: mobile ? `lg` : `sm` },
                                                    isViewed(file)
                                                        ? `text-success`
                                                        : `opacity-0 focus-visible:opacity-100 group-hover/file:opacity-100 max-md:opacity-100`,
                                                )
                                            "
                                            @click="toggleViewed(file)"
                                            v-tooltip.right="isViewed(file) ? reviewedTip() : t(`agents.agentReviewPanel.markReviewed`)"
                                            :aria-label="t(`agents.agentReviewPanel.markReviewed2`, { label: file.label })"
                                        >
                                            <Icon :name="isViewed(file) ? 'check-square' : 'check'" class="text-2xs" />
                                        </button>
                                    </div>
                                </template>
                            </template>
                        </template>
                    </div>
                </div>
            </aside>

            <!-- Sits in flow with negative margins, straddling the border without an overlay that scrolls with the list. -->
            <ResizeSeam
                v-if="!mobile"
                v-model="seamWidth"
                :min="toScreenPx(MIN_REVIEW_LIST_WIDTH)"
                :max="toScreenPx(MAX_REVIEW_LIST_WIDTH)"
                :reset="toScreenPx(defaultReviewListWidth())"
                :title="t(`ui.resizeSeam.doubleClickResets`)"
            />

            <section v-if="!mobile || selected !== undefined" class="flex min-h-0 min-w-0 flex-1 flex-col">
                <template v-if="selected !== undefined">
                    <!-- The same toolbar the workspace tab renders, so Split|Unified and Comments sit in the same place everywhere. -->
                    <DiffToolbar
                        :path="selected.label"
                        :status="selected.change.status"
                        :code="selected.change.code"
                        :additions="selected.change.additions"
                        :deletions="selected.change.deletions"
                        :from="selected.change.from"
                    >
                        <template #lead>
                            <button
                                v-if="mobile"
                                type="button"
                                :class="ICON_BUTTON"
                                @click="selectedKey = undefined"
                                :aria-label="t(`agents.agentReviewPanel.backToFileList`)"
                            >
                                <Icon name="arrow-left" class="text-xs" />
                            </button>
                        </template>
                        <!-- The row's mark, carried onto the opened file: a diff without it would read as an ordinary change. -->
                        <template #badges>
                            <span
                                v-if="selected.blocked !== undefined"
                                class="inline-flex shrink-0 items-center gap-1 ui-status-pill text-2xs font-medium"
                                :class="toneWash(`warning`)"
                                v-tooltip.bottom="reasonCopy()[selected.blocked].row"
                            >
                                <Icon :name="CONFLICT_ICON" class="text-2xs" />{{ t(`agents.agentReviewPanel.conflict`) }}
                            </span>
                            <!-- What this diff is on an already-committed file: the agent's own change, measured the same as every other row, not the commit's own patch. The review's one statement of where committed work went; the rest opens under it on hover. -->
                            <AgentHistoryChip
                                v-else-if="selected.carriedBy !== undefined"
                                :current="selected.carriedBy"
                                :commits="history.commits.value"
                                :unaccounted="history.unaccounted.value"
                                :remote-name="remoteName"
                                :graphs="graphs"
                                @open-graph="openGitHistory"
                            />
                            <span
                                v-else-if="mixedLanding && !selected.change.landed"
                                class="shrink-0 ui-status-pill text-2xs font-medium"
                                :class="toneWash(`warning`)"
                                v-tooltip.bottom="t(`agents.agentReviewPanel.awaitingLand`)"
                            >
                                {{ t(`agents.agentReviewPanel.notLanded`) }}
                            </span>
                        </template>
                        <!-- The review pass itself, and nothing else: accept this file, step to the next. Both have one-key peers (v, j/k), so they are here to say the pass exists as much as to be pressed. -->
                        <template #actions>
                            <button
                                type="button"
                                :class="[ICON_BUTTON, isViewed(selected) ? 'text-success' : '']"
                                @click="toggleViewed(selected)"
                                v-tooltip.bottom="isViewed(selected) ? reviewedTip(markTip.keys) : markTip"
                                :aria-label="t(`agents.agentReviewPanel.markReviewed2`, { label: selected.label })"
                            >
                                <Icon :name="isViewed(selected) ? 'check-square' : 'check'" class="text-2xs" />
                            </button>
                            <!-- Two halves of one move, so they are drawn as one stepper on a shared plate rather than as two loose glyphs. -->
                            <span class="flex shrink-0 items-center rounded-md bg-overlay/60">
                                <button
                                    type="button"
                                    :class="ICON_BUTTON"
                                    @click="move(-1)"
                                    v-tooltip.bottom="previousTip"
                                    :aria-label="t(`agents.agentReviewPanel.previousFile`)"
                                >
                                    <Icon name="chevron-up" class="text-2xs" />
                                </button>
                                <button
                                    type="button"
                                    :class="ICON_BUTTON"
                                    @click="move(1)"
                                    v-tooltip.bottom="nextTip"
                                    :aria-label="t(`agents.agentReviewPanel.nextFile`)"
                                >
                                    <Icon name="chevron-down" class="text-2xs" />
                                </button>
                            </span>
                        </template>
                        <!-- Leaving for the editor is a once-a-review escape, not part of the pass: it rides in the toolbar's own panel instead of spending a place in the row. Remote agents have no local workspace tab to open. -->
                        <template #settings="{ item, label, close }">
                            <button
                                v-if="!mobile && at === undefined"
                                type="button"
                                :class="item"
                                :disabled="diff === undefined"
                                @click="
                                    close();
                                    openInWorkspace();
                                "
                            >
                                <span :class="label">{{ t(`agents.agentReviewPanel.openDiffInWorkspace`) }}</span>
                                <Icon name="external-link" class="text-2xs text-subtle" />
                            </button>
                        </template>
                    </DiffToolbar>

                    <div class="min-h-0 flex-1">
                        <p v-if="diffError !== undefined" class="p-4 text-xs text-danger">{{ diffError }}</p>
                        <!-- A file read is one line where the diff's first line will be: the toolbar above already names the file
                             and its counts, and code lines guessed for it (or remembered from another agent's diff of the same
                             path) would only be torn down. -->
                        <template v-else-if="diff === undefined">
                            <ReviewWaitLine v-if="diffOutline" :label="t(`workspace.diffSkeleton.readingFile`)" class="px-4" />
                        </template>
                        <!-- One box around whichever viewer FileDiffPane picks. -->
                        <div v-else class="h-full">
                            <!-- Bytes, a patch, or two whole sides: FileDiffPane decides, same as it does in the workspace editor. -->
                            <FileDiffPane
                                :key="diffKey"
                                :path="selected.change.path"
                                :before="diff.before"
                                :after="diff.after"
                                :binary="diff.binary"
                                :partial="diff.partial"
                                :before-raw="rawSides.beforeRaw"
                                :after-raw="rawSides.afterRaw"
                                :at="at"
                            />
                        </div>
                    </div>
                </template>
                <p v-else class="p-4 text-2xs text-subtle">{{ t(`agents.agentReviewPanel.pickFileToSee`) }}</p>
            </section>
        </div>
    </div>
</template>
