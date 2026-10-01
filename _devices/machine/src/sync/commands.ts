import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { errorMessage } from "@intentic/base/errors";
import { plural } from "@intentic/base/format";
import { WORKSPACE_ROOT } from "@intentic/constants";
import { createUi, homeDir, type Log, type PlanStep, type Ui } from "@intentic/local-agent";
import { environmentKeyOf, projectDirNameOf, sandboxIdFromUrl, type SyncEnrollmentRequest, SyncEnrollmentAnswerSchema } from "@intentic/sandbox-contract";
import { buildCommand, buildRouteMap, type CommandContext, type FlagParametersForType } from "@stricli/core";
import { z } from "zod";
import { postWhileWarming } from "../daemon-base.js";
import { completeSetup, prepareSetup } from "../install.js";
import { machineId } from "../machine-id.js";
import { wslEnvironment } from "../wsl.js";
import { ensureResident, readResidentBuild, readResidentPid } from "../resident.js";
import { MACHINE_VERSION } from "../version.js";
import { machineLauncher } from "../supervision.js";
import {
    isProjectPairing,
    type Pairing,
    pairingRemoteDir,
    projectDirection,
    readState,
    removePairing,
    setAutoHealOff,
    setMirrorOff,
    setPortIgnored,
    type SyncMode,
    type SyncState,
    type SyncTransport,
    upsertPairing,
} from "./config.js";
import { localSandboxContainer } from "./endpoint.js";
import { overlappingPairing } from "./folders.js";
import { realBridgeExec, runGitBridge } from "./git-bridge.js";
import { retireMirroredPort, retirePairingMirror, teardownAllForwards } from "./mirror.js";
import { projectCommands } from "./project-commands.js";
import {
    ensureMutagen,
    existingSyncSessions,
    healDerivedConflicts,
    isOwnMutagen,
    registerMutagenAutostart,
    retireOrphanSessions,
    runMutagen,
    sessionName,
    syncSessionNames,
    unregisterMutagenAutostart,
} from "./mutagen.js";
import { syncSshPort, tunnelReady } from "./tunnel.js";
import {
    assertSshConfigVisible,
    ensureSshKey,
    hostKeyOf,
    mutagenSshPath,
    pairingSshConfig,
    probeSshTransport,
    removeManagedSshConfig,
    replaceKnownHost,
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
): Promise<{ syncToken: string; mode: SyncMode; hostKey: string | undefined }> => {
    const response = await postWhileWarming(
        sandboxUrl,
        "/system/authorized-key",
        {
            headers: {
                "content-type": "application/json",
                "x-intentic-pair": pairToken,
                ...(takeover ? { "x-intentic-sync-takeover": "1" } : {}),
            },
            body: JSON.stringify({ key, ...identity } satisfies SyncEnrollmentRequest),
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
    const answer = SyncEnrollmentAnswerSchema.safeParse(await response.json());
    if (!answer.success) {
        throw new Error(`the sandbox enrolled this machine but its answer could not be read: ${z.prettifyError(answer.error)}`);
    }
    const body = answer.data;
    // The sync token authorizes the port read, the machine report and the SSH transport: without one, fail here, not as a dead session.
    if (body.syncToken === undefined) {
        throw new Error("the sandbox enrolled this machine but returned no sync credential: update the sandbox and enable sync again.");
    }
    // What the daemon granted: "sync" is file sync plus mirroring (one holder), "mirror" is ports only (any number). The
    // sshd host key, when a sandbox hands it over, is what this machine pins for it (ssh.ts, replaceKnownHost).
    return { syncToken: body.syncToken, mode: body.mode ?? "sync", hostKey: hostKeyOf(body.hostKey) };
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
    readonly remoteDir?: string;
    readonly project: boolean;
    readonly transport?: TransportAsk;
}

// What `--transport` may ask for: a transport by name, or `auto`, the default, which lets transportFor decide.
type TransportAsk = "auto" | SyncTransport;

const parseTransport = (value: string): TransportAsk => {
    if (value !== "auto" && value !== "ssh" && value !== "docker") {
        throw new Error(`"${value}" is not a transport: auto (the default), ssh or docker.`);
    }
    return value;
};

// HOW A NEW PAIRING REACHES ITS SANDBOX (endpoint.ts). A project folder whose sandbox container runs on this machine's
// own Docker engine is reached through Docker, with nothing on ssh, the tunnel or a public address on the data path;
// every other pairing over ssh, as before. `--transport` overrides the choice, and docker asked for where it cannot work
// is refused before the pairing token is spent. Stored as absent for ssh, the shape every earlier pairing has.
export const transportFor = async (
    asked: TransportAsk,
    placement: Pick<Pairing, "project">,
    sandboxUrl: string,
    locate: (sandboxUrl: string) => Promise<string | undefined> = localSandboxContainer,
): Promise<Pick<Pairing, "transport" | "container">> => {
    if (asked === "ssh") {
        return {};
    }
    if (!isProjectPairing(placement)) {
        if (asked === "docker") {
            throw new Error("--transport docker is for a project folder (--project): a workspace pairing's git bridge and state backup ride ssh.");
        }
        return {};
    }
    const container = await locate(sandboxUrl);
    if (container === undefined) {
        if (asked === "docker") {
            throw new Error(`--transport docker needs this sandbox's container running on this machine's Docker engine, and none here serves ${sandboxUrl}.`);
        }
        return {};
    }
    return { transport: "docker", container };
};

// `--remote-dir`, held to the two shapes a pairing may take (config.ts pairingProblem) before anything is enrolled.
const parseRemoteDir = (value: string): string => {
    if (value !== WORKSPACE_ROOT && projectDirNameOf(value) === undefined) {
        throw new Error(
            `"${value}" is neither ${WORKSPACE_ROOT} nor ${WORKSPACE_ROOT}/<name> (a name starting with a letter or digit, of letters, digits, ".", "_" and "-", and not one the sandbox keeps for itself).`,
        );
    }
    return value;
};

// Where the folder syncs to, from the two flags that say so, refused when they disagree: a project is one folder under
// /work and nothing else is. /work itself is stored as nothing, the shape every pairing made before this had.
export const placementOf = (flags: Pick<SetupFlags, "remoteDir" | "project">): Pick<Pairing, "remoteDir" | "project"> => {
    const remoteDir = flags.remoteDir === WORKSPACE_ROOT ? undefined : flags.remoteDir;
    if (flags.project && remoteDir === undefined) {
        throw new Error(
            `--project needs --remote-dir ${WORKSPACE_ROOT}/<name>: a project folder syncs into a folder of its own, never into ${WORKSPACE_ROOT} itself.`,
        );
    }
    if (!flags.project && remoteDir !== undefined) {
        throw new Error(
            `--remote-dir ${remoteDir} is a project folder, so pass --project as well: it is what keeps the sandbox's state backup and git history out of the folder.`,
        );
    }
    return flags.project ? { remoteDir, project: true } : {};
};

// The folder this setup will sync, before enrollment decides whether it syncs any: a `~` prefix can reach us verbatim
// (SYNC_DIR travels as data, no shell expands it), and the default is named for the id in the sandbox's own URL, never
// the whole sanitized host, so the folder and the URL are visibly the same sandbox.
const wantedFolder = (flags: Pick<SetupFlags, "dir" | "url">, sandboxId: string): string =>
    resolve(
        flags.dir === undefined
            ? join(homeDir(), "intentic", sandboxIdFromUrl(flags.url) ?? sandboxId)
            : flags.dir.replace(/^~(?=[\\/]|$)/, homeDir()),
    );

const setup = buildCommand<SetupFlags>({
    docs: {
        brief: "Enroll this machine with a pairing token and start a Mutagen sync of the local dir ↔ sandbox /work (or a project folder in it), over ssh or, for a project on this machine's Docker engine, through Docker",
    },
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
            remoteDir: {
                kind: "parsed",
                parse: parseRemoteDir,
                optional: true,
                brief: "Sandbox folder to sync with: /work (the default) or /work/<name>, a project folder (needs --project)",
            },
            project: {
                kind: "boolean",
                brief: "The local dir is your own project: sync it into --remote-dir with no state backup and no git bridge writing into it",
            },
            transport: {
                kind: "parsed",
                parse: parseTransport,
                optional: true,
                brief: "How the sandbox is reached: auto (the default: Docker for a project whose sandbox runs on this machine's engine, ssh otherwise), ssh or docker",
            },
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

// A sandbox set up again keeps where its folder syncs. Re-running setup replaces the pairing, and one that changed
// kind over the same folder would rewrite what the folder holds: a project folder handed /work gets the sandbox's
// whole workspace and its state written into it, which is what a one-liner that predates project folders would do.
// Changing it is an unpair first, said out loud.
export const placementChange = (held: Pairing | undefined, placement: Pick<Pairing, "remoteDir" | "project">): string | undefined => {
    if (held?.localDir === undefined) {
        return undefined;
    }
    const same = pairingRemoteDir(held) === pairingRemoteDir(placement) && isProjectPairing(held) === isProjectPairing(placement);
    return same
        ? undefined
        : `${held.sandboxId} already syncs ${held.localDir} with its ${pairingRemoteDir(held)}${isProjectPairing(held) ? " as a project" : ""}; setting it up again for ${pairingRemoteDir(placement)}${isProjectPairing(placement) ? " as a project" : ""} would rewrite what that folder holds. Unpair it first (\`intentic-machine sync uninstall --sandbox ${held.sandboxId}\`), then set it up again.`;
};

// A project asked for in the environment but not in the flags: `ic` and the desktop app say a project with SYNC_PROJECT
// and SYNC_REMOTE_DIR, and an install script older than this agent drops them instead of passing the flags. Enrolled
// anyway, the sandbox's whole /work (its state, its starter, its public folder) would sync with the user's own folder,
// so the environment's word is taken as what was meant and the setup refused. Undefined when nothing disagrees.
export const projectAskedWithoutFlag = (flags: Pick<SetupFlags, "project">, env: NodeJS.ProcessEnv = process.env): string | undefined => {
    const remote = env["SYNC_REMOTE_DIR"] ?? ``;
    const asked = (env["SYNC_PROJECT"] ?? ``) !== `` || (remote !== `` && remote !== WORKSPACE_ROOT);
    return asked && !flags.project
        ? `This setup was asked to sync a project folder (SYNC_PROJECT, SYNC_REMOTE_DIR), but the install script that ran it did not pass --project: it is older than this agent. Nothing was enrolled. Run the setup again once the script is current.`
        : undefined;
};

// Everything that can refuse this setup, asked before the single-use pairing token is spent on it: where the folder
// syncs to, whether this sandbox already syncs it somewhere else, and whether another sandbox's pairing holds it.
const planSetup = async (
    flags: SetupFlags,
): Promise<{
    readonly sandboxId: string;
    readonly placement: Pick<Pairing, "remoteDir" | "project">;
    readonly folder: string;
    readonly reach: Pick<Pairing, "transport" | "container">;
}> => {
    const skewed = projectAskedWithoutFlag(flags);
    if (skewed !== undefined) {
        throw new Error(skewed);
    }
    const sandboxId = flags.sandboxId ?? sanitizeId(new URL(flags.url).host);
    const placement = placementOf(flags);
    const folder = wantedFolder(flags, sandboxId);
    const { pairings } = await readState();
    const changed = placementChange(
        pairings.find((held) => held.sandboxId === sandboxId),
        placement,
    );
    if (changed !== undefined) {
        throw new Error(changed);
    }
    const clash = await overlappingPairing(folder, sandboxId, pairings);
    if (clash !== undefined) {
        throw new Error(
            `${folder} overlaps ${clash.localDir}, which already syncs with ${clash.sandboxId}: two syncs over one folder overwrite each other's files. Choose a folder that neither is, holds nor sits inside one this machine syncs (\`intentic-machine status\` lists them).`,
        );
    }
    const reach = await transportFor(flags.transport ?? "auto", placement, flags.url);
    return { sandboxId, placement, folder, reach };
};

const runSetup = async (ui: Ui, out: Log, flags: SetupFlags): Promise<void> => {
    ui.step("sync-enrolling", "enrolling this machine with your sandbox…");
    const { sandboxId, placement, folder, reach } = await planSetup(flags);
    const publicKey = await ensureSshKey();
    // Enrollment can retry for ~30s while the sandbox tunnel warms; overlapped with the two binary downloads
    // (independent: distinct endpoints, distinct install paths).
    const [{ syncToken, mode, hostKey }, mutagen] = await Promise.all([
        enrollKey(flags.url, flags.pair, publicKey, {
            takeover: flags.takeover,
            identity: { machineId: machineId(), environment: environmentKeyOf({ wsl: await wslEnvironment() }) },
        }),
        ensureMutagen(),
    ]);
    out(`enrolled SSH key with ${flags.url}`);

    const container = dockerContainerOf(reach, mode);
    await pinHostKey(sandboxId, hostKey, container);

    // A project folder is only ever file sync: an enrollment that came back ports-only (another machine holds this
    // sandbox's sync) would leave the owner's project unsynced under a card that says it is, so it is handed back.
    if (placement.project === true && mode !== "sync") {
        await revokeEnrollment(flags.url, syncToken).catch((error: unknown) =>
            out(
                `note: ${flags.url} could not be told to forget this machine (${errorMessage(error)}), so its sync key is still authorized there. Remove this machine from that sandbox's Devices view.`,
            ),
        );
        throw new Error(
            "another machine holds file sync for this sandbox, so this project folder cannot sync here. Re-run with --takeover to move sync to this machine.",
        );
    }

    // File sync exists only in "sync" mode; a mirror-only enrollment has no local dir, just port forwards.
    const localDir = mode === "sync" ? folder : undefined;
    if (localDir !== undefined) {
        // Create the local root up front: an immediately-visible folder is the user's anchor that setup worked.
        await mkdir(localDir, { recursive: true });
    }

    const pairing: Pairing = {
        sandboxUrl: flags.url,
        sandboxId,
        mode,
        syncToken,
        ...(localDir === undefined ? {} : { localDir, ...placement, ...reach }),
    };

    ui.step("sync-linking", "linking the folder to your sandbox…");
    // ADD this pairing to whatever this machine already holds: pairing a second sandbox used to overwrite the
    // first, dropping its ssh alias, folder and file-sync session.
    await upsertPairing(pairing);
    const pairings = (await readState()).pairings;

    // The ssh fragment is regenerated from the whole pairing list, so every paired sandbox keeps its alias.
    await writeManagedSshConfig(pairingSshConfig(pairings));

    ui.step("sync-starting", "starting the sync engine…");
    await ensureResident(out);
    await completeSetup(out);
    await proveTransport(out, sandboxId, container);

    // THIS pairing's file sync is the agent's to start (mirror.ts prepares every setup it has not seen), never this
    // command's as well. The two used to race, and one name ended up holding two identical sessions. Waiting for it is
    // only so the lines below can say it began. Every other pairing's session keeps running; only sessions no pairing
    // claims are swept.
    if (mode === "sync" && !(await syncSessionAppears(mutagen, sandboxId, SESSION_READY_MS))) {
        out(await notStartedYet(localDir ?? sandboxId));
    }
    retireOrphanSessions(mutagen, pairings, out);
    // One bridge pass right away, so a fresh pairing's local repos carry the sandbox's git history from the first
    // minute rather than waiting out the watcher's cadence.
    runGitBridge(realBridgeExec, pairing, out, undefined);
    // Register the Mutagen daemon to autostart and resume sessions across reboots; it holds both sync and forward
    // sessions, so this covers mirror-only too. Best-effort: already-registered isn't worth failing on.
    registerMutagenAutostart(mutagen, machineLauncher(), out);
    finishSetup(ui, flags.url, pairing, pairings);
};

// The container a new file-sync pairing reaches its sandbox through, or undefined for one reached over ssh. A mirror-only
// enrollment has no folder, so whatever transportFor chose for it is moot.
const dockerContainerOf = (reach: Pick<Pairing, "transport" | "container">, mode: SyncMode): string | undefined =>
    mode === "sync" && reach.transport === "docker" ? reach.container : undefined;

// Enrolling again is the owner vouching that this is the same sandbox, whatever key its sshd presents now: the one
// known_hosts holds for the alias is replaced, which is the only moment a changed key is ever accepted. A pairing reached
// through Docker never dials that sshd, so it pins nothing.
const pinHostKey = async (sandboxId: string, hostKey: string | undefined, container: string | undefined): Promise<void> => {
    if (container === undefined) {
        await replaceKnownHost(sshAlias(sandboxId), syncSshPort(sandboxId), hostKey);
    }
};

// Proves the way this pairing reaches its sandbox before Mutagen is handed it. Over ssh: the listener the resident agent
// binds on its next pass (tunnel.ts; not fatal on a timeout), then the very client Mutagen will pick, which on Windows
// is not the `ssh` on PATH but the first hit in its own hardcoded list (ssh.ts). Through Docker nothing rides ssh
// (endpoint.ts): whether the container is this sandbox was checked before the token was spent, and is checked again
// before each session is made.
const proveTransport = async (out: Log, sandboxId: string, container: string | undefined): Promise<void> => {
    if (container !== undefined) {
        out(`reaching ${sandboxId} through Docker on this machine (${container}): no ssh key, tunnel or public address on the data path`);
        return;
    }
    const alias = sshAlias(sandboxId);
    const port = syncSshPort(sandboxId);
    if (!(await tunnelReady(port, TUNNEL_READY_MS))) {
        out(`note: the sync transport for ${sandboxId} isn't listening on 127.0.0.1:${port} yet, syncing starts as soon as it is.`);
    }
    const ssh = mutagenSshPath(process.platform, process.env["MUTAGEN_SSH_PATH"]);
    assertSshConfigVisible(ssh, alias, port);
    await probeSshTransport(ssh, alias, out);
};

// The ending block. The fleet is said out loud first: pairing a sandbox on a machine that already had one is the exact
// moment the user needs to know the others are still syncing. The address a person acts on is the folder, the thing
// they open, and an immediately visible path is the anchor that setup worked.
const finishSetup = (ui: Ui, sandboxUrl: string, pairing: Pairing, pairings: readonly Pairing[]): void => {
    if (pairings.length > 1) {
        ui.note(`This machine now syncs ${pairings.length} sandboxes:`);
        for (const held of pairings) {
            ui.note(`  ${held.sandboxId}${held.localDir === undefined ? " (ports only)" : ` → ${held.localDir}`}`);
        }
    }
    const syncing = pairing.mode === "sync";
    ui.finished(
        syncing ? "Desktop sync is running." : "Enrolled for port mirroring.",
        syncing ? pairing.localDir : undefined,
        syncing ? setupOutcome(pairing) : `Ports from ${sandboxUrl} now answer on this machine's localhost (mirror-only, no file sync).`,
        [
            ["check it", "intentic-machine status"],
            ["remove it", "intentic-machine sync uninstall"],
        ],
    );
};

// What a finished setup means for the folder, in the terms its direction gives it. A copy-first project is a copy: the
// owner's edits flow in, and nothing an agent does there reaches the folder until it is brought back. Only a two-way
// pairing makes the folder and the sandbox's side the same files.
export const setupOutcome = (pairing: Pick<Pairing, "project" | "direction" | "remoteDir">): string =>
    isProjectPairing(pairing) && projectDirection(pairing) === "to-sandbox"
        ? `That folder is copied into your sandbox's ${pairingRemoteDir(pairing)}, and your edits keep flowing in. What agents change there reaches this folder only when you bring it back (\`intentic-machine sync bring-back\`), after a restore point.`
        : `That folder and your sandbox's ${pairingRemoteDir(pairing)} are now the same files.`;

// How long `setup` waits for the watcher it just started to bind this pairing's port. Bounded by process
// startup, not by any work the watcher does.
const TUNNEL_READY_MS = 10_000;

// How long `setup` waits for the agent to create this pairing's workspace session. A first create installs Mutagen's
// agent in the sandbox over the tunnel, which takes a while on a slow uplink.
const SESSION_READY_MS = 90_000;

// Whether the agent has created this pairing's workspace session within `withinMs`. Blocking `sync list` is fine
// here: this is the one-shot CLI, which serves no transport (exec.ts).
const syncSessionAppears = async (mutagen: string, sandboxId: string, withinMs: number): Promise<boolean> => {
    const deadline = Date.now() + withinMs;
    while (existingSyncSessions(mutagen, [sessionName(sandboxId)]).length === 0) {
        if (Date.now() >= deadline) {
            return false;
        }
        await sleep(1_000);
    }
    return true;
};

// Said when that wait runs out. An agent older than this one prepares only the pairings it started with, and it is
// still running here only if setup's own update failed. Otherwise the sandbox is just answering slowly.
const notStartedYet = async (folder: string): Promise<string> => {
    const running = await readResidentBuild();
    return running !== undefined && running !== MACHINE_VERSION
        ? `note: the agent running here is ${running}, which starts file sync for ${folder} only at its next start; \`intentic-machine upgrade\` brings it to ${MACHINE_VERSION} now.`
        : `note: this machine's agent has not started file sync for ${folder} yet; it keeps trying, and \`intentic-machine status\` shows when it is running.`;
};

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
    const covered = (pairing: Pairing): string[] => syncSessionNames(pairing).filter((name) => running.has(name));
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
                    syncing.flatMap((pairing) => syncSessionNames(pairing)),
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
// `forGood` is the top-level `uninstall`, which retires the agent whatever this machine hosts.
export const syncUninstall = async (out: Log, sandbox?: string, { forGood = false }: { readonly forGood?: boolean } = {}): Promise<void> => {
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
            spawnSync(mutagen, ["sync", "terminate", ...syncSessionNames(pairing)], { stdio: "ignore", windowsHide: true });
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
        await ensureResident(out, { forGood });
        out(`Still syncing ${plural(remaining.length, "sandbox")}: ${remaining.map((pairing) => pairing.sandboxId).join(", ")}`);
        return;
    }

    // Nothing left to sync: sync's residue goes (forwards, transport, ssh include); the agent retires only when this
    // environment holds nothing at all.
    await ensureResident(out, { forGood });
    await teardownAllForwards(mutagen, out);
    await removeManagedSshConfig();
    // Our downloaded Mutagen copy exists only for this agent, so retire its daemon completely. A `mutagen` of the user's
    // own, found on PATH, may hold their own sessions: leave its daemon alone and say so instead. ensureMutagen answers an
    // absolute path either way, so which one this is is read off where it lives.
    const ownCopy = isOwnMutagen(mutagen);
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

export const syncCommands = { setup, pause, resume, mirror, clean, autoheal, uninstall, ...projectCommands };
