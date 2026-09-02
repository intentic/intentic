import {
    type AgentEvent,
    type AgentReply,
    type AgentTurn,
    capabilitiesOf,
    holdsCard,
    RESTORED_CARD_FIELDS,
    type RestoredCards,
    type RestoredMessage,
    type RestoredToolCall,
    resumeDisclosure,
    type TodoItem,
    withoutResumeNote,
} from "@intentic/sandbox-contract";
import { stripAttachmentNote } from "../agent/attachment-note.js";
import { parseRuntimeHistory } from "../agent/runtime-history.js";
import { takeSteerAnchors } from "../agent/steer-anchors.js";
import type { Services } from "../composition.js";
import type { TranscriptAgent } from "./agent-transcript.js";

/* ONE SETTLED TURN, in the flat shape a reopened chat redraws, built from the frames the daemon itself
 * streamed rather than re-read out of whatever store the provider happened to keep.
 *
 * That distinction is the point. Rebuilding a transcript from a provider's own session store means every
 * provider needs a reader, every reader needs the right key into that store, and a conversation goes blank the
 * day either is missing, which is how codex/grok NATIVE and ACP agents came to open empty while their work sat
 * on disk. The frame vocabulary here is the daemon's own (AgentEventSchema), so a provider with no session
 * store, and the next provider nobody has written a reader for, records exactly like Claude does.
 *
 * The bubble boundaries are the LIVE ones: `text_end` retires the current bubble (see AgentEventSchema), so the
 * tool calls a prose block introduced open a fresh bubble underneath it. A reopened tab therefore shows what was
 * on screen, not a second arrangement of it.
 *
 * Frames tagged `parentToolUseId` are a subagent's inner stream, and they NEST, under the Agent card that
 * spawned them, exactly where the live client puts them (ChatTool.children). They used to be dropped for having
 * nowhere flat to go, which meant a reopened chat lost every delegation it was showing: the card came back a
 * leaf, with the whole child collapsed into its result text. */
export const restoredTurn = (
    turn: { readonly prompt: string; readonly attachments?: readonly string[] | undefined },
    events: readonly AgentEvent[],
    root: string,
    // When the turn started, the moment its user row is stamped with (RestoredMessage.sentAt). Handed in
    // rather than read off a clock here: this runs as the turn SETTLES, which on a long answer is many minutes
    // after the message it is writing down was sent.
    sentAt: number,
): RestoredMessage[] => {
    const out: RestoredMessage[] = [];
    /* `turn.prompt` is the user's words with at most two daemon layers on them, the note saying what
     * interrupted a turn it re-ran (outermost, events.ts) and the trailing attachment note, and both come back
     * off here: they are not what the user typed and must not redraw as their words. The turn PREAMBLE is not
     * among them any more: notes ride the request typed and reach this record through the `preamble` frame
     * below, never through the prompt, so there is nothing of theirs to parse out. `turn.attachments` is the
     * authoritative list when the client sent one, the note is only the Claude path's way of carrying it, and
     * the other adapters word it differently. */
    const resume = resumeDisclosure(turn.prompt);
    const stripped = stripAttachmentNote(resume === undefined ? turn.prompt : withoutResumeNote(turn.prompt));
    const attachments = (turn.attachments ?? stripped.attachments).map((path) => (path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path));
    /* WHAT THE TURN WAS TOLD, off its own frame log: the `preamble` frame carries the same typed notes the
     * live tab drew, so the reopened tab shows the identical collapsed row, not a message whose agent appears
     * to have acted on nothing. Read from the frames rather than parsed out of any prompt, this fold used to
     * parse `turn.prompt`, which the notes were never in, so every daemon-recorded turn silently lost them.
     *
     * Carried ON the user's row, never as a row of its own: the record's positions are what a rewind addresses
     * and a branch copies a prefix of, so a turn that happened to be told something must not record one row more
     * than a turn that wasn't. */
    const injected = events.filter((event) => event.kind === "preamble").flatMap((event) => event.notes);
    const notes = [...injected, ...(resume?.kind === "note" ? [resume.note] : [])];
    /* A handoff turn's prompt opens with the transcript the daemon folded into it (runtime-history.ts). Unwrap
     * that and keep only what the user actually typed: the rows inside the envelope are this conversation's OWN
     * earlier messages, which this record already holds. Re-emitting them appended a second, and, being
     * budget-capped, truncated, copy of the conversation every time a provider or account was switched. */
    const text = parseRuntimeHistory(stripped.text)?.prompt ?? stripped.text;
    if (resume?.kind === "notice") {
        // A re-run of words this record already holds: the interruption goes down INSTEAD of them, one row for
        // one row, so the reader sees why the answer below carries on rather than the same message twice.
        out.push({ role: "notice", text: resume.text });
    } else if (text.length > 0 || attachments.length > 0) {
        out.push({ role: "user", text, sentAt, ...(attachments.length > 0 ? { attachments } : {}), ...(notes.length > 0 ? { notes } : {}) });
    }

    out.push(...foldFrames(events, undefined));
    return out;
};

/* ONE SUBAGENT'S SIDE OF A TURN, out of the same frame log, what the Subagents area renders for a child that is
 * still running. Its frames are already in the parent run's log, tagged with the tool call that spawned it, so
 * there is nothing to stream separately and nothing to store twice: the child's transcript is a projection of its
 * parent's.
 *
 * `prompt` is what it was asked to do (the registry's description), pushed as the opening user bubble so the
 * transcript reads like a conversation rather than starting mid-answer. */
export const subagentTurn = (events: readonly AgentEvent[], id: string, prompt: string | undefined): RestoredMessage[] => [
    ...(prompt !== undefined && prompt.length > 0 ? [{ role: "user" as const, text: prompt }] : []),
    ...foldFrames(events, id),
];

// A tool_call frame as the card it restores to. Shared by both levels of the fold below, a child's card is
// built by the same rules as its parent's, which is what makes a nested one indistinguishable from a top-level one.
const cardOf = (event: Extract<AgentEvent, { kind: "tool_call" }>): RestoredToolCall => ({
    id: event.id,
    name: event.name,
    category: event.category,
    status: event.status,
    ...(event.target !== undefined ? { target: event.target } : {}),
    ...(event.locations !== undefined ? { locations: event.locations } : {}),
    ...(event.content !== undefined ? { content: event.content } : {}),
});

/* THE FOLD ITSELF, over whichever stream of the log the caller is reading.
 *
 * `tag` names that stream: undefined is the main turn, a tool_use id is the subagent spawned by it. Frames
 * carrying THAT tag are the stream's own and land at top level; frames carrying a DIFFERENT one belong to a child
 * of this stream, and nest under the card that spawned them. Which is one rule for both callers, and it is what
 * makes depth fall out for free, a subagent that itself delegates nests one level further down, on the same
 * pass, whichever level you asked to read. */
interface Bubble {
    text: string;
    thinking: string;
    tools: RestoredToolCall[];
    // The card this bubble parked on, at most one: a card closes the bubble it lands in (see `park`).
    card: RestoredCards;
    todos?: TodoItem[] | undefined;
}

// The one card a recorded row holds, whichever kind it is: what a `resolved` frame settles.
const cardOn = (row: RestoredMessage): { reply?: AgentReply | undefined } | undefined =>
    RESTORED_CARD_FIELDS.map((field) => row[field]).find((card) => card !== undefined);

const foldFrames = (events: readonly AgentEvent[], tag: string | undefined): RestoredMessage[] => {
    const out: RestoredMessage[] = [];
    // tool_call id → the card a later tool_call_update settles. The card is already in `out` (or in the open
    // bubble) and is mutated in place, so a result that lands turns after its call needs no second pass. Nested
    // cards go in too: an update names only its id, so a child's result has to be reachable the same way.
    const cards = new Map<string, RestoredToolCall>();
    /* requestId → the ROW holding the interactive card it names, for the frames that land on a card after it
     * was raised: the reply that released it (`resolved`), a permission's late sentence, an offer's stream and
     * receipt. The row is already in `out` and its card is mutated in place, the same move the tool cards make.
     *
     * These used to be dropped, all of them, and with them the one part of a conversation the user had actually
     * DONE something in: a reopened chat showed the prose before a question and the prose after the answer, and
     * nothing of the question, the options, or the picks. The card's whole life is in the frame log this fold
     * reads, so recording it costs nothing but the fields. */
    const parked = new Map<string, RestoredMessage>();
    let bubble: Bubble | undefined;
    const open = (): Bubble => (bubble ??= { text: "", thinking: "", tools: [], card: {} });
    // Mirrors the client's own row guard (recordedRows): text, thinking, tools, todos or a card makes a row, and nothing
    // makes none. Returns the row it wrote, so a card can be found again by the frames that settle it.
    const flush = (): RestoredMessage | undefined => {
        const current = bubble;
        bubble = undefined;
        if (
            current === undefined ||
            (current.text.length === 0 && current.thinking.length === 0 && current.tools.length === 0 && !holdsCard(current.card) && (current.todos === undefined || current.todos.length === 0))
        ) {
            return undefined;
        }
        const row: RestoredMessage = {
            role: "assistant",
            text: current.text,
            ...(current.thinking.length > 0 ? { thinking: current.thinking } : {}),
            ...(current.tools.length > 0 ? { tools: current.tools } : {}),
            ...(current.todos !== undefined && current.todos.length > 0 ? { todos: current.todos } : {}),
            ...current.card,
        };
        out.push(row);
        return row;
    };
    /* A card takes the bubble that is open and closes it, the live client's own move (turnReducer: withBubble,
     * then bubbleId null): the prose that led up to the ask stays above the card, and whatever the agent says
     * once answered opens a fresh row beneath it. A bubble holding nothing but the card is still a row, as it is
     * live, where the card IS the bubble. */
    const park = (requestId: string, card: RestoredCards): void => {
        open().card = card;
        const row = flush();
        if (row !== undefined) {
            parked.set(requestId, row);
        }
    };
    // text_end retires a bubble that WROTE something, and only that, the client's own guard (turnReducer's
    // `hasProse`). A block that produced no prose has no boundary to draw: retiring on it would split a card
    // away from the prose that reported it, which is a shape the user never saw.
    const retire = (): void => {
        if (bubble !== undefined && bubble.text.length > 0) {
            flush();
        }
    };

    for (const event of events) {
        const parent = "parentToolUseId" in event ? event.parentToolUseId : undefined;
        if (parent !== tag) {
            /* A CHILD OF THIS STREAM. Its calls and its thinking hang off the card that spawned it; its PROSE
             * does not, because a card has no place for prose and the child's report already arrives as that
             * card's result content, which is the same division the live client makes (turnReducer drops a
             * subagent delta for exactly this reason). Read at the child's own level (subagentTurn) that prose
             * is top-level and lands in full.
             *
             * A card we have never seen means its spawning call is not in the stream being read, so there is
             * nothing to hang it off; dropping it is what keeps a nested level out of the level above it. */
            const card = parent === undefined ? undefined : cards.get(parent);
            if (card === undefined) {
                continue;
            }
            if (event.kind === "thinking") {
                card.thinking = `${card.thinking ?? ""}${event.text}`;
            } else if (event.kind === "tool_call") {
                const child = cardOf(event);
                card.children = [...(card.children ?? []), child];
                cards.set(event.id, child);
            }
            continue;
        }
        if (event.kind === "delta") {
            open().text += event.text;
        } else if (event.kind === "steer") {
            /* THE USER SPOKE MID-TURN, and it goes down as a row of its own, a turn can hold several of these,
             * so the record is not "one user row then the answer" and never really was. Before this frame
             * existed a steered message was written down nowhere at all: it lived only in the window that sent
             * it, so reopening the chat lost it, and the client's row count ran one ahead of the daemon's for
             * the rest of the conversation, which is the count a fork copies a prefix of and a rewind
             * addresses. Closes the open bubble first, exactly as the live client retires its own: what the
             * agent says next is its answer to these words and belongs below them. */
            flush();
            out.push({
                role: "user",
                text: event.text,
                sentAt: event.sentAt,
                ...(event.attachments !== undefined ? { attachments: [...event.attachments] } : {}),
            });
        } else if (event.kind === "error") {
            /* WHAT HAPPENED TO THE TURN, kept, and the frame whose absence made a refused session look broken
             * rather than refused. A provider that answers "your organization has disabled Claude subscription
             * access for Claude Code" sends this and no prose, so a fold of the two speakers alone recorded the
             * user's message and nothing else: reopening the step showed a question with no reply, on every
             * surface, with the reason only ever visible to whoever happened to be watching it live. It closes
             * the open bubble first, because it is what ended that block. */
            flush();
            out.push({ role: "notice", text: event.message });
        } else if (event.kind === "tier" && event.routed && event.model !== undefined) {
            /* THIS TURN RAN ON A CHEAPER MODEL THAN THE ONE ASKED FOR, written down for the same reason the
             * refusal above is: it is something that happened TO the turn, the answer below it is the cheap
             * rung's answer, and a reader coming back tomorrow has no other way to know which of their messages
             * were served that way. The live chat draws the identical line as the turn happens; recording it is
             * what stops that line being a thing only the window that watched it ever saw.
             *
             * Only a turn that really moved. A fast verdict that changed nothing (measure mode, a held chat, a
             * provider with nothing cheaper) is machinery, not an event, and a row per judged turn would bury
             * the conversation under its own instrumentation.
             *
             * The model is named by ID here where the live line uses the picker's display label, because a
             * display label is the browser's catalog and this side has only the id. Same fact, one of them
             * spelled the way the provider spells it.
             *
             * `noticeAction` carries the offer, so the restored line keeps the one press the live line had:
             * this is the one recorded notice with something to press, which is why the field exists at all. */
            flush();
            out.push({
                role: "notice",
                text: `This turn looked simple, so it ran on ${event.model} instead of your pick.`,
                noticeAction: "tierHold",
            });
        } else if (event.kind === "text_end") {
            retire();
        } else if (event.kind === "thinking") {
            open().thinking += event.text;
        } else if (event.kind === "todos") {
            open().todos = [...event.items];
        } else if (event.kind === "tool_call") {
            const card = cardOf(event);
            open().tools.push(card);
            cards.set(event.id, card);
        } else if (event.kind === "tool_call_update") {
            const card = cards.get(event.id);
            if (card === undefined) {
                continue;
            }
            // Replace, never append, the update frame's documented snapshot semantics. A card left
            // `in_progress` is a turn that died mid-call, which is the honest thing to redraw.
            if (event.status !== undefined) {
                card.status = event.status;
            }
            if (event.content !== undefined) {
                card.content = event.content;
            }
            if (event.locations !== undefined) {
                card.locations = event.locations;
            }
        } else if (event.kind === "plan") {
            park(event.requestId, {
                plan: { requestId: event.requestId, text: event.text, ...(event.document === undefined ? {} : { document: event.document }) },
            });
        } else if (event.kind === "question") {
            park(event.requestId, {
                question: {
                    requestId: event.requestId,
                    questions: event.questions,
                    ...(event.document === undefined ? {} : { document: event.document }),
                },
            });
        } else if (event.kind === "permission") {
            const { kind: _kind, ...ask } = event;
            park(event.requestId, { permission: ask });
        } else if (event.kind === "browser_help") {
            const { kind: _kind, ...ask } = event;
            park(event.requestId, { browserHelp: ask });
        } else if (event.kind === "terminal_help") {
            const { kind: _kind, ...ask } = event;
            park(event.requestId, { terminalHelp: ask });
        } else if (event.kind === "service_offer") {
            park(event.requestId, { serviceOffer: { requestId: event.requestId, offer: event.offer } });
        } else if (event.kind === "capability_offer") {
            park(event.requestId, { capabilityOffer: { requestId: event.requestId, offer: event.offer } });
        } else if (event.kind === "payment_offer") {
            park(event.requestId, { paymentOffer: { requestId: event.requestId, offer: event.offer } });
        } else if (event.kind === "resolved") {
            /* The reply rides verbatim, the frame's own rule: absent, nobody answered (a Stop, a turn that died
             * under the card), which is not a decision, and the card reads back unanswered rather than as one. */
            const row = parked.get(event.requestId);
            const card = row === undefined ? undefined : cardOn(row);
            if (card !== undefined && event.reply !== undefined) {
                card.reply = event.reply;
            }
        } else if (event.kind === "permission_note") {
            const permission = parked.get(event.requestId)?.permission;
            if (permission !== undefined) {
                permission.explain = event.explain;
            }
        } else if (event.kind === "service_event") {
            const offer = parked.get(event.requestId)?.serviceOffer;
            if (offer !== undefined) {
                offer.events = [...(offer.events ?? []), event.event];
            }
        } else if (event.kind === "service_receipt") {
            const offer = parked.get(event.requestId)?.serviceOffer;
            if (offer !== undefined) {
                offer.receipt = {
                    outcome: event.outcome,
                    credits: event.credits,
                    ...(event.remaining === undefined ? {} : { remaining: event.remaining }),
                };
            }
        } else if (event.kind === "capability_outcome") {
            const offer = parked.get(event.requestId)?.capabilityOffer;
            if (offer !== undefined) {
                offer.outcome = { outcome: event.outcome, ...(event.id === undefined ? {} : { id: event.id }) };
            }
        } else if (event.kind === "payment_receipt") {
            const offer = parked.get(event.requestId)?.paymentOffer;
            if (offer !== undefined) {
                offer.receipt = {
                    outcome: event.outcome,
                    amountUsd: event.amountUsd,
                    ...(event.transaction === undefined ? {} : { transaction: event.transaction }),
                    ...(event.network === undefined ? {} : { network: event.network }),
                };
            }
        }
    }
    flush();
    return out;
};

/* WHICH conversation a turn records against, one derivation, because the record's two halves (open, append)
 * must agree on it or a turn adopts into one file and settles into another. The provider/harness defaults are
 * the ones streamAgent resolves the turn under (absent ⇒ claude/native), so the record is keyed by what the
 * turn actually ran as. */
const transcriptAgentOf = (turn: AgentTurn & { readonly conversationId: string }): TranscriptAgent => ({
    id: turn.conversationId,
    provider: turn.agent ?? "claude",
    harness: turn.harness ?? "native",
});

/* OPEN the conversation's record before its turn reaches the provider, the boundary transcript-record.ts
 * argues for: adopting at settlement would re-read the provider store AFTER it recorded this very turn, and
 * duplicate it. Every road that starts a conversation turn opens here first (the /agent pump awaits this, an
 * automation wake and a gate fix call it ahead of their own loops), so no path can append into a record that
 * was never adopted.
 *
 * Never rejects, like the append below: a disk failure in a side channel must not manufacture an agent failure. */
export const openTurnTranscript = async (
    services: Pick<Services, "transcripts" | "logger">,
    turn: AgentTurn & { readonly conversationId: string },
): Promise<void> => {
    const agent = transcriptAgentOf(turn);
    /* A FORK opens differently, and only ever once: its opening history is a prefix of the conversation it was
     * cut from, which no provider store and no adoption could supply, the fork is a new conversation nothing
     * else knows about yet. From the copy onward it is an ordinary conversation: it seeds a switched session
     * from its own record like any other, and it reads back with the turns it inherited rather than beginning
     * abruptly at the cut. */
    const fork = turn.forkOf;
    const opening = fork !== undefined ? services.transcripts.fork(agent, fork.conversationId, fork.keep) : services.transcripts.open(agent);
    await opening.catch((error: unknown) => services.logger.warn({ err: error, conversationId: turn.conversationId }, "transcript open failed"));
};

/* WHERE THIS TURN SITS IN ITS CONVERSATION, the index its checkpoint is filed under, and the number of
 * messages a rewind to it keeps.
 *
 * Read at turn START, in the window every path guarantees: the record has been opened and adopted (the callers
 * above all await that first), and this turn's own messages are not appended until it settles. Measured at the
 * END instead it would be a race, the settle hook's append and the end-of-turn snapshot are not ordered
 * against each other, so the index would sometimes already count the very turn it is naming.
 *
 * Never rejects. 0 on failure files the checkpoint at the head of the conversation: a rewind that goes further
 * back than it should is still recoverable (restore takes its own pre-restore checkpoint first), whereas an
 * index pointing past the end of the transcript addresses a message that never existed. */
export const turnStartIndex = async (
    services: Pick<Services, "transcripts" | "logger">,
    turn: AgentTurn & { readonly conversationId: string },
): Promise<number> =>
    services.transcripts.count(transcriptAgentOf(turn)).catch((error: unknown) => {
        services.logger.warn({ err: error, conversationId: turn.conversationId }, "transcript count failed");
        return 0;
    });

/* THE TRANSCRIPT A FRESH SESSION IS SEEDED WITH, this conversation's own record, read at turn start for a turn
 * that resumes nothing.
 *
 * A provider, account or harness switch retires the session (a session id only resumes on the runtime and
 * credential that minted it), so its replacement starts blank and has to be told what came before. That used to
 * be the CLIENT's job, it shipped a text mirror of its own bubbles up with the turn, which meant the daemon
 * ignored the fuller account it keeps itself, and a conversation opened in a second window seeded from whatever
 * that window had happened to paint. This is the same record every other reader of the conversation already
 * uses, so a handoff carries tool calls and attachments the text mirror never had.
 *
 * Empty is the ordinary answer twice over: the first turn of a conversation has nothing recorded yet, and a turn
 * that RESUMES is never asked (its session carries its own context). Both mean "send the prompt alone".
 *
 * Never rejects. A transcript the daemon cannot read costs this turn its continuity, which is bad; failing the
 * turn outright over a side-channel read is worse. */
export const handoffHistory = async (
    services: Pick<Services, "transcripts" | "logger">,
    turn: AgentTurn & { readonly conversationId: string },
): Promise<readonly RestoredMessage[]> =>
    services.transcripts.read(transcriptAgentOf(turn)).catch((error: unknown) => {
        services.logger.warn({ err: error, conversationId: turn.conversationId }, "transcript read for handoff failed");
        return [];
    });

/* WRITE one settled turn to that record, the single spelling of that, because every road a turn can be started
 * down ends here: the /agent pump (turn-runs' settle hook), an automation wake, a landing-gate fix. Each used to
 * repeat the same two normalizations, and one of them had drifted to hardcoded literals. The paths are relative
 * to the workspace root the turn actually saw.
 *
 * Never rejects. A transcript is a side-channel of a turn that has already finished, the cost of a failed
 * write is one turn missing from a history, which must not become the cost of the turn itself. The boolean lets
 * the restart recovery path keep an interrupted journal entry until this write really landed; ordinary settled
 * turns use the awaited call only as an ordering boundary. */
export const recordTurnTranscript = async (
    services: Pick<Services, "transcripts" | "turnAnchors" | "workspace" | "logger">,
    turn: AgentTurn & { readonly conversationId: string },
    events: readonly AgentEvent[],
    // When the turn started, for the user row's stamp, every caller runs a turn and therefore knows it.
    sentAt: number,
): Promise<boolean> => {
    const agent = transcriptAgentOf(turn);
    /* Read BEFORE the append, which is what makes it this turn's start index: the same number turnStartIndex
     * takes at the top of the turn, in the same window (the record is open, this turn's rows are not in it yet).
     * Taken here rather than passed down from there because only this side knows how many rows the fold actually
     * wrote, and the two have to be added together to place a message steered into the turn.
     *
     * And OUTSIDE the guard below, which is the point: this is bookkeeping for a bookmark, and the write it sits
     * beside is the conversation itself. Inside, a store that cannot answer this — a count that fails, a caller
     * whose record does not implement one — took the turn's whole transcript down with it. */
    const base = await recordedCount(services, agent);
    try {
        const rows = restoredTurn(turn, events, services.workspace.root, sentAt);
        await services.transcripts.append(agent, rows);
        await recordSteerAnchors(services, turn.conversationId, rows, events, base);
        return true;
    } catch (error) {
        services.logger.warn({ err: error, conversationId: turn.conversationId }, "transcript append failed");
        return false;
    }
};

/* HOW MANY ROWS THIS CONVERSATION'S RECORD ALREADY HOLDS, or nothing, said in a way that cannot fail upward.
 *
 * try/catch rather than a rejection handler, because the two failures are shaped differently and only one of
 * them is a rejected promise: a store missing this member at all throws where it is CALLED, which no `.catch`
 * on the result can see. Undefined is a complete answer — the caller then files no bookmark for this turn's
 * steers, rather than filing one at a position it guessed. */
const recordedCount = async (services: Pick<Services, "transcripts">, agent: TranscriptAgent): Promise<number | undefined> => {
    try {
        return await services.transcripts.count(agent);
    } catch {
        return undefined;
    }
};

/* WHICH ROWS OF A SETTLED TURN ARE MESSAGES THE USER STEERED INTO IT, by position.
 *
 * The fold writes a user row in exactly two circumstances (restoredTurn, above): the turn's own opening prompt,
 * at most one and always first, and one per `steer` frame, in the order the turn took them. So the user rows
 * are the opener followed by the steers, and the only question is whether the opener is among them — a turn
 * whose prompt was empty, or one whose prompt was replaced by a re-run notice, writes no opening user row at
 * all, and then the very first user row is already a steered one.
 *
 * Answered by COUNTING rather than by re-deriving that condition: the steer frames say how many steered rows
 * there must be, so the last N user rows are them, whichever way the opener went. Two facts that must agree
 * become one fact that cannot disagree, which matters more here than usual — a position off by one files a
 * message's state under its neighbour, and a rewind then restores a point the reader never saw. */
export const steerRowsOf = (rows: readonly RestoredMessage[], events: readonly AgentEvent[]): number[] => {
    const steers = events.filter((event) => event.kind === "steer").length;
    const userRows = rows.flatMap((row, index) => (row.role === "user" ? [index] : []));
    return steers === 0 ? [] : userRows.slice(-steers);
};

/* FILE THE STATES PINNED MID-TURN UNDER THE ROWS THEY TURNED OUT TO BE (agent/steer-anchors.ts).
 *
 * This is the second half of a steer's bookmark, and the half that could only ever happen here: the state was
 * captured when the message arrived, because that is the only moment it exists, and its index is knowable only
 * now, because until the fold ran nobody knew how many rows the turn wrote before it.
 *
 * The queue drains whatever happens, including when this cannot use it — a turn whose count could not be read,
 * a record that took fewer rows than the queue holds — because a box left behind would be picked up by the NEXT
 * turn and filed under one of ITS rows, which is the mis-indexing this whole path is careful about.
 *
 * Never throws: a bookmark is a side-channel of a turn that has already finished. */
const recordSteerAnchors = async (
    services: Pick<Services, "turnAnchors" | "logger">,
    conversationId: string,
    rows: readonly RestoredMessage[],
    events: readonly AgentEvent[],
    base: number | undefined,
): Promise<void> => {
    const anchors = takeSteerAnchors(conversationId);
    const positions = steerRowsOf(rows, events);
    if (base === undefined) {
        return;
    }
    await Promise.all(
        positions.map(async (position, at) => {
            const anchor = anchors[at];
            if (anchor === undefined) {
                return;
            }
            await services.turnAnchors
                .record(conversationId, base + position, anchor)
                .catch((error: unknown) => services.logger.warn({ err: error, conversationId }, "anchors: filing a steered message failed"));
        }),
    );
};

// The line a turn the daemon died under leaves under whatever it managed to write: what stopped it, and the one
// move that carries the conversation on from here. Lives beside the recording rather than at the boot pass that
// asks for it, so the sentence and the rows it closes are written in one place.
export const RESTART_INTERRUPTED = "The sandbox restarted before this turn finished. Send another message to continue from the saved worktree.";

/* WHAT THE INTERRUPTED TURN ACTUALLY WROTE, recovered from the provider's own session store.
 *
 * The one provider-shaped read on this file, and, like storedTranscript's, a RECOVERY rather than a road any
 * ordinary turn goes down: a turn's frames live in the daemon's memory and die with it, so for a turn nothing
 * ever settled the provider's store is the only place its work exists. `undefined` for a runtime that keeps no
 * readable store (codex/grok NATIVE, every ACP agent) and for a turn that never reported a session, which is
 * not a failure, the caller writes the prompt alone, exactly as it did before this existed.
 *
 * The opening row is stamped with when the TURN started. The store knows when the provider received the prompt
 * and the daemon knows when the user sent it, and the second is what every other user row in this record
 * carries, so a recovered turn must not be the one message in a conversation whose clock comes from somewhere
 * else. */
const interruptedTurnRows = async (
    services: Pick<Services, "sessions" | "workspace" | "logger">,
    turn: AgentTurn & { readonly conversationId: string },
    sessionId: string | undefined,
    sentAt: number,
): Promise<readonly RestoredMessage[]> => {
    const agent = transcriptAgentOf(turn);
    if (sessionId === undefined || capabilitiesOf(agent.provider, agent.harness).runtime !== "claude-code") {
        return [];
    }
    const rows = await services.sessions.readTail(services.workspace.root, sessionId).catch((error: unknown) => {
        services.logger.warn({ err: error, conversationId: turn.conversationId, sessionId }, "interrupted turn: session tail unreadable");
        return [] as RestoredMessage[];
    });
    const [opening, ...rest] = rows;
    return opening === undefined ? [] : [opening.role === "user" ? { ...opening, sentAt } : opening, ...rest];
};

/* WRITE DOWN A TURN THE DAEMON DIED UNDER, at the boot that finds its journal entry still standing
 * (turn-resume.ts). The one write that is not a settled turn, and the last chance this turn is ever recorded:
 * the journal entry naming it is consumed in the same pass.
 *
 * It used to record the PROMPT and the interruption, nothing else, on the reasoning that a turn with no settled
 * transcript at least should not lose the user's words. That left the far bigger half on the floor. An
 * interrupted turn is usually a LONG one, an hour of tool calls is exactly the shape of thing a container
 * rebuild or an OOM lands in the middle of, and every line of it was already on disk in the provider's session
 * file. What the chat opened onto was the user's own message with a notice under it, over work that had really
 * happened, which reads as "nothing came of this" about a turn that got most of the way.
 *
 * The prompt-alone shape is still the FALLBACK, for the cases where there is genuinely nothing to recover: a
 * runtime with no readable store, a turn killed before it reported a session, a store that has since lost the
 * file. Nothing about those is an error; they are the conversations this used to be the whole answer for.
 *
 * Never throws. The boolean is the caller's, and it is load-bearing rather than informational: a failed write
 * means the journal entry is KEPT for the next boot instead of a transient disk error turning into permanent
 * loss (see turn-resume.ts). */
export const recordInterruptedTurn = async (
    services: Pick<Services, "transcripts" | "sessions" | "workspace" | "logger">,
    turn: AgentTurn & { readonly conversationId: string },
    // The session the dead turn last reported, off its journal entry, which is where that id survives a daemon
    // that never got to write it onto the registry entry.
    sessionId: string | undefined,
    sentAt: number,
): Promise<boolean> => {
    const recovered = await interruptedTurnRows(services, turn, sessionId, sentAt);
    // restoredTurn with no frames is the prompt row and nothing else, which is precisely the fallback.
    const written = recovered.length > 0 ? recovered : restoredTurn(turn, [], services.workspace.root, sentAt);
    try {
        await services.transcripts.append(transcriptAgentOf(turn), [...written, { role: "notice", text: RESTART_INTERRUPTED }]);
        return true;
    } catch (error) {
        services.logger.warn({ err: error, conversationId: turn.conversationId }, "interrupted turn: transcript append failed");
        return false;
    }
};
