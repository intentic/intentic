<script setup lang="ts">
import { isScratch, type GitChange, type GitDiffSide, type RepoChanges, type RepoTarget } from "@intentic/sandbox-contract";
import { Button, ChangeStatusMark, clipboardOf, ContextMenu, Modal, type TipRow, type TooltipValue, ui, useDevice, vAction } from "@intentic/ui";
import { useWorkspaceTabs } from "../tabs/useWorkspaceTabs";
import { computed, ref, watch } from "vue";
import ProviderLogo from "../../chat/accounts/ProviderLogo.vue";
import HoverCard from "../../chat/tabs/HoverCard.vue";
import ReviewStat from "./ReviewStat.vue";
import CommitComposer from "./CommitComposer.vue";
import ScopeChips from "./ScopeChips.vue";
import { useCommitScope } from "./useCommitScope";
import { clickIntent, rangeSelect } from "../../../lib/multiSelect";
import { rendersAsBytes } from "../explorer/fileType";
import { useLayout } from "../../../workbench/window/useLayout";
import { originHue, originsOf } from "./changeOrigins";
import { diffRawUrls } from "./diffRaw";
import { COMMIT_SCOPE, useChanges } from "./useChanges";
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
import { useT } from "@intentic/ui/i18n";
import type { MenuItem } from "primevue/menuitem";
import { changeRowMenuItems } from "./changeRowMenu";
import { useHome } from "../home/useHome";
import { useNotifications } from "../../../workbench/notifications/notifications";

// VSCode's SCM pattern over the real repos: uncommitted work grouped by repo, then by git's staged/unstaged
// sides (a path can be on both with different content). What Commit records is a scope (commitScope.ts): a session's
// landed files, your own edits, git's index as staged, or everything; rows outside it dim and stay listed. On a
// desktop the commit page beside the list picks the scope and holds the message (CommitPage.vue); `docked` is the
// phone, with no page beside it, where the scope chips sit over the list and the composer docks under it. Built for a
// ~270px sidebar: one primary button per row, icons+tooltips for the rest.

const { docked = false } = defineProps<{ docked?: boolean }>();

const t = useT();

const changes = useChanges();

// The scope Commit records, shared with the composer (useCommitScope.ts): rows outside it dim, never hide. A repo the
// daemon couldn't scan (empty lists, `error` set) stays out of every computation below but still renders as its own
// row, rather than silently disappearing.
const { scannable, scopeOrigin, originLabel, originProvider, originCard, rowInScope } = useCommitScope();
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

const { mobile } = useDevice();
const layout = useLayout();

// Raises the same card the chat tab strip does for a session, on hovering a row's chip.
const hoverCard = ref<InstanceType<typeof HoverCard> | null>(null);
const showOrigins = (event: MouseEvent, ids: readonly string[]): void => {
    hoverCard.value?.show(event, originCard(ids));
};
// The name rides the row only once the panel is wide enough to hold it without evicting the path (or on mobile).
const wide = computed(() => mobile.value || layout.sidebarWidth.value >= 320);

// Quiet when the row's only origin is the scope's own session (the dock already says so); a file two agents landed
// still shows both, since that's information the scope alone doesn't give.
const showRowOrigins = (repo: RepoChanges, path: string): boolean => {
    const ids = originsOf(repo, path);
    if (ids.length === 0) {
        return false;
    }
    return !(ids.length === 1 && ids[0] === scopeOrigin.value);
};

// Sides in git's order (conflicts block everything, then staged, then unstaged); an empty section renders nothing.
// Nothing is filtered: the commit scope dims rows, it never hides them.
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
                ].filter((section) => section.changes.length > 0),
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

// Only repos with changes get a row; a clean repo says nothing here (the empty state says it once, for the tree).
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
    void changes.fileDiff(repo, change.path, side).then((body) => fillDiff({ ...tab, ...body }));
};

// Prefetching is the app's own background loader now, not this panel's mount — it used to only start warming
// rows once this view opened. Every ±count here is the code-only reading the daemon computes with the list, final the
// moment it's drawn.

// Scale for the size rail: the biggest addition among rows shown. A folded repo still counts — folding hides rows, it
// doesn't rescale everyone else's rail.
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

// The same verb on hover, and spoken with its repo for a screen reader.
const sideVerbHint = (side: GitDiffSide): string => INDEX_VERB.value[side].all;

// Row action: moves the acting rows across the index, in the direction their side implies.
const stageRow = (row: Row): Promise<void> => changes.stageGroups(byRepo(actingRows(row, true)), movesIntoIndex(row.side));
// Section action: the whole side, sent as a scope rather than the rows drawn — the change that ended staging
// a truncated repo five hundred files at a time.
const stageSide = (repo: RepoChanges, side: GitDiffSide): Promise<void> =>
    changes.stageGroups([{ repo: repo.repo, scope: { side } }], movesIntoIndex(side));

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

// A repo-wide discard: every uncommitted change in it, sent as the whole repo so it reaches past the panel's
// truncation budget too.
const askDiscardRepo = (repo: RepoChanges): void => {
    // Distinct paths: a path staged and edited again is two rows but one file on disk, and this counts disk effect.
    const paths = new Set(sidesOf(repo).flatMap((section) => section.changes.map((change) => change.path)));
    const deletes = repo.unstaged.filter((change) => change.status === `added` && paths.has(change.path)).map((change) => change.path);
    pendingDiscard.value = {
        question: t(`workspace.reviewPanel.discardEveryChange`, { repo: repo.repo }),
        deletes,
        restores: paths.size - deletes.length,
        partial: truncatedTotal(repo) > 0,
        groups: [{ repo: repo.repo }],
    };
};

const confirmDiscard = async (): Promise<void> => {
    const target = pendingDiscard.value;
    pendingDiscard.value = undefined;
    if (target !== undefined) {
        await changes.discardGroups(target.groups);
    }
};

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
const failureIn = (key: string) => changes.failures.value.get(key);

// Failures with no row to land on: a fetch or push that fails in a CLEAN repo, which no longer has a row of
// its own now that ahead/behind moved to the outgoing block. Surface under the block that fired them, naming their
// repo.
const strayFailures = computed<readonly { repo: string; action: string; detail: string }[]>(() =>
    [...changes.failures.value]
        .filter(([key]) => key !== COMMIT_SCOPE && !dirty.value.some((repo) => repo.repo === key))
        .map(([repo, failure]) => ({ repo, ...failure })),
);

// A bordered block, not loose coloured text — an error needs a container or it reads as gibberish, not a message.
const NOTICE = `flex items-start gap-1.5 rounded-md border border-danger/40 bg-danger/10 px-2 py-1.5`;
</script>

<template>
    <div ref="panelEl" class="flex min-h-0 flex-1 flex-col">
        <!-- No header row of its own: the mode switch above already reads "Changes" with the count. -->

        <!-- The one genuinely panel-wide failure: the review set itself couldn't be read, so nothing below is trustworthy. -->
        <div v-if="changes.error.value" :class="[NOTICE, 'mx-2 mt-2 shrink-0']">
            <Icon name="exclamation-triangle" class="mt-0.5 shrink-0 text-2xs text-danger" />
            <div class="min-w-0 flex-1">
                <p class="text-2xs font-medium text-danger">{{ t(`workspace.reviewPanel.couldntReadChanges`) }}</p>
                <p class="break-words text-2xs text-muted">{{ changes.error.value }}</p>
            </div>
        </div>

        <!-- What Commit records, over the list it dims; the commit page holds the same row on a desktop. -->
        <div v-if="docked && changes.count.value > 0" class="shrink-0 border-b border-line-subtle px-2 py-1.5 empty:hidden">
            <ScopeChips compact />
        </div>

        <div class="min-h-0 flex-1 overflow-auto py-1">
            <!-- Loading appears only before the first answer. -->
            <!-- Where the incoming rows will appear, so it reads as "on their way here" rather than as a notice about
                 somewhere else. Above the list, not only in its place: a second land arrives while the first's rows are
                 already listed. -->
            <p v-if="changes.landing.value" class="flex items-center gap-1.5 px-3 py-2 text-2xs text-link">
                <Icon name="spinner" spin class="shrink-0 text-3xs" />
                <!-- A title long enough to truncate is the common case in a 270px sidebar, so the whole line is owed
                     on hover; the verb leads so what survives the cut is the part that answers "where is my work". -->
                <span class="min-w-0 truncate" v-tooltip.right.overflow="`${changes.landing.value}…`">{{ changes.landing.value }}…</span>
            </p>
            <p v-if="!changes.loaded.value && !changes.error.value" class="px-3 py-2 text-2xs text-subtle">
                {{ t(`workspace.words.loadingChanges`) }}
            </p>
            <!-- An explicitly clean tree distinguishes empty results from missing data — but only once it is a claim
                 anyone can make: mid-land the tree is being written, and the line above already says so. -->
            <p v-else-if="changes.loaded.value && changes.count.value === 0 && !changes.landing.value" class="px-3 py-2 text-2xs text-subtle">
                {{ t(`workspace.reviewPanel.noUncommittedChanges`) }}
            </p>

            <!-- Unscannable repositories remain visible with Git's reason and no actions. -->
            <div v-for="group in unscannable" :key="group.repo" class="mt-1 px-1 first:mt-0">
                <!-- The warning icon occupies the chevron slot so rows stay aligned. -->
                <div class="flex min-w-0 items-center gap-1.5 rounded-md py-1.5 pl-1 pr-1">
                    <Icon name="exclamation-triangle" class="shrink-0 text-2xs text-danger" />
                    <span class="min-w-0 truncate text-xs font-medium text-content">{{ group.repo }}</span>
                </div>
                <div :class="[NOTICE, 'mb-1.5']">
                    <div class="min-w-0 flex-1">
                        <p class="text-2xs font-medium text-danger">{{ t(`workspace.reviewPanel.couldntReadRepo`) }}</p>
                        <p class="line-clamp-4 break-words text-2xs text-muted" v-tooltip.top.overflow="group.error">{{ group.error }}</p>
                    </div>
                </div>
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
                        <Icon class="shrink-0 text-2xs text-subtle" :name="collapsed.has(group.repo) ? 'chevron-right' : 'chevron-down'" />
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
                        :class="[ICON_BUTTON, 'text-muted max-md:h-8 max-md:w-8']"
                        :disabled="changes.actionBusy.value"
                        v-action="() => stageSide(group, soleSide(group)!.side)"
                        v-tooltip.right="sideVerbHint(soleSide(group)!.side)"
                        :aria-label="t(`workspace.reviewPanel.in2`, { side: sideVerbHint(soleSide(group)!.side), repo: group.repo })"
                    >
                        <Icon :name="INDEX_VERB[soleSide(group)!.side].icon" class="text-2xs" />
                    </button>
                    <button
                        type="button"
                        :class="[ICON_BUTTON, ROW_ACTION, 'max-md:h-8 max-md:w-8']"
                        :disabled="changes.actionBusy.value"
                        @click="askDiscardRepo(group)"
                        v-tooltip.top="t(`workspace.reviewPanel.discardAll`)"
                        :aria-label="t(`workspace.reviewPanel.discardAllChangesIn`)"
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
                        v-tooltip.right="t(`ui.action.dismiss`)"
                        :aria-label="t(`workspace.reviewPanel.dismissError`, { repo: group.repo })"
                    >
                        <Icon name="times" class="text-2xs" />
                    </button>
                </div>

                <!-- Conflicts come from operations left by an external terminal. -->
                <div v-if="group.operation" :class="[NOTICE, 'mb-1.5 mt-0.5 border-warning/40 bg-warning/10']">
                    <Icon name="exclamation-triangle" class="mt-0.5 shrink-0 text-2xs text-warning" />
                    <div class="min-w-0 flex-1">
                        <p class="text-2xs font-medium text-warning">{{ t(`workspace.reviewPanel.inProgress`, { operation: group.operation }) }}</p>
                        <p class="text-2xs text-muted">{{ t(`workspace.reviewPanel.resolveConflictsStageTo`, { operation: group.operation }) }}</p>
                    </div>
                    <Button
                        size="small"
                        severity="warn"
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
                </div>

                <!-- Untracked paths shaped like scratch: every stage-everything leaves them out, so Commit all does too. -->
                <div v-if="group.scratch !== undefined" :class="[NOTICE, 'mb-1.5 mt-0.5 border-border bg-overlay']">
                    <Icon name="filter" class="mt-0.5 shrink-0 text-2xs text-subtle" />
                    <div class="min-w-0 flex-1">
                        <p class="text-2xs font-medium text-content">
                            {{ t(`workspace.reviewPanel.scratchLeftOut`, { count: group.scratch.length }, group.scratch.length) }}
                        </p>
                        <p class="break-all font-mono text-2xs text-muted">{{ group.scratch.map((entry) => entry.path).join(`, `) }}</p>
                        <p class="text-2xs text-subtle">{{ t(`workspace.reviewPanel.scratchLeftOutHint`) }}</p>
                    </div>
                </div>

                <!-- No empty-repo guard needed here — `dirty` is the list, and a repo with no rows isn't in it. -->
                <div v-if="!collapsed.has(group.repo)" class="pb-1 pl-1">
                    <!-- One block per git side (conflicts, staged, unstaged); the header's action is whole-side, ignoring selection. -->
                    <template v-for="section in sidesOf(group)" :key="`${group.repo}/${section.side}`">
                        <div v-if="sidesSplit(group)" class="flex items-center gap-1 pl-2 pt-1">
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
                                :class="[ICON_BUTTON, 'max-md:h-8 max-md:w-8']"
                                :disabled="changes.actionBusy.value"
                                v-action="() => stageSide(group, section.side)"
                                v-tooltip.right="sideVerbHint(section.side)"
                                :aria-label="t(`workspace.reviewPanel.in2`, { side: sideVerbHint(section.side), repo: group.repo })"
                            >
                                <Icon :name="INDEX_VERB[section.side].icon" class="text-2xs" />
                            </button>
                        </div>

                        <template v-for="bucket in viewOf(group.repo, section.side).buckets" :key="`${group.repo}/${section.side}/${bucket.key}`">
                            <!-- Each module label is shown once for its row group. -->
                            <div v-if="moduleRow(group, section.side)" class="flex items-center pt-2" :class="moduleIndent(group)">
                                <ModuleLabel :name="bucket.name" :packaged="bucket.packaged" />
                            </div>
                            <template v-for="change in bucket.rows" :key="`${group.repo}/${section.side}/${change.path}`">
                                <!-- Selection uses the primary tint instead of the row hover colour. -->
                                <!-- A row outside what Commit records is dimmed, never hidden: nothing enters a commit unseen, and
                                     nothing leaves the list because a scope was picked. Hover lifts it back to full strength. -->
                                <div
                                    class="group/file flex items-stretch gap-1 rounded transition-[opacity,background-color]"
                                    @contextmenu="openRowMenu($event, { repo: group.repo, side: section.side, path: change.path }, change)"
                                    :class="[
                                        isSelected({ repo: group.repo, side: section.side, path: change.path })
                                            ? 'bg-primary-500/15 hover:bg-primary-500/25'
                                            : 'ui-row-select',
                                        // One 8px step per rank that is actually drawn above this row, so a
                                        // filename never pays indent for a heading that isn't there.
                                        rowIndent(group, section.side),
                                        !rowInScope(group, section.side, change.path) && 'opacity-45 hover:opacity-100 focus-within:opacity-100',
                                    ]"
                                    :data-out-of-scope="rowInScope(group, section.side, change.path) ? undefined : ``"
                                >
                                    <!-- No indent guide or origin rail down the left: the status mark sits under its heading's first letter, and
                                         the origin chips below carry which agent touched the file. -->
                                    <button
                                        type="button"
                                        class="flex min-w-0 flex-1 items-center gap-1.5 py-0.5 pl-2 text-left max-md:min-h-11"
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
                                    <!-- Touch spacing keeps Discard separate from the unconfirmed Stage action. -->
                                    <button
                                        type="button"
                                        :class="
                                            ui.iconButton(
                                                `h-5 w-5 self-center rounded opacity-0 focus-visible:opacity-100 group-hover/file:opacity-100 max-md:ml-2 max-md:h-8 max-md:w-8 max-md:opacity-100`,
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
                    <p v-if="truncatedTotal(group) > 0" class="py-1 pl-4 text-2xs text-subtle">
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

        <!-- A fetch or push that failed in a repo the list isn't showing; named by repo since it has no row to sit under. -->
        <div v-for="failure in strayFailures" :key="failure.repo" :class="[NOTICE, 'mx-2 mb-1 shrink-0']">
            <Icon name="exclamation-triangle" class="mt-0.5 shrink-0 text-2xs text-danger" />
            <div class="min-w-0 flex-1">
                <p class="text-2xs font-medium text-danger">{{ t(`workspace.reviewPanel.in`, { action: failure.action, repo: failure.repo }) }}</p>
                <p class="line-clamp-4 break-words text-2xs text-muted" v-tooltip.top.overflow="failure.detail">{{ failure.detail }}</p>
            </div>
            <button
                type="button"
                class="shrink-0 rounded p-0.5 text-muted transition-colors hover:text-content"
                @click="changes.dismissFailure(failure.repo)"
                v-tooltip.right="t(`ui.action.dismiss`)"
                :aria-label="t(`workspace.reviewPanel.dismissError`, { repo: failure.repo })"
            >
                <Icon name="times" class="text-2xs" />
            </button>
        </div>

        <!-- A phone has no page beside the list, so the composer docks under it, the button inside its field. -->
        <CommitComposer v-if="docked" variant="dock" />

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
                <Button size="small" severity="secondary" :text="true" :label="t(`ui.action.cancel`)" @click="pendingDiscard = undefined" />
                <Button size="small" severity="danger" :label="t(`ui.action.discard`)" :disabled="changes.actionBusy.value" @click="confirmDiscard" />
            </template>
        </Modal>

        <!-- The same card the chat tab strip raises for a session, mounted at body so it clears this sidebar's narrow column. -->
        <HoverCard ref="hoverCard" />
        <ContextMenu ref="rowMenu" :model="rowMenuItems" />
    </div>
</template>
