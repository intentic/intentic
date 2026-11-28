import { errorMessage } from "@intentic/base/errors";
import { attestationIdOf, sandboxVouchOf, signAttestation, verifyAttestation } from "@intentic/sandbox-contract/s2s";
import {
    S2S_ATTESTATIONS_KEPT_MAX,
    type S2sAttestation,
    type S2sAttestationRow,
    type S2sAttestations,
    S2sAttestationSchema,
    type S2sClaims,
    S2sEnvelopeIdSchema,
    type S2sIdentityPrev,
    S2sRefSchema,
    type S2sSandboxVouch,
} from "@intentic/sandbox-contract/schemas/s2s";
import { z } from "zod";
import { opt } from "../../opt.js";
import { defineDocument } from "../../store/evolution/documents.js";
import type { JsonFile } from "../../store/json-file.js";
import { openDocument } from "../../store/open-document.js";
import { keySetOf } from "./identity-keys.js";
import type { IdentityCore, IdentityRefusal, S2sIdentity } from "./s2s-identity.js";

// THE ATTESTATIONS this sandbox's identity carries (docs/architecture/messages.md, "Attestations"): each one a contact
// signed about this sandbox and a person here added, after it verified against this sandbox's own document. The document
// lists those that hold when it is signed (current, about its key or the one before it), so one that lapses, or one a
// second rotation left behind, drops out at the next signing by itself; its row stays, listed with why, until a person
// removes it. One per issuer: a newer one from the same issuer replaces the older. And the other way: a vouch this
// sandbox signs for a contact, under its current key.

const AttestationRowSchema = z.object({
    attestation: S2sAttestationSchema,
    // The contact it came from and the message that carried it, in that contact's thread.
    contact: S2sRefSchema.optional(),
    message: S2sEnvelopeIdSchema.optional(),
    acceptedAt: z.number().int(),
});
export type AttestationRow = z.infer<typeof AttestationRowSchema>;

export const identityAttestationsDocument = defineDocument({
    root: "history",
    path: "s2s/identity-attestations.json",
    // About this sandbox's key: a copy elsewhere has another key, so none of them would hold there.
    portability: "identity",
    schema: z.object({ attestations: z.array(AttestationRowSchema).max(S2S_ATTESTATIONS_KEPT_MAX) }),
});

export const openIdentityAttestations = (path: string): JsonFile<{ attestations: AttestationRow[] }> =>
    openDocument(identityAttestationsDocument, path, { fallback: () => ({ attestations: [] }) });

// What a document about to be signed says of the sandbox: its id, its key, and the vouch that carried the key over.
export interface SignedAs {
    readonly sandbox: string;
    readonly fingerprint: string;
    readonly prev?: S2sIdentityPrev | undefined;
}

// Whether a stored vouch holds for the document about to be signed, its signature aside: that was checked when a person
// added it (addAttestation, below), and the file is the daemon's own, so signing a document checks nothing costlier.
const holds = (attestation: S2sAttestation, as: SignedAs, now: number): boolean => {
    const vouch = sandboxVouchOf(attestation);
    const keys = as.prev?.by === "key" ? [as.fingerprint, as.prev.fingerprint] : [as.fingerprint];
    return vouch !== undefined && vouch.subject.sandbox === as.sandbox && keys.includes(vouch.subject.fingerprint) && vouch.validUntil > now;
};

/** The attestations a document signed now carries: those that hold for it, in the order they were added. */
export const publishable = (rows: readonly AttestationRow[], as: SignedAs, now: number): readonly S2sAttestation[] =>
    rows.filter((row) => holds(row.attestation, as, now)).map((row) => row.attestation);

/** Each attestation's id, in order: what a document's signing key reads of them. */
export const idsOf = (attestations: readonly S2sAttestation[]): readonly string[] => attestations.map(attestationIdOf);

type AttestationChanges = Pick<S2sIdentity, "attestations" | "addAttestation" | "removeAttestation" | "issueVouch">;

const issuerOf = (attestation: S2sAttestation): string | undefined => sandboxVouchOf(attestation)?.issuer.fingerprint;

export const attestationChanges = (core: IdentityCore): AttestationChanges => {
    const { deps, attestationsFile } = core;

    // Every row as the Identity section lists it, newest first: checked whole against the document as served now.
    const list = async (): Promise<S2sAttestations> => {
        const doc = await core.document();
        const published = new Set((doc.attestations ?? []).map(attestationIdOf));
        const now = deps.now();
        const rows = (await attestationsFile.read()).attestations.toSorted((a, b) => b.acceptedAt - a.acceptedAt);
        return {
            attestations: rows.map((row): S2sAttestationRow => {
                const id = attestationIdOf(row.attestation);
                const check = verifyAttestation(row.attestation, doc, { now });
                return {
                    id,
                    attestation: row.attestation,
                    ...opt("contact", row.contact),
                    ...opt("message", row.message),
                    acceptedAt: row.acceptedAt,
                    verified: check.ok,
                    ...opt("problem", check.ok ? undefined : check.reason.slice(0, 500)),
                    published: published.has(id),
                };
            }),
        };
    };

    return {
        attestations: list,
        addAttestation: async (attestation, from) => {
            const check = verifyAttestation(attestation, await core.document(), { now: deps.now() });
            if (!check.ok) {
                return { refused: `that attestation does not verify against this sandbox's identity: ${check.reason}`, status: 409 };
            }
            const issuer = issuerOf(attestation);
            const at = deps.now();
            // Lapsed ones and the same issuer's earlier one go, so a renewal always has room.
            const stays = (row: AttestationRow): boolean => (sandboxVouchOf(row.attestation)?.validUntil ?? 0) > at && issuerOf(row.attestation) !== issuer;
            const row: AttestationRow = { attestation, ...opt("contact", from.contact), ...opt("message", from.message), acceptedAt: at };
            let full = false;
            await attestationsFile.update((file) => {
                const kept = file.attestations.filter(stays);
                full = kept.length >= S2S_ATTESTATIONS_KEPT_MAX;
                return full ? file : { attestations: [...kept, row] };
            });
            if (full) {
                return { refused: `this sandbox's identity already carries ${S2S_ATTESTATIONS_KEPT_MAX} attestations, as many as fit in its document: remove one first`, status: 409 };
            }
            return list();
        },
        removeAttestation: async (id) => {
            const rows = (await attestationsFile.read()).attestations;
            if (!rows.some((row) => attestationIdOf(row.attestation) === id)) {
                return { refused: `no attestation ${id.slice(0, 64)} is held here`, status: 404 } satisfies IdentityRefusal;
            }
            await attestationsFile.update((file) => ({ attestations: file.attestations.filter((row) => attestationIdOf(row.attestation) !== id) }));
            return list();
        },
        issueVouch: async (subject, claims: S2sClaims, validUntil) => {
            const self = deps.self();
            const doc = await core.document();
            const issuedAt = deps.now();
            try {
                const vouch: S2sSandboxVouch = signAttestation(
                    // A domain the document lists outlives a move between hosts, so it names the issuer where it has one.
                    { issuer: { sandbox: self.sandbox, address: doc.domains[0] ?? doc.host, name: self.name }, subject, claims, issuedAt, validUntil },
                    keySetOf((await core.keys()).current),
                );
                return vouch;
            } catch (error) {
                return { refused: errorMessage(error), status: 400 };
            }
        },
    };
};
