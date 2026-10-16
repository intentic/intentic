import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeyringSyncItem } from "@intentic/sandbox-contract/schemas/keyring";
import { keyFingerprint, seal } from "@intentic/sandbox-contract/keyring-seal";
import { createKeyringSync, intoMailbox, KeyringPairRefused, MAILBOX_CAP } from "./keyring-sync.js";
import { fakeDevices, fakeKeyring } from "./keyring.testing.js";

// The mailbox two of the owner's keyrings keep in step through, and their pairing: items collected from each keyring's
// outbox, the newest per sender and recipient kept, each handed to the keyring whose sync key it is sealed to, and none
// of it ever opened here.

const dirs: string[] = [];
afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const mailboxPath = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "intentic-keyring-sync-"));
    dirs.push(dir);
    return join(dir, "keyring-sync-mailbox.json");
};

const itemFrom = (from: string, to: string, revision: number): KeyringSyncItem => ({
    from,
    to,
    revision,
    sealed: seal(to, `entries at ${String(revision)}`, { kind: "sync", account: "owner", device: "rog", revision }),
});

test("the mailbox keeps the newest item per sender and recipient, and at most its cap, dropping the oldest", () => {
    const rog = fakeKeyring();
    const omen = fakeKeyring();
    const [a, b] = [rog.keys.sync.publicKey, omen.keys.sync.publicKey];
    expect(intoMailbox([itemFrom(a, b, 1)], [itemFrom(a, b, 3), itemFrom(b, a, 2), itemFrom(a, b, 2)]).map((item) => `${item.from === a ? "a" : "b"}:${String(item.revision)}`)).toEqual(["a:3", "b:2"]);
    const many = Array.from({ length: MAILBOX_CAP + 4 }, (_unused, index) => itemFrom(a, fakeKeyring().keys.sync.publicKey, index));
    const kept = intoMailbox([], many);
    expect([kept.length, kept[0]?.revision, kept.at(-1)?.revision]).toEqual([MAILBOX_CAP, 4, MAILBOX_CAP + 3]);
});

test("an exchange collects what a keyring sent and hands each keyring what is sealed to it, then forgets it", async () => {
    const rog = fakeKeyring();
    const omen = fakeKeyring();
    const devices = fakeDevices({ rog, omen });
    const sync = createKeyringSync({ devices: () => devices, mailboxPath: await mailboxPath(), logger: { warn: () => {} } });
    const forOmen = itemFrom(rog.keys.sync.publicKey, omen.keys.sync.publicKey, 7);
    rog.outbox = [forOmen];
    devices.online.delete("omen");
    await sync.exchange("rog");
    expect(await sync.mailbox()).toEqual([forOmen]);
    expect(rog.calls.some((call) => call.procedure === "keyringSyncDeliver")).toBe(false);
    // The recipient connects: it is handed its item, and the mailbox lets it go.
    devices.online.add("omen");
    await sync.exchange("omen");
    expect(omen.calls.find((call) => call.procedure === "keyringSyncDeliver")?.input).toEqual({ items: [forOmen] });
    expect(await sync.mailbox()).toEqual([]);
    expect(sync.syncOf("omen")).toEqual({ key: omen.keys.sync.publicKey, peers: [] });
});

test("pairing asks each keyring to pair with the other, by device and sync key, and answers both fingerprints", async () => {
    const rog = fakeKeyring();
    const omen = fakeKeyring();
    const sync = createKeyringSync({ devices: () => fakeDevices({ rog, omen }), mailboxPath: await mailboxPath(), logger: { warn: () => {} } });
    expect(await sync.pair("rog", "omen")).toEqual({ a: keyFingerprint(rog.keys.sync.publicKey), b: keyFingerprint(omen.keys.sync.publicKey) });
    expect(rog.calls.find((call) => call.procedure === "keyringSyncPair")?.input).toEqual({ peer: { device: "omen", key: omen.keys.sync.publicKey }, self: "rog" });
    expect(omen.calls.find((call) => call.procedure === "keyringSyncPair")?.input).toEqual({ peer: { device: "rog", key: rog.keys.sync.publicKey }, self: "omen" });
});

test("a keyring that says no, or a computer that is not connected, fails the pairing in words", async () => {
    const rog = fakeKeyring();
    const omen = fakeKeyring();
    const devices = fakeDevices({ rog, omen });
    const sync = createKeyringSync({ devices: () => devices, mailboxPath: await mailboxPath(), logger: { warn: () => {} } });
    omen.client.keyringSyncPair = async () => ({ ok: false, code: "declined", refusal: "the person said no" });
    await expect(sync.pair("rog", "omen")).rejects.toThrow(new KeyringPairRefused("The keyring on omen did not pair: the person said no"));
    devices.online.delete("omen");
    await expect(sync.pair("rog", "omen")).rejects.toThrow(new KeyringPairRefused("omen is not connected with a keyring right now, so the two cannot be paired."));
});
