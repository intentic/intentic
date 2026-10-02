import { z } from "zod";
import { defineDocument } from "../store/evolution/documents.js";
import { openDocument } from "../store/open-document.js";
import { stateRelPath } from "../state-paths.js";

// How far the scheduler has accounted for each schedule automation's clock, so a boot can tell which of its moments
// passed while nothing was running (scheduler.ts, the catch-up at start). The run ledger alone cannot say it: a wake
// that was held, dropped as overlapping, or never fired at all leaves no run, and a new automation has no history to
// measure from, so without this one created yesterday would fire at boot for a moment from before it existed.
// Written only when something changes (an automation armed, switched off, or fired), never per poll: a mark per poll
// would be a write every thirty seconds for a fact the next fire states anyway.

const MarkSchema = z.object({
    // Epoch ms up to which every moment of this automation is accounted for: fired, or not owed.
    coveredUntil: z.number(),
    // Seen switched off: nothing is owed while it is, and switching it back on, even by hand while the daemon was down,
    // owes nothing from before.
    off: z.literal(true).optional(),
});
export type ScheduleMark = z.infer<typeof MarkSchema>;

export const scheduleCoverageDocument = defineDocument({
    path: stateRelPath(".intentic/records/automation-schedule.json"),
    schema: MarkSchema,
    granularity: "record",
});

export interface ScheduleCoverageStore {
    readonly read: () => Promise<Readonly<Record<string, ScheduleMark>>>;
    // Sets each named mark, and drops the ones given as undefined; one write for a whole pass, none when nothing moves.
    readonly mark: (marks: Readonly<Record<string, ScheduleMark | undefined>>) => Promise<void>;
}

const sameMark = (a: ScheduleMark | undefined, b: ScheduleMark | undefined): boolean => a?.coveredUntil === b?.coveredUntil && a?.off === b?.off;

export const fileScheduleCoverageStore = (path: string): ScheduleCoverageStore => {
    // Unreadable is no marks, which reads as an upgrade: the run ledger is the fallback reference.
    const file = openDocument(scheduleCoverageDocument, path, { fallback: (): Record<string, ScheduleMark> => ({}) });
    return {
        read: file.read,
        mark: async (marks) => {
            const changes = Object.entries(marks);
            if (changes.length === 0) {
                return;
            }
            await file.update((current) => {
                const moved = changes.filter(([id, mark]) => !sameMark(current[id], mark));
                if (moved.length === 0) {
                    return current;
                }
                const next = { ...current };
                for (const [id, mark] of moved) {
                    if (mark === undefined) {
                        delete next[id];
                    } else {
                        next[id] = mark;
                    }
                }
                return next;
            });
        },
    };
};
