import { randomBytes, randomUUID } from "node:crypto";
import { type GrantedRole, GrantedRoleSchema } from "@intentic/sandbox-contract";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { z } from "zod";
import { jsonFile } from "../store/json-file.js";
import { objectParse } from "../store/unknown-keys.js";
import { tokenEquals } from "./auth.js";

/* JOIN LINKS — how a person from OUTSIDE gets access to this sandbox without the platform brokering it.
 *
 * The platform's invite is an email, an account and a row in its database; this is the same grant made where
 * it is actually enforced. The owner mints a link, sends it however they like, and the person who opens it
 * signs in with Google and lands on the members list — the one list this daemon has always checked.
 *
 * SO A LINK GRANTS, AND THE SIGN-IN IDENTIFIES. Those are deliberately separate jobs. The secret in the link
 * says what role its holder may have; Google says who they are. Nothing here ever authorizes a REQUEST — the
 * only thing redemption does is add a verified email to the members list, after which every later call takes
 * the ordinary bearer path (auth.ts) and every existing role floor applies unchanged. That is what keeps this
 * from being a second way in: there is still exactly one, and this widens who is on it.
 *
 * Modelled on control-tokens.ts, whose shape earned its keep: hashed at rest (the raw `ijl_…` is returned once
 * at mint), revocable per link, and persisted in /work/.intentic so it survives a rebuild with the workspace.
 *
 * REDEMPTION IS PER PERSON, NOT PER OPENING. A link records the emails that came in through it, and one of
 * them opening it again is free — a second device, a re-login, a forwarded tab. `maxUses` therefore bounds
 * PEOPLE, which is what an owner means by "this link is for one person", and it makes the count something the
 * owner can read as a guest list rather than as traffic.
 */

const StoredLinksSchema = z.object({
    links: z.array(
        z.object({
            id: z.string(),
            label: z.string(),
            role: GrantedRoleSchema,
            hash: z.string(),
            createdAt: z.number(),
            // Absent = no expiry. An owner who wants a link to die on its own says so at mint.
            expiresAt: z.number().optional(),
            // Absent = unbounded. Counts distinct people (see the header), never openings.
            maxUses: z.number().optional(),
            redeemedBy: z.array(z.string()),
        }),
    ),
});
type StoredLinks = z.infer<typeof StoredLinksSchema>;

export interface JoinLinkSummary {
    readonly id: string;
    readonly label: string;
    readonly role: GrantedRole;
    readonly createdAt: number;
    readonly expiresAt?: number;
    readonly maxUses?: number;
    // Who came in through this link — the owner's guest list, and the reason redemption is recorded at all.
    readonly redeemedBy: readonly string[];
}

// Why a redemption was refused, in the words the visitor is actually told. Distinguished on purpose: "ask for
// a new link" and "that is not a link" are different actions for the person holding it, and a 32-byte secret
// is not something an outsider guesses their way into knowing which they hit.
export type JoinRefusal = "unknown" | "expired" | "full";

export type JoinOutcome = { readonly ok: true; readonly role: GrantedRole } | { readonly ok: false; readonly reason: JoinRefusal };

export interface JoinLinks {
    // Returns the RAW secret once — only its sha256 is persisted.
    readonly mint: (args: { label: string; role: GrantedRole; expiresAt?: number; maxUses?: number }) => Promise<{ id: string; secret: string }>;
    /* Redeem for a VERIFIED email (the caller has already checked Google's signature — this never sees a
     * token). Idempotent for an email already on the link, which is what makes re-opening free. */
    readonly redeem: (secret: string, email: string, now: number) => Promise<JoinOutcome>;
    readonly list: () => Promise<JoinLinkSummary[]>;
    readonly revoke: (id: string) => Promise<boolean>;
}

const summarize = (link: StoredLinks["links"][number]): JoinLinkSummary => ({
    id: link.id,
    label: link.label,
    role: link.role,
    createdAt: link.createdAt,
    ...(link.expiresAt === undefined ? {} : { expiresAt: link.expiresAt }),
    ...(link.maxUses === undefined ? {} : { maxUses: link.maxUses }),
    redeemedBy: link.redeemedBy,
});

export const fileJoinLinks = (path: string): JoinLinks => {
    const file = jsonFile<StoredLinks>(path, {
        parse: objectParse(StoredLinksSchema),
        fallback: () => ({ links: [] }),
    });
    return {
        mint: async ({ label, role, expiresAt, maxUses }) => {
            const secret = `ijl_${randomBytes(32).toString("base64url")}`;
            const id = randomUUID();
            await file.update((stored) => ({
                links: [
                    ...stored.links,
                    {
                        id,
                        label,
                        role,
                        hash: sha256Hex(secret),
                        createdAt: Date.now(),
                        ...(expiresAt === undefined ? {} : { expiresAt }),
                        ...(maxUses === undefined ? {} : { maxUses }),
                        redeemedBy: [],
                    },
                ],
            }));
            return { id, secret };
        },
        /* The whole verdict is computed INSIDE one update, so two people opening the last seat of a link at the
         * same moment cannot both be let in: the store serializes read-modify-write, and the second attempt
         * sees the first one's email already recorded. */
        redeem: async (secret, email, now) => {
            if (secret === "") {
                return { ok: false, reason: "unknown" };
            }
            const hash = sha256Hex(secret);
            let outcome: JoinOutcome = { ok: false, reason: "unknown" };
            await file.update((stored) => {
                // Comparing fixed-length hex digests keeps the comparison timing-safe regardless of input length.
                const link = stored.links.find((entry) => tokenEquals(entry.hash, hash));
                if (link === undefined) {
                    return stored;
                }
                if (link.expiresAt !== undefined && link.expiresAt <= now) {
                    outcome = { ok: false, reason: "expired" };
                    return stored;
                }
                // Already came in through this link: hand back the same role and write nothing. Checked before
                // the seat count so the last guest can always reopen their own link.
                if (link.redeemedBy.includes(email)) {
                    outcome = { ok: true, role: link.role };
                    return stored;
                }
                if (link.maxUses !== undefined && link.redeemedBy.length >= link.maxUses) {
                    outcome = { ok: false, reason: "full" };
                    return stored;
                }
                outcome = { ok: true, role: link.role };
                return {
                    links: stored.links.map((entry) => (entry.id === link.id ? { ...entry, redeemedBy: [...entry.redeemedBy, email] } : entry)),
                };
            });
            return outcome;
        },
        list: async () => (await file.read()).links.map(summarize),
        revoke: async (id) => {
            let revoked = false;
            await file.update((stored) => {
                const next = stored.links.filter((entry) => entry.id !== id);
                revoked = next.length !== stored.links.length;
                // Unchanged by reference when nothing matched, so revoking an absent id writes nothing.
                return revoked ? { links: next } : stored;
            });
            return revoked;
        },
    };
};
