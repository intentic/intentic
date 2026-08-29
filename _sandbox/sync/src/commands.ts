import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { cliLauncher, createUi, type Log, type PlanStep, registerAutostart, type Ui, unregisterAutostart } from "@intentic/local-agent";
import { type MachinePort, type MachineReport, sandboxIdFromUrl, watcherStalled } from "@intentic/sandbox-contract";
import { buildCommand, type CommandContext } from "@stricli/core";
import { MIRROR_AUTOSTART } from "./autostart.js";
import { mirrorLogPath, type Pairing, readState, removePairing, type SyncMode, type SyncState, upsertPairing } from "./config.js";
import { realBridgeExec, runGitBridge } from "./git-bridge.js";
import { readLiveWatcherPid, retirePairingMirror, runMirrorWatch, startMirrorWatcher, stopMirror, stopWatcher } from "./mirror.js";
import {
    ensureMutagen,
    ensureSyncSession,
    existingSyncSessions,
    registerMutagenAutostart,
    retireOrphanSessions,
    runMutagen,
    syncSessionNames,
    unregisterMutagenAutostart,
} from "./mutagen.js";
import { machineReport } from "./report.js";
import { syncSshPort, tunnelReady } from "./tunnel.js";
import { assetUrl, realUpgradeExec, runUpgrade, upgradeMessage } from "./upgrade.js";
import { SYNC_VERSION } from "./version.js";
import {
    assertSshConfigVisible,
    ensureSshKey,
    mutagenSshPath,
    pairingSshConfig,
    probeSshTransport,
    removeManagedSshConfig,
    sanitizeId,
    sshAlias,
    writeManagedSshConfig,
} from "./ssh.js";

// Which pairings a command acts on. No selector means every one this machine holds, with a fleet, `--sandbox`
// takes the sandbox id or any substring that matches exactly one of them (real ids are
// `sandbox-<hex>-<zone>`-shaped, so "0738" is how a human names one).
export const selectPairings = (state: SyncState, selector: string | undefined): readonly Pairing[] => {
    if (selector === undefined) {
        return state.pairings;
    }
    const exact = state.pairings.filter((pairing) => pairing.sandboxId === sanitizeId(selector));
    if (exact.length === 1) {
        return exact;
    }
    const matched = state.pairings.filter((pairing) => pairing.sandboxId.includes(selector));
    if (matched.length === 0) {
        throw new Error(
            `no paired sandbox matches "${selector}". This machine pairs: ${state.pairings.map((pairing) => pairing.sandboxId).join(", ") || "none"}`,
        );
    }
    if (matched.length > 1) {
        throw new Error(`"${selector}" matches more than one paired sandbox: ${matched.map((pairing) => pairing.sandboxId).join(", ")}`);
    }
    return matched;
};

// Enroll our SSH public key using the browser-minted pairing token (single-use). The daemon answers with the
// sync token, the credential this agent presents for the port read, its own machine report, and the SSH
// transport it serves on loopback (tunnel.ts). No address comes back: the sandbox is reached at the URL we
// already hold, which is what makes every sandbox sync the same way.
// This fires right after the sandbox's tunnel comes up, so it may still be warming: the edge answers before the
// origin is registered (transient 502/503/504), or the host doesn't resolve yet (fetch throws). Retry through
// that. 401 (pairing expired) and other 4xx are the daemon's own definitive answers, never retried.
// ponytail: fixed ~30s window (10 × 3s); widen only if real tunnel warmups exceed it.
export const enrollKey = async (
    sandboxUrl: string,
    pairToken: string,
    key: string,
    { attempts = 10, delayMs = 3000, takeover = false }: { attempts?: number; delayMs?: number; takeover?: boolean } = {},
): Promise<{ syncToken: string; mode: SyncMode }> => {
    const url = `${sandboxUrl.replace(/\/$/, "")}/system/authorized-key`;
    for (let attempt = 1; ; attempt++) {
        let response: Response;
        try {
            response = await fetch(url, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-intentic-pair": pairToken,
                    ...(takeover ? { "x-intentic-sync-takeover": "1" } : {}),
                },
                body: JSON.stringify({ key }),
            });
        } catch (error) {
            if (attempt >= attempts) {
                throw error;
            }
            process.stderr.write(`enrolling the sync key: sandbox tunnel not reachable yet, retrying (${attempt}/${attempts})…\n`);
            await sleep(delayMs);
            continue;
        }
        if (response.status === 401) {
            throw new Error("pairing expired: click 'Enable desktop sync' again in your browser for a fresh command.");
        }
        if (response.status >= 500 && attempt < attempts) {
            process.stderr.write(`enrolling the sync key: sandbox tunnel warming up (HTTP ${response.status}), retrying (${attempt}/${attempts})…\n`);
            await sleep(delayMs);
            continue;
        }
        // 423 = another machine already holds sync for this sandbox. The daemon won't clobber it without an
        // explicit takeover, so tell the user how to move it here rather than silently kicking the other machine.
        if (response.status === 423) {
            const held = (await response.json().catch(() => ({}))) as { machine?: string };
            const from = held.machine !== undefined ? ` from "${held.machine}"` : "";
            throw new Error(
                `desktop sync is already active on this sandbox${from}. Re-run with --takeover to move it to this machine (this stops syncing on the other one).`,
            );
        }
        if (!response.ok) {
            throw new Error(`enrolling the sync key failed (${response.status}): ${await response.text()}`);
        }
        const body = (await response.json()) as { syncToken?: string; mode?: SyncMode };
        /* The sync token is the whole enrollment now: it authorizes the port read, the machine report AND the
         * SSH transport this agent listens for locally (tunnel.ts). A daemon that answers without one has
         * enrolled the key and handed back nothing to use it with, which is a broken sync rather than a partial
         * one, so it fails here instead of ten minutes later as a Mutagen session that never connects. */
        if (body.syncToken === undefined) {
            throw new Error("the sandbox enrolled this machine but returned no sync credential: update the sandbox and enable sync again.");
        }
        // `mode` is what the daemon GRANTED (per the pairing's role): "sync" = file sync + mirroring, "mirror" =
        // ports only.
        return { syncToken: body.syncToken, mode: body.mode ?? "sync" };
    }
};

// Self-revoke this machine's enrollment (uninstall): DELETE /system/authorized-key authed by the sync token,
// so the sandbox drops just this machine's key + token. Best-effort, the caller ignores failures.
const revokeEnrollment = async (sandboxUrl: string, syncToken: string): Promise<void> => {
    await fetch(`${sandboxUrl.replace(/\/$/, "")}/system/authorized-key`, { method: "DELETE", headers: { "x-intentic-sync": syncToken } });
};

interface SetupFlags {
    readonly url: string;
    readonly pair: string;
    readonly dir?: string;
    readonly sandboxId?: string;
    readonly takeover: boolean;
}

const setup = buildCommand<SetupFlags>({
    docs: { brief: "Enroll an SSH key with a pairing token and start a Mutagen sync of the local dir ↔ sandbox /work" },
    parameters: {
        flags: {
            url: { kind: "parsed", parse: String, brief: "The sandbox's public URL (e.g. https://sandbox-xxx.example.dev)" },
            pair: { kind: "parsed", parse: String, brief: "The one-time pairing token from the Desktop sync card" },
            dir: {
                kind: "parsed",
                parse: String,
                optional: true,
                brief: "Local directory to sync (default: ~/intentic/<sandbox id>, the id in the sandbox's own URL)",
            },
            sandboxId: { kind: "parsed", parse: String, optional: true, brief: "Session/alias id (default: the sandbox URL host)" },
            takeover: { kind: "boolean", brief: "Take over sync from another machine already enrolled on this sandbox (revokes its key)" },
        },
    },
    async func(this: CommandContext, flags: SetupFlags) {
        /* Rendered through the shared renderer (@intentic/local-agent), which is also what `ic` renders
         * through, so this reads as the same program whether it is pasted on its own or run by `ic` in the
         * middle of its install. Three modes and this command cares about none of them: a pipe still gets the
         * historical marker stream, a terminal gets the checklist, and `ic` sets INTENTIC_UI=nested so these
         * lines land as detail under ITS step rather than opening a second banner inside somebody's setup. */
        const ui = createUi(this.process);
        // Every helper below takes a `Log` and narrates through it, routing that at the renderer means the
        // whole command's prose is placed, wrapped and coloured without any of them knowing.
        const out: Log = ui.note;
        ui.begin("intentic · desktop sync", SETUP_PLAN);
        try {
            await runSetup(ui, out, flags);
        } finally {
            // The spinner is an interval; a CLI that leaves one running is a CLI that does not exit.
            ui.close();
        }
    },
});

/* What `setup` is going to do, said before it does it. Phases are this agent's own vocabulary and deliberately
 * NOT in the desktop app's setup plan (setupPlan.ts): a phase that plan does not carry is narration under
 * whichever step is running, which is exactly what sync is when it runs inside `ic sandbox connect`. */
const SETUP_PLAN: readonly PlanStep[] = [
    { phase: "sync-enrolling", label: "Enrol this machine", weight: 25 },
    { phase: "sync-linking", label: "Link the folder", weight: 5 },
    { phase: "sync-starting", label: "Start syncing", weight: 20 },
];

const runSetup = async (ui: Ui, out: Log, flags: SetupFlags): Promise<void> => {
    ui.step("sync-enrolling", "enrolling this machine with your sandbox…");
    const publicKey = await ensureSshKey();
    // Enrollment can retry for ~30s while the sandbox tunnel warms, overlap it with the two binary
    // downloads (independent: distinct endpoints, distinct install paths).
    const [{ syncToken, mode }, mutagen] = await Promise.all([
        enrollKey(flags.url, flags.pair, publicKey, { takeover: flags.takeover }),
        ensureMutagen(),
    ]);
    out(`enrolled SSH key with ${flags.url}`);

    const sandboxId = flags.sandboxId ?? sanitizeId(new URL(flags.url).host);
    const alias = sshAlias(sandboxId);

    // File sync exists only in "sync" mode, a mirror-only enrollment (a collaborator) has no local dir and
    // no sync session, just port forwards. A `~` prefix can reach us verbatim (SYNC_DIR travels as data from
    // the claim payload, no shell expands it), so expand it here where every entry path converges.
    // The default folder is named for the id in the sandbox's own URL (the browser's SYNC_DIR prefixes that
    // with the sandbox's name), never the whole sanitized host, so `~/intentic/<id>` and
    // `https://sandbox-<id>.<zone>` are visibly the same sandbox.
    const localDir =
        mode === "sync"
            ? resolve(
                  flags.dir === undefined
                      ? join(homedir(), "intentic", sandboxIdFromUrl(flags.url) ?? sandboxId)
                      : flags.dir.replace(/^~(?=[\\/]|$)/, homedir()),
              )
            : undefined;
    if (localDir !== undefined) {
        // Create the local root up front, an immediately-visible folder is the user's anchor that setup worked.
        await mkdir(localDir, { recursive: true });
    }

    const pairing: Pairing = {
        sandboxUrl: flags.url,
        sandboxId,
        mode,
        syncToken,
        ...(localDir === undefined ? {} : { localDir }),
    };

    ui.step("sync-linking", "linking the folder to your sandbox…");
    // Stop the resident watcher before touching state or sessions, and ONLY the watcher. It is running the
    // agent binary this very run just replaced, so every fix shipped since the day it started stays inert
    // until it restarts (and `setup` would report "already running (pid …)" as if that were the same thing);
    // on Windows it also holds that binary open. Its forwards stay up throughout. Mutagen's daemon holds
    // them, so no live connection drops, and the pairings it was serving are untouched.
    const stoppedPid = await stopWatcher();
    if (stoppedPid !== undefined) {
        out(`stopped the mirror watcher (pid ${stoppedPid}): it was running the agent binary this run replaced; restarting it below.`);
    }
    // ADD this pairing to whatever this machine already holds. Pairing a second sandbox used to overwrite the
    // first, dropping its ssh alias, its folder and its file-sync session, which is how installing the
    // desktop app beside a CLI-started sandbox silently stopped syncing the folder the user was working in.
    await upsertPairing(pairing);
    const pairings = (await readState()).pairings;

    // The ssh fragment is regenerated from the WHOLE pairing list, so every paired sandbox keeps its alias.
    await writeManagedSshConfig(pairingSshConfig(pairings));

    /* THE TRANSPORT COMES UP BEFORE ANYTHING DIALS IT, and that reorders this command.
     *
     * The sandbox's sshd is reached through a listener on this machine (tunnel.ts) rather than a hostname
     * somebody's fabric resolves, and the process that holds it is the mirror watcher, the resident half of
     * this agent, restarted just above. So mirroring is started HERE, before the probe and before Mutagen,
     * where it used to be the last thing setup did: every step under it now depends on the port being open.
     *
     * The wait is what makes that honest rather than racy, the watcher is a detached process, so the port
     * appears some hundreds of milliseconds after it is asked to start. Not fatal on timeout: Mutagen retries
     * a session forever, and the watcher keeps trying to bind, so a slow start costs a warning rather than a
     * failed setup. */
    ui.step("sync-starting", "starting the sync engine…");
    await enableMirroring(out);
    const port = syncSshPort(sandboxId);
    if (!(await tunnelReady(port, TUNNEL_READY_MS))) {
        out(`note: the sync transport for ${sandboxId} isn't listening on 127.0.0.1:${port} yet, syncing starts as soon as it is.`);
    }

    // Prove the transport before handing it to Mutagen, using the very client Mutagen will pick, on
    // Windows that is not the `ssh` on PATH but the first hit in its own hardcoded list (see ssh.ts).
    const ssh = mutagenSshPath(process.platform, process.env["MUTAGEN_SSH_PATH"]);
    assertSshConfigVisible(ssh, alias, port);
    await probeSshTransport(ssh, alias, out);

    // Start THIS pairing's file sync, or, when re-running setup found the same session already running on
    // this version's rules, leave it exactly as it is rather than paying a full rescan for nothing. Every
    // other pairing's session keeps running; only sessions no pairing claims any more are swept.
    ensureSyncSession(mutagen, pairing, out);
    retireOrphanSessions(mutagen, pairings, out);
    // One bridge pass right away, so a fresh pairing's local repos carry the sandbox's git history from
    // the first minute rather than waiting out the watcher's cadence.
    runGitBridge(realBridgeExec, pairing, out, undefined);
    // Register the Mutagen daemon to autostart at login and resume sessions across reboots, it holds BOTH
    // sync and forward sessions, so this covers mirror-only too. Mutagen's own mechanism everywhere except
    // Windows, where its own is a console command in the Run key and ours is the same command through the
    // launcher stub (mutagen.ts). Best-effort: already-registered isn't worth failing on.
    registerMutagenAutostart(mutagen, cliLauncher("intentic-sync"), out);
    // Say the fleet out loud, BEFORE the ending block. Pairing a sandbox on a machine that already had one
    // is the exact moment the user needs to know the others are still syncing, the silence there is what
    // made a lost pairing take days to notice, and it is detail under this step, not part of the verdict.
    if (pairings.length > 1) {
        ui.note(`This machine now syncs ${pairings.length} sandboxes:`);
        for (const held of pairings) {
            ui.note(`  ${held.sandboxId}${held.localDir === undefined ? " (ports only)" : ` → ${held.localDir}`}`);
        }
    }
    ui.finished(
        mode === "sync" ? "Desktop sync is running." : "Enrolled for port mirroring.",
        // The address a person acts on. For file sync that is the FOLDER, it is the thing they open, and
        // an immediately-visible path is the anchor that setup worked.
        mode === "sync" ? localDir : undefined,
        mode === "sync"
            ? "That folder and your sandbox's /work are now the same files."
            : `Ports from ${flags.url} now answer on this machine's localhost (mirror-only, no file sync).`,
        [
            ["check it", "intentic-sync status"],
            ["its logs", `intentic-sync status --sandbox ${sandboxId}`],
            ["remove it", "intentic-sync uninstall"],
        ],
    );
};

/* How long `setup` waits for the watcher it just started to bind this pairing's port. Bounded by process
 * startup on a busy machine, not by any work the watcher does, it binds before its first poll. */
const TUNNEL_READY_MS = 10_000;

// Turn mirroring on: register it to resume at every login AND run it now. registerAutostart returns true when
// the OS mechanism (macOS launchd) already launched this session's watcher, so we don't spawn a second one.
const enableMirroring = async (log: Log): Promise<void> => {
    const launcher = cliLauncher("intentic-sync");
    const startedNow = await registerAutostart(MIRROR_AUTOSTART, launcher, log);
    if (!startedNow) {
        await startMirrorWatcher(launcher, log);
    }
};

interface MirrorFlags {
    readonly watch: boolean;
    readonly stop: boolean;
}

// Port mirroring driver. `setup` already auto-starts the watcher, so a user rarely runs this; the entry points
// are here for control: bare `mirror` (re)starts the detached watcher, `--watch` runs the loop in the
// foreground (what the detached process runs, also handy to watch live), `--stop` tears it all down.
const mirror = buildCommand<MirrorFlags>({
    docs: { brief: "Manage the background mirror of the sandbox's workspace ports onto localhost (auto-started by setup)" },
    parameters: {
        flags: {
            watch: { kind: "boolean", brief: "Run the mirror watcher in the foreground (normally auto-started detached)" },
            stop: { kind: "boolean", brief: "Stop mirroring and tear down the port forwards" },
        },
    },
    async func(this: CommandContext, flags: MirrorFlags) {
        const out = (message: string): void => void this.process.stdout.write(`${message}\n`);
        if (flags.stop) {
            // Unregister login-autostart first, so mirroring stays stopped across the next reboot too.
            await unregisterAutostart(MIRROR_AUTOSTART, out);
            await stopMirror(out);
            return;
        }
        if (flags.watch) {
            // Timestamp the foreground/detached loop's lines, mirror.log is long-lived, so bare lines are useless.
            await runMirrorWatch((message) => void this.process.stdout.write(`[${new Date().toISOString()}] ${message}\n`));
            return;
        }
        await enableMirroring(out);
    },
});

/* Status leads with the PAIRING LIST, which sandboxes this machine syncs and into which folders, because that
 * is the question a user actually arrives with, and the one this command could not answer before: it read the
 * single pairing and printed Mutagen's view of it, so a folder that had quietly stopped being synced was
 * indistinguishable from one that never existed. Every folder that should be syncing is named here, or it isn't
 * being synced. The watcher's liveness follows, since a healthy session list under a dead watcher means new dev
 * server ports stop appearing on localhost and commits stop arriving in the local clones. */
interface StatusFlags {
    readonly json: boolean;
}

// One port row, in the form the two skip reasons are actually asked about: not "why is 6480 missing" but "who
// has it". A row nothing took reads as plain busy, because that is all this machine can honestly say.
const portLine = (port: MachinePort): string => {
    const what = port.command ?? "unknown process";
    if (port.state === "mirrored") {
        return `  localhost:${port.port} ← ${port.sandboxId} (${what})`;
    }
    const reason = port.heldBy === undefined ? "something else on this machine has the port" : `${port.heldBy} has it`;
    return `  localhost:${port.port}, NOT mirrored from ${port.sandboxId}: ${reason} (${what})`;
};

/* ONE PAIRING'S LINE. Pure, and exported, because every word of it has been wrong at least once and the only way
 * that stops is a test that reads the sentence.
 *
 * The two rules it exists to keep:
 *
 *   A count is printed only when it IS a count. `conflicts` is absent whenever Mutagen has none to report,
 *   protobuf JSON omits an empty list, so a healthy session used to render "[watching, undefined conflict(s)]",
 *   on the one line a user reads to find out whether anything is wrong. Absent means "none reported", never a
 *   number to interpolate.
 *
 *   A missing session is SHOUTED, not blanked. A sync pairing whose session was never created (or was terminated
 *   and could not be recreated) has no status to print, and printing nothing put "this folder is not syncing at
 *   all" and "this folder is fine" one space apart. */
export const pairingLine = (pairing: MachineReport["pairings"][number]): string => {
    const where = pairing.mode === "sync" ? (pairing.localDir ?? "(no folder)") : "(ports only)";
    const state =
        pairing.mode !== "sync"
            ? []
            : [
                  // Mutagen's own word, and the conflict count beside it: a two-way-safe session flags conflicts
                  // rather than clobbering, and nothing else in the product has ever said one was waiting.
                  pairing.paused === true ? "paused" : (pairing.mutagenStatus ?? "NO FILE-SYNC SESSION, this folder is not syncing"),
                  pairing.conflicts === undefined || pairing.conflicts === 0 ? undefined : `${pairing.conflicts} conflict(s)`,
                  /* The backup's own word, and it is SHOUTED when missing for the same reason the line above is:
                   * the whole value of this session is being there on the day the sandbox is not, and a silent
                   * absence reads identically to a healthy one. Named "backup" rather than shown as a bare second
                   * status so the line says which of the two is in trouble. A paused pairing pauses both, so it
                   * is not repeated here. */
                  pairing.paused === true
                      ? undefined
                      : `backup ${pairing.backupStatus ?? "NOT RUNNING, this sandbox's own state is not being copied here"}`,
              ].filter((part) => part !== undefined);
    return `  ${pairing.sandboxId}  ${where}${state.length === 0 ? "" : `  [${state.join(", ")}]`}`;
};

/* THE WATCHER LINE, running, stopped, or the third state that had no words: a live process whose loop is gone.
 *
 * That third one is the failure this whole file keeps meeting from a different angle. The watcher holds its
 * tunnel listeners on the event loop, so anything that escapes the loop leaves a process that is alive, a pidfile
 * that is claimed and a systemd unit that is "active", with mirroring and the git bridge stopped underneath. It
 * has now happened twice, and both times every surface said "running". A pid is not a pulse: the stamp the
 * watcher writes at the end of each completed pass is (config.ts), and this is where the two are read together.
 *
 * `now` is a parameter so the sentence can be tested without a clock. */
export const watcherLine = (watcher: MachineReport["watcher"], now: number): string => {
    if (!watcher.running) {
        return "Mirror watcher: NOT running, file syncing and port mirroring are both stopped. Run `intentic-sync mirror` to restart it.";
    }
    const since = watcher.lastTickAt === undefined ? undefined : now - watcher.lastTickAt;
    if (watcherStalled(watcher, now) && since !== undefined) {
        return `Mirror watcher: STALLED (pid ${watcher.pid}), the process is alive but its last full pass finished ${Math.round(since / 60_000)} minute(s) ago, so port mirroring, the git bridge and any file sync it has not created are stopped. Restart it with \`intentic-sync mirror --stop\` then \`intentic-sync mirror\`, and check ${mirrorLogPath}.`;
    }
    /* An agent too old to stamp reports no lastTickAt at all, and so does one whose first pass has not finished.
     * Neither is a stall, and neither is a clean bill of health, so the line says which of the two it is rather
     * than picking one, the alternative is the same silent green this field was added to end. */
    return since === undefined
        ? `Mirror watcher: running (pid ${watcher.pid}), no completed pass reported yet (a pass finishes within seconds of startup; an agent older than this one never reports them).`
        : `Mirror watcher: running (pid ${watcher.pid}), last pass ${Math.round(since / 1000)}s ago`;
};

const printReport = (report: MachineReport, out: (message: string) => void): void => {
    out(`Paired sandboxes (${report.pairings.length}):`);
    for (const pairing of report.pairings) {
        out(pairingLine(pairing));
    }
    /* The watcher's liveness is now the whole of sync's liveness, not just mirroring's: it holds the SSH
     * transport every session rides (tunnel.ts), so a dead watcher is a stalled file sync and stalled port
     * forwards, not merely "new ports stop appearing". Said plainly, because the previous wording invited a
     * reader to leave it stopped. */
    out(watcherLine(report.watcher, Date.now()));
    out(`Ports (${report.ports.length}):`);
    for (const port of report.ports) {
        out(portLine(port));
    }
};

/* Status leads with the PAIRING LIST, which sandboxes this machine syncs and into which folders, because that
 * is the question a user actually arrives with, and the one this command could not answer before: it read the
 * single pairing and printed Mutagen's view of it, so a folder that had quietly stopped being synced was
 * indistinguishable from one that never existed. Every folder that should be syncing is named here, or it isn't
 * being synced. The watcher's liveness follows, since a healthy session list under a dead watcher means new dev
 * server ports stop appearing on localhost and commits stop arriving in the local clones.
 *
 * `--json` emits the same MachineReport this prints, and is what the desktop app and a `host`-capability read
 * both consume, so the terminal answer and the two on-screen ones cannot drift apart, for the same reason the
 * desktop app spawns connect.sh rather than reimplementing it. Mutagen's own listings still follow the report in
 * the human rendering: they carry live transfer progress, which is detail the report deliberately does not model. */
const status = buildCommand<StatusFlags>({
    docs: { brief: "Show every paired sandbox, the mirror watcher, and Mutagen's own file-sync/forward state" },
    parameters: {
        flags: {
            json: { kind: "boolean", brief: "Emit the machine report as JSON (what the desktop app and the Computers view read)" },
        },
    },
    async func(this: CommandContext, flags: StatusFlags) {
        const out = (message: string): void => void this.process.stdout.write(`${message}\n`);
        const mutagen = await ensureMutagen();
        const report = await machineReport(mutagen);
        if (flags.json) {
            out(JSON.stringify(report));
            return;
        }
        printReport(report, out);
        /* Mutagen's own listing, for the pairings whose session EXISTS, and only those.
         *
         * `mutagen sync list a b` is all-or-nothing: a name it cannot resolve makes it print nothing at all and
         * exit 1, and runMutagen turns that into a throw. So one pairing that had lost its session took the whole
         * command down, no port mirroring section, no exit 0, and an error about a Mutagen "specification" as
         * the only answer to "is my sync working". That is a diagnostic command failing precisely when there is
         * something to diagnose. The missing ones are named here instead; the report above has already said the
         * folder is not syncing. */
        const syncing = report.pairings.filter((pairing) => pairing.mode === "sync");
        if (syncing.length > 0) {
            out("File sync:");
            // Both of a pairing's sessions: the workspace and the state backup that rides beside it. Listing only
            // the first would report a healthy sync while the thing standing between the owner and a lost
            // sandbox was not running at all.
            const wanted = syncing.flatMap((pairing) => syncSessionNames(pairing.sandboxId));
            const live = new Set(existingSyncSessions(mutagen, wanted));
            if (live.size > 0) {
                runMutagen(mutagen, ["sync", "list", ...wanted.filter((name) => live.has(name))]);
            }
            for (const pairing of syncing.filter((held) => !syncSessionNames(held.sandboxId).every((name) => live.has(name)))) {
                out(
                    `  ${pairing.sandboxId}: no file-sync session exists on this machine, ${pairing.localDir ?? "its folder"} is NOT syncing. The mirror watcher retries every few minutes; if it stays this way the sandbox is unreachable (check ${mirrorLogPath}).`,
                );
            }
        }
        out("Port mirroring:");
        runMutagen(mutagen, ["forward", "list"]);
    },
});

// Which sandbox a command acts on, every one this machine pairs unless named. Shared by pause/resume/uninstall.
interface SandboxFlags {
    readonly sandbox?: string;
}

const sandboxFlag = {
    sandbox: {
        kind: "parsed",
        parse: String,
        optional: true,
        brief: "Act on one paired sandbox (its id, or any substring matching exactly one). Default: all of them",
    },
} as const;

// Pause/resume act on file sync, skipped with a note for a mirror-only enrollment (mirroring is controlled by
// `intentic-sync mirror`, not paused).
const fileSyncOnly = (brief: string, verb: "pause" | "resume") =>
    buildCommand<SandboxFlags>({
        docs: { brief },
        parameters: { flags: sandboxFlag },
        async func(this: CommandContext, flags: SandboxFlags) {
            const out = (message: string): void => void this.process.stdout.write(`${message}\n`);
            const selected = selectPairings(await readState(), flags.sandbox);
            if (selected.length === 0) {
                out(`no sandboxes are paired on this machine: nothing to ${verb}. Enable sync from a sandbox's Desktop sync card.`);
                return;
            }
            const syncing = selected.filter((pairing) => pairing.mode === "sync");
            if (syncing.length === 0) {
                out(`mirror-only enrollment${selected.length > 1 ? "s" : ""}, no file sync to ${verb}.`);
                return;
            }
            const mutagen = await ensureMutagen();
            // Pause and resume act on the pair. Leaving the backup running under a deliberate `pause` would keep
            // writing to a folder the owner just asked this agent to stop touching.
            runMutagen(mutagen, ["sync", verb, ...syncing.flatMap((pairing) => syncSessionNames(pairing.sandboxId))]);
            out(`${verb === "pause" ? "Paused" : "Resumed"} file sync for: ${syncing.map((pairing) => pairing.sandboxId).join(", ")}`);
        },
    });

const pause = fileSyncOnly("Pause file syncing", "pause");
const resume = fileSyncOnly("Resume file syncing", "resume");

/* The build this agent is, on stdout, and nothing else on it. Deliberately bare rather than "intentic-sync
 * x.y.z": it is read by a person asking one question, by the release build proving the version stamp reached the
 * binary, and by `upgrade` vetting a freshly downloaded one before it installs it, and the last two want the
 * string, not a sentence around it. */
const version = buildCommand({
    docs: { brief: "Print this agent's version" },
    parameters: {},
    func(this: CommandContext) {
        this.process.stdout.write(`${SYNC_VERSION}\n`);
        return Promise.resolve();
    },
});

// How long to give a just-started watcher to claim its pidfile before calling the upgrade a failure and rolling
// back. It writes the file as its first act, so this is bounded by process startup, not by any work it does.
const WATCHER_START_TIMEOUT_MS = 10_000;
const WATCHER_START_POLL_MS = 200;

const watcherCameUp = async (): Promise<boolean> => {
    for (let waited = 0; waited < WATCHER_START_TIMEOUT_MS; waited += WATCHER_START_POLL_MS) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- a bounded wait on one pidfile, by definition serial
        if ((await readLiveWatcherPid()) !== undefined) {
            return true;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- same
        await sleep(WATCHER_START_POLL_MS);
    }
    return false;
};

/* Move this machine onto the current agent. WITHOUT a pairing token, which is the entire point. Updating and
 * enrolling had been the same command, so the cost of a version bump was a trip to the browser for a single-use
 * token that expires in ten minutes; the predictable result was machines running whatever was current the day
 * they were paired, indefinitely.
 *
 * Pairings, keys, ssh config, Mutagen sessions and mirrored ports are all untouched: this replaces one file and
 * restarts one background process. Everything that can fail is checked before the swap, and the one thing that
 * cannot be checked in advance, whether the new agent stays up on THIS machine, is rolled back automatically
 * (upgrade.ts). */
interface UpgradeFlags {
    readonly force: boolean;
}

const upgrade = buildCommand<UpgradeFlags>({
    docs: { brief: "Download and install the current agent, then restart the background watcher" },
    parameters: {
        flags: {
            force: {
                kind: "boolean",
                brief: "Install the published agent even over one built from source (which is otherwise left alone)",
            },
        },
    },
    async func(this: CommandContext, flags: UpgradeFlags) {
        const out = (message: string): void => void this.process.stdout.write(`${message}\n`);
        const exec = realUpgradeExec(stopWatcher, async () => await enableMirroring(() => undefined), watcherCameUp);
        out(upgradeMessage(await runUpgrade(exec, assetUrl(), SYNC_VERSION, flags.force, out)));
    },
});

/* Uninstall. With `--sandbox` it unpairs ONE sandbox and leaves the agent, and every other pairing, running;
 * bare, it removes the agent from this machine entirely. Either way the pairings it drops are self-revoked on
 * their sandboxes, so a machine walking away cleans up after itself. */
const uninstall = buildCommand<SandboxFlags>({
    docs: { brief: "Unpair a sandbox (--sandbox), or remove the sync agent and every pairing from this machine" },
    parameters: { flags: sandboxFlag },
    async func(this: CommandContext, flags: SandboxFlags) {
        const out = (message: string): void => void this.process.stdout.write(`${message}\n`);
        const state = await readState();
        const dropped = selectPairings(state, flags.sandbox);
        const mutagen = await ensureMutagen();
        const remaining = state.pairings.filter((held) => !dropped.some((pairing) => pairing.sandboxId === held.sandboxId));

        // Self-revoke each dropped enrollment so its sandbox drops the key + token (a collaborator leaving cleans
        // up after itself, without touching anyone else's mirror). Best-effort, an unreachable sandbox shouldn't
        // block local teardown.
        for (const pairing of dropped) {
            if (pairing.syncToken !== undefined) {
                // oxlint-disable-next-line eslint/no-await-in-loop -- one HTTP call per sandbox being dropped, sequenced so a failure names its own
                await revokeEnrollment(pairing.sandboxUrl, pairing.syncToken).catch(() => {});
            }
            if (pairing.mode === "sync") {
                // The pair goes together. A surviving backup session would keep mirroring a sandbox this machine
                // has just unpaired, writing into a folder the owner considers released.
                spawnSync(mutagen, ["sync", "terminate", ...syncSessionNames(pairing.sandboxId)], { stdio: "ignore", windowsHide: true });
            }
            // oxlint-disable-next-line eslint/no-await-in-loop -- state is a single file; serial keeps the writes ordered
            await retirePairingMirror(mutagen, pairing.sandboxId);
            // oxlint-disable-next-line eslint/no-await-in-loop -- ditto
            await removePairing(pairing.sandboxId);
            out(`unpaired ${pairing.sandboxId}${pairing.localDir === undefined ? "" : ` (${pairing.localDir} is no longer synced)`}.`);
        }

        if (remaining.length > 0) {
            // The agent stays: regenerate the ssh fragment for the pairings that are still live, restart the
            // watcher so it stops serving what just went, and leave Mutagen's daemon alone.
            await writeManagedSshConfig(pairingSshConfig(remaining));
            await stopWatcher();
            await startMirrorWatcher(cliLauncher("intentic-sync"), out);
            out(`Still syncing ${remaining.length} sandbox(es): ${remaining.map((pairing) => pairing.sandboxId).join(", ")}`);
            return;
        }

        // Nothing left to serve, remove the agent's own residency: login-autostart, watcher, forwards, transport.
        await unregisterAutostart(MIRROR_AUTOSTART, out);
        await stopMirror(out);
        await removeManagedSshConfig();
        // Our downloaded Mutagen copy exists only for this agent, so retire its daemon completely, the login
        // registration and the resident process both. A system-installed `mutagen` on PATH may hold the user's
        // own sessions: leave its daemon alone and say so instead.
        const ownCopy = mutagen !== "mutagen";
        if (ownCopy) {
            unregisterMutagenAutostart(mutagen);
            spawnSync(mutagen, ["daemon", "stop"], { stdio: "ignore", windowsHide: true });
        }
        this.process.stdout.write(
            ownCopy
                ? "Sync terminated; ssh-config include removed; Mutagen daemon stopped and unregistered. Nothing intentic stays resident on this machine.\n"
                : "Sync terminated; ssh-config include removed. (Your own Mutagen install is untouched, `mutagen daemon unregister` if you no longer want its daemon at login.)\n",
        );
    },
});

export const commands = { setup, mirror, status, version, upgrade, pause, resume, uninstall };
