import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { softwareAuthenticator } from "../../harness/passkey-authenticator.testing.js";
import { memoryPasskeyStore } from "../../harness/route-stores.testing.js";
import {
    createPasskeyCeremonies,
    filePasskeys,
    hashRecoveryCode,
    mintRecoveryCodes,
    normalizeRecoveryCode,
    PasskeyError,
    type PasskeyStore,
    RECOVERY_CODE_COUNT,
    type StoredCredential,
} from "./passkey-store.js";

// The daemon as relying party, driven with a software authenticator: real attestation and assertion bytes through the
// real verifier, then every way a response can fail to be the one the ceremony asked for.

const ORIGIN = "https://app.example.test";
const RP_ID = "app.example.test";
const ADA = { email: "ada@x.com", name: "Ada" };

const storePath = async (): Promise<string> => join(await mkdtemp(join(tmpdir(), "passkeys-")), "passkeys.json");

interface Harness {
    readonly store: PasskeyStore;
    readonly ceremonies: ReturnType<typeof createPasskeyCeremonies>;
    readonly clock: { now: number };
}

const harness = (options: { readonly store?: PasskeyStore; readonly allowed?: (origin: string) => boolean; readonly sandboxId?: string } = {}): Harness => {
    const store = options.store ?? memoryPasskeyStore();
    const clock = { now: Date.parse("2026-09-14T12:00:00Z") };
    const ceremonies = createPasskeyCeremonies({
        store,
        originAllowed: options.allowed ?? ((origin) => origin === ORIGIN || origin === "https://other.example.test"),
        sandboxId: options.sandboxId ?? "sandbox-a",
        sandboxName: "work",
        now: () => clock.now,
    });
    return { store, ceremonies, clock };
};

// Registers `authenticator` for `identity` and returns what the store now holds for it.
const register = async (
    { ceremonies }: Harness,
    authenticator = softwareAuthenticator(),
    identity: { email: string; name?: string } = ADA,
    label?: string,
): Promise<StoredCredential> => {
    const options = await ceremonies.registrationOptions({ identity, origin: ORIGIN });
    const response = authenticator.create({ challenge: options.challenge, origin: ORIGIN, rpId: RP_ID });
    return ceremonies.register({ identity, origin: ORIGIN, response, label });
};

const signIn = async ({ ceremonies }: Harness, authenticator: ReturnType<typeof softwareAuthenticator>, counter?: number): Promise<StoredCredential> => {
    const options = await ceremonies.authenticationOptions(ORIGIN);
    const response = authenticator.get({ challenge: options.challenge, origin: ORIGIN, rpId: RP_ID, ...(counter !== undefined ? { counter } : {}) });
    return ceremonies.authenticate({ origin: ORIGIN, response });
};

const refusal = async (run: Promise<unknown>): Promise<{ status: number; message: string } | undefined> => {
    try {
        await run;
    } catch (error) {
        if (error instanceof PasskeyError) {
            return { status: error.status, message: error.message };
        }
        throw error;
    }
    return undefined;
};

describe("registration and sign-in", () => {
    test("a registered passkey signs in: the stored credential names its owner, its origin, and when it last answered", async () => {
        const h = harness();
        const authenticator = softwareAuthenticator();
        const stored = await register(h, authenticator, ADA, "Ada's laptop");
        expect(stored).toMatchObject({ id: authenticator.credentialId, email: "ada@x.com", name: "Ada", label: "Ada's laptop", rpId: RP_ID, counter: 0, backedUp: false });
        expect(stored.publicKey).toEqual({ alg: -7, jwk: { kty: "EC", crv: "P-256", x: expect.any(String), y: expect.any(String) } });

        h.clock.now += 60_000;
        const signed = await signIn(h, authenticator);
        expect(signed).toMatchObject({ id: authenticator.credentialId, email: "ada@x.com", lastUsedAt: h.clock.now });
        expect((await h.store.find(authenticator.credentialId))?.lastUsedAt).toBe(h.clock.now);
    });

    test.each([
        [-257 as const, "RSA"],
        [-8 as const, "OKP"],
    ])("an authenticator signing with alg %i (Windows Hello, a FIDO key) registers and signs in", async (alg, kty) => {
        const h = harness();
        const authenticator = softwareAuthenticator({ alg });
        const stored = await register(h, authenticator);
        expect(stored.publicKey.alg).toBe(alg);
        expect(stored.publicKey.jwk["kty"]).toBe(kty);
        expect((await signIn(h, authenticator)).email).toBe("ada@x.com");
    });

    test("the options name the relying party from the origin, the caller's handle, and the passkeys already held", async () => {
        const h = harness();
        const first = softwareAuthenticator();
        await register(h, first);
        const options = await h.ceremonies.registrationOptions({ identity: ADA, origin: ORIGIN });
        expect(options.rp).toEqual({ id: RP_ID, name: "work" });
        expect(options.user).toEqual({ id: expect.any(String), name: "ada@x.com", displayName: "ada@x.com · work" });
        expect(options.pubKeyCredParams.map((param) => param.alg)).toEqual([-7, -257, -8]);
        expect(options.authenticatorSelection).toEqual({ residentKey: "required", requireResidentKey: true, userVerification: "required" });
        expect(options.attestation).toBe("none");
        expect(options.excludeCredentials).toEqual([{ type: "public-key", id: first.credentialId, transports: ["internal"] }]);

        const assertion = await h.ceremonies.authenticationOptions(ORIGIN);
        expect(assertion).toMatchObject({ rpId: RP_ID, userVerification: "required", available: true });
        expect(assertion.allowCredentials.map((entry) => entry.id)).toEqual([first.credentialId]);
    });

    test("with nothing registered for the origin the sign-in options say so, so a button is not offered that cannot work", async () => {
        const h = harness();
        expect(await h.ceremonies.authenticationOptions(ORIGIN)).toMatchObject({ available: false, allowCredentials: [] });
    });

    // Two sandboxes on one editor origin share an rpId; a shared handle would make the second registration overwrite the
    // first on the authenticator.
    test("the user handle is stable per person and distinct per sandbox", async () => {
        const a = harness({ sandboxId: "sandbox-a" });
        const b = harness({ sandboxId: "sandbox-b" });
        const handleA = (await a.ceremonies.registrationOptions({ identity: ADA, origin: ORIGIN })).user.id;
        expect((await a.ceremonies.registrationOptions({ identity: { email: "ADA@x.com" }, origin: ORIGIN })).user.id).toBe(handleA);
        expect((await b.ceremonies.registrationOptions({ identity: ADA, origin: ORIGIN })).user.id).not.toBe(handleA);
    });

    test("an unnamed passkey is labelled by what it is and when it was added", async () => {
        const h = harness();
        expect((await register(h)).label).toBe("Passkey added 2026-09-14");
    });
});

describe("refusals", () => {
    test("a challenge is spent by the response that answers it, and expires unanswered", async () => {
        const h = harness();
        const authenticator = softwareAuthenticator();
        const options = await h.ceremonies.registrationOptions({ identity: ADA, origin: ORIGIN });
        const response = authenticator.create({ challenge: options.challenge, origin: ORIGIN, rpId: RP_ID });
        await h.ceremonies.register({ identity: ADA, origin: ORIGIN, response, label: undefined });
        expect(await refusal(h.ceremonies.register({ identity: ADA, origin: ORIGIN, response, label: undefined }))).toEqual({
            status: 400,
            message: "this response answers no challenge this sandbox issued; start again",
        });

        const late = await h.ceremonies.authenticationOptions(ORIGIN);
        h.clock.now += 5 * 60 * 1000 + 1;
        const lateResponse = authenticator.get({ challenge: late.challenge, origin: ORIGIN, rpId: RP_ID });
        expect(await refusal(h.ceremonies.authenticate({ origin: ORIGIN, response: lateResponse }))).toEqual({ status: 400, message: "the challenge expired; start again" });
    });

    test("a registration challenge answers only for the person it was issued to", async () => {
        const h = harness();
        const options = await h.ceremonies.registrationOptions({ identity: ADA, origin: ORIGIN });
        const response = softwareAuthenticator().create({ challenge: options.challenge, origin: ORIGIN, rpId: RP_ID });
        const refused = await refusal(h.ceremonies.register({ identity: { email: "mallory@x.com" }, origin: ORIGIN, response, label: undefined }));
        expect(refused?.status).toBe(400);
        expect(refused?.message).toMatch(/started by someone else/);
    });

    test("the origin must be one the daemon trusts, present, and the one the browser signed", async () => {
        const h = harness();
        expect(await refusal(h.ceremonies.registrationOptions({ identity: ADA, origin: undefined }))).toEqual({ status: 400, message: "passkeys need a browser origin" });
        expect(await refusal(h.ceremonies.authenticationOptions("https://evil.example"))).toEqual({
            status: 400,
            message: "passkeys cannot be bound to https://evil.example",
        });
        // Options issued for one trusted origin, the browser reports another trusted one: the client data disagrees.
        const options = await h.ceremonies.registrationOptions({ identity: ADA, origin: ORIGIN });
        const response = softwareAuthenticator().create({ challenge: options.challenge, origin: "https://other.example.test", rpId: RP_ID });
        const refused = await refusal(h.ceremonies.register({ identity: ADA, origin: ORIGIN, response, label: undefined }));
        expect(refused?.status).toBe(400);
        expect(refused?.message).toMatch(/ran on https:\/\/other\.example\.test/);
    });

    test("a credential scoped to another site, a ceremony of the wrong kind, or one run cross-origin is refused", async () => {
        const h = harness();
        const authenticator = softwareAuthenticator();
        const scoped = await h.ceremonies.registrationOptions({ identity: ADA, origin: ORIGIN });
        expect(
            (await refusal(h.ceremonies.register({ identity: ADA, origin: ORIGIN, response: authenticator.create({ challenge: scoped.challenge, origin: ORIGIN, rpId: "evil.example" }), label: undefined })))
                ?.message,
        ).toMatch(/scoped to another site/);
        const kind = await h.ceremonies.registrationOptions({ identity: ADA, origin: ORIGIN });
        expect(
            (
                await refusal(
                    h.ceremonies.register({
                        identity: ADA,
                        origin: ORIGIN,
                        response: authenticator.create({ challenge: kind.challenge, origin: ORIGIN, rpId: RP_ID, clientType: "webauthn.get" }),
                        label: undefined,
                    }),
                )
            )?.message,
        ).toMatch(/expected webauthn\.create/);
        const cross = await h.ceremonies.registrationOptions({ identity: ADA, origin: ORIGIN });
        expect(
            (
                await refusal(
                    h.ceremonies.register({
                        identity: ADA,
                        origin: ORIGIN,
                        response: authenticator.create({ challenge: cross.challenge, origin: ORIGIN, rpId: RP_ID, crossOrigin: true }),
                        label: undefined,
                    }),
                )
            )?.message,
        ).toMatch(/cross-origin/);
    });

    // UV is what makes a passkey two factors: possession, plus the PIN or biometric the authenticator checked.
    test("an authenticator that did not verify the user is refused at registration and at sign-in", async () => {
        const h = harness();
        const lax = softwareAuthenticator({ userVerified: false });
        const options = await h.ceremonies.registrationOptions({ identity: ADA, origin: ORIGIN });
        const refused = await refusal(h.ceremonies.register({ identity: ADA, origin: ORIGIN, response: lax.create({ challenge: options.challenge, origin: ORIGIN, rpId: RP_ID }), label: undefined }));
        expect(refused?.message).toMatch(/did not verify the user/);

        const strict = softwareAuthenticator();
        await register(h, strict);
        const assertion = await h.ceremonies.authenticationOptions(ORIGIN);
        const response = strict.get({ challenge: assertion.challenge, origin: ORIGIN, rpId: RP_ID, userVerified: false });
        expect((await refusal(h.ceremonies.authenticate({ origin: ORIGIN, response })))?.message).toMatch(/did not verify the user/);
    });

    test("a signature from another key, or an unknown credential, is refused", async () => {
        const h = harness();
        const registered = softwareAuthenticator();
        await register(h, registered);
        const impostor = softwareAuthenticator();
        const options = await h.ceremonies.authenticationOptions(ORIGIN);
        // The impostor signs with its own key but names the registered credential.
        const forged = { ...impostor.get({ challenge: options.challenge, origin: ORIGIN, rpId: RP_ID }), id: registered.credentialId, rawId: registered.credentialId };
        expect(await refusal(h.ceremonies.authenticate({ origin: ORIGIN, response: forged }))).toEqual({
            status: 400,
            message: "signature does not verify against the registered key",
        });
        const unknown = await h.ceremonies.authenticationOptions(ORIGIN);
        expect(await refusal(h.ceremonies.authenticate({ origin: ORIGIN, response: impostor.get({ challenge: unknown.challenge, origin: ORIGIN, rpId: RP_ID }) }))).toEqual({
            status: 404,
            message: "no passkey registered with this sandbox answers that id",
        });
    });

    test("a counting authenticator must count up; a synced one reporting 0 is exempt", async () => {
        const h = harness();
        const key = softwareAuthenticator({ counts: true });
        const stored = await register(h, key);
        expect(stored.counter).toBe(1);
        expect((await signIn(h, key)).counter).toBe(2);
        // A clone replaying the count the daemon already holds.
        expect((await refusal(signIn(h, key, 2)))?.message).toBe("signature counter did not advance");
        expect((await signIn(h, key)).counter).toBe(3);

        const synced = softwareAuthenticator();
        await register(h, synced);
        expect((await signIn(h, synced)).counter).toBe(0);
        expect((await signIn(h, synced)).counter).toBe(0);
    });

    test("registering the same credential twice is a conflict, not a second row", async () => {
        const h = harness();
        const authenticator = softwareAuthenticator();
        await register(h, authenticator);
        expect(await refusal(register(h, authenticator))).toEqual({ status: 409, message: "this passkey is already registered with the sandbox" });
        expect((await h.store.list()).length).toBe(1);
    });
});

describe("recovery codes", () => {
    test("mints eight codes a person can read back, and keeps only their hashes", () => {
        const { codes, hashes } = mintRecoveryCodes();
        expect(codes.length).toBe(RECOVERY_CODE_COUNT);
        for (const code of codes) {
            expect(code).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}-[a-z2-9]{5}-[a-z2-9]{5}$/);
            expect(code).not.toMatch(/[ilo01]/);
        }
        expect(hashes).toEqual(codes.map(hashRecoveryCode));
        expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT);
    });

    test("a code typed with different case, spaces or dashes is the same code", () => {
        expect(normalizeRecoveryCode(" ABCDE fghjk-MNPQR_stuvw ")).toBe("abcdefghjkmnpqrstuvw");
        expect(hashRecoveryCode("ABCDE-FGHJK-MNPQR-STUVW")).toBe(hashRecoveryCode("abcdefghjkmnpqrstuvw"));
    });

    test("a code spends once; ten wrong codes close the door for a while", async () => {
        const h = harness();
        const { codes, hashes } = mintRecoveryCodes();
        await h.store.setRecovery(hashes);
        expect(await h.ceremonies.spendRecoveryCode(codes[0]!.toUpperCase())).toBe(true);
        expect(await h.ceremonies.spendRecoveryCode(codes[0]!)).toBe(false);
        expect((await h.store.recovery()).filter((code) => code.usedAt === undefined).length).toBe(RECOVERY_CODE_COUNT - 1);

        for (let attempt = 0; attempt < 9; attempt += 1) {
            expect(await h.ceremonies.spendRecoveryCode("wrong")).toBe(false);
        }
        // The tenth wrong code (one was spent above) arms the lockout; a RIGHT code is refused while it holds.
        expect(await refusal(h.ceremonies.spendRecoveryCode(codes[1]!))).toEqual({ status: 429, message: "too many wrong recovery codes; try again in 15 minutes" });
        h.clock.now += 15 * 60 * 1000;
        expect(await h.ceremonies.spendRecoveryCode(codes[1]!)).toBe(true);
    });
});

describe("the file store", () => {
    test("persists credentials, the switch and the recovery hashes across instances, and holds no code in the clear", async () => {
        const path = await storePath();
        const h = harness({ store: filePasskeys(path) });
        const authenticator = softwareAuthenticator();
        await register(h, authenticator, ADA, "laptop");
        const { codes, hashes } = mintRecoveryCodes();
        await h.store.setRequired(true);
        await h.store.setRecovery(hashes);

        const reopened = filePasskeys(path);
        expect((await reopened.list()).map((credential) => [credential.id, credential.label])).toEqual([[authenticator.credentialId, "laptop"]]);
        expect(await reopened.required()).toBe(true);
        expect(await reopened.spendRecovery(hashRecoveryCode(codes[3]!), 5)).toBe(true);
        expect(await reopened.spendRecovery(hashRecoveryCode(codes[3]!), 6)).toBe(false);
        const raw = await readFile(path, "utf8");
        for (const code of codes) {
            expect(raw.includes(code)).toBe(false);
            expect(raw.includes(normalizeRecoveryCode(code))).toBe(false);
        }

        expect(await reopened.remove(authenticator.credentialId)).toBe(true);
        expect(await reopened.remove(authenticator.credentialId)).toBe(false);
        expect(await reopened.list()).toEqual([]);
        await reopened.setRequired(false);
        await reopened.setRecovery([]);
        expect(await filePasskeys(path).required()).toBe(false);
        expect(await filePasskeys(path).recovery()).toEqual([]);
    });
});
