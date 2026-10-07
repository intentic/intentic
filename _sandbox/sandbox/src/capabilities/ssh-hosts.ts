import { lstat, mkdir, readdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import { writeFileAtomic } from "@intentic/base/fs";
import { withManagedInclude } from "@intentic/base/ssh-config";
import { publicLineOf } from "./credentials/ssh-keys.js";
import { isKeyAlias, type SshKeyStore } from "./ssh-key-store.js";
import { homeDir } from "../system/home-dir.js";

// Managed ssh-config shared by the `ssh` capability and git-provider key access: `<alias>.conf` per alias, beside the
// PUBLIC half of its key (`<alias>.pub`), or a password file for a machine that signs in with one. The private half is
// never here: it lives in the daemon's key store (ssh-key-store.ts) and the sandbox's ssh agent signs with it, so the
// config names the public file and ssh asks the agent (SSH_AUTH_SOCK) for the signature. Resolved per call, not cached;
// symlinked onto /history so the aliases survive container recreates.

// HOME is the home directory of record, read per call so a test can point it at a temp dir.

export const hostsDir = (): string => join(homeDir(), ".ssh", "intentic-hosts");
export const hostConfPath = (alias: string): string => join(hostsDir(), `${alias}.conf`);
// The public half the config's IdentityFile names: with IdentitiesOnly, ssh offers exactly this key from the agent.
export const hostPublicKeyPath = (alias: string): string => join(hostsDir(), `${alias}.pub`);
export const hostPassPath = (alias: string): string => join(hostsDir(), `${alias}.pass`);
// A private key as a file beside its alias: only ever one with a passphrase, which the agent could never sign with and
// which the passphrase protects where it sits. Every other key lives in the key store; an older build wrote those here
// too, and adoptLegacySshKeys moves them.
export const hostKeyFilePath = (alias: string): string => join(hostsDir(), `${alias}.key`);
const KEY_FILE_SUFFIX = ".key";

const INCLUDED = "intentic-hosts/*.conf";
const INCLUDE = `Include ${INCLUDED}`;

// Ensures ~/.ssh/config Includes the managed dir, first, once; a relative Include resolves under ~/.ssh, so a bare glob
// matches every alias file. Only a live line counts: one the user commented out is not an include. Written atomically
// so a crash mid-write cannot truncate the user's config.
const ensureInclude = async (): Promise<void> => {
    const sshDir = join(homeDir(), ".ssh");
    const userConfig = join(sshDir, "config");
    // Only absence reads as empty: the user's config that cannot be read is never rewritten as just the Include.
    const current = (await readFile(userConfig, "utf8").catch(undefinedIfMissing)) ?? "";
    const desired = withManagedInclude(current, INCLUDE, (path) => path === INCLUDED);
    if (desired === current) {
        return;
    }
    await mkdir(sshDir, { recursive: true, mode: 0o700 });
    await writeFileAtomic(userConfig, desired, 0o600);
};

// Boot: repoints the managed dir at the /history volume and re-ensures the Include, since ~/.ssh is container-local and
// a recreate wipes it. Credentials live on /history instead, so every path the agent, terminal and skills use is
// unchanged.
export const linkSshHosts = async (historyRoot: string): Promise<void> => {
    const target = join(historyRoot, "ssh-hosts");
    const link = hostsDir();
    await mkdir(target, { recursive: true, mode: 0o700 });
    await mkdir(dirname(link), { recursive: true, mode: 0o700 });
    const existing = await lstat(link).catch(undefinedIfMissing);
    if (existing !== undefined && !existing.isSymbolicLink()) {
        throw new Error(`${link} exists and is not a symlink: leaving the local ssh hosts alone`);
    }
    if (existing === undefined || (await readlink(link)) !== target) {
        if (existing !== undefined) {
            await rm(link);
        }
        await symlink(target, link);
    }
    // ~/.ssh/config is ephemeral too; without the Include, every alias file on the volume is inert.
    await ensureInclude();
};

export interface SshHostSpec {
    readonly host: string;
    readonly user: string;
    readonly port: number;
    // Absolute path to the identity file: the PUBLIC key the agent signs with (hostPublicKeyPath), or a passphrase-protected
    // key file (hostKeyFilePath); omitted for password auth.
    readonly identityFile?: string;
}

const configBlock = (alias: string, spec: SshHostSpec): string => {
    const lines = [
        `Host ${alias}`,
        `    HostName ${spec.host}`,
        `    User ${spec.user}`,
        `    Port ${spec.port}`,
        "    StrictHostKeyChecking accept-new",
    ];
    if (spec.identityFile !== undefined) {
        lines.push(`    IdentityFile "${spec.identityFile}"`, "    IdentitiesOnly yes");
    }
    return `${lines.join("\n")}\n`;
};

// Writes (or overwrites) an alias's ssh-config block and ensures ~/.ssh/config Includes the managed dir; the caller
// writes the credential file itself.
export const writeSshHost = async (alias: string, spec: SshHostSpec): Promise<void> => {
    await mkdir(hostsDir(), { recursive: true, mode: 0o700 });
    await ensureInclude();
    await writeFile(hostConfPath(alias), configBlock(alias, spec));
};

// Writes the public half beside the alias's config; the line is what authorized_keys holds, so it is no secret. Atomic,
// since it also REPLACES a stale one (git-access.ts) while an ssh may be reading it.
export const writeHostPublicKey = async (alias: string, publicLine: string): Promise<void> => {
    await mkdir(hostsDir(), { recursive: true, mode: 0o700 });
    await writeFileAtomic(hostPublicKeyPath(alias), publicLine.endsWith("\n") ? publicLine : `${publicLine}\n`, 0o644);
};

// Writes a key the agent cannot sign with (one with a passphrase) beside its alias, 0600 as ssh demands of a key file.
export const writeHostKeyFile = async (alias: string, privateKey: string): Promise<void> => {
    await mkdir(hostsDir(), { recursive: true, mode: 0o700 });
    await writeFile(hostKeyFilePath(alias), privateKey.endsWith("\n") ? privateKey : `${privateKey}\n`, { mode: 0o600 });
};

// Drops an alias's config, its public key, password and key files; missing files are fine. The key store's copy is the
// caller's to drop, since it owns the store.
export const removeSshHost = async (alias: string): Promise<void> => {
    await rm(hostConfPath(alias), { force: true });
    await rm(hostPublicKeyPath(alias), { force: true });
    await rm(hostPassPath(alias), { force: true });
    await rm(hostKeyFilePath(alias), { force: true });
    await rm(`${hostKeyFilePath(alias)}.pub`, { force: true });
};

// The config with its IdentityFile repointed from the old private key file to the public one; every other line kept.
const repointedIdentity = (conf: string, alias: string): string =>
    conf.replaceAll(/^([ \t]*IdentityFile[ \t]+).*$/gmu, `$1"${hostPublicKeyPath(alias)}"`);

/**
 * Moves the private key an older build wrote beside `alias` (`<alias>.key`) into the key store, writes the public half
 * in its place and repoints the alias at it. Ordered so a crash part-way leaves the key in at least one place: the store
 * is written before anything here is removed. A key with a passphrase stays where it is: the agent could never sign
 * with it, and the passphrase is what protects it there. Answers whether it moved one.
 */
export const adoptLegacySshKey = async (alias: string, keys: SshKeyStore): Promise<boolean> => {
    const privateKey = await readFile(hostKeyFilePath(alias), "utf8").catch(undefinedIfMissing);
    const publicLine = privateKey === undefined ? undefined : publicLineOf(privateKey);
    if (privateKey === undefined || publicLine === undefined) {
        return false;
    }
    await keys.put(alias, privateKey);
    await writeHostPublicKey(alias, publicLine);
    const conf = await readFile(hostConfPath(alias), "utf8").catch(undefinedIfMissing);
    if (conf !== undefined) {
        await writeFile(hostConfPath(alias), repointedIdentity(conf, alias));
    }
    await rm(hostKeyFilePath(alias), { force: true });
    await rm(`${hostKeyFilePath(alias)}.pub`, { force: true });
    return true;
};

/** Boot: adoptLegacySshKey for every alias with a key file beside it. Idempotent; answers the aliases it moved. */
export const adoptLegacySshKeys = async (keys: SshKeyStore): Promise<readonly string[]> => {
    const names = (await readdir(hostsDir()).catch(undefinedIfMissing)) ?? [];
    const adopted: string[] = [];
    for (const name of names) {
        const alias = name.slice(0, -KEY_FILE_SUFFIX.length);
        if (name.endsWith(KEY_FILE_SUFFIX) && isKeyAlias(alias) && (await adoptLegacySshKey(alias, keys))) {
            adopted.push(alias);
        }
    }
    return adopted;
};
