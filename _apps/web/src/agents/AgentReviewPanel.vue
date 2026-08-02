<script setup lang="ts">
import type { FileDiffResponse } from "@intentic-app/api-contract";
import { cmp, explorerColorClass, iconForEntry, Segmented, useDevice, useExplorerStyle } from "@intentic-app/ui";
import { isTestPath } from "@intentic/sandbox-contract";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import DiffStat from "../components/DiffStat.vue";
import { stopAgent } from "../composables/agents/agentActions";
import { type Blocker, REASON_COPY } from "../composables/agents/conflictResolution";
import { type AgentReviewFile, useAgentChanges } from "../composables/agents/useAgentChanges";
import { useLayout } from "../composables/useLayout";
import { diffRawUrls } from "../composables/workspace/diffRaw";
import { useWorkspaceTabs } from "../composables/workspace/useWorkspaceTabs";
import BinaryDiffView from "../pages/workspace/viewers/BinaryDiffView.vue";
import DiffToolbar from "../pages/workspace/viewers/DiffToolbar.vue";
import DiffView from "../pages/workspace/viewers/DiffView.vue";
import { rendersAsBytes } from "../pages/workspace/fileType";
import { moduleGroups, type ModuleGroup } from "../pages/workspace/changeModules";
import { useChangeGrouping } from "../composables/workspace/useChangeGrouping";
import { useModules } from "../composables/workspace/useModules";
import AgentConflictReport from "./AgentConflictReport.vue";
import { basename, parentDir } from "@intentic-app/ui/path";
import ChangeStatusMark from "../components/ChangeStatusMark.vue";

/* One agent's work, as a REVIEW: the file list on the left, that file's diff on the right, in this view — the
 * shape every code review has (GitHub, VSCode's SCM, `git add -p`), because the job is scanning a body of
 * changes fast enough to decide whether to land them.
 *
 * Three things this is built around, each replacing something the old panel got wrong:
 *   - THE DIFF IS HERE. Clicking a file used to push a workspace tab and NAVIGATE AWAY to /workspace, which
 *     abandoned the review to look at one file. The diff now renders next to the list (Monaco, the same engine
 *     the editor uses), so the next file is one keystroke away. Opening it in the workspace is still offered —
 *     as a deliberate secondary action, for when a file needs the full editor.
 *   - EACH COLUMN CARRIES ITS OWN BAR, and neither spans both. The list's header counts and narrows the FILES;
 *     the diff's (DiffToolbar, the same one the workspace tab renders) names and configures the FILE you are
 *     reading. What used to sit above both was a single full-width strip holding eleven targets and three
 *     unrelated jobs — what's in this changeset, narrow the list, end the session — so it stated the file count
 *     four times over and put Discard eight pixels from Land. The session half of it now lives in the page
 *     header above (AgentDetail); the two bars here are exactly as wide as the thing they describe.
 *   - LANDED WORK IS STILL WORK. The list is the agent's CUMULATIVE output (see useAgentChanges), not the
 *     not-yet-landed remainder. A clean turn auto-lands within milliseconds, so a remainder-scoped list showed
 *     an empty panel for everything the agent had just written. Rows carry `landed`; the toolbar counts what is
 *     left, and the Segmented filters down to it.
 *   - A REVIEW HAS PROGRESS. Files can be ticked off as you look at them (viewed, GitHub-style), the toolbar
 *     shows the count, and `v` ticks the current file and advances — so a 30-file scan has a place to stop and
 *     resume rather than being a wall of paths.
 *   - A CONFLICT IS A PROPERTY OF FILES. When a land refuses, the report above says how many refused and why;
 *     the LIST says which. Every blocked row carries its cause (REASON_COPY — the report's own vocabulary and
 *     the report's own glyph), each repo heading carries its count so a collapsed group cannot hide one, and
 *     the filter narrows to exactly them. Without this the two halves of a conflict lived apart: a paragraph
 *     naming three paths, above thirty rows that all looked alike, and the user matching strings by eye.
 *
 * Keyboard, while focus isn't in a text field or inside Monaco: ↑/↓ or j/k move, v marks viewed and advances.
 * Land/discard stay gated on the turn: both are refused daemon-side while it streams (CONFLICT), so they are
 * disabled up front when this browser is the one streaming. */

const { agentId, changes } = defineProps<{
    agentId: string;
    // The review's state, created and owned by AgentDetail — see the note there. This panel reads it and fires
    // the conflict ladder's own actions through it; Land, archive, discard and hold fire from the page header.
    changes: ReturnType<typeof useAgentChanges>;
    // Whether THIS browser is streaming the agent's turn — the conflict report gates its offers on it.
    streaming: boolean;
}>();
// "Watch it work" — the conflict block's link to the turn it just started. On desktop the conversation is
// already on screen in the docked chat, so this is a mobile affair: only there is the chat a mode this view
// has to be switched INTO, and only the parent owns that switch.
const emit = defineEmits<{ chat: [] }>();
const router = useRouter();
const { mobile } = useDevice();
const { explorerStyle } = useExplorerStyle();
const shell = useLayout();
const { openDiff } = useWorkspaceTabs();

// --- the list ------------------------------------------------------------------------------------------
/* THE NARROWING CONTROL. Every option is offered exactly while it would tell the user something they cannot
 * already see, and each is dropped for its own reason — which is why this is a list built per state rather
 * than one `splittable` flag over the whole control. That flag was "is the unlanded set a proper subset", and
 * it hid the Segmented ENTIRELY whenever it wasn't: a refused land is atomic, so it leaves every row unlanded,
 * so the one state where narrowing matters most was the one state with no control to do it.
 *
 *   Blocked     — what refused. First, because when it exists it is the only reason the user is on this panel.
 *   Code/Tests  — the product change vs the proof, offered only when the review holds both.
 *   Not landed  — the remainder Land now would apply, offered only while it is a PROPER subset: with nothing
 *                 landed it filters nothing, and with everything landed it would empty the panel. */
type ReviewFilter = `all` | `blocked` | `code` | `tests` | `pending`;
const filter = ref<ReviewFilter>(`all`);
const filterOptions = computed<{ label: string; value: ReviewFilter }[]>(() => [
    { label: `All ${changes.count.value}`, value: `all` },
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
]);
// A filter whose option has gone (the agent landed the last blocker, say) would otherwise hold the list empty
// with nothing on screen still claiming to be filtering it.
watch(filterOptions, (options) => {
    if (!options.some((option) => option.value === filter.value)) {
        filter.value = `all`;
    }
});

const collapsed = ref<ReadonlySet<string>>(new Set());
const toggleGroup = (repo: string): void => {
    const next = new Set(collapsed.value);
    if (!next.delete(repo)) {
        next.add(repo);
    }
    collapsed.value = next;
};

const filtered = computed<readonly AgentReviewFile[]>(() => {
    if (filter.value === `blocked`) {
        return changes.blocked.value;
    }
    if (filter.value === `pending`) {
        return changes.files.value.filter((file) => !file.change.landed);
    }
    // The change vs the proof — the contract's isTestPath, the same classifier the header chips total.
    if (filter.value === `code` || filter.value === `tests`) {
        return changes.files.value.filter((file) => isTestPath(file.change.path) === (filter.value === `tests`));
    }
    return changes.files.value;
});

// Repo groups in the daemon's order, rebuilt from the filtered rows so an emptied group disappears with its
// header rather than leaving a heading over nothing.
const groups = computed(() => {
    const byRepo = new Map<string, AgentReviewFile[]>();
    for (const file of filtered.value) {
        const bucket = byRepo.get(file.repo);
        if (bucket === undefined) {
            byRepo.set(file.repo, [file]);
        } else {
            bucket.push(file);
        }
    }
    return [...byRepo].map(([repo, files]) => ({
        repo,
        files,
        additions: files.reduce((total, file) => total + (file.change.additions ?? 0), 0),
        deletions: files.reduce((total, file) => total + (file.change.deletions ?? 0), 0),
        // On the heading because a collapsed repo is otherwise a place a blocker can hide: the whole point of
        // the row marks is that the list says where the trouble is without being scrolled or expanded.
        blocked: files.filter((file) => file.blocked !== undefined).length,
    }));
});

/* The same reading the workspace's Changes panel offers, from the same preference (useChangeGrouping): a repo's
 * rows grouped under the package each path lives in, with the row itself shrunk to the file. One setting for
 * both review surfaces, because "how do I read a change list" is not a thing anyone wants to answer twice —
 * and because these two lists disagreeing about how a changed file is named is exactly the kind of seam that
 * makes two panels feel like two products. */
const { groupByModule } = useChangeGrouping();
const { modulesOf } = useModules();

interface RepoView {
    // A repo's rows as the list draws them: one unnamed bucket in path mode, one per module otherwise.
    readonly buckets: readonly ModuleGroup<AgentReviewFile>[];
    // Whether those buckets get headers. A lone bucket of files no module claims is the repo's name printed
    // under the repo's own header — nothing to say, so nothing said.
    readonly named: boolean;
}

// Built once per change to the review, not per call: the rows read `named` too (a row's label switches on it),
// and a grouping pass per row would be quadratic on a big landing.
const repoViews = computed<ReadonlyMap<string, RepoView>>(() => {
    const views = new Map<string, RepoView>();
    for (const group of groups.value) {
        const buckets = groupByModule.value
            ? moduleGroups(group.files, (file) => file.change.path, modulesOf(group.repo), group.repo)
            : [{ key: `all`, name: ``, packaged: false, rows: group.files as readonly AgentReviewFile[] }];
        views.set(group.repo, { buckets, named: groupByModule.value && (buckets.length > 1 || buckets[0]?.packaged === true) });
    }
    return views;
});
const EMPTY_VIEW: RepoView = { buckets: [], named: false };
const viewOf = (repo: string): RepoView => repoViews.value.get(repo) ?? EMPTY_VIEW;

// What the keyboard walks: the rows actually on screen, in render order. A collapsed repo contributes nothing —
// you cannot step onto a row you cannot see. Read through the buckets, since grouping reorders a repo's rows.
const visibleRows = computed<readonly AgentReviewFile[]>(() =>
    groups.value.flatMap((group) => (collapsed.value.has(group.repo) ? [] : viewOf(group.repo).buckets.flatMap((bucket) => bucket.rows))),
);

const selectedKey = ref<string | undefined>(undefined);
// Resolved against the FILTERED rows, not the visible ones: collapsing a repo group is "give me back some
// list space", not "close the file I'm reading".
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

/* The conflict report's paths, landed on the rows they name. The report explains the CAUSES; the list holds
 * the files — clicking a path is the one gesture that joins them, and without it a user reading "3 files
 * couldn't be applied" over thirty rows is left to find them by matching strings with their eyes.
 *
 * Both guards are the difference between a click that works and a click that visibly does nothing: the row may
 * be hidden by the filter the user is standing in (widened to `blocked`, which by definition holds it — never
 * to `all`, which would throw away a narrowing they chose), and its repo may be collapsed. The scroll waits a
 * tick because after either of those the row's element does not exist yet. */
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
    selectedKey.value = file.key;
    await nextTick();
    rowEls.get(file.key)?.scrollIntoView({ block: `nearest` });
};

// Desktop opens on the first file — an empty diff pane next to a full list is a dead half-screen, and the
// first thing a reviewer does is click that row anyway. Mobile does NOT: there the diff is a full-screen
// takeover, so it waits to be asked for. A refresh that keeps the selected path keeps the selection.
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
    // Clamped, not wrapped: the list is a document being read top to bottom, and wrapping past the last file
    // back to the first reads as "nothing happened, and now you've lost your place".
    const next = rows[Math.min(rows.length - 1, Math.max(0, index + delta))];
    if (next !== undefined) {
        select(next);
    }
};

// --- viewed pass ---------------------------------------------------------------------------------------
const isViewed = (file: AgentReviewFile): boolean => changes.viewed.value.has(file.key);
const toggleViewed = (file: AgentReviewFile): void => changes.setViewed(file.key, !isViewed(file));
// The scanning loop: tick this file off and drop onto the next one, so a pass is one key per file.
const viewAndAdvance = (): void => {
    const file = selected.value;
    if (file !== undefined) {
        changes.setViewed(file.key, true);
        move(1);
    }
};

const onKey = (event: KeyboardEvent): void => {
    if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
    }
    // Typing beats navigating — the docked chat composer shares this screen, and Monaco's own editing surface
    // is a (hidden) textarea, so this same guard leaves ↑/↓ and F7 to the diff whenever it has focus.
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
    }
};
onMounted(() => window.addEventListener(`keydown`, onKey));
onBeforeUnmount(() => window.removeEventListener(`keydown`, onKey));

// --- the diff ------------------------------------------------------------------------------------------
const diff = ref<FileDiffResponse | undefined>(undefined);
const diffError = ref<string | undefined>(undefined);
const diffLoading = ref(false);
// Identity of what the viewer is showing. Monaco is uncontrolled (it owns its models), so a new file — or the
// same file re-read after the agent moved it — has to remount the editor rather than re-render it.
const diffKey = ref(``);
let fetchSeq = 0;

watch(
    selected,
    (file) => {
        diff.value = undefined;
        diffError.value = undefined;
        if (file === undefined) {
            return;
        }
        const token = ++fetchSeq;
        diffLoading.value = true;
        // Arrowing through a list outruns the network, so every response is checked against the latest request
        // before it paints — otherwise a slow early file lands on top of the file you're now looking at.
        void changes
            .fileDiff(file.repo, file.change.path)
            .then((body) => {
                if (token === fetchSeq) {
                    diff.value = body;
                    diffKey.value = `${file.key}:${token}`;
                }
            })
            .catch((error: Error) => {
                if (token === fetchSeq) {
                    diffError.value = error.message;
                }
            })
            .finally(() => {
                if (token === fetchSeq) {
                    diffLoading.value = false;
                }
            });
    },
    { immediate: true },
);

// Where the selected file's BYTES live, for the sides the response can only flag as binary. Derived from the
// row rather than fetched: a binary diff carries no content to infer the sides from, and the status letter
// already says which of them the file has.
const rawSides = computed(() =>
    selected.value === undefined
        ? {}
        : diffRawUrls({ source: `agent`, agent: agentId, repo: selected.value.repo }, selected.value.change.path, selected.value.change.status),
);

// The escape hatch to the full editor: the same diff as a workspace tab, where it gets the whole area, the
// tab bar, and the file tree next to it. Deliberately not what a row click does any more.
const openInWorkspace = (file: AgentReviewFile): void => {
    const body = diff.value;
    if (body === undefined) {
        return;
    }
    openDiff({
        key: `agent:${agentId}:${file.repo}`,
        scope: file.repo,
        label: file.label,
        status: file.change.status,
        path: file.change.path,
        ...body,
        ...diffRawUrls({ source: `agent`, agent: agentId, repo: file.repo }, file.change.path, file.change.status),
    });
    void router.push({ name: `workspace` });
};

// --- presentation --------------------------------------------------------------------------------------

// The design system's toolbar icon button, plus this panel's own disabled treatment.
const ICON_BUTTON = cmp.iconButton(`disabled:opacity-40`);
const NOTICE = `flex items-start gap-1.5 rounded-md border border-danger/40 bg-danger/10 px-2 py-1.5`;

// What a refused land left behind. The report itself — the causes, and the ladder of actions ordered by who
// can take them — is AgentConflictReport; this panel only owns where its buttons lead.
const resolvingPaths = computed(() => (changes.resolving.value ?? []).flatMap((entry) => entry.paths));

// Where the user's own half of a conflict is dealt with: the workspace sidebar's Changes panel, which is
// where these paths get committed or stashed. Same deep-link the badges use — setSidebarPanel un-collapses.
const openChanges = (): void => {
    shell.setSidebarPanel(`changes`);
    void router.push({ name: `workspace` });
};

// --- the list's width ----------------------------------------------------------------------------------
// The file list is a column of PATHS, and how much of one you need is the reviewer's call, not a constant:
// a flat repo reads fine at the default, a deep monorepo truncates every row at it. Same gesture and same
// persistence as the workspace explorer's edge — drag to size, double-click to reset, remembered after.
// Pointer capture rather than window listeners, so a drag that outruns the 6px strip still tracks.
const listEl = ref<HTMLElement>();
const resizing = ref(false);
let listLeft = 0;

const startResize = (event: PointerEvent): void => {
    event.preventDefault();
    listLeft = listEl.value?.getBoundingClientRect().left ?? 0;
    resizing.value = true;
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
};

const onResize = (event: PointerEvent): void => {
    if (resizing.value) {
        shell.setReviewListWidth(event.clientX - listLeft);
    }
};

const endResize = (event: PointerEvent): void => {
    if (!resizing.value) {
        return;
    }
    resizing.value = false;
    const target = event.target as HTMLElement;
    if (target.hasPointerCapture(event.pointerId)) {
        target.releasePointerCapture(event.pointerId);
    }
};
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
        <div v-if="changes.actionError.value" :class="[NOTICE, 'mx-2 mt-2 shrink-0']">
            <Icon name="exclamation-triangle" class="mt-0.5 shrink-0 text-2xs text-danger" />
            <p class="min-w-0 flex-1 break-words text-2xs text-danger">{{ changes.actionError.value }}</p>
        </div>

        <!-- What a MERGE land left behind: the delta is in the workspace, and these files carry markers to
             finish there. Shown above the conflict report so the newest outcome reads first. -->
        <div v-if="resolvingPaths.length > 0" class="mx-2 mt-2 flex shrink-0 flex-col gap-1 rounded-md border border-info/40 bg-info/10 px-2 py-1.5">
            <span class="text-2xs font-medium text-info">
                Landed with {{ resolvingPaths.length }} file{{ resolvingPaths.length === 1 ? "" : "s" }} to finish
            </span>
            <p class="text-2xs text-muted">
                Everything else applied. These carry conflict markers in your workspace — resolve them there, as you would any merge.
            </p>
            <p class="break-all font-mono text-2xs text-muted">{{ resolvingPaths.join(", ") }}</p>
        </div>

        <!-- The conflict report, and the ladder of what to do about it. Mounted rather than inlined: it is
             the one part of this panel with a decision tree in it (see AgentConflictReport). -->
        <AgentConflictReport
            v-if="changes.conflicts.value !== undefined && changes.conflicts.value.length > 0"
            class="mx-2 mt-2"
            :conflicts="changes.conflicts.value"
            :streaming="streaming"
            :busy="changes.actionBusy.value"
            :asked="changes.asked.value"
            @resolve="changes.askResolve()"
            @merge="changes.land('merge')"
            @commit="openChanges"
            @stop="stopAgent(agentId)"
            @chat="emit('chat')"
            @select="jumpTo"
        />

        <p v-if="changes.loading.value && changes.count.value === 0" class="px-3 py-2 text-2xs text-subtle">Loading the agent's diff…</p>
        <div v-else-if="changes.count.value === 0" class="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
            <Icon name="file-edit" class="text-2xl text-subtle" />
            <p class="max-w-xs text-2xs text-muted">
                This agent hasn't changed any files. Ask it for something in the chat — its work shows up here, file by file, to review before it
                lands.
            </p>
        </div>

        <!-- List | diff. On a phone the two are the same real estate: the list IS the view until a file is
             picked, and the diff takes the screen with a back arrow — no route change either way. -->
        <div v-else class="flex min-h-0 flex-1" :class="resizing ? 'select-none' : ''">
            <aside
                v-if="!mobile || selected === undefined"
                ref="listEl"
                class="flex min-h-0 min-w-0 flex-col"
                :class="mobile ? 'flex-1' : 'shrink-0 border-r border-line'"
                :style="mobile ? undefined : { width: `${shell.reviewListWidth.value}px` }"
            >
                <!-- The list's own header — everything on it is about the FILES: how many, which of them, how
                     far the pass got. Exactly as tall as the diff's toolbar beside it (h-8), so the two column
                     headers read as one unbroken line across the panel, the same invariant .view-header keeps
                     for the shell's columns.

                     The count is stated ONCE. It used to appear four times over: "8 files", the "All 8" filter
                     option, "0/8 reviewed", and each repo heading's badge. The filter is the copy that earns
                     its pixels — it prints the total AND is the control that acts on it — so the bare count
                     only renders when there is no filter to state it. -->
                <div class="flex h-8 shrink-0 items-center gap-1.5 border-b border-line px-2 max-md:h-12">
                    <Segmented v-if="filterOptions.length > 1" v-model="filter" :options="filterOptions" size="xs" />
                    <span v-else class="whitespace-nowrap text-2xs text-muted">
                        <span class="font-medium text-content">{{ changes.count.value }}</span> file{{ changes.count.value === 1 ? "" : "s" }}
                    </span>
                    <Icon v-if="changes.loading.value" name="spinner" class="shrink-0 text-2xs text-muted" spin />
                    <span class="flex-1"></span>
                    <!-- Totals for the whole review. The code/tests SPLIT that used to sit here in ± lines is
                         gone: the Code/Tests filter options above already carry that division in files, and
                         saying it twice in two units is how a header becomes something you stop reading. -->
                    <DiffStat :additions="changes.additions.value" :deletions="changes.deletions.value" />
                    <!-- A check and "3/12" beside a file list reads as reviewed-of-total without being told.
                         The keyboard map it used to smuggle in here reached nobody: a hover on a counter is not
                         where anyone looks for shortcuts. -->
                    <span class="inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap text-2xs text-subtle">
                        <Icon name="check" class="text-2xs" />{{ changes.viewedCount.value }}/{{ changes.count.value }}
                    </span>
                </div>

                <div class="scrollbar-thin min-h-0 flex-1 overflow-auto">
                    <div v-for="group in groups" :key="group.repo">
                        <!-- Sticky, because the repo a path belongs to is the one thing scrolling takes away. -->
                        <button
                            type="button"
                            class="sticky top-0 z-10 flex w-full items-center gap-1.5 border-b border-line/60 bg-canvas px-2 py-1 text-left transition-colors hover:bg-overlay"
                            @click="toggleGroup(group.repo)"
                        >
                            <Icon class="shrink-0 text-2xs text-subtle" :name="collapsed.has(group.repo) ? 'chevron-right' : 'chevron-down'" />
                            <span class="min-w-0 truncate text-2xs font-semibold uppercase tracking-wide text-muted">{{ group.repo }}</span>
                            <span class="shrink-0 rounded-full bg-overlay px-1.5 py-px text-2xs text-muted">{{ group.files.length }}</span>
                            <span
                                v-if="group.blocked > 0"
                                class="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-warning/20 px-1.5 py-px text-2xs font-medium text-warning"
                            >
                                <Icon name="exclamation-triangle" class="text-2xs" />{{ group.blocked }}
                            </span>
                            <span class="flex-1"></span>
                            <DiffStat :additions="group.additions" :deletions="group.deletions" />
                        </button>

                        <template v-if="!collapsed.has(group.repo)">
                            <template v-for="bucket in viewOf(group.repo).buckets" :key="`${group.repo}/${bucket.key}`">
                                <!-- The module its run of rows belongs to, said once — a label, not a control: the
                                 actions in this panel are the review's (viewed, land, open) and none of them
                                 has a module-sized scope. -->
                                <div
                                    v-if="viewOf(group.repo).named"
                                    class="flex items-center gap-1.5 border-b border-line/40 bg-canvas/60 px-2 py-0.5"
                                >
                                    <Icon :name="bucket.packaged ? 'box' : 'folder'" class="shrink-0 text-2xs text-subtle" />
                                    <span class="min-w-0 truncate text-2xs font-medium text-muted" v-tooltip.right.overflow="bucket.name">{{
                                        bucket.name
                                    }}</span>
                                    <span class="shrink-0 text-2xs text-subtle">{{ bucket.rows.length }}</span>
                                </div>
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
                                        class="flex min-w-0 flex-1 items-center gap-1.5 py-1 pl-1.5 pr-1 text-left max-md:min-h-11"
                                        :class="isViewed(file) ? 'opacity-50' : ''"
                                        @click="select(file)"
                                    >
                                        <ChangeStatusMark :status="file.change.status" />
                                        <Icon
                                            :name="iconForEntry(basename(file.change.path), 'file', false)"
                                            class="shrink-0 text-2xs"
                                            :class="explorerColorClass(explorerStyle, basename(file.change.path), 'file', false)"
                                        />
                                        <!-- Under a module header the row is the file alone — the header carries where
                                     it lives — and the full path is always the tooltip rather than only when
                                     the row is cut off, because a basename is ambiguous by construction. -->
                                        <span
                                            v-if="viewOf(group.repo).named"
                                            class="min-w-0 flex-1 truncate text-2xs font-medium text-content max-md:text-xs"
                                            v-tooltip.right="file.label"
                                            >{{ basename(file.change.path) }}</span
                                        >
                                        <!-- Basename first and legible, its directory trailing and dimmed: a review is
                                     read by file name, and the middle-truncated full paths this replaces made
                                     every row in a deep tree look the same. -->
                                        <span v-else class="min-w-0 flex-1 truncate text-2xs max-md:text-xs" v-tooltip.right.overflow="file.label">
                                            <span class="font-medium text-content">{{ basename(file.change.path) }}</span>
                                            <span class="ml-1 text-subtle">{{ parentDir(file.change.path) }}</span>
                                        </span>
                                        <!-- WHY THIS ROW REFUSED, on the row. A blocked file is unlanded by
                                     definition, so the plain dot would only be repeating what the mark
                                     already says in a word — the mark REPLACES it rather than crowding in
                                     beside it. One word and the cause's own glyph, because this sits between
                                     a truncating path and a diffstat; the sentence is the tooltip. -->
                                        <span
                                            v-if="file.blocked !== undefined"
                                            class="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-warning/20 px-1 py-px text-2xs font-medium text-warning"
                                            v-tooltip.right="REASON_COPY[file.blocked].row"
                                        >
                                            <Icon :name="REASON_COPY[file.blocked].icon" class="text-2xs" />{{ REASON_COPY[file.blocked].mark }}
                                        </span>
                                        <span
                                            v-else-if="!file.change.landed"
                                            class="h-1.5 w-1.5 shrink-0 rounded-full bg-warning"
                                            v-tooltip.right="'Not yet landed in your workspace'"
                                        ></span>
                                        <DiffStat :additions="file.change.additions" :deletions="file.change.deletions" />
                                    </button>
                                    <button
                                        type="button"
                                        class="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted transition-colors hover:bg-overlay hover:text-content max-md:h-9 max-md:w-9"
                                        :class="
                                            isViewed(file)
                                                ? 'text-success'
                                                : 'opacity-0 focus-visible:opacity-100 group-hover/file:opacity-100 max-md:opacity-100'
                                        "
                                        @click="toggleViewed(file)"
                                        v-tooltip.right="isViewed(file) ? 'Reviewed — click to unmark' : 'Mark as reviewed'"
                                        :aria-label="`Mark ${file.label} as reviewed`"
                                    >
                                        <Icon :name="isViewed(file) ? 'check-square' : 'check'" class="text-2xs" />
                                    </button>
                                </div>
                            </template>
                        </template>
                    </div>
                </div>
            </aside>

            <!-- The seam between list and diff. Sits in flow with negative margins, so it straddles the border
                 without an overlay: the list scrolls, and an absolutely-positioned handle inside it would
                 scroll away with the rows. -->
            <div
                v-if="!mobile"
                class="review-resize"
                :class="resizing ? 'is-resizing' : ''"
                @pointerdown="startResize"
                @pointermove="onResize"
                @pointerup="endResize"
                @pointercancel="endResize"
                @dblclick="shell.resetReviewListWidth()"
                title="Drag to resize · double-click to reset"
            ></div>

            <section v-if="!mobile || selected !== undefined" class="flex min-h-0 min-w-0 flex-1 flex-col">
                <template v-if="selected !== undefined">
                    <!-- The same bar the workspace tab renders, so Split|Unified and Comments are in the same
                         place with the same words wherever a diff is read. What it can't know — this file's
                         place in a REVIEW — comes in through its slots: the conflict mark beside the name, and
                         the reviewer's own controls after the reading ones. -->
                    <DiffToolbar
                        :path="selected.label"
                        :status="selected.change.status"
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
                        <!-- The row's mark, carried onto the file you opened: this header is where a reviewer
                             actually is while deciding what to do about the conflict, and a diff that does not
                             say it is the blocked one reads as an ordinary change. -->
                        <template #badges>
                            <span
                                v-if="selected.blocked !== undefined"
                                class="inline-flex shrink-0 items-center gap-1 rounded-full bg-warning/15 px-1.5 py-px text-2xs font-medium text-warning"
                                v-tooltip.bottom="REASON_COPY[selected.blocked].row"
                            >
                                <Icon :name="REASON_COPY[selected.blocked].icon" class="text-2xs" />blocked · {{ REASON_COPY[selected.blocked].mark }}
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
                                v-tooltip.bottom="isViewed(selected) ? 'Reviewed — click to unmark (v)' : 'Mark reviewed and go to the next file (v)'"
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
                            <button
                                v-if="!mobile"
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
                        <!-- No text to diff is not the same as nothing to see: an image renders as its two
                             sides, which is most of what reviewing an agent's asset change consists of. -->
                        <BinaryDiffView
                            v-else-if="rendersAsBytes(selected.change.path, diff.binary)"
                            :key="diffKey"
                            :path="selected.change.path"
                            :before="rawSides.beforeRaw"
                            :after="rawSides.afterRaw"
                        />
                        <p v-else-if="diff.truncated" class="p-4 text-xs text-subtle">File too large to diff in the browser.</p>
                        <DiffView v-else :key="diffKey" :before="diff.before" :after="diff.after" :path="selected.change.path" />
                    </div>
                </template>
                <p v-else class="p-4 text-2xs text-subtle">Pick a file to see what the agent did to it.</p>
            </section>
        </div>
    </div>
</template>

<style scoped>
/* Drag-to-resize seam on the file list's right edge (pointer-capture, no global listeners — mirrors the
   workspace explorer's .ws-resize). Above the sticky repo headers so a drag started over one still grabs it. */
.review-resize {
    position: relative;
    z-index: 20;
    flex: 0 0 6px;
    margin: 0 -3px;
    cursor: col-resize;
    touch-action: none;
    transition: background-color 0.15s;
}
.review-resize:hover,
.review-resize.is-resizing {
    background: color-mix(in srgb, var(--color-primary-500) 35%, transparent);
}
</style>
