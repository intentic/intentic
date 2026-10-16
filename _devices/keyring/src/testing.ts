import type { KeyringGrant, KeyringGrantTarget } from "@intentic/sandbox-contract";
import { grantNonce, type KeyringKeyPair, newSealKeyPair, newSignKeyPair, signGrant } from "@intentic/sandbox-contract/keyring-seal";
import { noAudit, type AuditRecord } from "./audit.js";
import { BackendReader } from "./backends.js";
import type { Consent, ConsentRequest } from "./consent/consent.js";
import { Keyring } from "./core.js";
import type { KeysFile } from "./keys.js";
import type { EntryRules } from "./protocol.js";
import type { Runner } from "./run.js";
import type { Focus } from "./policy.js";
import type { Place, Seen, Typist } from "./typing/typist.js";
import type { VaultFile } from "./vault.js";

// Fakes for driving a Keyring in a test: a person who answers as told, a focused window that is whatever the test says,
// a sandbox with its own keys that signs grants, and files kept in memory.

export const TEST_PASSPHRASE = "correct horse battery staple";
// scrypt at its floor, so a test's unlock takes milliseconds instead of half a second.
export const TEST_SCRYPT = { N: 2 ** 10, r: 8, p: 1 } as const;

export type Reply = "yes" | "no";

export interface FakePerson {
    readonly consent: Consent;
    readonly asked: ConsentRequest[];
    // Queued answers, first one first; when empty the person says yes.
    readonly replies: Reply[];
}

export const fakePerson = (passphrase: string = TEST_PASSPHRASE): FakePerson => {
    const asked: ConsentRequest[] = [];
    const replies: Reply[] = [];
    return {
        asked,
        replies,
        consent: {
            hello: undefined,
            ask: async (request) => {
                asked.push(request);
                if ((replies.shift() ?? "yes") === "no") {
                    return { ok: false, code: "declined", reason: "The person at the computer said no." };
                }
                if (!request.unlock) {
                    return { ok: true, vaultKey: undefined, how: "verified" };
                }
                const vaultKey = await request.opener?.withPassphrase(passphrase);
                return vaultKey === undefined ? { ok: false, code: "declined", reason: "wrong passphrase" } : { ok: true, vaultKey, how: "passphrase" };
            },
        },
    };
};

export interface FakeWindow {
    readonly typist: Typist;
    focus: Focus;
    handle: string;
    // What was typed, and where.
    readonly typed: { readonly value: string; readonly program: string }[];
}

export const fakeWindow = (focus: Focus = { program: "FortiClient.exe", path: "C:\\Program Files\\Fortinet\\FortiClient.exe", field: "password" }): FakeWindow => {
    const window: FakeWindow = {
        focus,
        handle: "hwnd-1",
        typed: [],
        typist: {
            inspect: (_place: Place) => Promise.resolve({ ok: true, seen: { focus: window.focus, handle: window.handle } }),
            type: (_place: Place, seen: Seen, value: string) => {
                window.typed.push({ value, program: seen.focus.program });
                return Promise.resolve({ ok: true });
            },
        },
    };
    return window;
};

export interface FakeSandbox {
    readonly url: string;
    readonly sign: KeyringKeyPair;
    readonly seal: KeyringKeyPair;
    readonly grant: (secret: string, target: KeyringGrantTarget, over?: Partial<KeyringGrant>) => { readonly signed: ReturnType<typeof signGrant>; readonly grant: KeyringGrant };
}

export const fakeSandbox = (url = "https://a1b2c3d4e5f6.intentic.dev", now: () => number = Date.now): FakeSandbox => {
    const sign = newSignKeyPair();
    const seal = newSealKeyPair();
    return {
        url,
        sign,
        seal,
        grant: (secret, target, over = {}) => {
            const issuedAt = now();
            const grant: KeyringGrant = { v: 1, sandbox: url, secret, target, purpose: "agent", detail: "a test use", nonce: grantNonce(), issuedAt, expiresAt: issuedAt + 60_000, ...over };
            return { signed: signGrant(sign, grant), grant };
        },
    };
};

export interface Harness {
    readonly keyring: Keyring;
    readonly person: FakePerson;
    readonly window: FakeWindow;
    readonly files: { vault: VaultFile | undefined; keys: KeysFile | undefined };
    readonly audit: AuditRecord[];
    readonly clock: { now: number };
}

export const keyringHarness = (sandboxes: readonly FakeSandbox[], runner?: Runner): Harness => {
    const person = fakePerson();
    const window = fakeWindow();
    const files: Harness["files"] = { vault: undefined, keys: undefined };
    const audit: AuditRecord[] = [];
    const clock = { now: Date.now() };
    const keyring = new Keyring({
        vault: {
            read: () => Promise.resolve(files.vault),
            write: (file) => {
                files.vault = structuredClone(file);
                return Promise.resolve();
            },
        },
        keys: {
            read: () => {
                files.keys ??= { v: 1, seal: newSealKeyPair(), sandboxes: {} };
                return Promise.resolve(structuredClone(files.keys));
            },
            write: (keys) => {
                files.keys = structuredClone(keys);
                return Promise.resolve();
            },
        },
        consent: person.consent,
        typist: window.typist,
        backends: new BackendReader(runner ?? (() => Promise.reject(new Error("no password manager in this test")))),
        fetchKeys: (url) => {
            const sandbox = sandboxes.find((candidate) => candidate.url === url);
            return sandbox === undefined ? Promise.reject(new Error("no such sandbox")) : Promise.resolve({ sign: sandbox.sign.publicKey, seal: sandbox.seal.publicKey });
        },
        audit: (record) => {
            audit.push(record);
            return noAudit(record);
        },
        now: () => clock.now,
        sleep: () => Promise.resolve(),
        version: "0.0.0-test",
        helloCredential: "intentic-keyring-test",
        scrypt: TEST_SCRYPT,
    });
    return { keyring, person, window, files, audit, clock };
};

export const passwordRules = (over: Partial<EntryRules> = {}): EntryRules => ({
    kind: "password",
    programs: ["FortiClient.exe"],
    packages: [],
    hosts: [],
    anyField: false,
    askpass: [],
    askpassRememberMinutes: 0,
    ...over,
});
