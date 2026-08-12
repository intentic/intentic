<script setup lang="ts">
import Button from "primevue/button";
import type { GitChange, GitDiffSide, LandedMessage, RepoChanges, RepoPaths } from "@intentic-app/api-contract";
import { ChangeStatusMark, cmp, useDevice } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import Dialog from "primevue/dialog";
import { computed, ref, watch } from "vue";
import ProviderLogo from "../../chat/ProviderLogo.vue";
import HoverCard from "../../components/HoverCard.vue";
import ReviewStat from "../../components/ReviewStat.vue";
import { useCodeStats, type CodeCount } from "../../composables/workspace/useCodeStats";
import { rendersAsBytes } from "./fileType";
import { useAgents } from "../../composables/agents/useAgents";
import { useChat } from "../../composables/chat/useChat";
import { useLayout } from "../../composables/useLayout";
import { commitMessage, followFilledMessage } from "../../composables/workspace/commitMessage";
import { ALL_SIDES, commitMessageOf, landedMessage, originHue, originsOf, summarizeOrigins, YOURS } from "../../composables/workspace/changeOrigins";
import { formatElapsed, unfinishedMark } from "../../composables/agents/agentStatus";
import { diffRawUrls } from "../../composables/workspace/diffRaw";
import { repoOfPath, turnWrites } from "../../composables/workspace/liveWrites";
import { ahead, behind, syncable, unpublished } from "../../composables/workspace/outgoingWork";
import { COMMIT_SCOPE, useChanges, workingStatKey } from "../../composables/workspace/useChanges";
import { usePushFlow } from "../../composables/workspace/usePushFlow";
import { useRepos } from "../../composables/workspace/useRepos";
import { useReceipts } from "../../composables/receipts";
import type { DiffPayload } from "@intentic/extension-api";
import { EMPTY_MODULE_VIEW, moduleView, type ModuleGroup, type ModuleView } from "../../composables/workspace/changeModules";
import type { OpenMode } from "./workspaceTabs";
import { useChangeGrouping } from "../../composables/workspace/useChangeGrouping";
import { useModules } from "../../composables/workspace/useModules";
import ChangeRowName from "../../components/ChangeRowName.vue";
import ModuleLabel from "../../components/ModuleLabel.vue";

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
// The push, from the click to the answer — started here, but owned above this panel so that leaving the view
// neither loses the run nor the question it may raise (composables/workspace/usePushFlow.ts).
const pushFlow = usePushFlow();
// The elapsed readout ticks only while something is actually in flight.
const now = useNow(() => pushFlow.running.value);

// A repo the daemon could not scan at all (a half-written .git from a canceled upload, a corrupt HEAD) arrives
// with empty change lists and `error` set to git's own one-line reason. It has nothing to commit or discard, so
// it stays OUT of every computation below — but it still renders, as its own row: dropping it from the list is
// exactly the silent disappearance this reports instead. Everything else is `scannable`, and every action reads
// that, so an errored repo can never leak into a commit even if the daemon someday reports partial changes
// alongside a failure.
const scannable = computed(() => changes.repos.value.filter((repo) => repo.error === undefined));
const unscannable = computed(() => changes.repos.value.filter((repo) => repo.error !== undefined));
// The mode rides along because it is the GESTURE that decides it: a click is a look (a preview tab, replaced by
// the next file looked at), a double-click asks to keep the tab. See workspaceTabs' OpenMode.
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
// The app's quiet channel, used here for the one thing about a landing that arrives late enough to be waited on.
const { say } = useReceipts();

const legend = computed(() => summarizeOrigins(scannable.value));
const originFilter = ref<string | undefined>(undefined);
// The filter outlives neither the agent's work nor a commit that swept it away. Dropping it takes the subject
// that agent's chip filed into the commit box with it — the box follows the LIT chip, and there is no longer one.
watch(legend, ({ agents, yours }) => {
    if (originFilter.value === undefined) {
        return;
    }
    const stillHasWork = originFilter.value === YOURS ? yours > 0 : agents.some((entry) => entry.id === originFilter.value);
    if (!stillHasWork) {
        originFilter.value = undefined;
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
// The elapsed reading is stamped when the card OPENS rather than ticked: HoverCard snapshots its content at
// show(), so the note is a frozen string either way. A card the user holds open for a minute reads a minute
// stale, which is the correct trade for a line whose point is "this started a while ago".
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

/* WHAT THE CHIP FILES INTO THE COMMIT BOX — the sentence written from that session's landed diff when its work
 * arrived, and nothing at all when there is no such sentence.
 *
 * THE DIFF WINS, and the reason is that the two describe different things. A title names the ASK, once, from
 * the opening prompt (see the daemon's landed-subject.ts) — so a conversation that opened "audit the review
 * panel" and then fixed what the audit found kept filing `chore: audit review panel` over a diff full of
 * fixes. The subject is read off the code instead, at land time, so it says what the commit actually contains.
 * It arrives already in the repo's own house style and goes in VERBATIM: it was drafted at land time against
 * exactly these paths, so re-prefixing it here would put a second convention on a line that already has one.
 *
 * THERE IS NO LONGER A TITLE FALLBACK. A verb table used to turn the session's name into a subject whenever no
 * drafted one existed — `Review panel · audit` filed as `chore: review panel audit` — and that guess is the
 * whole complaint this panel kept earning: it rephrased the ask instead of describing the change, and it did it
 * confidently. It also had no way to tell a real title from a bad one, so a naming pass that failed and asked
 * for more context went into the commit box verbatim, wearing a `feat:` the table had picked for it.
 *
 * Nothing replaces it, on purpose: a chip with no drafted sentence behind it files nothing and simply filters,
 * which is the honest answer. An empty box the user can type into beats a confident line about a change nobody
 * read.
 *
 * THE ROSTER ANSWERS FIRST, exactly as it does for the title and the logo above, and here it is the difference
 * between a message that arrives and one that does not. This sentence is written by a model that starts when
 * the work lands and answers several seconds later — reliably while the user is walking over to this panel and
 * clicking the very chip that is waiting for it. The roster is PUSHED the moment it is written; the review is a
 * workspace-wide rescan that only refreshes when something asks it to, so reading this out of the review alone
 * meant the box stayed empty until an unrelated write happened to refresh the panel, and clicking the chip
 * again was the only way anyone ever found to collect it.
 *
 * The review's copy stays as the second answer, for the reader the roster cannot serve: an archived agent is
 * off the board while its landed lines are still in the tree, and land → archive → commit at leisure is the
 * ordinary flow. Same shape from both roads (LandedMessage), so this is one lookup rather than two branches —
 * the rule itself, and the trailers it composes below, live in changeOrigins.ts where they are testable.
 *
 * AND NOTHING ELSE GOES IN. A drafted message used to carry a body between the subject and its trailers — up to
 * two "- " fact lines — and it is gone from the whole path, prompt included (the daemon's git/commit-message.ts).
 * It was the bulk of what the model wrote and therefore the bulk of the wait, and what it bought was the subject
 * restated at greater length over a diff git already records. */
const landedOf = (id: string): LandedMessage | undefined => landedMessage(agentOf(id), originOf(id));
const originSubject = (id: string): string | undefined => landedOf(id)?.subject;
const originMessage = (id: string): string | undefined => commitMessageOf(landedOf(id));

/* ONE CLICK, TWO HALVES OF THE SAME INTENT — "commit this session's work". The chip has always narrowed the
 * list (and every section verb under it) to that agent's files; it now also names that work in the commit box.
 * Those were the two things a user did by hand, in a row, every time: filter to the agent, then describe what
 * they were looking at.
 *
 * Which is also why the box no longer fills itself. It used to open holding every legend session's title joined
 * into one line — a message nobody chose, that changed under them whenever another agent landed. Naming a
 * commit is now something you ASK for, and the ask is the click you were already making.
 *
 * A session whose work landed with no sentence written for it (nothing connected to write one at the time) files
 * nothing, and the box stays the user's to type in. The filter always applies either way — you can narrow to a
 * session nothing can name.
 *
 * The click itself only lights the chip. Naming is the standing rule below, NOT an act of this handler, because
 * the sentence is routinely a few seconds younger than the click that asks for it. */
const toggleOrigin = (id: string): void => {
    originFilter.value = originFilter.value === id ? undefined : id;
};

/* WHAT THE LIT CHIP IS SAYING, AS IT STANDS THIS TICK. Undefined for no filter; for "you", whose edits have no
 * landing behind them to describe; and for a session whose message does not exist — nothing was connected to
 * write one when the work landed, or it is still being written, which is the ordinary state in the seconds
 * after a land.
 *
 * Reading it as a computed rather than at the click is the whole fix: this recomputes when the review does, so
 * the message the daemon publishes the moment it is drafted (runtime-state's `landings`) reaches the box on
 * arrival instead of waiting for the user to guess that clicking the chip twice would collect it. */
const filterMessage = computed<string | undefined>(() =>
    originFilter.value === undefined || originFilter.value === YOURS ? undefined : originMessage(originFilter.value),
);
followFilledMessage(filterMessage);

/* IS A SENTENCE ON ITS WAY FOR THIS SESSION — read off the fleet roster (AgentSummary.draftingSubject), which
 * is live and costs nothing to ask, rather than off the review, which costs a workspace-wide rescan.
 *
 * This exists because "no message" and "a message you are about to get" were the same empty box, and the second
 * is the ordinary state in the seconds after a land — exactly the window in which somebody who just watched an
 * agent finish walks over to Changes and clicks its chip. Being told costs one line and turns a control that
 * looks broken into one that is obviously working. */
const originDrafting = (id: string): boolean => agentOf(id)?.draftingSubject === true;
// The lit chip's own answer, for the box's placeholder below.
const filterDrafting = computed(
    () => originFilter.value !== undefined && originFilter.value !== YOURS && filterMessage.value === undefined && originDrafting(originFilter.value),
);

/* AND SAY WHEN IT ARRIVES. The other edge — a draft STARTING — is reported above this panel and outlives it
 * (composables/workspace/draftingReceipts.ts): the wait begins on the /agents board, where this component does
 * not exist. What belongs here is the answer, because this is the only place that holds the review and can
 * therefore tell the two ways a draft ends apart: a sentence was written, or the model chain ran dry and
 * nothing was. Announcing the second as "ready" would walk the user over to an empty box on purpose. */
const draftingIds = computed(() => fleet.value.filter((agent) => agent.draftingSubject === true).map((agent) => agent.id));
watch(draftingIds, (drafting, before) => {
    for (const id of before.filter((candidate) => !drafting.includes(candidate))) {
        if (originSubject(id) !== undefined) {
            say(`Commit message ready for ${originLabel(id)}`);
        }
    }
});

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

// The lit chip in words — the subject of every sentence that names what the filter has narrowed to (the commit
// button's tooltip, the section verbs, the discard prompt). Undefined is "no filter", not "nobody".
const filterLabel = computed<string | undefined>(() =>
    originFilter.value === undefined ? undefined : originFilter.value === YOURS ? `you` : originLabel(originFilter.value),
);

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

/* --- reading the list by module ------------------------------------------------------------------------------
 * The one preference this panel takes about how it READS (useChangeGrouping, flipped from the mode-switch row
 * above and mirrored in Settings ▸ Appearance). With it on, a side's rows are grouped under the package each
 * path lives in and the row itself shrinks to the file — because the module prefix is the repeated half of a
 * monorepo path, and in a 270px sidebar it is also the half that truncates away, so the list was spending its
 * width restating what a header can say once. See changeModules.ts for why the module is the header and not
 * the row.
 *
 * It changes nothing about what the panel DOES: the same rows, in the same order, staged and discarded by the
 * same verbs. Which is why every section verb still reads `changesOn` — a side, not a module. */
const { groupByModule } = useChangeGrouping();
const { modulesOf } = useModules();

/* Every side's shape, built ONCE per change to the review rather than per call. Both the headers and the rows
 * read it (a row's label switches on `named`), and a per-row grouping pass would be quadratic on a list this
 * one is expressly built to survive — the daemon ships up to 500 rows a repo.
 *
 * The rule itself is changeModules' moduleView, shared with the agent review on /agents/{id} — the two lists
 * having written their own copies of it is how they came to disagree about the same change set. */
type SectionView = ModuleView<ModuleGroup<GitChange>>;
const sectionViews = computed<ReadonlyMap<string, SectionView>>(() => {
    const views = new Map<string, SectionView>();
    for (const repo of scannable.value) {
        for (const section of sidesOf(repo)) {
            views.set(
                JSON.stringify([repo.repo, section.side]),
                moduleView(section.changes, (change) => change.path, modulesOf(repo.repo), repo.repo, groupByModule.value),
            );
        }
    }
    return views;
});
const viewOf = (repo: string, side: GitDiffSide): SectionView => sectionViews.value.get(JSON.stringify([repo, side])) ?? EMPTY_MODULE_VIEW;

// This panel lives in a ~270px sidebar, so labelled secondary buttons don't fit — four of them pushed the
// primary Commit off the edge entirely. Everything secondary is a 24px icon with a tooltip and an aria-label;
// only the primary action spends horizontal space on a word.
// The design system's toolbar icon button, plus this panel's own disabled treatment.
const ICON_BUTTON = cmp.iconButton(`disabled:opacity-40`);

/* Opens the diff of the ROW, not of the file: a staged row shows index-vs-HEAD, an unstaged row
 * worktree-vs-index. The side rides the tab key too, so a partially staged file's two diffs open as two tabs
 * instead of one silently replacing the other. A binary row carries its two sides' byte URLs as well — the
 * response flags an image, it cannot contain one, and this row is what knows which diff to fetch it from.
 *
 * THE TAB OPENS ON THE CLICK, not on the answer. Everything the tab needs to exist is on the row already — the
 * path, the status letter, the ± counts — and the diff is a daemon round-trip that a busy sandbox can take a
 * second over. Waiting for it before opening anything spent that second saying nothing, so the click read as
 * having missed; now the row's own facts are on screen at once and the panes fill under them (`pending`, and
 * `fill-diff` for the half that arrives late). Warmed rows land in the same tick and never draw a wait at all. */
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

/* --- reading ahead --------------------------------------------------------------------------------------------
 * NOT DONE HERE ANY MORE. This panel used to walk its own row list reading the diffs behind it, which tied the
 * read-ahead to the panel being MOUNTED: arriving at the review started the walk, so the first click still paid
 * a round trip, and stepping away threw away everything the walk had not reached. The app's background loader
 * (composables/prefetch) keeps these rows warm from wherever the user is standing instead, through the very
 * read this panel's clicks go through — so a click either finds the answer sitting there or joins the read
 * already in flight.
 *
 * HOW BIG EACH CHANGE IS IN THE READING ON SCREEN: these rows sit beside diffs that open on code alone, so
 * their +/− has to be the code's. That count is a by-product of having both sides of a file, so it is taken
 * where the file is READ (useChanges' fileDiff) rather than by whoever asked for it — and while this panel is the
 * open one the loader reads its rows before anything else in the app (changesWarm's `now` band), far enough down
 * the list (warmRows) that an ordinary review is covered whole. A row it has not reached yet still shows a
 * number — git's, at half weight, until the code's replaces it (ReviewStat). */
const { countOf } = useCodeStats();
const codeOf = (repo: string, side: GitDiffSide, path: string): CodeCount => countOf(workingStatKey(repo, side, path));

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
// across repos. A collapsed repo contributes nothing: you cannot range through rows you cannot see. Read
// through `viewOf` rather than off the sections, because module grouping REORDERS a side (a loose file
// between two of a package's) and a range that measured against the other order would select rows the user
// never dragged over.
const visibleRows = computed<readonly Row[]>(() =>
    scannable.value.flatMap((repo) =>
        collapsed.value.has(repo.repo)
            ? []
            : sidesOf(repo).flatMap((section) =>
                  viewOf(repo.repo, section.side).buckets.flatMap((bucket) =>
                      bucket.rows.map((change) => ({ repo: repo.repo, side: section.side, path: change.path })),
                  ),
              ),
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
    // A plain click is "look at this one": it collapses the selection and opens the diff, like any file list —
    // as the strip's preview tab, since reading down a change list is the whole point of this panel and every
    // row of it used to leave a tab behind. Double-clicking the row keeps the tab (below).
    selected.value = new Set([key]);
    anchor.value = key;
    openDiff(row.repo, row.side, change, `preview`);
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
// Staged repos are the commit target, full stop — a commit records the index.
const stagedRepos = computed(() => scannable.value.filter((repo) => repo.staged.length > 0).map((repo) => repo.repo));

/* --- when Commit stages for you ------------------------------------------------------------------------------
 * Nothing staged anywhere with work on screen is the one state where Commit stages before it records — VSCode's
 * "would you like to stage all your changes and commit them directly?", made an explicit label instead of a
 * dialog. WHAT it stages is what the list is SHOWING, which makes the origin filter's two states the button's
 * two shapes:
 *   - unfiltered → "Commit all". The whole worktree, through the daemon's `all` shape (`git commit -a`), which
 *     is also the only reading that reaches the rows the daemon truncated past its per-repo budget.
 *   - filtered   → "Commit 7 files". Stage exactly that origin's paths, then commit the index. The chip was
 *     always a whole intent — it narrows the list AND files the session's title into the message — and this is
 *     the part of it the index never heard. It used to be withheld here, on the grounds that "Commit all"
 *     would sweep every other agent's work under a message about this one; that is an argument for scoping the
 *     staging, not for taking the button away, and the scope was sitting in the filter the whole time.
 * Never once something IS staged: the index is then the user's own answer to what goes in, and Commit records
 * it. Which is also what keeps this safe — with nothing staged there is no staged work for it to sweep in. */
const stagesFirst = computed(() => stagedRepos.value.length === 0 && changes.count.value > 0);
const commitAll = computed(() => stagesFirst.value && originFilter.value === undefined);
// The filtered set, per repo. Distinct paths, because a file staged AND edited again is two rows and one path
// to git; and read through `sidesOf`, the single place the filter is applied, so this can only hold rows the
// user can actually see.
const filteredGroups = computed<readonly RepoPaths[]>(() =>
    scannable.value
        .map((repo) => ({ repo: repo.repo, paths: [...new Set(sidesOf(repo).flatMap((section) => section.changes.map((change) => change.path)))] }))
        .filter((group) => group.paths.length > 0),
);
// What Commit acts on, in the one shape `commitRepos` and the AI draft both take: a bare repo for the two
// whole-repo shapes, repo + paths for the filtered one.
const commitGroups = computed<readonly RepoPaths[]>(() => {
    if (!stagesFirst.value) {
        return stagedRepos.value.map((repo) => ({ repo }));
    }
    return commitAll.value ? scannable.value.map((repo) => ({ repo: repo.repo })) : filteredGroups.value;
});
const commitTarget = computed(() => commitGroups.value.map((group) => group.repo));
// Only the filtered shape carries paths, so this reads 0 for every other one — which is exactly when the button
// has no count to show.
const commitFiles = computed(() => commitGroups.value.reduce((total, group) => total + (group.paths?.length ?? 0), 0));
// An unresolved conflict in ANY repo blocks the button, not just in the repo that has it: a commit here is one
// commit per repo sharing a message, and git would refuse the conflicted one halfway through — leaving the
// others committed under a message that describes work that didn't all land. Better to not start.
const blockedByConflicts = computed(() => scannable.value.some((repo) => repo.conflicted.length > 0));
/* --- the commit that is already running ------------------------------------------------------------------------
 * A commit is a request that outlives the tab that fired it, and the panel used to say so with one flag that
 * died with the page. Reload mid-commit and the button re-armed itself over rows the commit was already
 * recording: it invited a second click at the exact moment it could do the least good, and then the rows changed
 * under the user a second later with nothing having explained why.
 *
 * So this reads the daemon's answer (unioned with this tab's own in-flight batch — see useChanges), narrowed to
 * the repos THIS BOX would commit. Narrowed rather than panel-wide because the two can genuinely differ: a
 * commit running in a repo the current filter excludes is not this button's business, and blanking the button
 * for it would be the same over-reach the old "an agent is running" gate was. */
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
// The count rides the LABEL rather than the readout beside it. This is the one shape whose scope is stated
// nowhere else on the panel — a bare "Commit" over a list that is hiding rows says nothing about which ones it
// is about to take.
const commitLabel = computed(() =>
    commitAll.value ? `Commit all` : commitFiles.value > 0 ? `Commit ${plural(commitFiles.value, `file`)}` : `Commit`,
);

/* --- committing an unfinished session's work ------------------------------------------------------------------
 * The sessions this commit would RECORD, and which of them are still going. Scoped exactly like the button:
 * the staged side alone for a plain Commit (a commit records the index), every side for "Commit all", and only
 * the repos in `commitTarget` — the same rule the whole family of files shares. A filtered commit needs no
 * summary at all: it stages that one origin's files and nothing else, so the filter IS the answer, and reading
 * it off the repos would name every other session with work parked in them.
 *
 * A warning rather than a gate, for the same reason as the mid-write one below: nothing here is at risk of
 * corruption, the commit is a legitimate thing to make (staging the first half of an agent's work on purpose is
 * ordinary), and `reset --soft` walks it back. What it prevents is the silent version — committing under a
 * subject that describes an intent the agent has not finished carrying out, which is exactly what the legend's
 * click-to-name makes easy to do without noticing. */
const commitOrigins = computed(() =>
    stagesFirst.value && originFilter.value !== undefined
        ? legend.value.agents.filter((entry) => entry.id === originFilter.value)
        : summarizeOrigins(
              scannable.value.filter((repo) => commitTarget.value.includes(repo.repo)),
              commitAll.value ? ALL_SIDES : [`staged`],
          ).agents,
);
const unfinished = computed(() => commitOrigins.value.filter((entry) => originMark(entry.id) !== undefined));

/* --- committing while an agent works ------------------------------------------------------------------------
 * THE INDEX IS ALREADY THE ISOLATION, which is why nothing here blocks. A plain Commit records what you
 * staged — a snapshot git took at stage time, which no later worktree write can alter — so a turn running in
 * the background cannot get into it, and refusing to commit during one bought exactly nothing. The exception is
 * a commit that STAGES FIRST, in either shape: it reads the worktree at stage time, so a file an agent is
 * halfway through writing goes in as it stands.
 *
 * So the panel warns, and only where that is true: a MAIN-TREE turn writing a repo this commit would
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
const atRisk = computed(() => (stagesFirst.value ? commitTarget.value.filter((repo) => writingRepos.value.has(repo)) : []));
const unaffected = computed(() => commitGroups.value.filter((group) => !writingRepos.value.has(group.repo)));

const runCommit = async (target: readonly RepoPaths[]): Promise<void> => {
    await changes.commitRepos(target, commitMessage.value, stagesFirst.value);
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
    // Ahead of "nothing to commit": mid-commit the rows are still listed, so this is the honest reason rather
    // than a count that is about to change. It is also the state a reloaded tab lands in.
    if (commitRunning.value) {
        return `Still committing ${committingNow.value.join(`, `)} — this finishes on its own.`;
    }
    if (commitTarget.value.length === 0) {
        return `Nothing to commit.`;
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
    await runCommit(commitGroups.value);
};

/* HOW TALL THE BOX IS — one row until the message needs more, then as many as it takes, to a stop.
 *
 * The box is a textarea rather than a single-line input because a commit message HAS a body: a release-note
 * trailer, or the facts under the subject that a session's landed sentence brings with it. In an `input` those
 * had nowhere to go — the message was cut to its first line before it ever reached the user.
 *
 * MEASURED, NOT COUNTED. Counting "\n" got a pasted body right and the ordinary long subject wrong: a single
 * line that WRAPS is still one line to `split`, so the box stayed one row tall and hid the rest behind a scroll
 * nobody expected. The browser already knows the answer — `scrollHeight`, with the height released first — so it
 * is read off the element, which makes wrapping, font size and the sidebar's own width count for free.
 *
 * Capped, because this panel is a review surface: past a handful of lines the message would push the file list
 * off the screen the user is describing, and the textarea scrolls instead. */
// Eight lines exactly, at this box's font and padding — the composer's own ceiling (ChatPane), scaled to a
// sidebar. Spelled again as the box's own `max-h`, which is what caps it in the frame before this first runs.
const MAX_COMMIT_HEIGHT = 142;
// The border this box wears itself, which the composer's does not (there it sits on the wrapper). scrollHeight
// counts the padding and never the border, so with `border-box` sizing a height set straight from it is two
// pixels short of its own text — enough to put a scrollbar on a single-line message.
const COMMIT_BOX_BORDER = 2;
const commitBox = ref<HTMLTextAreaElement | null>(null);
// Manual textarea auto-grow, the composer's own: reset to one line, then size to content up to the maximum.
// `auto` first because a height already set is a floor scrollHeight can never report under — without it the box
// would grow for a long message and stay tall after the message got shorter.
const growCommitBox = (): void => {
    const el = commitBox.value;
    if (!el) {
        return;
    }
    el.style.height = `auto`;
    el.style.height = `${Math.min(el.scrollHeight + COMMIT_BOX_BORDER, MAX_COMMIT_HEIGHT)}px`;
};
/* Watched rather than hung off `@input`, because most of what lands in this box is not typing: a From chip
 * files a whole message, a commit clears it, switching sandboxes swaps it for that tree's own. `post` runs it
 * after the DOM has the new text — measuring before that measures the previous message. The sidebar's width is
 * in the list for the same reason as the text: dragging it narrower re-wraps the lines, and the height that
 * fitted at 400px hides a line at 270px. */
watch([commitBox, commitMessage, layout.sidebarWidth], growCommitBox, { flush: `post` });

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

// The section header's verb as a sentence. Under a filter it says how much it will move and whose, because the
// button no longer means "this whole side" — it means the rows the filter has left on screen, which is a
// different promise and the reason the button stops hiding itself (see the header's class below).
const sideVerbHint = (repo: RepoChanges, side: GitDiffSide): string =>
    filterLabel.value === undefined
        ? INDEX_VERB[side].all
        : `${INDEX_VERB[side].all} — ${plural(changesOn(repo, side).length, `file`)} from ${filterLabel.value}`;

// Row action: moves the acting rows across the index, in the direction their side implies.
const stageRow = (row: Row): Promise<void> => changes.stageGroups(byRepo(actingRows(row, true)), movesIntoIndex(row.side));
// Section action: the whole side, regardless of selection — VSCode's "Stage All Changes" / "Unstage All".
const stageSide = (repo: RepoChanges, side: GitDiffSide): Promise<void> =>
    changes.stageGroups([{ repo: repo.repo, paths: changesOn(repo, side).map((change) => change.path) }], movesIntoIndex(side));

// --- discard -----------------------------------------------------------------------------------------------
// A modal confirm, like every other destructive git action in this app (the history graph's checkout/reset/drop), rather
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
            filterLabel.value === undefined
                ? `every uncommitted change in ${repo.repo}`
                : `${plural(paths.size, `file`)} from ${filterLabel.value} in ${repo.repo}`,
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
// `syncable`/`ahead`/`behind`/`unpublished` come from useChanges: the rail tile and the sidebar's Changes tab
// read the same repo the same way, and a second local definition here is how those three drift apart.

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
/* --- the push -------------------------------------------------------------------------------------------------
 * EVERY push in this panel funnels through `pushFlow.askSync` — the bar's Push/Sync/Publish and both of a repo
 * row's pills — because a second way to reach the same verb is a way around the check. That is also why
 * useChanges does not export a one-repo push: a single door is the only kind that can be guarded.
 *
 * WHY THE PUSH AND NOT THE COMMIT. The commit is the user's own review boundary and stays unchecked; nothing has
 * left the machine yet, and interrupting the act of recording work would be objecting to the wrong thing. The
 * push is the last moment before CI owns the answer, and the first at which what will be pushed is finally
 * settled — so it is the only moment where a check can be both timely and about the right artifact.
 *
 * THE PANEL NO LONGER HOLDS THE WAIT. It states it: while the flow runs, the strip below the sync bar says what
 * stage it is at and offers the two things worth offering mid-run (stop the suite, watch it). The decision a red
 * verdict needs is raised ABOVE the router (shell/PushNotice.vue), because by then the user is usually somewhere
 * else — which is the whole permission this design grants them. */

// What the strip says while something is in flight, and after. One line, because the panel is ~270px wide and
// the amount of it that can be spent on a status is one line.
const stageLine = computed<string | undefined>(() => {
    const push = pushFlow.pending.value;
    if (pushFlow.stage.value === `checking`) {
        return `Checking · ${formatElapsed(pushFlow.since.value, now.value)}`;
    }
    if (pushFlow.stage.value === `pushing`) {
        return `${push?.verb ?? `Push`}ing · ${formatElapsed(pushFlow.since.value, now.value)}`;
    }
    const sent = pushFlow.pushed.value;
    return sent === undefined ? undefined : `Pushed ${sent.what}`;
});

// The command, and how long this suite usually takes — the two facts that turn "it is running" into "I can go
// and do something else". They ride the tooltip rather than the line: in this width the elapsed clock is what
// has to be legible at a glance, and these are read once.
const stageHint = computed<string>(() => {
    const typical = pushFlow.typicalMs.value;
    const usually = typical === undefined ? `` : ` · usually about ${formatElapsed(0, typical)}`;
    return pushFlow.stage.value === `checking` ? `${pushFlow.command.value}${usually}` : `Sending your commits to their upstreams`;
});

// One click, every repo that has remote work — git can't span remotes, so the composable fans it out into one
// real sync per repo (pull what's behind, then push/publish what's ahead), each failure landing on its own row.
const doSync = (): void =>
    pushFlow.askSync(
        syncMeta.value?.label ?? `Sync`,
        `${aheadTotal.value > 0 ? plural(aheadTotal.value, `commit`) : `this branch`}${syncRepos.value.length > 1 ? ` across ${plural(syncRepos.value.length, `repo`)}` : ``}`,
        syncRepos.value.map((repo) => ({ repo: repo.repo, pull: behind(repo) > 0, push: ahead(repo) > 0 || unpublished(repo) })),
    );

// A row's own pill: this repo, outgoing only. Publish and ↑N differ in wording, not in what they send.
const askPushRepo = (repo: RepoChanges): void =>
    pushFlow.askSync(
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

        <!-- Commit box (VSCode places it at the top). It records the index — staging is the selection. -->
        <div v-if="changes.count.value > 0" class="flex shrink-0 flex-col gap-1.5 border-b border-line p-2">
            <!-- A textarea, not an input: the release-note trailer a session's landed sentence carries lives
                 under the subject, and a message the user writes by hand may have a body of its own. Enter
                 breaks the line; Ctrl/Cmd+Enter still commits, as the placeholder says. One row to start with —
                 growCommitBox takes it from there, on the real height of what is in it, and it scrolls past the
                 ceiling.

                 The placeholder does the waiting: a lit chip whose sentence is still being written says so
                 HERE, in the box the sentence is going to land in, rather than leaving an empty box that looks
                 identical to one nothing is coming for. It is a placeholder rather than filled text on purpose —
                 the box must stay the user's to type in, and typing over it is how they say they'd rather not
                 wait. -->
            <textarea
                ref="commitBox"
                v-model="commitMessage"
                rows="1"
                :placeholder="filterDrafting ? `Writing a message for ${filterLabel}…` : `Message (Ctrl+Enter to commit)`"
                class="scrollbar-thin block max-h-[142px] w-full min-w-0 resize-none overflow-y-auto rounded-md border border-line bg-canvas px-2 py-1 text-xs leading-snug text-content placeholder:text-subtle focus:border-line-strong focus:outline-none"
                @keydown.ctrl.enter="doCommit"
                @keydown.meta.enter="doCommit"
            ></textarea>
            <!-- What the commit will record, then the one button that records it. No checkboxes: the sentence
                 on the left is a readout of the index, not a control. A conflict replaces it outright — nothing
                 about the index matters while git is refusing to commit at all. -->
            <div class="flex items-center gap-1">
                <span v-if="blockedByConflicts" class="min-w-0 flex-1 truncate whitespace-nowrap text-2xs text-danger">
                    Resolve conflicts first
                </span>
                <!-- WHERE the commit is happening, which is the one thing the button next to it cannot say.
                     Ahead of the staged count on purpose: that one describes a commit that is no longer being
                     composed. -->
                <span v-else-if="commitRunning" class="min-w-0 flex-1 truncate whitespace-nowrap text-2xs text-muted">
                    Committing {{ committingNow.join(`, `) }}…
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
                <span v-else class="min-w-0 flex-1 truncate whitespace-nowrap text-2xs text-muted">
                    <template v-if="changes.stagedCount.value > 0"
                        >{{ changes.stagedCount.value }} staged<span v-if="stagedRepos.length > 1"> · {{ stagedRepos.length }} repos</span></template
                    >
                    <template v-else>nothing staged</template>
                </span>
                <!-- Mid-commit the button SAYS SO rather than just going flat. The wait is real — a stage, a
                     commit that runs the repo's own hooks, a re-read, and sometimes a queue behind an agent's
                     land — and a dimmed button with no spinner reads as a click that missed. It survives a
                     reload because the state it reads comes from the daemon, not from this page. -->
                <Button
                    size="small"
                    severity="success"
                    class="shrink-0 gap-0 whitespace-nowrap px-2 py-1 text-2xs"
                    :disabled="!commitReady"
                    @click="doCommit"
                    v-tooltip.right="
                        commitRunning
                            ? `Recording ${committingNow.join(', ')} — the rows clear when git is done`
                            : blockedByConflicts
                              ? 'A path is unmerged — stage each conflicted file to mark it resolved'
                              : commitAll
                                ? 'Stages every change, then commits'
                                : commitFiles > 0
                                  ? `Stages the ${plural(commitFiles, 'file')} from ${filterLabel}, then commits — nothing else goes in`
                                  : 'One commit per repo'
                    "
                >
                    <Icon :name="commitRunning ? `spinner` : `check`" :spin="commitRunning" class="mr-1 text-2xs" />{{
                        commitRunning ? `Committing…` : commitLabel
                    }}
                </Button>
            </div>
            <!-- An agent is writing, in a repo this commit would stage from the worktree. A WARNING, not a
                 gate: the commit is the user's to make and `reset --soft` walks it back, so the button above
                 stays live. What the strip adds is the thing the old block never offered — the repos nobody is
                 writing, committable in one click, which is the whole "let me commit something unrelated" case.
                 It quotes the button rather than naming a shape, so it reads the same for "Commit all" and for
                 the filtered "Commit 7 files". -->
            <div v-if="atRisk.length > 0" :class="WARNING">
                <Icon name="exclamation-triangle" class="mt-0.5 shrink-0 text-2xs text-warning" />
                <div class="min-w-0 flex-1">
                    <p class="break-words text-2xs text-warning">
                        An agent is editing {{ atRisk.join(`, `) }} right now — "{{ commitLabel }}" records
                        {{ atRisk.length === 1 ? `it` : `them` }} mid-write.
                    </p>
                    <button
                        v-if="unaffected.length > 0"
                        type="button"
                        class="mt-1 inline-flex items-center whitespace-nowrap rounded border border-line px-1.5 py-0.5 text-2xs text-muted transition-colors hover:bg-overlay hover:text-content disabled:opacity-40"
                        :disabled="!commitReady"
                        @click="runCommit(unaffected)"
                        v-tooltip.right="`Commits ${unaffected.map((group) => group.repo).join(`, `)}`"
                    >
                        <Icon name="check" class="mr-1 text-2xs" />Commit
                        {{ unaffected.length === 1 ? unaffected[0]!.repo : `the other ${unaffected.length} repos` }}
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
            <Button
                size="small"
                class="shrink-0 gap-0 whitespace-nowrap px-2 py-1 text-2xs"
                :disabled="changes.actionBusy.value || pushFlow.running.value"
                @click="doSync"
                v-tooltip.right="syncMeta!.hint"
            >
                <Icon :name="syncMeta!.icon" class="mr-1 text-2xs" />{{ syncMeta!.label }}
            </Button>
        </div>

        <!-- THE RUN, IN PLACE — what replaced the dialog that used to own the wait.
             It is a STRIP OF ITS OWN rather than a state of the bar above, because the bar above is the primary
             slot and the commit box takes it back the moment there is anything to commit: a status that lived
             there would vanish the first time the user did what this whole design invites them to do, which is
             carry on working while the suite runs. It says the stage and the clock, and offers only what is
             worth offering mid-run — stop the suite, go and watch it. No verdict, because a verdict that needs
             answering is raised above the router where the user can be found (shell/PushNotice.vue), and no
             output, because the output is the terminal's (composables/terminal/useTerminalPanel.ts). -->
        <div v-if="stageLine !== undefined" class="flex shrink-0 items-center gap-1.5 border-b border-line px-2 py-1.5" v-tooltip.right="stageHint">
            <Icon
                :name="pushFlow.running.value ? `spinner` : `check-circle`"
                :spin="pushFlow.running.value"
                class="shrink-0 text-2xs"
                :class="pushFlow.running.value ? `text-link` : `text-success`"
            />
            <span class="min-w-0 flex-1 truncate whitespace-nowrap text-2xs text-muted">{{ stageLine }}</span>
            <!-- Drawn only where there IS a terminal: a sandbox without the tmux wrapper ran the suite in an
                 invisible shell, and a button that opens an empty panel is worse than none. -->
            <button
                v-if="pushFlow.running.value && pushFlow.terminal.value !== undefined"
                type="button"
                class="shrink-0 rounded p-0.5 text-muted transition-colors hover:text-content"
                @click="pushFlow.showTerminal"
                v-tooltip.top="'Watch it run'"
                aria-label="Watch the checks run"
            >
                <Icon name="terminal" class="text-2xs" />
            </button>
            <!-- Stopping the suite is not cancelling the push: the run settles as stopped and the push is still
                 waiting on an answer, which is then asked for in the notice like any other red outcome. -->
            <button
                v-if="pushFlow.stage.value === `checking`"
                type="button"
                class="shrink-0 rounded px-1 py-0.5 text-2xs text-muted transition-colors hover:text-content"
                @click="pushFlow.stopChecks"
            >
                Stop
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
             The click ALSO names the commit, with the sentence written for that session's work when it landed
             (toggleOrigin) — the second half of the "commit this agent's work" intent the filter was always the
             first half of; a session with no such sentence just filters. And a chip whose session
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
                }${originDrafting(entry.id) ? `; its commit message is being written` : originTitle(entry.id) ? `; names the commit` : ``}`"
            >
                <!-- The session has not finished with your tree: its count above is an instalment, not a total.
                     A dot rather than a status glyph, and BEFORE the logo rather than on it — the logo is 11px,
                     which leaves no corner to put anything in, and this strip's hard constraint is horizontal
                     (spelled-out titles once wrapped it to five rows and pushed the file list off the fold). A
                     leading dot costs 10px, only on the rare chip that is actually live, and the words are one
                     hover away on the card the chip already raises. -->
                <span v-if="originMark(entry.id)" class="h-1.5 w-1.5 shrink-0 rounded-full" :class="originMark(entry.id)!.dot"></span>
                <!-- …and the same 10px, spent again on the other thing this chip can be waiting for: the
                     sentence it will file into the commit box, still being written. It pulses rather than sits,
                     because the unfinished dot above is already a static dot and two motionless dots in the same
                     slot would read as one state with two colours. Gone the moment the sentence lands. -->
                <span v-else-if="originDrafting(entry.id)" class="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-current opacity-60"></span>
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

            <!-- A REPO BEING RECORDED READS AS PENDING. Its rows are still genuinely uncommitted until git
                 returns, so they stay listed rather than being optimistically swept — but staging, discarding or
                 pulling one of them now would act on a tree mid-commit, and the daemon's repo lock would queue
                 the request behind it anyway. Dimming the whole group says that in one gesture, and it is the
                 only thing on screen that tells a reloaded tab WHICH rows the running commit is about to take. -->
            <div
                v-for="group in scannable"
                :key="group.repo"
                class="group/repo border-b border-line/50 transition-opacity"
                :class="changes.committing.value.includes(group.repo) && `pointer-events-none opacity-50`"
            >
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
                        v-tooltip.top="pullHint(group)"
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
                        :disabled="changes.actionBusy.value || pushFlow.running.value"
                        @click="askPushRepo(group)"
                        v-tooltip.top="'Push and start tracking this branch on the remote'"
                    >
                        <Icon name="cloud-upload" class="mr-1 text-[0.6rem]" />Publish
                    </button>
                    <button
                        v-else-if="ahead(group) > 0"
                        type="button"
                        :class="SYNC_PILL"
                        :disabled="changes.actionBusy.value || pushFlow.running.value"
                        @click="askPushRepo(group)"
                        v-tooltip.top="pushHint(group)"
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
                        v-tooltip.top="'Fetch — refresh what this repo knows about its remote'"
                        :aria-label="`Fetch ${group.repo}`"
                    >
                        <Icon name="sync" class="text-2xs" />
                    </button>
                    <button
                        type="button"
                        :class="[ICON_BUTTON, ROW_ACTION, 'max-md:h-8 max-md:w-8']"
                        :disabled="changes.actionBusy.value || repoCount(group) === 0"
                        @click="askDiscardRepo(group)"
                        v-tooltip.top="'Discard all changes in this repo'"
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

                <!-- WHY THESE FILES ARE CONFLICTED, and the one way out. Nothing this app starts can leave a repo
                     mid-operation (every daemon verb aborts itself), so this is always something a terminal left:
                     an agent's rebase that stopped, a land that could not finish. Above the sections rather than
                     inside Conflicts, because it explains the whole repo — git refuses almost every other verb
                     until it ends, including the commit the panel is otherwise inviting. -->
                <div v-if="group.operation" :class="[NOTICE, 'mx-2 mb-1.5 border-warning/40 bg-warning/10']">
                    <Icon name="exclamation-triangle" class="mt-0.5 shrink-0 text-2xs text-warning" />
                    <div class="min-w-0 flex-1">
                        <p class="text-2xs font-medium text-warning">A {{ group.operation }} is in progress</p>
                        <p class="text-2xs text-muted">
                            Resolve the conflicts and stage them to continue, or abort to return this repository to where the
                            {{ group.operation }} began.
                        </p>
                    </div>
                    <button
                        type="button"
                        class="shrink-0 rounded border border-warning/50 px-1.5 py-0.5 text-2xs text-warning transition-colors hover:bg-warning/10 disabled:opacity-40"
                        :disabled="changes.actionBusy.value"
                        @click="changes.abortOperation(group.repo)"
                        v-tooltip.top="'A restore point is saved first, so this is reversible from Restore points'"
                    >
                        Abort
                    </button>
                </div>

                <div v-if="!collapsed.has(group.repo)" class="pb-1 pl-2 pr-1">
                    <!-- One block per git side: conflicts (blocking), then staged (what a bare commit records),
                         then unstaged. The header's action is whole-side and ignores the row selection, which is
                         VSCode's "Stage All Changes" / "Unstage All". -->
                    <template v-for="section in sidesOf(group)" :key="`${group.repo}/${section.side}`">
                        <div class="flex items-center gap-1 pl-2 pt-1">
                            <span
                                class="truncate text-2xs font-medium uppercase tracking-wide"
                                :class="section.side === 'conflicted' ? 'text-danger' : 'text-subtle'"
                                >{{ section.label }}</span
                            >
                            <!-- Only when there is more than one section to tell apart; alone it repeats the repo badge. -->
                            <span v-if="sidesSplit(group)" class="shrink-0 text-2xs text-subtle">{{ section.changes.length }}</span>
                            <span class="flex-1"></span>
                            <!-- ALWAYS DRAWN — the one rule this panel's action buttons follow: what moves a row
                                 ACROSS THE INDEX is on screen, what destroys work waits for a hover. Staging is
                                 the errand the panel exists for and the step every commit goes through, and it
                                 was the only control here you had to already know about to find: a section at
                                 rest showed a label, a count, and nothing you could press. Hover-reveal is for
                                 the actions you should have to point at first (discard, on the row and on the
                                 repo row) — it was spent on the one action that should never have been hidden.
                                 It also retires the filter exception this replaces: a lit chip no longer has
                                 to un-hide the button, it only changes what the button promises (see the
                                 tooltip), which is a thing words do better than an appearing control. -->
                            <button
                                type="button"
                                :class="[ICON_BUTTON, 'max-md:h-8 max-md:w-8']"
                                :disabled="changes.actionBusy.value"
                                @click="stageSide(group, section.side)"
                                v-tooltip.right="sideVerbHint(group, section.side)"
                                :aria-label="`${sideVerbHint(group, section.side)} in ${group.repo}`"
                            >
                                <Icon :name="INDEX_VERB[section.side].icon" class="text-2xs" />
                            </button>
                        </div>

                        <template v-for="bucket in viewOf(group.repo, section.side).buckets" :key="`${group.repo}/${section.side}/${bucket.key}`">
                            <!-- The module a run of rows belongs to, said once — the same ModuleLabel the review
                                 panel on /agents/{id} draws, so a module is said the same way in both lists. A
                                 label rather than a control: the toggle behind it changes how the list READS,
                                 and staging stays the side's verb above (and the row's own beside it), so
                                 nothing here can act on a scope git has no word for.

                                 Separated by AIR rather than by brightness: this heading is the third rank in
                                 the list — under the repo, under the side — and everything about how quiet it
                                 is lives in the component. -->
                            <div v-if="viewOf(group.repo, section.side).named" class="flex items-center gap-1.5 pl-2 pt-2">
                                <ModuleLabel :name="bucket.name" :packaged="bucket.packaged" />
                                <span class="shrink-0 text-2xs text-subtle">{{ bucket.rows.length }}</span>
                            </div>
                            <template v-for="change in bucket.rows" :key="`${group.repo}/${section.side}/${change.path}`">
                                <!-- Selection is the explorer's own primary tint (WorkspaceTree's .treerow-on), NOT the
                                 overlay: the overlay IS this list's hover colour, so a selected row was drawn
                                 exactly like whichever row the pointer happened to sit on — which made the click
                                 read as doing nothing, and a multi-selection invisible. Hover keeps its own step
                                 above the selected tint, so a selected row still answers the pointer. -->
                                <div
                                    class="group/file flex items-center gap-1 rounded transition-colors"
                                    :class="[
                                        isSelected({ repo: group.repo, side: section.side, path: change.path })
                                            ? 'bg-primary-500/15 hover:bg-primary-500/25'
                                            : 'hover:bg-overlay',
                                        // Under a header the rows step in, so the module reads as holding them
                                        // rather than sitting beside them.
                                        viewOf(group.repo, section.side).named ? 'pl-2' : '',
                                    ]"
                                >
                                    <!-- The origin rail: 2px of the landing agent's hue, always laid out (transparent
                                     for a file nobody landed) so no row shifts when one appears. This is the part
                                     that works at a glance — an agent's batch reads as a colour block long before
                                     any of the names below are legible. -->
                                    <span
                                        class="h-4 w-0.5 shrink-0 rounded-full"
                                        :class="
                                            originsOf(group, change.path)[0] ? originHue(originsOf(group, change.path)[0]!).rail : 'bg-transparent'
                                        "
                                    ></span>
                                    <button
                                        type="button"
                                        class="flex min-w-0 flex-1 items-center gap-1.5 py-0.5 pl-0.5 text-left max-md:min-h-11"
                                        @click="clickRow({ repo: group.repo, side: section.side, path: change.path }, change, $event)"
                                        @dblclick="openDiff(group.repo, section.side, change, 'keep')"
                                    >
                                        <ChangeStatusMark :status="change.status" />
                                        <!-- How a changed file is named, shared with the review panel on
                                         /agents/{id} so a file reads the same on both — see ChangeRowName. It
                                         replaces the middle-truncated full path this row used to draw, which
                                         made every row in a deep tree look identical. -->
                                        <ChangeRowName
                                            :path="change.path"
                                            :label="changeLabel(group.repo, change)"
                                            :named="viewOf(group.repo, section.side).named"
                                        />
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
                                        <ReviewStat
                                            v-bind="codeOf(group.repo, section.side, change.path)"
                                            :additions="change.additions"
                                            :deletions="change.deletions"
                                        />
                                    </button>
                                    <!-- The row's half of the same rule: the index verb is always on screen. It
                                         rests a step BELOW the filename it sits beside (`text-subtle` against
                                         the path's `text-muted`) so a hundred of them read as texture down the
                                         right edge rather than as a hundred buttons; the row under the pointer
                                         brings it up to the path's own weight, and the pointer on the button
                                         itself lights it fully. Three steps, no movement — the same reveal the
                                         trash gets, done in tone instead of in existence.
                                         NOT TINTED, which is the other half of the decision. Green and red are
                                         already load-bearing on this row — +12/−3 beside it, and A/M/D on the
                                         status letter before the path — so a green plus would spend a colour
                                         that already means something on a control that is identical in every
                                         row. Colour here would be the loudest thing in the list and the least
                                         informative; the row's own colours are the data. -->
                                    <button
                                        type="button"
                                        class="flex h-5 w-5 shrink-0 items-center justify-center rounded text-subtle transition-colors hover:bg-overlay hover:text-content disabled:opacity-40 group-hover/file:text-muted max-md:h-8 max-md:w-8"
                                        :disabled="changes.actionBusy.value"
                                        @click="stageRow({ repo: group.repo, side: section.side, path: change.path })"
                                        v-tooltip.top="INDEX_VERB[section.side].one"
                                        :aria-label="`${INDEX_VERB[section.side].one}: ${change.path}`"
                                    >
                                        <Icon :name="INDEX_VERB[section.side].icon" class="text-2xs" />
                                    </button>
                                    <button
                                        type="button"
                                        class="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted opacity-0 transition-colors hover:bg-overlay hover:text-content focus-visible:opacity-100 group-hover/file:opacity-100 disabled:opacity-40 max-md:h-8 max-md:w-8 max-md:opacity-100"
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
                    <Icon name="shield" class="mr-0.5 text-[0.6rem]" />A restore point is saved first, so this is reversible from Restore points.
                </p>
            </template>
            <template #footer>
                <button type="button" class="rounded px-3 py-1 text-xs text-muted hover:text-content" @click="pendingDiscard = undefined">
                    Cancel
                </button>
                <Button
                    size="small"
                    severity="danger"
                    label="Discard"
                    class="px-3 py-1"
                    :disabled="changes.actionBusy.value"
                    @click="confirmDiscard"
                />
            </template>
        </Dialog>

        <!-- The full session title behind a row's origin chip — the same card the chat tab strip raises, mounted
             at <body> so it clears this sidebar's narrow, scrolling column. -->
        <HoverCard ref="hoverCard" />
    </div>
</template>
