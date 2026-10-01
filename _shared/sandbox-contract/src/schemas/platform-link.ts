import { z } from "zod";

// THE DAEMON'S LINK WITH THE PLATFORM, as /health reports it (`announce`) and as the owner's Reconnect renews it (POST
// /platform/relink). The one link nothing outside the container can probe: whether this daemon's registration was
// taken, and, when it was refused, whether the platform has no record of the sandbox (`unknown`, which a platform that
// forgot it says too) or deleted it (`deleted`). `ic sandbox doctor`, the setup wizard and the editor's recovery screen
// read it.
export const AnnounceStateSchema = z.object({
    // off: nothing to register with; pending: the first attempt is in flight; registered: the platform took it;
    // rejected: it answered no; unreachable: it could not be reached.
    state: z.enum(["off", "pending", "registered", "rejected", "unreachable"]),
    // Why, for the failing states, already in the owner's terms.
    detail: z.string().optional(),
    // On a failing state: false only once the platform said the sandbox was deleted; every other failure is retried.
    retrying: z.boolean().optional(),
    // Which no: `unknown` the platform has no record of this sandbox, and its owner's Reconnect can have it adopted;
    // `deleted` it holds a deletion record, which ends the retrying.
    reason: z.enum(["unknown", "deleted"]).optional(),
    // The identity of the database that took the registration (the platform's GET /api/identity), when it said.
    identity: z.string().optional(),
    // When this state was last confirmed, ms since epoch.
    at: z.number().optional(),
});
export type AnnounceState = z.infer<typeof AnnounceStateSchema>;

// The owner's Reconnect: registers now, and with a ticket (the platform's adoption ticket, carried opaque), first asks a
// platform that has no record of the sandbox to make one (its POST /sandbox/adopt). `name` and `image` are what the
// owner's browser remembers of it, since only the platform held them.
export const RelinkRequestSchema = z.object({
    ticket: z.string().min(1).optional(),
    name: z.string().max(60).optional(),
    image: z.string().max(150_000).optional(),
});
export type RelinkRequest = z.infer<typeof RelinkRequestSchema>;

export const RelinkAnswerSchema = z.object({
    announce: AnnounceStateSchema,
    // What the platform said to the adoption, when one was asked for and needed: its HTTP status (0 when it could not
    // be reached) and its reason, in the owner's terms.
    adoption: z.object({ status: z.number(), detail: z.string() }).optional(),
});
export type RelinkAnswer = z.infer<typeof RelinkAnswerSchema>;
