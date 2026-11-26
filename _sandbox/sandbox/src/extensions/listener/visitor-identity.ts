import { z } from "zod";
import type { IdTokenVerifier } from "../../auth/auth.js";
import { createGoogleVerifier } from "../../auth/proofs/google-id-token.js";
import type { Services } from "../../composition.js";
import { opt } from "../../opt.js";

// WHO A STRANGER WHO SIGNED IN IS, AS THE SANDBOX KNOWS THEM (2026-11-26): the door behind a listener that anyone on the
// internet reaches (`contributes.listener.strangers`), which the Visitor chat's own identity module was until it moved
// onto its extension. A page that asks its visitors to sign in with Google hands the extension a Google ID token; the
// extension asks here, and the daemon verifies it against the site's own client id and says whether that address is the
// owner's or a member's. It stays in the core because the second half is the roster, the sandbox's word about its own
// people: an extension asks this one question of it and never reads it, where the alternative was granting it
// `GET /members` whole. Neither half guards anything: the address is a claim the agent reads, never a grant.

export const VisitorIdentityAskSchema = z.object({
    // The only provider so far; named so another can join without a second door.
    kind: z.literal("google"),
    // The site's own client id, which a token is issued for: no single client could list every customer's domain.
    clientId: z.string().min(1).max(500),
    idToken: z.string().min(1).max(8_000),
});
export type VisitorIdentityAsk = z.infer<typeof VisitorIdentityAskSchema>;

export interface VerifiedVisitor {
    readonly email: string;
    readonly name?: string;
    // The verified address is the owner's or a member's.
    readonly member: boolean;
}

// One verifier per client id, kept for the daemon's life so Google's keys are not fetched again every message.
const verifiers = new Map<string, IdTokenVerifier>();

const verifierFor = (clientId: string): IdTokenVerifier => {
    const existing = verifiers.get(clientId);
    if (existing !== undefined) {
        return existing;
    }
    const verifier = createGoogleVerifier(clientId);
    verifiers.set(clientId, verifier);
    return verifier;
};

// The addresses that can already reach this sandbox: the owner and every member. Read per ask, never cached, since a
// stale `member` would misname who is talking.
const peopleOf = async (services: Pick<Services, "ownerEmail" | "members">): Promise<Set<string>> => {
    const owner = await services.ownerEmail();
    const members = await services.members.list();
    return new Set([...(owner === undefined ? [] : [owner]), ...members.map(({ email }) => email)].map((email) => email.toLowerCase()));
};

/** Who the token names, or undefined when it does not verify for that client id (a bad token is not the caller's fault). */
export const verifyVisitor = async (
    services: Pick<Services, "ownerEmail" | "members" | "logger">,
    ask: VisitorIdentityAsk,
    verify: (clientId: string) => IdTokenVerifier = verifierFor,
): Promise<VerifiedVisitor | undefined> => {
    let identity: Awaited<ReturnType<IdTokenVerifier>>;
    try {
        identity = await verify(ask.clientId)(ask.idToken);
    } catch (error) {
        services.logger.warn({ err: error }, "a visitor's Google ID token did not verify");
        return undefined;
    }
    return { email: identity.email, ...opt("name", identity.name), member: (await peopleOf(services)).has(identity.email.toLowerCase()) };
};
