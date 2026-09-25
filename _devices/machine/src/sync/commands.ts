import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import { plural } from "@intentic/base/format";
import { createUi, homeDir, type Log, type PlanStep, type Ui } from "@intentic/local-agent";
import { environmentKeyOf, sandboxIdFromUrl } from "@intentic/sandbox-contract";
import { buildCommand, buildRouteMap, type CommandContext, type FlagParametersForType } from "@stricli/core";
import { postWhileWarming } from "../daemon-base.js";
import { completeSetup, prepareSetup } from "../install.js";
import { machineId } from "../machine-id.js";
import { wslEnvironment } from "../wsl.js";
import { ensureResident, readResidentPid } from "../resident.js";
import { machineLauncher } from "../supervision.js";
import {
    type Pairing,
    readState,
    removePairing,
    setAutoHealOff,
    setMirrorOff,
    setPortIgnored,
    type SyncMode,
    type SyncState,
    upsertPairing,
} from "./config.js";
import { realBridgeExec, runGitBridge } from "./git-bridge.js";
import { retireMirroredPort, retirePairingMirror, teardownAllForwards } from "./mirror.js";
import {
    ensureMutagen,
    ensureSyncSession,
    existingSyncSessions,
    healDerivedConflicts,
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

// Enrolls this machine's SSH key with the single-use pairing token; a 423 or any other 4xx is the daemon's final answer.
export const enrollKey = async (
    sandboxUrl: string,
    pairToken: string,
    key: string,
    {
        attempts,
        delayMs,
        takeover = false,
        identity,
    }: {
        attempts?: number;
        delayMs?: number;
        takeover?: boolean;
        // Which computer and which OS install on it is enrolling, so the sandbox joins this enrollment to the same
        // machine's card; an older sandbox ignores both.
        identity?: { readonly machineId: string; readonly environment: string };
    } = {},
): Promise<{ syncToken: string; mode: SyncMode }> => {
    const response = await postWhileWarming(
        sandboxUrl,
        "/system/authorized-key",
        {
            headers: {
                "content-type": "application/json",
                "x-intentic-pair": pairToken,
                ...(takeover ? { "x-intentic-sync-takeover": "1" } : {}),
            },
            body: JSON.stringify({ key, ...identity }),
        },
        {
            doing: "enrolling the sync key",
            expired: "pairing expired: click 'Enable desktop sync' again in your browser for a fresh command.",
            attempts,
            delayMs,
        },
    );
    // Another machine holds sync for this sandbox, and the daemon moves it only on an explicit takeover.
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
    // The sync token authorizes the port read, the machine report and the SSH transport: without one, fail here, not as a dead session.
    if (body.syncToken === undefined) {
        throw new Error("the sandbox enrolled this machine but returned no sync credential: update the sandbox and enable sync again.");
    }
    // What the daemon granted: "sync" is file sync plus mirroring (one holder), "mirror" is ports only (any number).
    return { syncToken: body.syncToken, mode: body.mode ?? "sync" };
};

// Self-revoke this machine's enrollment (uninstall): DELETE /system/authorized-key authed by the sync token. A 404 is
// an enrollment the sandbox no longer holds; any other refusal leaves this machine's key authorized there.
const revokeEnrollment = async (sandboxUrl: string, syncToken: string): Promise<void> => {
    const response = await fetch(`${sandboxUrl.replace(/\/$/, "")}/system/authorized-key`, {
        method: "DELETE",
        headers: { "x-intentic-sync": syncToken },
    });
    if (!response.ok && response.status !== 404) {
        throw new Error(`HTTP ${response.status}`);
    }
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
        enrollKey(flags.url, flags.pair, publicKey, {
            takeover: flags.takeover,
            identity: { machineId: machineId(), environment: environmentKeyOf({ wsl: await wslEnvironment() }) },
        }),
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
                      ? join(homeDir(), "intentic", sandboxIdFromUrl(flags.url) ?? sandboxId)
                      : flags.dir.replace(/^~(?=[\\/]|$)/, homeDir()),
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

    // The transport is a listener the resident agent holds (tunnel.ts), bound on its next pass; not fatal on timeout.
    ui.step("sync-starting", "starting the sync engine…");
    await ensureResident(out);
    await completeSetup(out);
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

// The sessions a pause/resume can actually name, and which pairings that covers. `mutagen sync pause a b` is
// all-or-nothing: one unresolved name fails the call for every other pairing in it, so a pairing whose sandbox was
// unreachable when its session was due to be created used to take the whole command down with Mutagen's own
// "did not match any sessions". Pure and exported so that rule is checkable without a Mutagen daemon.
export const syncSwitchPlan = (
    syncing: readonly Pairing[],
    held: readonly string[],
): { readonly names: readonly string[]; readonly acted: readonly Pairing[]; readonly idle: readonly Pairing[] } => {
    const running = new Set(held);
    const covered = (pairing: Pairing): string[] => syncSessionNames(pairing.sandboxId).filter((name) => running.has(name));
    const acted = syncing.filter((pairing) => covered(pairing).length > 0);
    return { names: acted.flatMap(covered), acted, idle: syncing.filter((pairing) => covered(pairing).length === 0) };
};

const named = (pairings: readonly Pairing[]): string => pairings.map((pairing) => pairing.sandboxId).join(", ");

// A command over the pairings `--sandbox` selects; `none` is what it says when that selects nothing.
const pairingCommand = <F extends SandboxFlags>(
    brief: string,
    flags: FlagParametersForType<F>,
    none: string,
    act: (selected: readonly Pairing[], flags: F, out: Log) => Promise<void>,
) =>
    buildCommand<F>({
        docs: { brief },
        parameters: { flags },
        async func(this: CommandContext, given: F) {
            const out = (message: string): void => void this.process.stdout.write(`${message}\n`);
            const selected = selectPairings(await readState(), given.sandbox);
            if (selected.length === 0) {
                out(none);
                return;
            }
            await act(selected, given, out);
        },
    });

const NONE_TO_MIRROR = "no sandboxes are paired on this machine: nothing to mirror. Enable it from a sandbox's Desktop sync card.";

// The watcher is what gives mirrored ports back, so a stopped agent turns that into a promise nothing keeps.
const noteIfStopped = async (out: Log): Promise<void> => {
    if ((await readResidentPid()) === undefined) {
        out("Note: this machine's agent is NOT running, so nothing will mirror until you start it: `intentic-machine run`.");
    }
};

// Pause/resume act on file sync only: mirroring rides the resident agent, not a Mutagen pause.
const fileSyncSwitch = (brief: string, verb: "pause" | "resume") =>
    pairingCommand<SandboxFlags>(
        brief,
        sandboxFlag,
        `no sandboxes are paired on this machine: nothing to ${verb}. Enable sync from a sandbox's Desktop sync card.`,
        async (selected, _flags, out) => {
            const syncing = selected.filter((pairing) => pairing.mode === "sync");
            if (syncing.length === 0) {
                out(`mirror-only enrollment${selected.length > 1 ? "s" : ""}, no file sync to ${verb}.`);
                return;
            }
            const mutagen = await ensureMutagen();
            // Both sessions of the pair, and only names the daemon holds: one it can't resolve fails the whole call.
            const plan = syncSwitchPlan(
                syncing,
                existingSyncSessions(
                    mutagen,
                    syncing.flatMap((pairing) => syncSessionNames(pairing.sandboxId)),
                ),
            );
            if (plan.names.length === 0) {
                // Not a failure: a sandbox that has never answered has no session yet, and the agent creates one when it does.
                out(`No file-sync session is running for: ${named(syncing)}. Nothing to ${verb}; syncing starts when the sandbox answers again.`);
                return;
            }
            runMutagen(mutagen, ["sync", verb, ...plan.names]);
            out(`${verb === "pause" ? "Paused" : "Resumed"} file sync for: ${named(plan.acted)}`);
            if (plan.idle.length > 0) {
                out(`No file-sync session to ${verb} for: ${named(plan.idle)}.`);
            }
        },
    );

// Port mirroring on or off, durable and local (config.ts setMirrorOff), so it holds through a reboot and an unreachable sandbox.
const mirrorSwitch = (brief: string, off: boolean) =>
    pairingCommand<SandboxFlags>(brief, sandboxFlag, NONE_TO_MIRROR, async (selected, _flags, out) => {
        const mutagen = await ensureMutagen();
        for (const pairing of selected) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- state is a single file; serial keeps the writes ordered
            await setMirrorOff(pairing.sandboxId, off);
            // OFF takes effect now, ON is the watcher's: creating a forward dials over the transport that agent holds.
            if (off) {
                // oxlint-disable-next-line eslint/no-await-in-loop -- one pairing's teardown at a time, as everywhere else here
                await retirePairingMirror(mutagen, pairing.sandboxId);
            }
        }
        if (off) {
            out(`Port mirroring OFF for: ${named(selected)}. Those ports are off this device's localhost. File syncing is untouched.`);
            return;
        }
        out(`Port mirroring on for: ${named(selected)}. Their ports return to localhost within a few seconds.`);
        await noteIfStopped(out);
    });

// The one numeric flag this CLI takes. Parsed strictly rather than through a bare Number(): a NaN reaching the
// session name below would terminate a forward nothing holds and then report that it worked.
const parsePort = (value: string): number => {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error(`"${value}" is not a port number (1-65535).`);
    }
    return port;
};

interface MirrorPortFlags extends SandboxFlags {
    readonly port: number;
}

// One port left off THIS machine's localhost, where something of its own holds it; every other machine keeps mirroring it.
const mirrorPortSwitch = (brief: string, ignored: boolean) =>
    pairingCommand<MirrorPortFlags>(
        brief,
        { ...sandboxFlag, port: { kind: "parsed", parse: parsePort, brief: "The port number, as the sandbox serves it" } },
        NONE_TO_MIRROR,
        async (selected, flags, out) => {
            const mutagen = await ensureMutagen();
            let taken = 0;
            for (const pairing of selected) {
                // oxlint-disable-next-line eslint/no-await-in-loop -- state is a single file; serial keeps the writes ordered
                await setPortIgnored(pairing.sandboxId, flags.port, ignored);
                if (ignored) {
                    // oxlint-disable-next-line eslint/no-await-in-loop -- one pairing's teardown at a time, as everywhere else here
                    taken += (await retireMirroredPort(mutagen, pairing.sandboxId, flags.port)) ? 1 : 0;
                }
            }
            if (ignored) {
                out(
                    `Port ${flags.port} will not be mirrored for: ${named(selected)}.${taken === 0 ? "" : ` Took localhost:${flags.port} off this device.`} Every other port is untouched.`,
                );
                return;
            }
            out(
                `Port ${flags.port} will be mirrored again for: ${named(selected)}. It returns to localhost within a few seconds, unless something else on this machine is holding it.`,
            );
            await noteIfStopped(out);
        },
    );

const mirror = buildRouteMap({
    routes: {
        off: mirrorSwitch("Stop putting a sandbox's ports on this device's localhost (file syncing continues)", true),
        on: mirrorSwitch("Put a sandbox's ports back on this device's localhost", false),
        ignore: mirrorPortSwitch("Leave ONE port off this device's localhost, mirroring every other port as usual", true),
        unignore: mirrorPortSwitch("Mirror a port this device was told to leave alone", false),
    },
    docs: { brief: "Turn this device's port mirroring off or on, for a whole sandbox or for one port of it" },
});

// CLEARING BUILD OUTPUT IS NOT RESOLVING A CONFLICT, and this command is careful to be only the first. When the sandbox
// deletes a directory this device still has `node_modules` in, Mutagen holds the deletion rather than destroying
// content it never carried — so the pairing stops converging over something nobody wrote and nothing needs. This
// removes exactly that, per pairing, and leaves every conflict with two real copies standing for a person. It is what
// the Devices tab's button runs, and what the watcher already does on its own unless `autoheal off` says not to.
const clean = buildCommand<SandboxFlags>({
    docs: { brief: "Clear build output this device left in directories the sandbox deleted, so those deletions can land" },
    parameters: { flags: sandboxFlag },
    async func(this: CommandContext, flags: SandboxFlags) {
        const out = (message: string): void => void this.process.stdout.write(`${message}\n`);
        const syncing = selectPairings(await readState(), flags.sandbox).filter((pairing) => pairing.mode === "sync");
        if (syncing.length === 0) {
            out("no file-syncing sandbox is paired on this machine: there is no folder here to clear anything from.");
            return;
        }
        const mutagen = await ensureMutagen();
        let removed = 0;
        let standing = 0;
        for (const pairing of syncing) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- one pairing at a time, so a log line names one sandbox
            const outcome = await healDerivedConflicts(mutagen, pairing, out, true);
            removed += outcome.removed.length;
            standing += outcome.standing;
        }
        out(
            removed === 0
                ? "Nothing to clear: no directory the sandbox deleted is being held open by build output on this device."
                : `Cleared ${removed} director${removed === 1 ? "y" : "ies"}. The deletions they were holding back land within a few seconds.`,
        );
        if (standing > 0) {
            // Said plainly rather than folded into the number above: these are the ones this command must not touch.
            // Not called "real disagreements" — most are, but the count also holds anything that failed the check on
            // disk, and overstating what it knows is how a reader learns to distrust the rest.
            out(
                `${plural(standing, "conflict")} still standing, and not this command's to settle: two copies somebody wrote is a choice only a person makes. \`intentic-machine status\` lists the paths.`,
            );
        }
    },
});

// Whether the watcher clears build output by itself, durable and per pairing; `clean` is not gated by it.
const autoHealSwitch = (brief: string, off: boolean) =>
    pairingCommand<SandboxFlags>(brief, sandboxFlag, "no sandboxes are paired on this machine: nothing to switch.", async (selected, _flags, out) => {
        for (const pairing of selected) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- state is a single file; serial keeps the writes ordered
            await setAutoHealOff(pairing.sandboxId, off);
        }
        out(
            off
                ? `Clearing derived residue is OFF for: ${named(selected)}. A deletion the sandbox makes will now stop syncing whenever this device has build output inside it; \`intentic-machine sync clean\` clears one by hand.`
                : `Clearing derived residue is on for: ${named(selected)}.`,
        );
    });

const autoheal = buildRouteMap({
    routes: {
        off: autoHealSwitch("Stop clearing build output that blocks the sandbox's deletions from landing here", true),
        on: autoHealSwitch("Clear build output that blocks the sandbox's deletions from landing here", false),
    },
    docs: { brief: "Whether this device clears its own build output when it blocks a deletion, for one sandbox or all" },
});

// The sync half's teardown, callable from the top-level `uninstall` too. With a selector it unpairs ONE
// sandbox and leaves every other pairing served; bare, it removes everything, self-revoking each dropped
// enrollment so a machine walking away cleans up after itself.
export const syncUninstall = async (out: Log, sandbox?: string): Promise<void> => {
    const state = await readState();
    const dropped = selectPairings(state, sandbox);
    const mutagen = await ensureMutagen();
    const remaining = state.pairings.filter((held) => !dropped.some((pairing) => pairing.sandboxId === held.sandboxId));

    // Self-revoke each dropped enrollment so its sandbox drops the key + token. An unreachable sandbox doesn't block
    // local teardown, but the owner is told the key is still authorized there.
    for (const pairing of dropped) {
        if (pairing.syncToken !== undefined) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- Drops are sequenced so failures identify one sandbox.
            await revokeEnrollment(pairing.sandboxUrl, pairing.syncToken).catch((error: unknown) =>
                out(
                    `note: ${pairing.sandboxUrl} could not be told to forget this machine (${errorMessage(error)}), so its sync key is still authorized there. Remove this machine from that sandbox's Devices view.`,
                ),
            );
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
        // Sync stays: regenerate the ssh fragment for pairings still live. The agent is left running — it re-reads its
        // pairing list every tick (mirror.ts), and restarting it would drop this machine's socket to every linked
        // sandbox, which is the connection an unpair asked for from a sandbox travels over. Mutagen's daemon is left
        // alone too.
        await writeManagedSshConfig(pairingSshConfig(remaining));
        await ensureResident(out);
        out(`Still syncing ${plural(remaining.length, "sandbox")}: ${remaining.map((pairing) => pairing.sandboxId).join(", ")}`);
        return;
    }

    // Nothing left to sync: sync's residue goes (forwards, transport, ssh include); the agent retires only when this
    // environment holds nothing at all.
    await ensureResident(out);
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

const pause = fileSyncSwitch("Pause file syncing", "pause");
const resume = fileSyncSwitch("Resume file syncing", "resume");

export const syncCommands = { setup, pause, resume, mirror, clean, autoheal, uninstall };
