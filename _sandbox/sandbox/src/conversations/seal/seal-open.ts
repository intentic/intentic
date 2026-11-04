import { createHash, randomBytes } from "node:crypto";
import {
    SEAL_OPEN_HOURS,
    SEAL_PROOF_MAX_AGE_MS,
    type Seal,
    type SealOpen,
    type SealOpenCeremony,
    SealOpenDocumentSchema,
    sealOpenDocumentText,
} from "@intentic/sandbox-contract/schemas/seal";
import type { SealOpenProof } from "@intentic/sandbox-contract/schemas/seal-proof";
import { errorMessage } from "@intentic/base/errors";
import { ORPCError } from "@orpc/server";
import type { Caller } from "../../auth/auth.js";
import { base64url, verifyAuthentication } from "../../auth/passkeys/webauthn.js";
import type { Services } from "../../composition.js";
import { egressOwnerKeys } from "../../hosts/egress/owner-keys.js";
import { opt } from "../../opt.js";

/* OPENING A PRIVATE CONVERSATION WITHOUT ASKING (schemas/seal.ts). The sandbox owner alone, and only with their passkey
 * over a document naming the conversation and the reason, so the yes is the owner's own and not a session somebody took
 * over, nor an agent: no agent holds a passkey. The daemon writes the document (`prepare`), so its nonce and expiry are
 * its own and what the author is shown is exactly what was signed; the nonce is spent by the opening it proves.
 * Read-only for a day, from when it opens (a second person's yes, where an organisation asks for one). */

const OPEN_MS = SEAL_OPEN_HOURS * 60 * 60_000;

// Documents prepared and not yet spent, by nonce: what each was written for.
interface Prepared {
    readonly conversationId: string;
    readonly reason: string;
    readonly expiresAt: number;
}

export interface SealOpenings {
    readonly prepare: (conversationId: string, reason: string, origin: string | undefined) => Promise<SealOpenCeremony>;
    // Verifies the proof and answers the opening it makes: pending when a second person must agree.
    readonly verify: (caller: Caller, proof: SealOpenProof, origin: string | undefined, twoPerson: boolean) => Promise<SealOpen>;
}

const sha256base64url = (text: string): string => base64url.encode(createHash("sha256").update(text, "utf8").digest());

export const createSealOpenings = (services: Pick<Services, "config" | "passkeys" | "ownerEmail" | "appPasskeys">, now: () => number = Date.now): SealOpenings => {
    const prepared = new Map<string, Prepared>();
    const sweep = (at: number): void => {
        for (const [nonce, held] of prepared) {
            if (held.expiresAt <= at) {
                prepared.delete(nonce);
            }
        }
    };
    const keysFor = async (origin: string | undefined) => {
        const keys = await egressOwnerKeys(services, origin);
        if (keys === undefined || keys.ownerKeys.keys.length === 0) {
            throw new ORPCError("PRECONDITION_FAILED", { message: "opening a private conversation without asking needs your passkey: add one under Access ▸ Sign-in" });
        }
        return keys;
    };
    return {
        prepare: async (conversationId, reason, origin) => {
            const keys = await keysFor(origin);
            const at = now();
            sweep(at);
            const nonce = randomBytes(18).toString("hex");
            const expiresAt = at + SEAL_PROOF_MAX_AGE_MS;
            prepared.set(nonce, { conversationId, reason, expiresAt });
            const document = sealOpenDocumentText({ v: 1, purpose: "intentic-conversation-open", conversationId, reason, nonce, expiresAt });
            return { document, rpId: keys.ownerKeys.rpId, credentials: keys.credentials.map((credential) => ({ id: credential.id, ...opt("transports", credential.transports) })) };
        },
        verify: async (caller, proof, origin, twoPerson) => {
            const at = now();
            sweep(at);
            const parsed = SealOpenDocumentSchema.safeParse(JSON.parse(proof.document));
            const held = parsed.success ? prepared.get(parsed.data.nonce) : undefined;
            if (!parsed.success || held === undefined || held.conversationId !== proof.id || parsed.data.conversationId !== proof.id || parsed.data.reason !== held.reason) {
                throw new ORPCError("BAD_REQUEST", { message: "this opening was not prepared here, or it expired: start again" });
            }
            prepared.delete(parsed.data.nonce);
            const keys = await keysFor(origin);
            const stored = (await services.passkeys.list()).find((credential) => credential.id === proof.assertion.id);
            if (stored === undefined || !keys.ownerKeys.keys.some((key) => key.id === stored.id)) {
                throw new ORPCError("FORBIDDEN", { message: "that is not one of the owner's passkeys" });
            }
            try {
                const verified = verifyAuthentication(proof.assertion, {
                    challenge: sha256base64url(proof.document),
                    origin: keys.ownerKeys.origins,
                    rpId: keys.ownerKeys.rpId,
                    publicKey: stored.publicKey,
                    counter: stored.counter,
                });
                await services.passkeys.used(stored.id, verified.counter, verified.backedUp, at);
            } catch (error) {
                throw new ORPCError("FORBIDDEN", { message: `the passkey did not sign this opening: ${errorMessage(error)}` });
            }
            const open: SealOpen = { id: randomBytes(9).toString("hex"), email: caller.email.toLowerCase(), ...opt("name", caller.name), at, until: at + OPEN_MS, reason: held.reason };
            if (twoPerson) {
                open.pending = true;
            }
            return open;
        },
    };
};

/** The opening agreed to (or refused) by a second person: its day starts with the yes. */
export const answeredOpen = (open: SealOpen, by: Caller, agree: boolean, at: number): SealOpen => {
    const { pending: _pending, ...rest } = open;
    const person = { email: by.email.toLowerCase(), ...opt("name", by.name), at };
    return agree ? { ...rest, approvedBy: person, until: at + OPEN_MS } : { ...rest, refusedBy: person };
};

/** The seal with one opening added or replaced, by id. */
export const withOpen = (seal: Seal, open: SealOpen): Seal => ({
    ...seal,
    opens: [...(seal.opens ?? []).filter((held) => held.id !== open.id), open],
});
