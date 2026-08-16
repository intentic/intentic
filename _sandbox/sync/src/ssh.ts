import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import type { Log } from "@intentic/local-agent";
import { baseDir, knownHostsPath, sshConfigName, sshConfigPath, sshDir, sshKeyPath, userSshConfigPath } from "./config.js";
import { syncSshPort } from "./tunnel.js";

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
    STATE_DIR,
    ".git",
    ".pnpm-store",
];

// A sandbox id safe for an ssh-config alias / Mutagen session name (letters, digits, dashes).
export const sanitizeId = (raw: string): string => raw.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");

export const sshAlias = (sandboxId: string): string => `intentic-sync-${sanitizeId(sandboxId)}`;

// OpenSSH globs/parses config paths POSIX-style: backslashes are escapes, so Windows paths must use "/".
// "C:/Users/…" is what the Cygwin-based clients Mutagen prefers on Windows want too — they take a mixed path
// verbatim, where a POSIX-only spelling (/c/… vs /cygdrive/c/…) differs per build.
const slashPath = (path: string): string => path.replaceAll("\\", "/");

/* The ssh-config stanza Mutagen's `ssh` uses to reach the sandbox — now a plain loopback address, because the
 * transport is a listener this agent runs (tunnel.ts) rather than a hostname somebody's fabric resolves.
 *
 * That deletes the ProxyCommand and the `cloudflared` download behind it. It was there because the SSH endpoint
 * was a real public hostname reached through a Cloudflare tunnel, which stopped being true for every sandbox on
 * the platform's own reachability path.
 *
 * The isolated known_hosts stays, and matters MORE here: every sandbox's transport is now `127.0.0.1` at a
 * different port, so a shared hosts file would collect one entry per sandbox against the same address — and the
 * user's own global file would see 127.0.0.1's key change under it every time they pair another. Ours is
 * per-agent and keyed the same way, so accept-new can neither be poisoned by it nor poison it. */
export const sshConfigBlock = (args: {
    readonly alias: string;
    readonly port: number;
    readonly identityFile: string;
    readonly knownHostsFile: string;
}): string =>
    [
        `Host ${args.alias}`,
        "    HostName 127.0.0.1",
        `    Port ${args.port}`,
        "    User root",
        // Paths are quoted: Windows profile paths often contain spaces (C:\Users\First Last\…).
        `    IdentityFile "${slashPath(args.identityFile)}"`,
        "    IdentitiesOnly yes",
        `    UserKnownHostsFile "${slashPath(args.knownHostsFile)}"`,
        "    StrictHostKeyChecking accept-new",
        // Every pairing's transport answers on 127.0.0.1, so the host key must be remembered against the PORT
        // too — without this, pairing a second sandbox looks to ssh like the first one's key changing.
        "    HostKeyAlias %h",
        "",
    ].join("\n");

// How the user's ~/.ssh/config pulls our block in. RELATIVE on purpose — the single line this whole feature
// hangs on. OpenSSH anchors a relative user-config include at ~/.ssh in every build there is; an ABSOLUTE
// Windows path ("C:/Users/…") is recognized as absolute only by Microsoft's Win32 client, and the Cygwin-based
// builds anchor it under ~/.ssh too, glob nothing, and — since a no-match include is not an error — silently
// include NOTHING. That decides Windows outright: Mutagen never consults PATH there, it takes the first ssh.exe
// out of a hardcoded list that starts with Git for Windows' Cygwin build and ends with Microsoft's
// (pkg/ssh/ssh_windows.go), so the client that has to understand this line is, on any machine with Git
// installed, exactly the one that cannot read an absolute one. With the include invisible the alias resolves to
// nothing, ssh dials the alias itself as a hostname, and Mutagen surfaces it as the unreadable "unable to
// receive server magic number: EOF".
export const INCLUDE_MARKER = `Include ${sshConfigName}`;

// The include lines that are OURS to add and remove: the current relative one, and the absolute-path spelling
// earlier builds wrote. The old one is stripped rather than left alone because it is worse than dead weight —
// on Microsoft's client it still resolves, pinning the alias to whatever hostname that stale file holds.
const MANAGED_INCLUDE = /^[ \t]*Include[ \t]+"?(?:intentic-sync\.conf|.*[/\\]\.intentic[/\\]sync[/\\]ssh_config)"?[ \t]*$/;

export const stripManagedIncludes = (config: string): string =>
    config
        .split("\n")
        .filter((line) => !MANAGED_INCLUDE.test(line))
        .join("\n");

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

// The whole fragment for a set of pairings: one Host block each, in pairing order. Regenerated from the pairing
// list rather than appended to, so adding or dropping one sandbox can neither duplicate a block nor strip a
// sibling's — which is what a single-block overwrite did to every other sandbox on the machine.
export const pairingSshConfig = (pairings: readonly { readonly sandboxId: string }[]): string =>
    pairings
        .map((pairing) =>
            sshConfigBlock({
                alias: sshAlias(pairing.sandboxId),
                port: syncSshPort(pairing.sandboxId),
                identityFile: sshKeyPath,
                knownHostsFile: knownHostsPath,
            }),
        )
        .join("\n");

// Write our managed ssh-config fragment into ~/.ssh and make the user's own config include it, so `ssh` — and
// therefore Mutagen — resolves every paired sandbox's alias. We never edit their host entries; the include line
// is the only thing we own, and it is rewritten from scratch each time so no earlier spelling of it can linger
// alongside.
export const writeManagedSshConfig = async (fragment: string): Promise<void> => {
    await mkdir(sshDir, { recursive: true, mode: 0o700 });
    await writeFile(sshConfigPath, fragment, { mode: 0o600 });
    const current = await readFile(userSshConfigPath, "utf8").catch(() => "");
    const desired = `${INCLUDE_MARKER}\n${stripManagedIncludes(current)}`;
    if (desired === current) {
        return;
    }
    // Temp file + rename: a crash mid-write must never truncate the user's whole ssh config.
    const tmp = `${userSshConfigPath}.intentic-tmp`;
    await writeFile(tmp, desired, { mode: 0o600 });
    await rename(tmp, userSshConfigPath);
};

// Undo exactly what writeManagedSshConfig did — our fragment and our include line, nothing else of the user's.
export const removeManagedSshConfig = async (): Promise<void> => {
    await rm(sshConfigPath, { force: true });
    const current = await readFile(userSshConfigPath, "utf8").catch(() => "");
    const stripped = stripManagedIncludes(current);
    if (stripped !== current) {
        await writeFile(userSshConfigPath, stripped, { mode: 0o600 });
    }
};

// Where Mutagen looks for ssh.exe on Windows, in its order: PATH is never consulted and Microsoft's client
// comes LAST, so a machine with Git for Windows on it (nearly every dev machine) runs Git's Cygwin build.
// Mirrors Mutagen's own pkg/ssh/ssh_windows.go — the list this agent's config has to satisfy.
const WINDOWS_SSH_SEARCH_PATHS = [
    "C:\\Program Files\\Git\\usr\\bin",
    "C:\\Program Files (x86)\\Git\\usr\\bin",
    "C:\\msys32\\usr\\bin",
    "C:\\msys64\\usr\\bin",
    "C:\\cygwin\\bin",
    "C:\\cygwin64\\bin",
    "C:\\Windows\\System32\\OpenSSH",
];

// The ssh binary Mutagen will invoke — the one that has to understand the config we just wrote, which on
// Windows is emphatically not "whatever `ssh` means on PATH". MUTAGEN_SSH_PATH overrides the search everywhere
// (Mutagen reads it the same way); plain `ssh` is the POSIX answer and the best guess left when a Windows box
// has none of the known locations.
export const mutagenSshPath = (platform: NodeJS.Platform, override: string | undefined): string => {
    const dirs = override === undefined || override === "" ? (platform === "win32" ? WINDOWS_SSH_SEARCH_PATHS : []) : [override];
    return dirs.map((dir) => join(dir, platform === "win32" ? "ssh.exe" : "ssh")).find((candidate) => existsSync(candidate)) ?? "ssh";
};

/* What `ssh -G <alias>` resolved the alias to. `-G` prints the fully expanded configuration, so this is ground
 * truth for "did THAT client read our block": one that never saw the include echoes the alias straight back as
 * the hostname, on the default port.
 *
 * The PORT is half the answer now, and the more specific half: every pairing's transport is on 127.0.0.1, so a
 * hostname match alone would also be satisfied by a stale block, by another tool's `Host *` entry, or by the
 * previous pairing's stanza — while the port is derived per sandbox and belongs to exactly one of them. */
export const resolvedEndpoint = (sshGOutput: string): { hostname?: string; port?: number } => {
    const host = /^hostname (.+)$/m.exec(sshGOutput)?.[1]?.trim();
    const port = Number(/^port (\d+)$/m.exec(sshGOutput)?.[1]);
    return { ...(host === undefined ? {} : { hostname: host }), ...(Number.isInteger(port) ? { port } : {}) };
};

// Fail here, where the cause is still knowable, rather than three layers down in Mutagen. An ssh that cannot
// see our config dials the alias as a literal hostname and the whole story arrives as "unable to receive server
// magic number: EOF (error output: ssh: Could not resolve hostname intentic-sync-…)".
export const assertSshConfigVisible = (ssh: string, alias: string, expectedPort: number): void => {
    const result = spawnSync(ssh, ["-G", alias], { encoding: "utf8" });
    if (result.error !== undefined) {
        throw new Error(`could not run "${ssh}", the SSH client Mutagen drives the sync transport with: ${result.error.message}`);
    }
    const resolved = resolvedEndpoint(result.stdout);
    if (resolved.hostname === "127.0.0.1" && resolved.port === expectedPort) {
        return;
    }
    const expected = `127.0.0.1:${expectedPort}`;
    throw new Error(
        [
            `"${ssh}" — the SSH client Mutagen uses — resolves ${alias} to "${resolved.hostname ?? "nothing"}:${resolved.port ?? "?"}" instead of ${expected},`,
            `so it is not reading ${sshConfigPath}, which ${userSshConfigPath} includes. Most often that client resolves`,
            `~ to a home directory other than ${homedir()}.`,
            ...(result.stderr.trim() === "" ? [] : [result.stderr.trim()]),
            ...(process.platform === "win32"
                ? [`Point Mutagen at the Windows OpenSSH client and re-run: setx MUTAGEN_SSH_PATH "C:\\Windows\\System32\\OpenSSH"`]
                : []),
        ].join("\n"),
    );
};

// One real connection before Mutagen's, so a transport that resolves but doesn't AUTHENTICATE says so in ssh's
// own words — a key the client reads as world-readable, a tunnel not up yet — instead of arriving as Mutagen's
// "server magic number" again. It also settles the known_hosts entry before the daemon races on it. Not fatal:
// Mutagen retries a session forever, so a transient failure is no reason to refuse the setup, only to report it.
export const probeSshTransport = (ssh: string, alias: string, log: Log): void => {
    const result = spawnSync(ssh, ["-o", "BatchMode=yes", "-o", "ConnectTimeout=20", alias, "true"], { encoding: "utf8" });
    if (result.status === 0) {
        return;
    }
    log(`note: a test SSH connection to the sandbox failed — sync may not start:\n${(result.stderr ?? result.error?.message ?? "").trim()}`);
};
