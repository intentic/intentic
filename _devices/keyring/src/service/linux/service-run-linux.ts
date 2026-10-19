import { writeFileAtomic } from "@intentic/base/fs";
import { passphraseConsent, serialConsent } from "../../consent/consent.js";
import { type Runner, succeeded } from "../../run.js";
import { linuxServicePaths } from "./paths-linux.js";
import { type PolkitSubject, askPolkit, polkitConsent, subjectOf } from "./polkit-linux.js";
import { remoteChoicePrompt, remotePassphrasePrompt, remoteValuePrompt } from "../remote.js";
import { ServiceKey } from "../service-key.js";
import type { ServiceRun } from "../service-run.js";
import { doorAclArgs } from "./unit-linux.js";

// The service on Linux: run by systemd as the `intentic-keyring` user, one instance per user (`intentic-keyring@<uid>`),
// the vault in /var/lib/intentic-keyring/<uid>, the door a unix socket in /run/intentic-keyring/<uid> opened to that
// uid alone by ACL. A helper proves itself, and every yes is, a polkit check the service runs itself about the helper's
// process (polkit-linux.ts); a daily unlock opens the vault with the service's own key (service-key.ts), and the
// recovery key is the way in when polkit cannot ask.

export const linuxServiceRun = (uid: string, runner: Runner): ServiceRun => {
    const paths = linuxServicePaths(uid);
    const serviceKey = new ServiceKey(paths.serviceKey, paths.vaultDir);
    let helper: PolkitSubject | undefined;
    return {
        vaultDir: paths.vaultDir,
        place: { kind: "unix", path: paths.socket },
        consent: (link) => {
            const recovery = { ...passphraseConsent(remotePassphrasePrompt(link)), askValue: remoteValuePrompt(link), choose: remoteChoicePrompt(link) };
            return serialConsent(polkitConsent({ runner, helper: () => (link.ready ? helper : undefined), serviceKey, recovery }));
        },
        helloCredential: () => Promise.resolve("intentic-keyring"),
        challenge: () => Promise.resolve({ method: "polkit" }),
        proven: async (challenge, proof) => {
            if (challenge.method !== "polkit" || proof.method !== "polkit") {
                return false;
            }
            // The pid the helper names must be a live process of this service's user; polkit then asks the person in
            // that process's session, so a process naming another's pid only gets that session's person asked.
            const subject = await subjectOf(proof.pid, uid);
            if (subject === undefined) {
                return false;
            }
            const said = await askPolkit(runner, subject, { title: "Connect Passwords", message: "Passwords on this computer asks you to confirm it is you, once for this sign-in." });
            if (said !== "yes") {
                return false;
            }
            helper = subject;
            return true;
        },
        beforeWrite: async (file) => await serviceKey.merged(file),
        afterSetup: async (vaultKey) => {
            await serviceKey.adopt(vaultKey);
        },
        publish: async (door, log) => {
            await writeFileAtomic(paths.door, `${JSON.stringify(door)}\n`, 0o600);
            for (const args of doorAclArgs(paths)) {
                const set = await runner({ command: "setfacl", args, timeoutMs: 10_000 });
                if (!succeeded(set)) {
                    log(`setfacl ${args.join(" ")} failed (${set.missing ? "setfacl is not installed" : `exit ${String(set.exitCode)}`}): the session helper cannot reach the door`);
                }
            }
        },
    };
};
