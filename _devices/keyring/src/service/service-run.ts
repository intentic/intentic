import { appendFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { sleep } from "@intentic/base/async";
import { type KeyringPaths, keyringPaths } from "../address.js";
import { fileAudit } from "../audit.js";
import { BackendReader } from "../backends.js";
import type { Consent } from "../consent/consent.js";
import { Keyring } from "../core.js";
import { fetchSandboxKeys } from "../keyring-fetch.js";
import { loadKeys, saveKeys } from "../keys.js";
import type { Runner } from "../run.js";
import type { KeyringHandler } from "../server.js";
import { readVaultFile, unwrapPassphrase, type VaultFile, writeVaultFile } from "../vault.js";
import { KEYRING_VERSION } from "../version.js";
import { type DoorPlace, serveDoor } from "./channel.js";
import type { Challenge, DoorFile, Proof } from "./door.js";
import { HelperLink, remoteTypist } from "./remote.js";

// `intentic-keyring service run --user <id>`: the protected keyring, run by the system as an account of its own (LOCAL
// SERVICE from a startup task on Windows, the `intentic-keyring` user from a systemd unit on Linux). The same core as
// the per-user keyring had, over the vault in a folder only that account reads, with the session helper for its prompts
// and typing. What differs by platform comes in a ServiceRun (service-run-windows.ts, service-run-linux.ts).

export interface ServiceRun {
    // The folder holding vault.json, keys.json and audit.jsonl.
    readonly vaultDir: string;
    readonly place: DoorPlace;
    readonly consent: (link: HelperLink, files: KeyringPaths) => Consent;
    readonly helloCredential: (files: KeyringPaths) => Promise<string>;
    // The challenge for a helper once the vault is set up.
    readonly challenge: (files: KeyringPaths) => Promise<Challenge>;
    // Whether a Hello or polkit proof answers `challenge` (the recovery key and `unset` are checked here).
    readonly proven: (challenge: Challenge, proof: Proof, files: KeyringPaths) => Promise<boolean>;
    // What a vault the core writes goes through first (the Linux service's own wrap); as written where absent.
    readonly beforeWrite?: (file: VaultFile) => Promise<VaultFile>;
    // A setup that went through, with the vault key its recovery key opens: the Linux service wraps it under its own.
    readonly afterSetup?: (vaultKey: Buffer) => Promise<void>;
    // The door file written where the user can read it, and nobody else.
    readonly publish: (door: DoorFile, log: (message: string) => void) => Promise<void>;
}

const recoveryOpens = async (files: KeyringPaths, passphrase: string): Promise<boolean> => {
    const file = await readVaultFile(files.vault);
    const key = file === undefined ? undefined : await unwrapPassphrase(file.wraps, passphrase);
    key?.fill(0);
    return key !== undefined;
};

/** Whether `proof` answers `challenge`: the parts every platform shares, then the platform's own. */
export const provenBy = async (run: Pick<ServiceRun, "proven">, files: KeyringPaths, challenge: Challenge, proof: Proof): Promise<boolean> => {
    switch (proof.method) {
        case "declined":
            return false;
        // Before setup there is nothing to protect, and nothing yet to prove with: the helper is let in to enrol Hello.
        // Asked again here, so a vault set up meanwhile is not opened to a helper that proved nothing.
        case "unset":
            return challenge.method === "unset" && (await readVaultFile(files.vault)) === undefined;
        case "passphrase":
            return await recoveryOpens(files, proof.passphrase);
        default:
            return await run.proven(challenge, proof, files);
    }
};

// The core's handler, with a setup that went through handed to the platform: the Linux service wraps the vault key
// under its own key then, while the recovery key it was made with is still in hand.
const withAfterSetup = (keyring: Keyring, run: ServiceRun, files: KeyringPaths): KeyringHandler => ({
    handle: async (request) => {
        const answer = await keyring.handle(request);
        if (request.op === "setup" && answer.ok && run.afterSetup !== undefined) {
            const file = await readVaultFile(files.vault);
            const key = file === undefined ? undefined : await unwrapPassphrase(file.wraps, request.passphrase);
            if (key !== undefined) {
                await run.afterSetup(key);
                key.fill(0);
                if (file !== undefined && run.beforeWrite !== undefined) {
                    await writeVaultFile(files.vault, files.dir, await run.beforeWrite(file));
                }
            }
        }
        return answer;
    },
});

export const runService = async (run: ServiceRun, runner: Runner): Promise<never> => {
    const files = keyringPaths(run.vaultDir, "linux");
    const log = (message: string): void => {
        // allow(silent-catch): the log is where a failure would be said, so a line it cannot take has nowhere else to go.
        void appendFile(files.log, `${new Date().toISOString()} service: ${message}\n`).catch(() => undefined);
    };
    const link = new HelperLink();
    const beforeWrite = run.beforeWrite ?? ((file: VaultFile) => Promise.resolve(file));
    const keyring = new Keyring({
        vault: { read: async () => await readVaultFile(files.vault), write: async (file) => await writeVaultFile(files.vault, files.dir, await beforeWrite(file)) },
        keys: { read: async () => await loadKeys(files.keys, files.dir), write: async (keys) => await saveKeys(files.keys, files.dir, keys) },
        consent: run.consent(link, files),
        typist: remoteTypist(link),
        backends: new BackendReader(runner),
        fetchKeys: async (sandbox) => await fetchSandboxKeys(sandbox),
        audit: fileAudit(files.audit, files.dir),
        now: Date.now,
        sleep: async (ms) => await sleep(ms),
        version: KEYRING_VERSION,
        helloCredential: await run.helloCredential(files),
    });
    const token = randomBytes(32).toString("base64url");
    const { port } = await serveDoor(
        {
            handler: withAfterSetup(keyring, run, files),
            link,
            token,
            challenge: async () => ((await readVaultFile(files.vault)) === undefined ? { method: "unset" } : await run.challenge(files)),
            proven: async (challenge, proof) => await provenBy(run, files, challenge, proof),
            log,
        },
        run.place,
    );
    const door: DoorFile = run.place.kind === "unix" ? { socket: run.place.path, token, pid: process.pid } : { port: port ?? 0, token, pid: process.pid };
    await run.publish(door, log);
    log(`keyring ${KEYRING_VERSION} listening on ${run.place.kind === "unix" ? run.place.path : `127.0.0.1:${String(port)}`}`);
    return await new Promise<never>(() => undefined);
};
