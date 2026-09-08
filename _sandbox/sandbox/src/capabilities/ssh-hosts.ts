import { lstat, mkdir, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Managed ssh-config shared by the `ssh` capability and git-provider key access: `<alias>.conf` plus a 0600 key/pass
// file per alias. Resolved from homedir() per call, not cached; symlinked onto /history so credentials survive
// container recreates.

export const hostsDir = (): string => join(homedir(), ".ssh", "intentic-hosts");
export const hostConfPath = (alias: string): string => join(hostsDir(), `${alias}.conf`);
export const hostKeyPath = (alias: string): string => join(hostsDir(), `${alias}.key`);
export const hostPassPath = (alias: string): string => join(hostsDir(), `${alias}.pass`);

const INCLUDE = "Include intentic-hosts/*.conf";

// Ensures ~/.ssh/config Includes the managed dir once; a relative Include resolves under ~/.ssh, so a bare glob matches
// every alias file. Writes via temp file + rename so a crash mid-write cannot truncate the user's config.
const ensureInclude = async (): Promise<void> => {
    const sshDir = join(homedir(), ".ssh");
    const userConfig = join(sshDir, "config");
    const current = await readFile(userConfig, "utf8").catch(() => "");
    if (current.includes(INCLUDE)) {
        return;
    }
    await mkdir(sshDir, { recursive: true, mode: 0o700 });
    const tmp = `${userConfig}.intentic-tmp`;
    await writeFile(tmp, `${INCLUDE}\n${current}`, { mode: 0o600 });
    await rename(tmp, userConfig);
};

// Boot: repoints the managed dir at the /history volume and re-ensures the Include, since ~/.ssh is container-local and
// a recreate wipes it. Credentials live on /history instead, so every path the agent, terminal and skills use is
// unchanged.
export const linkSshHosts = async (historyRoot: string): Promise<void> => {
    const target = join(historyRoot, "ssh-hosts");
    const link = hostsDir();
    await mkdir(target, { recursive: true, mode: 0o700 });
    await mkdir(dirname(link), { recursive: true, mode: 0o700 });
    const existing = await lstat(link).catch(() => undefined);
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
