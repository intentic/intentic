import { generateKeyPairSync } from "node:crypto";
import { mintOwnerTicket } from "@intentic/sandbox-contract/owner-ticket";
import { describe, expect, test } from "vitest";
import {
    authorizeMaintainer,
    createAuthorizer,
    ForbiddenError,
    type IdTokenVerifier,
    type Member,
    type MembersStore,
    type OwnerStore,
    ownerTicketVerifier,
} from "./auth.js";

// In-memory owner store so the TOFU branching is exercised without touching disk.
const memOwner = (initial?: string): OwnerStore => {
    let value = initial;
    return {
        read: async () => value,
        write: async (email) => {
            value = email;
        },
    };
};

// In-memory shared-access list (the identities allowed besides the owner, each with its granted role).
const memMembers = (initial: Member[] = []): MembersStore => {
    let members = [...initial];
    return {
        list: async () => members,
        add: async (email, role) => {
            members = [...members.filter((member) => member.email !== email), { email, role }];
        },
        remove: async (email) => {
            members = members.filter((member) => member.email !== email);
        },
    };
};

// Most tests only care that an email is on the list; the role rides along.
const granted = (...emails: string[]): Member[] => emails.map((email) => ({ email, role: "collaborator" as const }));

// A fake verifier mapping a token straight to an email; an unknown token throws, standing in for a failed
// JWKS/issuer/audience verification.
const verifierFor =
    (map: Record<string, string>): IdTokenVerifier =>
    async (token) => {
        const email = map[token];
        if (email === undefined) {
            throw new Error("invalid token");
        }
        return { email };
    };

describe("createAuthorizer (owner TOFU + shared access)", () => {
    test("binds the first authenticated email as owner, then accepts only that owner", async () => {
        const owner = memOwner();
        const authz = createAuthorizer({ verify: verifierFor({ "tok-a": "a@x.com", "tok-b": "b@x.com" }), owner, members: memMembers() });
        await expect(authz.authorize("tok-a", undefined)).resolves.toEqual({ email: "a@x.com", role: "owner" });
        expect(await owner.read()).toBe("a@x.com");
        await expect(authz.authorize("tok-a", undefined)).resolves.toEqual({ email: "a@x.com", role: "owner" });
        await expect(authz.authorize("tok-b", undefined)).rejects.toBeInstanceOf(ForbiddenError);
    });

    test("accepts a granted member, rejects a stranger", async () => {
        const authz = createAuthorizer({
            verify: verifierFor({ "tok-m": "m@x.com", "tok-x": "x@x.com" }),
            owner: memOwner("a@x.com"),
            members: memMembers(granted("m@x.com")),
        });
        await expect(authz.authorize("tok-m", undefined)).resolves.toEqual({ email: "m@x.com", role: "collaborator" });
        await expect(authz.authorize("tok-x", undefined)).rejects.toBeInstanceOf(ForbiddenError);
    });

    /* THE ROSTER IS LOWERCASE AND THE CLAIM IS NOT, and an exact comparison between them is a permanent
     * lockout. Every write normalizes (app.ts's memberGrant/memberEmail both `.toLowerCase()`), while a Google
     * Workspace `email` claim can preserve case — so a grant for `Alice@Corp.com` stores as `alice@corp.com`,
     * and Alice was then a stranger to `enforce` forever. The owner's own `GET /members` still listed her, so
     * the roster and the daemon disagreed with nothing on either side to explain it. First-bind already
     * compared case-insensitively (the test below says so); these are the paths that did not. */
    test("a granted member is recognised whatever case the claim carries", async () => {
        const authz = createAuthorizer({
            verify: verifierFor({ "tok-m": "Alice@Corp.com" }),
            owner: memOwner("a@x.com"),
            members: memMembers(granted("alice@corp.com")),
        });
        await expect(authz.authorize("tok-m", undefined)).resolves.toEqual({ email: "Alice@Corp.com", role: "collaborator" });
    });

    test("the owner is recognised whatever case the claim carries, on every owner-only gate", async () => {
        const authz = createAuthorizer({
            verify: verifierFor({ "tok-a": "Ada@Corp.com" }),
            owner: memOwner("ada@corp.com"),
            members: memMembers(),
        });
        await expect(authz.authorize("tok-a", undefined)).resolves.toEqual({ email: "Ada@Corp.com", role: "owner" });
        await expect(authz.authorizeOwner("tok-a")).resolves.toBeUndefined();
        await expect(authz.authorizeRetirement("tok-a")).resolves.toBeUndefined();
    });

    // An unbound sandbox has no owner to be: the owner-only gates must refuse rather than compare against
    // undefined, which is the shape that would let `email !== undefined` read as "not the owner" by accident.
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
        });
    });

    test("rejects a missing bearer as an authentication failure, not Forbidden", async () => {
        const authz = createAuthorizer({ verify: verifierFor({}), owner: memOwner(), members: memMembers() });
        await expect(authz.authorize("", undefined)).rejects.toSatisfy(
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
        await expect(authz.authorize("tok-a", undefined)).rejects.toSatisfy(
            (error) => error instanceof Error && !(error instanceof ForbiddenError) && /connection token/.test(error.message),
        );
        await expect(authz.authorize("tok-a", "wrong")).rejects.toThrow(/connection token/);
        expect(await owner.read()).toBeUndefined();
        await authz.authorize("tok-a", "secret");
        expect(await owner.read()).toBe("a@x.com");
        await expect(authz.authorize("tok-a", undefined)).resolves.toEqual({ email: "a@x.com", role: "owner" });
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
        await expect(authz.authorize("tok-b", undefined)).rejects.toSatisfy(
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
        await expect(authz.authorizeOwner("")).rejects.toSatisfy(
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
            session: verifierFor({ "sess-a": "a@x.com", "sess-m": "m@x.com", "sess-x": "x@x.com" }),
            owner: memOwner("a@x.com"),
            members: memMembers(granted("m@x.com")),
        });
        await expect(authz.authorize("sess-a", undefined)).resolves.toEqual({ email: "a@x.com", role: "owner" });
        await expect(authz.authorize("sess-m", undefined)).resolves.toEqual({ email: "m@x.com", role: "collaborator" });
        // A verified session is still subject to per-request membership: revoking a member kills live sessions.
        await expect(authz.authorize("sess-x", undefined)).rejects.toBeInstanceOf(ForbiddenError);
        await expect(authz.authorizeOwner("sess-a")).resolves.toBeUndefined();
        await expect(authz.authorizeOwner("sess-m")).rejects.toBeInstanceOf(ForbiddenError);
    });

    test("a bearer that is not a session falls through to the Google verifier", async () => {
        const authz = createAuthorizer({
            verify: verifierFor({ "tok-a": "a@x.com" }),
            session: verifierFor({}),
            owner: memOwner("a@x.com"),
            members: memMembers(),
        });
        await expect(authz.authorize("tok-a", undefined)).resolves.toEqual({ email: "a@x.com", role: "owner" });
        await expect(authz.authorize("bogus", undefined)).rejects.toThrow(/invalid token/);
    });

    test("a session can never first-bind: an unbound daemon takes only a fresh Google proof", async () => {
        const owner = memOwner();
        const authz = createAuthorizer({
            verify: verifierFor({ "tok-a": "a@x.com" }),
            session: verifierFor({ "sess-a": "a@x.com" }),
            owner,
            members: memMembers(),
        });
        await expect(authz.authorize("sess-a", undefined)).rejects.toThrow(/invalid token/);
        expect(await owner.read()).toBeUndefined();
        await expect(authz.authorize("tok-a", undefined)).resolves.toEqual({ email: "a@x.com", role: "owner" });
        expect(await owner.read()).toBe("a@x.com");
    });
});

/* THE PLATFORM'S OWNER TICKET (sandbox-contract's owner-ticket.ts), the hosted lane's way past the second Google
 * prompt. Held to every rule a Google proof is: it names THIS sandbox, the expected owner on first-bind, and the
 * roster afterwards, and it satisfies the connect-token gate by itself, because the platform that signed it is
 * the platform that put the token in the machine's env. */
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
        await expect(authz.authorize(ticketFor("A@x.com"), undefined)).resolves.toEqual({ email: "a@x.com", role: "owner" });
        expect(await owner.read()).toBe("a@x.com");
        // Bound: a later ticket for the owner is the owner; one for a stranger is refused by the roster.
        await expect(authz.authorize(ticketFor("a@x.com"), undefined)).resolves.toEqual({ email: "a@x.com", role: "owner" });
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
