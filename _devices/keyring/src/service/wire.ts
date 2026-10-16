import { z } from "zod";

// What crosses the door for a typing: the focus as policy reads it, and what a typist answers.
export const FocusSchema = z.object({ program: z.string(), path: z.string(), field: z.enum(["password", "text", "unknown"]) }).strict();

export const InspectedSchema = z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), seen: z.object({ focus: FocusSchema, handle: z.string() }) }),
    z.object({ ok: z.literal(false), reason: z.string() }),
]);

export const TypedSchema = z.discriminatedUnion("ok", [z.object({ ok: z.literal(true) }), z.object({ ok: z.literal(false), reason: z.string(), partly: z.boolean() })]);

export const SignedSchema = z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), signature: z.string() }),
    z.object({ ok: z.literal(false), cancelled: z.boolean(), reason: z.string() }),
]);

export const TypedPassphraseSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("answered"), passphrase: z.string() }),
    z.object({ kind: z.literal("cancelled") }),
    z.object({ kind: z.literal("unavailable"), reason: z.string() }),
]);
