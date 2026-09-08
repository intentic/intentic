import { timingSafeEqual } from "node:crypto";
import type { GrantedRole, MemberRole } from "@intentic/sandbox-contract";
import { GrantedRoleSchema, roleAtLeast } from "@intentic/sandbox-contract";
import { isOwnerTicket, verifyOwnerTicket } from "@intentic/sandbox-contract/owner-ticket";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { jsonFile } from "../store/json-file.js";

// The sandbox authenticates the end user directly against Google; the platform never holds this credential.
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

export interface VerifiedIdentity {
    readonly email: string;
    // Display profile from the same token, shown to other members via presence; never used for authorization.
    readonly name?: string;
    readonly picture?: string;
}

// Verifies a Google ID token and returns its identity; throws on any signature/issuer/audience/email failure.
export type IdTokenVerifier = (idToken: string) => Promise<VerifiedIdentity>;

export const createGoogleVerifier = (audience: string): IdTokenVerifier => {
    const jwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
    return async (idToken) => {
        // clockTolerance guards clock drift after host sleep; algorithms is pinned so the verifier decides the shape.
        const { payload } = await jwtVerify(idToken, jwks, { issuer: GOOGLE_ISSUERS, audience, clockTolerance: 60, algorithms: ["RS256"] });
        const email = payload["email"];
        if (typeof email !== "string" || payload["email_verified"] !== true) {
            throw new Error("google id token has no verified email");
        }
        const name = payload["name"];
        const picture = payload["picture"];
        return {
            email,
            ...(typeof name === "string" ? { name } : {}),
            ...(typeof picture === "string" ? { picture } : {}),
        };
    };
};

// Persists the sandbox's single owner email (trust-on-first-use); a JSON file by default, injected in tests.
export interface OwnerStore {
    read(): Promise<string | undefined>;
    write(email: string): Promise<void>;
}

const OwnerFileSchema = z.object({ email: z.string() });

// On the daemon's JSON substrate like every other manifest: this file decides who may drive the sandbox.
// An atomic rename prevents a read landing mid-write from seeing an empty owner and treating the next identity as
// first.
export const fileOwnerStore = (path: string): OwnerStore => {
    const file = jsonFile<{ readonly email?: string }>(path, { parse: (raw) => OwnerFileSchema.safeParse(raw).data, fallback: () => ({}) });
    return {
        read: async () => (await file.read()).email,
        write: async (email) => {
            await file.update(() => ({ email }));
        },
    };
};

// The additional authorized identities beyond the owner and the role each was granted, stored as
// {members:[{email,role}]}.
// The owner is never listed here; the daemon enforces shared access, the platform only mirrors these grants.
export interface Member {
    readonly email: string;
    readonly role: GrantedRole;
}

export interface MembersStore {
    list(): Promise<Member[]>;
    // Upsert: granting an email that already holds access re-grades its role.
    add(email: string, role: GrantedRole): Promise<void>;
    remove(email: string): Promise<void>;
}

const MemberSchema = z.object({ email: z.string(), role: GrantedRoleSchema });
const MembersFileSchema = z.object({ members: z.array(z.unknown()) });

// Same substrate as the owner store; the per-file update queue lets two grants landing together both survive instead of
// one erasing the other.
// One malformed entry is skipped so the rest keep access; a file that isn't a members file at all reads as nobody.
export const fileMembersStore = (path: string): MembersStore => {
    const file = jsonFile<{ readonly members: readonly Member[] }>(path, {
        parse: (raw) => {
            const parsed = MembersFileSchema.safeParse(raw);
            return parsed.success ? { members: parsed.data.members.flatMap((entry) => MemberSchema.safeParse(entry).data ?? []) } : undefined;
        },
        fallback: () => ({ members: [] }),
    });
    return {
        list: async () => [...(await file.read()).members],
        add: async (email, role) => {
            await file.update((current) => ({ members: [...current.members.filter((member) => member.email !== email), { email, role }] }));
        },
        remove: async (email) => {
            await file.update((current) => {
                const kept = current.members.filter((member) => member.email !== email);
                return kept.length === current.members.length ? current : { members: kept };
            });
        },
    };
};

// Identity verified but not allowed for this sandbox, mapped to 403 (vs 401 for an authentication failure).
export class ForbiddenError extends Error {}

// Extract the bearer token from an Authorization header (empty string when absent/malformed).
export const bearerFrom = (header: string | undefined): string => (header?.startsWith("Bearer ") ? header.slice(7) : "");

export const tokenEquals = (a: string, b: string): boolean => {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && timingSafeEqual(ab, bb);
};

// A verified identity plus the trust tier it holds here, what every authorized request acts as.
// Role is resolved fresh on each authorize (owner + members re-read), so a re-grade applies on the very next request.
export interface Caller extends VerifiedIdentity {
    readonly role: MemberRole;
}

// The platform's owner ticket, accepted as a sign-in proof on hosted machines only: verifies against the public key in
// this machine's env and this sandbox's own id.
// The email it names is then held to every rule a Google proof is (expected owner, roster); undefined for every other
// bearer.
export const ownerTicketVerifier =
    (publicKeyPem: string, sandboxId: string) =>
    (bearer: string): VerifiedIdentity | undefined => {
        const ticket = verifyOwnerTicket(publicKeyPem, bearer, Date.now());
        return ticket !== undefined && ticket.sandboxId === sandboxId ? { email: ticket.email } : undefined;
    };

export interface Authorizer {
    // Verifies a bearer (session or Google ID token) and enforces access; the first request binds its email as owner
    // (TOFU) and must be a fresh Google proof, never a session.
    // A connectToken must accompany that first bind; an expectedOwner must match it. Throws on failure: the daemon maps
    // ForbiddenError to 403, else 401.
    authorize(bearer: string, firstBind: string | undefined): Promise<Caller>;
    // Verifies the bearer and asserts the caller is the bound owner, not merely a member; throws otherwise.
    authorizeOwner(bearer: string): Promise<void>;
    // The account-deletion endpoint's idempotent check; usable even after access is disabled, to disable it again.
    authorizeRetirement(bearer: string): Promise<void>;
}

// The highest revokable grant carries the owner's operating authority, but ownership stays a separate fact.
// Only authorizeOwner can change the roster or retire the sandbox; a maintainer can be revoked but never revoke or
// replace the owner.
export const authorizeMaintainer = async (authorizer: Authorizer, bearer: string): Promise<void> => {
    const caller = await authorizer.authorize(bearer, undefined);
    if (!roleAtLeast(caller.role, "maintainer")) {
        throw new ForbiddenError("not a sandbox maintainer");
    }
};

// One comparison for the one fact every gate turns on: is this claim the same account as the stored row.
// Case-insensitive since every roster write normalizes with `.toLowerCase()`, but a Google email claim isn't guaranteed
// to.
const sameEmail = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

export const createAuthorizer = (deps: {
    readonly verify: IdTokenVerifier;
    // Local verify for daemon-minted sessions (no JWKS round trip); optional for a session-less composition.
    readonly session?: (bearer: string) => Promise<VerifiedIdentity>;
    readonly owner: OwnerStore;
    readonly members: MembersStore;
    readonly connectToken?: string;
    // The account this sandbox was created under; when set, first-bind must match it, not just hold the token.
    readonly expectedOwner?: string;
    // Permanent account-deletion marker; optional for direct/test compositions, always supplied in production.
    readonly browserAccess?: { readonly enabled: () => Promise<boolean> };
    // The platform's owner ticket as sign-in proof on hosted machines; satisfies the connect-token gate by itself.
    readonly ownerTicket?: (bearer: string) => VerifiedIdentity | undefined;
}): Authorizer => {
    const requireBrowserAccess = async (): Promise<void> => {
        if (deps.browserAccess !== undefined && !(await deps.browserAccess.enabled())) {
            throw new Error("browser access has been removed");
        }
    };
    // The bearer's verified identity: its own session if the token parses as one, else a Google ID token.
    const identify = async (bearer: string): Promise<VerifiedIdentity> => {
        const session = deps.session === undefined ? undefined : await deps.session(bearer).catch(() => undefined);
        return session ?? deps.verify(bearer);
    };
    const enforce = async (identity: VerifiedIdentity, owner: string): Promise<Caller> => {
        if (sameEmail(identity.email, owner)) {
            return { ...identity, role: "owner" };
        }
        const member = (await deps.members.list()).find(({ email }) => sameEmail(email, identity.email));
        if (member === undefined) {
            throw new ForbiddenError("not authorized for this sandbox");
        }
        return { ...identity, role: member.role };
    };
    return {
        authorize: async (bearer, firstBind) => {
            await requireBrowserAccess();
            if (bearer === "") {
                throw new Error("missing bearer token");
            }
            const owner = await deps.owner.read();
            // A ticket-shaped bearer that fails to verify is refused here, not handed to Google to fail more slowly.
            const vouched = isOwnerTicket(bearer) ? deps.ownerTicket?.(bearer) : undefined;
            if (isOwnerTicket(bearer) && vouched === undefined) {
                throw new Error("owner ticket refused: not for this sandbox, expired, or not the platform's");
            }
            if (owner !== undefined) {
                return enforce(vouched ?? (await identify(bearer)), owner);
            }
            // First-bind takes only a fresh Google proof or the platform's ticket; a lingering session can't seed it.
            const identity = vouched ?? (await deps.verify(bearer));
            if (vouched === undefined && deps.connectToken !== undefined && (firstBind === undefined || !tokenEquals(firstBind, deps.connectToken))) {
                throw new Error("first-bind requires the connection token");
            }
            // Checked after the connect-token gate: a missing token is a setup problem (401), a wrong account is 403.
            if (deps.expectedOwner !== undefined && identity.email.toLowerCase() !== deps.expectedOwner.toLowerCase()) {
                throw new ForbiddenError(`this sandbox is registered to ${deps.expectedOwner}`);
            }
            await deps.owner.write(identity.email);
            return { ...identity, role: "owner" };
        },
        authorizeOwner: async (bearer) => {
            await requireBrowserAccess();
            if (bearer === "") {
                throw new Error("missing bearer token");
            }
            const { email } = await identify(bearer);
            const owner = await deps.owner.read();
            if (owner === undefined || !sameEmail(email, owner)) {
                throw new ForbiddenError("not the sandbox owner");
            }
        },
        authorizeRetirement: async (bearer) => {
            if (bearer === "") {
                throw new Error("missing bearer token");
            }
            const { email } = await identify(bearer);
            const owner = await deps.owner.read();
            if (owner === undefined || !sameEmail(email, owner)) {
                throw new ForbiddenError("not the sandbox owner");
            }
        },
    };
};
