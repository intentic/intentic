import { describe, expect, test } from "vitest";
import { createAuthorizer, ForbiddenError, type IdTokenVerifier, type Member, type MembersStore, type OwnerStore } from "./auth.js";

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

    test("returns the verifier's full identity — presence shows name/picture to the other members", async () => {
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
        // Wrong account can't claim ownership — and nothing is written, so the right account can still bind after.
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
        // A verified session is still subject to per-request membership — revoking a member kills live sessions.
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

    test("a session can never first-bind — an unbound daemon takes only a fresh Google proof", async () => {
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
