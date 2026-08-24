import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { STATE_DIR, WORKSPACE_ROOT } from "@intentic/constants";
import type { Log } from "@intentic/local-agent";
import { binDir, type Pairing } from "./config.js";
import { runProcess } from "./exec.js";
import { BACKUP_IGNORES, IGNORES, mutagenSshPath, sanitizeId, sshAlias, sshTransportAnswers } from "./ssh.js";

// The pinned Mutagen version this agent downloads when the machine has no install of its own.
const MUTAGEN_VERSION = "0.18.1";

// The prefix every session this agent creates carries, sync and forward alike, what makes them all findable
// again later, whichever pairing created them (see ourSyncSessions / ourForwardSessions).
const SESSION_PREFIX = "intentic-";

// The Mutagen session name (letters/digits/dashes) so `mutagen sync {list,pause,resume,terminate}` can target it.
export const sessionName = (sandboxId: string): string => `${SESSION_PREFIX}${sanitizeId(sandboxId)}`;

/* The BACKUP session's name, the second sync a pairing runs, carrying the sandbox's state dir down one-way (see
 * backupSpec). It hangs off the workspace session's name rather than getting a prefix of its own so that
 * everything which finds our sessions by prefix keeps finding it: `oursIn` sweeps it, `parseOrphanSyncNames`
 * retires it with its pairing, and a user's own Mutagen sessions stay untouched by all of it. */
export const backupSessionName = (sandboxId: string): string => `${sessionName(sandboxId)}-state`;

/* Both of a pairing's sync sessions, in the order a person reads them: the workspace, then its backup. Every
 * caller that used to name the one session now asks for the pair, which is what keeps a half-converged pairing
 * from existing, pause, resume, terminate and the orphan sweep all act on the same two names. */
export const syncSessionNames = (sandboxId: string): readonly string[] => [sessionName(sandboxId), backupSessionName(sandboxId)];

// One port-mirror forward session per port, deterministically named so `mirror` can reconcile (terminate a
// vanished port's session, recreate a live one) without querying Mutagen's session list. The shared prefix is
// what makes every forward this agent has EVER created findable again, whichever pairing created it, the name
// carries the sandbox id, so a session outlives the config that could name it (see ourForwardSessions).
const FORWARD_PREFIX = "intentic-fwd-";
export const forwardSessionName = (sandboxId: string, port: number): string => `${FORWARD_PREFIX}${sanitizeId(sandboxId)}-${port}`;

// Session names split out of a `list` listing, narrowed to the ones this agent owns. Whitespace-separated is
// unambiguous because a name is a sanitized id (plus a port number for a forward), and anything outside our
// prefix belongs to the user's own Mutagen, never ours to terminate.
const oursIn = (listed: string, prefix: string): string[] => listed.split(/\s+/).filter((name) => name.startsWith(prefix));

// The sandbox a forward session belongs to. The port is the trailing all-digit segment, so a sanitized id
// containing dashes (every real one does) still splits off correctly.
const FORWARD_NAME = new RegExp(`^${FORWARD_PREFIX}(.+)-(\\d+)$`);

// Our forward sessions, optionally narrowed to ONE sandbox, what lets a single pairing be torn down without
// touching the forwards every other paired sandbox on this machine is holding. Matching parses the name instead
// of testing a prefix: `intentic-fwd-sandbox-a-` is a prefix of `intentic-fwd-sandbox-a-b-5173` too.
export const parseForwardNames = (listed: string, sandboxId?: string): string[] => {
    const names = oursIn(listed, FORWARD_PREFIX);
    if (sandboxId === undefined) {
        return names;
    }
    const wanted = sanitizeId(sandboxId);
    return names.filter((name) => FORWARD_NAME.exec(name)?.[1] === wanted);
};

// Forward sessions belonging to no pairing we still hold: a sandbox that was unpaired (or whose config was lost)
// while Mutagen kept its localhost listener bound. Verified against 0.18.1: a session whose sandbox has been
// destroyed still reports ForwardingConnections and still holds the port, so every port it used greets the next
// pairing as "busy on this machine" until something terminates it.
export const parseOrphanForwardNames = (listed: string, keptSandboxIds: readonly string[]): string[] => {
    const kept = new Set(keptSandboxIds.map(sanitizeId));
    return parseForwardNames(listed).filter((name) => {
        const owner = FORWARD_NAME.exec(name)?.[1];
        return owner === undefined || !kept.has(owner);
    });
};

// Which file-sync sessions to retire: ours, minus the ones the pairings we still hold name. A session is retired
// because NOTHING claims it any more, never merely because another pairing arrived. Mutagen retries a
// disconnected session every 15 seconds for as long as the daemon lives, so an orphan is a dead sandbox being
// dialled forever and a line of junk in `intentic-sync status`.
// Forward sessions carry the same prefix but never appear in a `sync list`, so they can't be caught here.
export const parseOrphanSyncNames = (listed: string, keep: readonly string[]): string[] => {
    const kept = new Set(keep);
    return oursIn(listed, SESSION_PREFIX).filter((name) => !kept.has(name));
};

// The raw name listing for one kind of session. A daemon that isn't running (or a list that fails) has nothing
// of ours to report, and nothing to tear down either.
const listSessionNames = (mutagen: string, kind: "forward" | "sync"): string => {
    const result = spawnSync(mutagen, [kind, "list", "--template", "{{range .}}{{.Name}} {{end}}"], { encoding: "utf8", windowsHide: true });
    return result.status === 0 ? result.stdout : "";
};

// Every forward session in the daemon that is ours, all of them, or just one sandbox's.
export const ourForwardSessions = (mutagen: string, sandboxId?: string): string[] =>
    parseForwardNames(listSessionNames(mutagen, "forward"), sandboxId);

// Forward sessions no pairing in `keptSandboxIds` claims.
const orphanForwardSessions = (mutagen: string, keptSandboxIds: readonly string[]): string[] =>
    parseOrphanForwardNames(listSessionNames(mutagen, "forward"), keptSandboxIds);

// `mutagen forward create` args: bind the SAME port on the local loopback and pipe it to the sandbox listener
// at its recorded loopback address, `host` is the daemon-reported dial host, because a `localhost` bind inside
// the sandbox can land on ::1 only (Vite), where dialing 127.0.0.1 is connection-refused. TCP-level, so a
// dev server's TLS passes through untouched and the local browser sees exactly what a local dev server serves.
export const mutagenForwardArgs = (args: {
    readonly name: string;
    readonly port: number;
    readonly alias: string;
    readonly host: string;
}): string[] => [
    "forward",
    "create",
    "--name",
    args.name,
    `tcp:127.0.0.1:${args.port}`,
    `${args.alias}:tcp:${args.host.includes(":") ? `[${args.host}]` : args.host}:${args.port}`,
];

// Everything a file-sync session is made of: the two endpoints plus the name that lets every other command find
// it again. One shape describes both what we WOULD create and what a live session is compared against, so the
// two can't drift apart in code.
export interface SyncSessionSpec {
    readonly name: string;
    readonly localDir: string;
    readonly alias: string;
    readonly remoteDir: string;
    /* Pinned per session rather than globally, because the two a pairing runs want opposite things. The workspace
     * is edited on both ends, so it is two-way and conflicts are flagged. The backup has exactly one writer, so
     * it is a replica: the laptop copy is whatever the sandbox holds, deletions included. Replica is also what
     * makes it a BACKUP rather than an ever-growing pile, a note deleted in the sandbox should not linger. */
    readonly mode: "two-way-safe" | "one-way-replica";
    readonly ignores: readonly string[];
    /* WHICH END IS ALPHA, and the reason this is a field instead of a convention. Mutagen's one-way modes always
     * propagate alpha → beta, so a session that must run sandbox → laptop has to put the SANDBOX first. The
     * workspace session is local-first and two-way, where the order carries no direction at all. Getting this
     * backwards on the backup would not fail loudly; it would quietly overwrite the sandbox's own state with
     * whatever the laptop had. */
    readonly from: "local" | "sandbox";
}

// The workspace session for a pairing: name and ssh alias both namespace on the sandbox id, and the remote side
// is always /work, the sandbox's workspace root is the only thing there is to sync.
const sessionSpec = (pairing: Pairing & { readonly localDir: string }): SyncSessionSpec => ({
    name: sessionName(pairing.sandboxId),
    localDir: pairing.localDir,
    alias: sshAlias(pairing.sandboxId),
    remoteDir: WORKSPACE_ROOT,
    mode: "two-way-safe",
    ignores: IGNORES,
    from: "local",
});

/* THE BACKUP SESSION: the sandbox's state dir, mirrored down into the same place under the paired folder.
 *
 * It lands at `<localDir>/.intentic`, inside the folder the user already has, not beside it, so what sits on
 * their disk is the sandbox as it actually is, and a restore is a copy rather than a reassembly. The two
 * sessions cannot fight over it: the workspace session ignores the state dir wholesale (IGNORES), which is
 * exactly the exclusion that makes room for this one.
 *
 * ONE-WAY, SANDBOX FIRST. The daemon is the only writer of anything in here, so there is no edit on the laptop
 * worth propagating back, and pretending otherwise is what would put transcript churn and ledger rewrites into a
 * two-way reconciler. Mutagen halts a replica rather than emptying beta when alpha's root disappears
 * (halted-on-root-emptied), which is the case that matters here: a sandbox mid-rebuild must not read as "the
 * owner deleted their backup".
 *
 * IT WILL BE CHATTY, and that is accepted rather than overlooked. Session transcripts are rewritten on every
 * streamed token and the run ledgers every few seconds, so this session transfers something most of the time a
 * turn is running, which is exactly why the workspace watcher refuses to WATCH those same paths. The difference
 * is what each one costs: a watcher event fans out to every connected browser as a refetch, while this is a
 * delta on a wire that is already up, with no reader waiting on it. If it ever needs trimming, the honest lever
 * is the classification (a transcript tree could be its own entry with its own answer), not a quiet exclusion
 * here, the whole point of the list is that what the owner keeps is decided in one place. */
const backupSpec = (pairing: Pairing & { readonly localDir: string }): SyncSessionSpec => ({
    name: backupSessionName(pairing.sandboxId),
    localDir: join(pairing.localDir, STATE_DIR),
    alias: sshAlias(pairing.sandboxId),
    remoteDir: `${WORKSPACE_ROOT}/${STATE_DIR}`,
    mode: "one-way-replica",
    ignores: BACKUP_IGNORES,
    from: "sandbox",
});

// `mutagen sync create` args: two-way-safe (flags conflicts rather than clobber), our ignore set, and
// neighboring staging on the remote so a huge file stages on the same filesystem as /work (atomic rename, no
// cross-fs 2× copy). local first, then user@alias:/work. The sync mode is pinned explicitly. Mutagen's default
// is two-way-safe, but relying on the default lets a version bump or a user's global mutagen config silently
// switch it to a clobbering mode; pinning keeps conflicts flagged, never overwritten.
//
// No --ignore-vcs: its pattern set covers .git DIRECTORIES only, and the shapes that actually appear here,
// the pointer FILES the daemon leaves at /work/.git and inside every relocated repo, slip straight through
// it. IGNORES carries the bare `.git` that covers every shape at every level; see the comment there. Git
// state travels by git's own protocol instead (git-bridge.ts).
export const mutagenCreateArgs = (spec: SyncSessionSpec, paused: boolean): string[] => {
    const local = spec.localDir;
    const remote = `${spec.alias}:${spec.remoteDir}`;
    return [
        "sync",
        "create",
        "--name",
        spec.name,
        "--sync-mode",
        spec.mode,
        ...(paused ? ["--paused"] : []),
        ...spec.ignores.flatMap((pattern) => ["--ignore", pattern]),
        "--stage-mode-beta",
        "neighboring",
        // Alpha first. `from` is what decides it, because a one-way session's direction IS its endpoint order.
        ...(spec.from === "local" ? [local, remote] : [remote, local]),
    ];
};

// A live session as the daemon reports it, narrowed to what the drift check and the status report read. Protobuf
// JSON omits defaults, so a session with no ignores at all arrives as `"ignore":{}` and vcs:false is simply
// absent, and by the same rule `status`/`conflicts` are absent on a session that has neither, which is why
// everything the report reads is optional rather than defaulted here.
interface LiveSession {
    // Both ends carry an optional host now that a session may run either way round: the backup's ALPHA is the
    // sandbox. Protobuf JSON omits a local endpoint's empty host, so `undefined` is what "this machine" looks
    // like on whichever side happens to be local.
    readonly alpha: { readonly host?: string; readonly path?: string };
    readonly beta: { readonly host?: string; readonly path?: string };
    readonly ignore: { readonly paths?: readonly string[]; readonly vcs?: boolean };
    readonly paused?: boolean;
    readonly status?: string;
    readonly conflicts?: readonly unknown[];
}

// The session of this name as the daemon has it, or undefined when there is none. A non-zero exit is Mutagen's
// "specification did not match any sessions", or its daemon being unreachable, in which case the create that
// follows fails loudly with the real reason, which is what we want anyway.
const readSession = (mutagen: string, name: string): LiveSession | undefined => {
    const result = spawnSync(mutagen, ["sync", "list", "--template", "{{json .}}", name], { encoding: "utf8", windowsHide: true });
    if (result.status !== 0) {
        return undefined;
    }
    return (JSON.parse(result.stdout) as LiveSession[])[0];
};

/* What one pairing's file sync is DOING right now, for the machine report. Mutagen's own word is carried through
 * rather than mapped onto a traffic light: its halted states name their own cause ("halted-on-root-emptied"), and
 * a UI that flattens them to "problem" sends the user back to the terminal the report exists to replace.
 *
 * `exists` is separate from `status` because protobuf JSON OMITS a zero value, and Mutagen's status zero value is
 * "disconnected", so a session dialling a sandbox that will not answer arrives with no status field at all,
 * exactly like a session that was never created. Those are opposite situations for a reader ("it is trying" vs
 * "nothing is syncing that folder"), and collapsing them is what let a pairing with NO session render as a blank
 * cell on a status line that otherwise looked healthy. The absence is resolved here, once, where the answer is
 * known.
 *
 * The other fields stay absent when Mutagen did not say. Absent must read as "not known", never as zero. */
export const readSessionState = (
    mutagen: string,
    name: string,
): { exists: boolean; status?: string | undefined; paused?: boolean | undefined; conflicts?: number | undefined } => {
    const session = readSession(mutagen, name);
    if (session === undefined) {
        return { exists: false };
    }
    // An omitted status is the enum's zero value, which is Mutagen's own "disconnected", named rather than dropped.
    return { exists: true, status: session.status ?? "disconnected", paused: session.paused, conflicts: session.conflicts?.length };
};

/* Which of these session names the daemon actually HAS. `mutagen sync list a b` is all-or-nothing: one name it
 * cannot resolve makes it print nothing but "did not match any sessions" and exit 1, so asking for a fleet's
 * sessions is a command that fails entirely the moment one pairing has lost its own, which is how
 * `intentic-sync status` came to die on the one machine state it exists to explain. Callers ask this first and
 * list only what is there, naming the rest themselves. */
export const existingSyncSessions = (mutagen: string, names: readonly string[]): string[] => {
    const listed = new Set(oursIn(listSessionNames(mutagen, "sync"), SESSION_PREFIX));
    return names.filter((name) => listed.has(name));
};

/* Stop spending CPU on a sandbox that has stayed unreachable for an hour, without confusing that with a
 * person's deliberate pause. Both sessions are always paused/resumed as a pair. A pairing with no sessions is
 * already idle, and one whose sessions are both manually paused is left alone so the watcher never later undoes
 * the owner's choice. */
export const pauseUnreachableSync = (mutagen: string, pairing: Pairing): boolean => {
    if (pairing.mode !== "sync") {
        return false;
    }
    const names = existingSyncSessions(mutagen, syncSessionNames(pairing.sandboxId));
    if (names.length === 0 || names.every((name) => readSessionState(mutagen, name).paused === true)) {
        return false;
    }
    const result = spawnSync(mutagen, ["sync", "pause", ...names], { stdio: "ignore", windowsHide: true });
    return result.status === 0;
};

export const resumeAutoPausedSync = (mutagen: string, pairing: Pairing): boolean => {
    if (pairing.mode !== "sync" || pairing.fileSyncAutoPaused !== true) {
        return false;
    }
    const names = existingSyncSessions(mutagen, syncSessionNames(pairing.sandboxId));
    if (names.length === 0) {
        return false;
    }
    const result = spawnSync(mutagen, ["sync", "resume", ...names], { stdio: "ignore", windowsHide: true });
    return result.status === 0;
};

// Whether what's running is what THIS build would create. Both endpoints and the WHOLE ignore set count:
// Mutagen freezes a session's configuration at `sync create` and has no verb that edits it afterwards, so an
// ignore list that no longer matches is a session that will never behave like this version says it does.
export const sessionMatchesSpec = (session: LiveSession, spec: SyncSessionSpec): boolean => {
    // Which endpoint should be holding what, given the direction this spec runs in. A backup session whose ends
    // are the wrong way round is the one drift that must never be read as "close enough", it would be uploading.
    const [alpha, beta] =
        spec.from === "local"
            ? [
                  { host: undefined, path: spec.localDir },
                  { host: spec.alias, path: spec.remoteDir },
              ]
            : [
                  { host: spec.alias, path: spec.remoteDir },
                  { host: undefined, path: spec.localDir },
              ];
    return (
        session.alpha.path === alpha.path &&
        session.alpha.host === alpha.host &&
        session.beta.path === beta.path &&
        session.beta.host === beta.host &&
        session.ignore.vcs !== true &&
        (session.ignore.paths ?? []).join("\n") === spec.ignores.join("\n")
    );
};

// Converge the file-sync session on this build: create it when missing, recreate it when what's running drifted.
// Recreating is the only way to change a session's ignores, and that is what makes an agent upgrade actually
// reach a machine that is ALREADY paired, without it, a pairing made before a rule changed keeps syncing on
// the old rules forever, silently, with `status` reporting a perfectly healthy "Watching for changes". That is
// exactly how every project's .git stayed out of sandboxes long after --ignore-vcs was dropped here.
//
// The recreate is cheap where it counts: content that already matches on both ends reconciles without transfer,
// so it costs a rescan, not a re-download. A paused session is recreated paused, drift gets fixed without
// overriding a deliberate `intentic-sync pause`.
export const ensureSyncSession = async (mutagen: string, pairing: Pairing, log: Log): Promise<void> => {
    if (pairing.mode !== "sync" || pairing.localDir === undefined) {
        return; // a mirror-only enrollment has no file sync at all: just port forwards
    }
    const held = { ...pairing, localDir: pairing.localDir };
    /* Both sessions, converged in order and independently. Sequential rather than concurrent because they share
     * one ssh transport and one Mutagen daemon, and a recreate on either can block on the same probe; the
     * workspace goes first because it is the one the user is waiting on. An unreachable sandbox leaves BOTH
     * alone (each converge bails on the same probe), so a pairing never ends up half on the new rules. */
    for (const spec of [sessionSpec(held), backupSpec(held)]) {
        await convergeSession(mutagen, spec, log);
    }
};

const convergeSession = async (mutagen: string, spec: SyncSessionSpec, log: Log): Promise<void> => {
    const live = readSession(mutagen, spec.name);
    if (live !== undefined && sessionMatchesSpec(live, spec)) {
        return;
    }
    if (live !== undefined) {
        /* NEVER TEAR DOWN A RUNNING SESSION WE CANNOT REPLACE. Recreating is the only way to change a session's
         * ignores, and `mutagen sync create` refuses against an endpoint that will not answer, so a drifted
         * session plus an unreachable sandbox used to end with the session terminated, the create failed, and the
         * folder syncing nothing at all until someone noticed. Asleep, rebooting, mid-rebuild and mid-deploy are
         * all ordinary states for a sandbox, and every one of them hit this. So the transport is asked FIRST, and
         * a sandbox that does not answer keeps the session it has: drifted and retrying beats gone. The retry
         * comes back around on the watcher's next session pass (mirror.ts), by which time the sandbox may be up.
         *
         * The probe rides the same alias and the same listener Mutagen would use, so it is the same question,
         * asked at a cost of one ssh. */
        if (!(await sshTransportAnswers(mutagenSshPath(process.platform, process.env["MUTAGEN_SSH_PATH"]), spec.alias))) {
            log(
                `${spec.name}: the sandbox is not answering, so its existing file sync is left running as it is rather than terminated for a replacement that cannot be created. Retrying later.`,
            );
            return;
        }
        log(
            "the running sync session was created by an older agent: recreating it so this version's rules apply (no .git file-syncs anymore; commits arrive via the git bridge instead).",
        );
        spawnSync(mutagen, ["sync", "terminate", spec.name], { stdio: "ignore", windowsHide: true });
    }
    await runMutagenAsync(mutagen, mutagenCreateArgs(spec, live?.paused === true), log);
};

// Sweep the file-sync and forward sessions no pairing claims any more. Run when the pairing list changes, so an
// unpaired sandbox stops being dialled and releases the localhost ports it was holding. WITHOUT this being the
// thing that fires when a second sandbox is merely added, which is how a live pairing used to get evicted.
export const retireOrphanSessions = (mutagen: string, pairings: readonly Pairing[], log: Log): void => {
    const ids = pairings.map((pairing) => pairing.sandboxId);
    const sessions = parseOrphanSyncNames(
        listSessionNames(mutagen, "sync"),
        pairings.flatMap((pairing) => syncSessionNames(pairing.sandboxId)),
    );
    if (sessions.length > 0) {
        spawnSync(mutagen, ["sync", "terminate", ...sessions], { stdio: "ignore", windowsHide: true });
        log(`retired ${sessions.length} file-sync session(s) belonging to sandboxes this machine no longer pairs.`);
    }
    const forwards = orphanForwardSessions(mutagen, ids);
    if (forwards.length > 0) {
        spawnSync(mutagen, ["forward", "terminate", ...forwards], { stdio: "ignore", windowsHide: true });
        log(`released ${forwards.length} port forward(s) left holding localhost for sandboxes this machine no longer pairs.`);
    }
};

export const osToken = (): "linux" | "darwin" | "windows" => {
    if (process.platform === "linux" || process.platform === "darwin") {
        return process.platform;
    }
    if (process.platform === "win32") {
        return "windows";
    }
    throw new Error(`auto-download isn't supported on ${process.platform}: install mutagen and cloudflared manually, then re-run.`);
};

export const exe = process.platform === "win32" ? ".exe" : "";

export const archToken = (): "amd64" | "arm64" => {
    if (process.arch === "x64") {
        return "amd64";
    }
    if (process.arch === "arm64") {
        return "arm64";
    }
    throw new Error(`unsupported CPU arch ${process.arch}: install mutagen and cloudflared manually, then re-run.`);
};

// The version an installed copy reports, undefined when there is none, or when it is broken or half-extracted.
// Both tools print a semver we can read (`mutagen version` → "0.18.1", `cloudflared --version` → "cloudflared
// version 2026.7.2 (built …)") and both are PINNED above, so this one question decides whether anything needs
// downloading at all. Asking it matters more than the bandwidth it saves: re-extracting over a copy whose
// process is resident cannot succeed on Windows, where a running executable can be neither unlinked nor
// overwritten ("mutagen.exe: Can't unlink already-existing object: Permission denied"), so once the first setup
// had started the daemon, every later command that needed Mutagen, status, pause, a second setup, died there.
const installedVersion = (binary: string, versionArgs: string[]): string | undefined => {
    const result = spawnSync(binary, versionArgs, { encoding: "utf8", windowsHide: true });
    if (result.error !== undefined || result.status !== 0) {
        return undefined;
    }
    return /\d+\.\d+\.\d+/.exec(result.stdout)?.[0];
};

export const download = async (url: string, dest: string): Promise<void> => {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`download failed (${response.status}): ${url}`);
    }
    await mkdir(binDir, { recursive: true });
    await writeFile(dest, new Uint8Array(await response.arrayBuffer()));
};

// Put whatever `write` produces at `binary` in place of what is there now. Windows refuses to unlink or
// overwrite a RUNNING executable, the Mutagen daemon and the cloudflared processes ssh keeps alive each hold
// their own image open, but it does allow RENAMING one, which leaves the live process running from the
// renamed file while the replacement takes its place. (sync.ps1 does exactly this for the agent's own binary.)
// The displaced copy is swept at both ends, so it survives only while something is still executing it.
const replaceBinary = async (binary: string, write: () => Promise<void> | void): Promise<void> => {
    const displaced = `${binary}.old`;
    // Best-effort: a leftover that cannot go yet is still being run, and the write below is what has to succeed.
    await rm(displaced, { force: true }).catch(() => {});
    await rename(binary, displaced).catch(() => {});
    await write();
    await chmod(binary, 0o755);
    await rm(displaced, { force: true }).catch(() => {});
};

// Extract a gzipped tarball into ~/.intentic/sync/bin using the system `tar` (bsdtar on macOS/Windows 10+).
const extractTarball = (tarball: string): void => {
    const extract = spawnSync("tar", ["-xzf", tarball, "-C", binDir], { stdio: "inherit", windowsHide: true });
    if (extract.status !== 0) {
        throw new Error(`failed to extract ${tarball}: tar's own reason is above (no \`tar\` on PATH, or a file it must replace is in use)`);
    }
};

/* THE CLOUDFLARED DOWNLOAD THAT USED TO LIVE HERE is gone with the transport that needed it.
 *
 * Every paired machine downloaded a tunnel client so ssh could reach `ssh-<id>.<zone>` through a ProxyCommand.
 * The SSH endpoint is now a listener this agent runs (tunnel.ts), reached over the sandbox's own HTTPS surface,
 * so there is no second client to install, nothing to keep pinned against the sandbox image, and one less
 * platform matrix to satisfy, cloudflared has no windows-arm64 build, which was a hard refusal on exactly the
 * machines this agent is hardest to test on. */

// Resolve mutagen: the user's own install if they have one (at whatever version they run it at), else our
// pinned copy, downloaded and extracted (binary + agent bundle side by side, as Mutagen requires) only when
// what is in ~/.intentic/sync/bin isn't already the pin.
export const ensureMutagen = async (): Promise<string> => {
    if (installedVersion("mutagen", ["version"]) !== undefined) {
        return "mutagen";
    }
    const dest = join(binDir, `mutagen${exe}`);
    if (installedVersion(dest, ["version"]) === MUTAGEN_VERSION) {
        return dest;
    }
    // Replacing our copy retires the daemon running FROM it, a daemon of another version never serves this
    // CLI anyway, and on Windows it is precisely what holds the file open. Best-effort: usually there is none.
    spawnSync(dest, ["daemon", "stop"], { stdio: "ignore", windowsHide: true });
    const tarball = join(binDir, "mutagen.tar.gz");
    await download(
        `https://github.com/mutagen-io/mutagen/releases/download/v${MUTAGEN_VERSION}/mutagen_${osToken()}_${archToken()}_v${MUTAGEN_VERSION}.tar.gz`,
        tarball,
    );
    await replaceBinary(dest, () => extractTarball(tarball));
    return dest;
};

/* The same command, run WITHOUT blocking this process, what the mirror watcher must use for anything that
 * dials a sandbox (`sync create`, `forward create`). The watcher serves the SSH transport those commands travel
 * on, so a blocking spawn there deadlocks the command against its own route and every one of them fails with a
 * banner timeout, against healthy sandboxes (exec.ts). Mutagen's own output is logged rather than inherited,
 * because the watcher's stdout is a log file shared with the loop's lines.
 *
 * Throws on failure like its blocking twin, so the guard around each step still names the step that failed. */
export const runMutagenAsync = async (mutagen: string, args: readonly string[], log: Log): Promise<void> => {
    const result = await runProcess(mutagen, args);
    const said = `${result.stdout}${result.stderr}`.trim();
    if (result.status === 0) {
        return;
    }
    if (said !== "") {
        log(`  mutagen: ${said.split("\n").join(" / ")}`);
    }
    throw new Error(`mutagen ${args[0] ?? ""} exited with code ${result.status}`);
};

// Run a mutagen subcommand, inheriting stdio; throw on failure so the CLI surfaces it. For the one-shot CLI
// commands only, see runMutagenAsync for why the resident watcher cannot use this.
export const runMutagen = (mutagen: string, args: string[]): SpawnSyncReturns<Buffer> => {
    const result = spawnSync(mutagen, args, { stdio: "inherit", windowsHide: true });
    if (result.error !== undefined) {
        throw result.error;
    }
    if (result.status !== 0) {
        throw new Error(`mutagen ${args[0] ?? ""} exited with code ${result.status}`);
    }
    return result;
};
