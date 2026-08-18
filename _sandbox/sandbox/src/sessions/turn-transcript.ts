import type { AgentEvent, AgentTurn, RestoredMessage, RestoredToolCall } from "@intentic/sandbox-contract";
import { stripAttachmentNote } from "../agent/attachment-note.js";
import { parseRuntimeHistory } from "../agent/runtime-history.js";
import { unwrapStoredPrompt } from "../agent/turn-preamble.js";
import type { Services } from "../composition.js";
import type { TranscriptAgent } from "./agent-transcript.js";

/* ONE SETTLED TURN, in the flat shape a reopened chat redraws — built from the frames the daemon itself
 * streamed rather than re-read out of whatever store the provider happened to keep.
 *
 * That distinction is the point. Rebuilding a transcript from a provider's own session store means every
 * provider needs a reader, every reader needs the right key into that store, and a conversation goes blank the
 * day either is missing — which is how codex/grok NATIVE and ACP agents came to open empty while their work sat
 * on disk. The frame vocabulary here is the daemon's own (AgentEventSchema), so a provider with no session
 * store, and the next provider nobody has written a reader for, records exactly like Claude does.
 *
 * The bubble boundaries are the LIVE ones: `text_end` retires the current bubble (see AgentEventSchema), so the
 * tool calls a prose block introduced open a fresh bubble underneath it. A reopened tab therefore shows what was
 * on screen, not a second arrangement of it.
 *
 * Frames tagged `parentToolUseId` are a subagent's inner stream, and they NEST — under the Agent card that
 * spawned them, exactly where the live client puts them (ChatTool.children). They used to be dropped for having
 * nowhere flat to go, which meant a reopened chat lost every delegation it was showing: the card came back a
 * leaf, with the whole child collapsed into its result text. */
export const restoredTurn = (
    turn: { readonly prompt: string; readonly attachments?: readonly string[] | undefined },
    events: readonly AgentEvent[],
    root: string,
    // When the turn started — the moment its user row is stamped with (RestoredMessage.sentAt). Handed in
    // rather than read off a clock here: this runs as the turn SETTLES, which on a long answer is many minutes
    // after the message it is writing down was sent.
    sentAt: number,
): RestoredMessage[] => {
    const out: RestoredMessage[] = [];
    // The same unwrapping readWorkspaceSession does, for the same reason: the daemon's own injections (a turn
    // preamble, the note saying what interrupted a turn it re-ran, the trailing attachment note) are not what
    // the user typed and must not redraw as their words. `turn.attachments` is the authoritative list when the
    // client sent one — the note is only the Claude path's way of carrying it, and the other adapters word it
    // differently.
    const unwrapped = unwrapStoredPrompt(turn.prompt);
    const stripped = stripAttachmentNote(unwrapped.text);
    const attachments = (turn.attachments ?? stripped.attachments).map((path) => (path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path));
    /* Taken OUT of the user's words and kept, rather than taken out and dropped. What a turn was told is part of
     * what happened to it, so a tab that reopens tomorrow shows the same collapsed row the tab that watched it
     * stream did — not a message whose agent appears to have acted on nothing.
     *
     * Carried ON the user's row, never as a row of its own: the record's positions are what a rewind addresses
     * and a branch copies a prefix of, so a turn that happened to be told something must not record one row more
     * than a turn that wasn't. */
    const resume = unwrapped.resume;
    const notes = [...unwrapped.notes, ...(resume?.kind === "note" ? [resume.note] : [])];
    /* A handoff turn's prompt opens with the transcript the daemon folded into it (runtime-history.ts). Unwrap
     * that and keep only what the user actually typed: the rows inside the envelope are this conversation's OWN
     * earlier messages, which this record already holds. Re-emitting them appended a second — and, being
     * budget-capped, truncated — copy of the conversation every time a provider or account was switched. */
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

/* ONE SUBAGENT'S SIDE OF A TURN, out of the same frame log — what the Subagents area renders for a child that is
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

// A tool_call frame as the card it restores to. Shared by both levels of the fold below — a child's card is
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
 * makes depth fall out for free — a subagent that itself delegates nests one level further down, on the same
 * pass, whichever level you asked to read. */
const foldFrames = (events: readonly AgentEvent[], tag: string | undefined): RestoredMessage[] => {
    const out: RestoredMessage[] = [];
    // tool_call id → the card a later tool_call_update settles. The card is already in `out` (or in the open
    // bubble) and is mutated in place, so a result that lands turns after its call needs no second pass. Nested
    // cards go in too: an update names only its id, so a child's result has to be reachable the same way.
    const cards = new Map<string, RestoredToolCall>();
    let bubble: { text: string; thinking: string; tools: RestoredToolCall[] } | undefined;
    const open = (): { text: string; thinking: string; tools: RestoredToolCall[] } => (bubble ??= { text: "", thinking: "", tools: [] });
    const flush = (): void => {
        const current = bubble;
        bubble = undefined;
        if (current === undefined || (current.text.length === 0 && current.thinking.length === 0 && current.tools.length === 0)) {
            return;
        }
        out.push({
            role: "assistant",
            text: current.text,
            ...(current.thinking.length > 0 ? { thinking: current.thinking } : {}),
            ...(current.tools.length > 0 ? { tools: current.tools } : {}),
        });
    };
    // text_end retires a bubble that WROTE something, and only that — the client's own guard (turnReducer's
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
             * card's result content — which is the same division the live client makes (turnReducer drops a
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
            /* THE USER SPOKE MID-TURN, and it goes down as a row of its own — a turn can hold several of these,
             * so the record is not "one user row then the answer" and never really was. Before this frame
             * existed a steered message was written down nowhere at all: it lived only in the window that sent
             * it, so reopening the chat lost it, and the client's row count ran one ahead of the daemon's for
             * the rest of the conversation — which is the count a fork copies a prefix of and a rewind
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
            /* WHAT HAPPENED TO THE TURN, kept — and the frame whose absence made a refused session look broken
             * rather than refused. A provider that answers "your organization has disabled Claude subscription
             * access for Claude Code" sends this and no prose, so a fold of the two speakers alone recorded the
             * user's message and nothing else: reopening the step showed a question with no reply, on every
             * surface, with the reason only ever visible to whoever happened to be watching it live. It closes
             * the open bubble first, because it is what ended that block. */
            flush();
            out.push({ role: "notice", text: event.message });
        } else if (event.kind === "text_end") {
            retire();
        } else if (event.kind === "thinking") {
            open().thinking += event.text;
        } else if (event.kind === "tool_call") {
            const card = cardOf(event);
            open().tools.push(card);
            cards.set(event.id, card);
        } else if (event.kind === "tool_call_update") {
            const card = cards.get(event.id);
            if (card === undefined) {
                continue;
            }
            // Replace, never append — the update frame's documented snapshot semantics. A card left
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
        }
    }
    flush();
    return out;
};

/* WHICH conversation a turn records against — one derivation, because the record's two halves (open, append)
 * must agree on it or a turn adopts into one file and settles into another. The provider/harness defaults are
 * the ones streamAgent resolves the turn under (absent ⇒ claude/native), so the record is keyed by what the
 * turn actually ran as. */
const transcriptAgentOf = (turn: AgentTurn & { readonly conversationId: string }): TranscriptAgent => ({
    id: turn.conversationId,
    provider: turn.agent ?? "claude",
    harness: turn.harness ?? "native",
});

/* OPEN the conversation's record before its turn reaches the provider — the boundary transcript-record.ts
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
     * cut from, which no provider store and no adoption could supply — the fork is a new conversation nothing
     * else knows about yet. From the copy onward it is an ordinary conversation: it seeds a switched session
     * from its own record like any other, and it reads back with the turns it inherited rather than beginning
     * abruptly at the cut. */
    const fork = turn.forkOf;
    const opening = fork !== undefined ? services.transcripts.fork(agent, fork.conversationId, fork.keep) : services.transcripts.open(agent);
    await opening.catch((error: unknown) => services.logger.warn({ err: error, conversationId: turn.conversationId }, "transcript open failed"));
};

/* WHERE THIS TURN SITS IN ITS CONVERSATION — the index its checkpoint is filed under, and the number of
 * messages a rewind to it keeps.
 *
 * Read at turn START, in the window every path guarantees: the record has been opened and adopted (the callers
 * above all await that first), and this turn's own messages are not appended until it settles. Measured at the
 * END instead it would be a race — the settle hook's append and the end-of-turn snapshot are not ordered
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

/* THE TRANSCRIPT A FRESH SESSION IS SEEDED WITH — this conversation's own record, read at turn start for a turn
 * that resumes nothing.
 *
 * A provider, account or harness switch retires the session (a session id only resumes on the runtime and
 * credential that minted it), so its replacement starts blank and has to be told what came before. That used to
 * be the CLIENT's job — it shipped a text mirror of its own bubbles up with the turn — which meant the daemon
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

/* WRITE one settled turn to that record — the single spelling of that, because every road a turn can be started
 * down ends here: the /agent pump (turn-runs' settle hook), an automation wake, a landing-gate fix. Each used to
 * repeat the same two normalizations, and one of them had drifted to hardcoded literals. The paths are relative
 * to the workspace root the turn actually saw.
 *
 * Never rejects. A transcript is a side-channel of a turn that has already finished — the cost of a failed
 * write is one turn missing from a history, which must not become the cost of the turn itself. */
export const recordTurnTranscript = async (
    services: Pick<Services, "transcripts" | "workspace" | "logger">,
    turn: AgentTurn & { readonly conversationId: string },
    events: readonly AgentEvent[],
    // When the turn started, for the user row's stamp — every caller runs a turn and therefore knows it.
    sentAt: number,
): Promise<void> => {
    await services.transcripts
        .append(transcriptAgentOf(turn), restoredTurn(turn, events, services.workspace.root, sentAt))
        .catch((error: unknown) => services.logger.warn({ err: error, conversationId: turn.conversationId }, "transcript append failed"));
};
