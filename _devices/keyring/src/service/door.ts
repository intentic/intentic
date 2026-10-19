import { z } from "zod";
import type { KeyringRequest } from "../protocol.js";
import {
    type AvailableSchema,
    type EnrolledSchema,
    FocusSchema,
    type InspectedSchema,
    type SignedSchema,
    type TypedPassphraseSchema,
    type TypedSchema,
    type TypedValueSchema,
    type ChosenSchema,
} from "./wire.js";

// THE DOOR: how this user's programs and the session helper reach the protected service. On Windows a named pipe the
// service (LOCAL SERVICE) created would refuse the user's writes, and Node cannot give it another access list, so the
// service listens on loopback instead and writes where (`port`) and a random token (`token`) to a door file only this
// user can read. On Linux it is a unix socket (`socket`) in a folder only the service and this uid may enter
// (service-run-linux.ts), with the same token beside it. Every connection opens with one line naming the token and what it is:
// - `request`: one keyring request line follows (protocol.ts), one answer line comes back. The session helper forwards
//   the user's pipe this way, so intentic-machine and intentic-askpass reach the service exactly as they reached the
//   per-user keyring before it.
// - `helper`: the session helper's own long-lived connection. The service challenges it, and it must prove a person is
//   at this session (a Windows Hello signature, a polkit yes, or the recovery key) before it is sent a prompt to show or
//   a value to type; after that the service sends it calls, one at a time, each answered on its own line. Before setup
//   there is no vault to protect and nothing to prove with, so the challenge is `unset` and the helper is let in to
//   enrol Windows Hello.
// The token keeps other users of the computer out; it does not keep out this user's own programs, which is why every
// value still needs a sandbox's grant or a person's yes.

const DOOR_TOKEN = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
export const DoorFileSchema = z.union([
    z.object({ port: z.number().int().min(1).max(65535), token: DOOR_TOKEN, pid: z.number().int().positive() }).strict(),
    z.object({ socket: z.string().startsWith("/").max(200), token: DOOR_TOKEN, pid: z.number().int().positive() }).strict(),
]);
export type DoorFile = z.infer<typeof DoorFileSchema>;

export const OpeningSchema = z.object({ door: z.string(), as: z.enum(["request", "helper"]) }).strict();
export type Opening = z.infer<typeof OpeningSchema>;

// The service's challenge to a helper: sign this with the vault's Hello credential; name your process, for the service
// to ask polkit about (Linux); give the recovery key; or nothing yet, before setup.
export const ChallengeSchema = z.discriminatedUnion("method", [
    z.object({ method: z.literal("hello"), credential: z.string().min(1).max(128), challenge: z.string().min(1).max(200) }).strict(),
    z.object({ method: z.literal("polkit") }).strict(),
    z.object({ method: z.literal("passphrase") }).strict(),
    z.object({ method: z.literal("unset") }).strict(),
]);
export type Challenge = z.infer<typeof ChallengeSchema>;

export const ProofSchema = z.discriminatedUnion("method", [
    z.object({ method: z.literal("hello"), signature: z.string().min(1).max(4096) }).strict(),
    z.object({ method: z.literal("polkit"), pid: z.number().int().positive() }).strict(),
    z.object({ method: z.literal("passphrase"), passphrase: z.string().min(1).max(1024) }).strict(),
    z.object({ method: z.literal("unset") }).strict(),
    z.object({ method: z.literal("declined") }).strict(),
]);
export type Proof = z.infer<typeof ProofSchema>;

// What the service asks of the helper once it is in.
export const HelperCallSchema = z.discriminatedUnion("call", [
    // Show `title`/`message` and get a Hello signature over `challenge` with `credential`.
    z.object({ id: z.number().int(), call: z.literal("sign"), credential: z.string().min(1).max(128), challenge: z.string().min(1).max(200), title: z.string(), message: z.string() }).strict(),
    // Show `title`/`message` and get the keyring's passphrase.
    z.object({ id: z.number().int(), call: z.literal("passphrase"), title: z.string(), message: z.string() }).strict(),
    // Whether Windows Hello can sign in this session: asked before setup, when the service has no Hello key pinned yet.
    z.object({ id: z.number().int(), call: z.literal("hello-available") }).strict(),
    // Create the vault's Hello credential and sign `challenge` with it: setup's first gesture, only while nothing is pinned.
    z.object({ id: z.number().int(), call: z.literal("enrol"), credential: z.string().min(1).max(128), challenge: z.string().min(1).max(200), title: z.string(), message: z.string() }).strict(),
    // Show the type-once box (consent.ts ValuePrompt) and answer what the person typed in it.
    z
        .object({
            id: z.number().int(),
            call: z.literal("value"),
            title: z.string(),
            message: z.string(),
            remember: z.boolean(),
            username: z.object({ value: z.string().max(300).optional() }).strict().optional(),
        })
        .strict(),
    // Show the choice dialog (consent.ts ChoicePrompt: an agent's need) and answer the id of the button pressed.
    z
        .object({
            id: z.number().int(),
            call: z.literal("choice"),
            title: z.string(),
            message: z.string(),
            choices: z.array(z.object({ id: z.string().max(64), label: z.string().max(100) }).strict()).min(1).max(8),
        })
        .strict(),
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
export type HelperReply =
    | z.infer<typeof SignedSchema>
    | z.infer<typeof TypedPassphraseSchema>
    | z.infer<typeof InspectedSchema>
    | z.infer<typeof TypedSchema>
    | z.infer<typeof AvailableSchema>
    | z.infer<typeof EnrolledSchema>
    | z.infer<typeof TypedValueSchema>
    | z.infer<typeof ChosenSchema>;

// Everything that crosses the door, in either direction.
export type DoorMessage =
    | Opening
    | KeyringRequest
    | Challenge
    | Proof
    | HelperCall
    | { readonly id: number; readonly reply: HelperReply }
    | { readonly ok: boolean; readonly reason?: string };
