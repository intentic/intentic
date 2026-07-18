import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Managed ssh-config shared by the `ssh` capability (one remote machine per alias) and git-provider access
// (github.com / a gitlab host, key auth). Each alias gets a `<alias>.conf` block that ~/.ssh/config Includes, plus
// a 0600 `<alias>.key` / `<alias>.pass` credential file written by the caller. Paths compute from homedir() at
// call time (not cached) so a test can point HOME at a temp dir. The container runs as root, so ~ resolves to
// /root — shared by the daemon, the agent, and the interactive terminal, so one config authenticates all three.
// ponytail: aliases are a flat namespace, so an `ssh` capability named exactly "github.com" would collide with
// github git access on the same host — pathological; last writer wins, as with any duplicate id.

export const hostsDir = (): string => join(homedir(), ".ssh", "intentic-hosts");
export const hostConfPath = (alias: string): string => join(hostsDir(), `${alias}.conf`);
export const hostKeyPath = (alias: string): string => join(hostsDir(), `${alias}.key`);
export const hostPassPath = (alias: string): string => join(hostsDir(), `${alias}.pass`);

const INCLUDE = "Include intentic-hosts/*.conf";

// Make ~/.ssh/config pull in the managed dir, once. Relative Includes in a user config resolve under ~/.ssh, so a
// bare glob matches every alias file. Temp-file + rename so a crash mid-write can't truncate the user's config.
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

// Write (or overwrite) an alias's ssh-config block and make ~/.ssh/config Include the managed dir. The credential
// file (key/pass) is written by the caller — the ssh capability writes a pasted key, git access an ssh-keygen'd one.
export const writeSshHost = async (alias: string, spec: SshHostSpec): Promise<void> => {
    await mkdir(hostsDir(), { recursive: true, mode: 0o700 });
    await ensureInclude();
    await writeFile(hostConfPath(alias), configBlock(alias, spec));
};

// Drop an alias's config + both possible credential files (force: absent files are fine).
export const removeSshHost = async (alias: string): Promise<void> => {
    await rm(hostConfPath(alias), { force: true });
    await rm(hostKeyPath(alias), { force: true });
    await rm(hostPassPath(alias), { force: true });
};
