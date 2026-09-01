import type { AgentCommand, AgentEvent, AgentReply, ContextUsage, PermissionMode, UsageWindow } from "@intentic/sandbox-contract";
import { basename } from "@intentic/ui/path";
import {
    type BrowserHelpStatus,
    type CapabilityOfferStatus,
    type ChatMessage,
    type ChatTool,
    type ChatUsage,
    mapTool,
    type PermissionStatus,
    type PlanStatus,
    type QuestionStatus,
    type PaymentOfferStatus,
    type ServiceOfferStatus,
    type TerminalHelpStatus,
} from "./transcript";

/* One agent frame applied to the transcript, as a PURE function.
 *
 * This is the part of a chat that is genuinely intricate: which bubble a delta lands in, when a block of prose
 * is retired so the tools it introduced appear below it rather than above, where a sub-agent's calls nest,
 * which bubble a plan card attaches to and which one the post-approval continuation opens. Those rules are the
 * product, get them wrong and the transcript reads as a jumble, and they used to be spread across a class
 * that also owned the network, the abort controllers, the typewriter's timers, and a dozen Vue refs, which
 * meant the only way to exercise them was to drive a whole conversation.
 *
 * So the state a frame can touch is a VALUE here, and everything a frame does that isn't transcript-shaped
 * comes back as an effect the caller applies. The caller (Conversation) keeps the sockets and the refs; this
 * module keeps the rules.
 *
 * The typewriter is part of the state, not an escape hatch. Accepted-but-not-yet-revealed text lives in
 * `pending`, so "does this bubble hold any prose yet", the question the text_end split turns on, is
 * answerable without asking an animation what it has drawn. `revealPending`/`flushPending` are the same kind
 * of pure transition, driven by the caller's animation frame. */

export interface PendingText {
    // The bubble the buffered text belongs to. Buffered text NEVER migrates: a delta for a different bubble
    // flushes this one first, or prose leaks across a turn boundary.
    readonly bubbleId: number;
    readonly text: string;
}

export interface TurnState {
    readonly messages: readonly ChatMessage[];
    // The bubble the running turn writes into; null means "allocate a fresh one on the next write". Cleared
    // by every boundary that must push what follows BELOW what came before (a finished block of prose, a plan
    // card, the end of a turn).
    readonly bubbleId: number | null;
    // Monotonic message-id allocator. In the state because allocating an id IS a transition, a reducer that
    // reached for a counter on `this` would not be replayable.
    readonly nextId: number;
    readonly pending: PendingText | undefined;
    /* The run whose frames are being applied, stamped onto every row they append (ChatMessage.run). Held for
     * the length of a fold AND the effects it raises, a failure notice is written by an effect, and a replay
     * of the frame behind it raises that effect again, then cleared, so a write on the user's own clock is
     * never mistaken for something a replay would bring back. */
    readonly run?: string;
}

// What the frame needs to know about the turn it belongs to, and which the transcript cannot tell it.
export interface TurnContext {
    // The user bubble this turn answers, where a checkpoint id anchors its "restore to before this" affordance.
    readonly userMessageId: number;
}

/** Everything a frame does that is not a change to the transcript. The caller owns each of these, they are
 *  conversation-level refs, cross-conversation stores, or genuine side effects, and applying them is a flat
 *  switch with no logic in it, which is exactly the point: the logic is above, and it is pure. */
export type TurnEffect =
    /* The session the next matching turn resumes, and the ACCOUNT the daemon resolved for it, which is not
     * always the one this turn asked for: a turn naming no account is served by whichever connected one has
     * headroom. The caller stamps the provider/harness from the turn (those the client does decide) and takes
     * the account from here whenever the daemon named one, because only the daemon knows whose credential the
     * session was actually minted under, and that is what decides whether the next message resumes it. */
    | { readonly kind: "session"; readonly sessionId: string; readonly account?: string }
    | { readonly kind: "worktree"; readonly branch: string; readonly base: string; readonly unenforced?: boolean }
    // The posture the RUNNING turn is in, the agent's own EnterPlanMode, or where a plan approval landed.
    | { readonly kind: "liveMode"; readonly mode: PermissionMode }
    | { readonly kind: "commands"; readonly items: readonly AgentCommand[] }
    | { readonly kind: "activeModel"; readonly model: string }
    | { readonly kind: "contextUsage"; readonly usage: ContextUsage }
    // Fold into the conversation's lifetime totals. The transcript attachment already happened, in state.
    | { readonly kind: "totals"; readonly usage: ChatUsage }
    // Account-wide subscription headroom, keyed by the account that served the turn. Not tied to any bubble.
    | { readonly kind: "accountUsage"; readonly account: string; readonly windows: readonly UsageWindow[] }
    // A tool call the turn just made, for the caller to record as this turn's live writes.
    | { readonly kind: "toolCall"; readonly call: Extract<AgentEvent, { kind: "tool_call" }> }
    // Surface the agent's live tmux terminal as a tab in the global panel.
    | { readonly kind: "surfaceTerminal"; readonly session: string }
    // Same, for the live browser the agent drives through its Playwright tools.
    | { readonly kind: "surfaceBrowser"; readonly session: string }
    // A turn-level failure. Wording and severity are the caller's: several codes need state this module has no
    // business reading (the account's usage windows, the provider's account list) to phrase themselves.
    // rate_limit failures carry when the spent window reopens; provider-outage failures carry the daemon's
    // resume verdict, armed ("scheduled") or merely on offer behind the setting ("available").
    | {
          readonly kind: "error";
          readonly message: string;
          readonly code: Extract<AgentEvent, { kind: "error" }>["code"];
          readonly resetsAt: number | undefined;
          readonly autoResume: Extract<AgentEvent, { kind: "error" }>["autoResume"];
          // provider-outage only: when the next attempt is due and how many are left, see events.ts.
          readonly outage: Extract<AgentEvent, { kind: "error" }>["outage"];
          // rate_limit only: the daemon is holding this turn, so continuing RE-RUNS it rather than sending a
          // message after it, and `ran` says whether it got anywhere first. See events.ts for why that matters.
          readonly held: Extract<AgentEvent, { kind: "error" }>["held"];
      }
    // The turn is alive and waiting on the provider. Not a transcript write at all: the caller renders it where
    // the streaming indicator goes, and the next frame of real content retires it.
    | { readonly kind: "providerRetry"; readonly retry: Extract<AgentEvent, { kind: "provider_retry" }> }
    // What speed the harness is serving this turn at. Also not a transcript write: it belongs beside the
    // composer's own fast control, which is where the user made the choice this is answering.
    | { readonly kind: "fastMode"; readonly fast: Extract<AgentEvent, { kind: "fast_mode" }> }
    // What the complexity judge decided about this turn (fast_mode's twin for automatic tier selection): the
    // verdict, whether a cheaper model actually ran, and which. Rendered beside the model pick, not in the
    // transcript, except for the first routed turn, which earns a notice with its own opt-out (conversation.ts).
    | { readonly kind: "tier"; readonly tier: Extract<AgentEvent, { kind: "tier" }> };

export interface TurnStep {
    readonly state: TurnState;
    readonly effects: readonly TurnEffect[];
}

export const emptyTurnState: TurnState = { messages: [], bubbleId: null, nextId: 1, pending: undefined };

const step = (state: TurnState, ...effects: readonly TurnEffect[]): TurnStep => ({ state, effects });

// A daemon NEWER than this browser can emit a frame kind this build has never heard of, that is a supported
// state (a released app plane serves whatever image each user last pulled), so it must be a no-op rather than a
// crash. The `never` parameter is what keeps the switch below exhaustive at the same time: a kind the contract
// declares and this module forgets fails to compile here.
const unhandledFrame = (state: TurnState, _event: never): TurnStep => step(state);

// --- transcript primitives (pure, exported: the conversation runtime writes notices through these too) -------

// The run stamp rides UNDER the message, so a caller that knows its own provenance (the user bubble a reattach
// synthesizes) keeps it, and everything else inherits whichever run the state is applying.
export const appendMessage = (state: TurnState, message: Omit<ChatMessage, "id">): TurnState => ({
    ...state,
    messages: [...state.messages, { ...(state.run === undefined ? {} : { run: state.run }), ...message, id: state.nextId }],
    nextId: state.nextId + 1,
});

/** A small muted system line marking a control action (dismissed / kept planning / approved / stopped).
 * `extra` carries the three things a notice line can be more than text: the one-press follow-up some of them
 * offer (ChatMessage.noticeAction), the unfinished wait some of them describe (ChatMessage.noticeWait), and the
 * exact words behind a line that stands in for something the agent was told (ChatMessage.notes). */
export const appendNotice = (state: TurnState, text: string, extra?: Pick<ChatMessage, "noticeAction" | "noticeWait" | "notes">): TurnState =>
    appendMessage(state, { role: `notice`, text, ...extra });

/* What a landed delta did to the workspace's dependencies, as a clause the landed notice ends with, or nothing
 * at all, which is what almost every turn produces and what the reader should therefore never have to skip past.
 *
 * Written as a REPORT of something already done, not a request. The daemon started the install the moment the
 * tree changed (workspace/reconcile-deps.ts), so "installing" is the true tense and there is no decision left
 * for the reader to make; the button beside it opens the terminal it is running in, for whoever wants to watch.
 * The deferred wording is the one case that names a wait, because a workspace with other agents still running
 * genuinely has not started yet and saying otherwise would be a lie the terminal would immediately expose. */
const dependencyLine = (deps: { missing: number; started: string[]; deferred: boolean } | undefined): string => {
    if (deps === undefined || deps.missing === 0) {
        return ``;
    }
    const what = `${deps.missing} new ${deps.missing === 1 ? `dependency` : `dependencies`}`;
    return deps.deferred
        ? ` ${what} are queued: installation starts after this turn and any other active agents finish, appears in Work terminals, then its checks and outcome land in Activity.`
        : ` Installing ${what} it added; the project's checks run when that finishes, and the outcome lands in Activity.`;
};

/** A notice that belongs to the turn's OPENING rather than its running commentary, placed directly ABOVE the
 *  bubble this turn is writing into, which is to say directly under the message that asked for it.
 *
 *  Everything else a frame writes describes something that happened mid-answer, so appending files it correctly.
 *  This one describes the ground the turn started from, and by the time any frame arrives the turn's first
 *  assistant bubble already exists. Conversation.openBubble opens it up front so the typing indicator shows
 *  from the first moment. Appending would therefore print a line about the turn's starting conditions BELOW the
 *  answer it preceded, which reads as though the branch moved mid-thought.
 *
 *  Anchored on the open bubble, not on the user's message: a resumed turn (Conversation.reuseUserBubble without
 *  truncation) leaves the dead run's output and its interruption notice between the two, and this line belongs
 *  to the answer that is about to be written, not above the one that died. */
const prependTurnNotice = (state: TurnState, text: string, extra?: Pick<ChatMessage, "noticeAction" | "noticeWait" | "notes">): TurnState => {
    const at = state.messages.findIndex((message) => message.id === state.bubbleId);
    if (at === -1) {
        return appendNotice(state, text, extra);
    }
    return {
        ...state,
        messages: [...state.messages.slice(0, at), { id: state.nextId, role: `notice`, text, ...extra }, ...state.messages.slice(at)],
        nextId: state.nextId + 1,
    };
};

/* WHY THIS AGENT'S BRANCH JUST MOVED, the human's half of the rebase (daemon: agents/sync.ts).
 *
 * A conversation goes stale while its user commits around it, so the daemon rebases the branch onto the
 * current workspace. It is told, not asked: at the moment someone is answering their agent they have nothing
 * to decide this with, and the alternative to rebasing is not "stay safe", it is a land conflict half an hour
 * later. So this is one muted line with no button on it, the same weight as "Context compacted", and for the
 * same reason.
 *
 * TWO MOMENTS, and the line reads the same at both because it says the same thing: before the turn starts, and
 * again after the user answers a question or approves a plan, where the wait was minutes long and the main
 * line does not stop for it. Its PLACEMENT sorts itself out, prependTurnNotice puts the opening one above the
 * bubble the turn is about to write into, and finds no open bubble at the second (a card clears it), so that
 * one appends where it happened, under the answer that triggered it. Hence no "before this turn" here: the
 * sentence has to be true at both.
 *
 * The blocked half is the line that earns its keep: a rebase that would not apply was rolled back, the agent is
 * working from the older base, and the conflict report at the end of the turn is now EXPECTED rather than a
 * surprise. Naming the repo, not the paths, the review lists those, with the fix that fits each one. */
const syncLine = (sync: { commits: number; blocked: readonly string[] }): string => {
    const moved =
        sync.commits > 0
            ? `Your workspace moved on while this agent waited, its branch was rebased onto your latest ${sync.commits} commit${sync.commits === 1 ? `` : `s`}.`
            : undefined;
    const blocked =
        sync.blocked.length > 0
            ? `Couldn't rebase onto your workspace in ${sync.blocked.join(`, `)}: the turn is running from the older base, so its land may need a resolve.`
            : undefined;
    return [moved, blocked].filter((line) => line !== undefined).join(` `);
};

const mapMessage = (state: TurnState, id: number, fn: (message: ChatMessage) => ChatMessage): TurnState => ({
    ...state,
    messages: state.messages.map((message) => (message.id === id ? fn(message) : message)),
});

// Rewrite the tool with `id` wherever it lives across the transcript's bubbles, leaving every other bubble's
// object identity intact (mapTool returns the same array when the id is absent). The one seam both
// tool_call_update and a sub-agent's thinking delta write through. Reports whether it FOUND the tool, because
// two callers act on the answer, an update with no matching call is dropped, and a nested append whose parent
// card is missing falls back to a top-level one.
const mapToolAnywhere = (state: TurnState, id: string, fn: (tool: ChatTool) => ChatTool): { state: TurnState; matched: boolean } => {
    let matched = false;
    const messages = state.messages.map((message) => {
        if (message.tools === undefined) {
            return message;
        }
        const tools = mapTool(message.tools, id, fn);
        if (tools === message.tools) {
            return message;
        }
        matched = true;
        return { ...message, tools };
    });
    return { state: matched ? { ...state, messages } : state, matched };
};

// Whether the turn's current bubble holds any of the agent's prose. COUNTING text still buffered in the
// typewriter, which hasn't reached the message yet. Guards the text_end split: a block that wrote nothing (the
// empty text block a model can open before going straight to a tool) has no bubble to close, and retiring one
// there would strand it empty in the transcript for the rest of the turn.
const hasProse = (state: TurnState, id: number | null): boolean => {
    if (id === null) {
        return false;
    }
    if (state.pending?.bubbleId === id && state.pending.text !== ``) {
        return true;
    }
    return (state.messages.find((message) => message.id === id)?.text ?? ``) !== ``;
};

// Both halves of "this bubble is finished", as one question: a text block ending at the TOP LEVEL of the turn
// (a subagent's block closes nothing out here) with prose in the open bubble to close. Named rather than
// inlined at the one call site, so the text_end case reads as the decision it makes rather than as its test.
const closesBubble = (state: TurnState, event: Extract<AgentEvent, { kind: "text_end" }>): boolean =>
    event.parentToolUseId === undefined && hasProse(state, state.bubbleId);

// The bubble the current frame writes to, allocating a fresh assistant message when the turn's bubble was
// cleared (start of turn already has one; a plan card clears it for the next).
const withBubble = (state: TurnState): { state: TurnState; id: number } => {
    if (state.bubbleId !== null) {
        return { state, id: state.bubbleId };
    }
    const id = state.nextId;
    return { state: { ...appendMessage(state, { role: `assistant`, text: ``, thinking: `` }), bubbleId: id }, id };
};

// --- typewriter (pure: the caller drives the clock, this owns what a tick means) ------------------------------

/** Reveal a slice of the buffer, sized to catch up when far behind so bursts type out quickly but a large
 *  backlog never lags. Called from the caller's animation frame; a no-op with nothing buffered. */
export const revealPending = (state: TurnState): TurnState => {
    const pending = state.pending;
    if (pending === undefined || pending.text === ``) {
        return state;
    }
    const take = Math.max(2, Math.ceil(pending.text.length / 8));
    const slice = pending.text.slice(0, take);
    const rest = pending.text.slice(take);
    return {
        ...mapMessage(state, pending.bubbleId, (message) => ({ ...message, text: `${message.text}${slice}` })),
        pending: rest === `` ? undefined : { bubbleId: pending.bubbleId, text: rest },
    };
};

/** Reveal the WHOLE buffer at once, a turn ended, was stopped, or a card took the bubble over, so no text may
 *  be left mid-type. */
export const flushPending = (state: TurnState): TurnState => {
    const pending = state.pending;
    if (pending === undefined || pending.text === ``) {
        return { ...state, pending: undefined };
    }
    return {
        ...mapMessage(state, pending.bubbleId, (message) => ({ ...message, text: `${message.text}${pending.text}` })),
        pending: undefined,
    };
};

// Enqueue a delta for the typewriter rather than writing it straight to the bubble. If the target bubble
// changed (a new turn, a fresh post-plan bubble), flush the prior buffer first so nothing leaks across bubbles.
const enqueueText = (state: TurnState, bubbleId: number, delta: string): TurnState => {
    const base = state.pending !== undefined && state.pending.bubbleId !== bubbleId ? flushPending(state) : state;
    return { ...base, pending: { bubbleId, text: `${base.pending?.text ?? ``}${delta}` } };
};

// --- the reducer ----------------------------------------------------------------------------------------------

const appendTool = (state: TurnState, bubbleId: number, event: Extract<AgentEvent, { kind: "tool_call" }>): TurnState => {
    const tool: ChatTool = {
        id: event.id,
        name: event.name,
        category: event.category,
        status: event.status,
        ...(event.target !== undefined ? { target: event.target } : {}),
        ...(event.locations !== undefined ? { locations: event.locations } : {}),
        ...(event.content !== undefined ? { content: event.content } : {}),
    };
    const parentId = event.parentToolUseId;
    if (parentId !== undefined) {
        // A sub-agent's own calls carry the id of the Agent tool that spawned them, nest those under that
        // card, wherever it lives, so the delegation reads as one unit rather than a flat run of siblings with
        // a lone spinner stranded above them.
        const nested = mapToolAnywhere(state, parentId, (parent) => ({ ...parent, children: [...(parent.children ?? []), tool] }));
        if (nested.matched) {
            return nested.state;
        }
        // Its Agent card wasn't found (a malformed stream), fall through to a top-level append rather than
        // dropping the call.
    }
    return mapMessage(state, bubbleId, (message) => ({ ...message, tools: [...(message.tools ?? []), tool] }));
};

// The frozen status each card takes from the reply that settled it, the same mapping the answering client
// applies locally (see Conversation.decidePlan / answerQuestion / decidePermission), applied here to the card
// the frame names. No reply means the turn ended with the card still parked (Stop, a lost daemon), which is
// nobody's decision, 'cancelled' for all three. A reply of the wrong kind cannot reach a card of another,
// since the requestId is what matched it; it reads as unanswered rather than inventing a decision.
const planStatusOf = (reply: AgentReply | undefined): PlanStatus => (reply?.kind !== `plan` ? `cancelled` : reply.approve ? `approved` : `rejected`);
const questionStatusOf = (reply: AgentReply | undefined): QuestionStatus =>
    reply?.kind === `question` && reply.cancelled !== true ? `answered` : `cancelled`;
const permissionStatusOf = (reply: AgentReply | undefined): PermissionStatus => {
    if (reply?.kind !== `permission`) {
        return `cancelled`;
    }
    return reply.decision === `deny` ? `denied` : reply.decision === `always` ? `always` : `allowed`;
};
const browserHelpStatusOf = (reply: AgentReply | undefined): BrowserHelpStatus =>
    reply?.kind !== `browser_help` ? `cancelled` : reply.helped ? `helped` : `declined`;
const terminalHelpStatusOf = (reply: AgentReply | undefined): TerminalHelpStatus =>
    reply?.kind !== `terminal_help` ? `cancelled` : reply.helped ? `helped` : `declined`;
const serviceOfferStatusOf = (reply: AgentReply | undefined): ServiceOfferStatus =>
    reply?.kind !== `service_offer` ? `cancelled` : reply.approve ? `approved` : `skipped`;
// A yes settles the DECISION, not the ask: the owner is now setting the capability up, so the card moves to
// `connecting` and stays there until the capability_outcome frame says how the setup ended.
const capabilityOfferStatusOf = (reply: AgentReply | undefined): CapabilityOfferStatus =>
    reply?.kind !== `capability_offer` ? `cancelled` : reply.connect ? `connecting` : `skipped`;
// A yes settles the decision; whether the money actually moved is the payment_receipt frame's to say.
const paymentOfferStatusOf = (reply: AgentReply | undefined): PaymentOfferStatus =>
    reply?.kind !== `payment_offer` ? `cancelled` : reply.approve ? `approved` : `skipped`;

/* The quick model's plain sentence for a command card already on screen, patched onto the card the requestId
 * names. Not a new card and not a settlement: the card stays pending and answerable, and gains a line above
 * the shell it is holding.
 *
 * It arrives as its own frame because the card must not WAIT for it (see the frame's note in events.ts), and it
 * is patched by requestId for the same reason a service event is: by the time it lands the transcript has
 * usually moved on and the card is no longer the last thing in it. A note for a card this transcript does not
 * hold, a replay that starts after the card was answered, changes nothing. */
const noteCard = (state: TurnState, event: Extract<AgentEvent, { kind: "permission_note" }>): TurnState => ({
    ...state,
    messages: state.messages.map(
        (message): ChatMessage =>
            message.permission?.requestId === event.requestId
                ? { ...message, permission: { ...message.permission, explain: event.explain } }
                : message,
    ),
});

// One event off an approved run's stream, appended to the offer the requestId names: the run showing itself
// living, which the card renders as its latest status line while the receipt is pending.
const appendServiceEvent = (state: TurnState, event: Extract<AgentEvent, { kind: "service_event" }>): TurnState => ({
    ...state,
    messages: state.messages.map(
        (message): ChatMessage =>
            message.serviceOffer?.requestId === event.requestId
                ? { ...message, serviceOffer: { ...message.serviceOffer, events: [...(message.serviceOffer.events ?? []), event.event] } }
                : message,
    ),
});

// Freeze the card the frame names, wherever it hangs. Idempotent by construction: the window that answered
// already wrote this exact status when its reply came back, so the frame only ever changes a transcript that
// did NOT answer, a replay after a reload, or a second window watching the same run.
const resolveCard = (state: TurnState, event: Extract<AgentEvent, { kind: "resolved" }>): TurnState => ({
    ...state,
    messages: state.messages.map((message): ChatMessage => {
        if (message.plan?.requestId === event.requestId) {
            return { ...message, plan: { ...message.plan, status: planStatusOf(event.reply) } };
        }
        if (message.question?.requestId === event.requestId) {
            const answers = event.reply?.kind === `question` ? event.reply.answers : undefined;
            return {
                ...message,
                question: { ...message.question, status: questionStatusOf(event.reply), ...(answers !== undefined ? { answers } : {}) },
            };
        }
        if (message.permission?.requestId === event.requestId) {
            return { ...message, permission: { ...message.permission, status: permissionStatusOf(event.reply) } };
        }
        if (message.browserHelp?.requestId === event.requestId) {
            return { ...message, browserHelp: { ...message.browserHelp, status: browserHelpStatusOf(event.reply) } };
        }
        if (message.terminalHelp?.requestId === event.requestId) {
            return { ...message, terminalHelp: { ...message.terminalHelp, status: terminalHelpStatusOf(event.reply) } };
        }
        if (message.serviceOffer?.requestId === event.requestId) {
            return { ...message, serviceOffer: { ...message.serviceOffer, status: serviceOfferStatusOf(event.reply) } };
        }
        if (message.capabilityOffer?.requestId === event.requestId) {
            return { ...message, capabilityOffer: { ...message.capabilityOffer, status: capabilityOfferStatusOf(event.reply) } };
        }
        if (message.paymentOffer?.requestId === event.requestId) {
            return { ...message, paymentOffer: { ...message.paymentOffer, status: paymentOfferStatusOf(event.reply) } };
        }
        return message;
    }),
});

// Usage lands at end-of-turn; attach it to the last assistant bubble rather than spawning an empty one.
const attachUsage = (state: TurnState, usage: ChatUsage): TurnState => {
    const target = state.messages.findLast((message) => message.role === `assistant`);
    return target === undefined ? state : mapMessage(state, target.id, (message) => ({ ...message, usage }));
};

/** Apply one agent frame. Returns the next transcript state and whatever the caller must do outside it. */
export const applyTurnFrame = (state: TurnState, event: AgentEvent, context: TurnContext): TurnStep => {
    switch (event.kind) {
        case `delta`: {
            if (!event.text) {
                return step(state);
            }
            // A sub-agent's prose streams tagged with its Agent tool id. Its final form lands as that tool's
            // result content (tool_call_update), so the live delta is dropped rather than duplicated there,
            // and never typed into the PARENT bubble as if the main agent had said it.
            if (event.parentToolUseId !== undefined) {
                return step(state);
            }
            const opened = withBubble(state);
            return step(enqueueText(opened.state, opened.id, event.text));
        }
        /* THE USER SPOKE WHILE THE TURN RAN, their words, at the point in the stream the daemon took them.
         *
         * A bubble of their own AND a boundary, and the boundary is the whole bug this frame exists for. The
         * harness absorbs a steer between tool calls and the model keeps writing with no `result` in between, so
         * nothing else in the stream retires the open bubble: what the agent says NEXT is its answer to this
         * message, and left in the bubble above it the answer printed over the question. Retiring here is the
         * same move `text_end` and `usage` make, for the same reason, everything after these words belongs
         * below them.
         *
         * NOT flushed, exactly like text_end: the typewriter keeps draining into the retired bubble by id, so
         * prose the model had already written finishes typing where it was written rather than snapping into
         * place the instant a message arrives. */
        case `steer`: {
            const spoken = appendMessage(state, {
                role: `user`,
                text: event.text,
                sentAt: event.sentAt,
                ...(event.attachments === undefined ? {} : { attachments: event.attachments.map((path) => ({ name: basename(path), path })) }),
            });
            return step({ ...spoken, bubbleId: null });
        }
        case `text_end`:
            // The agent finished a block of prose. Retire the bubble it was writing into so whatever comes next
            //, the tool calls that block introduced, or the next block after they return, opens a fresh one
            // below it. That is what restores Claude Code's interleaving (says what it's about to do → the tool
            // cards → what it found → more cards → the summary); with one bubble per turn the whole narration
            // glued into a single paragraph run with every tool card hoisted above it. A subagent's blocks are
            // its own: its prose never enters the parent bubble, so its boundaries must not retire it either.
            //
            // Deliberately NOT flushed: the typewriter keeps draining into the retired bubble by id, and the
            // next delta flushes the remainder there before typing into the new one (see enqueueText). A flush
            // here would snap the whole tail of every block, including the closing summary, whose block ends
            // the moment the model stops writing, into place with no typing at all.
            if (closesBubble(state, event)) {
                return step({ ...state, bubbleId: null });
            }
            return step(state);
        case `thinking`: {
            if (!event.text) {
                return step(state);
            }
            // A sub-agent's thinking is grouped onto its own Agent card (its live transcript), not merged into
            // the parent turn's thinking block.
            if (event.parentToolUseId !== undefined) {
                return step(
                    mapToolAnywhere(state, event.parentToolUseId, (tool) => ({ ...tool, thinking: `${tool.thinking ?? ``}${event.text}` })).state,
                );
            }
            const opened = withBubble(state);
            return step(mapMessage(opened.state, opened.id, (message) => ({ ...message, thinking: `${message.thinking ?? ``}${event.text}` })));
        }
        case `tool_call`: {
            const opened = withBubble(state);
            return step(appendTool(opened.state, opened.id, event), { kind: `toolCall`, call: event });
        }
        case `tool_call_update`:
            // Merge the update into the call that produced it (matched by id); present fields REPLACE the prior
            // value (snapshot semantics. Codex streams a command's growing output as whole snapshots), absent
            // fields leave it unchanged. An update with no matching tool is dropped rather than shown loose.
            return step(
                mapToolAnywhere(state, event.id, (tool) => ({
                    ...tool,
                    ...(event.status !== undefined ? { status: event.status } : {}),
                    ...(event.content !== undefined ? { content: event.content } : {}),
                    ...(event.locations !== undefined ? { locations: event.locations } : {}),
                })).state,
            );
        case `subagent`: {
            /* The call just started an AGENT, an Agent/Task subagent, or a Codex/Grok CLI it drove from its own
             * Bash. The frame's id IS the spawning call's, so it lands on that card through the same lookup a
             * sub-agent's nested calls already use. A card that isn't there yet cannot happen in practice (the
             * tool_call is streamed first), and if it did the frame is dropped rather than opening a card of its
             * own: a subagent with no delegation above it is not a thing the transcript can render. */
            const { kind: _kind, id, subagentKind, ...rest } = event;
            return step(mapToolAnywhere(state, id, (tool) => ({ ...tool, subagent: { ...rest, kind: subagentKind, status: `running` } })).state);
        }
        case `subagent_update`:
            // Present fields REPLACE, absent ones leave the child alone, the same snapshot semantics
            // tool_call_update has, and for the same reason: progress arrives many times and says only what moved.
            return step(
                mapToolAnywhere(state, event.id, (tool) => {
                    if (tool.subagent === undefined) {
                        return tool;
                    }
                    const { kind: _kind, id: _id, ...patch } = event;
                    return { ...tool, subagent: { ...tool.subagent, ...patch } };
                }).state,
            );
        case `todos`: {
            const opened = withBubble(state);
            return step(mapMessage(opened.state, opened.id, (message) => ({ ...message, todos: event.items })));
        }
        case `checkpoint`:
            // The pre-turn workspace state's id, plus where this turn sits in the daemon's transcript, both
            // anchored on the turn's user bubble, which is what the rewind affordance addresses it by.
            return step(
                mapMessage(state, context.userMessageId, (message) => ({
                    ...message,
                    checkpointId: event.id,
                    ...(event.index !== undefined ? { rewindIndex: event.index } : {}),
                })),
            );
        case `usage`: {
            // End-of-turn accounting, and the turn BOUNDARY: a steered conversation's stream can carry several
            // turns (a queued message the running turn couldn't absorb runs as its own turn after this one
            // settles), so retire the current bubble and let the next turn's frames open a fresh one below the
            // steered user message.
            const { kind: _kind, account: _account, ...usage } = event;
            return step({ ...attachUsage(flushPending(state), usage), bubbleId: null }, { kind: `totals`, usage });
        }
        case `plan`: {
            /* Current ExitPlanMode has no plan input: the completed prose block immediately before the call IS
             * the plan. The daemon repeats it on this frame so the card is self-contained; when that exact
             * block is the adjacent retired bubble, reclassify it into the card instead of drawing the same
             * markdown once as prose and again as a plan. A distinct intro remains its own bubble and takes
             * the ordinary path below. */
            const flushed = flushPending(state);
            const adjacent = flushed.messages.at(-1);
            const consumesAdjacent =
                adjacent?.role === `assistant` && adjacent.text.trim() !== `` && adjacent.text.trim() === event.text.trim();
            const opened = consumesAdjacent ? { state: flushed, id: adjacent.id } : withBubble(flushed);
            const attached = mapMessage(opened.state, opened.id, (message) => ({
                ...message,
                ...(consumesAdjacent ? { text: `` } : {}),
                plan: {
                    requestId: event.requestId,
                    text: event.text,
                    status: `pending`,
                    ...(event.document === undefined ? {} : { document: event.document }),
                },
            }));
            return step({ ...attached, bubbleId: null });
        }
        case `question`: {
            // Same flow as plan: attach the card to the current bubble and start a fresh bubble for whatever
            // the agent streams after the answer comes back.
            const opened = withBubble(flushPending(state));
            const attached = mapMessage(opened.state, opened.id, (message) => ({
                ...message,
                // The document the turn wrote and is asking about rides the frame (agent.ts): the card carries
                // its own subject, so an answer never depends on finding the write that produced it.
                question: {
                    requestId: event.requestId,
                    questions: event.questions,
                    status: `pending`,
                    ...(event.document === undefined ? {} : { document: event.document }),
                },
            }));
            return step({ ...attached, bubbleId: null });
        }
        case `permission`: {
            const { kind: _kind, ...ask } = event;
            const opened = withBubble(flushPending(state));
            const attached = mapMessage(opened.state, opened.id, (message) => ({ ...message, permission: { ...ask, status: `pending` } }));
            return step({ ...attached, bubbleId: null });
        }
        case `browser_help`: {
            // Same flow as the other cards; the card's own action leads AWAY (to /browsers, where the live
            // stage is), and the resolved frame is what usually freezes it here.
            const { kind: _kind, ...ask } = event;
            const opened = withBubble(flushPending(state));
            const attached = mapMessage(opened.state, opened.id, (message) => ({ ...message, browserHelp: { ...ask, status: `pending` } }));
            return step({ ...attached, bubbleId: null });
        }
        case `terminal_help`: {
            // The browser card's twin: its action leads away to the terminal panel, where the waiting prompt
            // and the hand-back are, and the resolved frame is what usually freezes it here.
            const { kind: _kind, ...ask } = event;
            const opened = withBubble(flushPending(state));
            const attached = mapMessage(opened.state, opened.id, (message) => ({ ...message, terminalHelp: { ...ask, status: `pending` } }));
            return step({ ...attached, bubbleId: null });
        }
        case `service_offer`: {
            // Same flow as the other cards. The asking `services run` sits inside a tool call of this same
            // turn, so the run's answer lands in that tool's own output, the card carries the decision and,
            // via the receipt frame below, how the spend ended.
            const opened = withBubble(flushPending(state));
            const attached = mapMessage(opened.state, opened.id, (message) => ({
                ...message,
                serviceOffer: { requestId: event.requestId, offer: event.offer, status: `pending` },
            }));
            return step({ ...attached, bubbleId: null });
        }
        case `capability_offer`: {
            // Same flow as the service offer above: the asking `capabilities request` sits inside a tool call
            // of this same turn, so the ask's answer lands in that tool's own output, the card carries the
            // decision and, via the outcome frame below, how the setup ended.
            const opened = withBubble(flushPending(state));
            const attached = mapMessage(opened.state, opened.id, (message) => ({
                ...message,
                capabilityOffer: { requestId: event.requestId, offer: event.offer, status: `pending` },
            }));
            return step({ ...attached, bubbleId: null });
        }
        case `payment_offer`: {
            // Same flow as the service offer above: the asking `wallet fetch` sits inside a tool call of this
            // same turn, so the endpoint's answer lands in that tool's own output, the card carries the
            // decision and, via the receipt frame below, whether the money actually moved.
            const opened = withBubble(flushPending(state));
            const attached = mapMessage(opened.state, opened.id, (message) => ({
                ...message,
                paymentOffer: { requestId: event.requestId, offer: event.offer, status: `pending` },
            }));
            return step({ ...attached, bubbleId: null });
        }
        case `payment_receipt`:
            // How the approved payment ended, patched onto the card the requestId names: settled (with its
            // onchain transaction), or failed, in which case the authorization expired unused and the card
            // can honestly say nothing was spent.
            return step({
                ...state,
                messages: state.messages.map((message): ChatMessage =>
                    message.paymentOffer?.requestId === event.requestId
                        ? {
                              ...message,
                              paymentOffer: {
                                  ...message.paymentOffer,
                                  receipt: {
                                      outcome: event.outcome,
                                      amountUsd: event.amountUsd,
                                      ...(event.transaction !== undefined ? { transaction: event.transaction } : {}),
                                      ...(event.network !== undefined ? { network: event.network } : {}),
                                  },
                              },
                          }
                        : message,
                ),
            });
        case `capability_outcome`:
            // How an accepted ask's setup ended, patched onto the card the requestId names, what settles the
            // "waiting for you to finish setup" state, here and on every replaying surface.
            return step({
                ...state,
                messages: state.messages.map((message): ChatMessage =>
                    message.capabilityOffer?.requestId === event.requestId
                        ? {
                              ...message,
                              capabilityOffer: {
                                  ...message.capabilityOffer,
                                  outcome: { outcome: event.outcome, ...(event.id !== undefined ? { id: event.id } : {}) },
                              },
                          }
                        : message,
                ),
            });
        case `service_event`:
            return step(appendServiceEvent(state, event));
        case `service_receipt`:
            // The approved run's outcome, patched onto the card the requestId names: served-and-charged,
            // refunded (the service failed to answer, nothing charged), or refused after the click.
            return step({
                ...state,
                messages: state.messages.map((message): ChatMessage =>
                    message.serviceOffer?.requestId === event.requestId
                        ? {
                              ...message,
                              serviceOffer: {
                                  ...message.serviceOffer,
                                  receipt: {
                                      outcome: event.outcome,
                                      credits: event.credits,
                                      ...(event.remaining !== undefined ? { remaining: event.remaining } : {}),
                                  },
                              },
                          }
                        : message,
                ),
            });
        case `permission_note`:
            return step(noteCard(state, event));
        case `resolved`:
            // The card above was released, and the frame says how. The surface that ANSWERED already froze its
            // own card (decidePlan / answerQuestion / decidePermission), so this is a no-op there; it earns its
            // keep on every other surface, a transcript replayed after a reload, or a second window watching
            // the same run, which would otherwise leave the card pending and offer buttons on a requestId
            // nothing holds any more. (The daemon's fleet registry reads the same frame for how long the turn
            // was parked; see agents-registry.ts.)
            return step(resolveCard(state, event));
        case `preamble`:
            /* WHAT THE DAEMON PUT IN FRONT OF THE MODEL, as one collapsed row carrying the exact words.
             *
             * It went in front of the message the user typed, so it belongs TO that message, hung off the user
             * bubble, where someone re-reading their own prompt finds it, and where the daemon's record keeps it
             * for a tab that reopens tomorrow. There is no second placement: nothing is injected into a running
             * turn any more (the mid-turn rebase was the only one, and it is silent now).
             *
             * A frame with nothing in it is not a row. The daemon sends only notes it actually injected, but a
             * turn that injected none must not draw an empty disclosure inviting a click on nothing. */
            if (event.notes.length === 0) {
                return step(state);
            }
            return step(mapMessage(state, context.userMessageId, (message) => ({ ...message, notes: event.notes })));
        case `compact`:
            return step(appendNotice(state, `Context compacted to free up space.`));
        case `landed`:
            // End of a clean isolated turn: the delta auto-landed into the main tree as uncommitted changes
            // (review = the Changes panel), was HELD on the branch because auto-land is off, or conflicted and
            // stayed safely in the worktree. A landed delta that changed what the workspace depends on carries
            // its reconcile too (dependencyLine), the one consequence of this turn the Changes panel cannot
            // show, because it happened outside the diff.
            if (event.held === true) {
                return step(appendNotice(state, `Finished: the work is on this agent's branch, ready to land from its review.`));
            }
            return step(
                appendNotice(
                    state,
                    event.landed
                        ? `Changes landed in your workspace: review them in the Changes panel.${dependencyLine(event.deps)}`
                        : // Named, not explained: the cause is per-FILE (your edits, a moved main line, a binary),
                          // and the review is where each one is spelled out with the action that fits it. A
                          // notice that guesses one cause for all of them sends the user looking for an
                          // overlapping edit of their own that may not exist.
                          `${(event.conflicts ?? []).flatMap((conflict) => conflict.paths).length} file(s) couldn't land automatically in ${(
                              event.conflicts ?? []
                          )
                              .map((conflict) => conflict.repo)
                              .join(`, `)}. Open the agent's review to see what blocked them and land from there.`,
                    // The moment-of-regret offer, on the LANDED notice only (the same pattern as ChatPanel's
                    // outage banner): the automatic behaviour just fired, and "stop doing that" is
                    // worth one press exactly now. The renderer hides it once the agent already holds.
                    // An install that STARTED takes the slot instead: for as long as it runs, the one press
                    // worth offering is the terminal it is running in, the land is already reviewable, the
                    // install is the thing still happening.
                    event.landed ? { noticeAction: (event.deps?.started.length ?? 0) > 0 ? `depsInstall` : `landHold` } : undefined,
                ),
            );
        case `commands`:
            return step(state, { kind: `commands`, items: event.items });
        case `session`:
            return step(state, { kind: `session`, sessionId: event.sessionId, account: event.account });
        case `worktree`:
            return step(event.sync === undefined ? state : prependTurnNotice(state, syncLine(event.sync)), {
                kind: `worktree`,
                branch: event.branch,
                base: event.base,
                ...(event.unenforced === true ? { unenforced: true } : {}),
            });
        case `mode`:
            return step(state, { kind: `liveMode`, mode: event.mode });
        case `init`:
            return step(state, { kind: `activeModel`, model: event.model });
        case `context_usage`:
            return step(state, { kind: `contextUsage`, usage: { tokens: event.tokens, contextWindow: event.contextWindow } });
        case `account_usage`:
            // An env-token turn has no account to attribute headroom to, so there is nothing to key it by.
            return event.account === undefined ? step(state) : step(state, { kind: `accountUsage`, account: event.account, windows: event.windows });
        case `terminal`:
            return step(state, { kind: `surfaceTerminal`, session: event.session });
        case `browser`:
            return step(state, { kind: `surfaceBrowser`, session: event.session });
        case `error`:
            return step(state, {
                kind: `error`,
                message: event.message,
                code: event.code,
                resetsAt: event.resetsAt,
                autoResume: event.autoResume,
                outage: event.outage,
                held: event.held,
            });
        case `provider_retry`:
            return step(state, { kind: `providerRetry`, retry: event });
        case `fast_mode`:
            return step(state, { kind: `fastMode`, fast: event });
        case `tier`:
            return step(state, { kind: `tier`, tier: event });
        case `rate_limit_info`:
        // The live gate, not a headroom reading: it names whichever single window the provider considered
        // binding for that request. `account_usage` carries every pool, and is what the readouts use.
        case `done`:
            return step(state);
    }
    return unhandledFrame(state, event);
};
