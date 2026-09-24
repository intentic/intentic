import {
    type AgentChecklist,
    type AgentReaction,
    type AgentStatus,
    type AgentSummary,
    deriveTitle,
    isTurnBreakPolicy,
    type LandConflictReason,
    type LandedMessageDraft,
    planParts,
    type TodoItem,
    type TurnBreak,
    type TurnBreakPolicy,
    type TurnProfile,
    type UnfinishedWork,
    type SessionOwner,
} from "@intentic/sandbox-contract";
import { isFailureSentence, isSelfIdentityAnswer, isToolCallStandIn } from "../../agent/providers/failure-sentences.js";
import type { JournalledTurn, TurnJournalRows } from "../../agent/run/turn/turn-journal.js";
import { opt } from "../../opt.js";
import { parentOfActor } from "../../auth/principal.js";
import { subagentCountsOf } from "../../agent/subagents/subagents.js";
import { wakesItself } from "../../agent/tools/background-jobs.js";
import { liveRunOf } from "../actor/conversation-holdings.js";
import { queueView } from "../actor/conversation-queue.js";
import { MAX_NOTE_LENGTH, MAX_SUBJECT_LENGTH } from "../../git/ops/commit-message.js";
import type { ConversationUnits } from "../../store/conversation-units.js";
import { type ConversationActors, type ConversationBooks, createConversationActors } from "../actor/conversation-actors.js";
import type { BeginTurn, SettleFlush } from "../actor/conversation-decide.js";
import { activityLive, type ConversationState, NO_USAGE, type TurnUsage } from "../actor/conversation-state.js";
import { conversationStatus, parkedKinds } from "../actor/conversation-status.js";
import {
    type AgentsStore,
    type AgentTitleSource,
    type Composition,
    type Ending,
    endingStatus,
    type Identity,
    type IsolatedAgent,
    isIsolated,
    type PersistedAgent,
    type Postures,
    type RepoRecord,
    type Social,
    type StoredProfile,
    type Totals,
} from "./agents-store.js";
import type { LandOutcome } from "../land/land.js";
import type { LandedPresences } from "../land/landed-presence.js";
import type { LandStandings } from "../land/standing.js";
import { nextPromptDayAt } from "../../agent/run/prompt-fingerprint.js";

// The persisted half of the fleet: the in-memory entry list (loaded once, written through on persisted mutations), the
// AgentSummary each card is projected as, and the roster's subscribers. Every card-visible change broadcasts the full
// roster as a snapshot, never a diff (system.routes relays it onto /events); what a turn is doing lives in its actor.

const MAX_TITLE_LENGTH = 80;
// Numeric so promoteTitle's comparison is one `<=`; an entry with no title reads as `derived`, replaceable by anything.
const TITLE_RANK: Record<AgentTitleSource, number> = { derived: 0, model: 1, plan: 2, user: 3 };
// Collapses control characters and whitespace to single spaces and cuts to `limit`. A parameter, not a constant, since
// a title's card width and a changelog sentence's length must not share one ceiling.
const sanitizeLine = (text: string, limit: number): string | undefined => {
    const clean = text
        .replaceAll(/[\p{Cc}\p{Cf}]+/gu, " ")
        .replaceAll(/\s+/gu, " ")
        .trim()
        .slice(0, limit);
    return clean === "" ? undefined : clean;
};

const sanitizeTitle = (prompt: string): string | undefined => sanitizeLine(prompt, MAX_TITLE_LENGTH);

// A provider's failure sentence or a tool-call stand-in; never written as a name except by an explicit rename, and a
// stored one forfeits its rank so the next honest title replaces it.
const cannotBeAName = (title: string): boolean => isFailureSentence(title) || isToolCallStandIn(title) || isSelfIdentityAnswer(title);

// Whether an automatic source may overwrite what is stored: it must be a name at all, and must strictly outrank the
// stored one, whose rank is forfeit when it cannot be a name. A rename ("user") never asks; it always lands.
const outranksTitle = (title: Social["title"], clean: string, source: AgentTitleSource): boolean => {
    if (cannotBeAName(clean)) {
        return false;
    }
    const currentRank = title === undefined ? TITLE_RANK.derived : cannotBeAName(title.text) ? -1 : TITLE_RANK[title.source];
    return TITLE_RANK[source] > currentRank;
};

// One-line scrub on its own limit (MAX_NOTE_LENGTH), never the title's 80-character card width: sharing that ceiling
// once truncated changelog entries mid-word. A backstop; the drafter clips on a word boundary before this is reached.
const sanitizeNote = (note: string): string | undefined => sanitizeLine(note, MAX_NOTE_LENGTH);

// A commit subject's own limit (MAX_SUBJECT_LENGTH, git's header max), never the title's 80-character card width. A
// backstop; the drafter clips on a word boundary before this is reached.
const sanitizeSubject = (subject: string): string | undefined => sanitizeLine(subject, MAX_SUBJECT_LENGTH);

// Live context readings: how full the window is, how large it is, and how long what is already cached stays cheap to
// re-send. One clause on the summary, since no reader wants one without the others.
const contextFill = (state: ConversationState | undefined): Pick<AgentSummary, "contextTokens" | "contextWindow" | "promptCache" | "keepWarm"> => {
    const cache = state?.turn.promptCache;
    return {
        ...opt("contextTokens", state?.turn.contextTokens),
        ...opt("contextWindow", state?.turn.contextWindow),
        ...(cache === undefined
            ? {}
            : { promptCache: { ...cache, rollsAt: nextPromptDayAt(cache.at), ...(state?.turn.replayable === true ? { keepable: true } : {}) } }),
        ...opt("keepWarm", state?.keepWarm),
    };
};

// What a turn left open, read at finish from only what it measured, no model asked, nothing self-reported: a missing
// check means it was not re-run; what a missing checklist means depends on how the turn ended (`TurnEnding`).
const openSteps = (list: readonly TodoItem[]): UnfinishedWork["steps"] => {
    const open = list.filter((item) => item.status !== "completed");
    if (open.length === 0) {
        return undefined;
    }
    // What it would pick up next: the one already in progress, else the first still waiting.
    const next = (open.find((item) => item.status === "in_progress") ?? open[0])?.content;
    return { open: open.length, total: list.length, ...(next !== undefined ? { next } : {}) };
};

// Where the checklist stands, for a card rather than for a verdict: the live list while the daemon still holds it,
// else what the last turn recorded as left open. An empty list is no list, and says so by carrying nothing.
const checklistOf = (entry: PersistedAgent, state: ConversationState | undefined): AgentChecklist | undefined => {
    const live = state?.turn.checklist;
    if (live !== undefined) {
        return live.length === 0 ? undefined : { done: live.filter((item) => item.status === "completed").length, total: live.length };
    }
    // The only reading that survives a daemon restart, and only for a turn that ended with work open: `unfinished` is
    // persisted, the runtime list is not.
    const steps = entry.unfinished?.steps;
    return steps === undefined ? undefined : { done: steps.total - steps.open, total: steps.total };
};

// What the actor keeps for its card between turns; nothing for a conversation this daemon has not heard from.
const cardReadings = (state: ConversationState | undefined): Partial<Pick<ConversationState, "loop" | "workflow" | "watches" | "jobs">> =>
    state ?? {};

// The check's verdict, only when it ran and failed; passed, cancelled, or never run leaves nothing.
const failedCheck = (flush: SettleFlush): string | undefined => (flush.check?.failed === true ? flush.check.label : undefined);

// The moment of measurement, not of the write: a settle that observed neither the list nor a check learned nothing
// new, and stamping `now` there would restart the age of an old abandonment.
const leftAt = (entry: PersistedAgent, flush: SettleFlush, now: number): number =>
    flush.checklist === undefined && flush.check === undefined ? (entry.unfinished?.at ?? now) : now;

/* THE STEPS A TURN LEAVES, and why a list it never saw is not always the old list. */
const stepsLeft = (entry: PersistedAgent, flush: SettleFlush): UnfinishedWork["steps"] => {
    if (flush.checklist !== undefined) {
        return openSteps(flush.checklist);
    }
    return flush.ending === "clean" ? undefined : entry.unfinished?.steps;
};

const unfinishedOf = (entry: PersistedAgent, flush: SettleFlush, now: number): UnfinishedWork | undefined => {
    // No turn ran: a land or a sweep finishing a resting card learned nothing about its work, and re-reading the
    // readings left by the last turn would re-stamp an old abandonment with today's date.
    if (flush.ending === "none") {
        return entry.unfinished;
    }
    const steps = stepsLeft(entry, flush);
    const check = failedCheck(flush);
    if (steps === undefined && check === undefined) {
        return undefined;
    }
    return { at: leftAt(entry, flush, now), ...(steps !== undefined ? { steps } : {}), ...(check !== undefined ? { check } : {}) };
};

// The failure fields, only while the card still reads as `error`; once the standing has moved on, they would describe a
// turn the board no longer shows as the last word. A spent allowance's are the rate limit's.
const reportedFailure = (
    ending: Ending,
    status: AgentStatus,
): Partial<Pick<AgentSummary, "failure" | "failureCode" | "limitResetsAt" | "limitHeld" | "limitScheduled" | "limitMoving">> => {
    if (status !== "error") {
        return {};
    }
    switch (ending.kind) {
        case "failed":
            return { ...opt("failure", ending.failure), ...opt("failureCode", ending.code) };
        case "limited":
            return {
                ...opt("failure", ending.failure),
                failureCode: "rate_limit",
                ...opt("limitResetsAt", ending.resetsAt),
                ...(ending.held ? { limitHeld: true } : {}),
                ...(ending.scheduled ? { limitScheduled: true } : {}),
                ...opt("limitMoving", ending.moving),
            };
        default:
            return {};
    }
};

// The per-conversation overrides of a sandbox-wide default (absent means inherit), projected together since the card's
// menu and the chat's control read them together.
const postures = (held: Postures): Partial<Pick<AgentSummary, "autoLand" | "limitPolicy" | "outagePolicy" | "stopPolicy">> => ({
    ...opt("autoLand", held.autoLand),
    ...opt("limitPolicy", held.limit),
    ...opt("outagePolicy", held.outage),
    ...opt("stopPolicy", held.stopped),
});

// How many different emoji one conversation may carry. Bounded by kinds, not by presses: a hundred people agreeing is
// still one chip, while a hundred different emoji is a row no card can draw.
export const MAX_REACTION_KINDS = 24;

// Flat presses grouped into the card's chips. Both orders come straight off press order — the emoji by whoever used it
// first, the names within one by who marked it first — so a second person pressing an existing chip never moves it.
const groupedReactions = (reactions: Social["reactions"]): AgentReaction[] | undefined => {
    if (reactions.length === 0) {
        return undefined;
    }
    const chips = new Map<string, AgentReaction>();
    for (const { emoji, email, name, at } of reactions) {
        const who = { email, ...(name !== undefined ? { name } : {}), at };
        const chip = chips.get(emoji);
        if (chip === undefined) {
            chips.set(emoji, { emoji, by: [who] });
        } else {
            chip.by.push(who);
        }
    }
    return [...chips.values()];
};

// What the entry says the last turn left open, except while a turn is running, where it would be noise on a card
// already working through that very list.
const reportedUnfinished = (entry: PersistedAgent, state: ConversationState | undefined): Partial<Pick<AgentSummary, "unfinished">> =>
    state?.phase.kind === "running" ? {} : opt("unfinished", entry.unfinished);

// Session id and account move together: a session resumes only under the account that minted it. Taken from the frame,
// not the request; a frame naming none leaves the existing account alone rather than clearing it.
const sessionBinding = (
    entry: PersistedAgent | undefined,
    frame: { readonly sessionId: string; readonly account?: string | undefined },
): { readonly sessionId: string; readonly account?: string } | undefined => {
    // Entry gone (archived, purged) mid-turn: nothing to bind, and no next turn to read it.
    if (entry === undefined) {
        return undefined;
    }
    const account = frame.account ?? entry.profile.account;
    const moved = entry.sessionId !== frame.sessionId || entry.profile.account !== account;
    return moved ? { sessionId: frame.sessionId, ...(account !== undefined ? { account } : {}) } : undefined;
};

// The fence it was born with: kept once set, else the opening turn's, else the parent's for a spawned child. A child
// inherits rather than starting unfenced, since a delegate a fenced turn opens is that turn continuing by other means.
// `undefined` is the whole workspace, so a child of an unfenced parent is unfenced too, which is the same answer.
const areasOfConversation = (
    existing: Identity,
    turn: BeginTurn,
    entryOf: (id: string) => PersistedAgent | undefined,
): { readonly areas?: string[] } => {
    if (existing.areas !== undefined) {
        return { areas: [...existing.areas] };
    }
    const parentId = parentOfActor(existing.startedBy ?? turn.startedBy);
    const inherited = turn.areas ?? (parentId === undefined ? undefined : entryOf(parentId)?.identity.areas);
    return inherited === undefined ? {} : { areas: [...inherited] };
};

// Latched with the conversation: each field keeps the first answer it got, and a later turn's differing persona does
// not move the conversation to another project.
const identityOf = (existing: Identity, turn: BeginTurn, entryOf: (id: string) => PersistedAgent | undefined): Identity => ({
    ...opt("origin", existing.origin ?? turn.origin),
    ...opt("startedBy", existing.startedBy ?? turn.startedBy),
    ...areasOfConversation(existing, turn, entryOf),
    ...opt("startIn", existing.startIn ?? turn.startIn),
    ...opt("actsAs", existing.actsAs ?? turn.profile.actsAs),
    ...opt("forkedFrom", existing.forkedFrom ?? turn.forkedFrom),
});

// Who answers for it: kept once set, else the opening turn's member, else the parent's owner for a child (`since` is
// the child's own birth, not the parent's; a parent handed over later keeps its children where they were). A program's
// or a wake's conversation gets none, and stays claimable.
const ownerOf = (
    held: PersistedAgent,
    turn: BeginTurn,
    entryOf: (id: string) => PersistedAgent | undefined,
    now: number,
): { readonly owner?: SessionOwner } => {
    if (held.social.owner !== undefined) {
        return { owner: held.social.owner };
    }
    const parentId = parentOfActor(held.identity.startedBy ?? turn.startedBy);
    const opener = turn.owner ?? (parentId === undefined ? undefined : entryOf(parentId)?.social.owner);
    return opener === undefined ? {} : { owner: { email: opener.email, ...opt("name", opener.name), since: now } };
};

// An authored title, a browser derivation, or a mid-turn rename all stand as written; a turn naming none is titled the
// way the browser would derive it. A held title keeps its source and action with it.
const socialOf = (held: PersistedAgent, turn: BeginTurn, entryOf: (id: string) => PersistedAgent | undefined, now: number): Social => {
    const text = (turn.title === undefined ? undefined : sanitizeTitle(turn.title)) ?? sanitizeTitle(deriveTitle(turn.prompt));
    return {
        ...held.social,
        ...opt("title", held.social.title ?? (text === undefined ? undefined : { text, source: "derived" as const })),
        ...ownerOf(held, turn, entryOf, now),
    };
};

// What a conversation's first turn starts from. Placement latches with identity from here on: a later turn keeps its
// workspace or worktree, and its runner, whatever a stale request says; a runner implies a worktree, since a remote
// conversation is isolated by construction.
const freshEntry = (turn: BeginTurn, now: number): PersistedAgent => ({
    id: turn.conversationId,
    placement:
        turn.isolated || turn.runner !== undefined
            ? { kind: "worktree", branch: `agent/${turn.conversationId}`, ...opt("runner", turn.runner), repos: [] }
            : { kind: "main" },
    identity: {},
    profile: { provider: "claude", harness: "native" },
    ending: { kind: "interrupted" },
    postures: {},
    landing: {},
    social: { reactions: [] },
    totals: { costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 0, toolUses: 0, subagents: 0 },
    createdAt: now,
    updatedAt: now,
});

// Each setting falls back to the last turn's, so a turn naming none keeps describing the agent by what it actually ran;
// provider and harness are the turn's own, never carried.
const settingsOf = (existing: StoredProfile, profile: TurnProfile): StoredProfile => ({
    ...existing,
    provider: profile.agent ?? "claude",
    harness: profile.harness ?? "native",
    ...opt("model", profile.model),
    ...opt("effort", profile.effort),
    ...opt("thinking", profile.thinking),
    ...opt("fast", profile.fast),
    ...opt("account", profile.account),
});

// The entry a turn opens: every record carried whole, since each outlives the turn that wrote it, except what a turn
// restates (identity it may still fill in, settings, title and owner). Its ending is the resting state for a turn that
// never reports back: only a daemon killed mid-turn ever sees it. Only a person's turn un-archives it.
const openedEntry = (existing: PersistedAgent | undefined, turn: BeginTurn, entryOf: (id: string) => PersistedAgent | undefined, now: number): PersistedAgent => {
    const { archivedAt, ...held } = existing ?? freshEntry(turn, now);
    return {
        ...held,
        ...(turn.byPerson ? {} : opt("archivedAt", archivedAt)),
        identity: identityOf(held.identity, turn, entryOf),
        profile: settingsOf(held.profile, turn.profile),
        ending: { kind: "interrupted" },
        social: socialOf(held, turn, entryOf, now),
        updatedAt: now,
    };
};

// How the turn ended goes on the entry: its failure, the user's stop, or the clean ending that hands off to standing.ts,
// which a dismissal takes too. The open work is dropped and re-added only as this settle says.
const settledEntry = (entry: PersistedAgent, flush: SettleFlush, now: number): PersistedAgent => {
    const { unfinished: _open, ...carried } = entry;
    return {
        ...carried,
        ...opt("sessionId", flush.sessionId ?? entry.sessionId),
        // The one field here that can be true even of a turn that ended perfectly cleanly.
        ...opt("unfinished", unfinishedOf(entry, flush, now)),
        ending: flush.failure ?? (flush.stopped === "stopped" ? { kind: "stopped" } : { kind: "idle" }),
        totals: {
            costUsd: entry.totals.costUsd + flush.usage.costUsd,
            inputTokens: entry.totals.inputTokens + flush.usage.inputTokens,
            outputTokens: entry.totals.outputTokens + flush.usage.outputTokens,
            // A manual land settles outside any turn and must not inflate `turns`.
            turns: entry.totals.turns + (flush.ranTurn ? 1 : 0),
            toolUses: entry.totals.toolUses + flush.usage.toolUses,
            subagents: entry.totals.subagents + flush.usage.subagents,
        },
        updatedAt: now,
    };
};

// A spent allowance's hold, booking and move are this process's memory, which a fresh daemon does not have.
const restored = (entry: PersistedAgent): PersistedAgent =>
    entry.ending.kind === "limited"
        ? { ...entry, ending: { kind: "limited", ...opt("failure", entry.ending.failure), ...opt("resetsAt", entry.ending.resetsAt), held: false, scheduled: false } }
        : entry;

// Written onto the entry at every change, so a conversation no actor has heard of since a restart shows it too.
const queueClause = ({ queue }: PersistedAgent): Pick<AgentSummary, "queue"> => (queue === undefined ? {} : { queue: queueView(queue) });

// What the card says the conversation is: where it works, where it came from and as whom, its name, who answers for it
// and what people left on it, and the settings its last turn ran under.
const describedBy = ({ placement, identity, profile, social, sessionId, archivedAt }: PersistedAgent) => ({
    provider: profile.provider,
    harness: profile.harness,
    ...(placement.kind === "worktree" ? { branch: placement.branch, ...opt("runner", placement.runner) } : {}),
    ...opt("startIn", identity.startIn),
    ...opt("actsAs", identity.actsAs),
    ...opt("sessionId", sessionId),
    ...opt("origin", identity.origin),
    ...opt("startedBy", identity.startedBy),
    ...opt("owner", social.owner),
    // The fence it was born with, on the summary because visibleTo() filters summaries: without it every fenced reader's
    // board is empty, their own conversations included.
    ...opt("areas", identity.areas),
    ...opt("forkedFrom", identity.forkedFrom),
    ...opt("title", social.title?.text),
    ...opt("titleAction", social.title?.action),
    ...opt("model", profile.model),
    ...opt("effort", profile.effort),
    ...opt("thinking", profile.thinking),
    ...opt("fast", profile.fast),
    ...opt("account", profile.account),
    ...opt("landRequested", social.landRequested),
    ...opt("reactions", groupedReactions(social.reactions)),
    ...opt("seenAt", social.seenAt),
    ...opt("archivedAt", archivedAt),
});

// Lifetime totals plus the running turn's not-yet-flushed usage, each shown once it is more than nothing, so a chip
// appears on content rather than as a column of zeros. Subagents: the running count from the roster its actors hold,
// the lifetime total from the entry, since the roster forgets a finished child.
const spentBy = (totals: Totals, usage: TurnUsage, running: number) => {
    const costUsd = totals.costUsd + usage.costUsd;
    const inputTokens = totals.inputTokens + usage.inputTokens;
    const outputTokens = totals.outputTokens + usage.outputTokens;
    const toolUses = totals.toolUses + usage.toolUses;
    const subagents = { running, total: totals.subagents + usage.subagents };
    return {
        ...(costUsd > 0 ? { costUsd } : {}),
        ...(inputTokens > 0 ? { inputTokens } : {}),
        ...(outputTokens > 0 ? { outputTokens } : {}),
        ...(totals.turns > 0 ? { turns: totals.turns } : {}),
        ...(toolUses > 0 ? { toolUses } : {}),
        ...(subagents.total > 0 ? { subagents } : {}),
    };
};

// What the actor holds for the card: the live turn's readings, the checklist, and the loop, workflow, watches and jobs
// its pumps last published. An empty list is turned absent, indistinguishable from never having watched.
const liveReadings = (entry: PersistedAgent, state: ConversationState | undefined) => {
    const { loop, workflow, watches, jobs } = cardReadings(state);
    return {
        ...contextFill(state),
        ...opt("activity", state?.turn.activity),
        ...opt("checklist", checklistOf(entry, state)),
        ...(state?.phase.kind === "running" ? { startedAt: state.phase.startedAt } : {}),
        ...opt("loop", loop),
        ...opt("workflow", workflow),
        ...(watches !== undefined && watches.length > 0 ? { watches: [...watches] } : {}),
        ...(jobs !== undefined && jobs.length > 0 ? { jobs: [...jobs] } : {}),
    };
};

export interface AgentsRegistry {
    readonly init: () => Promise<void>;
    // Takes in the rows an arrival just wrote for `ids`, each read back as a boot reads it and replacing what this process
    // held for it; every other conversation keeps what this process holds of it, its limit hold included.
    readonly adopted: (ids: readonly string[]) => void;
    readonly ids: () => string[];
    // The board's roster, live agents only; archived ones are excluded here and from every broadcast.
    readonly list: () => AgentSummary[];
    // The archive, newest first; read on demand, never broadcast.
    readonly listArchived: () => AgentSummary[];
    readonly get: (id: string) => AgentSummary | undefined;
    // The persisted entry, including the per-repo bases diff and land need.
    readonly entry: (id: string) => PersistedAgent | undefined;
    // Writes what a worktree conversation's checkout is (its repos, each with the main-line base) and, only when given,
    // what it should carry (`composition`); callers that merely rewrite repos keep the opening turn's decision.
    readonly recordWorktree: (id: string, repos: readonly RepoRecord[], composition?: Composition) => Promise<void>;
    // Strips a deleted repo out of every checkout, live and archived. Only the registry's half; agents/vanished-repos.ts
    // decides the rest.
    readonly dropRepos: (repos: readonly string[]) => Promise<string[]>;
    // Sets the title per the source ranking (AgentTitleSource): a rename always lands, an automatic source only moves
    // it up. A rejected promotion still returns the entry's current summary, not `undefined`.
    // `action` is the naming pass's one work word, stored beside the title and never shown; any other source clears it.
    readonly setTitle: (id: string, title: string, source: AgentTitleSource, action?: string) => Promise<AgentSummary | undefined>;
    // Records what the landed work did, as a commit subject; no ranking, the newest land simply describes the most
    // current claim. Broadcast so the Changes panel picks it up immediately.
    readonly setLandedSubject: (id: string, draft: { subject: string; note?: string; breaking?: string; testNote?: string }) => Promise<void>;
    // Publishes the live account of a landed message being drafted, as it changes; the wait is the one part of a land a
    // user watches. Runtime and broadcast only, never persisted; `undefined` withdraws it.
    readonly setLandedMessageDraft: (id: string, draft: LandedMessageDraft | undefined) => void;
    // Stamps the read marker; leaves `updatedAt` alone, since reading is not activity.
    readonly markSeen: (id: string, now: number) => Promise<AgentSummary | undefined>;
    // Set/clear the autoLand override (null inherits the sandbox setting); read at turn completion, so a mid-turn flip
    // holds only this turn's work.
    readonly setAutoLand: (id: string, autoLand: boolean | null) => Promise<AgentSummary | undefined>;
    // Same grammar as `setAutoLand`, once for all three endings: read by the resume pass after the turn has already
    // died, so arming it mid-unwind is the ordinary case, and a limit's press is often made on a card whose turn died
    // hours ago. Refuses an answer the ending does not allow rather than persisting one no pass would ever read.
    readonly setBreakPolicy: (id: string, ending: TurnBreak, policy: TurnBreakPolicy | null) => Promise<AgentSummary | undefined>;
    // Stamps a collaborator's ask to land; leaves `updatedAt` alone. Re-asking re-stamps rather than queuing; the land
    // or discard that answers it clears the ask.
    readonly requestLand: (id: string, by: { email: string; name?: string }, at: number) => Promise<AgentSummary | undefined>;
    // Makes a member answerable for the conversation; who may is the route's decision (agents/ownership.ts). Leaves
    // `updatedAt` alone: changing hands is not the conversation doing something.
    readonly assign: (id: string, to: { email: string; name?: string }, at: number) => Promise<AgentSummary | undefined>;
    // Adds or takes back one person's mark. `on` is the intent, not a flip, so a retried request settles where the
    // first one did. Leaves `updatedAt` alone: somebody reacting is not the conversation doing something.
    readonly react: (id: string, emoji: string, by: { email: string; name?: string }, on: boolean, at: number) => Promise<AgentSummary | undefined>;
    // Stamps every card's read marker at once, the board's one escape hatch for unread badges.
    readonly markAllSeen: (now: number) => Promise<void>;
    // Persists a land's outcome (advanced landedTips, diffstat, conflict report) as one write, so the report cannot
    // drift from the tips it belongs to; an outcome with no conflicts clears the stored one.
    readonly recordLanded: (id: string, outcome: LandOutcome) => Promise<void>;
    // Records once that a landing is fully absorbed, instead of re-deriving it from git on every scan; the (landedHead,
    // landedTip) pair guards it. No broadcast: nothing visible changes.
    readonly markLandingAbsorbed: (id: string, repo: string, landedHead: string, landedTip: string, size: number) => Promise<void>;
    // Re-derives every live agent's land standing and publishes if any moved; called wherever the answer could have
    // changed outside the daemon. Once a feed is watched, free when nothing moved: no git runs at all.
    readonly refreshStandings: () => Promise<void>;
    // What can move a standing from outside the registry: a ref, or a file in a main checkout. Once given, a refresh
    // re-reads git only after the feed reported something or an agent's own landing record changed; until then, always.
    readonly watchStandings: (changes: (changed: () => void) => () => void) => () => void;
    // Stamps/clears the archive marker; the caller must have already retired or restored the checkout
    // (agents/archive.ts owns that order).
    readonly setArchived: (ids: readonly string[], now: number) => Promise<void>;
    readonly clearArchived: (ids: readonly string[]) => Promise<void>;
    // Delivers an immediate snapshot on subscribe, tagged with the revision it was taken at, so a fresh connection
    // paints without waiting.
    readonly subscribe: (listener: (agents: AgentSummary[], rev: number) => void) => () => void;
    // Bumped on every broadcast, so a browser reconciling this stream against its own GET and optimistic writes can
    // tell which snapshot is newer. Resets to 0 on reboot; a fresh connection adopts the first roster it sees.
    readonly revision: () => number;
}

// The fleet's two halves over one entry list: the registry that persists and projects it, and the actors that run each
// conversation's lifecycle, writing through the registry's books, which nothing else can reach.
export interface Fleet {
    readonly agents: AgentsRegistry;
    readonly conversations: ConversationActors;
}

// What the fleet writes through: its entries and the turn each has in flight, in one database whose transaction makes a
// turn's opening entry and its journal row one write, and the directory a conversation that leaves takes with it.
export interface FleetStore {
    readonly agents: AgentsStore;
    readonly journal: TurnJournalRows;
    readonly transaction: <T>(work: () => T) => T;
    readonly units: Pick<ConversationUnits, "remove">;
}

// Milliseconds between two sends of the roster, however many changes land between them.
export const ROSTER_WINDOW_MS = 100;

export const createFleet = (
    store: FleetStore,
    standings: LandStandings,
    presences: LandedPresences,
    { rosterWindowMs = ROSTER_WINDOW_MS }: { readonly rosterWindowMs?: number } = {},
): Fleet => {
    let entries: PersistedAgent[] = [];
    // Entries changed since the last write, and the journal row of each turn opened since, which goes down with its
    // opening entry; both drained only once the write commits, so a failed one is retried by the next.
    const dirty = new Set<string>();
    const journalled = new Map<string, JournalledTurn>();
    // Live account of each agent's commit message being drafted: drafting starts after the landing turn has ended, and a
    // finished report stays until the next land replaces it.
    const messageDrafts = new Map<string, LandedMessageDraft>();
    const listeners = new Set<(agents: AgentSummary[], rev: number) => void>();
    // Bumped by `broadcast()`, once per published change; see `revision` on the interface.
    let revision = 0;
    // When the roster last went out, and the send a burst is waiting on.
    let sentAt = Number.NEGATIVE_INFINITY;
    let sending: ReturnType<typeof setTimeout> | undefined;

    // Who can clear what is still refusing, from the same live probe the verdict came from. Only while the card is
    // actually refusing: a list left on a landed card would offer a press about nothing.
    const conflictCausesOf = (status: AgentStatus, id: string): LandConflictReason[] | undefined => {
        const causes = status === "conflict" ? standings.causesOf(id) : [];
        return causes.length === 0 ? undefined : [...causes];
    };

    // Rebuilt only when `entries` is reassigned, which is how every write lands (nothing mutates the array in place),
    // so lookups between writes are O(1) instead of a scan of the whole roster, archived agents included.
    let indexed: { readonly of: readonly PersistedAgent[]; readonly byId: ReadonlyMap<string, PersistedAgent> } | undefined;
    const entryOf = (id: string): PersistedAgent | undefined => {
        if (indexed?.of !== entries) {
            indexed = { of: entries, byId: new Map(entries.map((entry) => [entry.id, entry])) };
        }
        return indexed.byId.get(id);
    };

    const replace = (next: PersistedAgent): void => {
        entries = [...entries.filter((entry) => entry.id !== next.id), next];
        dirty.add(next.id);
    };

    // Every entry changed since the last write and every journal row owed with them, one transaction. Synchronous
    // underneath, so writes land in the order they were asked for; async only so a caller can await it like any write.
    const persist = async (): Promise<void> => {
        if (dirty.size === 0 && journalled.size === 0) {
            return;
        }
        const changed = entries.filter((entry) => dirty.has(entry.id));
        const rows = [...journalled];
        store.transaction(() => {
            store.agents.save(changed);
            for (const [, turn] of rows) {
                store.journal.putTurn(turn);
            }
        });
        dirty.clear();
        journalled.clear();
    };

    // The one place the title-rank comparison is applied, so every caller agrees on who may rename what. A rename
    // always lands, even a second one; anything else must strictly outrank what's there.
    const promoteTitle = (id: string, title: string | undefined, source: AgentTitleSource, action?: string): boolean => {
        const entry = entryOf(id);
        const clean = title === undefined ? undefined : sanitizeTitle(title);
        if (entry === undefined || clean === undefined) {
            return false;
        }
        const held = entry.social.title;
        if (source !== "user" && !outranksTitle(held, clean, source)) {
            return false;
        }
        if (held?.text === clean && held.source === source && held.action === action) {
            return false;
        }
        // A title from a source that names no action loses the previous one's category.
        replace({ ...entry, social: { ...entry.social, title: { text: clean, source, ...opt("action", action) } } });
        return true;
    };

    // Whether a refresh must re-read git: set by the watched feed, by a probe that failed, and at start; `watched` says a
    // feed exists at all, without which nothing could clear it honestly.
    let watched = false;
    let stale = true;
    // The live agents' own landing inputs as the last probe saw them; a change here moves a standing with no ref moving.
    let probedInputs = ``;
    const landingInputs = (live: readonly IsolatedAgent[]): string =>
        JSON.stringify(live.map((entry) => [entry.id, entry.placement.branch, entry.placement.repos, entry.landing.conflicts ?? []]));

    // Two independent, best-effort readings (standing, landed presence) run together rather than chained, and must
    // never throw: a settle waits on this. `allSettled`, so a failing half costs only its own reading.
    const probeFleet = async (): Promise<boolean> => {
        const live = entries.filter(isIsolated).filter((entry) => entry.archivedAt === undefined);
        stale = false;
        probedInputs = landingInputs(live);
        const probes = await Promise.allSettled([standings.refresh(live), presences.refresh(live)]);
        stale ||= probes.some((probe) => probe.status === "rejected");
        return probes.some((probe) => probe.status === "fulfilled" && probe.value);
    };
    // One probe at a time, shared: a caller arriving mid-probe may be asking after a change that probe began too early
    // to see (a land's moved tips), so one more follows it, shared in turn by everyone who asked meanwhile.
    let probing: Promise<boolean> | undefined;
    let following: Promise<boolean> | undefined;
    const reprobe = (): Promise<boolean> => {
        if (probing === undefined) {
            probing = probeFleet().finally(() => {
                probing = undefined;
            });
            return probing;
        }
        following ??= probing.then(
            () => {
                following = undefined;
                return reprobe();
            },
            () => {
                following = undefined;
                return reprobe();
            },
        );
        return following;
    };

    const books: ConversationBooks = {
        entry: entryOf,
        // The turn's journal row rides with the entry that opens it, so neither is ever written without the other.
        open: (turn, now, inFlight) => {
            replace(openedEntry(entryOf(turn.conversationId), turn, entryOf, now));
            if (inFlight !== undefined) {
                journalled.set(turn.conversationId, inFlight);
            }
        },
        settle: (id, flush, now) => {
            const entry = entryOf(id);
            if (entry !== undefined) {
                replace(settledEntry(entry, flush, now));
            }
        },
        // The daemon's own sentence about a resume that never came; the original failure's classification goes with it.
        abandon: (id, failure, now) => {
            const entry = entryOf(id);
            if (entry !== undefined) {
                replace({ ...entry, ending: { kind: "failed", ...opt("failure", failure) }, updatedAt: now });
            }
        },
        // Written through at once, not only at the settle: a daemon killed mid-turn otherwise loses the only key into the
        // provider's session store. Fire-and-forget.
        bindSession: (id, sessionId, account) => {
            const entry = entryOf(id);
            const binding = sessionBinding(entry, { sessionId, ...opt("account", account) });
            if (entry !== undefined && binding !== undefined) {
                replace({ ...entry, sessionId: binding.sessionId, profile: { ...entry.profile, ...opt("account", binding.account) } });
                void persist();
            }
        },
        dropSession: (id) => {
            const entry = entryOf(id);
            if (entry !== undefined) {
                const { sessionId: _dropped, ...carried } = entry;
                replace(carried);
            }
        },
        planTitle: (id, text) => {
            if (promoteTitle(id, planParts(text).title, "plan")) {
                void persist();
            }
        },
        // Filed so the next turn's plan can restate what a compaction summarized away; once per turn however often it
        // compacts. Fire-and-forget, no broadcast.
        compacted: (id) => {
            const entry = entryOf(id);
            if (entry !== undefined && entry.compactedTurn !== entry.totals.turns) {
                replace({ ...entry, compactedTurn: entry.totals.turns });
                void persist();
            }
        },
        queue: (id, queue) => {
            const entry = entryOf(id);
            if (entry !== undefined) {
                replace({ ...entry, queue });
            }
        },
        // The begun run's row as it changes: still waiting on the write that opens the turn, it goes with that write;
        // otherwise it is written now, on its own, since a turn in flight must not wait on anything else's write.
        journal: async (id, turn) => {
            if (journalled.has(id)) {
                journalled.set(id, turn);
                return;
            }
            store.journal.putTurn(turn);
        },
        unjournal: async (id) => {
            if (!journalled.delete(id)) {
                store.journal.deleteTurn(id);
            }
        },
        persist,
        reprobe,
        // Closures, since the roster they publish reads the actors built from these very books.
        broadcast: () => broadcast(),
        progress: () => progress(),
        // The actors' own half, watch timers included, went first, in dispose. Rows before the directories: a directory
        // left behind by a failed removal is one the boot sweep finds unowned.
        remove: async (ids) => {
            const targets = new Set(ids);
            entries = entries.filter((entry) => !targets.has(entry.id));
            for (const id of targets) {
                messageDrafts.delete(id);
                dirty.delete(id);
                journalled.delete(id);
            }
            standings.forget(ids);
            presences.forget(ids);
            store.agents.remove(ids);
            await store.units.remove(ids);
            broadcast();
        },
    };
    const conversations = createConversationActors(books);

    // What the checkout has landed and how that stands: the base it sits on, the drafted message and its live account,
    // the diffstat, and whether what landed is still in the tree. Worktree conversations only.
    const landingClause = (entry: PersistedAgent, status: AgentStatus) => {
        if (entry.placement.kind === "main") {
            return {};
        }
        const { repos } = entry.placement;
        return {
            ...opt("base", (repos.find((repo) => repo.repo === "root") ?? repos[0])?.base.slice(0, 7)),
            // Rides beside the attention flag, from the same live probe: the flag says a press is owed, this says whose.
            ...opt("conflictCauses", conflictCausesOf(status, entry.id)),
            // Live account of the commit message being drafted; kept until the next land replaces it.
            ...opt("landedMessageDraft", messageDrafts.get(entry.id)),
            // The finished sentence itself, the moment it exists, for the Changes panel's 'From' chip.
            ...opt("landedMessage", entry.landing.message),
            ...opt("diff", entry.landing.diff),
            // Present only when some of what this agent landed is no longer in the tree; absence says nothing.
            ...opt("landedPresence", presences.of(entry.id)),
        };
    };

    const summaryOf = (entry: PersistedAgent): AgentSummary => {
        const state = conversations.state(entry.id);
        // A turn holding any unanswered card reads as `awaiting`, whatever else is in flight beside it.
        const parked = parkedKinds(state);
        const status = conversationStatus(
            state,
            endingStatus(entry.ending),
            entry.placement.kind === "main" ? "idle" : standings.of(entry.id),
            wakesItself(conversations, entry.id),
        );
        return {
            id: entry.id,
            status,
            updatedAt: state !== undefined && activityLive(state) ? Math.max(entry.updatedAt, state.turn.lastAt ?? 0) : entry.updatedAt,
            attention: {
                plan: parked.includes("plan"),
                question: parked.includes("question"),
                permission: parked.includes("permission"),
                capability: parked.includes("capability_offer"),
                // Its own lane, not folded into `permission`: the reader looking at the board often cannot be the one
                // who clears it.
                credential: parked.includes("credential_offer"),
                // Reads the derived verdict, not a stored status; a cached status here was the original bug's shape.
                conflict: status === "conflict",
            },
            ...describedBy(entry),
            ...reportedUnfinished(entry, state),
            ...reportedFailure(entry.ending, status),
            ...postures(entry.postures),
            ...spentBy(entry.totals, state?.turn.usage ?? NO_USAGE, subagentCountsOf(conversations, entry.id).running),
            ...liveReadings(entry, state),
            // Only while its turn runs: a settled card must not name the run it just finished as under way.
            ...(state?.phase.kind === "running" ? opt("run", liveRunOf(conversations, entry.id)?.id) : {}),
            ...queueClause(entry),
            ...landingClause(entry, status),
        };
    };

    const list = (): AgentSummary[] => entries.filter((entry) => entry.archivedAt === undefined).map(summaryOf);

    const send = (): void => {
        sending = undefined;
        sentAt = Date.now();
        if (listeners.size === 0) {
            return;
        }
        const agents = list();
        for (const listener of listeners) {
            listener(agents, revision);
        }
    };

    // A change someone made goes out at once, carrying whatever progress was waiting. The revision is bumped at the
    // change, not the send, so a route reading `revision()` right after gets the one its own change produced.
    const broadcast = (): void => {
        revision += 1;
        clearTimeout(sending);
        send();
    };

    // Every running turn's tool calls, usage and todos land here and each send is the whole live roster, so progress goes
    // out at most once a window: after a quiet spell at once, the rest of a burst together at the window's end.
    const progress = (): void => {
        revision += 1;
        if (sending !== undefined) {
            return;
        }
        const wait = sentAt + rosterWindowMs - Date.now();
        if (wait <= 0) {
            send();
            return;
        }
        sending = setTimeout(send, wait);
    };

    // Applies `change` to the entry and writes it, answering the summary it left; undefined for an unknown id.
    const amend = async (id: string, change: (entry: PersistedAgent) => PersistedAgent): Promise<AgentSummary | undefined> => {
        const entry = entryOf(id);
        if (entry === undefined) {
            return undefined;
        }
        const next = change(entry);
        replace(next);
        await persist();
        broadcast();
        return summaryOf(next);
    };

    const agents: AgentsRegistry = {
        init: async () => {
            entries = store.agents.load().map(restored);
            // Broadcasts immediately on load, before standings are probed, since a fresh boot's verdict cache is empty
            // and probing first would hold the whole boot behind a git spawn per live agent.
            broadcast();
            void reprobe()
                .then((moved) => {
                    if (moved) {
                        broadcast();
                    }
                })
                // silent-catch: reprobe never throws; a broadcast that does leaves the next change to carry the standings.
                .catch(() => undefined);
        },
        adopted: (ids) => {
            const arrived = new Set(ids);
            entries = [...entries.filter((entry) => !arrived.has(entry.id)), ...store.agents.load().filter((entry) => arrived.has(entry.id)).map(restored)];
            standings.forget(ids);
            presences.forget(ids);
            broadcast();
        },
        refreshStandings: async () => {
            const live = entries.filter(isIsolated).filter((entry) => entry.archivedAt === undefined);
            if (watched && !stale && landingInputs(live) === probedInputs) {
                return;
            }
            if (await reprobe()) {
                broadcast();
            }
        },
        watchStandings: (changes) => {
            watched = true;
            stale = true;
            const stop = changes(() => {
                stale = true;
            });
            return () => {
                watched = false;
                stop();
            };
        },
        ids: () => entries.map((entry) => entry.id),
        list,
        listArchived: () =>
            entries
                .filter((entry) => entry.archivedAt !== undefined)
                .toSorted((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0))
                .map(summaryOf),
        get: (id) => {
            const entry = entryOf(id);
            return entry === undefined ? undefined : summaryOf(entry);
        },
        entry: entryOf,
        recordWorktree: async (id, repos, composition) => {
            const entry = entryOf(id);
            if (entry === undefined || !isIsolated(entry)) {
                return;
            }
            replace({ ...entry, placement: { ...entry.placement, repos: [...repos], ...opt("composition", composition) } });
            await persist();
        },
        dropRepos: async (repos) => {
            const gone = new Set(repos);
            // Snapshotted before the first `replace` rebuilds `entries`; rows are copied, never mutated, since readers
            // keep the array they read.
            const touched = entries.filter(isIsolated).filter((entry) => entry.placement.repos.some(({ repo }) => gone.has(repo)));
            if (touched.length === 0) {
                return [];
            }
            for (const entry of touched) {
                replace({ ...entry, placement: { ...entry.placement, repos: entry.placement.repos.filter(({ repo }) => !gone.has(repo)) } });
            }
            // One write and broadcast for the whole sweep; nothing on a card moves, but the roster should stop naming a
            // repo that's gone.
            await persist();
            broadcast();
            return touched.map((entry) => entry.id);
        },
        setTitle: async (id, title, source, action) => {
            if (entryOf(id) === undefined || sanitizeTitle(title) === undefined) {
                return undefined;
            }
            if (promoteTitle(id, title, source, action)) {
                await persist();
                broadcast();
            }
            const entry = entryOf(id);
            return entry === undefined ? undefined : summaryOf(entry);
        },
        setLandedSubject: async (id, draft) => {
            const entry = entryOf(id);
            const subject = sanitizeSubject(draft.subject);
            // Bounded to the subject's own ceiling, not the card's; an empty draft writes nothing rather than clearing
            // the last one.
            if (entry === undefined || subject === undefined) {
                return;
            }
            // Both notes clear when this land wrote none; they describe the claim as it now stands, not a leftover from
            // an earlier land.
            const note = draft.note === undefined ? undefined : sanitizeNote(draft.note);
            const breaking = draft.breaking === undefined ? undefined : sanitizeNote(draft.breaking);
            const testNote = draft.testNote === undefined ? undefined : sanitizeNote(draft.testNote);
            replace({
                ...entry,
                landing: { ...entry.landing, message: { subject, ...opt("note", note), ...opt("breaking", breaking), ...opt("testNote", testNote) } },
            });
            broadcast();
            await persist();
        },
        // The draft's whole story, re-sent complete on every beat, so a browser that missed one frame is merely late,
        // never wrong. Runtime only, never persisted.
        setLandedMessageDraft: (id, draft) => {
            if (entryOf(id) === undefined) {
                return;
            }
            if (draft === undefined) {
                if (!messageDrafts.delete(id)) {
                    return;
                }
            } else {
                messageDrafts.set(id, draft);
            }
            broadcast();
        },
        // Broadcasts so the badge clears on every connected surface at once.
        markSeen: (id, now) => amend(id, (entry) => ({ ...entry, social: { ...entry.social, seenAt: now } })),
        markAllSeen: async (now) => {
            for (const entry of entries) {
                replace({ ...entry, social: { ...entry.social, seenAt: now } });
            }
            await persist();
            broadcast();
        },
        // null strips the override entirely; absent is the inherit state, so the agent keeps following the sandbox toggle.
        setAutoLand: (id, autoLand) =>
            amend(id, (entry) => {
                const { autoLand: _cleared, ...held } = entry.postures;
                return { ...entry, postures: autoLand === null ? held : { ...held, autoLand } };
            }),
        setBreakPolicy: async (id, ending, policy) => {
            // An answer the ending cannot take is refused here rather than stored: no pass would ever read it, and a card
            // showing a policy nothing acts on is worse than one showing none.
            if (policy !== null && !isTurnBreakPolicy(ending, policy)) {
                return undefined;
            }
            // Same as `setAutoLand`: null strips the key, since absent is the only state that means inherit. Only the
            // named ending's key moves; the other two carry through untouched.
            return amend(id, (entry) => {
                const { [ending]: _cleared, ...held } = entry.postures;
                return { ...entry, postures: (policy === null ? held : { ...held, [ending]: policy }) as Postures };
            });
        },
        requestLand: (id, by, at) =>
            amend(id, (entry) => ({ ...entry, social: { ...entry.social, landRequested: { email: by.email, ...opt("name", by.name), at } } })),
        assign: (id, to, at) => amend(id, (entry) => ({ ...entry, social: { ...entry.social, owner: { email: to.email, ...opt("name", to.name), since: at } } })),
        react: async (id, emoji, by, on, at) => {
            const entry = entryOf(id);
            if (entry === undefined) {
                return undefined;
            }
            const held = entry.social.reactions;
            const mine = (mark: { emoji: string; email: string }): boolean => mark.emoji === emoji && mark.email === by.email;
            // Already where the caller is asking for: no write, no broadcast, and the same answer the first press gave.
            if (held.some(mine) === on) {
                return summaryOf(entry);
            }
            const reactions = on ? [...held, { emoji, email: by.email, ...opt("name", by.name), at }] : held.filter((mark) => !mine(mark));
            return amend(id, (current) => ({ ...current, social: { ...current.social, reactions } }));
        },
        recordLanded: async (id, outcome) => {
            const entry = entryOf(id);
            if (entry === undefined || !isIsolated(entry)) {
                return;
            }
            const { placement, landing } = entry;
            // Only a verdict may replace a verdict: a measure land touches no conflict gate and reports none, so it
            // carries the stored report across rather than reading silence as resolved.
            const verdict = outcome.adjudicated ? outcome.conflicts : (outcome.conflicts ?? landing.conflicts);
            // The drafted message describes the claim at its landedTips; once one moves it describes the previous
            // landing, and left in place it would head the commit of work it never read.
            const moved = outcome.repos.some((row) => row.landedTip !== placement.repos.find((composed) => composed.repo === row.repo)?.landedTip);
            if (moved) {
                messageDrafts.delete(id);
            }
            // A land answers any pending ask too; letting it outlive the land would read as a second, phantom ask.
            const { landRequested: _answered, ...social } = entry.social;
            replace({
                ...entry,
                placement: { ...placement, repos: [...outcome.repos] },
                landing: {
                    ...opt("message", moved ? undefined : landing.message),
                    ...opt("conflicts", verdict === undefined ? undefined : [...verdict]),
                    diff: outcome.diff,
                },
                social,
            });
            await persist();
            // landedTips just moved, half of what every standing is measured against.
            await reprobe();
            broadcast();
        },
        markLandingAbsorbed: async (id, repo, landedHead, landedTip, size) => {
            const entry = entryOf(id);
            if (entry === undefined || !isIsolated(entry)) {
                return;
            }
            const { repos } = entry.placement;
            const row = repos.find((composed) => composed.repo === repo);
            // Only the exact landing the caller measured; a newer land's fresh shas, or an already-marked row, are left
            // alone.
            if (row === undefined || row.landedHead !== landedHead || row.landedTip !== landedTip || row.absorbed !== undefined) {
                return;
            }
            // Copy-on-write: the array is shared with readers already holding it, so the row is replaced, not mutated.
            replace({ ...entry, placement: { ...entry.placement, repos: repos.map((composed) => (composed === row ? { ...row, absorbed: size } : composed)) } });
            await persist();
        },
        setArchived: async (ids, now) => {
            const targets = new Set(ids);
            for (const entry of entries.filter((candidate) => targets.has(candidate.id))) {
                replace({ ...entry, archivedAt: now });
            }
            await persist();
            // Excluding them from this broadcast's roster is how every connected surface learns the cards left the
            // board.
            broadcast();
        },
        clearArchived: async (ids) => {
            const targets = new Set(ids);
            for (const entry of entries.filter((candidate) => targets.has(candidate.id))) {
                const { archivedAt: _archived, ...live } = entry;
                replace(live);
            }
            await persist();
            broadcast();
        },
        subscribe: (listener) => {
            listeners.add(listener);
            // Carries the current revision without bumping it; subscribing is not a change, and a bumped one would look
            // newer than already-applied rosters.
            listener(list(), revision);
            return () => listeners.delete(listener);
        },
        revision: () => revision,
    };
    return { agents, conversations };
};
