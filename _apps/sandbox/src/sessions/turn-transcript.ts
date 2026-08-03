import type { AgentEvent, AgentTurn, RestoredMessage, RestoredToolCall } from "@intentic/sandbox-contract";
import { stripAttachmentNote } from "../agent/attachment-note.js";
import { parseRuntimeHistory } from "../agent/runtime-history.js";
import { stripTurnPreamble } from "../agent/turn-preamble.js";
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
): RestoredMessage[] => {
    const out: RestoredMessage[] = [];
    // The same unwrapping readWorkspaceSession does, for the same reason: the daemon's own injections (an
    // opening turn preamble, the trailing attachment note) are not what the user typed and must not redraw as
    // their words. `turn.attachments` is the authoritative list when the client sent one — the note is only the
    // Claude path's way of carrying it, and the other adapters word it differently.
    const stripped = stripAttachmentNote(stripTurnPreamble(turn.prompt));
    const attachments = (turn.attachments ?? stripped.attachments).map((path) => (path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path));
    const runtime = parseRuntimeHistory(stripped.text);
    if (runtime !== undefined) {
        out.push(...runtime.history);
        if (runtime.prompt.length > 0 || attachments.length > 0) {
            out.push({ role: "user", text: runtime.prompt, ...(attachments.length > 0 ? { attachments } : {}) });
        }
    } else if (stripped.text.length > 0 || attachments.length > 0) {
        out.push({ role: "user", text: stripped.text, ...(attachments.length > 0 ? { attachments } : {}) });
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
    await services.transcripts
        .open(transcriptAgentOf(turn))
        .catch((error: unknown) => services.logger.warn({ err: error, conversationId: turn.conversationId }, "transcript open failed"));
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
): Promise<void> => {
    await services.transcripts
        .append(transcriptAgentOf(turn), restoredTurn(turn, events, services.workspace.root))
        .catch((error: unknown) => services.logger.warn({ err: error, conversationId: turn.conversationId }, "transcript append failed"));
};
