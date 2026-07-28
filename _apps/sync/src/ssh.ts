import { spawnSync } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { baseDir, sshConfigPath, sshKeyPath } from "./config.js";

// Paths Mutagen must NOT two-way-sync. Its OWN purpose-built list (not the daemon's search-ignore set): it must
// also exclude secret files + the daemon's .intentic state, which the search-ignore set deliberately keeps visible.
// Passed to `mutagen sync create --ignore`. `.intentic` is the daemon's own state (owner/members/automations/
// credentials) — it must never leave the sandbox, and two-way sync would let a local deletion clobber it.
//
// `.git` matches EVERY level, and NO git state ever file-syncs. The workspace root's /work/.git is a POINTER
// FILE reading `gitdir: /history/gits/root` — a path that exists only inside the sandbox; synced down it turns
// the user's local folder into a repo every git command refuses ("fatal: not a git repository"). And the daemon
// relocates every NESTED repo's real git dir onto /history/gits/<id> too (its repo-git-dirs.ts, the invariant
// turn isolation needs), leaving the same pointer file behind — so a nested .git that file-syncs pits the local
// side's real DIRECTORY against the sandbox's FILE: an unresolvable type conflict that pins the session at
// Conflicts: 1 forever and freezes the local .git at whatever it held when the relocation landed, while the
// worktree keeps syncing — every commit the sandbox makes from then on reads locally as phantom modifications.
// Mutagen's own --ignore-vcs covers only .git DIRECTORIES, so it misses both pointer files; a bare `.git`
// pattern covers every shape at every level. Git state still travels — over the SAME transport, by git's own
// protocol instead (git-bridge.ts fetches from /history/gits/<id> and fast-forwards the local clone): atomic
// and lock-aware where a file-level copy of a live .git is neither.
//
// `.pnpm-store` is the sandbox's pnpm content-addressable store — tens of thousands of hash-named blobs (GBs) that
// are a rebuildable cache, not workspace content, and that dwarf the actual project on the wire. It also carries a
// live SQLite WAL (v11/index.db-wal) that pnpm appends to while a scan runs, so leaving it in produces recurring
// "hashed size mismatch" scan problems on beta. The sandbox's own history ignore set already excludes it.
export const IGNORES = [
    "node_modules",
    "dist",
    ".turbo",
    ".cache",
    ".next",
    ".angular",
    ".env",
    ".secrets.json",
    "claude.json",
    "capabilities.json",
    ".intentic",
    ".git",
    ".pnpm-store",
];

// A sandbox id safe for an ssh-config alias / Mutagen session name (letters, digits, dashes).
export const sanitizeId = (raw: string): string => raw.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");

export const sshAlias = (sandboxId: string): string => `intentic-sync-${sanitizeId(sandboxId)}`;

// OpenSSH globs/parses config paths POSIX-style: backslashes are escapes, so Windows paths must use "/".
const slashPath = (path: string): string => path.replaceAll("\\", "/");

// The ssh-config stanza Mutagen's `ssh` uses to reach the sandbox: routed through the Cloudflare tunnel via
// cloudflared's ProxyCommand, authed by our dedicated key, with an isolated known_hosts so first-connect
// auto-accept can't be poisoned by (or poison) the user's global hosts file.
export const sshConfigBlock = (args: {
    readonly alias: string;
    readonly hostname: string;
    readonly identityFile: string;
    readonly knownHostsFile: string;
    readonly cloudflaredPath: string;
}): string =>
    [
        `Host ${args.alias}`,
        `    HostName ${args.hostname}`,
        "    User root",
        `    IdentityFile "${slashPath(args.identityFile)}"`,
        "    IdentitiesOnly yes",
        `    UserKnownHostsFile "${slashPath(args.knownHostsFile)}"`,
        "    StrictHostKeyChecking accept-new",
        // Paths are quoted: Windows profile paths often contain spaces (C:\Users\First Last\…).
        `    ProxyCommand "${slashPath(args.cloudflaredPath)}" access ssh --hostname %h`,
        "",
    ].join("\n");

export const INCLUDE_MARKER = `Include "${slashPath(sshConfigPath)}"`;

// Generate the ed25519 keypair on first setup; return the public key line to enroll on the daemon.
export const ensureSshKey = async (): Promise<string> => {
    await mkdir(baseDir, { recursive: true });
    const pub = `${sshKeyPath}.pub`;
    const existing = await readFile(pub, "utf8").catch(() => undefined);
    if (existing !== undefined) {
        return existing.trim();
    }
    // Comment = this machine's name (whitespace stripped so it stays a single authorized_keys token) — the
    // daemon surfaces it as the "Syncing from X" label and to name the holder when a takeover is refused.
    const comment = hostname().replace(/\s+/g, "-") || "intentic-sync";
    const result = spawnSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", comment, "-f", sshKeyPath], { stdio: "inherit" });
    if (result.status !== 0) {
        throw new Error("ssh-keygen failed — is an OpenSSH client installed?");
    }
    return (await readFile(pub, "utf8")).trim();
};

// Write our managed ssh-config file and make the user's ~/.ssh/config Include it (once) so system `ssh` — and
// therefore Mutagen — resolves the alias. We never edit the user's own host entries, only prepend the Include.
export const writeManagedSshConfig = async (block: string): Promise<void> => {
    await mkdir(baseDir, { recursive: true });
    await writeFile(sshConfigPath, block, { mode: 0o600 });
    const userConfig = join(homedir(), ".ssh", "config");
    const current = await readFile(userConfig, "utf8").catch(() => "");
    if (current.includes(INCLUDE_MARKER)) {
        return;
    }
    await mkdir(join(homedir(), ".ssh"), { recursive: true, mode: 0o700 });
    // Temp file + rename: a crash mid-write must never truncate the user's whole ssh config.
    const tmp = `${userConfig}.intentic-tmp`;
    await writeFile(tmp, `${INCLUDE_MARKER}\n${current}`, { mode: 0o600 });
    await rename(tmp, userConfig);
};
