import { cancelledCards, settledCards } from "../policy/card-status.js";
import type { AgentEvent } from "../events/agent-events.js";
import { CARD_FIELDS, holdsCard, isAwaitingDecision, type TranscriptCards, type TranscriptPatch, type TranscriptRow, type TranscriptSubagent, type TranscriptTool } from "../events/transcript.js";
import { mentionedPathTokens } from "./mentions.js";

// Folds a turn's frames into rows once, live and for the settled record alike, so a reopened chat matches what was on
// screen. `tag` selects the stream read: undefined is the main turn, a tool-call id is the subagent it spawned; other
// frames nest under the card that spawned them. Rows mutate in place; every patch carries a copy of what it names.

export type TurnEnding = "settled" | "stopped";

// Where a tool card lives: its row, and the parent card it nests under when it's a helper's own call.
interface CardPlace {
    readonly tool: TranscriptTool;
    readonly row: number;
    readonly parent?: string;
}

// Strips undefined fields, so spreading a partial frame never overwrites a field an earlier frame already set.
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

// Whether a bubble has any content: text, thinking, tools, todos, usage or a card; empty otherwise.
const empty = (row: TranscriptRow): boolean =>
    row.text.length === 0 &&
    (row.thinking?.length ?? 0) === 0 &&
    (row.tools?.length ?? 0) === 0 &&
    (row.todos?.length ?? 0) === 0 &&
    row.usage === undefined &&
    !holdsCard(row);

// Clause appended to the landed notice for a workspace dependency change, or empty when there is none. Reports the
// install as already started, or queued when other agents are still running; never as a request.
const dependencyLine = (deps: { missing: number; started: string[]; deferred: boolean } | undefined): string => {
    if (deps === undefined || deps.missing === 0) {
        return ``;
    }
    const what = `${deps.missing} new ${deps.missing === 1 ? `dependency` : `dependencies`}`;
    return deps.deferred
        ? ` ${what} are queued: installation starts after this turn and any other active agents finish, appears in Work terminals, then its checks and outcome land in Activity.`
        : ` Installing ${what} it added; the project's checks run when that finishes, and the outcome lands in Activity.`;
};

// One line reporting the daemon's rebase of this agent's branch onto the current workspace; `blocked` names repos it
// couldn't rebase, where the turn ran from an older base.
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

// Row for a finished turn: held on its branch, landed automatically, or conflicted. A landed turn that changed
// dependencies appends dependencyLine, since the Changes diff can't show that.
const landedRow = (event: Extract<AgentEvent, { kind: "landed" }>): TranscriptRow => {
    if (event.held === true) {
        return { role: "notice", text: `Finished: the work is on this agent's branch, ready to land from its review.` };
    }
    if (!event.landed) {
        // Per-file cause (your edits, a moved main line, a binary) is spelled out in the review, not named here.
        const conflicts = event.conflicts ?? [];
        return {
            role: "notice",
            text: `${conflicts.flatMap((conflict) => conflict.paths).length} file(s) couldn't land automatically in ${conflicts
                .map((conflict) => conflict.repo)
                .join(`, `)}. Open the agent's review to see what blocked them and land from there.`,
        };
    }
    // noticeAction fires only here, right as the auto-behavior ran; an active install takes the slot instead.
    return {
        role: "notice",
        text: `Changes landed in your workspace: review them in the Changes panel.${dependencyLine(event.deps)}`,
        noticeAction: (event.deps?.started.length ?? 0) > 0 ? "depsInstall" : "landHold",
    };
};

// Row for a turn-ending error: the provider's own message plus one clause on what happens next. The live wait itself is
// drawn by the chat, not stored here.
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
        // Refused before the model saw it; the composer holds the message so the user can resend it.
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

// The turn's opening user row: text, timestamp, attachments, and whatever the daemon later stamps onto it (checkpoint,
// notes).
export const userRow = (text: string, sentAt: number, attachments: readonly string[]): TranscriptRow => {
    // Drops an attachment already inline as an @-mention, unless it's a generated upload path (its own thumbnail).
    const inline = new Set(mentionedPathTokens(text));
    const chips = attachments.filter((path) => !inline.has(path) || path.includes(`/records/artifacts/attachments/`));
    return { role: "user", text, sentAt, ...(chips.length > 0 ? { attachments: chips } : {}) };
};

export class TranscriptFold {
    readonly rows: TranscriptRow[] = [];
    // Row index of each user steer, in order; the daemon anchors rewind state to these once the turn settles.
    readonly steerRows: number[] = [];
    // Index of the open assistant bubble; always the last row, since every other row kind closes it first.
    private bubble: number | undefined;
    private readonly cards = new Map<string, CardPlace>();
    // requestId to the row holding its card, for frames landing on it later (a reply, a late sentence, a receipt).
    private readonly parked = new Map<string, number>();
    // The turn's opening user row, where the checkpoint and daemon notes land.
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

    /** Folds one frame in; returns the patches it produced, in order. */
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
                // A block with no prose has no boundary; retiring here would split a card from its report.
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
                // Present fields replace the prior value (snapshot semantics); an unmatched update drops.
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
                // The frame's id is the spawning call's id, so the subagent record lands on that card.
                const { kind: _kind, id, subagentKind, ...rest } = event;
                return this.patchCard(id, (tool) => {
                    tool.subagent = { ...rest, kind: subagentKind, status: "running" };
                });
            }
            case "subagent_update": {
                // Present fields replace, absent ones leave the child alone, as in tool_call_update.
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
                // Lands on the last assistant bubble and closes it: a steered turn's stream can carry several turns.
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
                // A steer also closes the bubble, or the next answer would print over it mid-call.
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
                // Anchors the pre-turn snapshot id and this turn's transcript position on its user row, for rewind.
                return this.stampOpener((row) => {
                    row.checkpointId = event.id;
                    if (event.index !== undefined) {
                        row.rewindIndex = event.index;
                    }
                });
            case "preamble":
                // Collapses the daemon's preamble notes onto the user row; an empty note list is not a disclosure.
                return event.notes.length === 0 ? [] : this.stampOpener((row) => (row.notes = [...event.notes]));
            case "worktree":
                return event.sync === undefined ? [] : this.pushRow({ role: "notice", text: syncLine(event.sync) });
            case "landed":
                return this.pushRow(landedRow(event));
            case "compact":
                return this.pushRow({ role: "notice", text: `Context compacted to free up space.` });
            case "error":
                // Keeps a refusal (no prose from the provider) from reading as a session that ended mid-question.
                return this.pushRow(errorRow(event));
            case "tier":
                // Notes a turn served on a cheaper model than requested, only when it actually routed.
                return event.routed && event.model !== undefined
                    ? this.pushRow({ role: "notice", text: `This turn looked simple, so it ran on ${event.model} instead of your pick.`, noticeAction: "tierHold" })
                    : [];
            case "plan": {
                // Folds a plan into an identical retired prose bubble instead of drawing the same markdown twice.
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
            case "capability_offer":
                return this.park(event.requestId, { capabilityOffer: { requestId: event.requestId, offer: event.offer, status: "pending" } });
            case "payment_offer":
                return this.park(event.requestId, { paymentOffer: { requestId: event.requestId, offer: event.offer, status: "pending" } });
            case "credential_offer":
                return this.park(event.requestId, { credentialOffer: { requestId: event.requestId, offer: event.offer, status: "pending" } });
            case "resolved":
                // Releases the card; the answering window already froze it locally, so this is a no-op there.
                return this.patchParked(event.requestId, (row) => Object.assign(row, settledCards(row, event.reply)));
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
            case "done":
                return [];
        }
    }

    /** Appends a daemon-authored row (a decision notice, card feedback) after everything said so far. */
    note(row: TranscriptRow): TranscriptPatch[] {
        return this.pushRow(row);
    }

    /**
     * Ends the turn: closes the open bubble, freezes every still-pending card as nobody's decision, and notes a user
     * stop.
     */
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

    // Routes a frame from a child stream onto the card that spawned it; its prose surfaces only when that child's own
    // stream is read directly. A spawning call absent from this stream means there is nothing to nest under, so the
    // frame is dropped.
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

    // Returns the bubble frames write to, opening a fresh assistant row when the last one was retired.
    private open(): [number, TranscriptPatch[]] {
        if (this.bubble !== undefined) {
            return [this.bubble, []];
        }
        const row: TranscriptRow = { role: "assistant", text: "" };
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
    private pushRow(row: TranscriptRow): TranscriptPatch[] {
        const closed = this.closeBubble();
        this.rows.push(row);
        return [...closed, { op: "append", row: structuredClone(row) }];
    }

    // A card takes the open bubble and closes it; `into` reuses an existing row (a plan's own prose) instead of opening
    // a new one.
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

/** Folds a whole turn at once: opening rows, every frame, and how it ended; what a settled turn reads back as. */
export const foldTurn = (opening: readonly TranscriptRow[], events: readonly AgentEvent[], ending: TurnEnding = "settled", tag?: string): TranscriptRow[] => {
    const fold = new TranscriptFold(opening, tag);
    for (const event of events) {
        fold.apply(event);
    }
    fold.finish(ending);
    return fold.rows;
};

/**
 * Applies one patch to a row list; only what the patch names moves. `tool` upserts by id anywhere in the tree,
 * top-level or nested alike.
 */
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

// Replaces the tool with this id anywhere in the tree, or appends it under `parent`, or at top level with no parent or
// no match.
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
export const cardFieldsOf = (row: TranscriptRow): TranscriptCards => Object.fromEntries(CARD_FIELDS.flatMap((field) => (row[field] === undefined ? [] : [[field, row[field]]])));
