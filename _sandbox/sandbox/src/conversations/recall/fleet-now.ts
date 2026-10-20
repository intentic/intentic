import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import { type TurnSpeaker, TurnSpeakerSchema } from "@intentic/sandbox-contract/schemas/speaker";
import type { ConversationState } from "../actor/conversation-state.js";

// Where a conversation stands RIGHT NOW, for `agents show`: the turn in flight (since when, who started it, when it last
// heard from its runtime, what it is doing) and what holds it between turns (an armed watch, a running background job, a
// queued message, a spent allowance). Read off the board's own summary and the conversation's actor, never re-derived,
// so the CLI cannot say `idle` while the board says Active: on 2026-10-10 it did, for a conversation whose background
// job's watch held its land with hours left, because the capsule read only the persisted entry.

// The turn now running.
export interface FleetTurnNow {
    readonly startedAt?: number;
    // The run a stop names, and the one a log line carries.
    readonly run?: string;
    // Who or what asked for it: a member's email, `token:<label>`, `agent:<id>`, `sandbox:<what>`, or the re-run it is.
    readonly by?: string;
    // When its runtime last sent anything, the one sign of a turn that is alive but stuck.
    readonly lastEventAt?: number;
    // The last tool it reached for, with what it reached for it with, or the checklist item it is on.
    readonly doing?: string;
    readonly checklist?: { readonly done: number; readonly total: number };
    // The kinds of card it is parked on, waiting for a person.
    readonly waitingOn?: readonly string[];
    readonly stopping?: boolean;
}

// A background command still running, as the card lists it.
export interface FleetJobNow {
    readonly id: string;
    readonly label: string;
    readonly startedAt: number;
    // The watch its exit wakes the conversation through.
    readonly watch?: string;
    // Left running for the person; it wakes nothing.
    readonly handed?: boolean;
    // Since when it has sat blocked reading its terminal, where nothing in the sandbox will answer it.
    readonly promptSince?: number;
}

export interface FleetNow {
    readonly turn?: FleetTurnNow;
    // It runs again by itself (a watch, or a wake waiting in its queue), and the daemon holds its land until then.
    readonly awaitingWake?: boolean;
    readonly watches?: readonly { readonly id: string; readonly note: string; readonly deadlineAt: number }[];
    readonly jobs?: readonly FleetJobNow[];
    // Messages waiting for its next turn, and why they do not go by themselves.
    readonly queued?: { readonly count: number; readonly paused?: string; readonly until?: number };
    // A spent allowance's held turn: whether it is booked to go again, when, and to which account.
    readonly limit?: { readonly held: boolean; readonly scheduled: boolean; readonly resetsAt?: number; readonly moving?: string };
    // The sandbox is already re-running what killed its last turn.
    readonly resuming?: boolean;
    // Its work is being carried into the workspace right now.
    readonly landing?: boolean;
}

// Its own copy of fleet-recall.ts's, which imports this module.
const present = <T extends object>(fields: T): { [K in keyof T]?: Exclude<T[K], undefined> } =>
    Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as { [K in keyof T]?: Exclude<T[K], undefined> };

const speakerWord = (speaker: TurnSpeaker): string => {
    switch (speaker.kind) {
        case "person":
            return speaker.email;
        case "program":
            return `token:${speaker.token}`;
        case "agent":
            return `agent:${speaker.conversationId}`;
        case "sandbox":
            return speaker.source === undefined ? "sandbox" : `sandbox:${speaker.source}`;
    }
};

// The journal files the turn as its door built it, speaker included, though the journal's own schema names only what a
// resume needs; parsed rather than trusted, so a turn an older build filed reads as unknown instead of as garbage.
const startedBy = (state: ConversationState | undefined): string | undefined => {
    const turn = state?.journal?.entry.turn;
    if (turn === undefined) {
        return undefined;
    }
    const speaker = TurnSpeakerSchema.safeParse((turn as { readonly speaker?: unknown }).speaker);
    const who = speaker.success ? speakerWord(speaker.data) : undefined;
    const words = [
        turn.resume === undefined ? who : `re-run (${turn.resume})${who === undefined ? "" : ` of ${who}`}`,
        turn.errand === undefined ? undefined : `for ${turn.errand}`,
        turn.outsideWake === undefined ? undefined : `woken by ${turn.outsideWake}`,
    ].filter((word): word is string => word !== undefined);
    return words.length === 0 ? undefined : words.join(" ");
};

const WAITING: readonly (keyof AgentSummary["attention"])[] = ["plan", "question", "permission", "capability", "credential", "need"];

const turnNow = (summary: AgentSummary, state: ConversationState | undefined, running: boolean): FleetTurnNow | undefined => {
    if (!running) {
        return undefined;
    }
    const { activity } = summary;
    const doing = activity?.tool === undefined ? activity?.todo : [activity.tool, activity.target].filter(Boolean).join(" ");
    const waitingOn = WAITING.filter((kind) => summary.attention[kind]);
    return present({
        startedAt: summary.startedAt,
        run: summary.run,
        by: startedBy(state),
        lastEventAt: state?.turn.lastAt,
        doing,
        checklist: summary.checklist,
        waitingOn: waitingOn.length === 0 ? undefined : waitingOn,
        stopping: summary.status === "stopping" ? true : undefined,
    });
};

const jobsNow = (summary: AgentSummary): readonly FleetJobNow[] =>
    (summary.jobs ?? [])
        .filter((job) => job.endedAt === undefined)
        .map((job) =>
            present({
                id: job.id,
                label: job.label,
                startedAt: job.startedAt,
                watch: job.watch,
                handed: job.handed,
                promptSince: job.inputWait?.since,
            }),
        ) as FleetJobNow[];

const queuedNow = (summary: AgentSummary): FleetNow["queued"] => {
    const count = summary.queue?.items.length ?? 0;
    return count === 0 ? undefined : { count, ...present({ paused: summary.queue?.paused, until: summary.queue?.until }) };
};

const limitNow = (summary: AgentSummary): FleetNow["limit"] => {
    const rerun = summary.next?.kind === "rerun" ? summary.next : undefined;
    return summary.limitHeld !== true && rerun === undefined
        ? undefined
        : { held: summary.limitHeld === true, scheduled: rerun !== undefined, ...present({ resetsAt: summary.limitResetsAt, moving: rerun?.onto }) };
};

/** What is live or holding the conversation now; undefined for one that is simply at rest. */
export const fleetNow = (summary: AgentSummary | undefined, state: ConversationState | undefined, running: boolean): FleetNow | undefined => {
    if (summary === undefined) {
        return undefined;
    }
    const jobs = jobsNow(summary);
    const now: FleetNow = present({
        turn: turnNow(summary, state, running),
        awaitingWake: summary.awaitingWake === true ? true : undefined,
        watches: summary.watches === undefined || summary.watches.length === 0 ? undefined : summary.watches.map(({ id, note, deadlineAt }) => ({ id, note, deadlineAt })),
        jobs: jobs.length === 0 ? undefined : jobs,
        queued: queuedNow(summary),
        limit: limitNow(summary),
        resuming: summary.status === "resuming" ? true : undefined,
        landing: summary.status === "landing" ? true : undefined,
    });
    return Object.keys(now).length === 0 ? undefined : now;
};
