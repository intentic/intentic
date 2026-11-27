import { SANDBOX_ID } from "@intentic/sandbox-contract/ids/sandbox-id";
import { z } from "zod";
import { IngressOkSchema } from "./ingress-schemas.js";

/* WAKE DOORS (2026-11-27): how a request reaches a hosted sandbox that sleeps. Before it sleeps, the daemon names the
 * public paths a request may wake it at, each with the SHA-256 of a secret the request carries (a webhook's fire token,
 * or the wake secret it minted for an extension's route), on the alarm it saves anyway (`wakeAlarm`). The platform keeps
 * only those digests. While the machine holds no tunnel, the edge hashes what a plain request carries that could be one
 * (every query value and a bearer token) and asks the platform (`requestWake`); the secret itself never leaves the edge. */
export const WAKE_DOORS_MAX = 64;
// The longest path a door names, and the most digests one request is asked with.
export const WAKE_DOOR_PATH_MAX = 512;
export const WAKE_DIGESTS_MAX = 16;
const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/u);

// A path prefix as the request carries it (percent-encoding included); it covers a request's path that equals it or
// continues it past a `/`.
export const WakeDoorSchema = z.object({
    path: z
        .string()
        .max(WAKE_DOOR_PATH_MAX)
        .regex(/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/u),
    digest: Sha256HexSchema,
});
export type WakeDoor = z.infer<typeof WakeDoorSchema>;

// Whether a request's path is a door's: the same path, or one continuing it past a segment boundary.
export const wakeDoorCovers = (door: Pick<WakeDoor, "path">, path: string): boolean =>
    path === door.path || path.startsWith(door.path.endsWith("/") ? door.path : `${door.path}/`);

// A hosted daemon must obtain this durable alarm's acknowledgement before stopping. Null cancels its previous alarm.
// `personAt` is the last moment a person was here since that boot (0 or absent for none): what the free lane's idle
// collection measures from, since a boot the alarm made is not somebody opening it (api hosted-idle.ts).
// `doors` (2026-11-27): the wake doors it sleeps with. The list replaces the one stored, `[]` clears it, and absent (a
// daemon from before doors) leaves it as it stands. A list that does not parse reads as absent, so the alarm beside it is
// never refused for it.
export const WakeAlarmBodySchema = z.object({
    at: z.number().int().positive().max(8_640_000_000_000_000).nullable(),
    personAt: z.number().int().nonnegative().max(8_640_000_000_000_000).optional(),
    doors: z.array(WakeDoorSchema).max(WAKE_DOORS_MAX).optional().catch(undefined),
});

// What the platform answers a daemon saving its alarm. `requestWake` (2026-11-27) says the platform started this machine
// for a request at one of its wake doors and this is the boot's first word since: the daemon sleeps again after the
// alarm's short grace when no person comes (idle-stop.ts). Absent from a platform from before it, and false otherwise.
export const WakeAlarmAnswerSchema = IngressOkSchema.extend({ requestWake: z.boolean().optional() });

// The edge asking whether a plain request to a sandbox holding no tunnel may wake it (`requestWake`, under the platform
// token): the sandbox its Host names, the request's path as it arrived, and the SHA-256 (hex) of each value it carries
// that could be a door's secret (query values and a bearer token), never the values.
export const RequestWakeBodySchema = z.object({
    sandboxId: z.string().regex(SANDBOX_ID),
    path: z.string().min(1).max(2_048),
    digests: z.array(Sha256HexSchema).max(WAKE_DIGESTS_MAX),
});
// `waking`: a start is under way (begun now, or one still booting), so the sender should come back in `retryAfter`
// seconds. `listening`: whether the sandbox has any wake door registered at all; false lets the edge stop asking about it
// for a while. A request no door covers changes nothing.
export const RequestWakeAnswerSchema = z.object({
    waking: z.boolean(),
    listening: z.boolean(),
    retryAfter: z.number().int().positive().max(3_600).optional(),
});
export type RequestWakeAnswer = z.infer<typeof RequestWakeAnswerSchema>;
