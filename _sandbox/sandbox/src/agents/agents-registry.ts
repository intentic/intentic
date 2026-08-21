import { type AgentEvent, type AgentSummary, type AgentTurn, deriveTitle, type LandedMessageDraft, planParts } from "@intentic/sandbox-contract";
import { isFailureSentence } from "../agent/failure-sentences.js";
import { subagentCountsOf } from "../agent/subagents.js";
import { MAX_NOTE_LENGTH } from "../git/commit-message.js";
import { loopProjection } from "../loops/loop-state.js";
import { workflowProjection } from "../workflows/workflow-state.js";
import { recordConversationPrompt, recordPrompt } from "../sessions/transcript-search.js";
import { type AgentsStore, type AgentTitleSource, isIsolated, landedMessageOf, type PersistedAgent } from "./agents-store.js";
import type { LandOutcome } from "./land.js";
import type { LandedPresences } from "./landed-presence.js";
import type { LandStandings } from "./standing.js";

// The runtime half of the fleet registry: holds the authoritative in-memory entry list (loaded once from the
// store, write-through on persisted mutations) plus per-conversation turn state rebuilt from AgentEvent frames
//, status (running/awaiting), attention flags, the card's activity snippet, context fill, and the per-
// conversation turn mutex. Every card-visible change broadcasts the FULL roster (snapshots, not diffs, the
// same last-frame-wins contract as presence), which system.routes relays onto /events.

const MAX_TITLE_LENGTH = 80;
/* Long enough for the provider's own explanation, the entitlement refusal that prompted this field runs to 140
 * characters and names both ways out of it, and short enough that a stack trace or an HTML error page cannot
 * ride into the roster, which every connected browser re-reads in full on every card change. */
const MAX_FAILURE_LENGTH = 400;
// One bounded line, for the same reason a title is one: this is read in a card's width and in a run's row, and a
// message that arrives with a newline in it would break both. Empty in ⇒ nothing to say, which reads as absent.
const sanitizeFailure = (message: string): string | undefined => {
    const clean = message.replaceAll(/\s+/gu, " ").trim().slice(0, MAX_FAILURE_LENGTH);
    return clean === "" ? undefined : clean;
};
// The source ranking as a number, so promoteTitle's comparison is one `<=`. An entry written before it had a
// source reads as `derived`, i.e. as replaceable by anything better.
const TITLE_RANK: Record<AgentTitleSource, number> = { derived: 0, model: 1, plan: 2, user: 3 };
/* ONE BOUNDED LINE: control characters and runs of whitespace collapse to single spaces, and the whole thing is
 * cut to the caller's limit. The limit is a parameter rather than a constant because that is the only difference
 * between the two things scrubbed this way, a title read in a card's width, and a sentence read in a changelog
 * entry, and sharing the constant as well as the scrub is what truncated the notes. */
const sanitizeLine = (text: string, limit: number): string | undefined => {
    const clean = text
        .replaceAll(/[\p{Cc}\p{Cf}]+/gu, " ")
        .replaceAll(/\s+/gu, " ")
        .trim()
        .slice(0, limit);
    return clean === "" ? undefined : clean;
};

const sanitizeTitle = (prompt: string): string | undefined => sanitizeLine(prompt, MAX_TITLE_LENGTH);

/* The `Release-Note:` / `Breaking-Note:` sentences, on their own limit. Same one-line scrub, these are read as
 * one line in a changelog entry and in the update card, and emphatically NOT the title's ceiling: a title is
 * bounded by a CARD'S width, and sharing that 80 is what published four of the first five changelog entries
 * ending mid-word ("…versus addin").
 *
 * The ceiling itself belongs to the prompt that writes these (git/commit-message.ts), which asks for a sentence
 * that fits it. One number, so a note is never cut at a length nothing asked it to respect. */
const sanitizeNote = (note: string): string | undefined => sanitizeLine(note, MAX_NOTE_LENGTH);

/* There is no body scrub here any more, and there is no body to scrub: a drafted message is a subject and, for a
 * repo that keeps a changelog, its notes (git/commit-message.ts). The multi-line cleaner this replaces existed
 * only to keep a model's "- " fact lines readable, and those lines are neither asked for nor read back now. */

interface RuntimeState {
    running: boolean;
    // The cards the turn is parked on RIGHT NOW, by the requestId each was raised with, the fleet's attention
    // flags are read straight off it. Keyed rather than counted because a turn can be parked on more than one
    // card at a time (a question raised beside a parallel tool call's permission prompt), and each is released
    // by its own `resolved` frame. Emphatically NOT inferred from the frames that follow a park: frames keep
    // arriving while a turn waits, the pausing tool's own `tool_call` regularly trails its card, and reading
    // one of those as "the user answered" is what kept an agent asking a question out of the Attention lane.
    pauses: Map<string, "plan" | "question" | "permission" | "browser_help" | "terminal_help" | "service_offer" | "capability_offer">;
    errored: boolean;
    // The sentence the last error frame carried, flushed onto the entry at finish so the card can say why
    // rather than only that. Last one wins: a turn that fails twice died of the second.
    failure: string | undefined;
    /* THE USER ENDED THIS TURN and the abort has landed, it is on its way out but not out yet, in the two
     * flavours that end differently.
     *
     * It is runtime state rather than a status write because the turn is still LIVE: aborting the provider only
     * asks it to unwind, and the generator keeps the conversation (its worktree, its mutex) until it has walked
     * its own cleanup, seconds, on a turn with a big tool call in flight. That window used to be published as
     * plain `running`, so a stopped agent kept its spinner turning on every surface until it settled.
     *
     * Read twice: `summaryOf` publishes either flavour as `stopping` the moment it is set, and `finish` reads
     * WHICH to decide the terminal status, the one thing that tells a turn a person ended from one the daemon
     * died under, and a Stop from a card the user waved away.
     *
     * `dismissed` is the second flavour, and it ends where a clean turn does. Pressing Stop leaves half-written
     * work nobody asked to be finished, so its card waits in Attention to be picked up; dismissing a question
     * is the user saying they are done with this, nothing is owed, so the card settles in Finished and the
     * branch keeps whatever it wrote for whenever they come back to it. */
    stopping: "stopped" | "dismissed" | undefined;
    /* This turn was killed by something the daemon is already undoing, a rotated credential being re-minted, a
     * provider outage being waited out, and it is coming back on its own (turn-resume.ts).
     *
     * The one flag here that OUTLIVES its turn, and it has to: `finish` runs seconds before the resume does, and
     * what it writes is how the turn ended, which for this one is nothing, because it hasn't. Without it the
     * entry's resting `idle` went out in between and the board filed a card the daemon was about to re-run under
     * Finished, then pulled it back into Active a moment later. Cleared by whatever ends the wait: the resumed
     * turn's own `begin` (a fresh runtime state), or `abandonResume` when the re-mint fails and the failure has
     * to stand. */
    resuming: boolean;
    activity: { tool?: string; target?: string; todo?: string } | undefined;
    contextTokens: number | undefined;
    contextWindow: number | undefined;
    startedAt: number | undefined;
    lastAt: number | undefined;
    // This turn's prompt, held only until it can be filed under a session id. A FIRST turn has none at begin
    // (the SDK mints it and announces it on the `session` frame), and the fleet filter searches by what the
    // user wrote, so without this the prompt that just started an agent is the one prompt that agent can't
    // be found by, for as long as its turn runs. Cleared the moment it is filed.
    pendingPrompt: string | undefined;
    // Frame-carried fields flushed into the persisted entry at finish (one write per turn, not per frame).
    pendingSessionId: string | undefined;
    pendingCostUsd: number;
    pendingInputTokens: number;
    pendingOutputTokens: number;
    pendingToolUses: number;
    // The children this turn has started so far. Flushed like the rest, so a delegating turn costs one write at
    // its end rather than one per child, and the card still counts them as they are born (see summaryOf).
    pendingSubagents: number;
}

const freshRuntime = (): RuntimeState => ({
    running: false,
    pauses: new Map(),
    errored: false,
    failure: undefined,
    stopping: undefined,
    resuming: false,
    activity: undefined,
    contextTokens: undefined,
    contextWindow: undefined,
    startedAt: undefined,
    lastAt: undefined,
    pendingPrompt: undefined,
    pendingSessionId: undefined,
    pendingCostUsd: 0,
    pendingInputTokens: 0,
    pendingOutputTokens: 0,
    pendingToolUses: 0,
    pendingSubagents: 0,
});

// The registry input of any conversation turn, the fields begin() records onto the entry. Placement is kept
// here rather than inferred from the provider: isolated conversations own a branch; workspace conversations do
// not, while both share the same identity, status and transcript lifecycle.
export type AgentTurnIdentity = Pick<AgentTurn, "prompt"> &
    Partial<Pick<AgentTurn, "title" | "model" | "effort" | "thinking" | "fast" | "account" | "origin">> & {
        readonly conversationId: string;
        readonly isolated: boolean;
        readonly provider: NonNullable<AgentTurn["agent"]>;
        readonly harness: NonNullable<AgentTurn["harness"]>;
    };

export interface AgentsRegistry {
    readonly init: () => Promise<void>;
    readonly ids: () => string[];
    // The BOARD's roster, live agents only. Archived ones are excluded here (and from every broadcast) so a
    // sandbox with a thousand retired agents still streams a roster the size of the work in flight.
    readonly list: () => AgentSummary[];
    // The cold half, newest-archived first. Read on demand by the board's archive view; never broadcast.
    readonly listArchived: () => AgentSummary[];
    readonly get: (id: string) => AgentSummary | undefined;
    // The persisted entry, the worktree composition (per-repo bases) diff/land need.
    readonly entry: (id: string) => PersistedAgent | undefined;
    readonly running: (id: string) => boolean;
    /* IS THE AGENT ACTUALLY WRITING RIGHT NOW, the narrow half of `running`, for the one caller that can
     * safely act on a live turn.
     *
     * `running` is true for two states a user reads as opposites: an agent editing files, and an agent PARKED
     * on a question, a permission card or a plan, doing nothing at all until someone answers. Every guard used
     * the broad one, so "wait for the agent turn to finish" was also the answer to landing work from an agent
     * that was, in fact, waiting for the user, the turn it was told to wait for could not end until they
     * acted, and the thing they wanted to do was the acting.
     *
     * A park is the daemon's own definition of quiet: it already commits and rebases that very checkout when a
     * parked card settles (agents/sync.ts), so a land there is a write of a class this codebase already takes
     * unasked. `stopping` counts as quiet for the same reason, the provider has been aborted and is only
     * unwinding; nothing new is being written.
     *
     * It is NOT a proof of stillness, and no caller should treat it as one: a turn can be parked on one card
     * while a parallel tool call keeps running (see RuntimeState.pauses). It is the honest, cheap reading of
     * "is anyone at the keyboard", which is what the land guard needs, the mid-write case stays behind an
     * explicit user override rather than behind this. */
    readonly writing: (id: string) => boolean;
    // The SDK session ids of the turns in flight RIGHT NOW. The terminals list maps them to the `agent-*` tmux
    // sessions those turns run their Bash in (agent/agent-terminals.ts), so a working agent's terminal doesn't
    // read as finished while it thinks, between two commands its only window is the last one's dead pane, and
    // pane liveness alone would call that done. Known from the turn's first SDK frame (`session`), well before
    // its first command; an id the entry has not been flushed with yet falls back to the last turn's.
    readonly liveSessionIds: () => string[];
    // One conversation's CURRENT session id, including a running first turn's, the entry is only flushed with
    // it at finish, so `entry(id).sessionId` alone is undefined for exactly the turn most likely to be steered.
    readonly sessionIdOf: (id: string) => string | undefined;
    // Acquire the conversation's turn mutex and mark it running, creating/updating the entry. False ⇒ a turn
    // is already running for that conversation, or a rewind holds the same mutex (the caller surfaces the
    // coded busy error).
    readonly begin: (turn: AgentTurnIdentity, now: number) => Promise<boolean>;
    /* HOLD THE CONVERSATION AGAINST ITS OWN TURNS while something destructive happens to the workspace, the
     * rewind's restore, which overwrites the files a running turn is reading and editing.
     *
     * The lease exists because "check that nothing is running, then restore" is NOT the same thing and cannot
     * be made safe by adding checks: a turn admitted in the gap between the last check and the first `git
     * checkout` lands mid-restore, and both halves lose. What closes it is that this and `begin` are the same
     * mutex, taken in one synchronous step, the refusal and the claim happen with no await between them, so
     * there is no gap for a turn to arrive in. Both directions are covered: a turn cannot start under a lease,
     * and a lease cannot be taken under a turn.
     *
     * Undefined ⇒ refused because a turn is running; the caller surfaces that as busy, exactly like begin's
     * false. The lease is always released, including when `fn` throws, a conversation stuck unrunnable
     * because a restore failed would be a worse outcome than the failure itself. */
    readonly withRewindLease: <T>(conversationId: string, fn: () => Promise<T>) => Promise<T | undefined>;
    // Record the worktree composition on first creation (per-repo full base shas).
    readonly recordWorktree: (id: string, repos: readonly PersistedAgent["repos"][number][]) => Promise<void>;
    /* Record what the complexity judge made of the turn just planned (PersistedAgent.tier), which the NEXT
     * turn in this conversation reads as its `afterHardTurn` signal.
     *
     * Not part of `begin` because it is not a fact the caller has: the turn identity is what the client sent,
     * and this is what the daemon concluded a moment later. Not broadcast either, unlike the settings it sits
     * beside: no surface renders it, it is machinery for the next judgement, and putting it on the roster
     * frame would spend a full board broadcast per turn to publish something nobody draws. */
    readonly recordTier: (id: string, tier: "fast" | "standard") => Promise<void>;
    // Set the display title, subject to the source ranking (see AgentTitleSourceSchema): a rename always
    // lands, an automatic source only ever moves the title up. Deliberately does NOT bump updatedAt (a rename
    // must not fake-unread other browsers or reorder lanes) and takes no running guard, begin()/finish()
    // re-read the entry, so a mid-turn rename survives. Undefined ⇒ unknown id or a title that sanitizes to
    // nothing; a rejected promotion returns the entry's CURRENT summary rather than undefined.
    readonly setTitle: (id: string, title: string, source: AgentTitleSource) => Promise<AgentSummary | undefined>;
    /* Record what this agent's landed work DID, as a commit subject (PersistedAgent.landedSubject). No ranking
     * and no ladder, unlike a title, which is an identity several sources compete over, this is one sentence
     * about one diff, and the newest land is by definition the one describing the most of the claim.
     *
     * BROADCAST, like the drafting flag it answers. The Changes panel reads this off the roster frame and only
     * falls back to the review's copy for an agent the roster has dropped, so the sentence reaches the commit
     * box on the push that already exists, rather than waiting for something to make the panel re-read a
     * workspace-wide scan. The caller still publishes that scan afterwards (agents/landed-subject.ts), because
     * the review's copy is what an ARCHIVED agent's chip is read through. Leaves updatedAt alone for the same
     * reason setTitle does, the land already stamped the activity this describes. */
    readonly setLandedSubject: (id: string, draft: { subject: string; note?: string; breaking?: string }) => Promise<void>;
    /* Publish the full account of the sentence above being drafted, which models were asked, how each went,
     * and how it ended, as it changes. The wait is the only part of a landing a user ever experiences, so it
     * is the one part that owes them a report rather than a spinner. Runtime and broadcast rather than
     * persisted and published; the implementation says why. `undefined` withdraws it. Unknown id ⇒ no-op. */
    readonly setLandedMessageDraft: (id: string, draft: LandedMessageDraft | undefined) => void;
    // Stamp the read marker the cards' unread badge is measured against. Like setTitle it leaves updatedAt
    // alone (reading is not activity) and needs no running guard. Undefined ⇒ unknown id.
    readonly markSeen: (id: string, now: number) => Promise<AgentSummary | undefined>;
    // Set/clear the per-agent autoLand override (null ⇒ back to "inherit the sandbox setting"). Like setTitle
    // it leaves updatedAt alone (configuring is not activity) and needs no running guard, the value is read
    // at turn COMPLETION, so flipping it mid-turn is exactly "hold THIS turn's work". Undefined ⇒ unknown id.
    readonly setAutoLand: (id: string, autoLand: boolean | null) => Promise<AgentSummary | undefined>;
    // Set/clear THIS conversation's outage-resume override (null ⇒ back to "inherit the sandbox setting").
    // Same grammar as setAutoLand and legal at the same moments, the value is read by the resume pass AFTER
    // the turn has already died, so arming a conversation whose turn is still unwinding is the ordinary case
    // rather than an edge one. Undefined ⇒ unknown id.
    readonly setResumeAfterOutage: (id: string, resumeAfterOutage: boolean | null) => Promise<AgentSummary | undefined>;
    // Stamp a collaborator's ask for this work to be landed (AgentSummarySchema.landRequested). Like setTitle
    // it leaves updatedAt alone (asking is not the agent's activity) and needs no running guard, the ask is
    // about whatever the branch holds when a maintainer answers it. Re-asking re-stamps (latest asker wins;
    // the board shows one ask, not a queue). Cleared by the land or discard that answers it. Undefined ⇒
    // unknown id.
    readonly requestLand: (id: string, by: { email: string; name?: string }, at: number) => Promise<AgentSummary | undefined>;
    /* Forget which provider session this conversation was resuming, what a rewind does after restoring the
     * files, so the next turn opens a fresh thread instead of resuming one whose context describes edits that
     * are no longer on disk. That mismatch is the whole reason rewind drops messages rather than only
     * restoring: a provider still holding the dropped turns would keep reasoning from them.
     *
     * Only the pointer goes. The provider's own store keeps the old session, and the daemon's transcript record
     * is authoritative for reading the conversation back, so nothing the user can see is lost by this. */
    readonly clearSession: (id: string) => Promise<void>;
    // "Mark all read", one stamp across the whole fleet, so a board full of badges has a single escape hatch.
    readonly markAllSeen: (now: number) => Promise<void>;
    // Persist a land's outcome: the advanced per-repo landedTips (partial lands included, conflicted repos
    // keep theirs), the refreshed cumulative diffstat, and the conflict report behind the `conflict` status.
    // Takes the whole outcome rather than its pieces so the report cannot drift from the tips it belongs to,
    // an outcome with no conflicts CLEARS the stored one, which is what makes a resolved conflict resolve.
    readonly recordLanded: (id: string, outcome: LandOutcome) => Promise<void>;
    /* THE LANDING IS ABSORBED, history has taken every path it put in the tree, and the attribution scan that
     * observed it says so once, here, instead of re-deriving it from git on every scan forever (see the
     * `absorbed` field's note in agents-store.ts). `size` is the landing's applied-path count, kept because the
     * presence reading is a fraction and a settled repo still counts in the denominator.
     *
     * The shas are the GUARD, not context: a newer land advances both, and a mark computed against the old pair
     * must not stamp the new landing, so a row whose landedHead/landedTip no longer match is left alone. No
     * broadcast: nothing user-visible moves (an absorbed landing reads exactly as it did, fully present, no
     * chips), this only stops the re-derivation. Unknown id ⇒ no-op. */
    readonly markLandingAbsorbed: (id: string, repo: string, landedHead: string, landedTip: string, size: number) => Promise<void>;
    // Fold one turn frame into runtime state; broadcasts only on card-visible changes.
    readonly observe: (id: string, event: AgentEvent) => void;
    /* THE USER ENDED THIS TURN and the abort has landed, recorded NOW, ahead of the unwind.
     *
     * The whole point is the gap it closes. /agent/stop aborts the provider and then waits for the generator to
     * walk its cleanup, and until finish() runs the roster still reads `running`: the press had no visible
     * result anywhere, so every surface kept a spinner turning on a turn that was already dead. Called by the
     * routes rather than inferred from a frame, because an abort's defining feature is that no frame follows
     * it. A no-op when nothing is running, an ending that raced the turn's own changes nothing.
     *
     * The two endings differ in what the card does WHILE it unwinds, as well as where it lands. A Stop is
     * published immediately, because the press is news and the card has to stop spinning. A dismissal is not:
     * the card is already sitting in Attention where the user just acted on it, the unwind is over in a blink
     * (the turn is parked inside the card being dismissed, so there is nothing in flight to unwind), and
     * publishing the in-between would spend a lane change announcing that the agent went back to work for the
     * length of that blink, which is the thing being fixed. It holds its place, and finish() moves it once. */
    readonly stopping: (id: string, ending: "stopped" | "dismissed") => void;
    // End of turn (aborted included): flush pending usage/session into the entry, release the mutex, and write
    // how the turn ENDED, error on an observed error frame, `stopped` when the user cut it short, else idle.
    // Deliberately says nothing about where the work now stands: that is standing.ts's question, re-derived
    // here before the roster goes out.
    readonly finish: (id: string, now: number) => Promise<void>;
    /* A RESUME IS COMING, the way INTO `resuming` for an ending the observer cannot see. The error-frame path
     * covers a turn the daemon is repairing (a re-mint, an outage backoff); this covers a settlement that IS a
     * beginning: a restored card's answer ends its placeholder turn and starts the real resumed one seconds
     * later (turn-resume.ts), and without this flag the entry's resting `idle` goes out in between, the board
     * files the card under Finished for the blink before it climbs back into Active. Set BEFORE the placeholder
     * settles; cleared by what always clears it, the resumed turn's own begin, or abandonResume when the
     * resume never comes. */
    readonly markResuming: (id: string) => void;
    /* THE RESUME IS NOT COMING, the other way out of `resuming`, and the one nobody sees happen: the credential
     * could not be re-minted, or an outage's stranded turn went stale waiting for a setting that stayed off
     * (turn-resume.ts). Writes the failure the card was holding open for: this is exactly the condition where a
     * person really is needed, so it settles into Attention rather than back into the resting `idle` the
     * interrupted turn left behind.
     *
     * A no-op while a turn is running: the resume lost a race to the user's own send, and that turn's begin has
     * already cleared the wait and owns the entry this would otherwise write over.
     *
     * `reason` is what the card then says. The two callers are the only ones who know which of the two endings
     * this is, and a card that has been promising to come back for an hour owes the reader more than the word
     * "error" when it stops.
     *
     * Answers whether the WAIT IS OVER, which is not the same as whether anything was written: a card with no
     * wait left to end (a fresh turn already cleared it, the entry is gone) is settled and answers true. Only a
     * turn still unwinding answers false, the caller has to come back, because the failing turn's own finish is
     * seconds away and will re-open the very spinner this was called to close. Dropping that call is how a
     * refusal recorded one tick before its turn settled left a card spinning with nothing left to end it. */
    readonly abandonResume: (id: string, now: number, reason: string) => Promise<boolean>;
    /* Re-derive every live agent's land standing and publish the roster if any of them moved. Called wherever
     * the answer can have changed without this daemon doing it, most of all the roster READ, which is what
     * heals a card after work reached the main tree by a road the daemon never saw (a hand-merge in a
     * terminal). Cheap and idempotent: a pass whose shas are unchanged spends one rev-parse per repo and
     * broadcasts nothing. */
    readonly refreshStandings: () => Promise<void>;
    // Stamp/clear the archive marker. Both take the ids that ALREADY had their checkout retired (or restored)
    //, the registry owns the marker, agents/archive.ts owns the git side and the order between them.
    readonly setArchived: (ids: readonly string[], now: number) => Promise<void>;
    readonly clearArchived: (ids: readonly string[]) => Promise<void>;
    // Forget agents outright, `discard`, the archive's purge, and the boot sweep's vanished worktrees. Takes a
    // SET because every caller but discard has one, and a per-id call would spend a persist and a roster
    // broadcast on each agent of a batch.
    readonly remove: (ids: readonly string[]) => Promise<void>;
    // Immediate snapshot on subscribe, so a fresh /events connection paints the fleet without waiting. The
    // listener also receives the revision the snapshot was taken at (see `revision`).
    readonly subscribe: (listener: (agents: AgentSummary[], rev: number) => void) => () => void;
    // A counter bumped on every broadcast, i.e. on every registry change. The roster is published as full
    // snapshots, and the browser reconciles three sources of it, this stream, its own GET /agents, and its
    // optimistic writes, so each snapshot has to say WHEN it was true. Monotonic within a daemon process;
    // it restarts at 0 on reboot, which is safe because the stream reconnects and the browser adopts the first
    // roster it sees on a fresh connection.
    readonly revision: () => number;
}

export const createAgentsRegistry = (store: AgentsStore, standings: LandStandings, presences: LandedPresences): AgentsRegistry => {
    let entries: PersistedAgent[] = [];
    const runtime = new Map<string, RuntimeState>();
    /* The other half of the turn mutex, conversations a rewind is currently restoring. Deliberately NOT a flag
     * on RuntimeState: that map is rebuilt per turn (freshRuntime in begin), and a lease that a turn's own
     * bookkeeping could clear is not a lease. Empty in the overwhelmingly common case, so the extra read in
     * begin costs a Set miss. */
    const rewinding = new Set<string>();
    /* The live account of each agent's commit message being drafted (agents/landed-subject.ts), which models
     * have been asked, how each went, and how it ended. A Map beside `rewinding` rather than a flag on
     * RuntimeState, and for the same reason: the drafting starts AFTER the turn that landed the work has ended,
     * so a per-turn map is either stale or already replaced by the next turn's fresh state by the time this
     * would be cleared. A finished report stays until the next land replaces it, how the LAST draft went is
     * exactly what a user staring at an unfilled commit box needs to read. */
    const messageDrafts = new Map<string, LandedMessageDraft>();
    const listeners = new Set<(agents: AgentSummary[], rev: number) => void>();
    // Bumped by broadcast(), so it advances exactly once per published change, see `revision` on the interface.
    let revision = 0;

    const runtimeOf = (id: string): RuntimeState => {
        const existing = runtime.get(id);
        if (existing !== undefined) {
            return existing;
        }
        const fresh = freshRuntime();
        runtime.set(id, fresh);
        return fresh;
    };

    const summaryOf = (entry: PersistedAgent): AgentSummary => {
        const state = runtime.get(entry.id);
        // A turn holding an unanswered card is AWAITING, however much else it has in flight beside it.
        const parked = state === undefined ? [] : [...state.pauses.values()];
        /* THE STATUS PROJECTION, in precedence order: the live turn, then the one that is coming BACK, then how
         * the last one ENDED, then where the work stands. The `idle` rung is why it is the only persisted value
         * that yields, it is the one that means "the turn ended cleanly", i.e. that the entry has nothing more
         * to say and the question passes to git. `error` and `interrupted` outrank precisely because nothing
         * else remembers them: a turn that died is not made fine by a branch that happens to be empty.
         *
         * Within the live rung, an ending the user chose outranks a park: a turn aborted while holding a
         * question is on its way out, and publishing it as `awaiting` would keep asking the user to answer a
         * card the abort has already settled.
         *
         * An armed resume outranks every settled reading below it for the same reason `stopping` outranks
         * `running`: the entry describes a turn that has stopped, and this one has stopped without ending. */
        const landing = entry.branch === undefined ? "idle" : standings.of(entry.id);
        const status =
            state?.running === true
                ? state.stopping !== undefined
                    ? "stopping"
                    : parked.length > 0
                      ? "awaiting"
                      : "running"
                : state?.resuming === true
                  ? "resuming"
                  : entry.status === "idle"
                    ? landing
                    : entry.status;
        const base = (entry.repos.find((repo) => repo.repo === "root") ?? entry.repos[0])?.base.slice(0, 7);
        // Live totals: persisted totals plus the running turn's not-yet-flushed usage.
        const costUsd = entry.costUsd + (state?.pendingCostUsd ?? 0);
        const inputTokens = entry.inputTokens + (state?.pendingInputTokens ?? 0);
        const outputTokens = entry.outputTokens + (state?.pendingOutputTokens ?? 0);
        /* THE CHILDREN, from the two places that each know half of it. What is RUNNING is a fact about right now
         * and only the live registry has it; how many this agent has EVER started is a fact about the work, and
         * only the entry keeps it, the live registry sweeps a finished child after five minutes and remembers
         * nothing across a restart, which is what used to take the count off the card while the agent that
         * earned it was still on the board. */
        const subagents = { running: subagentCountsOf(entry.id).running, total: (entry.subagents ?? 0) + (state?.pendingSubagents ?? 0) };
        const loop = loopProjection.of(entry.id);
        const workflow = workflowProjection.of(entry.id);
        // Read for branch-backed agents only, for the same reason a standing is: a workspace conversation
        // reaches the main tree by typing in it, never through a land, so it has no landing to be missing.
        const landedPresence = entry.branch === undefined ? undefined : presences.of(entry.id);
        const landedMessage = landedMessageOf(entry);
        return {
            id: entry.id,
            status,
            provider: entry.provider,
            harness: entry.harness,
            ...(entry.branch !== undefined ? { branch: entry.branch } : {}),
            updatedAt: Math.max(entry.updatedAt, state?.lastAt ?? 0),
            attention: {
                plan: parked.includes("plan"),
                question: parked.includes("question"),
                permission: parked.includes("permission"),
                service: parked.includes("service_offer"),
                capability: parked.includes("capability_offer"),
                // Reads the DERIVED verdict, not the stored report. Deriving this from a cached status was the
                // shape of the original bug in miniature: a faithful projection over a stale input is stale.
                conflict: status === "conflict",
            },
            ...(entry.sessionId !== undefined ? { sessionId: entry.sessionId } : {}),
            // Only while the card still READS as failed. A branch whose standing has moved on (the work landed
            // by another road, the delta went away) is answered by `landing` above, and an explanation left
            // under it would be describing a turn the board no longer shows as the last word.
            ...(entry.failure !== undefined && status === "error" ? { failure: entry.failure } : {}),
            ...(entry.origin !== undefined ? { origin: entry.origin } : {}),
            ...(entry.forkedFrom !== undefined ? { forkedFrom: entry.forkedFrom } : {}),
            ...(entry.title !== undefined ? { title: entry.title } : {}),
            ...(entry.model !== undefined ? { model: entry.model } : {}),
            ...(entry.effort !== undefined ? { effort: entry.effort } : {}),
            ...(entry.thinking !== undefined ? { thinking: entry.thinking } : {}),
            ...(entry.fast !== undefined ? { fast: entry.fast } : {}),
            ...(entry.account !== undefined ? { account: entry.account } : {}),
            ...(entry.autoLand !== undefined ? { autoLand: entry.autoLand } : {}),
            ...(entry.resumeAfterOutage !== undefined ? { resumeAfterOutage: entry.resumeAfterOutage } : {}),
            ...(entry.landRequested !== undefined ? { landRequested: entry.landRequested } : {}),
            ...(base !== undefined ? { base } : {}),
            ...(costUsd > 0 ? { costUsd } : {}),
            ...(inputTokens > 0 ? { inputTokens } : {}),
            ...(outputTokens > 0 ? { outputTokens } : {}),
            ...(state?.contextTokens !== undefined ? { contextTokens: state.contextTokens } : {}),
            ...(state?.contextWindow !== undefined ? { contextWindow: state.contextWindow } : {}),
            ...(state?.activity !== undefined ? { activity: state.activity } : {}),
            // The full account of this landing's commit message being drafted, live while a model is writing,
            // kept after it ends until the next land replaces it. See setLandedMessageDraft.
            ...(messageDrafts.has(entry.id) ? { landedMessageDraft: messageDrafts.get(entry.id) } : {}),
            /* …and the sentence itself the moment it exists. The flag above is a promise, and this is the frame
             * that keeps it: the Changes panel's "From" chip files this into the commit box, and a landing's
             * message is the one thing about that panel which arrives SECONDS after everything else it draws.
             * Sending it here costs a string on a frame that was going out anyway; the alternative was the
             * panel re-reading the whole review to collect it (see LandedMessage). */
            ...(landedMessage === undefined ? {} : { landedMessage }),
            ...(state?.running === true && state.startedAt !== undefined ? { startedAt: state.startedAt } : {}),
            ...(entry.seenAt !== undefined ? { seenAt: entry.seenAt } : {}),
            ...(entry.archivedAt !== undefined ? { archivedAt: entry.archivedAt } : {}),
            ...(entry.turns !== undefined ? { turns: entry.turns } : {}),
            // Live count: the running turn's tool calls show on the card as they happen.
            ...((entry.toolUses ?? 0) + (state?.pendingToolUses ?? 0) > 0 ? { toolUses: (entry.toolUses ?? 0) + (state?.pendingToolUses ?? 0) } : {}),
            // Absent for the agents that never delegated, which is most of them, so the chip appears on content
            // rather than reading "0" down the board.
            ...(subagents.total > 0 ? { subagents } : {}),
            ...(entry.diffFiles !== undefined
                ? { diff: { files: entry.diffFiles, insertions: entry.diffInsertions ?? 0, deletions: entry.diffDeletions ?? 0 } }
                : {}),
            // Present ONLY when some of what this agent landed is no longer in the main tree, the user
            // discarded it, or took it back out by hand. Its absence is the steady state and says nothing, so
            // the card spends a line on this exactly when there is something to say (landed-presence.ts).
            ...(landedPresence !== undefined ? { landedPresence } : {}),
            // The loop driving this conversation, read off the pump's own live state for the same reason the
            // subagent counts are read off theirs, one projection, no second copy to go stale.
            ...(loop !== undefined ? { loop } : {}),
            ...(workflow !== undefined ? { workflow } : {}),
        };
    };

    const list = (): AgentSummary[] => entries.filter((entry) => entry.archivedAt === undefined).map(summaryOf);

    // One bump per published change, BEFORE the fan-out, so every listener on this broadcast sees the same
    // revision and a mutation route reading revision() afterwards reports the one its own change produced.
    const broadcast = (): void => {
        const agents = list();
        revision += 1;
        for (const listener of listeners) {
            listener(agents, revision);
        }
    };

    /* Both projections move BETWEEN turns, which is the card-visible change no frame announces: the last
     * iteration's finish() has already published, and only then does the pump decide the goal is met; a step
     * settles, and only then does the step after it name itself. Without this the card would hold
     * `running · iteration 12/12` until something unrelated moved the fleet, at precisely the moment someone is
     * watching it. Never unsubscribed: the registry outlives the process. */
    loopProjection.onChange(broadcast);
    workflowProjection.onChange(broadcast);

    /* Only the live, branch-backed roster is probed, see LandStandings.refresh on why an archived agent keeps
     * its last answer, and why a workspace conversation has no standing to probe at all.
     *
     * Two readings over one roster, because a land has two halves and only one of them is a sha: where the
     * branch stands against the main line (standing.ts), and whether what already landed is still in the tree
     * (landed-presence.ts). Both, or the board answers the discard case with a confident stale yes. Run
     * together rather than chained so neither waits on the other's git, and `moved` is the OR: either half
     * changing is a card the user is looking at changing. */
    const reprobe = async (): Promise<boolean> => {
        const live = entries.filter(isIsolated).filter((entry) => entry.archivedAt === undefined);
        const [standingMoved, presenceMoved] = await Promise.all([standings.refresh(live), presences.refresh(live)]);
        return standingMoved || presenceMoved;
    };

    // Chained, not fire-and-forget: `entries` is REPLACED (not mutated) by every write path, so two overlapping
    // persists would each serialize the array they captured, and the one that finishes last would write back a
    // snapshot missing the other's change. Archiving several agents at once is exactly that shape. Chaining also
    // means the closure reads `entries` at EXECUTION time, so a queued write always persists the latest state.
    // (`.then(save, save)` so one rejected write doesn't poison the queue, the push-store idiom.)
    let writes: Promise<unknown> = Promise.resolve();
    /* Move a title UP the source ranking, or leave it exactly as it is. The single place the ranking is
     * applied, so the rename route and the frame path cannot disagree about who may rename what.
     *
     * A rename always lands, including the second one, which an ordinary rank comparison would reject as a
     * sideways move. Everything else has to strictly outrank what is already there: a model name or a plan
     * heading may replace the prompt the title was derived from, a plan may replace a model name but never the
     * reverse, nothing may replace a rename, and a REPLAN may not rename the job the first plan already named.
     * The strictness is also what makes the naming pass self-limiting: once one model name lands, the next
     * turn's would be a sideways move and is never even attempted. Returns whether the entry changed, so
     * callers persist and broadcast only when something actually did. */
    const promoteTitle = (id: string, title: string | undefined, source: AgentTitleSource): boolean => {
        const entry = entryOf(id);
        const clean = title === undefined ? undefined : sanitizeTitle(title);
        if (entry === undefined || clean === undefined) {
            return false;
        }
        // A provider failure sentence ("You've hit your session limit · resets …", "Failed to authenticate.
        // API Error: 401 …") is never a NAME, however it got here, a naming pass whose own model call hit
        // the condition, a plan heading quoting the failure. Only a rename may say it, because a rename is the
        // user's to waste. And a STORED title that is one was stolen exactly that way: it forfeits its
        // source's rank, so the next honest promotion replaces it instead of bouncing off the sideways-move
        // rule below. The family, never a member of it, see failure-sentences.ts on what guarding one cost.
        if (source !== "user" && isFailureSentence(clean)) {
            return false;
        }
        const currentRank = entry.title !== undefined && isFailureSentence(entry.title) ? -1 : TITLE_RANK[entry.titleSource ?? "derived"];
        if (source !== "user" && TITLE_RANK[source] <= currentRank) {
            return false;
        }
        if (entry.title === clean && entry.titleSource === source) {
            return false;
        }
        replace({ ...entry, title: clean, titleSource: source });
        return true;
    };

    const persist = (): Promise<void> => {
        const next = writes.then(
            () => store.save(entries),
            () => store.save(entries),
        );
        writes = next.catch(() => undefined);
        return next;
    };

    const entryOf = (id: string): PersistedAgent | undefined => entries.find((entry) => entry.id === id);

    const replace = (next: PersistedAgent): void => {
        entries = [...entries.filter((entry) => entry.id !== next.id), next];
    };

    return {
        init: async () => {
            entries = await store.load();
            /* The roster goes out the moment it is loaded, an /events stream that connected during boot is
             * already holding an empty fleet and this frame is what fills it. Standings are probed BEHIND the
             * broadcast, not before it: a reboot's verdict cache is empty, so the probe is a git spawn per live
             * agent, and awaiting it here held the whole boot (and with it every route) behind minutes of git
             * on a machine that had just crashed. Unprobed agents read `idle` for the seconds until the
             * refresh's own broadcast corrects them. */
            broadcast();
            void reprobe()
                .then((moved) => {
                    if (moved) {
                        broadcast();
                    }
                })
                .catch(() => undefined);
        },
        refreshStandings: async () => {
            if (await reprobe()) {
                broadcast();
            }
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
        running: (id) => runtime.get(id)?.running === true,
        writing: (id) => {
            const state = runtime.get(id);
            return state?.running === true && state.stopping === undefined && state.pauses.size === 0;
        },
        sessionIdOf: (id) => runtime.get(id)?.pendingSessionId ?? entryOf(id)?.sessionId,
        liveSessionIds: () =>
            [...runtime]
                .filter(([, state]) => state.running)
                .flatMap(([id, state]) => {
                    const sessionId = state.pendingSessionId ?? entryOf(id)?.sessionId;
                    return sessionId === undefined ? [] : [sessionId];
                }),
        withRewindLease: async (conversationId, fn) => {
            /* The claim. `running` is read and `rewinding` is written with NOTHING between them, no await, no
             * call that could yield, so from the event loop's point of view this is one step, and `begin`
             * (whose own check-to-claim path is likewise unbroken) can only ever observe it as taken or not
             * taken. Introducing an await here, however harmless it looks, is what reopens the hole this
             * function exists to close. */
            if (runtime.get(conversationId)?.running === true) {
                return undefined;
            }
            rewinding.add(conversationId);
            try {
                return await fn();
            } finally {
                rewinding.delete(conversationId);
            }
        },
        begin: async (turn, now) => {
            // Both arms of the mutex, read together. Everything from here to the runtime.set below is
            // synchronous, which is what makes this a claim rather than a hopeful check, see withRewindLease.
            if (runtime.get(turn.conversationId)?.running === true || rewinding.has(turn.conversationId)) {
                return false;
            }
            const existing = entryOf(turn.conversationId);
            // Placement is latched with the identity. A stale tab may send its old `isolated` posture, but an
            // existing workspace conversation stays in /work and an existing worktree conversation keeps its
            // branch. Only a conversation the registry has never seen takes the request's placement choice.
            const isolated = existing === undefined ? turn.isolated : existing.branch !== undefined;
            // An authored title, the browser's own derivation, or a rename that landed mid-turn, is taken as
            // written. A turn that arrived WITHOUT one (an automation, a Discord mention, a webchat visitor)
            // is named by the same rule the browser runs, so one prompt opens under one name wherever it
            // entered; sanitizeTitle then does what it does for any title, including turning empty into none.
            const title =
                existing?.title ?? (turn.title !== undefined ? sanitizeTitle(turn.title) : undefined) ?? sanitizeTitle(deriveTitle(turn.prompt));
            // The turn's settings, each falling back to the last turn's: a caller that states none (an
            // automation, a Discord mention) keeps describing the agent by what it has actually been running.
            const model = turn.model ?? existing?.model;
            const effort = turn.effort ?? existing?.effort;
            const thinking = turn.thinking ?? existing?.thinking;
            const fast = turn.fast ?? existing?.fast;
            const account = turn.account ?? existing?.account;
            // Provenance belongs to the turn that CREATED the conversation and is never re-derived: the user's
            // own follow-up turns in a surfaced agent's tab carry no origin, and must not strip the Discord
            // mention that opened it off the card.
            const origin = existing?.origin ?? turn.origin;
            replace({
                id: turn.conversationId,
                ...(isolated ? { branch: existing?.branch ?? `agent/${turn.conversationId}` } : {}),
                provider: turn.provider,
                harness: turn.harness,
                repos: existing?.repos ?? [],
                // The state this turn should be found in if it never reports back, see the store's note on
                // PersistedAgentStatusSchema. finish() overwrites it moments later in the ordinary case (it
                // runs in a `finally`, so an abort and a failure both reach it); what it cannot overwrite is
                // the daemon being killed under the turn, and THAT is what this value is for.
                status: "interrupted",
                costUsd: existing?.costUsd ?? 0,
                inputTokens: existing?.inputTokens ?? 0,
                outputTokens: existing?.outputTokens ?? 0,
                createdAt: existing?.createdAt ?? now,
                updatedAt: now,
                // The source rides with the title: an entry rebuilt for a follow-up turn keeps whatever
                // promoted it (a rename stays a rename), and a fresh one starts at the bottom of the ranking
                // so the turn's first plan can name it properly.
                ...(title !== undefined ? { title, titleSource: existing?.titleSource ?? "derived" } : {}),
                ...(model !== undefined ? { model } : {}),
                ...(effort !== undefined ? { effort } : {}),
                ...(thinking !== undefined ? { thinking } : {}),
                ...(fast !== undefined ? { fast } : {}),
                // Carried, never taken from the turn: the client has no opinion about this and the daemon's own
                // verdict for THIS turn is not in yet (it is written by recordTier, once the turn is planned).
                // Listed here because `replace` is an explicit field list, so an omission is a deletion, and
                // dropping it would reset every conversation's history of itself on every single turn.
                ...(existing?.tier !== undefined ? { tier: existing.tier } : {}),
                ...(account !== undefined ? { account } : {}),
                ...(origin !== undefined ? { origin } : {}),
                ...(existing?.sessionId !== undefined ? { sessionId: existing.sessionId } : {}),
                // The read marker survives the rebuild too, a new turn makes the agent unread again (updatedAt
                // now outruns it), but WHEN it was last opened is what tells "New" from "Updated".
                ...(existing?.seenAt !== undefined ? { seenAt: existing.seenAt } : {}),
                // `archivedAt` is deliberately NOT carried across: sending an archived agent a message is how
                // you un-archive it, so the entry rebuilt here is a live one again. The checkout follows
                // immediately, the ensure() right after this re-attaches it from the surviving branch.
                // The land posture survives the rebuild too: "hold this agent's work" is a standing choice
                // about the conversation, and the next turn is exactly when it matters.
                ...(existing?.autoLand !== undefined ? { autoLand: existing.autoLand } : {}),
                // And so does the outage posture, for the reason the land posture survives: "keep finishing
                // THIS work when the provider drops it" is a standing choice about the conversation, and the
                // next turn, which is exactly what this rebuild is, is when it matters.
                ...(existing?.resumeAfterOutage !== undefined ? { resumeAfterOutage: existing.resumeAfterOutage } : {}),
                /* WHAT THE LANDED WORK IS CALLED SURVIVES THE REBUILD, because it describes a CLAIM on the main
                 * tree and not the turn that made it. The claim is what `repos` above carries across, and it
                 * outlives any number of follow-up turns, a commit is what retires it.
                 *
                 * Dropping these was silent and total: land, then send one more message, and the drafted commit
                 * message and its release note were gone from the entry the "From" chip reads. A turn that lands
                 * again redraws them, which is why this only ever bit the turns that landed NOTHING, a question
                 * answered, a check that found nothing to change, and those are the turns most likely to be
                 * followed by the commit that needed the sentence. */
                ...(existing?.landedSubject !== undefined ? { landedSubject: existing.landedSubject } : {}),
                ...(existing?.landedNote !== undefined ? { landedNote: existing.landedNote } : {}),
                ...(existing?.landedBreaking !== undefined ? { landedBreaking: existing.landedBreaking } : {}),
                // Lifetime counters + diffstat survive the per-turn entry rebuild.
                ...(existing?.turns !== undefined ? { turns: existing.turns } : {}),
                ...(existing?.toolUses !== undefined ? { toolUses: existing.toolUses } : {}),
                ...(existing?.subagents !== undefined ? { subagents: existing.subagents } : {}),
                ...(existing?.diffFiles !== undefined ? { diffFiles: existing.diffFiles } : {}),
                ...(existing?.diffInsertions !== undefined ? { diffInsertions: existing.diffInsertions } : {}),
                ...(existing?.diffDeletions !== undefined ? { diffDeletions: existing.diffDeletions } : {}),
            });
            const state = freshRuntime();
            state.running = true;
            state.startedAt = now;
            state.lastAt = now;
            // File this turn's prompt against the session the fleet filter will search, right now if the
            // conversation already has one, else on the `session` frame that mints it (see observe). The
            // transcript gets the same prompt moments later, but "moments" is a whole turn long when the turn
            // is a twenty-minute one, and the prompt just sent is the likeliest thing to be searched for.
            if (existing?.sessionId !== undefined) {
                recordPrompt(existing.sessionId, turn.prompt);
            } else {
                state.pendingPrompt = turn.prompt;
            }
            runtime.set(turn.conversationId, state);
            recordConversationPrompt(turn.conversationId, turn.prompt);
            await persist();
            broadcast();
            return true;
        },
        recordWorktree: async (id, repos) => {
            const entry = entryOf(id);
            if (entry === undefined) {
                return;
            }
            replace({ ...entry, repos: [...repos] });
            await persist();
        },
        recordTier: async (id, tier) => {
            const entry = entryOf(id);
            // A conversation whose entry has gone (archived, purged) mid-turn is not an error worth surfacing:
            // there is no next turn for the value to be read by.
            if (entry === undefined || entry.tier === tier) {
                return;
            }
            replace({ ...entry, tier });
            await persist();
        },
        setTitle: async (id, title, source) => {
            if (entryOf(id) === undefined || sanitizeTitle(title) === undefined) {
                return undefined;
            }
            if (promoteTitle(id, title, source)) {
                await persist();
                broadcast();
            }
            const entry = entryOf(id);
            return entry === undefined ? undefined : summaryOf(entry);
        },
        setLandedSubject: async (id, draft) => {
            const entry = entryOf(id);
            const clean = sanitizeTitle(draft.subject);
            // Sanitized through the title cleaner, which is the same job: one bounded line, no control
            // characters. An empty draft writes nothing rather than clearing what the last land said.
            if (entry === undefined || clean === undefined) {
                return;
            }
            /* Both notes go through the note cleaner and are both CLEARED when this land wrote none. They
             * describe the claim as it NOW stands, so a second land that turned out to need neither must not
             * leave the previous land's sentences standing over a subject that has since been rewritten. */
            const cleanNote = draft.note === undefined ? undefined : sanitizeNote(draft.note);
            const cleanBreaking = draft.breaking === undefined ? undefined : sanitizeNote(draft.breaking);
            replace({
                ...entry,
                landedSubject: clean,
                ...(cleanNote === undefined ? { landedNote: undefined } : { landedNote: cleanNote }),
                ...(cleanBreaking === undefined ? { landedBreaking: undefined } : { landedBreaking: cleanBreaking }),
            });
            broadcast();
            await persist();
        },
        /* THE DRAFT'S OWN STORY, RE-TOLD WHOLE ON EVERY BEAT, set by the drafter and nowhere else
         * (agents/landed-subject.ts). Snapshot-not-diff like every roster fact: the caller hands the complete
         * report as it now stands, so a browser that missed a frame is merely late, never wrong.
         *
         * Runtime, never persisted, and that is the point rather than a shortcut: a daemon that died mid-draft
         * did not leave a draft running, so a report restored from disk would show a walk nothing will ever
         * finish. A restart forgetting it is the correct answer.
         *
         * Broadcast, because a report nobody is told about is a report nobody can draw. This is the cheap frame
         * the roster already sends, not the review, see the note at the publish site for which of the two
         * carries what. `undefined` withdraws it (a land that turned out to have nothing to describe). */
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
        markSeen: async (id, now) => {
            const entry = entryOf(id);
            if (entry === undefined) {
                return undefined;
            }
            const next = { ...entry, seenAt: now };
            replace(next);
            await persist();
            // Broadcast so the badge clears on EVERY connected surface at once, the phone that opened it and
            // the desktop rail counting it are looking at the same fleet.
            broadcast();
            return summaryOf(next);
        },
        markAllSeen: async (now) => {
            entries = entries.map((entry) => ({ ...entry, seenAt: now }));
            await persist();
            broadcast();
        },
        setAutoLand: async (id, autoLand) => {
            const entry = entryOf(id);
            if (entry === undefined) {
                return undefined;
            }
            // null strips the key entirely rather than storing it: absent IS the "inherit" state, and it is
            // what keeps the agent following the sandbox-wide toggle wherever it is pointed next.
            const { autoLand: _cleared, ...carried } = entry;
            const next = { ...carried, ...(autoLand !== null ? { autoLand } : {}) };
            replace(next);
            await persist();
            broadcast();
            return summaryOf(next);
        },
        setResumeAfterOutage: async (id, resumeAfterOutage) => {
            const entry = entryOf(id);
            if (entry === undefined) {
                return undefined;
            }
            // null strips the key, exactly as setAutoLand does: absent IS "inherit", and it is the only state
            // that keeps this conversation following the sandbox default wherever it is pointed next.
            const { resumeAfterOutage: _cleared, ...carried } = entry;
            const next = { ...carried, ...(resumeAfterOutage !== null ? { resumeAfterOutage } : {}) };
            replace(next);
            await persist();
            broadcast();
            return summaryOf(next);
        },
        requestLand: async (id, by, at) => {
            const entry = entryOf(id);
            if (entry === undefined) {
                return undefined;
            }
            const next = { ...entry, landRequested: { email: by.email, ...(by.name !== undefined ? { name: by.name } : {}), at } };
            replace(next);
            await persist();
            broadcast();
            return summaryOf(next);
        },
        clearSession: async (id) => {
            const entry = entryOf(id);
            if (entry === undefined) {
                return;
            }
            // The RUNTIME's pending id too, not just the persisted one: a first turn's session lives only there
            // until finish() flushes it, and sessionIdOf reads it in preference, clearing one of the two would
            // leave the next turn resuming through the half that survived.
            const state = runtime.get(id);
            if (state !== undefined) {
                state.pendingSessionId = undefined;
            }
            const { sessionId: _dropped, ...carried } = entry;
            replace(carried);
            await persist();
            broadcast();
        },
        observe: (id, event) => {
            const state = runtimeOf(id);
            state.lastAt = Date.now();
            // A plan's heading is the agent's own name for the whole job, which the opening prompt rarely was.
            // Promoted out here rather than under `case "plan"` so that case keeps falling through to the
            // shared pause registration, and applied to the entry immediately so the card and every open tab
            // pick the name up on the broadcast this frame was already going to make, a plan parks the turn
            // on the user, and it may sit there a while. The write out is fire-and-forget: it is ordered
            // behind whatever else is in the store's write chain, and a daemon that dies before it lands loses
            // a title the next plan frame re-derives anyway.
            if (event.kind === "plan" && promoteTitle(id, planParts(event.text).title, "plan")) {
                void persist();
            }
            switch (event.kind) {
                case "session":
                    state.pendingSessionId = event.sessionId;
                    // The turn's own prompt has been waiting for exactly this id (see begin), file it so the
                    // agent is findable by what started it from its first frame, not from its last.
                    if (state.pendingPrompt !== undefined) {
                        recordPrompt(event.sessionId, state.pendingPrompt);
                        state.pendingPrompt = undefined;
                    }
                    return;
                case "usage":
                    state.pendingCostUsd += event.costUsd ?? 0;
                    state.pendingInputTokens += event.inputTokens ?? 0;
                    state.pendingOutputTokens += event.outputTokens ?? 0;
                    break;
                case "context_usage":
                    state.contextTokens = event.tokens;
                    state.contextWindow = event.contextWindow;
                    break;
                case "plan":
                case "question":
                case "permission":
                case "browser_help":
                case "terminal_help":
                case "service_offer":
                case "capability_offer":
                    // A turn being torn down cannot park on anything: the abort settles every waiter, so a card
                    // raised by a frame still in flight behind the stop would ask the user a question whose
                    // answer has nowhere to go, and would put the card back in Attention as it leaves.
                    if (state.stopping) {
                        return;
                    }
                    state.pauses.set(event.requestId, event.kind);
                    break;
                case "resolved":
                    // Nothing to release ⇒ nothing to publish: a daemon that restarted mid-park never saw the
                    // card go up, and re-broadcasting for it would only churn the board.
                    if (!state.pauses.delete(event.requestId)) {
                        return;
                    }
                    break;
                case "tool_call":
                    state.pendingToolUses += 1;
                    state.activity = {
                        tool: event.name,
                        ...(event.target !== undefined ? { target: event.target } : {}),
                        ...(state.activity?.todo !== undefined ? { todo: state.activity.todo } : {}),
                    };
                    break;
                case "todos": {
                    const current = event.items.find((item) => item.status === "in_progress")?.content;
                    state.activity = { ...state.activity, ...(current !== undefined ? { todo: current } : {}) };
                    break;
                }
                /* THE AGENTS THIS ONE STARTED. A birth is the only place the lifetime count can be taken, the
                 * live registry sweeps the child five minutes after it reports, so it is counted here and
                 * flushed at finish, exactly like the turn's tool calls above.
                 *
                 * Both cases also PUBLISH, which nothing else did. A parent that spawns children and then waits
                 * on them emits no frames of its own, so the card learned about its children only as a side
                 * effect of whatever they happened to do next, and a count that had gone quiet stayed on the
                 * board after the last child settled.
                 *
                 * An update publishes only when it carries a STATUS. What the card shows is running-of-total,
                 * and the rest of an update is one child's tokens and tool names, the Subagents area's
                 * business, arriving several times a second per child, and not worth re-publishing the whole
                 * fleet for. */
                case "subagent":
                    state.pendingSubagents += 1;
                    break;
                case "subagent_update":
                    if (event.status === undefined) {
                        return;
                    }
                    break;
                case "error":
                    /* A failure the daemon has already scheduled a resume for is not how this turn ENDED, the
                     * turn is coming back (turn-resume.ts), and the card has to read as work in progress rather
                     * than as a card the user needs to go look at. Without this a provider blip painted the whole
                     * board red for the length of an outage, which is both wrong and the strongest possible
                     * argument for switching the automation off.
                     *
                     * Keyed on the frame's own verdict rather than on the code, so it covers every condition that
                     * resumes itself. "available" is NOT covered, nothing is armed, so the failure stands until
                     * the user arms it.
                     *
                     * Remembered rather than merely skipped, because skipping alone only got the card as far as
                     * the entry's resting `idle`, which is the Finished lane. The flag is what carries "coming
                     * back" past the finish() that is seconds away (see RuntimeState.resuming). Nothing to
                     * broadcast here: the turn is still running, and `running` is what the card should say until
                     * it isn't. */
                    if (event.autoResume === "scheduled") {
                        state.resuming = true;
                        return;
                    }
                    state.errored = true;
                    state.failure = sanitizeFailure(event.message);
                    break;
                default:
                    return; // delta/thinking/etc, not card-visible, skip the broadcast.
            }
            broadcast();
        },
        stopping: (id, ending) => {
            const state = runtime.get(id);
            // Nothing running ⇒ nothing to say. An ending that raced the turn's own last frame is not news, and
            // marking a settled conversation would leave `stopping` on the entry for the NEXT turn to inherit.
            if (state === undefined || !state.running || state.stopping !== undefined) {
                return;
            }
            state.stopping = ending;
            /* The abort settles every card this turn was parked on (agent-requests.ts), including the ones
             * whose `resolved` frame will never make it out of the dying stream. Cleared here rather than at
             * finish so the card stops asking for an answer it can no longer take the moment the ending lands.
             *
             * Which is also why clearing them is not enough on its own for a dismissal, and why the publish
             * below is the Stop's alone: a released card on a live turn reads as `running`, so re-broadcasting
             * here would file the dismissed agent under Active for the blink before finish() lands. */
            state.pauses.clear();
            if (ending === "stopped") {
                broadcast();
            }
        },
        finish: async (id, now) => {
            const entry = entryOf(id);
            const state = runtime.get(id);
            // Captured BEFORE the reset: only a finish that ends a LIVE turn counts toward `turns`, the
            // manual land route finishes with an outcome outside any turn and must not inflate the counter.
            const ranTurn = state?.running === true;
            // Same reason, for the value this writes below: the reset clears it, and a manual land's finish
            // (no runtime state at all) must not read as an ending the user chose.
            const ended = state?.stopping;
            if (state !== undefined) {
                state.running = false;
                state.stopping = undefined;
                // A turn that ended holds nobody up any more, however it ended: an aborted card's waiter is
                // settled by the same abort, and its `resolved` frame may never make it out of the stream.
                state.pauses.clear();
                state.startedAt = undefined;
                // `resuming` is deliberately NOT reset here, unlike everything else on this list: it is the one
                // fact that has to survive the finish, because it says this turn's ending isn't one.
            }
            // Tolerates a missing runtime state: the manual land route finishes with an outcome outside any
            // turn (possibly right after a daemon restart), and must still write the status through.
            if (entry !== undefined) {
                const sessionId = state?.pendingSessionId ?? entry.sessionId;
                // Dropped from the carried entry and re-added only under the status it explains, the same
                // shape recordLanded clears `conflicts` with, and for the same reason: this finish is the one
                // that decides how the turn ended, so an explanation it did not write is one for a death that
                // is no longer being reported.
                const { failure: _ended, ...carried } = entry;
                replace({
                    ...carried,
                    /* How the turn ENDED, which is all this field says now: an observed error frame, the user's
                     * own Stop, else the clean ending that hands the question to standing.ts. A stop outranks
                     * nothing, the abort's own unwind no longer reaches here as an error (see agent.routes'
                     * frame loop), so an errored stop means the turn had already failed when it was stopped.
                     *
                     * A DISMISSED card takes the clean ending with everything else that had nothing left to
                     * do. It is an ending the user chose, like the Stop beside it, but not the same one: they
                     * waved the question away rather than reaching in to halt work they still wanted, so
                     * nothing is owed and the card belongs with the finished ones. Whatever the turn had
                     * written stays on its branch for a later message to carry on from, exactly as it does
                     * for any turn that ends with an unlanded delta. */
                    status: state?.errored === true ? "error" : ended === "stopped" ? "stopped" : "idle",
                    ...(state?.errored === true && state.failure !== undefined ? { failure: state.failure } : {}),
                    costUsd: entry.costUsd + (state?.pendingCostUsd ?? 0),
                    inputTokens: entry.inputTokens + (state?.pendingInputTokens ?? 0),
                    outputTokens: entry.outputTokens + (state?.pendingOutputTokens ?? 0),
                    turns: (entry.turns ?? 0) + (ranTurn ? 1 : 0),
                    toolUses: (entry.toolUses ?? 0) + (state?.pendingToolUses ?? 0),
                    subagents: (entry.subagents ?? 0) + (state?.pendingSubagents ?? 0),
                    updatedAt: now,
                    ...(sessionId !== undefined ? { sessionId } : {}),
                });
                if (state !== undefined) {
                    state.pendingCostUsd = 0;
                    state.pendingInputTokens = 0;
                    state.pendingOutputTokens = 0;
                    state.pendingToolUses = 0;
                    state.pendingSubagents = 0;
                    state.pendingSessionId = undefined;
                    state.errored = false;
                    state.failure = undefined;
                }
                await persist();
            }
            // The turn just moved the branch (and, on an auto-land, the main tree), re-derive BEFORE the
            // roster goes out, so the card the user sees settle carries the new standing rather than the one
            // from before the turn ran.
            await reprobe();
            broadcast();
        },
        markResuming: (id) => {
            // runtimeOf, not get: the placeholder's finish is about to reset the state, and `resuming` is the
            // one flag finish deliberately leaves alone, it only has to exist before that reset runs.
            runtimeOf(id).resuming = true;
        },
        abandonResume: async (id, now, reason) => {
            const entry = entryOf(id);
            const state = runtime.get(id);
            // Still unwinding, its own finish() is about to write how it ended, over anything written here.
            // The one answer that means "come back", and the reason this returns anything at all.
            if (state?.running === true) {
                return false;
            }
            // Nothing left to end: a fresh turn's begin already cleared the wait, or the entry is gone.
            if (entry === undefined || state?.resuming !== true) {
                return true;
            }
            state.resuming = false;
            const failure = sanitizeFailure(reason);
            replace({ ...entry, status: "error", ...(failure !== undefined ? { failure } : {}), updatedAt: now });
            await persist();
            broadcast();
            return true;
        },
        recordLanded: async (id, outcome) => {
            const entry = entryOf(id);
            if (entry === undefined) {
                return;
            }
            // The land answers a pending ask along with clearing the old conflict report, a request chip that
            // outlived the land it asked for would read as a second, phantom ask.
            const { conflicts: cleared, landRequested: _answered, ...carried } = entry;
            /* ONLY A VERDICT MAY REPLACE A VERDICT. A `measure` land settles the books and never touches the
             * main tree, so it reaches no conflict gate and reports none: read as "nothing refuses anymore"
             * that silently deleted the last real refusal, and with it the premise the conflict standing, the
             * review's report and "Have the agent resolve it" all hang off (see LandOutcome.adjudicated).
             * It carries the stored report across instead; the derived layers retire it on their own terms the
             * moment the delta stops being outstanding. */
            const verdict = outcome.adjudicated ? outcome.conflicts : (outcome.conflicts ?? cleared);
            replace({
                ...carried,
                repos: [...outcome.repos],
                diffFiles: outcome.diff.files,
                diffInsertions: outcome.diff.insertions,
                diffDeletions: outcome.diff.deletions,
                ...(verdict !== undefined ? { conflicts: [...verdict] } : {}),
            });
            await persist();
            // The landedTips just moved, which is half the anchor every standing is measured from.
            await reprobe();
            broadcast();
        },
        markLandingAbsorbed: async (id, repo, landedHead, landedTip, size) => {
            const entry = entryOf(id);
            if (entry === undefined) {
                return;
            }
            const row = entry.repos.find((composed) => composed.repo === repo);
            // The guard: only the very landing the caller measured. A newer land wrote fresh shas (and with
            // them a fresh, unmarked row), and an already-marked row has nothing left to record.
            if (row === undefined || row.landedHead !== landedHead || row.landedTip !== landedTip || row.absorbed !== undefined) {
                return;
            }
            // Copy-on-write, one row replaced: the entry array is shared with every reader that holds it, and
            // mutating the row in place would move the mark under a scan already reading it.
            const repos = [...entry.repos];
            repos[entry.repos.indexOf(row)] = { ...row, absorbed: size };
            replace({ ...entry, repos });
            await persist();
        },
        setArchived: async (ids, now) => {
            const targets = new Set(ids);
            entries = entries.map((entry) => (targets.has(entry.id) ? { ...entry, archivedAt: now } : entry));
            await persist();
            // The roster this broadcasts no longer contains them, which IS how every connected surface learns
            // the cards left the board.
            broadcast();
        },
        clearArchived: async (ids) => {
            const targets = new Set(ids);
            entries = entries.map((entry) => {
                if (!targets.has(entry.id)) {
                    return entry;
                }
                const { archivedAt: _archived, ...live } = entry;
                return live;
            });
            await persist();
            broadcast();
        },
        remove: async (ids) => {
            const targets = new Set(ids);
            entries = entries.filter((entry) => !targets.has(entry.id));
            for (const id of targets) {
                runtime.delete(id);
            }
            standings.forget(ids);
            presences.forget(ids);
            loopProjection.forget(ids);
            workflowProjection.forget(ids);
            await persist();
            broadcast();
        },
        subscribe: (listener) => {
            listeners.add(listener);
            // The immediate paint carries the CURRENT revision without bumping it: subscribing is not a change,
            // and inventing a revision here would make a new connection look newer than the rosters already
            // applied by tabs that have been connected all along.
            listener(list(), revision);
            return () => listeners.delete(listener);
        },
        revision: () => revision,
    };
};
