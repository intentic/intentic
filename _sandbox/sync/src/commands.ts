import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { cliLauncher, type Log, registerAutostart, unregisterAutostart } from "@intentic/local-agent";
import { type MachinePort, type MachineReport, sandboxIdFromUrl } from "@intentic/sandbox-contract";
import { buildCommand, type CommandContext } from "@stricli/core";
import { MIRROR_AUTOSTART } from "./autostart.js";
import { type Pairing, readState, removePairing, type SyncMode, type SyncState, upsertPairing } from "./config.js";
import { realBridgeExec, runGitBridge } from "./git-bridge.js";
import { readLiveWatcherPid, retirePairingMirror, runMirrorWatch, startMirrorWatcher, stopMirror, stopWatcher } from "./mirror.js";
import { ensureCloudflared, ensureMutagen, ensureSyncSession, retireOrphanSessions, runMutagen, sessionName } from "./mutagen.js";
import { machineReport } from "./report.js";
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

// Which pairings a command acts on. No selector means every one this machine holds — with a fleet, `--sandbox`
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

// Enroll our SSH public key using the browser-minted pairing token (single-use). The daemon returns the tunnel's
// SSH hostname + the sync token `mirror` reads /ports with — the only HTTP surface the agent ever touches;
// everything else is Mutagen over SSH.
// This fires right after connect.sh starts the sandbox's cloudflared sidecar, so the public tunnel may still be
// warming up: Cloudflare's edge answers before the origin is registered (transient 502/503/504), or the host
// doesn't resolve yet (fetch throws). Retry through that. 401 (pairing expired) and other 4xx are the daemon's
// own definitive answers — never retried.
// ponytail: fixed ~30s window (10 × 3s); widen only if real tunnel warmups exceed it.
export const enrollKey = async (
    sandboxUrl: string,
    pairToken: string,
    key: string,
    { attempts = 10, delayMs = 3000, takeover = false }: { attempts?: number; delayMs?: number; takeover?: boolean } = {},
): Promise<{ sshHostname: string; syncToken?: string; mode: SyncMode }> => {
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
            if (attempt >= attempts) throw error;
            process.stderr.write(`enrolling the sync key — sandbox tunnel not reachable yet, retrying (${attempt}/${attempts})…\n`);
            await sleep(delayMs);
            continue;
        }
        if (response.status === 401) {
            throw new Error("pairing expired — click “Enable desktop sync” again in your browser for a fresh command.");
        }
        if (response.status >= 500 && attempt < attempts) {
            process.stderr.write(
                `enrolling the sync key — sandbox tunnel warming up (HTTP ${response.status}), retrying (${attempt}/${attempts})…\n`,
            );
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
        const body = (await response.json()) as { sshHostname?: string; syncToken?: string; mode?: SyncMode };
        if (body.sshHostname === undefined) {
            throw new Error("this sandbox has no SSH tunnel configured for sync — reconnect it so its tunnel routes ssh-<id>.<zone>.");
        }
        // `mode` is what the daemon GRANTED (per the pairing's role): "sync" = file sync + mirroring, "mirror" =
        // ports only. A daemon predating modes omits it → treat as "sync" (its historical behavior). syncToken
        // stays optional: a daemon predating port mirroring still syncs files fine.
        return { sshHostname: body.sshHostname, mode: body.mode ?? "sync", ...(body.syncToken === undefined ? {} : { syncToken: body.syncToken }) };
    }
};

// Self-revoke this machine's enrollment (uninstall): DELETE /system/authorized-key authed by the sync token,
// so the sandbox drops just this machine's key + token. Best-effort — the caller ignores failures.
export const revokeEnrollment = async (sandboxUrl: string, syncToken: string): Promise<void> => {
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
        const out = (message: string): void => void this.process.stdout.write(`${message}\n`);
        const publicKey = await ensureSshKey();
        // Enrollment can retry for ~30s while the sandbox tunnel warms — overlap it with the two binary
        // downloads (independent: distinct endpoints, distinct install paths).
        const [{ sshHostname, syncToken, mode }, cloudflaredPath, mutagen] = await Promise.all([
            enrollKey(flags.url, flags.pair, publicKey, { takeover: flags.takeover }),
            ensureCloudflared(),
            ensureMutagen(),
        ]);
        out(`enrolled SSH key; sandbox reachable at ${sshHostname}`);

        const sandboxId = flags.sandboxId ?? sanitizeId(new URL(flags.url).host);
        const alias = sshAlias(sandboxId);

        // File sync exists only in "sync" mode — a mirror-only enrollment (a collaborator) has no local dir and
        // no sync session, just port forwards. A `~` prefix can reach us verbatim (SYNC_DIR travels as data from
        // the claim payload — no shell expands it), so expand it here where every entry path converges.
        // The default folder is named for the id in the sandbox's own URL (the browser's SYNC_DIR prefixes that
        // with the sandbox's name), never the whole sanitized host — so `~/intentic/<id>` and
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
            // Create the local root up front — an immediately-visible folder is the user's anchor that setup worked.
            await mkdir(localDir, { recursive: true });
        }

        const pairing: Pairing = {
            sandboxUrl: flags.url,
            sandboxId,
            sshHostname,
            mode,
            ...(localDir === undefined ? {} : { localDir }),
            ...(syncToken === undefined ? {} : { syncToken }),
        };

        // Stop the resident watcher before touching state or sessions — and ONLY the watcher. It is running the
        // agent binary this very run just replaced, so every fix shipped since the day it started stays inert
        // until it restarts (and `setup` would report "already running (pid …)" as if that were the same thing);
        // on Windows it also holds that binary open. Its forwards stay up throughout — Mutagen's daemon holds
        // them, so no live connection drops, and the pairings it was serving are untouched.
        const stoppedPid = await stopWatcher();
        if (stoppedPid !== undefined) {
            out(`stopped the mirror watcher (pid ${stoppedPid}) — it was running the agent binary this run replaced; restarting it below.`);
        }
        // ADD this pairing to whatever this machine already holds. Pairing a second sandbox used to overwrite the
        // first — dropping its ssh alias, its folder and its file-sync session — which is how installing the
        // desktop app beside a CLI-started sandbox silently stopped syncing the folder the user was working in.
        await upsertPairing(pairing);
        const pairings = (await readState()).pairings;

        // The ssh fragment is regenerated from the WHOLE pairing list, so every paired sandbox keeps its alias.
        await writeManagedSshConfig(pairingSshConfig(pairings, cloudflaredPath));
        // Prove the transport before handing it to Mutagen, using the very client Mutagen will pick — on
        // Windows that is not the `ssh` on PATH but the first hit in its own hardcoded list (see ssh.ts).
        const ssh = mutagenSshPath(process.platform, process.env["MUTAGEN_SSH_PATH"]);
        assertSshConfigVisible(ssh, alias, sshHostname);
        probeSshTransport(ssh, alias, out);

        // Start THIS pairing's file sync — or, when re-running setup found the same session already running on
        // this version's rules, leave it exactly as it is rather than paying a full rescan for nothing. Every
        // other pairing's session keeps running; only sessions no pairing claims any more are swept.
        ensureSyncSession(mutagen, pairing, out);
        retireOrphanSessions(mutagen, pairings, out);
        // One bridge pass right away, so a fresh pairing's local repos carry the sandbox's git history from
        // the first minute rather than waiting out the watcher's cadence.
        runGitBridge(realBridgeExec, pairing, out, undefined);
        // Register the Mutagen daemon to autostart at login and resume sessions across reboots — it holds BOTH
        // sync and forward sessions, so this covers mirror-only too. Its own native mechanism (launchd/Task
        // Scheduler); no register verb on Linux. Best-effort: already-registered isn't worth failing on.
        if (process.platform !== "linux") {
            try {
                runMutagen(mutagen, ["daemon", "register"]);
            } catch (error) {
                out(
                    `note: could not register the Mutagen daemon for autostart (${error instanceof Error ? error.message : String(error)}); it still runs while you're logged in.`,
                );
            }
        }
        out(
            mode === "sync"
                ? `Sync started: ${localDir} ↔ ${sshHostname}:/work. Check it with \`intentic-sync status\`.`
                : `Enrolled for port mirroring on ${sshHostname} (mirror-only — no file sync). Check it with \`intentic-sync status\`.`,
        );
        // Say the fleet out loud. Pairing a sandbox on a machine that already had one is the exact moment the
        // user needs to know the others are still syncing — the silence there is what made a lost pairing take
        // days to notice.
        if (pairings.length > 1) {
            out(`This machine now syncs ${pairings.length} sandboxes:`);
            for (const held of pairings) {
                out(`  ${held.sandboxId}${held.localDir === undefined ? " (ports only)" : ` → ${held.localDir}`}`);
            }
        }

        // Auto-start port mirroring so the user never types a command: each sandbox's dev servers become
        // localhost:<same-port> here, new ones appear as they start, and it resumes after a reboot.
        //
        // Gated on ANY pairing having a sync token, not just this one: the watcher stopped above was serving the
        // whole fleet, so declining to restart it because THIS enrollment happens to lack a token (a daemon
        // predating port mirroring) would leave every sibling's mirroring dead until the next login.
        if (pairings.some((held) => held.syncToken !== undefined)) {
            await enableMirroring(out);
        }
    },
});

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
            // Timestamp the foreground/detached loop's lines — mirror.log is long-lived, so bare lines are useless.
            await runMirrorWatch((message) => void this.process.stdout.write(`[${new Date().toISOString()}] ${message}\n`));
            return;
        }
        await enableMirroring(out);
    },
});

/* Status leads with the PAIRING LIST — which sandboxes this machine syncs and into which folders — because that
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
    return `  localhost:${port.port} — NOT mirrored from ${port.sandboxId}: ${reason} (${what})`;
};

const printReport = (report: MachineReport, out: (message: string) => void): void => {
    out(`Paired sandboxes (${report.pairings.length}):`);
    for (const pairing of report.pairings) {
        const where = pairing.mode === "sync" ? (pairing.localDir ?? "(no folder)") : "(ports only)";
        // Mutagen's own word, and the conflict count beside it: a two-way-safe session flags conflicts rather
        // than clobbering, and nothing else in the product has ever said one was waiting.
        const state = [
            pairing.paused === true ? "paused" : pairing.mutagenStatus,
            pairing.conflicts === 0 ? undefined : `${pairing.conflicts} conflict(s)`,
        ]
            .filter((part) => part !== undefined)
            .join(", ");
        out(`  ${pairing.sandboxId}  ${where}${state === "" ? "" : `  [${state}]`}`);
    }
    out(
        report.watcher.running
            ? `Mirror watcher: running (pid ${report.watcher.pid})`
            : "Mirror watcher: NOT running — run `intentic-sync mirror` to restart it.",
    );
    out(`Ports (${report.ports.length}):`);
    for (const port of report.ports) {
        out(portLine(port));
    }
};

/* Status leads with the PAIRING LIST — which sandboxes this machine syncs and into which folders — because that
 * is the question a user actually arrives with, and the one this command could not answer before: it read the
 * single pairing and printed Mutagen's view of it, so a folder that had quietly stopped being synced was
 * indistinguishable from one that never existed. Every folder that should be syncing is named here, or it isn't
 * being synced. The watcher's liveness follows, since a healthy session list under a dead watcher means new dev
 * server ports stop appearing on localhost and commits stop arriving in the local clones.
 *
 * `--json` emits the same MachineReport this prints, and is what the desktop app and a `host`-capability read
 * both consume — so the terminal answer and the two on-screen ones cannot drift apart, for the same reason the
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
        const syncing = report.pairings.filter((pairing) => pairing.mode === "sync");
        if (syncing.length > 0) {
            out("File sync:");
            runMutagen(mutagen, ["sync", "list", ...syncing.map((pairing) => sessionName(pairing.sandboxId))]);
        }
        out("Port mirroring:");
        runMutagen(mutagen, ["forward", "list"]);
    },
});

// Which sandbox a command acts on — every one this machine pairs unless named. Shared by pause/resume/uninstall.
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

// Pause/resume act on file sync — skipped with a note for a mirror-only enrollment (mirroring is controlled by
// `intentic-sync mirror`, not paused).
const fileSyncOnly = (brief: string, verb: "pause" | "resume") =>
    buildCommand<SandboxFlags>({
        docs: { brief },
        parameters: { flags: sandboxFlag },
        async func(this: CommandContext, flags: SandboxFlags) {
            const out = (message: string): void => void this.process.stdout.write(`${message}\n`);
            const selected = selectPairings(await readState(), flags.sandbox);
            if (selected.length === 0) {
                out(`no sandboxes are paired on this machine — nothing to ${verb}. Enable sync from a sandbox's Desktop sync card.`);
                return;
            }
            const syncing = selected.filter((pairing) => pairing.mode === "sync");
            if (syncing.length === 0) {
                out(`mirror-only enrollment${selected.length > 1 ? "s" : ""} — no file sync to ${verb}.`);
                return;
            }
            const mutagen = await ensureMutagen();
            runMutagen(mutagen, ["sync", verb, ...syncing.map((pairing) => sessionName(pairing.sandboxId))]);
            out(`${verb === "pause" ? "Paused" : "Resumed"} file sync for: ${syncing.map((pairing) => pairing.sandboxId).join(", ")}`);
        },
    });

const pause = fileSyncOnly("Pause file syncing", "pause");
const resume = fileSyncOnly("Resume file syncing", "resume");

/* The build this agent is, on stdout, and nothing else on it. Deliberately bare rather than "intentic-sync
 * x.y.z": it is read by a person asking one question, by the release build proving the version stamp reached the
 * binary, and by `upgrade` vetting a freshly downloaded one before it installs it — and the last two want the
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

/* Move this machine onto the current agent — WITHOUT a pairing token, which is the entire point. Updating and
 * enrolling had been the same command, so the cost of a version bump was a trip to the browser for a single-use
 * token that expires in ten minutes; the predictable result was machines running whatever was current the day
 * they were paired, indefinitely.
 *
 * Pairings, keys, ssh config, Mutagen sessions and mirrored ports are all untouched: this replaces one file and
 * restarts one background process. Everything that can fail is checked before the swap, and the one thing that
 * cannot be checked in advance — whether the new agent stays up on THIS machine — is rolled back automatically
 * (upgrade.ts). */
const upgrade = buildCommand({
    docs: { brief: "Download and install the current agent, then restart the background watcher" },
    parameters: {},
    async func(this: CommandContext) {
        const out = (message: string): void => void this.process.stdout.write(`${message}\n`);
        const exec = realUpgradeExec(stopWatcher, async () => await enableMirroring(() => undefined), watcherCameUp);
        out(upgradeMessage(await runUpgrade(exec, assetUrl(), SYNC_VERSION, out)));
    },
});

/* Uninstall. With `--sandbox` it unpairs ONE sandbox and leaves the agent — and every other pairing — running;
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
        // up after itself, without touching anyone else's mirror). Best-effort — an unreachable sandbox shouldn't
        // block local teardown.
        for (const pairing of dropped) {
            if (pairing.syncToken !== undefined) {
                // oxlint-disable-next-line eslint/no-await-in-loop -- one HTTP call per sandbox being dropped, sequenced so a failure names its own
                await revokeEnrollment(pairing.sandboxUrl, pairing.syncToken).catch(() => {});
            }
            if (pairing.mode === "sync") {
                spawnSync(mutagen, ["sync", "terminate", sessionName(pairing.sandboxId)], { stdio: "ignore" });
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
            await writeManagedSshConfig(pairingSshConfig(remaining, await ensureCloudflared()));
            await stopWatcher();
            await startMirrorWatcher(cliLauncher("intentic-sync"), out);
            out(`Still syncing ${remaining.length} sandbox(es): ${remaining.map((pairing) => pairing.sandboxId).join(", ")}`);
            return;
        }

        // Nothing left to serve — remove the agent's own residency: login-autostart, watcher, forwards, transport.
        await unregisterAutostart(MIRROR_AUTOSTART, out);
        await stopMirror(out);
        await removeManagedSshConfig();
        // Our downloaded Mutagen copy exists only for this agent, so retire its daemon completely — the login
        // registration and the resident process both. A system-installed `mutagen` on PATH may hold the user's
        // own sessions: leave its daemon alone and say so instead.
        const ownCopy = mutagen !== "mutagen";
        if (ownCopy) {
            if (process.platform !== "linux") {
                spawnSync(mutagen, ["daemon", "unregister"], { stdio: "ignore" });
            }
            spawnSync(mutagen, ["daemon", "stop"], { stdio: "ignore" });
        }
        this.process.stdout.write(
            ownCopy
                ? "Sync terminated; ssh-config include removed; Mutagen daemon stopped and unregistered. Nothing intentic stays resident on this machine.\n"
                : "Sync terminated; ssh-config include removed. (Your own Mutagen install is untouched — `mutagen daemon unregister` if you no longer want its daemon at login.)\n",
        );
    },
});

export const commands = { setup, mirror, status, version, upgrade, pause, resume, uninstall };
