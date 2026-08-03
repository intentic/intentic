import {
    type AgentCommand,
    type AgentEvent,
    type AgentHarness,
    type AgentProvider,
    type AgentReply,
    capabilitiesOf,
    clampMode,
    type ContextUsage,
    deriveTitle,
    type EditorContext,
    fastAllowed,
    type PermissionMode,
    providerLabel,
    type RestoredMessage,
    withoutResumeNote,
} from "@intentic/sandbox-contract";
import { computed, ref } from "vue";
import { trackPerf } from "../perf";
import { sandboxRequest } from "../sandbox/sandboxClient";
import { errorMessage } from "../useAsyncAction";
import { clampEffort } from "./effortScale";
import { rememberedAccountFor, selectedAccountId } from "./providerAccounts";
import { providerModels, providerTabs } from "./providerCatalog";
import { type CardKind, type ChatAttachment, type ChatMessage, isAwaitingDecision, transcriptOf, withCancelledCards } from "./transcript";
import { readTranscript, saveTranscript } from "./transcriptCache";
import { TranscriptClock } from "./transcriptClock";
import { rememberedModelFor, startingMode, turnDefaults } from "./turnDefaults";
import { TurnFailures } from "./turnFailures";
import type { TurnEffect } from "./turnReducer";
import { type SessionRef, type TurnSettings, resumes, turnRequestBody } from "./turnRequest";
import { type AttachHead, followRun, postTurnControl, type TurnContext } from "./turnStream";
import { usageStatusByAccount } from "./usageStatus";
import { mentionPaths } from "./useMentions";

// A file staged in a conversation's composer, uploaded to the workspace the moment it's attached (send is
// then instant). Each lands in its own uuid dir so duplicate names never collide and the agent sees the real
// filename. `previewUrl` (object URL) and `controller` are client-session only — a restored entry has neither.
export interface PendingAttachment {
    readonly id: string;
    readonly name: string;
    // Workspace-relative destination: .intentic/attachments/<uuid>/<name>.
    readonly path: string;
    // Object URL for image thumbnails; revoked on remove, handed to the sent message on submit.
    readonly previewUrl?: string;
    readonly controller?: AbortController;
    status: `uploading` | `done` | `failed`;
    progress: number;
    error?: string;
}

// A message the user wrote while a turn was already running, waiting to reach the agent. The composer never
// refuses input: a message submitted mid-turn lands here and the conversation delivers it as soon as it can —
// injected into the running turn where the harness accepts that (Claude Code's queue-and-steer), else sent as
// the next turn the moment this one settles. Carries everything a fresh message can (files, the editor chip),
// so "add more while it works" isn't a lesser kind of message.
export interface QueuedMessage {
    readonly id: string;
    readonly text: string;
    readonly attachments: readonly ChatAttachment[];
    readonly editorContext?: EditorContext;
}

// What a conversation is doing right now, surfaced as the tab's status icon.
export type ConversationStatus = "idle" | "streaming" | "awaiting" | "error";

/* One chat conversation: its transcript, the resumed sandbox session, and the turn selection every send runs
 * under. Self-contained so the manager can run several at once — each instance owns its AbortController and its
 * transcript clock, so tabs stream independently.
 *
 * The pieces a turn is made of live beside this file, and each is one thing: turnStream.ts renders a run and
 * carries control messages to it, transcriptClock.ts holds the transcript and decides when a frame is shown,
 * turnReducer.ts says what a frame MEANS, turnFailures.ts says what a failed turn does to the conversation, and
 * turnRequest.ts states the turn on the wire. What is left here is the conversation itself: the selection, the
 * queue, the cards, and the effects a frame has on all three. */
export class Conversation {
    /* The transcript and its clock. Frames are buffered into it and folded on the next paint; the effects they
     * raise come back through `applied` below, because what an effect DOES is this conversation's business and
     * what it does it TO is the transcript's. */
    private readonly transcript = new TranscriptClock((event, turn, effects) => this.applied(event, turn, effects));

    readonly messages = this.transcript.messages;
    // Whether a pane is showing this transcript WITH the focus — the typewriter's gate, written by the pane
    // that holds it (ChatPane) and read by the clock's tick. See TranscriptClock.watched for why an unwatched
    // transcript settles its text instead of typing it.
    readonly watched = this.transcript.watched;
    readonly streaming = ref(false);
    /* True while the attached stream is still re-telling frames that PREDATE this attach (see followRun). The
     * transcript is rebuilt from that frame log, so a card the user answered long ago passes back through
     * `pending` on its way to the answer that froze it: a run this window is joining (a reload, a redeploy, a
     * second window, a probe) re-tells the whole story.
     *
     * Rendering follows the frames as they land — that flicker is the transcript being drawn. Anything that
     * ACTS on what a frame says (the plan preview's auto-open) waits for this to drop, because a replayed
     * proposal is not a proposal: only what is still pending at the boundary is waiting on the user. */
    readonly replaying = ref(false);
    readonly error = ref<string | null>(null);
    // True while a daemon read that should produce this conversation's transcript is in flight and nothing is
    // painted meanwhile — a history open, or a restored tab whose local mirror came up empty. The panel shows
    // its loading state on it instead of the "Start a conversation" invitation, which over a chat that merely
    // hasn't arrived yet reads as data loss.
    readonly loading = ref(false);
    // This conversation's slash commands — replaced whole per `commands` frame, listed by the composer's `/`
    // popover. Both provider families publish them: an ACP agent mid-session, Claude at each turn's init (plus
    // a republish whenever the session's list changes).
    readonly availableCommands = ref<readonly AgentCommand[]>([]);

    // True while a turn is paused on a card awaiting the user's input (a pending plan, question, or tool
    // permission). The attach stream stays open during this, so `streaming` is still true — but the agent
    // isn't generating, so the composer should drop the Stop spinner and show a ready Send (Claude Code style).
    readonly awaitingDecision = computed(() => this.messages.value.some(isAwaitingDecision));

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

    /* The user's permission posture for this conversation — the composer's pick, seeded by where the
     * conversation works (startingMode). Only the user writes it, and nothing writes OVER it.
     *
     * The mode is the contract's PermissionMode — imported, not redeclared. The composer picks the turn's
     * STARTING mode; the agent can then move itself (EnterPlanMode when a request turns out to need thinking
     * through, ExitPlanMode once the user approves), which arrives back as a `mode` frame and drives `liveMode`
     * below. So the selector always shows the live posture, not just what the user last clicked. */
    readonly modePick = ref<PermissionMode>(startingMode(true));

    // The posture the next turn actually STARTS in: the pick, clamped to what this conversation's runtime can
    // hold. Read-clamped rather than written back, exactly as `effort` is one field down and for the same
    // reason — a native Codex/Grok/ACP turn has an approval channel for nothing, so "Manual" above one is a
    // promise it can't keep, but a user who switches to Codex and back must get their own pick returned rather
    // than quietly ratcheted down to the posture the other runtime happened to allow.
    readonly mode = computed<PermissionMode>(() => clampMode(this.modePick.value, this.capabilities.value));

    // The posture the RUNNING turn is actually in, from the turn's `mode` frames — the agent's own
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
    // daemon's own `terminal` frame. Held so the transcript can offer to WATCH the shell — the agent's terminals
    // no longer tab themselves into the panel (useWorkTerminals), so the Bash card is where that door lives.
    // Undefined until the first Bash of a turn; a fresh conversation, a branch, and a restored transcript all
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

    // Whether the fleet has ever known this conversation. The board's DRAFT card exists to bridge exactly one
    // gap — "New agent" pressed → the first roster frame that registers it — and that crossing happens once, so
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

    // Lifetime accounting across the conversation's turns (finally surfaced — the fleet card and the usage
    // popover read these). The daemon's registry is the authoritative cross-device total; these accumulate the
    // turns THIS tab streamed, which matches it whenever the tab saw every turn.
    readonly costUsd = ref(0);
    readonly inputTokens = ref(0);
    readonly outputTokens = ref(0);

    // Start of the in-flight turn (ms), for the card's elapsed readout; undefined while idle.
    readonly turnStartedAt = ref<number | undefined>();

    // This conversation's turn selection, seeded from the module defaults at construction. All of it — provider
    // and account included — is switchable mid-chat (the composer binds them); send() decides whether the
    // session above still matches (resume) or a fresh one starts seeded with the transcript so far.
    readonly provider = ref<AgentProvider>(turnDefaults.provider.value);
    readonly harness = ref<AgentHarness>(turnDefaults.harness.value);
    readonly account = ref<string | undefined>(rememberedAccountFor(turnDefaults.provider.value));
    readonly model = ref<string>(rememberedModelFor(turnDefaults.provider.value));
    readonly thinking = ref<boolean>(turnDefaults.thinking.value);
    /* Ask for fast speed on this conversation's turns. Deliberately NOT seeded from turnDefaults, unlike every
     * other control on this line: fast mode costs roughly twice per token, and the sticky-default machinery
     * would carry one chat's toggle into every chat opened afterwards. A control that spends more money starts
     * from off, every time, and says so per conversation. (The daemon takes the same position for the same
     * reason — see the fastModePerSessionOptIn note in agent.ts.) */
    readonly fast = ref<boolean>(false);
    // The reasoning effort the user ASKED for — which is not always runnable, because the tier scale belongs to
    // the MODEL: a pick made on Claude ('max', 'xhigh') is off Kimi K3's scale, and 'max' leaves Claude's own the
    // moment thinking is switched off. Everything that selects an effort writes this; everything that renders or
    // SENDS one reads `effort` below. Keeping the pick means a trip through a smaller model doesn't ratchet it
    // down — come back and the user's choice is still there.
    readonly effortPick = ref<string>(turnDefaults.effort.value);

    // The tier this conversation's next turn actually runs at: the pick, clamped to what the current
    // provider+model+thinking triple offers. Clamped at READ rather than written back, so it also covers the
    // moments no setter runs — the model catalog arriving after the conversation was seeded, most of all.
    readonly effort = computed<string>(() => clampEffort(this.effortPick.value, this.provider.value, this.model.value, this.thinking.value));

    // This conversation's composer draft: the unsent message text and staged attachments. Per-tab so switching
    // tabs keeps each chat's draft; persisted per sandbox (see useChat's tab snapshot) so a refresh keeps it.
    readonly draft = ref(``);
    readonly attachments = ref<PendingAttachment[]>([]);

    // Messages submitted while a turn was running and not yet delivered — see enqueue/drainQueue. Rendered
    // above the composer so nothing the user wrote is ever invisible, and persisted with the draft.
    readonly queued = ref<QueuedMessage[]>([]);

    /* The harness retrying INSIDE the live turn (provider_retry). Distinct from a failure in the way that
     * matters most to a waiting user: nothing has failed and nothing has been lost — this turn is still running.
     * Rendered as a status beside the streaming indicator and dropped the moment the turn produces anything or
     * settles, so it can never outlive the wait it describes. */
    readonly providerRetry = ref<Extract<AgentEvent, { kind: `provider_retry` }> | undefined>();

    /* What speed the harness actually served the last turn at, and — when it wasn't the one asked for — its
     * reason. Kept ACROSS turns rather than cleared at the boundary like providerRetry above: the answer is a
     * standing fact about this conversation's model and account ("your plan doesn't include fast mode") far
     * more often than a property of one turn, and clearing it would make the notice flicker away exactly when
     * the user goes looking for why the toggle did nothing. A turn that changes the answer replaces it. */
    readonly fastMode = ref<Extract<AgentEvent, { kind: `fast_mode` }> | undefined>();

    /* What the runtime behind this conversation's provider/harness pair can actually do — the same record the
     * daemon plans the turn against (capabilitiesOf), so the composer can't offer a control nothing applies.
     * Every consumer reads the field it cares about: the mode menu takes `permissions`, the effort segments
     * take `effort`, the picker footer takes the whole record via limitationsOf. */
    readonly capabilities = computed(() => capabilitiesOf(this.provider.value, this.harness.value));

    // Whether the running turn can absorb a message mid-flight — the same field the daemon's streamAgent gates
    // its SteeringQueue on. Used for WORDING alone (the composer says "steer" vs "queue"): delivery asks the
    // daemon and falls back to the queue on a refusal, so a drift here can't lose a message.
    readonly steerable = computed(() => this.capabilities.value.steering);

    // Whether the fast control is offered at all: the runtime, the route and the selected MODEL all have to
    // allow it (fastAllowed). Read from the live catalog rather than remembered, so switching to a model that
    // doesn't publish fast mode takes the control away by itself — the same way the effort segments follow the
    // model's own tier list. The pick is left alone underneath: come back to a fast-capable model and the
    // toggle is where the user left it.
    readonly fastOffered = computed(() =>
        fastAllowed(
            this.capabilities.value,
            this.provider.value,
            (providerModels.value[this.provider.value] ?? []).find((option) => option.value === this.model.value)?.badges,
        ),
    );

    /* What a failed turn does to this conversation, and how one that is coming back is waited out — the outage
     * countdown and the credential-renewal spinner the composer draws are this unit's own state. Public because
     * those two are what the banner and the notice line read. */
    readonly failures = new TurnFailures({
        transcript: this.transcript,
        provider: this.provider,
        account: this.account,
        session: this.session,
        error: this.error,
        streaming: this.streaming,
        requeue: (userMessageId: number) => this.requeueUndelivered(userMessageId),
        hold: () => {
            this.interrupted = true;
        },
        reattach: () => this.reattach(),
        persist: () => this.persist(),
    });

    // What a followed run writes into: this conversation's replay flag and its buffered transcript. The turn a
    // stream renders under is the one varying part, so each call adds its own `ensureTurn`.
    private readonly sink = {
        replaying: this.replaying,
        frame: (event: AgentEvent, turn: TurnContext): void => this.transcript.push(event, turn),
        catchUp: (): void => this.transcript.catchUp(),
    };

    // The one unsent "switched" divider notice, upserted/removed as the user toggles provider/account and made
    // permanent by the next send (the segment cut).
    private pendingSwitchNoticeId: number | undefined;

    // Aborts the in-flight ATTACH STREAM when the user hits Stop / closes the tab; cleared once the stream
    // settles. The turn itself runs detached on the daemon — only /agent/stop cancels it.
    private inflight: AbortController | null = null;

    // The Stop request whose successful response means the daemon's detached run has completely settled and
    // released this conversation. The local attach aborts immediately for a responsive UI, so without this
    // barrier the next message can otherwise reach /agent during the daemon's cleanup tail and receive a false
    // "another window" conflict from the run it just stopped itself.
    private stopping: Promise<void> | undefined;

    // The in-flight reattach probe (see reattach), aborted by a send so the two never race one run.
    private probe: AbortController | undefined;

    // Set by abort() — a Stop, a closed tab, a sandbox switch — and cleared whenever a turn starts or the user
    // submits again. An INTERRUPTED turn must not flush the queue: someone who just stopped the agent did not
    // ask for another turn to start on its own. The queued messages stay put and ride the user's next send.
    private interrupted = false;

    // True while drainQueue owns the idle flush (it is awaiting the turn that carries the queue), so a second
    // drain — the settle hook, a fresh submit — can't send the same messages twice.
    private flushing = false;

    // `conversationId` is the conversation's whole identity — the key the daemon puts on the fleet registry
    // entry and the worktree, the strip puts on the tab, and the transcript mirror puts on the cache entry. It
    // survives provider/harness switches (which retire sessions) and reloads (persisted in the tab snapshot),
    // and its shape satisfies the wire's branch/path-safety regex (a UUID: hex + hyphens, starts alphanumeric).
    constructor(readonly conversationId: string = crypto.randomUUID()) {}

    // Switch the provider this conversation's next turn runs on and re-scope its provider-specific settings:
    // the model repoints to the new provider's remembered/live-default pick (the effort scale follows the model,
    // through Conversation.effort). Writes the pick back to the module default so the next new chat inherits it. Mid-chat,
    // the switch takes effect at the next send — the current session is retired then and the new provider's
    // fresh session is seeded with the transcript so far (see send); browsing the picker never destroys it.
    selectProvider(next: AgentProvider): void {
        if (this.streaming.value || next === this.provider.value) {
            return;
        }
        this.provider.value = next;
        // Switching back to the session's own runtime restores its account, so the next send resumes it.
        this.account.value = next === this.session.value?.provider ? this.session.value.account : rememberedAccountFor(next);
        this.model.value = rememberedModelFor(next);
        turnDefaults.provider.value = next;
        // The old segment's live model and context meter don't describe the next turn.
        this.activeModel.value = null;
        this.contextUsage.value = undefined;
        this.refreshSwitchNotice();
    }

    /* THE THREE TURN-SETTING WRITES, all shaped the same way: apply to THIS conversation, and remember the pick
     * as the seed for the next new chat. They live here rather than in useChat because a conversation is not
     * always the active tab — the suggested-session dialog drives a draft that has no tab at all yet, through
     * the same model picker and the same effort segments (SuggestedSessionBox.vue). useChat's identically-named
     * facades are these, bound to the active tab.
     *
     * One picker row = provider + model; the harness is a separate axis (the picker's footer chips), so a model
     * pick keeps the current harness. A cross-provider pick re-points the selection and the fresh session starts
     * lazily at the next send. Mid-stream, only a same-provider model swap is allowed — a provider switch is not,
     * because it retires the session the stream is running on. */
    selectModel(pick: { provider: AgentProvider; value: string }): void {
        if (this.streaming.value && pick.provider !== this.provider.value) {
            return;
        }
        if (pick.provider !== this.provider.value) {
            this.selectProvider(pick.provider);
        }
        this.model.value = pick.value;
        // Per-provider memory, so switching provider away and back restores the pick (the catalog is
        // harness-independent, so it rides across a harness switch too).
        turnDefaults.models.value = { ...turnDefaults.models.value, [pick.provider]: pick.value };
    }

    // The effort PICK, which is not always the effort in force: Conversation.effort clamps it to whatever scale
    // the current model and thinking flag actually offer, so a `max` pick survives a trip through a model that
    // tops out at `high` rather than being silently rewritten to it.
    setEffort(value: string): void {
        this.effortPick.value = value;
        turnDefaults.effort.value = value;
    }

    // No effort clamp here: turning thinking OFF invalidates a `max` pick (the API rejects the pair), and
    // `effort` already answers for it — thinking is one of the three inputs it clamps against, so the segments
    // and the next turn both follow this flip on their own.
    setThinking(value: boolean): void {
        this.thinking.value = value;
        turnDefaults.thinking.value = value;
    }

    // Not written to turnDefaults — see the `fast` ref. Switching it also drops the last answer: the notice
    // under the composer describes a turn that ran under the OLD setting, and leaving it up next to a freshly
    // flipped toggle reads as the answer to the flip.
    setFast(value: boolean): void {
        this.fast.value = value;
        this.fastMode.value = undefined;
    }

    // Point the conversation's next turn at a specific account of its current provider (the account switcher).
    // Mid-chat, an account change — like a provider change — retires the session at the next send.
    selectAccount(id: string): void {
        if (this.streaming.value) {
            return;
        }
        this.account.value = id;
        selectedAccountId.value = { ...selectedAccountId.value, [this.provider.value]: id };
        this.refreshSwitchNotice();
    }

    // Switch the harness (native runtime vs the Claude Code loop) for the next turn. The model is kept — the
    // catalog is harness-independent now (codex/grok run the same subscription ids either way). Writes the pick
    // back to the module default so the next new chat inherits it. Mid-chat this retires the session at the next
    // send, exactly like a provider/account switch — the runtimes mint incompatible sessions. Meaningful only for
    // codex/grok; claude is always its own loop.
    selectHarness(next: AgentHarness): void {
        if (this.streaming.value || next === this.harness.value) {
            return;
        }
        this.harness.value = next;
        turnDefaults.harness.value = next;
        this.activeModel.value = null;
        this.contextUsage.value = undefined;
        this.refreshSwitchNotice();
    }

    // Retract the pending "switched" divider — the change it announced is no longer what the next send does.
    private dropSwitchNotice(): void {
        const noticeId = this.pendingSwitchNoticeId;
        if (noticeId === undefined) {
            return;
        }
        this.transcript.write((state) => ({ ...state, messages: state.messages.filter((message) => message.id !== noticeId) }));
        this.pendingSwitchNoticeId = undefined;
    }

    // Upsert/remove the one pending "switched" divider as the user toggles provider/account: no notice when the
    // next send still resumes the session (the selection matches it) or the chat hasn't begun; otherwise one
    // notice says what the next message starts. send() freezes it into the transcript at the segment cut.
    private refreshSwitchNotice(): void {
        const session = this.session.value;
        const started = this.messages.value.length > 0 || session !== undefined;
        if (resumes(session, this.turnSettings()) || !started) {
            this.dropSwitchNotice();
            return;
        }
        // ACP providers have no tab entry — the shared label fallback (capability name layered by the picker,
        // else the raw id) covers them.
        const label = providerTabs.find((tab) => tab.value === this.provider.value)?.label ?? providerLabel(this.provider.value);
        // A restored codex/grok tab has a session but no readable transcript (the daemon's reader is
        // Claude-only) — there is nothing to carry over, so say so instead of promising continuity.
        const text = this.messages.value.some((message) => message.role !== `notice`)
            ? `Switched to ${label} — your next message starts a fresh session with the conversation so far carried over.`
            : `Switched to ${label} — your next message starts a fresh session (the earlier transcript isn't available to carry over).`;
        const noticeId = this.pendingSwitchNoticeId;
        if (noticeId !== undefined) {
            this.transcript.write((state) => ({
                ...state,
                messages: state.messages.map((message) => (message.id === noticeId ? { ...message, text } : message)),
            }));
            return;
        }
        this.pendingSwitchNoticeId = this.transcript.append({ role: `notice`, text });
    }

    // Mirror the settled transcript to the local cache (see transcriptCache), so reopening this conversation
    // paints from disk rather than waiting on the sandbox. Fire-and-forget, and only where the transcript has
    // settled — a turn ending, a remote transcript landing — never per streamed frame.
    // `authoritative` is the daemon's own replay, which may legitimately shrink the mirror; everything else is
    // this window reporting what it is showing, which can be a fraction of the conversation (see saveTranscript).
    private persist(authoritative = false): void {
        // Timed because an unconfirmed write READS the mirror back before deciding whether it may shrink it
        // (see saveTranscript), so this is two IndexedDB transactions plus a copy of up to 300 messages — and
        // it fires on every turn boundary. `messages` is what its cost scales with.
        void trackPerf(`chat.persist`, { messages: this.messages.value.length, authoritative }, () =>
            saveTranscript(this.conversationId, this.messages.value, authoritative),
        );
    }

    // Paint the locally cached transcript, if there is one and nothing has been rendered yet. Returns whether
    // anything was painted. The daemon still reconciles afterwards and REPLACES this — the cache only decides
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

    // Seed this conversation as a BRANCH of `source` taken just before `index`: the turns before that point
    // become this conversation's transcript and its settings ride across, while the source is left completely
    // untouched — that is the whole point of branching over rewinding. No session is carried: a branch is a
    // new conversation daemon-side, and its first send seeds a fresh one from the transcript above via the
    // same `history` mechanism a provider switch already uses.
    branchFrom(source: Conversation, index: number): void {
        this.transcript.rebuild(source.messages.value.slice(0, index));
        this.provider.value = source.provider.value;
        this.harness.value = source.harness.value;
        this.account.value = source.account.value;
        this.model.value = source.model.value;
        // The PICK, not what it currently clamps to — a branch inherits the user's choice, not one model's ceiling.
        this.effortPick.value = source.effortPick.value;
        this.thinking.value = source.thinking.value;
        this.fast.value = source.fast.value;
        // The pick again, for the same reason: a fork inherits the posture the user chose, not the one the
        // source's runtime happened to allow it.
        this.modePick.value = source.modePick.value;
        this.isolated.value = source.isolated.value;
        // Left null so send() names the branch after the edited message — two tabs sharing one title is the
        // one thing that makes a branch hard to find again.
        this.title.value = null;
    }

    /* GO BACK TO A MESSAGE. The daemon restores the workspace to the checkpoint that turn found, drops the
     * messages after it from its record, and forgets the provider session; this then makes the tab agree.
     *
     * The two indices are different numbers and mixing them is the bug this method exists to not have.
     * `message.rewindIndex` is the position in the DAEMON's transcript — what the route addresses — while the
     * slice below is over the BUBBLES, which additionally carry local notices the daemon never recorded.
     *
     * The local session is dropped to match the daemon's: the next send then starts a fresh provider thread
     * rather than resuming one whose context still describes the edits just rolled back. Returns false when
     * the daemon refused (a turn is running, or that message has no checkpoint) — the tab is left untouched,
     * because a transcript cut against a workspace that never moved is the one state with no way back. */
    async rewindTo(message: ChatMessage): Promise<boolean> {
        const index = message.rewindIndex;
        const bubble = this.messages.value.indexOf(message);
        if (index === undefined || bubble < 0) {
            return false;
        }
        const response = await sandboxRequest(`/agent/rewind`, {
            method: `POST`,
            headers: { "content-type": `application/json` },
            body: JSON.stringify({ conversationId: this.conversationId, index }),
        });
        if (!response.ok) {
            this.error.value =
                response.status === 409
                    ? `This agent is running a turn — stop it before going back.`
                    : `That message can no longer be gone back to.`;
            return false;
        }
        this.transcript.rebuild(this.messages.value.slice(0, bubble));
        this.session.value = undefined;
        this.error.value = null;
        this.persist(true);
        return true;
    }

    // Redraw the bubbles of a transcript the daemon replayed, leaving every other property of the conversation
    // alone. This is the whole of what a RESTORED tab needs: it already carries its own session, title,
    // provider and isolation from the tab snapshot, and overwriting those with the history-menu defaults below
    // would quietly move an isolated agent's next turn onto the main tree.
    restoreMessages(messages: readonly RestoredMessage[]): void {
        this.transcript.rebuild(
            messages.map((message, index) => ({
                role: message.role,
                text: message.text,
                /* The rewind anchor. The array position IS the daemon's index here — this is the record read
                 * back verbatim, one bubble per stored row — which is the one moment the two numberings are
                 * guaranteed to agree, and why the index is captured now rather than recomputed later from a
                 * bubble list that has since grown local notices.
                 *
                 * Only where the daemon supplied a checkpoint: it stamps one on the messages that still have a
                 * state to go back to, so an offer here is an offer the rewind route will honour. */
                ...(message.checkpointId !== undefined ? { checkpointId: message.checkpointId, rewindIndex: index } : {}),
                // Chips from the restored workspace-relative paths; thumbnails re-mint from the
                // workspace bytes at render time (attachmentPreview) — object URLs don't survive here.
                ...(message.attachments !== undefined && message.attachments.length > 0
                    ? { attachments: message.attachments.map((path) => ({ name: path.split(`/`).at(-1) ?? path, path })) }
                    : {}),
                ...(message.thinking !== undefined ? { thinking: message.thinking } : {}),
                ...(message.tools !== undefined ? { tools: message.tools } : {}),
            })),
        );
        this.error.value = null;
        this.persist(true);
    }

    // Restore a past conversation pulled from the history menu: build bubbles from the stored transcript and
    // arm its session so the next turn resumes it in the sandbox. Unlike restoreMessages this also seeds the
    // conversation's identity, because the tab it lands in is a fresh one that has none.
    loadTranscript(messages: readonly RestoredMessage[], sessionId: string, title: string | null): void {
        this.restoreMessages(messages);
        // History-menu sessions live in the MAIN tree's session namespace — resuming one in a worktree would
        // miss it. The fleet's own open path rehydrates isolated conversations separately.
        this.isolated.value = false;
        // ...and a turn on the tree the user is looking at plans before it touches anything.
        this.modePick.value = startingMode(false);
        // The history menu lists Claude sessions only, so a restored conversation resumes on Claude, under the
        // current default Claude account (the transcript carries no account of its own).
        const account = rememberedAccountFor(`claude`);
        this.session.value = { id: sessionId, provider: `claude`, account, harness: `native` };
        this.provider.value = `claude`;
        this.harness.value = `native`;
        this.account.value = account;
        this.model.value = rememberedModelFor(`claude`);
        this.title.value = title;
        this.activeModel.value = null;
    }

    async send(prompt: string, settings: TurnSettings, attachments: readonly ChatAttachment[] = [], editorContext?: EditorContext): Promise<void> {
        const text = prompt.trim();
        if (text.length === 0 && attachments.length === 0) {
            return;
        }
        // Stop makes the local stream idle before the daemon can finish unwinding. A direct send (branches and
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
        // The session is resumed only while the selection still matches the runtime/account that minted it — a
        // switched provider or account retires it, and the transcript so far (captured before this turn's
        // bubbles land) seeds the replacement session on the new runtime.
        const session = this.session.value;
        const resume = resumes(session, settings) ? session : undefined;
        if (resume === undefined) {
            this.session.value = undefined;
            // A turn that can't resume runs under a NEW sdk session, so it will run its Bash in a different
            // tmux session — the remembered one belongs to the segment that just ended, and offering to watch
            // it would point at a shell this conversation no longer uses.
            this.agentTerminal.value = undefined;
            this.agentBrowser.value = undefined;
        }
        const history = resume === undefined ? transcriptOf(this.messages.value).slice(-200) : [];
        // The switch divider (if any) is frozen into the transcript — the segment cut happened.
        this.pendingSwitchNoticeId = undefined;
        // First message of a fresh conversation names it — free, no model call. An attachment-only send has no
        // prose to read, so it is named after what was dropped in.
        if (this.title.value === null) {
            this.title.value = deriveTitle(text.length > 0 ? text : attachments.map((file) => file.name).join(`, `));
        }
        const userMessageId = this.transcript.append({ role: `user`, text, ...(attachments.length > 0 ? { attachments } : {}) });
        // Streaming context for the turn: the current text bubble — a fresh empty assistant message (so the
        // typing indicator shows immediately; a plan card clears it so the post-decision continuation streams
        // into a new bubble below the card) — plus the provider/account attribution for the session frame.
        this.transcript.openBubble();
        const turn: TurnContext = { userMessageId, provider: settings.agent, account: settings.account, harness: settings.harness };
        // This turn starts from the user's pick; the previous turn's live posture (a plan it entered, a mode an
        // approval landed in) is history, and the daemon will echo this one back at init. Only this path clears
        // it — a REATTACHED turn is already running under a posture of its own, and blanking the composer's
        // live pill until the next `mode` frame would be a lie in the other direction.
        this.liveMode.value = undefined;
        const controller = new AbortController();
        this.beginTurn(controller, Date.now());

        // Uploaded attachments plus @-mentioned workspace paths — one wire field, the daemon resolves both the
        // same way (workspace-relative → absolute, folded into the prompt as a Read-tool note). Mentions never
        // render as chips: they're already visible inline in the text.
        const attachmentPaths = [
            ...attachments.map((file) => file.path),
            ...mentionPaths(text).filter((path) => !attachments.some((file) => file.path === path)),
        ];
        try {
            const response = await sandboxRequest(`/agent`, {
                method: `POST`,
                headers: { "content-type": `application/json` },
                signal: controller.signal,
                body: JSON.stringify(
                    turnRequestBody({
                        text,
                        conversationId: this.conversationId,
                        title: this.title.value,
                        isolated: this.isolated.value,
                        mode: this.mode.value,
                        settings,
                        resume,
                        history,
                        attachmentPaths,
                        editorContext,
                    }),
                ),
            });
            if (!response.ok) {
                throw new Error(
                    response.status === 409
                        ? `This agent already has a turn running — wait for it to finish.`
                        : `Chat request failed (${response.status}).`,
                );
            }
            // The ack means the turn is running daemon-side regardless of what happens to this tab; from here
            // on this window is just one renderer of the run.
            const { run } = (await response.json()) as { run: string };
            await followRun(this.conversationId, { run, after: 0 }, { ...this.sink, ensureTurn: () => turn }, controller);
        } catch (err) {
            // A user-initiated Stop aborts the fetch; that's expected, not an error to surface.
            if (!(err instanceof DOMException && err.name === `AbortError`)) {
                this.error.value = errorMessage(err, `Chat failed.`);
            }
        } finally {
            this.endTurn();
        }
    }

    /* WHAT IT MEANS FOR A TURN TO BE LIVE IN THIS WINDOW, opened and closed in one place. Two paths run one —
     * send() starts a turn, reattach() adopts one already running daemon-side — and each wrote these same
     * assignments out longhand. The pair that has to move together is `streaming` + `inflight`: every
     * affordance the composer offers keys off them, so a path that set one without the other would leave a
     * Stop button attached to nothing. */
    private beginTurn(controller: AbortController, startedAt: number): void {
        this.inflight = controller;
        this.streaming.value = true;
        // Whatever interrupted the last turn is history, so THIS one's clean end may flush the queue.
        this.interrupted = false;
        this.error.value = null;
        // A live turn supersedes the waits a failed one opened — THIS turn is the retry, or the send that
        // replaced it, whether the scheduler fired it or another window did.
        this.failures.clear();
        this.turnStartedAt.value = startedAt;
    }

    // Settle it: drain whatever the typewriter still holds, drop the streaming affordances, mirror the finished
    // transcript, and let anything queued behind the turn go.
    private endTurn(): void {
        this.transcript.settle();
        this.inflight = null;
        this.streaming.value = false;
        // An in-turn retry belongs to the turn that was retrying. Whatever it settled as, the wait is over.
        this.providerRetry.value = undefined;
        // Nothing is streaming here, so nothing is replay — a stream that died mid-replay must not leave the
        // conversation permanently marked as re-telling history.
        this.replaying.value = false;
        this.turnStartedAt.value = undefined;
        this.failures.armRenewalProbe();
        this.persist();
        void this.drainQueue();
    }

    /* The composer's one send path — the message is accepted whatever the conversation is doing, and the
     * conversation works out how to deliver it (Claude Code's queue-and-steer):
     *   idle          → it starts a turn immediately, together with anything already queued behind it;
     *   turn running  → it is handed to that turn where the harness takes mid-turn input (injected between
     *                   tool calls), and otherwise waits for the turn to settle and goes as the next one.
     * An empty message with a non-empty queue is the user pressing Send on the queue itself, so it just drains.
     */
    enqueue(text: string, attachments: readonly ChatAttachment[] = [], editorContext?: EditorContext): Promise<void> {
        const trimmed = text.trim();
        // The user is driving again — a Stop's hold on the queue is released (see `interrupted`).
        this.interrupted = false;
        if (trimmed.length > 0 || attachments.length > 0) {
            this.queued.value = [
                ...this.queued.value,
                { id: crypto.randomUUID(), text: trimmed, attachments, ...(editorContext !== undefined ? { editorContext } : {}) },
            ];
        }
        return this.drainQueue();
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
        this.queued.value = [{ id: crypto.randomUUID(), text: bubble.text, attachments: bubble.attachments ?? [] }, ...this.queued.value];
    }

    // Release a hold placed by a failure the user has now fixed (reconnecting a revoked account) and let
    // whatever was held ride immediately. Nothing happens when the queue is empty, so calling it on every
    // conversation after a reconnect is safe.
    resume(): Promise<void> {
        this.interrupted = false;
        this.error.value = null;
        return this.drainQueue();
    }

    // Move this conversation onto a re-connected credential for the SAME human account. The session ref moves
    // with it: a reconnect mints a new local account id, and leaving the old one on the session would read as a
    // deliberate account switch and retire a live session that resumes perfectly well — the user reconnected to
    // carry on, not to start over.
    rebindAccount(accountId: string): void {
        this.account.value = accountId;
        const session = this.session.value;
        if (session !== undefined) {
            this.session.value = { ...session, account: accountId };
        }
        // Not a switch the user made — the same human account, re-credentialled — so no "switched to…" divider.
        // A pending one is retracted: whatever it announced, the next send now just carries on.
        this.dropSwitchNotice();
    }

    /* Deliver what's waiting, oldest first. A running turn takes them one at a time over /agent/steer; the
     * daemon is the authority on whether it can (a native codex/grok/ACP turn has no steering queue and
     * answers NOT_FOUND), so a refusal simply leaves the message queued for the settle below rather than
     * needing this client to predict the harness. A turn parked on a card is skipped too: the card is what the
     * agent is waiting on, so the message goes in once it's answered (the decide* methods drain again).
     *
     * With nothing running, the whole queue rides ONE fresh turn — "also do Y", written while the agent worked,
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
            // a turn nobody asked for. Same for a flush already in flight — it owns these messages.
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
    // whatever is selected when it actually goes — the same rule a typed message follows.
    turnSettings(): TurnSettings {
        return {
            agent: this.provider.value,
            harness: this.harness.value,
            account: this.account.value,
            model: this.model.value,
            effort: this.effort.value,
            thinking: this.thinking.value,
            // The pick AND the offer: a toggle left on from a fast-capable model must not ride along to one
            // that doesn't publish fast mode, where the harness would refuse it and the user would read the
            // refusal as a bug. Same shape as `effort` clamping to the model's own tier list.
            fast: this.fast.value && this.fastOffered.value,
        };
    }

    // Hand one queued message to the running turn (the daemon injects it between tool calls), moving it into
    // the transcript once the daemon has it. False when no steerable turn is live — the message stays queued.
    // The running turn keeps streaming into its current bubble (above this message — that output answers what
    // came before); the `usage` frame closing the current turn retires the bubble, so the answer to this
    // message opens a fresh one below it.
    private async deliverSteer(message: QueuedMessage): Promise<boolean> {
        const paths = message.attachments.map((file) => file.path);
        const delivered = await postTurnControl(`/agent/steer`, {
            conversationId: this.conversationId,
            text: message.text,
            ...(paths.length > 0 ? { attachments: paths } : {}),
            ...(message.editorContext !== undefined ? { editorContext: message.editorContext } : {}),
        });
        if (!delivered) {
            return false;
        }
        this.removeQueued(message.id);
        this.transcript.append({
            role: `user`,
            text: message.text,
            ...(message.attachments.length > 0 ? { attachments: message.attachments } : {}),
        });
        return true;
    }

    // User-initiated Stop button: retire any card the turn was parked on, record a muted notice, hard-cancel
    // the turn daemon-side (/agent/stop), then abort the local stream. The control request is retained as a
    // barrier for the next send: its response means the detached run has released the conversation lock.
    stop(): void {
        if (!this.streaming.value) {
            return;
        }
        this.cancelPendingCards();
        this.transcript.notice(`Stopped.`);
        const stopping = postTurnControl(`/agent/stop`, { conversationId: this.conversationId }).then(() => undefined);
        this.stopping = stopping;
        void stopping.finally(() => {
            if (this.stopping === stopping) {
                this.stopping = undefined;
            }
        });
        this.abort();
        this.persist();
    }

    // Freeze whatever the stopped turn was parked on. Stop is offered WHILE a plan / question / permission card
    // is open — a turn holding the user's attention is exactly when they most want out — and the daemon settles
    // its own waiter with an abort reply, so the local card must stop asking too: /agent/reply would 404 from
    // here on, and a card left `pending` would keep awaitingDecision (and with it the composer's plan-feedback
    // routing and the tab's "awaiting" status) wedged on a turn that no longer exists.
    private cancelPendingCards(): void {
        if (!this.awaitingDecision.value) {
            return;
        }
        this.transcript.write((state) => ({ ...state, messages: state.messages.map(withCancelledCards) }));
    }

    // Aborts this tab's attach stream; whatever streamed so far stays in the transcript. The run itself is
    // detached daemon-side, so this is soft BY DESIGN — stop() above pairs it with /agent/stop to hard-cancel.
    // Called bare by the manager when its tab is closed: the turn finishes and lands its work, and reopening
    // the conversation reattaches to it.
    abort(): void {
        // The turn is ending on someone's say-so, not its own — hold the queue back from the settle flush
        // (a closed tab must not fire a turn; a stopped agent must not be immediately restarted).
        this.interrupted = true;
        this.transcript.settle();
        this.probe?.abort();
        this.inflight?.abort();
        this.failures.cancelProbe();
    }

    // Attach to a turn already running daemon-side — started before a reload, or by another window/device on
    // the same conversation. False when nothing is live (or recently finished): the caller falls back to
    // transcript hydration. The attach head synthesizes what the initiating window appended locally: the
    // user bubble from the run's prompt and the elapsed readout from its start time.
    async reattach(): Promise<boolean> {
        if (this.streaming.value) {
            return true;
        }
        const controller = new AbortController();
        this.probe = controller;
        let engaged = false;
        const ensureTurn = (head: AttachHead): TurnContext | undefined => {
            // A send that started between this probe's entry check and the daemon's reply owns the stream.
            if (this.streaming.value) {
                return undefined;
            }
            engaged = true;
            this.beginTurn(controller, head.startedAt);
            /* What the user actually asked, whichever run this is. A run the DAEMON restarted carries the original
             * prompt behind a note saying why (RESUME_NOTES), and rendering that verbatim put a paragraph of
             * machine prose into the transcript as something the user had supposedly typed — right under the copy
             * of it they really did type. Stripped, it matches that copy, and the bubble is reused instead.
             *
             * The strip is also what identifies a resume, which is what decides whether the tail under that bubble
             * belongs to this run — see reuseUserBubble. */
            const prompt = withoutResumeNote(head.prompt);
            const userMessageId =
                this.transcript.reuseUserBubble(prompt, prompt === head.prompt) ?? this.transcript.append({ role: `user`, text: prompt });
            this.transcript.openBubble();
            return { userMessageId, provider: this.provider.value, account: this.account.value, harness: this.harness.value };
        };
        try {
            return await followRun(this.conversationId, { run: undefined, after: 0 }, { ...this.sink, ensureTurn }, controller);
        } finally {
            this.probe = undefined;
            if (engaged) {
                this.endTurn();
            }
        }
    }

    /* THE ONE PATH EVERY CARD ANSWER TAKES. All three kinds (plan, question, permission) are decided the same
     * way — un-park the turn on the daemon's side channel, and only once it has actually taken the answer
     * freeze that answer into the transcript — and they were written out once per method, which is how the
     * "could not record it" wording came to differ four ways for one failure. Ordering is the part worth
     * holding in one place: the daemon goes first, because a card frozen against a reply that 404'd reads as
     * answered while the agent is still waiting on it.
     *
     * Returns whether the decision landed. What happens NEXT genuinely differs per card — a notice, the
     * rejection feedback as a user bubble, stopping the turn — so the callers keep their own tails. */
    private async decide(id: number, body: AgentReply, failure: string, decided: Pick<ChatMessage, CardKind>): Promise<boolean> {
        if (!(await postTurnControl(`/agent/reply`, body))) {
            this.error.value = failure;
            return false;
        }
        this.transcript.attachCard(id, decided);
        return true;
    }

    /* Answers a pending plan card. The turn is parked on ExitPlanMode, so on approval it executes in `mode`
     * (the "auto-accept edits" vs "approve each edit" choice) and streams a closing turn; on rejection the
     * feedback is fed back and it re-plans.
     *
     * Feedback may carry the composer's staged files. The reply has ONE text field on the wire, so they go up
     * the way a user would type them — as `@`-prefixed workspace paths, which is exactly what mentionPaths
     * produces for an ordinary send and what the harness resolves at the other end. The alternative was the
     * rule this replaces ("plan feedback is text-only"), which refused the single most natural way to say what
     * a plan got wrong: a screenshot. */
    async decidePlan(
        message: ChatMessage,
        approve: boolean,
        mode: PermissionMode,
        feedback?: string,
        attachments: readonly ChatAttachment[] = [],
    ): Promise<void> {
        const plan = message.plan;
        if (plan?.status !== `pending`) {
            return;
        }
        const trimmed = feedback?.trim();
        const written = [trimmed, ...attachments.map((file) => `@${file.path}`)].filter(Boolean).join(`\n`);
        const landed = await this.decide(
            message.id,
            { kind: `plan`, requestId: plan.requestId, approve, mode, feedback: written.length > 0 ? written : undefined },
            `Could not record your plan decision — the turn may have ended.`,
            { plan: { ...plan, status: approve ? `approved` : `rejected` } },
        );
        if (!landed) {
            return;
        }
        this.transcript.notice(approve ? `Plan approved.` : `Kept planning.`);
        // Keep the rejection feedback visible as the user's turn — otherwise the typed text (and the files it
        // went with) vanish from the transcript even though the agent has them.
        if (!approve && (trimmed !== undefined || attachments.length > 0)) {
            this.transcript.append({ role: `user`, text: trimmed ?? ``, ...(attachments.length > 0 ? { attachments } : {}) });
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
            message.id,
            { kind: `question`, requestId: question.requestId, answers },
            `Could not submit your answers — the turn may have ended.`,
            { question: { ...question, status: `answered`, answers } },
        );
        if (landed) {
            void this.drainQueue();
        }
    }

    // Dismisses a pending question AND stops the turn. This TELLS the daemon (cancelled), rather than just
    // dropping the stream: the agent is parked inside its `ask` tool holding the conversation's run lock, so a
    // client-side-only dismissal would wedge the conversation until the daemon restarted.
    //
    // Stopping is the point, not a side effect — it is what Claude Code does, and for the same reason. The card
    // was raised because the agent could not choose for itself; waving it away answers nothing, so letting the
    // turn run on means it guesses at exactly the fork it just said it could not guess at. The user gets the
    // wheel back instead, with the transcript recording both halves ("Question dismissed." then "Stopped.").
    async cancelQuestion(message: ChatMessage): Promise<void> {
        const question = message.question;
        if (question?.status !== `pending`) {
            return;
        }
        const landed = await this.decide(
            message.id,
            { kind: `question`, requestId: question.requestId, cancelled: true },
            `Could not dismiss the question — the turn may have ended.`,
            { question: { ...question, status: `cancelled` } },
        );
        if (!landed) {
            return;
        }
        this.transcript.notice(`Question dismissed.`);
        // After the card is frozen, so it reads back as dismissed rather than as a card the Stop caught pending.
        this.stop();
    }

    // Answers a pending permission card. 'once' allows just this call, 'always' also persists the rules the
    // SDK suggested so the same tool stops asking, 'deny' blocks it — and stops the turn, for the same reason a
    // dismissed question does (see cancelQuestion). The card offers no free text, so a denial hands the agent
    // nothing to redirect with; Claude Code draws the line in exactly that place, aborting a denial that carries
    // no feedback and letting one that does carry some steer the turn onward.
    async decidePermission(message: ChatMessage, decision: "once" | "always" | "deny", feedback?: string): Promise<void> {
        const permission = message.permission;
        if (permission?.status !== `pending`) {
            return;
        }
        const status = decision === `deny` ? `denied` : decision === `always` ? `always` : `allowed`;
        const landed = await this.decide(
            message.id,
            { kind: `permission`, requestId: permission.requestId, decision, feedback },
            `Could not record your decision — the turn may have ended.`,
            { permission: { ...permission, status } },
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

    /* One folded frame's consequences for the conversation, in the order the frames arrived. Both orderings
     * here matter and neither can be hoisted: `providerRetry` is cleared by any other frame and SET by an
     * effect below, so a batch holding a retry and the frame that answers it would otherwise settle on
     * whichever won the reshuffle. */
    private applied(event: AgentEvent, turn: TurnContext, effects: readonly TurnEffect[]): void {
        // Any other frame means the wait a provider_retry described is over — the request went through, or
        // the turn moved on to a different problem. Retired against any frame rather than specific ones
        // because "still waiting" is only true until literally anything else happens, and a replayed
        // transcript must not restore a countdown that finished minutes ago.
        if (event.kind !== `provider_retry`) {
            this.providerRetry.value = undefined;
        }
        for (const effect of effects) {
            this.applyEffect(effect, turn);
        }
    }

    private applyEffect(effect: TurnEffect, turn: TurnContext): void {
        switch (effect.kind) {
            case `session`:
                // Captured with the turn's provider/account so a later mismatch (a mid-chat switch) is
                // detectable at send time.
                this.session.value = { id: effect.sessionId, provider: turn.provider, account: turn.account, harness: turn.harness };
                return;
            case `worktree`:
                // First frame of an isolated turn: which branch/base this conversation works on.
                this.worktree.value = { branch: effect.branch, base: effect.base };
                /* The container cannot enforce the worktree with mounts, so the harness is redirecting tool
                 * paths into it instead — which covers tool input but not a path a subprocess computes for
                 * itself. Said ONCE per conversation rather than per turn: it is a property of the sandbox, it
                 * does not change while it runs, and repeating it every turn would train the reader to skip it. */
                if (effect.unenforced === true && !this.warnedUnenforced) {
                    this.warnedUnenforced = true;
                    this.transcript.notice(
                        `This sandbox can't isolate agent turns at the filesystem level (it was created without CAP_SYS_ADMIN). Work is redirected into ${effect.branch}, but a command that builds its own paths can still reach the shared workspace — recreate the sandbox to restore full isolation.`,
                    );
                }
                return;
            case `liveMode`:
                // The turn's live posture — the user's pick echoed back at init, or a move the AGENT made
                // (EnterPlanMode / a plan approval). Drives the composer's selector so it never lies, without
                // overwriting the pick the NEXT turn starts from.
                this.liveMode.value = effect.mode;
                return;
            case `commands`:
                // The provider's slash commands (ACP agents), replaced whole — the composer's `/` popover.
                this.availableCommands.value = effect.items;
                return;
            case `activeModel`:
                this.activeModel.value = effect.model;
                return;
            case `contextUsage`:
                // Per-conversation context-window fill — held on this instance (not the singleton) so the
                // composer shows the active chat's meter for auto-compaction awareness.
                this.contextUsage.value = effect.usage;
                return;
            case `totals`:
                // The conversation's lifetime accounting (the fleet card's cost/token readout). The usage's
                // TRANSCRIPT attachment already happened — it is a change to a bubble, so the reducer made it.
                this.costUsd.value += effect.usage.costUsd ?? 0;
                this.inputTokens.value += effect.usage.inputTokens ?? 0;
                this.outputTokens.value += effect.usage.outputTokens ?? 0;
                return;
            case `accountUsage`:
                // Account-wide subscription headroom, keyed by the account that served the turn so switching
                // accounts shows the right one. Stamped with the read time so it can be compared against the
                // daemon's persisted snapshot on the next `/accounts` load — whichever is newer wins, and the
                // picker can say how stale a reading is.
                usageStatusByAccount.value = {
                    ...usageStatusByAccount.value,
                    [effect.account]: { windows: [...effect.windows], measuredAt: Date.now() },
                };
                return;
            case `toolCall`: {
                const { call } = effect;
                // A MAIN-TREE turn writes the files the Changes panel commits, so its paths are recorded for the
                // panel to warn against — per repo, so an agent working in one repo says nothing about the rest.
                // An isolated turn writes its own worktree and lands as a reviewable diff, so it records nothing:
                // that distinction is the whole reason the panel no longer blocks committing on "an agent is
                // running", which was true of both and meaningful for neither.
                if (!this.isolated.value && this.turnStartedAt.value !== undefined) {
                    const startedAt = this.turnStartedAt.value;
                    void import(`../workspace/liveWrites`).then((m) => m.recordTurnWrite(this.conversationId, startedAt, call));
                }
                return;
            }
            case `surfaceTerminal`: {
                // The agent started running Bash in its live `agent-<id>` tmux terminal. Remember it, so this
                // conversation's Bash cards can offer to watch it, and tell the terminal layer whose it is, so
                // its popover names the conversation instead of eight hex characters. The panel is then asked to
                // surface it, which tabs it only if the user opted into work terminals — no auto-open, no focus
                // steal either way. Both imports are lazy so the chat model doesn't statically pull in the
                // xterm/terminal-panel chain.
                const { session } = effect;
                this.agentTerminal.value = session;
                const title = this.title.value;
                void import("../terminal/useWorkTerminals").then((m) => m.noteAgentTerminal(session, title));
                void import("../terminal/useTerminalPanel").then((m) => m.useTerminalPanel().surface(session));
                return;
            }
            case `surfaceBrowser`: {
                // The agent just used a browser tool. Everything above applies unchanged — the browser is the
                // same kind of thing as the shell (this conversation's, for this turn, watchable but hidden
                // until asked for), which is why it rides the same three calls rather than a parallel channel.
                const { session } = effect;
                this.agentBrowser.value = session;
                const title = this.title.value;
                void import("../terminal/useWorkTerminals").then((m) => m.noteAgentTerminal(session, title));
                void import("../terminal/useTerminalPanel").then((m) => m.useTerminalPanel().surface(session));
                return;
            }
            case `providerRetry`:
                // A wait, not a failure: the turn is still running. Held only while it is (see endTurn), so a
                // stale "retrying…" can never sit under a finished answer.
                this.providerRetry.value = effect.retry;
                return;
            case `fastMode`:
                // Deliberately NOT cleared at the turn boundary (see the ref): the answer usually outlives the
                // turn that reported it.
                this.fastMode.value = effect.fast;
                return;
            case `error`:
                this.failures.apply(effect, turn);
                return;
        }
    }
}
