import { join } from "node:path";
import type { HostHub } from "../../hosts/host-peer.js";
import { keyringDevicesOf } from "./device-secrets.js";
import { fileSandboxKeyringKeys, type SandboxKeyringKeys, sandboxKeyringKeysDocument } from "./keyring-keys.js";
import { createKeyringLink, type KeyringDevices, type KeyringLinkRunner, type KeyringLogger } from "./keyring-link.js";
import {
    fileKeyringBook,
    fileKeyringCopies,
    type KeyringCopies,
    keyringCopiesDocument,
    keyringDevicesDocument,
    RELEASED_VALUES_FILE,
    type ReleasedDeviceValues,
    releasedDeviceValues,
} from "./keyring-stores.js";
import { createKeyringSync, type KeyringSync, type KeyringSyncDevices, keyringSyncMailboxDocument } from "./keyring-sync.js";

// The keyring half of the secrets slice, each part on its file under the auth root, built in the order they read each
// other: the sandbox's own keys, what the keyrings left here, the sync mailbox, then the link that uses them all.

export interface KeyringParts {
    // The owner's computers that can answer a keyring call now.
    readonly devices: KeyringDevices & KeyringSyncDevices;
    readonly keyringKeys: SandboxKeyringKeys;
    readonly keyringCopies: KeyringCopies;
    readonly releasedDeviceValues: ReleasedDeviceValues;
    readonly keyringSync: KeyringSync;
    readonly keyringLink: KeyringLinkRunner;
}

export interface KeyringPartsDeps {
    readonly authRoot: string;
    // The device hub, composed after the secrets slice, so read at each call.
    readonly hub: () => Pick<HostHub, "connected" | "client" | "state">;
    // The address the owner's computers paired with: the config's public URL.
    readonly publicUrl: () => string;
    readonly logger: KeyringLogger;
}

export const createKeyringParts = ({ authRoot, hub, publicUrl, logger }: KeyringPartsDeps): KeyringParts => {
    const devices = keyringDevicesOf(hub);
    const keyringKeys = fileSandboxKeyringKeys(join(authRoot, sandboxKeyringKeysDocument.path));
    const keyringCopies = fileKeyringCopies(join(authRoot, keyringCopiesDocument.path));
    const released = releasedDeviceValues(join(authRoot, RELEASED_VALUES_FILE), (message, error) => logger.warn({ err: error }, message));
    const keyringSync = createKeyringSync({ devices: () => devices, mailboxPath: join(authRoot, keyringSyncMailboxDocument.path), logger });
    const keyringLink = createKeyringLink({
        devices: () => devices,
        publicUrl,
        keys: keyringKeys,
        book: fileKeyringBook(join(authRoot, keyringDevicesDocument.path)),
        copies: keyringCopies,
        released,
        syncOf: keyringSync.syncOf,
        logger,
    });
    return { devices, keyringKeys, keyringCopies, releasedDeviceValues: released, keyringSync, keyringLink };
};
