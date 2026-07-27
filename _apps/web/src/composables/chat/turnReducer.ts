import type { AgentCommand, AgentEvent, AgentReply, ContextUsage, PermissionMode, UsageWindow } from "@intentic/sandbox-contract";
import { type ChatMessage, type ChatTool, type ChatUsage, mapTool, type PermissionStatus, type PlanStatus, type QuestionStatus } from "./transcript";

/* One agent frame applied to the transcript — as a PURE function.
 *
 * This is the part of a chat that is genuinely intricate: which bubble a delta lands in, when a block of prose
 * is retired so the tools it introduced appear below it rather than above, where a sub-agent's calls nest,
 * which bubble a plan card attaches to and which one the post-approval continuation opens. Those rules are the
 * product — get them wrong and the transcript reads as a jumble — and they used to be spread across a class
 * that also owned the network, the abort controllers, the typewriter's timers, and a dozen Vue refs, which
 * meant the only way to exercise them was to drive a whole conversation.
 *
 * So the state a frame can touch is a VALUE here, and everything a frame does that isn't transcript-shaped
 * comes back as an effect the caller applies. The caller (Conversation) keeps the sockets and the refs; this
 * module keeps the rules.
 *
 * The typewriter is part of the state, not an escape hatch. Accepted-but-not-yet-revealed text lives in
 * `pending`, so "does this bubble hold any prose yet" — the question the text_end split turns on — is
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
    // Monotonic message-id allocator. In the state because allocating an id IS a transition — a reducer that
    // reached for a counter on `this` would not be replayable.
    readonly nextId: number;
    readonly pending: PendingText | undefined;
}

// What the frame needs to know about the turn it belongs to, and which the transcript cannot tell it.
export interface TurnContext {
    // The user bubble this turn answers — where a checkpoint id anchors its "restore to before this" affordance.
    readonly userMessageId: number;
}

/** Everything a frame does that is not a change to the transcript. The caller owns each of these — they are
 *  conversation-level refs, cross-conversation stores, or genuine side effects — and applying them is a flat
 *  switch with no logic in it, which is exactly the point: the logic is above, and it is pure. */
export type TurnEffect =
    // The session the next matching turn resumes. The caller stamps it with the turn's provider/account/harness.
    | { readonly kind: "session"; readonly sessionId: string }
    | { readonly kind: "worktree"; readonly branch: string; readonly base: string }
    // The posture the RUNNING turn is in — the agent's own EnterPlanMode, or where a plan approval landed.
    | { readonly kind: "liveMode"; readonly mode: PermissionMode }
    | { readonly kind: "commands"; readonly items: readonly AgentCommand[] }
    | { readonly kind: "activeModel"; readonly model: string }
    | { readonly kind: "contextUsage"; readonly usage: ContextUsage }
    // Fold into the conversation's lifetime totals. The transcript attachment already happened, in state.
    | { readonly kind: "totals"; readonly usage: ChatUsage }
    // Account-wide subscription headroom, keyed by the account that served the turn. Not tied to any bubble.
    | { readonly kind: "accountUsage"; readonly account: string; readonly windows: readonly UsageWindow[] }
    // Auto-open the file an edit touches.
    | { readonly kind: "followToolCall"; readonly call: Extract<AgentEvent, { kind: "tool_call" }> }
    // Surface the agent's live tmux terminal as a tab in the global panel.
    | { readonly kind: "surfaceTerminal"; readonly session: string }
    // A turn-level failure. Wording and severity are the caller's: several codes need state this module has no
    // business reading (the account's usage windows, the provider's account list) to phrase themselves.
    | { readonly kind: "error"; readonly message: string; readonly code: Extract<AgentEvent, { kind: "error" }>["code"] };

export interface TurnStep {
    readonly state: TurnState;
    readonly effects: readonly TurnEffect[];
}

export const emptyTurnState: TurnState = { messages: [], bubbleId: null, nextId: 1, pending: undefined };

const step = (state: TurnState, ...effects: readonly TurnEffect[]): TurnStep => ({ state, effects });

// A daemon NEWER than this browser can emit a frame kind this build has never heard of — that is a supported
// state (a released app plane serves whatever image each user last pulled), so it must be a no-op rather than a
// crash. The `never` parameter is what keeps the switch below exhaustive at the same time: a kind the contract
// declares and this module forgets fails to compile here.
const unhandledFrame = (state: TurnState, _event: never): TurnStep => step(state);

// --- transcript primitives (pure, exported: the conversation runtime writes notices through these too) -------

export const appendMessage = (state: TurnState, message: Omit<ChatMessage, "id">): TurnState => ({
    ...state,
    messages: [...state.messages, { ...message, id: state.nextId }],
    nextId: state.nextId + 1,
});

/** A small muted system line marking a control action (dismissed / kept planning / approved / stopped). */
export const appendNotice = (state: TurnState, text: string): TurnState => appendMessage(state, { role: `notice`, text });

const mapMessage = (state: TurnState, id: number, fn: (message: ChatMessage) => ChatMessage): TurnState => ({
    ...state,
    messages: state.messages.map((message) => (message.id === id ? fn(message) : message)),
});

// Rewrite the tool with `id` wherever it lives across the transcript's bubbles, leaving every other bubble's
// object identity intact (mapTool returns the same array when the id is absent). The one seam both
// tool_call_update and a sub-agent's thinking delta write through. Reports whether it FOUND the tool, because
// two callers act on the answer — an update with no matching call is dropped, and a nested append whose parent
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

// Whether the turn's current bubble holds any of the agent's prose — COUNTING text still buffered in the
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

/** Reveal the WHOLE buffer at once — a turn ended, was stopped, or a card took the bubble over, so no text may
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
        // A sub-agent's own calls carry the id of the Agent tool that spawned them — nest those under that
        // card, wherever it lives, so the delegation reads as one unit rather than a flat run of siblings with
        // a lone spinner stranded above them.
        const nested = mapToolAnywhere(state, parentId, (parent) => ({ ...parent, children: [...(parent.children ?? []), tool] }));
        if (nested.matched) {
            return nested.state;
        }
        // Its Agent card wasn't found (a malformed stream) — fall through to a top-level append rather than
        // dropping the call.
    }
    return mapMessage(state, bubbleId, (message) => ({ ...message, tools: [...(message.tools ?? []), tool] }));
};

// The frozen status each card takes from the reply that settled it — the same mapping the answering client
// applies locally (see Conversation.decidePlan / answerQuestion / decidePermission), applied here to the card
// the frame names. No reply means the turn ended with the card still parked (Stop, a lost daemon), which is
// nobody's decision — 'cancelled' for all three. A reply of the wrong kind cannot reach a card of another,
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

// Freeze the card the frame names, wherever it hangs. Idempotent by construction: the window that answered
// already wrote this exact status when its reply came back, so the frame only ever changes a transcript that
// did NOT answer — a replay after a reload, or a second window watching the same run.
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
            // result content (tool_call_update), so the live delta is dropped rather than duplicated there —
            // and, crucially, never typed into the PARENT bubble as if the main agent had said it.
            if (event.parentToolUseId !== undefined) {
                return step(state);
            }
            const opened = withBubble(state);
            return step(enqueueText(opened.state, opened.id, event.text));
        }
        case `text_end`:
            // The agent finished a block of prose. Retire the bubble it was writing into so whatever comes next
            // — the tool calls that block introduced, or the next block after they return — opens a fresh one
            // below it. That is what restores Claude Code's interleaving (says what it's about to do → the tool
            // cards → what it found → more cards → the summary); with one bubble per turn the whole narration
            // glued into a single paragraph run with every tool card hoisted above it. A subagent's blocks are
            // its own: its prose never enters the parent bubble, so its boundaries must not retire it either.
            //
            // Deliberately NOT flushed: the typewriter keeps draining into the retired bubble by id, and the
            // next delta flushes the remainder there before typing into the new one (see enqueueText). A flush
            // here would snap the whole tail of every block — including the closing summary, whose block ends
            // the moment the model stops writing — into place with no typing at all.
            if (event.parentToolUseId === undefined && hasProse(state, state.bubbleId)) {
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
            return step(appendTool(opened.state, opened.id, event), { kind: `followToolCall`, call: event });
        }
        case `tool_call_update`:
            // Merge the update into the call that produced it (matched by id); present fields REPLACE the prior
            // value (snapshot semantics — Codex streams a command's growing output as whole snapshots), absent
            // fields leave it unchanged. An update with no matching tool is dropped rather than shown loose.
            return step(
                mapToolAnywhere(state, event.id, (tool) => ({
                    ...tool,
                    ...(event.status !== undefined ? { status: event.status } : {}),
                    ...(event.content !== undefined ? { content: event.content } : {}),
                    ...(event.locations !== undefined ? { locations: event.locations } : {}),
                })).state,
            );
        case `todos`: {
            const opened = withBubble(state);
            return step(mapMessage(opened.state, opened.id, (message) => ({ ...message, todos: event.items })));
        }
        case `checkpoint`:
            // The pre-turn workspace state's id — anchor the restore affordance on the turn's user bubble.
            return step(mapMessage(state, context.userMessageId, (message) => ({ ...message, checkpointId: event.id })));
        case `usage`: {
            // End-of-turn accounting — and the turn BOUNDARY: a steered conversation's stream can carry several
            // turns (a queued message the running turn couldn't absorb runs as its own turn after this one
            // settles), so retire the current bubble and let the next turn's frames open a fresh one below the
            // steered user message.
            const { kind: _kind, account: _account, ...usage } = event;
            return step({ ...attachUsage(flushPending(state), usage), bubbleId: null }, { kind: `totals`, usage });
        }
        case `plan`: {
            // Attach the plan to the current bubble (its intro text, if any) and clear the turn's bubble so the
            // post-decision continuation streams into a fresh one below the plan card. Flush first so any
            // in-flight intro text finishes typing into this bubble, not the next.
            const opened = withBubble(flushPending(state));
            const attached = mapMessage(opened.state, opened.id, (message) => ({
                ...message,
                plan: { requestId: event.requestId, text: event.text, status: `pending` },
            }));
            return step({ ...attached, bubbleId: null });
        }
        case `question`: {
            // Same flow as plan: attach the card to the current bubble and start a fresh bubble for whatever
            // the agent streams after the answer comes back.
            const opened = withBubble(flushPending(state));
            const attached = mapMessage(opened.state, opened.id, (message) => ({
                ...message,
                question: { requestId: event.requestId, questions: event.questions, status: `pending` },
            }));
            return step({ ...attached, bubbleId: null });
        }
        case `permission`: {
            const { kind: _kind, ...ask } = event;
            const opened = withBubble(flushPending(state));
            const attached = mapMessage(opened.state, opened.id, (message) => ({ ...message, permission: { ...ask, status: `pending` } }));
            return step({ ...attached, bubbleId: null });
        }
        case `resolved`:
            return step(resolveCard(state, event));
        case `compact`:
            return step(appendNotice(state, `Context compacted to free up space.`));
        case `landed`:
            // End of a clean isolated turn: the delta auto-landed into the main tree as uncommitted changes
            // (review = the Changes panel), or conflicted and stayed safely in the worktree.
            return step(
                appendNotice(
                    state,
                    event.landed
                        ? `Changes landed in your workspace — review them in the Changes panel.`
                        : `Some changes couldn't land automatically — your own edits overlap in ${(event.conflicts ?? [])
                              .map((conflict) => conflict.repo)
                              .join(`, `)}. Resolve them, then use Land now in the agent's review.`,
                ),
            );
        case `commands`:
            return step(state, { kind: `commands`, items: event.items });
        case `session`:
            return step(state, { kind: `session`, sessionId: event.sessionId });
        case `worktree`:
            return step(state, { kind: `worktree`, branch: event.branch, base: event.base });
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
        case `error`:
            return step(state, { kind: `error`, message: event.message, code: event.code });
        case `rate_limit_info`:
        // The live gate, not a headroom reading: it names whichever single window the provider considered
        // binding for that request. `account_usage` carries every pool, and is what the readouts use.
        case `done`:
            return step(state);
    }
    return unhandledFrame(state, event);
};
