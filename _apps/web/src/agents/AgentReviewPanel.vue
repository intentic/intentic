<script setup lang="ts">
import type { FileDiffResponse } from "@intentic-app/api-contract";
import { cmp, explorerColorClass, iconForEntry, Segmented, useDevice, useExplorerStyle } from "@intentic-app/ui";
import { isTestPath } from "@intentic/sandbox-contract";
import Dialog from "primevue/dialog";
import { computed, onBeforeUnmount, onMounted, ref, toRef, watch } from "vue";
import { useRouter } from "vue-router";
import DiffStat from "../components/DiffStat.vue";
import { stopAgent } from "../composables/agents/agentActions";
import { effectiveAutoLand } from "../composables/agents/agentStatus";
import { type AgentReviewFile, useAgentChanges } from "../composables/agents/useAgentChanges";
import { useAgents } from "../composables/agents/useAgents";
import { useChat } from "../composables/chat/useChat";
import { useSandboxSettings } from "../composables/sandbox/useSandboxSettings";
import { useLayout } from "../composables/useLayout";
import { diffRawUrls } from "../composables/workspace/diffRaw";
import { useWorkspaceTabs } from "../composables/workspace/useWorkspaceTabs";
import BinaryDiffView from "../pages/workspace/viewers/BinaryDiffView.vue";
import DiffView from "../pages/workspace/viewers/DiffView.vue";
import { rendersAsBytes } from "../pages/workspace/fileType";
import { STATUS_CLASS, STATUS_LETTER } from "../pages/workspace/workspaceTabs";
import AgentConflictReport from "./AgentConflictReport.vue";

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
// "Watch it work" — the conflict block's link to the turn it just started. On desktop the conversation is
// already on screen in the docked chat, so this is a mobile affair: only there is the chat a mode this view
// has to be switched INTO, and only the parent owns that switch.
const emit = defineEmits<{ chat: [] }>();
const router = useRouter();
const { mobile } = useDevice();
const { explorerStyle } = useExplorerStyle();
const shell = useLayout();
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

/* THE HOLD TOGGLE — this agent's land-at-completion posture, surfaced beside the Land button because this
 * panel is where the user is when they think "I'd rather have reviewed that first". It reads the EFFECTIVE
 * value (the agent's override, else the sandbox-wide setting — Sandbox ▸ Agent owns the default), and a click
 * flips it FOR THIS AGENT only. Flipping back to what the sandbox already says clears the override entirely
 * (null), so agents don't accumulate frozen overrides that quietly stop following the global toggle.
 * Deliberately legal mid-turn: the daemon reads the value at turn COMPLETION, so pressing hold while the
 * agent works is exactly "keep THIS turn's work on the branch" — the press that matters most. */
const { settings: sandboxSettings } = useSandboxSettings();
const autoLandOn = computed(() => effectiveAutoLand(agentById(props.agentId), sandboxSettings.value?.autoLand));
const toggleAutoLand = (): void => {
    const next = !autoLandOn.value;
    void changes.setAutoLand(next === (sandboxSettings.value?.autoLand ?? true) ? null : next);
};

// --- the list ------------------------------------------------------------------------------------------
// "Not landed" narrows the list to the remainder Land now would apply. It only exists while that remainder is
// a PROPER subset — with nothing landed it filters nothing, and with everything landed it would empty the
// panel, which is the failure mode this whole view exists to undo.
const filter = ref<`all` | `code` | `tests` | `pending`>(`all`);
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

const filtered = computed<readonly AgentReviewFile[]>(() => {
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

const filterOptions = computed<{ label: string; value: `all` | `code` | `tests` | `pending` }[]>(() => [
    { label: `All ${changes.count.value}`, value: `all` },
    ...(changes.testStat.value.files > 0 && changes.codeStat.value.files > 0
        ? [
              { label: `Code ${changes.codeStat.value.files}`, value: `code` as const },
              { label: `Tests ${changes.testStat.value.files}`, value: `tests` as const },
          ]
        : []),
    { label: `Not landed ${changes.pending.value.length}`, value: `pending` },
]);
const layoutOptions: { label: string; value: `split` | `unified` }[] = [
    { label: `Split`, value: `split` },
    { label: `Unified`, value: `unified` },
];

const ICON_BUTTON = `flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-overlay hover:text-content disabled:opacity-40`;
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
            <template v-if="changes.testStat.value.files > 0 && changes.codeStat.value.files > 0">
                <span class="inline-flex items-center gap-1 whitespace-nowrap" v-tooltip.bottom="'The product change, tests excluded'">
                    <DiffStat :additions="changes.codeStat.value.additions" :deletions="changes.codeStat.value.deletions" />
                    <span class="text-2xs text-muted">code</span>
                </span>
                <span class="inline-flex items-center gap-1 whitespace-nowrap" v-tooltip.bottom="'Test files (*.test.*, fixtures, runner configs)'">
                    <DiffStat :additions="changes.testStat.value.additions" :deletions="changes.testStat.value.deletions" />
                    <span class="text-2xs text-muted">tests</span>
                </span>
            </template>
            <DiffStat v-else :additions="changes.additions.value" :deletions="changes.deletions.value" />
            <span
                v-if="changes.pending.value.length > 0"
                class="whitespace-nowrap rounded-full bg-warning/15 px-1.5 py-px text-2xs font-medium text-warning"
                v-tooltip.bottom="'What Land now will apply'"
            >
                {{ changes.pending.value.length }} not landed
            </span>
            <span
                v-else-if="changes.count.value > 0"
                class="inline-flex items-center gap-1 whitespace-nowrap text-2xs text-success"
                v-tooltip.bottom="'Already in your workspace — commit it from the Changes panel'"
            >
                <Icon name="check" class="text-2xs" />landed
            </span>
            <Segmented v-if="splittable" v-model="filter" :options="filterOptions" size="xs" />
            <Icon v-if="changes.actionBusy.value" name="spinner" class="text-xs text-muted" spin />
            <span class="flex-1"></span>
            <span
                v-if="changes.count.value > 0"
                class="whitespace-nowrap text-2xs text-subtle"
                v-tooltip.bottom="'↑/↓ or j/k to move · v marks viewed and advances'"
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
                    streaming ? 'Wait for the agent turn to finish' : 'The branch, diff and conversation are kept'
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
                v-tooltip.bottom="'Puts it back on the board'"
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
            <!-- The hold toggle rides beside the button it modifies: locked = finished work waits on the
                 branch for the Land button, unlocked = it lands by itself at turn completion. Per-agent —
                 the sandbox-wide default lives in Sandbox ▸ Agent (see toggleAutoLand). -->
            <button
                type="button"
                :class="[ICON_BUTTON, autoLandOn ? '' : 'text-link']"
                :disabled="changes.actionBusy.value || archived"
                @click="toggleAutoLand"
                v-tooltip.bottom="
                    autoLandOn
                        ? 'Finished turns land into your workspace by themselves. Click to keep this agent\'s future work on its branch until you press Land now.'
                        : 'Holding: finished work waits on this agent\'s branch for Land now. Click to land automatically at turn completion again.'
                "
                :aria-label="autoLandOn ? 'Hold this agent\'s finished work on its branch' : 'Land this agent\'s finished work automatically'"
            >
                <Icon :name="autoLandOn ? 'unlock' : 'lock'" class="text-2xs" />
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
                          ? 'Already in your workspace'
                          : `Applies ${changes.pending.value.length} change(s) to your workspace`
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
                class="scrollbar-thin flex min-h-0 min-w-0 flex-col overflow-auto"
                :class="mobile ? 'flex-1' : 'shrink-0 border-r border-line'"
                :style="mobile ? undefined : { width: `${shell.reviewListWidth.value}px` }"
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
                                <span class="min-w-0 flex-1 truncate text-2xs max-md:text-xs" v-tooltip.right.overflow="file.label">
                                    <span class="font-medium text-content">{{ basename(file.change.path) }}</span>
                                    <span class="ml-1 text-subtle">{{ parentDir(file.change.path) }}</span>
                                </span>
                                <span
                                    v-if="!file.change.landed"
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
                    <div class="flex h-8 shrink-0 items-center gap-1.5 border-b border-line px-2">
                        <button v-if="mobile" type="button" :class="ICON_BUTTON" @click="selectedKey = undefined" aria-label="Back to the file list">
                            <Icon name="arrow-left" class="text-xs" />
                        </button>
                        <span class="w-3 shrink-0 text-center font-mono text-2xs" :class="STATUS_CLASS[selected.change.status]">
                            {{ STATUS_LETTER[selected.change.status] }}
                        </span>
                        <span class="min-w-0 flex-1 truncate text-2xs" v-tooltip.bottom.overflow="selected.label">
                            <span v-if="parentDir(selected.label) !== ''" class="text-subtle">{{ parentDir(selected.label) }}/</span>
                            <span class="font-medium text-content">{{ basename(selected.label) }}</span>
                        </span>
                        <span
                            v-if="selected.change.from !== undefined"
                            class="hidden max-w-40 truncate font-mono text-2xs text-subtle md:inline-block"
                            v-tooltip.bottom="`renamed from ${selected.change.from}`"
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
