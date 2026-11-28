import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import type { Pairing } from "@intentic/sandbox-contract/schemas/account-routes";
import { z } from "zod";
import { opt } from "../opt.js";
import { UPGRADE_REPEAT_MS, type UpgradedMark } from "../s2s/contacts/contact-upgrade.js";
import { defineDocument } from "../store/evolution/documents.js";
import { openDocument } from "../store/open-document.js";

/* THE PAIRINGS THIS SANDBOX KEEPS FOR OTHERS (2026-11-24, docs/architecture/account-routing.md). A sandbox may route as a
 * person into this one for any scope but a report only beside the secret that person minted here for it: the platform's
 * pass says who the person is, and the platform alone could sign any pass, so its word opens nothing but an inbox.
 * Keyed by (asking sandbox's tunnel id, person), each the SHA-256 of a random 32-byte secret: the secret itself is shown
 * once, to the person's own editor, and never kept here. On the history volume, out of every turn's reach, and not on the
 * member row, since the owner has none.
 * A pairing upgraded into a person-scoped contact (2026-11-27, messages.md "Across versions") is no pairing any more: it
 * admits nothing and is listed nowhere. Its row stays as a marker naming the contact and the key it vouched for, so a
 * repeat of the upgrade under the same secret (the asking side never heard the first answer) reads that answer again for
 * fifteen minutes, at the upgrade door alone; after that the secret opens nothing. */

const PairingRowSchema = z.object({
    from: z.string(),
    fromName: z.string(),
    // Lower-cased.
    person: z.string(),
    // SHA-256 of the secret, hex.
    hash: z.string(),
    createdAt: z.number(),
    // Set once the pairing became a person-scoped contact here (pairing-upgrade.ts): the contact's id, when, and the key the
    // secret vouched for (absent on one upgraded before it was kept, which answers no repeat).
    upgraded: z.object({ contact: z.string(), at: z.number(), fingerprint: z.string().optional() }).optional(),
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
    // Whether `secret` is the one minted for (from, person), compared in constant time. An upgraded pairing admits
    // nothing, unless `upgraded` (the time it is asked at) asks for the upgrade door's own repeat, within its fifteen minutes.
    readonly verify: (from: string, person: string, secret: string | undefined, options?: { readonly upgraded?: number }) => Promise<boolean>;
    // The pairing (from, person) is a contact now: it stops admitting, and stays only to answer a repeat of the upgrade.
    readonly markUpgraded: (from: string, person: string, mark: UpgradedMark) => Promise<void>;
    // What the pairing (from, person) became, once it was upgraded.
    readonly upgradedOf: (from: string, person: string) => Promise<UpgradedMark | undefined>;
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
                .filter((row) => row.upgraded === undefined && (person === undefined || same(row.person, person)))
                .map(({ hash: _hash, upgraded: _upgraded, ...pairing }) => pairing),
        revoke: async (from, person) => {
            let found = false;
            await file.update((current) => {
                const kept = current.pairings.filter((row) => !matches(from, person)(row));
                found = kept.length !== current.pairings.length;
                return found ? { pairings: kept } : current;
            });
            return found;
        },
        verify: async (from, person, secret, options = {}) => {
            if (secret === undefined || secret === "") {
                return false;
            }
            const row = (await file.read()).pairings.find(matches(from, person));
            const repeatable = row?.upgraded !== undefined && options.upgraded !== undefined && options.upgraded - row.upgraded.at <= UPGRADE_REPEAT_MS;
            return (
                row !== undefined &&
                (row.upgraded === undefined || repeatable) &&
                timingSafeEqual(Buffer.from(row.hash, "hex"), Buffer.from(hashOf(secret), "hex"))
            );
        },
        markUpgraded: async (from, person, mark) => {
            const upgraded = { contact: mark.contact, at: mark.at, ...opt("fingerprint", mark.fingerprint) };
            await file.update((current) => ({
                pairings: current.pairings.map((row) => (matches(from, person)(row) && row.upgraded === undefined ? { ...row, upgraded } : row)),
            }));
        },
        upgradedOf: async (from, person) => (await file.read()).pairings.find(matches(from, person))?.upgraded,
    };
};
