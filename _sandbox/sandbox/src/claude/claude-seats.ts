import type { Logger } from "pino";
import { z } from "zod";
import { jsonFile } from "../store/json-file.js";

/* THE ACCOUNTS AN ORGANIZATION HAS TURNED CLAUDE CODE OFF FOR (<authRoot>/claude/seats.json — beside the
 * accounts it is about, and shared between sandboxes for the same reason they are: what one sandbox spends a
 * turn to discover, the next one should not have to spend another turn discovering).
 *
 * A FILE OF ITS OWN, and that is the whole of why this exists. The mark used to live on the account record,
 * which is the one place it could not survive: that record is a CREDENTIAL, rewritten whole every time a token
 * rotates, by every process holding the account — and the auth dir is shared, so "every process" spans sandboxes
 * running different builds of this daemon. One of them refreshed a token through a schema that had never heard
 * of the mark, wrote the account back without it, and the seat rejoined the rotation four hours later; the next
 * unpinned turn went straight to the one account in the sandbox that could not run it, and died on the
 * organization's refusal with a fix nobody watching could apply. A fact no other writer touches is a fact no
 * other writer can drop.
 *
 * Why the fact has to be durable at all: an organization-managed account whose admin has Claude Code switched
 * off signs in perfectly and publishes full headroom, and is refused only once a turn is actually running. So it
 * is invisible to every check that happens BEFORE a turn, and it is the account the picker prefers — it has the
 * most headroom left precisely because nothing can ever spend on it. Ranking it last is not enough; it comes out
 * of the running entirely until a turn on it answers (see resolveHarnessCredentials).
 *
 * The refusal recorded in provider-refusals.json is the same event and NOT a substitute: that store keeps one
 * refusal per provider, so the next spent allowance on any Claude account overwrites it. It answers "when did
 * this last happen"; this answers "which accounts may not be sent a turn". */

const SeatRefusalSchema = z.object({
    // Epoch MS of the FIRST refusal, kept across every later one (see `refuse`) — the only record of how long a
    // seat has been off, since the log line beside it rotates away.
    at: z.number(),
    // The provider's own sentence, verbatim: the only part that names what an admin has to switch back on. It is
    // what the account row shows, so it is stored rather than re-derived.
    reason: z.string(),
});
export type SeatRefusal = z.infer<typeof SeatRefusalSchema>;

const StoredSeatsSchema = z.record(z.string(), SeatRefusalSchema);

export interface ClaudeSeatStore {
    // Every account whose organization has refused it, keyed by account id.
    readonly read: () => Promise<Record<string, SeatRefusal>>;
    readonly refuse: (id: string, reason: string) => Promise<void>;
    /* Back in the rotation. Two callers, one meaning: a turn ANSWERED on the account (so an admin re-enabling the
     * seat needs no reconnect and no button — the next pinned turn proves it), or the account was disconnected
     * (a reconnect mints a fresh id, so an entry left behind here is orphaned for good). */
    readonly clear: (id: string) => Promise<void>;
}

export const fileClaudeSeatStore = (path: string, logger: Logger): ClaudeSeatStore => {
    const file = jsonFile<Record<string, SeatRefusal>>(path, {
        parse: (raw) => StoredSeatsSchema.safeParse(raw).data,
        fallback: () => ({}),
    });
    return {
        read: file.read,
        // Idempotent: a second refusal on an account already refused rewrites nothing, which keeps the timestamp
        // the first one earned. The transition is carried out of the change function because it is the half worth
        // logging — a repeat says nothing, and this line is how a silently re-routed fleet is explained later.
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
                logger.warn({ account: id, reason }, "claude account cannot serve Claude Code — taking it out of the rotation");
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
