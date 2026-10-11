// short codes: the single-use 8-character code a copy-paste command carries instead of a token. The sandbox mints one
// beside each device, sync or server-connect token it hands out; the install script redeems it at the sandbox's public
// POST /system/redeem/<code>, which answers `KEY=value` lines (KIND, SANDBOX_URL, then the kind's own values).
import { z } from "zod";
import { INVENTORY_NAME_MAX, INVENTORY_NAME_RE } from "./inventory.js";

// Crockford base32 (no I, L, O, U), 8 characters: 40 bits. Redemption accepts any case and one hyphen in the middle.
export const SHORT_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const SHORT_CODE_LENGTH = 8;
export const ShortCodeSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{8}$/);

// What each kind of code redeems to, in its answer's KIND line.
export const ShortCodeKindSchema = z.enum(["device", "sync", "server"]);
export type ShortCodeKind = z.infer<typeof ShortCodeKindSchema>;

// A value that rides one `KEY=value` line: no line breaks or other control characters.
const lineValue = z
    .string()
    .min(1)
    .max(1024)
    .regex(/^[^\p{Cc}]+$/u);

// A device or sync pairing as minted: the token (unchanged) and, additively, the code that stands for it.
export const PairingAnswerSchema = z.object({
    token: z.string(),
    expiresIn: z.number().describe("Seconds until the token, and its code, expire."),
    code: ShortCodeSchema.describe("Single-use short code a command carries instead of the token."),
});
export type PairingAnswer = z.infer<typeof PairingAnswerSchema>;

// POST /system/sync/pair's optional body: the person's chosen local folder and takeover, handed out with the code.
// It goes to their own sandbox, never the platform.
export const SyncPairRequestSchema = z.object({
    syncDir: lineValue.optional().describe("Local folder to sync, as the person chose it (`~` expanded on the device)."),
    takeover: z.boolean().optional().describe("Take sync over from another machine already enrolled."),
});
export type SyncPairRequest = z.infer<typeof SyncPairRequestSchema>;

// POST /system/enroll/code: mints a server-connect code backed by a single-use enroll token.
export const EnrollCodeRequestSchema = z.object({
    hostName: z.string().min(1).max(INVENTORY_NAME_MAX).regex(INVENTORY_NAME_RE).optional().describe("What the server will be called."),
});
export type EnrollCodeRequest = z.infer<typeof EnrollCodeRequestSchema>;
export const EnrollCodeAnswerSchema = z.object({
    code: ShortCodeSchema,
    expiresIn: z.number().describe("Seconds until the code and its enroll token expire."),
});
export type EnrollCodeAnswer = z.infer<typeof EnrollCodeAnswerSchema>;
