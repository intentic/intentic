import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GrantedRole, MemberRole } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { createApp } from "./app.js";
import { fileJoinLinks, type JoinLinks, type JoinOutcome } from "./auth/join-links.js";
import { postJson, rejectForbidden, services } from "./route-testing.js";

/* JOINING A SANDBOX BY LINK, at the route level — the outsider path the platform's invite mail used to be the
 * only way onto. The store's own rules (expiry, seats, idempotence) are covered in auth/join-links.integration.test.ts;
 * what these assert is the wiring nothing else can: who may mint, that a stranger with no bearer can redeem at
 * all, and the two refusals that keep redemption from being a way IN rather than a way onto the list. */

// A store stub that says yes to one secret. `redeemed` records what the route asked it, which is how the
// "verified email, never the client's word for it" property is asserted.
const linkStore = (outcome: JoinOutcome, redeemed: { secret?: string; email?: string } = {}): JoinLinks => ({
    mint: async () => ({ id: "link-1", secret: "ijl_minted" }),
    redeem: async (secret, email) => {
        redeemed.secret = secret;
        redeemed.email = email;
        return outcome;
    },
    list: async () => [],
    revoke: async () => true,
});

// An exposed daemon whose bearer path refuses everyone (no member is signed in) — so any success below came
// through the join route's own credential, not through an authorization these tests accidentally granted.
const joinable = (overrides: {
    joinLinks?: JoinLinks;
    members?: { list: () => Promise<{ email: string; role: GrantedRole }[]>; add: (email: string, role: GrantedRole) => Promise<void> };
    verifyVisitor?: (idToken: string) => Promise<{ email: string }>;
    ownerBound?: () => Promise<boolean>;
}) =>
    services({
        auth: {
            authorize: rejectForbidden,
            authorizeOwner: rejectForbidden,
            ...(overrides.ownerBound === undefined ? {} : { ownerBound: overrides.ownerBound }),
        },
        joinLinks: overrides.joinLinks ?? linkStore({ ok: true, role: "collaborator" }),
        verifyVisitor: (overrides.verifyVisitor ?? (async () => ({ email: "Ada@Example.com" }))) as never,
        members: {
            list: overrides.members?.list ?? (async () => []),
            add: overrides.members?.add ?? (async () => {}),
            remove: async () => {},
        },
    });

test("a stranger with no bearer redeems a link and lands on the members list with the role it carried", async () => {
    const added: { email: string; role: MemberRole }[] = [];
    const asked: { secret?: string; email?: string } = {};
    const app = createApp(
        joinable({
            joinLinks: linkStore({ ok: true, role: "collaborator" }, asked),
            members: { list: async () => [], add: async (email, role) => void added.push({ email, role }) },
        }),
    );

    const response = await postJson(app, "/join", { secret: "ijl_good", idToken: "google-token" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ email: "ada@example.com", role: "collaborator" });
    // The email is the VERIFIED one, lowercased — never a field the client sent.
    expect(added).toEqual([{ email: "ada@example.com", role: "collaborator" }]);
    expect(asked).toEqual({ secret: "ijl_good", email: "ada@example.com" });
});

test("an unverifiable sign-in is refused, and no link is spent on it", async () => {
    const asked: { secret?: string } = {};
    const app = createApp(
        joinable({
            joinLinks: linkStore({ ok: true, role: "collaborator" }, asked),
            verifyVisitor: async () => {
                throw new Error("bad token");
            },
        }),
    );

    const response = await postJson(app, "/join", { secret: "ijl_good", idToken: "forged" });

    expect(response.status).toBe(401);
    // The store was never consulted: a forged sign-in must not consume a seat on a real link.
    expect(asked.secret).toBeUndefined();
});

/* THE ONE THAT PROTECTS THE BOX ITSELF. Ownership is trust-on-first-use, so a guest admitted to an unowned
 * sandbox would become its owner on their next call — joining would hand the box away. */
test("refused outright while no owner is bound", async () => {
    const app = createApp(joinable({ ownerBound: async () => false }));

    const response = await postJson(app, "/join", { secret: "ijl_good", idToken: "google-token" });

    expect(response.status).toBe(409);
});

test("a refused link says which refusal it was, and adds nobody", async () => {
    const added: string[] = [];
    const app = createApp(
        joinable({
            joinLinks: linkStore({ ok: false, reason: "expired" }),
            members: { list: async () => [], add: async (email) => void added.push(email) },
        }),
    );

    const response = await postJson(app, "/join", { secret: "ijl_stale", idToken: "google-token" });

    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ error: "expired" });
    expect(added).toEqual([]);
});

test("a link never DOWNGRADES someone who already holds more — the guest keeps their standing", async () => {
    const added: string[] = [];
    const app = createApp(
        joinable({
            joinLinks: linkStore({ ok: true, role: "viewer" }),
            members: {
                list: async () => [{ email: "ada@example.com", role: "maintainer" }],
                add: async (email) => void added.push(email),
            },
        }),
    );

    const response = await postJson(app, "/join", { secret: "ijl_viewer", idToken: "google-token" });

    expect(await response.json()).toEqual({ email: "ada@example.com", role: "maintainer" });
    expect(added).toEqual([]);
});

test("minting, listing and revoking links are the OWNER's, not a member's", async () => {
    // A signed-in MAINTAINER — the highest tier that is still not the owner, so nothing but the owner gate
    // itself can be what refuses these three.
    const app = createApp(
        services({
            auth: { authorize: async () => ({ email: "grace@example.com", role: "maintainer" as const }), authorizeOwner: rejectForbidden },
        }),
    );

    expect((await app.request("/join-links")).status).toBe(403);
    expect((await postJson(app, "/join-links", { label: "Ada", role: "viewer" })).status).toBe(403);
    expect((await app.request("/join-links", { method: "DELETE", body: JSON.stringify({ id: "x" }) })).status).toBe(403);
});

test("the owner mints a link and gets the secret exactly once", async () => {
    const app = createApp(
        services({
            auth: { authorize: async () => ({ email: "owner@x.com", role: "owner" as const }), authorizeOwner: async () => {} },
            joinLinks: linkStore({ ok: true, role: "viewer" }),
        }),
    );

    const response = await postJson(app, "/join-links", { label: "Ada", role: "viewer", expiresInDays: 7, maxUses: 1 });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "link-1", secret: "ijl_minted", links: [] });
});

/* THE WHOLE LOOP, WITHOUT A STUB BETWEEN THE TWO HALVES: the owner mints through the route, the secret that
 * comes back is the one a guest pastes, and redeeming it through the public route puts them on the members
 * list. Every test above fakes one side or the other; this is the one that would catch the two halves
 * agreeing about a shape neither actually writes. */
test("minted here, redeemed there: the real store carries a link from the owner to a guest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "join-loop-"));
    try {
        const store = fileJoinLinks(join(dir, "join-links.json"));
        const members: { email: string; role: GrantedRole }[] = [];
        const shared = {
            joinLinks: store,
            verifyVisitor: (async () => ({ email: "ada@example.com" })) as never,
            members: {
                list: async () => members,
                add: async (email: string, role: GrantedRole) => void members.push({ email, role }),
                remove: async () => {},
            },
        };

        const ownerApp = createApp(
            services({
                auth: { authorize: async () => ({ email: "owner@x.com", role: "owner" as const }), authorizeOwner: async () => {} },
                ...shared,
            }),
        );
        const minted = (await (await postJson(ownerApp, "/join-links", { label: "Ada", role: "collaborator", maxUses: 1 })).json()) as {
            secret: string;
        };

        // A different app instance, standing in for the stranger's browser: no bearer, no session, nothing but
        // the secret and a Google sign-in.
        const guestApp = createApp(services({ auth: { authorize: rejectForbidden, authorizeOwner: rejectForbidden }, ...shared }));
        const joined = await postJson(guestApp, "/join", { secret: minted.secret, idToken: "google-token" });

        expect(joined.status).toBe(200);
        expect(members).toEqual([{ email: "ada@example.com", role: "collaborator" }]);
        // The owner now sees who used it — the guest list that makes a link auditable after the fact.
        expect((await store.list())[0]?.redeemedBy).toEqual(["ada@example.com"]);

        // …and the one seat is spent, so the next stranger is refused.
        const secondPerson = createApp(
            services({
                auth: { authorize: rejectForbidden, authorizeOwner: rejectForbidden },
                ...shared,
                verifyVisitor: (async () => ({ email: "mallory@example.com" })) as never,
            }),
        );
        expect((await postJson(secondPerson, "/join", { secret: minted.secret, idToken: "google-token" })).status).toBe(410);
        expect(members).toHaveLength(1);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("a mint without a role is refused — a link IS a role decision", async () => {
    const app = createApp(
        services({ auth: { authorize: async () => ({ email: "owner@x.com", role: "owner" as const }), authorizeOwner: async () => {} } }),
    );

    expect((await postJson(app, "/join-links", { label: "Ada" })).status).toBe(400);
    expect((await postJson(app, "/join-links", { label: "Ada", role: "owner" })).status).toBe(400);
});
