import { cancelledRequests, settledRequests } from "../policy/request-status.js";
import type { AgentEvent } from "../events/agent-events.js";
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
import { isLandConflict } from "../events/land-conflict.js";
import { turnedAwayCode } from "../policy/turned-away.js";
import { mentionedPathTokens } from "./mentions.js";
import { unspokenPromptRow } from "../events/agent-words.js";
import { needRowText } from "../events/need-wake.js";
import { noticeCode, sandboxNoticeOf } from "../events/sandbox-notice.js";

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

const cardOf = (event: Extract<AgentEvent, { kind: "tool_call" }>): TranscriptTool => ({
    id: event.id,
    name: event.name,
    category: event.category,
    status: event.status,
    ...(event.target !== undefined ? { target: event.target } : {}),
    ...(event.locations !== undefined ? { locations: event.locations } : {}),
    ...(event.content !== undefined ? { content: event.content } : {}),
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

// Clause appended to the landed notice for a workspace dependency change, or empty when there is none. Reports the
// install as already started, or as on its way: the daemon starts it within seconds, in the install lane, behind any
// install already running; never as a request.
const dependencyLine = (deps: { missing: number; started: string[]; deferred: boolean } | undefined): string => {
    if (deps === undefined || deps.missing === 0) {
        return ``;
    }
    // `missing` counts versions the turn bumped as well as names it added, so the sentence names both.
    const what = `${deps.missing} ${deps.missing === 1 ? `dependency` : `dependencies`} it added or changed`;
    return deps.deferred
        ? ` ${what} ${deps.missing === 1 ? `is` : `are`} being installed in your tree: the install waits for any other install to finish, appears in Work terminals, and its outcome lands in Activity.`
        : ` Installing ${what}; the project's checks run when that finishes, and the outcome lands in Activity.`;
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

// Row for a spawned child's work gone into its parent's checkout, or held off it by a clash with the parent's edits.
const intoParentRow = (event: Extract<AgentEvent, { kind: "landed" }>): TranscriptRow => {
    if (event.landed) {
        return {
            role: "notice",
            text: `Changes went into the parent agent's checkout, as its in-process subagents' edits do: they reach your workspace with its land.`,
            noticeCode: noticeCode({ code: "intoParent" }),
        };
    }
    const files = (event.conflicts ?? []).flatMap((conflict) => conflict.paths).length;
    return {
        role: "notice",
        text: `${files} file(s) clash with the parent agent's own edits, so nothing was written into its checkout. The parent was told, and can bring the changes in to resolve.`,
        noticeCode: noticeCode({ code: "intoParentClash", params: { files } }),
    };
};

// Row for a finished turn: held on its branch, landed automatically, or conflicted. A landed turn that changed
// dependencies appends dependencyLine, since the Changes diff can't show that.
const landedRow = (event: Extract<AgentEvent, { kind: "landed" }>): TranscriptRow => {
    if (event.into !== undefined) {
        return intoParentRow(event);
    }
    if (event.held === true) {
        return { role: "notice", text: `Finished: the work is on this agent's branch, ready to land from its review.`, noticeCode: noticeCode({ code: "landHeld" }) };
    }
    if (!event.landed) {
        // Per-file cause (your edits, a moved main line, a binary) is spelled out in the review, not named here.
        const conflicts = event.conflicts ?? [];
        const files = conflicts.flatMap((conflict) => conflict.paths).length;
        const repos = conflicts.map((conflict) => conflict.repo).join(`, `);
        return {
            role: "notice",
            text: `${files} file(s) couldn't land automatically in ${repos}. Open the agent's review to see what blocked them and land from there.`,
            noticeCode: noticeCode({ code: "landConflict", params: { files, repos } }),
        };
    }
    // noticeAction fires only here, right as the auto-behavior ran; an active install takes the slot instead.
    const deps = event.deps === undefined || event.deps.missing === 0 ? undefined : event.deps;
    return {
        role: "notice",
        text: `Changes landed in your workspace: review them in the Changes panel.${dependencyLine(event.deps)}`,
        noticeAction: (event.deps?.started.length ?? 0) > 0 ? "depsInstall" : "landHold",
        noticeCode: noticeCode({ code: "landed", params: deps === undefined ? undefined : { deps: deps.missing, queued: deps.deferred || undefined } }),
    };
};

// A failure's own sentence and code, which every coded error row carries ahead of what it adds.
const failureOf = (event: Extract<AgentEvent, { kind: "error" }>): { message: string; error?: string } =>
    event.code === undefined ? { message: event.message } : { message: event.message, error: event.code };

// The clause after a refusal that ran nothing. A turn somebody typed is held in its conversation's queue for another
// press; a turn that started itself — an automation, a loop, a watch wake — has no typed message and nobody watching,
// so promising a resend there names a composer the reader is not looking at. Neither version promises a retry: whether
// one comes is the scheduler's decision, not this row's to state.
const undelivered = (unattended: boolean): string =>
    unattended
        ? `Nothing ran, and nothing is held: this run started on its own, so there is no message waiting to be sent again.`
        : `Your message was not delivered: it is held for you to send again.`;

// The press a memory hold offers: the raise rides along only when the hold carried a ceiling to size it by, since a
// stall names none and raising one would not clear it.
const memoryPress = (event: Extract<AgentEvent, { kind: "error" }>): "sendAnyway" | "sandboxMemory" =>
    event.memory === undefined ? "sendAnyway" : "sandboxMemory";

// A memory hold is asked once and never again that spell (resource-budget.ts), so the next send always runs. A turn the
// sandbox started itself (a fix press, a peer's message, a re-run) was never in a composer: its message stays above, and
// the press asks the sandbox to run the turn it kept rather than sending a queue that holds nothing.
const heldRow = (event: Extract<AgentEvent, { kind: "error" }>): TranscriptRow => {
    const unattended = event.unattended === true;
    const memory = event.code === "sandbox-memory-low";
    const said = failureOf(event);
    if (event.held !== undefined && !unattended) {
        return {
            role: "notice",
            text: memory
                ? `${event.message} Nothing has run yet: the message above is kept here, and sending it anyway starts it.`
                : `${event.message} Nothing has run yet: the message above is kept here to send again once that is sorted.`,
            noticeAction: memory ? memoryPress(event) : "sendAgain",
            sandboxHeld: true,
            noticeCode: noticeCode({ code: "kept", params: { ...said, memory: memory || undefined } }),
        };
    }
    if (!memory || unattended) {
        return {
            role: "notice",
            text: `${event.message} ${undelivered(unattended)}`,
            noticeCode: noticeCode({ code: "undelivered", params: { ...said, unattended: unattended || undefined } }),
        };
    }
    return {
        role: "notice",
        text: `${event.message} Your message is held: send it again to start anyway.`,
        noticeAction: memoryPress(event),
        noticeCode: noticeCode({ code: "memoryHeld", params: said }),
    };
};

// What an armed credential renewal promises, and what its row says instead once a later failure in the same run took
// that promise back (TranscriptFold.withdrawRenewal).
const RENEWING = "The credential is being renewed and this turn continues automatically.";
const RENEWAL_WITHDRAWN =
    "The credential was being renewed, but the turn stopped before it could continue: it will not carry on by itself, so press Continue to pick it back up.";

// Row for a turn-ending error: the provider's own message plus one clause on what happens next. The live wait itself is
// drawn by the chat, not stored here.
const errorRow = (event: Extract<AgentEvent, { kind: "error" }>): TranscriptRow => {
    const { message, code } = event;
    const said = failureOf(event);
    switch (code) {
        case "provider-outage": {
            const retry = retryClause(event);
            return retry === undefined
                ? {
                      role: "notice",
                      text: `${message} Nothing is retrying it, so the turn is waiting here.`,
                      noticeCode: noticeCode({ code: "outageWaiting", params: said }),
                  }
                : { role: "notice", text: `${message} ${retry.text}`, noticeCode: retry.code };
        }
        case "claude-token-refused":
            return event.autoResume === "scheduled"
                ? {
                      role: "notice",
                      text: `${message} ${RENEWING}`,
                      noticeWait: "credentialRenewal",
                      noticeCode: noticeCode({ code: "renewing", params: said }),
                  }
                : {
                      role: "notice",
                      text: `${message} Reconnect the account to pick this conversation back up.`,
                      noticeCode: noticeCode({ code: "reconnect", params: said }),
                  };
        case "rate_limit":
            return { role: "notice", text: message };
        default:
            break;
    }
    if (!turnedAwayCode(code)) {
        const retry = retryClause(event);
        if (retry !== undefined) {
            return { role: "notice", text: `${message} ${retry.text}`, noticeCode: retry.code };
        }
        // A failure the sandbox names by code is coded too, so a reader that words that failure itself can; the
        // provider's own uncoded words are only ever themselves.
        return code === undefined ? { role: "notice", text: message } : { role: "notice", text: message, noticeCode: noticeCode({ code: "failed", params: said }) };
    }
    return heldRow(event);
};

// What a laddered wall's automatic re-runs are doing, said on the failure's own row so the count stays in the record.
const retryClause = (event: Extract<AgentEvent, { kind: "error" }>): { text: string; code: NonNullable<TranscriptRow["noticeCode"]> } | undefined => {
    const { retries } = event;
    if (retries === undefined) {
        return undefined;
    }
    const said = failureOf(event);
    if (event.autoResume === "scheduled") {
        return {
            text: `Retrying by itself: attempt ${retries.made + 1} of ${retries.max}.`,
            code: noticeCode({ code: "retrying", params: { ...said, attempt: retries.made + 1, of: retries.max } }),
        };
    }
    return retries.made >= retries.max
        ? {
              text: `Retried ${retries.made} of ${retries.max} times by itself; nothing more is sent automatically.`,
              code: noticeCode({ code: "retried", params: { ...said, made: retries.made, of: retries.max } }),
          }
        : undefined;
};

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

    constructor(opening: readonly TranscriptRow[]) {
        for (const row of opening) {
            this.rows.push(row);
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
                const tool = cardOf(event);
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
                return this.stampOpener((row) => {
                    row.checkpointId = event.id;
                    if (event.index !== undefined) {
                        row.rewindIndex = event.index;
                    }
                });
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
            case "worktree":
                return event.sync === undefined ? [] : this.synced(event.sync);
            case "landed":
                return this.pushRow(landedRow(event));
            case "compact":
                return this.pushRow(compactedRow());
            case "error":
                // Keeps a refusal (no prose from the provider) from reading as a session that ended mid-question.
                // A refusal that ran nothing takes its message back out ahead of the notice standing in for it.
                return [...this.retract(event), ...this.withdrawRenewal(event), ...this.pushRow(errorRow(event))];
            case "plan": {
                // Folds a plan into an identical retired prose bubble instead of drawing the same markdown twice.
                const adjacent = this.rows.at(-1);
                const consumes = this.bubble === undefined && restates(adjacent, event.text);
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
            case "done":
                return [];
        }
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
            const child = cardOf(event);
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
    private park(requestId: string, cards: TranscriptRequests, into?: number): TranscriptPatch[] {
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
    private synced(sync: { commits: number; blocked: readonly string[] }): TranscriptPatch[] {
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
        case "toolThinking":
            return rows.map((row, index) => (index === patch.index ? { ...row, tools: [...appendToolThinking(row.tools ?? [], patch.id, patch.text)] } : row));
        case "tool":
            return rows.map((row, index) => (index === patch.index ? { ...row, tools: upsertTool(row.tools ?? [], patch.tool, patch.parent) } : row));
    }
};

// Appends a delegated subagent's reasoning onto the card with this id, wherever it nests.
export const appendToolThinking = (tools: readonly TranscriptTool[], id: string, text: string): readonly TranscriptTool[] =>
    mapTool(tools, id, (card) => ({ ...card, thinking: `${card.thinking ?? ""}${text}` }));

// Replaces the tool with this id anywhere in the tree, keeping the nested calls and thinking it already holds, or appends
// it under `parent`, or at top level with no parent or no match.
export const upsertTool = (tools: readonly TranscriptTool[], tool: TranscriptTool, parent: string | undefined): TranscriptTool[] => {
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
