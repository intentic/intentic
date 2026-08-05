import { lstat, mkdir, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Managed ssh-config shared by the `ssh` capability (one remote machine per alias) and git-provider access
// (github.com / a gitlab host, key auth). Each alias gets a `<alias>.conf` block that ~/.ssh/config Includes, plus
// a 0600 `<alias>.key` / `<alias>.pass` credential file written by the caller. Paths compute from homedir() at
// call time (not cached) so a test can point HOME at a temp dir. The container runs as root, so ~ resolves to
// /root — shared by the daemon, the agent, and the interactive terminal, so one config authenticates all three.
// The dir itself is a symlink onto the /history volume (linkSshHosts below), so the credentials survive the
// container recreates that wipe /root.
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

// Boot: point the managed dir at the /history volume and re-ensure the Include. ~/.ssh is the CONTAINER's
// filesystem, which every recreate throws away — recreate.sh (any mode) and a provider update all
// `docker rm -f` + `docker run`, keeping only the /work and /history volumes. So the ssh identity git access
// registered with github/gitlab, and every `ssh` capability's key, died on each rebuild while the manifest on
// /work still said "connected": `git pull` answered `Permission denied (publickey)` under a card that read
// active, and re-adding the connection just uploaded ANOTHER account key. The credential material lives on
// /history instead (the daemon's own volume — outside the agent's /work mount, never synced to a laptop) and
// ~/.ssh/intentic-hosts points at it, so every path the agent, the terminal, the skills and ssh itself use is
// unchanged. Mirrors linkClaudeState, including its "a real dir means a dev-host run" guard.
export const linkSshHosts = async (historyRoot: string): Promise<void> => {
    const target = join(historyRoot, "ssh-hosts");
    const link = hostsDir();
    await mkdir(target, { recursive: true, mode: 0o700 });
    await mkdir(dirname(link), { recursive: true, mode: 0o700 });
    const existing = await lstat(link).catch(() => undefined);
    if (existing !== undefined && !existing.isSymbolicLink()) {
        throw new Error(`${link} exists and is not a symlink — leaving the local ssh hosts alone`);
    }
    if (existing === undefined || (await readlink(link)) !== target) {
        if (existing !== undefined) {
            await rm(link);
        }
        await symlink(target, link);
    }
    // ~/.ssh/config is ephemeral too, and without the Include every alias file on the volume is inert.
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
