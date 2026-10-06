// Named imports rather than the `z` namespace: this module is bundled into the browser extension (through the
// `./webext` entry), where the namespace keeps zod's locales. _devices/webext/scripts/size-budget.mjs holds the ceiling.
import { object, string } from "zod";
import type * as z from "zod";

// What POST /system/<door>/enroll answers once it redeems a pairing (peers/peer-routes.ts): the id the pairing was bound
// to and the durable token the peer presents from then on. A door may add fields of its own beside them; a reader
// needs only these two. A 401 is the expired-or-spent pairing, a 5xx a sandbox not ready yet. The sync key's door is
// a different route with its own answer (SyncEnrollmentAnswerSchema in devices.ts).
export const PeerEnrollmentAnswerSchema = object({
    id: string(),
    token: string().min(1),
});
export type PeerEnrollmentAnswer = z.infer<typeof PeerEnrollmentAnswerSchema>;
