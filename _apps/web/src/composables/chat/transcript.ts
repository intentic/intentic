import type {
    AskQuestion,
    PermissionAsk,
    SubagentKind,
    SubagentStatus,
    TodoItem,
    ToolCallContent,
    ToolCallLocation,
    ToolCallStatus,
    ToolKind,
} from "@intentic/sandbox-contract";
import { errandOf } from "./errands";

/* The transcript VOCABULARY — what a chat is made of, with no notion of how it is produced.
 *
 * Split out of conversation.ts so the frame reducer (turnReducer.ts) and the conversation runtime can both
 * speak it without one importing the other. Everything here is a plain value type or a pure function over
 * them; nothing reaches for a ref, the network, or the daemon. */

// 'notice' is a small muted system line in the transcript (dismissed / kept planning / approved / stopped) —
// it keeps the user informed about control actions, Claude Code style.
export type ChatRole = "user" | "assistant" | "notice";

// A plan the agent proposed, awaiting the user. 'pending' renders the approve/keep-planning buttons; once
// decided the choice is frozen into the transcript. 'cancelled' is the user stopping the turn out from under
// the card instead of answering it.
export type PlanStatus = "pending" | "approved" | "rejected" | "cancelled";

export interface PlanRequest {
    readonly requestId: string;
    readonly text: string;
    readonly status: PlanStatus;
}

// A set of questions awaiting the user's picks. 'pending' shows the selectable card; once the user submits or
// dismisses, the choice is frozen into the transcript.
export type QuestionStatus = "pending" | "answered" | "cancelled";

export interface QuestionRequest {
    readonly requestId: string;
    readonly questions: AskQuestion[];
    readonly status: QuestionStatus;
    // Selected option label(s) per question text, captured on submit for the static summary.
    readonly answers?: Record<string, string[]>;
}

// A tool call awaiting the user's approval (the daemon's canUseTool gate). 'pending' shows the buttons; the
// answer then freezes into the transcript so the turn reads back as a record of what was allowed. 'cancelled'
// is the user stopping the turn instead of answering — the tool never ran, and nobody denied it either.
export type PermissionStatus = "pending" | "allowed" | "always" | "denied" | "cancelled";

export interface PermissionRequest extends PermissionAsk {
    readonly requestId: string;
    readonly status: PermissionStatus;
}

// One tool call the sandbox agent made during a turn, built from its tool_call frame and merged-by-id with
// every later tool_call_update (status transitions, fresh content/locations — snapshots, not appends).
export interface ChatTool {
    readonly id: string;
    readonly name: string;
    readonly category: ToolKind;
    readonly status: ToolCallStatus;
    readonly target?: string;
    readonly locations?: readonly ToolCallLocation[];
    readonly content?: readonly ToolCallContent[];
    // A sub-agent (Agent/Task tool) delegation's own transcript: the tool calls it made, nested under its card
    // so the delegation reads as one unit instead of a flat run of siblings. Its frames carry this tool's id as
    // their parentToolUseId. Absent for an ordinary tool call.
    readonly children?: readonly ChatTool[];
    // A sub-agent's streamed thinking, grouped onto its own card rather than merged into the parent turn's
    // thinking block. Absent for an ordinary tool call.
    readonly thinking?: string;
    /* THE CHILD THIS CALL STARTED, as the daemon's registry sees it (SubagentSessionSchema). Set on the card whose
     * id the `subagent`/`subagent_update` frames name — which is this call's own id, so no correlation is needed:
     * an Agent card wears its subagent's live state, and a Bash card that turned out to be a `codex exec` wears
     * its delegate's.
     *
     * It is what a card can say about a BACKGROUNDED child, which is the case that used to be invisible: the tool
     * result may be minutes away, and until it lands this is the only account of whether anything is happening. */
    readonly subagent?: {
        readonly kind: SubagentKind;
        readonly agentType?: string;
        readonly description?: string;
        readonly status: SubagentStatus;
        readonly tokens?: number;
        readonly toolUses?: number;
        readonly lastTool?: string;
        readonly summary?: string;
        readonly error?: string;
        readonly background?: boolean;
        // A delegation's tmux session — the live view a subagent has no equivalent of.
        readonly terminal?: string;
    };
}

// Apply `fn` to the tool with `id` anywhere in a bubble's tool tree — a sub-agent's calls live nested under its
// Agent card, so a tool_call_update or a sub-agent thinking delta has to reach into the children too. Returns
// the SAME array when the id isn't present, so an unrelated bubble keeps its identity (and re-renders nothing).
export const mapTool = (tools: readonly ChatTool[], id: string, fn: (tool: ChatTool) => ChatTool): readonly ChatTool[] => {
    let changed = false;
    const next = tools.map((tool) => {
        if (tool.id === id) {
            changed = true;
            return fn(tool);
        }
        if (tool.children !== undefined) {
            const children = mapTool(tool.children, id, fn);
            if (children !== tool.children) {
                changed = true;
                return { ...tool, children };
            }
        }
        return tool;
    });
    return changed ? next : tools;
};

// A file the user attached to a turn, already uploaded to the workspace before send. `previewUrl` is an
// object URL for image thumbnails — client-session only, gone on reload (restored history shows text).
export interface ChatAttachment {
    readonly name: string;
    // Workspace-relative upload destination (.intentic/attachments/<uuid>/<name>), sent on the turn.
    readonly path: string;
    readonly previewUrl?: string;
}

// End-of-turn accounting from the SDK's result message.
export interface ChatUsage {
    readonly costUsd?: number;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly durationMs?: number;
    readonly numTurns?: number;
}

export interface ChatMessage {
    readonly id: number;
    readonly role: ChatRole;
    readonly text: string;
    /* A one-press follow-up a notice line can carry (notices only): the landed notice's "keep future work on the
     * branch" offer, and the outage notice's "stop resuming these by itself". A KIND, not a callback — the
     * transcript is rebuilt from replayed frames, so the renderer owns what the press does and whether the offer
     * is still standing (ChatMessageView reads the CURRENT posture and hides a stale offer).
     *
     * Both are the same shape of affordance, and it is the one that earns an on-by-default automation the right to
     * be on by default: the moment the automatic behaviour fires is the moment "don't do that" is worth exactly
     * one press, so the opt-out is offered there rather than only in a settings page nobody is looking at. */
    readonly noticeAction?: "landHold" | "outageOptOut";
    /* Set on a notice describing something that has not finished yet (notices only) — rendered with a spinner in
     * place of its info icon while the wait is on, and as an ordinary settled line once it is over.
     *
     * A KIND rather than a boolean, for the same reason noticeAction is: whether the wait is STILL running is a
     * fact about the conversation right now, not about a line frozen into a replayed transcript. The renderer
     * pairs the kind with the live state that answers it (credentialRenewal), so a transcript replayed an hour
     * later shows the line settled instead of spinning forever over a turn that came back long ago. */
    readonly noticeWait?: "credentialRenewal";
    // Files the user attached to this turn (user bubbles only), for the chip/thumbnail row.
    readonly attachments?: readonly ChatAttachment[];
    // The workspace checkpoint capturing the state BEFORE this turn ran (user bubbles only, main-tree turns
    // only) — powers the hover "restore to before this message" affordance.
    readonly checkpointId?: string;
    // Accumulated extended-thinking text for assistant turns (empty when none / thinking off).
    readonly thinking?: string;
    // Set when this assistant turn proposed a plan; carries the approval state for the card UI.
    readonly plan?: PlanRequest;
    // Set when this assistant turn asked interactive questions; carries the answer state.
    readonly question?: QuestionRequest;
    // Set when a tool call on this turn needed the user's approval; carries the decision.
    readonly permission?: PermissionRequest;
    // Tool actions (Bash/Edit/…) the sandbox agent ran during this turn, newest last. A sub-agent's own calls
    // nest under its Agent card (ChatTool.children), so this is a tree, not a flat list. Built immutably
    // (mapTool rewrites by id), so it's readonly to the element level like `attachments`.
    readonly tools?: readonly ChatTool[];
    // The agent's live task checklist (TodoWrite), replaced whole each time it updates.
    readonly todos?: TodoItem[];
    // Cost/token accounting, attached once the turn's result lands.
    readonly usage?: ChatUsage;
}

/* THE INTERACTIVE CARDS a turn can park on. They differ in what they ask — a plan to approve, questions to
 * answer, a tool to permit — and in nothing else: each carries a `requestId` the daemon un-parks on, each is
 * `pending` until the user answers it, and each can be `cancelled` by a Stop instead. Every site that has to
 * reach "whatever card this bubble is waiting on" derives from this list, so a fourth kind is one edit here
 * rather than a hunt through the three places that used to spell them out. */
export const CARD_KINDS = ["plan", "question", "permission"] as const;
export type CardKind = (typeof CARD_KINDS)[number];

// Whether a bubble is holding the turn open on a card the user hasn't answered.
export const isAwaitingDecision = (message: ChatMessage): boolean => CARD_KINDS.some((kind) => message[kind]?.status === `pending`);

/* Freeze whatever cards a bubble is parked on as `cancelled` — the user stopped the turn out from under the
 * question instead of answering it. Returns the SAME message when it holds none, so a Stop mid-transcript
 * re-renders only the bubbles it actually changed. */
export const withCancelledCards = (message: ChatMessage): ChatMessage => {
    if (!isAwaitingDecision(message)) {
        return message;
    }
    return {
        ...message,
        ...(message.plan?.status === `pending` ? { plan: { ...message.plan, status: `cancelled` } } : {}),
        ...(message.question?.status === `pending` ? { question: { ...message.question, status: `cancelled` } } : {}),
        ...(message.permission?.status === `pending` ? { permission: { ...message.permission, status: `cancelled` } } : {}),
    };
};

// One exchange: the user's prompt and everything the agent produced in reply, up to the next prompt. The
// transcript renders a group per turn so the prompt can pin to the top of the scroller while its answer scrolls
// beneath it — the group is what bounds the pin, so the next prompt pushes this one out instead of stacking on
// it. Identified by its opening message, which is stable for the group's life.
export interface ChatTurn {
    readonly id: number;
    readonly messages: ChatMessage[];
    /* What turnsOf folded into this turn — every user message after the opener, whether the user's own nudge
     * or an errand the app sent (see foldsIntoTurn). Rendered by the opener's bubble as its "↳ … ×N" trailer,
     * so a pinned prompt still admits what has happened to it since.
     *
     * Derived here rather than per render, because the transcript reads it for the head bubble of EVERY turn
     * on every paint of a streaming answer, and a freshly filtered array each time is a changed prop: it
     * defeated Vue's identity bailout and re-rendered one bubble per turn per frame to hand it the same
     * messages back. Turns that folded nothing — nearly all of them — share NOTHING_FOLDED, so the prop holds
     * still across the rebuild `turnsOf` does on each frame. */
    readonly folded: readonly ChatMessage[];
}

// The client transcript as a daemon-seed history: user/assistant text turns only. Notices, tool runs, todos,
// and thinking are UI artifacts; a plan card's markdown IS the assistant's output in plan mode, so it rides.
export const transcriptOf = (messages: readonly ChatMessage[]): { role: "user" | "assistant"; text: string }[] =>
    messages.flatMap((message) => {
        if (message.role === `notice`) {
            return [];
        }
        const text = message.plan !== undefined ? [message.text, message.plan.text].filter((part) => part.length > 0).join(`\n\n`) : message.text;
        return text.trim().length > 0 ? [{ role: message.role, text }] : [];
    });

/* Messages whose ENTIRE content is "keep going". Such a message points at the previous prompt instead of
 * carrying intent of its own — so opening a turn on it would pin "Continue" to the top of the panel while the
 * question it defers to scrolls away. Matched against the whole message, deliberately: "continue, but skip
 * the tests" carries a new instruction and must pin like any prompt. Trailing sentence punctuation is
 * stripped ("Continue.", "ok!"), but never "?" — "continue?" is a question, not consent. */
const ACKNOWLEDGMENTS = new Set([
    `continue`,
    `please continue`,
    `keep going`,
    `go`,
    `go on`,
    `go ahead`,
    `go for it`,
    `carry on`,
    `proceed`,
    `resume`,
    `next`,
    `do it`,
    `do that`,
    `yes`,
    `yes please`,
    `y`,
    `yep`,
    `yeah`,
    `ok`,
    `okay`,
    `k`,
    `sure`,
    `sounds good`,
    `lgtm`,
    `ship it`,
    `approved`,
    `+1`,
    `👍`,
]);

// An attachment makes any text substantive — "continue" plus a screenshot is new material, not a nudge.
export const isAcknowledgment = (message: ChatMessage): boolean => {
    if (message.role !== `user` || (message.attachments?.length ?? 0) > 0) {
        return false;
    }
    return ACKNOWLEDGMENTS.has(
        message.text
            .trim()
            .toLowerCase()
            .replace(/[.!…]+$/u, ``)
            .trim()
            .replace(/\s+/gu, ` `),
    );
};

/* A USER MESSAGE THAT DOES NOT OPEN A TURN. It folds into the one above it instead, so the prompt that
 * actually defines the work keeps its pin through everything done in service of it.
 *
 * Two populations, deferring for two different reasons, and the split is worth stating because only one of
 * them is about the user at all: a bare acknowledgment is their own contentless "keep going", while an errand
 * is a prompt the APP composed and sent on their behalf (errands.ts) — a rebase, a review, a test pass. Both
 * point at the prompt above rather than carrying intent of their own, and pinning either would cover the
 * question it defers to. */
export const foldsIntoTurn = (message: ChatMessage): boolean => isAcknowledgment(message) || errandOf(message) !== undefined;

// A conversation can open with frames that answer no prompt of this session — a restored history's assistant
// text, a provider-switch notice — so the first group may have no user message to pin.
// Shared by every turn that folded nothing, so the overwhelmingly common case hands the renderer the same
// array on each rebuild rather than an equal one (see ChatTurn.folded).
const NOTHING_FOLDED: readonly ChatMessage[] = [];

export const turnsOf = (messages: readonly ChatMessage[]): ChatTurn[] => {
    const turns: { id: number; messages: ChatMessage[]; folded: readonly ChatMessage[] }[] = [];
    for (const message of messages) {
        const open = turns.at(-1);
        if (open === undefined || (message.role === `user` && !foldsIntoTurn(message))) {
            turns.push({ id: message.id, messages: [message], folded: NOTHING_FOLDED });
            continue;
        }
        open.messages.push(message);
        // Every user message past the opener is one this turn folded in. Assigned only when there is one, so a
        // turn that folded nothing keeps the shared empty array.
        if (message.role === `user`) {
            open.folded = open.folded === NOTHING_FOLDED ? [message] : [...open.folded, message];
        }
    }
    return turns;
};
