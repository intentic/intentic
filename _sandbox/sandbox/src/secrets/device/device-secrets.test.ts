import { seal, verifyGrant } from "@intentic/sandbox-contract/keyring-seal";
import { SETTLES, waitFor } from "@intentic/testing/bun";
import type { NamedSecret } from "../secret-registry.js";
import { createDeviceSecrets } from "./device-secrets.js";
import { createKeyringLink } from "./keyring-link.js";
import { fakeDevices, fakeKeyring, type FakeKeyring, memoryKeyringBook, memoryKeyringCopies, memoryReleasedValues, memorySandboxKeys, pointerOf, SANDBOX_URL } from "./keyring.testing.js";

// The device-held names as the rest of the slice reads them: which a reference resolves through (none a sandbox store
// holds), the host guard each carries from its keyring, the words an agent reads when a computer will not hand a value
// over, and what starting the reading does.

const setup = (keyrings: Readonly<Record<string, FakeKeyring>>, registry: readonly NamedSecret[] = []) => {
    const keys = memorySandboxKeys();
    const devices = fakeDevices(keyrings);
    const warned: string[] = [];
    const exchanged: (string | undefined)[] = [];
    let resets = 0;
    const logger = { warn: (_fields: object, message: string) => void warned.push(message) };
    const link = createKeyringLink({
        devices: () => devices,
        publicUrl: () => SANDBOX_URL,
        keys,
        book: memoryKeyringBook(),
        copies: memoryKeyringCopies(),
        released: memoryReleasedValues(),
        syncOf: () => undefined,
        logger,
    });
    const device = createDeviceSecrets({
        link,
        sync: { exchange: async (machine) => void exchanged.push(machine) },
        released: {
            reset: async () => {
                resets += 1;
            },
        },
        registry: async () => registry,
        devices: () => devices,
        logger,
    });
    return { device, link, keys, warned, exchanged, resets: () => resets };
};

const VPN = pointerOf("VPN_PASSWORD", { hosts: ["vpn.example.com", "*.corp.example.com", "not a host"] });

test("a name a sandbox store holds is the sandbox's: the keyring's entry is neither resolved nor listed, and the log says so once", async () => {
    const rog = fakeKeyring([VPN, pointerOf("SHADOWED"), pointerOf("COPIED", { mode: "copy" })]);
    const registry: NamedSecret[] = [
        { name: "SHADOWED", value: "sandbox-held-value", source: "sandbox" },
        { name: "COPIED", value: "copied-value-here", source: "copy" },
    ];
    const { device, link, warned } = setup({ rog }, registry);
    await link.refresh();
    expect((await device.held()).map((entry) => entry.pointer.name)).toEqual(["VPN_PASSWORD"]);
    // A copy is the keyring's entry, kept here: it resolves from the copy, and lists as the keyring's.
    expect((await device.listed()).map((entry) => entry.pointer.name)).toEqual(["VPN_PASSWORD", "COPIED"]);
    await device.held();
    expect(warned).toEqual(["keyring: a sandbox secret has the same name as an entry a keyring shares; the sandbox's own is the one used"]);
});

test("each device-held name carries its keyring's hosts as a host guard that is on, less any the sandbox would not read as a host", async () => {
    const { device, link } = setup({ rog: fakeKeyring([VPN]) });
    await link.refresh();
    expect(await device.guards()).toEqual([{ subject: "VPN_PASSWORD", kind: "secret", guard: true, hosts: ["vpn.example.com", "*.corp.example.com"], source: "keyring" }]);
});

test("a fetch asks the computer for one value, and a refusal says where it is kept and what to do", async () => {
    const rog = fakeKeyring([VPN]);
    const { device, link, keys } = setup({ rog });
    await link.refresh();
    rog.release = async (signed) => {
        const verdict = verifyGrant(keys.sign.publicKey, signed, Date.now());
        if (!verdict.ok) {
            throw new Error(verdict.reason);
        }
        return { ok: true, asked: false, sealed: seal(keys.seal.publicKey, "vpn-value-fetched", { kind: "release", sandbox: SANDBOX_URL, secret: "VPN_PASSWORD", nonce: verdict.grant.nonce }) };
    };
    expect(await device.fetch({ name: "VPN_PASSWORD", lane: "shell", detail: "curl", conversationId: "conv-1" })).toEqual({ value: "vpn-value-fetched" });
    rog.release = async () => ({ ok: false, code: "declined", refusal: "The person at rog said no." });
    expect(await device.fetch({ name: "VPN_PASSWORD", lane: "shell", detail: "curl" })).toEqual({
        refusal: '"VPN_PASSWORD" is kept in the keyring on rog, which did not hand it over: The person at rog said no. The person at that computer said no: do not retry, and do not look for another way to get it.',
    });
    expect(await device.fetch({ name: "GONE", lane: "code", detail: "x" })).toEqual({ refusal: '"GONE" is no longer shared with this sandbox by any of the owner\'s keyrings, so it was not used.' });
});

test("starting resets the released values' file and reads every computer already connected, then carries its mailbox", async () => {
    const rog = fakeKeyring([VPN]);
    const { device, link, exchanged, resets } = setup({ rog });
    const stop = device.start();
    try {
        await waitFor(async () => expect([resets(), exchanged, (await link.pointers()).map((entry) => entry.pointer.name)]).toEqual([1, ["rog"], ["VPN_PASSWORD"]]), SETTLES);
    } finally {
        stop();
    }
});
