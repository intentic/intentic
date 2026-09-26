import type { Hono } from "hono";
import { createApp } from "../../app.js";
import type { AppEnv } from "../../app-env.js";
import { softwareAuthenticator } from "../../harness/passkey-authenticator.testing.js";
import { proven, rejectForbidden } from "../../harness/route-client.testing.js";
import { memoryPasskeyStore, rejectAuth } from "../auth-slice.testing.js";
import { services } from "../../harness/route-services.testing.js";
import { ForbiddenError, type Proof, type ProvenCaller } from "../auth.js";
import type { PasskeyStore } from "./passkey-store.js";

// The passkey routes over the daemon's HTTP surface, as the browser drives them: registration upgrades the session that
// asked, the two anonymous doors mint one from a passkey alone, and the owner's switch cannot lock the owner out.

const ORIGIN = "https://app.test";
const RP_ID = "app.test";
const OWNER = "o@x.com";
const MEMBER = "m@x.com";

// The session a mint produced, legible: who, proven how, from which passkey.
const mintSession = async (proof: Proof) => ({
    token: `sess:${proof.email}:${proof.methods.join("+")}${proof.credentialId === undefined ? "" : `:${proof.credentialId}`}`,
    expiresAt: 42,
});

interface Daemon {
    readonly app: Hono<AppEnv>;
    readonly store: PasskeyStore;
    readonly closed: string[];
}

// The roster the daemon-verified doors hold a proof to: owner, member, and a Forbidden stranger.
const roster = async (proof: Proof): Promise<ProvenCaller> => {
    if (proof.email === OWNER) {
        return { ...proof, role: "owner" };
    }
    if (proof.email === MEMBER) {
        return { ...proof, role: "collaborator" };
    }
    throw new ForbiddenError("not authorized for this sandbox");
};

// The bearer gates as they answer for `caller`: nobody (401 everywhere), a member (403 on the owner's), or the owner.
const authFor = (caller: ProvenCaller | undefined) => {
    if (caller === undefined) {
        return { authorize: rejectAuth, authorizeOwner: rejectAuth, authorizeRecovery: rejectAuth };
    }
    const admit = async () => caller;
    return caller.role === "owner"
        ? { authorize: admit, authorizeOwner: async () => {}, authorizeRecovery: admit }
        : { authorize: admit, authorizeOwner: rejectForbidden, authorizeRecovery: rejectForbidden };
};

// A daemon whose bearer middleware admits `caller` (or refuses everyone), over a memory passkey store.
const daemon = (caller: ProvenCaller | undefined, options: { readonly store?: PasskeyStore; readonly required?: boolean } = {}): Daemon => {
    const store = options.store ?? memoryPasskeyStore([], options.required ?? false);
    const composed = services({
        passkeys: store,
        ownerEmail: async () => OWNER,
        auth: { ...authFor(caller), authorizeProven: roster, mintSession },
    });
    const closed: string[] = [];
    if (caller !== undefined) {
        composed.auth?.connections.register(caller, () => closed.push(caller.email));
    }
    return { app: createApp(composed), store, closed };
};

const json = async (app: Hono<AppEnv>, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> =>
    app.request(path, {
        method,
        headers: { origin: ORIGIN, authorization: "Bearer x", ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

const bodyOf = async <T>(response: Response): Promise<T> => (await response.json()) as T;

// Registers `authenticator` through the routes as the daemon's admitted caller; returns the register response body.
const registerThrough = async (app: Hono<AppEnv>, authenticator: ReturnType<typeof softwareAuthenticator>, label?: string) => {
    const options = await bodyOf<{ challenge: string; rp: { id: string } }>(await json(app, "POST", "/system/passkeys/register/options", {}));
    expect(options.rp.id).toBe(RP_ID);
    const response = authenticator.create({ challenge: options.challenge, origin: ORIGIN, rpId: RP_ID });
    return json(app, "POST", "/system/passkeys/register", { response, ...(label === undefined ? {} : { label }) });
};

test("registering a passkey stores it for the caller and upgrades the Google-proven session that asked", async () => {
    const { app, store } = daemon(proven(OWNER, "owner"));
    const authenticator = softwareAuthenticator();
    const registered = await registerThrough(app, authenticator, "laptop");
    expect(registered.status).toBe(200);
    expect(await registered.json()).toEqual({
        passkey: { id: authenticator.credentialId, email: OWNER, label: "laptop", rpId: RP_ID, createdAt: expect.any(Number), backedUp: false },
        session: { token: `sess:${OWNER}:google+passkey:${authenticator.credentialId}`, expiresAt: 42, email: OWNER },
    });
    expect((await store.list()).map((credential) => credential.email)).toEqual([OWNER]);

    const listed = await json(app, "GET", "/system/passkeys");
    expect(await listed.json()).toEqual({ passkeys: [expect.objectContaining({ id: authenticator.credentialId })], required: false });
});

test("a caller already proven by a passkey gets no new session from registering another", async () => {
    const { app } = daemon(proven(OWNER, "owner", ["passkey"]));
    const body = await bodyOf<Record<string, unknown>>(await registerThrough(app, softwareAuthenticator()));
    expect(Object.keys(body)).toEqual(["passkey"]);
});

test("a malformed registration body is a 400, and a response for a challenge nobody issued is too", async () => {
    const { app } = daemon(proven(OWNER, "owner"));
    expect((await json(app, "POST", "/system/passkeys/register", { response: { id: "nope" } })).status).toBe(400);
    const stray = softwareAuthenticator().create({ challenge: "never-issued", origin: ORIGIN, rpId: RP_ID });
    const refused = await json(app, "POST", "/system/passkeys/register", { response: stray });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "this response answers no challenge this sandbox issued; start again" });
});

test("the sign-in doors take no bearer: options list this origin's passkeys, and a valid assertion mints a session", async () => {
    const store = memoryPasskeyStore();
    const authenticator = softwareAuthenticator();
    await registerThrough(daemon(proven(OWNER, "owner"), { store }).app, authenticator);

    // The bearer middleware refuses everyone; both doors still answer.
    const anonymous = daemon(undefined, { store }).app;
    const options = await json(anonymous, "POST", "/system/passkeys/assert/options", {}, { authorization: "" });
    expect(options.status).toBe(200);
    const issued = await bodyOf<{ challenge: string; available: boolean; allowCredentials: { id: string }[] }>(options);
    expect(issued.available).toBe(true);
    expect(issued.allowCredentials.map((entry) => entry.id)).toEqual([authenticator.credentialId]);

    const response = authenticator.get({ challenge: issued.challenge, origin: ORIGIN, rpId: RP_ID });
    const signedIn = await json(anonymous, "POST", "/system/passkeys/assert", { response }, { authorization: "" });
    expect(signedIn.status).toBe(200);
    expect(await signedIn.json()).toEqual({ token: `sess:${OWNER}:passkey:${authenticator.credentialId}`, expiresAt: 42, email: OWNER });
    expect((await store.find(authenticator.credentialId))?.lastUsedAt).toEqual(expect.any(Number));
});

test("an assertion from a passkey whose holder was removed from the roster is 403; an unknown passkey 404; garbage 400", async () => {
    const store = memoryPasskeyStore();
    const stranger = softwareAuthenticator();
    // Registered as a member who is then no longer on the roster (the roster fake knows only OWNER and MEMBER).
    await registerThrough(daemon(proven("gone@x.com", "collaborator"), { store }).app, stranger);
    const anonymous = daemon(undefined, { store }).app;
    const issued = await bodyOf<{ challenge: string }>(await json(anonymous, "POST", "/system/passkeys/assert/options", {}));
    const response = stranger.get({ challenge: issued.challenge, origin: ORIGIN, rpId: RP_ID });
    expect((await json(anonymous, "POST", "/system/passkeys/assert", { response })).status).toBe(403);

    const unknown = await bodyOf<{ challenge: string }>(await json(anonymous, "POST", "/system/passkeys/assert/options", {}));
    const unregistered = softwareAuthenticator().get({ challenge: unknown.challenge, origin: ORIGIN, rpId: RP_ID });
    expect((await json(anonymous, "POST", "/system/passkeys/assert", { response: unregistered })).status).toBe(404);
    expect((await json(anonymous, "POST", "/system/passkeys/assert", { response: 7 })).status).toBe(400);
});

test("in loopback mode there is no sign-in to add a passkey to: every passkey route 404s", async () => {
    const app = createApp(services({}));
    expect((await json(app, "GET", "/system/passkeys")).status).toBe(404);
    expect((await json(app, "POST", "/system/passkeys/assert/options", {})).status).toBe(404);
    expect((await json(app, "POST", "/system/session/recover", { code: "x" })).status).toBe(404);
});

test("a member sees and removes only their own passkeys; the owner sees everyone's and may remove a member's", async () => {
    const store = memoryPasskeyStore();
    const ownerKey = softwareAuthenticator();
    const memberKey = softwareAuthenticator();
    await registerThrough(daemon(proven(OWNER, "owner"), { store }).app, ownerKey);
    await registerThrough(daemon(proven(MEMBER, "collaborator"), { store }).app, memberKey);

    const member = daemon(proven(MEMBER, "collaborator"), { store });
    const memberList = await bodyOf<{ passkeys: { id: string }[] }>(await json(member.app, "GET", "/system/passkeys"));
    expect(memberList.passkeys.map((entry) => entry.id)).toEqual([memberKey.credentialId]);
    expect((await json(member.app, "DELETE", `/system/passkeys/${ownerKey.credentialId}`)).status).toBe(403);
    expect((await json(member.app, "DELETE", "/system/passkeys/no-such")).status).toBe(404);

    const owner = daemon(proven(OWNER, "owner"), { store });
    const ownerList = await bodyOf<{ passkeys: { id: string }[] }>(await json(owner.app, "GET", "/system/passkeys"));
    expect(ownerList.passkeys.map((entry) => entry.id).toSorted()).toEqual([ownerKey.credentialId, memberKey.credentialId].toSorted());
    expect((await json(owner.app, "DELETE", `/system/passkeys/${memberKey.credentialId}`)).status).toBe(200);
    expect((await store.list()).map((credential) => credential.id)).toEqual([ownerKey.credentialId]);

    // Removing one's own passkey closes that person's live transports, so a lost device's streams end now.
    expect((await json(member.app, "DELETE", `/system/passkeys/${ownerKey.credentialId}`)).status).toBe(403);
    expect((await json(owner.app, "DELETE", `/system/passkeys/${ownerKey.credentialId}`)).status).toBe(200);
    expect(owner.closed).toEqual([OWNER]);
});

test("requiring a passkey needs one of the owner's first, hands out recovery codes once, and closes every open transport", async () => {
    const owner = daemon(proven(OWNER, "owner"));
    expect((await json(owner.app, "POST", "/system/passkeys/policy", { required: true })).status).toBe(409);
    expect(await owner.store.required()).toBe(false);

    const authenticator = softwareAuthenticator();
    await registerThrough(owner.app, authenticator);
    const switched = await json(owner.app, "POST", "/system/passkeys/policy", { required: true });
    expect(switched.status).toBe(200);
    const { required, codes } = await bodyOf<{ required: boolean; codes: string[] }>(switched);
    expect(required).toBe(true);
    expect(codes.length).toBe(8);
    expect(await owner.store.required()).toBe(true);
    expect(owner.closed).toEqual([OWNER]);
    expect(await bodyOf(await json(owner.app, "GET", "/system/passkeys"))).toMatchObject({ required: true, recovery: { remaining: 8 } });

    // The owner's last passkey stays while the switch is on.
    const last = await json(owner.app, "DELETE", `/system/passkeys/${authenticator.credentialId}`);
    expect(last.status).toBe(409);
    expect(await owner.store.list()).toHaveLength(1);

    // Fresh codes forget the old ones.
    const regenerated = await bodyOf<{ codes: string[] }>(await json(owner.app, "POST", "/system/passkeys/recovery", {}));
    expect(regenerated.codes).toHaveLength(8);
    expect(regenerated.codes).not.toEqual(codes);

    // Off: the codes are gone with it, and regenerating is a step out of order.
    expect(await bodyOf<{ required: boolean }>(await json(owner.app, "POST", "/system/passkeys/policy", { required: false }))).toEqual({
        required: false,
    });
    expect(await owner.store.recovery()).toEqual([]);
    expect((await json(owner.app, "POST", "/system/passkeys/recovery", {})).status).toBe(409);
    expect((await json(owner.app, "POST", "/system/passkeys/policy", { required: "yes" })).status).toBe(400);
});

test("the policy and recovery routes are the owner's alone", async () => {
    const member = daemon(proven(MEMBER, "collaborator"));
    expect((await json(member.app, "POST", "/system/passkeys/policy", { required: true })).status).toBe(403);
    expect((await json(member.app, "POST", "/system/passkeys/recovery", {})).status).toBe(403);
});

test("a recovery code plus the owner's Google proof mints a recovery-proven session, once per code", async () => {
    const owner = daemon(proven(OWNER, "owner"));
    await registerThrough(owner.app, softwareAuthenticator());
    const { codes } = await bodyOf<{ codes: string[] }>(await json(owner.app, "POST", "/system/passkeys/policy", { required: true }));

    expect((await json(owner.app, "POST", "/system/session/recover", {})).status).toBe(400);
    const wrong = await json(owner.app, "POST", "/system/session/recover", { code: "abcde-abcde-abcde-abcde" });
    expect(wrong.status).toBe(403);
    const recovered = await json(owner.app, "POST", "/system/session/recover", { code: codes[0]!.toUpperCase() });
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toEqual({ token: `sess:${OWNER}:google+recovery`, expiresAt: 42, email: OWNER, remaining: 7 });
    expect((await json(owner.app, "POST", "/system/session/recover", { code: codes[0]! })).status).toBe(403);

    // A member's bearer, or none, never reaches the codes.
    const member = daemon(proven(MEMBER, "collaborator"), { store: owner.store });
    expect((await json(member.app, "POST", "/system/session/recover", { code: codes[1]! })).status).toBe(403);
    const nobody = daemon(undefined, { store: owner.store });
    expect((await json(nobody.app, "POST", "/system/session/recover", { code: codes[1]! })).status).toBe(401);
    expect((await owner.store.recovery()).filter((code) => code.usedAt === undefined)).toHaveLength(7);
});

test("the stored credential carries what a passkey-only session needs for presence: the registrant's display profile", async () => {
    const { app, store } = daemon({ ...proven(OWNER, "owner"), name: "Olive", picture: "https://p/o.png" });
    await registerThrough(app, softwareAuthenticator());
    const [credential] = await store.list();
    expect(credential).toMatchObject({ name: "Olive", picture: "https://p/o.png" });
});

test("the middleware passes the enrolment allowance to authorize only on the two registration paths", async () => {
    const seen: (boolean | undefined)[] = [];
    const authorize = jest.fn(async (_bearer: string, _first: string | undefined, options?: { enrolment?: boolean }) => {
        seen.push(options?.enrolment);
        return proven(OWNER, "owner");
    });
    const app = createApp(services({ auth: { authorize, authorizeOwner: async () => {} } }));
    await json(app, "POST", "/system/passkeys/register/options", {});
    await json(app, "GET", "/system/passkeys");
    await json(app, "GET", "/settings");
    expect(seen).toEqual([true, false, false]);
});
