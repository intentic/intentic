import type {
    AskQuestion,
    PermissionAsk,
    ServiceOffer,
    SubagentKind,
    SubagentStatus,
    TodoItem,
    ToolCallContent,
    ToolCallLocation,
    ToolCallStatus,
    ToolKind,
    TurnNote,
} from "@intentic/sandbox-contract";
import { formatDate } from "@intentic/ui/format";
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

// The agent's browser parked on something only a person can clear (a captcha, a stored password nobody holds).
// 'pending' renders the card with its way THERE — the Browsers view, where the live stage and Take control are,
// and where "hand back" resolves it; 'helped'/'declined' freeze how it ended (mostly via the resolved frame,
// since the answering surface is usually not this card). 'cancelled' is the turn ending under it.
export type BrowserHelpStatus = "pending" | "helped" | "declined" | "cancelled";

export interface BrowserHelpRequest {
    readonly requestId: string;
    // The browser session on /browsers the owner steps into, and the account whose sign-in is stuck.
    readonly session: string;
    readonly account: string;
    readonly message: string;
    readonly status: BrowserHelpStatus;
}

// A priced service run awaiting the owner's click — the daemon's spend gate (platform/service-offer.ts).
// 'pending' shows Run/Skip with the platform's own numbers; 'approved'/'skipped' freeze the decision.
// 'cancelled' is nobody answering — the turn stopped under the card, the asking command died, or the offer
// expired — every one of which charged nothing.
export type ServiceOfferStatus = "pending" | "approved" | "skipped" | "cancelled";

export interface ServiceOfferRequest {
    readonly requestId: string;
    readonly offer: ServiceOffer;
    readonly status: ServiceOfferStatus;
    // How an approved run ended (the service_receipt frame): served and charged, refunded in full because the
    // service failed to answer, or refused by the platform after the click (a raced-out allowance).
    readonly receipt?: { readonly outcome: "ok" | "refunded" | "refused"; readonly credits: number; readonly remaining?: number };
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
    // Workspace-relative upload destination (.intentic/artifacts/attachments/<uuid>/<name>), sent on the turn.
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
    /* WHEN THIS MESSAGE WAS SENT, in epoch milliseconds (user bubbles only) — what the bubble shows on hover.
     *
     * Stamped as the bubble is appended for a turn this tab sent, and read off the daemon's record
     * (RestoredMessage.sentAt) for one it reopens, so the same message reads the same hour or a week later. Only
     * the user's own rows carry one: the daemon knows when a turn was sent and nothing anywhere knows when a
     * given assistant block was written, and a bubble stamped with a time it has no claim to is worse than one
     * that says nothing. Absent on rows recorded before this existed — the bubble simply shows nothing. */
    readonly sentAt?: number;
    /* A one-press follow-up a notice line can carry (notices only): the landed notice's "keep future work on the
     * branch" offer, the outage notice's "stop resuming these by itself", and the terminal a dependency install
     * the daemon just started is running in. A KIND, not a callback — the transcript is rebuilt from replayed
     * frames, so the renderer owns what the press does and whether the offer is still standing (ChatMessageView
     * reads the CURRENT posture and hides a stale offer).
     *
     * The first two are the same shape of affordance, and it is the one that earns an on-by-default automation the
     * right to be on by default: the moment the automatic behaviour fires is the moment "don't do that" is worth
     * exactly one press, so the opt-out is offered there rather than only in a settings page nobody is looking at.
     *
     * `depsInstall` is the other half of the same bargain — an automation that ran without asking owes the reader
     * a way to SEE it, not just a way to stop it. The install is a real attachable tmux job, so the press is a
     * reveal rather than a dialog: whoever wants the output gets the terminal it is already scrolling in. */
    readonly noticeAction?: "landHold" | "outageOptOut" | "depsInstall";
    /* Set on a notice describing something that has not finished yet (notices only) — rendered with a spinner in
     * place of its info icon while the wait is on, and as an ordinary settled line once it is over.
     *
     * A KIND rather than a boolean, for the same reason noticeAction is: whether the wait is STILL running is a
     * fact about the conversation right now, not about a line frozen into a replayed transcript. The renderer
     * pairs the kind with the live state that answers it (credentialRenewal), so a transcript replayed an hour
     * later shows the line settled instead of spinning forever over a turn that came back long ago. */
    readonly noticeWait?: "credentialRenewal";
    /* Set on a notice that came out of the DAEMON'S RECORD rather than being drawn here (notices only) — a turn
     * the provider refused, a turn the daemon resumed by itself. It is the one thing that tells the two kinds
     * apart once they are side by side in the same list, and what it decides is arithmetic: a recorded notice
     * occupies a row of the record and a local one does not, so a fork that counts them the same way cuts the
     * copied prefix in the wrong place (see recordedRows). */
    readonly recorded?: boolean;
    /* WHAT THE DAEMON TOLD THIS TURN and the user did not — each note with the title its row is drawn as and the
     * text that opening it reveals.
     *
     * A turn's prompt is not only what was typed: a rebase that moved the branch out from under the agent,
     * dependencies that are behind, workspace context retrieved for the message, the repos just pulled. The chat
     * used to show one muted line paraphrasing the rebase and nothing at all for the rest, which put the user in
     * the position of watching an agent follow instructions they had no way to read. Collapsed, not hidden: one
     * line until it is opened, and always there to open.
     *
     * On the USER bubble for the ordinary case, because that is what the notes were added to and it is how they
     * survive a reopen (the daemon stores them on that row). On a NOTICE for the mid-turn case — a rebase taken
     * while a card was parked went in front of no message of theirs, so it reads where it happened. */
    readonly notes?: readonly TurnNote[];
    // Files the user attached to this turn (user bubbles only), for the chip/thumbnail row.
    readonly attachments?: readonly ChatAttachment[];
    // The workspace checkpoint capturing the state BEFORE this turn ran (user bubbles only, main-tree turns
    // only) — powers the hover "go back to before this message" affordance.
    readonly checkpointId?: string;
    /* This message's position in the DAEMON's transcript, which is how the rewind route addresses it (user
     * bubbles only). Deliberately not the bubble's own index: the two diverge the moment a local `notice` line
     * is drawn, and a rewind aimed one message off restores the wrong turn and drops the wrong messages.
     *
     * Set from the daemon's `checkpoint` frame while a turn streams, and from the transcript's own ordering
     * when a tab reopens — the record holds exactly the user/assistant rows this index counts. */
    readonly rewindIndex?: number;
    // Accumulated extended-thinking text for assistant turns (empty when none / thinking off).
    readonly thinking?: string;
    // Set when this assistant turn proposed a plan; carries the approval state for the card UI.
    readonly plan?: PlanRequest;
    // Set when this assistant turn asked interactive questions; carries the answer state.
    readonly question?: QuestionRequest;
    // Set when a tool call on this turn needed the user's approval; carries the decision.
    readonly permission?: PermissionRequest;
    // Set when this turn's browser asked for the owner's hands; carries how the request ended.
    readonly browserHelp?: BrowserHelpRequest;
    // Set when this turn asked to run a priced service; carries the decision and, once run, the receipt.
    readonly serviceOffer?: ServiceOfferRequest;
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
export const CARD_KINDS = ["plan", "question", "permission", "browserHelp", "serviceOffer"] as const;
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
        ...(message.browserHelp?.status === `pending` ? { browserHelp: { ...message.browserHelp, status: `cancelled` } } : {}),
        ...(message.serviceOffer?.status === `pending` ? { serviceOffer: { ...message.serviceOffer, status: `cancelled` } } : {}),
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

/* HOW MANY ROWS THE DAEMON'S RECORD HOLDS FOR THESE BUBBLES — the one place the two numberings are converted,
 * and the count a fork hands the daemon so it can copy that prefix of the source conversation.
 *
 * The record and the bubble list are deliberately not the same list: a bubble that produced nothing at all is
 * not a row, and most notices are this client's own writing (a rewind, a provider switch, a control action) with
 * nothing behind them in the record. Everything else is 1:1, because both sides fold a turn the same way (one
 * user row, then one assistant row per prose block with its cards beneath it).
 *
 * The notices that DO count are the ones the daemon wrote down — a refused turn, a turn it resumed by itself —
 * which arrive here only through a restore and say so (ChatMessage.recorded). Counting those out was silently
 * wrong for every conversation that had ever seen a provider error: the fork asked for fewer rows than it meant
 * and lost the tail of the transcript it was copying.
 *
 * The assistant guard below MIRRORS the daemon's own (`flush` in sessions/turn-transcript.ts): text, thinking or
 * tools makes a row, and nothing makes none. The two have to agree — a fork that counts one row too many
 * inherits a turn the user cut, one too few drops a turn they kept — so change them together. */
export const recordedRows = (messages: readonly ChatMessage[]): number =>
    messages.filter((message) => {
        if (message.role === `notice`) {
            return message.recorded === true;
        }
        if (message.role === `user`) {
            return true;
        }
        return message.text.length > 0 || (message.thinking?.length ?? 0) > 0 || (message.tools?.length ?? 0) > 0;
    }).length;

/* WHAT PRESSING CONTINUE ACTUALLY SAYS — one sentence, picked from two by continuationFor below.
 *
 * "Continue" alone is ambiguous at exactly the moment it gets used most. The commonest way a turn ends early is
 * a tool the user refused: the agent is told to stop and wait, and the next thing it hears is the word
 * "continue" — which reads as "go on then, run it", so the refused command is the first thing it reaches for
 * again. That is the failure mode of typing the word by hand, and naming the refusal is what fixes it.
 *
 * Plain words, and short, because this lands in the transcript as the user's own message: pressing the button IS
 * them saying it. (The machine-voiced resume notes on the wire are for turns the daemon re-ran with nobody
 * asking, where a user bubble would be a lie about who spoke. This is not one of those.) */
export const CONTINUATIONS = {
    plain: `Continue`,
    afterDenial: `Continue, without the step I declined.`,
} as const;

// A message reduced to what the lexicon below is written in: lower case, one space between words, and trailing
// sentence punctuation gone ("Continue.", "ok!") — but never "?", since "continue?" asks rather than consents.
const bareText = (text: string): string =>
    text
        .trim()
        .toLowerCase()
        .replace(/[.!…]+$/u, ``)
        .trim()
        .replace(/\s+/gu, ` `);

/* Messages whose ENTIRE content is "keep going". Such a message points at the previous prompt instead of
 * carrying intent of its own — so opening a turn on it would pin "Continue" to the top of the panel while the
 * question it defers to scrolls away. Matched against the whole message, deliberately: "continue, but skip
 * the tests" carries a new instruction and must pin like any prompt.
 *
 * THE APP'S OWN CONTINUATIONS ARE IN HERE, derived rather than spelled out a second time. They are the same
 * contentless nudge the typed ones are — longer only because they are precise about a refusal the model would
 * otherwise re-attempt — so a chat where the user pressed the button must fold exactly like one where they
 * typed the word, and rewording a sentence up there must never quietly turn it into a message that pins. */
const ACKNOWLEDGMENTS = new Set([
    ...Object.values(CONTINUATIONS).map(bareText),
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
    return ACKNOWLEDGMENTS.has(bareText(message.text));
};

/* WHICH CONTINUATION THIS CHAT'S NEXT PRESS SHOULD SEND. The refusal is read off the last PERMISSION card in
 * the transcript rather than the last card of any kind: a dismissed question or a rejected plan already carry
 * the user's own words about what to do instead, so there is nothing for a sentence here to add. */
export const continuationFor = (messages: readonly ChatMessage[]): string =>
    messages.findLast((message) => message.permission !== undefined)?.permission?.status === `denied`
        ? CONTINUATIONS.afterDenial
        : CONTINUATIONS.plain;

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

/* WHERE THE CONVERSATION CAN BE CUT — one boundary per turn, keyed by the turn it hangs off (ChatForkCut).
 *
 * A cut is a boundary, and a boundary can be named from either side: "redo this prompt differently" and "carry
 * on from that answer another way" are the same line. Which side it HANGS OFF is not a detail though — it is
 * where the user goes looking for it. The mark used to belong to the turn BELOW the line, level with the prompt
 * the cut ran above, which put every mark one turn away from the answer that prompted the thought and left the
 * first answer in a chat with no mark at all (there is nothing above it to keep). Nobody reads a transcript
 * thinking "before this prompt"; they finish an ANSWER and think "take it from here". So the cut past a turn
 * belongs to that turn: every answer in the chat has a mark of its own, beside the end of what it said.
 *
 * The value is the count of messages a fork there inherits, which is also the index of the message below the
 * line — the next turn's prompt, and therefore the checkpoint a rewind restores. Past the LAST turn there is no
 * message below and no state filed under it, so that cut is the whole conversation carried on elsewhere: the
 * one offer that promises nothing about old files. */
export const forkCutsOf = (turns: readonly ChatTurn[]): Map<number, number> => {
    const cuts = new Map<number, number>();
    let below = 0;
    for (const turn of turns) {
        below += turn.messages.length;
        cuts.set(turn.id, below);
    }
    return cuts;
};

/* WHICH DAY A TURN WAS SENT ON, for the turns where that day is not the one already on screen — keyed by turn
 * id, absent for every other turn. The transcript draws one marker row per entry (ChatPane), and that row is
 * the chat's date: it is what lets each prompt's own hover stamp shrink to the clock alone.
 *
 * The day comes off the turn's first STAMPED message, which is its opening prompt — the only row that carries a
 * time (see ChatMessage.sentAt). A turn with no stamp anywhere (a restored history's opening frames, rows
 * recorded before stamps existed) contributes no marker, and does not break the run either: the next dated turn
 * is compared against the last day actually marked.
 *
 * Days are compared as the FORMATTED string rather than by date arithmetic, in the viewer's own zone: two turns
 * are on the same day exactly when they would print the same marker, which is the only sense of "same day" this
 * is for. */
export const dayMarksOf = (turns: readonly ChatTurn[]): Map<number, string> => {
    const marks = new Map<number, string>();
    let marked: string | undefined;
    for (const turn of turns) {
        const sentAt = turn.messages.find((message) => message.sentAt !== undefined)?.sentAt;
        if (sentAt === undefined) {
            continue;
        }
        const day = formatDate(sentAt);
        if (day !== marked) {
            marks.set(turn.id, day);
            marked = day;
        }
    }
    return marks;
};
