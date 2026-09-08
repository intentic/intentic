import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import type { Log } from "@intentic/local-agent";
import { STATE_GROUPS, stateGroupPaths, UNBACKED_STATE_PATHS } from "@intentic/sandbox-contract";
import { baseDir } from "../config.js";
import { knownHostsPath, sshConfigName, sshConfigPath, sshDir, sshKeyPath, userSshConfigPath } from "./config.js";
import { runProcess } from "./exec.js";
import { syncSshPort } from "./tunnel.js";

// Mutagen's two-way ignore set: also excludes secrets and the daemon's `.intentic` state, never the search-ignore
// set's job. `.git` matches every level, since git state travels by git's own protocol (git-bridge.ts), not file sync.
export const IGNORES = [
    "node_modules",
    "dist",
    ".turbo",
    ".cache",
    ".next",
    ".angular",
    // Astro's build cache; `.astro/dev.json` holds machine-local paths, so both sides regenerating it is a
    // create-vs-create conflict that never settles.
    ".astro",
    ".env",
    ".secrets.json",
    "claude.json",
    // No `capabilities.json` entry: its credentials live in the vault now, and the daemon's own copy sits under
    // STATE_DIR already. Keeping it would only exclude a same-named file of the user's.
    STATE_DIR,
    ".git",
    ".pnpm-store",
];

// The state dir's own one-way, sandbox-first backup, since the workspace session excludes it wholesale from
// two-way sync. Patterns are anchored, not depth-matched; a group collapses to a folder only when wholly excluded.
const anchored = (path: string): string => {
    const tail = path.slice(`${STATE_DIR}/`.length).replace(/\/$/, "");
    return `/${tail.endsWith(".") ? `${tail}*` : tail}`;
};

export const BACKUP_IGNORES: readonly string[] = STATE_GROUPS.flatMap((group) => {
    const inGroup = stateGroupPaths(group);
    const excluded = inGroup.filter((path) => UNBACKED_STATE_PATHS.includes(path));
    if (excluded.length === 0) {
        return [];
    }
    return excluded.length === inGroup.length ? [`/${group}`] : excluded.map(anchored);
});

// A sandbox id safe for an ssh-config alias / Mutagen session name (letters, digits, dashes).
export const sanitizeId = (raw: string): string => raw.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");

export const sshAlias = (sandboxId: string): string => `intentic-sync-${sanitizeId(sandboxId)}`;

// OpenSSH parses config paths POSIX-style; backslashes are escapes, so Windows paths must use "/". Cygwin-based
// clients take that mixed spelling verbatim too.
const slashPath = (path: string): string => path.replaceAll("\\", "/");

// The ssh-config stanza Mutagen's ssh uses: a loopback address, since the transport is a listener this agent runs
// (tunnel.ts). The isolated known_hosts matters more here, since every sandbox now shares 127.0.0.1 at a different
// port.
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
        // Written literally: ssh does not expand %-tokens in HostKeyAlias, so `%h` would be the literal string every
        // sandbox shares, and the second one to connect gets REMOTE HOST IDENTIFICATION HAS CHANGED.
        `    HostKeyAlias ${args.alias}`,
        "",
    ].join("\n");

// Relative on purpose: OpenSSH anchors a relative include at ~/.ssh in every build, but an absolute Windows path
// is recognized only by Microsoft's client, not the Cygwin-based ones Mutagen tries first, which then silently include
// nothing.
export const INCLUDE_MARKER = `Include ${sshConfigName}`;

// Every include spelling this agent has ever written, stripped rather than left alone: an old file's Host blocks
// share this agent's aliases, and whichever include ssh reads first wins.
const MANAGED_INCLUDE = /^[ \t]*Include[ \t]+"?(?:intentic-machine\.conf|intentic-sync\.conf|.*[/\\]\.intentic[/\\]sync[/\\]ssh_config)"?[ \t]*$/;

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
    // This machine's name, whitespace stripped to stay one authorized_keys token; the daemon shows it as the
    // "Syncing from X" label.
    const comment = hostname().replace(/\s+/g, "-") || "intentic-machine";
    const result = spawnSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", comment, "-f", sshKeyPath], { stdio: "inherit" });
    if (result.status !== 0) {
        throw new Error("ssh-keygen failed: is an OpenSSH client installed?");
    }
    return (await readFile(pub, "utf8")).trim();
};

// One Host block per pairing, regenerated from the full list rather than appended, so adding or dropping a
// sandbox can't duplicate or strip a sibling's block.
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

// Writes the managed fragment and makes the user's config include it, so ssh resolves every paired alias. Never
// edits their host entries; the include line is rewritten from scratch so no earlier spelling lingers.
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

// Undo exactly what writeManagedSshConfig did, our fragment and our include line, nothing else of the user's.
export const removeManagedSshConfig = async (): Promise<void> => {
    await rm(sshConfigPath, { force: true });
    const current = await readFile(userSshConfigPath, "utf8").catch(() => "");
    const stripped = stripManagedIncludes(current);
    if (stripped !== current) {
        await writeFile(userSshConfigPath, stripped, { mode: 0o600 });
    }
};

// Where Mutagen looks for ssh.exe on Windows, in order; PATH is never consulted, so a machine with Git for
// Windows (nearly all of them) runs its Cygwin build. Mirrors Mutagen's own pkg/ssh/ssh_windows.go.
const WINDOWS_SSH_SEARCH_PATHS = [
    "C:\\Program Files\\Git\\usr\\bin",
    "C:\\Program Files (x86)\\Git\\usr\\bin",
    "C:\\msys32\\usr\\bin",
    "C:\\msys64\\usr\\bin",
    "C:\\cygwin\\bin",
    "C:\\cygwin64\\bin",
    "C:\\Windows\\System32\\OpenSSH",
];

// The ssh binary Mutagen will invoke, which on Windows is not just whatever `ssh` means on PATH.
// MUTAGEN_SSH_PATH overrides the search everywhere; plain `ssh` is the fallback guess.
export const mutagenSshPath = (platform: NodeJS.Platform, override: string | undefined): string => {
    const dirs = override === undefined || override === "" ? (platform === "win32" ? WINDOWS_SSH_SEARCH_PATHS : []) : [override];
    return dirs.map((dir) => join(dir, platform === "win32" ? "ssh.exe" : "ssh")).find((candidate) => existsSync(candidate)) ?? "ssh";
};

// What `ssh -G` resolved the alias to; a client that missed the include echoes the alias back as the hostname.
// The port matters too: every transport shares 127.0.0.1, so hostname alone could match a stale block or another
// pairing's stanza.
export const resolvedEndpoint = (sshGOutput: string): { hostname?: string; port?: number } => {
    const host = /^hostname (.+)$/m.exec(sshGOutput)?.[1]?.trim();
    const port = Number(/^port (\d+)$/m.exec(sshGOutput)?.[1]);
    return { ...(host === undefined ? {} : { hostname: host }), ...(Number.isInteger(port) ? { port } : {}) };
};

// Fails here, where the cause is knowable, rather than three layers down in Mutagen as an unreadable "unable to
// receive server magic number" EOF.
export const assertSshConfigVisible = (ssh: string, alias: string, expectedPort: number): void => {
    // `windowsHide`: a console-less parent (the watcher) would otherwise pop a window for this child on Windows.
    const result = spawnSync(ssh, ["-G", alias], { encoding: "utf8", windowsHide: true });
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
            `"${ssh}": the SSH client Mutagen uses, resolves ${alias} to "${resolved.hostname ?? "nothing"}:${resolved.port ?? "?"}" instead of ${expected},`,
            `so it is not reading ${sshConfigPath}, which ${userSshConfigPath} includes. Most often that client resolves`,
            `~ to a home directory other than ${homedir()}.`,
            ...(result.stderr.trim() === "" ? [] : [result.stderr.trim()]),
            ...(process.platform === "win32"
                ? [`Point Mutagen at the Windows OpenSSH client and re-run: setx MUTAGEN_SSH_PATH "C:\\Windows\\System32\\OpenSSH"`]
                : []),
        ].join("\n"),
    );
};

// One real connection before Mutagen's, so an auth failure reports in ssh's own words, not another "server magic
// number" error; also settles known_hosts first. Not fatal, only reported: Mutagen retries forever.
export const probeSshTransport = async (ssh: string, alias: string, log: Log): Promise<void> => {
    if (await sshTransportAnswers(ssh, alias)) {
        return;
    }
    log(`note: a test SSH connection to the sandbox failed, sync may not start:\n${sshProbeReason}`);
};

// Asked before replacing a running session (mutagen.ts): a create against an unreachable sandbox fails, leaving
// no session at all, worse than the drifted one. Kept in a module slot rather than returned, since every caller here is
// synchronous.
let sshProbeReason = "";

// Must stay async: the mirror watcher, one of its callers, itself serves the transport this probe dials, so a
// blocking spawn would fail it against every sandbox, healthy or not.
export const sshTransportAnswers = async (ssh: string, alias: string): Promise<boolean> => {
    const result = await runProcess(ssh, ["-o", "BatchMode=yes", "-o", "ConnectTimeout=20", alias, "true"], { timeoutMs: PROBE_TIMEOUT_MS });
    sshProbeReason = result.stderr.trim();
    return result.status === 0;
};

// Covers what ssh's own ConnectTimeout doesn't: a transport that accepts the TCP dial but never speaks.
const PROBE_TIMEOUT_MS = 30_000;
