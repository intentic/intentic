import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createUi, type Log, type PlanStep, type Ui } from "@intentic/local-agent";
import { sandboxIdFromUrl } from "@intentic/sandbox-contract";
import { buildCommand, buildRouteMap, type CommandContext } from "@stricli/core";
import { resolveDaemonBase } from "../daemon-base.js";
import { prepareSetup } from "../install.js";
import { machineLauncher, readResidentPid, reconcileResidency } from "../resident.js";
import { type Pairing, readState, removePairing, setMirrorOff, type SyncMode, type SyncState, upsertPairing } from "./config.js";
import { realBridgeExec, runGitBridge } from "./git-bridge.js";
import { retirePairingMirror, teardownAllForwards } from "./mirror.js";
import {
    ensureMutagen,
    ensureSyncSession,
    registerMutagenAutostart,
    retireOrphanSessions,
    runMutagen,
    syncSessionNames,
    unregisterMutagenAutostart,
} from "./mutagen.js";
import { syncSshPort, tunnelReady } from "./tunnel.js";
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

// Which pairings a command acts on. No selector means every one this machine holds; `--sandbox` takes the
// sandbox id or any substring matching exactly one (real ids are `sandbox-<hex>-<zone>`-shaped).
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

// Enroll our SSH public key using the browser-minted pairing token (single-use); the daemon answers with the
// sync token, its own machine report, and the SSH transport it serves on loopback (tunnel.ts). This fires right
// after the sandbox's tunnel comes up, so it may still be warming (transient 502/503/504, or DNS not resolved
// yet): retried, but 401 and other 4xx are the daemon's own definitive answers and are never retried.
export const enrollKey = async (
    sandboxUrl: string,
    pairToken: string,
    key: string,
    { attempts = 10, delayMs = 3000, takeover = false }: { attempts?: number; delayMs?: number; takeover?: boolean } = {},
): Promise<{ syncToken: string; mode: SyncMode }> => {
    for (let attempt = 1; ; attempt++) {
        // Enrolled wherever the daemon answers, resolved per attempt for the reason the device half's enroll states
        // (device/commands.ts): a sandbox on this machine with its tunnel down must not fail the one call that pairs
        // it.
        const { base } = await resolveDaemonBase(sandboxUrl);
        const url = `${base}/system/authorized-key`;
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
        // 423 = another machine already holds sync for this sandbox. The daemon won't clobber it without an explicit
        // takeover.
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
        // The sync token is the whole enrollment now: it authorizes the port read, the machine report AND the SSH
        // transport. A daemon that answers without one fails here instead of ten minutes later as a session that never
        // connects.
        if (body.syncToken === undefined) {
            throw new Error("the sandbox enrolled this machine but returned no sync credential: update the sandbox and enable sync again.");
        }
        // `mode` is what the daemon granted (per the pairing's role): "sync" = file sync + mirroring (single holder),
        // "mirror" = ports only (unlimited collaborators).
        return { syncToken: body.syncToken, mode: body.mode ?? "sync" };
    }
};

// Self-revoke this machine's enrollment (uninstall): DELETE /system/authorized-key authed by the sync token.
// Best-effort, the caller ignores failures.
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
        // Self-update, PATH, the Windows launcher run first (install.ts), in plain lines before the renderer opens: on
        // an actual update this process re-execs the new agent with the same argv, and a UI opened here would be a
        // second banner there.
        await prepareSetup((message) => void this.process.stdout.write(`${message}\n`), process.argv.slice(2));
        // Rendered through the shared renderer (@intentic/local-agent), also what `ic` renders through: `ic` sets
        // INTENTIC_UI=nested so these lines land as detail under its own step rather than a second banner.
        const ui = createUi(this.process);
        // Every helper below takes a `Log` and narrates through it, so the whole command's prose is placed, wrapped
        // and coloured without any of them knowing.
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

// What `setup` is going to do, said before it does it. Phases are this agent's own vocabulary, deliberately not
// in the desktop app's setup plan: a phase that plan doesn't carry is narration under whichever step is running.
const SETUP_PLAN: readonly PlanStep[] = [
    { phase: "sync-enrolling", label: "Enrol this machine", weight: 25 },
    { phase: "sync-linking", label: "Link the folder", weight: 5 },
    { phase: "sync-starting", label: "Start syncing", weight: 20 },
];

const runSetup = async (ui: Ui, out: Log, flags: SetupFlags): Promise<void> => {
    ui.step("sync-enrolling", "enrolling this machine with your sandbox…");
    const publicKey = await ensureSshKey();
    // Enrollment can retry for ~30s while the sandbox tunnel warms; overlapped with the two binary downloads
    // (independent: distinct endpoints, distinct install paths).
    const [{ syncToken, mode }, mutagen] = await Promise.all([
        enrollKey(flags.url, flags.pair, publicKey, { takeover: flags.takeover }),
        ensureMutagen(),
    ]);
    out(`enrolled SSH key with ${flags.url}`);

    const sandboxId = flags.sandboxId ?? sanitizeId(new URL(flags.url).host);
    const alias = sshAlias(sandboxId);

    // File sync exists only in "sync" mode; a mirror-only enrollment has no local dir, just port forwards. A `~`
    // prefix can reach us verbatim (SYNC_DIR travels as data, no shell expands it). The default folder is named for
    // the id in the sandbox's own URL, never the whole sanitized host, so the folder and the URL are visibly the
    // same sandbox.
    const localDir =
        mode === "sync"
            ? resolve(
                  flags.dir === undefined
                      ? join(homedir(), "intentic", sandboxIdFromUrl(flags.url) ?? sandboxId)
                      : flags.dir.replace(/^~(?=[\\/]|$)/, homedir()),
              )
            : undefined;
    if (localDir !== undefined) {
        // Create the local root up front: an immediately-visible folder is the user's anchor that setup worked.
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
    // ADD this pairing to whatever this machine already holds: pairing a second sandbox used to overwrite the
    // first, dropping its ssh alias, folder and file-sync session.
    await upsertPairing(pairing);
    const pairings = (await readState()).pairings;

    // The ssh fragment is regenerated from the whole pairing list, so every paired sandbox keeps its alias.
    await writeManagedSshConfig(pairingSshConfig(pairings));

    // The transport comes up before anything dials it: the sandbox's sshd is reached through a listener the
    // resident loop holds (tunnel.ts), so the loop is (re)started here, before the probe and before Mutagen, and
    // the restart also retires a loop still running the binary this run just replaced. Not fatal on timeout:
    // Mutagen retries a session forever and the loop keeps trying to bind.
    ui.step("sync-starting", "starting the sync engine…");
    await reconcileResidency(out);
    const port = syncSshPort(sandboxId);
    if (!(await tunnelReady(port, TUNNEL_READY_MS))) {
        out(`note: the sync transport for ${sandboxId} isn't listening on 127.0.0.1:${port} yet, syncing starts as soon as it is.`);
    }

    // Prove the transport before handing it to Mutagen, using the very client Mutagen will pick: on Windows that
    // is not the `ssh` on PATH but the first hit in its own hardcoded list (see ssh.ts).
    const ssh = mutagenSshPath(process.platform, process.env["MUTAGEN_SSH_PATH"]);
    assertSshConfigVisible(ssh, alias, port);
    await probeSshTransport(ssh, alias, out);

    // Start THIS pairing's file sync, or leave an already-running session exactly as it is rather than pay a full
    // rescan for nothing. Every other pairing's session keeps running; only sessions no pairing claims are swept.
    ensureSyncSession(mutagen, pairing, out);
    retireOrphanSessions(mutagen, pairings, out);
    // One bridge pass right away, so a fresh pairing's local repos carry the sandbox's git history from the first
    // minute rather than waiting out the watcher's cadence.
    runGitBridge(realBridgeExec, pairing, out, undefined);
    // Register the Mutagen daemon to autostart and resume sessions across reboots; it holds both sync and forward
    // sessions, so this covers mirror-only too. Best-effort: already-registered isn't worth failing on.
    registerMutagenAutostart(mutagen, machineLauncher(), out);
    // Say the fleet out loud, before the ending block: pairing a sandbox on a machine that already had one is the
    // exact moment the user needs to know the others are still syncing.
    if (pairings.length > 1) {
        ui.note(`This machine now syncs ${pairings.length} sandboxes:`);
        for (const held of pairings) {
            ui.note(`  ${held.sandboxId}${held.localDir === undefined ? " (ports only)" : ` → ${held.localDir}`}`);
        }
    }
    ui.finished(
        mode === "sync" ? "Desktop sync is running." : "Enrolled for port mirroring.",
        // The address a person acts on. For file sync that is the folder, the thing they open, and an
        // immediately-visible
        // path is the anchor that setup worked.
        mode === "sync" ? localDir : undefined,
        mode === "sync"
            ? "That folder and your sandbox's /work are now the same files."
            : `Ports from ${flags.url} now answer on this machine's localhost (mirror-only, no file sync).`,
        [
            ["check it", "intentic-machine status"],
            ["remove it", "intentic-machine sync uninstall"],
        ],
    );
};

// How long `setup` waits for the watcher it just started to bind this pairing's port. Bounded by process
// startup, not by any work the watcher does.
const TUNNEL_READY_MS = 10_000;

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

// Pause/resume act on file sync, skipped with a note for a mirror-only enrollment (mirroring rides the
// resident loop, not a Mutagen pause).
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
            // Pause and resume act on the pair: leaving the backup running under a deliberate `pause` would keep
            // writing
            // to a folder the owner just asked this agent to stop touching.
            runMutagen(mutagen, ["sync", verb, ...syncing.flatMap((pairing) => syncSessionNames(pairing.sandboxId))]);
            out(`${verb === "pause" ? "Paused" : "Resumed"} file sync for: ${syncing.map((pairing) => pairing.sandboxId).join(", ")}`);
        },
    });

const pause = fileSyncOnly("Pause file syncing", "pause");
const resume = fileSyncOnly("Resume file syncing", "resume");

// Port mirroring, on or off, the twin of pause/resume for the other half of what this agent does. Mirroring is
// the half that changes THIS device: stopping it used to mean unpairing the sandbox entirely or revoking every
// machine's enrollment. Bare, it acts on every sandbox this machine pairs; `--sandbox` takes one. The state is
// local and durable (config.ts setMirrorOff), so it holds through a reboot and while the sandbox is unreachable.
const mirrorSwitch = (brief: string, off: boolean) =>
    buildCommand<SandboxFlags>({
        docs: { brief },
        parameters: { flags: sandboxFlag },
        async func(this: CommandContext, flags: SandboxFlags) {
            const out = (message: string): void => void this.process.stdout.write(`${message}\n`);
            const selected = selectPairings(await readState(), flags.sandbox);
            if (selected.length === 0) {
                out("no sandboxes are paired on this machine: nothing to mirror. Enable it from a sandbox's Desktop sync card.");
                return;
            }
            const mutagen = await ensureMutagen();
            for (const pairing of selected) {
                // oxlint-disable-next-line eslint/no-await-in-loop -- state is a single file; serial keeps the writes ordered
                await setMirrorOff(pairing.sandboxId, off);
                // OFF takes effect now, not on the watcher's next pass: somebody who just asked for their localhost
                // back should
                // have it before they can alt-tab. Turning it back ON is left to the watcher, since creating a forward
                // dials
                // the sandbox over the transport that loop holds.
                if (off) {
                    // oxlint-disable-next-line eslint/no-await-in-loop -- one pairing's teardown at a time, as everywhere else here
                    await retirePairingMirror(mutagen, pairing.sandboxId);
                }
            }
            const named = selected.map((pairing) => pairing.sandboxId).join(", ");
            if (off) {
                out(`Port mirroring OFF for: ${named}. Those ports are off this device's localhost. File syncing is untouched.`);
                return;
            }
            out(`Port mirroring on for: ${named}. Their ports return to localhost within a few seconds.`);
            // The watcher is what puts them back, so a stopped agent turns this command into a promise nothing keeps.
            if ((await readResidentPid()) === undefined) {
                out("Note: this machine's agent is NOT running, so nothing will mirror until you start it: `intentic-machine run`.");
            }
        },
    });

const mirror = buildRouteMap({
    routes: {
        off: mirrorSwitch("Stop putting a sandbox's ports on this device's localhost (file syncing continues)", true),
        on: mirrorSwitch("Put a sandbox's ports back on this device's localhost", false),
    },
    docs: { brief: "Turn this device's port mirroring off or on, for one paired sandbox or all of them" },
});

// The sync half's teardown, callable from the top-level `uninstall` too. With a selector it unpairs ONE
// sandbox and leaves every other pairing served; bare, it removes everything, self-revoking each dropped
// enrollment so a machine walking away cleans up after itself.
export const syncUninstall = async (out: Log, sandbox?: string): Promise<void> => {
    const state = await readState();
    const dropped = selectPairings(state, sandbox);
    const mutagen = await ensureMutagen();
    const remaining = state.pairings.filter((held) => !dropped.some((pairing) => pairing.sandboxId === held.sandboxId));

    // Self-revoke each dropped enrollment so its sandbox drops the key + token. Best-effort, an unreachable sandbox
    // shouldn't block local teardown.
    for (const pairing of dropped) {
        if (pairing.syncToken !== undefined) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- one HTTP call per sandbox being dropped, sequenced so a failure names its own
            await revokeEnrollment(pairing.sandboxUrl, pairing.syncToken).catch(() => {});
        }
        if (pairing.mode === "sync") {
            // The pair goes together: a surviving backup session would keep mirroring a sandbox this machine has just
            // unpaired, writing into a folder the owner considers released.
            spawnSync(mutagen, ["sync", "terminate", ...syncSessionNames(pairing.sandboxId)], { stdio: "ignore", windowsHide: true });
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- state is a single file; serial keeps the writes ordered
        await retirePairingMirror(mutagen, pairing.sandboxId);
        // oxlint-disable-next-line eslint/no-await-in-loop -- ditto
        await removePairing(pairing.sandboxId);
        out(`unpaired ${pairing.sandboxId}${pairing.localDir === undefined ? "" : ` (${pairing.localDir} is no longer synced)`}.`);
    }

    if (remaining.length > 0) {
        // Sync stays: regenerate the ssh fragment for pairings still live, and restart the resident loop so it stops
        // serving what just went. Mutagen's daemon is left alone.
        await writeManagedSshConfig(pairingSshConfig(remaining));
        await reconcileResidency(out);
        out(`Still syncing ${remaining.length} sandbox(es): ${remaining.map((pairing) => pairing.sandboxId).join(", ")}`);
        return;
    }

    // Nothing left to sync: sync's residue goes (forwards, transport, ssh include); reconcileResidency retires the
    // resident loop with the login entry only when this machine holds nothing at all.
    await reconcileResidency(out);
    await teardownAllForwards(mutagen, out);
    await removeManagedSshConfig();
    // Our downloaded Mutagen copy exists only for this agent, so retire its daemon completely. A system-installed
    // `mutagen` on PATH may hold the user's own sessions: leave its daemon alone and say so instead.
    const ownCopy = mutagen !== "mutagen";
    if (ownCopy) {
        unregisterMutagenAutostart(mutagen);
        spawnSync(mutagen, ["daemon", "stop"], { stdio: "ignore", windowsHide: true });
    }
    out(
        ownCopy
            ? "Sync terminated; ssh-config include removed; Mutagen daemon stopped and unregistered."
            : "Sync terminated; ssh-config include removed. (Your own Mutagen install is untouched, `mutagen daemon unregister` if you no longer want its daemon at login.)",
    );
};

const uninstall = buildCommand<SandboxFlags>({
    docs: { brief: "Unpair a sandbox (--sandbox), or stop syncing every sandbox on this machine" },
    parameters: { flags: sandboxFlag },
    async func(this: CommandContext, flags: SandboxFlags) {
        const out = (message: string): void => void this.process.stdout.write(`${message}\n`);
        await syncUninstall(out, flags.sandbox);
    },
});

export const syncCommands = { setup, pause, resume, mirror, uninstall };
