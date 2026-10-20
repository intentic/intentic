import { cancelledRequests, settledRequests } from "../policy/request-status.js";
import type { AgentEvent } from "../events/agent-events.js";
import { drawInline, type InlineEvent, supersedeEarlier } from "./transcript-inline.js";
import {
    REQUEST_FIELDS,
    holdsRequest,
    isAwaitingDecision,
    type TranscriptRequests,
    type TranscriptPatch,
    type TranscriptRow,
    type TranscriptSubagent,
    type TranscriptTool,
} from "../events/transcript.js";
import { contextTrimLine, contextTrimNotice } from "../schemas/context-trim.js";
import { keptWarmLine, keptWarmNotice } from "../schemas/keep-warm.js";
import { handedOffLine, handedOffNotice } from "../schemas/providers/handoff.js";
import { isLandConflict } from "../events/land-conflict.js";
import { turnedAwayCode } from "../policy/turned-away.js";
import { errorRow, RENEWAL_WITHDRAWN, RENEWING } from "../events/failure-rows.js";
import { mentionedPathTokens } from "./mentions.js";
import { unspokenPromptRow } from "../events/agent-words.js";
import { needRowText } from "../events/need-wake.js";
import { noticeCode, sandboxNoticeOf } from "../events/sandbox-notice.js";
import { installRow, landedRow, syncLine } from "./land-rows.js";

// Folds a turn's frames into rows once, live and for the settled record alike, so a reopened chat matches what was on
// screen. The main turn's frames are its rows; a frame a subagent produced (tagged with the call that spawned it) nests
// under that call's card. Rows mutate in place; every patch carries a copy of what it names.
//
// Every subagent lands on the card of the call that started it, whichever mechanism started it. An in-process one (the
// runtime's own Agent/Task tool) is named by that call's id, so its card is found at once. A spawned one is named by its
// own conversation id, and every door that spawns one answers with that id (the spawn tool's `child`, the `agents
// spawn` CLI's first line), so its frames wait until a card's result names it, then ride that card from there on.

export type TurnEnding = "settled" | "stopped";

// A compaction's row, live and restored from the provider's store alike.
export const COMPACTED_NOTICE = "Context compacted to free up space.";
export const compactedRow = (): TranscriptRow => ({ role: "notice", text: COMPACTED_NOTICE, noticeCode: noticeCode({ code: "compacted" }) });

// Where a tool card lives: its row, and the parent card it nests under when it's a helper's own call.
interface CardPlace {
    readonly tool: TranscriptTool;
    readonly row: number;
    readonly parent?: string;
}

// Strips undefined fields, so spreading a partial frame never overwrites a field an earlier frame already set.
const defined = <T extends object>(value: T): Partial<T> =>
    Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as Partial<T>;

// A card's own fields: what a `tool` patch carries, so a delegation's growing subtree never rides one.
const ownFields = ({ children: _children, thinking: _thinking, ...own }: TranscriptTool): TranscriptTool => own;

// Everything a card's result said, as one string: what a subagent waiting for its card is looked for in.
const resultWords = (tool: TranscriptTool): string =>
    (tool.content ?? [])
        .filter((entry) => entry.type === "text")
        .map((entry) => entry.text)
        .join("\n");

// Whether a call's status is final: the moment it turns so is when its result arrived.
const ended = (status: TranscriptTool["status"]): boolean => status === "completed" || status === "failed";

// `at` is the fold's clock reading as the call is seen, absent for a fold without one; a call that arrives already
// finished started and ended in that same moment, as far as anyone here can tell.
const cardOf = (event: Extract<AgentEvent, { kind: "tool_call" }>, at: number | undefined): TranscriptTool => ({
    id: event.id,
    name: event.name,
    category: event.category,
    status: event.status,
    ...(event.target !== undefined ? { target: event.target } : {}),
    ...(event.locations !== undefined ? { locations: event.locations } : {}),
    ...(event.content !== undefined ? { content: event.content } : {}),
    ...(event.input !== undefined ? { input: event.input } : {}),
    ...(at !== undefined ? { startedAt: at, ...(ended(event.status) ? { endedAt: at } : {}) } : {}),
});

// Whether a just-retired prose bubble says exactly what the plan about to be drawn says, so the request can take its
// place instead of the same markdown appearing twice in a row.
const restates = (row: TranscriptRow | undefined, text: string): boolean =>
    row?.role === "assistant" && !holdsRequest(row) && row.text.trim() !== "" && row.text.trim() === text.trim();

// Whether a bubble has any content: text, thinking, tools, todos, usage or a card; empty otherwise.
const empty = (row: TranscriptRow): boolean =>
    row.text.length === 0 &&
    (row.thinking?.length ?? 0) === 0 &&
    (row.tools?.length ?? 0) === 0 &&
    (row.todos?.length ?? 0) === 0 &&
    row.usage === undefined &&
    !holdsRequest(row);

// The turn's opening user row: text, timestamp, attachments, the message's id, and whatever the daemon later stamps onto
// it (checkpoint, notes).
export const userRow = (text: string, sentAt: number, attachments: readonly string[], messageId?: string): TranscriptRow => {
    // Drops an attachment already inline as an @-mention, unless it's a generated upload path (its own thumbnail).
    const inline = new Set(mentionedPathTokens(text));
    const chips = attachments.filter((path) => !inline.has(path) || path.includes(`/records/artifacts/attachments/`));
    return { role: "user", text, sentAt, ...(chips.length > 0 ? { attachments: chips } : {}), ...(messageId === undefined ? {} : { messageId }) };
};

export class TranscriptFold {
    readonly rows: TranscriptRow[] = [];
    // Row index of each user steer, in order; the daemon anchors rewind state to these once the turn settles.
    readonly steerRows: number[] = [];
    // Whether anything was steered in, whoever spoke: a retract may not take back an opening something followed.
    private steeredIn = false;
    // Index of the open assistant bubble; always the last row, since every other row kind closes it first.
    private bubble: number | undefined;
    private readonly cards = new Map<string, CardPlace>();
    // A subagent's own id to the card of the call that started it, once that card is known.
    private readonly placed = new Map<string, string>();
    // A subagent heard before its card: born, and perhaps already moving, while the call that started it had not yet
    // said its id. Placed as soon as a card claims it; dropped with the fold if none ever does.
    private readonly unplaced = new Map<string, TranscriptSubagent>();
    // requestId to the row holding its card, for frames landing on it later (a reply, a late sentence, a receipt).
    private readonly parked = new Map<string, number>();
    // The turn's opening user row, where the checkpoint and daemon notes land; cleared once `retract` takes it back.
    private opener: number | undefined;
    // Set by `retract`: this turn was refused before it ran, and its message went back to the conversation's queue.
    private unrun = false;

    // `now`, when given, stamps each card's start and end and each assistant or notice row's opening as the frame that
    // brings it is folded: a runtime's frames carry no clock, so the live fold is the one place these moments are known.
    // A fold replaying frames after the fact is given none, since its own clock would date them all to the replay.
    constructor(
        opening: readonly TranscriptRow[],
        private readonly now?: () => number,
    ) {
        for (const [index, row] of opening.entries()) {
            this.rows.push(row);
            // A run carried on after a restart opens on the cards it had raised, which it raises again: each is found
            // where it stands, so the frame that re-raises it, and the one that settles it, land on that row.
            for (const field of REQUEST_FIELDS) {
                const requestId = row[field]?.requestId;
                if (requestId !== undefined) {
                    this.parked.set(requestId, index);
                }
            }
        }
        const opener = this.rows.findIndex((row) => row.role === "user");
        this.opener = opener === -1 ? undefined : opener;
    }

    /** Folds one frame in; returns the patches it produced, in order. */
    apply(event: AgentEvent): TranscriptPatch[] {
        const parent = "parentToolUseId" in event ? event.parentToolUseId : undefined;
        if (parent !== undefined) {
            return this.applyChild(event, parent);
        }
        switch (event.kind) {
            case "delta": {
                if (event.text.length === 0) {
                    return [];
                }
                const [index, opened] = this.open();
                this.rows[index]!.text += event.text;
                return [...opened, { op: "text", index, text: event.text }];
            }
            case "thinking": {
                if (event.text.length === 0) {
                    return [];
                }
                const [index, opened] = this.open();
                const row = this.rows[index]!;
                row.thinking = `${row.thinking ?? ""}${event.text}`;
                return [...opened, { op: "thinking", index, text: event.text }];
            }
            case "text_end":
                // A block with no prose has no boundary; retiring here would split a card from its report.
                if (this.bubble !== undefined && this.rows[this.bubble]!.text.length > 0) {
                    this.bubble = undefined;
                }
                return [];
            case "tool_call": {
                const [index, opened] = this.open();
                const tool = cardOf(event, this.now?.());
                const row = this.rows[index]!;
                row.tools = [...(row.tools ?? []), tool];
                this.cards.set(tool.id, { tool, row: index });
                this.claimById(tool);
                return [...opened, { op: "tool", index, tool: structuredClone(tool) }];
            }
            case "tool_call_update":
                // Present fields replace the prior value (snapshot semantics); an unmatched update drops.
                return this.patchCard(event.id, (tool) => {
                    if (event.status !== undefined) {
                        tool.status = event.status;
                        // The first final status is when the result arrived; a later frame re-sending it is not.
                        if (ended(event.status) && tool.endedAt === undefined && this.now !== undefined) {
                            tool.endedAt = this.now();
                        }
                    }
                    if (event.exitCode !== undefined) {
                        tool.exitCode = event.exitCode;
                    }
                    if (event.content !== undefined) {
                        tool.content = event.content;
                        this.claimByResult(tool);
                    }
                    if (event.locations !== undefined) {
                        tool.locations = event.locations;
                    }
                });
            case "subagent":
                return this.subagentBorn(event);
            case "subagent_update":
                return this.subagentMoved(event);
            case "todos": {
                const [index, opened] = this.open();
                this.rows[index]!.todos = [...event.items];
                return [...opened, this.replace(index)];
            }
            case "usage": {
                // Lands on the last assistant bubble and closes it: a steered turn's stream can carry several turns.
                const {
                    kind: _kind,
                    account: _account,
                    cacheReadTokens: _read,
                    cacheCreationTokens: _written,
                    openingCacheReadTokens: _openingRead,
                    openingCacheCreationTokens: _openingWritten,
                    promptFingerprint: _fingerprint,
                    ...usage
                } = event;
                const index = this.rows.findLastIndex((row) => row.role === "assistant");
                const closed = this.closeBubble();
                if (index === -1) {
                    return closed;
                }
                this.rows[index]!.usage = usage;
                return [...closed, this.replace(index)];
            }
            case "steer":
                return this.steered(event);
            case "checkpoint":
                // Anchors the pre-turn snapshot id and this turn's transcript position on its user row, for rewind.
                return this.stampOpener((row) =>
                    Object.assign(row, { checkpointId: event.id }, event.index === undefined ? {} : { rewindIndex: event.index }),
                );
            case "preamble":
                // Collapses the daemon's preamble notes onto the user row; an empty note list is not a disclosure.
                return event.notes.length === 0 ? [] : this.stampOpener((row) => (row.notes = [...event.notes]));
            case "prompt_cache": {
                // Only a conversation the sandbox kept warm gets a row: every other turn's cache is its own business.
                const line = keptWarmLine(event);
                const notice = keptWarmNotice(event);
                return line === undefined || notice === undefined ? [] : this.pushRow({ role: "notice", text: line, noticeCode: noticeCode(notice) });
            }
            case "context_trim":
                // A row of its own rather than a stamp on the message: what was left out is not part of what was sent,
                // and the fold beside the message only ever lists notes that actually rode.
                return this.pushRow({ role: "notice", text: contextTrimLine(event), noticeCode: noticeCode(contextTrimNotice(event)) });
            case "handoff":
                return this.pushRow({ role: "notice", text: handedOffLine(event), noticeCode: noticeCode(handedOffNotice(event)) });
            case "worktree":
                return this.synced(event.sync);
            case "landed":
                return this.pushRow(landedRow(event));
            case "compact":
                return this.pushRow(compactedRow());
            case "install":
                return this.pushRow(installRow(event));
            case "agent_notice":
                // A runtime's own extension or loop said it: a notice row, so a reopened conversation still says it.
                return event.text.trim() === ""
                    ? []
                    : this.pushRow({
                          role: "notice",
                          text: event.text,
                          agentNotice: { level: event.level, ...(event.source === undefined ? {} : { source: event.source }) },
                      });
            case "error":
                // Keeps a refusal (no prose from the provider) from reading as a session that ended mid-question.
                // A refusal that ran nothing takes its message back out ahead of the notice standing in for it.
                return [...this.retract(event), ...this.withdrawRenewal(event), ...this.pushRow(errorRow(event, this.rows.some((row) => row.role === "assistant")))];
            case "plan": {
                // Folds a plan into an identical retired prose bubble instead of drawing the same markdown twice.
                const adjacent = this.rows.at(-1);
                // A plan raised again already has its row (park), and takes nobody's words a second time.
                const consumes = this.bubble === undefined && !this.parked.has(event.requestId) && restates(adjacent, event.text);
                if (consumes && adjacent !== undefined) {
                    adjacent.text = "";
                }
                return this.park(
                    event.requestId,
                    {
                        plan: {
                            requestId: event.requestId,
                            text: event.text,
                            status: "pending",
                            ...(event.document === undefined ? {} : { document: event.document }),
                        },
                    },
                    consumes ? this.rows.length - 1 : undefined,
                );
            }
            case "question":
                return this.park(event.requestId, {
                    question: {
                        requestId: event.requestId,
                        questions: event.questions,
                        status: "pending",
                        ...(event.document === undefined ? {} : { document: event.document }),
                    },
                });
            case "permission": {
                const { kind: _kind, ...ask } = event;
                return this.park(event.requestId, { permission: { ...ask, status: "pending" } });
            }
            case "browser_help": {
                const { kind: _kind, ...ask } = event;
                return this.park(event.requestId, { browserHelp: { ...ask, status: "pending" } });
            }
            case "terminal_help": {
                const { kind: _kind, ...ask } = event;
                return this.park(event.requestId, { terminalHelp: { ...ask, status: "pending" } });
            }
            case "capability_offer":
                return this.park(event.requestId, { capabilityOffer: { requestId: event.requestId, offer: event.offer, status: "pending" } });
            case "payment_offer":
                return this.park(event.requestId, { paymentOffer: { requestId: event.requestId, offer: event.offer, status: "pending" } });
            case "credential_offer":
                return this.park(event.requestId, { credentialOffer: { requestId: event.requestId, offer: event.offer, status: "pending" } });
            case "page":
            case "review":
                return this.showInline(event);
            case "page_ask":
                return this.park(event.requestId, { pageAsk: { requestId: event.requestId, page: event.page, status: "pending" } });
            case "need":
                // A row of its own, not a park: the turn goes on, and the card reads the need's live state by its id.
                return this.pushRow({ role: "notice", text: needRowText(event.need), need: event.need });
            case "resolved":
                // Releases the card; the answering window already froze it locally, so this is a no-op there.
                return this.patchParked(event.requestId, (row) => Object.assign(row, settledRequests(row, event.reply)));
            case "capability_outcome":
                return this.patchParked(event.requestId, (row) => {
                    if (row.capabilityOffer !== undefined) {
                        row.capabilityOffer.outcome = { outcome: event.outcome, ...(event.id === undefined ? {} : { id: event.id }) };
                    }
                });
            case "payment_receipt":
                return this.patchParked(event.requestId, (row) => {
                    if (row.paymentOffer !== undefined) {
                        row.paymentOffer.receipt = {
                            outcome: event.outcome,
                            amountUsd: event.amountUsd,
                            ...(event.transaction === undefined ? {} : { transaction: event.transaction }),
                            ...(event.network === undefined ? {} : { network: event.network }),
                        };
                    }
                });
            case "credential_receipt":
                return this.patchParked(event.requestId, (row) => {
                    if (row.credentialOffer !== undefined) {
                        row.credentialOffer.receipt = {
                            outcome: event.outcome,
                            ...(event.approvedBy === undefined ? {} : { approvedBy: event.approvedBy }),
                        };
                    }
                });
            // These carry facts about the turn, not rows in it; the run relays them as themselves.
            case "session":
            case "init":
            case "terminal":
            case "browser":
            case "commands":
            case "rate_limit_info":
            case "fast_mode":
            case "provider_retry":
            case "account_usage":
            case "context_usage":
            case "mode":
            case "agent_status":
            case "page_draft":
            case "done":
                return [];
        }
    }

    /**
     * Drawn on the bubble whose call showed it (a page, a review's findings), which it then closes, as a card does: the
     * prose after it is the next row. A redraw of one already shown folds the earlier row to a line rather than drawing
     * two copies (transcript-inline.ts).
     */
    private showInline(event: InlineEvent): TranscriptPatch[] {
        const earlier = supersedeEarlier(this.rows, event);
        const [index, opened] = this.open();
        drawInline(this.rows[index]!, event);
        this.bubble = undefined;
        return [...(earlier === undefined ? [] : [this.replace(earlier)]), ...opened, this.replace(index)];
    }

    /** A message pushed into a running turn; only a person's own message is a rewind anchor. */
    private steered(event: Extract<AgentEvent, { kind: "steer" }>): TranscriptPatch[] {
        this.steeredIn = true;
        const unspoken = unspokenPromptRow(event.text);
        if (unspoken !== undefined) {
            return this.pushRow(unspoken);
        }
        // A steer also closes the bubble, or the next answer would print over it mid-call.
        const row: TranscriptRow = { role: "user", text: event.text, sentAt: event.sentAt };
        if (event.attachments !== undefined) {
            row.attachments = [...event.attachments];
        }
        if (event.messageId !== undefined) {
            row.messageId = event.messageId;
        }
        // The sandbox's own words say so on the row, so a reader never shows them as the owner's; an agent's words
        // come as their own card (agentWords), which names the agent.
        if (event.voice === "sandbox") {
            row.speaker = { kind: "sandbox" };
        }
        if (event.errand !== undefined) {
            row.errand = event.errand;
        }
        const patches = this.pushRow(row);
        // Anchors pair by position with the checkpoints only a person's steer reserves.
        if (event.voice === undefined) {
            this.steerRows.push(this.rows.length - 1);
        }
        return patches;
    }

    /** Appends a daemon-authored row (a decision notice, card feedback) after everything said so far. */
    note(row: TranscriptRow): TranscriptPatch[] {
        return this.pushRow(row);
    }

    /**
     * Whether the turn ran nothing: refused before the model saw it, message handed back; never recorded (turn-runs).
     * Re-derived rather than latched, so a stream that spoke after its refusal still keeps what it said.
     */
    get ranNothing(): boolean {
        return this.unrun && !this.rows.some((row) => row.role === "assistant");
    }

    /**
     * Whether this frame turns the whole turn away at the door: a refusal before the model saw a word, with somebody
     * watching and nothing yet said or steered in. Asked before the frame is applied, by whoever keeps the words.
     */
    turnedAway(event: AgentEvent): boolean {
        return (
            event.kind === "error" &&
            turnedAwayCode(event.code) &&
            event.unattended !== true &&
            !this.rows.some((row) => row.role === "assistant") &&
            !this.steeredIn
        );
    }

    // Attended refusals only: the conversation's queue holds those words for another press, so a bubble left standing
    // repeats them once per press. Splicing is safe because nothing ran — no open bubble, no parked card, no steer above
    // it. A turn the sandbox kept (`held`) keeps its message and is recorded: no queue holds a copy of it.
    private retract(event: Extract<AgentEvent, { kind: "error" }>): TranscriptPatch[] {
        if (!this.turnedAway(event) || event.held !== undefined) {
            return [];
        }
        this.unrun = true;
        const opener = this.opener;
        // An opening the daemon wrote (a watch wake, a resume disclosure) has no bubble to take back, and is still unrun.
        if (opener === undefined) {
            return [];
        }
        this.rows.splice(opener, 1);
        this.opener = undefined;
        return [{ op: "drop", index: opener }];
    }

    // A run holds one hold, and each failure replaces it: a later failure in the run that armed a credential renewal is
    // what the sandbox acts on now, so the renewal row's "continues automatically" is no longer true. It says the turn
    // stopped instead, and no longer names a wait nobody is running. A renewal armed again keeps its promise.
    private withdrawRenewal(event: Extract<AgentEvent, { kind: "error" }>): TranscriptPatch[] {
        if (event.code === "claude-token-refused" && event.autoResume === "scheduled") {
            return [];
        }
        const index = this.rows.findLastIndex((row) => row.role === "notice" && row.noticeWait === "credentialRenewal");
        const row = this.rows[index];
        if (row === undefined) {
            return [];
        }
        const { noticeWait: _withdrawn, ...rest } = row;
        const withdrawn: TranscriptRow = { ...rest, text: row.text.replace(RENEWING, RENEWAL_WITHDRAWN) };
        // The code says the same as the words: the row still quotes its failure, and now reports the stop.
        const renewing = sandboxNoticeOf(row);
        if (renewing?.code === "renewing") {
            withdrawn.noticeCode = noticeCode({ code: "renewalWithdrawn", params: renewing.params });
        }
        this.rows[index] = withdrawn;
        return [this.replace(index)];
    }

    /**
     * Ends the turn: closes the open bubble, freezes every still-pending card as nobody's decision, and notes a user
     * stop.
     */
    finish(ending: TurnEnding): TranscriptPatch[] {
        const patches = this.closeBubble();
        for (const [index, row] of this.rows.entries()) {
            if (row.role === "assistant" && isAwaitingDecision(row)) {
                Object.assign(row, cancelledRequests(row));
                patches.push(this.replace(index));
            }
        }
        if (ending === "stopped") {
            patches.push(...this.pushRow({ role: "notice", text: `Stopped.`, noticeCode: noticeCode({ code: "stopped" }) }));
        }
        return patches;
    }

    // Routes a frame from a child stream onto the card that spawned it: its calls and its thinking, never its prose,
    // which is the child's own and reaches the parent as the call's result. A spawning call absent from this stream means
    // there is nothing to nest under, so the frame is dropped.
    private applyChild(event: AgentEvent, parent: string): TranscriptPatch[] {
        const place = this.cards.get(parent);
        if (place === undefined) {
            return [];
        }
        // Only the new words travel: the card whole, children and all, would go out again for every token.
        if (event.kind === "thinking") {
            if (event.text.length === 0) {
                return [];
            }
            place.tool.thinking = `${place.tool.thinking ?? ""}${event.text}`;
            return [{ op: "toolThinking", index: place.row, id: parent, text: event.text }];
        }
        if (event.kind === "tool_call") {
            const child = cardOf(event, this.now?.());
            place.tool.children = [...(place.tool.children ?? []), child];
            this.cards.set(child.id, { tool: child, row: place.row, parent });
            this.claimById(child);
            return [{ op: "tool", index: place.row, tool: structuredClone(child), parent }];
        }
        return [];
    }

    // A subagent starts: on its card when that is known, else held until a card claims it. A later birth under the same
    // id (a follow-up turn of the same subagent) starts its card's state over.
    private subagentBorn(event: Extract<AgentEvent, { kind: "subagent" }>): TranscriptPatch[] {
        const { kind: _kind, id, subagentKind, ...rest } = event;
        const born: TranscriptSubagent = { ...rest, kind: subagentKind, status: "running" };
        const card = this.cardOfSubagent(id);
        if (card === undefined) {
            this.unplaced.set(id, born);
            return [];
        }
        return this.patchCard(card, (tool) => this.place(tool, id, born));
    }

    // A subagent moves: present fields replace, absent ones leave it alone, as in tool_call_update; one still waiting for
    // its card moves where it waits.
    private subagentMoved(event: Extract<AgentEvent, { kind: "subagent_update" }>): TranscriptPatch[] {
        const { kind: _kind, id, ...patch } = event;
        const moved = defined(patch) as Partial<TranscriptSubagent>;
        const card = this.cardOfSubagent(id);
        if (card !== undefined) {
            return this.patchCard(card, (tool) => {
                if (tool.subagent !== undefined) {
                    tool.subagent = { ...tool.subagent, ...moved };
                }
            });
        }
        const waiting = this.unplaced.get(id);
        if (waiting !== undefined) {
            this.unplaced.set(id, { ...waiting, ...moved });
        }
        return [];
    }

    // The card a subagent's frames land on: the one already carrying it, else the one sharing its id (an in-process
    // subagent is named by the call that started it); undefined while the call that started it has not yet named it.
    private cardOfSubagent(id: string): string | undefined {
        return this.placed.get(id) ?? (this.cards.has(id) ? id : undefined);
    }

    // Puts a subagent on the card that started it. Its own id rides along only where it differs from the card's, so the
    // card can still name it to the roster, `wait` and its own page.
    private place(tool: TranscriptTool, id: string, subagent: TranscriptSubagent): void {
        const { id: _id, ...state } = subagent;
        tool.subagent = id === tool.id ? state : { ...state, id };
        this.placed.set(id, tool.id);
        this.unplaced.delete(id);
    }

    // A card appearing under the id a subagent was already heard by: the stream said the child before the call.
    private claimById(tool: TranscriptTool): void {
        const waiting = this.unplaced.get(tool.id);
        if (waiting !== undefined) {
            this.place(tool, tool.id, waiting);
        }
    }

    // A call whose result names a subagent still waiting for its card is the call that started it. A card carries one
    // subagent, so one that already has its own claims nothing more.
    private claimByResult(tool: TranscriptTool): void {
        if (this.unplaced.size === 0 || tool.subagent !== undefined) {
            return;
        }
        const words = resultWords(tool);
        for (const [id, waiting] of this.unplaced) {
            if (words.includes(id)) {
                this.place(tool, id, waiting);
                return;
            }
        }
    }

    // Returns the bubble frames write to, opening a fresh assistant row when the last one was retired.
    private open(): [number, TranscriptPatch[]] {
        if (this.bubble !== undefined) {
            return [this.bubble, []];
        }
        const row: TranscriptRow = { role: "assistant", text: "", ...(this.now === undefined ? {} : { openedAt: this.now() }) };
        this.rows.push(row);
        this.bubble = this.rows.length - 1;
        return [this.bubble, [{ op: "append", row: structuredClone(row) }]];
    }

    // Retires the open bubble; one that ended empty is dropped rather than kept as a row, and it's always last so
    // nothing above shifts.
    private closeBubble(): TranscriptPatch[] {
        const index = this.bubble;
        this.bubble = undefined;
        if (index === undefined) {
            return [];
        }
        if (!empty(this.rows[index]!)) {
            return [];
        }
        this.rows.splice(index, 1);
        return [{ op: "drop", index }];
    }

    // Pushes a row that is not the open bubble; closes the bubble first so order stays: what came before, then this.
    // A row other than a user's is stamped with when it landed, unless it came with its own moment.
    private pushRow(given: TranscriptRow): TranscriptPatch[] {
        const closed = this.closeBubble();
        const row = given.role === "user" || given.openedAt !== undefined || this.now === undefined ? given : { ...given, openedAt: this.now() };
        this.rows.push(row);
        return [...closed, { op: "append", row: structuredClone(row) }];
    }

    // A card takes the open bubble and closes it; `into` reuses an existing row (a plan's own prose) instead of opening
    // a new one.
    private park(requestId: string, cards: TranscriptRequests, into?: number): TranscriptPatch[] {
        // One card is one row: raised again under the id it already holds, it is put back where it stands, never drawn
        // a second time beneath.
        const standing = this.parked.get(requestId);
        if (standing !== undefined) {
            Object.assign(this.rows[standing]!, cards);
            return [this.replace(standing)];
        }
        const [index, opened] = into === undefined ? this.open() : [into, []];
        Object.assign(this.rows[index]!, cards);
        this.bubble = undefined;
        this.parked.set(requestId, index);
        return [...opened, this.replace(index)];
    }

    private patchParked(requestId: string, mutate: (row: TranscriptRow) => void): TranscriptPatch[] {
        const index = this.parked.get(requestId);
        if (index === undefined) {
            return [];
        }
        mutate(this.rows[index]!);
        return [this.replace(index)];
    }

    private patchCard(id: string, mutate: (tool: TranscriptTool) => void): TranscriptPatch[] {
        const place = this.cards.get(id);
        if (place === undefined) {
            return [];
        }
        mutate(place.tool);
        return [{ op: "tool", index: place.row, tool: structuredClone(ownFields(place.tool)), ...(place.parent === undefined ? {} : { parent: place.parent }) }];
    }

    // The rebase notice, less what a resolve turn was sent to fix: that turn opens because the branch couldn't rebase, so
    // saying so again one row under its own errand only repeats it. What did move is still told.
    private synced(sync: { commits: number; blocked: readonly string[] } | undefined): TranscriptPatch[] {
        if (sync === undefined) {
            return [];
        }
        const opener = this.opener === undefined ? undefined : this.rows[this.opener];
        const told = opener !== undefined && isLandConflict(opener.text) ? { ...sync, blocked: [] } : sync;
        const text = syncLine(told);
        const blocked = told.blocked.length > 0 ? told.blocked.join(`, `) : undefined;
        return text === "" ? [] : this.pushRow({ role: "notice", text, noticeCode: noticeCode({ code: "synced", params: { commits: told.commits, blocked } }) });
    }

    private stampOpener(mutate: (row: TranscriptRow) => void): TranscriptPatch[] {
        if (this.opener === undefined) {
            return [];
        }
        mutate(this.rows[this.opener]!);
        return [this.replace(this.opener)];
    }

    private replace(index: number): TranscriptPatch {
        return { op: "replace", index, row: structuredClone(this.rows[index]!) };
    }
}

/** Folds a whole turn at once: opening rows, every frame, and how it ended; what a settled turn reads back as. */
export const foldTurn = (opening: readonly TranscriptRow[], events: readonly AgentEvent[], ending: TurnEnding = "settled"): TranscriptRow[] => {
    const fold = new TranscriptFold(opening);
    for (const event of events) {
        fold.apply(event);
    }
    fold.finish(ending);
    return fold.rows;
};

// A patch that changes the row it names, rather than adding one or taking one away.
export type RowPatch = Exclude<TranscriptPatch, { op: "append" | "drop" }>;

/**
 * What one patch makes of the row it names: the one rule every copy of a run's rows follows (a window drawing the run,
 * the run log a restart folds back, this module's own replay), so no copy can draw a change its own way. `tool` upserts
 * by id anywhere in the tree, top-level or nested alike. Every field the patch does not name is kept, a window's own
 * marks on the row included; `replace` is the row whole.
 */
export const patchedRow = <R extends TranscriptRow>(row: R, patch: RowPatch): R | TranscriptRow => {
    switch (patch.op) {
        case "replace":
            return patch.row;
        case "text":
            return { ...row, text: `${row.text}${patch.text}` };
        case "thinking":
            return { ...row, thinking: `${row.thinking ?? ""}${patch.text}` };
        case "toolThinking":
            return { ...row, tools: [...appendToolThinking(row.tools ?? [], patch.id, patch.text)] };
        case "tool":
            return { ...row, tools: upsertTool(row.tools ?? [], patch.tool, patch.parent) };
    }
};

/** Applies one patch to a row list; only what the patch names moves (patchedRow). */
export const applyTranscriptPatch = (rows: readonly TranscriptRow[], patch: TranscriptPatch): TranscriptRow[] => {
    switch (patch.op) {
        case "append":
            return [...rows, patch.row];
        case "drop":
            return rows.filter((_row, index) => index !== patch.index);
        default:
            return rows.map((row, index) => (index === patch.index ? patchedRow(row, patch) : row));
    }
};

// Appends a delegated subagent's reasoning onto the card with this id, wherever it nests.
const appendToolThinking = (tools: readonly TranscriptTool[], id: string, text: string): readonly TranscriptTool[] =>
    mapTool(tools, id, (card) => ({ ...card, thinking: `${card.thinking ?? ""}${text}` }));

// Replaces the tool with this id anywhere in the tree, keeping the nested calls and thinking it already holds, or appends
// it under `parent`, or at top level with no parent or no match.
const upsertTool = (tools: readonly TranscriptTool[], tool: TranscriptTool, parent: string | undefined): TranscriptTool[] => {
    const replaced = mapTool(tools, tool.id, (current) => ({
        ...tool,
        ...(current.children === undefined ? {} : { children: current.children }),
        ...(current.thinking === undefined ? {} : { thinking: current.thinking }),
    }));
    if (replaced !== tools) {
        return [...replaced];
    }
    if (parent !== undefined) {
        const nested = mapTool(tools, parent, (card) => ({ ...card, children: [...(card.children ?? []), tool] }));
        if (nested !== tools) {
            return [...nested];
        }
    }
    return [...tools, tool];
};

// Applies `fn` to the tool with `id` anywhere in the tree; returns the same array when absent, so an unrelated row's
// identity is unchanged.
export const mapTool = (tools: readonly TranscriptTool[], id: string, fn: (tool: TranscriptTool) => TranscriptTool): readonly TranscriptTool[] => {
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
                return { ...tool, children: [...children] };
            }
        }
        return tool;
    });
    return changed ? next : tools;
};

// Which row fields are cards, exported for readers that count rows by them.
export const cardFieldsOf = (row: TranscriptRow): TranscriptRequests =>
    Object.fromEntries(REQUEST_FIELDS.flatMap((field) => (row[field] === undefined ? [] : [[field, row[field]]])));
