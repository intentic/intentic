import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import type { Pairing } from "@intentic/sandbox-contract/schemas/account-routes";
import { z } from "zod";
import { defineDocument } from "../store/evolution/documents.js";
import { openDocument } from "../store/open-document.js";

/* THE PAIRINGS THIS SANDBOX KEEPS FOR OTHERS (2026-11-24, docs/architecture/account-routing.md). A sandbox may route as a
 * person into this one for any scope but a report only beside the secret that person minted here for it: the platform's
 * pass says who the person is, and the platform alone could sign any pass, so its word opens nothing but an inbox.
 * Keyed by (asking sandbox's tunnel id, person), each the SHA-256 of a random 32-byte secret: the secret itself is shown
 * once, to the person's own editor, and never kept here. On the history volume, out of every turn's reach, and not on the
 * member row, since the owner has none. */

const PairingRowSchema = z.object({
    from: z.string(),
    fromName: z.string(),
    // Lower-cased.
    person: z.string(),
    // SHA-256 of the secret, hex.
    hash: z.string(),
    createdAt: z.number(),
});

export const accountPairingsDocument = defineDocument({
    root: "history",
    path: "account-pairings.json",
    // Hashes of secrets other sandboxes hold: a credential's other half, so it travels only when the owner says so.
    portability: "secret",
    schema: z.object({ pairings: z.array(PairingRowSchema) }),
});

const hashOf = (secret: string): string => createHash("sha256").update(secret, "utf8").digest("hex");
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export interface PairingsStore {
    // Mints a secret for (from, person), replacing one they held, and answers it: the only time it is ever said.
    readonly mint: (pairing: { readonly from: string; readonly fromName: string; readonly person: string }, now: number) => Promise<{ secret: string; createdAt: number }>;
    // The pairings, without their hashes: one person's, or everyone's.
    readonly list: (person?: string) => Promise<Pairing[]>;
    // True when one was there to remove.
    readonly revoke: (from: string, person: string) => Promise<boolean>;
    // Whether `secret` is the one minted for (from, person), compared in constant time.
    readonly verify: (from: string, person: string, secret: string | undefined) => Promise<boolean>;
}

export const filePairingsStore = (historyRoot: string): PairingsStore => {
    const file = openDocument(accountPairingsDocument, join(historyRoot, accountPairingsDocument.path), {
        fallback: () => ({ pairings: [] }),
        mode: 0o600,
        onUnreadable: "refuse",
    });
    const matches = (from: string, person: string) => (row: { readonly from: string; readonly person: string }) => row.from === from && same(row.person, person);
    return {
        mint: async ({ from, fromName, person }, now) => {
            const secret = randomBytes(32).toString("base64url");
            const row = { from, fromName, person: person.toLowerCase(), hash: hashOf(secret), createdAt: now };
            await file.update((current) => ({ pairings: [...current.pairings.filter((held) => !matches(from, person)(held)), row] }));
            return { secret, createdAt: now };
        },
        list: async (person) =>
            (await file.read()).pairings
                .filter((row) => person === undefined || same(row.person, person))
                .map(({ hash: _hash, ...pairing }) => pairing),
        revoke: async (from, person) => {
            let found = false;
            await file.update((current) => {
                const kept = current.pairings.filter((row) => !matches(from, person)(row));
                found = kept.length !== current.pairings.length;
                return found ? { pairings: kept } : current;
            });
            return found;
        },
        verify: async (from, person, secret) => {
            if (secret === undefined || secret === "") {
                return false;
            }
            const row = (await file.read()).pairings.find(matches(from, person));
            return row !== undefined && timingSafeEqual(Buffer.from(row.hash, "hex"), Buffer.from(hashOf(secret), "hex"));
        },
    };
};
