import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { buildCommand, type CommandContext } from "@stricli/core";
import { sandboxIdFromUrl } from "@intentic/sandbox-contract";
import { registerAutostart, unregisterAutostart } from "./autostart.js";
import { knownHostsPath, type Log, readConfig, type SyncConfig, type SyncMode, sshKeyPath, writeConfig } from "./config.js";
import { realBridgeExec, runGitBridge } from "./git-bridge.js";
import { type CliLauncher, runMirrorWatch, startMirrorWatcher, stopMirror } from "./mirror.js";
import { ensureCloudflared, ensureMutagen, ensureSyncSession, runMutagen, sessionName } from "./mutagen.js";
import { ensureSshKey, INCLUDE_MARKER, sanitizeId, sshAlias, sshConfigBlock, writeManagedSshConfig } from "./ssh.js";

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
        await writeManagedSshConfig(
            sshConfigBlock({
                alias: sshAlias(sandboxId),
                hostname: sshHostname,
                identityFile: sshKeyPath,
                knownHostsFile: knownHostsPath,
                cloudflaredPath,
            }),
        );

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

        const config: SyncConfig = {
            sandboxUrl: flags.url,
            sandboxId,
            sshHostname,
            mode,
            ...(localDir === undefined ? {} : { localDir }),
            ...(syncToken === undefined ? {} : { syncToken }),
        };
        await writeConfig(config);

        // Start the file sync — or, when re-running setup found the same session already running on this
        // version's rules, leave it exactly as it is rather than paying a full rescan for nothing.
        ensureSyncSession(mutagen, config, out);
        // One bridge pass right away, so a fresh pairing's local repos carry the sandbox's git history from
        // the first minute rather than waiting out the watcher's cadence.
        runGitBridge(realBridgeExec, config, out);
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

        // Auto-start port mirroring so the user never types a command: the sandbox's dev servers become
        // localhost:<same-port> here, new ones appear as they start, and it resumes after a reboot. Needs the
        // enrollment sync token; a daemon that predates mirroring simply skips this (file sync still works).
        if (syncToken !== undefined) {
            await enableMirroring(out);
        }
    },
});

// Bun's compiled-binary virtual filesystem. `bun build --compile` reports process.argv[1] as a path INSIDE the
// executable ("/$bunfs/root/<name>" on posix, a "~BUN" path on Windows) — matched on the distinctive marker
// rather than an exact prefix, since only the marker is stable across bun versions and platforms.
const isBunVirtualEntry = (entry: string): boolean => entry.includes("$bunfs") || entry.includes("~BUN");

// How to re-launch this CLI: the executable, plus any leading argument that must precede the command. Re-exec'd
// (with `mirror --watch`) to spawn the detached watcher, and written verbatim into the OS autostart entries.
//
// `node dist/cli.js` needs the script path, so its launcher is [node, cli.js]. A compiled binary — what the
// install script actually ships — IS the CLI, and its runtime re-injects that virtual argv[1] on every launch.
// Passing the entry explicitly therefore pushed it to argv[2], which is where stricli starts reading the command
// name: every detached watcher died on the spot with "No command registered for `/$bunfs/root/intentic-sync-
// linux-amd64`", and the autostart entry was persisted with the same broken argv, so port mirroring never ran on
// a released build at all (`status` reported "No forwarding sessions found" with nothing else to go on).
export const cliLauncher = (): CliLauncher => {
    const entry = process.argv[1];
    if (entry === undefined) {
        throw new Error("cannot locate the intentic-sync entry to start the mirror watcher");
    }
    return isBunVirtualEntry(entry) ? [process.execPath] : [process.execPath, entry];
};

// Turn mirroring on: register it to resume at every login AND run it now. registerAutostart returns true when
// the OS mechanism (macOS launchd) already launched this session's watcher, so we don't spawn a second one.
const enableMirroring = async (log: Log): Promise<void> => {
    const launcher = cliLauncher();
    const startedNow = await registerAutostart(launcher, log);
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
            await unregisterAutostart(out);
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

const status = buildCommand<Record<string, never>>({
    docs: { brief: "Show file-sync and port-mirror status" },
    parameters: { flags: {} },
    async func(this: CommandContext) {
        const out = (message: string): void => void this.process.stdout.write(`${message}\n`);
        const config = await readConfig();
        const mutagen = await ensureMutagen();
        if (config.mode === "sync") {
            out("File sync:");
            runMutagen(mutagen, ["sync", "list", sessionName(config.sandboxId)]);
        }
        out("Port mirroring:");
        runMutagen(mutagen, ["forward", "list"]);
    },
});

// Pause/resume act on file sync — a no-op with a note for a mirror-only enrollment (mirroring is controlled by
// `intentic-sync mirror`, not paused).
const fileSyncOnly = (brief: string, verb: "pause" | "resume") =>
    buildCommand<Record<string, never>>({
        docs: { brief },
        parameters: { flags: {} },
        async func(this: CommandContext) {
            const config = await readConfig();
            if (config.mode !== "sync") {
                this.process.stdout.write(`mirror-only enrollment — no file sync to ${verb}.\n`);
                return;
            }
            runMutagen(await ensureMutagen(), ["sync", verb, sessionName(config.sandboxId)]);
        },
    });

const pause = fileSyncOnly("Pause file syncing", "pause");
const resume = fileSyncOnly("Resume file syncing", "resume");

const uninstall = buildCommand<Record<string, never>>({
    docs: { brief: "Terminate the sync session and remove the managed ssh-config include" },
    parameters: { flags: {} },
    async func(this: CommandContext) {
        // Stop mirroring first: unregister login-autostart, kill the watcher, and tear down its port forwards
        // before the SSH transport goes.
        const out = (message: string): void => void this.process.stdout.write(`${message}\n`);
        await unregisterAutostart(out);
        await stopMirror(out);
        const config = await readConfig();
        const mutagen = await ensureMutagen();
        if (config.mode === "sync") {
            spawnSync(mutagen, ["sync", "terminate", sessionName(config.sandboxId)], { stdio: "ignore" });
        }
        // Self-revoke this machine's enrollment so the sandbox drops its key + token (a collaborator leaving
        // cleans up after itself, without touching anyone else's mirror). Best-effort — an unreachable sandbox
        // shouldn't block local teardown.
        if (config.syncToken !== undefined) {
            await revokeEnrollment(config.sandboxUrl, config.syncToken).catch(() => {});
        }
        const userConfig = join(homedir(), ".ssh", "config");
        const current = await readFile(userConfig, "utf8").catch(() => "");
        const stripped = current
            .split("\n")
            .filter((line) => line.trim() !== INCLUDE_MARKER)
            .join("\n");
        if (stripped !== current) {
            await writeFile(userConfig, stripped, { mode: 0o600 });
        }
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

export const commands = { setup, mirror, status, pause, resume, uninstall };
