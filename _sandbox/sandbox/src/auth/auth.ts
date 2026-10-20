import type { AgentAccess, CredentialReach, EditScope } from "@intentic/sandbox-contract/schemas/members";
import type { GrantedRole, MemberRole } from "@intentic/sandbox-contract/schemas/shared";
import type { ProofMethod } from "@intentic/sandbox-contract/schemas/system";
import {
    accessRefusal,
    AgentAccessSchema,
    CredentialReachSchema,
    EditScopeSchema,
    memberAccess,
    tierOf,
} from "@intentic/sandbox-contract/schemas/members";
import { EMAIL_SIGN_IN_OFF, PLATFORM_KEY_UNKNOWN } from "@intentic/sandbox-contract/schemas/system";
import { GrantedRoleSchema, roleAtLeast } from "@intentic/sandbox-contract/schemas/shared";
import { isIdentityAssertion, verifyIdentityAssertion } from "@intentic/sandbox-contract/identity-assertion";
import { isOwnerTicket, verifyOwnerTicket } from "@intentic/sandbox-contract/owner-ticket";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { z } from "zod";
import { defineDocument } from "../store/evolution/documents.js";
import { ManifestUnreadableError } from "../store/json-file.js";
import { openDocument } from "../store/open-document.js";
import { tokenEquals } from "./token-equals.js";
import type { Listener } from "./proofs/listener.js";
import { assertChannel, meetsPasskeyPolicy } from "./proofs/proof-methods.js";
import { spentOnce } from "./proofs/spent-once.js";

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
    // The bearer was a session this daemon minted, not a fresh sign-in: what the audit trail tells a renewal by.
    readonly renewal?: true;
}

// Verifies a Google ID token and returns its identity; throws on any signature/issuer/audience/email failure.
export type IdTokenVerifier = (idToken: string) => Promise<VerifiedIdentity>;

// What a bind writes beside the email: whether the owner may open this sandbox with the platform's identity assertion,
// true when they bound with one (they sign in by email, so it is the only way the platform can let them back in).
export interface OwnerWriteOptions {
    readonly emailSignIn?: boolean;
}

// Persists the sandbox's single owner email (trust-on-first-use); a JSON file by default, injected in tests.
export interface OwnerStore {
    read(): Promise<string | undefined>;
    write(email: string, options?: OwnerWriteOptions): Promise<void>;
    // Whether the bound owner may sign in with the platform's identity assertion. Absent from a store that cannot say,
    // which reads as no: an owner who bound with Google is never opened by the platform's word alone.
    emailSignIn?(): Promise<boolean>;
}

// `emailSignIn` was added 2026-10-12, optional: a file written before it is an owner who bound with Google.
const OwnerFileSchema = z.object({ email: z.string(), emailSignIn: z.boolean().optional() });

// On the history volume, off the workspace every turn writes: who owns the sandbox is the daemon's to decide, never a file
// a member's agent could edit. Until 2026-10-06 it sat at `.intentic/identity/owner.json`; identity-off-workspace.ts
// brings it over.
export const ownerDocument = defineDocument({
    root: "history",
    path: "identity/owner.json",
    // Who owns this sandbox, who else may reach it and at what tier, and the hashed control tokens programs present:
    // the daemon's to decide, so kept off the workspace every turn writes (auth/members/identity-off-workspace.ts moved
    // them from `.intentic/identity/` on 2026-10-06). An access list that traveled would let a source sandbox hand
    // itself the target's ownership, and a token authenticates against the sandbox that minted it.
    portability: "identity",
    note: "The target is bound by its own owner's first sign-in.",
    schema: OwnerFileSchema,
});

// The reason a refused request gives when the owner file is what stands in the way: nobody can sign in until a person
// on the host moves it aside. Machine-readable, so a client can say so instead of asking for another sign-in; nothing
// else about the file is told to a caller who has not signed in.
export const OWNER_UNREADABLE = "owner-unreadable";

// The owner file exists and this build cannot read it. Fail-closed: reading it as absent would let the next identity to
// arrive bind the sandbox.
export class OwnerUnreadableError extends Error {
    readonly reason = OWNER_UNREADABLE;
    readonly detail: string;
    constructor(detail: string) {
        super(`the sandbox owner file could not be read (${detail}), so nobody is recognized as owner until it is fixed`);
        this.name = "OwnerUnreadableError";
        this.detail = detail;
    }
}

// What a person on the machine that runs the sandbox types to get back in: `ic` names a sandbox by the slug its connect
// token hashes to, the same id this daemon derives from it.
export const ownerResetCommand = (connectToken: string): string => `ic sandbox reset-owner ${sandboxIdFromToken(connectToken) ?? "<slug>"}`;

// On the daemon's JSON substrate like every other manifest: this file decides who may drive the sandbox.
// An atomic rename prevents a read landing mid-write from seeing an empty owner and treating the next identity as
// first; an owner file that exists but cannot be read throws, since "no owner" would let the next identity bind.
export const fileOwnerStore = (path: string): OwnerStore => {
    const file = openDocument<typeof ownerDocument, { readonly email?: string; readonly emailSignIn?: boolean }>(ownerDocument, path, {
        fallback: () => ({}),
        onUnreadable: "refuse",
    });
    const current = async (): Promise<{ readonly email?: string; readonly emailSignIn?: boolean }> => {
        const state = await file.state();
        if (state.unreadable) {
            throw new OwnerUnreadableError(state.detail);
        }
        return state.value;
    };
    return {
        read: async () => (await current()).email,
        write: async (email, options = {}) => {
            await file.update(() => (options.emailSignIn === true ? { email, emailSignIn: true } : { email }));
        },
        emailSignIn: async () => (await current()).emailSignIn === true,
    };
};

// The additional authorized identities beyond the owner and the role each was granted, stored as
// {members:[{email,role,areas?}]}.
// The owner is never listed here; the daemon enforces shared access, the platform only mirrors these grants. Areas
// are the daemon's alone: what of this workspace a person reaches is a fact about this workspace's folders, never
// mirrored.
export interface Member {
    readonly email: string;
    // The tier the rest of the row makes (sandbox-contract `tierOf`), kept in step by every write.
    readonly role: GrantedRole;
    // Area ids fencing what of the workspace this person reaches, and with it which persona cards they may wear
    // (personas/persona-reach.ts). Absent means the whole workspace; empty means nothing at all. Never absent on a
    // guest row.
    readonly areas?: readonly string[];
    // Whether their conversations run agents, and where they change files by hand; absent, what the role meant
    // (sandbox-contract `memberAccess`).
    readonly agents?: AgentAccess;
    readonly edit?: EditScope;
    // Whether the platform's identity assertion opens this sandbox for them (they sign in with an email code), which the
    // owner decides per person. Absent means no: Google, a passkey or a recovery code are their only ways in.
    readonly emailSignIn?: boolean;
    // The capabilities and secrets their conversations may spend (secrets/credential-reach.ts). Absent means every one,
    // which is what a row written before it meant; never on a maintainer, who reads every credential.
    readonly credentials?: CredentialReach;
}

// What a grant decides, in the shape both the store and the route pass it around in. `emailSignIn` and `credentials`
// absent keep what the row already says, so a re-grade from an editor that predates them never drops a way in or widens
// what a person's conversations may spend; `credentials: "all"` is how a grant lifts a reach.
export interface MemberGrant {
    readonly role: GrantedRole;
    readonly areas?: readonly string[] | undefined;
    readonly agents?: AgentAccess | undefined;
    readonly edit?: EditScope | undefined;
    readonly emailSignIn?: boolean | undefined;
    readonly credentials?: CredentialReach | "all" | undefined;
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
        // Added 2026-10-12, optional: a row written before it is a person who signs in with Google.
        emailSignIn: z.boolean().optional(),
        // Added 2026-10-13, optional: a row written before it reaches every credential, as it did then.
        credentials: CredentialReachSchema.optional(),
        // Added 2026-10-13, optional: a row written before them reads as its role meant (sandbox-contract `memberAccess`).
        agents: AgentAccessSchema.optional(),
        edit: EditScopeSchema.optional(),
    })
    .refine((member) => accessRefusal(memberAccess(member)) === undefined && tierOf(memberAccess(member)) === member.role, {
        message: "a row's access must be one a grant could write, and its role the tier that access makes",
    });
const MembersFileSchema = z.object({ members: z.array(z.unknown()) });

// The shape a grant writes. The file schema above checks only the frame, so one bad row is skipped rather than fatal.
// On the history volume beside the owner file, for the same reason: a roster in the workspace let any member's turn grant
// its person a tier. Until 2026-10-06 it sat at `.intentic/identity/members.json`.
export const membersDocument = defineDocument({
    root: "history",
    path: "identity/members.json",
    portability: "identity",
    note: "Re-invite collaborators from the Access tab, a grant is the platform's record, and the target enforces its own copy.",
    schema: z.object({ members: z.array(MemberSchema) }),
});

// The row a grant writes: an area list is kept whatever the tier, and its absence is the whole workspace, so an
// omitted field can never read as an empty fence. Email sign-in is written only when on, and a grant that does not say
// keeps the previous row's.
// A roster row while it is being built, its optional fields added one at a time.
interface MemberRowDraft {
    email: string;
    role: GrantedRole;
    areas?: string[];
    agents?: AgentAccess;
    edit?: EditScope;
    emailSignIn?: boolean;
    credentials?: CredentialReach;
}

// The reach a grant leaves on the row: `all` lifts it, a list replaces it, silence keeps the previous row's. A
// maintainer holds none, whatever the grant or the row before it said: the tier reads every credential, so a reach kept
// on it would read as a limit nothing enforces, and would come back the day the person is graded down.
const reachOfRow = (grant: MemberGrant, previous: Member | undefined): CredentialReach | undefined => {
    if (grant.role === "maintainer" || grant.credentials === "all") {
        return undefined;
    }
    const reach = grant.credentials ?? previous?.credentials;
    return reach === undefined ? undefined : { capabilities: [...reach.capabilities], secrets: [...reach.secrets] };
};

export const memberRow = (email: string, grant: MemberGrant, previous?: Member): Member => {
    const row: MemberRowDraft = { email, role: grant.role };
    if (grant.areas !== undefined) {
        row.areas = [...grant.areas];
    }
    // Written as the grant said them, and never on a maintainer, whose tier already answers both.
    if (grant.agents !== undefined && grant.role !== "maintainer") {
        row.agents = grant.agents;
    }
    if (grant.edit !== undefined && grant.role !== "maintainer") {
        row.edit = grant.edit === "all" ? "all" : [...grant.edit];
    }
    if (grant.emailSignIn ?? previous?.emailSignIn === true) {
        row.emailSignIn = true;
    }
    const credentials = reachOfRow(grant, previous);
    if (credentials !== undefined) {
        row.credentials = credentials;
    }
    return row;
};

// Same substrate as the owner store; the per-file update queue lets two grants landing together both survive instead of
// one erasing the other.
// One malformed entry is skipped so the rest keep access; a file that isn't a members file at all reads as nobody, and
// is refused rather than set aside by a grant or a removal (ManifestUnreadableError), since replacing it would drop
// every other member's access for good.
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
        onUnreadable: "refuse",
    });
    return {
        list: async () => [...(await file.read()).members],
        add: async (email, grant) => {
            await file.update((current) => {
                const previous = current.members.find((member) => member.email === email);
                return { members: [...current.members.filter((member) => member.email !== email), memberRow(email, grant, previous)] };
            });
        },
        remove: async (email) => {
            // Over a roster this build cannot read, a removal would find nobody to remove, write nothing and answer as if
            // done, and the person would be back the moment the file was fixed: refused like a grant.
            const roster = await file.state();
            if (roster.unreadable) {
                throw new ManifestUnreadableError(path, roster.detail);
            }
            await file.update((current) => {
                const kept = current.members.filter((member) => member.email !== email);
                return kept.length === current.members.length ? current : { members: kept };
            });
        },
    };
};

// Identity verified but not allowed for this sandbox, mapped to 403 (vs 401 for an authentication failure). `reason` is
// machine-readable for the refusals a client acts on (sandbox-contract EMAIL_SIGN_IN_OFF), answered beside the message.
export class ForbiddenError extends Error {
    constructor(
        message: string,
        readonly reason?: string,
    ) {
        super(message);
    }
}

// An identity assertion arrived before this daemon learned the platform's key (it has not reached the platform yet),
// mapped to a 401 that says so (sandbox-contract PLATFORM_KEY_UNKNOWN), so the editor can retry rather than re-prompt.
export class PlatformKeyUnknownError extends Error {
    readonly reason = PLATFORM_KEY_UNKNOWN;
    constructor() {
        super("this sandbox has not learned the platform's identity key yet");
    }
}

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

export { tokenEquals } from "./token-equals.js";

// A verified identity plus the trust tier it holds here, what every authorized request acts as.
// Role is resolved fresh on each authorize (owner + members re-read), so a re-grade applies on the very next request.
export interface Caller extends VerifiedIdentity {
    // The tier their access makes; an owner and a maintainer hold every other answer below.
    readonly role: MemberRole;
    // Whether they may start agents, and where they may change files by hand (a subset of `areas`). Absent: what the
    // tier means, which for the owner is everything.
    readonly agents?: AgentAccess;
    readonly edits?: "none" | "all" | readonly string[];
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
    // Which way the request came in (listener.ts), for a proof bound to one; absent is any but netd's loopback port.
    readonly listener?: Listener;
}

// The platform's owner ticket, accepted as a sign-in proof on hosted machines only: verifies against the public key in
// this machine's env and this sandbox's own id.
// The email it names is then held to every rule a Google proof is (expected owner, roster); undefined for every other
// bearer.
// Not spent once: a ticket carries no nonce, so two minted in the same second for the same owner are the same string,
// and refusing the second would refuse a person's second tab. The identity assertion below carries one and is.
export const ownerTicketVerifier =
    (publicKeyPem: string, sandboxId: string) =>
    (bearer: string): VerifiedIdentity | undefined => {
        const ticket = verifyOwnerTicket(publicKeyPem, bearer, Date.now());
        return ticket !== undefined && ticket.sandboxId === sandboxId ? { email: ticket.email } : undefined;
    };

// How long a sign-in waits for the platform's identity key when the daemon has not learned it yet: its first announce
// is usually seconds away, and a person who just opened the sandbox should not be refused for the race.
export const PLATFORM_KEY_WAIT_MS = 10_000;

// Verifies the platform's identity assertion (sandbox-contract policy/identity-assertion.ts) against the platform's key
// and this sandbox's own id, spending each once. Throws for one that fails, so it is never handed to Google to fail more
// slowly; PlatformKeyUnknownError when no key arrived in time.
export type AssertionVerifier = (bearer: string) => Promise<VerifiedIdentity>;

export const identityAssertionVerifier = (deps: {
    // The platform's identity key, waiting up to `waitMs` for it when none is known yet.
    readonly key: (waitMs: number) => Promise<string | undefined>;
    readonly sandboxId: string;
    readonly now?: () => number;
}): AssertionVerifier => {
    const spent = spentOnce();
    const now = deps.now ?? Date.now;
    return async (bearer) => {
        const key = await deps.key(PLATFORM_KEY_WAIT_MS);
        if (key === undefined) {
            throw new PlatformKeyUnknownError();
        }
        const at = now();
        const claim = verifyIdentityAssertion(key, bearer, at);
        if (claim === undefined || claim.sandboxId !== deps.sandboxId) {
            throw new Error("identity assertion refused: not for this sandbox, expired, or not the platform's");
        }
        if (!spent.spend(claim.nonce, claim.expiresAt * 1000, at)) {
            throw new Error("identity assertion refused: already spent");
        }
        return { email: claim.email };
    };
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
    // Verifies the bearer and asserts the caller is the bound owner, not merely a member; throws otherwise. `listener`
    // here and below is AuthorizeOptions' own.
    authorizeOwner(bearer: string, listener?: Listener): Promise<void>;
    // The account-deletion endpoint's idempotent check; usable even after access is disabled, to disable it again.
    authorizeRetirement(bearer: string, listener?: Listener): Promise<void>;
    // The recovery-code door: the bearer must be the owner, and the policy is not asked, since this is how an owner
    // with no passkey left gets back to registering one.
    authorizeRecovery(bearer: string, listener?: Listener): Promise<ProvenCaller>;
}

// The highest revokable grant carries the owner's operating authority, but ownership stays a separate fact.
// Only authorizeOwner can change the roster or retire the sandbox; a maintainer can be revoked but never revoke or
// replace the owner.
export const authorizeMaintainer = async (authorizer: Authorizer, bearer: string, listener?: Listener): Promise<void> => {
    const caller = await authorizer.authorize(bearer, undefined, { listener });
    if (!roleAtLeast(caller.role, "maintainer")) {
        throw new ForbiddenError("not a sandbox maintainer");
    }
};

// Compare emails case-insensitively because roster writes normalize them.
const sameEmail = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

// Whether this person holds the operating tier right now: the bound owner, or a maintainer on the roster. Read fresh on
// every ask, like authorize, so a removal or a re-grade answers no on the very next one.
export const operatesSandbox =
    (owner: Pick<OwnerStore, "read">, members: Pick<MembersStore, "list">) =>
    async (email: string): Promise<boolean> => {
        const bound = await owner.read();
        if (bound !== undefined && sameEmail(bound, email)) {
            return true;
        }
        return (await members.list()).some((member) => sameEmail(member.email, email) && roleAtLeast(member.role, "maintainer"));
    };

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
    // The platform's identity assertion as sign-in proof (method `email`); absent where the daemon cannot learn the key.
    readonly identityAssertion?: AssertionVerifier | undefined;
    // A hosted machine, which the platform holds already: its assertion opens the sandbox for the owner and anyone on the
    // roster, as its owner ticket does, and satisfies the connect-token gate. Elsewhere an assertion opens it only for an
    // owner who bound with one and for members the owner opted in, so the platform's word alone never opens a sandbox
    // for someone who signs in with Google there.
    readonly assertionsForAnyone?: boolean | undefined;
}): Authorizer => {
    const requireBrowserAccess = async (): Promise<void> => {
        if (deps.browserAccess !== undefined && !(await deps.browserAccess.enabled())) {
            throw new Error("browser access has been removed");
        }
    };
    // The platform's identity assertion as a proof, or undefined for every other bearer.
    const assertionProof = async (bearer: string): Promise<Proof | undefined> => {
        if (!isIdentityAssertion(bearer)) {
            return undefined;
        }
        if (deps.identityAssertion === undefined) {
            throw new Error("this sandbox does not accept the platform's identity assertion");
        }
        return { ...(await deps.identityAssertion(bearer)), methods: ["email"] };
    };
    // The bearer's verified proof: the platform's identity assertion, its own session if the token parses as one, else a
    // Google ID token. A session from a passkey that has since been removed is refused: the session outlived the
    // credential behind it. So is one whose proof stands on another channel than this request's (listener.ts).
    const identify = async (bearer: string, listener: Listener): Promise<Proof> => {
        const assertion = await assertionProof(bearer);
        if (assertion !== undefined) {
            return assertion;
        }
        const session = deps.session === undefined ? undefined : await deps.session(bearer).catch(() => undefined);
        if (session === undefined) {
            return { ...(await deps.verify(bearer)), methods: ["google"] };
        }
        if (session.credentialId !== undefined && deps.passkeys !== undefined && !(await deps.passkeys.exists(session.credentialId))) {
            throw new Error("the passkey this session came from has been removed");
        }
        assertChannel(session.methods, listener);
        return { ...session, renewal: true };
    };
    // Whether only the platform's word stands behind this proof: an assertion, or a session minted from one, with no
    // passkey or recovery code of this daemon's own added since. Those need the person's opt-in off a hosted machine.
    const vouchedOnly = (proof: Proof): boolean =>
        deps.assertionsForAnyone !== true && proof.methods.includes("email") && !proof.methods.includes("passkey") && !proof.methods.includes("recovery");
    // The owner's half of the opt-in: an owner who bound with Google is never opened by the platform's word alone.
    const requireOwnerOptIn = async (proof: Proof): Promise<void> => {
        if (vouchedOnly(proof) && !((await deps.owner.emailSignIn?.()) ?? false)) {
            throw new ForbiddenError("the owner of this sandbox signs in here with Google or a passkey, not an email code", EMAIL_SIGN_IN_OFF);
        }
    };
    const enforce = async (proof: Proof, owner: string): Promise<ProvenCaller> => {
        if (sameEmail(proof.email, owner)) {
            await requireOwnerOptIn(proof);
            return { ...proof, role: "owner" };
        }
        const member = (await deps.members.list()).find(({ email }) => sameEmail(email, proof.email));
        if (member === undefined) {
            throw new ForbiddenError("not authorized for this sandbox");
        }
        if (vouchedOnly(proof) && member.emailSignIn !== true) {
            throw new ForbiddenError("email sign-in is not on for you on this sandbox: ask its owner to allow it", EMAIL_SIGN_IN_OFF);
        }
        // A maintainer holds the owner's operating authority and reads every credential, so a fence over the tier would
        // enforce nothing (areas/invariant.ts `no-maintainer-is-fenced`), and the grant route refuses one. A row that
        // carries areas anyway, hand-edited or written before that refusal, used to hide most of the tree and every
        // conversation outside them from that person all the same: it is read as the whole workspace instead
        // (`memberAccess` answers a maintainer with no fence).
        // The tier is the one the access makes, never the row's own word for it: every floor reads it.
        const access = memberAccess(member);
        return {
            ...proof,
            role: tierOf(access),
            agents: access.agents,
            edits: access.edit,
            ...(access.see === undefined ? {} : { areas: access.see }),
        };
    };
    // The require-passkey policy, read per request like the roster (proof-methods.ts says which proofs pass it).
    const requirePasskey = async (caller: ProvenCaller, enrolment: boolean): Promise<void> => {
        if (deps.passkeys === undefined || !(await deps.passkeys.required())) {
            return;
        }
        if (meetsPasskeyPolicy(caller.methods)) {
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
    const ownerProof = async (bearer: string, listener: Listener): Promise<Proof> => {
        if (bearer === "") {
            throw new Error("missing bearer token");
        }
        const proof = await identify(bearer, listener);
        const owner = await deps.owner.read();
        if (owner === undefined || !sameEmail(proof.email, owner)) {
            throw new ForbiddenError("not the sandbox owner");
        }
        await requireOwnerOptIn(proof);
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
    // First-bind takes only a fresh Google proof, the platform's ticket or its identity assertion; a lingering session
    // can't seed it. `platformHeld` is a proof from the platform on a machine the platform holds (a hosted one), which
    // satisfies the connect-token gate by itself; every other proof needs the token beside it. An owner who binds with an
    // assertion is recorded as signing in by email, the only way the platform can let them back in.
    const bind = async (bearer: string, firstBind: string | undefined, vouched: Proof | undefined, platformHeld: boolean): Promise<ProvenCaller> => {
        const proof: Proof = vouched ?? { ...(await deps.verify(bearer)), methods: ["google"] };
        if (!platformHeld && deps.connectToken !== undefined && (firstBind === undefined || !tokenEquals(firstBind, deps.connectToken))) {
            throw new Error("first-bind requires the connection token");
        }
        // Checked after the connect-token gate: a missing token is a setup problem (401), a wrong account is 403.
        if (deps.expectedOwner !== undefined && proof.email.toLowerCase() !== deps.expectedOwner.toLowerCase()) {
            throw new ForbiddenError(`this sandbox is registered to ${deps.expectedOwner}`);
        }
        await deps.owner.write(proof.email, { emailSignIn: proof.methods.includes("email") });
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
                const assertion = ticket === undefined ? await assertionProof(bearer) : undefined;
                return bind(bearer, firstBind, ticket ?? assertion, ticket !== undefined || (assertion !== undefined && deps.assertionsForAnyone === true));
            }
            const caller = await enforce(ticket ?? (await identify(bearer, options.listener)), owner);
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
        authorizeOwner: async (bearer, listener) => {
            await requireBrowserAccess();
            if (bearer === "") {
                throw new Error("missing bearer token");
            }
            const proof = await identify(bearer, listener);
            const owner = await deps.owner.read();
            if (owner === undefined || !sameEmail(proof.email, owner)) {
                throw new ForbiddenError("not the sandbox owner");
            }
            await requireOwnerOptIn(proof);
        },
        authorizeRetirement: async (bearer, listener) => {
            await ownerProof(bearer, listener);
        },
        authorizeRecovery: async (bearer, listener) => {
            await requireBrowserAccess();
            return { ...(await ownerProof(bearer, listener)), role: "owner" };
        },
    };
};
