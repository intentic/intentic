import { lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import { writeFileAtomic } from "@intentic/base/fs";
import { withManagedInclude } from "@intentic/base/ssh-config";

// Managed ssh-config shared by the `ssh` capability and git-provider key access: `<alias>.conf` plus a 0600 key/pass
// file per alias. Resolved per call, not cached; symlinked onto /history so credentials survive container recreates.

// HOME is the home directory of record, read per call so a test can point it at a temp dir.
const homeDir = (): string => process.env["HOME"] ?? homedir();

export const hostsDir = (): string => join(homeDir(), ".ssh", "intentic-hosts");
export const hostConfPath = (alias: string): string => join(hostsDir(), `${alias}.conf`);
export const hostKeyPath = (alias: string): string => join(hostsDir(), `${alias}.key`);
export const hostPassPath = (alias: string): string => join(hostsDir(), `${alias}.pass`);

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
    // Absolute path to the identity file; omitted for password/agent auth (no IdentityFile line).
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

// Drops an alias's config and both possible credential files; missing files are fine.
export const removeSshHost = async (alias: string): Promise<void> => {
    await rm(hostConfPath(alias), { force: true });
    await rm(hostKeyPath(alias), { force: true });
    await rm(hostPassPath(alias), { force: true });
};
