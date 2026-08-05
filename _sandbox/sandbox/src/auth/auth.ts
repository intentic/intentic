import { timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createRemoteJWKSet, jwtVerify } from "jose";

// The sandbox authenticates the END USER directly against Google — the platform never holds or signs this
// credential, so a platform compromise can't command the sandbox. The browser obtains a Google ID token via
// Google Identity Services and presents it as a bearer; we verify its signature against Google's published
// JWKS and its issuer/audience. The audience is our Google *web* client id (public, not a secret).
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

export interface VerifiedIdentity {
    readonly email: string;
    // Display profile from the same token, when Google includes the claims — presence shows these to the
    // other members. Never used for authorization decisions.
    readonly name?: string;
    readonly picture?: string;
}

// Verifies a Google ID token and returns its verified identity; throws if the signature, issuer, audience, or
// email verification fail. Implemented over Google's remote JWKS (jose caches the keys).
export type IdTokenVerifier = (idToken: string) => Promise<VerifiedIdentity>;

export const createGoogleVerifier = (audience: string): IdTokenVerifier => {
    const jwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
    return async (idToken) => {
        // clockTolerance: a fresh container's clock (WSL/Docker after host sleep) can run ahead of the
        // browser's, making a still-valid token look expired here and killing the terminal with 1008.
        // `algorithms` pinned for the same reason session.ts pins HS256: the verifier should accept one shape,
        // not whatever the token's own header proposes. jose already refuses to pair an RSA JWKS key with a
        // symmetric alg, so this closes nothing open today — it just stops that guarantee from living in a
        // dependency's behaviour instead of in this call.
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

// Persists the sandbox's single owner email (trust-on-first-use). Defaults to a JSON file beside the
// workspace (the same .intentic/ dir as the claude/tools stores); injected in tests.
export interface OwnerStore {
    read(): Promise<string | undefined>;
    write(email: string): Promise<void>;
}

export const fileOwnerStore = (path: string): OwnerStore => ({
    read: async () => {
        try {
            const parsed = JSON.parse(await readFile(path, "utf8")) as { email?: unknown };
            return typeof parsed.email === "string" ? parsed.email : undefined;
        } catch {
            return undefined;
        }
    },
    write: async (email) => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, JSON.stringify({ email }), "utf8");
    },
});

// The additional authorized emails (shared access beyond the owner), stored as { emails: [...] } in the same
// .intentic/ dir. The owner is NOT listed here — ownership stays in the owner store. The daemon is the real
// enforcer of shared access; the platform only mirrors these grants so a member's browser can find the sandbox.
export interface MembersStore {
    list(): Promise<string[]>;
    add(email: string): Promise<void>;
    remove(email: string): Promise<void>;
}

const readEmails = async (path: string): Promise<string[]> => {
    try {
        const parsed = JSON.parse(await readFile(path, "utf8")) as { emails?: unknown };
        return Array.isArray(parsed.emails) ? parsed.emails.filter((email): email is string => typeof email === "string") : [];
    } catch {
        return [];
    }
};

export const fileMembersStore = (path: string): MembersStore => ({
    list: () => readEmails(path),
    add: async (email) => {
        const emails = await readEmails(path);
        if (emails.includes(email)) {
            return;
        }
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, JSON.stringify({ emails: [...emails, email] }), "utf8");
    },
    remove: async (email) => {
        const emails = await readEmails(path);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, JSON.stringify({ emails: emails.filter((member) => member !== email) }), "utf8");
    },
});

// Identity verified but not allowed for this sandbox — mapped to 403 (vs 401 for every authentication
// failure), so the browser can tell "wrong Google account" apart from "daemon down / bad token".
export class ForbiddenError extends Error {}

// Extract the bearer token from an Authorization header (empty string when absent/malformed).
export const bearerFrom = (header: string | undefined): string => (header?.startsWith("Bearer ") ? header.slice(7) : "");

export const tokenEquals = (a: string, b: string): boolean => {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && timingSafeEqual(ab, bb);
};

export interface Authorizer {
    // Verify a request's bearer — a daemon-minted session (auth/session.ts) or a Google ID token — and enforce
    // access. The FIRST authenticated request binds its email as the owner (TOFU) and must be a fresh Google
    // proof, never a session; when a connectToken is configured, that first request must also carry it (the
    // connection token only the operator holds — closes the first-bind race), and when an expectedOwner is
    // configured its email must match (pins ownership to the intentic account, not just the token holder). Every
    // later request must be the owner OR a granted member. Returns the caller's verified identity (presence
    // shows it to the other members). Throws on any failure; the daemon maps a ForbiddenError to 403, anything
    // else to 401.
    authorize(bearer: string, firstBind: string | undefined): Promise<VerifiedIdentity>;
    // Verify the bearer AND assert the caller is the bound owner (not merely a member) — the gate for the
    // owner-only member-management routes. Throws on any failure.
    authorizeOwner(bearer: string): Promise<void>;
}

export const createAuthorizer = (deps: {
    readonly verify: IdTokenVerifier;
    // Local verify for daemon-minted sessions — the steady-state credential (no JWKS round trip). Optional so
    // compositions without a session store keep authorizing pure Google bearers.
    readonly session?: (bearer: string) => Promise<VerifiedIdentity>;
    readonly owner: OwnerStore;
    readonly members: MembersStore;
    readonly connectToken?: string;
    // The account email this sandbox was created under (seeded from the platform). When set, the first-bind
    // must be THIS identity — so daemon ownership always matches the intentic account, not just whoever holds
    // the connect token first. Undefined ⇒ plain TOFU (headless/direct connect with no setup code).
    readonly expectedOwner?: string;
}): Authorizer => {
    // The bearer's verified identity once the daemon is bound: its own session when the token parses as one,
    // otherwise a Google ID token against the JWKS. Session first — it is every call after sign-in.
    const identify = async (bearer: string): Promise<VerifiedIdentity> => {
        const session = deps.session === undefined ? undefined : await deps.session(bearer).catch(() => undefined);
        return session ?? deps.verify(bearer);
    };
    const enforce = async (identity: VerifiedIdentity, owner: string): Promise<VerifiedIdentity> => {
        if (identity.email === owner) {
            return identity;
        }
        if (!(await deps.members.list()).includes(identity.email)) {
            throw new ForbiddenError("not authorized for this sandbox");
        }
        return identity;
    };
    return {
        authorize: async (bearer, firstBind) => {
            if (bearer === "") {
                throw new Error("missing bearer token");
            }
            const owner = await deps.owner.read();
            if (owner !== undefined) {
                return enforce(await identify(bearer), owner);
            }
            // First-bind takes a fresh Google proof only — a session lingering from a wiped owner file (a
            // recreated workspace under the same sandbox id) must never seed ownership.
            const identity = await deps.verify(bearer);
            if (deps.connectToken !== undefined && (firstBind === undefined || !tokenEquals(firstBind, deps.connectToken))) {
                throw new Error("first-bind requires the connection token");
            }
            // Identity gate AFTER the connect-token gate: a missing token is a setup problem (401), a wrong
            // account is a permission problem (403 → the browser's "no access" screen). Case-insensitive since
            // the platform seeds lowercase but a Google email claim isn't guaranteed to be.
            if (deps.expectedOwner !== undefined && identity.email.toLowerCase() !== deps.expectedOwner.toLowerCase()) {
                throw new ForbiddenError(`this sandbox is registered to ${deps.expectedOwner}`);
            }
            await deps.owner.write(identity.email);
            return identity;
        },
        authorizeOwner: async (bearer) => {
            if (bearer === "") {
                throw new Error("missing bearer token");
            }
            const { email } = await identify(bearer);
            if (email !== (await deps.owner.read())) {
                throw new ForbiddenError("not the sandbox owner");
            }
        },
    };
};
