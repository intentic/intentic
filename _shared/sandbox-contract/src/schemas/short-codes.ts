// short codes: the single-use 8-character code a copy-paste command carries instead of a token. The sandbox mints one
// beside each device or sync token it hands out; the install script redeems it at the sandbox's public
// POST /system/redeem/<code>, which answers `KEY=value` lines (KIND, SANDBOX_URL, then the kind's own values).
import { z } from "zod";

// Crockford base32 (no I, L, O, U), 8 characters: 40 bits. Redemption accepts any case and one hyphen in the middle.
export const SHORT_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const SHORT_CODE_LENGTH = 8;
export const ShortCodeSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{8}$/);

// What each kind of code redeems to, in its answer's KIND line.
export const ShortCodeKindSchema = z.enum(["device", "sync"]);
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

// What POST /system/<door>/pair answers on any peer door (device, browser, phone, runner): the token, and the short code
// only the device door mints beside it. `expiresIn` is optional on read since a reader meets daemons older than the
// field; the editor then shows the token without a countdown.
export const PeerPairingAnswerSchema = PairingAnswerSchema.partial({ code: true, expiresIn: true });
export type PeerPairingAnswer = z.infer<typeof PeerPairingAnswerSchema>;

// POST /system/sync/pair: the pairing with the mode the daemon granted, which may be less than the one asked for (a
// member's "sync" comes back "mirror"), and the code that stands for it.
export const SyncPairAnswerSchema = PeerPairingAnswerSchema.extend({ mode: z.enum(["sync", "mirror"]).optional() });
export type SyncPairAnswer = z.infer<typeof SyncPairAnswerSchema>;

// POST /system/sync/pair's optional body: the person's chosen local folder and takeover, handed out with the code.
// It goes to their own sandbox, never the platform.
export const SyncPairRequestSchema = z.object({
    syncDir: lineValue.optional().describe("Local folder to sync, as the person chose it (`~` expanded on the device)."),
    takeover: z.boolean().optional().describe("Take sync over from another machine already enrolled."),
});
export type SyncPairRequest = z.infer<typeof SyncPairRequestSchema>;
