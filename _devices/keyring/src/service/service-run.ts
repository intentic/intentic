import { randomBytes } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { sleep } from "@intentic/base/async";
import { writeFileAtomic } from "@intentic/base/fs";
import { keyringPaths } from "../address.js";
import { fileAudit } from "../audit.js";
import { BackendReader } from "../backends.js";
import { helloConsent, passphraseConsent, serialConsent } from "../consent/consent.js";
import { Keyring } from "../core.js";
import { fetchSandboxKeys } from "../keyring-fetch.js";
import { loadKeys, saveKeys } from "../keys.js";
import { realRunner, type Runner } from "../run.js";
import { helloWrapOf, readVaultFile, unwrapPassphrase, writeVaultFile } from "../vault.js";
import { KEYRING_VERSION } from "../version.js";
import { doorAcl } from "./acl.js";
import { serveDoor } from "./channel.js";
import { helloSigned } from "./hello-verify.js";
import { hardenedPaths } from "./paths.js";
import { HelperLink, type HelloPin, remoteHello, remotePassphrasePrompt, remoteTypist } from "./remote.js";

// `intentic-keyring service run --user <SID>`: the hardened keyring, run by Task Scheduler as LOCAL SERVICE. The same core
// as plain mode, over the vault in its access-listed folder, with the session helper for its prompts and typing.

export const runService = async (sid: string, runner: Runner = realRunner): Promise<void> => {
    const paths = hardenedPaths(sid);
    const files = keyringPaths(paths.vaultDir, "linux");
    const log = (message: string): void => {
        // allow(silent-catch): the log is where a failure would be said, so a line it cannot take has nowhere else to go.
        void appendFile(files.log, `${new Date().toISOString()} service: ${message}\n`).catch(() => undefined);
    };
    const pin = async (): Promise<HelloPin | undefined> => {
        const wrap = helloWrapOf((await readVaultFile(files.vault))?.wraps ?? []);
        return wrap?.publicKey === undefined ? undefined : { credential: wrap.credential, publicKey: wrap.publicKey };
    };
    const link = new HelperLink();
    const keyring = new Keyring({
        vault: { read: async () => await readVaultFile(files.vault), write: async (file) => await writeVaultFile(files.vault, files.dir, file) },
        keys: { read: async () => await loadKeys(files.keys, files.dir), write: async (keys) => await saveKeys(files.keys, files.dir, keys) },
        consent: serialConsent(helloConsent(remoteHello(link, pin), passphraseConsent(remotePassphrasePrompt(link)))),
        typist: remoteTypist(link),
        backends: new BackendReader(runner),
        fetchKeys: async (sandbox) => await fetchSandboxKeys(sandbox),
        audit: fileAudit(files.audit, files.dir),
        now: Date.now,
        sleep: async (ms) => await sleep(ms),
        version: KEYRING_VERSION,
        helloCredential: (await pin())?.credential ?? "intentic-keyring",
    });
    const token = randomBytes(32).toString("base64url");
    const { port } = await serveDoor({
        handler: keyring,
        link,
        token,
        challenge: async () => {
            const pinned = await pin();
            return pinned === undefined ? { method: "passphrase" } : { method: "hello", credential: pinned.credential, challenge: randomBytes(32).toString("base64url") };
        },
        proven: async (challenge, proof) => {
            if (challenge.method === "hello" && proof.method === "hello") {
                const pinned = await pin();
                return pinned !== undefined && helloSigned(pinned.publicKey, challenge.challenge, proof.signature);
            }
            if (proof.method === "passphrase") {
                const file = await readVaultFile(files.vault);
                const key = file === undefined ? undefined : await unwrapPassphrase(file.wraps, proof.passphrase);
                key?.fill(0);
                return key !== undefined;
            }
            return false;
        },
        log,
    });
    await writeFileAtomic(paths.door, `${JSON.stringify({ port, token, pid: process.pid })}\n`, 0o600);
    const acl = doorAcl(paths.door, sid);
    const set = await runner({ command: "icacls", args: [acl.path, ...acl.args], timeoutMs: 20_000 });
    if (set.exitCode !== 0) {
        log(`icacls on the door file failed (exit ${String(set.exitCode)}): the session helper cannot read it`);
    }
    log(`keyring ${KEYRING_VERSION} listening on 127.0.0.1:${String(port)}`);
    await new Promise<never>(() => undefined);
};
