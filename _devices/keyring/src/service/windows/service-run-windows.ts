import { randomBytes } from "node:crypto";
import { writeFileAtomic } from "@intentic/base/fs";
import { helloConsent, passphraseConsent, serialConsent } from "../../consent/consent.js";
import type { Runner } from "../../run.js";
import { helloWrapOf, readVaultFile } from "../../vault.js";
import { doorAcl } from "./acl-windows.js";
import { helloSigned } from "../hello-verify.js";
import { windowsServicePaths } from "./paths-windows.js";
import { type HelloPin, remoteChoicePrompt, remoteHello, remotePassphrasePrompt, remoteValuePrompt } from "../remote.js";
import type { ServiceRun } from "../service-run.js";

// The service on Windows: run by Task Scheduler as LOCAL SERVICE, the vault under %ProgramData%\Intentic\Keyring\<SID>,
// the door on loopback with its file readable by the one user (acl-windows.ts). A helper proves itself, and every yes
// is, a Windows Hello signature checked against the key pinned at setup (hello-verify.ts); the recovery key where Hello
// cannot answer.

// The credential's name for a vault set up by the service. KeyCredentialManager keeps credentials per user, so one name
// serves every user of the PC; a vault moved in from before keeps the name it was set up with.
const SERVICE_CREDENTIAL = "intentic-keyring";

export const windowsServiceRun = (sid: string, runner: Runner): ServiceRun => {
    const paths = windowsServicePaths(sid);
    const pinOf = async (vault: string): Promise<HelloPin | undefined> => {
        const wrap = helloWrapOf((await readVaultFile(vault))?.wraps ?? []);
        return wrap?.publicKey === undefined ? undefined : { credential: wrap.credential, publicKey: wrap.publicKey };
    };
    return {
        vaultDir: paths.vaultDir,
        place: { kind: "tcp" },
        consent: (link, files) => {
            const recovery = passphraseConsent(remotePassphrasePrompt(link));
            const withBox = { ...recovery, askValue: remoteValuePrompt(link), choose: remoteChoicePrompt(link) };
            return serialConsent(helloConsent(remoteHello(link, async () => await pinOf(files.vault)), withBox));
        },
        helloCredential: async (files) => (await pinOf(files.vault))?.credential ?? SERVICE_CREDENTIAL,
        challenge: async (files) => {
            const pinned = await pinOf(files.vault);
            return pinned === undefined ? { method: "passphrase" } : { method: "hello", credential: pinned.credential, challenge: randomBytes(32).toString("base64url") };
        },
        proven: async (challenge, proof, files) => {
            if (challenge.method !== "hello" || proof.method !== "hello") {
                return false;
            }
            const pinned = await pinOf(files.vault);
            return pinned !== undefined && helloSigned(pinned.publicKey, challenge.challenge, proof.signature);
        },
        publish: async (door, log) => {
            await writeFileAtomic(paths.door, `${JSON.stringify(door)}\n`, 0o600);
            const acl = doorAcl(paths.door, sid);
            const set = await runner({ command: "icacls", args: [acl.path, ...acl.args], timeoutMs: 20_000 });
            if (set.exitCode !== 0) {
                log(`icacls on the door file failed (exit ${String(set.exitCode)}): the session helper cannot read it`);
            }
        },
    };
};
