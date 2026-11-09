import { type PassphraseNotice, passphraseConsent, WRONG_MASTER_PASSWORD, WRONG_RECOVERY_KEY } from "./consent.js";

/* The recovery key as consent: a key that does not open the vault is asked for again, the box saying so apart from
   what is asked, and refused after three. */

const opener = { withPassphrase: (typed: string) => Promise.resolve(typed === "right" ? Buffer.alloc(32) : undefined) };

test("a key that did not open the vault is asked for again with the problem beside, not inside, the message", async () => {
    const asked: PassphraseNotice[] = [];
    const typing = ["wrong", "right"];
    const consent = passphraseConsent((notice) => {
        asked.push(notice);
        return Promise.resolve({ kind: "answered", passphrase: typing.shift() ?? "" });
    });
    expect(await consent.ask({ title: "Unlock", message: "For 15 minutes.", unlock: true, opener })).toMatchObject({ ok: true, how: "passphrase" });
    expect(asked).toEqual([
        { title: "Unlock", message: "For 15 minutes.", asks: "recovery-key" },
        { title: "Unlock", message: "For 15 minutes.", problem: WRONG_RECOVERY_KEY, asks: "recovery-key" },
    ]);
});

test("where the person set a master password, the box asks for it, and says so when it did not open", async () => {
    const asked: PassphraseNotice[] = [];
    const typing = ["wrong", "right"];
    const consent = passphraseConsent((notice) => {
        asked.push(notice);
        return Promise.resolve({ kind: "answered", passphrase: typing.shift() ?? "" });
    });
    expect(await consent.ask({ title: "Unlock", message: "m", unlock: true, opener: { ...opener, master: true } })).toMatchObject({ ok: true });
    expect(asked.map((notice) => [notice.asks, notice.problem])).toEqual([
        ["master-password", undefined],
        ["master-password", WRONG_MASTER_PASSWORD],
    ]);
});

test("three keys that did not open it are a no", async () => {
    let asked = 0;
    const consent = passphraseConsent(() => {
        asked++;
        return Promise.resolve({ kind: "answered", passphrase: "wrong" });
    });
    expect(await consent.ask({ title: "Unlock", message: "m", unlock: true, opener })).toMatchObject({ ok: false, code: "declined" });
    expect(asked).toBe(3);
});
