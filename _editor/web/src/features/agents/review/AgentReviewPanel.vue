<script setup lang="ts">
import type { FileDiffResponse } from "@intentic/api-contract";
import {
    Button,
    ChangeStatusMark,
    ui,
    explorerColorClass,
    iconForEntry,
    Notice,
    ResizeSeam,
    SegmentedControl,
    useDevice,
    useExplorerStyle,
} from "@intentic/ui";
import { isTestPath, type WorkspaceModule } from "@intentic/sandbox-contract";
import type { LineStat } from "@intentic/code-read";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, type Ref, watch } from "vue";
import { useRouter } from "vue-router";
import ReviewStat from "../../../components/ReviewStat.vue";
import { stopAgent } from "../fleet/agentActions";
import { boxNameOf, openInSandbox } from "../fleet/fleetScope";
import { type Blocker, REASON_COPY } from "./conflictResolution";
import {
    AGENT_FILE_DIFF_OPTIONS,
    agentFileDiffKey,
    type AgentReviewFile,
    readAgentFileDiff,
    useAgentChanges,
} from "./useAgentChanges";
import { useAgentHistory } from "../fleet/useAgentHistory";
import { documentsAt } from "../../../core-views/documentRegistry";
import { useSandboxQuery } from "../../sandbox/client/useSandboxQuery";
import { defaultReviewListWidth, MAX_REVIEW_LIST_WIDTH, MIN_REVIEW_LIST_WIDTH, useLayout } from "../../../shell/window/useLayout";
import { toAppPx, toScreenPx, uiLength } from "../../../shell/window/uiScale";
import { diffRawUrls } from "../../workspace/changes/diffRaw";
import { useWorkspaceTabs } from "../../workspace/tabs/useWorkspaceTabs";
import DiffToolbar from "../../workspace/viewers/DiffToolbar.vue";
import FileDiffPane from "../../workspace/viewers/FileDiffPane.vue";
import { EMPTY_MODULE_VIEW, moduleView, type ModuleGroup, type ModuleView } from "../../workspace/changes/changeModules";
import { useChangeGrouping } from "../../workspace/changes/useChangeGrouping";
import { addedIn, sumCode, sumShown, useChangeWeight, type ShownStat } from "../../workspace/changes/changeWeight";
import ChangeRowName from "../../../components/ChangeRowName.vue";
import ModuleLabel from "../../../components/ModuleLabel.vue";
import AgentConflictReport from "./AgentConflictReport.vue";
import ReviewGroupCheck from "./ReviewGroupCheck.vue";
import { groupCountLabel, groupPassOn, rowAfterGroup, viewedIn } from "./reviewGroupPass";
import { basename } from "@intentic/ui/path";

// One agent's work as a review: file list on the left, that file's diff on the right, the shape every code review
// has. Replaces the old panel's mistakes:
// - the diff renders here instead of navigating to /workspace
// - each column (list, diff) carries its own bar instead of one shared strip
// - the list shows what still differs from main, landed or not, not just the unlanded remainder
// - files and headings can be ticked as viewed, and headings collapse per repo and per package
// - a blocked row carries its conflict cause directly, matching the conflict report above
//
// Keyboard (outside text fields and Monaco): arrows/j/k move, v marks viewed and advances, Shift+V marks a
// heading's rows and advances past them.

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
const { openDiff, openDocument } = useWorkspaceTabs();

// What the review can no longer show because the user committed it (`absorbed`). Enabled off that count alone,
// and its rows arrive already shaped like the review's own (useAgentHistory).
const history = useAgentHistory(
    computed(() => agentId),
    computed(() => changes.absorbed.value > 0),
    computed(() => at),
);

// The list.
// Narrowing options, each shown only when it would tell the reader something not already visible:
// - Blocked: what refused, shown first since it's the reason to be here
// - Code/Tests: shown only when the review holds both
// - Not landed: the Land now remainder, shown only as a proper subset
// - In history: committed work, a second body of work rather than a narrowing, so it sits last
type ReviewFilter = `all` | `blocked` | `code` | `tests` | `pending` | `history`;
const filter = ref<ReviewFilter>(`all`);
const filterOptions = computed<{ label: string; value: ReviewFilter }[]>(() => [
    ...(changes.count.value > 0 ? [{ label: `All ${changes.count.value}`, value: `all` as const }] : []),
    ...(changes.blocked.value.length > 0 ? [{ label: `Blocked ${changes.blocked.value.length}`, value: `blocked` as const }] : []),
    ...(changes.testStat.value.files > 0 && changes.codeStat.value.files > 0
        ? [
              { label: `Code ${changes.codeStat.value.files}`, value: `code` as const },
              { label: `Tests ${changes.testStat.value.files}`, value: `tests` as const },
          ]
        : []),
    ...(changes.pending.value.length > 0 && changes.pending.value.length < changes.count.value
        ? [{ label: `Not landed ${changes.pending.value.length}`, value: `pending` as const }]
        : []),
    ...(history.count.value > 0 ? [{ label: `In history ${history.count.value}`, value: `history` as const }] : []),
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
    const whose = remoteName.value === undefined ? `your workspace's history` : `${remoteName.value}'s history`;
    return changes.absorbed.value === 1
        ? `The one file this agent wrote is in ${whose}, so nothing of it differs from main any more.`
        : `All ${changes.absorbed.value} files this agent wrote are in ${whose}, so nothing of it differs from main any more.`;
});

// The committed work: clicking a row here reads it directly instead of pushing a workspace tab and hunting
// through a commit graph. The graph is still offered as a secondary act for questions a file list can't answer
// (what else was in that commit, what came before).
const historyStamp = (authored: number): string => new Date(authored).toLocaleDateString(undefined, { month: `short`, day: `numeric` });
// Shown only with several commits; with one the summary above has already named it.
const manyCommits = computed(() => history.commits.value.length > 1);

// The graph is found via the document registry (which provider offers git-history for a repo's directory) rather
// than hard-coded, since it comes from an extension; nothing renders if it's off. Never offered for a
// cross-sandbox review, since "the workspace" is this box's own /work.
const HISTORY_DOCUMENT = `git-history`;
const graphAt = (repo: string) => {
    if (at !== undefined) {
        return undefined;
    }
    // The tree addresses a repo by its root-relative directory; the workspace root is the empty path.
    const path = repo === `root` ? `` : repo;
    const found = documentsAt(path).find((entry) => entry.provider.id === HISTORY_DOCUMENT);
    return found === undefined ? undefined : { path, ...found };
};
// Resolved once per commit, not per binding, since each ask calls every provider's detect(); stays reactive.
const graphs = computed(() => new Map(history.commits.value.map((commit) => [commit.repo, graphAt(commit.repo)])));
const openGitHistory = (repo: string): void => {
    const graph = graphs.value.get(repo);
    if (graph === undefined) {
        return;
    }
    openDocument(graph.provider.owner, graph.provider.id, graph.path, graph.offer.title, graph.offer.icon);
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
    readonly repo: string;
    readonly files: readonly AgentReviewFile[];
}

// Repo groups in the daemon's order, rebuilt from filtered rows so an emptied group loses its heading too.
const groups = computed<readonly RepoGroup[]>(() => {
    const byRepo = new Map<string, AgentReviewFile[]>();
    for (const file of filtered.value) {
        const bucket = byRepo.get(file.repo);
        if (bucket === undefined) {
            byRepo.set(file.repo, [file]);
        } else {
            bucket.push(file);
        }
    }
    const built: RepoGroup[] = [];
    for (const [repo, files] of byRepo) {
        built.push({ repo, files, ...statsOf(files) });
    }
    // Most-added-first reaches repos too, unlike the workspace's Changes panel, where a repo row is operable (its own
    // sync/discard) and reordering it would be a different kind of surprise.
    return bySize(built, (group) => group.order);
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
        const view = moduleView(group.files, (file) => file.change.path, modulesOf(group.repo), group.repo, groupByModule.value);
        const buckets: ReviewBucket[] = [];
        for (const bucket of view.buckets) {
            // Biggest first inside a package, before the packages themselves are ranked too.
            const rows = bySize(bucket.rows, readingOfRow);
            buckets.push({ ...bucket, rows, ...statsOf(rows) });
        }
        views.set(group.repo, { buckets: bySize(buckets, (bucket) => bucket.order), named: view.named });
    }
    return views;
});
const viewOf = (repo: string): RepoView => repoViews.value.get(repo) ?? EMPTY_MODULE_VIEW;

// What the keyboard walks: only rows actually on screen, in render order. A collapsed repo or package contributes
// nothing, since stepping onto a hidden row would silently undo the fold.
const visibleRows = computed<readonly AgentReviewFile[]>(() =>
    groups.value.flatMap((group) =>
        collapsed.value.has(group.repo)
            ? []
            : viewOf(group.repo).buckets.flatMap((bucket) => (moduleCollapsed(group.repo, bucket.key) ? [] : bucket.rows)),
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

// Joins the conflict report's paths to their rows, so clicking one finds it instead of matching by eye. Widens
// the filter to `blocked` (never `all`) and opens both fold levels before scrolling to it.
const jumpTo = async (blocker: Blocker): Promise<void> => {
    const file = changes.files.value.find((row) => row.repo === blocker.repo && row.change.path === blocker.path);
    if (file === undefined) {
        return;
    }
    if (!filtered.value.some((row) => row.key === file.key)) {
        filter.value = `blocked`;
    }
    const expanded = new Set(collapsed.value);
    expanded.delete(file.repo);
    collapsed.value = expanded;
    // Read after the filter above, so the buckets searched are the ones about to be drawn.
    const bucket = viewOf(file.repo).buckets.find((group) => group.rows.some((row) => row.key === file.key));
    if (bucket !== undefined) {
        const opened = new Set(collapsedModules.value);
        opened.delete(moduleKey(file.repo, bucket.key));
        collapsedModules.value = opened;
    }
    selectedKey.value = file.key;
    await nextTick();
    rowEls.get(file.key)?.scrollIntoView({ block: `nearest` });
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
    return viewOf(file.repo).buckets.find((bucket) => bucket.rows.some((row) => row.key === file.key))?.rows ?? [];
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
    const target = event.target;
    if (target instanceof HTMLElement && (target.isContentEditable || [`INPUT`, `TEXTAREA`, `SELECT`].includes(target.tagName))) {
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
// Monaco is uncontrolled, so a genuinely different file must remount, not re-render. vue-query keeps `diff` the
// same object across a no-op refetch, so that identity (numbered only because :key needs a string) is what
// distinguishes files.
const diffIds = new WeakMap<FileDiffResponse, number>();
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

// Escape hatch to the full editor (same diff as a workspace tab); no longer what a row click does by default.
const openInWorkspace = (file: AgentReviewFile): void => {
    const body = diff.value;
    if (body === undefined) {
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
const NOTICE = `flex items-start gap-1.5 rounded-md border border-danger/40 bg-danger/10 px-2 py-1.5`;

// What a refused land left behind; causes and the action ladder are AgentConflictReport's to own.
const resolvingPaths = computed(() => (changes.resolving.value ?? []).flatMap((entry) => entry.paths));

// Where the user's own conflict half is resolved: the Changes panel, the same deep-link the badges use.
const openChanges = (): void => {
    shell.setSidebarPanel(`changes`);
    void router.push({ name: `workspace` });
};

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
        <div v-if="changes.error.value" :class="[NOTICE, 'mx-2 mt-2 shrink-0']">
            <Icon name="exclamation-triangle" class="mt-0.5 shrink-0 text-2xs text-danger" />
            <div class="min-w-0 flex-1">
                <p class="text-2xs font-medium text-danger">Couldn't read this agent's changes</p>
                <p class="break-words text-2xs text-muted">{{ changes.error.value }}</p>
            </div>
        </div>
        <Notice v-if="changes.actionError.value" :of="changes.actionError.value" class="mx-2 mt-2 shrink-0" />

        <!--
            What a merge land left behind: everything else applied, these files carry markers to finish in the
            workspace.
            Shown above the conflict report so the newest outcome reads first.
        -->
        <div v-if="resolvingPaths.length > 0" class="mx-2 mt-2 flex shrink-0 flex-col gap-1 rounded-md border border-info/40 bg-info/10 px-2 py-1.5">
            <span class="text-2xs font-medium text-info">
                Landed with {{ resolvingPaths.length }} file{{ resolvingPaths.length === 1 ? "" : "s" }} to finish
            </span>
            <p class="text-2xs text-muted">
                Everything else applied. These carry conflict markers in your workspace: resolve them there, as you would any merge.
            </p>
            <p class="break-all font-mono text-2xs text-muted">{{ resolvingPaths.join(", ") }}</p>
        </div>

        <!--
            The conflict report and its action ladder; mounted rather than inlined since it holds its own decision
            tree.
        -->
        <AgentConflictReport
            v-if="changes.conflicts.value !== undefined && changes.conflicts.value.length > 0"
            class="mx-2 mt-2"
            :conflicts="changes.conflicts.value"
            :streaming="streaming"
            :writing="writing"
            :busy="changes.actionBusy.value"
            :asked="changes.asked.value"
            :box="remoteName"
            @resolve="changes.askResolve()"
            @merge="changes.land('merge')"
            @commit="openChanges"
            @stop="stopAgent(agentId, at)"
            @cross="cross"
            @chat="emit('chat')"
            @select="jumpTo"
        />

        <!--
            Where the committed work went, shown only while `history` is the active filter, since it isn't what the
            reader
            is doing otherwise. One row per commit, and the row is the way into the graph.
        -->
        <div
            v-if="filter === 'history' && history.commits.value.length > 0"
            class="mx-2 mt-2 flex shrink-0 flex-col gap-1 rounded-md border border-success/40 bg-success/10 px-2 py-1.5"
        >
            <span class="inline-flex items-center gap-1 text-2xs font-medium text-success">
                <Icon name="check" class="text-2xs" />In {{ remoteName === undefined ? "your" : `${remoteName}'s` }} history
            </span>
            <p class="text-2xs text-muted">
                You committed this work, so it is not a difference against main any more and the review above cannot list it. It is still readable
                here, file by file, exactly as the agent wrote it.
            </p>
            <button
                v-for="commit in history.commits.value"
                :key="commit.sha"
                type="button"
                class="flex items-center gap-1.5 rounded px-1 py-0.5 text-left transition-colors"
                :class="graphs.get(commit.repo) === undefined ? 'cursor-default' : 'hover:bg-overlay'"
                :disabled="graphs.get(commit.repo) === undefined"
                @click="openGitHistory(commit.repo)"
                v-tooltip.bottom="graphs.get(commit.repo) === undefined ? undefined : 'Open this repository\'s git history'"
            >
                <span class="shrink-0 rounded bg-overlay px-1 py-px font-mono text-2xs text-muted">{{ commit.short }}</span>
                <span class="min-w-0 flex-1 truncate text-2xs text-content" v-tooltip.bottom.overflow="commit.subject">{{ commit.subject }}</span>
                <span class="shrink-0 text-2xs text-subtle">
                    {{ commit.author }} · {{ historyStamp(commit.at) }} · {{ commit.changes.length }} file{{ commit.changes.length === 1 ? "" : "s" }}
                </span>
                <Icon v-if="graphs.get(commit.repo) !== undefined" name="sitemap" class="shrink-0 text-2xs text-subtle" />
            </button>
            <!-- Absorbed but unattributable: reached main by no commit here; said explicitly, not silently dropped. -->
            <p v-if="history.unaccounted.value > 0" class="text-2xs text-subtle">
                {{ history.unaccounted.value }} more file{{ history.unaccounted.value === 1 ? " is" : "s are" }} in your history without a commit here
                accounting for {{ history.unaccounted.value === 1 ? "it" : "them" }}: that content reached your main line some other way.
            </p>
        </div>

        <!-- History loads only once absorbed work is reported, skipping a flash of "nothing here" first. -->
        <p v-if="changes.loading.value && changes.count.value === 0" class="px-3 py-2 text-2xs text-subtle">Loading the agent's diff…</p>
        <p v-else-if="changes.count.value === 0 && changes.absorbed.value > 0 && history.loading.value" class="px-3 py-2 text-2xs text-subtle">
            Finding where this work went in your history…
        </p>
        <div
            v-else-if="changes.count.value === 0 && history.count.value === 0"
            class="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center"
        >
            <Icon :name="changes.absorbed.value > 0 ? 'check' : 'file-edit'" class="text-2xl text-subtle" />
            <!--
                An empty list is two opposite facts needing different next moves: nothing written, or everything
                already
                committed. `absorbed` (the daemon's count of retired rows) tells them apart.
            -->
            <p v-if="changes.absorbed.value > 0" class="max-w-xs text-2xs text-muted">{{ absorbedNote }} Anything it writes next shows up here.</p>
            <!--
                "Ask it in chat" only applies where a chat for this agent exists; a remote review has none on screen,
                so the
                sentence points at the crossing instead.
            -->
            <p v-else-if="remoteName !== undefined" class="max-w-xs text-2xs text-muted">
                This agent hasn't changed any files. Its conversation is in {{ remoteName }}: open it there to ask for something, and whatever it
                writes shows up here.
            </p>
            <p v-else class="max-w-xs text-2xs text-muted">
                This agent hasn't changed any files. Ask it for something in the chat: its work shows up here, file by file, to review before it
                lands.
            </p>
            <Button v-if="remoteName !== undefined" size="small" severity="secondary" class="mt-1" @click="cross">
                <Icon name="arrow-right" />Open in {{ remoteName }}
            </Button>
        </div>

        <!-- List | diff share one screen on a phone: the diff takes over on pick, with no route change either way. -->
        <!-- No select-none while dragging: ResizeSeam already claims the whole document's selection for the drag. -->
        <div v-else class="flex min-h-0 flex-1">
            <aside
                v-if="!mobile || selected === undefined"
                class="flex min-h-0 min-w-0 flex-col"
                :class="mobile ? 'flex-1' : 'shrink-0 border-r border-line'"
                :style="mobile ? undefined : { width: uiLength(shell.reviewListWidth.value) }"
            >
                <!--
                    The list's own header (count, filter, pass progress), the same height as the diff's toolbar so both
                    align. The
                    count prints once: the filter states the total and acts on it, so a bare count shows only without
                    one.
                -->
                <div class="flex h-8 shrink-0 items-center gap-1.5 border-b border-line px-2 max-md:h-12">
                    <SegmentedControl v-if="filterOptions.length > 1" v-model="filter" :options="filterOptions" size="xs" />
                    <span v-else class="whitespace-nowrap text-2xs text-muted">
                        <span class="font-medium text-content">{{ bodyFiles.length }}</span> file{{ bodyFiles.length === 1 ? "" : "s" }}
                    </span>
                    <Icon v-if="changes.loading.value" name="spinner" class="shrink-0 text-2xs text-muted" spin />
                    <span class="flex-1"></span>
                    <!--
                        Totals for the whole review; the code/tests split is now carried by the filter options above
                        instead.
                    -->
                    <ReviewStat :code="reviewCode" :additions="bodyAdditions" :deletions="bodyDeletions" />
                    <!--
                        A check and "N/total" reads as reviewed-of-total on its own, no hover-only shortcut hint needed
                        here.
                    -->
                    <span class="inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap text-2xs text-subtle">
                        <Icon name="check" class="text-2xs" />{{ bodyViewed }}/{{ bodyFiles.length }}
                    </span>
                </div>

                <div class="scrollbar-thin min-h-0 flex-1 overflow-auto">
                    <div v-for="group in groups" :key="group.repo">
                        <!--
                            Sticky, since scrolling is what takes the repo context away. Two controls in one row
                            (collapse, tick), not
                            nested, sharing the same right-hand column as each row's own tick so the finished pass
                            reads as one rail.
                        -->
                        <div
                            class="group/head sticky top-0 z-10 flex w-full items-center border-b border-line/60 bg-canvas pr-1 transition-colors hover:bg-overlay"
                        >
                            <button
                                type="button"
                                class="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1 text-left"
                                @click="toggleGroup(group.repo)"
                            >
                                <Icon class="shrink-0 text-2xs text-subtle" :name="collapsed.has(group.repo) ? 'chevron-right' : 'chevron-down'" />
                                <span class="min-w-0 truncate text-2xs font-semibold uppercase tracking-wide text-muted">{{ group.repo }}</span>
                                <span class="shrink-0 rounded-full bg-overlay px-1.5 py-px text-2xs text-muted">{{ groupLabel(group.files) }}</span>
                                <span
                                    v-if="group.blocked > 0"
                                    class="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-warning/20 px-1.5 py-px text-2xs font-medium text-warning"
                                >
                                    <Icon name="exclamation-triangle" class="text-2xs" />{{ group.blocked }}
                                </span>
                                <span class="flex-1"></span>
                                <ReviewStat :code="group.code" :additions="group.additions" :deletions="group.deletions" />
                            </button>
                            <ReviewGroupCheck
                                :name="group.repo"
                                :total="group.files.length"
                                :viewed="groupProgress(group.files)"
                                @toggle="toggleGroupViewed(group.files)"
                            />
                        </div>

                        <template v-if="!collapsed.has(group.repo)">
                            <template v-for="bucket in viewOf(group.repo).buckets" :key="`${group.repo}/${bucket.key}`">
                                <!--
                                    The package a run of rows belongs to, stated once: same
                                    fold-left/sweep-right/totals-between heading as the
                                    repo's, one scope down, since viewed and folding are both about the reader's own
                                    attention on that package.
                                -->
                                <div v-if="viewOf(group.repo).named" class="group/head flex items-center border-b border-line/40 bg-canvas/60 pr-1.5">
                                    <button
                                        type="button"
                                        class="flex min-w-0 flex-1 items-center gap-2 py-1 pl-2 pr-1.5 text-left"
                                        @click="toggleModule(group.repo, bucket.key)"
                                    >
                                        <Icon
                                            class="shrink-0 text-[0.6rem] text-subtle"
                                            :name="moduleCollapsed(group.repo, bucket.key) ? 'chevron-right' : 'chevron-down'"
                                        />
                                        <!--
                                            One way to name a module, shared with the workspace's own Changes list
                                            (ModuleLabel).
                                        -->
                                        <ModuleLabel :name="bucket.name" :packaged="bucket.packaged" />
                                        <span class="shrink-0 text-2xs text-subtle">{{ groupLabel(bucket.rows) }}</span>
                                        <!--
                                            A folded package can't hide a refusal either: same badge, same glyph, one
                                            scope down.
                                        -->
                                        <span
                                            v-if="bucket.blocked > 0"
                                            class="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-warning/20 px-1.5 py-px text-2xs font-medium text-warning"
                                        >
                                            <Icon name="exclamation-triangle" class="text-2xs" />{{ bucket.blocked }}
                                        </span>
                                        <span class="flex-1"></span>
                                        <!--
                                            Its size, always: the only place a folded package's +/- survives, and what
                                            marks it worth folding.
                                        -->
                                        <ReviewStat :code="bucket.code" :additions="bucket.additions" :deletions="bucket.deletions" />
                                    </button>
                                    <ReviewGroupCheck
                                        :name="bucket.name"
                                        :total="bucket.rows.length"
                                        :viewed="groupProgress(bucket.rows)"
                                        @toggle="toggleGroupViewed(bucket.rows)"
                                    />
                                </div>
                                <template v-if="!moduleCollapsed(group.repo, bucket.key)">
                                    <div
                                        v-for="file in bucket.rows"
                                        :key="file.key"
                                        :ref="(el) => setRowEl(file.key, el)"
                                        class="group/file flex items-center border-l-2 transition-colors"
                                        :class="[
                                            file.key === selectedKey
                                                ? 'border-primary-500 bg-primary-600/10'
                                                : file.blocked !== undefined
                                                  ? 'border-warning/70 bg-warning/5 hover:bg-overlay'
                                                  : 'border-transparent hover:border-line-strong hover:bg-overlay',
                                            // Under a header the rows step in, so the module reads as holding them.
                                            viewOf(group.repo).named ? 'pl-2' : '',
                                        ]"
                                    >
                                        <button
                                            type="button"
                                            class="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-2 pr-1.5 text-left max-md:min-h-11"
                                            :class="isViewed(file) ? 'opacity-50' : ''"
                                            @click="select(file)"
                                        >
                                            <ChangeStatusMark :status="file.change.status" />
                                            <Icon
                                                :name="iconForEntry(basename(file.change.path), 'file', false)"
                                                class="shrink-0 text-2xs"
                                                :class="explorerColorClass(explorerStyle, basename(file.change.path), 'file', false)"
                                            />
                                            <!--
                                                How a changed file is named, shared with the workspace's Changes list
                                                (ChangeRowName).
                                            -->
                                            <ChangeRowName :path="file.change.path" :label="file.label" :named="viewOf(group.repo).named" />
                                            <!--
                                                Why this row refused, on the row itself: a blocked file is unlanded by
                                                definition, so this mark replaces the
                                                plain not-landed dot rather than sitting beside it. One word plus the
                                                cause's glyph; the tooltip has the sentence.
                                            -->
                                            <span
                                                v-if="file.blocked !== undefined"
                                                class="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-warning/20 px-1 py-px text-2xs font-medium text-warning"
                                                v-tooltip.right="REASON_COPY[file.blocked].row"
                                            >
                                                <Icon :name="REASON_COPY[file.blocked].icon" class="text-2xs" />{{ REASON_COPY[file.blocked].mark }}
                                            </span>
                                            <!--
                                                Which commit took this file; silent with only one, already named by the
                                                summary above (`manyCommits`).
                                            -->
                                            <span
                                                v-else-if="file.carriedBy !== undefined && manyCommits"
                                                class="shrink-0 rounded bg-overlay px-1 py-px font-mono text-2xs text-subtle"
                                                v-tooltip.right="`You committed this file in ${file.carriedBy.short}`"
                                                >{{ file.carriedBy.short }}</span
                                            >
                                            <span
                                                v-else-if="file.carriedBy === undefined && !file.change.landed"
                                                class="h-1.5 w-1.5 shrink-0 rounded-full bg-warning"
                                                v-tooltip.right="'Not yet landed in your workspace'"
                                            ></span>
                                            <!--
                                                `of` turns the badge into a rail: weight against the heaviest file on
                                                screen, scanned rather than read digit by
                                                digit.
                                            -->
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
                                                    `rounded max-md:h-9 max-md:w-9`,
                                                    isViewed(file)
                                                        ? `text-success`
                                                        : `opacity-0 focus-visible:opacity-100 group-hover/file:opacity-100 max-md:opacity-100`,
                                                )
                                            "
                                            @click="toggleViewed(file)"
                                            v-tooltip.right="isViewed(file) ? 'Reviewed, click to unmark' : 'Mark as reviewed'"
                                            :aria-label="`Mark ${file.label} as reviewed`"
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

            <!--
                Sits in flow with negative margins, straddling the border without an overlay that scrolls with the
                list.
            -->
            <ResizeSeam
                v-if="!mobile"
                v-model="seamWidth"
                :min="toScreenPx(MIN_REVIEW_LIST_WIDTH)"
                :max="toScreenPx(MAX_REVIEW_LIST_WIDTH)"
                :reset="toScreenPx(defaultReviewListWidth())"
                title="Drag to resize · double-click to reset"
            />

            <section v-if="!mobile || selected !== undefined" class="flex min-h-0 min-w-0 flex-1 flex-col">
                <template v-if="selected !== undefined">
                    <!--
                        The same toolbar the workspace tab renders, so Split|Unified and Comments sit in the same place
                        everywhere;
                        what it can't know (this file's place in a review) comes in through slots instead.
                    -->
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
                                aria-label="Back to the file list"
                            >
                                <Icon name="arrow-left" class="text-xs" />
                            </button>
                        </template>
                        <!--
                            The row's mark, carried onto the opened file: a diff without it would read as an ordinary
                            change.
                        -->
                        <template #badges>
                            <span
                                v-if="selected.blocked !== undefined"
                                class="inline-flex shrink-0 items-center gap-1 rounded-full bg-warning/15 px-1.5 py-px text-2xs font-medium text-warning"
                                v-tooltip.bottom="REASON_COPY[selected.blocked].row"
                            >
                                <Icon :name="REASON_COPY[selected.blocked].icon" class="text-2xs" />blocked · {{ REASON_COPY[selected.blocked].mark }}
                            </span>
                            <!--
                                What this diff is on an already-committed file: the agent's own change, measured the
                                same as every other row,
                                not the commit's own patch; the tooltip says which when the two differ.
                            -->
                            <span
                                v-else-if="selected.carriedBy !== undefined"
                                class="inline-flex shrink-0 items-center gap-1 rounded-full bg-success/15 px-1.5 py-px font-mono text-2xs font-medium text-success"
                                v-tooltip.bottom="'You committed this file here. The diff is what the agent wrote, not the commit\'s own patch.'"
                            >
                                <Icon name="check" class="text-2xs" />{{ selected.carriedBy.short }}
                            </span>
                            <span
                                v-else-if="!selected.change.landed"
                                class="shrink-0 rounded-full bg-warning/15 px-1.5 py-px text-2xs font-medium text-warning"
                                v-tooltip.bottom="'Still waiting for Land now'"
                            >
                                not landed
                            </span>
                        </template>
                        <template #actions>
                            <button
                                type="button"
                                :class="[ICON_BUTTON, isViewed(selected) ? 'text-success' : '']"
                                @click="toggleViewed(selected)"
                                v-tooltip.bottom="
                                    isViewed(selected)
                                        ? 'Reviewed: click to unmark (v)'
                                        : 'Mark reviewed and go to the next file (v) · ⇧V for the rest of this group'
                                "
                                :aria-label="`Mark ${selected.label} as reviewed`"
                            >
                                <Icon :name="isViewed(selected) ? 'check-square' : 'check'" class="text-2xs" />
                            </button>
                            <button
                                type="button"
                                :class="ICON_BUTTON"
                                @click="move(-1)"
                                v-tooltip.bottom="'Previous file (k)'"
                                aria-label="Previous file"
                            >
                                <Icon name="chevron-up" class="text-2xs" />
                            </button>
                            <button type="button" :class="ICON_BUTTON" @click="move(1)" v-tooltip.bottom="'Next file (j)'" aria-label="Next file">
                                <Icon name="chevron-down" class="text-2xs" />
                            </button>
                            <!--
                                Absent for a remote agent: "the workspace editor" is this box's own /work, and a tab
                                there would carry another
                                box's paths over a tree that never held them; the review is the whole surface for that
                                case.
                            -->
                            <button
                                v-if="!mobile && at === undefined"
                                type="button"
                                :class="ICON_BUTTON"
                                :disabled="diff === undefined"
                                @click="openInWorkspace(selected)"
                                v-tooltip.bottom="'Open this diff in the workspace editor'"
                                aria-label="Open this diff in the workspace"
                            >
                                <Icon name="external-link" class="text-2xs" />
                            </button>
                        </template>
                    </DiffToolbar>

                    <div class="min-h-0 flex-1">
                        <p v-if="diffError !== undefined" class="p-4 text-xs text-danger">{{ diffError }}</p>
                        <p v-else-if="diff === undefined" class="p-4 text-xs text-subtle">
                            <Icon v-if="diffLoading" name="spinner" spin class="mr-1 text-xs" />Loading the diff…
                        </p>
                        <!--
                            Bytes, a patch, or two whole sides: FileDiffPane decides, same as it does in the workspace
                            editor.
                        -->
                        <FileDiffPane
                            v-else
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
                </template>
                <p v-else class="p-4 text-2xs text-subtle">Pick a file to see what the agent did to it.</p>
            </section>
        </div>
    </div>
</template>
