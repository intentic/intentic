import {
    type AgentCommand,
    type AgentHarness,
    type AgentProvider,
    type AgentReply,
    capabilitiesOf,
    clampMode,
    type ContextUsage,
    deriveTitle,
    type EditorContext,
    fastAllowed,
    isAwaitingDecision,
    mentionPaths,
    newConversationId,
    type PermissionMode,
    providerLabel,
    settledCards,
    type TranscriptCards,
    type TranscriptPatch,
    type TranscriptRow,
    type TurnFact,
} from "@intentic/sandbox-contract";
import { errorMessage } from "@intentic/ui/async";
import { basename } from "@intentic/ui/path";
import { computed, ref } from "vue";
import { trackPerf } from "../perf";
import { sandboxError, sandboxRequestVia } from "../sandbox/sandboxClient";
import { jsonBody } from "../sandbox/jsonBody";
import { invalidateAgentTranscript, olderTranscriptPage } from "./agentTranscript";
import { AUTO_CONTINUE_PROGRESS_MS, AUTO_CONTINUE_TRIES, autoContinueDelay } from "./autoContinue";
import type { PickUp } from "./pickUp";
import { clampEffort } from "./effortScale";
import { rememberedAccountFor, selectedAccountId, setAccountUsage } from "./providerAccounts";
import { modelLabelFor, providerModels, providerTabs } from "./providerCatalog";
import { type ChatAttachment, type ChatMessage, continuationFor, isNudgeText, recordedRows, withCancelledCards } from "./transcript";
import { readTranscript, saveTranscript } from "./transcriptCache";
import { TranscriptClock } from "./transcriptClock";
import { rememberedModelFor, rememberedProviderFor, rememberPick, startingMode, turnDefaults, type TurnPick } from "./turnDefaults";
import { TurnFailures } from "./turnFailures";
import { type SessionRef, type TurnSettings, boundSession, resumes, turnRequestBody } from "./turnRequest";
import { type AttachEntry, type AttachHead, followRun, postTurnControl, type TurnContext } from "./turnStream";
import { formatReset, formatUtilization, isStale, modelAllowance, SPENT_PERCENT, usageStatusFor } from "./usageStatus";
import { uuid } from "../uuid";

// A file staged in a conversation's composer, uploaded to the workspace the moment it's attached (send is
// then instant). Each lands in its own uuid dir so duplicate names never collide and the agent sees the real
// filename. `previewUrl` (object URL) and `controller` are client-session only, a restored entry has neither.
export interface PendingAttachment {
    readonly id: string;
    readonly name: string;
    // Workspace-relative destination: .intentic/records/artifacts/attachments/<uuid>/<name>.
    readonly path: string;
    // Object URL for image thumbnails; revoked on remove, handed to the sent message on submit.
    readonly previewUrl?: string;
    readonly controller?: AbortController;
    status: `uploading` | `done` | `failed`;
    progress: number;
    error?: string;
}

// A message the user wrote while a turn was already running, waiting to reach the agent. The composer never
// refuses input: a message submitted mid-turn lands here and the conversation delivers it as soon as it can,
// injected into the running turn where the harness accepts that (Claude Code's queue-and-steer), else sent as
// the next turn the moment this one settles. Carries everything a fresh message can (files, the editor chip),
// so "add more while it works" isn't a lesser kind of message.
export interface QueuedMessage {
    readonly id: string;
    readonly text: string;
    readonly attachments: readonly ChatAttachment[];
    readonly editorContext?: EditorContext;
}

/* TWO "CARRY ON"S NEXT TO EACH OTHER IN THE QUEUE ARE ONE MESSAGE, and this is what says so.
 *
 * The queue flushes as a SINGLE turn (everything written while the agent worked belongs to one request), and a
 * turn refused before it ran hands its words straight back to it. Put together, a chat that keeps bouncing off
 * the same refusal compounds the press into the words themselves: the button is pressed, the send fails, the
 * word comes back, the next press queues behind it, and the message grows by one "Continue" per attempt. A real
 * transcript reached seven of them in one prompt, drawn as a single clamped bubble with a scrollbar, and that
 * pile is what the agent read when a send finally got through.
 *
 * A nudge carries no instruction of its own (transcript.ts's ACKNOWLEDGMENTS is the same list the transcript
 * folds turns by), so a second one behind an undelivered first says nothing the first didn't. The press still
 * lands: what it means now is "try the held one again", which is what both callers do next.
 *
 * ADJACENT ONLY, and never against real words. Attachments make any text substantive ("continue" plus a
 * screenshot is new material), and "fix the tests" that never left, followed by "go ahead", is a user answering
 * something, which the queue joining the two is exactly what it is for. */
const repeatsNudge = (message: { readonly text: string; readonly attachments: readonly ChatAttachment[] }, neighbour?: QueuedMessage): boolean => {
    if (neighbour === undefined || message.attachments.length > 0 || neighbour.attachments.length > 0) {
        return false;
    }
    return isNudgeText(message.text) && isNudgeText(neighbour.text);
};

// What a conversation is doing right now, surfaced as the tab's status icon.
export type ConversationStatus = "idle" | "streaming" | "awaiting" | "error";

/* One chat conversation: its transcript, the resumed sandbox session, and the turn selection every send runs
 * under. Self-contained so the manager can run several at once, each instance owns its AbortController and its
 * transcript clock, so tabs stream independently.
 *
 * The pieces a turn is made of live beside this file, and each is one thing: turnStream.ts renders a run and
 * carries control messages to it, transcriptClock.ts holds the transcript and decides when a frame is shown,
 * transcriptState.ts is that transcript as a value and every transition it can make, turnFailures.ts says what a
 * failed turn does to the conversation, and turnRequest.ts states the turn on the wire. What a frame MEANS is
 * settled before it reaches this window, by the daemon's fold (sandbox-contract/transcript-fold.ts). What is left
 * here is the conversation itself: the selection, the queue, the cards, and the effects a frame has on all three. */
export class Conversation {
    /* The transcript and its clock. The run's entries are buffered into it and applied on the next paint; what
     * each one means for the conversation beyond its rows comes back through `applied` below, because what a
     * fact DOES is this conversation's business and what a patch does it TO is the transcript's. */
    private readonly transcript = new TranscriptClock((entry, turn, replay) => this.applied(entry, turn, replay));

    readonly messages = this.transcript.messages;
    // Whether a pane is showing this transcript WITH the focus, the typewriter's gate, written by the pane
    // that holds it (ChatPane) and read by the clock's tick. See TranscriptClock.watched for why an unwatched
    // transcript settles its text instead of typing it.
    readonly watched = this.transcript.watched;
    readonly streaming = ref(false);
    readonly error = ref<string | null>(null);
    /* THE LAST TURN ENDED BEFORE ITS WORK DID, and picking it up is a press rather than a sentence.
     *
     * Four endings share that shape: a turn the user stopped, a turn that died with no code anybody can act on
     * (the harness crashing mid-run, an agent that halted after a tool it was refused), a provider outage, and a
     * spent allowance. All four leave half-finished work behind a session that is perfectly alive, so the only
     * thing missing is somebody saying "carry on". That sentence was being typed by hand, into every chat this
     * happened to, which is the whole reason this state exists: the offer it arms (the continue strip, and Enter
     * on an empty composer) is the typing, done once.
     *
     * The last two differ from the first two only in KNOWING SOMETHING EXTRA about when the press works, and
     * pickUp.ts is where that difference lives, not here.
     *
     * DELIBERATELY NOT the failures that name something to fix, a dead credential, a model the provider does
     * not serve, a seat nobody enabled. Continuing those re-fails by construction, and an offer that re-fails
     * teaches the user to stop trusting the offer.
     *
     * Cleared by the next turn starting, whichever it is: the continuation itself, or whatever the user decided
     * to send instead of it. */
    readonly pickUp = ref<PickUp | undefined>();

    /* WHETHER THE DAEMON HAS TAKEN THE TURN THIS WINDOW IS ON, false from the moment a send opens one until its
     * ack comes back, and true for the whole of a run adopted by reattach (a run that exists daemon-side is
     * accepted by definition).
     *
     * It exists because the two halves of a send fail in ways that have nothing in common, and one `catch` used
     * to read them as the same thing. AFTER the ack, a throw is a stream this window lost over a turn the daemon
     * owns and is still running: the words are recorded, so they stay in the transcript and the failure is the
     * red line's business. BEFORE it, nothing reached the daemon at all, no turn, no record, no session, so
     * this window holds the ONLY copy of what the user typed, and a bubble left sitting in the transcript shows
     * a message as said when no agent has ever seen it. That is what the report behind this was: a send lost to
     * an unreachable daemon left the words on screen, undelivered and unrecoverable, and the chat then offered to
     * "continue" a conversation the daemon had no record of, so the press sent a bare "Continue" as its opening
     * message, collected the new-conversation preamble, and the agent answered that there was nothing to
     * continue. Both halves of that are this flag's: the words go back to the queue, and the offer stands down. */
    private turnAccepted = false;

    /* THE SAME PRESS, STANDING, this chat continues itself for as long as it keeps stopping short.
     *
     * A standing instruction rather than a per-stop choice, which is why it lives on the conversation and is
     * persisted with the tab: the whole point is the stops that happen while nobody is watching. It arms nothing
     * on its own, only a turn that ends `resumable` schedules anything, so a chat whose turns finish normally
     * never sees it act. A failure that names something to repair (a dead credential) is not one of those endings
     * by construction; a spent allowance is, because it clears on its own and its retry policy lives below.
     *
     * autoContinue.ts holds the schedule and the argument for it; `autoContinueAt` is the instant the pending
     * one fires, which is what the composer's strip counts down to (and what makes the wait visible instead of
     * the chat merely appearing to sit there). */
    readonly autoContinue = ref(false);
    readonly autoContinueAt = ref<number | undefined>();
    private autoContinueTimer: ReturnType<typeof setTimeout> | undefined;
    // Consecutive automatic continuations that bought nothing, the rung of autoContinue.ts's ladder this chat
    // is on. Reset by a turn that got somewhere, and by the switch being thrown again.
    private autoContinueTries = 0;
    // True while a daemon read that should produce this conversation's transcript is in flight and nothing is
    // painted meanwhile, a history open, or a restored tab whose local mirror came up empty. The panel shows
    // its loading state on it instead of the "Start a conversation" invitation, which over a chat that merely
    // hasn't arrived yet reads as data loss.
    readonly loading = ref(false);
    /* WHERE WHAT IS DRAWN SITS IN THE RECORD. The daemon answers a transcript read with the most recent turns,
     * not the whole conversation: `historyFrom` is where the oldest drawn message sits in the record, and
     * `historyMore` says there is more above it. Handing `historyFrom` back as `before` fetches the page above.
     *
     * Zero and false is both a fresh conversation and one that fits inside a single window, which is most of
     * them — the pair only starts saying anything on a conversation long enough to have been the problem. */
    readonly historyFrom = ref(0);
    readonly historyMore = ref(false);
    // A page of older turns is on its way. Separate from `loading`, which means "nothing is painted at all":
    // paging back happens over a full transcript the reader is looking at, and must not blank it.
    readonly loadingOlder = ref(false);
    // This conversation's slash commands, replaced whole per `commands` frame, listed by the composer's `/`
    // popover. Both provider families publish them: an ACP agent mid-session, Claude at each turn's init (plus
    // a republish whenever the session's list changes).
    readonly availableCommands = ref<readonly AgentCommand[]>([]);

    // True while a turn is paused on a card awaiting the user's input (a pending plan, question, or tool
    // permission). The attach stream stays open during this, so `streaming` is still true, but the agent
    // isn't generating, so the composer should drop the Stop spinner and show a ready Send (Claude Code style).
    readonly awaitingDecision = computed(() => this.messages.value.some(isAwaitingDecision));

    /* THE MODEL IS ACTUALLY WORKING RIGHT NOW, which is a narrower thing than `streaming` and is the honest
     * subject of every "not while a turn is running" rule.
     *
     * A turn parked on a card is streaming: the run is alive and the attach stream is open, so the flag stays
     * true for as long as the card waits. The guards that reached for it therefore refused things a parked turn
     * has no stake in, and the account switcher was the one that mattered: a person reading "the allowance is
     * spent" on a card cannot re-point the chat at an account that isn't, which is the one move the situation
     * calls for. What a parked turn genuinely cannot survive is a change to the RUNNING request (a provider
     * switch retires the session it is running on), and those guards keep reading `streaming`. */
    readonly generating = computed(() => this.streaming.value && !this.awaitingDecision.value);

    /* THE CARDS WHOSE ANSWER IS CURRENTLY IN THE AIR, by message id.
     *
     * A decision card is answered by ONE of several buttons: Allow once, Always allow, Deny; Approve, Keep
     * planning. Locking the pressed button (which the kit's <Button> now does on its own) stops the same
     * answer being sent twice, and does nothing at all about the user who presses Approve and then, a beat
     * later, changes their mind and presses the one beside it. Both are legitimate presses of two live
     * controls, and both used to go out: the daemon un-parks the turn on whichever lands first and answers the
     * second with a 404, which the card reported as "the turn may have ended" over a decision that had in fact
     * landed perfectly.
     *
     * So the guard belongs to the CARD, not to the button. The status check at the top of each `decideX`
     * cannot do it: `pending` only stops being `pending` once the reply has come back, so it is blind for
     * exactly the window it exists to cover. This is written synchronously, before the request leaves. */
    private readonly deciding = ref<ReadonlySet<number>>(new Set());

    /** Whether this card's answer is on its way, for the view that must stop offering the other answers. */
    isDeciding(id: number): boolean {
        return this.deciding.value.has(id);
    }

    // The message carrying a plan currently awaiting the user's decision, if any. Lets the composer route
    // typed feedback into a plan rejection (reject-with-feedback) instead of starting a fresh turn.
    readonly pendingPlanMessage = computed(() => this.messages.value.find((message) => message.plan?.status === `pending`));

    // Header title for this conversation; null shows "New chat". Derived from the first user message.
    readonly title = ref<string | null>(null);

    // The model the SDK actually resolved for the latest turn (from its init message), when reported.
    readonly activeModel = ref<string | null>(null);

    // Context-window fill for this conversation (tokens sent on the latest request vs the model's window),
    // updated at the end of each turn. Per-conversation, so the composer shows the active chat's meter.
    readonly contextUsage = ref<ContextUsage | undefined>();

    /* The user's permission posture for this conversation, the composer's pick, seeded by where the
     * conversation works (startingMode). Only the user writes it, and nothing writes OVER it.
     *
     * The mode is the contract's PermissionMode, imported, not redeclared. The composer picks the turn's
     * STARTING mode; the agent can then move itself (EnterPlanMode when a request turns out to need thinking
     * through, ExitPlanMode once the user approves), which arrives back as a `mode` frame and drives `liveMode`
     * below. So the selector always shows the live posture, not just what the user last clicked. */
    readonly modePick = ref<PermissionMode>(startingMode(true));

    // The posture the next turn actually STARTS in: the pick, clamped to what this conversation's runtime can
    // hold. Read-clamped rather than written back, exactly as `effort` is one field down and for the same
    // reason, a native Codex/Grok/ACP turn has an approval channel for nothing, so "Manual" above one is a
    // promise it can't keep, but a user who switches to Codex and back must get their own pick returned rather
    // than quietly ratcheted down to the posture the other runtime happened to allow.
    readonly mode = computed<PermissionMode>(() => clampMode(this.modePick.value, this.capabilities.value));

    // The posture the RUNNING turn is actually in, from the turn's `mode` frames, the agent's own
    // EnterPlanMode, or the mode a plan approval landed in. Display-only (the composer shows it so the pill
    // never lies mid-turn) and cleared at each send: an agent that escalates itself into planning must not
    // leave the user's standing pick demoted for every turn after it.
    readonly liveMode = ref<PermissionMode | undefined>();

    // What this conversation is doing, for the tab's status icon.
    readonly status = computed<ConversationStatus>(() => {
        if (this.error.value !== null) {
            return `error`;
        }
        if (this.awaitingDecision.value) {
            return `awaiting`;
        }
        return this.streaming.value ? `streaming` : `idle`;
    });

    // The session the next matching turn resumes (Claude Code session / Codex thread / Grok session), captured
    // from the stream together with the provider/account that minted it. Public so the manager can focus an
    // already-open tab when the user reopens the same conversation from history.
    readonly session = ref<SessionRef | undefined>();

    // The tmux session this conversation's Bash commands are running in (`agent-<sdk session>`), from the
    // daemon's own `terminal` frame. Held so the transcript can offer to WATCH the shell, the agent's terminals
    // no longer tab themselves into the panel (useWorkTerminals), so the Bash card is where that door lives.
    // Undefined until the first Bash of a turn; a fresh conversation, a fork, and a restored transcript all
    // start without one, because whatever shell they inherited belongs to a session they no longer run in.
    readonly agentTerminal = ref<string | undefined>();

    // The same, for the browser this conversation's agent drives (`browser-<sdk session>`, named by the
    // daemon's `browser` frame). Held for the same reason and cleared on the same edges: a browser card can
    // offer to watch a live page only while the turn that opened it is the turn on screen.
    readonly agentBrowser = ref<string | undefined>();

    // Whether this conversation's turns run in an isolated git worktree (the parallel-agents mode, the default
    // for new chats) or on the shared /work tree. Flipped off for history-menu restores (their sessions live in
    // the main tree's namespace) and legacy restored tabs.
    readonly isolated = ref(true);

    /* WHICH MACHINE THIS CONVERSATION RUNS ON: a paired runner's id, or undefined for this sandbox (the
     * default). Chosen before the first turn and latched by the daemon from then on, so the picker offers it
     * only while `registered` is false: a conversation cannot move between machines mid-life, and a control
     * that pretended otherwise would silently do nothing. Design: docs/remote-runners-plan.md in the
     * workspace this sandbox serves. */
    readonly runner = ref<string | undefined>();

    /* WHICH SANDBOX THIS CONVERSATION LIVES IN: a sandbox id, or undefined for the box this browser is pointed
     * at, which is what every conversation in this app was until now and what almost all of them still are.
     *
     * IT IS AN ADDRESS, NOT A MODE. Every daemon call this object makes, the send, the attach it renders from,
     * steer, stop, reply, rewind, the transcript read, an attachment's bytes, goes through `this.at`, so one
     * field decides the whole correspondence and no half of it can end up talking to a different machine than
     * the other half. That is the entire mechanism: `sandboxSession` keys its bearers by sandbox id and
     * `sandboxRequestVia` takes the id, so a turn in another box is the same protocol at another address.
     *
     * WHAT IT DOES NOT MOVE. The workspace around the composer is still THIS box's: the file tree the @-mention
     * popover completes from, the editor's open file, the personas and the provider accounts. Those are
     * properties of a machine, not of a conversation (docs/across-sandboxes-design.md §3), so a remote
     * conversation does not send them and the composer stops offering them (see `remote` in ChatPane and the
     * omissions in turnRequestBody's caller below). The model and provider DO cross: a model id is the
     * provider's, not the box's, and the target daemon resolves it against its own catalog and its own account.
     *
     * CHOSEN BEFORE THE FIRST TURN AND LATCHED THEN, exactly like `runner` above and for a stronger reason: the
     * daemon that has the conversation's record, its worktree and its session is the only one that can run its
     * next turn. The picker offers it while `registered` is false and reads afterwards. */
    readonly box = ref<string | undefined>();

    // The reach every request in this class is aimed with (composables/sandbox/sandboxClient.ts): the box above,
    // in the vocabulary the daemon client and agentActions already speak, where undefined means the active one.
    private get at(): string | undefined {
        return this.box.value;
    }

    /* A CONVERSATION IN ANOTHER BOX IS REGISTERED BY ITS ACK, because no roster frame will ever say so here:
     * `registered` latches on the fleet stream and this browser streams ONE sandbox. The ack is the same fact
     * arriving from the other end, the daemon has opened the registry entry this turn runs under, and it is
     * exactly the fact the latch exists to hold: without it a remote tab stays a "draft" for good, drawing a
     * phantom New-agent card on the board next to the real card the All-sandboxes read brings back for it.
     *
     * A no-op for a conversation in this box, which keeps its roster-frame latch: that one is later but it is
     * the daemon's own account of its registry, and a send that is refused after the ack (a turn the entry
     * never got) would otherwise leave a card claiming a registration nothing made. Called on the send path's
     * ack alone (see send). */
    private latchRemoteRegistration(): void {
        if (this.box.value !== undefined) {
            this.registered.value = true;
        }
    }

    // Whether the fleet has ever known this conversation. The board's DRAFT card exists to bridge exactly one
    // gap, "New agent" pressed → the first roster frame that registers it, and that crossing happens once, so
    // this LATCHES rather than tracking the roster. Reading "absent from the roster" as "draft" instead is what
    // put an agent the user had just ARCHIVED straight back in the Active lane under a fresh "New agent" card:
    // the roster carries live agents only, so its open tab looked brand new again. A dropped events stream
    // (resetAgents empties the roster) and a cold load before the first frame did the same to every open agent
    // tab at once. Persisted with the tab, so a reload doesn't un-know it.
    readonly registered = ref(false);

    // The conversation's worktree identity from the turn's `worktree` frame: its agent/<id> branch and the
    // root repo's short base sha. Undefined until the first isolated turn runs (or on main-tree conversations).
    readonly worktree = ref<{ branch: string; base: string } | undefined>();

    // Whether this tab has already said that the sandbox cannot enforce worktrees with mounts. Latches for the
    // conversation's life: the condition is a property of the container, not of any one turn.
    private warnedUnenforced = false;

    // Lifetime accounting across the conversation's turns (the fleet card and the usage popover read these),
    // summed off the rows on screen: each turn's usage sits on the bubble its answer ended in. The daemon's
    // registry is the authoritative cross-device total; this is what this tab can see, which matches it
    // whenever the tab holds every turn.
    readonly costUsd = computed(() => this.messages.value.reduce((sum, message) => sum + (message.usage?.costUsd ?? 0), 0));
    readonly inputTokens = computed(() => this.messages.value.reduce((sum, message) => sum + (message.usage?.inputTokens ?? 0), 0));
    readonly outputTokens = computed(() => this.messages.value.reduce((sum, message) => sum + (message.usage?.outputTokens ?? 0), 0));

    // Start of the in-flight turn (ms), for the card's elapsed readout; undefined while idle.
    readonly turnStartedAt = ref<number | undefined>();

    /* This conversation's turn selection. All of it, provider and account included, is switchable mid-chat (the
     * composer binds them); send() decides whether the session above still matches (resume) or a fresh one
     * starts seeded with the transcript so far.
     *
     * The values below are placeholders: `seedPicks` (called by the constructor) is what actually fills them
     * from the remembered picks, and it is the ONE description of what a chat nobody has touched starts on.
     * Written as five field initializers, the seeding drifted from the re-seeding "New agent" needs when it
     * hands back an already-open empty draft instead of minting a twin, and a rule spelled out in two places is
     * a rule that is about to disagree with itself. */
    readonly provider = ref<AgentProvider>(`claude`);
    readonly harness = ref<AgentHarness>(`native`);
    readonly account = ref<string | undefined>();
    readonly model = ref<string>(``);
    /* WHERE THE APP MOVED THIS CHAT FROM — the provider AND the model — and the whole of what tells an
     * app-chosen fallback apart from a choice somebody made. Undefined for every conversation that is where it
     * was put, which is almost all of them; set by `repointProvider` and cleared the moment either the fallback
     * is given back (restoreProvider) or the user picks for themselves.
     *
     * The MODEL rides along because the restore is otherwise lossy in exactly the way this whole file is about:
     * two drafts prepared on two different Claude models, both parked on Cursor by an outage, both came back on
     * whichever Claude model had been picked most recently. What was displaced is what is owed back.
     *
     * IT REPLACES ASKING THE GLOBAL PREFERENCE. The connection watch used to answer "should this chat move back"
     * by comparing the conversation's provider against the last pick made ANYWHERE (turnDefaults.provider), which
     * cannot tell the two apart: a board of unsent drafts, each deliberately prepared on its own model, was
     * dragged wholesale onto whichever one had been picked most recently, on every account refresh and on every
     * reload. Per conversation, the question is exact — this chat is on the trial because we put it there, and
     * here is what it was on — so the only chat that ever moves is the one that was moved in the first place,
     * and it moves back to its own provider rather than to somebody else's latest pick.
     *
     * Persisted with the tab (tabSnapshot), because the fallback reliably outlives the window: a chat pushed onto
     * the free trial while an OAuth redirect was in flight comes back from that redirect still on the trial, and
     * a displacement only this window's memory knew about would leave it there for good.
     *
     * A conversation can also be BORN displaced, which is why `seedPicks` sets this too: `rememberedProviderFor`
     * resolves a pick that cannot run today to one that can, deliberately without writing over the pick, so a
     * chat opened while Claude is down opens on whatever can send. That is a substitution exactly like the
     * watch's, and it is owed the same return — the two differ only in which of them noticed first. */
    readonly movedFrom = ref<TurnPick | undefined>();
    readonly thinking = ref<boolean>(true);
    /* Ask for fast speed on this conversation's turns. Deliberately NOT seeded from turnDefaults, unlike every
     * other control on this line: fast mode costs roughly twice per token, and the sticky-default machinery
     * would carry one chat's toggle into every chat opened afterwards. A control that spends more money starts
     * from off, every time, and says so per conversation. (The daemon takes the same position for the same
     * reason, see the fastModePerSessionOptIn note in agent.ts.) */
    readonly fast = ref<boolean>(false);
    /* KEEP THIS CONVERSATION ON THE MODEL I PICKED: the standing veto over automatic tier selection
     * (AgentTurn.tierHold). Per conversation and never a global default, like `fast` above and for the mirror
     * of its reason: this control REFUSES a saving rather than buying a speed-up, and carrying one chat's
     * distrust into every later chat would quietly switch the feature off without anyone deciding that. Sent on
     * every turn as a plain boolean (never omitted), because the daemon persists it on the entry and only an
     * explicit `false` can clear a hold set yesterday. Seeded from the entry on reopen (AgentSummary.tierHold). */
    readonly tierHold = ref<boolean>(false);
    /* WHO THIS CHAT IS WHEN IT REACHES THE OUTSIDE WORLD, the id of one of the workspace's personas, or
     * undefined for the ordinary chat that keeps every connected account.
     *
     * Per turn on the wire and so switchable mid-chat, which is the point: "now act as Work and post this"
     * is one pick away, and the turn it applies to is the next one rather than a new conversation. The card
     * bounds the turn where it counts, the accounts it can act through, the shelves of its toolbox, so
     * nothing here needs to be true for the session already running.
     *
     * Deliberately NOT seeded from turnDefaults and never sticky, unlike the model/effort picks two lines up.
     * A persona takes accounts AWAY, and a narrowing that follows the user into the next chat is one they
     * would not remember making, so every new chat starts as everyone, and the pick belongs to the chat it
     * was made in (it is persisted with the tab, so a reload keeps it). */
    readonly actsAs = ref<string | undefined>();
    /* THE WORKFLOW THIS COMPOSER'S NEXT MESSAGE RUNS THROUGH, if any, the id of a saved design, or undefined
     * for the ordinary thing where the message is a turn on this chat.
     *
     * It sits with the other per-conversation picks because that is exactly what it is: one more answer to
     * "what happens when I press send", alongside which model and how hard it thinks. A workflow used to be
     * started from its own page behind its own dialog, which made starting agent work two different acts
     * depending on which of them you wanted, and the one behind the dialog was the one nobody could find.
     *
     * Deliberately NOT seeded from turnDefaults and never sticky: a workflow fans a message out into several
     * paid sessions, and carrying that pick silently into the next chat is the one default nobody would want.
     * It clears on send, for the same reason. */
    readonly workflowId = ref<string | undefined>();
    /* THE SAVED LOOP THIS COMPOSER'S NEXT MESSAGE RUNS AS, if any, the id of a saved loop, or undefined for the
     * ordinary send-it-once.
     *
     * The workflow pick's twin, held beside it because it is the same KIND of answer to "what happens when I
     * press send": one hands the message to a graph of other sessions, this one hands it to this agent over and
     * over until a stated bar is cleared. Both leave the sentence to the composer, which is what stopped a loop
     * needing a form with a goal field in it.
     *
     * Never sticky and cleared on send, for the workflow pick's reason and more sharply: a loop spends money
     * per round with nobody pressing anything between rounds, and a badge that survived its own run would make
     * the next message do it all again silently. */
    readonly loopId = ref<string | undefined>();
    // The reasoning effort the user ASKED for, which is not always runnable, because the tier scale belongs to
    // the MODEL: a pick made on Claude ('max', 'xhigh') is off Kimi K3's scale, and 'max' leaves Claude's own the
    // moment thinking is switched off. Everything that selects an effort writes this; everything that renders or
    // SENDS one reads `effort` below. Keeping the pick means a trip through a smaller model doesn't ratchet it
    // down, come back and the user's choice is still there.
    readonly effortPick = ref<string>(``);

    // The tier this conversation's next turn actually runs at: the pick, clamped to what the current
    // provider+model+thinking triple offers. Clamped at READ rather than written back, so it also covers the
    // moments no setter runs, the model catalog arriving after the conversation was seeded, most of all.
    readonly effort = computed<string>(() => clampEffort(this.effortPick.value, this.provider.value, this.model.value, this.thinking.value));

    // This conversation's composer draft: the unsent message text and staged attachments. Per-tab so switching
    // tabs keeps each chat's draft; persisted per sandbox (see useChat's tab snapshot) so a refresh keeps it.
    readonly draft = ref(``);
    readonly attachments = ref<PendingAttachment[]>([]);

    /* WHEN THIS COMPOSER FIRST HELD SOMETHING UNSENT, so the marks that report it (UnsentMark, on the fleet
     * board's card and the chat rail's row) can say how long the message has been standing rather than only
     * that it exists. That is the fact triage actually turns on: a sentence abandoned four days ago and one
     * broken off mid-word a minute ago are the same mark today.
     *
     * THE EDGE, NOT THE LAST KEYSTROKE. It is stamped when `unsent` goes false→true and cleared when it goes
     * back (useChat holds the one watcher that does it, so every route into a draft — typing, an upload
     * landing, a queued message, a restore — is covered by watching the flag itself rather than each of them).
     * A per-keystroke timestamp would also churn the draft echo's publish key, which is deliberately built to
     * stop changing once the preview settles (draftEcho).
     *
     * Persisted with the draft (tabSnapshot), because an age that resets to "just now" on every reload is
     * worse than no age at all. Absent while the composer is empty. */
    readonly draftAt = ref<number | undefined>();

    /* ASKING THIS TURN AGAIN, IN DIFFERENT WORDS, the composer aimed at a message already in the transcript
     * rather than at the end of it. Set by beginEdit, cleared by cancelEdit or by the send that spends it.
     *
     * IT HOLDS THE CHAT UNCHANGED UNTIL THE SEND. Everything the edit is going to destroy, the old prompt, the
     * turns under it, the files those turns wrote, is still there while the box is being typed into, and the
     * transcript merely draws the doomed rows struck through (ChatPane's `doomed`). That is the whole shape of
     * this feature and the reason it is a MODE rather than a button: a rewind that fired on the pencil would
     * demand a confirm of its own before the user had even decided what to say instead, and an edit abandoned
     * halfway would have already thrown the answer away. Here, cancelling costs nothing because nothing has
     * happened yet, and the send is its own confirmation, the user re-states the prompt in the act of
     * replacing it.
     *
     * `restore` is the draft the mode displaced, put back verbatim on cancel: entering an edit must not eat a
     * half-written message, which is the one thing on this screen the app cannot recover (see `unsent`).
     * `attachments` is the same promise for the staged files.
     *
     * Keyed by the message's own id rather than its position, because an append renumbers nothing while an
     * insert would shift every index under an open editor.
     *
     * IDS ARE ONLY UNIQUE WITHIN ONE TRANSCRIPT, though, which is the trap this has to be read alongside:
     * TranscriptClock.rebuild starts its allocator over from zero, so a wholesale replacement can hand id 1 to a
     * message that has nothing to do with the one an edit was armed on, and an edit that resolved by id alone
     * would then replace the wrong turn without a word. So every path that REPLACES this conversation's
     * transcript disarms the edit on its way through (rewindTo and restoreMessages below; forkFrom and
     * paintCached cannot be reached with one armed, the first builds a conversation that has not existed yet,
     * the second refuses on any transcript that already has a message in it). */
    readonly editing = ref<{ readonly id: number; readonly restore: string; readonly attachments: readonly PendingAttachment[] } | undefined>();

    // Messages submitted while a turn was running and not yet delivered, see enqueue/drainQueue. Rendered
    // above the composer so nothing the user wrote is ever invisible, and persisted with the draft.
    readonly queued = ref<QueuedMessage[]>([]);

    /* WORDS OF THE USER'S THAT HAVE NOT GONE OUT, composer text (whitespace alone isn't text; send() refuses
     * it too), a staged or still-uploading attachment, a message queued behind a running turn.
     *
     * Everything else a chat holds is recoverable: the transcript is in the session store, the branch is on
     * disk, a closed tab reopens from History. These three are not, they live in this window and nowhere
     * else. So they are the one thing that makes a conversation the app must not quietly lose track of, and
     * three surfaces read this one flag to say so: the retention sweep refuses to close such a tab, the fleet
     * board keeps its card on screen (it is why an ARCHIVED session comes back to the board), and both
     * finished lanes hold it in front of their fold. */
    readonly unsent = computed<boolean>(() => this.draft.value.trim() !== `` || this.attachments.value.length > 0 || this.queued.value.length > 0);

    /* The harness retrying INSIDE the live turn (provider_retry). Distinct from a failure in the way that
     * matters most to a waiting user: nothing has failed and nothing has been lost, this turn is still running.
     * Rendered as a status beside the streaming indicator and dropped the moment the turn produces anything or
     * settles, so it can never outlive the wait it describes. */
    readonly providerRetry = ref<Extract<TurnFact, { kind: `provider_retry` }> | undefined>();

    /* What speed the harness actually served the last turn at, and, when it wasn't the one asked for, its
     * reason. Kept ACROSS turns rather than cleared at the boundary like providerRetry above: the answer is a
     * standing fact about this conversation's model and account ("your plan doesn't include fast mode") far
     * more often than a property of one turn, and clearing it would make the notice flicker away exactly when
     * the user goes looking for why the toggle did nothing. A turn that changes the answer replaces it. */
    readonly fastMode = ref<Extract<TurnFact, { kind: `fast_mode` }> | undefined>();

    /* What the complexity judge said about the LAST judged turn here, fastMode's twin for automatic tier
     * selection, and kept across turns for its reason: "this ran on the cheaper model" is exactly what the user
     * goes looking for after noticing an answer felt thinner, and a value cleared at the boundary would be gone
     * by then. Replaced by the next judged turn's frame; undefined until one arrives (the judge off, or a
     * conversation reopened — the VERDICT half is reseeded from the entry via `lastTier` below). */
    readonly tierAnswer = ref<Extract<TurnFact, { kind: `tier` }> | undefined>();

    /* The last verdict alone, the one judge input a draft cannot contain (prompt-complexity.ts `afterHardTurn`),
     * held apart from `tierAnswer` because it outlives it: a reopened tab has no frames yet, but the entry
     * remembers the verdict (AgentSummary.tier) and the composer's pre-send preview must judge a follow-up the
     * way the daemon will. Seeded from the tab, replaced by every tier frame. */
    readonly lastTier = ref<`fast` | `standard` | undefined>();

    /* What the runtime behind this conversation's provider/harness pair can actually do, the same record the
     * daemon plans the turn against (capabilitiesOf), so the composer can't offer a control nothing applies.
     * Every consumer reads the field it cares about: the mode menu takes `permissions`, the effort segments
     * take `effort`, the picker footer takes the whole record via limitationsOf. */
    readonly capabilities = computed(() => capabilitiesOf(this.provider.value, this.harness.value));

    // Whether the running turn can absorb a message mid-flight, the same field the daemon's streamAgent gates
    // its SteeringQueue on. Used for WORDING alone (the composer says "steer" vs "queue"): delivery asks the
    // daemon and falls back to the queue on a refusal, so a drift here can't lose a message.
    readonly steerable = computed(() => this.capabilities.value.steering);

    // Whether the fast control is offered at all: the runtime, the route and the selected MODEL all have to
    // allow it (fastAllowed). Read from the live catalog rather than remembered, so switching to a model that
    // doesn't publish fast mode takes the control away by itself, the same way the effort segments follow the
    // model's own tier list. The pick is left alone underneath: come back to a fast-capable model and the
    // toggle is where the user left it.
    readonly fastOffered = computed(() =>
        fastAllowed(
            this.capabilities.value,
            this.provider.value,
            (providerModels.value[this.provider.value] ?? []).find((option) => option.value === this.model.value)?.badges,
        ),
    );

    /* What a failed turn does to this conversation, and how one that is coming back is waited out, the outage
     * countdown and the credential-renewal spinner the composer draws are this unit's own state. Public because
     * those two are what the banner and the notice line read. */
    readonly failures = new TurnFailures({
        transcript: this.transcript,
        provider: this.provider,
        account: this.account,
        model: this.model,
        session: this.session,
        error: this.error,
        pickUp: this.pickUp,
        streaming: this.streaming,
        requeue: (userMessageId: number) => this.requeueUndelivered(userMessageId),
        hold: () => {
            this.interrupted = true;
        },
        reattach: () => this.reattach(),
        persist: () => this.persist(),
    });

    // What a followed run writes into. The turn a stream renders under is the one varying part, so each call
    // adds its own `attached`.
    private readonly sink = {
        entry: (entry: AttachEntry, turn: TurnContext, replay: boolean): void => this.transcript.push(entry, turn, replay),
    };

    /* THE TOOLS THIS TURN HAS ALREADY DRAWN, by id, so a card's first arrival can be told from its updates: a
     * main-tree turn's writes are recorded for the Changes panel once per call (liveWrites), and a tool patch
     * carries the whole card every time it moves. Cleared as each turn begins. */
    private liveTools = new Set<string>();

    // The one unsent "switched" divider notice, upserted/removed as the user toggles provider/account and made
    // permanent by the next send (the segment cut).
    private pendingSwitchNoticeId: number | undefined;

    /* A SWITCH MADE WHILE THE TURN WAS PARKED ON A CARD, owed a divider it could not be given at the time.
     *
     * The account switcher is live while a turn waits on the user (see selectAccount), and the transcript's tail
     * in that moment belongs to the card, so the line that says what the NEXT message does cannot go under it.
     * This carries the fact to the settle hook, which is where the divider belongs anyway, and it is what stops
     * that hook from having to guess a switch out of a mismatched session ref (noticeMidTurnSwitch). */
    private switchedMidTurn = false;

    /* THE MODEL THIS CONVERSATION IS ALREADY RUNNING ON: the pick the last SENT turn went out under, and the
     * only thing a same-provider model swap can be measured against.
     *
     * Deliberately not `activeModel`, which looks like the same fact and isn't: that is the model the SDK
     * RESOLVED, so an automatic-tier turn that ran on the cheap model leaves it naming a model the user never
     * picked, and every message after one would then announce a switch nobody made. This is the ASK, so it
     * moves only when the user moves it.
     *
     * Undefined until the first send, and cleared wherever the segment restarts (a provider or harness switch,
     * a restored session): past that boundary there is no cached prompt left to lose, which is the one thing
     * the notice it feeds exists to report. */
    private sentModel: string | undefined;

    /* Where this conversation was cut from, until the daemon has ACCEPTED a turn carrying it (see forkFrom).
     * Undefined on every conversation that is not a fork, and on a fork from its acked first turn onward, the
     * daemon has copied the rows by then, and from there this conversation's record is its own.
     *
     * A REF, AND PUBLIC, BECAUSE IT RIDES THE TAB SNAPSHOT. Until that first send this field is the ONLY record
     * anywhere that the fork is a fork, and a tab can be rebuilt from its snapshot in the gap between the cut
     * and the send, a page reload, the popped window hydrating the same strip. A rebuilt tab used to come back
     * with its draft, its bubbles and every pill intact, minus this one in-memory field: its first send then
     * opened an ordinary empty conversation daemon-side, and the agent answered a chat that LOOKED continued
     * while knowing nothing that came before. */
    readonly pendingForkOf = ref<{ conversationId: string; keep: number; files: "then" | "now" } | undefined>(undefined);

    // Aborts the in-flight ATTACH STREAM when the user hits Stop / closes the tab; cleared once the stream
    // settles. The turn itself runs detached on the daemon, only /agent/stop cancels it.
    private inflight: AbortController | null = null;

    // The Stop request whose successful response means the daemon's detached run has completely settled and
    // released this conversation. The local attach aborts immediately for a responsive UI, so without this
    // barrier the next message can otherwise reach /agent during the daemon's cleanup tail and receive a false
    // "another window" conflict from the run it just stopped itself.
    private stopping: Promise<void> | undefined;

    // The in-flight reattach probe (see reattach), aborted by a send so the two never race one run.
    private probe: AbortController | undefined;

    // Set by abort(), a Stop, a closed tab, a sandbox switch, and cleared whenever a turn starts or the user
    // submits again. An INTERRUPTED turn must not flush the queue: someone who just stopped the agent did not
    // ask for another turn to start on its own. The queued messages stay put and ride the user's next send.
    private interrupted = false;

    // True while drainQueue owns the idle flush (it is awaiting the turn that carries the queue), so a second
    // drain, the settle hook, a fresh submit, can't send the same messages twice.
    private flushing = false;

    // `conversationId` is the conversation's whole identity, the key the daemon puts on the fleet registry
    // entry and the worktree, the strip puts on the tab, and the transcript mirror puts on the cache entry. It
    // survives provider/harness switches (which retire sessions) and reloads (persisted in the tab snapshot).
    // A readable word pair rather than a UUID, because this string is READ far more than it is dereferenced,
    // it is the branch, the worktree directory and the name on every board card; see newConversationId.
    constructor(readonly conversationId: string = newConversationId()) {
        this.seedPicks();
    }

    /* WHAT A CHAT NOBODY HAS TOUCHED STARTS ON: the last deliberate composer pick (turnDefaults /
     * accountPreference), resolved against what this sandbox can actually run.
     *
     * TWO CALLERS, AND THE SECOND IS THE REASON THIS IS A METHOD. A fresh conversation is seeded here at
     * construction; and "New agent" hands back the untouched draft that is already open rather than minting a
     * twin (useChat.draftConversation, which is what keeps a second press from reading as a press that did
     * nothing), so that draft has to be re-seeded or the press opens a chat wearing whatever was remembered
     * when the tab happened to be created — which after a pick made anywhere since is a model the user did not
     * choose, sitting under a heading that says "New agent".
     *
     * Safe there precisely because the draft is UNTOUCHED: no words, no title, no turn, nothing decided about
     * it. And it costs a deliberate pick nothing, since a pick made in that very draft is by definition the one
     * being re-seeded from.
     *
     * The account reads THIS conversation's resolved provider rather than the remembered pick again: the two
     * differ exactly when the pick cannot run, and reading the pick here would hand the chat another provider's
     * account. `fast`, `tierHold`, `actsAs`, `workflowId` and `loopId` are deliberately NOT here; each says on
     * its own declaration why it is never sticky. */
    seedPicks(): void {
        const provider = rememberedProviderFor();
        this.provider.value = provider;
        this.harness.value = turnDefaults.harness.value;
        this.account.value = rememberedAccountFor(provider);
        this.model.value = rememberedModelFor(provider);
        this.effortPick.value = turnDefaults.effort.value;
        this.thinking.value = turnDefaults.thinking.value;
        // Born displaced when the pick could not run and something else was substituted for it (see movedFrom).
        const picked = turnDefaults.provider.value;
        this.movedFrom.value = picked === provider ? undefined : { provider: picked, value: rememberedModelFor(picked) };
    }

    // Switch the provider this conversation's next turn runs on and re-scope its provider-specific settings:
    // the model repoints to the new provider's remembered/live-default pick (the effort scale follows the model,
    // through Conversation.effort). Writes the pick back to the module default so the next new chat inherits it. Mid-chat,
    // the switch takes effect at the next send, the current session is retired then and the new provider's
    // fresh session is seeded with the transcript so far (see send); browsing the picker never destroys it.
    selectProvider(next: AgentProvider): void {
        if (!this.pointAt(next)) {
            return;
        }
        // A choice, so there is no longer a fallback owed back: wherever the app had moved this chat from, the
        // user has now said where it runs.
        this.movedFrom.value = undefined;
        rememberPick({ provider: next, value: this.model.value });
    }

    /* THE SAME SWITCH, MADE BY THE APP RATHER THAN BY THE USER, the connection safety net moving a chat off a
     * provider it cannot send to (useChat). It re-scopes exactly as a pick does, and deliberately does NOT write
     * the module default: a fallback is the app coping, not the user choosing, and persisting it turned one
     * unlucky moment into every later chat's starting provider, the "my model keeps coming back as GPT" report.
     * The user's remembered provider survives untouched, so the next reload opens on it again.
     *
     * What it DOES record is the pick it moved this chat off (`movedFrom`), so the move can be undone later for
     * this chat alone. The FIRST displacement is the one kept: a chat pushed Claude → trial → Codex across two
     * unlucky loads is owed Claude back, not the trial it was parked on in between. */
    repointProvider(next: AgentProvider): void {
        const from: TurnPick = { provider: this.provider.value, value: this.model.value };
        if (!this.pointAt(next)) {
            return;
        }
        this.movedFrom.value ??= from;
    }

    /* GIVE THE FALLBACK BACK, now that the provider the app moved this chat off can serve it again. The mirror of
     * repointProvider and the only thing that ever undoes one: a chat nobody moved has nothing to return to, and
     * a chat whose user has picked since is where they put it.
     *
     * Not a pick either, so nothing is written to the module defaults: putting a conversation back where it was
     * says as little about what the user wants next as moving it away did. */
    restoreProvider(): void {
        const from = this.movedFrom.value;
        if (from === undefined || this.streaming.value) {
            return;
        }
        this.pointAt(from.provider);
        // The model it was displaced FROM, not the provider's remembered one: two drafts on two Claude models
        // parked by the same outage are owed their own back, which is this whole change in one line.
        this.model.value = from.value;
        this.movedFrom.value = undefined;
    }

    // Point this conversation at a provider and re-scope everything that was scoped to the old one. False when
    // the switch is refused (mid-stream, or already there), so only a switch that happened is remembered.
    private pointAt(next: AgentProvider): boolean {
        if (this.streaming.value || next === this.provider.value) {
            return false;
        }
        this.provider.value = next;
        // Switching back to the session's own runtime restores its account, so the next send resumes it.
        this.account.value = next === this.session.value?.provider ? this.session.value.account : rememberedAccountFor(next);
        this.model.value = rememberedModelFor(next);
        // The old segment's live model and context meter don't describe the next turn.
        this.activeModel.value = null;
        this.contextUsage.value = undefined;
        // …nor does the model it ran on: the next turn opens a fresh session on the new provider, so there is
        // no cached prompt for a later model swap to be measured against.
        this.sentModel = undefined;
        this.refreshSwitchNotice();
        return true;
    }

    /* THE THREE TURN-SETTING WRITES, all shaped the same way: apply to THIS conversation, and remember the pick
     * as the seed for the next new chat. They live here rather than in useChat because a conversation is not
     * always the active tab, the suggested-session box drives a draft that has no tab at all yet, through
     * the same model picker and the same effort segments (SuggestedSessionBox.vue). useChat's identically-named
     * facades are these, bound to the active tab.
     *
     * One picker row = provider + model; the harness is a separate axis (the picker's footer chips), so a model
     * pick keeps the current harness. A cross-provider pick re-points the selection and the fresh session starts
     * lazily at the next send. Mid-stream, only a same-provider model swap is allowed, a provider switch is not,
     * because it retires the session the stream is running on. */
    selectModel(pick: TurnPick): void {
        if (this.streaming.value && pick.provider !== this.provider.value) {
            return;
        }
        // `pointAt` rather than `selectProvider`, and a no-op when the row's provider is already this chat's: the
        // pair is remembered ONCE, below, with the model the user actually pressed. Routing through the provider
        // setter wrote the memory twice, the first time pairing the new provider with the OLD one's model.
        this.pointAt(pick.provider);
        this.model.value = pick.value;
        // A choice, so nothing is owed back: see selectProvider.
        this.movedFrom.value = undefined;
        rememberPick(pick);
        /* A SAME-PROVIDER MODEL SWAP GETS A DIVIDER TOO, which it did not until this line, and the silence was
         * read as "this one is free". It keeps the session where a provider switch retires it, so the sentence
         * it earns is a different one (modelSwitchNotice), but it is not nothing: the next turn re-reads the
         * whole conversation on a model that has never seen it, and on a metered-per-model plan it spends a
         * different allowance from the one this chat has been spending. */
        this.refreshSwitchNotice();
    }

    // The effort PICK, which is not always the effort in force: Conversation.effort clamps it to whatever scale
    // the current model and thinking flag actually offer, so a `max` pick survives a trip through a model that
    // tops out at `high` rather than being silently rewritten to it.
    setEffort(value: string): void {
        this.effortPick.value = value;
        turnDefaults.effort.value = value;
    }

    // No effort clamp here: turning thinking OFF invalidates a `max` pick (the API rejects the pair), and
    // `effort` already answers for it, thinking is one of the three inputs it clamps against, so the segments
    // and the next turn both follow this flip on their own.
    setThinking(value: boolean): void {
        this.thinking.value = value;
        turnDefaults.thinking.value = value;
    }

    // Not written to turnDefaults, see the `fast` ref. Switching it also drops the last answer: the notice
    // under the composer describes a turn that ran under the OLD setting, and leaving it up next to a freshly
    // flipped toggle reads as the answer to the flip.
    setFast(value: boolean): void {
        this.fast.value = value;
        this.fastMode.value = undefined;
    }

    // Not written to any global default, see the `tierHold` ref. The last answer stays up, unlike setFast's:
    // "ran on the cheaper model" remains true of the turn it describes whatever the toggle now says, and it is
    // the sentence that explains what the freshly flipped hold is FOR.
    setTierHold(value: boolean): void {
        this.tierHold.value = value;
    }

    /* Point the conversation's next turn at a specific account of its current provider (the account switcher).
     * Mid-chat, an account change, like a provider change, retires the session at the next send.
     *
     * ALLOWED WHILE A CARD WAITS ON THE USER, which is the one guard here that reads `generating` rather than
     * `streaming`, and the difference is the whole point of the two flags existing. This write lands on the NEXT
     * turn: the parked turn keeps the credential it spawned with, whatever this says, so nothing about the run in
     * flight moves under it. And the moment the rule mattered most was exactly the one it used to refuse, an
     * allowance refused mid-conversation puts a card on screen, and the answer to it is usually "on a different
     * account" — the switcher greyed out while the composer sat there ready to send was the app declining to be
     * pointed at the fix.
     *
     * The divider is owed rather than drawn (see switchedMidTurn): the transcript's tail belongs to the card. */
    selectAccount(id: string): void {
        if (this.generating.value) {
            return;
        }
        this.account.value = id;
        selectedAccountId.value = { ...selectedAccountId.value, [this.provider.value]: id };
        this.switchedMidTurn = this.switchedMidTurn || this.streaming.value;
        this.refreshSwitchNotice();
    }

    // Switch the harness (native runtime vs the Claude Code loop) for the next turn. The model is kept, the
    // catalog is harness-independent now (codex/grok run the same subscription ids either way). Writes the pick
    // back to the module default so the next new chat inherits it. Mid-chat this retires the session at the next
    // send, exactly like a provider/account switch, the runtimes mint incompatible sessions. Meaningful only for
    // codex/grok; claude is always its own loop.
    selectHarness(next: AgentHarness): void {
        if (this.streaming.value || next === this.harness.value) {
            return;
        }
        this.harness.value = next;
        turnDefaults.harness.value = next;
        this.activeModel.value = null;
        this.contextUsage.value = undefined;
        // A retired session takes its prompt cache with it, exactly as a provider switch does (pointAt).
        this.sentModel = undefined;
        this.refreshSwitchNotice();
    }

    // Retract the pending "switched" divider, the change it announced is no longer what the next send does.
    private dropSwitchNotice(): void {
        const noticeId = this.pendingSwitchNoticeId;
        if (noticeId === undefined) {
            return;
        }
        this.transcript.write((state) => ({ ...state, messages: state.messages.filter((message) => message.id !== noticeId) }));
        this.pendingSwitchNoticeId = undefined;
    }

    /* WHAT THE NEXT MESSAGE DOES DIFFERENTLY, in one line, or undefined when it does nothing differently.
     *
     * Two kinds of switch reach this, and they cost opposite things, which is why one sentence could never
     * cover both. A provider / account / harness switch RETIRES the session: the next send opens a fresh one
     * and the daemon re-seeds it from its own record. A same-provider model swap KEEPS it, so nothing is
     * retired and nothing is re-seeded, and it used to say nothing at all, which read as "this one is free".
     *
     * It isn't. A prompt cache belongs to one model, so the resumed turn re-reads every token of the
     * conversation on a model that has never seen it, and that is the whole cost of a model swap made twenty
     * turns deep. Where the plan meters models separately (Claude's weekly per-model pools) it also moves the
     * spend onto a different allowance, which the account's own reading can name and count. */
    private segmentSwitchNotice(): string | undefined {
        const session = this.session.value;
        const started = this.messages.value.length > 0 || session !== undefined;
        if (!started || resumes(session, this.turnSettings())) {
            return undefined;
        }
        // ACP providers have no tab entry, the shared label fallback (capability name layered by the picker,
        // else the raw id) covers them.
        const label = providerTabs.find((tab) => tab.value === this.provider.value)?.label ?? providerLabel(this.provider.value);
        // Unconditional now: what carries over is the DAEMON's record of this conversation, not what this window
        // happens to have painted. The notice used to hedge for a restored codex/grok tab, whose transcript no
        // reader could reach, that gap closed when the daemon started recording every runtime's turns itself.
        return `Switched to ${label}: your next message starts a fresh session with the conversation so far carried over.`;
    }

    // The other half: the swap that keeps everything and still costs something. See segmentSwitchNotice above.
    private modelSwitchNotice(): string | undefined {
        /* Nothing sent yet on this segment, or the pick is back where the last turn left it: there is no warm
         * cache to lose and no allowance to move, so there is nothing to say.
         *
         * This is also the whole guard against a provider switch drawing two lines. A switch that retires the
         * session clears `sentModel` on its way through (pointAt, selectHarness), so by the time the segment's
         * own sentence is written there is no model swap left to report beside it. */
        if (this.sentModel === undefined || this.sentModel === this.model.value) {
            return undefined;
        }
        return `Switched to ${this.modelLabel()}${this.allowanceNote()}`;
    }

    // The picked model, named the way the picker names it.
    private modelLabel(): string {
        return modelLabelFor(this.provider.value, this.model.value);
    }

    /* WHOSE ALLOWANCE THE NEW MODEL SPENDS, when the plan meters that model on its own and this sandbox has a
     * reading for the account serving the turn. Empty for every provider and plan that publishes no per-model
     * pool, which is all of them but Claude today: naming an allowance we cannot see would be inventing one,
     * and this notice's only claim to being worth reading is that every figure in it came from the provider.
     *
     * The floor mark rides along (formatUtilization), because a reading taken twenty minutes ago can only have
     * climbed since. The reset instant is spent only on a pool that is effectively spent, where "when does it
     * come back" is the question the number raises; below that it is a date nobody asked for. */
    private allowanceNote(): string {
        const model = { id: this.model.value, label: this.modelLabel() };
        const usage = usageStatusFor(this.provider.value, this.account.value, model);
        const allowance = modelAllowance(usage, model);
        if (usage === undefined || allowance === undefined) {
            return ``;
        }
        const resetsAt = allowance.percent >= SPENT_PERCENT ? allowance.resetsAt : undefined;
        return ` · ${allowance.name} ${formatUtilization(allowance.percent, isStale(usage))} used${
            resetsAt === undefined ? `` : `, resets ${formatReset(resetsAt)}`
        }`;
    }

    /* Upsert/remove the one pending "switched" divider as the user toggles provider / account / harness /
     * model: nothing to announce retracts it, otherwise one notice says what the next message does. send()
     * freezes it into the transcript at the segment cut.
     *
     * MID-STREAM IT WAITS. The transcript's tail belongs to the turn being typed into it, so a divider appended
     * under a half-written answer would read as part of that answer, and under a pending card it would sit between
     * the question and the answer to it. Two switches are reachable while a turn is live, a same-provider model
     * swap (selectModel's own rule, since it retires nothing) and an account re-point while the turn is parked on
     * the user (selectAccount); endTurn asks again the moment the turn settles, which is where either divider
     * belongs anyway. */
    private refreshSwitchNotice(): void {
        if (this.streaming.value) {
            return;
        }
        const text = this.segmentSwitchNotice() ?? this.modelSwitchNotice();
        if (text === undefined) {
            this.dropSwitchNotice();
            return;
        }
        const noticeId = this.pendingSwitchNoticeId;
        if (noticeId !== undefined) {
            this.transcript.write((state) => ({
                ...state,
                messages: state.messages.map((message) => (message.id === noticeId ? { ...message, text } : message)),
            }));
            return;
        }
        this.pendingSwitchNoticeId = this.transcript.notice(text);
    }

    /* The settle hook's half of that: the switches that were made WHILE the turn ran and so had nowhere to draw
     * their line at the time. Two of them reach here, and they are asked in the order that keeps them to one line
     * between them, the same order refreshSwitchNotice uses.
     *
     * THE SEGMENT HALF IS GATED ON `switchedMidTurn`, not asked outright, and the gate is the whole care in this
     * method. Asking `segmentSwitchNotice` unconditionally would have every turn on a provider that mints no
     * session ref end by announcing a switch nobody made, `resumes` being false for want of a session rather than
     * for want of a match. The flag says a person really did re-point this conversation during the turn, which is
     * the only thing that distinguishes the two.
     *
     * It only ever ADDS a line, for the same reason as before: nothing pending survives a send. */
    private noticeMidTurnSwitch(): void {
        const text = (this.switchedMidTurn ? this.segmentSwitchNotice() : undefined) ?? this.modelSwitchNotice();
        this.switchedMidTurn = false;
        if (text !== undefined && this.pendingSwitchNoticeId === undefined) {
            this.pendingSwitchNoticeId = this.transcript.notice(text);
        }
    }

    // Mirror the settled transcript to the local cache (see transcriptCache), so reopening this conversation
    // paints from disk rather than waiting on the sandbox. Fire-and-forget, and only where the transcript has
    // settled, a turn ending, a remote transcript landing, never per streamed frame.
    // `authoritative` is the daemon's own replay, which may legitimately shrink the mirror; everything else is
    // this window reporting what it is showing, which can be a fraction of the conversation (see saveTranscript).
    private persist(authoritative = false): void {
        // Timed because an unconfirmed write READS the mirror back before deciding whether it may shrink it
        // (see saveTranscript), so this is two IndexedDB transactions plus a copy of up to 300 messages, and
        // it fires on every turn boundary. `messages` is what its cost scales with.
        void trackPerf(`chat.persist`, { messages: this.messages.value.length, authoritative }, () =>
            saveTranscript(this.conversationId, this.messages.value, authoritative),
        );
    }

    // Paint the locally cached transcript, if there is one and nothing has been rendered yet. Returns whether
    // anything was painted. The daemon still reconciles afterwards and REPLACES this, the cache only decides
    // what the user looks at during the round-trip, so a stale mirror costs a repaint and nothing more.
    async paintCached(): Promise<boolean> {
        if (this.messages.value.length > 0 || this.streaming.value) {
            return false;
        }
        const cached = await readTranscript(this.conversationId);
        // Re-checked after the await: a turn or a reattach may have landed while IndexedDB was reading, and
        // the live transcript always wins over the mirror.
        if (cached === undefined || this.messages.value.length > 0 || this.streaming.value) {
            return false;
        }
        this.transcript.adopt(cached);
        return true;
    }

    /* Seed this conversation as a FORK of `source` cut just before `index`: the turns before that point become
     * this conversation's transcript and its settings ride across, while the source is left completely
     * untouched, that is the whole point of forking over rewinding. No session is carried: a fork is a new
     * conversation daemon-side.
     *
     * The daemon is told where the cut was rather than what was on this screen, so it can copy that prefix of
     * the SOURCE's record into this conversation's own. Two things follow that sending bubbles up never gave:
     * the fork's first turn is seeded with the full recorded turns (tool calls and attachments included, not a
     * prose summary of them), and the fork reads back with its inherited history when it is reopened tomorrow
     * instead of appearing to begin mid-conversation.
     *
     * `files` is the user's own choice between the two forks that are worth telling apart, and it is the reason
     * this takes a mode at all rather than always doing one thing. "now" continues over the workspace as it
     * stands. "then" asks for the files as they were at the cut, which is only expressible in a checkout of the
     * fork's own, so it turns the fork isolated whatever the source was, and a fork of a plain chat that wants
     * the old files becomes an agent on the board. The daemon resolves WHICH commits that means from the
     * source's turn anchors; nothing about the workspace is decided here. */
    forkFrom(source: Conversation, index: number, files: "then" | "now"): void {
        const kept = source.messages.value.slice(0, index);
        this.pendingForkOf.value = { conversationId: source.conversationId, keep: recordedRows(kept), files };
        this.transcript.rebuild(kept);
        this.provider.value = source.provider.value;
        this.harness.value = source.harness.value;
        this.account.value = source.account.value;
        this.model.value = source.model.value;
        // The PICK, not what it currently clamps to, a fork inherits the user's choice, not one model's ceiling.
        this.effortPick.value = source.effortPick.value;
        this.thinking.value = source.thinking.value;
        this.fast.value = source.fast.value;
        // The veto and the last verdict both carry: a fork continues the same conversation's work, so its next
        // turn should be judged, and held, exactly as the source's would have been.
        this.tierHold.value = source.tierHold.value;
        this.lastTier.value = source.lastTier.value;
        // The pick again, for the same reason: a fork inherits the posture the user chose, not the one the
        // source's runtime happened to allow it.
        this.modePick.value = source.modePick.value;
        // "Files as they were" is only sayable in a checkout of one's own, so that choice carries isolation with
        // it; "now" simply keeps the source's placement, main tree or worktree alike.
        this.isolated.value = files === `then` ? true : source.isolated.value;
        // Left null so send() names the fork after its own first message, two tabs sharing one title is the
        // one thing that makes a fork hard to find again.
        this.title.value = null;
    }

    /* GO BACK TO A MESSAGE. The daemon restores the workspace to the checkpoint that turn found, drops the
     * messages after it from its record, and forgets the provider session; this then makes the tab agree.
     *
     * The two indices are different numbers and mixing them is the bug this method exists to not have.
     * `message.rewindIndex` is the position in the DAEMON's transcript, what the route addresses, while the
     * slice below is over the BUBBLES, which additionally carry local notices the daemon never recorded.
     *
     * The local session is dropped to match the daemon's: the next send then starts a fresh provider thread
     * rather than resuming one whose context still describes the edits just rolled back. Returns false when
     * the daemon refused (a turn is running, or that message has no checkpoint), the tab is left untouched,
     * because a transcript cut against a workspace that never moved is the one state with no way back. */
    async rewindTo(message: ChatMessage, reason: "rewind" | "edit" = `rewind`): Promise<boolean> {
        const index = message.rewindIndex;
        const bubble = this.messages.value.indexOf(message);
        if (index === undefined || bubble < 0) {
            return false;
        }
        const response = await sandboxRequestVia(this.at, `/agent/rewind`, jsonBody(`POST`, { conversationId: this.conversationId, index }));
        if (!response.ok) {
            this.error.value =
                response.status === 409 ? `This agent is running a turn, stop it before going back.` : `That message can no longer be gone back to.`;
            return false;
        }
        const dropped = this.messages.value.length - bubble;
        /* THE REBUILD BELOW RENUMBERS EVERY SURVIVING BUBBLE FROM ZERO, so an edit armed on one of them is now
         * pointing at an id that means something else, see `editing`. Disarmed here rather than left to be
         * noticed later, because the failure it prevents is silent: the edit would still find "a" message and
         * replace the wrong turn. submitEdit's own rewind comes through here too, which is harmless, it has
         * already read what it needed and clears the mode itself a line later. */
        this.editing.value = undefined;
        this.transcript.rebuild(this.messages.value.slice(0, bubble));
        /* SAY WHAT JUST HAPPENED TO THE FILES, in the place the dropped messages used to be. A rewind is the one
         * move here that changes the workspace without anything on screen showing it: the bubbles simply end,
         * and a transcript that merely stops is indistinguishable from one that was always that short. The line
         * names both halves, what left the conversation and what happened on disk, because it is the only
         * record either of them ever gets. */
        /* An EDIT says so in its own words. The two moves are the same underneath and must not read the same on
         * screen: "went back to here" over a line the user is about to re-ask describes the mechanism rather
         * than the intent, and leaves the transcript looking as though a rewind and a fresh prompt happened to
         * land together. Named for what the reader did, the line is the only record that the prompt below it
         * replaced one, the old wording is kept exactly for the rewind that really is just going back. */
        this.transcript.notice(
            reason === `edit`
                ? `Edited this message, ${dropped} message${dropped === 1 ? `` : `s`} dropped and the files restored to this point.`
                : `Went back to here, ${dropped} message${dropped === 1 ? `` : `s`} dropped and the files restored to this point.`,
        );
        this.session.value = undefined;
        this.error.value = null;
        this.persist(true);
        return true;
    }

    /* AIM THE COMPOSER AT A MESSAGE ALREADY SENT. Nothing is destroyed here and nothing is sent, see `editing`
     * for why the whole gesture hangs on that. What this does is move the old prompt and its files back into the
     * box, stash whatever they displaced, and let the transcript draw what the send would drop.
     *
     * Refused for a message with no checkpoint behind it: an edit whose files could not go back would leave the
     * new turn reasoning about a workspace the restated prompt never produced, which is exactly the incoherent
     * half-measure the daemon's rewind refuses to perform (agent/rewind.ts). The surfaces grey the control out
     * for the same reason, so reaching this branch is a race rather than a click. */
    beginEdit(message: ChatMessage): boolean {
        if (message.role !== `user` || message.rewindIndex === undefined || !this.messages.value.includes(message)) {
            return false;
        }
        this.editing.value = { id: message.id, restore: this.draft.value, attachments: this.attachments.value };
        this.draft.value = message.text;
        /* The prompt's OWN files come back with its words, a message is what was attached as much as what was
         * typed, and an edit that silently dropped the screenshot would re-ask the question without the half of
         * it that made it answerable. They are already on disk (the send that placed them uploaded them), so
         * they are re-staged as finished chips rather than re-uploaded. No `previewUrl`: this chip did not mint
         * one, so it must not own one either (removing it would revoke a URL the bubbles still on screen are
         * drawn from). The thumb comes from the path, like every other redraw of these bytes, and a chip whose
         * path this page has never fetched falls back to its name while it loads. */
        this.attachments.value = (message.attachments ?? []).map((path): PendingAttachment => ({
            id: uuid(),
            name: basename(path),
            path,
            status: `done`,
            progress: 100,
        }));
        return true;
    }

    /* PUT IT ALL BACK. The draft and the chips return to exactly what they were before the pencil, because the
     * mode's promise is that abandoning it costs nothing, and a composer that came back empty would have eaten
     * a message the user was part-way through writing.
     *
     * The re-staged chips are NOT revoked on the way out: their preview URLs belong to the transcript bubble
     * this edit borrowed them from, which is still on screen and still drawing them. */
    cancelEdit(): void {
        const edit = this.editing.value;
        if (edit === undefined) {
            return;
        }
        this.draft.value = edit.restore;
        this.attachments.value = [...edit.attachments];
        this.editing.value = undefined;
    }

    /* SPEND THE EDIT, the one press that destroys anything, and it does the two halves in the order that
     * survives a failure between them: rewind first, send only if it landed.
     *
     * Backwards would be unrecoverable. A message sent against a workspace still holding the turns it was meant
     * to replace starts an agent on the wrong files, and the rewind that followed would then cut the transcript
     * out from under a running turn, the exact interleaving the daemon's rewind lease exists to make
     * impossible. This way a refused rewind (a turn is running, the checkpoint is gone) leaves the chat
     * untouched with its reason on screen, and the edit is still armed for another try.
     *
     * The mode is cleared BETWEEN the two, so the send appends to a transcript that is no longer drawing
     * anything as doomed. */
    async submitEdit(text: string, attachments: readonly ChatAttachment[] = [], editorContext?: EditorContext): Promise<boolean> {
        const edit = this.editing.value;
        if (edit === undefined) {
            return false;
        }
        const message = this.messages.value.find((candidate) => candidate.id === edit.id);
        if (message === undefined) {
            // The row left the transcript under an open editor, another window rewound, or a watch replayed a
            // shorter record. There is nothing to edit any more, so the mode ends rather than aiming at whatever
            // has since taken that place.
            this.editing.value = undefined;
            this.error.value = `That message is no longer in this conversation.`;
            return false;
        }
        if (!(await this.rewindTo(message, `edit`))) {
            return false;
        }
        this.editing.value = undefined;
        await this.enqueue(text, attachments, editorContext);
        return true;
    }

    /* SPEAK AS THE AGENT, place the user's words into the transcript as an assistant bubble, with no turn and
     * no reply. The daemon appends the row to its record marked `placed` and forgets the provider session in
     * the same breath; this then makes the tab agree, the same two halves as a rewind.
     *
     * The local session drop mirrors the daemon's and is just as important here: a next send that still
     * carried a session id would ask the daemon to resume a thread it has already retired. Dropped, the next
     * turn opens fresh and is seeded from the record, where the placed line reads as the agent's own words.
     *
     * Returns false when the daemon refused; the tab is left untouched, because a bubble drawn for a row the
     * record never took would be the transcript lying about itself. In a CHANNEL conversation (a Discord
     * mention's thread) the daemon also carries the line out to the channel before it appends, so a refusal
     * here can be the channel being unreachable, and its sentence (the sandboxError branch) is the one thing
     * that tells the user which audience missed the message. */
    async placeAsAgent(text: string): Promise<boolean> {
        const path = `/agents/${encodeURIComponent(this.conversationId)}/place`;
        const response = await sandboxRequestVia(this.at, path, jsonBody(`POST`, { text }));
        if (!response.ok) {
            this.error.value =
                response.status === 409
                    ? `This agent is running a turn: wait for it to finish before speaking as it.`
                    : response.status === 404
                      ? `Could not place the message: this conversation hasn't run a turn yet.`
                      : `Could not place the message, ${(await sandboxError(response, { method: `POST`, path })).message}`;
            return false;
        }
        this.transcript.append({ role: `assistant`, text, placed: true });
        this.session.value = undefined;
        this.error.value = null;
        this.persist(true);
        return true;
    }

    /* THE FILES MOVED UNDER THIS CONVERSATION, and not by anything it did, somebody restored a checkpoint from
     * the Checkpoints timeline while this chat was open.
     *
     * Worth a line for the same reason the rewind above is: the agent's context still describes the workspace as
     * it was a moment ago, and nothing else on screen would ever say otherwise. This is the smaller half of that
     * problem (the transcript is intact, only the disk moved), which is exactly why it is a notice and not a
     * truncation, what the reader needs is to know that the next turn starts somewhere else. */
    noteWorkspaceRestored(): void {
        this.transcript.notice(`The workspace was restored to an earlier point, the files below this line have changed.`);
        this.persist(true);
    }

    // Redraw the rows of a transcript the daemon replayed, leaving every other property of the conversation
    // alone. This is the whole of what a RESTORED tab needs: it already carries its own session, title,
    // provider and isolation from the tab snapshot, and overwriting those with the history-menu defaults below
    // would quietly move an isolated agent's next turn onto the main tree. The rows are drawn as they arrive:
    // they are the same rows every window watched being written, so there is nothing to translate.
    restoreMessages(messages: readonly TranscriptRow[], page?: { readonly from: number; readonly more: boolean }): void {
        // A replayed record is a different transcript wearing the same ids (see `editing`), so an edit armed
        // against the one being replaced cannot survive it, the message it named may not be in the new record
        // at all, and the id it named certainly means something else now.
        this.editing.value = undefined;
        this.transcript.rebuild(messages);
        /* And the cursor moves with them. A redraw REPLACES what is drawn, so whatever was paged in before it
         * is gone from the pane and the offer to page back has to describe the new window rather than the old
         * one — a stale `historyFrom` would fetch a page that no longer sits above anything on screen. A caller
         * with no page to report (a local mirror, a fork's inherited rows) is holding rows whose position in
         * the record it cannot vouch for, and says so by leaving the cursor at "this is all of it". */
        this.historyFrom.value = page?.from ?? 0;
        this.historyMore.value = page?.more ?? false;
        this.error.value = null;
        this.persist(true);
    }

    /* THE PAGE ABOVE WHAT IS DRAWN, for a reader who has reached the top of the window the chat opened on.
     *
     * Rows are PREPENDED, never rebuilt: the reader is looking at this transcript, a turn may be streaming into
     * it, and rebuilding would drop the live turn on the floor for the same reason restoreMessages is refused
     * mid-stream. Concurrent presses are held off by `loadingOlder` rather than queued, because two pages
     * fetched against the same cursor are the same page twice.
     *
     * A failed read leaves the cursor alone and says nothing: the button comes back, and pressing it again is
     * the retry. Nothing here can cost the reader what is already on screen.
     *
     * Deliberately NOT persisted to the local mirror. The mirror exists to paint an opening tab in the same
     * tick (transcriptCache.ts), and what a tab opens on is the window the daemon serves — growing it by a
     * page every time somebody reads back through a long conversation would mirror the whole record to disk
     * one press at a time, which is the cost this window exists to stop paying. */
    async loadOlder(): Promise<void> {
        if (this.loadingOlder.value || !this.historyMore.value || this.historyFrom.value <= 0) {
            return;
        }
        this.loadingOlder.value = true;
        try {
            const page = await olderTranscriptPage(this.conversationId, this.historyFrom.value, this.at);
            if (page === `gone` || page.messages.length === 0) {
                // Nothing above after all: stop offering, rather than leaving a button that answers with nothing.
                this.historyMore.value = false;
                return;
            }
            this.transcript.prepend(page.messages);
            this.historyFrom.value = page.from;
            this.historyMore.value = page.more;
        } catch {
            // A tunnel hiccup on a read the reader asked for by hand. The transcript is untouched and the offer
            // stands, so the retry is the same press again.
        } finally {
            this.loadingOlder.value = false;
        }
    }

    /* HOW THE LAST TURN ENDED, AS THE DAEMON HAS IT (AgentTranscriptSchema.ending), taken by a tab that never
     * watched it happen. The record's verdict arrives as the whole pick-up rather than a bare "it stopped", so
     * the offer a reopened chat makes is the same offer the watching window made, down to the countdown and to
     * what the press DOES.
     *
     * `pickUp` used to be arm-able ONLY by the stream that watched a turn die, which quietly made the press a
     * property of the WINDOW rather than of the conversation. Every other way of arriving at the same stopped
     * session therefore had nothing: a Stop pressed on the board with the chat closed (which posts the cancel
     * straight to the daemon, agentActions.stopAgent), a session stopped on another device, a tab closed and
     * reopened from its card, a turn the daemon was killed under. All of them left a chat whose only way on was
     * typing the word by hand, which is the exact typing this state exists to do once.
     *
     * AND THE ENDING THAT NEEDED IT MOST WAS THE ONE THE RECORD COULD NOT DESCRIBE. A spent allowance reopens
     * hours later, so the window that met it is reliably gone by the time the press would work; while the wire
     * carried a boolean it could not say "limit" at all, and the chat someone came back to in the morning
     * offered nothing. Now it says which ending, when the allowance is due, whether the turn is still held, and
     * whether a fire is already booked — the four facts that separate a live press from a countdown and a
     * re-run from an appended "Continue".
     *
     * FOUR REFUSALS, and each is a case where the record is not the last word:
     *   · the record says the turn ENDED ON ITS OWN (no ending at all), which is most of them and the reason
     *     this is asked here rather than at the call site: what a record can settle about the chat in front of
     *     the user is this conversation's judgement to make;
     *   · a LIVE turn, where the record describes the turn BEFORE it and beginTurn has already cleared the
     *     pick-up for the one that is running;
     *   · a pick-up ALREADY HELD, which is this window's own live reading of the same turn and carries the
     *     things only a window can know: an outage resume ARMED here, with a probe running and a countdown on
     *     screen, is state no record has (the daemon's breaker is per-conversation but the arming is a press
     *     made in this pane), and a hydrate that overwrote it would take the countdown off a chat that really
     *     is waiting on one. Hydrates are frequent; this one costs nothing to refuse, because the case the
     *     record is here for, a window that never saw the turn stop, has no pick-up to refuse;
     *   · an EMPTY transcript, an offer to continue nothing, whose press would open the conversation with the
     *     word "Continue".
     *
     * A HELD TURN THE DAEMON HAS SINCE FORGOTTEN is the one disagreement that survives those refusals, and it
     * needs no guard here: the press asks the daemon, and a daemon no longer holding the turn answers NOT_FOUND,
     * which resumeHeldTurn already reads as "say carry on instead".
     *
     * It arms the OFFER and never the automation, even on a chat with auto-continue switched on: that switch
     * takes the stop in front of it when it is PRESSED (see setAutoContinue), and opening a tab is not a press.
     * A turn started because somebody looked at a chat is the one thing an unattended continuation must not do. */
    adoptEnding(ending: PickUp | undefined): void {
        if (ending === undefined || this.streaming.value || this.pickUp.value !== undefined || this.messages.value.length === 0) {
            return;
        }
        this.pickUp.value = ending;
    }

    // Restore a past conversation pulled from the history menu: build bubbles from the stored transcript and
    // arm its session so the next turn resumes it in the sandbox. Unlike restoreMessages this also seeds the
    // conversation's identity, because the tab it lands in is a fresh one that has none.
    loadTranscript(messages: readonly TranscriptRow[], sessionId: string, title: string | null): void {
        this.restoreMessages(messages);
        // History-menu sessions live in the MAIN tree's session namespace, resuming one in a worktree would
        // miss it. The fleet's own open path rehydrates isolated conversations separately.
        this.isolated.value = false;
        // ...and a turn on the tree the user is looking at plans before it touches anything.
        this.modePick.value = startingMode(false);
        /* The history menu lists Claude sessions only, so a restored conversation resumes on Claude, under the
         * current default Claude account.
         *
         * The ONE place a session's account is still assumed rather than told, and deliberately: a raw runtime
         * session is not a fleet conversation, so no registry entry names what served it (the /sessions routes
         * carry messages and nothing else). The assumption is at least self-consistent, the pin it takes is the
         * one the next send will go out under, so the pair agrees and nothing announces a switch nobody made.
         * A fleet conversation never comes through here: it is opened by conversation id, and the daemon states
         * its binding (AgentTranscriptSchema). */
        const account = rememberedAccountFor(`claude`);
        this.session.value = { id: sessionId, provider: `claude`, account, harness: `native` };
        this.provider.value = `claude`;
        this.harness.value = `native`;
        this.account.value = account;
        this.model.value = rememberedModelFor(`claude`);
        this.title.value = title;
        this.activeModel.value = null;
        // Whatever the restored session last ran on, this window never sent it: nothing here can claim a model
        // swap would cost a cache, so the first send under this tab is what starts measuring again.
        this.sentModel = undefined;
    }

    async send(prompt: string, settings: TurnSettings, attachments: readonly ChatAttachment[] = [], editorContext?: EditorContext): Promise<void> {
        const text = prompt.trim();
        if (text.length === 0 && attachments.length === 0) {
            return;
        }
        // Stop makes the local stream idle before the daemon can finish unwinding. A direct send (forks and
        // tests use this path; the composer normally comes through drainQueue) joins that cleanup boundary too.
        if (this.stopping !== undefined) {
            await this.stopping;
        }
        if (this.streaming.value) {
            return;
        }
        // A pending reattach probe must not race this send's own stream over the same run, and the resume this
        // send supersedes must not fire one later either (the daemon clears its own side at turn start).
        this.probe?.abort();
        this.failures.cancelProbe();
        // The session is resumed only while the selection still matches the runtime/account that minted it, a
        // switched provider or account retires it. Nothing is carried up the wire to replace it: the daemon
        // seeds the fresh session from its own record of this conversation, which is keyed by conversationId
        // and therefore still describes the chat the retired session was serving.
        const session = this.session.value;
        const resume = resumes(session, settings) ? session : undefined;
        if (resume === undefined) {
            this.cutSegment();
        }
        // The switch divider (if any) is frozen into the transcript, the segment cut happened.
        this.pendingSwitchNoticeId = undefined;
        /* …and this turn is what the NEXT model swap is measured against: the pick it goes out under is the one
         * the provider will have a warm prompt cache for.
         *
         * Read off the conversation's own ref rather than off `settings`, which is the same string on every
         * path that matters (drainQueue builds them from turnSettings) and is NOT on a caller that hands in a
         * selection this chat never made. Both sides of the comparison therefore read one ref, and no caller
         * can manufacture a swap nobody performed. The cost is a divider missed if the pick moves inside this
         * method's own awaits, which is the right way round: a line that isn't there beats a line that lies. */
        this.sentModel = this.model.value;
        // A fork names its origin on its first turn: this send is what makes the daemon copy the rows. Consumed
        // on the daemon's ack below, not here, a send refused at the door produced nothing, and a linkage
        // dropped with it would make the retry quietly open an unrelated conversation.
        const forkOf = this.pendingForkOf.value;
        // First message of a fresh conversation names it, free, no model call. An attachment-only send has no
        // prose to read, so it is named after what was dropped in.
        if (this.title.value === null) {
            this.title.value = deriveTitle(text.length > 0 ? text : attachments.map((file) => file.name).join(`, `));
        }
        /* The user's bubble, drawn NOW so the send reads as sent, and replaced the moment the daemon's head
         * arrives with the row the daemon made of it (the same words, with what the daemon knows: the uploads
         * as chips, the notes it added, the checkpoint it took). It keeps its id across that replacement
         * (transcriptState.attachRun), which is what lets a turn refused before it ran take these exact words
         * back out. */
        const userMessageId = this.transcript.append({
            role: `user`,
            text,
            ...(attachments.length > 0 ? { attachments: attachments.map((file) => file.path) } : {}),
        });
        // Everything but the run, which the daemon only names in the ack below, the head that carries it is
        // what completes this into the context the entries are rendered under.
        const turn: Omit<TurnContext, "run"> = { userMessageId, provider: settings.agent, account: settings.account, harness: settings.harness };
        // This turn starts from the user's pick; the previous turn's live posture (a plan it entered, a mode an
        // approval landed in) is history, and the daemon will echo this one back at init. Only this path clears
        // it, a REATTACHED turn is already running under a posture of its own, and blanking the composer's
        // live pill until the next `mode` frame would be a lie in the other direction.
        this.liveMode.value = undefined;
        const controller = new AbortController();
        this.beginTurn(controller, Date.now());

        // Uploaded attachments plus @-mentioned workspace paths, one wire field, the daemon resolves both the
        // same way (workspace-relative → absolute, folded into the prompt as a Read-tool note). Mentions never
        // render as chips: they're already visible inline in the text.
        const attachmentPaths = [
            ...attachments.map((file) => file.path),
            ...mentionPaths(text).filter((path) => !attachments.some((file) => file.path === path)),
        ];
        try {
            const response = await sandboxRequestVia(this.at, `/agent`, {
                method: `POST`,
                headers: { "content-type": `application/json` },
                signal: controller.signal,
                body: JSON.stringify(
                    turnRequestBody({
                        text,
                        conversationId: this.conversationId,
                        title: this.title.value,
                        isolated: this.isolated.value,
                        runner: this.runner.value,
                        box: this.box.value,
                        mode: this.mode.value,
                        settings,
                        resume,
                        forkOf,
                        attachmentPaths,
                        editorContext,
                    }),
                ),
            });
            /* TURNED AWAY AT THE DOOR, the daemon refused the request before any turn existed, which is a
             * different thing from a turn that failed, and the one failure in this file that used to answer
             * with neither of the two things a refusal owes the user.
             *
             * IT SAYS WHY. The daemon puts a sentence on every refusal it makes (an attachment path outside
             * the workspace, a body its schema rejected); answering with the status code instead left the user
             * holding "400" and no move to make, so they re-send by hand, and every hand-retry started from a
             * fresh tab leaves one more card on the board that never ran and cannot be acted on.
             *
             * AND IT KEEPS THE WORDS. Nothing reached the daemon, so this window holds the only copy: the
             * bubble comes back out of the transcript and waits in the queue for the user's own next send,
             * which is the bargain claude-reauth and unknown-command already strike. This path is just the one
             * where the refusal arrives as an HTTP status rather than as a turn frame.
             *
             * A 409 keeps neither half: a turn IS running on this conversation, so these words are its to take
             * as steering, and the queue has to stay free to flush into it the moment it settles. */
            if (!response.ok) {
                if (response.status === 409) {
                    this.error.value = `This agent already has a turn running: wait for it to finish.`;
                    return;
                }
                const refusal = await sandboxError(response, { method: `POST`, path: `/agent` });
                this.requeueUndelivered(userMessageId);
                this.error.value = `${refusal.message} Your message is held below: send it again once that's sorted.`;
                return;
            }
            // The ack means the turn is running daemon-side regardless of what happens to this tab; from here
            // on this window is just one renderer of the run, and a fork's rows are copied, so its record
            // stands on its own and the linkage is spent.
            this.pendingForkOf.value = undefined;
            const { run } = (await response.json()) as { run: string };
            this.turnAccepted = true;
            this.latchRemoteRegistration();
            await followRun(
                this.conversationId,
                run,
                {
                    ...this.sink,
                    // Every head, the first and every re-attach, replaces this run's rows with the daemon's,
                    // starting at the bubble drawn above, which keeps its id under the daemon's row.
                    attached: (head) => {
                        this.transcript.attachRun(head, userMessageId);
                        return { ...turn, run: head.run };
                    },
                },
                controller,
                this.at,
            );
        } catch (err) {
            // A user-initiated Stop aborts the fetch; that's expected, not an error to surface.
            const stopped = err instanceof DOMException && err.name === `AbortError`;
            /* THE SEND THAT NEVER LEFT, the request itself threw or was aborted, so there was never a turn (see
             * `turnAccepted`). Same bargain as the refusal above, for the same reason: the daemon has no record of
             * these words, so the bubble comes back out of the transcript and waits in the queue for the user's own
             * next send. Leaving it on screen is the shape of the bug this fixes, a message that reads as sent,
             * that no agent will ever see, and that the user can only recover by retyping (and cannot recover at
             * all if they had dropped a file on it).
             *
             * The offer to carry on is refused on the same grounds, one level down in `ended()`: a Stop pressed
             * while this request hung would otherwise arm a press with nothing behind it, which opens a fresh
             * session whose first message is the word "Continue". */
            if (!this.turnAccepted) {
                this.requeueUndelivered(userMessageId);
                this.error.value = stopped ? null : `${errorMessage(err, `Chat failed.`)} Your message is held below, send it again to deliver it.`;
                return;
            }
            if (!stopped) {
                this.error.value = errorMessage(err, `Chat failed.`);
            }
        } finally {
            this.endTurn();
        }
    }

    /* WHAT IT MEANS FOR A TURN TO BE LIVE IN THIS WINDOW, opened and closed in one place. Two paths run one,
     * send() starts a turn, reattach() adopts one already running daemon-side, and each wrote these same
     * assignments out longhand. The pair that has to move together is `streaming` + `inflight`: every
     * affordance the composer offers keys off them, so a path that set one without the other would leave a
     * Stop button attached to nothing. */
    private beginTurn(controller: AbortController, startedAt: number): void {
        this.inflight = controller;
        this.streaming.value = true;
        // Nothing is delivered until the daemon says so (see `turnAccepted`). reattach() sets it straight after
        // this call, the run it adopts is the daemon's already.
        this.turnAccepted = false;
        // Whatever interrupted the last turn is history, so THIS one's clean end may flush the queue.
        this.interrupted = false;
        this.error.value = null;
        // A turn is running, so there is nothing left stopped to pick up, this IS the picking up, or the message
        // the user sent in its place. Either way a scheduled continuation has been overtaken by it.
        this.pickUp.value = undefined;
        this.cancelAutoContinue();
        // A live turn supersedes the waits a failed one opened. THIS turn is the retry, or the send that
        // replaced it, whether the scheduler fired it or another window did.
        this.failures.clear();
        this.turnStartedAt.value = startedAt;
        this.liveTools = new Set();
    }

    // Settle it: drain whatever the typewriter still holds, drop the streaming affordances, mirror the finished
    // transcript, and let anything queued behind the turn go.
    private endTurn(): void {
        // Read before turnStartedAt is cleared: how long this turn ran is what tells the auto-continue ladder
        // whether the last continuation bought anything (autoContinue.ts).
        const ranForMs = this.turnStartedAt.value === undefined ? 0 : Date.now() - this.turnStartedAt.value;
        this.transcript.settle();
        this.inflight = null;
        this.streaming.value = false;
        // An in-turn retry belongs to the turn that was retrying. Whatever it settled as, the wait is over.
        this.providerRetry.value = undefined;
        this.turnStartedAt.value = undefined;
        this.failures.armRenewalProbe();
        // A model swapped or an account re-pointed WHILE this turn ran held its divider back
        // (refreshSwitchNotice won't write into a transcript a turn is still typing into). The turn is over, the
        // tail is ours again, and the line describes the next message, so this is exactly where it goes. A no-op
        // for every other ending.
        this.noticeMidTurnSwitch();
        this.persist();
        this.dropStaleRemoteTranscript();
        this.scheduleAutoContinue(ranForMs);
        void this.drainQueue();
    }

    /* THE WARMED TRANSCRIPT OF A CONVERSATION IN ANOTHER BOX IS NOW ONE TURN OLD.
     *
     * For a conversation in THIS box the roster watch does this: a status change is the one moment the daemon's
     * record can have grown, and it invalidates the cached read (useAgents). A box this browser does not stream
     * has no such moment, so the turn ending HERE is the signal, and this window is the only thing that has it.
     *
     * Without it, a remote tab closed and reopened in the same session replays the copy read before the turn: a
     * transcript ending one turn early, which is the exact answer that cache invalidation exists to prevent.
     * Cheap and idempotent, and a no-op for every local conversation. */
    private dropStaleRemoteTranscript(): void {
        if (this.box.value !== undefined) {
            invalidateAgentTranscript(this.conversationId, this.box.value);
        }
    }

    /* THE STANDING PRESS, SCHEDULED, run at the end of every turn, and does nothing for nearly all of them.
     *
     * The three conditions are the same ones that make the button appear at all, minus the composer's (those are
     * read when the timer fires, since a draft can arrive during the wait): the automation is armed, this turn
     * ended in the one shape a continuation answers, and nobody INTERRUPTED it, a Stop, a closed tab, a sandbox
     * switch. That last one is the important exclusion: restarting a turn somebody just stopped is the exact
     * opposite of what they asked for, and `interrupted` is what tells the two endings apart. */
    private scheduleAutoContinue(ranForMs: number): void {
        const pickUp = this.pickUp.value;
        if (!this.autoContinue.value || this.interrupted) {
            return;
        }
        /* A long turn normally proves the continuation bought something, even if it stopped again afterwards,
         * and starts the short ladder over. A LIMIT NEVER PROVES THAT BY DURATION. Providers and harnesses may
         * spend minutes retrying a closed allowance before reporting the same refusal; amber-forge's turns did,
         * which reset this counter to five seconds forever without producing a word. Keep its rung until a turn
         * ends as something other than a limit. This also resets after a successful long turn (`pickUp` absent),
         * so a later unrelated stop does not inherit yesterday's backoff. */
        if (ranForMs >= AUTO_CONTINUE_PROGRESS_MS && pickUp?.reason !== `limit`) {
            this.autoContinueTries = 0;
        }
        if (pickUp === undefined) {
            return;
        }
        /* SOMETHING ELSE IS ALREADY BRINGING THIS TURN BACK (an outage the daemon's breaker holds), so the
         * automation stands down rather than racing it: two continuations of one stopped turn is the failure
         * mode this whole state exists to make impossible. The strip still says what is happening, and the
         * manual press is still there for anyone who won't wait. */
        if (pickUp.automatic !== undefined) {
            return;
        }
        this.armAutoContinue();
    }

    // Put the next continuation on the clock at whatever rung of the ladder this chat has reached. Ordinary
    // stops have three rungs and then stand down; limits repeat their one-day ceiling until the allowance opens.
    private armAutoContinue(): void {
        const blocker = this.pickUp.value?.reason === `limit` ? `limit` : `transient`;
        const delay = autoContinueDelay(this.autoContinueTries, blocker);
        if (delay === undefined) {
            // The ladder is spent: three turns in a row went nowhere, so something is wrong that continuing does
            // not fix. Stand down and SAY so, an automation that quietly stopped would leave the user waiting on
            // a chat that is no longer waiting on anything.
            this.autoContinue.value = false;
            this.transcript.notice(
                `Auto-continue stopped: ${AUTO_CONTINUE_TRIES} turns in a row ended without getting anywhere. Press Continue to carry on.`,
            );
            this.persist();
            return;
        }
        this.autoContinueTries += 1;
        /* THE LADDER SETS A FLOOR, NOT THE WAIT. A pick-up that names an instant before which nothing gets
         * through (a spent allowance, hours out) makes every earlier rung a guaranteed failure. So the wait is
         * whichever is longer: an armed chat sleeps through a known reset and picks the work up on the far side;
         * only a provider that names no instant walks the interval ladder above. */
        const readyAt = this.pickUp.value?.readyAt;
        const wait = Math.max(delay, readyAt === undefined ? 0 : readyAt - Date.now());
        this.autoContinueAt.value = Date.now() + wait;
        this.autoContinueTimer = setTimeout(() => {
            this.autoContinueAt.value = undefined;
            this.autoContinueTimer = undefined;
            /* SOMEBODY AT THE KEYBOARD OUTRANKS THE TIMER. Words in the composer, a staged file, a message
             * already queued: each is the user's own answer to "what happens next", and firing a bare "Continue"
             * over one would start a turn they did not ask for and did not see coming. The automation stays
             * armed, it simply lets this stop go by, and the send they are in the middle of is what continues
             * the chat instead. */
            if (this.draft.value.trim() !== `` || this.attachments.value.length > 0 || this.queued.value.length > 0 || this.streaming.value) {
                return;
            }
            // The same press the button makes, so a held turn is RE-RUN here too. Which matters more for the
            // automation than for the button: unattended, this fires three times against one stopped turn, and
            // three appended "Continue"s is the shape of the pile that made a chat unreadable in the first place.
            void this.continueTurn();
        }, wait);
    }

    // Drop a pending continuation: a turn starting (it has been overtaken), the automation being switched off,
    // the tab going away. Leaves the ladder where it is, a turn that got somewhere resets that, and so does
    // arming the switch again; nothing else should.
    private cancelAutoContinue(): void {
        clearTimeout(this.autoContinueTimer);
        this.autoContinueTimer = undefined;
        this.autoContinueAt.value = undefined;
    }

    /* The switch itself, and the one thing it does beyond flipping the flag: turning it OFF drops whatever it had
     * already scheduled, because the press people reach for it with is "not that, not now". Turning it ON starts
     * from the front of the ladder, arming an automation is a fresh instruction, not a resumption of the one
     * that gave up. It does not schedule anything by itself: the next turn to stop short is what does that. */
    setAutoContinue(on: boolean): void {
        this.autoContinue.value = on;
        this.autoContinueTries = 0;
        // No persist(): that mirrors the TRANSCRIPT, and nothing was said. The switch rides the tab snapshot,
        // which the strip's own reactivity carries out of snapshotTab (tabSnapshot.ts).
        if (!on) {
            this.cancelAutoContinue();
            return;
        }
        /* ARMED ON A CHAT THAT IS ALREADY STOPPED, which is exactly where the switch is offered, takes that
         * stop too. The press means "and get on with it"; waiting for the NEXT one would ask the user to press
         * Continue as well, and not pressing Continue is the entire point. No `interrupted` guard here, unlike
         * the turn-end path: somebody who stops a turn and then arms this is asking for that turn to carry on. */
        if (this.pickUp.value !== undefined && this.pickUp.value.automatic === undefined && !this.streaming.value) {
            this.armAutoContinue();
        }
    }

    /* The composer's one send path, the message is accepted whatever the conversation is doing, and the
     * conversation works out how to deliver it (Claude Code's queue-and-steer):
     *   idle          → it starts a turn immediately, together with anything already queued behind it;
     *   turn running  → it is handed to that turn where the harness takes mid-turn input (injected between
     *                   tool calls), and otherwise waits for the turn to settle and goes as the next one.
     * An empty message with a non-empty queue is the user pressing Send on the queue itself, so it just drains.
     */
    enqueue(text: string, attachments: readonly ChatAttachment[] = [], editorContext?: EditorContext): Promise<void> {
        const trimmed = text.trim();
        // The user is driving again, a Stop's hold on the queue is released (see `interrupted`).
        this.interrupted = false;
        if ((trimmed.length > 0 || attachments.length > 0) && !repeatsNudge({ text: trimmed, attachments }, this.queued.value.at(-1))) {
            this.queued.value = [
                ...this.queued.value,
                { id: uuid(), text: trimmed, attachments, ...(editorContext !== undefined ? { editorContext } : {}) },
            ];
        }
        return this.drainQueue();
    }

    /* WHAT "CARRY ON" ACTUALLY DOES, asked in one place because two callers ask it and an answer that differed
     * between them would be the worse of the two half the time: the press (the continue strip's button, and Enter
     * on an empty composer) and the standing version of that press, auto-continue.
     *
     * A HELD TURN IS RE-RUN; anything else is continued by saying so. The order matters and only one way round is
     * safe: a re-run needs the daemon to still be holding the turn, and the fallback is a message that works
     * whether it is or not, so asking for the re-run first costs a round trip and asking second would cost the
     * user a message they did not mean to send.
     *
     * Returns the words that were sent, or undefined when the held turn was re-run instead and nothing was said.
     * The caller needs the difference: an actual message belongs in the composer's recall ring, so ↑ brings it
     * back for anyone who wants to continue with an instruction attached, and a re-run has no words to put there. */
    async continueTurn(): Promise<string | undefined> {
        if (await this.resumeHeldTurn()) {
            return undefined;
        }
        const text = continuationFor(this.messages.value);
        await this.enqueue(text);
        return text;
    }

    // Drop a queued message before it reaches the agent (the × on its chip).
    removeQueued(id: string): void {
        this.queued.value = this.queued.value.filter((message) => message.id !== id);
    }

    // Take a user bubble the daemon turned away back OUT of the transcript and put it at the FRONT of the
    // queue, held there until the user sends again: a turn refused before it ran produced nothing, so a queue
    // that flushed on its own would just re-fail it.
    private requeueUndelivered(userMessageId: number): void {
        this.interrupted = true;
        const bubble = this.transcript.takeBackUserBubble(userMessageId);
        if (bubble === undefined) {
            return;
        }
        const held = { text: bubble.text, attachments: (bubble.attachments ?? []).map((path) => ({ name: basename(path), path })) };
        // Pressed again while this very turn was failing, so the press is already queued and the words coming
        // back are the same nudge: one of the two is the whole message (see repeatsNudge).
        if (repeatsNudge(held, this.queued.value[0])) {
            return;
        }
        this.queued.value = [{ id: uuid(), ...held }, ...this.queued.value];
    }

    /* WHAT THIS WINDOW DROPS WHEN THE NEXT TURN OPENS A FRESH PROVIDER SESSION, the bookkeeping half of a
     * segment cut. The session ref goes because the credential or runtime that minted it is no longer the one
     * serving this conversation; the terminal and browser go with it because a fresh sdk session runs its Bash in
     * a different tmux session, so the remembered one belongs to the segment that just ended and offering to watch
     * it would point at a shell this conversation no longer uses.
     *
     * Written once because two things cut a segment: an ordinary send under a switched selection, and the press
     * that re-runs a held turn on a switched account (resumeHeldTurn). They used to do it in one place, which is
     * why the press left this window pointed at a retired session. */
    private cutSegment(): void {
        this.session.value = undefined;
        this.agentTerminal.value = undefined;
        this.agentBrowser.value = undefined;
    }

    // Release a hold placed by a failure the user has now fixed (reconnecting a revoked account) and let
    // whatever was held ride immediately. Nothing happens when the queue is empty, so calling it on every
    // conversation after a reconnect is safe.
    resume(): Promise<void> {
        this.interrupted = false;
        this.error.value = null;
        return this.drainQueue();
    }

    /* RUN THE HELD TURN AGAIN, which is what Continue means on an ending the daemon kept the turn for
     * (PickUp.held, and AgentEvent's error `held` for the argument). Reports whether it started; false sends the
     * caller back to the ordinary continuation, which is still right for every ending with nothing held.
     *
     * NO MESSAGE IS APPENDED HERE, and that absence is the entire feature. A press is the same request again, so
     * there is nothing new for the user to have said: the daemon re-runs the turn with a resume note on its
     * prompt, and opens that run on what the note DISCLOSES rather than on the words a second time
     * (sessions/turn-transcript.ts openingRows, sandbox-contract's resumeDisclosure), so the muted line about the
     * interruption goes down where the repeat would have, and the bubble holding their words stays where it is,
     * one turn up. One press, one run, one line saying what happened. The alternative is what this replaces: a
     * bubble reading "Continue" per press, in the record and in the provider session both, and the model reading
     * four of them back as things it had been asked and had not answered.
     *
     * The request only starts the run; watching it is reattach's job, which is also what makes the press safe to
     * spam. A second press while the first one's turn is running finds `streaming` true and stops at the guard;
     * one that slips past it is answered NOT_FOUND by a daemon whose held entry that turn has already cleared.
     *
     * WHAT THE PRESS DOES CARRY IS WHO SERVES IT. The prompt and everything else about the turn stay on the
     * daemon's own copy (see ResumeTurnSchema), but the routing is read off this conversation HERE, at the press,
     * exactly as a send reads it at delivery: a spent allowance is one account's refusal, so the switcher in the
     * composer is what a person reaches for between the refusal and this button, and a press that replayed the
     * refused account bounced off the same limit and left typing the word by hand as the only way through. */
    async resumeHeldTurn(): Promise<boolean> {
        if (this.streaming.value || this.pickUp.value?.held === undefined) {
            return false;
        }
        if (this.stopping !== undefined) {
            await this.stopping;
        }
        const settings = this.turnSettings();
        // The switch this press acts on is also a segment cut: the fresh session the daemon opens for it belongs
        // to the new credential, so this window drops what belonged to the old one (see cutSegment).
        if (!resumes(this.session.value, settings)) {
            this.cutSegment();
        }
        this.pendingSwitchNoticeId = undefined;
        try {
            const response = await sandboxRequestVia(this.at, `/agent/resume`, {
                method: `POST`,
                headers: { "content-type": `application/json` },
                body: JSON.stringify({
                    conversationId: this.conversationId,
                    routing: {
                        agent: settings.agent,
                        harness: settings.harness,
                        account: settings.account,
                        // Same rule as an ordinary send (turnRequestBody): an empty pick is a catalog that hasn't
                        // loaded, not a choice, and the daemon keeps the held turn's model rather than blanking it.
                        model: settings.model || undefined,
                    },
                }),
            });
            if (!response.ok) {
                /* The daemon is not holding it after all: it restarted, or another window has since run a turn
                 * on this conversation. Both are cases where saying "carry on" is the honest move, so the caller
                 * falls back to it rather than reporting a failure at a press that was reasonable to make. */
                return false;
            }
        } catch {
            // The daemon is unreachable. Same answer, for a smaller reason: an offline press must not eat the
            // one affordance the user has, and the ordinary send path already knows how to hold their words.
            return false;
        }
        await this.reattach();
        return true;
    }

    /* THE SESSION AS THE DAEMON HAS IT, adopted whole (the id, the runtime and the credential that minted it,
     * see SessionRef) from the two places the daemon states it: the `session` frame at the head of a turn, and the
     * transcript a reopened tab reads (useChat.replayStoredSession).
     *
     * AND THE ONE THING THE TAB TAKES FROM IT: an account it never picked. A tab with no pin sends no account, and
     * the daemon serves such a turn on whichever connected account has headroom (agent/harness-credentials.ts), so
     * the session came back bound to an account the tab knew nothing about. Left that way two things were wrong
     * at once: the picker highlighted its first row while the card's chip named the account that actually ran,
     * and the next send compared "no pick" against that account (turnRequest.resumes), found no match, and quietly
     * retired a session that resumed perfectly well. A pin the user DID make is never touched here: a session
     * bound elsewhere than the pick is the switch they made and have not sent yet, and the divider already says
     * what it costs. Nor is a conversation homed in another box, whose turns carry no account at all: the id the
     * daemon names is a key in THAT box's store, and pinning it here would hand this box's reconciliation a
     * foreign id to move off. Nor a session of another provider than the tab now points at, for the same reason
     * pointAt reads the session's account only when switching back to its own runtime. */
    bindSession(session: SessionRef): void {
        this.session.value = session;
        if (this.account.value === undefined && this.box.value === undefined && session.provider === this.provider.value) {
            this.account.value = session.account;
        }
    }

    // Move this conversation onto a re-connected credential for the SAME human account. The session ref moves
    // with it: a reconnect mints a new local account id, and leaving the old one on the session would read as a
    // deliberate account switch and retire a live session that resumes perfectly well, the user reconnected to
    // carry on, not to start over.
    rebindAccount(accountId: string): void {
        this.account.value = accountId;
        const session = this.session.value;
        if (session !== undefined) {
            this.session.value = { ...session, account: accountId };
        }
        // Not a switch the user made, the same human account, re-credentialled, so no "switched to…" divider.
        // A pending one is retracted: whatever it announced, the next send now just carries on.
        this.dropSwitchNotice();
    }

    /* Deliver what's waiting, oldest first. A running turn takes them one at a time over /agent/steer; the
     * daemon is the authority on whether it can (a native codex/grok/ACP turn has no steering queue and
     * answers NOT_FOUND), so a refusal simply leaves the message queued for the settle below rather than
     * needing this client to predict the harness. A turn parked on a card is skipped too: the card is what the
     * agent is waiting on, so the message goes in once it's answered (the decide* methods drain again).
     *
     * With nothing running, the whole queue rides ONE fresh turn, "also do Y", written while the agent worked,
     * belongs to the same request as "and Z", not to a turn each. Public so the card decisions can re-drive it:
     * answering a card un-parks the turn, which is a moment the queue can move that no send() covers. */
    async drainQueue(): Promise<void> {
        // A message submitted just after Stop is accepted into the queue immediately, but must not be steered
        // into the aborting turn or started against its still-live detached-run lock. The Stop endpoint resolves
        // only after that run is genuinely settled, so this is the single ordering barrier for both races.
        if (this.stopping !== undefined) {
            await this.stopping;
        }
        for (;;) {
            const next = this.queued.value[0];
            if (next === undefined) {
                return;
            }
            if (this.streaming.value) {
                if (this.awaitingDecision.value || !(await this.deliverSteer(next))) {
                    return;
                }
                continue;
            }
            // An interrupted turn doesn't flush: the queue waits for the user's next send instead of starting
            // a turn nobody asked for. Same for a flush already in flight, it owns these messages.
            if (this.interrupted || this.flushing) {
                return;
            }
            this.flushing = true;
            try {
                const pending = this.queued.value;
                this.queued.value = [];
                await this.send(
                    pending
                        .map((message) => message.text)
                        .filter((text) => text.length > 0)
                        .join(`\n\n`),
                    this.turnSettings(),
                    pending.flatMap((message) => [...message.attachments]),
                    pending.find((message) => message.editorContext !== undefined)?.editorContext,
                );
            } finally {
                this.flushing = false;
            }
        }
    }

    // The turn settings a message sends under: this conversation's own current selection, captured at delivery.
    // The composer writes provider/model/effort/thinking straight onto these refs, so a queued message rides
    // whatever is selected when it actually goes, the same rule a typed message follows.
    turnSettings(): TurnSettings {
        return {
            agent: this.provider.value,
            harness: this.harness.value,
            account: this.account.value,
            // Read at delivery like the rest of this: a message queued behind a running turn goes out as
            // whoever the composer says at the moment it actually leaves, not as whoever was picked when it
            // was typed.
            actsAs: this.actsAs.value,
            model: this.model.value,
            effort: this.effort.value,
            thinking: this.thinking.value,
            // The pick AND the offer: a toggle left on from a fast-capable model must not ride along to one
            // that doesn't publish fast mode, where the harness would refuse it and the user would read the
            // refusal as a bug. Same shape as `effort` clamping to the model's own tier list.
            fast: this.fast.value && this.fastOffered.value,
            // Always the raw boolean, never conditional: the daemon persists the hold on the entry, and only an
            // explicit false can clear one set on an earlier turn (or from another device).
            tierHold: this.tierHold.value,
        };
    }

    /* Hand one queued message to the running turn (the daemon injects it between tool calls). False when no
     * steerable turn is live, the message stays queued for the settle.
     *
     * THE TRANSCRIPT WRITE IS NOT DONE HERE. The daemon answers a taken steer by pushing a `steer` frame into
     * the run's own log, and that frame is what draws the bubble, in this window, in every other window
     * rendering the same run, and in the record the settled turn is written down from. Writing it locally
     * instead is what used to put the answer above the question: the bubble landed at the end of THIS window's
     * transcript while the turn kept typing into the one it had open above, and a steer absorbed mid-turn emits
     * no `usage` to retire that bubble (see the `steer` frame in events.ts). The frame is pushed before this
     * request is answered, so there is no gap where the message is neither queued nor on screen. */
    private async deliverSteer(message: QueuedMessage): Promise<boolean> {
        const paths = message.attachments.map((file) => file.path);
        const delivered = await postTurnControl(this.at, `/agent/steer`, {
            conversationId: this.conversationId,
            text: message.text,
            ...(paths.length > 0 ? { attachments: paths } : {}),
            ...(message.editorContext !== undefined ? { editorContext: message.editorContext } : {}),
        });
        if (!delivered) {
            return false;
        }
        this.removeQueued(message.id);
        return true;
    }

    /* User-initiated Stop button: hard-cancel the turn daemon-side (/agent/stop) and let its stream say the rest.
     * The daemon's fold freezes the cards the turn was parked on and writes the "Stopped." line into the run's
     * own rows as it unwinds, so every window and the record read the stop the same way; this window keeps
     * its stream open to receive exactly that, and the stream ends when the run does. The control request is
     * retained as a barrier for the next send: its response means the detached run has released the
     * conversation lock.
     *
     * Only a stop the daemon could not be told about is drawn here (cancelPendingCards, a local line): the
     * stream would otherwise stay open on a turn nobody is ending. */
    stop(): void {
        if (!this.streaming.value) {
            return;
        }
        this.ended();
        const stopping = postTurnControl(this.at, `/agent/stop`, { conversationId: this.conversationId }).then((delivered) => {
            if (!delivered) {
                this.stopLocally();
            }
        });
        this.stopping = stopping;
        void stopping.finally(() => {
            if (this.stopping === stopping) {
                this.stopping = undefined;
            }
        });
    }

    // This side of a turn ending on the user's say-so: hold the queue, and arm the way back. Shared with a
    // dismissal, which ends the turn as part of the dismissal itself and so has no request of its own to send
    // (see cancelQuestion).
    private ended(): void {
        // The turn is ending on the user's say-so, not its own, hold the queue back from the settle flush (a
        // stopped agent must not be immediately restarted), and drop a continuation already on the clock.
        this.interrupted = true;
        this.cancelAutoContinue();
        /* The work stopped mid-flight and the session is untouched, so the way back is one press (see
         * `resumable`). Armed HERE rather than in abort(), which a closed tab and a sandbox switch also call:
         * neither of those is the user standing in front of a chat deciding what to do next.
         *
         * And only for a turn the daemon actually took (see `turnAccepted`). A Stop pressed while the opening
         * request was still in flight left nothing behind to pick up, no turn, no record, no session, so the
         * press would send a bare "Continue" as the conversation's first message and the agent would rightly
         * answer that it has nothing to continue. What that Stop earns instead is the words back, which the
         * send's own pre-ack path hands over. */
        this.pickUp.value = this.turnAccepted ? { reason: `stopped` } : undefined;
        this.persist();
    }

    // The stop the daemon never heard: nothing is going to write the ending into the rows, so this window draws
    // it, freezes the cards, and drops the stream it can no longer trust.
    private stopLocally(): void {
        this.cancelPendingCards();
        this.transcript.notice(`Stopped.`);
        this.abort();
        this.persist();
    }

    // Freeze whatever the stopped turn was parked on. Stop is offered WHILE a plan / question / permission card
    // is open, a turn holding the user's attention is exactly when they most want out, and a card left `pending`
    // would keep awaitingDecision (and with it the composer's plan-feedback routing and the tab's "awaiting"
    // status) wedged on a turn that no longer exists.
    private cancelPendingCards(): void {
        if (!this.awaitingDecision.value) {
            return;
        }
        this.transcript.write((state) => ({ ...state, messages: state.messages.map(withCancelledCards) }));
    }

    // Aborts this tab's attach stream; whatever streamed so far stays in the transcript. The run itself is
    // detached daemon-side, so this is soft BY DESIGN, stop() above pairs it with /agent/stop to hard-cancel.
    // Called bare by the manager when its tab is closed: the turn finishes and lands its work, and reopening
    // the conversation reattaches to it.
    abort(): void {
        // The turn is ending on someone's say-so, not its own, hold the queue back from the settle flush
        // (a closed tab must not fire a turn; a stopped agent must not be immediately restarted), and drop a
        // continuation already on the clock for the same reason: it would fire into a tab nobody has open.
        this.interrupted = true;
        this.cancelAutoContinue();
        this.transcript.settle();
        this.probe?.abort();
        this.inflight?.abort();
        this.failures.cancelProbe();
    }

    // Attach to a turn already running daemon-side, started before a reload, or by another window/device on
    // the same conversation. False when nothing is live (or recently finished): the caller falls back to
    // transcript hydration. The attach head carries the run's rows whole, the user's message included, so
    // there is nothing for this window to synthesize.
    async reattach(): Promise<boolean> {
        if (this.streaming.value) {
            return true;
        }
        const controller = new AbortController();
        this.probe = controller;
        let engaged = false;
        let turn: TurnContext | undefined;
        const attached = (head: AttachHead): TurnContext | undefined => {
            // A send that started between this probe's entry check and the daemon's reply owns the stream.
            if (!engaged && this.streaming.value) {
                return undefined;
            }
            if (!engaged) {
                engaged = true;
                this.beginTurn(controller, head.startedAt);
                // The daemon is streaming this run at us, so it is its own record already, nothing here is
                // undelivered, and a stream that drops later leaves a turn that really is worth continuing.
                this.turnAccepted = true;
            }
            /* THIS WINDOW MAY HAVE DRAWN THIS RUN ALREADY, a stream that dropped and came back, a sandbox that
             * restarted underneath one, a tab reopened onto a run still going. The head's rows REPLACE what this
             * window holds for the run (transcriptState.attachRun remembers where each run's rows start), so
             * nothing is drawn twice, and what the run sits UNDER, an interrupted run's work, the notice
             * explaining it, is untouched. */
            const { userMessageId } = this.transcript.attachRun(head);
            turn = {
                userMessageId: userMessageId ?? turn?.userMessageId ?? -1,
                run: head.run,
                provider: this.provider.value,
                account: this.account.value,
                harness: this.harness.value,
            };
            return turn;
        };
        try {
            return await followRun(this.conversationId, undefined, { ...this.sink, attached }, controller, this.at);
        } finally {
            this.probe = undefined;
            if (engaged) {
                this.endTurn();
            }
        }
    }

    /* THE ONE PATH EVERY CARD ANSWER TAKES. All three kinds (plan, question, permission) are decided the same
     * way, un-park the turn on the daemon's side channel, and only once it has actually taken the answer
     * freeze that answer into the transcript, and they were written out once per method, which is how the
     * "could not record it" wording came to differ four ways for one failure. Ordering is the part worth
     * holding in one place: the daemon goes first, because a card frozen against a reply that 404'd reads as
     * answered while the agent is still waiting on it.
     *
     * Returns whether the decision landed. What happens NEXT genuinely differs per card, a notice, the
     * rejection feedback as a user bubble, stopping the turn, so the callers keep their own tails.
     *
     * ONE ANSWER PER CARD, and the claim is staked before the request goes out rather than after it comes
     * back (see `deciding` above for why the `pending` check upstairs cannot do this job). A second answer
     * arriving while the first is in the air is dropped in silence: it is not an error, it is a person
     * clicking, and the card is about to show them what their first press decided. */
    private async decide(message: ChatMessage, body: AgentReply, failure: string, cards: TranscriptCards): Promise<boolean> {
        const { id } = message;
        if (this.deciding.value.has(id)) {
            return false;
        }
        this.deciding.value = new Set(this.deciding.value).add(id);
        try {
            if (!(await postTurnControl(this.at, `/agent/reply`, body))) {
                this.error.value = failure;
                return false;
            }
            // The same derivation the daemon applies when it writes the `resolved` row (card-status.ts), applied
            // here first so the card reads answered on the click rather than a round trip later.
            this.transcript.attachCard(id, settledCards(cards, body));
            return true;
        } finally {
            // Released even on the failure path: the card is back to `pending` on screen, so it has to be
            // answerable again, and the error line beside it is the reason to try.
            const left = new Set(this.deciding.value);
            left.delete(id);
            this.deciding.value = left;
        }
    }

    /* Answers a pending plan card. The turn is parked on ExitPlanMode, so on approval it executes the plan and
     * streams a closing turn; on rejection the feedback is fed back and it re-plans. The reply names no
     * posture, an approved plan runs under bypassPermissions, decided by the gate that raised the card.
     *
     * Feedback may carry the composer's staged files. The reply has ONE text field on the wire, so they go up
     * the way a user would type them, as `@`-prefixed workspace paths, which is exactly what mentionPaths
     * produces for an ordinary send and what the harness resolves at the other end. The alternative was the
     * rule this replaces ("plan feedback is text-only"), which refused the single most natural way to say what
     * a plan got wrong: a screenshot. */
    async decidePlan(message: ChatMessage, approve: boolean, feedback?: string, attachments: readonly ChatAttachment[] = []): Promise<void> {
        const plan = message.plan;
        if (plan?.status !== `pending`) {
            return;
        }
        const trimmed = feedback?.trim();
        const written = [trimmed, ...attachments.map((file) => `@${file.path}`)].filter(Boolean).join(`\n`);
        // The verdict's own line and the feedback bubble are the daemon's to write, into the run's rows, so a
        // second window and the record read them too (agent.routes' reply handler).
        const landed = await this.decide(
            message,
            { kind: `plan`, requestId: plan.requestId, approve, feedback: written.length > 0 ? written : undefined },
            `Could not record your plan decision: the turn may have ended.`,
            { plan },
        );
        if (!landed) {
            return;
        }
        // The turn is generating again, so anything queued behind the card can go in now.
        void this.drainQueue();
    }

    // Submits the user's picks for a pending question card. The turn is parked on the `ask` tool, which
    // unblocks and resumes using the answers.
    async answerQuestion(message: ChatMessage, answers: Record<string, string[]>): Promise<void> {
        const question = message.question;
        if (question?.status !== `pending`) {
            return;
        }
        const landed = await this.decide(
            message,
            { kind: `question`, requestId: question.requestId, answers },
            `Could not submit your answers: the turn may have ended.`,
            {
                question,
            },
        );
        if (landed) {
            void this.drainQueue();
        }
    }

    /* Dismisses a pending question, which ENDS THE TURN. The card was raised because the agent could not
     * choose for itself; waving it away answers nothing, so letting the turn run on means it guesses at
     * exactly the fork it just said it could not guess at. The user gets the wheel back instead, with the
     * transcript recording both halves ("Question dismissed." then "Stopped.").
     *
     * ONE REQUEST DOES BOTH, and the daemon is where the ending happens (agent.routes' reply handler). Sending
     * the dismissal and then a Stop behind it is what made a dismissed agent flash through the board's Active
     * lane: between the two, the daemon had a live turn with nothing parked on it, a working agent, as far as
     * every surface reading the roster could tell, and the card was pulled out of Attention to say so before
     * being moved again when the stop landed. It also made where the card CAME TO REST a race between two
     * requests. The reply now comes back with the turn already out, so there is nothing to send after it and
     * nothing to wait for: the board moves the card once. */
    async cancelQuestion(message: ChatMessage): Promise<void> {
        const question = message.question;
        if (question?.status !== `pending`) {
            return;
        }
        // Both lines, "Question dismissed." and the "Stopped." under it, are the daemon's: it writes the first
        // before it ends the turn and the second as the run unwinds, and the stream carries both here.
        const landed = await this.decide(
            message,
            { kind: `question`, requestId: question.requestId, cancelled: true },
            `Could not dismiss the question: the turn may have ended.`,
            { question },
        );
        if (!landed) {
            return;
        }
        this.ended();
    }

    // Answers a pending permission card. 'once' allows just this call, 'always' also persists the rules the
    // SDK suggested so the same tool stops asking, 'deny' blocks it, and stops the turn, for the same reason a
    // dismissed question does (see cancelQuestion). The card offers no free text, so a denial hands the agent
    // nothing to redirect with; Claude Code draws the line in exactly that place, aborting a denial that carries
    // no feedback and letting one that does carry some steer the turn onward.
    async decidePermission(message: ChatMessage, decision: "once" | "always" | "deny", feedback?: string): Promise<void> {
        const permission = message.permission;
        if (permission?.status !== `pending`) {
            return;
        }
        const landed = await this.decide(
            message,
            { kind: `permission`, requestId: permission.requestId, decision, feedback },
            `Could not record your decision: the turn may have ended.`,
            { permission },
        );
        if (!landed) {
            return;
        }
        if (decision === `deny` && feedback === undefined) {
            this.stop();
            return;
        }
        void this.drainQueue();
    }

    /* The spend decision, the click that is the ONLY way a priced service run can happen (the daemon holds
     * the agent's request parked until this settles it; platform/service-offer.ts). Approve releases exactly
     * one run; skip charges nothing and tells the agent to carry on without it. The receipt that follows an
     * approval arrives as its own frame and patches the card, nothing here predicts how the run will end. */
    async decideServiceOffer(message: ChatMessage, approve: boolean): Promise<void> {
        const offer = message.serviceOffer;
        if (offer?.status !== `pending`) {
            return;
        }
        const landed = await this.decide(
            message,
            { kind: `service_offer`, requestId: offer.requestId, approve },
            `Could not record your decision: the offer may have expired.`,
            { serviceOffer: offer },
        );
        if (landed) {
            void this.drainQueue();
        }
    }

    /* The payment decision, the click that is the ONLY way a USDC payment can leave the wallet (the daemon
     * holds the agent's `wallet fetch` parked until this settles it; wallet/payment-offer.ts). Approve
     * releases exactly one payment at exactly the price on the card; skip spends nothing and tells the agent
     * to carry on without it. The receipt that follows an approval arrives as its own frame and patches the
     * card, nothing here predicts whether the endpoint will actually settle. */
    async decidePaymentOffer(message: ChatMessage, approve: boolean): Promise<void> {
        const offer = message.paymentOffer;
        if (offer?.status !== `pending`) {
            return;
        }
        const landed = await this.decide(
            message,
            { kind: `payment_offer`, requestId: offer.requestId, approve },
            `Could not record your decision: the offer may have expired.`,
            { paymentOffer: offer },
        );
        if (landed) {
            void this.drainQueue();
        }
    }

    /* THE RELEASE, the click that lets a turn use a credential the owner put behind a named person (the
     * daemon holds the exit parked until this settles it; secrets/credential-gate.ts). How far one yes goes
     * is the POLICY's answer and not this call's: a per-use gate releases exactly this use and the next one
     * asks again, a conversation-scoped gate covers the rest of the conversation. The card says which.
     *
     * THE ONE CARD WHOSE ANSWER CAN BE REFUSED. Every other decide here settles whatever it reaches, because
     * the daemon is single-tenant and a card is the owner's to decide; this one is checked server-side
     * against the verified identity on the request, and a click from anybody the card does not name comes
     * back 403 with the card still standing. The template disables the buttons for a non-approver so the
     * refusal is not how they find out, but the server is what enforces it — the disabled attribute is a
     * courtesy, not the rule. */
    async decideCredentialOffer(message: ChatMessage, approve: boolean): Promise<void> {
        const offer = message.credentialOffer;
        if (offer?.status !== `pending`) {
            return;
        }
        const landed = await this.decide(
            message,
            { kind: `credential_offer`, requestId: offer.requestId, approve },
            `Could not record your decision: the card may have expired, or it may not be yours to answer.`,
            { credentialOffer: offer },
        );
        if (landed) {
            void this.drainQueue();
        }
    }

    /* The setup decision, the click that decides a missing-capability ask (the daemon holds the agent's
     * request parked until this settles it; capabilities/capability-offer.ts). Connect moves the card to
     * `connecting`, the owner is now setting it up, and the agent stays parked watching for the connection;
     * the capability_outcome frame that follows patches how it ended. Not-now tells the agent to carry on
     * without it, and the daemon remembers the no for this conversation so it isn't asked twice. */
    async decideCapabilityOffer(message: ChatMessage, connect: boolean): Promise<void> {
        const offer = message.capabilityOffer;
        if (offer?.status !== `pending`) {
            return;
        }
        const landed = await this.decide(
            message,
            { kind: `capability_offer`, requestId: offer.requestId, connect },
            `Could not record your decision: the ask may have expired.`,
            { capabilityOffer: offer },
        );
        if (landed) {
            void this.drainQueue();
        }
    }

    /* Declines a pending browser-help card from the CHAT side, "can't help now", which un-parks the agent to
     * carry on without the owner's hands. The other half of this card's life happens on /browsers (the banner
     * over the live stage is where "hand back" lives, beside Take control); when the user resolves it THERE,
     * the resolved frame freezes this card, so chat offers only the answer that needs no browser. */
    async declineBrowserHelp(message: ChatMessage): Promise<void> {
        const help = message.browserHelp;
        if (help?.status !== `pending`) {
            return;
        }
        const landed = await this.decide(
            message,
            { kind: `browser_help`, requestId: help.requestId, helped: false },
            `Could not send that: the turn may have ended.`,
            {
                browserHelp: help,
            },
        );
        if (landed) {
            void this.drainQueue();
        }
    }

    /* The same, for the terminal handover, "can't help now" from chat, which un-parks the agent to carry on
     * without the owner at the prompt. "Done, hand back" lives on the terminal panel's banner for the reason
     * the browser's lives over its stage: it belongs beside the thing the owner just acted on, and it is the
     * answer that only makes sense once they have. */
    async declineTerminalHelp(message: ChatMessage): Promise<void> {
        const help = message.terminalHelp;
        if (help?.status !== `pending`) {
            return;
        }
        const landed = await this.decide(
            message,
            { kind: `terminal_help`, requestId: help.requestId, helped: false },
            `Could not send that: the turn may have ended.`,
            {
                terminalHelp: help,
            },
        );
        if (landed) {
            void this.drainQueue();
        }
    }

    /* One entry's consequences for the conversation beyond its rows, in the order the entries arrived. The
     * ordering matters and cannot be hoisted: `providerRetry` is cleared by any other entry and SET by the
     * retry fact, so a batch holding a retry and the entry that answers it would otherwise settle on whichever
     * won the reshuffle.
     *
     * A REPLAYED fact (delivered to an earlier attach of this same stream) is applied again all the same: every
     * fact below is a statement of state rather than an increment, so applying it twice lands on the same
     * answer, and the one that was an increment, the turn's cost, is read off the rows instead. */
    private applied(entry: AttachEntry, turn: TurnContext, _replay: boolean): void {
        // Any other entry means the wait a provider_retry described is over, the request went through, or the
        // turn moved on to a different problem. Retired against anything rather than specific entries because
        // "still waiting" is only true until literally anything else happens.
        if (entry.kind !== `fact` || entry.fact.kind !== `provider_retry`) {
            this.providerRetry.value = undefined;
        }
        if (entry.kind === `patch`) {
            this.applyPatchConsequence(entry.patch);
            return;
        }
        this.applyFact(entry.fact, turn);
    }

    /* What a change to the rows means BEYOND the rows: a tool card arriving for the first time. A MAIN-TREE turn
     * writes the files the Changes panel commits, so its paths are recorded for the panel to warn against, per
     * repo, so an agent working in one repo says nothing about the rest. An isolated turn writes its own
     * worktree and lands as a reviewable diff, so it records nothing: that distinction is the whole reason the
     * panel no longer blocks committing on "an agent is running", which was true of both and meaningful for
     * neither. */
    private applyPatchConsequence(patch: TranscriptPatch): void {
        if (patch.op !== `tool` || this.liveTools.has(patch.tool.id)) {
            return;
        }
        this.liveTools.add(patch.tool.id);
        if (!this.isolated.value && this.turnStartedAt.value !== undefined) {
            const startedAt = this.turnStartedAt.value;
            const call = patch.tool;
            void import(`../workspace/liveWrites`).then((m) => m.recordTurnWrite(this.conversationId, startedAt, call));
        }
    }

    private applyFact(fact: TurnFact, turn: TurnContext): void {
        switch (fact.kind) {
            case `session`:
                /* Captured with the runtime and credential it was minted under, so a later mismatch (a mid-chat
                 * switch) is detectable at send time.
                 *
                 * The ACCOUNT comes off the fact whenever the daemon named one, and only falls back to what
                 * this turn asked for when it did not. They differ exactly where it matters: a turn that names
                 * no account is served by whichever connected one has headroom, so an automation's session,
                 * reattached in a tab, would otherwise be bound to nobody, and the tab's first send would
                 * announce, and take, a fresh session over one that resumes perfectly well. */
                this.bindSession(boundSession(fact.sessionId, turn, fact.account));
                return;
            case `worktree`:
                // First fact of an isolated turn: which branch/base this conversation works on. The rebase it
                // may report is a row of the run's own, written by the daemon.
                this.worktree.value = { branch: fact.branch, base: fact.base };
                /* The container cannot enforce the worktree with mounts, so the harness is redirecting tool
                 * paths into it instead, which covers tool input but not a path a subprocess computes for
                 * itself. Said ONCE per conversation rather than per turn: it is a property of the sandbox, it
                 * does not change while it runs, and repeating it every turn would train the reader to skip it. */
                if (fact.unenforced === true && !this.warnedUnenforced) {
                    this.warnedUnenforced = true;
                    this.transcript.notice(
                        `This sandbox can't isolate agent turns at the filesystem level (it was created without CAP_SYS_ADMIN). Work is redirected into ${fact.branch}, but a command that builds its own paths can still reach the shared workspace: recreate the sandbox to restore full isolation.`,
                    );
                }
                return;
            case `mode`:
                // The turn's live posture, the user's pick echoed back at init, or a move the AGENT made
                // (EnterPlanMode / a plan approval). Drives the composer's selector so it never lies, without
                // overwriting the pick the NEXT turn starts from.
                this.liveMode.value = fact.mode;
                return;
            case `commands`:
                // The provider's slash commands (ACP agents), replaced whole, the composer's `/` popover.
                this.availableCommands.value = fact.items;
                return;
            case `init`:
                this.activeModel.value = fact.model;
                return;
            case `context_usage`:
                // Per-conversation context-window fill, held on this instance (not the singleton) so the
                // composer shows the active chat's meter for auto-compaction awareness.
                this.contextUsage.value = { tokens: fact.tokens, contextWindow: fact.contextWindow };
                return;
            case `usage`:
                // The turn's cost is on the bubble its answer ended in (the daemon put it there), and the
                // conversation's totals are summed off the rows; nothing to keep here.
                return;
            case `account_usage`:
                // Account-wide subscription headroom, keyed by the account that served the turn so switching
                // accounts shows the right one. Stamped with the read time, and written into the one shared map
                // newest-wins, so the daemon's own push of the same reading and the next list load agree. An
                // env-token turn has no account to attribute headroom to, so there is nothing to key it by.
                if (fact.account !== undefined) {
                    setAccountUsage(this.provider.value, fact.account, { windows: [...fact.windows], measuredAt: Date.now() });
                }
                return;
            case `terminal`: {
                // The agent started running Bash in its live `agent-<id>` tmux terminal. Remember it, so this
                // conversation's Bash cards can offer to watch it, and tell the terminal layer whose it is, so
                // its popover names the conversation instead of eight hex characters. The panel is then asked to
                // surface it, which tabs it only if the user opted into work terminals, no auto-open, no focus
                // steal either way. Both imports are lazy so the chat model doesn't statically pull in the
                // xterm/terminal-panel chain.
                const { session } = fact;
                this.agentTerminal.value = session;
                const title = this.title.value;
                void import("../terminal/useWorkTerminals").then((m) => m.noteAgentTerminal(session, title));
                void import("../terminal/useTerminalPanel").then((m) => m.useTerminalPanel().surface(session));
                return;
            }
            case `browser`: {
                // The agent just used a browser tool. Everything above applies unchanged, the browser is the
                // same kind of thing as the shell (this conversation's, for this turn, watchable but hidden
                // until asked for), which is why it rides the same three calls rather than a parallel channel.
                const { session } = fact;
                this.agentBrowser.value = session;
                const title = this.title.value;
                void import("../terminal/useWorkTerminals").then((m) => m.noteAgentTerminal(session, title));
                void import("../terminal/useTerminalPanel").then((m) => m.useTerminalPanel().surface(session));
                return;
            }
            case `provider_retry`:
                // A wait, not a failure: the turn is still running. Held only while it is (see endTurn), so a
                // stale "retrying…" can never sit under a finished answer.
                this.providerRetry.value = fact;
                return;
            case `fast_mode`:
                // Deliberately NOT cleared at the turn boundary (see the ref): the answer usually outlives the
                // turn that reported it.
                this.fastMode.value = fact;
                return;
            case `tier`:
                /* A judged turn's verdict: two standing facts are replaced (the picker notice's answer, the next
                 * preview's `afterHardTurn` input). The line a routed turn earns in the transcript, with its
                 * opt-out a press away, is a row of the run's own, written by the daemon, so the live chat and
                 * the reopened one carry it identically. */
                this.tierAnswer.value = fact;
                this.lastTier.value = fact.tier;
                return;
            case `error`:
                this.failures.apply(fact, turn);
                return;
            case `rate_limit_info`:
                // The live gate, not a headroom reading: `account_usage` carries every pool, and is what the
                // readouts use.
                return;
        }
    }
}
