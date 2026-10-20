import { join } from "node:path";
import { z } from "zod";
import { defineDocument } from "../store/evolution/documents.js";
import { openDocument } from "../store/open-document.js";

// Which of the owner's phones each computer's keyring paired with for Passwords, as this sandbox carried the pairing:
// what the phone's list of keyrings says as `paired`, so the app knows where it can fill without asking each computer.
// Only a pairing the keyring answered yes to is written; the keyring's own pinned keys are the record that counts, and
// this one only saves the phone a round trip. Owner-only on the history volume, like the phones' wake channels.

const PairingSchema = z.object({ phone: z.string(), keyring: z.string(), fingerprint: z.string(), at: z.number() });
const PhonePairingsFileSchema = z.object({ pairings: z.array(PairingSchema) });
type PhonePairingsFile = z.infer<typeof PhonePairingsFileSchema>;

export const phonePairingsDocument = defineDocument({
    root: "history",
    path: "phone-pairings.json",
    // Which computers' keyrings each phone paired with for Passwords: a shortcut over the keyrings' own pinned keys,
    // keyed by phones paired to this sandbox, so it stays with the pairings (peers/enrollment.ts).
    portability: "identity",
    schema: PhonePairingsFileSchema,
});

export interface PhonePairings {
    // The computers this phone is paired with.
    readonly of: (phone: string) => Promise<ReadonlySet<string>>;
    // A pairing the keyring said yes to; a second one for the same pair replaces the first.
    readonly add: (pairing: { readonly phone: string; readonly keyring: string; readonly fingerprint: string; readonly at: number }) => Promise<void>;
}

export const filePhonePairings = (historyRoot: string): PhonePairings => {
    const file = openDocument(phonePairingsDocument, join(historyRoot, phonePairingsDocument.path), {
        fallback: (): PhonePairingsFile => ({ pairings: [] }),
        mode: 0o600,
    });
    return {
        of: async (phone) => new Set((await file.read()).pairings.filter((pairing) => pairing.phone === phone).map((pairing) => pairing.keyring)),
        add: async (pairing) => {
            await file.update((current) => ({
                pairings: [...current.pairings.filter((kept) => kept.phone !== pairing.phone || kept.keyring !== pairing.keyring), { ...pairing }],
            }));
        },
    };
};

