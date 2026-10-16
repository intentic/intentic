import { newSealKeyPair } from "@intentic/sandbox-contract/keyring-seal";
import { helloChallenge, newVaultKey, openDocument, sealDocument, unwrapHello, unwrapPassphrase, type VaultDocument, wrapWithHello, wrapWithPassphrase } from "./vault.js";
import { TEST_SCRYPT } from "./testing.js";

const emptyDoc = (): VaultDocument => ({ v: 1, revision: 0, entries: {}, inbox: newSealKeyPair(), sync: newSealKeyPair(), peers: [], backends: [], pins: {} });

describe("the vault", () => {
    test("opens with its key and with nothing else", () => {
        const key = newVaultKey();
        const sealed = sealDocument(key, emptyDoc());
        expect(openDocument(key, sealed).v).toBe(1);
        expect(() => openDocument(newVaultKey(), sealed)).toThrow();
    });

    test("the passphrase unwraps the key, a wrong one unwraps nothing", async () => {
        const key = newVaultKey();
        const wrap = await wrapWithPassphrase(key, "correct horse battery staple", TEST_SCRYPT);
        expect((await unwrapPassphrase([wrap], "correct horse battery staple"))?.equals(key)).toBe(true);
        expect(await unwrapPassphrase([wrap], "wrong horse battery staple")).toBeUndefined();
    });

    test("a Hello signature unwraps the key it was enrolled with, another signature nothing", () => {
        const key = newVaultKey();
        const challenge = helloChallenge();
        const signature = Buffer.alloc(256, 7);
        const wrap = wrapWithHello(key, { credential: "intentic-keyring-test", challenge, signature });
        if (wrap.method !== "hello") {
            throw new Error("not a hello wrap");
        }
        expect(unwrapHello(wrap, signature)?.equals(key)).toBe(true);
        expect(unwrapHello(wrap, Buffer.alloc(256, 8))).toBeUndefined();
    });
});
