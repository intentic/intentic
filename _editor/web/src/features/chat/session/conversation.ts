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
    type ModelPin,
    newConversationId,
    type PermissionMode,
    providerLabel,
    settledCards,
    type TranscriptCards,
    type ResumeRouting,
    type TranscriptPatch,
    type TranscriptRow,
    type TurnFact,
} from "@intentic/sandbox-contract";
import { errorMessage } from "@intentic/ui/async";
import { basename } from "@intentic/ui/path";
import { computed, ref } from "vue";
import { trackPerf } from "../../../app/perf";
import { sandboxError, sandboxRequestVia } from "../../sandbox/client/sandboxClient";
import { jsonBody } from "../../sandbox/client/jsonBody";
import { invalidateAgentTranscript, olderTranscriptPage } from "../transcript/agentTranscript";
import { AUTO_CONTINUE_PROGRESS_MS, AUTO_CONTINUE_TRIES, autoContinueDelay } from "../run/autoContinue";
import type { PickUp } from "../run/pickUp";
import { clampEffort } from "../models/effortScale";
import { rememberedAccountFor, selectedAccountId, setAccountUsage } from "../accounts/providerAccounts";
import { modelLabelFor, providerModels, providerTabs } from "../accounts/providerCatalog";
import { type ChatAttachment, type ChatMessage, continuationFor, isNudgeText, recordedRows, withCancelledCards } from "../transcript/transcript";
import { readTranscript, saveTranscript } from "../transcript/transcriptCache";
import { TranscriptClock } from "../transcript/transcriptClock";
import { rememberedModelFor, rememberedProviderFor, rememberPick, startingMode, turnDefaults, type TurnPick } from "../run/turnDefaults";
import { TurnFailures } from "../run/turnFailures";
import { type SessionRef, type TurnSettings, boundSession, resumes, turnRequestBody } from "../run/turnRequest";
import { type AttachEntry, type AttachHead, followRun, postTurnControl, type TurnContext } from "../run/turnStream";
import { formatReset, formatUtilization, isStale, modelAllowance, SPENT_PERCENT, usageStatusFor } from "./usageStatus";
import { uuid } from "../../../lib/uuid";

// A file staged in the composer, uploaded to the workspace immediately so send is instant; each gets its own uuid dir.
// `previewUrl` and `controller` are session-only, absent on a restored entry.
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

// A message sent while a turn runs, not yet delivered: steered into it if the harness takes mid-turn input,
// else sent as the next turn once it settles. Carries files and editor context like an ordinary message.
export interface QueuedMessage {
    readonly id: string;
    readonly text: string;
    readonly attachments: readonly ChatAttachment[];
    readonly editorContext?: EditorContext;
}

// Two adjacent queued nudges with no attachments (e.g. repeated "Continue") collapse into one: a second behind an
// undelivered first says nothing new. Never collapses against real words or attachments.
const repeatsNudge = (message: { readonly text: string; readonly attachments: readonly ChatAttachment[] }, neighbour?: QueuedMessage): boolean => {
    if (neighbour === undefined || message.attachments.length > 0 || neighbour.attachments.length > 0) {
        return false;
    }
    return isNudgeText(message.text) && isNudgeText(neighbour.text);
};

// What a conversation is doing right now, surfaced as the tab's status icon.
export type ConversationStatus = "idle" | "streaming" | "awaiting" | "error";

// One chat conversation: transcript, resumed session, and turn selection; self-contained so several run at once.
// Turn mechanics live in sibling files (turnStream, transcriptClock, turnFailures, turnRequest).
// Routing for re-running a held turn, read at the press; an empty pick means the daemon keeps the held model.
// `carry` keeps the provider session across an account change, only when asked.
const heldRouting = (settings: TurnSettings, options: { readonly carry?: boolean }): ResumeRouting => ({
    agent: settings.agent,
    harness: settings.harness,
    account: settings.account,
    model: settings.model || undefined,
    ...(options.carry === true ? { carry: true } : {}),
});

export class Conversation {
    // Transcript and its clock; `applied` below handles what a fact does to the conversation, not the transcript.
    private readonly transcript = new TranscriptClock((entry, turn, replay) => this.applied(entry, turn, replay));

    readonly messages = this.transcript.messages;
    // Whether a pane shows this transcript with focus, gating whether the typewriter types or settles text.
    readonly watched = this.transcript.watched;
    readonly streaming = ref(false);
    readonly error = ref<string | null>(null);
    // Offer to resume a turn that stopped short (stop, crash, outage, spent allowance); cleared by the next turn.
    readonly pickUp = ref<PickUp | undefined>();

    // Whether the daemon has accepted the current turn; false before its ack, true through an adopted reattach.
    private turnAccepted = false;

    // Standing instruction to re-run this chat whenever a turn ends `resumable`, persisted with the tab.
    readonly autoContinue = ref(false);
    readonly autoContinueAt = ref<number | undefined>();
    private autoContinueTimer: ReturnType<typeof setTimeout> | undefined;
    // Consecutive automatic continuations that bought nothing; reset by a turn that got somewhere or by re-arming.
    private autoContinueTries = 0;
    // True while a transcript read is in flight and nothing is painted, so the panel shows loading instead.
    readonly loading = ref(false);
    // Position of the oldest drawn message, and whether more sits above it; passed back as `before` to page further.
    readonly historyFrom = ref(0);
    readonly historyMore = ref(false);
    // A page of older turns is loading; unlike `loading`, which blanks the whole transcript instead of appending.
    readonly loadingOlder = ref(false);
    // This conversation's slash commands, replaced whole per `commands` frame, listed by the composer's `/` popover.
    readonly availableCommands = ref<readonly AgentCommand[]>([]);

    // True while a turn is parked on a card; `streaming` stays true too, but the composer shows Send, not Stop.
    readonly awaitingDecision = computed(() => this.messages.value.some(isAwaitingDecision));

    // Whether the model is actually generating, narrower than `streaming`: a parked card is streaming but not this.
    readonly generating = computed(() => this.streaming.value && !this.awaitingDecision.value);

    // Cards whose answer is in flight, by message id; claimed before the request leaves so it can't double-answer.
    private readonly deciding = ref<ReadonlySet<number>>(new Set());

    /** Whether this card's answer is on its way, for the view that must stop offering the other answers. */
    isDeciding(id: number): boolean {
        return this.deciding.value.has(id);
    }

    // Message carrying a plan awaiting decision, if any; routes feedback into a plan rejection instead of a fresh turn.
    readonly pendingPlanMessage = computed(() => this.messages.value.find((message) => message.plan?.status === `pending`));

    // Header title for this conversation; null shows "New chat". Derived from the first user message.
    readonly title = ref<string | null>(null);

    // The model the SDK actually resolved for the latest turn (from its init message), when reported.
    readonly activeModel = ref<string | null>(null);

    // Context-window fill for this conversation (tokens sent vs the model's window), updated at the end of each turn.
    readonly contextUsage = ref<ContextUsage | undefined>();

    // The user's permission posture, the composer's own pick; only the user writes it.
    readonly modePick = ref<PermissionMode>(startingMode(true));

    // Posture the next turn starts in: the pick clamped to what this conversation's runtime can hold.
    readonly mode = computed<PermissionMode>(() => clampMode(this.modePick.value, this.capabilities.value));

    // Posture the running turn is actually in (the agent's own mode frames); display-only, cleared at each send.
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

    // Session the next matching turn resumes, with the provider/account that minted it; public for the manager.
    readonly session = ref<SessionRef | undefined>();

    // tmux session this conversation's Bash runs in (`agent-<sdk session>`); undefined until the first Bash.
    readonly agentTerminal = ref<string | undefined>();

    // Same as `agentTerminal`, for the browser this conversation's agent drives (`browser-<sdk session>`).
    readonly agentBrowser = ref<string | undefined>();

    // Whether this conversation's turns run in an isolated git worktree (default) or the shared /work tree.
    readonly isolated = ref(true);

    // Machine this conversation runs on: a paired runner's id, or undefined for this sandbox; latched early.
    readonly runner = ref<string | undefined>();

    // Sandbox this conversation lives in, or undefined for this browser's box; every call routes through `this.at`.
    readonly box = ref<string | undefined>();

    // Address every request in this class is aimed at: the box above, or undefined for the active sandbox.
    private get at(): string | undefined {
        return this.box.value;
    }

    // A remote conversation is registered by its ack, since no roster frame for another box reaches this browser.
    // A no-op for a conversation in this box; called only on the send path's ack.
    private latchRemoteRegistration(): void {
        if (this.box.value !== undefined) {
            this.registered.value = true;
        }
    }

    // Whether the fleet has ever known this conversation; latches rather than tracks the roster, so a dropped roster
    // can't un-register it. Persisted with the tab.
    readonly registered = ref(false);

    // A tab opened for a glance (fleet card, history row); swept once focus leaves unless `keep()` promotes it.
    readonly peek = ref(false);

    // Promote this chat out of the peek slot: the user is acting on it now, not just glancing. Called by the verbs that
    // change the conversation, never by ones the daemon drives.
    keep(): void {
        this.peek.value = false;
    }

    // Blank fallback a panel shows with no tabs, or after closing its last; says nothing about what the chat is.
    readonly standIn = ref(false);

    // Worktree identity from the turn's `worktree` frame: agent/<id> branch and base sha; undefined until isolated.
    readonly worktree = ref<{ branch: string; base: string } | undefined>();

    // Whether this tab already warned the sandbox can't enforce worktrees with mounts; latches for the chat's life.
    private warnedUnenforced = false;

    // Lifetime accounting summed off the rows on screen; the daemon's registry is the cross-device authoritative total.
    readonly costUsd = computed(() => this.messages.value.reduce((sum, message) => sum + (message.usage?.costUsd ?? 0), 0));
    readonly inputTokens = computed(() => this.messages.value.reduce((sum, message) => sum + (message.usage?.inputTokens ?? 0), 0));
    readonly outputTokens = computed(() => this.messages.value.reduce((sum, message) => sum + (message.usage?.outputTokens ?? 0), 0));

    // Start of the in-flight turn (ms), for the card's elapsed readout; undefined while idle.
    readonly turnStartedAt = ref<number | undefined>();

    // This conversation's turn selection, switchable mid-chat; `seedPicks` fills the starting values.
    readonly provider = ref<AgentProvider>(`claude`);
    readonly harness = ref<AgentHarness>(`native`);
    readonly account = ref<string | undefined>();
    readonly model = ref<string>(``);
    // Provider/model the app moved this chat FROM when it couldn't run there; cleared by restoreProvider or a pick.
    readonly movedFrom = ref<TurnPick | undefined>();
    readonly thinking = ref<boolean>(true);
    // Ask for fast speed on this chat's turns; not seeded from turnDefaults, since fast mode costs more.
    readonly fast = ref<boolean>(false);
    // Standing veto over automatic tier selection; sent as an explicit boolean every turn to clear an earlier hold.
    readonly tierHold = ref<boolean>(false);
    // Persona this chat acts as externally, or undefined for the ordinary chat with every account; not sticky.
    readonly actsAs = ref<string | undefined>();
    // Saved workflow design the next message runs through, if any; not sticky, clears on send.
    readonly workflowId = ref<string | undefined>();
    // Saved loop the next message runs as, if any; not sticky, clears on send like `workflowId`.
    readonly loopId = ref<string | undefined>();
    // Reasoning effort the user asked for; not always runnable, since the tier scale belongs to the model.
    readonly effortPick = ref<string>(``);

    // Tier the next turn actually runs at: the pick clamped to what the current provider+model+thinking triple offers.
    readonly effort = computed<string>(() => clampEffort(this.effortPick.value, this.provider.value, this.model.value, this.thinking.value));

    // This conversation's composer draft: unsent text and staged attachments; per-tab, persisted per sandbox.
    readonly draft = ref(``);
    readonly attachments = ref<PendingAttachment[]>([]);

    // When the composer first held something unsent, for age-based UnsentMark; cleared on the reverse edge.
    readonly draftAt = ref<number | undefined>();

    // Message being re-asked, keyed by id; disarmed by any transcript replacement, since ids repeat across transcripts.
    readonly editing = ref<{ readonly id: number; readonly restore: string; readonly attachments: readonly PendingAttachment[] } | undefined>();

    // Messages submitted while a turn ran, not yet delivered; see enqueue/drainQueue. Rendered above the composer.
    readonly queued = ref<QueuedMessage[]>([]);

    // Whether this window holds words nowhere else does (draft, attachment, queued message); guards a tab from closing.
    readonly unsent = computed<boolean>(() => this.draft.value.trim() !== `` || this.attachments.value.length > 0 || this.queued.value.length > 0);

    // Harness retrying inside the live turn; nothing has failed. Cleared once the turn produces anything or settles.
    readonly providerRetry = ref<Extract<TurnFact, { kind: `provider_retry` }> | undefined>();

    // Speed the harness actually served the last turn at, with its reason if not the one asked for; kept across turns.
    readonly fastMode = ref<Extract<TurnFact, { kind: `fast_mode` }> | undefined>();

    // What the complexity judge said about the last judged turn; kept across turns, replaced by the next verdict.
    readonly tierAnswer = ref<Extract<TurnFact, { kind: `tier` }> | undefined>();

    // Last tier verdict alone, outliving `tierAnswer`: seeded from the entry so a preview judges like the daemon.
    readonly lastTier = ref<`fast` | `standard` | undefined>();

    // What this provider/harness pair can actually do (capabilitiesOf), the record the daemon plans the turn against.
    readonly capabilities = computed(() => capabilitiesOf(this.provider.value, this.harness.value));

    // Whether the running turn can absorb a mid-flight message; used only for wording ("steer" vs "queue").
    readonly steerable = computed(() => this.capabilities.value.steering);

    // Whether the fast control is offered at all (runtime, route, model must all allow it); the pick stays untouched.
    readonly fastOffered = computed(() =>
        fastAllowed(
            this.capabilities.value,
            this.provider.value,
            (providerModels.value[this.provider.value] ?? []).find((option) => option.value === this.model.value)?.badges,
        ),
    );

    // What a failed turn does to this conversation and how a return is waited out; public for the banner and notice.
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

    // What a followed run writes into; each call supplies its own `attached`.
    private readonly sink = {
        entry: (entry: AttachEntry, turn: TurnContext, replay: boolean): void => this.transcript.push(entry, turn, replay),
    };

    // Tool ids this turn has already drawn, so a card's first arrival can be told from its updates; cleared per turn.
    private liveTools = new Set<string>();

    // The one unsent "switched" divider notice, upserted/removed as settings toggle, frozen by the next send.
    private pendingSwitchNoticeId: number | undefined;

    // A switch made while parked on a card, owed a divider it couldn't get then; the settle hook draws it.
    private switchedMidTurn = false;

    // Model the last SENT turn went out under, not `activeModel`; the baseline a model swap is measured against.
    private sentModel: string | undefined;

    // Where this conversation was cut from, until the daemon accepts a turn carrying it; a fork's only record.
    readonly pendingForkOf = ref<{ conversationId: string; keep: number; files: "then" | "now" } | undefined>(undefined);

    // Aborts the in-flight attach stream on Stop/tab close; the turn runs detached, only /agent/stop cancels it.
    private inflight: AbortController | null = null;

    // Resolves once the daemon's detached run has settled after a Stop; else the next send could race its cleanup.
    private stopping: Promise<void> | undefined;

    // In-flight reattach probe (see reattach), aborted by a send so the two never race the same run.
    private probe: AbortController | undefined;

    // Set by abort/Stop/tab close/sandbox switch; an interrupted turn must not flush the queue on its own.
    private interrupted = false;

    // True while drainQueue owns the idle flush, so a second drain can't send the same messages twice.
    private flushing = false;

    // The conversation's whole identity: key for the fleet entry, worktree, tab, and mirror; a word pair, not a UUID.
    constructor(readonly conversationId: string = newConversationId()) {
        this.seedPicks();
    }

    // What an untouched chat starts on: the last deliberate pick, resolved against what this sandbox can run.
    // Re-seeded, not just seeded at construction, so "New agent" reopening a draft doesn't wear a stale pick.
    seedPicks(): void {
        const provider = rememberedProviderFor();
        this.provider.value = provider;
        this.harness.value = turnDefaults.harness.value;
        this.account.value = rememberedAccountFor(provider);
        this.model.value = rememberedModelFor(provider);
        this.effortPick.value = turnDefaults.effort.value;
        this.thinking.value = turnDefaults.thinking.value;
        // Born displaced when the pick couldn't run and something else was substituted (see movedFrom).
        const picked = turnDefaults.provider.value;
        this.movedFrom.value = picked === provider ? undefined : { provider: picked, value: rememberedModelFor(picked) };
    }

    // Switch the provider this chat's next turn runs on, re-scoping provider settings; writes the module default.
    // Mid-chat this takes effect at the next send; browsing the picker never destroys the session.
    selectProvider(next: AgentProvider): void {
        if (!this.pointAt(next)) {
            return;
        }
        this.keep();
        // A choice, so nothing is owed back: whatever the app had moved this chat from no longer applies.
        this.movedFrom.value = undefined;
        rememberPick({ provider: next, value: this.model.value });
    }

    // The same switch made by the app, not the user; re-scopes like a pick but does not write the module default.
    // Records the pick it moved the chat off (`movedFrom`) so the move can be undone later, for this chat alone.
    repointProvider(next: AgentProvider): void {
        const from: TurnPick = { provider: this.provider.value, value: this.model.value };
        if (!this.pointAt(next)) {
            return;
        }
        this.movedFrom.value ??= from;
    }

    // Give the fallback back, now that the provider this chat was moved off can serve it again; undoes repointProvider.
    // Not a pick either: nothing is written to the module defaults.
    restoreProvider(): void {
        const from = this.movedFrom.value;
        if (from === undefined || this.streaming.value) {
            return;
        }
        this.pointAt(from.provider);
        // The model it was displaced FROM, not the provider's remembered one: each displaced chat is owed its own back.
        this.model.value = from.value;
        this.movedFrom.value = undefined;
    }

    // Point this conversation at a provider and re-scope everything scoped to the old one. Returns false when the
    // switch is refused (mid-stream, or already there).
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
        // Nor does the model it ran on: the next turn opens fresh, with no cached prompt to measure a swap against.
        this.sentModel = undefined;
        this.refreshSwitchNotice();
        return true;
    }

    // The three turn-setting writes (this one and the two below): apply here, remember the pick for the next new chat.
    // One picker row is provider + model; harness is a separate axis, so a model pick keeps the harness.
    selectModel(pick: TurnPick): void {
        if (this.streaming.value && pick.provider !== this.provider.value) {
            return;
        }
        this.keep();
        // `pointAt` rather than `selectProvider`: the pair is remembered once below, with the model actually pressed.
        this.pointAt(pick.provider);
        this.model.value = pick.value;
        // A choice, so nothing is owed back: see selectProvider.
        this.movedFrom.value = undefined;
        rememberPick(pick);
        // A same-provider model swap earns a divider too: it re-reads the whole conversation on a model never seen.
        this.refreshSwitchNotice();
    }

    // Apply a persona's model as the CARD's choice, not the user's; the composer follows it once the card is put on.
    // Unlike repointProvider, nothing is owed back when the card comes off.
    wearModel(pin: ModelPin): void {
        if (this.streaming.value) {
            return;
        }
        this.keep();
        this.pointAt(pin.provider);
        this.model.value = pin.model;
        if (pin.effort !== undefined) {
            this.effortPick.value = pin.effort;
        }
        if (pin.thinking !== undefined) {
            this.thinking.value = pin.thinking;
        }
        if (pin.harness !== undefined) {
            this.harness.value = pin.harness;
        }
        this.movedFrom.value = undefined;
        this.refreshSwitchNotice();
    }

    // The effort PICK, not always the effort in force: `effort` clamps it to what the current model and thinking flag
    // offer.
    setEffort(value: string): void {
        this.effortPick.value = value;
        turnDefaults.effort.value = value;
    }

    // No clamp here: turning thinking off invalidates a `max` pick, but `effort` already accounts for thinking as one
    // of its inputs.
    setThinking(value: boolean): void {
        this.thinking.value = value;
        turnDefaults.thinking.value = value;
    }

    // Not written to turnDefaults (see `fast`); also drops the last answer, which described a turn run under the old
    // setting.
    setFast(value: boolean): void {
        this.fast.value = value;
        this.fastMode.value = undefined;
    }

    // Not written to any global default (see `tierHold`); the last answer stays up, since it remains true of the turn
    // it describes.
    setTierHold(value: boolean): void {
        this.tierHold.value = value;
    }

    // Point the next turn at a specific account of its current provider; retires the session at the next send.
    // Allowed while a card waits on the user (`generating`, not `streaming`): the parked turn keeps its credential.
    selectAccount(id: string): void {
        if (this.generating.value) {
            return;
        }
        this.keep();
        this.account.value = id;
        selectedAccountId.value = { ...selectedAccountId.value, [this.provider.value]: id };
        this.switchedMidTurn = this.switchedMidTurn || this.streaming.value;
        this.refreshSwitchNotice();
    }

    // Switch harness (native runtime vs the Claude Code loop); keeps the model, retires the session at the next send.
    // Meaningful only for codex/grok; claude is always its own loop.
    selectHarness(next: AgentHarness): void {
        if (this.streaming.value || next === this.harness.value) {
            return;
        }
        this.keep();
        this.harness.value = next;
        turnDefaults.harness.value = next;
        this.activeModel.value = null;
        this.contextUsage.value = undefined;
        // A retired session takes its prompt cache with it, exactly as a provider switch does (pointAt).
        this.sentModel = undefined;
        this.refreshSwitchNotice();
    }

    // A muted line of this window's own, for work the chat did that no turn shows: what was asked of a helper model,
    // and what it answered. `noticeWait` names a wait the row spins on until the caller rewords it.
    notice(text: string, extra?: Pick<ChatMessage, "noticeWait">): number {
        return this.transcript.notice(text, extra);
    }

    // Replaces one notice's words in place, so a wait and its outcome are one row rather than two.
    reword(noticeId: number, text: string, extra?: Pick<ChatMessage, "noticeWait">): void {
        this.transcript.write((state) => ({
            ...state,
            messages: state.messages.map((message) => (message.id === noticeId ? { ...message, text, ...extra } : message)),
        }));
    }

    // Retract the pending "switched" divider: the change it announced is no longer what the next send does.
    private dropSwitchNotice(): void {
        const noticeId = this.pendingSwitchNoticeId;
        if (noticeId === undefined) {
            return;
        }
        this.transcript.write((state) => ({ ...state, messages: state.messages.filter((message) => message.id !== noticeId) }));
        this.pendingSwitchNoticeId = undefined;
    }

    // What the next message does differently, or undefined when nothing changes.
    // A provider/account/harness switch retires the session; a model swap keeps it but re-reads on a cold cache.
    private segmentSwitchNotice(): string | undefined {
        const session = this.session.value;
        const started = this.messages.value.length > 0 || session !== undefined;
        if (!started || resumes(session, this.turnSettings())) {
            return undefined;
        }
        // ACP providers have no tab entry; falls back to the capability name or the raw provider id.
        const label = providerTabs.find((tab) => tab.value === this.provider.value)?.label ?? providerLabel(this.provider.value);
        // Unconditional: what carries over is the daemon's own record, not what this window happens to have painted.
        return `Switched to ${label}: your next message starts a fresh session with the conversation so far carried over.`;
    }

    // The other half: a model swap that keeps the session and still costs something. See segmentSwitchNotice.
    private modelSwitchNotice(): string | undefined {
        // Nothing sent yet on this segment, or the pick is back where the last turn left it: nothing to say.
        if (this.sentModel === undefined || this.sentModel === this.model.value) {
            return undefined;
        }
        return `Switched to ${this.modelLabel()}${this.allowanceNote()}`;
    }

    // The picked model, named the way the picker names it.
    private modelLabel(): string {
        return modelLabelFor(this.provider.value, this.model.value);
    }

    // Whose allowance the new model spends, when the plan meters it separately and this sandbox has a reading for it.
    // The floor mark rides along since a reading can only have climbed; the reset date shows once the pool is spent.
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

    // Upsert/remove the one pending "switched" divider as settings change; send() freezes it at the segment cut.
    // Waits mid-stream: the transcript's tail belongs to the turn being typed into it.
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
            this.reword(noticeId, text);
            return;
        }
        this.pendingSwitchNoticeId = this.transcript.notice(text);
    }

    // The settle hook's half: switches made while the turn ran, asked in the order that keeps them to one line.
    // Gated on `switchedMidTurn`, since a sessionless provider would otherwise always look switched.
    private noticeMidTurnSwitch(): void {
        const text = (this.switchedMidTurn ? this.segmentSwitchNotice() : undefined) ?? this.modelSwitchNotice();
        this.switchedMidTurn = false;
        if (text !== undefined && this.pendingSwitchNoticeId === undefined) {
            this.pendingSwitchNoticeId = this.transcript.notice(text);
        }
    }

    // Mirror the settled transcript locally so reopening paints from disk rather than waiting on the sandbox.
    // `authoritative` is the daemon's own replay, which may shrink the mirror; anything else is this window's view.
    private persist(authoritative = false): void {
        // Timed: an unconfirmed write reads the mirror back first, so this is two IndexedDB writes per boundary.
        void trackPerf(`chat.persist`, { messages: this.messages.value.length, authoritative }, () =>
            saveTranscript(this.conversationId, this.messages.value, authoritative),
        );
    }

    // Paint the locally cached transcript if there is one and nothing has rendered yet; returns whether it painted.
    // The daemon still reconciles and replaces this: a stale mirror costs a repaint and nothing more.
    async paintCached(): Promise<boolean> {
        if (this.messages.value.length > 0 || this.streaming.value) {
            return false;
        }
        const cached = await readTranscript(this.conversationId);
        // Re-checked after the await: a turn or reattach may have landed meanwhile; the live transcript always wins.
        if (cached === undefined || this.messages.value.length > 0 || this.streaming.value) {
            return false;
        }
        this.transcript.adopt(cached);
        return true;
    }

    // Seed this conversation as a fork of `source` cut before `index`; settings ride across, no session does.
    // `files`: "now" keeps the current workspace; "then" checks out the cut's files, forcing isolation.
    forkFrom(source: Conversation, index: number, files: "then" | "now"): void {
        const kept = source.messages.value.slice(0, index);
        this.pendingForkOf.value = { conversationId: source.conversationId, keep: recordedRows(kept), files };
        this.transcript.rebuild(kept);
        this.provider.value = source.provider.value;
        this.harness.value = source.harness.value;
        this.account.value = source.account.value;
        this.model.value = source.model.value;
        // The PICK, not what it currently clamps to: a fork inherits the user's choice, not one model's ceiling.
        this.effortPick.value = source.effortPick.value;
        this.thinking.value = source.thinking.value;
        this.fast.value = source.fast.value;
        // The veto and last verdict both carry: a fork's next turn is judged and held exactly as the source's would be.
        this.tierHold.value = source.tierHold.value;
        this.lastTier.value = source.lastTier.value;
        // The pick again, for the same reason: a fork inherits the chosen posture, not the source runtime's ceiling.
        this.modePick.value = source.modePick.value;
        // "Files as they were" is only sayable in the fork's own checkout, so that choice carries isolation with it.
        this.isolated.value = files === `then` ? true : source.isolated.value;
        // Left null so send() names the fork after its own first message; two tabs sharing a title is hard to find.
        this.title.value = null;
    }

    // Go back to a message: the daemon restores the checkpoint, drops later messages, and forgets the session.
    // `message.rewindIndex` addresses the daemon's transcript; the slice below is over the bubbles, with local notices.
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
        // The rebuild renumbers every bubble from zero, so an edit armed on one points elsewhere; disarmed here.
        this.editing.value = undefined;
        this.transcript.rebuild(this.messages.value.slice(0, bubble));
        // Says what happened to the files, since a rewind changes the workspace with nothing else on screen showing it.
        // An edit says so in its own words, naming what the prompt replaced; a plain rewind keeps its own wording.
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

    // Aim the composer at a message already sent; nothing is destroyed or sent here (see `editing`).
    // Refused with no checkpoint: an edit whose files can't go back would reason about a workspace never produced.
    beginEdit(message: ChatMessage): boolean {
        if (message.role !== `user` || message.rewindIndex === undefined || !this.messages.value.includes(message)) {
            return false;
        }
        this.editing.value = { id: message.id, restore: this.draft.value, attachments: this.attachments.value };
        this.draft.value = message.text;
        // The prompt's own files come back with it, already on disk, re-staged as finished chips with no `previewUrl`.
        this.attachments.value = (message.attachments ?? []).map((path): PendingAttachment => ({
            id: uuid(),
            name: basename(path),
            path,
            status: `done`,
            progress: 100,
        }));
        return true;
    }

    // Put draft and chips back to exactly what they were before the pencil; re-staged chips are not revoked, their
    // preview URLs still belong to the bubble on screen.
    cancelEdit(): void {
        const edit = this.editing.value;
        if (edit === undefined) {
            return;
        }
        this.draft.value = edit.restore;
        this.attachments.value = [...edit.attachments];
        this.editing.value = undefined;
    }

    // Spend the edit: rewind first, send only if it landed, since sending against unrewound files hits the wrong files.
    // The mode clears between the two, so the send appends to a transcript no longer drawing anything as doomed.
    async submitEdit(text: string, attachments: readonly ChatAttachment[] = [], editorContext?: EditorContext): Promise<boolean> {
        const edit = this.editing.value;
        if (edit === undefined) {
            return false;
        }
        const message = this.messages.value.find((candidate) => candidate.id === edit.id);
        if (message === undefined) {
            // The row left the transcript under an open editor; nothing to edit, so the mode just ends.
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

    // Place words into the transcript as an assistant bubble, with no turn or reply; the daemon marks the row `placed`.
    // In a channel conversation the daemon carries the line out first, so a refusal here can mean it was unreachable.
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

    // The files moved under this conversation without it doing anything: a checkpoint was restored mid-chat.
    // Only a notice, not a truncation: the transcript is intact, only the disk moved.
    noteWorkspaceRestored(): void {
        this.transcript.notice(`The workspace was restored to an earlier point, the files below this line have changed.`);
        this.persist(true);
    }

    // Redraw the rows of a transcript the daemon replayed, leaving every other conversation property alone; a restored
    // tab already carries its own session, title, provider, and isolation from the tab snapshot.
    restoreMessages(messages: readonly TranscriptRow[], page?: { readonly from: number; readonly more: boolean }): void {
        // A replayed record wears the same ids on different messages; an edit armed against the old one fails.
        this.editing.value = undefined;
        this.transcript.rebuild(messages);
        // The cursor moves with the redraw: a caller with no page to report leaves it at "this is all of it".
        this.historyFrom.value = page?.from ?? 0;
        this.historyMore.value = page?.more ?? false;
        this.error.value = null;
        this.persist(true);
    }

    // Page above what's drawn, for a reader at the top; rows are prepended, never rebuilt, so a live turn survives.
    // Not persisted locally: paging a long conversation would mirror the whole record to disk, page by page.
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
            // A tunnel hiccup on a manual read; the transcript is untouched, so retrying is the same press again.
        } finally {
            this.loadingOlder.value = false;
        }
    }

    // How the last turn ended, as the daemon has it (AgentTranscriptSchema.ending), for a tab that never watched it
    // happen; arms the same pick-up a watching window would, down to the countdown and what the press does.
    // Refused when:
    // - the record shows no ending (the turn ended on its own);
    // - a turn is already live (beginTurn already cleared any pick-up);
    // - a pick-up is already held (this window's own live reading takes precedence);
    // - the transcript is empty (nothing to continue).
    // Arms the offer only, never the automation: opening a tab is not a press.
    adoptEnding(ending: PickUp | undefined): void {
        if (ending === undefined || this.streaming.value || this.pickUp.value !== undefined || this.messages.value.length === 0) {
            return;
        }
        this.pickUp.value = ending;
    }

    // Restore a past conversation from the history menu: build bubbles and arm its session to resume.
    // Unlike restoreMessages this also seeds the conversation's identity, since the tab it lands in is a fresh one.
    loadTranscript(messages: readonly TranscriptRow[], sessionId: string, title: string | null): void {
        this.restoreMessages(messages);
        // History-menu sessions live in the main tree's session namespace; resuming one in a worktree would miss it.
        this.isolated.value = false;
        // A turn on the tree the user is looking at plans before it touches anything.
        this.modePick.value = startingMode(false);
        // The history menu lists Claude sessions only, so a restored conversation resumes on the default account.
        const account = rememberedAccountFor(`claude`);
        this.session.value = { id: sessionId, provider: `claude`, account, harness: `native` };
        this.provider.value = `claude`;
        this.harness.value = `native`;
        this.account.value = account;
        this.model.value = rememberedModelFor(`claude`);
        this.title.value = title;
        this.activeModel.value = null;
        // Whatever the restored session last ran on, this window never sent it, so no swap here can claim a lost cache.
        this.sentModel = undefined;
    }

    async send(prompt: string, settings: TurnSettings, attachments: readonly ChatAttachment[] = [], editorContext?: EditorContext): Promise<void> {
        const text = prompt.trim();
        if (text.length === 0 && attachments.length === 0) {
            return;
        }
        // Stop makes the local stream idle before the daemon finishes unwinding; a direct send joins that boundary too.
        if (this.stopping !== undefined) {
            await this.stopping;
        }
        if (this.streaming.value) {
            return;
        }
        // A pending reattach probe must not race this send's stream, nor must a superseded resume fire one later.
        this.probe?.abort();
        this.failures.cancelProbe();
        // The session is resumed only while the selection still matches what minted it; the daemon reseeds otherwise.
        const session = this.session.value;
        const resume = resumes(session, settings) ? session : undefined;
        if (resume === undefined) {
            this.cutSegment();
        }
        // The switch divider, if any, is frozen into the transcript: the segment cut happened.
        this.pendingSwitchNoticeId = undefined;
        // This turn is what the next model swap is measured against; read off the conversation's own ref.
        this.sentModel = this.model.value;
        // A fork names its origin on its first turn; consumed on the daemon's ack, so a refused send can retry cleanly.
        const forkOf = this.pendingForkOf.value;
        // First message of a fresh conversation names it, free; an attachment-only send is named after the files.
        if (this.title.value === null) {
            this.title.value = deriveTitle(text.length > 0 ? text : attachments.map((file) => file.name).join(`, `));
        }
        // The user's bubble, drawn now so the send reads as sent, replaced once the daemon's row arrives, same id.
        const userMessageId = this.transcript.append({
            role: `user`,
            text,
            ...(attachments.length > 0 ? { attachments: attachments.map((file) => file.path) } : {}),
        });
        // Everything but the run, which the daemon only names in the ack below.
        const turn: Omit<TurnContext, "run"> = { userMessageId, provider: settings.agent, account: settings.account, harness: settings.harness };
        // This turn starts from the user's pick; the previous turn's live posture is history by the time this runs.
        this.liveMode.value = undefined;
        const controller = new AbortController();
        this.beginTurn(controller, Date.now());

        // Uploaded attachments plus @-mentioned paths, one wire field; mentions skip chips, already visible inline.
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
            // Turned away at the door: the daemon refused before any turn existed, says why, and keeps the words.
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
            // The ack means the turn is running daemon-side regardless of this tab; a fork's rows are already copied.
            this.pendingForkOf.value = undefined;
            const { run } = (await response.json()) as { run: string };
            this.turnAccepted = true;
            this.latchRemoteRegistration();
            await followRun(
                this.conversationId,
                run,
                {
                    ...this.sink,
                    // Every head replaces this run's rows with the daemon's, from the bubble above, keeping its id.
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
            // The send that never left: the bubble returns to the queue, and the continue offer is refused too.
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

    // What it means for a turn to be live in this window, opened and closed in one place by send() and reattach().
    // `streaming` and `inflight` must move together: every composer affordance keys off them.
    private beginTurn(controller: AbortController, startedAt: number): void {
        this.inflight = controller;
        this.streaming.value = true;
        // Nothing is delivered until the daemon says so; reattach() sets it true, adopting a run already accepted.
        this.turnAccepted = false;
        // Whatever interrupted the last turn is history, so this one's clean end may flush the queue.
        this.interrupted = false;
        this.error.value = null;
        // A turn is running, so nothing stopped is left to pick up; it supersedes any scheduled continuation.
        this.pickUp.value = undefined;
        this.cancelAutoContinue();
        // A live turn supersedes the waits a failed one opened, whether the scheduler fired it or another window did.
        this.failures.clear();
        this.turnStartedAt.value = startedAt;
        this.liveTools = new Set();
    }

    // Settle it: drain the typewriter, drop streaming affordances, mirror the finished transcript, and let anything
    // queued behind the turn go.
    private endTurn(): void {
        // Read before turnStartedAt clears: how long this turn ran tells the ladder whether it bought anything.
        const ranForMs = this.turnStartedAt.value === undefined ? 0 : Date.now() - this.turnStartedAt.value;
        this.transcript.settle();
        this.inflight = null;
        this.streaming.value = false;
        // An in-turn retry belongs to the turn that was retrying; whatever it settled as, the wait is over.
        this.providerRetry.value = undefined;
        this.turnStartedAt.value = undefined;
        this.failures.armRenewalProbe();
        // A switch made while this turn ran held its divider back; the turn's over, so it goes here. No-op otherwise.
        this.noticeMidTurnSwitch();
        this.persist();
        this.dropStaleRemoteTranscript();
        this.scheduleAutoContinue(ranForMs);
        void this.drainQueue();
    }

    // A remote conversation has no roster watch to invalidate its cached read, so the turn ending here is the signal.
    // Cheap and idempotent; a no-op for every local conversation.
    private dropStaleRemoteTranscript(): void {
        if (this.box.value !== undefined) {
            invalidateAgentTranscript(this.conversationId, this.box.value);
        }
    }

    // The standing press, scheduled at the end of every turn; does nothing unless auto-continue is armed, the turn
    // ended in a resumable shape, and nothing interrupted it.
    private scheduleAutoContinue(ranForMs: number): void {
        const pickUp = this.pickUp.value;
        if (!this.autoContinue.value || this.interrupted) {
            return;
        }
        // A long turn normally proves the continuation helped, but not for a limit: retries can run minutes first.
        if (ranForMs >= AUTO_CONTINUE_PROGRESS_MS && pickUp?.reason !== `limit`) {
            this.autoContinueTries = 0;
        }
        if (pickUp === undefined) {
            return;
        }
        // Something else is already bringing this turn back (the daemon's own breaker); the automation stands down.
        if (pickUp.automatic !== undefined) {
            return;
        }
        this.armAutoContinue();
    }

    // Put the next continuation on the clock at this chat's rung; ordinary stops have three rungs then stand down,
    // limits repeat until the allowance opens.
    private armAutoContinue(): void {
        const blocker = this.pickUp.value?.reason === `limit` ? `limit` : `transient`;
        const delay = autoContinueDelay(this.autoContinueTries, blocker);
        if (delay === undefined) {
            // The ladder is spent: stand down and say so, rather than leaving the user waiting on a dead automation.
            this.autoContinue.value = false;
            this.transcript.notice(
                `Auto-continue stopped: ${AUTO_CONTINUE_TRIES} turns in a row ended without getting anywhere. Press Continue to carry on.`,
            );
            this.persist();
            return;
        }
        this.autoContinueTries += 1;
        // The ladder sets a floor, not the wait: a pick-up naming a ready instant sleeps through it instead.
        const readyAt = this.pickUp.value?.readyAt;
        const wait = Math.max(delay, readyAt === undefined ? 0 : readyAt - Date.now());
        this.autoContinueAt.value = Date.now() + wait;
        this.autoContinueTimer = setTimeout(() => {
            this.autoContinueAt.value = undefined;
            this.autoContinueTimer = undefined;
            // Somebody at the keyboard outranks the timer: a draft, staged file, or queued message answers first.
            if (this.draft.value.trim() !== `` || this.attachments.value.length > 0 || this.queued.value.length > 0 || this.streaming.value) {
                return;
            }
            // The same press the button makes, so a held turn is re-run here too, not appended as another "Continue".
            void this.continueTurn();
        }, wait);
    }

    // Drop a pending continuation (a turn starting, the switch going off, the tab closing); leaves the ladder where it
    // is.
    private cancelAutoContinue(): void {
        clearTimeout(this.autoContinueTimer);
        this.autoContinueTimer = undefined;
        this.autoContinueAt.value = undefined;
    }

    // The switch itself: turning it off drops whatever was scheduled, turning it on starts the ladder from the front.
    // Schedules nothing by itself; the next turn that stops short is what does that.
    setAutoContinue(on: boolean): void {
        this.autoContinue.value = on;
        this.autoContinueTries = 0;
        // No persist(): this mirrors the transcript and nothing was said; the switch itself rides the tab snapshot.
        if (!on) {
            this.cancelAutoContinue();
            return;
        }
        // Arming on an already-stopped chat takes that stop too, since the press means "and get on with it".
        if (this.pickUp.value !== undefined && this.pickUp.value.automatic === undefined && !this.streaming.value) {
            this.armAutoContinue();
        }
    }

    // The composer's one send path: the message is accepted whatever the conversation is doing.
    // - idle: starts a turn immediately, with anything already queued;
    // - turn running: handed to it where the harness takes mid-turn input, else waits and goes as the next turn.
    // An empty message with a non-empty queue just drains the queue.
    enqueue(text: string, attachments: readonly ChatAttachment[] = [], editorContext?: EditorContext): Promise<void> {
        const trimmed = text.trim();
        // The user is driving again: a Stop's hold on the queue is released (see `interrupted`).
        this.interrupted = false;
        this.keep();
        if ((trimmed.length > 0 || attachments.length > 0) && !repeatsNudge({ text: trimmed, attachments }, this.queued.value.at(-1))) {
            this.queued.value = [
                ...this.queued.value,
                { id: uuid(), text: trimmed, attachments, ...(editorContext !== undefined ? { editorContext } : {}) },
            ];
        }
        return this.drainQueue();
    }

    // What "carry on" does, asked once since both callers (the button, auto-continue) need the same answer.
    // A held turn is re-run; anything else is continued by saying so, since a re-run needs the daemon still holding it.
    async continueTurn(options: { readonly carry?: boolean } = {}): Promise<string | undefined> {
        if (await this.resumeHeldTurn(options)) {
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

    // Take a bubble the daemon turned away out of the transcript and queue it at the front, for the user to resend.
    // A turn refused before it ran produced nothing, so an auto-flushed queue would just re-fail it.
    private requeueUndelivered(userMessageId: number): void {
        this.interrupted = true;
        const bubble = this.transcript.takeBackUserBubble(userMessageId);
        if (bubble === undefined) {
            return;
        }
        const held = { text: bubble.text, attachments: (bubble.attachments ?? []).map((path) => ({ name: basename(path), path })) };
        // Pressed again while this turn was already failing, so the words are the same nudge already queued.
        if (repeatsNudge(held, this.queued.value[0])) {
            return;
        }
        this.queued.value = [{ id: uuid(), ...held }, ...this.queued.value];
    }

    // Drop the session ref and terminal/browser handles when the next turn opens a fresh session, a new tmux session.
    // Written once since two callers cut a segment: an ordinary send, and resumeHeldTurn on a switched account.
    private cutSegment(): void {
        this.session.value = undefined;
        this.agentTerminal.value = undefined;
        this.agentBrowser.value = undefined;
    }

    // Release a hold placed by a now-fixed failure and let whatever was held ride immediately; a no-op when the queue
    // is empty.
    resume(): Promise<void> {
        this.interrupted = false;
        this.error.value = null;
        return this.drainQueue();
    }

    // Re-run the held turn: what Continue means when the daemon kept it; false falls back to a plain continuation.
    // No message is appended: a press is the same request again, so the daemon resumes with a note, not a repeat.
    async resumeHeldTurn(options: { readonly carry?: boolean } = {}): Promise<boolean> {
        if (this.streaming.value || this.pickUp.value?.held === undefined) {
            return false;
        }
        if (this.stopping !== undefined) {
            await this.stopping;
        }
        const settings = this.turnSettings();
        // This switch is also a segment cut: the fresh session belongs to the new credential, unless carried across.
        if (!resumes(this.session.value, settings) && options.carry !== true) {
            this.cutSegment();
        }
        this.pendingSwitchNoticeId = undefined;
        try {
            const response = await sandboxRequestVia(this.at, `/agent/resume`, {
                method: `POST`,
                headers: { "content-type": `application/json` },
                body: JSON.stringify({ conversationId: this.conversationId, routing: heldRouting(settings, options) }),
            });
            if (!response.ok) {
                // The daemon isn't holding it (restarted, or another window ran a turn); fall back to continuing.
                return false;
            }
        } catch {
            // The daemon is unreachable; same fallback, so an offline press doesn't eat the user's only affordance.
            return false;
        }
        await this.reattach();
        return true;
    }

    // Adopt the session as the daemon has it. Pins the account only when this tab has none, is local, matches provider.
    // A real user pick, a remote box's foreign id, or another provider's session is never overwritten.
    bindSession(session: SessionRef): void {
        this.session.value = session;
        if (this.account.value === undefined && this.box.value === undefined && session.provider === this.provider.value) {
            this.account.value = session.account;
        }
    }

    // Move onto a reconnected credential for the same human account; the session ref moves with it so it isn't read as
    // a deliberate switch that retires it.
    rebindAccount(accountId: string): void {
        this.account.value = accountId;
        const session = this.session.value;
        if (session !== undefined) {
            this.session.value = { ...session, account: accountId };
        }
        // Not a user switch, just a re-credentialled account: no "switched to…" divider; any pending one retracts.
        this.dropSwitchNotice();
    }

    // Deliver what's waiting, oldest first: a running turn takes them over /agent/steer, a parked card skips them.
    // With nothing running, the whole queue rides one fresh turn. Public so card decisions can re-drive it.
    async drainQueue(): Promise<void> {
        // A message queued right after Stop must not be steered into the aborting turn nor started before it settles.
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
            // An interrupted turn doesn't flush; same for a flush already in flight, which owns these messages.
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

    // Turn settings a message sends under: this conversation's current selection, captured at delivery time, not at
    // typing time.
    turnSettings(): TurnSettings {
        return {
            agent: this.provider.value,
            harness: this.harness.value,
            account: this.account.value,
            // Read at delivery, like the rest: a queued message goes out as whoever is picked when it actually leaves.
            actsAs: this.actsAs.value,
            model: this.model.value,
            effort: this.effort.value,
            thinking: this.thinking.value,
            // The pick AND the offer: a toggle left on must not ride to a model that doesn't publish fast mode.
            fast: this.fast.value && this.fastOffered.value,
            // Always the raw boolean: the daemon persists the hold, only an explicit false can clear one set earlier.
            tierHold: this.tierHold.value,
        };
    }

    // Hand one queued message to the running turn via steer; false when no steerable turn is live, so it stays queued.
    // The transcript write isn't done here: the daemon's `steer` frame draws the bubble everywhere.
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

    // User-initiated Stop: hard-cancel the turn daemon-side and let its stream draw the rest, the same way everywhere.
    // The request is retained as a barrier: its response means the run has released the conversation lock.
    stop(): void {
        if (!this.streaming.value) {
            return;
        }
        this.keep();
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

    // This side of a turn ending on the user's say-so: hold the queue and arm the way back; shared with a dismissal,
    // which has no request of its own.
    private ended(): void {
        // Hold the queue back from the settle flush and drop any continuation: a stopped agent must not restart.
        this.interrupted = true;
        this.cancelAutoContinue();
        // Armed here, not in abort(): only a turn the daemon accepted gets a way back, else there's nothing to pick up.
        this.pickUp.value = this.turnAccepted ? { reason: `stopped` } : undefined;
        this.persist();
    }

    // The stop the daemon never heard: this window draws the ending itself, freezes the cards, and drops the stream it
    // can no longer trust.
    private stopLocally(): void {
        this.cancelPendingCards();
        this.transcript.notice(`Stopped.`);
        this.abort();
        this.persist();
    }

    // Freeze whatever the stopped turn was parked on, so a cancelled card doesn't leave `awaitingDecision` wedged on a
    // turn that no longer exists.
    private cancelPendingCards(): void {
        if (!this.awaitingDecision.value) {
            return;
        }
        this.transcript.write((state) => ({ ...state, messages: state.messages.map(withCancelledCards) }));
    }

    // Aborts this tab's attach stream; whatever streamed stays in the transcript, the run keeps running detached.
    // Called bare when the tab closes: the turn lands its work, and reopening reattaches to it.
    abort(): void {
        // Ending on someone's say-so, not its own: hold the queue and drop any scheduled continuation.
        this.interrupted = true;
        this.cancelAutoContinue();
        this.transcript.settle();
        this.probe?.abort();
        this.inflight?.abort();
        this.failures.cancelProbe();
    }

    // Attach to a turn already running daemon-side (before a reload, or from another window/device). False when nothing
    // is live, so the caller falls back to hydration.
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
                // The daemon is streaming this run at us, so it's already its own record; nothing here is undelivered.
                this.turnAccepted = true;
            }
            // This window may have drawn this run already; the head's rows replace what it holds, nothing draws twice.
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

    // The one path every card answer takes: un-park the turn on the daemon first, freeze the answer only once it lands.
    // One answer per card, claimed before the request goes out (see `deciding`), so a second press is dropped.
    private async decide(message: ChatMessage, body: AgentReply, failure: string, cards: TranscriptCards): Promise<boolean> {
        const { id } = message;
        if (this.deciding.value.has(id)) {
            return false;
        }
        // Answering a card the turn is parked on is an act on this chat, whichever card it is.
        this.keep();
        this.deciding.value = new Set(this.deciding.value).add(id);
        try {
            if (!(await postTurnControl(this.at, `/agent/reply`, body))) {
                this.error.value = failure;
                return false;
            }
            // The same derivation the daemon uses for the `resolved` row, applied here so the card reads answered.
            this.transcript.attachCard(id, settledCards(cards, body));
            return true;
        } finally {
            // Released even on failure: the card goes back to `pending` on screen, so it must be answerable again.
            const left = new Set(this.deciding.value);
            left.delete(id);
            this.deciding.value = left;
        }
    }

    // Answers a pending plan card: approval executes and streams a closing turn; rejection re-plans off the feedback.
    // Feedback's attachments go up as `@`-prefixed workspace paths, the one text field the wire reply has.
    async decidePlan(message: ChatMessage, approve: boolean, feedback?: string, attachments: readonly ChatAttachment[] = []): Promise<void> {
        const plan = message.plan;
        if (plan?.status !== `pending`) {
            return;
        }
        const trimmed = feedback?.trim();
        const written = [trimmed, ...attachments.map((file) => `@${file.path}`)].filter(Boolean).join(`\n`);
        // The verdict's line and the feedback bubble are the daemon's to write, into the run's own rows.
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

    // Submits the user's picks for a pending question card; the turn is parked on the `ask` tool and resumes using the
    // answers.
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

    // Dismisses a pending question, which ENDS the turn: waving it away answers nothing, so the user takes it back.
    // One request does both, dismiss and end, on the daemon's side, so the board moves the card once.
    async cancelQuestion(message: ChatMessage): Promise<void> {
        const question = message.question;
        if (question?.status !== `pending`) {
            return;
        }
        // Both lines, "Question dismissed." and "Stopped.", are the daemon's own, written as it ends the turn.
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

    // Answers a pending permission card: 'once' allows this call, 'always' persists the SDK's rule, 'deny' stops it.
    // A denial with feedback steers the turn onward instead of aborting it.
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

    // The payment decision: approve releases exactly the price shown, skip spends nothing, the only way funds leave.
    // The receipt arrives as its own frame; nothing here predicts whether the endpoint actually settles.
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

    // The release for a credential behind a named person: how far one yes goes is policy, the card says which.
    // The one card whose answer can be refused: enforced server-side against the verified identity.
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

    // The setup decision for a missing-capability ask: Connect parks the agent while the owner sets it up.
    // Not-now tells the agent to carry on without it, remembered so it isn't asked twice.
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

    // Declines a pending browser-help card from chat, un-parking the agent; the other half ("hand back") lives on the
    // /browsers banner.
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

    // Same, for the terminal handover; "done, hand back" lives on the terminal panel's own banner instead.
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

    // One entry's consequences beyond its rows, in arrival order: `providerRetry` clears on anything, sets on its fact.
    // A replayed fact applies again regardless: every fact here is a state statement, not an increment.
    private applied(entry: AttachEntry, turn: TurnContext, _replay: boolean): void {
        // Any other entry means the wait a provider_retry described is over, whatever happens next.
        if (entry.kind !== `fact` || entry.fact.kind !== `provider_retry`) {
            this.providerRetry.value = undefined;
        }
        if (entry.kind === `patch`) {
            this.applyPatchConsequence(entry.patch);
            return;
        }
        this.applyFact(entry.fact, turn);
    }

    // A tool card arriving for the first time: a main-tree turn records its written paths for the Changes panel to warn
    // against, per repo; an isolated turn records nothing, since its writes land in its own worktree diff.
    private applyPatchConsequence(patch: TranscriptPatch): void {
        if (patch.op !== `tool` || this.liveTools.has(patch.tool.id)) {
            return;
        }
        this.liveTools.add(patch.tool.id);
        if (!this.isolated.value && this.turnStartedAt.value !== undefined) {
            const startedAt = this.turnStartedAt.value;
            const call = patch.tool;
            void import(`../../workspace/files/liveWrites`).then((m) => m.recordTurnWrite(this.conversationId, startedAt, call));
        }
    }

    private applyFact(fact: TurnFact, turn: TurnContext): void {
        switch (fact.kind) {
            case `session`:
                // Account comes off the fact when the daemon named one, else falls back to what this turn asked for.
                this.bindSession(boundSession(fact.sessionId, turn, fact.account));
                return;
            case `worktree`:
                // First fact of an isolated turn: which branch/base this conversation works on.
                this.worktree.value = { branch: fact.branch, base: fact.base };
                // The sandbox can't enforce the worktree with mounts, so tool paths redirect instead; said once, ever.
                if (fact.unenforced === true && !this.warnedUnenforced) {
                    this.warnedUnenforced = true;
                    this.transcript.notice(
                        `This sandbox can't isolate agent turns at the filesystem level (it was created without CAP_SYS_ADMIN). Work is redirected into ${fact.branch}, but a command that builds its own paths can still reach the shared workspace: recreate the sandbox to restore full isolation.`,
                    );
                }
                return;
            case `mode`:
                // The turn's live posture, echoed back or moved by the agent; drives the selector, not the pick.
                this.liveMode.value = fact.mode;
                return;
            case `commands`:
                // The provider's slash commands (ACP agents), replaced whole, for the composer's `/` popover.
                this.availableCommands.value = fact.items;
                return;
            case `init`:
                this.activeModel.value = fact.model;
                return;
            case `context_usage`:
                // Per-conversation context-window fill, held here so the composer shows the active chat's own meter.
                this.contextUsage.value = { tokens: fact.tokens, contextWindow: fact.contextWindow };
                return;
            case `usage`:
                // The turn's cost lives on the bubble it ended in; nothing to keep here.
                return;
            case `account_usage`:
                // Account-wide headroom, keyed by the serving account and stamped with read time so newest-wins.
                if (fact.account !== undefined) {
                    setAccountUsage(this.provider.value, fact.account, { windows: [...fact.windows], measuredAt: Date.now() });
                }
                return;
            case `terminal`: {
                // The agent started running Bash in its tmux terminal; remembered so Bash cards can offer to watch it.
                const { session } = fact;
                this.agentTerminal.value = session;
                const title = this.title.value;
                void import("../../terminal/useWorkTerminals").then((m) => m.noteAgentTerminal(session, title));
                void import("../../terminal/useTerminalPanel").then((m) => m.useTerminalPanel().surface(session));
                return;
            }
            case `browser`: {
                // The agent just used a browser tool; handled like the terminal above, an equally watchable resource.
                const { session } = fact;
                this.agentBrowser.value = session;
                const title = this.title.value;
                void import("../../terminal/useWorkTerminals").then((m) => m.noteAgentTerminal(session, title));
                void import("../../terminal/useTerminalPanel").then((m) => m.useTerminalPanel().surface(session));
                return;
            }
            case `provider_retry`:
                // A wait, not a failure: the turn is still running. Held only while it is (see endTurn).
                this.providerRetry.value = fact;
                return;
            case `fast_mode`:
                // Not cleared at the turn boundary (see the ref): the answer outlives the turn that reported it.
                this.fastMode.value = fact;
                return;
            case `tier`:
                // A judged turn's verdict, replacing both the picker notice's answer and the next preview's input.
                this.tierAnswer.value = fact;
                this.lastTier.value = fact.tier;
                return;
            case `error`:
                this.failures.apply(fact, turn);
                return;
            case `rate_limit_info`:
                // The live gate, not a headroom reading: `account_usage` carries every pool for the readouts.
                return;
        }
    }
}
