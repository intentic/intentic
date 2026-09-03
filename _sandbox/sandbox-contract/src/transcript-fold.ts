import { cancelledCards, settledCards } from "./card-status.js";
import {
    type AgentEvent,
    CARD_FIELDS,
    holdsCard,
    isAwaitingDecision,
    type TranscriptCards,
    type TranscriptPatch,
    type TranscriptRow,
    type TranscriptSubagent,
    type TranscriptTool,
} from "./events.js";
import { mentionedPathTokens } from "./mentions.js";

/* THE FOLD: a turn's frames into the rows a conversation is made of, one rule, applied once.
 *
 * The daemon runs it live, frame by frame, as the turn streams (turn-runs.ts): what it produces is what every
 * attached window draws, patch by patch, and what the record keeps once the turn settles. A reopened chat
 * therefore shows what was on screen rather than a second arrangement of it, because there is no second
 * arrangement: the row a window watched being typed and the row the record holds are the same row, made by
 * the same code at the same moment.
 *
 * It used to run twice. The browser folded the live frames into its own bubbles, the daemon folded the same
 * frames at settlement into the record, and a third pass turned the record back into bubbles on reopen. Each
 * grew rules the others lacked, a card the record forgot, a steer the live view placed wrong, a notice only
 * the window that watched ever saw, and a change to one was a bug in the other until somebody noticed. This
 * is the one copy.
 *
 * `tag` names which stream of the log is being read: undefined is the main turn, a tool-call id is the
 * subagent that call spawned. Frames carrying THAT tag are the stream's own and land at top level; frames
 * carrying a different one belong to a child of this stream and nest under the card that spawned it, one
 * rule for both, which is what makes depth fall out for free: a subagent that itself delegates nests one
 * level further down, on the same pass, whichever level is being read.
 *
 * Rows are MUTATED in place and every patch carries a COPY of what it names. The mutation is what keeps a
 * result that lands turns after its call cheap, no second pass; the copy is what keeps a patch true to the
 * moment it was made rather than to whatever the row grew into by the time a slow reader took it. */

export type TurnEnding = "settled" | "stopped";

// Where a tool card lives, for the frames that reach it by id after it was drawn: its row, and the card it
// nests under when it is a helper's own call.
interface CardPlace {
    readonly tool: TranscriptTool;
    readonly row: number;
    readonly parent?: string;
}

// The keys a frame actually carries: an optional field a frame left out must not overwrite what an earlier
// frame set, and a spread of the parsed frame would, with `undefined`.
const defined = <T extends object>(value: T): Partial<T> => Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as Partial<T>;

const cardOf = (event: Extract<AgentEvent, { kind: "tool_call" }>): TranscriptTool => ({
    id: event.id,
    name: event.name,
    category: event.category,
    status: event.status,
    ...(event.target !== undefined ? { target: event.target } : {}),
    ...(event.locations !== undefined ? { locations: event.locations } : {}),
    ...(event.content !== undefined ? { content: event.content } : {}),
});

// Whether a bubble has anything in it: text, thinking, tools, a checklist or a card makes a row, and nothing
// makes none.
const empty = (row: TranscriptRow): boolean =>
    row.text.length === 0 &&
    (row.thinking?.length ?? 0) === 0 &&
    (row.tools?.length ?? 0) === 0 &&
    (row.todos?.length ?? 0) === 0 &&
    row.usage === undefined &&
    !holdsCard(row);

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

/* WHY THIS AGENT'S BRANCH JUST MOVED, the human's half of the rebase (daemon: agents/sync.ts).
 *
 * A conversation goes stale while its user commits around it, so the daemon rebases the branch onto the
 * current workspace. It is told, not asked: at the moment someone is answering their agent they have nothing
 * to decide this with, and the alternative to rebasing is not "stay safe", it is a land conflict half an hour
 * later. So this is one muted line with no button on it, the same weight as "Context compacted", and for the
 * same reason. The blocked half is the line that earns its keep: a rebase that would not apply was rolled
 * back, the agent is working from the older base, and the conflict report at the end of the turn is now
 * EXPECTED rather than a surprise. */
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

// End of a clean isolated turn: the delta auto-landed into the main tree as uncommitted changes (review = the
// Changes panel), was HELD on the branch because auto-land is off, or conflicted and stayed safely in the
// worktree. A landed delta that changed what the workspace depends on carries its reconcile too, the one
// consequence of this turn the Changes panel cannot show, because it happened outside the diff.
const landedRow = (event: Extract<AgentEvent, { kind: "landed" }>): TranscriptRow => {
    if (event.held === true) {
        return { role: "notice", text: `Finished: the work is on this agent's branch, ready to land from its review.` };
    }
    if (!event.landed) {
        // Named, not explained: the cause is per-FILE (your edits, a moved main line, a binary), and the review
        // is where each one is spelled out with the action that fits it.
        const conflicts = event.conflicts ?? [];
        return {
            role: "notice",
            text: `${conflicts.flatMap((conflict) => conflict.paths).length} file(s) couldn't land automatically in ${conflicts
                .map((conflict) => conflict.repo)
                .join(`, `)}. Open the agent's review to see what blocked them and land from there.`,
        };
    }
    // The moment-of-regret offer, on the LANDED notice only: the automatic behaviour just fired, and "stop
    // doing that" is worth one press exactly now. An install that STARTED takes the slot instead: for as long
    // as it runs, the one press worth offering is the terminal it is running in.
    return {
        role: "notice",
        text: `Changes landed in your workspace: review them in the Changes panel.${dependencyLine(event.deps)}`,
        noticeAction: (event.deps?.started.length ?? 0) > 0 ? "depsInstall" : "landHold",
    };
};

/* WHAT HAPPENED TO THE TURN, written down: the provider's own sentence, and the one clause the daemon can add
 * about what comes next. The wait itself (a countdown to the allowance reopening, an outage's next attempt) is
 * the chat's to draw beside the composer, live; this row is the record of the moment, and reads the same live
 * and a week later. */
const errorRow = (event: Extract<AgentEvent, { kind: "error" }>): TranscriptRow => {
    const { message, code } = event;
    switch (code) {
        case "provider-outage":
            return event.outage === undefined
                ? { role: "notice", text: `${message} Nothing is retrying it, so the turn is waiting: keep this chat going and it continues from here.` }
                : {
                      role: "notice",
                      text: `${message} Retrying by itself: attempt ${event.outage.attempt} of ${event.outage.maxAttempts}.`,
                      ...(event.autoResume === "scheduled" ? { noticeAction: "outageOptOut" } : {}),
                  };
        case "claude-token-refused":
            return event.autoResume === "scheduled"
                ? { role: "notice", text: `${message} The credential is being renewed and this turn continues automatically.`, noticeWait: "credentialRenewal" }
                : { role: "notice", text: `${message} Reconnect the account to pick this conversation back up.` };
        case "rate_limit":
            return { role: "notice", text: event.autoResume === "scheduled" ? `${message} This chat sends it again once the allowance comes back.` : message };
        // Refused before anything ran: the words never reached the model, and the chat holds them for the
        // user's own next send rather than flushing them into the same refusal.
        case "claude-reauth":
        case "unknown-command":
        case "context-window-too-small":
        case "sandbox-memory-low":
        case "trial-unavailable":
        case "trial-model-unavailable":
        case "trial-exhausted":
            return { role: "notice", text: `${message} Your message was not delivered: it is held for you to send again.` };
        default:
            return { role: "notice", text: message };
    }
};

/* The opening user row of a turn: what was typed, when, with what attached and what the daemon added. Built by
 * whoever holds the prompt (the daemon strips its own layers off it first, sessions/turn-transcript.ts), and
 * handed to the fold as the row it starts from. */
export const userRow = (text: string, sentAt: number, attachments: readonly string[]): TranscriptRow => {
    /* Uploads only. A path @-mentioned inline in the text rides the same wire field (the composer sends both
     * as attachments), and drawing it as a chip would show the reader the same path twice; an upload that the
     * user ALSO happened to type the generated path of keeps its chip, because the chip is the thumbnail. */
    const inline = new Set(mentionedPathTokens(text));
    const chips = attachments.filter((path) => !inline.has(path) || path.includes(`/records/artifacts/attachments/`));
    return { role: "user", text, sentAt, ...(chips.length > 0 ? { attachments: chips } : {}) };
};

export class TranscriptFold {
    readonly rows: TranscriptRow[] = [];
    // The rows the user steered into the turn, by position: the daemon files each one's rewind state under it
    // once the turn settles (agent/steer-anchors.ts), and only the fold knows where they landed.
    readonly steerRows: number[] = [];
    // The open assistant bubble, by index, and it is always the LAST row: every other kind of row closes it
    // first (pushRow), so a bubble that ends empty is dropped without moving anything above it.
    private bubble: number | undefined;
    private readonly cards = new Map<string, CardPlace>();
    // requestId → the row holding the interactive card it names, for the frames that land on a card after it
    // was raised: the reply that released it, a permission's late sentence, an offer's stream and receipt.
    private readonly parked = new Map<string, number>();
    // The turn's own opening user row, where the checkpoint and the daemon's notes land.
    private readonly opener: number | undefined;

    constructor(
        opening: readonly TranscriptRow[],
        private readonly tag?: string,
    ) {
        for (const row of opening) {
            this.rows.push(row);
        }
        const opener = this.rows.findIndex((row) => row.role === "user");
        this.opener = opener === -1 ? undefined : opener;
    }

    /** Fold one frame in. What changed comes back as patches, in the order it changed. */
    apply(event: AgentEvent): TranscriptPatch[] {
        const parent = "parentToolUseId" in event ? event.parentToolUseId : undefined;
        if (parent !== this.tag) {
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
                // The agent finished a block of prose: retire the bubble it was writing into, so what comes next,
                // the tool calls that block introduced or the next block after they return, opens a fresh one
                // below it. A block that wrote no prose has no boundary to draw: retiring on it would split a
                // card away from the prose that reported it, which is a shape the user never saw.
                if (this.bubble !== undefined && this.rows[this.bubble]!.text.length > 0) {
                    this.bubble = undefined;
                }
                return [];
            case "tool_call": {
                const [index, opened] = this.open();
                const tool = cardOf(event);
                const row = this.rows[index]!;
                row.tools = [...(row.tools ?? []), tool];
                this.cards.set(tool.id, { tool, row: index });
                return [...opened, { op: "tool", index, tool: structuredClone(tool) }];
            }
            case "tool_call_update":
                // Present fields REPLACE the prior value (snapshot semantics: Codex streams a command's growing
                // output as whole snapshots), absent fields leave it unchanged. An update with no matching tool
                // is dropped rather than shown loose.
                return this.patchCard(event.id, (tool) => {
                    if (event.status !== undefined) {
                        tool.status = event.status;
                    }
                    if (event.content !== undefined) {
                        tool.content = event.content;
                    }
                    if (event.locations !== undefined) {
                        tool.locations = event.locations;
                    }
                });
            case "subagent": {
                // The call just started an AGENT. The frame's id IS the spawning call's, so it lands on that card.
                const { kind: _kind, id, subagentKind, ...rest } = event;
                return this.patchCard(id, (tool) => {
                    tool.subagent = { ...rest, kind: subagentKind, status: "running" };
                });
            }
            case "subagent_update": {
                // Present fields REPLACE, absent ones leave the child alone, the same snapshot semantics
                // tool_call_update has: progress arrives many times and says only what moved.
                const { kind: _kind, id, ...patch } = event;
                return this.patchCard(id, (tool) => {
                    if (tool.subagent !== undefined) {
                        tool.subagent = { ...tool.subagent, ...(defined(patch) as Partial<TranscriptSubagent>) };
                    }
                });
            }
            case "todos": {
                const [index, opened] = this.open();
                this.rows[index]!.todos = [...event.items];
                return [...opened, this.replace(index)];
            }
            case "usage": {
                // End-of-turn accounting: onto the last assistant bubble rather than a fresh one, and the turn
                // BOUNDARY, a steered conversation's stream can carry several turns, so the current bubble is
                // retired and the next turn's frames open a fresh one below the steered user message.
                const { kind: _kind, account: _account, cacheReadTokens: _read, cacheCreationTokens: _written, ...usage } = event;
                const index = this.rows.findLastIndex((row) => row.role === "assistant");
                const closed = this.closeBubble();
                if (index === -1) {
                    return closed;
                }
                this.rows[index]!.usage = usage;
                return [...closed, this.replace(index)];
            }
            case "steer": {
                /* THE USER SPOKE MID-TURN, their words, at the point in the stream the daemon took them: a row of
                 * their own AND a boundary. The harness absorbs a steer between tool calls and the model keeps
                 * writing with no `result` in between, so nothing else in the stream retires the open bubble:
                 * what the agent says NEXT is its answer to this message, and left in the bubble above it the
                 * answer printed over the question. */
                const patches = this.pushRow({
                    role: "user",
                    text: event.text,
                    sentAt: event.sentAt,
                    ...(event.attachments === undefined ? {} : { attachments: [...event.attachments] }),
                });
                this.steerRows.push(this.rows.length - 1);
                return patches;
            }
            case "checkpoint":
                // The pre-turn workspace state's id, plus where this turn sits in the daemon's transcript, both
                // anchored on the turn's user row, which is what the rewind affordance addresses it by.
                return this.stampOpener((row) => {
                    row.checkpointId = event.id;
                    if (event.index !== undefined) {
                        row.rewindIndex = event.index;
                    }
                });
            case "preamble":
                // What the daemon put in front of the model, as one collapsed row hung off the user's message.
                // A frame with nothing in it is not a disclosure.
                return event.notes.length === 0 ? [] : this.stampOpener((row) => (row.notes = [...event.notes]));
            case "worktree":
                return event.sync === undefined ? [] : this.pushRow({ role: "notice", text: syncLine(event.sync) });
            case "landed":
                return this.pushRow(landedRow(event));
            case "compact":
                return this.pushRow({ role: "notice", text: `Context compacted to free up space.` });
            case "error":
                /* WHAT HAPPENED TO THE TURN, kept, and the frame whose absence made a refused session look broken
                 * rather than refused: a provider that answers "your organization has disabled Claude subscription
                 * access" sends this and no prose, so a fold of the two speakers alone ends on the user's message. */
                return this.pushRow(errorRow(event));
            case "tier":
                /* THIS TURN RAN ON A CHEAPER MODEL THAN THE ONE ASKED FOR, written down for the same reason the
                 * refusal above is: the answer below it is the cheap rung's answer, and a reader coming back
                 * tomorrow has no other way to know which of their messages were served that way. Only a turn that
                 * really moved: a verdict that changed nothing is machinery, not an event. The model is named by
                 * ID, the only name this side has. `noticeAction` carries the one press the line offers, "keep
                 * this chat on my pick". */
                return event.routed && event.model !== undefined
                    ? this.pushRow({ role: "notice", text: `This turn looked simple, so it ran on ${event.model} instead of your pick.`, noticeAction: "tierHold" })
                    : [];
            case "plan": {
                /* Current ExitPlanMode has no plan input: the completed prose block immediately before the call IS
                 * the plan. The daemon repeats it on this frame so the card is self-contained; when that exact
                 * block is the adjacent retired bubble, reclassify it into the card instead of drawing the same
                 * markdown once as prose and again as a plan. A distinct intro remains its own bubble. */
                const adjacent = this.rows.at(-1);
                const consumes =
                    this.bubble === undefined &&
                    adjacent?.role === "assistant" &&
                    !holdsCard(adjacent) &&
                    adjacent.text.trim() !== "" &&
                    adjacent.text.trim() === event.text.trim();
                if (consumes) {
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
            case "service_offer":
                return this.park(event.requestId, { serviceOffer: { requestId: event.requestId, offer: event.offer, status: "pending" } });
            case "capability_offer":
                return this.park(event.requestId, { capabilityOffer: { requestId: event.requestId, offer: event.offer, status: "pending" } });
            case "payment_offer":
                return this.park(event.requestId, { paymentOffer: { requestId: event.requestId, offer: event.offer, status: "pending" } });
            case "resolved":
                // The card above was released, and the frame says how. The window that answered already froze its
                // own card the instant its reply was accepted (card-status.ts, the same derivation), so this is a
                // no-op there and earns its keep on every other surface.
                return this.patchParked(event.requestId, (row) => Object.assign(row, settledCards(row, event.reply)));
            case "permission_note":
                return this.patchParked(event.requestId, (row) => {
                    if (row.permission !== undefined) {
                        row.permission.explain = event.explain;
                    }
                });
            case "service_event":
                return this.patchParked(event.requestId, (row) => {
                    if (row.serviceOffer !== undefined) {
                        row.serviceOffer.events = [...(row.serviceOffer.events ?? []), event.event];
                    }
                });
            case "service_receipt":
                return this.patchParked(event.requestId, (row) => {
                    if (row.serviceOffer !== undefined) {
                        row.serviceOffer.receipt = { outcome: event.outcome, credits: event.credits, ...(event.remaining === undefined ? {} : { remaining: event.remaining }) };
                    }
                });
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
            // Facts about the turn, not rows in it (TURN_FACT_KINDS): the run relays them as themselves.
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
            case "done":
                return [];
        }
    }

    /** A row the daemon writes on the turn's behalf, a notice about a decision, the feedback that answered a
     *  card, at the end of what has been said so far. */
    note(row: TranscriptRow): TranscriptPatch[] {
        return this.pushRow(row);
    }

    /** The turn is over. The open bubble is closed, every card still waiting on an answer is frozen as nobody's
     *  decision, and a turn the user stopped says so, all of it as rows, because all of it is what the reader
     *  saw. */
    finish(ending: TurnEnding): TranscriptPatch[] {
        const patches = this.closeBubble();
        for (const [index, row] of this.rows.entries()) {
            if (row.role === "assistant" && isAwaitingDecision(row)) {
                Object.assign(row, cancelledCards(row));
                patches.push(this.replace(index));
            }
        }
        if (ending === "stopped") {
            patches.push(...this.pushRow({ role: "notice", text: `Stopped.` }));
        }
        return patches;
    }

    /* A CHILD OF THIS STREAM. Its calls and its thinking hang off the card that spawned it; its PROSE does not,
     * because a card has no place for prose and the child's report already arrives as that card's result
     * content. Read at the child's own level (a fold tagged with its id) that prose is top-level and lands in
     * full. A card this stream has never seen means the spawning call is not in the stream being read, so
     * there is nothing to hang it off; dropping it is what keeps a nested level out of the level above it. */
    private applyChild(event: AgentEvent, parent: string | undefined): TranscriptPatch[] {
        const place = parent === undefined ? undefined : this.cards.get(parent);
        if (place === undefined || parent === undefined) {
            return [];
        }
        if (event.kind === "thinking") {
            return this.patchCard(parent, (tool) => {
                tool.thinking = `${tool.thinking ?? ""}${event.text}`;
            });
        }
        if (event.kind === "tool_call") {
            const child = cardOf(event);
            place.tool.children = [...(place.tool.children ?? []), child];
            this.cards.set(child.id, { tool: child, row: place.row, parent });
            return [{ op: "tool", index: place.row, tool: structuredClone(child), parent }];
        }
        return [];
    }

    // The bubble the current frame writes to, allocating a fresh assistant row when the turn's bubble was
    // retired (a finished block of prose, a card, the end of a turn).
    private open(): [number, TranscriptPatch[]] {
        if (this.bubble !== undefined) {
            return [this.bubble, []];
        }
        const row: TranscriptRow = { role: "assistant", text: "" };
        this.rows.push(row);
        this.bubble = this.rows.length - 1;
        return [this.bubble, [{ op: "append", row: structuredClone(row) }]];
    }

    // Retire the open bubble. One that ended empty is not a row: the empty text block a model can open before
    // going straight to a tool has nothing to keep, and it is always the last row, so dropping it moves nothing.
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

    // A row that is not the open bubble: the bubble is closed first, so what follows lands BELOW what came
    // before, and the new row is the last.
    private pushRow(row: TranscriptRow): TranscriptPatch[] {
        const closed = this.closeBubble();
        this.rows.push(row);
        return [...closed, { op: "append", row: structuredClone(row) }];
    }

    /* A card takes the bubble that is open and closes it: the prose that led up to the ask stays above the card,
     * and whatever the agent says once answered opens a fresh row beneath it. A bubble holding nothing but the
     * card is still a row, where the card IS the bubble. `into` reuses a row already there (the plan's own
     * prose) instead of opening one. */
    private park(requestId: string, cards: TranscriptCards, into?: number): TranscriptPatch[] {
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
        return [{ op: "tool", index: place.row, tool: structuredClone(place.tool), ...(place.parent === undefined ? {} : { parent: place.parent }) }];
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

/** A whole turn at once: the opening rows, every frame, and how it ended. What a settled turn reads back as. */
export const foldTurn = (opening: readonly TranscriptRow[], events: readonly AgentEvent[], ending: TurnEnding = "settled", tag?: string): TranscriptRow[] => {
    const fold = new TranscriptFold(opening, tag);
    for (const event of events) {
        fold.apply(event);
    }
    fold.finish(ending);
    return fold.rows;
};

/** Apply one patch to a list of rows, the client's half of the fold: what a patch names is what moves, and
 *  nothing else. `tool` upserts by id anywhere in the row's tree, so a helper's nested call and a top-level
 *  one are placed by the same rule. Returns a new list; the rows it did not touch keep their identity. */
export const applyTranscriptPatch = (rows: readonly TranscriptRow[], patch: TranscriptPatch): TranscriptRow[] => {
    switch (patch.op) {
        case "append":
            return [...rows, patch.row];
        case "replace":
            return rows.map((row, index) => (index === patch.index ? patch.row : row));
        case "drop":
            return rows.filter((_row, index) => index !== patch.index);
        case "text":
            return rows.map((row, index) => (index === patch.index ? { ...row, text: `${row.text}${patch.text}` } : row));
        case "thinking":
            return rows.map((row, index) => (index === patch.index ? { ...row, thinking: `${row.thinking ?? ""}${patch.text}` } : row));
        case "tool":
            return rows.map((row, index) => (index === patch.index ? { ...row, tools: upsertTool(row.tools ?? [], patch.tool, patch.parent) } : row));
    }
};

// Replace the tool with this id wherever it lives in the tree; failing that, add it under its parent, or at
// the top level when it has none (or its parent is not here, a malformed stream, where dropping the call
// would be worse than showing it loose).
export const upsertTool = (tools: readonly TranscriptTool[], tool: TranscriptTool, parent: string | undefined): TranscriptTool[] => {
    const replaced = mapTool(tools, tool.id, () => tool);
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

// Apply `fn` to the tool with `id` anywhere in a row's tool tree. Returns the SAME array when the id isn't
// present, so an unrelated row keeps its identity (and re-renders nothing).
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

// Which fields of a row are cards, exported beside the fold for readers that count rows by them.
export const cardFieldsOf = (row: TranscriptRow): TranscriptCards => Object.fromEntries(CARD_FIELDS.flatMap((field) => (row[field] === undefined ? [] : [[field, row[field]]])));
