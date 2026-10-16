import {
    type KeyringGrant,
    type KeyringInboxItem,
    KEYRING_NONCE_RE,
    type KeyringTypeInput,
    type SignedKeyringGrant,
} from "@intentic/sandbox-contract/schemas/keyring";
import { seal, unseal, verifyGrant } from "@intentic/sandbox-contract/keyring-seal";
import { createKeyringLink, type KeyringLinkDeps } from "./keyring-link.js";
import { fakeDevices, fakeKeyring, type FakeKeyring, memoryKeyringBook, memoryKeyringCopies, memoryReleasedValues, memorySandboxKeys, pointerOf, SANDBOX_URL } from "./keyring.testing.js";

// The sandbox's side of a computer's keyring, against a keyring that answers as the machine relays it: what the link
// keeps of each keyring, the grants it signs, what it opens and what it seals, and the keys it trusts.

const NOW = 1_800_000_000_000;

interface Setup {
    readonly link: ReturnType<typeof createKeyringLink>;
    readonly keys: ReturnType<typeof memorySandboxKeys>;
    readonly devices: ReturnType<typeof fakeDevices>;
    readonly released: ReturnType<typeof memoryReleasedValues>;
    readonly copies: ReturnType<typeof memoryKeyringCopies>;
    readonly book: ReturnType<typeof memoryKeyringBook>;
    readonly warned: string[];
}

const setup = (keyrings: Readonly<Record<string, FakeKeyring>>, over: Partial<KeyringLinkDeps> = {}): Setup => {
    const keys = memorySandboxKeys();
    const devices = fakeDevices(keyrings);
    const released = memoryReleasedValues();
    const copies = memoryKeyringCopies();
    const book = memoryKeyringBook();
    const warned: string[] = [];
    const link = createKeyringLink({
        devices: () => devices,
        publicUrl: () => `${SANDBOX_URL}/`,
        keys,
        book,
        copies,
        released,
        syncOf: () => undefined,
        logger: { warn: (_fields: object, message: string) => void warned.push(message) },
        now: () => NOW,
        ...over,
    });
    return { link, keys, devices, released, copies, book, warned };
};

// The grant a call carried, as the keyring reads it: verified with the sandbox's public signing key.
const grantOf = (keys: Setup["keys"], signed: SignedKeyringGrant): KeyringGrant => {
    const verdict = verifyGrant(keys.sign.publicKey, signed, NOW);
    if (!verdict.ok) {
        throw new Error(`the grant did not verify: ${verdict.reason}`);
    }
    return verdict.grant;
};

const VPN = pointerOf("VPN_PASSWORD", { programs: ["FortiClient.exe"], hosts: ["vpn.example.com"] });

describe("pointers", () => {
    it("lists what each keyring shares once it is read, and keeps an offline computer's rows, as offline", async () => {
        const rog = fakeKeyring([VPN]);
        const { link, devices, book } = setup({ rog });
        expect(await link.pointers()).toEqual([]);
        await link.refresh();
        expect(await link.pointers()).toEqual([{ machine: "rog", pointer: VPN, online: true, locked: false }]);
        devices.online.delete("rog");
        expect(await link.pointers()).toEqual([{ machine: "rog", pointer: VPN, online: false, locked: undefined }]);
        // Names and rules only on disk: the book holds what the keyring said, and no value ever reaches it.
        expect(book.book.get("rog")?.pointers).toEqual([VPN]);
    });

    it("answers a name from memory, preferring a computer that answers now", async () => {
        const rog = fakeKeyring([VPN]);
        const omen = fakeKeyring([{ ...VPN, updatedAt: 9_000 }]);
        const { link, devices } = setup({ rog, omen });
        await link.refresh();
        devices.online.delete("omen");
        const calls = rog.calls.length + omen.calls.length;
        expect((await link.pointer("VPN_PASSWORD"))?.machine).toBe("rog");
        expect(rog.calls.length + omen.calls.length).toBe(calls);
        expect(await link.pointer("NOT_SHARED")).toBeUndefined();
    });

    it("keeps the last entries of a keyring that stopped answering, and stops calling it online", async () => {
        const rog = fakeKeyring([VPN]);
        const { link } = setup({ rog });
        await link.refresh();
        rog.shares = () => ({ pointers: [], reason: "the keyring is not running" });
        await link.refresh("rog");
        expect(await link.pointers()).toEqual([{ machine: "rog", pointer: VPN, online: false, locked: undefined }]);
    });
});

describe("release", () => {
    it("signs a grant for one use the keyring verifies, then opens the value sealed for that grant alone", async () => {
        const rog = fakeKeyring([VPN]);
        const { link, keys, released } = setup({ rog });
        rog.release = async (signed) => {
            const grant = grantOf(keys, signed);
            return { ok: true, asked: true, sealed: seal(keys.seal.publicKey, "hunter2-but-longer", { kind: "release", sandbox: grant.sandbox, secret: grant.secret, nonce: grant.nonce }) };
        };
        const answer = await link.release({ machine: "rog", secret: "VPN_PASSWORD", lane: "shell", detail: `curl ${"x".repeat(400)}`, conversationId: "conv-1" });
        expect(answer).toEqual({ ok: true, value: "hunter2-but-longer", asked: true });
        const call = rog.calls.find((entry) => entry.procedure === "keyringRelease");
        // SAFETY: the fake records each procedure's own input, and keyringRelease's is a signed grant.
        const grant = grantOf(keys, call?.input as SignedKeyringGrant);
        expect({ ...grant, nonce: KEYRING_NONCE_RE.test(grant.nonce), detail: grant.detail.length }).toEqual({
            v: 1,
            sandbox: SANDBOX_URL,
            secret: "VPN_PASSWORD",
            target: { kind: "sandbox", lane: "shell" },
            purpose: "agent",
            conversation: "conv-1",
            detail: 300,
            nonce: true,
            issuedAt: NOW,
            expiresAt: NOW + 90_000,
        });
        // Kept to mask, under its name.
        expect(released.all()).toEqual({ VPN_PASSWORD: "hunter2-but-longer" });
    });

    it("asks again for every use: a value released before is never answered from memory", async () => {
        const rog = fakeKeyring([VPN]);
        const { link, keys } = setup({ rog });
        rog.release = async (signed) => {
            const grant = grantOf(keys, signed);
            return { ok: true, asked: false, sealed: seal(keys.seal.publicKey, "value-number-one", { kind: "release", sandbox: grant.sandbox, secret: grant.secret, nonce: grant.nonce }) };
        };
        await link.release({ machine: "rog", secret: "VPN_PASSWORD", lane: "code", detail: "first" });
        rog.release = async () => ({ ok: false, code: "locked", refusal: "the keyring is locked" });
        expect(await link.release({ machine: "rog", secret: "VPN_PASSWORD", lane: "code", detail: "second" })).toEqual({ ok: false, code: "locked", refusal: "the keyring is locked" });
        expect(rog.calls.filter((entry) => entry.procedure === "keyringRelease")).toHaveLength(2);
    });

    it("refuses a box sealed for another grant, and keeps nothing of it", async () => {
        const rog = fakeKeyring([VPN]);
        const { link, keys, released } = setup({ rog });
        rog.release = async (signed) => {
            const grant = grantOf(keys, signed);
            return { ok: true, asked: false, sealed: seal(keys.seal.publicKey, "replayed-value-xyz", { kind: "release", sandbox: grant.sandbox, secret: grant.secret, nonce: "A".repeat(22) }) };
        };
        expect(await link.release({ machine: "rog", secret: "VPN_PASSWORD", lane: "shell", detail: "x" })).toEqual({
            ok: false,
            code: "bad-grant",
            refusal: "What the keyring on rog sent for VPN_PASSWORD did not open with this sandbox's key, so it was not used.",
        });
        expect(released.all()).toEqual({});
    });

    it("says a computer that is not connected is not, and asks nothing", async () => {
        const { link } = setup({});
        expect(await link.release({ machine: "rog", secret: "VPN_PASSWORD", lane: "shell", detail: "x" })).toMatchObject({ ok: false, code: "unavailable" });
    });

    it("refuses to sign anything before the sandbox has a public address", async () => {
        const rog = fakeKeyring([VPN]);
        const { link } = setup({ rog }, { publicUrl: () => "" });
        expect(await link.release({ machine: "rog", secret: "VPN_PASSWORD", lane: "shell", detail: "x" })).toEqual({
            ok: false,
            code: "unavailable",
            refusal: "this sandbox has no public address yet, so no keyring can be asked for anything: its tunnel is not up",
        });
        expect(rog.calls).toEqual([]);
    });
});

describe("typing and the keys a keyring is trusted with", () => {
    const WINDOW = { kind: "window" as const, programs: ["FortiClient.exe"], anyField: false, countdownSeconds: 3 };

    it("seals a sandbox-held value to the keyring's pinned seal key, for the typing grant's own nonce", async () => {
        const rog = fakeKeyring();
        const { link, keys } = setup({ rog });
        await link.refresh();
        const typed = await link.type({ machine: "rog", secret: "SITE_PASSWORD", target: WINDOW, value: "sandbox-held-value", purpose: "owner", detail: "Type into" });
        expect(typed).toEqual({ ok: true, program: "FortiClient.exe", field: "password", asked: false });
        // SAFETY: the fake records each procedure's own input, and keyringType's is a typing input.
        const input = rog.calls.find((entry) => entry.procedure === "keyringType")?.input as KeyringTypeInput;
        const grant = grantOf(keys, input.grant);
        expect({ target: grant.target, purpose: grant.purpose }).toEqual({ target: WINDOW, purpose: "owner" });
        expect(unseal(rog.keys.seal, input.sealed ?? { v: 1, epk: "", iv: "", tag: "", data: "" }, { kind: "type", sandbox: SANDBOX_URL, secret: "SITE_PASSWORD", nonce: grant.nonce })).toBe(
            "sandbox-held-value",
        );
    });

    it("relays a secret one computer holds to the one typing it, both grants under one nonce", async () => {
        const omen = fakeKeyring([VPN]);
        const rog = fakeKeyring();
        const { link, keys } = setup({ rog, omen });
        await link.refresh();
        omen.release = async (signed) => {
            const grant = grantOf(keys, signed);
            return { ok: true, asked: false, sealed: seal(rog.keys.seal.publicKey, "relayed-value-123", { kind: "type", sandbox: grant.sandbox, secret: grant.secret, nonce: grant.nonce }) };
        };
        expect(await link.type({ machine: "rog", secret: "VPN_PASSWORD", target: WINDOW, relayFrom: "omen", purpose: "owner", detail: "Type into" })).toMatchObject({ ok: true });
        // SAFETY: the fakes record each procedure's own input.
        const relay = grantOf(keys, omen.calls.find((entry) => entry.procedure === "keyringRelease")?.input as SignedKeyringGrant);
        // SAFETY: as above.
        const typing = rog.calls.find((entry) => entry.procedure === "keyringType")?.input as KeyringTypeInput;
        expect(relay.target).toEqual({ kind: "relay", sealTo: rog.keys.seal.publicKey, toMachine: "rog" });
        expect(grantOf(keys, typing.grant).nonce).toBe(relay.nonce);
        expect(unseal(rog.keys.seal, typing.sealed ?? { v: 1, epk: "", iv: "", tag: "", data: "" }, { kind: "type", sandbox: SANDBOX_URL, secret: "VPN_PASSWORD", nonce: relay.nonce })).toBe(
            "relayed-value-123",
        );
    });

    it("pins a keyring's keys when first heard, refuses one reporting others on a live connection, and re-pins after it reconnects", async () => {
        const rog = fakeKeyring();
        const { link, warned } = setup({ rog });
        await link.refresh();
        expect(await link.deviceKeys("rog")).toEqual({ seal: rog.keys.seal.publicKey, inbox: rog.keys.inbox.publicKey });
        const swapped = fakeKeyring();
        rog.shares = () => swapped.shares({ seal: swapped.keys.seal.publicKey, inbox: swapped.keys.inbox.publicKey });
        await link.refresh("rog");
        expect(await link.deviceKeys("rog")).toBeUndefined();
        expect(await link.type({ machine: "rog", secret: "SITE_PASSWORD", target: WINDOW, value: "never-sealed-value", purpose: "owner", detail: "x" })).toEqual({
            ok: false,
            code: "unavailable",
            refusal: "The keyring on rog reports keys other than the ones this sandbox pinned for it, so nothing is sent to it until the computer reconnects.",
        });
        expect(rog.calls.some((entry) => entry.procedure === "keyringType")).toBe(false);
        await link.arrived("rog");
        expect(await link.deviceKeys("rog")).toEqual({ seal: swapped.keys.seal.publicKey, inbox: swapped.keys.inbox.publicKey });
        expect(warned).toEqual([
            "keyring: the keyring on this computer reports keys other than the ones pinned, without reconnecting; nothing is sealed to it until it reconnects",
            "keyring: the keyring on this computer reports new keys since it reconnected; they are pinned in place of the old ones",
        ]);
    });

    it("says a keyring that is installed but not set up has nowhere to keep or type a value", async () => {
        const rog = fakeKeyring();
        rog.shares = () => ({ keyring: { version: "1.0.0", locked: true, unlock: ["passphrase"], pendingInbox: 0 }, pointers: [] });
        const { link } = setup({ rog });
        await link.refresh();
        expect(await link.inbox({ machine: "rog", name: "NEW_KEY", value: "a-value-to-keep", mode: "while-here", kind: "password", programs: [], hosts: [] })).toEqual({
            ok: false,
            code: "no-keyring",
            refusal:
                "The keyring on rog is installed but not set up yet, so it has no vault to keep a value in or to type one from: set it up on that computer first (intentic-machine keyring setup).",
        });
    });
});

describe("inbox and copies", () => {
    it("seals a value sent to be kept to the keyring's inbox key, and reads the keyring again once it is taken", async () => {
        const rog = fakeKeyring();
        const { link } = setup({ rog });
        await link.refresh();
        rog.inbox = async () => ({ ok: true, pending: false });
        expect(await link.inbox({ machine: "rog", name: "NEW_KEY", value: "a-value-to-keep", mode: "each-use", kind: "password", programs: [], hosts: [] })).toEqual({ ok: true, pending: false });
        // SAFETY: the fake records each procedure's own input, and keyringInbox's is an inbox item.
        const item = rog.calls.find((entry) => entry.procedure === "keyringInbox")?.input as KeyringInboxItem;
        expect({ ...item, sealed: unseal(rog.keys.inbox, item.sealed, { kind: "inbox", sandbox: SANDBOX_URL, secret: "NEW_KEY" }) }).toEqual({
            name: "NEW_KEY",
            sealed: "a-value-to-keep",
            mode: "each-use",
            kind: "password",
            programs: [],
            hosts: [],
            sandbox: SANDBOX_URL,
        });
        expect(rog.calls.filter((entry) => entry.procedure === "keyringShares")).toHaveLength(2);
    });

    it("keeps each copy a keyring shares in copy mode, and drops it once the entry is no longer shared that way", async () => {
        const copied = pointerOf("DB_PASSWORD", { mode: "copy", updatedAt: 5_000 });
        const rog = fakeKeyring([copied]);
        const { link, keys, copies } = setup({ rog });
        rog.copies = () => ({
            copies: [
                { name: "DB_PASSWORD", updatedAt: 5_000, sealed: seal(keys.seal.publicKey, "copied-value-abc", { kind: "copy", sandbox: SANDBOX_URL, secret: "DB_PASSWORD", updatedAt: 5_000 }) },
                // Not shared in copy mode: whatever it is, it is not kept.
                { name: "OTHER", updatedAt: 1, sealed: seal(keys.seal.publicKey, "not-for-keeping", { kind: "copy", sandbox: SANDBOX_URL, secret: "OTHER", updatedAt: 1 }) },
            ],
        });
        await link.refresh();
        expect(await copies.all()).toEqual({ DB_PASSWORD: "copied-value-abc" });
        rog.shares = (reported) => ({ ...fakeKeyring().shares(reported), pointers: [{ ...copied, mode: "while-here" }] });
        await link.refresh();
        expect(await copies.all()).toEqual({});
    });
});

describe("keyrings", () => {
    it("lists each computer with a keyring this sandbox reaches, its state while it answers and its last release after", async () => {
        const rog = fakeKeyring([VPN]);
        const { link, devices } = setup({ rog }, { syncOf: () => ({ key: rog.keys.sync.publicKey, peers: ["omen"] }) });
        await link.refresh();
        const [online] = await link.keyrings();
        expect(online).toEqual({ machine: "rog", online: true, locked: false, version: "1.0.0", pendingInbox: 0, shared: 1, sync: { fingerprint: expect.stringMatching(/^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/u), peers: ["omen"] } });
        devices.online.delete("rog");
        expect(await link.keyrings()).toEqual([{ machine: "rog", online: false, version: "1.0.0", shared: 1 }]);
    });

    it("names the address the computers paired with, without its trailing slash", async () => {
        expect(await setup({}).link.sandboxUrl()).toBe(SANDBOX_URL);
    });
});
