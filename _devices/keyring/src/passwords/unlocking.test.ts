import { sealForKeyring, sealMasterPassword } from "../seal.js";
import { fakeHello, type Harness, keyringHarness, TEST_PASSPHRASE } from "../testing.js";
import { hasMasterPassword, helloWrapOf, unwrapHello, unwrapPassphrase } from "../vault.js";

const inboxKey = async (h: Harness): Promise<string> => {
    const state = await h.keyring.handle({ op: "state" });
    if (!state.ok || !("state" in state) || state.state.keys === undefined) {
        throw new Error("no inbox key");
    }
    return state.state.keys.inbox;
};

const stateOf = async (h: Harness) => {
    const state = await h.keyring.handle({ op: "state" });
    if (!state.ok || !("state" in state)) {
        throw new Error("no state");
    }
    return state.state;
};

describe("Windows Hello added after setup", () => {
    test("a vault set up without Hello offers it, and add-hello wraps the key for Hello's signature", async () => {
        const signature = Buffer.alloc(256, 9);
        const hello = fakeHello(signature);
        const h = keyringHarness([], undefined, hello);
        await h.keyring.handle({ op: "setup", passphrase: TEST_PASSPHRASE, hello: false });
        expect(await stateOf(h)).toMatchObject({ helloAddable: true, unlock: ["passphrase"] });
        await h.keyring.handle({ op: "lock" });
        h.person.asked.length = 0;
        expect(await h.keyring.handle({ op: "add-hello" })).toEqual({ ok: true });
        // Asked once by the way it opened before: the recovery key.
        expect(h.person.asked).toHaveLength(1);
        const wrap = helloWrapOf(h.files.vault?.wraps ?? []);
        expect(wrap?.publicKey).toBe("AAAA");
        const key = wrap === undefined ? undefined : unwrapHello(wrap, signature);
        expect(key?.equals((await unwrapPassphrase(h.files.vault?.wraps ?? [], TEST_PASSPHRASE)) ?? Buffer.alloc(0))).toBe(true);
        expect(await stateOf(h)).toMatchObject({ helloAddable: false, unlock: ["hello", "passphrase"] });
        expect(await h.keyring.handle({ op: "add-hello" })).toMatchObject({ ok: false, code: "declined" });
    });

    test("where Hello is not, nothing is offered and add-hello says why", async () => {
        const h = keyringHarness([]);
        await h.keyring.handle({ op: "setup", passphrase: TEST_PASSPHRASE, hello: false });
        expect(await stateOf(h)).toMatchObject({ helloAddable: false });
        expect(await h.keyring.handle({ op: "add-hello" })).toMatchObject({ ok: false, code: "unavailable" });
    });
});

describe("the master password", () => {
    test("opens the vault beside the recovery key, is tried first, and can be taken away again", async () => {
        const h = keyringHarness([]);
        await h.keyring.handle({ op: "setup", passphrase: TEST_PASSPHRASE, hello: false });
        expect(await stateOf(h)).toMatchObject({ masterPassword: false });
        const sealed = sealMasterPassword(await inboxKey(h), "my own master password");
        expect(await h.keyring.handle({ op: "set-master-password", sealed })).toEqual({ ok: true });
        const wraps = h.files.vault?.wraps ?? [];
        expect(wraps[0]).toMatchObject({ method: "passphrase", role: "master" });
        expect(await unwrapPassphrase(wraps, "my own master password")).toBeInstanceOf(Buffer);
        expect(await unwrapPassphrase(wraps, TEST_PASSPHRASE)).toBeInstanceOf(Buffer);
        expect(await stateOf(h)).toMatchObject({ masterPassword: true });
        expect(await h.keyring.handle({ op: "remove-master-password" })).toEqual({ ok: true });
        expect(hasMasterPassword(h.files.vault?.wraps ?? [])).toBe(false);
        expect(await unwrapPassphrase(h.files.vault?.wraps ?? [], TEST_PASSPHRASE)).toBeInstanceOf(Buffer);
    });

    test("changing it replaces the old one", async () => {
        const h = keyringHarness([]);
        await h.keyring.handle({ op: "setup", passphrase: TEST_PASSPHRASE, hello: false });
        await h.keyring.handle({ op: "set-master-password", sealed: sealMasterPassword(await inboxKey(h), "first master password") });
        await h.keyring.handle({ op: "set-master-password", sealed: sealMasterPassword(await inboxKey(h), "second master password") });
        const wraps = h.files.vault?.wraps ?? [];
        expect(wraps.filter((wrap) => wrap.method === "passphrase" && wrap.role === "master")).toHaveLength(1);
        expect(await unwrapPassphrase(wraps, "first master password")).toBeUndefined();
        expect(await unwrapPassphrase(wraps, "second master password")).toBeInstanceOf(Buffer);
    });

    test("is asked for by the person, refused when short, key-shaped, or sealed for something else", async () => {
        const h = keyringHarness([]);
        await h.keyring.handle({ op: "setup", passphrase: TEST_PASSPHRASE, hello: false });
        h.person.asked.length = 0;
        const inbox = await inboxKey(h);
        expect(await h.keyring.handle({ op: "set-master-password", sealed: sealMasterPassword(inbox, "short") })).toMatchObject({ ok: false, code: "declined" });
        expect(await h.keyring.handle({ op: "set-master-password", sealed: sealMasterPassword(inbox, "ABCDE-FGHJK-MNPQR-STVWX-YZ012-34567") })).toMatchObject({ ok: false, code: "declined" });
        expect(await h.keyring.handle({ op: "set-master-password", sealed: sealForKeyring(inbox, "GITHUB", "an entry's value here") })).toMatchObject({ ok: false, code: "bad-grant" });
        expect(h.person.asked).toHaveLength(3);
        expect(hasMasterPassword(h.files.vault?.wraps ?? [])).toBe(false);
    });
});
