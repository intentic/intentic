import { timingSafeEqual } from "node:crypto";
import type { GrantedRole, MemberRole, ProofMethod } from "@intentic/sandbox-contract";
import { GrantedRoleSchema, roleAtLeast } from "@intentic/sandbox-contract";
import { isOwnerTicket, verifyOwnerTicket } from "@intentic/sandbox-contract/owner-ticket";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { defineDocument } from "../store/evolution/documents.js";
import { openDocument } from "../store/open-document.js";
import { stateRelPath } from "../state-paths.js";

// The sandbox authenticates the end user directly against Google; the platform never holds this credential.
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

export interface VerifiedIdentity {
    readonly email: string;
    // Display profile from the same token, shown to other members via presence; never used for authorization.
    readonly name?: string;
    readonly picture?: string;
}

// An identity plus how the bearer proved it: what a session is minted from and what the require-passkey policy reads.
// `credentialId` names the passkey a proof came from, so removing that passkey ends every session it opened.
export interface Proof extends VerifiedIdentity {
    readonly methods: readonly ProofMethod[];
    readonly credentialId?: string;
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

export const ownerDocument = defineDocument({ path: stateRelPath(".intentic/identity/owner.json"), schema: OwnerFileSchema });

// On the daemon's JSON substrate like every other manifest: this file decides who may drive the sandbox.
// An atomic rename prevents a read landing mid-write from seeing an empty owner and treating the next identity as
// first; an owner file that exists but cannot be read throws, since "no owner" would let the next identity bind.
export const fileOwnerStore = (path: string): OwnerStore => {
    const file = openDocument<typeof ownerDocument, { readonly email?: string }>(ownerDocument, path, { fallback: () => ({}), onUnreadable: "refuse" });
    return {
        read: async () => {
            const state = await file.state();
            if (state.unreadable) {
                throw new Error(`the sandbox owner file could not be read (${state.detail}), so nobody is recognized as owner until it is fixed`);
            }
            return state.value.email;
        },
        write: async (email) => {
            await file.update(() => ({ email }));
        },
    };
};

// The additional authorized identities beyond the owner and the role each was granted, stored as
// {members:[{email,role,areas?}]}.
// The owner is never listed here; the daemon enforces shared access, the platform only mirrors these grants. Areas
// are the daemon's alone: what of this workspace a person reaches is a fact about this workspace's folders, never
// mirrored.
export interface Member {
    readonly email: string;
    readonly role: GrantedRole;
    // Area ids fencing what of the workspace this person reaches, and with it which persona cards they may wear
    // (personas/persona-reach.ts). Absent means the whole workspace; empty means nothing at all. Never absent on a
    // writer or a guest row.
    readonly areas?: readonly string[];
}

// What a grant decides, in the shape both the store and the route pass it around in.
export interface MemberGrant {
    readonly role: GrantedRole;
    readonly areas?: readonly string[] | undefined;
}

export interface MembersStore {
    list(): Promise<Member[]>;
    // Upsert: granting an email that already holds access re-grades its role, and replaces its areas.
    add(email: string, grant: MemberGrant): Promise<void>;
    remove(email: string): Promise<void>;
}

// Areas ride on any row, since where a person may look is a question independent of what they may do there — except
// on a writer and on a guest, where they ARE the question: a writer's fence is the folders it may change, and a guest's
// is the only thing deciding which cards it may speak through.
// Both refusals are enforced here rather than only at the route, because the roster file is hand-editable: a malformed
// row is skipped by the store, so a fenceless writer or guest row costs that person their access instead of handing
// them the unfenced workspace — and every card in it — their absent area list would otherwise resolve to.
const MemberSchema = z
    .object({
        email: z.string(),
        role: GrantedRoleSchema,
        areas: z.array(z.string().min(1)).optional(),
    })
    .refine((member) => (member.role !== "writer" && member.role !== "guest") || (member.areas?.length ?? 0) > 0, {
        message: "a writer and a guest each name at least one area: what they reach there is what the tier is",
    });
const MembersFileSchema = z.object({ members: z.array(z.unknown()) });

// The shape a grant writes. The file schema above checks only the frame, so one bad row is skipped rather than fatal.
export const membersDocument = defineDocument({
    path: stateRelPath(".intentic/identity/members.json"),
    schema: z.object({ members: z.array(MemberSchema) }),
});

// The row a grant writes: an area list is kept whatever the tier, and its absence is the whole workspace, so an
// omitted field can never read as an empty fence.
export const memberRow = (email: string, grant: MemberGrant): Member => ({
    email,
    role: grant.role,
    ...(grant.areas !== undefined ? { areas: [...grant.areas] } : {}),
});

// Same substrate as the owner store; the per-file update queue lets two grants landing together both survive instead of
// one erasing the other.
// One malformed entry is skipped so the rest keep access; a file that isn't a members file at all reads as nobody.
export const fileMembersStore = (path: string): MembersStore => {
    const file = openDocument<typeof membersDocument, { readonly members: readonly Member[] }>(membersDocument, path, {
        lenient: (raw) => {
            const parsed = MembersFileSchema.safeParse(raw);
            if (!parsed.success) {
                return undefined;
            }
            return {
                members: parsed.data.members.flatMap((entry) => {
                    const member = MemberSchema.safeParse(entry).data;
                    return member === undefined ? [] : [member];
                }),
            };
        },
        fallback: () => ({ members: [] }),
    });
    return {
        list: async () => [...(await file.read()).members],
        add: async (email, grant) => {
            await file.update((current) => ({ members: [...current.members.filter((member) => member.email !== email), memberRow(email, grant)] }));
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

// Identity verified and allowed, but this sandbox requires a passkey and the proof carries none; mapped to 428.
// `enrolled` tells the browser whether to ask for the passkey the caller holds or to walk them through adding their
// first.
export class PasskeyRequiredError extends Error {
    constructor(readonly enrolled: boolean) {
        super(enrolled ? "this sandbox requires your passkey" : "this sandbox requires a passkey; add one to continue");
    }
}

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
    // Area ids fencing what of the workspace this caller reaches, and with it which persona cards they may wear;
    // absent means the whole workspace, which is what the owner always holds. Carried as ids, not folders, so one read
    // of the area manifest per request answers it freshly: editing an area narrows its holders on their very next
    // call, like a re-grade does.
    readonly areas?: readonly string[];
}

// What authorize() hands the middleware: the caller and the proof behind them, so a session renewal keeps its methods
// and a passkey registration can upgrade the session that asked for it.
export interface ProvenCaller extends Caller, Proof {}

// What the passkey routes need of the roster: whether the policy is on, and whether a given person holds a passkey.
export interface PasskeyPolicy {
    readonly required: () => Promise<boolean>;
    readonly enrolled: (email: string) => Promise<boolean>;
    // Whether the passkey a session came from still exists; a removed one ends the sessions it opened.
    readonly exists: (credentialId: string) => Promise<boolean>;
}

export interface AuthorizeOptions {
    // The two registration routes: a proof with no passkey may pass the policy there, but only for an identity that
    // holds none yet. With one held, only that passkey opens the door, so a stolen Google account cannot add its own.
    readonly enrolment?: boolean;
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
    // ForbiddenError to 403, PasskeyRequiredError to 428, else 401.
    authorize(bearer: string, firstBind: string | undefined, options?: AuthorizeOptions): Promise<ProvenCaller>;
    // Enforces access for a proof this daemon verified itself with no bearer (a passkey assertion, a recovery code):
    // the roster and the policy, never first-bind, since no passkey can exist before an owner does.
    authorizeProven(proof: Proof): Promise<ProvenCaller>;
    // Verifies the bearer and asserts the caller is the bound owner, not merely a member; throws otherwise.
    authorizeOwner(bearer: string): Promise<void>;
    // The account-deletion endpoint's idempotent check; usable even after access is disabled, to disable it again.
    authorizeRetirement(bearer: string): Promise<void>;
    // The recovery-code door: the bearer must be the owner, and the policy is not asked, since this is how an owner
    // with no passkey left gets back to registering one.
    authorizeRecovery(bearer: string): Promise<ProvenCaller>;
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

// Compare emails case-insensitively because roster writes normalize them.
const sameEmail = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

export const createAuthorizer = (deps: {
    readonly verify: IdTokenVerifier;
    // Local verify for daemon-minted sessions (no JWKS round trip); optional for a session-less composition.
    readonly session?: (bearer: string) => Promise<Proof>;
    // The require-passkey policy and roster of passkeys; optional for a composition with no passkey routes.
    readonly passkeys?: PasskeyPolicy;
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
    // The bearer's verified proof: its own session if the token parses as one, else a Google ID token.
    // A session from a passkey that has since been removed is refused: the session outlived the credential behind it.
    const identify = async (bearer: string): Promise<Proof> => {
        const session = deps.session === undefined ? undefined : await deps.session(bearer).catch(() => undefined);
        if (session === undefined) {
            return { ...(await deps.verify(bearer)), methods: ["google"] };
        }
        if (session.credentialId !== undefined && deps.passkeys !== undefined && !(await deps.passkeys.exists(session.credentialId))) {
            throw new Error("the passkey this session came from has been removed");
        }
        return session;
    };
    const enforce = async (proof: Proof, owner: string): Promise<ProvenCaller> => {
        if (sameEmail(proof.email, owner)) {
            return { ...proof, role: "owner" };
        }
        const member = (await deps.members.list()).find(({ email }) => sameEmail(email, proof.email));
        if (member === undefined) {
            throw new ForbiddenError("not authorized for this sandbox");
        }
        return {
            ...proof,
            role: member.role,
            ...(member.areas !== undefined ? { areas: member.areas } : {}),
        };
    };
    // The require-passkey policy, read per request like the roster. A recovery code counts: it exists to get an owner
    // with no passkey left back to registering one.
    const requirePasskey = async (caller: ProvenCaller, enrolment: boolean): Promise<void> => {
        if (deps.passkeys === undefined || !(await deps.passkeys.required())) {
            return;
        }
        if (caller.methods.includes("passkey") || caller.methods.includes("recovery")) {
            return;
        }
        const enrolled = await deps.passkeys.enrolled(caller.email);
        if (enrolment && !enrolled) {
            return;
        }
        throw new PasskeyRequiredError(enrolled);
    };
    // The owner's proof from a bearer, for the two doors that stay open to an owner the policy would otherwise hold
    // out: retiring access and spending a recovery code. Neither adds power the bearer did not already have.
    const ownerProof = async (bearer: string): Promise<Proof> => {
        if (bearer === "") {
            throw new Error("missing bearer token");
        }
        const proof = await identify(bearer);
        const owner = await deps.owner.read();
        if (owner === undefined || !sameEmail(proof.email, owner)) {
            throw new ForbiddenError("not the sandbox owner");
        }
        return proof;
    };
    // The platform's ticket as a proof, or undefined for every other bearer. A ticket-shaped bearer that fails to verify
    // is refused here, not handed to Google to fail more slowly.
    const ticketProof = (bearer: string): Proof | undefined => {
        if (!isOwnerTicket(bearer)) {
            return undefined;
        }
        const vouched = deps.ownerTicket?.(bearer);
        if (vouched === undefined) {
            throw new Error("owner ticket refused: not for this sandbox, expired, or not the platform's");
        }
        return { ...vouched, methods: ["ticket"] };
    };
    // First-bind takes only a fresh Google proof or the platform's ticket; a lingering session can't seed it.
    const bind = async (bearer: string, firstBind: string | undefined, ticket: Proof | undefined): Promise<ProvenCaller> => {
        const proof: Proof = ticket ?? { ...(await deps.verify(bearer)), methods: ["google"] };
        if (ticket === undefined && deps.connectToken !== undefined && (firstBind === undefined || !tokenEquals(firstBind, deps.connectToken))) {
            throw new Error("first-bind requires the connection token");
        }
        // Checked after the connect-token gate: a missing token is a setup problem (401), a wrong account is 403.
        if (deps.expectedOwner !== undefined && proof.email.toLowerCase() !== deps.expectedOwner.toLowerCase()) {
            throw new ForbiddenError(`this sandbox is registered to ${deps.expectedOwner}`);
        }
        await deps.owner.write(proof.email);
        return { ...proof, role: "owner" };
    };
    return {
        authorize: async (bearer, firstBind, options = {}) => {
            await requireBrowserAccess();
            if (bearer === "") {
                throw new Error("missing bearer token");
            }
            const owner = await deps.owner.read();
            const ticket = ticketProof(bearer);
            if (owner === undefined) {
                return bind(bearer, firstBind, ticket);
            }
            const caller = await enforce(ticket ?? (await identify(bearer)), owner);
            await requirePasskey(caller, options.enrolment === true);
            return caller;
        },
        authorizeProven: async (proof) => {
            await requireBrowserAccess();
            const owner = await deps.owner.read();
            if (owner === undefined) {
                throw new Error("this sandbox has no owner yet");
            }
            const caller = await enforce(proof, owner);
            await requirePasskey(caller, false);
            return caller;
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
            await ownerProof(bearer);
        },
        authorizeRecovery: async (bearer) => {
            await requireBrowserAccess();
            return { ...(await ownerProof(bearer)), role: "owner" };
        },
    };
};
