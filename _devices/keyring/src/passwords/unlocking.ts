import type { SealedBox } from "@intentic/sandbox-contract/schemas/keyring";
import { unseal } from "@intentic/sandbox-contract/keyring-seal";
import { MASTER_PASSWORD_MIN } from "../protocol.js";
import { MASTER_PASSWORD_PURPOSE } from "../seal.js";
import { looksLikeRecoveryKey } from "../service/recovery.js";
import { hasMasterPassword, helloChallenge, helloWrapOf, SCRYPT_COST, type Wrap, wrapWithHello, wrapWithPassphrase } from "../vault.js";
import { type Answer, NOT_SET_UP, refuse, type VaultAccess } from "./access.js";

// THE WAYS OF UNLOCKING, changed after setup (2026-11-09). The vault key is wrapped once per way (vault.ts); these ops
// add or take away a wrap, never touching the sealed document:
// - Windows Hello where setup could not enrol it (no session helper yet, Hello skipped or not yet set up in Windows),
//   which otherwise leaves a vault the recovery key alone opens, asked for at every sign-in and every yes;
// - the passphrase the person chooses (the `master` wrap: "master password" until 2026-11-11), asked for instead of the
//   recovery key wherever Hello or polkit cannot answer. The recovery key's wrap is never taken away: it stays the
//   backup for a forgotten passphrase.
// Each asks the person by the way the vault opens now, so adding a way in takes a way in the person already has.

const MASTER_PASSWORD_MAX = 1024;

/** Why a chosen passphrase cannot be kept, or undefined when it can: what setup and set-master-password both check. */
export const passphraseProblem = (passphrase: string): string | undefined => {
    const length = [...passphrase].length;
    if (length < MASTER_PASSWORD_MIN || length > MASTER_PASSWORD_MAX) {
        return `A passphrase needs at least ${String(MASTER_PASSWORD_MIN)} characters.`;
    }
    // The typed box reads a key-shaped answer as a recovery key (recovery.ts), so such a passphrase would never open.
    if (looksLikeRecoveryKey(passphrase)) {
        return "That reads as a recovery key. Choose a passphrase of your own: the recovery key stays as it is.";
    }
    return undefined;
};

const isMaster = (wrap: Wrap): boolean => wrap.method === "passphrase" && wrap.role === "master";

export interface UnlockingAccess extends VaultAccess {
    // Writes the vault file with these wraps and the sealed document and open part as they are.
    readonly rewrap: (wraps: readonly Wrap[]) => Promise<void>;
}

export class Unlocking {
    constructor(private readonly vault: UnlockingAccess) {}

    /** Windows Hello is here and signs, and the vault has no Hello wrap yet: what the app offers to turn on. */
    async helloAddable(): Promise<boolean> {
        const file = this.vault.file();
        const hello = this.vault.deps.consent.hello;
        return file !== undefined && hello !== undefined && helloWrapOf(file.wraps) === undefined && (await hello.available());
    }

    async addHello(): Answer<"add-hello"> {
        const file = this.vault.file();
        if (file === undefined) {
            return refuse("locked", NOT_SET_UP);
        }
        if (helloWrapOf(file.wraps) !== undefined) {
            return refuse("declined", "Windows Hello unlocks Passwords on this computer already.");
        }
        const hello = this.vault.deps.consent.hello;
        if (hello === undefined || !(await hello.available())) {
            return refuse("unavailable", "Windows Hello is not available here. Set up a PIN, face or fingerprint in Windows Settings › Accounts › Sign-in options, then try again.");
        }
        const opened = await this.vault.open(file, {
            title: "Turn on Windows Hello for Passwords?",
            message: "From now on Windows Hello unlocks Passwords and answers its questions. Your recovery key still opens it if Hello is ever reset.",
            person: true,
        });
        if ("ok" in opened) {
            return opened;
        }
        const challenge = helloChallenge();
        const enrolled = await hello.enrol(this.vault.deps.helloCredential, challenge, {
            title: "Turn on Windows Hello for Passwords",
            message: "Confirm with Windows Hello: from now on it unlocks Passwords on this computer.",
        });
        if (!enrolled.ok) {
            await this.vault.record({ op: "add-hello", outcome: "refused", reason: enrolled.reason });
            return enrolled.cancelled ? refuse("declined", "Windows Hello was not turned on: the person said no.") : refuse("unavailable", `Windows Hello could not be turned on: ${enrolled.reason}.`);
        }
        const helloWrap = wrapWithHello(opened.key, { credential: this.vault.deps.helloCredential, challenge, signature: enrolled.value.signature, publicKey: enrolled.value.publicKey });
        const latest = this.vault.file() ?? file;
        await this.vault.rewrap([...latest.wraps.filter((wrap) => wrap.method !== "hello"), helloWrap]);
        await this.vault.record({ op: "add-hello", outcome: "done", asked: opened.asked, how: opened.how });
        return { ok: true };
    }

    async setMasterPassword(sealed: SealedBox): Answer<"set-master-password"> {
        const file = this.vault.file();
        if (file === undefined) {
            return refuse("locked", NOT_SET_UP);
        }
        const had = hasMasterPassword(file.wraps);
        const opened = await this.vault.open(file, {
            title: had ? "Change your passphrase?" : "Set a passphrase for Passwords?",
            message: "Passwords will ask for it whenever Windows Hello or your computer's own check can't answer. Your recovery key keeps working as the backup, for the day you forget it.",
            person: true,
        });
        if ("ok" in opened) {
            return opened;
        }
        let password: string;
        try {
            password = unseal(opened.doc.inbox, sealed, MASTER_PASSWORD_PURPOSE);
        } catch {
            return refuse("bad-grant", "The passphrase was not sealed to this keyring's inbox for a passphrase.");
        }
        const problem = passphraseProblem(password);
        if (problem !== undefined) {
            return refuse("declined", problem);
        }
        const master = await wrapWithPassphrase(opened.key, password, this.vault.deps.scrypt ?? SCRYPT_COST, "master");
        const latest = this.vault.file() ?? file;
        // First, so the answer typed most often is the first one tried (vault.ts unwrapPassphrase).
        await this.vault.rewrap([master, ...latest.wraps.filter((wrap) => !isMaster(wrap))]);
        await this.vault.record({ op: "master-password", outcome: "done", target: had ? "changed" : "set", asked: opened.asked, how: opened.how });
        return { ok: true };
    }

    async removeMasterPassword(): Answer<"remove-master-password"> {
        const file = this.vault.file();
        if (file === undefined) {
            return refuse("locked", NOT_SET_UP);
        }
        if (!hasMasterPassword(file.wraps)) {
            return refuse("unknown", "Passwords has no passphrase on this computer.");
        }
        const opened = await this.vault.open(file, {
            title: "Remove your passphrase?",
            message: "Passwords will ask for your recovery key instead wherever Windows Hello or your computer's own check can't answer.",
            person: true,
        });
        if ("ok" in opened) {
            return opened;
        }
        const latest = this.vault.file() ?? file;
        await this.vault.rewrap(latest.wraps.filter((wrap) => !isMaster(wrap)));
        await this.vault.record({ op: "master-password", outcome: "done", target: "removed", asked: opened.asked, how: opened.how });
        return { ok: true };
    }
}
