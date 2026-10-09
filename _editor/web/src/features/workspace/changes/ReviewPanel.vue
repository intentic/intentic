<script setup lang="ts">
import {
    isScratch,
    type GitChange,
    type GitDiffSide,
    type LandedMessage,
    type LandedMessageDraft,
    type RepoChanges,
    type RepoTarget,
} from "@intentic/sandbox-contract";
import {
    Button,
    type ButtonTier,
    ChangeStatusMark,
    clipboardOf,
    ContextMenu,
    formatElapsed,
    Modal,
    Notice,
    timeAgo,
    type Tip,
    toneWash,
    type TooltipValue,
    ui,
    useDevice,
    vAction,
} from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { useWorkspaceTabs } from "../tabs/useWorkspaceTabs";
import { computed, ref, watch } from "vue";
import ProviderLogo from "../../chat/accounts/ProviderLogo.vue";
import HoverCard from "../../chat/tabs/HoverCard.vue";
import ReviewStat from "./ReviewStat.vue";
import CommitField from "./commit/CommitField.vue";
import { clickIntent, rangeSelect } from "../../../lib/multiSelect";
import { rendersAsBytes } from "../explorer/fileType";
import { useAgents } from "../../agents/fleet/useAgents";
import { useChat } from "../../chat/run/useChat";
import { useLayout } from "../../../workbench/window/useLayout";
import { boxIsYours, commitMessage, followFilledMessage, nameCommitAfter, namedAfter } from "./commit/commitMessage";
import {
    ALL_SIDES,
    chipMessageNotice,
    commitMessageOf,
    draftRunning,
    isFrom,
    landedMessage,
    originHue,
    originsOf,
    summarizeOrigins,
    YOURS,
} from "./changeOrigins";
import { currentAction, unfinishedMark } from "../../agents/fleet/agentStatus";
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
import { useVocabulary } from "../../../workbench/views/vocabulary";
import { useT } from "@intentic/ui/i18n";
import type { MenuItem } from "primevue/menuitem";
import { changeRowMenuItems } from "./changeRowMenu";
import { useHome } from "../home/useHome";
import { useNotifications } from "../../../workbench/notifications/notifications";
import { formatChord, isApplePlatform } from "../../../workbench/commands/keybindings";

// VSCode's SCM pattern over the real repos: uncommitted work grouped by repo, then by git's staged/unstaged
// sides (a path can be on both with different content). Staging IS the selection — no checkboxes; git already
// has one selection mechanism (the index), so Commit records it. Built for a ~270px sidebar: one primary button per
// row, icons+tooltips for the rest.

const t = useT();

const changes = useChanges();
const words = useVocabulary();
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
const emit = defineEmits<{ "open-diff": [payload: DiffPayload, mode: OpenMode] }>();
// The body lands in the tabs store directly, not through the host: on a phone the host swaps this panel out for the
// viewer the moment the diff opens, and an emit from an unmounted panel reaches nobody.
const { fillDiff, openFile } = useWorkspaceTabs();

const collapsed = ref<ReadonlySet<string>>(new Set());
const toggleGroup = (repo: string): void => {
    const next = new Set(collapsed.value);
    if (!next.delete(repo)) {
        next.add(repo);
    }
    collapsed.value = next;
};

const changeLabel = (repo: string, change: GitChange): string => (repo === `root` ? change.path : `${repo}/${change.path}`);

// Per row: a colour rail plus a provider chip, since "did an agent touch this" is scanned before it's read.
// Per panel: a legend that IS the filter, not a grouping — a file two agents landed can't be grouped under one.
const { fleet } = useAgents();
// Read here for an origin chip's hover-card prompt, and below for which repos a main-tree turn is writing.
const { conversations } = useChat();
const { mobile } = useDevice();
const layout = useLayout();

// A phone keyboard has no Ctrl, so the shortcut hint moves to the button label instead.
const commitPlaceholder = computed(() => (mobile.value ? t(`workspace.reviewPanel.message`) : t(`workspace.reviewPanel.messageCtrlEnter`)));

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
const originLabel = (id: string): string => originTitle(id) ?? t(`workspace.reviewPanel.agentId`, { id: id.slice(0, 6) });
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
    const doing = currentAction(agent.activity);
    const since = agent.startedAt !== undefined ? formatElapsed((Date.now() - agent.startedAt) / 1000) : undefined;
    return [mark.label, turn, doing, since].filter((part) => part !== undefined && part !== ``).join(` · `);
};

// The session's landed-diff subject (drafted at land time), not its title — a title names the ask, the diff says
// what actually changed. Roster first (live, pushed instantly), then the review, same lookup order as identity above.
const landedOf = (id: string): LandedMessage | undefined => landedMessage(agentOf(id), originOf(id));
const originMessage = (id: string): string | undefined => commitMessageOf(landedOf(id));

// Every repo holding any of an origin's work, sent as a scope on one side that the daemon resolves against live status.
// Any side, not just the one moving: a click landing before the rescan from the last move still reaches its files,
// and a repo with none of them on that side answers with a no-op. A truncated repo is asked too, since its unlisted
// rows may be that origin's.
const originTargets = (id: string, side: GitDiffSide): readonly RepoTarget[] =>
    scannable.value
        .filter((repo) => truncatedTotal(repo) > 0 || ALL_SIDES.some((held) => repo[held].some((change) => isFrom(repo, change.path, id))))
        .map((repo) => ({ repo: repo.repo, scope: { side, origin: id } }));

// A chip is the "+" on one origin's work, not a view over it. Lighting it stages that work, clearing it unstages that
// work again, and moving to another chip swaps one for the other. Staging stays the only selection Commit reads, and
// the Staged list shows exactly what the commit will take. The lit chip still narrows the list and names the commit,
// recorded outside this component (nameCommitAfter) so the name holds after the panel closes. Conflicts are left
// alone: staging one marks it resolved, which no chip should do for the owner.
const toggleOrigin = async (id: string): Promise<void> => {
    const was = originFilter.value;
    const next = was === id ? undefined : id;
    originFilter.value = next;
    nameCommitAfter(next === YOURS ? undefined : next);
    // One after the other: the second batch would be dropped while the first holds the busy span.
    const out = was === undefined ? [] : originTargets(was, `staged`);
    if (out.length > 0) {
        await changes.stageGroups(out, false);
    }
    const into = next === undefined ? [] : originTargets(next, `unstaged`);
    if (into.length > 0) {
        await changes.stageGroups(into, true);
    }
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
// The lit chip's own report, for the box's placeholder and the progress mark inside the box (CommitField).
const filterDraft = computed<LandedMessageDraft | undefined>(() =>
    originFilter.value === undefined || originFilter.value === YOURS ? undefined : originDraft(originFilter.value),
);
// Both edges of the wait (it started, what became of it) are reported above this panel and outlive it
// (draftingReceipts.ts) — the wait begins on the /agents board and often outlasts a visit here.

// Raises the same card the chat tab strip does for a session, on hovering a chip (a row's, or the legend's).
const hoverCard = ref<InstanceType<typeof HoverCard> | null>(null);
// Includes attachments: a screenshot is often the whole of what was asked, and dropping it would misquote the prompt.
const firstPromptOf = (id: string): { text?: string; attachments?: readonly string[] } | undefined => {
    const conversation = conversations.value.find((c) => c.conversationId === id);
    const prompt = conversation?.transcript.messages.value.find((message) => message.role === `user`);
    return prompt === undefined ? undefined : { text: prompt.text, attachments: prompt.attachments };
};
const showOrigins = (event: MouseEvent, ids: readonly string[]): void => {
    // Two agents on one file is real but rare, and a single title can't say both, so the card lists them without a
    // prompt.
    const prompt = ids.length === 1 ? firstPromptOf(ids[0]!) : undefined;
    hoverCard.value?.show(
        event,
        ids.length === 1
            ? {
                  label: t(`workspace.reviewPanel.landedBy`),
                  title: originLabel(ids[0]!),
                  note: originNote(ids[0]!),
                  ...(prompt === undefined ? {} : { messages: [prompt] }),
              }
            : { label: t(`workspace.reviewPanel.landedBy`), title: ids.map((id) => originLabel(id)).join(`\n`) },
    );
};
// The name rides the row only once the panel is wide enough to hold it without evicting the path (or on mobile).
const wide = computed(() => mobile.value || layout.sidebarWidth.value >= 320);

// An origin chip's spoken name: what a press does, whose files and how many, whether the session is still going, and
// what the chip says about the commit message. Whole clauses, joined by punctuation, so none is a fragment of another.
const originChipLabel = (id: string, files: number): string => {
    const values = { origin: originLabel(id), count: files };
    const press =
        originFilter.value === id ? t(`workspace.reviewPanel.unstageFrom`, values, files) : t(`workspace.reviewPanel.stageFrom`, values, files);
    const mark = originMark(id)?.label.toLowerCase();
    const note = originDrafting(id)
        ? t(`workspace.reviewPanel.messageBeingWritten`)
        : originTitle(id) === undefined
          ? undefined
          : t(`workspace.reviewPanel.namesTheCommit`);
    const head = mark === undefined ? press : `${press}, ${mark}`;
    return note === undefined ? head : `${head}; ${note}`;
};

// The lit chip in words, for every sentence naming the filter's scope; undefined means no filter, not "nobody".
const filterLabel = computed<string | undefined>(() =>
    originFilter.value === undefined ? undefined : originFilter.value === YOURS ? t(`workspace.reviewPanel.you`) : originLabel(originFilter.value),
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
    return originFilter.value === undefined || isFrom(repo, change.path, originFilter.value);
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

// Sides in git's order (conflicts block everything, then staged, then unstaged); an empty section renders
// nothing. The origin filter is applied here once, so every row, verb and count downstream inherits it for free.
// Except on Staged: that side is exactly what Commit records whenever it holds anything, so hiding part of it let a
// filtered commit take files nobody could see.
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
                    { side: `conflicted` as const, label: t(`workspace.reviewPanel.conflicts`), changes: repo.conflicted },
                    { side: `staged` as const, label: t(`workspace.reviewPanel.staged2`), changes: repo.staged },
                    { side: `unstaged` as const, label: t(`workspace.reviewPanel.unstaged`), changes: repo.unstaged },
                ].flatMap((section) => {
                    const shown = section.side === `staged` ? section.changes : section.changes.filter((change) => matchesFilter(repo, change));
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
// tree). Read through `sidesOf`, so the origin filter also drops repos that agent never touched, unless something
// there is staged.
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

// The panel's one indent grid, 8px gutter and 16px per rank. Every leading glyph (chevron, spinner, module box, status
// letter) sits in this 10px slot, centred whatever the glyph's own width, and the label follows at the row's 6px gap.
// So each rank's slot starts exactly where its parent's label does, and the push run's spinner on the action bar shares
// the chevrons' column instead of hanging 1px off it.
const LEAD = `flex w-2.5 shrink-0 items-center justify-center`;
// A line on the action bar that matters (a blocker, a press under way). It keeps a floor of width, so in a narrow box the
// buttons wrap under it rather than truncating it away.
const BAR_LINE = `min-w-0 flex-1 basis-28 truncate whitespace-nowrap text-2xs`;
// The trailing glyphs (stage verb, discard) are one size on every row, so their columns run straight down from the
// repo row through a side header to each file. A row missing one keeps its place with GLYPH_GAP.
const rowGlyph = (tone: `muted` | `subtle` = `muted`, ...classes: string[]): string =>
    ui.iconButton({ size: mobile.value ? `lg` : `xs`, tone }, `shrink-0 disabled:opacity-40`, ...classes);
const GLYPH_GAP = `w-5 shrink-0 max-md:w-8`;
// Discard sits a touch further off on touch, so it can't be hit for the unconfirmed Stage beside it.
const DISCARD_GAP = `max-md:ml-2`;

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
    void changes.fileDiff(repo, change.path, side).then((body) => fillDiff({ ...tab, ...body }));
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
    const intent = clickIntent(event, anchor.value !== undefined && keys.includes(anchor.value));
    if (intent === `range`) {
        selected.value = new Set(rangeSelect(keys, anchor.value, key) ?? [key]);
        return;
    }
    if (intent === `toggle`) {
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

// "Commit all": fires only when nothing is staged anywhere, no chip is lit, and there's work to record (VSCode's
// stage-all-and-commit, made explicit), so every file it takes is on screen. Under a lit chip Commit records the index
// alone, which the chip itself filled: a stage-first there would take files the list still shows as unstaged.
const stagesFirst = computed(() => stagedRepos.value.length === 0 && changes.count.value > 0 && originFilter.value === undefined);
// A scope, not an enumerated list: the daemon resolves which files answer to a side/origin from the repo's own
// status, so this isn't capped by what the review actually listed (RepoChanges.truncated). Staged is never filtered
// (sidesByRepo), so its verb moves the whole side it shows.
const scoped = (repo: string, side?: GitDiffSide): RepoTarget => ({
    repo,
    scope: {
        ...(side !== undefined ? { side } : {}),
        ...(originFilter.value !== undefined && side !== `staged` ? { origin: originFilter.value } : {}),
    },
});
// What Commit records, one whole-repo target per repo: the staged repos, or every repo for "Commit all".
const commitGroups = computed<readonly RepoTarget[]>(() =>
    stagesFirst.value ? scannable.value.map((repo) => ({ repo: repo.repo })) : stagedRepos.value.map((repo) => ({ repo })),
);
const commitTarget = computed(() => commitGroups.value.map((group) => group.repo));
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
// A plain Commit carries its staged count beside the label; the stage-first press says "all" instead.
const commitLabel = computed(() => (stagesFirst.value ? t(`workspace.reviewPanel.commitAll`) : t(`workspace.reviewPanel.commit`)));

// The commit button's hover: what the press will record, and the chord that presses it from the box. Nothing while it
// runs, since the readout beside it already names the repos being committed.
const COMMIT_KEYS = formatChord(`Mod+Enter`, isApplePlatform());
const conflictedCount = computed(() => scannable.value.reduce((total, repo) => total + repo.conflicted.length, 0));
const commitTip = computed((): Tip | undefined => {
    const keys = mobile.value ? undefined : COMMIT_KEYS;
    if (commitRunning.value) {
        return undefined;
    }
    if (blockedByConflicts.value) {
        return {
            title: t(`workspace.reviewPanel.conflicts`),
            tone: `danger`,
            rows: [{ label: t(`shared.files`), value: conflictedCount.value }],
            note: t(`workspace.reviewPanel.stageToResolve`),
        };
    }
    if (stagesFirst.value) {
        return { title: t(`workspace.reviewPanel.stageAllFirst`), keys, rows: [{ label: t(`shared.changes`), value: changes.count.value }] };
    }
    const spread = stagedRepos.value.length > 1;
    return {
        title: spread
            ? `${t(`workspace.reviewPanel.commit`)} ${t(`workspace.reviewPanel.repos`, { count: stagedRepos.value.length }, stagedRepos.value.length)}`
            : t(`workspace.reviewPanel.commit`),
        keys,
        rows: [{ label: t(`shared.files`), value: changes.stagedCount.value }],
        note: spread ? t(`workspace.reviewPanel.onePerRepo`) : undefined,
    };
});

// Sessions this commit would record, and which are still running — scoped exactly like the button. A
// warning, not a gate: staging part of an unfinished agent's work is ordinary, and `reset --soft` undoes it.
const commitOrigins = computed(
    () =>
        summarizeOrigins(
            scannable.value.filter((repo) => commitTarget.value.includes(repo.repo)),
            stagesFirst.value ? ALL_SIDES : [`staged`],
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
                .filter((conversation) => !conversation.isolated.value && conversation.turn.streaming.value)
                .flatMap((conversation) =>
                    [...turnWrites(conversation.conversationId, conversation.turn.turnStartedAt.value)].map((path) =>
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
        return t(`workspace.reviewPanel.blockedByConflicts`);
    }
    // Checked ahead of "nothing to commit": mid-commit the rows are still listed, so this is the honest reason, not a
    // count about to change.
    if (commitRunning.value) {
        return t(`workspace.reviewPanel.stillCommitting`, { repos: committingNow.value.join(`, `) });
    }
    if (commitTarget.value.length === 0) {
        return t(`workspace.reviewPanel.nothingToCommit`);
    }
    if (commitMessage.value.trim().length === 0) {
        return t(`workspace.reviewPanel.writeMessageFirst`);
    }
    return changes.actionBusy.value ? t(`workspace.reviewPanel.anotherGitAction`) : undefined;
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

// `staged` is the one side moving OUT of the index; the other two move in — a conflict's inward move is `git add`,
// resolving it.
const movesIntoIndex = (side: GitDiffSide): boolean => side !== `staged`;
// Read through `sidesOf`, so a section verb can only ever touch the rows that section is actually showing.
const changesOn = (repo: RepoChanges, side: GitDiffSide): readonly GitChange[] =>
    sidesOf(repo).find((section) => section.side === side)?.changes ?? [];

// What the inward/outward index move is called, per side: a conflict says "resolve", not "stage" — `git add`
// on an unmerged path settles a merge, it doesn't put a change in the index.
const INDEX_VERB = computed<Record<GitDiffSide, { readonly one: string; readonly all: string; readonly icon: "plus" | "minus" | "check" }>>(() => ({
    conflicted: { one: t(`workspace.reviewPanel.markResolved`), all: t(`workspace.reviewPanel.resolveAll`), icon: `check` },
    unstaged: { one: t(`workspace.reviewPanel.stage`), all: t(`workspace.reviewPanel.stageAll`), icon: `plus` },
    staged: { one: t(`workspace.reviewPanel.unstage`), all: t(`workspace.reviewPanel.unstageAll`), icon: `minus` },
}));

// The filter a side's verb answers to: none on Staged, which the filter never narrows.
const sideFilter = (side: GitDiffSide): string | undefined => (side === `staged` ? undefined : filterLabel.value);

// Names whose files it moves, under a filter — the button no longer means "this whole side". Drops the
// count wherever the daemon truncated, since a fraction is a worse promise than none.
const sideVerbHint = (repo: RepoChanges, side: GitDiffSide): string => {
    const verb = INDEX_VERB.value[side].all;
    const origin = sideFilter(side);
    if (origin === undefined) {
        return verb;
    }
    const count = changesOn(repo, side).length;
    return truncatedOn(repo, side) > 0
        ? t(`workspace.reviewPanel.verbEveryFileFrom`, { verb, origin })
        : t(`workspace.reviewPanel.verbFilesFrom`, { verb, count, origin }, count);
};
// The same verb on hover: the bare verb unfiltered, or a card naming whose files it moves and how many.
const sideVerbTip = (repo: RepoChanges, side: GitDiffSide): TooltipValue =>
    sideFilter(side) === undefined
        ? INDEX_VERB.value[side].all
        : {
              title: INDEX_VERB.value[side].all,
              rows: [
                  { label: t(`workspace.reviewPanel.from`), value: sideFilter(side) ?? `` },
                  { label: t(`shared.files`), value: truncatedOn(repo, side) > 0 ? `` : changesOn(repo, side).length },
              ],
          };

// Row action: moves the acting rows across the index, in the direction their side implies.
const stageRow = (row: Row): Promise<void> => changes.stageGroups(byRepo(actingRows(row, true)), movesIntoIndex(row.side));
// Section action: the whole side, sent as a scope rather than the rows drawn — the change that ended staging
// a truncated repo five hundred files at a time.
const stageSide = (repo: RepoChanges, side: GitDiffSide): Promise<void> => changes.stageGroups([scoped(repo.repo, side)], movesIntoIndex(side));

// The row's right-click menu (changeRowMenu.ts). Like the explorer's: right-clicking outside the selection collapses it
// to that row, inside a multi-selection keeps it, and the verbs then act on the whole selection.
const panelEl = ref<HTMLElement>();
const rowMenu = ref<{ show: (event: Event) => void }>();
const menuRow = ref<{ row: Row; change: GitChange } | undefined>(undefined);
const home = useHome();
const { say } = useNotifications();

// Reached through this panel's root so a popped-out window writes its own clipboard; unavailability is swallowed.
const copyLines = (lines: readonly string[]): void =>
    void clipboardOf(panelEl.value)
        .writeText(lines.join(`\n`))
        .then(() => say(t(`workspace.fileVerbs.pathCopied`)))
        // allow(silent-catch): a clipboard the page may not write (no focus, no permission) is the only failure, and the missing "copied" says so.
        .catch(() => undefined);
// Distinct paths, in the order drawn: a file staged and edited again is two rows over one path.
const distinctPaths = (rows: readonly Row[], label: (row: Row) => string): string[] => [...new Set(rows.map(label))];
const workspacePath = (row: Row): string => (row.repo === `root` ? row.path : `${row.repo}/${row.path}`);

const rowMenuItems = computed<MenuItem[]>(() => {
    const target = menuRow.value;
    if (target === undefined) {
        return [];
    }
    const { row, change } = target;
    const all = actingRows(row, false);
    const multi = all.length > 1;
    const paths = distinctPaths(all, workspacePath);
    return changeRowMenuItems({
        multi,
        paths: paths.length,
        sameSide: actingRows(row, true).length,
        indexVerb: INDEX_VERB.value[row.side].one,
        indexIcon: INDEX_VERB.value[row.side].icon,
        deleted: change.status === `deleted`,
        // Any acting row in a nested repo: a root repo's paths are already workspace paths.
        nested: all.some((candidate) => candidate.repo !== `root`),
        busy: changes.actionBusy.value,
        verbs: {
            openChanges: () => openDiff(row.repo, row.side, change, `keep`),
            openFile: () => openFile(workspacePath(row), `keep`),
            // The explorer reveals the current entry, so picking it and showing the tree is the whole move.
            reveal: () => {
                home.pick(workspacePath(row), `file`);
                layout.setSidebarPanel(`files`);
            },
            stage: () => void stageRow(row),
            discard: () => askDiscardRow(row, change),
            copyPath: () => copyLines(paths),
            copyRepoPath: () => copyLines(distinctPaths(all, (candidate) => candidate.path)),
        },
    });
});
const openRowMenu = (event: MouseEvent, row: Row, change: GitChange): void => {
    event.preventDefault();
    const key = rowKey(row);
    if (!selected.value.has(key)) {
        selected.value = new Set([key]);
        anchor.value = key;
    }
    menuRow.value = { row, change };
    rowMenu.value?.show(event);
};

// A modal confirm, like every other destructive git action here. The target is resolved when the user arms
// it, so the prompt's wording and the action can never disagree with a poll landing in between.
interface DiscardTarget {
    // The whole heading, one message per scope ("Discard every uncommitted change in intentic?", "Discard 3 selected
    // files?"), so a translation words each question itself instead of wrapping an English phrase.
    readonly question: string;
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
        question:
            paths > 1
                ? t(`workspace.reviewPanel.discardSelected`, { count: paths }, paths)
                : t(`workspace.reviewPanel.discard3`, { what: changeLabel(row.repo, change) }),
        deletes,
        restores: paths - deletes.length,
        // A selection is exactly as long as the rows clicked, so it's never a floor.
        partial: false,
        groups,
    };
};

// A repo-wide discard's question: everything, or the filtered origin's files (yours, or an agent's), counted unless
// truncation hides some.
const discardRepoQuestion = (repo: string, files: number, partial: boolean): string => {
    const origin = filterLabel.value;
    if (origin === undefined) {
        return t(`workspace.reviewPanel.discardEveryChange`, { repo });
    }
    if (originFilter.value === YOURS) {
        return partial
            ? t(`workspace.reviewPanel.discardEveryFileOfYours`, { repo })
            : t(`workspace.reviewPanel.discardFilesOfYours`, { count: files, repo }, files);
    }
    return partial
        ? t(`workspace.reviewPanel.discardEveryFileFrom`, { origin, repo })
        : t(`workspace.reviewPanel.discardFilesFrom`, { count: files, origin, repo }, files);
};

// Narrows to the filtered origin's files under a filter — the row it hangs off is showing that subset only.
// Both shapes are scopes now, so the filtered discard also reaches that session's files past the panel's truncation
// budget.
// Whether a repo-wide discard has anything to take: a repo the filter shows only for its staged rows has none of the
// filter's own files.
const discardable = (repo: RepoChanges): boolean =>
    originFilter.value === undefined || sidesOf(repo).some((section) => section.changes.some((change) => matchesFilter(repo, change)));

const askDiscardRepo = (repo: RepoChanges): void => {
    // Distinct paths: a path staged and edited again is two rows but one file on disk, and this counts disk effect.
    // Only the filter's own: the staged rows from other work it leaves on screen are not in the scope this discards.
    const paths = new Set(
        sidesOf(repo).flatMap((section) => section.changes.filter((change) => matchesFilter(repo, change)).map((change) => change.path)),
    );
    const deletes = repo.unstaged.filter((change) => change.status === `added` && paths.has(change.path)).map((change) => change.path);
    const partial = truncatedTotal(repo) > 0;
    pendingDiscard.value = {
        question: discardRepoQuestion(repo.repo, paths.size, partial),
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
// Icons match the arrows on the counts the button carries (↑ push, ↓ pull), so the two read as one language. Straight arrows, since the
// diagonal one means "open elsewhere" across the app.
// The button's hover (`syncTip`) adds what the label can't: which repos, and the replay caveat when pulling.
// `running` is the word the status line says while the verb is in flight.
const SYNC_VERB = computed<
    Record<
        "push" | "pull" | "sync" | "publish",
        { readonly label: string; readonly running: string; readonly icon: "arrow-up" | "arrow-down" | "sync" | "cloud-upload" }
    >
>(() => ({
    push: { label: words.value.push, running: words.value.pushing, icon: `arrow-up` },
    pull: { label: t(`workspace.reviewPanel.pull`), running: t(`workspace.reviewPanel.pulling`), icon: `arrow-down` },
    sync: { label: words.value.sync, running: words.value.syncing, icon: `sync` },
    publish: { label: words.value.publish, running: words.value.publishing, icon: `cloud-upload` },
}));
const syncMeta = computed(() => (syncVerb.value === undefined ? undefined : SYNC_VERB.value[syncVerb.value]));
// Counts plus the repo spread when more than one is in play; a pure publish has nothing to count.
const syncSummary = computed<string>(() => {
    const counts = [...(behindTotal.value > 0 ? [`↓${behindTotal.value}`] : []), ...(aheadTotal.value > 0 ? [`↑${aheadTotal.value}`] : [])];
    const spread = syncRepos.value.length > 1 ? t(`workspace.reviewPanel.repos`, { count: syncRepos.value.length }, syncRepos.value.length) : ``;
    return (counts.length > 0 ? counts.join(` `) : t(`workspace.reviewPanel.noUpstreamYet`)) + spread;
});
// Every push funnels through `pushFlow.askSync` (the bar and both row pills), the one place a refusal becomes a
// question, which is also why useChanges exports no one-repo push.

// One line, the width this ~270px panel can spend on status.
const stageLine = computed<string | undefined>(() => {
    if (pushFlow.running.value) {
        // The run carries the label it was asked with; the verb that label belongs to says its running word.
        const verb = pushFlow.pending.value?.verb;
        const running = Object.values(SYNC_VERB.value).find((entry) => entry.label === verb)?.running ?? SYNC_VERB.value.push.running;
        return t(`workspace.reviewPanel.runningFor`, { running, elapsed: formatElapsed((now.value - pushFlow.since.value) / 1000) });
    }
    const sent = pushFlow.pushed.value;
    return sent === undefined ? undefined : t(`workspace.reviewPanel.pushedWhat`, { what: sent.what });
});

// The one fact the line has no room for: what is going out, spelled out on a phone, which has no hover. Undefined once
// nothing is in flight.
const stageHint = computed<string | undefined>(() =>
    pushFlow.running.value
        ? t(`workspace.reviewPanel.sendingWhat`, { what: pushFlow.pending.value?.what ?? t(`workspace.reviewPanel.yourCommits`) })
        : undefined,
);

/* Closing a card hides its question but does not change the verdict. */
const heldLine = computed<string | undefined>(() => {
    const held = pushFlow.held.value;
    return held === undefined ? undefined : `${held.question.title} · ${timeAgo(held.at, { now: now.value })}`;
});

// The same fact as a card, where there is a pointer to raise it.
const stageTip = computed((): Tip | undefined =>
    pushFlow.running.value
        ? { title: t(`ui.status.sending`), rows: [{ label: t(`workspace.reviewPanel.toRemote`), value: pushFlow.pending.value?.what ?? `` }] }
        : undefined,
);

// What the press shows, and what the button beside it does instead.
const heldTip = computed((): Tip | undefined => {
    const held = pushFlow.held.value;
    return held === undefined
        ? undefined
        : {
              title: t(`workspace.reviewPanel.whatHappened`),
              rows: [{ label: t(`workspace.reviewPanel.command`), value: held.question.command ?? `` }],
              note: t(`workspace.reviewPanel.retriesWithHooks`, { verb: syncMeta.value?.label ?? words.value.push }),
          };
});

// The offer and the run are one control in three states, not stacked rows — the control that was clicked is the
// control that reports, and the one that keeps reporting after the answer was closed. Also the only place sync is
// mentioned now; the per-row pills it replaced turned every repo row into a remote dashboard.
const outgoing = computed<"flow" | "held" | "offer" | undefined>(() =>
    stageLine.value !== undefined ? `flow` : heldLine.value !== undefined ? `held` : syncMeta.value !== undefined ? `offer` : undefined,
);
// Commit and the sync share one bar under the message field, so the box stands whenever either has something to say.
const actionBar = computed(() => changes.count.value > 0 || outgoing.value !== undefined);
// Commit keeps the primary slot while there's anything to record, so the two buttons are never both full-weight.
const syncTier = computed<ButtonTier>(() => (changes.count.value > 0 ? `boring` : `accent`));
// The button carries the bare count, as Commit does; its hover says which way each number goes and which repos it
// spans. The replay caveat rides here too — the one thing about this verb a user can be surprised by.
const syncTip = computed((): Tip => ({
    title: syncMeta.value?.label ?? words.value.sync,
    rows: [
        ...(aheadTotal.value > 0 ? [{ label: t(`workspace.reviewPanel.notPushed`), value: aheadTotal.value }] : []),
        ...(behindTotal.value > 0 ? [{ label: t(`workspace.reviewPanel.toPull`), value: behindTotal.value }] : []),
        {
            label: t(`workspace.reviewPanel.repoLabel`, {}, syncRepos.value.length),
            value: syncRepos.value.map((repo) => repo.repo).join(`, `),
        },
    ],
    note: behindTotal.value > 0 ? t(`workspace.reviewPanel.rebasesNeverMerges`) : undefined,
}));
// Every repo with a remote — the honest scope for a verb whose whole job is proving a stale zero wrong.
const fetchable = computed(() => scannable.value.filter((repo) => syncable(repo)).map((repo) => repo.repo));
const fetchTip = computed((): Tip => ({
    title: t(`workspace.reviewPanel.fetch`),
    rows: [{ label: t(`workspace.reviewPanel.repoLabel`, {}, fetchable.value.length), value: fetchable.value.length }],
}));

// Deliberately no rules of its own: the view header above already draws the one line this column gets. Blocks
// are told apart by their own padding; a control with its own edge (the field, the button) carries what a rule would
// have.
// What a sync sends, named in "Pushed …" and "Sending … to the remote": the commits (or the branch), and across how many
// repos. A noun phrase, which each language's sentence around it takes whole.
const syncWhat = (): string => {
    const commits =
        aheadTotal.value > 0
            ? t(`workspace.reviewPanel.commitCount`, { count: aheadTotal.value }, aheadTotal.value)
            : t(`workspace.reviewPanel.thisBranch`);
    const spread = syncRepos.value.length;
    return spread > 1 ? t(`workspace.reviewPanel.whatAcrossRepos`, { what: commits, count: spread }, spread) : commits;
};

// One click, every repo with remote work: git can't span remotes, so this fans out into one real sync per repo.
const doSync = (): void =>
    pushFlow.askSync(
        syncMeta.value?.label ?? words.value.sync,
        syncWhat(),
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

// Each rank that is actually DRAWN (side, module) pushes the rows below it one 16px step (see LEAD); a rank that isn't
// drawn costs nothing, so a shallow list (one repo, one side, no grouping) stays shallow instead of indenting for
// headings that aren't there. Measured from the repo block's 4px inset, so rank 0 lands on the repo name's column (24px).
const RANK_INDENT: readonly string[] = [`pl-5`, `pl-9`, `pl-13`];
const rowIndent = (repo: RepoChanges, side: GitDiffSide): string =>
    RANK_INDENT[(sidesSplit(repo) ? 1 : 0) + (moduleRow(repo, side) ? 1 : 0)] ?? `pl-13`;
// The module heading sits one step above its rows, on whichever step the side header left free.
const moduleIndent = (repo: RepoChanges): string => (sidesSplit(repo) ? `pl-9` : `pl-5`);

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
</script>

<template>
    <div ref="panelEl" class="flex min-h-0 flex-1 flex-col">
        <!-- No header row of its own: the mode switch above already reads "Changes" with the count. -->

        <!-- The one genuinely panel-wide failure: the review set itself couldn't be read, so nothing below is trustworthy. -->
        <Notice v-if="changes.error.value" tone="danger" size="sm" class="mx-2 mt-2 shrink-0">
            <span class="block font-medium">{{ t(`workspace.reviewPanel.couldntReadChanges`) }}</span>
            <span class="block break-words text-muted">{{ changes.error.value }}</span>
        </Notice>

        <!-- Commit box first (VSCode's placement). It records the index — staging is the selection. Commit and the sync
             share one bar under the field, so the box costs the field and a single row of presses. A container, so the
             bar thins against its own width (sidebar, phone or pop-out) rather than the window's. -->
        <div v-if="actionBar" class="@container flex shrink-0 flex-col gap-1.5" :class="changes.count.value > 0 ? `p-2` : `px-2 py-1.5`">
            <!-- The lit chip's message being written, or why none was, reports inside the field it is filling. -->
            <CommitField
                v-if="changes.count.value > 0"
                v-model="commitMessage"
                :placeholder="chipNotice ?? commitPlaceholder"
                :draft="filterDraft"
                :draft-title="filterLabel"
                @submit="doCommit"
            />
            <!-- The bar's own width says the one thing its buttons can't, most pressing first: what stops Commit, a press
                 under way, why Ctrl+Enter refused, the push in flight or just done, why the lit chip left the box alone,
                 and last what the sync spans. A line that matters keeps a floor (basis), so a narrow box wraps the buttons
                 under it rather than cutting it to nothing; at rest there is no line, and the bar never wraps. -->
            <div class="flex flex-wrap items-center justify-end gap-x-1 gap-y-1.5">
                <span v-if="changes.count.value > 0 && blockedByConflicts" :class="BAR_LINE" class="text-danger">
                    {{ t(`workspace.reviewPanel.resolveConflictsFirst`) }}
                </span>
                <!-- Where the commit is happening — the one thing the button beside it can't say. -->
                <span v-else-if="commitRunning" :class="BAR_LINE" class="text-muted">{{
                    t(`workspace.reviewPanel.committingNow`, { repos: committingNow.join(`, `) })
                }}</span>
                <!-- Why Ctrl+Enter just refused: takes the line, since it answers the question the line is for. -->
                <span v-else-if="blockerNotice" :class="BAR_LINE" class="text-warning" v-tooltip.right.overflow="blockerNotice">
                    {{ blockerNotice }}
                </span>
                <!-- The push in flight, in the place its button left: the run's clock, or what just went out. -->
                <span
                    v-else-if="outgoing === `flow`"
                    class="flex min-w-0 flex-1 basis-28 items-center gap-1.5 text-2xs text-muted"
                    v-tooltip.right="mobile ? undefined : stageTip"
                >
                    <span :class="LEAD">
                        <Icon
                            :name="pushFlow.running.value ? `spinner` : `check-circle`"
                            :spin="pushFlow.running.value"
                            :class="pushFlow.running.value ? `text-link` : `text-success`"
                        />
                    </span>
                    <span v-if="mobile && stageHint" class="flex min-w-0 flex-1 flex-col">
                        <span class="truncate whitespace-nowrap">{{ stageLine }}</span>
                        <span class="truncate whitespace-nowrap font-mono text-3xs text-subtle">{{ stageHint }}</span>
                    </span>
                    <span v-else class="min-w-0 flex-1 truncate whitespace-nowrap">{{ stageLine }}</span>
                </span>
                <!-- The lit chip's answer, for the one case the placeholder can't show: the box holds the user's own text. -->
                <span
                    v-else-if="changes.count.value > 0 && boxIsYours && chipNotice"
                    :class="BAR_LINE"
                    class="text-muted"
                    v-tooltip.right.overflow="chipNotice"
                >
                    {{ chipNotice }}
                </span>
                <!-- What the sync button can't carry: a branch with no upstream to count against. Context, not a reason, so
                     it gives way to the buttons rather than wrapping them. How many repos a press spans is the button's
                     tooltip's to say, not a line of its own. -->
                <span
                    v-else-if="outgoing === `offer` && behindTotal === 0 && aheadTotal === 0"
                    class="flex min-w-0 flex-1 items-center gap-1.5 text-2xs text-subtle"
                >
                    <span class="truncate whitespace-nowrap">{{ t(`workspace.reviewPanel.noUpstreamYet`) }}</span>
                </span>
                <span v-else class="flex-1"></span>
                <div class="ml-auto flex shrink-0 items-center gap-1">
                    <!-- Show terminal controls only when a terminal exists. -->
                    <button
                        v-if="outgoing === `flow` && pushFlow.running.value && pushFlow.terminal.value !== undefined"
                        type="button"
                        :class="[ICON_BUTTON, 'max-md:h-8 max-md:w-8']"
                        @click="pushFlow.showTerminal"
                        v-tooltip.top="t(`workspace.reviewPanel.watchRun`)"
                        :aria-label="t(`workspace.reviewPanel.watchRun`)"
                    >
                        <Icon name="terminal" class="text-2xs" />
                    </button>
                    <!-- Fetch lives with the number it refreshes, and there's one of it now: its scope is every repo with a
                         remote. A cloud, not ↻, which the view header already spends on rescanning the tree. -->
                    <button
                        v-if="outgoing === `offer`"
                        type="button"
                        :class="[ICON_BUTTON, 'max-md:h-8 max-md:w-8']"
                        :disabled="changes.actionBusy.value"
                        @click="changes.fetchRepos(fetchable)"
                        v-tooltip.top="fetchTip"
                        :aria-label="t(`workspace.reviewPanel.fetchEveryRepo`)"
                    >
                        <Icon name="cloud-download" class="text-2xs" />
                    </button>
                    <!-- The commit action reports progress while stages, hooks, and reads run. -->
                    <Button
                        v-if="changes.count.value > 0"
                        size="small"
                        tone="success"
                        thumb
                        class="shrink-0 whitespace-nowrap"
                        :disabled="!commitReady"
                        @click="doCommit"
                        v-tooltip.right="commitTip"
                    >
                        <Icon :name="commitRunning ? `spinner` : `check`" :spin="commitRunning" />{{
                            commitRunning ? t(`workspace.reviewPanel.committing`) : commitLabel
                        }}
                        <!-- What a plain Commit records, said on the press itself rather than in a readout beside it. -->
                        <span v-if="!commitRunning && !stagesFirst && changes.stagedCount.value > 0" class="tabular-nums opacity-70">{{
                            changes.stagedCount.value
                        }}</span>
                    </Button>
                    <!-- After Commit, in the order the two happen. The flow owns the bar's line while it runs, so Push has
                         no separate disabled state. Its word gives way first in a narrow box: the arrow and the count
                         carry it, and the hover and the spoken name keep the whole of it. -->
                    <Button
                        v-if="(outgoing === `offer` || outgoing === `held`) && syncMeta"
                        size="small"
                        :tier="syncTier"
                        class="shrink-0 whitespace-nowrap"
                        :disabled="changes.actionBusy.value"
                        v-tooltip.bottom="syncTip"
                        :aria-label="`${syncMeta.label} ${syncSummary}`"
                        @click="doSync"
                    >
                        <Icon :name="syncMeta.icon" /><span class="hidden @2xs:inline">{{ syncMeta.label }}</span>
                        <!-- How much the press moves, on the press itself. One direction needs only the number, since the
                             verb and its arrow already say which way; Sync moves both, so each number keeps its arrow. -->
                        <span v-if="syncVerb === `sync`" class="inline-flex items-center gap-1 tabular-nums opacity-70" aria-hidden="true">
                            <span class="inline-flex items-center"><Icon name="arrow-down" class="text-3xs" />{{ behindTotal }}</span>
                            <span v-if="aheadTotal > 0" class="inline-flex items-center"><Icon name="arrow-up" class="text-3xs" />{{ aheadTotal }}</span>
                        </span>
                        <span v-else-if="syncVerb === `push` && aheadTotal > 0" class="tabular-nums opacity-70" aria-hidden="true">{{ aheadTotal }}</span>
                        <span v-else-if="syncVerb === `pull`" class="tabular-nums opacity-70" aria-hidden="true">{{ behindTotal }}</span>
                    </Button>
                </div>
            </div>
            <!-- A closed push card's verdict, kept under the press that raised it, which retries it from the bar above.
                 The one state that takes a row, since the card needs the width. -->
            <button
                v-if="outgoing === `held`"
                type="button"
                :class="ui.textButton({ tone: `quiet`, flush: true }, `w-full min-w-0 rounded-md p-1 hover:bg-overlay`)"
                :aria-label="heldLine"
                v-tooltip.right="heldTip"
                @click="pushFlow.reopen"
            >
                <span class="flex size-7 shrink-0 items-center justify-center rounded-md" :class="toneWash(`warning`)" aria-hidden="true">
                    <Icon name="exclamation-circle" class="text-base" />
                </span>
                <span class="flex min-w-0 flex-1 flex-col gap-1">
                    <span class="text-xs leading-snug font-medium text-content">{{ pushFlow.held.value?.question.title }}</span>
                    <span class="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-2xs leading-snug text-muted">
                        <span v-if="pushFlow.held.value" class="whitespace-nowrap">{{ timeAgo(pushFlow.held.value.at, { now }) }}</span>
                        <span v-if="pushFlow.heldStale.value">{{ t(`workspace.reviewPanel.filesChangedSince`) }}</span>
                    </span>
                </span>
            </button>
            <template v-if="changes.count.value > 0">
                <!-- A warning, not a gate — the commit is the user's to make, and `reset --soft` undoes it. -->
                <Notice v-if="atRisk.length > 0" tone="warning" size="sm">
                    <span class="break-words">
                        {{ t(`workspace.reviewPanel.agentEditing`, { paths: atRisk.join(`, `), action: commitLabel }, atRisk.length) }}
                    </span>
                    <template v-if="unaffected.length > 0" #actions>
                        <Button
                            size="small"
                            tier="boring"
                            class="whitespace-nowrap"
                            :disabled="!commitReady"
                            @click="() => runCommit(unaffected)"
                            v-tooltip.right="t(`workspace.reviewPanel.commitsRepos`, { repos: unaffected.map((group) => group.repo).join(`, `) })"
                        >
                            <Icon name="check" class="mr-1 text-2xs" />{{ t(`workspace.reviewPanel.commit`) }}
                            {{ unaffected.length === 1 ? unaffected[0]!.repo : t(`workspace.reviewPanel.otherRepos`, { count: unaffected.length }) }}
                        </Button>
                    </template>
                </Notice>
                <!-- This warning reports unfinished work after the index has already been frozen. -->
                <Notice v-if="unfinished.length > 0" tone="warning" icon="wave-pulse" size="sm">
                    <span class="break-words">
                        {{
                            t(
                                `workspace.reviewPanel.unfinishedOrigins`,
                                {
                                    origins: unfinished.map((entry) => originLabel(entry.id)).join(`, `),
                                    files: t(
                                        `workspace.reviewPanel.fileWord`,
                                        {},
                                        unfinished.reduce((total, entry) => total + entry.files, 0),
                                    ),
                                },
                                unfinished.length,
                            )
                        }}
                    </span>
                </Notice>
                <!-- A commit spans every staged repo, so its failure belongs to the box that fired it, message still in the input. -->
                <Notice
                    v-if="failureIn(COMMIT_SCOPE)"
                    tone="danger"
                    size="sm"
                    :dismiss-label="t(`workspace.reviewPanel.dismissCommitError`)"
                    @dismiss="changes.dismissFailure(COMMIT_SCOPE)"
                >
                    <span class="block font-medium">{{ failureIn(COMMIT_SCOPE)!.action }}</span>
                    <span class="line-clamp-4 break-words text-muted" v-tooltip.top.overflow="failureIn(COMMIT_SCOPE)!.detail">
                        {{ failureIn(COMMIT_SCOPE)!.detail }}
                    </span>
                </Notice>
            </template>
        </div>

        <!-- A fetch or push that failed in a repo the list isn't showing; named by repo since it has no row to sit under. -->
        <Notice
            v-for="failure in strayFailures"
            :key="failure.repo"
            tone="danger"
            size="sm"
            class="mx-2 mt-1 shrink-0"
            :dismiss-label="t(`workspace.reviewPanel.dismissError`, { repo: failure.repo })"
            @dismiss="changes.dismissFailure(failure.repo)"
        >
            <span class="block font-medium">{{ t(`workspace.reviewPanel.in`, { action: failure.action, repo: failure.repo }) }}</span>
            <span class="line-clamp-4 break-words text-muted" v-tooltip.top.overflow="failure.detail">{{ failure.detail }}</span>
        </Notice>

        <!-- Whose work is in the tree, one line, only when an agent landed something. Each chip stages that work and
             narrows the list to it (toggleOrigin), so it heads the list it narrows: choosing what to commit happens in
             one place, chips and row checkmarks together. Disabled while a git action runs, like every other index verb. -->
        <div v-if="legend.agents.length > 0" class="flex shrink-0 flex-wrap items-center gap-1 px-2 pb-1 pt-2">
            <span class="shrink-0 text-2xs uppercase tracking-wide text-subtle">{{ t(`workspace.reviewPanel.from`) }}</span>
            <!-- Resting chips are plain plates with only the logo in the agent's hue (the same hue its rows' badges
                 wear); lighting one floods the chip with that hue. Colour arriving is the whole "on": no tick, no edge,
                 so a lone chip still visibly changes without out-shouting the panel. -->
            <button
                v-for="entry in legend.agents"
                :key="entry.id"
                type="button"
                class="ui-chip min-w-0 max-w-full gap-1"
                :class="[
                    originFilter === entry.id ? ['shrink', originHue(entry.id).chip] : 'shrink-0',
                    originFilter !== undefined && originFilter !== entry.id ? 'opacity-40' : '',
                ]"
                :disabled="changes.actionBusy.value"
                @click="toggleOrigin(entry.id)"
                @mouseenter="showOrigins($event, [entry.id])"
                @mouseleave="hoverCard?.hide()"
                :aria-label="originChipLabel(entry.id, entry.files)"
                :aria-pressed="originFilter === entry.id"
            >
                <span class="relative flex shrink-0" :class="originHue(entry.id).text">
                    <ProviderLogo v-if="originProvider(entry.id)" :provider="originProvider(entry.id)!" class="text-2xs" />
                    <Icon v-else name="sparkles" class="text-2xs" />
                    <!-- A dot on the logo's corner means the session hasn't finished — its count is an instalment, not a
                         total. Worn by the logo rather than beside it, so the chip leads with one mark, not a row. -->
                    <span
                        v-if="originMark(entry.id)"
                        class="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full"
                        :class="originMark(entry.id)!.dot"
                    ></span>
                    <!-- The same corner, spent on a different wait: the chip's commit-message sentence still being written. -->
                    <span v-else-if="originDrafting(entry.id)" class="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-current opacity-60"></span>
                </span>
                <!-- Named on every chip, cut short until lit: two sessions on one provider differ by little else. Label and
                     count share a baseline, the count a step smaller: full-size digits stand at cap height and read as
                     floating above a lowercase name, which centring each box on its own could never fix. -->
                <span class="flex min-w-0 items-baseline gap-1">
                    <span class="min-w-0 truncate" :class="originFilter === entry.id ? '' : 'max-w-24'">{{ originLabel(entry.id) }}</span>
                    <span class="shrink-0 text-[0.625rem] tabular-nums opacity-70">{{ entry.files }}</span>
                </span>
                <!-- The way out, drawn only on the chip that's hiding rows: a cross means "clear this" without a word. -->
                <Icon v-if="originFilter === entry.id" name="times" class="shrink-0 text-[0.6rem] opacity-70" />
            </button>
            <button
                v-if="legend.yours > 0"
                type="button"
                class="ui-chip shrink-0 gap-1"
                :class="originFilter === YOURS ? 'ui-chip-on' : originFilter !== undefined ? 'opacity-40' : ''"
                :disabled="changes.actionBusy.value"
                :aria-pressed="originFilter === YOURS"
                @click="toggleOrigin(YOURS)"
                v-tooltip.right="{ title: t(`workspace.savePanel.ownEdits`), note: t(`workspace.reviewPanel.alsoTerminalChats`) }"
            >
                <span class="flex items-baseline gap-1">
                    <span>{{ t(`workspace.reviewPanel.you`) }}</span>
                    <span class="text-[0.625rem] tabular-nums opacity-70">{{ legend.yours }}</span>
                </span>
                <Icon v-if="originFilter === YOURS" name="times" class="shrink-0 text-[0.6rem] opacity-70" />
            </button>
        </div>

        <div class="min-h-0 flex-1 overflow-auto py-1">
            <!-- Loading appears only before the first answer. -->
            <!-- Where the incoming rows will appear, so it reads as "on their way here" rather than as a notice about
                 somewhere else. Above the list, not only in its place: a second land arrives while the first's rows are
                 already listed. -->
            <p v-if="changes.landing.value" class="flex items-center gap-1.5 px-2 py-2 text-2xs text-link">
                <span :class="LEAD"><Icon name="spinner" spin class="text-2xs" /></span>
                <!-- A title long enough to truncate is the common case in a 270px sidebar, so the whole line is owed
                     on hover; the verb leads so what survives the cut is the part that answers "where is my work". -->
                <span class="min-w-0 truncate" v-tooltip.right.overflow="`${changes.landing.value}…`">{{ changes.landing.value }}…</span>
            </p>
            <p v-if="!changes.loaded.value && !changes.error.value" class="px-2 py-2 text-2xs text-subtle">
                {{ t(`workspace.words.loadingChanges`) }}
            </p>
            <!-- An explicitly clean tree distinguishes empty results from missing data — but only once it is a claim
                 anyone can make: mid-land the tree is being written, and the line above already says so. -->
            <p v-else-if="changes.loaded.value && changes.count.value === 0 && !changes.landing.value" class="px-2 py-2 text-2xs text-subtle">
                {{ t(`workspace.reviewPanel.noUncommittedChanges`) }}
            </p>
            <!-- A lit chip over an empty list says so too — otherwise a filtered-to-nothing tree reads as having lost its files. -->
            <p v-else-if="dirty.length === 0 && filterLabel" class="px-2 py-2 text-2xs text-subtle">
                {{ t(`workspace.reviewPanel.nothingLeftInTree`, { filterLabel }) }}
            </p>

            <!-- Unscannable repositories remain visible with Git's reason and no actions. -->
            <div v-for="group in unscannable" :key="group.repo" class="mt-1 px-1 first:mt-0">
                <!-- The warning icon occupies the chevron slot so rows stay aligned. -->
                <div class="flex min-w-0 items-center gap-1.5 rounded-md py-1.5 pl-1 pr-1">
                    <span :class="LEAD"><Icon name="exclamation-triangle" class="text-2xs text-danger" /></span>
                    <span class="min-w-0 truncate text-xs font-medium text-content">{{ group.repo }}</span>
                </div>
                <Notice tone="danger" size="sm" class="mx-1 mb-1.5">
                    <span class="block font-medium">{{ t(`workspace.reviewPanel.couldntReadRepo`) }}</span>
                    <span class="line-clamp-4 break-words text-muted" v-tooltip.top.overflow="group.error">{{ group.error }}</span>
                </Notice>
            </div>

            <!-- Committing repositories stay listed but dim while their lock is held. -->
            <div
                v-for="group in dirty"
                :key="group.repo"
                class="group/repo mt-1 px-1 transition-opacity first:mt-0"
                :class="changes.committing.value.includes(group.repo) && `pointer-events-none opacity-50`"
            >
                <!-- One row per repo, about the files under it: identity, then the sole side's rank/verb, then discard. -->
                <div class="ui-row-select flex items-center gap-1 rounded-md pr-1">
                    <button
                        type="button"
                        class="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pl-1 text-left max-md:min-h-11"
                        @click="toggleGroup(group.repo)"
                    >
                        <!-- The chevron is the repository row's only leading icon. -->
                        <span :class="LEAD">
                            <Icon class="text-2xs text-subtle" :name="collapsed.has(group.repo) ? 'chevron-right' : 'chevron-down'" />
                        </span>
                        <!-- Both names truncate together, the branch three times as fast — it's the annotation, the repo is the heading. -->
                        <span class="min-w-0 truncate text-xs font-medium text-content" v-tooltip.top.overflow="group.repo">{{ group.repo }}</span>
                        <span v-if="group.branch !== undefined" class="flex min-w-0 max-w-24 shrink-3 items-center gap-0.5 text-2xs text-subtle">
                            <Icon name="fork" class="shrink-0 text-[0.6rem]" />
                            <!-- Repository and branch names truncate and reveal their full text on hover. -->
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
                        :class="rowGlyph()"
                        :disabled="changes.actionBusy.value"
                        v-action="() => stageSide(group, soleSide(group)!.side)"
                        v-tooltip.right="sideVerbTip(group, soleSide(group)!.side)"
                        :aria-label="t(`workspace.reviewPanel.in2`, { side: sideVerbHint(group, soleSide(group)!.side), repo: group.repo })"
                    >
                        <Icon :name="INDEX_VERB[soleSide(group)!.side].icon" class="text-2xs" />
                    </button>
                    <!-- Two sides carry their verbs on their own headers; the column stays, so the count ends where a side's label would. -->
                    <span v-else :class="GLYPH_GAP" aria-hidden="true"></span>
                    <button
                        v-if="discardable(group)"
                        type="button"
                        :class="rowGlyph(`muted`, ROW_ACTION, DISCARD_GAP)"
                        :disabled="changes.actionBusy.value"
                        @click="askDiscardRepo(group)"
                        v-tooltip.top="t(`workspace.reviewPanel.discardAll`)"
                        :aria-label="t(`workspace.reviewPanel.discardAllChangesIn`)"
                    >
                        <Icon name="trash" class="text-2xs" />
                    </button>
                    <span v-else :class="[GLYPH_GAP, DISCARD_GAP]" aria-hidden="true"></span>
                </div>

                <!-- A failed fetch/pull/push/discard/stage for this repo, under the row that caused it, in git's own words. -->
                <Notice
                    v-if="failureIn(group.repo)"
                    tone="danger"
                    size="sm"
                    class="mx-1 mb-1.5 mt-0.5"
                    :dismiss-label="t(`workspace.reviewPanel.dismissError`, { repo: group.repo })"
                    @dismiss="changes.dismissFailure(group.repo)"
                >
                    <span class="block font-medium">{{ failureIn(group.repo)!.action }}</span>
                    <span class="line-clamp-4 break-words text-muted" v-tooltip.top.overflow="failureIn(group.repo)!.detail">
                        {{ failureIn(group.repo)!.detail }}
                    </span>
                </Notice>

                <!-- Conflicts come from operations left by an external terminal. -->
                <Notice v-if="group.operation" tone="warning" size="sm" class="mx-1 mb-1.5 mt-0.5">
                    <span class="block font-medium">{{ t(`workspace.reviewPanel.inProgress`, { operation: group.operation }) }}</span>
                    <span class="block text-muted">{{ t(`workspace.reviewPanel.resolveConflictsStageTo`, { operation: group.operation }) }}</span>
                    <template #actions>
                        <Button
                            size="small"
                            tone="warning"
                            class="shrink-0"
                            :disabled="changes.actionBusy.value"
                            @click="changes.abortOperation(group.repo)"
                            v-tooltip.top="{
                                title: t(`workspace.reviewPanel.abortOperation`, { operation: group.operation }),
                                note: t(`workspace.reviewPanel.restorePointFirst`),
                            }"
                        >
                            {{ t(`workspace.reviewPanel.abort`) }}
                        </Button>
                    </template>
                </Notice>

                <!-- Untracked paths shaped like scratch: every stage-everything leaves them out, so Commit all does too. -->
                <div
                    v-if="group.scratch !== undefined"
                    class="mx-1 mb-1.5 mt-0.5 flex items-start gap-1.5 rounded-md border border-border bg-overlay px-2 py-1.5"
                >
                    <span :class="LEAD" class="h-4"><Icon name="filter" class="text-2xs text-subtle" /></span>
                    <div class="min-w-0 flex-1">
                        <p class="text-2xs font-medium text-content">
                            {{ t(`workspace.reviewPanel.scratchLeftOut`, { count: group.scratch.length }, group.scratch.length) }}
                        </p>
                        <p class="break-all font-mono text-2xs text-muted">{{ group.scratch.map((entry) => entry.path).join(`, `) }}</p>
                        <p class="text-2xs text-subtle">{{ t(`workspace.reviewPanel.scratchLeftOutHint`) }}</p>
                    </div>
                </div>

                <!-- No empty-repo guard needed here — `dirty` is the list, and a repo with no rows isn't in it. -->
                <div v-if="!collapsed.has(group.repo)" class="pb-1">
                    <!-- One block per git side (conflicts, staged, unstaged); the header's action is whole-side, ignoring selection. -->
                    <template v-for="section in sidesOf(group)" :key="`${group.repo}/${section.side}`">
                        <div v-if="sidesSplit(group)" class="flex items-center gap-1 pl-5 pr-1 pt-1">
                            <span
                                class="shrink-0 text-2xs font-medium uppercase tracking-wide"
                                :class="section.side === 'conflicted' ? 'text-danger' : 'text-subtle'"
                                >{{ section.label }}</span
                            >
                            <!-- The side count includes visible rows and truncated rows. -->
                            <span class="shrink-0 text-2xs text-subtle">{{ sideTotal(group, section.side, section.changes.length) }}</span>
                            <!-- The section's only module, said here instead of on its own row below it — see soleBucket. -->
                            <ModuleLabel
                                v-if="soleBucket(group.repo, section.side)"
                                :name="soleBucket(group.repo, section.side)!.name"
                                :packaged="soleBucket(group.repo, section.side)!.packaged"
                            />
                            <span class="flex-1"></span>
                            <!-- Always drawn: what moves a row across the index stays on screen, what destroys work waits for a hover. -->
                            <button
                                type="button"
                                :class="rowGlyph()"
                                :disabled="changes.actionBusy.value"
                                v-action="() => stageSide(group, section.side)"
                                v-tooltip.right="sideVerbTip(group, section.side)"
                                :aria-label="t(`workspace.reviewPanel.in2`, { side: sideVerbHint(group, section.side), repo: group.repo })"
                            >
                                <Icon :name="INDEX_VERB[section.side].icon" class="text-2xs" />
                            </button>
                            <span :class="[GLYPH_GAP, DISCARD_GAP]" aria-hidden="true"></span>
                        </div>

                        <template v-for="bucket in viewOf(group.repo, section.side).buckets" :key="`${group.repo}/${section.side}/${bucket.key}`">
                            <!-- Each module label is shown once for its row group. -->
                            <div v-if="moduleRow(group, section.side)" class="flex items-center pt-2" :class="moduleIndent(group)">
                                <ModuleLabel :name="bucket.name" :packaged="bucket.packaged" />
                            </div>
                            <template v-for="change in bucket.rows" :key="`${group.repo}/${section.side}/${change.path}`">
                                <!-- Selection uses the primary tint instead of the row hover colour. -->
                                <div
                                    class="group/file flex items-stretch gap-1 rounded pr-1 transition-colors"
                                    @contextmenu="openRowMenu($event, { repo: group.repo, side: section.side, path: change.path }, change)"
                                    :class="[
                                        isSelected({ repo: group.repo, side: section.side, path: change.path })
                                            ? 'bg-primary-500/15 hover:bg-primary-500/25'
                                            : 'ui-row-select',
                                    ]"
                                >
                                    <!-- No indent guide or origin rail down the left: the status mark sits under its heading's first letter, and
                                         the origin chips below carry which agent touched the file. -->
                                    <button
                                        type="button"
                                        class="flex min-w-0 flex-1 items-center gap-1.5 py-0.5 text-left max-md:min-h-11"
                                        :class="rowIndent(group, section.side)"
                                        @click="clickRow({ repo: group.repo, side: section.side, path: change.path }, change, $event)"
                                        @dblclick="openDiff(group.repo, section.side, change, 'keep')"
                                    >
                                        <!-- One step under its heading: the letter's slot starts where the heading's label does. -->
                                        <span :class="LEAD"><ChangeStatusMark :status="change.status" /></span>
                                        <!-- How a changed file is named, shared with the agent review's own rows — see ChangeRowName. -->
                                        <ChangeRowName
                                            :path="change.path"
                                            :label="changeLabel(group.repo, change)"
                                            :named="viewOf(group.repo, section.side).named"
                                        />
                                        <span v-if="isScratch(change.path, group.scratch ?? [])" class="shrink-0 text-2xs text-subtle">{{
                                            t(`workspace.reviewPanel.scratchTag`)
                                        }}</span>
                                        <!-- Provider chips show before the file name when the panel has room. -->
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
                                        <!-- The `of` value scales the badge against the largest addition. -->
                                        <ReviewStat :code="change.code" :additions="change.additions" :deletions="change.deletions" :of="heaviest" />
                                    </button>
                                    <!-- Index verbs stay quieter than file names so repeated rows read as texture. -->
                                    <button
                                        type="button"
                                        :class="rowGlyph(`subtle`, `self-center`)"
                                        :disabled="changes.actionBusy.value"
                                        v-action="() => stageRow({ repo: group.repo, side: section.side, path: change.path })"
                                        v-tooltip.top="INDEX_VERB[section.side].one"
                                        :aria-label="`${INDEX_VERB[section.side].one}: ${change.path}`"
                                    >
                                        <Icon :name="INDEX_VERB[section.side].icon" class="text-2xs" />
                                    </button>
                                    <!-- Touch spacing keeps Discard separate from the unconfirmed Stage action. -->
                                    <button
                                        type="button"
                                        :class="
                                            rowGlyph(
                                                `muted`,
                                                `self-center opacity-0 focus-visible:opacity-100 group-hover/file:opacity-100 max-md:opacity-100`,
                                                DISCARD_GAP,
                                            )
                                        "
                                        :disabled="changes.actionBusy.value"
                                        @click="askDiscardRow({ repo: group.repo, side: section.side, path: change.path }, change)"
                                        v-tooltip.top="t(`ui.action.discard`)"
                                        :aria-label="t(`workspace.reviewPanel.discard2`, { path: change.path })"
                                    >
                                        <Icon name="trash" class="text-2xs" />
                                    </button>
                                </div>
                            </template>
                        </template>
                    </template>
                    <!-- The daemon's per-repo cap, said plainly so the list doesn't read as complete when it isn't. -->
                    <p v-if="truncatedTotal(group) > 0" class="py-1 pl-5 pr-2 text-2xs text-subtle">
                        {{
                            t(`workspace.reviewPanel.moreShowingFirstStage`, {
                                group: truncatedTotal(group),
                                group2: repoCount(group) - truncatedTotal(group),
                            })
                        }}
                    </p>
                </div>
            </div>

            <!-- Other sandboxes' changes remain a separate read-only ledger. -->
            <OtherSandboxChanges />
        </div>

        <!-- Tracked and untracked discard outcomes are reported separately. -->
        <Modal
            :open="pendingDiscard !== undefined"
            size="sm"
            :header="t(`workspace.reviewPanel.discardChanges`)"
            @update:open="pendingDiscard = undefined"
        >
            <template v-if="pendingDiscard">
                <p class="break-words text-xs text-content">{{ pendingDiscard.question }}</p>
                <!-- The counts are a floor when daemon truncation hides additional files. -->
                <p v-if="pendingDiscard.partial" class="mt-2 text-xs text-warning">
                    {{ t(`workspace.reviewPanel.moreFilesPendingHere`) }}
                </p>
                <!-- The verb agrees with the count (`plural`), since a lone file misreading as plural is the one line here that must be read carefully. -->
                <p v-if="pendingDiscard.restores > 0" class="mt-2 text-xs text-muted">
                    {{ pendingDiscard.partial ? t(`workspace.words.atLeast`) : `` }}
                    {{ t(`workspace.reviewPanel.filesReturn`, { count: pendingDiscard.restores }, pendingDiscard.restores) }}
                </p>
                <div v-if="pendingDiscard.deletes.length > 0" class="mt-2">
                    <p class="text-xs text-danger">
                        {{ pendingDiscard.partial ? t(`workspace.words.atLeast`) : `` }}
                        {{ t(`workspace.reviewPanel.untrackedLeave`, { count: pendingDiscard.deletes.length }, pendingDiscard.deletes.length) }}
                    </p>
                    <ul class="mt-1 max-h-24 overflow-auto">
                        <li v-for="path in pendingDiscard.deletes" :key="path" class="truncate font-mono text-2xs text-muted" dir="rtl">
                            <bdi>{{ path }}</bdi>
                        </li>
                    </ul>
                </div>
                <p class="mt-3 text-2xs text-subtle">
                    <Icon name="shield" class="mr-0.5 text-[0.6rem]" />{{ t(`workspace.reviewPanel.restorePointSavedFirst2`) }}
                </p>
            </template>
            <template #footer>
                <Button size="small" tier="quiet" :label="t(`ui.action.cancel`)" @click="pendingDiscard = undefined" />
                <Button size="small" tone="danger" :label="t(`ui.action.discard`)" :disabled="changes.actionBusy.value" @click="confirmDiscard" />
            </template>
        </Modal>

        <!-- The same card the chat tab strip raises for a session, mounted at body so it clears this sidebar's narrow column. -->
        <HoverCard ref="hoverCard" />
        <ContextMenu ref="rowMenu" :model="rowMenuItems" />
    </div>
</template>
