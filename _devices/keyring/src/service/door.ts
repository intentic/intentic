import { z } from "zod";
import type { KeyringRequest } from "../protocol.js";
import { FocusSchema, type InspectedSchema, type SignedSchema, type TypedPassphraseSchema, type TypedSchema } from "./wire.js";

// THE DOOR: how this user's programs and the session helper reach the hardened service. A named pipe the service (LOCAL
// SERVICE) created would refuse the user's writes, and Node cannot give it another access list, so the service listens
// on loopback instead and writes where (`port`) and a random token (`token`) to a door file only this user can read.
// Every connection opens with one line naming the token and what it is:
// - `request`: one keyring request line follows (protocol.ts), one answer line comes back. The session helper forwards
//   the user's pipe this way, so intentic-machine and intentic-askpass reach a hardened keyring exactly as before.
// - `helper`: the session helper's own long-lived connection. The service challenges it, and it must answer with a
//   Windows Hello signature (or the passphrase) before it is sent a prompt to show or a value to type; after that the
//   service sends it `ask`, `inspect` and `type` calls, one at a time, each answered on its own line.
// The token keeps other users of the computer out; it does not keep out this user's own programs, which is why every
// value still needs a sandbox's grant or a person's yes, as in plain mode.

export const DoorFileSchema = z.object({ port: z.number().int().min(1).max(65535), token: z.string().regex(/^[A-Za-z0-9_-]{43}$/u), pid: z.number().int().positive() }).strict();
export type DoorFile = z.infer<typeof DoorFileSchema>;

export const OpeningSchema = z.object({ door: z.string(), as: z.enum(["request", "helper"]) }).strict();
export type Opening = z.infer<typeof OpeningSchema>;

// The service's challenge to a helper: sign this with the vault's Hello credential, or give the passphrase.
export const ChallengeSchema = z.discriminatedUnion("method", [
    z.object({ method: z.literal("hello"), credential: z.string().min(1).max(128), challenge: z.string().min(1).max(200) }).strict(),
    z.object({ method: z.literal("passphrase") }).strict(),
]);
export type Challenge = z.infer<typeof ChallengeSchema>;

export const ProofSchema = z.discriminatedUnion("method", [
    z.object({ method: z.literal("hello"), signature: z.string().min(1).max(4096) }).strict(),
    z.object({ method: z.literal("passphrase"), passphrase: z.string().min(1).max(1024) }).strict(),
    z.object({ method: z.literal("declined") }).strict(),
]);
export type Proof = z.infer<typeof ProofSchema>;

// What the service asks of the helper once it is in.
export const HelperCallSchema = z.discriminatedUnion("call", [
    // Show `title`/`message` and get a Hello signature over `challenge` with `credential`.
    z.object({ id: z.number().int(), call: z.literal("sign"), credential: z.string().min(1).max(128), challenge: z.string().min(1).max(200), title: z.string(), message: z.string() }).strict(),
    // Show `title`/`message` and get the keyring's passphrase.
    z.object({ id: z.number().int(), call: z.literal("passphrase"), title: z.string(), message: z.string() }).strict(),
    z.object({ id: z.number().int(), call: z.literal("inspect"), place: z.discriminatedUnion("kind", [z.object({ kind: z.literal("window") }), z.object({ kind: z.literal("android"), serial: z.string() })]) }).strict(),
    z
        .object({
            id: z.number().int(),
            call: z.literal("type"),
            place: z.discriminatedUnion("kind", [z.object({ kind: z.literal("window") }), z.object({ kind: z.literal("android"), serial: z.string() })]),
            seen: z.object({ focus: FocusSchema, handle: z.string() }),
            value: z.string(),
        })
        .strict(),
]);
export type HelperCall = z.infer<typeof HelperCallSchema>;

// What a helper answers a call with, by the call's kind.
export type HelperReply = z.infer<typeof SignedSchema> | z.infer<typeof TypedPassphraseSchema> | z.infer<typeof InspectedSchema> | z.infer<typeof TypedSchema>;

// Everything that crosses the door, in either direction.
export type DoorMessage =
    | Opening
    | KeyringRequest
    | Challenge
    | Proof
    | HelperCall
    | { readonly id: number; readonly reply: HelperReply }
    | { readonly ok: boolean; readonly reason?: string };
