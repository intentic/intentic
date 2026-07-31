<script setup lang="ts">
import type { GitChange, GitDiffSide, RepoChanges } from "@intentic-app/api-contract";
import { cmp, useDevice } from "@intentic-app/ui";
import Dialog from "primevue/dialog";
import { computed, ref, watch } from "vue";
import ProviderLogo from "../../chat/ProviderLogo.vue";
import DiffStat from "../../components/DiffStat.vue";
import HoverCard from "../../components/HoverCard.vue";
import { useAgents } from "../../composables/agents/useAgents";
import { useChat } from "../../composables/chat/useChat";
import { useQuickModel } from "../../composables/chat/quickModel";
import { useLayout } from "../../composables/useLayout";
import { clearFilledMessage, commitMessage, fillCommitMessage } from "../../composables/workspace/commitMessage";
import { conventionalSubject } from "../../composables/workspace/commitSuggestion";
import { useCommitDraft } from "../../composables/workspace/useCommitDraft";
import { ALL_SIDES, originHue, originsOf, summarizeOrigins, YOURS } from "../../composables/workspace/changeOrigins";
import { formatElapsed, unfinishedMark } from "../../composables/agents/agentStatus";
import { diffRawUrls } from "../../composables/workspace/diffRaw";
import { repoOfPath, turnWrites } from "../../composables/workspace/liveWrites";
import { COMMIT_SCOPE, type RepoPaths, type SyncTarget, useChanges } from "../../composables/workspace/useChanges";
import { useGate } from "../../composables/workspace/useGate";
import { useRepos } from "../../composables/workspace/useRepos";
import GateBadge from "./GateBadge.vue";
import { type DiffTabPayload, STATUS_CLASS, STATUS_LETTER } from "./workspaceTabs";

/* The Changes review — a mode of the workspace's ONE left sidebar (Workspace.vue owns the aside, the resize
 * handle, and the Files|Changes|History mode switch), VSCode's SCM pattern over the real repos: uncommitted
 * work (yours and the agent's) grouped by repo, and within a repo by git's two sides — Staged (index vs HEAD)
 * and Unstaged (worktree vs index, untracked included). A path can appear in BOTH with different content,
 * which is exactly why they are separate lists rather than one merged one.
 *
 * STAGING IS THE SELECTION, which is why there are no checkboxes anywhere. git already has a mechanism for
 * choosing what a commit contains — the index — and a parallel tick-selection could only contradict it: a
 * path-scoped commit over a partially staged file records the WORKTREE content while the row the user ticked
 * showed the INDEX content. So Commit records the index, and the panel's job is to make staging fast:
 *   - section actions   → Stage All / Unstage All for a side, Discard All for a repo
 *   - row actions       → stage/unstage/discard that row (or the whole selection it belongs to)
 *   - Commit            → one real commit per repo that has something staged, all sharing the message
 *   - Commit all        → what the button becomes when nothing is staged: stage everything, then commit
 * Click/ctrl/shift selection exists only to let one row action reach several rows. It never targets Commit.
 *
 * Sized for the sidebar it lives in (~270px), which is the constraint that shapes every control here: exactly
 * one labelled button per row — the primary one — and icons with tooltips for everything else. Status text
 * truncates; action clusters never shrink; nothing is allowed to push the primary action off the edge.
 *
 * Clicking a file opens the diff of THAT ROW's side; discard restores the worktree from HEAD. The History panel
 * stays the safety timeline.
 *
 * Two rules earn the panel its quiet, and both replace something that shouted:
 *   - SYNC STATE IS THE SYNC CONTROL. Ahead/behind ride the repo row as pills that ARE pull and push, so a
 *     repo in sync spends no pixels saying so. This replaces a full-width bar under every repo that mostly
 *     rendered a zero and three icons.
 *   - A FAILURE RENDERS WHERE IT HAPPENED. Errors are keyed by repo (or the commit box) in useChanges and drawn
 *     against the row that caused them, naming the verb. The one shared red line this replaces sat at the top
 *     of the panel naming neither, so a failed fetch read as a stray sentence with no visible cause. */

const changes = useChanges();
// The same one query GateBadge reads — one key, so TanStack serves both from a single poll. The panel needs it
// for the push guardrail, which has to answer before the badge has been looked at (and while it is hidden).
const gate = useGate();

// A repo the daemon could not scan at all (a half-written .git from a canceled upload, a corrupt HEAD) arrives
// with empty change lists and `error` set to git's own one-line reason. It has nothing to commit or discard, so
// it stays OUT of every computation below — but it still renders, as its own row: dropping it from the list is
// exactly the silent disappearance this reports instead. Everything else is `scannable`, and every action reads
// that, so an errored repo can never leak into a commit even if the daemon someday reports partial changes
// alongside a failure.
const scannable = computed(() => changes.repos.value.filter((repo) => repo.error === undefined));
const unscannable = computed(() => changes.repos.value.filter((repo) => repo.error !== undefined));
const emit = defineEmits<{ "open-diff": [payload: DiffTabPayload] }>();

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

/* --- who landed it ------------------------------------------------------------------------------------------
 * The daemon reports, per repo, which agent landed each uncommitted path (changeOrigins.ts). Two things are
 * drawn from it, and the split is deliberate:
 *   - PER ROW, a colour rail + a provider chip. Colour, because the question "did an agent write this?" is
 *     asked while SCANNING, and a hue registers before a word does; the chip carries the identity for the one
 *     row you then stop on. In a sidebar this wide, that is the whole budget — hence no inline name until the
 *     user has actually widened the panel (`wide`).
 *   - PER PANEL, a legend that IS the filter. Grouping the list by agent would be the obvious move and it is
 *     the wrong one: a file two agents landed would have to be duplicated or arbitrarily assigned, and the
 *     repo → conflicted/staged/unstaged hierarchy underneath is not decoration — it is what staging means.
 *     Filtering keeps one row per file and still answers "show me only this agent's work".
 * Nothing is drawn for a file with no agent origin. A "you" badge on nine rows in ten is noise, and terminal
 * edits plus workspace conversations do not pass through the land-attribution path — the legend states that
 * once, for all of them. */
const { fleet } = useAgents();
// The open tabs — read here for the first message behind an origin chip's title, and below for which repos a
// main-tree turn is writing while you commit.
const { conversations } = useChat();
const { mobile } = useDevice();
const layout = useLayout();

const legend = computed(() => summarizeOrigins(scannable.value));
const originFilter = ref<string | undefined>(undefined);
// The filter outlives neither the agent's work nor a commit that swept it away — and neither does the subject
// that agent's chip filed into the commit box.
watch(legend, ({ agents, yours }) => {
    if (originFilter.value === undefined) {
        return;
    }
    const stillHasWork = originFilter.value === YOURS ? yours > 0 : agents.some((entry) => entry.id === originFilter.value);
    if (!stillHasWork) {
        originFilter.value = undefined;
        clearFilledMessage();
    }
});

/* Resolving an origin id to a name and a provider logo, from two sources in this order:
 *   - THE OPEN FLEET CARD, when there is one, because it is the LIVE copy: a rename repaints the chip on the
 *     keystroke rather than on the next poll of this panel's query.
 *   - THE REVIEW ITSELF (`changes.originAgents`), which is the one that always answers. The roster is the live
 *     board and deliberately drops archived agents, but a landing outlives the card — land, archive the
 *     finished agent, commit at leisure is the ordinary flow — so a roster-only lookup missed exactly the
 *     agents whose work is most likely to still be sitting here, and the chip read "Agent ec437c" with a
 *     generic sparkle for them. The daemon reads attribution and identity from one registry in one pass.
 * The id-shaped fallback survives for the case neither can cover: an entry the retention sweep has retired.
 * A chip is still drawn for it, because hiding one would silently re-attribute the file to the user. */
const agentOf = (id: string) => fleet.value.find((agent) => agent.id === id);
const originOf = (id: string) => changes.originAgents.value[id];
// The title as a session actually HAS one — undefined for the id-shaped fallback below, because the two are
// interchangeable to read and not at all interchangeable to use as a commit subject.
const originTitle = (id: string): string | undefined => agentOf(id)?.title ?? originOf(id)?.title;
const originLabel = (id: string): string => originTitle(id) ?? `Agent ${id.slice(0, 6)}`;
const originProvider = (id: string): string | undefined => agentOf(id)?.provider ?? originOf(id)?.provider;

/* --- and is it FINISHED ---------------------------------------------------------------------------------------
 * A chip's file count is a total for a session that has stopped and an instalment for one that hasn't, and
 * nothing on this panel said which. The gap is narrow but real: the "commit while an agent works" warning below
 * covers a main-tree turn writing the worktree mid-`commit -a`, which is an ATOMICITY problem the index already
 * solves for everything else — while an isolated agent on its second iteration is a COMPLETENESS problem the
 * index cannot touch. It will land more files, into a tree you are about to commit, and the panel was silent.
 *
 * So one bit rides the chip (unfinishedMark), and it is `laneOf` — the fleet board's OWN lane machine — read as
 * a boolean. Not a status list of this panel's own: an agent parked on a question carries a settled `status`
 * with an attention flag raised, so a status-only reading calls it finished while its card sits in the board's
 * Attention lane, and the user is looking at two surfaces disagreeing about one session.
 *
 * Read from the fleet roster, not from `originAgents`, which carries identity only. That is the right source
 * anyway: the roster drops archived agents, and an archived agent is by definition one whose session is over,
 * so absence means finished rather than unknown. */
const originMark = (id: string) => unfinishedMark(agentOf(id));

// The hover card's live line — what the mark stands for, in words, with what the roster knows about the turn.
// `turns` counts COMPLETED turns, so a session that has landed files and is running again is on turn N+1: the
// "second iteration" this whole affordance exists to name.
//
// The elapsed reading is stamped when the card OPENS rather than ticked by an interval: this panel is one of
// several the sidebar swaps between, and a timer running behind a v-if to animate a string nobody is looking at
// is a re-render per second for nothing. A card the user holds open for a minute reads a minute stale, which is
// the correct trade for a line whose point is "this started a while ago".
const now = ref(0);
const originNote = (id: string): string | undefined => {
    const mark = originMark(id);
    const agent = agentOf(id);
    if (mark === undefined || agent === undefined) {
        return undefined;
    }
    const turn = agent.turns !== undefined && agent.turns > 0 ? `turn ${agent.turns + 1}` : undefined;
    const doing = agent.activity?.tool !== undefined ? [agent.activity.tool, agent.activity.target].filter(Boolean).join(` `) : agent.activity?.todo;
    const since = agent.startedAt !== undefined ? formatElapsed(agent.startedAt, now.value) : undefined;
    return [mark.label, turn, doing, since].filter((part) => part !== undefined && part !== ``).join(` · `);
};

/* ONE CLICK, TWO HALVES OF THE SAME INTENT — "commit this session's work". The chip has always narrowed the
 * list (and every section verb under it) to that agent's files; it now also files that session's title into the
 * commit box as a subject line. Those were the two things a user did by hand, in a row, every time: filter to
 * the agent, then retype the title they could already read one line above the input.
 *
 * Which is also why the box no longer fills itself. It used to open holding every legend session's title joined
 * into one line — a message nobody chose, that changed under them whenever another agent landed. Naming a
 * commit is now something you ASK for, and the ask is the click you were already making.
 *
 * Untitled origins file nothing: the chip's "Agent 4f2a1c" fallback is an id, and an id is not a description of
 * a change. The filter still applies — you can narrow to a session you cannot name. */
const toggleOrigin = (id: string): void => {
    const next = originFilter.value === id ? undefined : id;
    originFilter.value = next;
    const subject = next === undefined || next === YOURS ? undefined : conventionalSubject([originTitle(next) ?? ``]);
    if (subject === undefined) {
        // Toggled off, moved to "you", or a session with no title to lend — either way the line the legend put
        // there no longer has a chip behind it. Anything the user has made their own survives this.
        clearFilledMessage();
        return;
    }
    fillCommitMessage(subject);
};

// A chip is a 14px logo and, at best, a title truncated to max-w-24 — so hovering one (on a file row, or in the
// From legend above the list) raises the SAME card the chat tab strip raises for that session: the full derived
// title, and under it the first message it came from when that conversation is open in the panel (the roster
// carries no prompt, only the ≤40-char title).
const hoverCard = ref<InstanceType<typeof HoverCard> | null>(null);
const firstPromptOf = (id: string): string | undefined => {
    const conversation = conversations.value.find((c) => c.conversationId === id);
    return conversation?.messages.value.find((message) => message.role === `user`)?.text;
};
const showOrigins = (event: MouseEvent, ids: readonly string[]): void => {
    now.value = Date.now();
    // Two agents on one file is a real (if rare) case, and it is exactly the case a single title can't state —
    // so the card lists them and the first message stays out of it.
    hoverCard.value?.show(
        event,
        ids.length === 1
            ? { label: `Landed by`, title: originLabel(ids[0]!), note: originNote(ids[0]!), body: firstPromptOf(ids[0]!) }
            : { label: `Landed by`, title: ids.map((id) => originLabel(id)).join(`\n`) },
    );
};
// The name only rides the row once the panel is wide enough to hold it without evicting the path — and on
// mobile, where this panel is the whole screen.
const wide = computed(() => mobile.value || layout.sidebarWidth.value >= 320);

const matchesFilter = (repo: RepoChanges, change: GitChange): boolean => {
    if (originFilter.value === undefined) {
        return true;
    }
    const ids = originsOf(repo, change.path);
    return originFilter.value === YOURS ? ids.length === 0 : ids.includes(originFilter.value);
};

// The lists a repo group renders. Conflicts first because they BLOCK everything below them — git will not
// commit while one exists — then staged, then unstaged (VSCode's order, staged being what a bare commit takes).
// An empty section renders nothing at all rather than an empty header. "Unstaged", not VSCode's bare "Changes":
// this panel is itself titled Changes, so that label collided with its own header.
//
// The origin filter applies HERE, so everything downstream inherits it from one place: the rows, the range
// selection, the section verbs and the repo's Discard all. A "Stage all" under an active filter stages that
// agent's files and only those — which is the action the filter existed to make possible.
const sidesOf = (repo: RepoChanges): readonly { side: GitDiffSide; label: string; changes: readonly GitChange[] }[] =>
    [
        { side: `conflicted` as const, label: `Conflicts`, changes: repo.conflicted },
        { side: `staged` as const, label: `Staged`, changes: repo.staged },
        { side: `unstaged` as const, label: `Unstaged`, changes: repo.unstaged },
    ].flatMap((section) => {
        const shown = section.changes.filter((change) => matchesFilter(repo, change));
        return shown.length === 0 ? [] : [{ side: section.side, label: section.label, changes: shown }];
    });

// A section's own count only earns its pixels when there is more than one section to tell apart. Alone it is
// the repo row's badge repeated verbatim one line below it — the same number twice, one line apart.
const sidesSplit = (repo: RepoChanges): boolean => sidesOf(repo).length > 1;

// This panel lives in a ~270px sidebar, so labelled secondary buttons don't fit — four of them pushed the
// primary Commit off the edge entirely. Everything secondary is a 24px icon with a tooltip and an aria-label;
// only the primary action spends horizontal space on a word.
const ICON_BUTTON = `flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-overlay hover:text-content disabled:opacity-40`;

// Opens the diff of the ROW, not of the file: a staged row shows index-vs-HEAD, an unstaged row
// worktree-vs-index. The side rides the tab key too, so a partially staged file's two diffs open as two tabs
// instead of one silently replacing the other. A binary row carries its two sides' byte URLs as well — the
// response flags an image, it cannot contain one, and this row is what knows which diff to fetch it from.
const openDiff = (repo: string, side: GitDiffSide, change: GitChange): void => {
    void changes.fileDiff(repo, change.path, side).then((body) => {
        emit(`open-diff`, {
            key: `working:${repo}:${side}`,
            scope: repo,
            label: side === `staged` ? `${changeLabel(repo, change)} (staged)` : changeLabel(repo, change),
            status: change.status,
            path: change.path,
            ...body,
            ...diffRawUrls({ source: `working`, repo, side }, change.path, change.status),
        });
    });
};

// --- row selection (a list selection, NOT a commit target) -------------------------------------------------
// Ordinary click/ctrl/shift list selection, exactly as VSCode's SCM list works, and for exactly one purpose:
// so a single gesture can stage or discard several rows. It never reaches Commit — the index decides that — and
// it is forgotten the moment the rows underneath it change.
//
// The key carries the side because a path that is staged AND edited again is two rows with two different
// diffs. JSON rather than a delimiter: a repo id is a directory name and a path is arbitrary, so any literal
// separator is one unlucky filename away from two rows sharing a key.
interface Row {
    readonly repo: string;
    readonly side: GitDiffSide;
    readonly path: string;
}
const rowKey = (row: Row): string => JSON.stringify([row.repo, row.side, row.path]);

// Every row in render order, so shift-click resolves a range the way a flat list does — across sections and
// across repos. A collapsed repo contributes nothing: you cannot range through rows you cannot see.
const visibleRows = computed<readonly Row[]>(() =>
    scannable.value.flatMap((repo) =>
        collapsed.value.has(repo.repo)
            ? []
            : sidesOf(repo).flatMap((section) => section.changes.map((change) => ({ repo: repo.repo, side: section.side, path: change.path }))),
    ),
);

const selected = ref<ReadonlySet<string>>(new Set());
// Where a shift-range measures from — the last row the user touched deliberately.
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
    // A plain click is "look at this one": it collapses the selection and opens the diff, like any file list.
    selected.value = new Set([key]);
    anchor.value = key;
    openDiff(row.repo, row.side, change);
};

// Drop keys whose row no longer exists — committed, staged across to the other side, discarded, vanished.
watch(visibleRows, (rows) => {
    const live = new Set(rows.map(rowKey));
    const pruned = new Set([...selected.value].filter((key) => live.has(key)));
    if (pruned.size !== selected.value.size) {
        selected.value = pruned;
    }
});

// What a row action fires on: the whole selection when the clicked row is part of a multi-selection, that row
// alone otherwise. This is the rule every file list uses, and the only reason a selection is worth having.
// `sameSideOnly` narrows it for the index verbs — staging an already-staged row is meaningless — while discard
// is a worktree action and takes every selected path.
const actingRows = (row: Row, sameSideOnly: boolean): readonly Row[] => {
    const key = rowKey(row);
    const rows =
        selected.value.has(key) && selected.value.size > 1 ? visibleRows.value.filter((candidate) => selected.value.has(rowKey(candidate))) : [row];
    return sameSideOnly ? rows.filter((candidate) => candidate.side === row.side) : rows;
};

// git can't span repos, so every batch action is grouped into one request per repo. Paths dedupe: a path
// selected on both sides is still one worktree path to discard.
const byRepo = (rows: readonly Row[]): RepoPaths[] => {
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

// --- commit ------------------------------------------------------------------------------------------------
// The message is NOT component state: this panel is mounted behind a v-if, and going to look at the files you
// are describing must not throw away what you typed (see composables/workspace/commitMessage.ts).
// Staged repos are the commit target, full stop. With nothing staged anywhere but changes present, the button
// becomes "Commit all" — VSCode's "would you like to stage all your changes and commit them directly?", made
// an explicit label instead of a dialog, and served by the daemon's `all` shape.
const stagedRepos = computed(() => scannable.value.filter((repo) => repo.staged.length > 0).map((repo) => repo.repo));
// Never while an origin filter is on: "Commit all" stages EVERYTHING first, and a user who has narrowed the
// list to one agent would be recording the other agents' work under a message about this one. The filter
// narrows the list, not the index — so with nothing staged it stays a plain (disabled) Commit, and the way to
// commit that agent's work is the Stage all the filter has already narrowed for them.
const commitAll = computed(() => originFilter.value === undefined && stagedRepos.value.length === 0 && changes.count.value > 0);
const commitTarget = computed(() => (commitAll.value ? scannable.value.map((repo) => repo.repo) : stagedRepos.value));
// An unresolved conflict in ANY repo blocks the button, not just in the repo that has it: a commit here is one
// commit per repo sharing a message, and git would refuse the conflicted one halfway through — leaving the
// others committed under a message that describes work that didn't all land. Better to not start.
const blockedByConflicts = computed(() => scannable.value.some((repo) => repo.conflicted.length > 0));
const commitReady = computed(
    () => commitTarget.value.length > 0 && commitMessage.value.trim().length > 0 && !blockedByConflicts.value && !changes.actionBusy.value,
);
const commitLabel = computed(() => (commitAll.value ? `Commit all` : `Commit`));

/* --- committing an unfinished session's work ------------------------------------------------------------------
 * The sessions this commit would RECORD, and which of them are still going. Scoped exactly like the button:
 * the staged side alone for a plain Commit (a commit records the index), every side for "Commit all", and only
 * the repos in `commitTarget` — the same rule the whole family of files shares.
 *
 * A warning rather than a gate, for the same reason as the mid-write one below: nothing here is at risk of
 * corruption, the commit is a legitimate thing to make (staging the first half of an agent's work on purpose is
 * ordinary), and `reset --soft` walks it back. What it prevents is the silent version — committing under a
 * subject that describes an intent the agent has not finished carrying out, which is exactly what the legend's
 * click-to-name makes easy to do without noticing. */
const commitOrigins = computed(
    () =>
        summarizeOrigins(
            scannable.value.filter((repo) => commitTarget.value.includes(repo.repo)),
            commitAll.value ? ALL_SIDES : [`staged`],
        ).agents,
);
const unfinished = computed(() => commitOrigins.value.filter((entry) => originMark(entry.id) !== undefined));

/* --- committing while an agent works ------------------------------------------------------------------------
 * THE INDEX IS ALREADY THE ISOLATION, which is why nothing here blocks. A plain Commit records what you
 * staged — a snapshot git took at stage time, which no later worktree write can alter — so a turn running in
 * the background cannot get into it, and refusing to commit during one bought exactly nothing. "Commit all" is
 * the single exception: `commit -a` reads the WORKTREE, so a file an agent is halfway through writing goes in
 * as it stands.
 *
 * So the panel warns, and only where that is true: a MAIN-TREE turn writing a repo this Commit all would
 * sweep. An isolated turn is silent — it works in its own worktree and reaches this tree only through land,
 * which the daemon serializes against every git write this panel makes (git.routes.ts), so there is no race
 * left to warn about. The block this replaces did the opposite of all of that: it read one chat tab's stream,
 * so it stopped you for the isolated turns that could never touch your commit while waving through the
 * background main-tree turns that could — across every repo, including the ones nothing was writing.
 *
 * The residual case it cannot see is a main-tree agent running `git add` itself: that moves the index under a
 * staged commit, and a Bash call reports no locations to detect it by. Recoverable (`reset --soft`), rare, and
 * not worth warning about on every commit to catch. */
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
// Named in the warning, and the difference between the two lists is the escape hatch: everything else is
// committable right now, which is the whole point of scoping this per repo instead of per workspace.
const atRisk = computed(() => (commitAll.value ? commitTarget.value.filter((repo) => writingRepos.value.has(repo)) : []));
const unaffected = computed(() => commitTarget.value.filter((repo) => !writingRepos.value.has(repo)));

const runCommit = async (target: readonly string[]): Promise<void> => {
    await changes.commitRepos(target, commitMessage.value, commitAll.value);
    // Keep the message on failure — it is the one thing here the user typed by hand.
    if (!changes.failures.value.has(COMMIT_SCOPE)) {
        commitMessage.value = ``;
    }
};
// Ctrl+Enter reaches this too, and a keyboard path that silently does nothing is the worst way to say no —
// the user retries the same chord harder. When the button is off, say which of its three reasons applies.
const commitBlocker = computed<string | undefined>(() => {
    if (blockedByConflicts.value) {
        return `Resolve the conflicts first — git cannot commit while a path is unmerged.`;
    }
    if (commitTarget.value.length === 0) {
        // The one genuinely puzzling empty target: an origin filter suppresses "Commit all" (it would stage
        // every agent's work under a message about one), so the button goes quiet with changes on screen.
        return originFilter.value === undefined
            ? `Nothing to commit.`
            : `Nothing staged — "Commit all" is off while the list is filtered. Stage what you want first.`;
    }
    if (commitMessage.value.trim().length === 0) {
        return `Write a commit message first.`;
    }
    return changes.actionBusy.value ? `Another git action is still running.` : undefined;
});
// Shown where the readout sits, for the moment after a rejected Ctrl+Enter. Cleared by the next edit to the
// message, so it never outlives the state it describes.
const blockerNotice = ref<string | undefined>(undefined);
watch([commitMessage, commitBlocker], () => {
    blockerNotice.value = undefined;
});
const doCommit = async (): Promise<void> => {
    if (!commitReady.value) {
        blockerNotice.value = commitBlocker.value;
        return;
    }
    await runCommit(commitTarget.value);
};

/* --- AI autofill ---------------------------------------------------------------------------------------------
 * One click drafts the subject line from what this commit will actually record — the same `commitTarget` and
 * `commitAll` the button below reads, so the message can never describe a different set of changes than the
 * commit contains.
 *
 * It runs on the sandbox's QUICK MODEL (the cheap rung — see the contract's quick-model.ts), never on whatever
 * the chat is set to: a commit subject is a mechanical job, and spending a frontier model's quota on one is the
 * thing this whole feature exists to avoid. The tooltip names the model and where to change it, which is how
 * the setting on Sandbox ▸ Agent gets discovered at all.
 *
 * Everything it has to say goes in the READOUT SLOT the blocker notice already owns — "Drafted with X · Undo",
 * or why it failed. Same reasoning as blockerNotice: that line answers "what is this box about to do", a draft
 * is an answer to exactly that, and a two-line box cannot afford a row per state. */
const commitDraft = useCommitDraft();
const quickModel = useQuickModel();
// Off when there is nothing to describe or nothing to describe it with. `commitTarget` is empty in exactly the
// cases the Commit button is also off, so the two never disagree about whether this commit exists.
const autofillReady = computed(() => commitTarget.value.length > 0 && quickModel.choice.value !== undefined && !commitDraft.busy.value);
const autofillHint = computed(() => {
    if (quickModel.choice.value === undefined) {
        return `Connect an AI account in Sandbox ▸ Agent to draft commit messages.`;
    }
    if (commitTarget.value.length === 0) {
        return `Nothing to describe yet — stage the changes you want to commit.`;
    }
    const scope = commitAll.value ? `every uncommitted change` : `the staged changes`;
    return `Draft a message from ${scope} using ${quickModel.label.value} — change the model in Sandbox ▸ Agent.`;
});
const runAutofill = async (): Promise<void> => {
    // A click while it is running means stop, not "run it again" — the model call is already paid for either
    // way, and queueing a second would only overwrite the first answer with a near-identical one.
    if (commitDraft.busy.value) {
        commitDraft.cancel();
        return;
    }
    if (!autofillReady.value) {
        blockerNotice.value = autofillHint.value;
        return;
    }
    const message = await commitDraft.draft(commitTarget.value, commitAll.value, commitMessage.value);
    if (message !== undefined) {
        commitMessage.value = message;
    }
};
const undoAutofill = (): void => {
    const restored = commitDraft.undo();
    if (restored !== undefined) {
        commitMessage.value = restored;
    }
};
// The user has taken the message somewhere else — "Undo" would now restore text that predates their edit, and
// "Drafted with X" would be describing a message they have since rewritten. Compared against the draft rather
// than watching blindly so writing the draft itself doesn't immediately clear its own readout.
watch(commitMessage, (message) => {
    if (commitDraft.drafted.value !== undefined && message !== commitDraft.drafted.value.message) {
        commitDraft.forget();
    }
});

// --- stage / unstage ---------------------------------------------------------------------------------------
// `staged` is the one side that moves BACK out of the index; the other two move in. For a conflict that inward
// move is `git add`, which is precisely how you tell git the merge is resolved — same request, different word
// on the button.
const movesIntoIndex = (side: GitDiffSide): boolean => side !== `staged`;
// Read through sidesOf, so a section verb can only ever touch the rows the section is actually showing.
const changesOn = (repo: RepoChanges, side: GitDiffSide): readonly GitChange[] =>
    sidesOf(repo).find((section) => section.side === side)?.changes ?? [];

// What that inward/outward move is CALLED, per side. A conflict says "resolve", not "stage": `git add` on an
// unmerged path is not putting a change in the index, it is telling git you have settled which side wins. Same
// request either way, and calling it staging would hide the only thing the user actually needs to understand.
const INDEX_VERB: Record<GitDiffSide, { readonly one: string; readonly all: string; readonly icon: "plus" | "undo" | "check" }> = {
    conflicted: { one: `Mark resolved`, all: `Mark all resolved`, icon: `check` },
    unstaged: { one: `Stage`, all: `Stage all`, icon: `plus` },
    staged: { one: `Unstage`, all: `Unstage all`, icon: `undo` },
};

// Row action: moves the acting rows across the index, in the direction their side implies.
const stageRow = (row: Row): Promise<void> => changes.stageGroups(byRepo(actingRows(row, true)), movesIntoIndex(row.side));
// Section action: the whole side, regardless of selection — VSCode's "Stage All Changes" / "Unstage All".
const stageSide = (repo: RepoChanges, side: GitDiffSide): Promise<void> =>
    changes.stageGroups([{ repo: repo.repo, paths: changesOn(repo, side).map((change) => change.path) }], movesIntoIndex(side));

// --- discard -----------------------------------------------------------------------------------------------
// A modal confirm, like every other destructive git action in this app (GitGraph's checkout/reset/drop), rather
// than the inline warning strip this replaces: that one wedged itself between the repo row and the file list,
// shoved everything below it down, and read as an error that had already happened rather than a question.
//
// The target is RESOLVED when the user arms it — the prompt's wording and the action can never disagree, and a
// background poll landing between the two clicks cannot change what gets destroyed. That is also what lets the
// copy be specific: the old prompt said "Untracked files are deleted" unconditionally, crying wolf on every
// repo that had none, so the one case where a file really was about to be deleted looked like all the others.
interface DiscardTarget {
    // The heading's object — "every uncommitted change in intentic", "3 selected files", a single path.
    readonly what: string;
    // Untracked paths, which are DELETED rather than reverted: nothing in the object store holds them, so they
    // are the only part of a discard the user cannot get back from git itself.
    readonly deletes: readonly string[];
    // Distinct tracked paths returning to their last committed state.
    readonly restores: number;
    readonly groups: readonly RepoPaths[];
}
const pendingDiscard = ref<DiscardTarget | undefined>(undefined);

// "added" on the UNSTAGED side means untracked — the worktree has a file the index does not. A tracked file can
// never report added there (it is already in the index), so this is exact, not a heuristic.
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
    // byRepo already deduped a path selected on both sides, so this counts worktree paths, not rows.
    const paths = groups.reduce((total, group) => total + (group.paths?.length ?? 0), 0);
    pendingDiscard.value = {
        what: paths > 1 ? `${paths} selected files` : changeLabel(row.repo, change),
        deletes,
        restores: paths - deletes.length,
        groups,
    };
};

// The repo's own Discard. Under an origin filter it narrows to that origin's files — the row it hangs off is
// showing that subset, and wiping another agent's work from a list that isn't displaying it would be the worst
// kind of surprise. Unfiltered it stays the whole repo (no `paths` in the group ⇒ the daemon discards it all).
const askDiscardRepo = (repo: RepoChanges): void => {
    // Distinct paths: a path staged AND edited again is two rows but one file on disk, and the prompt is
    // counting what happens to the disk.
    const paths = new Set(sidesOf(repo).flatMap((section) => section.changes.map((change) => change.path)));
    const deletes = repo.unstaged.filter((change) => change.status === `added` && paths.has(change.path)).map((change) => change.path);
    pendingDiscard.value = {
        what:
            originFilter.value === undefined
                ? `every uncommitted change in ${repo.repo}`
                : `${plural(paths.size, `file`)} from ${originFilter.value === YOURS ? `you` : originLabel(originFilter.value)} in ${repo.repo}`,
        deletes,
        restores: paths.size - deletes.length,
        groups: [originFilter.value === undefined ? { repo: repo.repo } : { repo: repo.repo, paths: [...paths] }],
    };
};

const confirmDiscard = async (): Promise<void> => {
    const target = pendingDiscard.value;
    pendingDiscard.value = undefined;
    if (target !== undefined) {
        await changes.discardGroups(target.groups);
    }
};

// --- remote sync ------------------------------------------------------------------------------------------
// Sync affordances show only for a repo that actually has a remote; a purely local repo gets no dead controls.
// Each verb then earns its place from state: pull when behind, push when ahead, Publish when the branch has no
// upstream at all. Fetch is the exception — it is what MAKES ahead/behind trustworthy, so it is always offered.
const syncable = (repo: RepoChanges): boolean => repo.remote?.remote !== undefined;
const unpublished = (repo: RepoChanges): boolean => syncable(repo) && repo.remote?.upstream === undefined;
const ahead = (repo: RepoChanges): number => repo.remote?.ahead ?? 0;
const behind = (repo: RepoChanges): number => repo.remote?.behind ?? 0;

// The pills carry only a direction and a number, so the tooltip is where the whole sentence goes — including
// WHICH ref is involved, which the folded row no longer spends a line printing.
const pullHint = (repo: RepoChanges): string =>
    `Pull ${plural(behind(repo), `commit`)} from ${repo.remote?.upstream} — fast-forward only; a diverged history is reported, never auto-merged`;
const pushHint = (repo: RepoChanges): string => `Push ${plural(ahead(repo), `commit`)} to ${repo.remote?.upstream}`;

// --- the primary sync action --------------------------------------------------------------------------------
// VSCode's post-commit move: the same prominent slot the user just used to Commit becomes the sync the repos now
// need, so "push what I just committed" is one labelled click where they are already looking — not the muted ↑N
// pill on a repo row that most people never register as a button at all. It takes the slot only once the commit
// box has nothing left to show (no uncommitted work anywhere); the per-row pills stay the granular control for a
// set whose repos each need something different.
const syncRepos = computed(() => scannable.value.filter((repo) => syncable(repo) && (ahead(repo) > 0 || behind(repo) > 0 || unpublished(repo))));
const aheadTotal = computed(() => syncRepos.value.reduce((total, repo) => total + ahead(repo), 0));
const behindTotal = computed(() => syncRepos.value.reduce((total, repo) => total + behind(repo), 0));
const toPublish = computed(() => syncRepos.value.some((repo) => unpublished(repo)));
// The verb mirrors the row pills so the bar can never contradict them: Pull when the only work is incoming, Push
// when it is only outgoing, Publish when the only work is a branch with no upstream yet, and Sync when a repo (or
// the set as a whole) carries both sides at once. Mixed publish + outgoing reads Push, whose per-repo fan-out
// publishes the un-tracked branches anyway.
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
// Label, glyph and the whole-sentence tooltip per verb — the same shape INDEX_VERB uses for the stage buttons.
// The icons match the row pills (↑ push, ↓ pull) so the bar and the rows read as one language.
const SYNC_VERB: Record<
    "push" | "pull" | "sync" | "publish",
    { readonly label: string; readonly icon: "arrow-up-right" | "arrow-down-left" | "sync" | "cloud-upload"; readonly hint: string }
> = {
    push: { label: `Push`, icon: `arrow-up-right`, hint: `Push your committed work to each repo's upstream` },
    pull: {
        label: `Pull`,
        icon: `arrow-down-left`,
        hint: `Fast-forward each repo from its upstream — a diverged history is reported, never auto-merged`,
    },
    sync: { label: `Sync`, icon: `sync`, hint: `Pull each repo up to its upstream (fast-forward only), then push your committed work` },
    publish: { label: `Publish`, icon: `cloud-upload`, hint: `Push and start tracking each branch on its remote` },
};
const syncMeta = computed(() => (syncVerb.value === undefined ? undefined : SYNC_VERB[syncVerb.value]));
// The one-line readout beside the button — the counts its single word leaves out, plus the repo spread when more
// than one repo is in play, so a multi-repo sync says so before it fires. A pure publish has nothing to count.
const syncSummary = computed<string>(() => {
    const counts = [...(behindTotal.value > 0 ? [`↓${behindTotal.value}`] : []), ...(aheadTotal.value > 0 ? [`↑${aheadTotal.value}`] : [])];
    const spread = syncRepos.value.length > 1 ? ` · ${plural(syncRepos.value.length, `repo`)}` : ``;
    return (counts.length > 0 ? counts.join(` `) : `no upstream yet`) + spread;
});
/* --- the push guardrail --------------------------------------------------------------------------------------
 * EVERY push in this panel funnels through `askSync` — the bar's Push/Sync/Publish and both of a repo row's
 * pills — because a second way to reach the same verb is a way around the guardrail. That is also why
 * useChanges no longer exports a one-repo push: a single door is the only kind that can be guarded.
 *
 * WHY THE PUSH AND NOT THE COMMIT. The commit is the user's own review boundary and stays unguarded; nothing has
 * left the machine yet, and interrupting the act of recording work would be objecting to the wrong thing. The
 * push is the last moment before CI owns the answer, and it is reached — habitually — within a minute of the
 * land, often inside the gate's own quiet period. So this is where the verdict finally gets a word in.
 *
 * IT IS A GUARDRAIL, NOT A GATE, and the asymmetry is deliberate: the objection is a sentence and a button, and
 * Push anyway is always there. The user knows things the verdict does not — that the failure is the one they are
 * pushing a fix for, that the suite is flaky, that they need this on a branch to look at it in CI. A prompt that
 * merely slows down a decision the user has already made would get muscle-memoried away within a week; one that
 * BLOCKED it would get the whole gate switched off.
 *
 * A pull-only sync passes straight through: nothing leaves the machine, so the gate has no standing to comment.
 *
 * The objection is resolved AT THE CLICK, exactly like the discard prompt above, so the sentence the user reads
 * is the one the verdict said then — a poll landing between the two clicks cannot change the question they are
 * answering. */
interface PendingSync {
    // The word the control the user clicked was wearing, so the prompt answers that click instead of renaming it.
    readonly verb: string;
    // What is about to leave — "3 commits across 2 repos", "intentic's branch".
    readonly what: string;
    readonly objection: string;
    readonly targets: readonly SyncTarget[];
}
const pendingSync = ref<PendingSync | undefined>(undefined);

const askSync = (verb: string, what: string, targets: readonly SyncTarget[]): void => {
    if (changes.actionBusy.value) {
        return;
    }
    const objection = targets.some((target) => target.push) ? gate.pushObjection.value : undefined;
    if (objection === undefined) {
        void changes.syncAll(targets);
        return;
    }
    pendingSync.value = { verb, what, objection, targets };
};

const confirmSync = (): void => {
    const target = pendingSync.value;
    pendingSync.value = undefined;
    if (target !== undefined) {
        void changes.syncAll(target.targets);
    }
};

// The constructive way out: start the checks and DON'T push. The badge above follows them from there, so the
// user comes back to a push that has an answer behind it. Hidden while a run is already going — there is nothing
// to start, and offering it would read as though the gate had missed the first click.
const runChecksInstead = (): void => {
    pendingSync.value = undefined;
    void gate.run();
};

// One click, every repo that has remote work — git can't span remotes, so the composable fans it out into one
// real sync per repo (pull what's behind, then push/publish what's ahead), each failure landing on its own row.
const doSync = (): void =>
    askSync(
        syncMeta.value?.label ?? `Sync`,
        `${aheadTotal.value > 0 ? plural(aheadTotal.value, `commit`) : `this branch`}${syncRepos.value.length > 1 ? ` across ${plural(syncRepos.value.length, `repo`)}` : ``}`,
        syncRepos.value.map((repo) => ({ repo: repo.repo, pull: behind(repo) > 0, push: ahead(repo) > 0 || unpublished(repo) })),
    );

// A row's own pill: this repo, outgoing only. Publish and ↑N differ in wording, not in what they send.
const askPushRepo = (repo: RepoChanges): void =>
    askSync(
        unpublished(repo) ? `Publish` : `Push`,
        unpublished(repo) ? `${repo.repo}'s branch` : `${plural(ahead(repo), `commit`)} in ${repo.repo}`,
        [{ repo: repo.repo, pull: false, push: true }],
    );

// Ahead/behind are only ever as fresh as the last fetch, which is why fetch is offered even when both read
// zero — the zero itself is the claim most likely to be stale.
const SYNC_PILL = `flex h-5 shrink-0 items-center gap-0.5 rounded px-1 text-2xs text-muted transition-colors hover:bg-overlay hover:text-content disabled:opacity-40`;
// Hover-revealed, but always laid out: revealing on hover must not move anything, or the button slides out
// from under the cursor that summoned it. Touch has no hover, so mobile keeps them visible.
const ROW_ACTION = `opacity-0 transition-opacity focus-visible:opacity-100 group-hover/repo:opacity-100 max-md:opacity-100`;

// A repo's own change count, for the row badge — every side it is SHOWING, so under an origin filter the badge
// counts what the list holds rather than advertising rows the filter is hiding. The daemon-truncated remainder
// counts too: a repo with 30k deletions must read as 30k, not as the 500 rows that fit the payload.
const repoCount = (repo: RepoChanges): number => sidesOf(repo).reduce((total, section) => total + section.changes.length, repo.truncated ?? 0);

// Where a failed action gets drawn: the repo's own row, or the commit box for a commit that spans repos.
const failureIn = (scope: string) => changes.failures.value.get(scope);

// Shared shells for the two things this panel says when something is wrong. A notice is a contained block with
// a border, not loose coloured text — the old bare red sentence at the top of the panel was indistinguishable
// from the panel's own content, which is most of why a git message read as gibberish rather than as an error.
const NOTICE = `flex items-start gap-1.5 rounded-md border border-danger/40 bg-danger/10 px-2 py-1.5`;
// The same strip one severity down. Danger is reserved for what already went wrong; this is a heads-up about
// something that hasn't, on an action the user is still free to take.
const WARNING = `flex items-start gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-2 py-1.5`;
</script>

<template>
    <div class="flex min-h-0 flex-1 flex-col">
        <!-- No header row of its own: the mode switch directly above already reads "Changes" WITH the count, and
             a second title line one pixel below it spent a row restating both. The panel's two panel-wide
             actions (git history, refresh) live on that switch's row instead — see WorkspaceDesktop. -->

        <!-- The ONE genuinely panel-wide failure: the review set itself could not be read, so nothing below is
             trustworthy. Every other error belongs to a repo row or the commit box and is drawn there. -->
        <div v-if="changes.error.value" :class="[NOTICE, 'mx-2 mt-2 shrink-0']">
            <Icon name="exclamation-triangle" class="mt-0.5 shrink-0 text-2xs text-danger" />
            <div class="min-w-0 flex-1">
                <p class="text-2xs font-medium text-danger">Couldn't read changes</p>
                <p class="break-words text-2xs text-muted">{{ changes.error.value }}</p>
            </div>
        </div>

        <!-- Would this tree survive CI? Above the commit box because it is what the user needs BEFORE deciding
             what to commit, and because the verdict was computed minutes ago (the daemon runs the check a short
             while after the last land — gate/gate.ts) rather than being waited for here. It never disables
             Commit: the panel reports, the user decides. Draws nothing when no check command is configured.

             It outlasts the commit box on purpose. Committing empties `count` but changes no content, so the
             verdict still describes the tree exactly (the fingerprint is the worktree's own tree sha, invariant
             to staging and committing — gate/gate.ts), and the minutes between the last commit and the push are
             when it matters most. Gone only when there is neither uncommitted work nor anything to send. -->
        <GateBadge v-if="changes.count.value > 0 || syncRepos.length > 0" />

        <!-- Commit box (VSCode places it at the top). It records the index — staging is the selection. -->
        <div v-if="changes.count.value > 0" class="flex shrink-0 flex-col gap-1.5 border-b border-line p-2">
            <!-- The AI autofill sits INSIDE the input's right edge (VSCode's "Generate Commit Message"
                 placement): it acts on the field it is drawn in, and the sidebar has no room for a second
                 labelled button beside Commit. Extra right padding keeps a long message from running under it. -->
            <div class="relative">
                <input
                    v-model="commitMessage"
                    type="text"
                    placeholder="Message (Ctrl+Enter to commit)"
                    class="w-full min-w-0 rounded-md border border-line bg-canvas py-1 pl-2 pr-7 text-xs text-content placeholder:text-subtle focus:border-line-strong focus:outline-none"
                    @keydown.ctrl.enter="doCommit"
                    @keydown.meta.enter="doCommit"
                />
                <button
                    type="button"
                    class="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-subtle transition-colors hover:bg-overlay hover:text-content disabled:cursor-not-allowed disabled:opacity-40"
                    :disabled="!autofillReady && !commitDraft.busy.value"
                    @click="runAutofill"
                    v-tooltip.right="commitDraft.busy.value ? 'Stop drafting' : autofillHint"
                    :aria-label="commitDraft.busy.value ? 'Stop drafting the commit message' : 'Draft the commit message with AI'"
                >
                    <Icon :name="commitDraft.busy.value ? 'spinner' : 'sparkles'" class="text-2xs" :spin="commitDraft.busy.value" />
                </button>
            </div>
            <!-- What the commit will record, then the one button that records it. No checkboxes: the sentence
                 on the left is a readout of the index, not a control. A conflict replaces it outright — nothing
                 about the index matters while git is refusing to commit at all. -->
            <div class="flex items-center gap-1">
                <span v-if="blockedByConflicts" class="min-w-0 flex-1 truncate whitespace-nowrap text-2xs text-danger">
                    Resolve conflicts first
                </span>
                <!-- Why the button just refused a Ctrl+Enter. It takes the readout's place rather than adding a
                     line, because it answers the same question the readout does — what will this commit do. -->
                <span
                    v-else-if="blockerNotice"
                    class="min-w-0 flex-1 truncate whitespace-nowrap text-2xs text-warning"
                    v-tooltip.right.overflow="blockerNotice"
                >
                    {{ blockerNotice }}
                </span>
                <!-- The autofill failed. Same slot, same reasoning: the user clicked a button in this box and
                     nothing appeared, so the answer belongs where they are already looking. -->
                <span
                    v-else-if="commitDraft.error.value"
                    class="min-w-0 flex-1 truncate whitespace-nowrap text-2xs text-danger"
                    v-tooltip.right.overflow="commitDraft.error.value"
                >
                    {{ commitDraft.error.value }}
                </span>
                <!-- The message on screen was written by a model, and by WHICH one — with the single click that
                     takes it back. Undo has to be offered explicitly because writing through v-model leaves the
                     browser's own Ctrl+Z with nothing to restore; it is also what makes overwriting a typed
                     message safe enough to need no confirmation. -->
                <span v-else-if="commitDraft.drafted.value" class="flex min-w-0 flex-1 items-center gap-1 text-2xs text-muted">
                    <span class="min-w-0 truncate whitespace-nowrap" v-tooltip.right.overflow="`Drafted with ${commitDraft.drafted.value.model}`">
                        Drafted with {{ commitDraft.drafted.value.model }}
                    </span>
                    <button
                        v-if="commitDraft.previous.value !== undefined"
                        type="button"
                        class="shrink-0 rounded px-1 text-2xs text-muted underline decoration-dotted transition-colors hover:text-content"
                        @click="undoAutofill"
                        v-tooltip.right="
                            commitDraft.previous.value === ``
                                ? `Clear the drafted message`
                                : `Put back what you had typed: ${commitDraft.previous.value}`
                        "
                    >
                        Undo
                    </button>
                </span>
                <span v-else class="min-w-0 flex-1 truncate whitespace-nowrap text-2xs text-muted">
                    <template v-if="changes.stagedCount.value > 0"
                        >{{ changes.stagedCount.value }} staged<span v-if="stagedRepos.length > 1"> · {{ stagedRepos.length }} repos</span></template
                    >
                    <template v-else>nothing staged</template>
                </span>
                <button
                    type="button"
                    :class="cmp.buttonSuccess('shrink-0 gap-0 whitespace-nowrap px-2 py-1 text-2xs')"
                    :disabled="!commitReady"
                    @click="doCommit"
                    v-tooltip.right="
                        blockedByConflicts
                            ? 'A path is unmerged — stage each conflicted file to mark it resolved'
                            : commitAll
                              ? 'Stages every change, then commits'
                              : 'One commit per repo'
                    "
                >
                    <Icon name="check" class="mr-1 text-2xs" />{{ commitLabel }}
                </button>
            </div>
            <!-- An agent is writing, in a repo this Commit all would sweep from the worktree. A WARNING, not a
                 gate: the commit is the user's to make and `reset --soft` walks it back, so the button above
                 stays live. What the strip adds is the thing the old block never offered — the repos nobody is
                 writing, committable in one click, which is the whole "let me commit something unrelated" case. -->
            <div v-if="atRisk.length > 0" :class="WARNING">
                <Icon name="exclamation-triangle" class="mt-0.5 shrink-0 text-2xs text-warning" />
                <div class="min-w-0 flex-1">
                    <p class="break-words text-2xs text-warning">
                        An agent is editing {{ atRisk.join(`, `) }} right now — "Commit all" records
                        {{ atRisk.length === 1 ? `it` : `them` }} mid-write.
                    </p>
                    <button
                        v-if="unaffected.length > 0"
                        type="button"
                        class="mt-1 inline-flex items-center whitespace-nowrap rounded border border-line px-1.5 py-0.5 text-2xs text-muted transition-colors hover:bg-overlay hover:text-content disabled:opacity-40"
                        :disabled="!commitReady"
                        @click="runCommit(unaffected)"
                        v-tooltip.right="`Commits ${unaffected.join(`, `)}`"
                    >
                        <Icon name="check" class="mr-1 text-2xs" />Commit
                        {{ unaffected.length === 1 ? unaffected[0] : `the other ${unaffected.length} repos` }}
                    </button>
                </div>
            </div>
            <!-- A session whose work this commit records is STILL GOING. Not the race the strip above warns
                 about — the index already froze these files and nothing can move them — but the other half of
                 the same question: what you are about to record is that session's work so far, and it has more
                 coming. Named rather than counted, because "which agent" is what decides whether you wait. -->
            <div v-if="unfinished.length > 0" :class="WARNING">
                <Icon name="wave-pulse" class="mt-0.5 shrink-0 text-2xs text-warning" />
                <p class="min-w-0 flex-1 break-words text-2xs text-warning">
                    {{ unfinished.map((entry) => originLabel(entry.id)).join(`, `) }}
                    {{ unfinished.length === 1 ? `hasn't` : `haven't` }} finished — this commit records the
                    {{ unfinished.reduce((total, entry) => total + entry.files, 0) === 1 ? `file` : `files` }} landed so far.
                </p>
            </div>
            <!-- A commit spans every staged repo, so its failure belongs to the box that fired it — under the
                 button, where the user is already looking, with the message they typed still in the input. -->
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

        <!-- Once there is nothing left to commit, the commit box hands the primary slot to the sync the repos
             actually need — VSCode's post-commit button. Same place, same weight, so the commits you just made
             are one labelled click from their remote instead of a muted pill you had to spot on a repo row. Every
             sync failure renders on its own repo row below (each is filed per repo), so this bar carries only the
             action and a one-line readout of what it will do. -->
        <div v-else-if="syncMeta !== undefined" class="flex shrink-0 items-center gap-1 border-b border-line p-2">
            <span class="min-w-0 flex-1 truncate whitespace-nowrap text-2xs text-muted">{{ syncSummary }}</span>
            <button
                type="button"
                :class="cmp.buttonPrimary('shrink-0 gap-0 whitespace-nowrap px-2 py-1 text-2xs')"
                :disabled="changes.actionBusy.value"
                @click="doSync"
                v-tooltip.right="syncMeta!.hint"
            >
                <Icon :name="syncMeta!.icon" class="mr-1 text-2xs" />{{ syncMeta!.label }}
            </button>
        </div>

        <!-- WHOSE WORK IS IN MY TREE — one line, only when an agent actually landed something. Each entry is a
             filter: it narrows the list (and every section verb below it) to that origin's files, so "stage
             everything this agent did" is two clicks and no path-picking. "you" is the complement — the files
             no agent landed, which is also every terminal edit and anything the daemon can't attribute.
             A chip is a logo and a file count — NOT a title. Six sessions with their titles spelled out wrapped
             this strip to five rows and pushed the file list, the thing being reviewed, off the fold; and the
             title was the one part already written twice elsewhere (the hover card, and the file rows' own
             origin column). So the compact chip is the resting state, and the ONE chip whose identity is
             load-bearing — the one you have filtered to, which is now silently hiding rows — earns its title
             inline. Everything else stays a hover away, on the SAME card the file rows and the chat tab strip
             raise for that session. What the click does needs no words either: the chips visibly dim to leave
             the filtered one lit.
             The click ALSO names the commit, with that session's title (toggleOrigin) — the second half of the
             "commit this agent's work" intent the filter was always the first half of. And a chip whose session
             has not finished wears a leading dot, because a count from a session still running is an instalment
             rather than a total, and every other reading on this panel silently assumes a total. -->
        <div v-if="legend.agents.length > 0" class="flex shrink-0 flex-wrap items-center gap-1 border-b border-line px-2 py-1.5">
            <span class="shrink-0 text-2xs uppercase tracking-wide text-subtle">From</span>
            <button
                v-for="entry in legend.agents"
                :key="entry.id"
                type="button"
                class="flex min-w-0 max-w-full items-center gap-1 rounded-full py-px pl-1 pr-1.5 text-2xs transition-opacity"
                :class="[
                    originHue(entry.id).chip,
                    originFilter === entry.id ? 'shrink' : 'shrink-0',
                    originFilter !== undefined && originFilter !== entry.id ? 'opacity-40' : '',
                ]"
                @click="toggleOrigin(entry.id)"
                @mouseenter="showOrigins($event, [entry.id])"
                @mouseleave="hoverCard?.hide()"
                :aria-label="`${originFilter === entry.id ? `Clear the filter on` : `Show only`} ${originLabel(entry.id)} — ${plural(entry.files, `file`)}${
                    originMark(entry.id) ? `, ${originMark(entry.id)!.label.toLowerCase()}` : ``
                }${originTitle(entry.id) ? `; names the commit` : ``}`"
            >
                <!-- The session has not finished with your tree: its count above is an instalment, not a total.
                     A dot rather than a status glyph, and BEFORE the logo rather than on it — the logo is 11px,
                     which leaves no corner to put anything in, and this strip's hard constraint is horizontal
                     (spelled-out titles once wrapped it to five rows and pushed the file list off the fold). A
                     leading dot costs 10px, only on the rare chip that is actually live, and the words are one
                     hover away on the card the chip already raises. -->
                <span v-if="originMark(entry.id)" class="h-1.5 w-1.5 shrink-0 rounded-full" :class="originMark(entry.id)!.dot"></span>
                <ProviderLogo v-if="originProvider(entry.id)" :provider="originProvider(entry.id)!" class="shrink-0 text-2xs" />
                <Icon v-else name="sparkles" class="shrink-0 text-2xs" />
                <span v-if="originFilter === entry.id" class="min-w-0 truncate">{{ originLabel(entry.id) }}</span>
                <span class="shrink-0 opacity-70">{{ entry.files }}</span>
            </button>
            <button
                v-if="legend.yours > 0"
                type="button"
                class="flex shrink-0 items-center gap-1 rounded-full bg-overlay px-1.5 py-px text-2xs text-muted transition-opacity"
                :class="originFilter !== undefined && originFilter !== YOURS ? 'opacity-40' : ''"
                @click="toggleOrigin(YOURS)"
                v-tooltip.right="'Your own edits, the terminal, a main-tree chat'"
            >
                you <span class="opacity-70">{{ legend.yours }}</span>
            </button>
        </div>

        <div class="scrollbar-thin min-h-0 flex-1 overflow-auto py-1">
            <p v-if="changes.loading.value && changes.count.value === 0" class="px-3 py-2 text-2xs text-subtle">Loading changes…</p>
            <!-- "No changes" only when there is genuinely nothing to say: a repo that failed to scan, or one
                 merely out of sync with its remote, has its own row below, and claiming an all-clear over
                 either would be the same silence this reports instead. -->
            <p v-else-if="changes.count.value === 0 && scannable.length === 0 && unscannable.length === 0" class="px-3 py-2 text-2xs text-subtle">
                No uncommitted changes. Edits by you or the agent show up here to review, commit, or discard.
            </p>

            <!-- Repos git refused to scan. Same row rhythm as a real group — the repo still gets its name on a
                 row, because dropping it from the list is the silent disappearance this reports instead — with
                 git's reason in the same notice every other failure here uses. There is nothing to stage,
                 commit or discard, so the row carries no actions at all. -->
            <div v-for="group in unscannable" :key="group.repo" class="border-b border-line/50">
                <div class="flex min-w-0 items-center gap-1.5 py-1.5 pl-2 pr-1">
                    <Icon name="exclamation-triangle" class="shrink-0 text-2xs text-danger" />
                    <span class="min-w-0 truncate text-xs font-medium text-content">{{ group.repo }}</span>
                </div>
                <div :class="[NOTICE, 'mx-2 mb-1.5']">
                    <div class="min-w-0 flex-1">
                        <p class="text-2xs font-medium text-danger">Couldn't read this repo</p>
                        <p class="line-clamp-4 break-words text-2xs text-muted" v-tooltip.top.overflow="group.error">{{ group.error }}</p>
                    </div>
                </div>
            </div>

            <div v-for="group in scannable" :key="group.repo" class="group/repo border-b border-line/50">
                <!-- One row per repo, carrying everything about it: identity on the left, then sync state, the
                     change count, and the two actions that don't depend on state. The pills ARE the verbs —
                     clicking "↓2" pulls those two commits — so a repo that is in sync costs exactly this row
                     and no more, where it used to cost this row plus a full-width bar mostly reading zero. -->
                <div class="flex items-center gap-1 pr-1 transition-colors hover:bg-overlay">
                    <button
                        type="button"
                        class="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pl-2 text-left max-md:min-h-11"
                        @click="toggleGroup(group.repo)"
                    >
                        <Icon class="shrink-0 text-2xs text-subtle" :name="collapsed.has(group.repo) ? 'chevron-right' : 'chevron-down'" />
                        <span class="shrink-0 truncate text-xs font-medium text-content">{{ group.repo }}</span>
                        <span v-if="group.branch !== undefined" class="min-w-0 truncate text-2xs text-subtle">{{ group.branch }}</span>
                    </button>

                    <button
                        v-if="behind(group) > 0"
                        type="button"
                        :class="SYNC_PILL"
                        :disabled="changes.actionBusy.value"
                        @click="changes.pullRepo(group.repo)"
                        v-tooltip.right="pullHint(group)"
                        :aria-label="`Pull ${group.repo}`"
                    >
                        <Icon name="arrow-down-left" class="text-[0.6rem]" />{{ behind(group) }}
                    </button>
                    <!-- Publish keeps its word where the pills stay numeric: a branch with no upstream is a
                         one-off state most people meet rarely, and "↑3" would not tell them the push also has
                         to CREATE the branch on the remote. -->
                    <button
                        v-if="unpublished(group)"
                        type="button"
                        class="inline-flex h-5 shrink-0 items-center whitespace-nowrap rounded border border-line px-1.5 text-2xs text-muted transition-colors hover:bg-overlay hover:text-content disabled:opacity-40"
                        :disabled="changes.actionBusy.value"
                        @click="askPushRepo(group)"
                        v-tooltip.right="'Push and start tracking this branch on the remote'"
                    >
                        <Icon name="cloud-upload" class="mr-1 text-[0.6rem]" />Publish
                    </button>
                    <button
                        v-else-if="ahead(group) > 0"
                        type="button"
                        :class="SYNC_PILL"
                        :disabled="changes.actionBusy.value"
                        @click="askPushRepo(group)"
                        v-tooltip.right="pushHint(group)"
                        :aria-label="`Push ${group.repo}`"
                    >
                        <Icon name="arrow-up-right" class="text-[0.6rem]" />{{ ahead(group) }}
                    </button>

                    <span v-if="repoCount(group) > 0" class="shrink-0 rounded-full bg-overlay px-1.5 py-px text-2xs text-muted">{{
                        repoCount(group)
                    }}</span>

                    <button
                        v-if="syncable(group)"
                        type="button"
                        :class="[ICON_BUTTON, ROW_ACTION, 'max-md:h-8 max-md:w-8']"
                        :disabled="changes.actionBusy.value"
                        @click="changes.fetchRepo(group.repo)"
                        v-tooltip.right="'Fetch — refresh what this repo knows about its remote'"
                        :aria-label="`Fetch ${group.repo}`"
                    >
                        <Icon name="sync" class="text-2xs" />
                    </button>
                    <button
                        type="button"
                        :class="[ICON_BUTTON, ROW_ACTION, 'max-md:h-8 max-md:w-8']"
                        :disabled="changes.actionBusy.value || repoCount(group) === 0"
                        @click="askDiscardRepo(group)"
                        v-tooltip.right="'Discard all changes in this repo'"
                        aria-label="Discard all changes in this repo"
                    >
                        <Icon name="trash" class="text-2xs" />
                    </button>
                </div>

                <!-- A failed fetch/pull/push/discard/stage for THIS repo, under the row that caused it and
                     naming the verb. The message it carries is git's own verdict line. -->
                <div v-if="failureIn(group.repo)" :class="[NOTICE, 'mx-2 mb-1.5']">
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

                <div v-if="!collapsed.has(group.repo)" class="pb-1 pl-2 pr-1">
                    <!-- One block per git side: conflicts (blocking), then staged (what a bare commit records),
                         then unstaged. The header's action is whole-side and ignores the row selection, which is
                         VSCode's "Stage All Changes" / "Unstage All". -->
                    <template v-for="section in sidesOf(group)" :key="`${group.repo}/${section.side}`">
                        <div class="group/side flex items-center gap-1 pl-2 pt-1">
                            <span
                                class="truncate text-2xs font-medium uppercase tracking-wide"
                                :class="section.side === 'conflicted' ? 'text-danger' : 'text-subtle'"
                                >{{ section.label }}</span
                            >
                            <!-- Only when there is more than one section to tell apart; alone it repeats the repo badge. -->
                            <span v-if="sidesSplit(group)" class="shrink-0 text-2xs text-subtle">{{ section.changes.length }}</span>
                            <span class="flex-1"></span>
                            <button
                                type="button"
                                :class="[
                                    ICON_BUTTON,
                                    'opacity-0 focus-visible:opacity-100 group-hover/side:opacity-100 disabled:opacity-40 max-md:h-8 max-md:w-8 max-md:opacity-100',
                                ]"
                                :disabled="changes.actionBusy.value"
                                @click="stageSide(group, section.side)"
                                v-tooltip.right="INDEX_VERB[section.side].all"
                                :aria-label="`${INDEX_VERB[section.side].all} in ${group.repo}`"
                            >
                                <Icon :name="INDEX_VERB[section.side].icon" class="text-2xs" />
                            </button>
                        </div>

                        <template v-for="change in section.changes" :key="`${group.repo}/${section.side}/${change.path}`">
                            <!-- Selection is the explorer's own primary tint (WorkspaceTree's .treerow-on), NOT the
                                 overlay: the overlay IS this list's hover colour, so a selected row was drawn
                                 exactly like whichever row the pointer happened to sit on — which made the click
                                 read as doing nothing, and a multi-selection invisible. Hover keeps its own step
                                 above the selected tint, so a selected row still answers the pointer. -->
                            <div
                                class="group/file flex items-center gap-1 rounded transition-colors"
                                :class="
                                    isSelected({ repo: group.repo, side: section.side, path: change.path })
                                        ? 'bg-primary-500/15 hover:bg-primary-500/25'
                                        : 'hover:bg-overlay'
                                "
                            >
                                <!-- The origin rail: 2px of the landing agent's hue, always laid out (transparent
                                     for a file nobody landed) so no row shifts when one appears. This is the part
                                     that works at a glance — an agent's batch reads as a colour block long before
                                     any of the names below are legible. -->
                                <span
                                    class="h-4 w-0.5 shrink-0 rounded-full"
                                    :class="originsOf(group, change.path)[0] ? originHue(originsOf(group, change.path)[0]!).rail : 'bg-transparent'"
                                ></span>
                                <button
                                    type="button"
                                    class="flex min-w-0 flex-1 items-center gap-1.5 py-0.5 pl-0.5 text-left max-md:min-h-11"
                                    @click="clickRow({ repo: group.repo, side: section.side, path: change.path }, change, $event)"
                                >
                                    <span class="w-3 shrink-0 text-center font-mono text-2xs" :class="STATUS_CLASS[change.status]">{{
                                        STATUS_LETTER[change.status]
                                    }}</span>
                                    <!-- dir="rtl" ellipsizes the head of the path so the filename survives truncation, but it
                                         also lets bidi-neutral edge characters jump sides: a leading "_" in "_apps/…" renders
                                         at the far right. <bdi> isolates the path as one LTR run, keeping the glyphs in order.
                                         The tooltip is what that truncation costs — the full label, repo included, and only
                                         while the row is actually cut off. -->
                                    <span
                                        class="min-w-0 flex-1 truncate text-2xs text-muted max-md:text-xs"
                                        dir="rtl"
                                        v-tooltip.right.overflow="changeLabel(group.repo, change)"
                                        ><bdi>{{ change.path }}</bdi></span
                                    >
                                    <!-- Who landed it: a provider chip per agent (two, then a count), and the name
                                         itself only once the panel is wide enough to hold it AND the file has a
                                         single owner — the path keeps first claim on the width. -->
                                    <span
                                        v-if="originsOf(group, change.path).length > 0"
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
                                    <DiffStat :additions="change.additions" :deletions="change.deletions" />
                                </button>
                                <button
                                    type="button"
                                    class="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted opacity-0 transition-colors hover:bg-overlay hover:text-content focus-visible:opacity-100 group-hover/file:opacity-100 disabled:opacity-40 max-md:h-8 max-md:w-8 max-md:opacity-100"
                                    :disabled="changes.actionBusy.value"
                                    @click="stageRow({ repo: group.repo, side: section.side, path: change.path })"
                                    v-tooltip.right="INDEX_VERB[section.side].one"
                                    :aria-label="`${INDEX_VERB[section.side].one}: ${change.path}`"
                                >
                                    <Icon :name="INDEX_VERB[section.side].icon" class="text-2xs" />
                                </button>
                                <button
                                    type="button"
                                    class="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted opacity-0 transition-colors hover:bg-overlay hover:text-content focus-visible:opacity-100 group-hover/file:opacity-100 disabled:opacity-40 max-md:h-8 max-md:w-8 max-md:opacity-100"
                                    :disabled="changes.actionBusy.value"
                                    @click="askDiscardRow({ repo: group.repo, side: section.side, path: change.path }, change)"
                                    v-tooltip.right="'Discard'"
                                    :aria-label="`Discard ${change.path}`"
                                >
                                    <Icon name="trash" class="text-2xs" />
                                </button>
                            </div>
                        </template>
                    </template>
                    <!-- The daemon caps how many rows one repo ships (a cloned monorepo, a mass delete); the
                         remainder arrives as a count. Said plainly under the group, because a list that ends
                         without it reads as complete — and whole-repo actions (commit all, discard repo) still
                         cover every file, capped or not. -->
                    <p v-if="(group.truncated ?? 0) > 0" class="py-1 pl-4 text-2xs text-subtle">
                        …and {{ group.truncated }} more — showing the first {{ repoCount(group) - (group.truncated ?? 0) }}. Repo-wide commit and
                        discard still cover everything.
                    </p>
                </div>
            </div>
        </div>

        <!-- The destructive confirm, in the same modal every other irreversible git action in this app uses.
             It states the two OUTCOMES separately, because they are genuinely different: tracked files go back
             to their last commit (git could return them anyway), untracked files leave the disk (git could
             not). The old prompt asserted the second unconditionally, so the case where it was true looked
             exactly like the many where it wasn't. -->
        <Dialog
            :visible="pendingDiscard !== undefined"
            :modal="true"
            :draggable="false"
            :dismissable-mask="true"
            :style="{ width: '24rem' }"
            header="Discard changes"
            @update:visible="pendingDiscard = undefined"
        >
            <template v-if="pendingDiscard">
                <p class="break-words text-xs text-content">Discard {{ pendingDiscard.what }}?</p>
                <p v-if="pendingDiscard.restores > 0" class="mt-2 text-xs text-muted">
                    {{ plural(pendingDiscard.restores, "file") }} return to their last committed state.
                </p>
                <div v-if="pendingDiscard.deletes.length > 0" class="mt-2">
                    <p class="text-xs text-danger">
                        {{ plural(pendingDiscard.deletes.length, "untracked file") }} leave the disk — they were never committed, so git has no copy:
                    </p>
                    <ul class="mt-1 max-h-24 overflow-auto">
                        <li v-for="path in pendingDiscard.deletes" :key="path" class="truncate font-mono text-2xs text-muted" dir="rtl">
                            <bdi>{{ path }}</bdi>
                        </li>
                    </ul>
                </div>
                <p class="mt-3 text-2xs text-subtle">
                    <Icon name="shield" class="mr-0.5 text-[0.6rem]" />A checkpoint is saved first, so this is reversible from Checkpoints.
                </p>
            </template>
            <template #footer>
                <button type="button" class="rounded px-3 py-1 text-xs text-muted hover:text-content" @click="pendingDiscard = undefined">
                    Cancel
                </button>
                <button type="button" :class="cmp.buttonDanger('rounded px-3 py-1')" :disabled="changes.actionBusy.value" @click="confirmDiscard">
                    Discard
                </button>
            </template>
        </Dialog>

        <!-- The push guardrail. Warning, not danger: the push is not a mistake, it is a decision the user is
             better placed to make than the verdict is — so the objection gets stated once, plainly, and both
             ways forward are offered. "Run checks" leads, because it is the one that makes the question go
             away; "Push anyway" is right there beside it and needs no second confirmation. -->
        <Dialog
            :visible="pendingSync !== undefined"
            :modal="true"
            :draggable="false"
            :dismissable-mask="true"
            :style="{ width: '24rem' }"
            :header="`${pendingSync?.verb ?? 'Push'} before the checks pass?`"
            @update:visible="pendingSync = undefined"
        >
            <template v-if="pendingSync">
                <p :class="cmp.alertWarning('break-words text-xs')">{{ pendingSync.objection }}</p>
                <p class="mt-2 break-words text-xs text-content">
                    {{ pendingSync.verb }} {{ pendingSync.what }} anyway? This is what CI will run on.
                </p>
            </template>
            <template #footer>
                <button type="button" class="rounded px-3 py-1 text-xs text-muted hover:text-content" @click="pendingSync = undefined">Cancel</button>
                <button v-if="!gate.busy.value" type="button" :class="cmp.buttonPrimary('rounded px-3 py-1')" @click="runChecksInstead">
                    Run checks
                </button>
                <button type="button" :class="cmp.buttonWarning('rounded px-3 py-1')" :disabled="changes.actionBusy.value" @click="confirmSync">
                    {{ pendingSync?.verb ?? "Push" }} anyway
                </button>
            </template>
        </Dialog>

        <!-- The full session title behind a row's origin chip — the same card the chat tab strip raises, mounted
             at <body> so it clears this sidebar's narrow, scrolling column. -->
        <HoverCard ref="hoverCard" />
    </div>
</template>
