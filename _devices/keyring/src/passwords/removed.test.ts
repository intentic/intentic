import { sealForKeyring } from "../seal.js";
import { type Harness, keyringHarness, passwordRules } from "../testing.js";
import { TRASH_KEEP_MS } from "../vault.js";

const inboxKey = async (h: Harness): Promise<string> => {
    const state = await h.keyring.handle({ op: "state" });
    if (!state.ok || !("state" in state) || state.state.keys === undefined) {
        throw new Error("no inbox key");
    }
    return state.state.keys.inbox;
};

// A keyring set up and unlocked, holding GITHUB with a value, and nobody asked yet.
const withEntry = async (): Promise<Harness> => {
    const h = keyringHarness([]);
    await h.keyring.handle({ op: "setup", passphrase: "correct horse battery staple", hello: false });
    await h.keyring.handle({ op: "add", name: "GITHUB", sealed: sealForKeyring(await inboxKey(h), "GITHUB", "gh-value-123"), rules: passwordRules(), replace: false });
    h.person.asked.length = 0;
    return h;
};

describe("Recently deleted", () => {
    test("removing while unlocked asks nobody, and the entry waits in Recently deleted without its value", async () => {
        const h = await withEntry();
        expect(await h.keyring.handle({ op: "remove", name: "GITHUB" })).toEqual({ ok: true });
        expect(h.person.asked).toHaveLength(0);
        expect(h.keyring.list()).toMatchObject({ ok: true, entries: [] });
        const removed = await h.keyring.handle({ op: "recently-deleted" });
        expect(removed).toMatchObject({ ok: true, items: [{ entry: { name: "GITHUB" } }] });
        expect(JSON.stringify(removed)).not.toContain("gh-value-123");
        expect(JSON.stringify(h.files.vault?.open)).not.toContain("gh-value-123");
    });

    test("putting it back restores the value, unasked while unlocked", async () => {
        const h = await withEntry();
        await h.keyring.handle({ op: "remove", name: "GITHUB" });
        expect(await h.keyring.handle({ op: "undo-remove", name: "GITHUB" })).toEqual({ ok: true });
        expect(h.person.asked).toHaveLength(0);
        expect(await h.keyring.handle({ op: "recently-deleted" })).toEqual({ ok: true, items: [] });
        expect(await h.keyring.handle({ op: "reveal", name: "GITHUB" })).toMatchObject({ ok: true, value: "gh-value-123" });
    });

    test("removing while locked asks once, to unlock", async () => {
        const h = await withEntry();
        await h.keyring.handle({ op: "lock" });
        expect(await h.keyring.handle({ op: "remove", name: "GITHUB" })).toEqual({ ok: true });
        expect(h.person.asked).toHaveLength(1);
        expect(h.person.asked[0]?.unlock).toBe(true);
    });

    test("a name in use again is not overwritten by putting the old one back", async () => {
        const h = await withEntry();
        await h.keyring.handle({ op: "remove", name: "GITHUB" });
        await h.keyring.handle({ op: "add", name: "GITHUB", sealed: sealForKeyring(await inboxKey(h), "GITHUB", "new-value-456"), rules: passwordRules(), replace: false });
        expect(await h.keyring.handle({ op: "undo-remove", name: "GITHUB" })).toMatchObject({ ok: false, code: "declined" });
        expect(await h.keyring.handle({ op: "reveal", name: "GITHUB" })).toMatchObject({ ok: true, value: "new-value-456" });
    });

    test("deleting for good asks the person even while unlocked, and cannot be undone", async () => {
        const h = await withEntry();
        await h.keyring.handle({ op: "remove", name: "GITHUB" });
        h.person.replies.push("no");
        expect(await h.keyring.handle({ op: "purge", name: "GITHUB" })).toMatchObject({ ok: false, code: "declined" });
        expect(await h.keyring.handle({ op: "purge" })).toEqual({ ok: true, purged: 1 });
        expect(h.person.asked).toHaveLength(2);
        expect(await h.keyring.handle({ op: "undo-remove", name: "GITHUB" })).toMatchObject({ ok: false, code: "unknown" });
    });

    test("what was removed more than 30 days ago is gone", async () => {
        const h = await withEntry();
        await h.keyring.handle({ op: "remove", name: "GITHUB" });
        h.clock.now += TRASH_KEEP_MS + 1000;
        expect(await h.keyring.handle({ op: "recently-deleted" })).toEqual({ ok: true, items: [] });
        expect(await h.keyring.handle({ op: "undo-remove", name: "GITHUB" })).toMatchObject({ ok: false, code: "unknown" });
    });
});
