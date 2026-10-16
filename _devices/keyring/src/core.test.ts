import type { KeyringOp, KeyringResponse } from "./protocol.js";
import { unseal } from "@intentic/sandbox-contract/keyring-seal";
import { sealForKeyring } from "./seal.js";
import { fakeSandbox, type Harness, keyringHarness, passwordRules } from "./testing.js";
import type { KeyringShareMode } from "@intentic/sandbox-contract/schemas/keyring";

const SECRET = "fortinet-password-123";

const inboxKey = async (h: Harness): Promise<string> => {
    const state = await h.keyring.handle({ op: "state" });
    if (!state.ok || !("state" in state) || state.state.keys === undefined) {
        throw new Error("no inbox key");
    }
    return state.state.keys.inbox;
};

// A keyring set up, with VPN_FORTI added and shared with `sandbox` under `mode`, then locked.
const withSharedEntry = async (h: Harness, sandboxUrl: string, mode: KeyringShareMode, rules = passwordRules()): Promise<void> => {
    expect(await h.keyring.handle({ op: "setup", passphrase: "correct horse battery staple", hello: false })).toEqual({ ok: true });
    const sealed = sealForKeyring(await inboxKey(h), "VPN_FORTI", SECRET);
    expect(await h.keyring.handle({ op: "add", name: "VPN_FORTI", sealed, rules, replace: false })).toEqual({ ok: true });
    expect(await h.keyring.handle({ op: "share", name: "VPN_FORTI", sandbox: sandboxUrl, machine: "rog", mode })).toMatchObject({ ok: true });
    await h.keyring.handle({ op: "lock" });
    h.person.asked.length = 0;
};

const sealedOf = (answer: KeyringResponse<KeyringOp>): Parameters<typeof unseal>[1] => {
    if (!answer.ok || !("sealed" in answer)) {
        throw new Error(answer.ok ? "not a release" : answer.refusal);
    }
    return answer.sealed;
};

describe("setup and the vault's own ops", () => {
    test("set up, add and list never shows a value", async () => {
        const h = keyringHarness([]);
        await h.keyring.handle({ op: "setup", passphrase: "correct horse battery staple", hello: false });
        const sealed = sealForKeyring(await inboxKey(h), "GITHUB_TOKEN", "ghp_abcdefghijklmnop");
        expect(await h.keyring.handle({ op: "add", name: "GITHUB_TOKEN", sealed, rules: passwordRules({ kind: "text", programs: [] }), replace: false })).toEqual({ ok: true });
        const listed = await h.keyring.handle({ op: "list" });
        expect(listed).toMatchObject({ ok: true, entries: [{ name: "GITHUB_TOKEN", kind: "text" }] });
        expect(JSON.stringify(listed)).not.toContain("ghp_abcdefghijklmnop");
        expect(JSON.stringify(h.files.vault)).not.toContain("ghp_abcdefghijklmnop");
    });

    test("setting up twice is refused, so nothing set up can be overwritten", async () => {
        const h = keyringHarness([]);
        await h.keyring.handle({ op: "setup", passphrase: "correct horse battery staple", hello: false });
        expect(await h.keyring.handle({ op: "setup", passphrase: "another passphrase", hello: false })).toMatchObject({ ok: false, code: "declined" });
    });

    test("a value not sealed to this keyring's inbox is refused", async () => {
        const h = keyringHarness([]);
        await h.keyring.handle({ op: "setup", passphrase: "correct horse battery staple", hello: false });
        const other = keyringHarness([]);
        await other.keyring.handle({ op: "setup", passphrase: "correct horse battery staple", hello: false });
        const sealed = sealForKeyring(await inboxKey(other), "X", "value-value-value");
        expect(await h.keyring.handle({ op: "add", name: "X", sealed, rules: passwordRules(), replace: false })).toMatchObject({ ok: false, code: "bad-grant" });
    });

    test("an edit that only narrows asks nobody while unlocked; one that widens asks", async () => {
        const sandbox = fakeSandbox();
        const h = keyringHarness([sandbox]);
        await withSharedEntry(h, sandbox.url, "each-use");
        await h.keyring.handle({ op: "unlock", minutes: 10 });
        h.person.asked.length = 0;
        expect(await h.keyring.handle({ op: "edit", name: "VPN_FORTI", patch: { programs: [] } })).toEqual({ ok: true });
        expect(h.person.asked).toHaveLength(0);
        expect(await h.keyring.handle({ op: "edit", name: "VPN_FORTI", patch: { programs: ["mstsc.exe"] } })).toEqual({ ok: true });
        expect(h.person.asked).toHaveLength(1);
        expect(h.person.asked[0]?.message).toContain("mstsc.exe");
    });
});

describe("releases", () => {
    test("each-use asks the person, and the value opens only with the sandbox's key and the grant's nonce", async () => {
        const sandbox = fakeSandbox();
        const h = keyringHarness([sandbox]);
        await withSharedEntry(h, sandbox.url, "each-use");
        const { signed, grant } = sandbox.grant("VPN_FORTI", { kind: "sandbox", lane: "shell" });
        const answer = await h.keyring.handle({ op: "release", grant: signed });
        expect(answer).toMatchObject({ ok: true, asked: true });
        expect(h.person.asked).toHaveLength(1);
        expect(unseal(sandbox.seal, sealedOf(answer), { kind: "release", sandbox: sandbox.url, secret: "VPN_FORTI", nonce: grant.nonce })).toBe(SECRET);
    });

    test("a grant answers once", async () => {
        const sandbox = fakeSandbox();
        const h = keyringHarness([sandbox]);
        await withSharedEntry(h, sandbox.url, "each-use");
        const { signed } = sandbox.grant("VPN_FORTI", { kind: "sandbox", lane: "shell" });
        await h.keyring.handle({ op: "release", grant: signed });
        expect(await h.keyring.handle({ op: "release", grant: signed })).toMatchObject({ ok: false, code: "replayed" });
    });

    test("a person's no is a refusal", async () => {
        const sandbox = fakeSandbox();
        const h = keyringHarness([sandbox]);
        await withSharedEntry(h, sandbox.url, "each-use");
        h.person.replies.push("no");
        expect(await h.keyring.handle({ op: "release", grant: sandbox.grant("VPN_FORTI", { kind: "sandbox", lane: "shell" }).signed })).toMatchObject({ ok: false, code: "declined" });
    });

    test("while-here goes unasked while unlocked and asks once locked", async () => {
        const sandbox = fakeSandbox();
        const h = keyringHarness([sandbox]);
        await withSharedEntry(h, sandbox.url, "while-here");
        await h.keyring.handle({ op: "unlock", minutes: 10 });
        h.person.asked.length = 0;
        expect(await h.keyring.handle({ op: "release", grant: sandbox.grant("VPN_FORTI", { kind: "sandbox", lane: "shell" }).signed })).toMatchObject({ ok: true, asked: false });
        expect(h.person.asked).toHaveLength(0);
        h.clock.now += 11 * 60_000;
        const later = sandbox.grant("VPN_FORTI", { kind: "sandbox", lane: "shell" }, { issuedAt: h.clock.now, expiresAt: h.clock.now + 60_000 });
        expect(await h.keyring.handle({ op: "release", grant: later.signed })).toMatchObject({ ok: true, asked: true });
    });

    test("a grant another key signed, or from a sandbox nothing is shared with, gets nothing", async () => {
        const sandbox = fakeSandbox();
        const impostor = fakeSandbox(sandbox.url);
        const stranger = fakeSandbox("https://ffffffffffff.intentic.dev");
        const h = keyringHarness([sandbox]);
        await withSharedEntry(h, sandbox.url, "while-here");
        expect(await h.keyring.handle({ op: "release", grant: impostor.grant("VPN_FORTI", { kind: "sandbox", lane: "shell" }).signed })).toMatchObject({ ok: false, code: "bad-grant" });
        expect(await h.keyring.handle({ op: "release", grant: stranger.grant("VPN_FORTI", { kind: "sandbox", lane: "shell" }).signed })).toMatchObject({ ok: false, code: "not-shared" });
        expect(h.person.asked).toHaveLength(0);
    });

    test("a mode the open part understates is not given away unasked", async () => {
        const sandbox = fakeSandbox();
        const h = keyringHarness([sandbox]);
        await withSharedEntry(h, sandbox.url, "each-use");
        await h.keyring.handle({ op: "unlock", minutes: 10 });
        // Another process of this user rewrites the readable part to say `while-here`.
        const vault = h.files.vault;
        if (vault === undefined) {
            throw new Error("no vault");
        }
        for (const entry of vault.open.entries) {
            entry.shares = entry.shares.map((share) => ({ ...share, mode: "while-here" }));
        }
        const tampered = keyringHarness([sandbox]);
        Object.assign(tampered.files, h.files);
        await tampered.keyring.handle({ op: "unlock", minutes: 10 });
        tampered.person.asked.length = 0;
        expect(await tampered.keyring.handle({ op: "release", grant: sandbox.grant("VPN_FORTI", { kind: "sandbox", lane: "shell" }).signed })).toMatchObject({ ok: false, code: "declined" });
    });
});

describe("typing", () => {
    test("into a program on the entry's list, in a password field, goes unasked while unlocked", async () => {
        const sandbox = fakeSandbox();
        const h = keyringHarness([sandbox]);
        await withSharedEntry(h, sandbox.url, "while-here");
        await h.keyring.handle({ op: "unlock", minutes: 10 });
        h.person.asked.length = 0;
        const answer = await h.keyring.handle({ op: "type", input: { grant: sandbox.grant("VPN_FORTI", { kind: "window", programs: [], anyField: false }).signed } });
        expect(answer).toEqual({ ok: true, program: "FortiClient.exe", field: "password", asked: false });
        expect(h.window.typed).toEqual([{ value: SECRET, program: "FortiClient.exe" }]);
    });

    test("into a program off the list asks, and a no types nothing", async () => {
        const sandbox = fakeSandbox();
        const h = keyringHarness([sandbox]);
        await withSharedEntry(h, sandbox.url, "while-here");
        await h.keyring.handle({ op: "unlock", minutes: 10 });
        h.window.focus = { program: "notepad.exe", path: "C:\\Windows\\notepad.exe", field: "text" };
        h.person.replies.push("no");
        expect(await h.keyring.handle({ op: "type", input: { grant: sandbox.grant("VPN_FORTI", { kind: "window", programs: [], anyField: false }).signed } })).toMatchObject({ ok: false, code: "declined" });
        expect(h.window.typed).toHaveLength(0);
    });

    test("a program the grant did not name is refused outright", async () => {
        const sandbox = fakeSandbox();
        const h = keyringHarness([sandbox]);
        await withSharedEntry(h, sandbox.url, "while-here");
        await h.keyring.handle({ op: "unlock", minutes: 10 });
        expect(await h.keyring.handle({ op: "type", input: { grant: sandbox.grant("VPN_FORTI", { kind: "window", programs: ["mstsc.exe"], anyField: false }).signed } })).toMatchObject({ ok: false, code: "guard" });
        expect(h.window.typed).toHaveLength(0);
    });

    test("focus that moves while the person answers stops the typing", async () => {
        const sandbox = fakeSandbox();
        const h = keyringHarness([sandbox]);
        await withSharedEntry(h, sandbox.url, "each-use");
        const consent = h.person.consent.ask;
        Object.assign(h.person.consent, {
            ask: async (...args: Parameters<typeof consent>) => {
                h.window.handle = "hwnd-2";
                return await consent(...args);
            },
        });
        expect(await h.keyring.handle({ op: "type", input: { grant: sandbox.grant("VPN_FORTI", { kind: "window", programs: [], anyField: false }).signed } })).toMatchObject({ ok: false, code: "guard" });
        expect(h.window.typed).toHaveLength(0);
    });

    test("a value the sandbox sent is typed under the grant's own guard", async () => {
        const sandbox = fakeSandbox();
        const h = keyringHarness([sandbox]);
        await withSharedEntry(h, sandbox.url, "each-use");
        const keys = h.files.keys;
        if (keys === undefined) {
            throw new Error("no keys");
        }
        const { seal } = await import("@intentic/sandbox-contract/keyring-seal");
        const { signed, grant } = sandbox.grant("DB_PASSWORD", { kind: "window", programs: ["FortiClient.exe"], anyField: false });
        const sealed = seal(keys.seal.publicKey, "sandbox-held-value", { kind: "type", sandbox: sandbox.url, secret: "DB_PASSWORD", nonce: grant.nonce });
        expect(await h.keyring.handle({ op: "type", input: { grant: signed, sealed } })).toMatchObject({ ok: true, asked: false });
        expect(h.window.typed).toEqual([{ value: "sandbox-held-value", program: "FortiClient.exe" }]);
        h.window.focus = { program: "chrome.exe", path: "C:\\chrome.exe", field: "password" };
        const second = sandbox.grant("DB_PASSWORD", { kind: "window", programs: ["FortiClient.exe"], anyField: false });
        const again = seal(keys.seal.publicKey, "sandbox-held-value", { kind: "type", sandbox: sandbox.url, secret: "DB_PASSWORD", nonce: second.grant.nonce });
        expect(await h.keyring.handle({ op: "type", input: { grant: second.signed, sealed: again } })).toMatchObject({ ok: false, code: "guard" });
    });

    test("a relay seals to the other computer, which types it under a grant with the same nonce", async () => {
        const sandbox = fakeSandbox();
        const a = keyringHarness([sandbox]);
        const b = keyringHarness([sandbox]);
        await withSharedEntry(a, sandbox.url, "each-use");
        await b.keyring.handle({ op: "setup", passphrase: "correct horse battery staple", hello: false });
        // B learns the sandbox's keys the way it does in practice: by being shared something.
        await b.keyring.handle({ op: "add", name: "B_OWN", sealed: sealForKeyring(await inboxKey(b), "B_OWN", "b-own-value-xx"), rules: passwordRules(), replace: false });
        await b.keyring.handle({ op: "share", name: "B_OWN", sandbox: sandbox.url, machine: "omen", mode: "each-use" });
        const bSeal = b.files.keys?.seal.publicKey ?? "";
        const relay = sandbox.grant("VPN_FORTI", { kind: "relay", sealTo: bSeal, toMachine: "omen" });
        const released = await a.keyring.handle({ op: "release", grant: relay.signed });
        const typeGrant = sandbox.grant("VPN_FORTI", { kind: "window", programs: ["FortiClient.exe"], anyField: false }, { nonce: relay.grant.nonce });
        expect(await b.keyring.handle({ op: "type", input: { grant: typeGrant.signed, sealed: sealedOf(released) } })).toMatchObject({ ok: true });
        expect(b.window.typed).toEqual([{ value: SECRET, program: "FortiClient.exe" }]);
    });
});

describe("inbox and copies", () => {
    test("a value sent while locked waits, and the next unlock takes it in shared back", async () => {
        const sandbox = fakeSandbox();
        const h = keyringHarness([sandbox]);
        await h.keyring.handle({ op: "setup", passphrase: "correct horse battery staple", hello: false });
        const inbox = await inboxKey(h);
        await h.keyring.handle({ op: "lock" });
        const { seal } = await import("@intentic/sandbox-contract/keyring-seal");
        const sealed = seal(inbox, "kept-on-my-computer", { kind: "inbox", sandbox: sandbox.url, secret: "API_KEY" });
        expect(await h.keyring.handle({ op: "inbox", item: { name: "API_KEY", sealed, mode: "each-use", kind: "password", programs: [], hosts: [], sandbox: sandbox.url } })).toEqual({ ok: true, pending: true });
        expect(await h.keyring.handle({ op: "state" })).toMatchObject({ ok: true, state: { pendingInbox: 1 } });
        const unlocked = await h.keyring.handle({ op: "unlock", minutes: 5 });
        expect(unlocked.ok).toBe(true);
        expect(h.person.asked.at(-1)?.message).toContain("API_KEY");
        expect(h.keyring.shares(sandbox.url)).toMatchObject({ ok: true, pointers: [{ name: "API_KEY", mode: "each-use" }] });
        const released = await h.keyring.handle({ op: "release", grant: sandbox.grant("API_KEY", { kind: "sandbox", lane: "code" }).signed });
        expect(released.ok).toBe(true);
    });

    test("a copy is sealed to its sandbox, and follows a new value", async () => {
        const sandbox = fakeSandbox();
        const h = keyringHarness([sandbox]);
        await withSharedEntry(h, sandbox.url, "copy");
        const copies = await h.keyring.handle({ op: "copies", sandbox: sandbox.url });
        if (!copies.ok || !("copies" in copies)) {
            throw new Error("no copies");
        }
        const [copy] = copies.copies;
        expect(copy?.name).toBe("VPN_FORTI");
        expect(copy === undefined ? "" : unseal(sandbox.seal, copy.sealed, { kind: "copy", sandbox: sandbox.url, secret: "VPN_FORTI", updatedAt: copy.updatedAt })).toBe(SECRET);
    });
});

describe("askpass", () => {
    test("answers the prompt its matcher fits, asking each time unless told to remember", async () => {
        const sandbox = fakeSandbox();
        const h = keyringHarness([sandbox]);
        await withSharedEntry(h, sandbox.url, "each-use", passwordRules({ askpass: ["ssh:radar@10.0.0.5"], askpassRememberMinutes: 0 }));
        expect(await h.keyring.handle({ op: "askpass", prompt: "radar@10.0.0.5's password: " })).toEqual({ ok: true, value: SECRET });
        expect(await h.keyring.handle({ op: "askpass", prompt: "radar@10.0.0.5's password: " })).toEqual({ ok: true, value: SECRET });
        expect(h.person.asked).toHaveLength(2);
        expect(await h.keyring.handle({ op: "askpass", prompt: "root@10.0.0.5's password: " })).toMatchObject({ ok: false, code: "unknown" });
    });

    test("remembers an answer for the minutes the entry says, only while unlocked", async () => {
        const sandbox = fakeSandbox();
        const h = keyringHarness([sandbox]);
        await withSharedEntry(h, sandbox.url, "each-use", passwordRules({ askpass: ["sudo"], askpassRememberMinutes: 5 }));
        await h.keyring.handle({ op: "unlock", minutes: 30 });
        h.person.asked.length = 0;
        await h.keyring.handle({ op: "askpass", prompt: "[sudo] password for radar: " });
        await h.keyring.handle({ op: "askpass", prompt: "[sudo] password for radar: " });
        expect(h.person.asked).toHaveLength(1);
        h.clock.now += 6 * 60_000;
        await h.keyring.handle({ op: "askpass", prompt: "[sudo] password for radar: " });
        expect(h.person.asked).toHaveLength(2);
    });
});

describe("sync", () => {
    test("two paired keyrings keep one set of entries, removals included", async () => {
        const a = keyringHarness([]);
        const b = keyringHarness([]);
        await a.keyring.handle({ op: "setup", passphrase: "correct horse battery staple", hello: false });
        await b.keyring.handle({ op: "setup", passphrase: "correct horse battery staple", hello: false });
        const aState = await a.keyring.handle({ op: "sync-state" });
        const bState = await b.keyring.handle({ op: "sync-state" });
        if (!aState.ok || !("sync" in aState) || !bState.ok || !("sync" in bState)) {
            throw new Error("no sync state");
        }
        await a.keyring.handle({ op: "sync-pair", pair: { peer: { device: "omen", key: bState.sync.key }, self: "rog" } });
        await b.keyring.handle({ op: "sync-pair", pair: { peer: { device: "rog", key: aState.sync.key }, self: "omen" } });
        await a.keyring.handle({ op: "add", name: "SHARED", sealed: sealForKeyring(await inboxKey(a), "SHARED", "synced-value-1"), rules: passwordRules(), replace: false });
        const outbox = await a.keyring.handle({ op: "sync-outbox" });
        if (!outbox.ok || !("items" in outbox)) {
            throw new Error("no outbox");
        }
        expect(JSON.stringify(outbox.items)).not.toContain("synced-value-1");
        expect(await b.keyring.handle({ op: "sync-deliver", deliver: { items: outbox.items } })).toMatchObject({ ok: true, accepted: outbox.items.length });
        expect(b.keyring.list()).toMatchObject({ ok: true, entries: [{ name: "SHARED" }] });
        a.clock.now += 1000;
        await a.keyring.handle({ op: "remove", name: "SHARED" });
        const second = await a.keyring.handle({ op: "sync-outbox" });
        if (!second.ok || !("items" in second)) {
            throw new Error("no outbox");
        }
        await b.keyring.handle({ op: "sync-deliver", deliver: { items: second.items } });
        expect(b.keyring.list()).toMatchObject({ ok: true, entries: [] });
    });

    test("items from a keyring that is not paired are counted out", async () => {
        const a = keyringHarness([]);
        const stranger = keyringHarness([]);
        await a.keyring.handle({ op: "setup", passphrase: "correct horse battery staple", hello: false });
        await stranger.keyring.handle({ op: "setup", passphrase: "correct horse battery staple", hello: false });
        const aState = await a.keyring.handle({ op: "sync-state" });
        if (!aState.ok || !("sync" in aState)) {
            throw new Error("no sync state");
        }
        await stranger.keyring.handle({ op: "sync-pair", pair: { peer: { device: "rog", key: aState.sync.key }, self: "evil" } });
        await stranger.keyring.handle({ op: "add", name: "PLANTED", sealed: sealForKeyring(await inboxKey(stranger), "PLANTED", "planted-value"), rules: passwordRules(), replace: false });
        const outbox = await stranger.keyring.handle({ op: "sync-outbox" });
        if (!outbox.ok || !("items" in outbox)) {
            throw new Error("no outbox");
        }
        expect(await a.keyring.handle({ op: "sync-deliver", deliver: { items: outbox.items } })).toEqual({ ok: true, accepted: 0 });
    });
});

test("a sandbox named with a trailing slash in one place and without it in another is the same sandbox", async () => {
    const sandbox = fakeSandbox("https://a1b2c3d4e5f6.intentic.dev");
    const h = keyringHarness([sandbox, { ...sandbox, url: `${sandbox.url}/` }]);
    await withSharedEntry(h, `${sandbox.url}/`, "each-use");
    expect(h.keyring.shares(sandbox.url)).toMatchObject({ ok: true, pointers: [{ name: "VPN_FORTI" }] });
    expect(await h.keyring.handle({ op: "release", grant: sandbox.grant("VPN_FORTI", { kind: "sandbox", lane: "shell" }).signed })).toMatchObject({ ok: true });
});
