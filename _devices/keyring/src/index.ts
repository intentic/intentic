// intentic-keyring as a library: the pipe's protocol and a client for it, for intentic-machine and intentic-askpass,
// and the sealing a value needs before it is sent in. The keyring's own process (serve.ts, core.ts) is not exported:
// nothing else runs its vault.

export { keyringAddress, keyringPaths, KEYRING_HOME, type KeyringPaths } from "./address.js";
export { askKeyring, KeyringUnavailable, type KeyringClientOptions } from "./client.js";
export { sealForKeyring } from "./seal.js";
export * from "./protocol.js";
export { windowsServicePaths, windowsServiceInstalled, type WindowsServicePaths } from "./service/windows/paths-windows.js";
export { linuxServicePaths, linuxServiceInstalled, type LinuxServicePaths } from "./service/linux/paths-linux.js";
export { currentSid } from "./service/windows/sid-windows.js";
export { helloHere, NOT_ON_MAC, serviceInstalledHere, servicePlatform, serviceUserId, type ServicePlatform } from "./service/user.js";
export { asRecoveryKey, newRecoveryKey } from "./service/recovery.js";
export { realRunner } from "./run.js";
