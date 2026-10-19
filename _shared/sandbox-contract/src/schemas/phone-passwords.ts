import { z } from "zod";
import {
    KeyringCaptureItemSchema,
    KeyringCaptureResultSchema,
    KeyringPhoneFillResultSchema,
    KeyringPhoneKeysSchema,
    KeyringPhonePairResultSchema,
    KeyringPublicKeySchema,
    SignedKeyringPhoneFillSchema,
} from "./keyring.js";

// THE PHONE'S WAY TO THE OWNER'S PASSWORDS (2026-10-19): the Intentic Device app as Android's autofill service, saving
// what the person signs in with and filling it back, against the keyrings on the owner's computers. The phone door is
// the sandbox asking and the phone answering (phone-protocol.ts); these go the other way, so they are plain HTTPS
// requests from the app to its sandbox, authorised by the phone's enrollment token (`Authorization: Bearer <token>`),
// and the sandbox relays each to the named computer's keyring over that computer's device link. What rides is sealed
// end to end: a capture to the keyring's inbox key, a fill's answer to the phone's own seal key.

export const PHONE_PASSWORDS_PATHS = {
    keyrings: "/system/phones/passwords/keyrings",
    pair: "/system/phones/passwords/pair",
    capture: "/system/phones/passwords/capture",
    fill: "/system/phones/passwords/fill",
} as const;

/** One of the owner's computers whose keyring the phone can save to and fill from. */
export const PhoneKeyringSchema = z.object({
    device: z.string().min(1).max(128).describe("The computer, by its device card."),
    label: z.string().describe("The computer's name for people."),
    online: z.boolean(),
    locked: z.boolean().optional(),
    inbox: KeyringPublicKeySchema.optional().describe("What a capture is sealed to. Absent until the keyring is set up."),
    remember: z.boolean().describe("Whether the person turned on remembering from the phone on that computer."),
    paired: z.boolean().describe("Whether this phone's keys are pinned there, so it can fill."),
});
export type PhoneKeyring = z.infer<typeof PhoneKeyringSchema>;

// GET keyrings → the owner's keyrings this sandbox can reach.
export const PhoneKeyringsResultSchema = z.object({ keyrings: z.array(PhoneKeyringSchema) });

// POST pair → the computer's keyring asks its person, showing the phone's fingerprint; the phone shows the keyring's.
export const PhonePasswordsPairSchema = z.object({ keyring: z.string().min(1).max(128), phone: KeyringPhoneKeysSchema }).strict();
export const PhonePasswordsPairResultSchema = KeyringPhonePairResultSchema;

// POST capture → onSaveRequest's credential, sealed on the phone for `{ kind: "capture", via, at }`.
export const PhonePasswordsCaptureSchema = z.object({ keyring: z.string().min(1).max(128), item: KeyringCaptureItemSchema }).strict();
export const PhonePasswordsCaptureResultSchema = KeyringCaptureResultSchema;

// POST fill → after the person's fingerprint signed the request with the presence key.
export const PhonePasswordsFillSchema = z.object({ keyring: z.string().min(1).max(128), fill: SignedKeyringPhoneFillSchema }).strict();
export const PhonePasswordsFillResultSchema = KeyringPhoneFillResultSchema;
