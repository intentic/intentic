import type { AskQuestion, PermissionAsk, TodoItem, ToolCallContent, ToolCallLocation, ToolCallStatus, ToolKind } from "@intentic/sandbox-contract";

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

// One exchange: the user's prompt and everything the agent produced in reply, up to the next prompt. The
// transcript renders a group per turn so the prompt can pin to the top of the scroller while its answer scrolls
// beneath it — the group is what bounds the pin, so the next prompt pushes this one out instead of stacking on
// it. Identified by its opening message, which is stable for the group's life.
export interface ChatTurn {
    readonly id: number;
    readonly messages: ChatMessage[];
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

// A conversation can open with frames that answer no prompt of this session — a restored history's assistant
// text, a provider-switch notice — so the first group may have no user message to pin.
export const turnsOf = (messages: readonly ChatMessage[]): ChatTurn[] => {
    const turns: ChatTurn[] = [];
    for (const message of messages) {
        const open = turns.at(-1);
        if (message.role === `user` || open === undefined) {
            turns.push({ id: message.id, messages: [message] });
            continue;
        }
        open.messages.push(message);
    }
    return turns;
};
