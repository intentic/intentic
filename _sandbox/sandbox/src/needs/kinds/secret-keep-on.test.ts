import type { DeviceFacts } from "@intentic/sandbox-contract/schemas/hosts";
import { unseal } from "@intentic/sandbox-contract/keyring-seal";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../../composition.js";
import { fakeDevices, fakeKeyring, SANDBOX_URL } from "../../secrets/device/keyring.testing.js";
import { secretsSliceFake } from "../../secrets/secrets-slice.testing.js";
import { NeedRefusal } from "../needs.js";
import { keepOnDevice } from "./secret-keep-on.js";

// "Keep it on my computer" from a secret need's card: the value goes sealed to that computer's keyring inbox and nothing
// is stored here, and a computer that cannot take it is refused before anything is sent, saying why.

const hubWith = (online: boolean, features: DeviceFacts["features"]): Services["hostHub"] =>
    unstubbed<Services["hostHub"]>("hostHub", {
        // SAFETY: only `features` is read off a device's facts on this path (deviceSupports).
        state: () => ({ online, facts: { features } as DeviceFacts }),
        online: () => online,
    });

test("a computer with a keyring is sent the value, sealed to its inbox, and answers whether it waits for an unlock", async () => {
    const rog = fakeKeyring();
    const slice = secretsSliceFake(fakeDevices({ rog }));
    await slice.keyringLink.refresh();
    const kept = await keepOnDevice({ hostHub: hubWith(true, ["keyring"]), keyringLink: slice.keyringLink }, "VPN_PASSWORD", "vpn-value-to-keep", { device: "rog", mode: "while-here" });
    expect(kept).toEqual({ pending: true });
    const item = rog.calls.find((call) => call.procedure === "keyringInbox")?.input;
    // SAFETY: the fake records each procedure's own input, and keyringInbox's is an inbox item.
    const sealed = (item as { readonly sealed: Parameters<typeof unseal>[1] }).sealed;
    expect(unseal(rog.keys.inbox, sealed, { kind: "inbox", sandbox: SANDBOX_URL, secret: "VPN_PASSWORD" })).toBe("vpn-value-to-keep");
    expect(await slice.sandboxSecrets.all()).toEqual({});
});

test("a computer without a keyring, or one not connected, is refused in words and sent nothing", async () => {
    const rog = fakeKeyring();
    const slice = secretsSliceFake(fakeDevices({ rog }));
    const keepOn = { device: "rog", mode: "each-use" as const };
    await expect(keepOnDevice({ hostHub: hubWith(true, []), keyringLink: slice.keyringLink }, "VPN_PASSWORD", "never-sent", keepOn)).rejects.toThrow(
        new NeedRefusal("invalid", "rog has no keyring: its agent does not offer one, so it cannot keep VPN_PASSWORD. Install the keyring there (intentic-machine keyring), or keep the value in the sandbox."),
    );
    await expect(keepOnDevice({ hostHub: hubWith(false, []), keyringLink: slice.keyringLink }, "VPN_PASSWORD", "never-sent", keepOn)).rejects.toThrow(
        "rog is not connected right now, so its keyring cannot take VPN_PASSWORD: keep the value in the sandbox, or try again once that computer is on.",
    );
    expect(rog.calls).toEqual([]);
});

test("a keyring that refuses the item is the need's refusal, with its sentence", async () => {
    const rog = fakeKeyring();
    rog.inbox = async () => ({ ok: false, code: "busy", refusal: "another prompt is open" });
    const slice = secretsSliceFake(fakeDevices({ rog }));
    await slice.keyringLink.refresh();
    await expect(keepOnDevice({ hostHub: hubWith(true, ["keyring"]), keyringLink: slice.keyringLink }, "VPN_PASSWORD", "v-a-l-u-e", { device: "rog", mode: "copy" })).rejects.toThrow(
        "VPN_PASSWORD could not be kept on rog: another prompt is open",
    );
});
