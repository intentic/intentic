import type { TodoItem } from "@intentic/sandbox-contract/events/requests";
import type { UnfinishedWork } from "@intentic/sandbox-contract/schemas/agents";
import type { SettleFlush } from "../actor/conversation-decide.js";
import type { PersistedAgent } from "./agents-store.js";
import { opt } from "../../opt.js";

// What a turn left open, read at finish from only what it measured, no model asked, nothing self-reported: a missing
// check means it was not re-run; what a missing checklist means depends on how the turn ended (`TurnCompletion`).
const openSteps = (list: readonly TodoItem[]): UnfinishedWork["steps"] => {
    const open = list.filter((item) => item.status !== "completed");
    if (open.length === 0) {
        return undefined;
    }
    // What it would pick up next: the one already in progress, else the first still waiting.
    const next = (open.find((item) => item.status === "in_progress") ?? open[0])?.content;
    return { open: open.length, total: list.length, ...opt("next", next) };
};

// The moment of measurement, not of the write: a settle that never observed the list learned nothing new, and stamping
// `now` there would restart the age of an old abandonment.
const leftAt = (entry: PersistedAgent, flush: SettleFlush, now: number): number =>
    flush.checklist === undefined ? (entry.unfinished?.at ?? now) : now;

/* THE STEPS A TURN LEAVES, and why a list it never saw is not always the old list. */
const stepsLeft = (entry: PersistedAgent, flush: SettleFlush): UnfinishedWork["steps"] => {
    if (flush.checklist !== undefined) {
        return openSteps(flush.checklist);
    }
    return flush.ending === "clean" ? undefined : entry.unfinished?.steps;
};

export const unfinishedOf = (entry: PersistedAgent, flush: SettleFlush, now: number): UnfinishedWork | undefined => {
    // No turn ran: a land or a sweep finishing a resting card learned nothing about its work, and re-reading the
    // readings left by the last turn would re-stamp an old abandonment with today's date.
    if (flush.ending === "none") {
        return entry.unfinished;
    }
    const steps = stepsLeft(entry, flush);
    if (steps === undefined) {
        return undefined;
    }
    return { at: leftAt(entry, flush, now), steps };
};
