<script setup lang="ts">
import type { FileDiffResponse } from "@intentic-app/api-contract";
import { cmp, explorerColorClass, iconForEntry, Segmented, useDevice, useExplorerStyle } from "@intentic-app/ui";
import Dialog from "primevue/dialog";
import { computed, onBeforeUnmount, onMounted, ref, toRef, watch } from "vue";
import { useRouter } from "vue-router";
import DiffStat from "../components/DiffStat.vue";
import { type AgentReviewFile, useAgentChanges } from "../composables/agents/useAgentChanges";
import { useAgents } from "../composables/agents/useAgents";
import { useChat } from "../composables/chat/useChat";
import { diffRawUrls } from "../composables/workspace/diffRaw";
import { useWorkspaceTabs } from "../composables/workspace/useWorkspaceTabs";
import BinaryDiffView from "../pages/workspace/viewers/BinaryDiffView.vue";
import DiffView from "../pages/workspace/viewers/DiffView.vue";
import { rendersAsBytes } from "../pages/workspace/fileType";
import { STATUS_CLASS, STATUS_LETTER } from "../pages/workspace/workspaceTabs";

/* One agent's work, as a REVIEW: the file list on the left, that file's diff on the right, in this view — the
 * shape every code review has (GitHub, VSCode's SCM, `git add -p`), because the job is scanning a body of
 * changes fast enough to decide whether to land them.
 *
 * Three things this is built around, each replacing something the old panel got wrong:
 *   - THE DIFF IS HERE. Clicking a file used to push a workspace tab and NAVIGATE AWAY to /workspace, which
 *     abandoned the review to look at one file. The diff now renders next to the list (Monaco, the same engine
 *     the editor uses), so the next file is one keystroke away. Opening it in the workspace is still offered —
 *     as a deliberate secondary action, for when a file needs the full editor.
 *   - LANDED WORK IS STILL WORK. The list is the agent's CUMULATIVE output (see useAgentChanges), not the
 *     not-yet-landed remainder. A clean turn auto-lands within milliseconds, so a remainder-scoped list showed
 *     an empty panel for everything the agent had just written. Rows carry `landed`; the toolbar counts what is
 *     left, and the Segmented filters down to it.
 *   - A REVIEW HAS PROGRESS. Files can be ticked off as you look at them (viewed, GitHub-style), the toolbar
 *     shows the count, and `v` ticks the current file and advances — so a 30-file scan has a place to stop and
 *     resume rather than being a wall of paths.
 *
 * Keyboard, while focus isn't in a text field or inside Monaco: ↑/↓ or j/k move, v marks viewed and advances.
 * Land/discard stay gated on the turn: both are refused daemon-side while it streams (CONFLICT), so they are
 * disabled up front when this browser is the one streaming. */

const props = defineProps<{ agentId: string }>();
const router = useRouter();
const { mobile } = useDevice();
const { explorerStyle } = useExplorerStyle();
const changes = useAgentChanges(toRef(props, `agentId`));
const { openDiff } = useWorkspaceTabs();

const { conversations } = useChat();
const streaming = computed(() => conversations.value.find((c) => c.conversationId === props.agentId)?.streaming.value === true);

// Archiving reports itself by the card leaving the board — which this surface cannot show, since there is no
// board on it. So the button is the report: it becomes the way back the moment it succeeds, the same flip the
// fleet card makes. Without it, the one archive affordance in the app with no visible consequence would be
// the one on the page dedicated to a single agent.
const { agentById, restore, busyIds } = useAgents();
const archived = computed(() => agentById(props.agentId)?.archivedAt !== undefined);
// Both directions claim the same per-id counter in the fleet store, so one flag covers the round trip either way.
const archiveBusy = computed(() => busyIds.value.includes(props.agentId));

// --- the list ------------------------------------------------------------------------------------------
// "Not landed" narrows the list to the remainder Land now would apply. It only exists while that remainder is
// a PROPER subset — with nothing landed it filters nothing, and with everything landed it would empty the
// panel, which is the failure mode this whole view exists to undo.
const filter = ref<`all` | `pending`>(`all`);
const splittable = computed(() => changes.pending.value.length > 0 && changes.pending.value.length < changes.count.value);
watch(splittable, (canSplit) => {
    if (!canSplit) {
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

const filtered = computed<readonly AgentReviewFile[]>(() =>
    filter.value === `pending` ? changes.files.value.filter((file) => !file.change.landed) : changes.files.value,
);

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
    }));
});

// What the keyboard walks: the rows actually on screen, in render order. A collapsed repo contributes nothing —
// you cannot step onto a row you cannot see.
const visibleRows = computed<readonly AgentReviewFile[]>(() => groups.value.flatMap((group) => (collapsed.value.has(group.repo) ? [] : group.files)));

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
const layout = ref<`split` | `unified`>(`split`);
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
        : diffRawUrls({ source: `agent`, agent: props.agentId, repo: selected.value.repo }, selected.value.change.path, selected.value.change.status),
);

// The escape hatch to the full editor: the same diff as a workspace tab, where it gets the whole area, the
// tab bar, and the file tree next to it. Deliberately not what a row click does any more.
const openInWorkspace = (file: AgentReviewFile): void => {
    const body = diff.value;
    if (body === undefined) {
        return;
    }
    openDiff({
        key: `agent:${props.agentId}:${file.repo}`,
        scope: file.repo,
        label: file.label,
        status: file.change.status,
        path: file.change.path,
        ...body,
        ...diffRawUrls({ source: `agent`, agent: props.agentId, repo: file.repo }, file.change.path, file.change.status),
    });
    void router.push({ name: `workspace` });
};

// --- presentation --------------------------------------------------------------------------------------
const basename = (path: string): string => path.slice(path.lastIndexOf(`/`) + 1);
const parentDir = (path: string): string => (path.includes(`/`) ? path.slice(0, path.lastIndexOf(`/`)) : ``);

const filterOptions = computed<{ label: string; value: `all` | `pending` }[]>(() => [
    { label: `All ${changes.count.value}`, value: `all` },
    { label: `Not landed ${changes.pending.value.length}`, value: `pending` },
]);
const layoutOptions: { label: string; value: `split` | `unified` }[] = [
    { label: `Split`, value: `split` },
    { label: `Unified`, value: `unified` },
];

const ICON_BUTTON = `flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-overlay hover:text-content disabled:opacity-40`;
const NOTICE = `flex items-start gap-1.5 rounded-md border border-danger/40 bg-danger/10 px-2 py-1.5`;

/* THE CONFLICT REPORT — the panel's one job when a land is refused.
 *
 * What it replaced named every path in the delta and said "your workspace's copy of these paths differs",
 * which was wrong twice over: `git apply` is atomic, so a handful of real conflicts held back everything and
 * the report listed the lot; and the stated cause was the rarest of the three. A user reading it had no way
 * to tell four blocked files from fourteen, no idea which of their own edits was implicated, and — since the
 * only buttons were Archive, Discard and a Land that would fail identically forever — nothing to do about it.
 *
 * So: count what is actually blocked against what would land anyway, group the blockers by CAUSE, and end on
 * the one action that fits the causes present. */
const REASON_COPY = {
    diverged: {
        title: `your workspace moved on since the agent branched`,
        fix: `A three-way merge can reconcile these.`,
    },
    workspace: {
        title: `you have uncommitted edits to these`,
        fix: `Commit or stash your copy, then land again — git cannot merge through unstaged work.`,
    },
    binary: {
        title: `binary files, which have no automatic merge`,
        fix: `Land the rest, then copy these across by hand.`,
    },
} as const;

const conflictPaths = computed(() => (changes.conflicts.value ?? []).flatMap((conflict) => conflict.paths));
const blockedCount = computed(() => conflictPaths.value.length);
// What the atomic refusal is holding hostage — the number that tells the user how little is actually wrong.
const cleanCount = computed(() => (changes.conflicts.value ?? []).reduce((total, conflict) => total + conflict.clean, 0));
// Grouped by cause, because the three want three different things from the user.
const conflictGroups = computed(() =>
    (Object.keys(REASON_COPY) as (keyof typeof REASON_COPY)[]).flatMap((reason) => {
        const paths = conflictPaths.value.filter((conflict) => conflict.reason === reason).map((conflict) => conflict.path);
        return paths.length === 0 ? [] : [{ reason, paths, ...REASON_COPY[reason] }];
    }),
);
// A three-way apply goes through the index, so git refuses it outright on an unstaged path. Offering the
// button in that case would promise something the daemon has to decline.
const mergeable = computed(() => blockedCount.value > 0 && conflictPaths.value.every((conflict) => conflict.reason !== `workspace`));
const resolvingPaths = computed(() => (changes.resolving.value ?? []).flatMap((entry) => entry.paths));

// Destructive and unrecoverable (the branch and worktree go), so it asks in the same modal every other
// irreversible git action in this app uses — not the inline warning strip that used to shove the list down.
const pendingDiscard = ref(false);
const confirmDiscard = (): void => {
    pendingDiscard.value = false;
    void changes.discard();
};
</script>

<template>
    <div class="flex min-h-0 flex-1 flex-col">
        <!-- Toolbar: what this agent wrote, how much of it is still yours to land, how far the review got, and
             the two actions that end it. One row on desktop; it wraps rather than truncates on a phone. -->
        <div class="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-line px-2 py-1.5">
            <span class="whitespace-nowrap text-2xs text-muted">
                <span class="font-medium text-content">{{ changes.count.value }}</span> file{{ changes.count.value === 1 ? "" : "s" }}
            </span>
            <DiffStat :additions="changes.additions.value" :deletions="changes.deletions.value" />
            <span
                v-if="changes.pending.value.length > 0"
                class="whitespace-nowrap rounded-full bg-warning/15 px-1.5 py-px text-2xs font-medium text-warning"
                v-tooltip.bottom="'Not yet applied to your workspace — this is what Land now applies'"
            >
                {{ changes.pending.value.length }} not landed
            </span>
            <span
                v-else-if="changes.count.value > 0"
                class="inline-flex items-center gap-1 whitespace-nowrap text-2xs text-success"
                v-tooltip.bottom="'Every change is already in your workspace — review it here, commit it from the Changes panel'"
            >
                <Icon name="check" class="text-2xs" />landed
            </span>
            <Segmented v-if="splittable" v-model="filter" :options="filterOptions" size="xs" />
            <Icon v-if="changes.actionBusy.value" name="spinner" class="text-xs text-muted" spin />
            <span class="flex-1"></span>
            <span
                v-if="changes.count.value > 0"
                class="whitespace-nowrap text-2xs text-subtle"
                v-tooltip.bottom="'Files you have looked at. ↑/↓ or j/k move · v marks viewed and advances'"
            >
                {{ changes.viewedCount.value }}/{{ changes.count.value }} reviewed
            </span>
            <button
                type="button"
                :class="ICON_BUTTON"
                @click="changes.refresh()"
                v-tooltip.bottom="'Refresh'"
                aria-label="Refresh the agent's changes"
            >
                <Icon name="refresh" class="text-2xs" :spin="changes.loading.value" />
            </button>
            <!-- Two endings, and the copy is what keeps them apart: archive KEEPS everything and only takes the
                 agent off the board, discard is the one that throws work away. The safe one goes first and
                 asks nothing; the destructive one keeps its dialog. -->
            <button
                v-if="!archived"
                type="button"
                class="inline-flex items-center whitespace-nowrap rounded border border-line px-2 py-0.5 text-2xs text-muted transition-colors hover:bg-overlay hover:text-content disabled:opacity-40"
                :disabled="changes.actionBusy.value || archiveBusy || streaming"
                @click="changes.archive()"
                v-tooltip.bottom="
                    streaming ? 'Wait for the agent turn to finish' : 'Take this agent off the board. Its branch, diff and conversation are kept.'
                "
            >
                <Icon name="box" class="mr-1 text-2xs" />Archive
            </button>
            <button
                v-else
                type="button"
                class="inline-flex items-center whitespace-nowrap rounded border border-line px-2 py-0.5 text-2xs text-link transition-colors hover:bg-overlay disabled:opacity-40"
                :disabled="archiveBusy"
                @click="restore([agentId])"
                v-tooltip.bottom="'Archived. Put it back on the board.'"
            >
                <Icon name="history" class="mr-1 text-2xs" />Restore
            </button>
            <button
                type="button"
                class="inline-flex items-center whitespace-nowrap rounded border border-line px-2 py-0.5 text-2xs text-muted transition-colors hover:bg-overlay hover:text-content disabled:opacity-40"
                :disabled="changes.actionBusy.value || streaming"
                @click="pendingDiscard = true"
                v-tooltip.bottom="streaming ? 'Wait for the agent turn to finish' : 'Drop this agent\'s branch and worktree'"
            >
                <Icon name="trash" class="mr-1 text-2xs" />Discard
            </button>
            <button
                type="button"
                :class="cmp.buttonSuccess('gap-0 whitespace-nowrap px-2.5 py-1 text-2xs')"
                :disabled="changes.actionBusy.value || streaming || changes.pending.value.length === 0"
                @click="changes.land()"
                v-tooltip.bottom="
                    streaming
                        ? 'Wait for the agent turn to finish'
                        : changes.pending.value.length === 0
                          ? 'Nothing left to land — this work is already in your workspace'
                          : `Apply ${changes.pending.value.length} change(s) to your workspace`
                "
            >
                <Icon name="check" class="mr-1 text-2xs" />Land now
            </button>
        </div>

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

        <!-- The conflict report. Nothing was written: the worktree still holds every change, so this is a
             decision point rather than a failure — hence the count of what is being held back by how little,
             the cause of each blocker, and an action that fits the causes present. -->
        <div
            v-if="changes.conflicts.value !== undefined && changes.conflicts.value.length > 0"
            class="mx-2 mt-2 flex shrink-0 flex-col gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-2 py-1.5"
        >
            <span class="text-2xs font-medium text-warning">
                <template v-if="blockedCount === 0">Couldn't reach your workspace's copy of this repo</template>
                <template v-else>
                    {{ blockedCount }} file{{ blockedCount === 1 ? "" : "s" }} couldn't be applied<template v-if="cleanCount > 0">
                        — holding back {{ cleanCount }} that {{ cleanCount === 1 ? "would" : "would all" }} land cleanly</template
                    >
                </template>
            </span>
            <!-- Grouped by cause: which of the three is in play decides what the user does next. -->
            <div v-for="group in conflictGroups" :key="group.reason" class="flex flex-col">
                <span class="text-2xs text-content">{{ group.title }}</span>
                <span class="break-all font-mono text-2xs text-muted">{{ group.paths.join(", ") }}</span>
                <span class="text-2xs text-subtle">{{ group.fix }}</span>
            </div>
            <p v-if="blockedCount === 0" class="text-2xs text-muted">
                Nothing was applied and nothing was lost — the agent's work is still on its branch.
            </p>
            <div v-if="mergeable" class="mt-0.5 flex items-center gap-2">
                <button
                    type="button"
                    :class="cmp.buttonWarning('gap-0 whitespace-nowrap px-2.5 py-1 text-2xs')"
                    :disabled="changes.actionBusy.value || streaming"
                    @click="changes.land('merge')"
                    v-tooltip.bottom="'Applies everything that fits and leaves the rest with conflict markers to resolve in your workspace'"
                >
                    <Icon name="check" class="mr-1 text-2xs" />Land with conflict markers
                </button>
                <span class="text-2xs text-subtle">Writes to your workspace — "Land now" does not.</span>
            </div>
        </div>

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
        <div v-else class="flex min-h-0 flex-1">
            <aside
                v-if="!mobile || selected === undefined"
                class="scrollbar-thin flex min-h-0 min-w-0 flex-col overflow-auto"
                :class="mobile ? 'flex-1' : 'w-72 shrink-0 border-r border-line'"
            >
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
                        <span class="flex-1"></span>
                        <DiffStat :additions="group.additions" :deletions="group.deletions" />
                    </button>

                    <template v-if="!collapsed.has(group.repo)">
                        <div
                            v-for="file in group.files"
                            :key="file.key"
                            :ref="(el) => setRowEl(file.key, el)"
                            class="group/file flex items-center border-l-2 transition-colors"
                            :class="
                                file.key === selectedKey
                                    ? 'border-primary-500 bg-primary-600/10'
                                    : 'border-transparent hover:border-line-strong hover:bg-overlay'
                            "
                        >
                            <button
                                type="button"
                                class="flex min-w-0 flex-1 items-center gap-1.5 py-1 pl-1.5 pr-1 text-left max-md:min-h-11"
                                :class="isViewed(file) ? 'opacity-50' : ''"
                                :title="file.label"
                                @click="select(file)"
                            >
                                <span class="w-3 shrink-0 text-center font-mono text-2xs" :class="STATUS_CLASS[file.change.status]">
                                    {{ STATUS_LETTER[file.change.status] }}
                                </span>
                                <Icon
                                    :name="iconForEntry(basename(file.change.path), 'file', false)"
                                    class="shrink-0 text-2xs"
                                    :class="explorerColorClass(explorerStyle, basename(file.change.path), 'file', false)"
                                />
                                <!-- Basename first and legible, its directory trailing and dimmed: a review is
                                     read by file name, and the middle-truncated full paths this replaces made
                                     every row in a deep tree look the same. -->
                                <span class="min-w-0 flex-1 truncate text-2xs max-md:text-xs">
                                    <span class="font-medium text-content">{{ basename(file.change.path) }}</span>
                                    <span class="ml-1 text-subtle">{{ parentDir(file.change.path) }}</span>
                                </span>
                                <span
                                    v-if="!file.change.landed"
                                    class="h-1.5 w-1.5 shrink-0 rounded-full bg-warning"
                                    v-tooltip.top="'Not yet landed in your workspace'"
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
                                v-tooltip.left="isViewed(file) ? 'Reviewed — click to unmark' : 'Mark as reviewed'"
                                :aria-label="`Mark ${file.label} as reviewed`"
                            >
                                <Icon :name="isViewed(file) ? 'check-square' : 'check'" class="text-2xs" />
                            </button>
                        </div>
                    </template>
                </div>
            </aside>

            <section v-if="!mobile || selected !== undefined" class="flex min-h-0 min-w-0 flex-1 flex-col">
                <template v-if="selected !== undefined">
                    <div class="flex h-8 shrink-0 items-center gap-1.5 border-b border-line px-2">
                        <button v-if="mobile" type="button" :class="ICON_BUTTON" @click="selectedKey = undefined" aria-label="Back to the file list">
                            <Icon name="arrow-left" class="text-xs" />
                        </button>
                        <span class="w-3 shrink-0 text-center font-mono text-2xs" :class="STATUS_CLASS[selected.change.status]">
                            {{ STATUS_LETTER[selected.change.status] }}
                        </span>
                        <span class="min-w-0 flex-1 truncate text-2xs" :title="selected.label">
                            <span v-if="parentDir(selected.label) !== ''" class="text-subtle">{{ parentDir(selected.label) }}/</span>
                            <span class="font-medium text-content">{{ basename(selected.label) }}</span>
                        </span>
                        <span
                            v-if="selected.change.from !== undefined"
                            class="hidden max-w-40 truncate font-mono text-2xs text-subtle md:inline-block"
                            :title="`renamed from ${selected.change.from}`"
                        >
                            ← {{ selected.change.from }}
                        </span>
                        <span
                            v-if="!selected.change.landed"
                            class="shrink-0 rounded-full bg-warning/15 px-1.5 py-px text-2xs font-medium text-warning"
                            v-tooltip.bottom="'Still waiting for Land now'"
                        >
                            not landed
                        </span>
                        <DiffStat :additions="selected.change.additions" :deletions="selected.change.deletions" />
                        <Segmented v-if="!mobile" v-model="layout" :options="layoutOptions" size="xs" />
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
                    </div>

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
                            :side-by-side="mobile ? false : layout === 'split'"
                        />
                        <p v-else-if="diff.truncated" class="p-4 text-xs text-subtle">File too large to diff in the browser.</p>
                        <DiffView
                            v-else
                            :key="diffKey"
                            :before="diff.before"
                            :after="diff.after"
                            :path="selected.change.path"
                            :side-by-side="mobile ? undefined : layout === 'split'"
                        />
                    </div>
                </template>
                <p v-else class="p-4 text-2xs text-subtle">Pick a file to see what the agent did to it.</p>
            </section>
        </div>

        <Dialog
            :visible="pendingDiscard"
            :modal="true"
            :draggable="false"
            :dismissable-mask="true"
            :style="{ width: '24rem' }"
            header="Discard this agent's work"
            @update:visible="pendingDiscard = false"
        >
            <p class="text-xs text-content">
                Delete the agent's branch and worktree? Its {{ changes.count.value }} changed file{{ changes.count.value === 1 ? "" : "s" }} and the
                conversation's isolated history go with them.
            </p>
            <p v-if="changes.count.value > changes.pending.value.length" class="mt-2 text-xs text-muted">
                Work that already landed stays in your workspace — only what is still on the branch is lost.
            </p>
            <template #footer>
                <button type="button" class="rounded px-3 py-1 text-xs text-muted hover:text-content" @click="pendingDiscard = false">Cancel</button>
                <button type="button" :class="cmp.buttonDanger('rounded px-3 py-1')" :disabled="changes.actionBusy.value" @click="confirmDiscard">
                    Discard
                </button>
            </template>
        </Dialog>
    </div>
</template>
