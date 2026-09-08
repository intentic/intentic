import type { Logger } from "pino";
import { z } from "zod";
import { jsonFile } from "../../store/json-file.js";

// Accounts an org has turned Claude Code off for, kept apart from the account record: that record is a credential
// rewritten whole on every rotation, so no other writer may touch this mark. A refused account still shows full
// headroom and passes every pre-turn check, so it must be excluded from selection entirely.

const SeatRefusalSchema = z.object({
    // Epoch ms of the first refusal, kept across later ones; the only record of how long a seat has been off.
    at: z.number(),
    // Provider's own sentence, verbatim; the only part naming what an admin must switch back on, shown on the row.
    reason: z.string(),
});
export type SeatRefusal = z.infer<typeof SeatRefusalSchema>;

const StoredSeatsSchema = z.record(z.string(), SeatRefusalSchema);

export interface ClaudeSeatStore {
    // Every account whose organization has refused it, keyed by account id.
    readonly read: () => Promise<Record<string, SeatRefusal>>;
    readonly refuse: (id: string, reason: string) => Promise<void>;
    // Two callers: a turn answered on the account, or it was disconnected; else a leftover entry orphans.
    readonly clear: (id: string) => Promise<void>;
}

export const fileClaudeSeatStore = (path: string, logger: Logger): ClaudeSeatStore => {
    const file = jsonFile<Record<string, SeatRefusal>>(path, {
        parse: (raw) => StoredSeatsSchema.safeParse(raw).data,
        fallback: () => ({}),
    });
    return {
        read: file.read,
        // Idempotent: a second refusal on an already-refused account rewrites nothing, keeping the first timestamp.
        // Logged outside the change function, since only the transition, not a repeat, is worth a log line.
        refuse: async (id, reason) => {
            let refused = false;
            await file.update((current) => {
                if (current[id] !== undefined) {
                    return current;
                }
                refused = true;
                return { ...current, [id]: { at: Date.now(), reason } };
            });
            if (refused) {
                logger.warn({ account: id, reason }, "claude account cannot serve Claude Code, taking it out of the rotation");
            }
        },
        clear: async (id) => {
            let cleared = false;
            await file.update((current) => {
                if (current[id] === undefined) {
                    return current;
                }
                cleared = true;
                const { [id]: _restored, ...rest } = current;
                return rest;
            });
            if (cleared) {
                logger.info({ account: id }, "claude account is back in the rotation");
            }
        },
    };
};
