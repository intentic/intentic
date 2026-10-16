import type { KeyringTypeInput, SignedKeyringGrant } from "@intentic/sandbox-contract/schemas/keyring";
import { keyFingerprint, seal, unseal, verifyGrant } from "@intentic/sandbox-contract/keyring-seal";
import { unstubbed } from "@intentic/testing";
import { call } from "@orpc/server";
import type { OrpcContext } from "../../app-env.js";
import { errorCode, rejectForbidden } from "../../harness/route-client.testing.js";
import { createDeviceSecretRoutes, type DeviceSecretRoutesDeps } from "./device-secrets.routes.js";
import { fakeDevices, fakeKeyring, type FakeKeyring, pointerOf, SANDBOX_URL } from "./keyring.testing.js";
import { secretsSliceFake } from "../secrets-slice.testing.js";

// The owner's Type into…, the keyrings this sandbox reaches, and pairing two of them, driven through the handlers: a
// sandbox-held value goes sealed to the computer typing it under its own program guard, a keyring's entry is typed by its
// keyring or relayed computer to computer, and each typing lands on the ledger with where it went.

const owner: OrpcContext = { headers: new Headers(), method: "POST", url: "/secrets/type-into" };

const setup = async (keyrings: Readonly<Record<string, FakeKeyring>>, options: { readonly owner?: boolean } = {}) => {
    const slice = secretsSliceFake(fakeDevices(keyrings));
    await slice.keyringLink.refresh();
    const deps: DeviceSecretRoutesDeps = {
        auth: options.owner === false ? unstubbed<NonNullable<DeviceSecretRoutesDeps["auth"]>>("auth", { authorizeOwner: rejectForbidden }) : undefined,
        logger: unstubbed<DeviceSecretRoutesDeps["logger"]>("logger", { warn: () => {} }),
        deviceSecrets: slice.deviceSecrets,
        keyringLink: slice.keyringLink,
        keyringSync: slice.keyringSync,
        programGuardFor: slice.programGuardFor,
        secretRegistry: slice.secretRegistry,
        secretUses: slice.secretUses,
    };
    return { routes: createDeviceSecretRoutes(deps), slice };
};

// The typing a keyring was asked for: its grant as the keyring verifies it, and what came sealed with it.
const typedOn = (keyring: FakeKeyring, signKey: string) => {
    // SAFETY: the fake records each procedure's own input, and keyringType's is a typing input.
    const input = keyring.calls.find((entry) => entry.procedure === "keyringType")?.input as KeyringTypeInput;
    const verdict = verifyGrant(signKey, input.grant, Date.now());
    if (!verdict.ok) {
        throw new Error(verdict.reason);
    }
    expect(verdict.grant.purpose).toBe("owner");
    return { input, nonce: verdict.grant.nonce, target: verdict.grant.target };
};

test("a sandbox-held secret is sealed to the computer typing it, under its own program guard, and its use is on the ledger", async () => {
    const rog = fakeKeyring();
    const { routes, slice } = await setup({ rog });
    await slice.sandboxSecrets.set("RDP_PASSWORD", "rdp-password-value");
    await slice.secretProgramGuards.set("RDP_PASSWORD", { programs: ["mstsc.exe"], packages: [], anyField: false });
    expect(await call(routes.typeInto, { key: "RDP_PASSWORD", device: "rog", countdownSeconds: 3 }, { context: owner })).toEqual({ program: "FortiClient.exe", field: "password", asked: false });
    const { input, nonce, target } = typedOn(rog, (await slice.sandboxKeyringKeys.publicKeys()).sign);
    expect(target).toEqual({ kind: "window", programs: ["mstsc.exe"], anyField: false, countdownSeconds: 3 });
    expect(unseal(rog.keys.seal, input.sealed ?? { v: 1, epk: "", iv: "", tag: "", data: "" }, { kind: "type", sandbox: SANDBOX_URL, secret: "RDP_PASSWORD", nonce })).toBe("rdp-password-value");
    expect((await slice.secretUses.all()).map(({ name, lane, detail }) => ({ name, lane, detail }))).toEqual([{ name: "RDP_PASSWORD", lane: "device", detail: "rog · FortiClient.exe" }]);
});

test("a keyring's entry is typed by its own keyring with the entry's list, or relayed when another computer types it", async () => {
    const vpn = pointerOf("VPN_PASSWORD", { programs: ["FortiClient.exe"], anyField: true });
    const omen = fakeKeyring([vpn]);
    const rog = fakeKeyring();
    const { routes, slice } = await setup({ rog, omen });
    await call(routes.typeInto, { key: "VPN_PASSWORD", device: "omen", countdownSeconds: 0 }, { context: owner });
    const signKey = (await slice.sandboxKeyringKeys.publicKeys()).sign;
    const own = typedOn(omen, signKey);
    expect([own.target, own.input.sealed]).toEqual([{ kind: "window", programs: ["FortiClient.exe"], anyField: true, countdownSeconds: 0 }, undefined]);
    omen.release = async (signed: SignedKeyringGrant) => {
        const verdict = verifyGrant(signKey, signed, Date.now());
        if (!verdict.ok) {
            throw new Error(verdict.reason);
        }
        return { ok: true, asked: true, sealed: seal(rog.keys.seal.publicKey, "relayed-vpn-value", { kind: "type", sandbox: SANDBOX_URL, secret: "VPN_PASSWORD", nonce: verdict.grant.nonce }) };
    };
    await call(routes.typeInto, { key: "VPN_PASSWORD", device: "rog", countdownSeconds: 2 }, { context: owner });
    const relayed = typedOn(rog, signKey);
    expect(unseal(rog.keys.seal, relayed.input.sealed ?? { v: 1, epk: "", iv: "", tag: "", data: "" }, { kind: "type", sandbox: SANDBOX_URL, secret: "VPN_PASSWORD", nonce: relayed.nonce })).toBe(
        "relayed-vpn-value",
    );
});

test("a keyring's refusal is the route's, in its words, and nothing reaches the ledger", async () => {
    const rog = fakeKeyring();
    rog.type = async () => ({ ok: false, code: "guard", refusal: "the focused window is notepad.exe, which is not on the list" });
    const { routes, slice } = await setup({ rog });
    await slice.sandboxSecrets.set("RDP_PASSWORD", "rdp-password-value");
    await expect(call(routes.typeInto, { key: "RDP_PASSWORD", device: "rog", countdownSeconds: 3 }, { context: owner })).rejects.toThrow(
        "the focused window is notepad.exe, which is not on the list",
    );
    expect(await errorCode(call(routes.typeInto, { key: "RDP_PASSWORD", device: "rog", countdownSeconds: 3 }, { context: owner }))).toBe("FORBIDDEN");
    expect(await errorCode(call(routes.typeInto, { key: "NOPE", device: "rog", countdownSeconds: 3 }, { context: owner }))).toBe("NOT_FOUND");
    expect(await slice.secretUses.all()).toEqual([]);
});

test("Type into… and pairing are the owner's alone", async () => {
    const rog = fakeKeyring();
    const { routes, slice } = await setup({ rog }, { owner: false });
    await slice.sandboxSecrets.set("RDP_PASSWORD", "rdp-password-value");
    expect(await errorCode(call(routes.typeInto, { key: "RDP_PASSWORD", device: "rog", countdownSeconds: 3 }, { context: owner }))).toBe("FORBIDDEN");
    expect(await errorCode(call(routes.keyringPair, { a: "rog", b: "omen" }, { context: owner }))).toBe("FORBIDDEN");
    expect(rog.calls.filter((entry) => entry.procedure !== "keyringShares" && entry.procedure !== "keyringCopies")).toEqual([]);
});

test("the keyrings are listed from what each last said, and two are paired with both fingerprints answered", async () => {
    const rog = fakeKeyring([pointerOf("VPN_PASSWORD")]);
    const omen = fakeKeyring();
    const { routes } = await setup({ rog, omen });
    expect(await call(routes.keyrings, undefined, { context: owner })).toEqual({
        keyrings: [
            { machine: "omen", online: true, locked: false, version: "1.0.0", pendingInbox: 0, shared: 0 },
            { machine: "rog", online: true, locked: false, version: "1.0.0", pendingInbox: 0, shared: 1 },
        ],
    });
    expect(await call(routes.keyringPair, { a: "rog", b: "omen" }, { context: owner })).toEqual({
        fingerprints: { a: keyFingerprint(rog.keys.sync.publicKey), b: keyFingerprint(omen.keys.sync.publicKey) },
    });
    omen.client.keyringSyncPair = async () => ({ ok: false, code: "declined", refusal: "the person said no" });
    await expect(call(routes.keyringPair, { a: "rog", b: "omen" }, { context: owner })).rejects.toThrow("The keyring on omen did not pair: the person said no");
});
