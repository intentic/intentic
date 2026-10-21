import type { Services } from "../../../../composition.js";
import { defineInFlight } from "../../../../seams/restart/in-flight.js";
import { recordUnrecordedRuns } from "../../../../sessions/turn-transcript.js";
import type { JournalEntry, JournalledTurn } from "../../../../store/journals/turn-journal.js";
import { recordOrRerun, restartCostNow, restoreParked } from "../turn-resume.js";
import { recordSettledTurn } from "./cut-turn-rows.js";
import type { RestartResume } from "./restart-resume-policy.js";

// THE TURNS A RESTART CUT, recovered at boot: the in-flight kind the gate reads (bootstrap/restart/in-flight-kinds.ts) and
// the pass over each turn it holds. What becomes of one turn (re-run, written down, its cards put back) is turn-resume.ts's.

// Every turn journalled when the gate opens is one the daemon died under (bootstrap/restart/in-flight-kinds.ts), each consumed (spent or
// deleted) before it restarts, so a turn that kills the daemon can't loop the boot; then what waited in a queue goes,
// whatever became of the turns. An unreadable journal resumes no cut turn this boot, its entries left on file for the
// next, but the queues are not the journal's and still drain (2026-10-21: a journal read that threw had skipped them).
export const interruptedTurnsInFlight = defineInFlight({
    name: "interrupted turns",
    read: async (services: Pick<Services, "turnJournal" | "logger">) =>
        (
            await services.turnJournal.list().catch((error: Error): JournalEntry[] => {
                services.logger.warn({ err: error }, "turn journal: unreadable at boot, no interrupted turn is resumed");
                return [];
            })
        ).filter((entry): entry is JournalledTurn => entry.kind === "turn"),
    recover: async (services: Services, left, resume) => {
        try {
            await recoverCutTurns(services, left, resume);
        } finally {
            for (const conversationId of services.agents.ids()) {
                if ((services.agents.entry(conversationId)?.queue?.items.length ?? 0) > 0) {
                    void services.turns.drain(conversationId);
                }
            }
        }
    },
});

// `cost`: what the restart cost the turns it cut (restart-record.ts), told to each it re-runs; read off this boot's marker.
export const recoverCutTurns = async (
    services: Services,
    interrupted: readonly JournalledTurn[],
    resume: RestartResume,
    now: number = Date.now(),
    cost: string | undefined = restartCostNow(),
): Promise<void> => {
    const resumedWhy = resume.resume && resume.asked ? "the owner asked this restart to pick up after" : "autoResumeOnRestart";
    for (const entry of interrupted) {
        // One turn whose recovery throws (a run log that cannot be read, say) costs only itself: the rest still go.
        await recoverCutTurn(services, entry, { resume, resumedWhy, cost }, now).catch((error: Error) =>
            services.logger.error(
                { err: error, conversationId: entry.turn.conversationId },
                "interrupted turn could not be recovered: its entry stays on file as it stood, the boot's other cut turns go on",
            ),
        );
    }
};

const recoverCutTurn = async (
    services: Services,
    entry: JournalledTurn,
    policy: { readonly resume: RestartResume; readonly resumedWhy: string; readonly cost: string | undefined },
    now: number,
): Promise<void> => {
    // A turn that ended but whose record refused it is written down, and never run again.
    if (entry.run?.settled === true) {
        await recordSettledTurn(services, entry);
        return;
    }
    // An earlier run the record missed goes down first, so the cut turn lands beneath it; still refused, the entry
    // waits for the next boot.
    if (!(await recordUnrecordedRuns(services, entry.turn.conversationId))) {
        services.logger.warn({ conversationId: entry.turn.conversationId }, "interrupted turn kept for the next boot: an earlier turn's record still refuses");
        return;
    }
    // Skips every gate below: rehydration spends nothing and isn't an attempt, so autoResumeOnRestart, staleness
    // and the attempt cap don't apply. Not cleared here either; the placeholder re-journals it, so a second restart
    // rehydrates again.
    if (entry.parked !== undefined && entry.parked.length > 0) {
        await restoreParked(services, entry);
        return;
    }
    await recordOrRerun(services, entry, policy, now);
};

