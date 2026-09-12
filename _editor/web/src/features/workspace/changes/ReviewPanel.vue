<script setup lang="ts">
import type { GitChange, GitDiffSide, LandedMessage, LandedMessageDraft, RepoChanges, RepoTarget } from "@intentic/api-contract";
import { Button, ChangeStatusMark, growTextarea, ui, Modal, timeAgo, useDevice, type IconName, vAction } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { computed, ref, watch } from "vue";
import ProviderLogo from "../../chat/accounts/ProviderLogo.vue";
import HoverCard from "../../../components/HoverCard.vue";
import ReviewStat from "../../../components/ReviewStat.vue";
import { rendersAsBytes } from "../explorer/fileType";
import { useAgents } from "../../agents/fleet/useAgents";
import { useChat } from "../../chat/run/useChat";
import { useLayout } from "../../../shell/window/useLayout";
import { boxIsYours, commitMessage, followFilledMessage, nameCommitAfter, namedAfter } from "./commitMessage";
import {
    ALL_SIDES,
    chipMessageNotice,
    commitMessageOf,
    draftReport,
    draftRunning,
    type DraftReportRow,
    landedMessage,
    originHue,
    originsOf,
    summarizeOrigins,
    YOURS,
} from "./changeOrigins";
import { formatElapsed, unfinishedMark } from "../../agents/fleet/agentStatus";
import { diffRawUrls } from "./diffRaw";
import { repoOfPath, turnWrites } from "../files/liveWrites";
import { ahead, behind, syncable, unpublished } from "../push/outgoingWork";
import { COMMIT_SCOPE, useChanges } from "./useChanges";
import { usePushFlow } from "../push/usePushFlow";
import { useRepos } from "../explorer/useRepos";
import type { DiffPayload } from "@intentic/extension-api";
import { EMPTY_MODULE_VIEW, moduleView, type ModuleGroup, type ModuleView } from "./changeModules";
import { sideTotal, truncatedOn, truncatedTotal } from "./truncation";
import type { OpenMode } from "../tabs/workspaceTabs";
import { useChangeGrouping } from "./useChangeGrouping";
import { addedIn, sumCode, sumShown, useChangeWeight, type ShownStat } from "./changeWeight";
import { useModules } from "../health/useModules";
import ChangeRowName from "../../../components/ChangeRowName.vue";
import OtherSandboxChanges from "./OtherSandboxChanges.vue";
import ModuleLabel from "../../../components/ModuleLabel.vue";

// VSCode's SCM pattern over the real repos: uncommitted work grouped by repo, then by git's staged/unstaged
// sides (a path can be on both with different content). Staging IS the selection — no checkboxes; git already
// has one selection mechanism (the index), so Commit records it. Built for a ~270px sidebar: one primary button per
// row, icons+tooltips for the rest.

const changes = useChanges();
// The push, started here but owned above this panel, so leaving the view doesn't lose the run or its question.
const pushFlow = usePushFlow();
// Ticks while a push is in flight, and while a verdict stands unanswered below — that line counts up too, and a
// frozen "4m ago" over a failure from an hour back is worse than no clock at all.
const now = useNow(() => pushFlow.running.value || pushFlow.held.value !== undefined);

// A repo the daemon couldn't scan (empty lists, `error` set) stays out of every computation below but still
// renders as its own row, rather than silently disappearing.
const scannable = computed(() => changes.repos.value.filter((repo) => repo.error === undefined));
const unscannable = computed(() => changes.repos.value.filter((repo) => repo.error !== undefined));
// The open mode rides the gesture: a click previews (replaced by the next look), a double-click keeps the tab.
const emit = defineEmits<{ "open-diff": [payload: DiffPayload, mode: OpenMode]; "fill-diff": [payload: DiffPayload] }>();

const collapsed = ref<ReadonlySet<string>>(new Set());
const toggleGroup = (repo: string): void => {
    const next = new Set(collapsed.value);
    if (!next.delete(repo)) {
        next.add(repo);
    }
    collapsed.value = next;
};

const changeLabel = (repo: string, change: GitChange): string => (repo === `root` ? change.path : `${repo}/${change.path}`);
const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? `` : `s`}`;

// Per row: a colour rail plus a provider chip, since "did an agent touch this" is scanned before it's read.
// Per panel: a legend that IS the filter, not a grouping — a file two agents landed can't be grouped under one.
const { fleet } = useAgents();
// Read here for an origin chip's hover-card prompt, and below for which repos a main-tree turn is writing.
const { conversations } = useChat();
const { mobile } = useDevice();
const layout = useLayout();

// A phone keyboard has no Ctrl, so the shortcut hint moves to the button label instead.
const commitPlaceholder = computed(() => (mobile.value ? `Message` : `Message (Ctrl+Enter to commit)`));

const legend = computed(() => summarizeOrigins(scannable.value));
// Seeded from the standing ask (namedAfter), so reopening the panel restores the filter; "you" never travels,
// since it names no ask.
const originFilter = ref<string | undefined>(namedAfter.value);
// Retires the filter (and its ask) once the named session has no work left in the tree; immediate, since a
// restored filter has to be checked the moment this panel opens. An empty (still-loading) review retires nothing.
watch(
    legend,
    ({ agents, yours }) => {
        if (originFilter.value === undefined || (agents.length === 0 && yours === 0)) {
            return;
        }
        const stillHasWork = originFilter.value === YOURS ? yours > 0 : agents.some((entry) => entry.id === originFilter.value);
        if (!stillHasWork) {
            originFilter.value = undefined;
            nameCommitAfter(undefined);
        }
    },
    { immediate: true },
);

// Resolves an id via the live fleet card first (repaints on a rename instantly), then the review's own
// `originAgents`, which survives archiving. An id-shaped fallback still draws a chip rather than reattributing the file
// to the user.
const agentOf = (id: string) => fleet.value.find((agent) => agent.id === id);
const originOf = (id: string) => changes.originAgents.value[id];
// Undefined for the id-shaped fallback — readable, but not fit to use as a commit subject.
const originTitle = (id: string): string | undefined => agentOf(id)?.title ?? originOf(id)?.title;
const originLabel = (id: string): string => originTitle(id) ?? `Agent ${id.slice(0, 6)}`;
const originProvider = (id: string): string | undefined => agentOf(id)?.provider ?? originOf(id)?.provider;

// Whether a chip's count is a total (session stopped) or an instalment (still running), read from the fleet's
// own lane machine, not `status` alone: a parked-on-a-question agent has a settled status but sits in Attention.
const originMark = (id: string) => unfinishedMark(agentOf(id));

// `turns` counts completed turns, so a session already running again is on turn N+1.
// Stamped when the card opens, not ticked — HoverCard snapshots its content at show(), so a held-open card reads stale
// on purpose.
const originNote = (id: string): string | undefined => {
    const mark = originMark(id);
    const agent = agentOf(id);
    if (mark === undefined || agent === undefined) {
        return undefined;
    }
    const turn = agent.turns !== undefined && agent.turns > 0 ? `turn ${agent.turns + 1}` : undefined;
    const doing = agent.activity?.tool !== undefined ? [agent.activity.tool, agent.activity.target].filter(Boolean).join(` `) : agent.activity?.todo;
    const since = agent.startedAt !== undefined ? formatElapsed(agent.startedAt, Date.now()) : undefined;
    return [mark.label, turn, doing, since].filter((part) => part !== undefined && part !== ``).join(` · `);
};

// The session's landed-diff subject (drafted at land time), not its title — a title names the ask, the diff says
// what actually changed. Roster first (live, pushed instantly), then the review, same lookup order as identity above.
const landedOf = (id: string): LandedMessage | undefined => landedMessage(agentOf(id), originOf(id));
const originMessage = (id: string): string | undefined => commitMessageOf(landedOf(id));

// One click narrows the list to that session's files and also names the commit after it — two things a user
// did by hand before. Naming is recorded outside this component (nameCommitAfter), so it's answered even after the
// panel closes.
const toggleOrigin = (id: string): void => {
    originFilter.value = originFilter.value === id ? undefined : id;
    nameCommitAfter(originFilter.value === YOURS ? undefined : originFilter.value);
};

// Computed, not read at the click: recomputes as the review updates, so a message drafted seconds after
// the click still reaches the box without a second click.
const filterMessage = computed<string | undefined>(() =>
    originFilter.value === undefined || originFilter.value === YOURS ? undefined : originMessage(originFilter.value),
);
followFilledMessage(filterMessage);

// Read off the fleet roster's live draft report, not the review (which would cost a rescan). Distinguishes
// "nothing was written" from "one is coming", which used to be the same empty box.
const originDraft = (id: string): LandedMessageDraft | undefined => agentOf(id)?.landedMessageDraft;
const originDrafting = (id: string): boolean => draftRunning(originDraft(id));
// The lit chip's own report, for the box's readout and the step list under it.
const filterDraft = computed<LandedMessageDraft | undefined>(() =>
    originFilter.value === undefined || originFilter.value === YOURS ? undefined : originDraft(originFilter.value),
);
// Ticks only while the lit chip's draft is running, so its in-flight step's elapsed time actually moves.
const draftClock = useNow(() => draftRunning(filterDraft.value));
// The step list while a draft runs, and the post-mortem after it fails; a draft that succeeded clears from
// here, since its message in the box is report enough.
const filterDraftRows = computed<readonly DraftReportRow[]>(() => {
    const draft = filterDraft.value;
    return draft === undefined || draft.outcome === `written` ? [] : draftReport(draft, draftClock.value);
});

// One glyph and colour per row status, isolated to a narrow column so the reason text stays untinted.
// A refusal mid-chain isn't an error (the fallback is working); only a draft that ends with nothing is amber.
const STEP_MARKS: Record<DraftReportRow[`status`], { icon: IconName; spin?: boolean; tone: string }> = {
    reading: { icon: `spinner`, spin: true, tone: `text-subtle` },
    asking: { icon: `spinner`, spin: true, tone: `text-link` },
    answered: { icon: `check`, tone: `text-success` },
    refused: { icon: `times`, tone: `text-subtle` },
    skipped: { icon: `forward`, tone: `text-subtle` },
    failed: { icon: `exclamation-triangle`, tone: `text-warning` },
};

// Both edges of the wait (it started, what became of it) are reported above this panel and outlive it
// (draftingReceipts.ts) — the wait begins on the /agents board and often outlasts a visit here.

// Raises the same card the chat tab strip does for a session, on hovering a chip (a row's, or the legend's).
const hoverCard = ref<InstanceType<typeof HoverCard> | null>(null);
// Includes attachments: a screenshot is often the whole of what was asked, and dropping it would misquote the prompt.
const firstPromptOf = (id: string): { text?: string; attachments?: readonly string[] } | undefined => {
    const conversation = conversations.value.find((c) => c.conversationId === id);
    const prompt = conversation?.messages.value.find((message) => message.role === `user`);
    return prompt === undefined ? undefined : { text: prompt.text, attachments: prompt.attachments };
};
const showOrigins = (event: MouseEvent, ids: readonly string[]): void => {
    // Two agents on one file is real but rare, and a single title can't say both, so the card lists them without a
    // prompt.
    const prompt = ids.length === 1 ? firstPromptOf(ids[0]!) : undefined;
    hoverCard.value?.show(
        event,
        ids.length === 1
            ? { label: `Landed by`, title: originLabel(ids[0]!), note: originNote(ids[0]!), ...(prompt === undefined ? {} : { messages: [prompt] }) }
            : { label: `Landed by`, title: ids.map((id) => originLabel(id)).join(`\n`) },
    );
};
// The name rides the row only once the panel is wide enough to hold it without evicting the path (or on mobile).
const wide = computed(() => mobile.value || layout.sidebarWidth.value >= 320);

// The lit chip in words, for every sentence naming the filter's scope; undefined means no filter, not "nobody".
const filterLabel = computed<string | undefined>(() =>
    originFilter.value === undefined ? undefined : originFilter.value === YOURS ? `you` : originLabel(originFilter.value),
);

// States why the box didn't change after a click: still writing, none written, "you" has none, or the box
// is the user's own text. Placeholder while empty; a readout line once there's text to sit beside instead.
const chipNotice = computed<string | undefined>(() =>
    chipMessageNotice({
        label: filterLabel.value,
        yours: originFilter.value === YOURS,
        message: filterMessage.value,
        draft: filterDraft.value,
        boxIsYours: boxIsYours.value,
    }),
);

const matchesFilter = (repo: RepoChanges, change: GitChange): boolean => {
    if (originFilter.value === undefined) {
        return true;
    }
    const ids = originsOf(repo, change.path);
    return originFilter.value === YOURS ? ids.length === 0 : ids.includes(originFilter.value);
};

// Quiet when the row's only origin is the lit chip (already said by the filter); a file two agents landed
// still shows both, since that's information the filter alone doesn't give.
const showRowOrigins = (repo: RepoChanges, path: string): boolean => {
    const ids = originsOf(repo, path);
    if (ids.length === 0) {
        return false;
    }
    return !(ids.length === 1 && ids[0] === originFilter.value);
};

// Indent guide and origin rail share one column, stretched to the row's full height so a run of one agent's
// files reads as one block. `bg-content/15`, not `border-line`, which measured near-invisible on this panel's
// background.
const railClass = (repo: RepoChanges, path: string): string => {
    const first = originsOf(repo, path)[0];
    return first === undefined ? `bg-content/15` : originHue(first).rail;
};

// Sides in git's order (conflicts block everything, then staged, then unstaged); an empty section renders
// nothing. The origin filter is applied here once, so every row, verb and count downstream inherits it for free.
interface SideView {
    readonly side: GitDiffSide;
    readonly label: string;
    readonly changes: readonly GitChange[];
}
const sidesByRepo = computed<ReadonlyMap<string, readonly SideView[]>>(
    () =>
        new Map(
            scannable.value.map((repo) => [
                repo.repo,
                [
                    { side: `conflicted` as const, label: `Conflicts`, changes: repo.conflicted },
                    { side: `staged` as const, label: `Staged`, changes: repo.staged },
                    { side: `unstaged` as const, label: `Unstaged`, changes: repo.unstaged },
                ].flatMap((section) => {
                    const shown = section.changes.filter((change) => matchesFilter(repo, change));
                    return shown.length === 0 ? [] : [{ side: section.side, label: section.label, changes: shown }];
                }),
            ]),
        ),
);
const sidesOf = (repo: RepoChanges): readonly SideView[] => sidesByRepo.value.get(repo.repo) ?? [];

// A side's own heading (and count) only earns its row once there's more than one side to tell apart; with
// one side, the repo row itself states it, instead of restating the same fact one indent down.
const sidesSplit = (repo: RepoChanges): boolean => sidesOf(repo).length > 1;
const soleSide = (repo: RepoChanges): SideView | undefined => {
    const sides = sidesOf(repo);
    return sides.length === 1 ? sides[0] : undefined;
};

// Only repos with changes get a row; a clean repo says nothing here (the empty state says it once, for the
// tree). Read through `sidesOf`, so the origin filter also drops repos that agent never touched.
const dirty = computed(() => scannable.value.filter((repo) => sidesOf(repo).length > 0));

// Whether a side's rows group under their package (useChangeGrouping, mirrored in Settings ▸ Appearance) —
// a monorepo path's truncated-away half becomes the header instead. Changes only how the list reads, not what it does.
const { groupByModule } = useChangeGrouping();
const { modulesOf } = useModules();

// Built once per review, not per call — a per-row pass would be quadratic on up to 500 rows a repo. Shares
// changeModules' `moduleView` with the agent review, so the two lists can't disagree about the same change set.
type SectionView = ModuleView<ModuleGroup<GitChange>>;
const sectionViews = computed<ReadonlyMap<string, SectionView>>(() => {
    const views = new Map<string, SectionView>();
    for (const repo of scannable.value) {
        for (const section of sidesOf(repo)) {
            const view = moduleView(section.changes, (change) => change.path, modulesOf(repo.repo), repo.repo, groupByModule.value);
            // Sorts by size within and across packages when asked (changeWeight.ts); sides and repos keep their own
            // order, since one is a sequence of meanings and the other is a row with its own controls.
            const buckets = bySize(
                view.buckets.map((bucket) => ({ ...bucket, rows: bySize(bucket.rows, readingOfRow) })),
                (bucket) => sumShown(bucket.rows.map(readingOfRow)),
            );
            views.set(JSON.stringify([repo.repo, section.side]), { buckets, named: view.named });
        }
    }
    return views;
});
const viewOf = (repo: string, side: GitDiffSide): SectionView => sectionViews.value.get(JSON.stringify([repo, side])) ?? EMPTY_MODULE_VIEW;

// A 270px sidebar has no room for labelled secondary buttons; only the primary action spends width on a word.
const ICON_BUTTON = ui.iconButton(`disabled:opacity-40`);

// Opens the row's own diff (side included in the key, so a partially staged file gets two tabs, not one
// replacing the other). Opens on the click, not the fetched answer: the row already has everything the tab needs to
// render.
const openDiff = (repo: string, side: GitDiffSide, change: GitChange, mode: OpenMode): void => {
    const tab = {
        key: `working:${repo}:${side}`,
        scope: repo,
        label: side === `staged` ? `${changeLabel(repo, change)} (staged)` : changeLabel(repo, change),
        status: change.status,
        path: change.path,
        additions: change.additions,
        deletions: change.deletions,
        ...diffRawUrls({ source: `working`, repo, side }, change.path, change.status),
    };
    emit(`open-diff`, { ...tab, pending: true }, mode);
    void changes.fileDiff(repo, change.path, side).then((body) => emit(`fill-diff`, { ...tab, ...body }));
};

// Prefetching is the app's own background loader now, not this panel's mount — it used to only start warming
// rows once this view opened. Every ±count here is the code-only reading the daemon computes with the list, final the
// moment it's drawn.

// Scale for the size rail: the biggest addition among rows actually shown, narrowed by the origin filter.
// A folded repo still counts — folding hides rows, it doesn't rescale everyone else's rail.
const { readingOf, bySize } = useChangeWeight();
const readingOfRow = (change: GitChange): ShownStat => readingOf(change.code, change.additions, change.deletions);
const heaviest = computed(() => {
    let most = 0;
    for (const repo of scannable.value) {
        for (const section of sidesOf(repo)) {
            for (const change of section.changes) {
                most = Math.max(most, addedIn(readingOfRow(change)));
            }
        }
    }
    return most;
});

// List selection only, never a commit target — the index alone decides what Commit records. Keyed by
// repo+side+path as JSON, since a delimited string risks collision with an arbitrary repo or file name.
interface Row {
    readonly repo: string;
    readonly side: GitDiffSide;
    readonly path: string;
}
const rowKey = (row: Row): string => JSON.stringify([row.repo, row.side, row.path]);

// Flattens the module buckets into a plain row list, since a range selection drags across headings as if they weren't
// there.
const rowsOn = (repo: string, side: GitDiffSide): readonly Row[] =>
    viewOf(repo, side).buckets.flatMap((bucket) => bucket.rows.map((change) => ({ repo, side, path: change.path })));

// Every row in render order (a collapsed repo contributes none), so shift-click ranges like a flat list.
// Read through `viewOf`, since module grouping reorders a side — ranging against git's own order would select the wrong
// rows.
const visibleRows = computed<readonly Row[]>(() =>
    dirty.value.flatMap((repo) => (collapsed.value.has(repo.repo) ? [] : sidesOf(repo).flatMap((section) => rowsOn(repo.repo, section.side)))),
);

const selected = ref<ReadonlySet<string>>(new Set());
// Where a shift-range measures from: the last row the user deliberately touched.
const anchor = ref<string | undefined>(undefined);
const isSelected = (row: Row): boolean => selected.value.has(rowKey(row));

const clickRow = (row: Row, change: GitChange, event: MouseEvent): void => {
    const key = rowKey(row);
    const keys = visibleRows.value.map(rowKey);
    if (event.shiftKey && anchor.value !== undefined) {
        const from = keys.indexOf(anchor.value);
        const to = keys.indexOf(key);
        if (from !== -1 && to !== -1) {
            selected.value = new Set(keys.slice(Math.min(from, to), Math.max(from, to) + 1));
            return;
        }
    }
    if (event.ctrlKey || event.metaKey) {
        const next = new Set(selected.value);
        if (!next.delete(key)) {
            next.add(key);
        }
        selected.value = next;
        anchor.value = key;
        return;
    }
    // A plain click looks at one row: collapses the selection and opens a preview tab, like any file list.
    // Double-click keeps the tab (below).
    selected.value = new Set([key]);
    anchor.value = key;
    openDiff(row.repo, row.side, change, `preview`);
};

// Drops selected keys whose row no longer exists (committed, staged across, discarded, vanished).
watch(visibleRows, (rows) => {
    const live = new Set(rows.map(rowKey));
    const pruned = new Set([...selected.value].filter((key) => live.has(key)));
    if (pruned.size !== selected.value.size) {
        selected.value = pruned;
    }
});

// A row action fires on the whole selection when the clicked row is part of one, otherwise just that row.
// `sameSideOnly` narrows it for index verbs (staging an already-staged row is meaningless); discard takes both sides.
const actingRows = (row: Row, sameSideOnly: boolean): readonly Row[] => {
    const key = rowKey(row);
    const rows =
        selected.value.has(key) && selected.value.size > 1 ? visibleRows.value.filter((candidate) => selected.value.has(rowKey(candidate))) : [row];
    return sameSideOnly ? rows.filter((candidate) => candidate.side === row.side) : rows;
};

// Grouped per repo (git can't span repos); paths dedupe, since a path selected on both sides is one worktree
// path. The one verb shape that still enumerates rows — a selection is only ever as long as what was clicked.
const byRepo = (rows: readonly Row[]): RepoTarget[] => {
    const grouped = new Map<string, Set<string>>();
    for (const row of rows) {
        const paths = grouped.get(row.repo);
        if (paths === undefined) {
            grouped.set(row.repo, new Set([row.path]));
        } else {
            paths.add(row.path);
        }
    }
    return [...grouped].map(([repo, paths]) => ({ repo, paths: [...paths] }));
};

// The message lives outside component state (commitMessage.ts), since this panel is mounted behind a v-if
// and must survive a trip to look at the files it describes. Staged repos are the commit target — a commit records the
// index.
const stagedRepos = computed(() => scannable.value.filter((repo) => repo.staged.length > 0).map((repo) => repo.repo));

// Fires only when nothing is staged anywhere but there's work to record (VSCode's stage-all-and-commit, made
// explicit). What it stages follows the origin filter — the whole repo unfiltered, or just that session's scope — as a
// daemon-resolved scope, not the rows drawn.
const stagesFirst = computed(() => stagedRepos.value.length === 0 && changes.count.value > 0);
const commitAll = computed(() => stagesFirst.value && originFilter.value === undefined);
// A scope, not an enumerated list: the daemon resolves which files answer to a side/origin from the repo's own
// status, so this isn't capped by what the review actually listed (RepoChanges.truncated).
const scoped = (repo: string, side?: GitDiffSide): RepoTarget => ({
    repo,
    scope: { ...(side !== undefined ? { side } : {}), ...(originFilter.value !== undefined ? { origin: originFilter.value } : {}) },
});
// Which repos: read off the visible (filtered) rows. What each commits: that session's whole landed scope in
// the repo, truncated rows included, not just what's drawn.
const filteredGroups = computed<readonly RepoTarget[]>(() =>
    scannable.value
        .filter((repo) => sidesOf(repo).some((section) => section.changes.length > 0))
        .map((repo) => scoped(repo.repo)),
);
// The one shape both `commitRepos` and the AI draft take: an empty target for a whole-repo commit ("Commit
// all" and plain Commit), a scope for the filtered one.
const commitGroups = computed<readonly RepoTarget[]>(() => {
    if (!stagesFirst.value) {
        return stagedRepos.value.map((repo) => ({ repo }));
    }
    return commitAll.value ? scannable.value.map((repo) => ({ repo: repo.repo })) : filteredGroups.value;
});
const commitTarget = computed(() => commitGroups.value.map((group) => group.repo));
const repoIn = (id: string): RepoChanges | undefined => scannable.value.find((repo) => repo.repo === id);
const truncatedIn = (id: string): number => {
    const repo = repoIn(id);
    return repo === undefined ? 0 : truncatedTotal(repo);
};
// Distinct paths a repo is showing: a file staged and edited again is two rows over one path.
const visibleIn = (repo: RepoChanges): number =>
    new Set(sidesOf(repo).flatMap((section) => section.changes.map((change) => change.path))).size;
// Files the filtered shape covers, for the button's label; 0 for every other shape. Counted off the drawn
// rows, so it's a lower bound wherever the review truncated — `commitCountable` says when to hide the number rather
// than undercount it.
const commitFiles = computed(() =>
    commitGroups.value.reduce((total, group) => {
        const repo = repoIn(group.repo);
        return total + (group.scope === undefined ? (group.paths?.length ?? 0) : repo === undefined ? 0 : visibleIn(repo));
    }, 0),
);
const commitCountable = computed(() => !commitGroups.value.some((group) => truncatedIn(group.repo) > 0));
// Any repo's unresolved conflict blocks the whole button: a commit spans repos sharing one message, and git would
// refuse mid-batch.
const blockedByConflicts = computed(() => scannable.value.some((repo) => repo.conflicted.length > 0));
// Reads the daemon's own "committing" flag (unioned with this tab's in-flight batch), narrowed to the
// repos this box would actually commit — a run in a repo the filter excludes isn't this button's concern.
const committingNow = computed(() => commitTarget.value.filter((repo) => changes.committing.value.includes(repo)));
const commitRunning = computed(() => committingNow.value.length > 0);
const commitReady = computed(
    () =>
        commitTarget.value.length > 0 &&
        commitMessage.value.trim().length > 0 &&
        !blockedByConflicts.value &&
        !changes.actionBusy.value &&
        !commitRunning.value,
);
// The count rides the label, since a bare "Commit" over a filtered or hidden list wouldn't say what it covers.
// Dropped wherever the review truncated, in favor of naming the filter — an undercounted figure is a worse promise than
// none.
const commitLabel = computed(() =>
    commitAll.value
        ? `Commit all`
        : commitFiles.value === 0
          ? `Commit`
          : commitCountable.value
            ? `Commit ${plural(commitFiles.value, `file`)}`
            : `Commit everything from ${filterLabel.value ?? `this filter`}`,
);

// Sessions this commit would record, and which are still running — scoped exactly like the button. A
// warning, not a gate: staging part of an unfinished agent's work is ordinary, and `reset --soft` undoes it.
const commitOrigins = computed(() =>
    stagesFirst.value && originFilter.value !== undefined
        ? legend.value.agents.filter((entry) => entry.id === originFilter.value)
        : summarizeOrigins(
              scannable.value.filter((repo) => commitTarget.value.includes(repo.repo)),
              commitAll.value ? ALL_SIDES : [`staged`],
          ).agents,
);
const unfinished = computed(() => commitOrigins.value.filter((entry) => originMark(entry.id) !== undefined));

// Only matters for a stage-first commit, which reads the live worktree — a plain commit already froze its
// content at stage time. Only main-tree turns count: an isolated turn reaches this tree through land, which the daemon
// already serializes against every git write here.
const repos = useRepos();
const writingRepos = computed<ReadonlySet<string>>(
    () =>
        new Set(
            conversations.value
                .filter((conversation) => !conversation.isolated.value && conversation.streaming.value)
                .flatMap((conversation) =>
                    [...turnWrites(conversation.conversationId, conversation.turnStartedAt.value)].map((path) =>
                        repoOfPath(path, repos.repoDirs.value),
                    ),
                ),
        ),
);
// Named in the warning; everything else is committable right now, which is why this is scoped per repo, not per
// workspace.
const atRisk = computed(() => (stagesFirst.value ? commitTarget.value.filter((repo) => writingRepos.value.has(repo)) : []));
const unaffected = computed(() => commitGroups.value.filter((group) => !writingRepos.value.has(group.repo)));

const runCommit = async (target: readonly RepoTarget[]): Promise<void> => {
    await changes.commitRepos(target, commitMessage.value, stagesFirst.value);
    // Keeps the message on failure — it's the one thing here the user typed by hand.
    if (!changes.failures.value.has(COMMIT_SCOPE)) {
        commitMessage.value = ``;
        // Ends the naming ask with the commit that fulfilled it, or a message still being drafted would fill the NEXT
        // commit's box.
        nameCommitAfter(undefined);
    }
};
// Ctrl+Enter reaches this too, so a silently-ignored chord just gets retried harder; this names which of the
// three reasons applied instead.
const commitBlocker = computed<string | undefined>(() => {
    if (blockedByConflicts.value) {
        return `Resolve the conflicts first: git cannot commit while a path is unmerged.`;
    }
    // Checked ahead of "nothing to commit": mid-commit the rows are still listed, so this is the honest reason, not a
    // count about to change.
    if (commitRunning.value) {
        return `Still committing ${committingNow.value.join(`, `)}. This finishes on its own.`;
    }
    if (commitTarget.value.length === 0) {
        return `Nothing to commit.`;
    }
    if (commitMessage.value.trim().length === 0) {
        return `Write a commit message first.`;
    }
    return changes.actionBusy.value ? `Another git action is still running.` : undefined;
});
// Shown after a rejected Ctrl+Enter; cleared on the next edit, so it never outlives what it described.
const blockerNotice = ref<string | undefined>(undefined);
watch([commitMessage, commitBlocker], () => {
    blockerNotice.value = undefined;
});
const doCommit = async (): Promise<void> => {
    if (!commitReady.value) {
        blockerNotice.value = commitBlocker.value;
        return;
    }
    await runCommit(commitGroups.value);
};

// A textarea, not an input, since a message can carry a release-note trailer as a body. Measured via
// `scrollHeight`, not counted newlines — a single wrapped line is still one line to `split`.
// Eight lines at this box's font/padding, matching the composer's own ceiling (ChatPane), scaled to the sidebar.
const MAX_COMMIT_HEIGHT = 142;
const commitBox = ref<HTMLTextAreaElement | null>(null);
// This box has its own border (the composer's doesn't), so growTextarea reads it off the element rather than a
// constant.
const growCommitBox = (): void => {
    growTextarea(commitBox.value, MAX_COMMIT_HEIGHT);
};
// Watched, not `@input`: most of what fills this box isn't typing (a chip fill, a clear, a sandbox switch).
// Sidebar width and `chipNotice` are in the list too, since a re-wrap or a longer placeholder both change the needed
// height.
watch([commitBox, commitMessage, chipNotice, layout.sidebarWidth], growCommitBox, { flush: `post` });

// `staged` is the one side moving OUT of the index; the other two move in — a conflict's inward move is `git add`,
// resolving it.
const movesIntoIndex = (side: GitDiffSide): boolean => side !== `staged`;
// Read through `sidesOf`, so a section verb can only ever touch the rows that section is actually showing.
const changesOn = (repo: RepoChanges, side: GitDiffSide): readonly GitChange[] =>
    sidesOf(repo).find((section) => section.side === side)?.changes ?? [];

// What the inward/outward index move is called, per side: a conflict says "resolve", not "stage" — `git add`
// on an unmerged path settles a merge, it doesn't put a change in the index.
const INDEX_VERB: Record<GitDiffSide, { readonly one: string; readonly all: string; readonly icon: "plus" | "undo" | "check" }> = {
    conflicted: { one: `Mark resolved`, all: `Mark all resolved`, icon: `check` },
    unstaged: { one: `Stage`, all: `Stage all`, icon: `plus` },
    staged: { one: `Unstage`, all: `Unstage all`, icon: `undo` },
};

// Names whose files it moves, under a filter — the button no longer means "this whole side". Drops the
// count wherever the daemon truncated, since a fraction is a worse promise than none.
const sideVerbHint = (repo: RepoChanges, side: GitDiffSide): string => {
    if (filterLabel.value === undefined) {
        return INDEX_VERB[side].all;
    }
    const whose = `from ${filterLabel.value}`;
    return truncatedOn(repo, side) > 0
        ? `${INDEX_VERB[side].all}, every file ${whose}`
        : `${INDEX_VERB[side].all}, ${plural(changesOn(repo, side).length, `file`)} ${whose}`;
};

// Row action: moves the acting rows across the index, in the direction their side implies.
const stageRow = (row: Row): Promise<void> => changes.stageGroups(byRepo(actingRows(row, true)), movesIntoIndex(row.side));
// Section action: the whole side, sent as a scope rather than the rows drawn — the change that ended staging
// a truncated repo five hundred files at a time.
const stageSide = (repo: RepoChanges, side: GitDiffSide): Promise<void> =>
    changes.stageGroups([scoped(repo.repo, side)], movesIntoIndex(side));

// A modal confirm, like every other destructive git action here. The target is resolved when the user arms
// it, so the prompt's wording and the action can never disagree with a poll landing in between.
interface DiscardTarget {
    // The heading's object: "every uncommitted change in intentic", "3 selected files", a single path.
    readonly what: string;
    // Untracked paths are deleted, not reverted: git holds no copy of them, so this is the one part not recoverable
    // from git.
    readonly deletes: readonly string[];
    // Distinct tracked paths returning to their last committed state.
    readonly restores: number;
    // True wherever the daemon truncated: the discard covers the whole scope, but these counts and the deletion
    // list can only speak for the rows the panel was given, so this says when they're a floor, not the total.
    readonly partial: boolean;
    readonly groups: readonly RepoTarget[];
}
const pendingDiscard = ref<DiscardTarget | undefined>(undefined);

// "added" on the unstaged side means untracked — a tracked file can never report added there, so this is exact.
const untrackedIn = (repo: string): ReadonlySet<string> =>
    new Set(
        scannable.value
            .find((candidate) => candidate.repo === repo)
            ?.unstaged.filter((change) => change.status === `added`)
            .map((change) => change.path) ?? [],
    );

const askDiscardRow = (row: Row, change: GitChange): void => {
    const groups = byRepo(actingRows(row, false));
    const deletes = groups.flatMap((group) => {
        const untracked = untrackedIn(group.repo);
        return (group.paths ?? []).filter((path) => untracked.has(path)).map((path) => (group.repo === `root` ? path : `${group.repo}/${path}`));
    });
    // `byRepo` already deduped a path selected on both sides, so this counts worktree paths, not rows.
    const paths = groups.reduce((total, group) => total + (group.paths?.length ?? 0), 0);
    pendingDiscard.value = {
        what: paths > 1 ? `${paths} selected files` : changeLabel(row.repo, change),
        deletes,
        restores: paths - deletes.length,
        // A selection is exactly as long as the rows clicked, so it's never a floor.
        partial: false,
        groups,
    };
};

// Narrows to the filtered origin's files under a filter — the row it hangs off is showing that subset only.
// Both shapes are scopes now, so the filtered discard also reaches that session's files past the panel's truncation
// budget.
const askDiscardRepo = (repo: RepoChanges): void => {
    // Distinct paths: a path staged and edited again is two rows but one file on disk, and this counts disk effect.
    const paths = new Set(sidesOf(repo).flatMap((section) => section.changes.map((change) => change.path)));
    const deletes = repo.unstaged.filter((change) => change.status === `added` && paths.has(change.path)).map((change) => change.path);
    const partial = truncatedTotal(repo) > 0;
    pendingDiscard.value = {
        what:
            filterLabel.value === undefined
                ? `every uncommitted change in ${repo.repo}`
                : partial
                  ? `every file from ${filterLabel.value} in ${repo.repo}`
                  : `${plural(paths.size, `file`)} from ${filterLabel.value} in ${repo.repo}`,
        deletes,
        restores: paths.size - deletes.length,
        partial,
        groups: [originFilter.value === undefined ? { repo: repo.repo } : scoped(repo.repo)],
    };
};

const confirmDiscard = async (): Promise<void> => {
    const target = pendingDiscard.value;
    pendingDiscard.value = undefined;
    if (target !== undefined) {
        await changes.discardGroups(target.groups);
    }
};

// Shown only for a repo with a remote. `syncable`/`ahead`/`behind`/`unpublished` come from useChanges, so the
// rail tile and this panel read a repo the same way. No verb reaches a row anymore — see the outgoing block above the
// list.

// VSCode's post-commit move: the slot just used to Commit becomes the sync the repos need, once the commit
// box has nothing left to show. Per-row pills remain the granular control for a set whose repos need different things.
const syncRepos = computed(() => scannable.value.filter((repo) => syncable(repo) && (ahead(repo) > 0 || behind(repo) > 0 || unpublished(repo))));
const aheadTotal = computed(() => syncRepos.value.reduce((total, repo) => total + ahead(repo), 0));
const behindTotal = computed(() => syncRepos.value.reduce((total, repo) => total + behind(repo), 0));
const toPublish = computed(() => syncRepos.value.some((repo) => unpublished(repo)));
// Mirrors the row pills so the bar can't contradict them: Pull for incoming-only, Push for outgoing-only,
// Publish for an unpublished branch alone, Sync when a repo carries both. Mixed publish+outgoing reads Push.
const syncVerb = computed<"push" | "pull" | "sync" | "publish" | undefined>(() => {
    if (syncRepos.value.length === 0) {
        return undefined;
    }
    if (behindTotal.value > 0) {
        return aheadTotal.value > 0 || toPublish.value ? `sync` : `pull`;
    }
    if (toPublish.value && aheadTotal.value === 0) {
        return `publish`;
    }
    return `push`;
});
// Icons match the row pills (↑ push, ↓ pull), so the bar and the rows read as one language.
// No hover hint on this one, deliberately: the label is already Push/Pull/etc, and `syncSummary` beside it
// already states what will move — a tooltip repeating the label would fire on every pointer pass in a narrow sidebar.
const SYNC_VERB: Record<
    "push" | "pull" | "sync" | "publish",
    { readonly label: string; readonly icon: "arrow-up-right" | "arrow-down-left" | "sync" | "cloud-upload" }
> = {
    push: { label: `Push`, icon: `arrow-up-right` },
    pull: { label: `Pull`, icon: `arrow-down-left` },
    sync: { label: `Sync`, icon: `sync` },
    publish: { label: `Publish`, icon: `cloud-upload` },
};
const syncMeta = computed(() => (syncVerb.value === undefined ? undefined : SYNC_VERB[syncVerb.value]));
// Counts plus the repo spread when more than one is in play; a pure publish has nothing to count.
const syncSummary = computed<string>(() => {
    const counts = [...(behindTotal.value > 0 ? [`↓${behindTotal.value}`] : []), ...(aheadTotal.value > 0 ? [`↑${aheadTotal.value}`] : [])];
    const spread = syncRepos.value.length > 1 ? ` · ${plural(syncRepos.value.length, `repo`)}` : ``;
    return (counts.length > 0 ? counts.join(` `) : `no upstream yet`) + spread;
});
// Every push funnels through `pushFlow.askSync` (the bar and both row pills) — a second door to the same verb
// would be a way around the pre-push check, which is also why useChanges exports no one-repo push.

// How far through the suite is, against usePushFlow's remembered typical duration per sandbox — an elapsed
// clock alone can't say whether 2s in is almost done or barely started. Capped short of 100%; undefined (no memory yet)
// reads as indeterminate, not idle.
const CHECK_FILL_CAP = 0.92;
const checkElapsed = computed(() => now.value - pushFlow.since.value);
const checkOverrun = computed(() => pushFlow.typicalMs.value !== undefined && checkElapsed.value > pushFlow.typicalMs.value);
const checkFill = computed<number | undefined>(() => {
    const typical = pushFlow.typicalMs.value;
    return pushFlow.stage.value !== `checking` || typical === undefined || typical <= 0
        ? undefined
        : Math.min(checkElapsed.value / typical, CHECK_FILL_CAP);
});

// One line, the width this ~270px panel can spend on status; the duration scale rides the same line.
const stageLine = computed<string | undefined>(() => {
    const elapsed = formatElapsed(pushFlow.since.value, now.value);
    if (pushFlow.stage.value === `checking`) {
        const typical = pushFlow.typicalMs.value;
        if (typical === undefined) {
            return `Checking · ${elapsed}`;
        }
        return checkOverrun.value ? `Checking · ${elapsed} · taking longer` : `Checking · ${elapsed} of ~${formatElapsed(0, typical)}`;
    }
    if (pushFlow.stage.value === `pushing`) {
        return `${pushFlow.pending.value?.verb ?? `Push`}ing · ${elapsed}`;
    }
    const sent = pushFlow.pushed.value;
    return sent === undefined ? undefined : `Pushed ${sent.what}`;
});

// The one fact the line has no room for: the command running. Undefined once nothing is in flight.
const stageHint = computed<string | undefined>(() => {
    if (pushFlow.stage.value === `checking`) {
        return pushFlow.command.value === `` ? undefined : pushFlow.command.value;
    }
    return pushFlow.stage.value === `pushing` ? `Sending ${pushFlow.pending.value?.what ?? `your commits`} to the remote` : undefined;
});

/* WHAT A CLOSED CARD LEAVES BEHIND, on the control that raised it. Closing the card said "off my screen", not "that
 * never happened": the check still failed and the push still hasn't gone, so the block that spent three minutes
 * finding that out keeps saying it, and a press puts the whole card back at no cost. Without this the only route to
 * a verdict already reached is running the suite again to reach it a second time.
 *
 * The age is the point of the line. A verdict is about the files as they were, so "4m ago" is what makes it
 * trustworthy, and a tree written to since demotes it: still shown, no longer the answer.
 *
 * That demotion gets a LINE OF ITS OWN rather than a third clause, and this column is why: at 270px a third
 * clause truncates to "files c…", which is the one reading that says nothing at all. The stacked pair is the
 * shape the running state next door already uses for the same reason. */
const heldLine = computed<string | undefined>(() => {
    const held = pushFlow.held.value;
    return held === undefined ? undefined : `${held.question.title} · ${timeAgo(held.at, { now: now.value })}`;
});

// Whether the button beside the line would spend the suite again. Only a settled failure over an untouched tree is
// still an answer; a stopped run, one that couldn't start, and a tree written to since all mean measure it again.
const heldReruns = computed(() => pushFlow.held.value?.check?.status !== `failed` || pushFlow.heldStale.value);

// What the press costs, which is the one thing the line can't say and the whole reason the block is here.
const heldHint = computed<string | undefined>(() => {
    const held = pushFlow.held.value;
    if (held === undefined) {
        return undefined;
    }
    const verb = syncMeta.value?.label ?? `Push`;
    const shown = `Show what happened: ${held.question.command ?? held.question.title}.`;
    return heldReruns.value
        ? `${shown} ${verb} runs the check again`
        : `${shown} Nothing has been written since, so ${verb} shows this instead of spending the check`;
});

// The offer and the run are one control in three states, not stacked rows — the control that was clicked is the
// control that reports, and the one that keeps reporting after the answer was closed. Also the only place sync is
// mentioned now; the per-row pills it replaced turned every repo row into a remote dashboard.
const outgoing = computed<"flow" | "held" | "offer" | undefined>(() =>
    stageLine.value !== undefined ? `flow` : heldLine.value !== undefined ? `held` : syncMeta.value !== undefined ? `offer` : undefined,
);
// Commit keeps the primary slot while there's anything to record, so the two buttons are never both full-weight.
const syncSeverity = computed<"secondary" | undefined>(() => (changes.count.value > 0 ? `secondary` : undefined));
// Names which repos, since the summary beside the button only counts. The fast-forward caveat rides here too
// — the one thing about this verb a user can be surprised by, now that the per-row pull pill is gone.
const syncHint = computed(() => {
    const named = `${syncMeta.value?.label ?? `Sync`} ${syncRepos.value.map((repo) => repo.repo).join(`, `)}`;
    return behindTotal.value > 0 ? `${named}. Pulls fast-forward only: a diverged history is reported, never auto-merged` : named;
});
// Every repo with a remote — the honest scope for a verb whose whole job is proving a stale zero wrong.
const fetchable = computed(() => scannable.value.filter((repo) => syncable(repo)).map((repo) => repo.repo));

// Deliberately no rules of its own: the view header above already draws the one line this column gets. Blocks
// are told apart by their own padding; a control with its own edge (the field, the button) carries what a rule would
// have.
// One click, every repo with remote work: git can't span remotes, so this fans out into one real sync per repo.
const doSync = (): void =>
    pushFlow.askSync(
        syncMeta.value?.label ?? `Sync`,
        `${aheadTotal.value > 0 ? plural(aheadTotal.value, `commit`) : `this branch`}${syncRepos.value.length > 1 ? ` across ${plural(syncRepos.value.length, `repo`)}` : ``}`,
        syncRepos.value.map((repo) => ({ repo: repo.repo, pull: behind(repo) > 0, push: ahead(repo) > 0 || unpublished(repo) })),
    );

// Hover-revealed but always laid out, so revealing on hover never moves the button out from under the pointer; touch
// keeps them visible.
const ROW_ACTION = `opacity-0 transition-opacity focus-visible:opacity-100 group-hover/repo:opacity-100 max-md:opacity-100`;

// Counts every side the row is showing (so a filter narrows it too), plus the daemon-truncated remainder.
const repoCount = (repo: RepoChanges): number => sidesOf(repo).reduce((total, section) => total + section.changes.length, truncatedTotal(repo));

// A count earns its pixels only where the rows it counts are NOT all on screen already — folded, multi-sided,
// or truncated. Expanded, single-sided and complete, the figure is deleted: the rows are right there to count.
const showRepoCount = (repo: RepoChanges): boolean =>
    repoCount(repo) > 0 && (collapsed.value.has(repo.repo) || sidesSplit(repo) || truncatedTotal(repo) > 0);

// Each rank that is actually DRAWN (repo, side, module, file) gets one 8px step; a rank that isn't drawn costs
// nothing, so a shallow list (one repo, one side, no grouping) stays shallow instead of indenting for headings that
// aren't there.
const ROW_INDENT: readonly string[] = [`pl-2`, `pl-4`, `pl-6`];
const rowIndent = (repo: RepoChanges, side: GitDiffSide): string =>
    ROW_INDENT[(sidesSplit(repo) ? 1 : 0) + (moduleRow(repo, side) ? 1 : 0)] ?? `pl-6`;
// The module heading sits one step above its rows, on whichever step the side header left free.
const moduleIndent = (repo: RepoChanges): string => (sidesSplit(repo) ? `pl-4` : `pl-2`);

// The same fold as `soleSide`, one level down: a section whose rows are all in one module states it on the
// section's own row instead of a heading over a single row. Only where there's a section row to fold into.
const soleBucket = (repo: string, side: GitDiffSide): ModuleGroup<GitChange> | undefined => {
    const view = viewOf(repo, side);
    return view.named && view.buckets.length === 1 ? view.buckets[0] : undefined;
};
const moduleRow = (repo: RepoChanges, side: GitDiffSide): boolean =>
    viewOf(repo.repo, side).named && !(sidesSplit(repo) && soleBucket(repo.repo, side) !== undefined);

// Where a failed action gets drawn: the repo's own row, or the commit box for a commit spanning repos.
const failureIn = (scope: string) => changes.failures.value.get(scope);

// Failures with no row to land on: a fetch or push that fails in a CLEAN repo, which no longer has a row of
// its own now that ahead/behind moved to the outgoing block. Surface under the block that fired them, naming their
// repo.
const strayFailures = computed<readonly { repo: string; action: string; detail: string }[]>(() =>
    [...changes.failures.value]
        .filter(([scope]) => scope !== COMMIT_SCOPE && !dirty.value.some((repo) => repo.repo === scope))
        .map(([repo, failure]) => ({ repo, ...failure })),
);

// A bordered block, not loose coloured text — an error needs a container or it reads as gibberish, not a message.
const NOTICE = `flex items-start gap-1.5 rounded-md border border-danger/40 bg-danger/10 px-2 py-1.5`;
// The same shape one severity down: a heads-up about something that hasn't gone wrong yet, on an action still
// available.
const WARNING = `flex items-start gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-2 py-1.5`;
</script>

<template>
    <div class="flex min-h-0 flex-1 flex-col">
        <!--
            No header row of its own: the mode switch above already reads "Changes" with the count. The panel's two
            panel-wide actions (history, refresh) live on that switch's row instead (WorkspaceDesktop).
        -->

        <!--
            The one genuinely panel-wide failure: the review set itself couldn't be read, so nothing below is
            trustworthy. Every other error belongs to a row or the commit box.
        -->
        <div v-if="changes.error.value" :class="[NOTICE, 'mx-2 mt-2 shrink-0']">
            <Icon name="exclamation-triangle" class="mt-0.5 shrink-0 text-2xs text-danger" />
            <div class="min-w-0 flex-1">
                <p class="text-2xs font-medium text-danger">Couldn't read changes</p>
                <p class="break-words text-2xs text-muted">{{ changes.error.value }}</p>
            </div>
        </div>

        <!-- Commit box first (VSCode's placement). It records the index — staging is the selection. -->
        <div v-if="changes.count.value > 0" class="flex shrink-0 flex-col gap-1.5 p-2">
            <!--
                A textarea: a landed sentence's trailer, or a hand-typed body, needs somewhere to go. The placeholder answers
                the click directly — a chip still drafting, or one with nothing coming, says so right where the sentence would land.
            -->
            <textarea
                ref="commitBox"
                v-model="commitMessage"
                rows="1"
                :placeholder="chipNotice ?? commitPlaceholder"
                class="ui-field-box ui-field-sm scrollbar-thin block max-h-[142px] w-full min-w-0 resize-none overflow-y-auto leading-snug"
                @keydown.ctrl.enter="doCommit"
                @keydown.meta.enter="doCommit"
            ></textarea>
            <!--
                The draft's full report, one row per model, while a message is being written or after it fails; a draft that
                ends well takes its report with it, since the message in the box is report enough. A table, not a paragraph, so status, clock and
                reason each get their own column.
            -->
            <div v-if="filterDraftRows.length > 0" class="flex flex-col gap-px rounded-md bg-overlay/60 px-1.5 py-1">
                <div v-for="row in filterDraftRows" :key="row.key" class="flex min-w-0 items-center gap-1.5 leading-snug" v-tooltip.right="row.title">
                    <!-- Every glyph is one em square, so the column self-aligns with no width set on it. -->
                    <Icon
                        :name="STEP_MARKS[row.status].icon"
                        :spin="STEP_MARKS[row.status].spin"
                        class="shrink-0 text-3xs"
                        :class="STEP_MARKS[row.status].tone"
                    />
                    <!--
                        The model stays ahead of the reason and is capped at the chips' own width, so a long tiered name can't push
                        the reason (the part that differs row to row) off the edge; its full form is one tooltip away.
                    -->
                    <span
                        v-if="row.model !== undefined"
                        class="max-w-28 shrink-0 truncate text-2xs"
                        :class="row.status === `refused` || row.status === `skipped` ? `text-muted` : `text-content`"
                    >
                        {{ row.model }}
                    </span>
                    <span class="min-w-0 flex-1 truncate text-2xs" :class="row.status === `failed` ? `text-warning` : `text-subtle`">
                        {{ row.detail }}
                    </span>
                    <!-- Tabular figures in a held column, so seconds line up and a skip's blank time doesn't ragged the right edge. -->
                    <span class="w-7 shrink-0 text-right text-2xs tabular-nums text-subtle">{{ row.elapsed }}</span>
                </div>
            </div>
            <!--
                What the commit will record, then the button that records it; no checkboxes, since the sentence is a readout of the index, not a
                control.
            -->
            <div class="flex items-center gap-1">
                <span v-if="blockedByConflicts" class="min-w-0 flex-1 truncate whitespace-nowrap text-2xs text-danger">
                    Resolve conflicts first
                </span>
                <!--
                    Where the commit is happening — the one thing the button beside it can't say. Ahead of the staged count, which no longer applies
                    mid-commit.
                -->
                <span v-else-if="commitRunning" class="min-w-0 flex-1 truncate whitespace-nowrap text-2xs text-muted">
                    Committing {{ committingNow.join(`, `) }}…
                </span>
                <!-- Why Ctrl+Enter just refused: takes the readout's place, since it answers the same question the readout does. -->
                <span
                    v-else-if="blockerNotice"
                    class="min-w-0 flex-1 truncate whitespace-nowrap text-2xs text-warning"
                    v-tooltip.right.overflow="blockerNotice"
                >
                    {{ blockerNotice }}
                </span>
                <!--
                    The lit chip's answer, for the one case the placeholder can't show: the box holds the user's own text.
                    Ahead of the staged readout, since it explains a click that looked like it did nothing — the more urgent question.
                -->
                <span
                    v-else-if="boxIsYours && chipNotice"
                    class="min-w-0 flex-1 truncate whitespace-nowrap text-2xs text-muted"
                    v-tooltip.right.overflow="chipNotice"
                >
                    {{ chipNotice }}
                </span>
                <span v-else class="min-w-0 flex-1 truncate whitespace-nowrap text-2xs text-muted">
                    <template v-if="changes.stagedCount.value > 0"
                        >{{ changes.stagedCount.value }} staged<span v-if="stagedRepos.length > 1"> · {{ stagedRepos.length }} repos</span></template
                    >
                    <template v-else>nothing staged</template>
                </span>
                <!-- Says so mid-commit rather than just going flat — the wait can include a stage, hooks, a re-read and a queued land. -->
                <Button
                    size="small"
                    severity="success"
                    class="shrink-0 whitespace-nowrap"
                    :disabled="!commitReady"
                    @click="doCommit"
                    v-tooltip.right="
                        commitRunning
                            ? `Recording ${committingNow.join(', ')}: the rows clear when git is done`
                            : blockedByConflicts
                              ? 'A path is unmerged: stage each conflicted file to mark it resolved'
                              : commitAll
                                ? 'Stages every change, then commits'
                                : commitFiles > 0
                                  ? `Stages the ${plural(commitFiles, 'file')} from ${filterLabel}, then commits: nothing else goes in`
                                  : 'One commit per repo'
                    "
                >
                    <Icon :name="commitRunning ? `spinner` : `check`" :spin="commitRunning" />{{ commitRunning ? `Committing…` : commitLabel }}
                </Button>
            </div>
            <!--
                A warning, not a gate — the commit is the user's to make, and `reset --soft` undoes it. What this adds is the
                repos nobody is writing, committable in one click, without waiting on the ones that are.
            -->
            <div v-if="atRisk.length > 0" :class="WARNING">
                <Icon name="exclamation-triangle" class="mt-0.5 shrink-0 text-2xs text-warning" />
                <div class="min-w-0 flex-1">
                    <p class="break-words text-2xs text-warning">
                        An agent is editing {{ atRisk.join(`, `) }} right now. "{{ commitLabel }}" records
                        {{ atRisk.length === 1 ? `it` : `them` }} mid-write.
                    </p>
                    <Button
                        v-if="unaffected.length > 0"
                        size="small"
                        severity="secondary"
                        class="mt-1 whitespace-nowrap"
                        :disabled="!commitReady"
                        @click="() => runCommit(unaffected)"
                        v-tooltip.right="`Commits ${unaffected.map((group) => group.repo).join(`, `)}`"
                    >
                        <Icon name="check" class="mr-1 text-2xs" />Commit
                        {{ unaffected.length === 1 ? unaffected[0]!.repo : `the other ${unaffected.length} repos` }}
                    </Button>
                </div>
            </div>
            <!--
                A different question from the write-race warning above: the index already froze these files; this just says the session has more
                coming.
            -->
            <div v-if="unfinished.length > 0" :class="WARNING">
                <Icon name="wave-pulse" class="mt-0.5 shrink-0 text-2xs text-warning" />
                <p class="min-w-0 flex-1 break-words text-2xs text-warning">
                    {{ unfinished.map((entry) => originLabel(entry.id)).join(`, `) }}
                    {{ unfinished.length === 1 ? `hasn't` : `haven't` }} finished, this commit records the
                    {{ unfinished.reduce((total, entry) => total + entry.files, 0) === 1 ? `file` : `files` }} landed so far.
                </p>
            </div>
            <!-- A commit spans every staged repo, so its failure belongs to the box that fired it, message still in the input. -->
            <div v-if="failureIn(COMMIT_SCOPE)" :class="NOTICE">
                <Icon name="exclamation-triangle" class="mt-0.5 shrink-0 text-2xs text-danger" />
                <div class="min-w-0 flex-1">
                    <p class="text-2xs font-medium text-danger">{{ failureIn(COMMIT_SCOPE)!.action }}</p>
                    <p class="line-clamp-4 break-words text-2xs text-muted" v-tooltip.top.overflow="failureIn(COMMIT_SCOPE)!.detail">
                        {{ failureIn(COMMIT_SCOPE)!.detail }}
                    </p>
                </div>
                <button
                    type="button"
                    class="shrink-0 rounded p-0.5 text-muted transition-colors hover:text-content"
                    @click="changes.dismissFailure(COMMIT_SCOPE)"
                    v-tooltip.right="'Dismiss'"
                    aria-label="Dismiss commit error"
                >
                    <Icon name="times" class="text-2xs" />
                </button>
            </div>
        </div>

        <!--
            One block, two states, never both: at rest the sync every repo needs, in flight the run in the button's own
            place. The only place the remote is mentioned now — the per-row pills it replaced turned every row into a remote dashboard.
        -->
        <div
            v-if="outgoing !== undefined"
            class="relative flex shrink-0 items-center gap-1.5 px-2 py-1.5"
            v-tooltip.right="outgoing === `flow` && !mobile ? stageHint : undefined"
        >
            <template v-if="outgoing === `flow`">
                <Icon
                    :name="pushFlow.running.value ? `spinner` : `check-circle`"
                    :spin="pushFlow.running.value"
                    class="shrink-0 text-2xs"
                    :class="pushFlow.running.value ? `text-link` : `text-success`"
                />
                <span class="flex min-w-0 flex-1 flex-col">
                    <!-- Lifts to full contrast only when it's news: a suite already running past its usual duration. -->
                    <span class="truncate whitespace-nowrap text-2xs" :class="checkOverrun ? `text-content` : `text-muted`">{{ stageLine }}</span>
                    <span v-if="mobile && stageHint" class="truncate whitespace-nowrap font-mono text-3xs text-subtle">{{ stageHint }}</span>
                </span>
                <!--
                    Drawn only where a terminal exists — a sandbox without the tmux wrapper ran the suite invisibly, and a button to nothing is worse
                    than none.
                -->
                <button
                    v-if="pushFlow.running.value && pushFlow.terminal.value !== undefined"
                    type="button"
                    :class="[ICON_BUTTON, 'max-md:h-8 max-md:w-8']"
                    @click="pushFlow.showTerminal"
                    v-tooltip.top="'Watch it run'"
                    aria-label="Watch the checks run"
                >
                    <Icon name="terminal" class="text-2xs" />
                </button>
                <!--
                    Stopping the suite isn't cancelling the push — it settles as stopped and the push still waits on an answer.
                    Wears this panel's own secondary-button shape rather than a bare word, so it's visibly pressable.
                -->
                <Button
                    v-if="pushFlow.stage.value === `checking`"
                    size="small"
                    severity="secondary"
                    class="shrink-0 whitespace-nowrap"
                    @click="pushFlow.stopChecks"
                    v-tooltip.top="'Stop the checks. The push stays waiting on your answer'"
                >
                    Stop
                </Button>
            </template>
            <!--
                The verdict the card was closed on, kept where the press that raised it lives. The line itself is the
                way back into it: a separate "Show" button beside a Push that already reopens it would be two controls
                for one thought, in a column that has room for neither.
            -->
            <template v-else-if="outgoing === `held`">
                <Icon
                    name="exclamation-triangle"
                    class="shrink-0 text-2xs"
                    :class="heldReruns ? `text-muted` : `text-danger`"
                    aria-hidden="true"
                />
                <button
                    type="button"
                    class="flex min-w-0 flex-1 flex-col text-left transition-colors"
                    :class="heldReruns ? `text-muted hover:text-content` : `text-danger hover:text-content`"
                    v-tooltip.right="heldHint"
                    @click="pushFlow.reopen"
                >
                    <span class="truncate whitespace-nowrap text-2xs">{{ heldLine }}</span>
                    <!-- Its own line, not a third clause: truncated to "files c…" this says nothing. -->
                    <span v-if="pushFlow.heldStale.value" class="truncate whitespace-nowrap text-3xs text-subtle">files changed since</span>
                </button>
                <Button
                    v-if="syncMeta"
                    size="small"
                    :severity="syncSeverity"
                    class="shrink-0 whitespace-nowrap"
                    :disabled="changes.actionBusy.value"
                    v-tooltip.top="syncHint"
                    @click="doSync"
                >
                    <Icon :name="syncMeta.icon" />{{ syncMeta.label }}
                </Button>
            </template>
            <template v-else>
                <span class="min-w-0 flex-1 truncate whitespace-nowrap text-2xs text-muted" v-tooltip.right="syncHint">{{ syncSummary }}</span>
                <!--
                    Fetch lives with the number it refreshes, and there's one of it now: its scope is every repo with a remote,
                    the only scope at which the count is worth trusting (a per-repo fetch left the rest of the summary just as stale).
                -->
                <button
                    type="button"
                    :class="[ICON_BUTTON, 'max-md:h-8 max-md:w-8']"
                    :disabled="changes.actionBusy.value"
                    @click="changes.fetchRepos(fetchable)"
                    v-tooltip.top="'Fetch: refresh what every repo knows about its remote'"
                    aria-label="Fetch every repo"
                >
                    <Icon name="sync" class="text-2xs" />
                </button>
                <!--
                    No `running` in the disabled check anymore — the flow takes the whole block over, so there's no dead Push beside its own
                    progress.
                -->
                <Button size="small" :severity="syncSeverity" class="shrink-0 whitespace-nowrap" :disabled="changes.actionBusy.value" @click="doSync">
                    <Icon :name="syncMeta!.icon" />{{ syncMeta!.label }}
                </Button>
            </template>

            <!--
                The block's own bottom edge doubles as the progress bar, so the wait is drawn in pixels the panel already
                spends. Determinate against the remembered duration; a pulse when there's none yet; stops short of 100%.
            -->
            <div v-if="pushFlow.stage.value === `checking`" class="pointer-events-none absolute inset-x-0 -bottom-px h-0.5 overflow-hidden">
                <div
                    v-if="checkFill !== undefined"
                    class="h-full bg-link transition-[width] duration-1000 ease-linear"
                    :style="{ width: `${Math.round(checkFill * 100)}%` }"
                ></div>
                <div v-else class="h-full w-full bg-link/40"></div>
            </div>
        </div>

        <!-- A fetch or push that failed in a repo the list isn't showing; named by repo since it has no row to sit under. -->
        <div v-for="failure in strayFailures" :key="failure.repo" :class="[NOTICE, 'mx-2 mt-1 shrink-0']">
            <Icon name="exclamation-triangle" class="mt-0.5 shrink-0 text-2xs text-danger" />
            <div class="min-w-0 flex-1">
                <p class="text-2xs font-medium text-danger">{{ failure.action }} in {{ failure.repo }}</p>
                <p class="line-clamp-4 break-words text-2xs text-muted" v-tooltip.top.overflow="failure.detail">{{ failure.detail }}</p>
            </div>
            <button
                type="button"
                class="shrink-0 rounded p-0.5 text-muted transition-colors hover:text-content"
                @click="changes.dismissFailure(failure.repo)"
                v-tooltip.right="'Dismiss'"
                :aria-label="`Dismiss error for ${failure.repo}`"
            >
                <Icon name="times" class="text-2xs" />
            </button>
        </div>

        <!--
            Whose work is in the tree, one line, only when an agent landed something; each chip is a filter. A chip is a
            logo and a file count, not a title — the identity is a hover away, on the same card the file rows and chat tab strip raise.
        -->
        <div v-if="legend.agents.length > 0" class="flex shrink-0 flex-wrap items-center gap-1 px-2 py-1.5">
            <span class="shrink-0 text-2xs uppercase tracking-wide text-subtle">From</span>
            <button
                v-for="entry in legend.agents"
                :key="entry.id"
                type="button"
                class="ui-chip min-w-0 max-w-full gap-1 transition-opacity"
                :class="[
                    originHue(entry.id).chip,
                    originFilter === entry.id ? 'shrink' : 'shrink-0',
                    originFilter !== undefined && originFilter !== entry.id ? 'opacity-40' : '',
                ]"
                @click="toggleOrigin(entry.id)"
                @mouseenter="showOrigins($event, [entry.id])"
                @mouseleave="hoverCard?.hide()"
                :aria-label="`${originFilter === entry.id ? `Clear the filter on` : `Show only`} ${originLabel(entry.id)}, ${plural(entry.files, `file`)}${
                    originMark(entry.id) ? `, ${originMark(entry.id)!.label.toLowerCase()}` : ``
                }${originDrafting(entry.id) ? `; its commit message is being written` : originTitle(entry.id) ? `; names the commit` : ``}`"
            >
                <!--
                    A dot before the logo means the session hasn't finished — its count above is an instalment, not a total.
                    Placed before the 11px logo, since the logo itself has no room to carry a mark.
                -->
                <span v-if="originMark(entry.id)" class="h-1.5 w-1.5 shrink-0 rounded-full" :class="originMark(entry.id)!.dot"></span>
                <!--
                    The same slot, spent on a different wait: the chip's commit-message sentence still being written. Pulses so it can't be mistaken
                    for the static unfinished dot.
                -->
                <span v-else-if="originDrafting(entry.id)" class="h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-60"></span>
                <ProviderLogo v-if="originProvider(entry.id)" :provider="originProvider(entry.id)!" class="shrink-0 text-2xs" />
                <Icon v-else name="sparkles" class="shrink-0 text-2xs" />
                <span v-if="originFilter === entry.id" class="min-w-0 truncate">{{ originLabel(entry.id) }}</span>
                <span class="shrink-0 opacity-70">{{ entry.files }}</span>
                <!--
                    The way out, drawn only on the chip that's hiding rows: a cross means "clear this" without a word, since
                    dimming the others signals a filter is on but not how to end it.
                -->
                <Icon v-if="originFilter === entry.id" name="times" class="shrink-0 text-[0.6rem] opacity-70" />
            </button>
            <button
                v-if="legend.yours > 0"
                type="button"
                class="ui-chip shrink-0 gap-1 transition-opacity"
                :class="originFilter !== undefined && originFilter !== YOURS ? 'opacity-40' : ''"
                @click="toggleOrigin(YOURS)"
                v-tooltip.right="'Your own edits, the terminal, a main-tree chat'"
            >
                you <span class="opacity-70">{{ legend.yours }}</span>
                <Icon v-if="originFilter === YOURS" name="times" class="shrink-0 text-[0.6rem] opacity-70" />
            </button>
        </div>

        <div class="scrollbar-thin min-h-0 flex-1 overflow-auto py-1">
            <p v-if="changes.loading.value && changes.count.value === 0" class="px-3 py-2 text-2xs text-subtle">Loading changes…</p>
            <!-- A clean tree says so explicitly, rather than leaving a mostly-empty column with nothing claiming the emptiness is the answer. -->
            <p v-else-if="changes.count.value === 0" class="px-3 py-2 text-2xs text-subtle">No uncommitted changes.</p>
            <!-- A lit chip over an empty list says so too — otherwise a filtered-to-nothing tree reads as having lost its files. -->
            <p v-else-if="dirty.length === 0 && filterLabel" class="px-3 py-2 text-2xs text-subtle">
                Nothing from {{ filterLabel }} is left in the tree.
            </p>

            <!--
                Repos git refused to scan still get a row (with git's own reason), rather than silently disappearing; no actions, since there's
                nothing to act on.
            -->
            <div v-for="group in unscannable" :key="group.repo" class="mt-1 px-1 first:mt-0">
                <!-- The triangle takes the chevron's slot, so an unreadable repo lines up with the readable ones instead of getting an extra glyph. -->
                <div class="flex min-w-0 items-center gap-1.5 rounded-md py-1.5 pl-1 pr-1">
                    <Icon name="exclamation-triangle" class="shrink-0 text-2xs text-danger" />
                    <span class="min-w-0 truncate text-xs font-medium text-content">{{ group.repo }}</span>
                </div>
                <div :class="[NOTICE, 'mb-1.5']">
                    <div class="min-w-0 flex-1">
                        <p class="text-2xs font-medium text-danger">Couldn't read this repo</p>
                        <p class="line-clamp-4 break-words text-2xs text-muted" v-tooltip.top.overflow="group.error">{{ group.error }}</p>
                    </div>
                </div>
            </div>

            <!--
                A committing repo's rows stay listed (genuinely still uncommitted) but dim, since acting on them would just queue behind the daemon's
                own repo lock.
            -->
            <div
                v-for="group in dirty"
                :key="group.repo"
                class="group/repo mt-1 px-1 transition-opacity first:mt-0"
                :class="changes.committing.value.includes(group.repo) && `pointer-events-none opacity-50`"
            >
                <!--
                    One row per repo, about the files under it: identity, then the sole side's rank/verb, then discard. Nothing
                    about the remote anymore — ahead/behind, publish and fetch all moved to the outgoing block above the list.
                -->
                <div class="ui-row-select flex items-center gap-1 rounded-md pr-1">
                    <button
                        type="button"
                        class="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pl-1 text-left max-md:min-h-11"
                        @click="toggleGroup(group.repo)"
                    >
                        <!-- The chevron is the whole lead now; a repository glyph beside it said only what the panel itself already says. -->
                        <Icon class="shrink-0 text-2xs text-subtle" :name="collapsed.has(group.repo) ? 'chevron-right' : 'chevron-down'" />
                        <!--
                            Both names truncate together, the branch three times as fast — it's the annotation, the repo is the heading,
                            so a squeezed row still reads as two ordered facts rather than one fact beside a naked glyph.
                        -->
                        <span class="min-w-0 truncate text-xs font-medium text-content" v-tooltip.top.overflow="group.repo">{{ group.repo }}</span>
                        <span v-if="group.branch !== undefined" class="flex min-w-0 max-w-24 shrink-3 items-center gap-0.5 text-2xs text-subtle">
                            <Icon name="fork" class="shrink-0 text-[0.6rem]" />
                            <!-- Both names truncate and both say the rest on hover (`.overflow`, so the tooltip only fires when actually cut). -->
                            <span class="min-w-0 truncate" v-tooltip.top.overflow="group.branch">{{ group.branch }}</span>
                        </span>
                    </button>

                    <!-- The sole side's name, count and verb as one cluster ("STAGED 2 ↺"); never drawn once a repo has two sides. -->
                    <span
                        v-if="soleSide(group)"
                        class="shrink-0 text-2xs font-medium uppercase tracking-wide"
                        :class="soleSide(group)!.side === 'conflicted' ? 'text-danger' : 'text-subtle'"
                        >{{ soleSide(group)!.label }}</span
                    >

                    <!-- A number, not a pill, and only where the rows it counts aren't already on screen — see showRepoCount. -->
                    <span v-if="showRepoCount(group)" class="shrink-0 px-0.5 text-2xs tabular-nums text-muted">{{ repoCount(group) }}</span>

                    <!-- The sole side's own verb, hoisted onto this row; with two sides it moves back to each side's own header. -->
                    <button
                        v-if="soleSide(group)"
                        type="button"
                        :class="[ICON_BUTTON, 'text-muted max-md:h-8 max-md:w-8']"
                        :disabled="changes.actionBusy.value"
                        v-action="() => stageSide(group, soleSide(group)!.side)"
                        v-tooltip.right="sideVerbHint(group, soleSide(group)!.side)"
                        :aria-label="`${sideVerbHint(group, soleSide(group)!.side)} in ${group.repo}`"
                    >
                        <Icon :name="INDEX_VERB[soleSide(group)!.side].icon" class="text-2xs" />
                    </button>
                    <button
                        type="button"
                        :class="[ICON_BUTTON, ROW_ACTION, 'max-md:h-8 max-md:w-8']"
                        :disabled="changes.actionBusy.value"
                        @click="askDiscardRepo(group)"
                        v-tooltip.top="'Discard all changes in this repo'"
                        aria-label="Discard all changes in this repo"
                    >
                        <Icon name="trash" class="text-2xs" />
                    </button>
                </div>

                <!-- A failed fetch/pull/push/discard/stage for this repo, under the row that caused it, in git's own words. -->
                <div v-if="failureIn(group.repo)" :class="[NOTICE, 'mb-1.5 mt-0.5']">
                    <Icon name="exclamation-triangle" class="mt-0.5 shrink-0 text-2xs text-danger" />
                    <div class="min-w-0 flex-1">
                        <p class="text-2xs font-medium text-danger">{{ failureIn(group.repo)!.action }}</p>
                        <p class="line-clamp-4 break-words text-2xs text-muted" v-tooltip.top.overflow="failureIn(group.repo)!.detail">
                            {{ failureIn(group.repo)!.detail }}
                        </p>
                    </div>
                    <button
                        type="button"
                        class="shrink-0 rounded p-0.5 text-muted transition-colors hover:text-content"
                        @click="changes.dismissFailure(group.repo)"
                        v-tooltip.right="'Dismiss'"
                        :aria-label="`Dismiss error for ${group.repo}`"
                    >
                        <Icon name="times" class="text-2xs" />
                    </button>
                </div>

                <!--
                    Why these files are conflicted, and the one way out: nothing this app runs leaves a repo mid-operation, so
                    this is always something a terminal left behind. Above the sections, since it explains the whole repo, not one side.
                -->
                <div v-if="group.operation" :class="[NOTICE, 'mb-1.5 mt-0.5 border-warning/40 bg-warning/10']">
                    <Icon name="exclamation-triangle" class="mt-0.5 shrink-0 text-2xs text-warning" />
                    <div class="min-w-0 flex-1">
                        <p class="text-2xs font-medium text-warning">A {{ group.operation }} is in progress</p>
                        <p class="text-2xs text-muted">
                            Resolve the conflicts and stage them to continue, or abort to return this repository to where the
                            {{ group.operation }} began.
                        </p>
                    </div>
                    <Button
                        size="small"
                        severity="warn"
                        class="shrink-0"
                        :disabled="changes.actionBusy.value"
                        @click="changes.abortOperation(group.repo)"
                        v-tooltip.top="'A restore point is saved first, so this is reversible from Restore points'"
                    >
                        Abort
                    </Button>
                </div>

                <!-- No empty-repo guard needed here — `dirty` is the list, and a repo with no rows isn't in it. -->
                <div v-if="!collapsed.has(group.repo)" class="pb-1 pl-1">
                    <!--
                        One block per git side (conflicts, staged, unstaged); the header's action is whole-side, ignoring selection.
                        Drawn only when there's more than one side — with one, the repo row above already states it.
                    -->
                    <template v-for="section in sidesOf(group)" :key="`${group.repo}/${section.side}`">
                        <div v-if="sidesSplit(group)" class="flex items-center gap-1 pl-2 pt-1">
                            <span
                                class="shrink-0 text-2xs font-medium uppercase tracking-wide"
                                :class="section.side === 'conflicted' ? 'text-danger' : 'text-subtle'"
                                >{{ section.label }}</span
                            >
                            <!-- The side's real length: rows shown plus whatever didn't fit, since the button here acts on the side, not the listing. -->
                            <span class="shrink-0 text-2xs text-subtle">{{ sideTotal(group, section.side, section.changes.length) }}</span>
                            <!-- The section's only module, said here instead of on its own row below it — see soleBucket. A label, not a control. -->
                            <ModuleLabel
                                v-if="soleBucket(group.repo, section.side)"
                                :name="soleBucket(group.repo, section.side)!.name"
                                :packaged="soleBucket(group.repo, section.side)!.packaged"
                            />
                            <span class="flex-1"></span>
                            <!--
                                Always drawn: what moves a row across the index stays on screen, what destroys work waits for a hover. A
                                lit chip only changes what this button promises (see the tooltip), not whether it's visible.
                            -->
                            <button
                                type="button"
                                :class="[ICON_BUTTON, 'max-md:h-8 max-md:w-8']"
                                :disabled="changes.actionBusy.value"
                                v-action="() => stageSide(group, section.side)"
                                v-tooltip.right="sideVerbHint(group, section.side)"
                                :aria-label="`${sideVerbHint(group, section.side)} in ${group.repo}`"
                            >
                                <Icon :name="INDEX_VERB[section.side].icon" class="text-2xs" />
                            </button>
                        </div>

                        <template v-for="bucket in viewOf(group.repo, section.side).buckets" :key="`${group.repo}/${section.side}/${bucket.key}`">
                            <!--
                                The module a run of rows belongs to, said once — the same ModuleLabel the agent review draws, so a module
                                reads the same in both lists. Its own count is gone: a module bucket has no fold, so its rows are always on screen
                                already.
                            -->
                            <div v-if="moduleRow(group, section.side)" class="flex items-center pt-2" :class="moduleIndent(group)">
                                <ModuleLabel :name="bucket.name" :packaged="bucket.packaged" />
                            </div>
                            <template v-for="change in bucket.rows" :key="`${group.repo}/${section.side}/${change.path}`">
                                <!--
                                    Selection uses the app's primary-tint recipe, not this list's own hover colour, so a selected row can't be
                                    mistaken for whatever the pointer happens to sit on. Hover keeps its own step above selection.
                                -->
                                <div
                                    class="group/file flex items-stretch gap-1 rounded transition-colors"
                                    :class="[
                                        isSelected({ repo: group.repo, side: section.side, path: change.path })
                                            ? 'bg-primary-500/15 hover:bg-primary-500/25'
                                            : 'ui-row-select',
                                        // One 8px step per rank that is actually drawn above this row, so a
                                        // filename never pays indent for a heading that isn't there.
                                        rowIndent(group, section.side),
                                    ]"
                                >
                                    <!--
                                        Indent guide and origin rail share one column (railClass), stretched the row's full height so a run of one
                                        agent's files reads as a single colour block rather than separate ticks.
                                    -->
                                    <span class="w-0.5 shrink-0 self-stretch rounded-full" :class="railClass(group, change.path)"></span>
                                    <button
                                        type="button"
                                        class="flex min-w-0 flex-1 items-center gap-1.5 py-0.5 pl-0.5 text-left max-md:min-h-11"
                                        @click="clickRow({ repo: group.repo, side: section.side, path: change.path }, change, $event)"
                                        @dblclick="openDiff(group.repo, section.side, change, 'keep')"
                                    >
                                        <ChangeStatusMark :status="change.status" />
                                        <!-- How a changed file is named, shared with the agent review's own rows — see ChangeRowName. -->
                                        <ChangeRowName
                                            :path="change.path"
                                            :label="changeLabel(group.repo, change)"
                                            :named="viewOf(group.repo, section.side).named"
                                        />
                                        <!--
                                            Provider chips (up to two, then a count); the name itself only once the panel is wide enough AND the file
                                            has one owner — the path keeps first claim on the width. Silent under a filter that already names this
                                            row's only origin.
                                        -->
                                        <span
                                            v-if="showRowOrigins(group, change.path)"
                                            class="flex shrink-0 items-center gap-0.5"
                                            @mouseenter="showOrigins($event, originsOf(group, change.path))"
                                            @mouseleave="hoverCard?.hide()"
                                        >
                                            <span
                                                v-if="wide && originsOf(group, change.path).length === 1"
                                                class="max-w-24 truncate text-2xs"
                                                :class="originHue(originsOf(group, change.path)[0]!).text"
                                            >
                                                {{ originLabel(originsOf(group, change.path)[0]!) }}
                                            </span>
                                            <span
                                                v-for="id in originsOf(group, change.path).slice(0, 2)"
                                                :key="id"
                                                class="flex h-3.5 w-3.5 items-center justify-center rounded-full"
                                                :class="originHue(id).chip"
                                            >
                                                <ProviderLogo v-if="originProvider(id)" :provider="originProvider(id)!" class="text-[0.55rem]" />
                                                <Icon v-else name="sparkles" class="text-[0.55rem]" />
                                            </span>
                                            <span v-if="originsOf(group, change.path).length > 2" class="text-2xs text-subtle">
                                                +{{ originsOf(group, change.path).length - 2 }}
                                            </span>
                                        </span>
                                        <!--
                                            `of` turns the badge into a size rail too, scaled to the panel's biggest addition, so the list can be
                                            ranked by scanning.
                                        -->
                                        <ReviewStat
                                            :code="change.code"
                                            :additions="change.additions"
                                            :deletions="change.deletions"
                                            :of="heaviest"
                                        />
                                    </button>
                                    <!--
                                        The index verb sits a step below the filename's own weight, so a hundred of them read as texture rather than
                                        a hundred buttons; not tinted, since green/red are already load-bearing on this row.
                                    -->
                                    <button
                                        type="button"
                                        :class="
                                            ui.iconButton(`h-5 w-5 self-center rounded text-subtle group-hover/file:text-muted max-md:h-8 max-md:w-8`)
                                        "
                                        :disabled="changes.actionBusy.value"
                                        v-action="() => stageRow({ repo: group.repo, side: section.side, path: change.path })"
                                        v-tooltip.top="INDEX_VERB[section.side].one"
                                        :aria-label="`${INDEX_VERB[section.side].one}: ${change.path}`"
                                    >
                                        <Icon :name="INDEX_VERB[section.side].icon" class="text-2xs" />
                                    </button>
                                    <!--
                                        Held a finger's width from the index verb on touch only: Discard confirms first and Stage doesn't, so the
                                        mis-tap that actually hurts is the one that lands on Stage instead of the trash.
                                    -->
                                    <button
                                        type="button"
                                        :class="
                                            ui.iconButton(
                                                `h-5 w-5 self-center rounded opacity-0 focus-visible:opacity-100 group-hover/file:opacity-100 max-md:ml-2 max-md:h-8 max-md:w-8 max-md:opacity-100`,
                                            )
                                        "
                                        :disabled="changes.actionBusy.value"
                                        @click="askDiscardRow({ repo: group.repo, side: section.side, path: change.path }, change)"
                                        v-tooltip.top="'Discard'"
                                        :aria-label="`Discard ${change.path}`"
                                    >
                                        <Icon name="trash" class="text-2xs" />
                                    </button>
                                </div>
                            </template>
                        </template>
                    </template>
                    <!--
                        The daemon's per-repo cap, said plainly so the list doesn't read as complete when it isn't. Every side/repo
                        verb below already sends a scope the daemon resolves itself, so the cap limits what you can read here, not what you can do.
                    -->
                    <p v-if="truncatedTotal(group) > 0" class="py-1 pl-4 text-2xs text-subtle">
                        …and {{ truncatedTotal(group) }} more: showing the first {{ repoCount(group) - truncatedTotal(group) }}. Stage all, commit and
                        discard cover every file here, listed or not.
                    </p>
                </div>
            </div>

            <!-- What other sandboxes are holding: a ledger of exposure you can't act on here, kept below and separate from this workspace's own rows. -->
            <OtherSandboxChanges />
        </div>

        <!-- States the two outcomes separately, since they're genuinely different: tracked files can come back from git, untracked ones can't. -->
        <Modal :open="pendingDiscard !== undefined" size="sm" header="Discard changes" @update:open="pendingDiscard = undefined">
            <template v-if="pendingDiscard">
                <p class="break-words text-xs text-content">Discard {{ pendingDiscard.what }}?</p>
                <!-- The counts below are a floor, said first: past the daemon's truncation this discard covers more than the dialog can list. -->
                <p v-if="pendingDiscard.partial" class="mt-2 text-xs text-warning">
                    More files are pending here than the panel is listing, and this covers all of them. The figures below count only the listed ones.
                </p>
                <!--
                    The verb agrees with the count (`plural`), since a lone file misreading as plural is the one line here that must be read
                    carefully.
                -->
                <p v-if="pendingDiscard.restores > 0" class="mt-2 text-xs text-muted">
                    {{ pendingDiscard.partial ? `At least ` : `` }}{{ plural(pendingDiscard.restores, "file") }}
                    {{ pendingDiscard.restores === 1 ? `returns` : `return` }} to their last committed state.
                </p>
                <div v-if="pendingDiscard.deletes.length > 0" class="mt-2">
                    <p class="text-xs text-danger">
                        {{ pendingDiscard.partial ? `At least ` : `` }}{{ plural(pendingDiscard.deletes.length, "untracked file") }}
                        {{ pendingDiscard.deletes.length === 1 ? `leaves` : `leave` }} the disk: they were never committed, so git has no copy:
                    </p>
                    <ul class="mt-1 max-h-24 overflow-auto">
                        <li v-for="path in pendingDiscard.deletes" :key="path" class="truncate font-mono text-2xs text-muted" dir="rtl">
                            <bdi>{{ path }}</bdi>
                        </li>
                    </ul>
                </div>
                <p class="mt-3 text-2xs text-subtle">
                    <Icon name="shield" class="mr-0.5 text-[0.6rem]" />A restore point is saved first, so this is reversible from Restore points.
                </p>
            </template>
            <template #footer>
                <Button size="small" severity="secondary" :text="true" label="Cancel" @click="pendingDiscard = undefined" />
                <Button size="small" severity="danger" label="Discard" :disabled="changes.actionBusy.value" @click="confirmDiscard" />
            </template>
        </Modal>

        <!-- The same card the chat tab strip raises for a session, mounted at body so it clears this sidebar's narrow column. -->
        <HoverCard ref="hoverCard" />
    </div>
</template>
