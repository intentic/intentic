import { appendFile } from "node:fs/promises";
import type { Server } from "node:net";
import { sleep } from "@intentic/base/async";
import { claimPidFile, releasePidFile, rotateIfLarge } from "@intentic/local-agent";
import { type KeyringPaths, keyringPaths, userTag } from "./address.js";
import { fileAudit } from "./audit.js";
import { BackendReader } from "./backends.js";
import { type Consent, helloConsent, passphraseConsent, refusingConsent, serialConsent } from "./consent/consent.js";
import { linuxPassphrasePrompt, macPassphrasePrompt } from "./consent/consent-posix.js";
import { windowsHello, windowsPassphrasePrompt } from "./consent/consent-windows.js";
import { Keyring } from "./core.js";
import { fetchSandboxKeys } from "./keyring-fetch.js";
import { loadKeys, saveKeys } from "./keys.js";
import { realRunner, type Runner } from "./run.js";
import { serveKeyring } from "./server.js";
import { platformTypist } from "./typing/index.js";
import { readVaultFile, writeVaultFile } from "./vault.js";
import { KEYRING_VERSION } from "./version.js";

// `intentic-keyring serve`: the resident keyring, one per user, held by its pidfile. Everything platform-specific is
// chosen here once (how to ask a person, how to type) and handed to the core.

export const platformConsent = (runner: Runner, platform: NodeJS.Platform = process.platform): Consent => {
    switch (platform) {
        case "win32":
            return serialConsent(helloConsent(windowsHello(runner), passphraseConsent(windowsPassphrasePrompt(runner))));
        case "linux":
            return serialConsent(passphraseConsent(linuxPassphrasePrompt(runner)));
        case "darwin":
            return serialConsent(passphraseConsent(macPassphrasePrompt(runner)));
        default:
            return refusingConsent(`the keyring cannot ask a person on ${platform}.`);
    }
};

export const keyringOf = (paths: KeyringPaths, runner: Runner = realRunner): Keyring =>
    new Keyring({
        vault: { read: async () => await readVaultFile(paths.vault), write: async (file) => await writeVaultFile(paths.vault, paths.dir, file) },
        keys: { read: async () => await loadKeys(paths.keys, paths.dir), write: async (keys) => await saveKeys(paths.keys, paths.dir, keys) },
        consent: platformConsent(runner),
        typist: platformTypist(runner),
        backends: new BackendReader(runner),
        fetchKeys: async (sandbox) => await fetchSandboxKeys(sandbox),
        audit: fileAudit(paths.audit, paths.dir),
        now: Date.now,
        sleep: async (ms) => await sleep(ms),
        version: KEYRING_VERSION,
        helloCredential: `intentic-keyring-${userTag()}`,
    });

const logTo =
    (path: string) =>
    (message: string): void => {
        void rotateIfLarge(path)
            .then(async () => await appendFile(path, `${new Date().toISOString()} ${message}\n`, { mode: 0o600 }))
            // allow(silent-catch): the log is where a failure would be said, so a line it cannot take has nowhere else to go.
            .catch(() => undefined);
    };

export type Served = { readonly ok: true; readonly server: Server; readonly stop: () => Promise<void> } | { readonly ok: false; readonly reason: string };

export const serve = async (paths: KeyringPaths = keyringPaths()): Promise<Served> => {
    const claim = await claimPidFile(paths.pid, paths.dir, { pid: process.pid, build: KEYRING_VERSION });
    if (!claim.claimed) {
        return { ok: false, reason: `A keyring is running already (pid ${String(claim.holder.pid)}).` };
    }
    const log = logTo(paths.log);
    const server = await serveKeyring(keyringOf(paths), paths.address, log);
    log(`keyring ${KEYRING_VERSION} listening`);
    return {
        ok: true,
        server,
        stop: async () => {
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await releasePidFile(paths.pid, process.pid);
        },
    };
};
