import type { OpenCodeClient, OpenCodeEvent } from "@opencode/client";
import type { AgentEvent, AgentReply, AskQuestion } from "@intentic/sandbox-contract";
import { z } from "zod";
import { opt } from "../../opt.js";
import { EXPIRED, type TurnWatchdog } from "../decorators/turn-watchdog.js";
import { FORM_DISMISSED, FORM_UNRENDERABLE, formAnswer, formQuestions, type OpenCodeForm } from "./opencode-forms.js";
import type { EventOf } from "./opencode-frames.js";
import { sessionOf } from "./opencode-frames.js";
import { retryHandover } from "./opencode-failures.js";
import { outsideSourceOf } from "../../guard/outside-results.js";

// The parts of reading one OpenCode turn that are about waiting rather than about frames: what the turn's queue holds,
// how long its silence may last while a shell runs or a background one is left, the steers it sends, the forms it asks
// a person, the retries it hands to the daemon, and what it reads back after the server's stream reopened. Kept apart
// from opencode-agent.ts, which drives the session and maps the events onto frames.

// A frame the daemon raised for the turn itself (a permission card, then its resolution), carried in order with the
// session's events; OpenCode sends no event of this type.
export interface RaisedFrame {
    readonly type: "intentic.frame";
    readonly frame: AgentEvent;
}
// The turn handed its failure to the daemon (a retry it will not wait out): the frame says why, and nothing follows.
export interface HandedOver {
    readonly type: "intentic.failed";
    readonly frame: Extract<AgentEvent, { kind: "error" }>;
}
// A message steered into the running turn, waiting to be sent.
interface Steer {
    readonly type: "intentic.steer";
    readonly text: string;
}
// The server's stream reopened after a drop: what went by in between has to be read back.
interface Resumed {
    readonly type: "intentic.resumed";
}
// Something the turn waits on settled outside its events (a form answered): the turn looks again at whether it is done.
interface Wake {
    readonly type: "intentic.wake";
}
// A form found standing in a read-back, as the session's own list holds it.
interface StandingForm {
    readonly type: "intentic.form";
    readonly form: OpenCodeForm;
}
// What the daemon puts on a turn's queue for itself, rather than OpenCode's events or the cards its judge raised.
export type DaemonItem = Steer | Resumed | Wake | StandingForm;
export type QueueItem = OpenCodeEvent | RaisedFrame | DaemonItem;

const DAEMON_ITEMS: ReadonlySet<string> = new Set(["intentic.steer", "intentic.resumed", "intentic.wake", "intentic.form"]);
export const isDaemonItem = (item: QueueItem): item is DaemonItem => DAEMON_ITEMS.has(item.type);

// What a read answers once the follow-up wait passed with nothing new.
export const SETTLED: unique symbol = Symbol("settled");

// Everything one turn reads, in arrival order: its session family's events, the cards its judge raises, its steers.
export const turnQueue = () => {
    const items: QueueItem[] = [];
    let lost: Error | undefined;
    let wake: (() => void) | undefined;
    const ping = (): void => {
        wake?.();
        wake = undefined;
    };
    return {
        push: (item: QueueItem): void => {
            items.push(item);
            ping();
        },
        lose: (reason: Error): void => {
            lost ??= reason;
            ping();
        },
        // Whether anything waits to be read.
        waiting: (): boolean => items.length > 0,
        // The next item, or why there will be none: the stream lost, the watchdog's deadline, or the follow-up wait over.
        next: async (clock: TurnWatchdog, followUpUntil: number | undefined): Promise<QueueItem | Error | typeof EXPIRED | typeof SETTLED> => {
            for (;;) {
                const item = items.shift();
                if (item !== undefined) {
                    return item;
                }
                if (lost !== undefined) {
                    return lost;
                }
                if (clock.remaining() <= 0) {
                    return EXPIRED;
                }
                if (followUpUntil !== undefined && Date.now() >= followUpUntil) {
                    return SETTLED;
                }
                let timer: NodeJS.Timeout | undefined;
                await new Promise<void>((resolve) => {
                    wake = resolve;
                    timer = setTimeout(resolve, Math.max(1, Math.min(clock.remaining(followUpUntil), 60_000)));
                });
                clearTimeout(timer);
            }
        },
    };
};
export type TurnQueue = ReturnType<typeof turnQueue>;

// How long a turn whose own work has ended waits for OpenCode to pick up what a background shell or subagent left it
// (OpenCode wakes the session with their result as soon as they end, within milliseconds).
export const FOLLOW_UP_MS = 5_000;

// How long a turn whose own work has ended waits on a shell it left running in the background: a build or a test run it
// means to read the end of. Past this the turn ends, and the shell with it (a dev server never ends on its own, and
// would otherwise hold the turn silent until its cap and then fail it).
export const BACKGROUND_WAIT_MS = 10 * 60_000;

// OpenCode's shell tool, and its own time limit on a foreground command when the call names none (2.0.26).
const SHELL_TOOL = "shell";
const SHELL_DEFAULT_TIMEOUT_MS = 120_000;
// The longest a foreground command keeps the turn's silence clock still, whatever time limit the call asked for (0
// asks for none): a command still silent past this is read as stuck, as any silence is.
export const FOREGROUND_SHELL_MAX_MS = 20 * 60_000;

// What a turn's card for a form or a default-mode ask goes to: the turn's own card registry, with the frames pushed on
// the turn's stream in order.
export type TurnAsk = (questions: readonly AskQuestion[], push: (frame: AgentEvent) => void) => Promise<Extract<AgentReply, { kind: "question" }>>;

export interface TurnReading {
    readonly client: OpenCodeClient;
    readonly sessionId: string;
    readonly queue: TurnQueue;
    readonly clock: TurnWatchdog;
    // Who answers a form: a person on a question card; absent, every form is cancelled, since nobody would answer it.
    readonly ask: TurnAsk | undefined;
    // The family's sessions, read back after a reopened stream.
    readonly members: () => ReadonlySet<string>;
    readonly signal: AbortSignal;
}

// A turn's own state while it is read: its executions, its steers, its forms, its shells' waits, what it has heard.
export interface TurnProgress {
    // Sessions of the family with an execution running.
    readonly running: Set<string>;
    // Whether the turn's own session's latest execution ended well.
    ownEnded: boolean;
    // Until when a turn whose work ended waits for something left in the background to report.
    followUpUntil: number | undefined;
    // Until when a turn waits on a shell it left in the background, once its own work ended.
    backgroundUntil: number | undefined;
    // Steers sent and not yet taken in by the session (by inbox id), those whose send has not answered yet, and those
    // the session took in before the send answered.
    readonly steers: Set<string>;
    sending: number;
    readonly delivered: Set<string>;
    // Forms put on a card and not yet answered.
    forms: number;
    // Each call's tool name, by call id, as its input began.
    readonly calls: Map<string, string>;
    // The foreground shell calls still running, by call id, each with the instant its own time limit runs out.
    readonly shellsRunning: Map<string, number>;
    // The calls whose result brings outside content in, by call id, each with the source its taint is filed under.
    readonly outside: Map<string, string>;
    // The durable events already read (by id), and each session's newest durable sequence number: what a read-back
    // after a reopened stream starts after, and skips.
    readonly heard: Set<string>;
    readonly seq: Map<string, number>;
}

export const turnProgress = (): TurnProgress => ({
    running: new Set(),
    ownEnded: false,
    followUpUntil: undefined,
    backgroundUntil: undefined,
    steers: new Set(),
    sending: 0,
    delivered: new Set(),
    forms: 0,
    calls: new Map(),
    shellsRunning: new Map(),
    outside: new Map(),
    heard: new Set(),
    seq: new Map(),
});

const EXECUTION_ENDS: ReadonlySet<string> = new Set(["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"]);
export const isExecutionEnd = (event: OpenCodeEvent): boolean => EXECUTION_ENDS.has(event.type);

/** Whether an event was already read (a read-back repeating one heard live); notes it as read otherwise. */
export const heardBefore = (progress: TurnProgress, event: OpenCodeEvent): boolean => {
    const durable = "durable" in event ? event.durable : undefined;
    if (durable === undefined) {
        return false;
    }
    if (progress.heard.has(event.id)) {
        return true;
    }
    progress.heard.add(event.id);
    const session = sessionOf(event);
    if (session !== undefined && durable.seq > (progress.seq.get(session) ?? -1)) {
        progress.seq.set(session, durable.seq);
    }
    return false;
};

/** An execution's start or end, in the family's running set and the turn's own ending. */
export const noteExecution = (progress: TurnProgress, event: OpenCodeEvent, own: string): void => {
    const session = sessionOf(event);
    if (session === undefined) {
        return;
    }
    if (event.type === "session.execution.started") {
        progress.running.add(session);
        progress.followUpUntil = undefined;
        progress.backgroundUntil = undefined;
        if (session === own) {
            progress.ownEnded = false;
        }
    } else if (isExecutionEnd(event)) {
        progress.running.delete(session);
        if (session === own && event.type === "session.execution.succeeded") {
            progress.ownEnded = true;
        }
    }
};

/**
 * A shell call, for the silence clock: a foreground command blocks its call, saying nothing until it ends, so while one
 * runs the silence window is held past the command's own time limit (bounded by FOREGROUND_SHELL_MAX_MS). Every event
 * the turn reads restarts the window, so the hold is put back after each, until the call's own ending lets it go. A
 * background command returns at once and needs nothing here.
 */
export const noteCall = (progress: TurnProgress, event: OpenCodeEvent, clock: TurnWatchdog, now = Date.now()): void => {
    if (event.type === "session.tool.input.started") {
        progress.calls.set(event.data.id, event.data.name);
    } else if (event.type === "session.tool.called" && progress.calls.get(event.data.id) === SHELL_TOOL) {
        const call = ShellCallSchema.parse(event.data.input);
        if (call.background !== true) {
            progress.shellsRunning.set(event.data.id, now + Math.min(shellLimitOf(call.timeout), FOREGROUND_SHELL_MAX_MS));
        }
    } else if (event.type === "session.tool.success" || event.type === "session.tool.failed") {
        progress.shellsRunning.delete(event.data.id);
    }
    const until = Math.max(...progress.shellsRunning.values());
    if (Number.isFinite(until)) {
        clock.extendPast(until);
    }
};

// OpenCode's built-in tools by the names outsideSourceOf reads (the Claude loop's), where their results can bring the
// outside in; an MCP tool goes by the name the turn's view gives it (`mcp__<server>__<tool>`).
const OUTSIDE_NAMES: ReadonlyMap<string, string> = new Map([
    ["webfetch", "WebFetch"],
    ["websearch", "WebSearch"],
    ["shell", "Bash"],
]);

/**
 * A call whose result brings outside content into the turn (a fetched page, a search, a shell command that reaches the
 * network, a non-control MCP server's answer), marked on the turn's taint bit once it succeeded, as the Claude loop's
 * result wrap marks it (guard/outside-results.ts). OpenCode's results cannot be rewritten into an envelope here; the
 * taint is what the command gate reads, so later commands are judged as a turn the outside reached.
 */
export const noteOutside = (progress: TurnProgress, event: OpenCodeEvent, nameOf: (raw: string) => string, mark: (source: string) => void): void => {
    if (event.type === "session.tool.called") {
        const raw = progress.calls.get(event.data.id);
        const source = raw === undefined ? undefined : outsideSourceOf(OUTSIDE_NAMES.get(raw) ?? nameOf(raw), event.data.input);
        if (source !== undefined) {
            progress.outside.set(event.data.id, source);
        }
    } else if (event.type === "session.tool.success" || event.type === "session.tool.failed") {
        const source = progress.outside.get(event.data.id);
        progress.outside.delete(event.data.id);
        if (source !== undefined && event.type === "session.tool.success") {
            mark(source);
        }
    }
};

// A shell call's input as far as its waiting goes, read tolerantly: another shape reads as the tool's defaults.
const ShellCallSchema = z.object({ timeout: z.number().optional().catch(undefined), background: z.boolean().optional().catch(undefined) }).catch({});

// How long a foreground command may run: the time it asked for, none when it asked for 0, else the tool's own default.
const shellLimitOf = (timeout: number | undefined): number => {
    if (timeout === undefined) {
        return SHELL_DEFAULT_TIMEOUT_MS;
    }
    return timeout > 0 ? timeout : FOREGROUND_SHELL_MAX_MS;
};

/** A steer the session took in, or dropped: it no longer holds the turn open. */
export const noteInbox = (progress: TurnProgress, event: OpenCodeEvent, own: string): void => {
    if ((event.type === "session.inbox.delivered" || event.type === "session.inbox.cancelled") && event.data.sessionID === own) {
        progress.delivered.add(event.data.inboxID);
        progress.steers.delete(event.data.inboxID);
    }
};

/**
 * Sends one steer into the turn's session. Delivered as a steer, OpenCode hands it to the model at its next step, or,
 * with the session's work already done, starts the next execution with it, which this turn reads as its own. The turn
 * stays open until the session says it took the message in (`session.inbox.delivered`).
 */
export const sendSteer = async (reading: TurnReading, progress: TurnProgress, text: string): Promise<void> => {
    progress.sending += 1;
    try {
        const sent = await reading.client.session.prompt({ sessionID: reading.sessionId, text, delivery: "steer" });
        if (!progress.delivered.has(sent.id)) {
            progress.steers.add(sent.id);
        }
    } finally {
        progress.sending -= 1;
    }
};

// One form cancelled, with the words the model hears for it.
const cancelForm = async (client: OpenCodeClient, form: OpenCodeForm, message: string): Promise<void> => {
    await client.session.form.cancel({ sessionID: form.sessionID, formID: form.id, message });
};

// One form's reply on its wire: the answer, or, for a dismissed card, a cancellation saying so.
const replyToForm = async (client: OpenCodeClient, form: OpenCodeForm, answer: ReturnType<typeof formAnswer>): Promise<void> => {
    if (answer === undefined) {
        await cancelForm(client, form, FORM_DISMISSED);
        return;
    }
    await client.session.form.reply({ sessionID: form.sessionID, formID: form.id, answer });
};

/**
 * Puts a form on a question card and answers it from the card; the watchdog is held while the card waits on a person,
 * and the turn does not end with it open. A form no card can carry, or one raised where nobody answers cards, is
 * cancelled at once with a sentence telling the model to carry on. A reply that fails leaves the form to OpenCode.
 */
export const answerForm = (reading: TurnReading, progress: TurnProgress, form: OpenCodeForm): void => {
    const questions = formQuestions(form);
    const ask = reading.ask;
    if (questions === undefined || ask === undefined) {
        // allow(silent-catch): a form that could not be cancelled is one OpenCode already settled
        void cancelForm(reading.client, form, FORM_UNRENDERABLE).catch(() => {});
        return;
    }
    progress.forms += 1;
    const release = reading.clock.hold();
    void (async () => {
        try {
            const reply = await ask(
                questions.map((entry) => entry.question),
                (frame) => reading.queue.push({ type: "intentic.frame", frame }),
            );
            await replyToForm(reading.client, form, formAnswer(questions, reply));
        } catch {
            // allow(silent-catch): an unanswered form is the session's to give up on; the turn is not failed for it
        } finally {
            release();
            progress.forms -= 1;
            reading.queue.push({ type: "intentic.wake" });
        }
    })();
};

/** The failure a scheduled retry is handed to the daemon as, or undefined to let OpenCode wait it out. */
export const handover = (event: EventOf<"session.retry.scheduled">, clock: TurnWatchdog): HandedOver | undefined => {
    const frame = retryHandover(event.data, clock.capRemaining());
    return frame === undefined ? undefined : { type: "intentic.failed", frame };
};

/**
 * What the turn waits on once its own work ended and nothing of its family runs: a steer on its way, a form on a card,
 * a shell left in the background (for BACKGROUND_WAIT_MS at most), or a background ending OpenCode is about to wake the
 * session with. `done` once nothing is left to wait on.
 */
export const settling = (progress: TurnProgress, shells: number, clock: TurnWatchdog, now = Date.now()): "done" | "wait" => {
    if (progress.steers.size > 0 || progress.sending > 0 || progress.forms > 0) {
        return "wait";
    }
    if (shells > 0) {
        progress.backgroundUntil ??= now + BACKGROUND_WAIT_MS;
        progress.followUpUntil = progress.backgroundUntil;
        clock.extendPast(progress.backgroundUntil);
        return "wait";
    }
    return progress.followUpUntil === undefined ? "done" : "wait";
};

// What a session's latest recorded message says about its last execution, where it says it ended.
const IDLE_ENDINGS = {
    succeeded: "session.execution.succeeded",
    failed: "session.execution.failed",
    interrupted: "session.execution.interrupted",
} as const;

// The family's durable events since the last one each session's turn heard, read back from the session's own log.
const readLogs = async (reading: TurnReading, progress: TurnProgress): Promise<void> => {
    for (const session of reading.members()) {
        try {
            const log = reading.client.session.log(
                { sessionID: session, follow: false, ...opt("after", progress.seq.get(session)) },
                { signal: reading.signal },
            );
            for await (const item of log) {
                // The log's marker of where it caught up, an edit to a stored message and a side spend recorded are not
                // events the live stream carries, nor ones a turn reads.
                if (item.type !== "log.synced" && item.type !== "session.message.content.updated" && item.type !== "session.usage.recorded") {
                    reading.queue.push(item);
                }
            }
        } catch {
            // allow(silent-catch): an unread log leaves readEndings to find the ending
        }
    }
};

// A session still counted running that the server no longer runs ended while nobody heard: its ending, as its last
// recorded messages say it ended.
const readEndings = async (reading: TurnReading, progress: TurnProgress): Promise<void> => {
    // allow(silent-catch): an unread list of running sessions reads as none running, so each is checked below
    const active = await reading.client.session.active().catch((): Awaited<ReturnType<OpenCodeClient["session"]["active"]>> => ({}));
    for (const session of [...progress.running].filter((member) => !(member in active))) {
        // allow(silent-catch): a session whose messages cannot be read keeps waiting, which its watchdog ends
        const last = await reading.client.message.list({ sessionID: session, order: "desc", limit: 2 }).catch(() => undefined);
        const idle = last?.data.find((message) => message.type === "idle");
        const assistant = last?.data.find((message) => message.type === "assistant");
        if (idle?.type === "idle") {
            reading.queue.push(readBackEnding(session, idle.outcome, assistant?.type === "assistant" ? assistant.error : undefined));
        }
    }
};

// Forms the family's sessions raised while nobody heard, as the events that would have carried them.
const readForms = async (reading: TurnReading): Promise<void> => {
    for (const session of reading.members()) {
        // allow(silent-catch): forms that cannot be listed stay standing, which the session's own wait ends
        for (const form of await reading.client.session.form.list({ sessionID: session }).catch(() => [])) {
            reading.queue.push({ type: "intentic.form", form });
        }
    }
};

/**
 * After the server's stream reopened: the family's durable events since the last one heard, then the endings and forms
 * nobody heard. Everything goes through the turn's queue, where `heardBefore` drops what was already read.
 */
export const readBack = async (reading: TurnReading, progress: TurnProgress): Promise<void> => {
    await readLogs(reading, progress);
    await readEndings(reading, progress);
    await readForms(reading);
};

// The ending a session's idle message records, as the event the live stream would have carried.
const readBackEnding = (
    session: string,
    outcome: keyof typeof IDLE_ENDINGS,
    error: EventOf<"session.execution.failed">["data"]["error"] | undefined,
): OpenCodeEvent => {
    const base = { id: `readback_${session}_${outcome}`, created: Date.now(), durable: { aggregateID: session, seq: -1, version: 1 as const } };
    switch (outcome) {
        case "succeeded":
            return { ...base, type: IDLE_ENDINGS.succeeded, data: { sessionID: session } };
        case "failed":
            return {
                ...base,
                type: IDLE_ENDINGS.failed,
                data: { sessionID: session, error: error ?? { type: "unknown", message: "OpenCode ended the turn with an error it did not keep." } },
            };
        case "interrupted":
            return { ...base, type: IDLE_ENDINGS.interrupted, data: { sessionID: session, reason: "user" } };
    }
};

export type { EventOf };
