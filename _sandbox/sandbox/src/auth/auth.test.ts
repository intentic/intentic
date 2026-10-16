import { generateKeyPairSync } from "node:crypto";
import { EMAIL_SIGN_IN_OFF, type ProofMethod } from "@intentic/sandbox-contract/schemas/system";
import { mintIdentityAssertion } from "@intentic/sandbox-contract/identity-assertion";
import { mintOwnerTicket } from "@intentic/sandbox-contract/owner-ticket";
import {
    authorizeMaintainer,
    createAuthorizer,
    ForbiddenError,
    identityAssertionVerifier,
    type IdTokenVerifier,
    type Member,
    memberRow,
    type MembersStore,
    type OwnerStore,
    ownerTicketVerifier,
    type PasskeyPolicy,
    PasskeyRequiredError,
    PlatformKeyUnknownError,
    type Proof,
} from "./auth.js";

// In-memory owner store so the TOFU branching is exercised without touching disk. `emailSignIn` is what the bind wrote.
const memOwner = (initial?: string, initialEmailSignIn = false): OwnerStore => {
    let value = initial;
    let emailSignIn = initialEmailSignIn;
    return {
        read: async () => value,
        write: async (email, options = {}) => {
            value = email;
            emailSignIn = options.emailSignIn === true;
        },
        emailSignIn: async () => emailSignIn,
    };
};

// In-memory shared-access list (the identities allowed besides the owner, each with its granted role).
const memMembers = (initial: Member[] = []): MembersStore => {
    let members = [...initial];
    return {
        list: async () => members,
        add: async (email, grant) => {
            const previous = members.find((member) => member.email === email);
            members = [...members.filter((member) => member.email !== email), memberRow(email, grant, previous)];
        },
        remove: async (email) => {
            members = members.filter((member) => member.email !== email);
        },
    };
};

// Most tests only care that an email is on the list; the role rides along.
const granted = (...emails: string[]): Member[] => emails.map((email) => ({ email, role: "collaborator" as const }));

// A fake verifier mapping a token to an email; an unknown token throws, standing in for a failed verify.
const verifierFor =
    (map: Record<string, string>): IdTokenVerifier =>
    async (token) => {
        const email = map[token];
        if (email === undefined) {
            throw new Error("invalid token");
        }
        return { email };
    };

// bun's `rejects` chain does not unwrap the promise for toSatisfy, so the rejection is captured and asserted on directly.
const rejection = async (promise: Promise<unknown>): Promise<unknown> => {
    try {
        await promise;
    } catch (error) {
        return error;
    }
    throw new Error("expected the call to reject");
};

// The session verifier's fake: a token to the proof it was minted from, Google-proven unless the test says otherwise.
const sessionFor =
    (map: Record<string, string>, methods: readonly ProofMethod[] = ["google"], credentialId?: string) =>
    async (token: string): Promise<Proof> => {
        const email = map[token];
        if (email === undefined) {
            throw new Error("invalid token");
        }
        return { email, methods, ...(credentialId !== undefined ? { credentialId } : {}) };
    };

describe("createAuthorizer (owner TOFU + shared access)", () => {
    test("binds the first authenticated email as owner, then accepts only that owner", async () => {
        const owner = memOwner();
        const authz = createAuthorizer({ verify: verifierFor({ "tok-a": "a@x.com", "tok-b": "b@x.com" }), owner, members: memMembers() });
        await expect(authz.authorize("tok-a", undefined)).resolves.toEqual({ email: "a@x.com", role: "owner", methods: ["google"] });
        expect(await owner.read()).toBe("a@x.com");
        await expect(authz.authorize("tok-a", undefined)).resolves.toEqual({ email: "a@x.com", role: "owner", methods: ["google"] });
        await expect(authz.authorize("tok-b", undefined)).rejects.toBeInstanceOf(ForbiddenError);
    });

    test("accepts a granted member, rejects a stranger", async () => {
        const authz = createAuthorizer({
            verify: verifierFor({ "tok-m": "m@x.com", "tok-x": "x@x.com" }),
            owner: memOwner("a@x.com"),
            members: memMembers(granted("m@x.com")),
        });
        await expect(authz.authorize("tok-m", undefined)).resolves.toEqual({ email: "m@x.com", role: "collaborator", agents: "run", edits: "none", methods: ["google"] });
        await expect(authz.authorize("tok-x", undefined)).rejects.toBeInstanceOf(ForbiddenError);
    });

    // The fence rides on the caller, since every narrowed route reads it off the identity the middleware verified —
    // which folders they see, and with it which assistants they may speak through.
    test("a fenced member's areas reach the caller; an unfenced tier carries none", async () => {
        const authz = createAuthorizer({
            verify: verifierFor({ "tok-d": "d@x.com", "tok-m": "m@x.com" }),
            owner: memOwner("a@x.com"),
            members: memMembers([{ email: "d@x.com", role: "guest", areas: ["support", "sales"] }, ...granted("m@x.com")]),
        });
        await expect(authz.authorize("tok-d", undefined)).resolves.toEqual({
            email: "d@x.com",
            role: "guest",
            agents: "chat",
            edits: "none",
            areas: ["support", "sales"],
            methods: ["google"],
        });
        await expect(authz.authorize("tok-m", undefined)).resolves.not.toHaveProperty("areas");
    });

    // The invariant reports such a row as claiming a fence that is not there; the authorizer has to agree with it, or
    // the maintainer it names sees a sliver of the tree and none of the conversations outside it.
    test("a maintainer row that carries areas anyway reaches the caller unfenced", async () => {
        const authz = createAuthorizer({
            verify: verifierFor({ "tok-m": "m@x.com", "tok-w": "w@x.com" }),
            owner: memOwner("a@x.com"),
            members: memMembers([
                { email: "m@x.com", role: "maintainer", areas: ["support"] },
                { email: "w@x.com", role: "writer", areas: ["support"] },
            ]),
        });
        await expect(authz.authorize("tok-m", undefined)).resolves.toEqual({ email: "m@x.com", role: "maintainer", agents: "run", edits: "all", methods: ["google"] });
        await expect(authz.authorize("tok-w", undefined)).resolves.toEqual({ email: "w@x.com", role: "writer", agents: "run", edits: ["support"], areas: ["support"], methods: ["google"] });
    });

    test("a granted member is recognised whatever case the claim carries", async () => {
        const authz = createAuthorizer({
            verify: verifierFor({ "tok-m": "Alice@Corp.com" }),
            owner: memOwner("a@x.com"),
            members: memMembers(granted("alice@corp.com")),
        });
        await expect(authz.authorize("tok-m", undefined)).resolves.toEqual({ email: "Alice@Corp.com", role: "collaborator", agents: "run", edits: "none", methods: ["google"] });
    });

    test("the owner is recognised whatever case the claim carries, on every owner-only gate", async () => {
        const authz = createAuthorizer({
            verify: verifierFor({ "tok-a": "Ada@Corp.com" }),
            owner: memOwner("ada@corp.com"),
            members: memMembers(),
        });
        await expect(authz.authorize("tok-a", undefined)).resolves.toEqual({ email: "Ada@Corp.com", role: "owner", methods: ["google"] });
        await expect(authz.authorizeOwner("tok-a")).resolves.toBeUndefined();
        await expect(authz.authorizeRetirement("tok-a")).resolves.toBeUndefined();
    });

    // An unbound sandbox has no owner: the gates must refuse rather than compare against undefined.
    test("the owner-only gates refuse before the sandbox is bound", async () => {
        const authz = createAuthorizer({ verify: verifierFor({ "tok-a": "a@x.com" }), owner: memOwner(), members: memMembers() });
        await expect(authz.authorizeOwner("tok-a")).rejects.toBeInstanceOf(ForbiddenError);
        await expect(authz.authorizeRetirement("tok-a")).rejects.toBeInstanceOf(ForbiddenError);
    });

    test("returns the verifier's full identity: presence shows name/picture to the other members", async () => {
        const authz = createAuthorizer({
            verify: async () => ({ email: "a@x.com", name: "Ada", picture: "https://p/a.png" }),
            owner: memOwner("a@x.com"),
            members: memMembers(),
        });
        await expect(authz.authorize("tok-a", undefined)).resolves.toEqual({
            email: "a@x.com",
            name: "Ada",
            picture: "https://p/a.png",
            role: "owner",
            methods: ["google"],
        });
    });

    test("rejects a missing bearer as an authentication failure, not Forbidden", async () => {
        const authz = createAuthorizer({ verify: verifierFor({}), owner: memOwner(), members: memMembers() });
        expect(await rejection(authz.authorize("", undefined))).toSatisfy(
            (error) => error instanceof Error && !(error instanceof ForbiddenError) && /missing bearer/.test(error.message),
        );
    });

    test("propagates a verify failure (invalid/expired/wrong-audience token)", async () => {
        const authz = createAuthorizer({ verify: verifierFor({ good: "a@x.com" }), owner: memOwner(), members: memMembers() });
        await expect(authz.authorize("bogus", undefined)).rejects.toThrow(/invalid token/);
    });

    test("with a connectToken, first-bind requires it (an auth failure, not Forbidden); later requests do not", async () => {
        const owner = memOwner();
        const authz = createAuthorizer({ verify: verifierFor({ "tok-a": "a@x.com" }), owner, members: memMembers(), connectToken: "secret" });
        expect(await rejection(authz.authorize("tok-a", undefined))).toSatisfy(
            (error) => error instanceof Error && !(error instanceof ForbiddenError) && /connection token/.test(error.message),
        );
        await expect(authz.authorize("tok-a", "wrong")).rejects.toThrow(/connection token/);
        expect(await owner.read()).toBeUndefined();
        await authz.authorize("tok-a", "secret");
        expect(await owner.read()).toBe("a@x.com");
        await expect(authz.authorize("tok-a", undefined)).resolves.toEqual({ email: "a@x.com", role: "owner", methods: ["google"] });
    });

    test("with an expectedOwner, only that identity may first-bind (mismatch is Forbidden, case-insensitive)", async () => {
        const owner = memOwner();
        const authz = createAuthorizer({
            verify: verifierFor({ "tok-a": "a@x.com", "tok-b": "b@x.com", "tok-a-caps": "A@X.com" }),
            owner,
            members: memMembers(),
            expectedOwner: "a@x.com",
        });
        // Wrong account can't claim ownership, and nothing is written, so the right account can still bind after.
        await expect(authz.authorize("tok-b", undefined)).rejects.toBeInstanceOf(ForbiddenError);
        expect(await owner.read()).toBeUndefined();
        // A differently-cased match still binds.
        await authz.authorize("tok-a-caps", undefined);
        expect(await owner.read()).toBe("A@X.com");
    });

    test("expectedOwner + connectToken: a missing token fails as a setup error even when the email would mismatch", async () => {
        const owner = memOwner();
        const authz = createAuthorizer({
            verify: verifierFor({ "tok-b": "b@x.com" }),
            owner,
            members: memMembers(),
            connectToken: "secret",
            expectedOwner: "a@x.com",
        });
        // The connect-token gate runs first: a setup problem (401), not a Forbidden identity check.
        expect(await rejection(authz.authorize("tok-b", undefined))).toSatisfy(
            (error) => error instanceof Error && !(error instanceof ForbiddenError) && /connection token/.test(error.message),
        );
        // With the token present, the identity gate then rejects the wrong account as Forbidden.
        await expect(authz.authorize("tok-b", "secret")).rejects.toBeInstanceOf(ForbiddenError);
        expect(await owner.read()).toBeUndefined();
    });

    test("authorizeOwner accepts the owner but rejects a member or stranger", async () => {
        const authz = createAuthorizer({
            verify: verifierFor({ "tok-a": "a@x.com", "tok-m": "m@x.com" }),
            owner: memOwner("a@x.com"),
            members: memMembers(granted("m@x.com")),
        });
        await expect(authz.authorizeOwner("tok-a")).resolves.toBeUndefined();
        await expect(authz.authorizeOwner("tok-m")).rejects.toBeInstanceOf(ForbiddenError);
        expect(await rejection(authz.authorizeOwner(""))).toSatisfy(
            (error) => error instanceof Error && !(error instanceof ForbiddenError) && /missing bearer/.test(error.message),
        );
    });

    test("the highest revokable grant has operating authority but not ownership", async () => {
        const authz = createAuthorizer({
            verify: verifierFor({ "tok-a": "a@x.com", "tok-m": "m@x.com", "tok-c": "c@x.com" }),
            owner: memOwner("a@x.com"),
            members: memMembers([
                { email: "m@x.com", role: "maintainer" },
                { email: "c@x.com", role: "collaborator" },
            ]),
        });
        await expect(authorizeMaintainer(authz, "tok-a")).resolves.toBeUndefined();
        await expect(authorizeMaintainer(authz, "tok-m")).resolves.toBeUndefined();
        await expect(authorizeMaintainer(authz, "tok-c")).rejects.toThrow(/sandbox maintainer/);
        await expect(authz.authorizeOwner("tok-m")).rejects.toBeInstanceOf(ForbiddenError);
    });

    test("permanently disabled browser access refuses ordinary calls but lets the owner repeat retirement", async () => {
        const authz = createAuthorizer({
            verify: verifierFor({ "tok-a": "a@x.com", "tok-m": "m@x.com" }),
            owner: memOwner("a@x.com"),
            members: memMembers(granted("m@x.com")),
            browserAccess: { enabled: async () => false },
        });
        await expect(authz.authorize("tok-a", undefined)).rejects.toThrow(/browser access has been removed/);
        await expect(authz.authorize("tok-m", undefined)).rejects.toThrow(/browser access has been removed/);
        await expect(authz.authorizeOwner("tok-a")).rejects.toThrow(/browser access has been removed/);
        await expect(authz.authorizeRetirement("tok-a")).resolves.toBeUndefined();
        await expect(authz.authorizeRetirement("tok-m")).rejects.toBeInstanceOf(ForbiddenError);
    });
});

describe("createAuthorizer (daemon-minted sessions)", () => {
    test("a session bearer authorizes owner and member without touching the Google verifier", async () => {
        const authz = createAuthorizer({
            verify: async () => {
                throw new Error("google verifier must not be consulted for a valid session");
            },
            session: sessionFor({ "sess-a": "a@x.com", "sess-m": "m@x.com", "sess-x": "x@x.com" }),
            owner: memOwner("a@x.com"),
            members: memMembers(granted("m@x.com")),
        });
        await expect(authz.authorize("sess-a", undefined)).resolves.toEqual({ email: "a@x.com", role: "owner", methods: ["google"], renewal: true });
        await expect(authz.authorize("sess-m", undefined)).resolves.toEqual({ email: "m@x.com", role: "collaborator", agents: "run", edits: "none", methods: ["google"], renewal: true });
        // A verified session is still subject to per-request membership: revoking a member kills live sessions.
        await expect(authz.authorize("sess-x", undefined)).rejects.toBeInstanceOf(ForbiddenError);
        await expect(authz.authorizeOwner("sess-a")).resolves.toBeUndefined();
        await expect(authz.authorizeOwner("sess-m")).rejects.toBeInstanceOf(ForbiddenError);
    });

    test("a bearer that is not a session falls through to the Google verifier", async () => {
        const authz = createAuthorizer({
            verify: verifierFor({ "tok-a": "a@x.com" }),
            session: sessionFor({}),
            owner: memOwner("a@x.com"),
            members: memMembers(),
        });
        await expect(authz.authorize("tok-a", undefined)).resolves.toEqual({ email: "a@x.com", role: "owner", methods: ["google"] });
        await expect(authz.authorize("bogus", undefined)).rejects.toThrow(/invalid token/);
    });

    test("a session can never first-bind: an unbound daemon takes only a fresh Google proof", async () => {
        const owner = memOwner();
        const authz = createAuthorizer({
            verify: verifierFor({ "tok-a": "a@x.com" }),
            session: sessionFor({ "sess-a": "a@x.com" }),
            owner,
            members: memMembers(),
        });
        await expect(authz.authorize("sess-a", undefined)).rejects.toThrow(/invalid token/);
        expect(await owner.read()).toBeUndefined();
        await expect(authz.authorize("tok-a", undefined)).resolves.toEqual({ email: "a@x.com", role: "owner", methods: ["google"] });
        expect(await owner.read()).toBe("a@x.com");
    });
});

// The platform's owner ticket (owner-ticket.ts): the hosted lane's way past the second Google prompt.
// Held to every rule a Google proof is (sandbox id, expected owner, roster) but satisfies the connect-token gate by
// itself.
describe("owner ticket", () => {
    const pair = generateKeyPairSync("ed25519");
    const privatePem = pair.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    const publicPem = pair.publicKey.export({ type: "spki", format: "pem" }) as string;
    const ticketFor = (email: string, sandboxId = "0123456789ab"): string =>
        mintOwnerTicket(privatePem, { sandboxId, email, issuedAtMs: Date.now() });

    test("first-binds the expected owner without a connect token, and drives the sandbox as owner afterwards", async () => {
        const owner = memOwner();
        const authz = createAuthorizer({
            verify: verifierFor({}),
            owner,
            members: memMembers(),
            connectToken: "secret",
            expectedOwner: "a@x.com",
            ownerTicket: ownerTicketVerifier(publicPem, "0123456789ab"),
        });
        await expect(authz.authorize(ticketFor("A@x.com"), undefined)).resolves.toEqual({ email: "a@x.com", role: "owner", methods: ["ticket"] });
        expect(await owner.read()).toBe("a@x.com");
        // Bound: a later ticket for the owner is the owner; one for a stranger is refused by the roster.
        await expect(authz.authorize(ticketFor("a@x.com"), undefined)).resolves.toEqual({ email: "a@x.com", role: "owner", methods: ["ticket"] });
        await expect(authz.authorize(ticketFor("b@x.com"), undefined)).rejects.toBeInstanceOf(ForbiddenError);
    });

    test("cannot pick an owner the sandbox was not created for", async () => {
        const owner = memOwner();
        const authz = createAuthorizer({
            verify: verifierFor({}),
            owner,
            members: memMembers(),
            expectedOwner: "a@x.com",
            ownerTicket: ownerTicketVerifier(publicPem, "0123456789ab"),
        });
        await expect(authz.authorize(ticketFor("b@x.com"), undefined)).rejects.toBeInstanceOf(ForbiddenError);
        expect(await owner.read()).toBeUndefined();
    });

    test("refuses a ticket for another sandbox, another key, or a daemon with no key, and never falls through to Google", async () => {
        const otherKey = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }) as string;
        const verify = verifierFor({ "tok-a": "a@x.com" });
        const withKey = createAuthorizer({
            verify,
            owner: memOwner(),
            members: memMembers(),
            ownerTicket: ownerTicketVerifier(publicPem, "0123456789ab"),
        });
        await expect(withKey.authorize(ticketFor("a@x.com", "ffffffffffff"), undefined)).rejects.toThrow(/owner ticket refused/);
        await expect(
            withKey.authorize(mintOwnerTicket(otherKey, { sandboxId: "0123456789ab", email: "a@x.com", issuedAtMs: Date.now() }), undefined),
        ).rejects.toThrow(/owner ticket refused/);
        // Every non-hosted daemon: no key in its env, so a ticket-shaped bearer is refused outright.
        const withoutKey = createAuthorizer({ verify, owner: memOwner(), members: memMembers() });
        await expect(withoutKey.authorize(ticketFor("a@x.com"), undefined)).rejects.toThrow(/owner ticket refused/);
    });
});

// The platform's identity assertion (identity-assertion.ts): how a person whose address no identity provider vouches for
// gets in. Off a hosted machine it opens the sandbox only for an owner who bound with one and for members the owner opted
// in, so the platform's word alone never opens a sandbox for someone who signs in with Google there.
describe("identity assertion", () => {
    // PEM strings straight from the generator, the form the platform's env and the announce answer carry.
    const pemPair = (): { privateKey: string; publicKey: string } =>
        generateKeyPairSync("ed25519", { publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
    const { privateKey: privatePem, publicKey: publicPem } = pemPair();
    const SANDBOX = "0123456789ab";
    const assertionFor = (email: string, sandboxId = SANDBOX, key = privatePem): string =>
        mintIdentityAssertion(key, { sandboxId, email, method: "email", issuedAtMs: Date.now() });
    const verifier = () => identityAssertionVerifier({ key: async () => publicPem, sandboxId: SANDBOX });
    const reasonOf = async (promise: Promise<unknown>): Promise<string | undefined> => {
        const error = await rejection(promise);
        return error instanceof ForbiddenError ? error.reason : undefined;
    };

    test("first-binds the expected owner with the connect token beside it, recording that they sign in by email", async () => {
        const owner = memOwner();
        const authz = createAuthorizer({
            verify: verifierFor({}),
            owner,
            members: memMembers(),
            connectToken: "secret",
            expectedOwner: "ada@example.org",
            identityAssertion: verifier(),
        });
        await expect(authz.authorize(assertionFor("ada@example.org"), undefined)).rejects.toThrow("first-bind requires the connection token");
        expect(await owner.read()).toBeUndefined();
        await expect(authz.authorize(assertionFor("ada@example.org"), "secret")).resolves.toEqual({ email: "ada@example.org", role: "owner", methods: ["email"] });
        expect(await owner.emailSignIn?.()).toBe(true);
        // Bound: the owner keeps coming in on the platform's word; a stranger's assertion is refused by the roster.
        await expect(authz.authorize(assertionFor("ada@example.org"), undefined)).resolves.toEqual({ email: "ada@example.org", role: "owner", methods: ["email"] });
        await expect(authz.authorize(assertionFor("eve@example.org"), undefined)).rejects.toThrow("not authorized for this sandbox");
    });

    test("cannot pick an owner the sandbox was not created for", async () => {
        const owner = memOwner();
        const authz = createAuthorizer({ verify: verifierFor({}), owner, members: memMembers(), connectToken: "secret", expectedOwner: "ada@example.org", identityAssertion: verifier() });
        await expect(authz.authorize(assertionFor("eve@example.org"), "secret")).rejects.toThrow("this sandbox is registered to ada@example.org");
        expect(await owner.read()).toBeUndefined();
    });

    test("never opens a sandbox for an owner who bound with Google, there or at the owner-only doors", async () => {
        const authz = createAuthorizer({
            verify: verifierFor({ "google-ada": "ada@example.org" }),
            owner: memOwner("ada@example.org"),
            members: memMembers(),
            identityAssertion: verifier(),
        });
        expect(await reasonOf(authz.authorize(assertionFor("ada@example.org"), undefined))).toBe(EMAIL_SIGN_IN_OFF);
        expect(await reasonOf(authz.authorizeOwner(assertionFor("ada@example.org")))).toBe(EMAIL_SIGN_IN_OFF);
        expect(await reasonOf(authz.authorizeRetirement(assertionFor("ada@example.org")))).toBe(EMAIL_SIGN_IN_OFF);
        expect(await reasonOf(authz.authorizeRecovery(assertionFor("ada@example.org")))).toBe(EMAIL_SIGN_IN_OFF);
        // Google still opens it, as it always did.
        await expect(authz.authorize("google-ada", undefined)).resolves.toEqual({ email: "ada@example.org", role: "owner", methods: ["google"] });
    });

    test("opens it for a member only when the owner opted them in, and re-reads the opt-in on every request", async () => {
        const members = memMembers([
            { email: "bo@example.org", role: "collaborator", emailSignIn: true },
            { email: "cy@example.org", role: "viewer" },
        ]);
        const authz = createAuthorizer({
            verify: verifierFor({}),
            session: sessionFor({ "sess-bo": "bo@example.org", "sess-bo-passkey": "bo@example.org" }, ["email"]),
            owner: memOwner("ada@example.org"),
            members,
            identityAssertion: verifier(),
        });
        await expect(authz.authorize(assertionFor("bo@example.org"), undefined)).resolves.toEqual({ email: "bo@example.org", role: "collaborator", agents: "run", edits: "none", methods: ["email"] });
        expect(await reasonOf(authz.authorize(assertionFor("cy@example.org"), undefined))).toBe(EMAIL_SIGN_IN_OFF);
        await expect(authz.authorize("sess-bo", undefined)).resolves.toMatchObject({ email: "bo@example.org", methods: ["email"] });
        // The owner takes it back: the session minted from the platform's word stops at its next request.
        await members.add("bo@example.org", { role: "collaborator", emailSignIn: false });
        expect(await reasonOf(authz.authorize("sess-bo", undefined))).toBe(EMAIL_SIGN_IN_OFF);
    });

    test("lets a session that added a passkey or a recovery code of this daemon's own stand without the opt-in", async () => {
        const authz = createAuthorizer({
            verify: verifierFor({}),
            session: sessionFor({ "sess-cy": "cy@example.org" }, ["email", "passkey"]),
            owner: memOwner("ada@example.org"),
            members: memMembers([{ email: "cy@example.org", role: "viewer" }]),
            identityAssertion: verifier(),
        });
        await expect(authz.authorize("sess-cy", undefined)).resolves.toEqual({ email: "cy@example.org", role: "viewer", agents: "off", edits: "none", methods: ["email", "passkey"], renewal: true });
    });

    test("on a hosted machine opens it for anyone on the roster and binds without the connect token, as the owner ticket does", async () => {
        const owner = memOwner();
        const authz = createAuthorizer({
            verify: verifierFor({}),
            owner,
            members: memMembers([{ email: "cy@example.org", role: "viewer" }]),
            connectToken: "secret",
            expectedOwner: "ada@example.org",
            identityAssertion: verifier(),
            assertionsForAnyone: true,
        });
        await expect(authz.authorize(assertionFor("ada@example.org"), undefined)).resolves.toEqual({ email: "ada@example.org", role: "owner", methods: ["email"] });
        await expect(authz.authorize(assertionFor("cy@example.org"), undefined)).resolves.toEqual({ email: "cy@example.org", role: "viewer", agents: "off", edits: "none", methods: ["email"] });
    });

    test("spends each assertion once, and refuses another sandbox's, another key's, and any without a verifier, never asking Google", async () => {
        const otherKey = pemPair().privateKey;
        const googleAsked: string[] = [];
        const verify: IdTokenVerifier = async (token) => {
            googleAsked.push(token);
            throw new Error("invalid token");
        };
        const authz = createAuthorizer({ verify, owner: memOwner("ada@example.org", true), members: memMembers(), identityAssertion: verifier() });
        const once = assertionFor("ada@example.org");
        await expect(authz.authorize(once, undefined)).resolves.toMatchObject({ role: "owner" });
        await expect(authz.authorize(once, undefined)).rejects.toThrow("identity assertion refused: already spent");
        await expect(authz.authorize(assertionFor("ada@example.org", "ffffffffffff"), undefined)).rejects.toThrow("identity assertion refused: not for this sandbox");
        await expect(authz.authorize(assertionFor("ada@example.org", SANDBOX, otherKey), undefined)).rejects.toThrow("identity assertion refused: not for this sandbox");
        const withoutVerifier = createAuthorizer({ verify, owner: memOwner("ada@example.org", true), members: memMembers() });
        await expect(withoutVerifier.authorize(assertionFor("ada@example.org"), undefined)).rejects.toThrow("does not accept the platform's identity assertion");
        expect(googleAsked).toEqual([]);
    });

    test("says the key is not known yet, rather than refusing the person, when the platform has not answered", async () => {
        const authz = createAuthorizer({
            verify: verifierFor({}),
            owner: memOwner("ada@example.org", true),
            members: memMembers(),
            identityAssertion: identityAssertionVerifier({ key: async () => undefined, sandboxId: SANDBOX }),
        });
        await expect(authz.authorize(assertionFor("ada@example.org"), undefined)).rejects.toBeInstanceOf(PlatformKeyUnknownError);
    });
});

describe("memberRow", () => {
    test("keeps a person's email sign-in through a re-grade that does not mention it, and drops it when told", () => {
        const previous: Member = { email: "bo@example.org", role: "viewer", emailSignIn: true };
        expect(memberRow("bo@example.org", { role: "collaborator" }, previous)).toEqual({ email: "bo@example.org", role: "collaborator", emailSignIn: true });
        expect(memberRow("bo@example.org", { role: "collaborator", emailSignIn: false }, previous)).toEqual({ email: "bo@example.org", role: "collaborator" });
        expect(memberRow("bo@example.org", { role: "viewer", emailSignIn: true })).toEqual({ email: "bo@example.org", role: "viewer", emailSignIn: true });
    });
});

// The require-passkey policy: read per request like the roster, satisfied by a passkey or a recovery code, and open to
// a proof with neither only for the two registration routes and only for an identity holding no passkey yet.
describe("require-passkey policy", () => {
    const policy = (required: boolean, enrolled: readonly string[] = [], existing: readonly string[] = []): PasskeyPolicy => ({
        required: async () => required,
        enrolled: async (email) => enrolled.includes(email.toLowerCase()),
        exists: async (credentialId) => existing.includes(credentialId),
    });
    const withPolicy = (
        passkeys: PasskeyPolicy,
        sessions: Record<string, string>,
        methods: readonly ProofMethod[] = ["google"],
        credentialId?: string,
    ) =>
        createAuthorizer({
            verify: verifierFor({ "tok-a": "a@x.com", "tok-m": "m@x.com" }),
            session: sessionFor(sessions, methods, credentialId),
            passkeys,
            owner: memOwner("a@x.com"),
            members: memMembers(granted("m@x.com")),
        });

    test("off: a Google proof opens every route, as before", async () => {
        const authz = withPolicy(policy(false, ["a@x.com"]), {});
        await expect(authz.authorize("tok-a", undefined)).resolves.toEqual({ email: "a@x.com", role: "owner", methods: ["google"] });
    });

    test("on: a Google proof is refused with 428's error, saying whether the caller holds a passkey to answer with", async () => {
        const authz = withPolicy(policy(true, ["a@x.com"]), {});
        expect(await rejection(authz.authorize("tok-a", undefined))).toSatisfy((error) => error instanceof PasskeyRequiredError && error.enrolled);
        expect(await rejection(authz.authorize("tok-m", undefined))).toSatisfy((error) => error instanceof PasskeyRequiredError && !error.enrolled);
        // Not a Forbidden: the identity is welcome, the proof is short.
        await expect(authz.authorize("tok-m", undefined)).rejects.not.toBeInstanceOf(ForbiddenError);
    });

    test("on: the enrolment allowance opens the registration routes to a first passkey only", async () => {
        const authz = withPolicy(policy(true, ["a@x.com"]), {});
        // Holding none yet: the Google proof may register the first.
        await expect(authz.authorize("tok-m", undefined, { enrolment: true })).resolves.toEqual({
            email: "m@x.com",
            role: "collaborator",
            agents: "run",
            edits: "none",
            methods: ["google"],
        });
        // Holding one: only that passkey opens the door, registration included, so a stolen Google account adds nothing.
        await expect(authz.authorize("tok-a", undefined, { enrolment: true })).rejects.toBeInstanceOf(PasskeyRequiredError);
    });

    test("on: a session proven by a passkey or a recovery code passes; the hosted owner ticket alone does not", async () => {
        const passkey = withPolicy(policy(true, ["a@x.com"]), { "sess-a": "a@x.com" }, ["passkey"]);
        await expect(passkey.authorize("sess-a", undefined)).resolves.toEqual({ email: "a@x.com", role: "owner", methods: ["passkey"], renewal: true });
        const recovered = withPolicy(policy(true, ["a@x.com"]), { "sess-a": "a@x.com" }, ["google", "recovery"]);
        await expect(recovered.authorize("sess-a", undefined)).resolves.toEqual({ email: "a@x.com", role: "owner", methods: ["google", "recovery"], renewal: true });

        const pair = generateKeyPairSync("ed25519");
        const ticketed = createAuthorizer({
            verify: verifierFor({}),
            passkeys: policy(true, ["a@x.com"]),
            owner: memOwner("a@x.com"),
            members: memMembers(),
            ownerTicket: ownerTicketVerifier(pair.publicKey.export({ type: "spki", format: "pem" }) as string, "0123456789ab"),
        });
        const ticket = mintOwnerTicket(pair.privateKey.export({ type: "pkcs8", format: "pem" }) as string, {
            sandboxId: "0123456789ab",
            email: "a@x.com",
            issuedAtMs: Date.now(),
        });
        await expect(ticketed.authorize(ticket, undefined)).rejects.toBeInstanceOf(PasskeyRequiredError);
    });

    test("a session from a passkey that has since been removed is refused as an authentication failure", async () => {
        const live = withPolicy(policy(false, [], ["cred-1"]), { "sess-a": "a@x.com" }, ["passkey"], "cred-1");
        await expect(live.authorize("sess-a", undefined)).resolves.toMatchObject({ email: "a@x.com", credentialId: "cred-1" });
        const removed = withPolicy(policy(false, [], []), { "sess-a": "a@x.com" }, ["passkey"], "cred-1");
        await expect(removed.authorize("sess-a", undefined)).rejects.toThrow(/passkey this session came from has been removed/);
        await expect(removed.authorize("sess-a", undefined)).rejects.not.toBeInstanceOf(ForbiddenError);
    });

    test("authorizeProven holds a daemon-verified proof to the roster: owner, member, stranger, and no owner yet", async () => {
        const authz = withPolicy(policy(true, ["a@x.com"]), {});
        await expect(authz.authorizeProven({ email: "A@x.com", methods: ["passkey"], credentialId: "c" })).resolves.toEqual({
            email: "A@x.com",
            role: "owner",
            methods: ["passkey"],
            credentialId: "c",
        });
        await expect(authz.authorizeProven({ email: "m@x.com", methods: ["passkey"] })).resolves.toMatchObject({ role: "collaborator" });
        await expect(authz.authorizeProven({ email: "x@x.com", methods: ["passkey"] })).rejects.toBeInstanceOf(ForbiddenError);
        const unbound = createAuthorizer({ verify: verifierFor({}), owner: memOwner(), members: memMembers() });
        await expect(unbound.authorizeProven({ email: "a@x.com", methods: ["passkey"] })).rejects.toThrow(/no owner yet/);
    });

    test("the recovery and retirement doors take the owner's Google proof with the policy on, and nobody else's", async () => {
        const authz = withPolicy(policy(true, ["a@x.com"]), {});
        await expect(authz.authorizeRecovery("tok-a")).resolves.toEqual({ email: "a@x.com", role: "owner", methods: ["google"] });
        await expect(authz.authorizeRecovery("tok-m")).rejects.toBeInstanceOf(ForbiddenError);
        await expect(authz.authorizeRecovery("")).rejects.toThrow(/missing bearer/);
        await expect(authz.authorizeRetirement("tok-a")).resolves.toBeUndefined();
    });
});
