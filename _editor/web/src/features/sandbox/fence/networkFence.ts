import type { EgressOwnerKeysRead, EgressPolicy, EgressStatus } from "@intentic/sandbox-contract/schemas/egress";
import { t } from "@intentic/ui/i18n";
import { assertPasskey, browserSupportsPasskeys } from "../../../client/session/passkeySignIn";
import { sandboxRpc } from "../../../client/sandbox/sandboxRpc";
import { type ChangeTarget, changeToSign, heldPolicy, heldRevision, loosens } from "../../../models/sandbox/devices/egressFlow";
import { manageDeviceSandbox } from "../../../models/sandbox/devices/useDevices";

// THE NETWORK FENCE'S ONE WRITE, from the press to the machine. Tightening goes as it is. Loosening first reads the owner
// keys the daemon will hand the machine (so the document names exactly them), has the owner's passkey sign the change
// in this browser (the ceremony the passkey sign-in runs, `assertPasskey`, with the change's hash as its challenge), and
// sends the signature with the policy. The daemon relays both; the machine agent checks the signature against the keys
// it pinned and refuses anything else, so nothing here is trusted beyond carrying the owner's yes.

/** What the owner keys read says about signing a loosening from here, before anything is pressed. */
export type SignStanding = `ready` | `not-owner` | `no-passkey` | `no-webauthn`;

export const signStanding = (read: EgressOwnerKeysRead | undefined, webauthn: boolean = browserSupportsPasskeys()): SignStanding => {
    if (read !== undefined && !read.owner) {
        return `not-owner`;
    }
    if (read?.ownerKeys === undefined || read.ownerKeys.keys.length === 0) {
        return `no-passkey`;
    }
    return webauthn ? `ready` : `no-webauthn`;
};

export const readOwnerKeys = (): Promise<EgressOwnerKeysRead> => sandboxRpc.system.egressOwnerKeys();

/** Where the change goes, and the machine's sentence once it took it. Throws the machine's refusal, or the ceremony's. */
export const sendFence = async (
    door: { readonly hostId: string; readonly target: ChangeTarget },
    status: EgressStatus | undefined,
    next: EgressPolicy,
    onLine?: (line: string) => void,
): Promise<string> => {
    const { hostId, target } = door;
    if (!loosens(heldPolicy(status), next)) {
        return await manageDeviceSandbox(hostId, target.slug, `set-egress`, { egress: next, onLine });
    }
    // Read now, not when the page opened: the owner may have added a passkey since, and the hash must match what goes.
    const read = await readOwnerKeys();
    const keys = read.ownerKeys;
    if (signStanding(read) !== `ready` || keys === undefined) {
        throw new Error(t(`sandbox.networkFence.cannotSign`));
    }
    const { text, challenge } = await changeToSign(target, heldRevision(status), next, keys);
    const assertion = await assertPasskey({
        rpId: keys.rpId,
        challenge,
        timeout: 120_000,
        userVerification: `required`,
        allowCredentials: read.credentials.map((credential) => ({ type: `public-key`, id: credential.id, transports: credential.transports })),
        available: true,
    });
    return await manageDeviceSandbox(hostId, target.slug, `set-egress`, { egress: next, egressProof: { document: text, assertion }, onLine });
};
