import { mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { errorMessage, undefinedIfMissing } from "@intentic/base/errors";
import { plural } from "@intentic/base/format";
import { WORKSPACE_ROOT } from "@intentic/constants";
import { explain, type Footnote, homeDir, type Log, type PlanStep, type Ui } from "@intentic/local-agent";
import { environmentKeyOf } from "@intentic/sandbox-contract/schemas/hosts";
import { projectDirNameOf } from "@intentic/sandbox-contract/ids/project-dir";
import { sandboxIdFromUrl } from "@intentic/sandbox-contract/ids/hostnames";
import { type SyncEnrollmentRequest, SyncEnrollmentAnswerSchema } from "@intentic/sandbox-contract/schemas/devices";
import { buildRouteMap, type CommandContext, type FlagParametersForType } from "@stricli/core";
import { buildCommand, machineUi, type Narration, sandboxUrlOf } from "../cli-ui.js";
import { z } from "zod";
import { postWhileWarming } from "../daemon-base.js";
import { completeSetup, prepareSetup } from "../install.js";
import { machineId } from "../machine-id.js";
import { wslEnvironment } from "../environments/wsl.js";
import { ensureResident, readResidentBuild, readResidentPid } from "../resident/resident.js";
import { MACHINE_VERSION } from "../version.js";
import {
    isAttachedPairing,
    isProjectPairing,
    type Pairing,
    pairingKey,
    pairingRemoteDir,
    readState,
    setAutoHealOff,
    setMirrorOff,
    setOwnerPaused,
    setPortIgnored,
    type SyncMode,
    type SyncState,
    upsertPairing,
} from "./config.js";
import { type TransportAsk, transportFor } from "./endpoint.js";
import { overlappingPairing } from "./folders.js";
import { retireMirroredPort, retirePairingMirror } from "./mirror.js";
import { asidePrefix } from "./project/adopt.js";
import { attachCommands } from "./attach-commands.js";
import { projectCommands } from "./project/project-commands.js";
import { existingSyncSessions, healDerivedConflicts, readAllSessions, retireOrphanSessions, sessionName, startMutagenDaemon } from "./mutagen.js";
import { adoptOwnerPauses, HOLD_WORDS, holdSessions, syncHeld, syncHolds } from "./holds.js";
import { ensureMutagen } from "./binary/mutagen-binary.js";
import { forget } from "./forget-command.js";
import { revokeEnrollment, syncsAFolder, uninstallPairings } from "./uninstall.js";
import { refuseAcrossPc } from "./siblings.js";
import { syncSshPort, tunnelReady } from "./tunnel.js";
import {
    assertSshConfigVisible,
    ensureSshKey,
    hostKeyOf,
    mutagenSshPath,
    pairingSshConfig,
    probeSshTransport,
    replaceKnownHost,
    sanitizeId,
    sshAlias,
    writeManagedSshConfig,
} from "./ssh.js";

// Where a new pairing's transport is decided now lives beside the transports themselves (endpoint.ts).
export { transportFor } from "./endpoint.js";

// Which pairings a command acts on. No selector means every one this machine holds; `--sandbox` takes the
// sandbox id or any substring matching exactly one (real ids are `sandbox-<hex>-<zone>`-shaped), and selects every
// pairing of that sandbox: its own, and each folder attached to it.
// The host of a sandbox's address, or undefined for anything that is not one.
const urlHost = (value: string): string | undefined => {
    if (!value.includes("://")) {
        return undefined;
    }
    try {
        return new URL(value).host;
    } catch {
        // allow(silent-catch): a value that is not a URL is matched as an id
        return undefined;
    }
};

export const selectPairings = (state: SyncState, selector: string | undefined): readonly Pairing[] => {
    if (selector === undefined) {
        return state.pairings;
    }
    const ids = [...new Set(state.pairings.map((pairing) => pairing.sandboxId))];
    // The sandbox's address names it too, as setup derives its id from it: one spelling of --sandbox for every command.
    const wanted = sanitizeId(urlHost(selector) ?? selector);
    const exact = ids.filter((id) => id === wanted);
    const matched = exact.length === 1 ? exact : ids.filter((id) => id.includes(selector));
    if (matched.length === 0) {
        throw new Error(explain(`No paired sandbox matches ${selector}.`, `this device pairs ${ids.length === 0 ? "no sandbox" : ids.join(", ")}.`));
    }
    if (matched.length > 1) {
        throw new Error(
            explain(
                `${selector} matches more than one paired sandbox.`,
                `it matches ${matched.join(", ")}.`,
                "name one of them in full with --sandbox.",
            ),
        );
    }
    return state.pairings.filter((pairing) => pairing.sandboxId === matched[0]);
};

const SYNC_NOT_SET_UP = "Desktop sync was not set up.";

// Enrolls this device's SSH key with the single-use pairing token; a 423 or any other 4xx is the daemon's final answer.
export const enrollKey = async (
    sandboxUrl: string,
    pairToken: string,
    key: string,
    {
        attempts,
        delayMs,
        takeover = false,
        identity,
        say,
    }: {
        attempts?: number;
        delayMs?: number;
        takeover?: boolean;
        // Which computer and which OS install on it is enrolling, so the sandbox joins this enrollment to the same
        // machine's card; an older sandbox ignores both.
        identity?: { readonly machineId: string; readonly environment: string };
        // Where a retry while the sandbox warms up is narrated.
        say?: Log;
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
            expired: explain(SYNC_NOT_SET_UP, "the pairing has expired.", "click Enable desktop sync again in your browser for a fresh command."),
            say,
            attempts,
            delayMs,
        },
    );
    // Another machine holds sync for this sandbox, and the daemon moves it only on an explicit takeover.
    if (response.status === 423) {
        const held = (await response.json().catch(() => ({}))) as { machine?: string };
        const from = held.machine !== undefined ? ` from "${held.machine}"` : "";
        throw new Error(
            explain(
                `Desktop sync is already active on this sandbox${from}.`,
                "one device at a time holds a sandbox's file sync.",
                "run the same command again with --takeover to move it to this device; the other one stops syncing.",
            ),
        );
    }
    if (!response.ok) {
        throw new Error(explain(SYNC_NOT_SET_UP, `enrolling the sync key failed (${response.status}): ${await response.text()}`));
    }
    const answer = SyncEnrollmentAnswerSchema.safeParse(await response.json());
    if (!answer.success) {
        throw new Error(
            explain(SYNC_NOT_SET_UP, `the sandbox enrolled this device but its answer could not be read: ${z.prettifyError(answer.error)}`),
        );
    }
    const body = answer.data;
    // The sync token authorizes the port read, the machine report and the SSH transport: without one, fail here, not as a dead session.
    if (body.syncToken === undefined) {
        throw new Error(
            explain(
                SYNC_NOT_SET_UP,
                "the sandbox enrolled this device but returned no sync credential.",
                "update the sandbox, then enable sync again.",
            ),
        );
    }
    // What the daemon granted: "sync" is file sync plus mirroring (one holder), "mirror" is ports only (any number). The
    // sshd host key, when a sandbox hands it over, is what this machine pins for it (ssh.ts, replaceKnownHost).
    return { syncToken: body.syncToken, mode: body.mode ?? "sync", hostKey: hostKeyOf(body.hostKey) };
};

interface SetupFlags {
    readonly url: string;
    // --sandbox, the spelling every other command picks a sandbox with, standing in for --url.
    readonly sandbox?: string;
    readonly pair: string;
    readonly dir?: string;
    readonly sandboxId?: string;
    readonly takeover: boolean;
    readonly remoteDir?: string;
    readonly project: boolean;
    readonly transport?: TransportAsk;
    // This computer's own sandbox, enrolled with no folder of its own: folders attach to it (`sync attach`).
    readonly projectsHost?: boolean;
}

const parseTransport = (value: string): TransportAsk => {
    if (value !== "auto" && value !== "ssh" && value !== "docker") {
        throw new Error(`"${value}" is not a transport: auto (the default), ssh or docker.`);
    }
    return value;
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

type SetupGiven = Omit<SetupFlags, "url"> & { readonly url?: string };

const setup = buildCommand<SetupGiven>({
    docs: {
        brief: "Enroll this device with a pairing token and start a Mutagen sync of the local dir ↔ sandbox /work (or a project folder in it), over ssh or, for a project on this device's Docker engine, through Docker",
    },
    parameters: {
        flags: {
            url: { kind: "parsed", parse: String, optional: true, brief: "The sandbox's public URL (e.g. https://sandbox-xxx.example.dev)" },
            sandbox: { kind: "parsed", parse: String, optional: true, brief: "The same as --url" },
            pair: { kind: "parsed", parse: String, brief: "The one-time pairing token from the Desktop sync card" },
            dir: {
                kind: "parsed",
                parse: String,
                optional: true,
                brief: "Local directory to sync (default: ~/intentic/<sandbox id>, the id in the sandbox's own URL)",
            },
            sandboxId: { kind: "parsed", parse: String, optional: true, brief: "Session/alias id (default: the sandbox URL host)" },
            takeover: { kind: "boolean", brief: "Take over sync from another device already enrolled on this sandbox (revokes its key)" },
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
                brief: "How the sandbox is reached: auto (the default: Docker for a project whose sandbox runs on this device's engine, ssh otherwise), ssh or docker",
            },
            projectsHost: {
                kind: "boolean",
                optional: true,
                brief: "Enroll this computer's own sandbox with no folder of its own, for folders to attach to (`sync attach`); takes no --dir, --remote-dir or --project",
            },
        },
    },
    async func(this: CommandContext, given: SetupGiven) {
        const flags: SetupFlags = { ...given, url: sandboxUrlOf(given.url, given.sandbox, "Desktop sync was not set up.") };
        // Rendered through the shared renderer (@intentic/local-agent), also what `ic` renders through: `ic` sets
        // INTENTIC_UI=nested so these lines land as detail under its own step rather than a second banner.
        const ui = machineUi(this.process);
        // Self-update, PATH, the Windows launcher run first (install.ts), as narration before the header: on an actual
        // update this process re-execs the new agent with the same argv, which draws the header itself.
        await prepareSetup(ui.note, process.argv.slice(2));
        // Every helper below takes a `Log` and narrates through it, so the whole command's prose is placed, wrapped
        // and coloured without any of them knowing.
        const out: Log = ui.note;
        ui.begin("intentic · desktop sync", SETUP_PLAN);
        // A throw is left to the run's stop (cli-ui.ts), which settles the running step as failed and stops the spinner;
        // closing here first would settle it as done.
        await runSetup(ui, out, flags);
        ui.close();
    },
});

// What `setup` is going to do, said before it does it. Phases are this agent's own vocabulary, deliberately not
// in the desktop app's setup plan: a phase that plan doesn't carry is narration under whichever step is running.
const SETUP_PLAN: readonly PlanStep[] = [
    { phase: "sync-enrolling", label: "Connect this device", weight: 25 },
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
        : explain(
              `${held.sandboxId} was not set up again.`,
              `it already syncs ${held.localDir} with its ${pairingRemoteDir(held)}${isProjectPairing(held) ? " as a project" : ""}; setting it up again for ${pairingRemoteDir(placement)}${isProjectPairing(placement) ? " as a project" : ""} would rewrite what that folder holds. Unpair it first, then set it up again.`,
              unpairCommand(held.sandboxId),
          );
};

const unpairCommand = (sandboxId: string): string => `intentic-machine sync uninstall --sandbox ${sandboxId}`;

// A project asked for in the environment but not in the flags: `ic` and the desktop app say a project with SYNC_PROJECT
// and SYNC_REMOTE_DIR, and an install script older than this agent drops them instead of passing the flags. Enrolled
// anyway, the sandbox's whole /work (its state, its starter, its public folder) would sync with the user's own folder,
// so the environment's word is taken as what was meant and the setup refused. Undefined when nothing disagrees.
export const projectAskedWithoutFlag = (flags: Pick<SetupFlags, "project">, env: NodeJS.ProcessEnv = process.env): string | undefined => {
    const remote = env["SYNC_REMOTE_DIR"] ?? ``;
    const asked = (env["SYNC_PROJECT"] ?? ``) !== `` || (remote !== `` && remote !== WORKSPACE_ROOT);
    return asked && !flags.project
        ? explain(
              "Nothing was enrolled.",
              "this setup was asked to sync a project folder (SYNC_PROJECT, SYNC_REMOTE_DIR), but the install script that ran it did not pass --project: it is older than this agent.",
              "run the setup again once the script is current.",
          )
        : undefined;
};

// THE PROJECTS HOST, this computer's own sandbox that folders attach to, is a pairing of its own kind: it holds the
// sync token and mirrors the ports, and holds no folder. Setting a sandbox up again as the other kind would either leave
// its attached folders with no sandbox pairing, or drop the folder it syncs; either is an unpair first, said out loud.
// `--projects-host` takes no folder flag at all. Undefined when nothing disagrees.
export const projectsHostChange = (
    held: Pick<Pairing, "sandboxId" | "localDir" | "projectsHost"> | undefined,
    flags: Pick<SetupFlags, "projectsHost" | "dir" | "remoteDir" | "project">,
): string | undefined => {
    if (flags.projectsHost === true && (flags.dir !== undefined || flags.remoteDir !== undefined || flags.project)) {
        return explain(
            "Nothing was enrolled.",
            "--projects-host enrolls this device's sandbox with no folder of its own, so it takes no --dir, --remote-dir or --project; folders attach to it afterwards.",
            "run the same command again without --dir, --remote-dir and --project.",
        );
    }
    if (held === undefined) {
        return undefined;
    }
    if (flags.projectsHost === true && held.localDir !== undefined) {
        return explain(
            `${held.sandboxId} was not set up again.`,
            `it already syncs ${held.localDir}; setting it up as this device's sandbox for folders would stop that. Unpair it first, then set it up again.`,
            unpairCommand(held.sandboxId),
        );
    }
    if (flags.projectsHost !== true && held.projectsHost === true) {
        return explain(
            `${held.sandboxId} was not set up again.`,
            "it is this device's sandbox for folders, which attach to it; setting it up for a folder of its own would leave them without it. Set it up again with --projects-host, or unpair it first.",
            unpairCommand(held.sandboxId),
        );
    }
    return undefined;
};

// Everything that can refuse this setup, asked before the single-use pairing token is spent on it: where the folder
// syncs to, whether this sandbox already syncs it somewhere else, and whether another pairing holds it.
const planSetup = async (
    flags: SetupFlags,
): Promise<{
    readonly sandboxId: string;
    readonly placement: Pick<Pairing, "remoteDir" | "project">;
    readonly folder: string | undefined;
    readonly reach: Pick<Pairing, "transport" | "container">;
    // The other environments of this PC whose folders could not be read, so the overlap check could not include them.
    readonly unread?: readonly string[];
}> => {
    const skewed = flags.projectsHost === true ? undefined : projectAskedWithoutFlag(flags);
    if (skewed !== undefined) {
        throw new Error(skewed);
    }
    const sandboxId = flags.sandboxId ?? sanitizeId(new URL(flags.url).host);
    const { pairings } = await readState();
    // The sandbox's own pairing, never a folder attached to it: those are filed under keys of their own.
    const held = pairings.find((pairing) => pairingKey(pairing) === sandboxId);
    const hostChange = projectsHostChange(held, flags);
    if (hostChange !== undefined) {
        throw new Error(hostChange);
    }
    if (flags.projectsHost === true) {
        return {
            sandboxId,
            placement: {},
            folder: undefined,
            reach: await transportFor(flags.transport ?? "auto", { projectsHost: true }, flags.url),
        };
    }
    const placement = placementOf(flags);
    const folder = wantedFolder(flags, sandboxId);
    const changed = placementChange(held, placement);
    if (changed !== undefined) {
        throw new Error(changed);
    }
    const clash = await overlappingPairing(folder, sandboxId, pairings);
    if (clash !== undefined) {
        throw new Error(
            explain(
                `${folder} was not set up.`,
                `it overlaps ${clash.localDir}, which already syncs with ${clash.sandboxId}, and two syncs over one folder overwrite each other's files.`,
                "choose a folder that neither is, holds nor sits inside one this device syncs; intentic-machine status lists them.",
            ),
        );
    }
    // (2026-10-05) And the other environments of this PC, each with a sync.json of its own (siblings.ts).
    const across = await refuseAcrossPc(folder);
    if (across.refusal !== undefined) {
        throw new Error(across.refusal);
    }
    const reach = await transportFor(flags.transport ?? "auto", placement, flags.url);
    return { sandboxId, placement, folder, reach, unread: across.unread };
};

const runSetup = async (ui: Ui, out: Log, flags: SetupFlags): Promise<void> => {
    ui.step("sync-enrolling", "enrolling this device with your sandbox…");
    const { sandboxId, placement, folder, reach, unread = [] } = await planSetup(flags);
    if (unread.length > 0) {
        ui.warn(
            `${unread.join(", ")} could not be asked which folders ${unread.length === 1 ? "it syncs" : "they sync"}, so ${folder ?? "this folder"} was not checked against ${unread.length === 1 ? "it" : "them"}.`,
        );
    }
    const publicKey = await ensureSshKey();
    // Enrollment can retry for ~30s while the sandbox tunnel warms; overlapped with the two binary downloads
    // (independent: distinct endpoints, distinct install paths).
    const [{ syncToken, mode, hostKey }, mutagen] = await Promise.all([
        enrollKey(flags.url, flags.pair, publicKey, {
            takeover: flags.takeover,
            say: out,
            identity: { machineId: machineId(), environment: environmentKeyOf({ wsl: await wslEnvironment() }) },
        }),
        ensureMutagen(),
    ]);
    out(`enrolled SSH key with ${flags.url}`);

    const container = dockerContainerOf(reach, mode);
    await pinHostKey(sandboxId, hostKey, container);

    // A project folder is only ever file sync: an enrollment that came back ports-only (another machine holds this
    // sandbox's sync) would leave the owner's project unsynced under a card that says it is, so it is handed back. The
    // projects host likewise: the folders that attach to it are file sync.
    if ((placement.project === true || flags.projectsHost === true) && mode !== "sync") {
        await revokeEnrollment(flags.url, syncToken).catch((error: unknown) =>
            ui.warn(
                `${flags.url} could not be told to forget this device (${errorMessage(error)}), so its sync key is still authorized there. Remove this device from that sandbox's Devices view.`,
            ),
        );
        throw new Error(
            explain(
                flags.projectsHost === true ? "No folder can attach to this sandbox here." : "This project folder cannot sync here.",
                "another device holds file sync for this sandbox.",
                "run the same command again with --takeover to move sync to this device.",
            ),
        );
    }

    // File sync exists only in "sync" mode; a mirror-only enrollment has no local dir, just port forwards, and the
    // projects host has none by design.
    const localDir = mode === "sync" ? folder : undefined;
    // A folder that already holds files is made to agree with the sandbox's copy before the first session compares them
    // (adopt.ts): a session with no history would carry every stale file into the sandbox and stop on every difference.
    // A project folder is the copy that counts, so it is never adopted.
    const adopt = localDir !== undefined && placement.project !== true && (await holdsEntries(localDir));
    if (localDir !== undefined) {
        // Create the local root up front: an immediately-visible folder is the user's anchor that setup worked.
        await mkdir(localDir, { recursive: true });
    }

    const pairing: Pairing =
        flags.projectsHost === true
            ? { sandboxUrl: flags.url, sandboxId, mode, syncToken, projectsHost: true, ...reach }
            : {
                  sandboxUrl: flags.url,
                  sandboxId,
                  mode,
                  syncToken,
                  ...(localDir === undefined ? {} : { localDir, ...placement, ...reach }),
                  ...(adopt ? { adoptFolder: true as const } : {}),
              };

    ui.step("sync-linking", "linking the folder to your sandbox…");
    // ADD this pairing to whatever this machine already holds: pairing a second sandbox used to overwrite the
    // first, dropping its ssh alias, folder and file-sync session. A new token reaches every folder attached to the
    // sandbox too (config.ts withPairing).
    await upsertPairing(pairing);
    const pairings = (await readState()).pairings;

    // The ssh fragment is regenerated from the whole pairing list, so every paired sandbox keeps its alias.
    await writeManagedSshConfig(pairingSshConfig(pairings));

    ui.step("sync-starting", "starting the sync engine…");
    // What a late start adds to the ending's footnotes.
    const later: Footnote[] = [];
    // The daemon holds both sync and forward sessions, so this covers mirror-only too. The resident agent starts it
    // as its watcher starts as well; started here, the wait below can read it as soon as the watcher makes a session.
    startMutagenDaemon(mutagen);
    await ensureResident(out);
    await completeSetup(out);
    await proveTransport(out, ui.warn, sandboxId, container);

    // THIS pairing's file sync is the agent's to start (mirror.ts prepares every setup it has not seen), never this
    // command's as well. The two used to race, and one name ended up holding two identical sessions. Waiting for it is
    // only so the lines below can say it began. Every other pairing's session keeps running; only sessions no pairing
    // claims are swept.
    if (mode === "sync" && localDir !== undefined && !(await syncSessionAppears(mutagen, sandboxId, SESSION_READY_MS))) {
        const late = await notStartedYet(localDir);
        ui.warn(late.said);
        later.push(late.later);
    }
    retireOrphanSessions(mutagen, pairings, out);
    // No bridge pass of this command's own: the watcher's next pass, seconds away, starts one, and a first fetch of a big
    // repository can run for hours (git-bridge.ts), which would hold this command open as long, and two fetches into
    // one clone at once would only race.
    finishSetup(ui, flags.url, pairing, pairings, later);
};

// Whether a folder exists and has anything in it; what it holds is adopt.ts's to compare.
const holdsEntries = async (dir: string): Promise<boolean> => ((await readdir(dir).catch(undefinedIfMissing))?.length ?? 0) > 0;

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
const proveTransport = async (out: Log, warn: Log, sandboxId: string, container: string | undefined): Promise<void> => {
    if (container !== undefined) {
        out(`reaching ${sandboxId} through Docker on this device (${container}): no ssh key, tunnel or public address on the data path`);
        return;
    }
    const alias = sshAlias(sandboxId);
    const port = syncSshPort(sandboxId);
    if (!(await tunnelReady(port, TUNNEL_READY_MS))) {
        warn(`The sync transport for ${sandboxId} isn't listening on 127.0.0.1:${port} yet; syncing starts as soon as it is.`);
    }
    const ssh = mutagenSshPath(process.platform, process.env["MUTAGEN_SSH_PATH"]);
    await assertSshConfigVisible(ssh, alias, port);
    await probeSshTransport(ssh, alias, out);
};

// What a file-sync setup leaves true. The first copy is still to come when setup returns, so it says it is under way
// rather than done; a folder that already held files says where the ones that disagree with the sandbox go (adopt.ts),
// since that is the one thing setup does to files the owner put there.
const syncedSentence = (pairing: Pairing): string => {
    const kept = `That folder and your sandbox's ${pairingRemoteDir(pairing)} are kept the same from now on; the first copy can take a few minutes.`;
    return pairing.adoptFolder === true && pairing.localDir !== undefined
        ? `${kept}\nThe folder already held files: any that differ from the sandbox's copy are moved to ${asidePrefix(pairing.localDir)}<time> first, so the sandbox's version is the one that syncs. Nothing is deleted.`
        : kept;
};

// The ending block. The fleet is said out loud first: pairing a sandbox on a machine that already had one is the exact
// moment the user needs to know the others are still syncing. The address a person acts on is the folder, the thing
// they open, and an immediately visible path is the anchor that setup worked.
const finishSetup = (ui: Ui, sandboxUrl: string, pairing: Pairing, pairings: readonly Pairing[], later: readonly Footnote[] = []): void => {
    if (pairings.length > 1) {
        ui.note(`This device now syncs ${pairings.length} pairings:`);
        for (const held of pairings) {
            ui.note(
                `  ${pairingKey(held)}${held.projectsHost === true ? " (this device's sandbox, for folders)" : held.localDir === undefined ? " (ports only)" : ` → ${held.localDir}`}`,
            );
        }
    }
    if (pairing.projectsHost === true) {
        ui.finished(
            "This device's sandbox is ready for folders.",
            undefined,
            `Ports from ${sandboxUrl} answer on this device's localhost, and folders attach to it as ${WORKSPACE_ROOT}/<name>.`,
            [
                ["attach a folder", `intentic-machine sync attach --sandbox-url ${sandboxUrl} --dir <folder> --name <name>`],
                ["check it", "intentic-machine status"],
                ...later,
            ],
        );
        return;
    }
    const syncing = pairing.mode === "sync";
    ui.finished(
        syncing ? "Desktop sync is running." : "Enrolled for port mirroring.",
        syncing ? pairing.localDir : undefined,
        syncing ? syncedSentence(pairing) : `Ports from ${sandboxUrl} now answer on this device's localhost (mirror-only, no file sync).`,
        [["check it", "intentic-machine status"], ["remove it", unpairCommand(pairing.sandboxId)], ...later],
    );
};

// How long `setup` waits for the watcher it just started to bind this pairing's port. Bounded by process
// startup, not by any work the watcher does.
const TUNNEL_READY_MS = 10_000;

// How long `setup` waits for the agent to create this pairing's workspace session. A first create installs Mutagen's
// agent in the sandbox over the tunnel, which takes a while on a slow uplink.
const SESSION_READY_MS = 90_000;

// Whether the agent has created this pairing's workspace session within `withinMs`. Blocking `sync list` is fine
// here: this is the one-shot CLI, which serves no transport (exec.ts).
const syncSessionAppears = async (mutagen: string, key: string, withinMs: number): Promise<boolean> => {
    const deadline = Date.now() + withinMs;
    while ((existingSyncSessions(mutagen, [sessionName(key)]) ?? []).length === 0) {
        if (Date.now() >= deadline) {
            return false;
        }
        await sleep(1_000);
    }
    return true;
};

// Said when that wait runs out. An agent older than this one prepares only the pairings it started with, and it is
// still running here only if setup's own update failed. Otherwise the sandbox is just answering slowly.
const notStartedYet = async (folder: string): Promise<{ readonly said: string; readonly later: Footnote }> => {
    const running = await readResidentBuild();
    return running !== undefined && running !== MACHINE_VERSION
        ? {
              said: `The agent running here is ${running}, which starts file sync for ${folder} only at its next start; ${MACHINE_VERSION} starts it at once.`,
              later: ["update it now", "intentic-machine upgrade"],
          }
        : {
              said: `This device's agent has not started file sync for ${folder} yet; it keeps trying.`,
              later: ["see when it runs", "intentic-machine status"],
          };
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
        brief: "Act on one paired sandbox (its URL, its id, or any part of the id matching exactly one). Default: all of them",
    },
} as const;

// Each pairing by its key: the sandbox id, or `<sandboxId>~<name>` for a folder attached to it.
const named = (pairings: readonly Pairing[]): string => pairings.map(pairingKey).join(", ");

// A command over the pairings `--sandbox` selects; `none` is what it says when that selects nothing.
const pairingCommand = <F extends SandboxFlags>(
    brief: string,
    flags: FlagParametersForType<F>,
    none: string,
    act: (selected: readonly Pairing[], flags: F, ui: Ui) => Promise<void>,
) =>
    buildCommand<F>({
        docs: { brief },
        parameters: { flags },
        async func(this: CommandContext, given: F) {
            const ui = machineUi(this.process);
            const selected = selectPairings(await readState(), given.sandbox);
            if (selected.length === 0) {
                ui.quiet(none);
                return;
            }
            await act(selected, given, ui);
        },
    });

const NONE_TO_MIRROR = "No sandbox is paired on this device, so there is nothing to mirror. Desktop sync starts from a sandbox's Desktop sync card.";

// The watcher is what gives mirrored ports back, so a stopped agent turns that into a promise nothing keeps.
const noteIfStopped = async (ui: Ui): Promise<void> => {
    if ((await readResidentPid()) === undefined) {
        ui.warn("This device's agent is not running, so nothing mirrors until it starts.");
        ui.later([["start the agent", "intentic-machine run"]]);
    }
};

// Pause/resume act on file sync only: mirroring rides the resident agent, not a Mutagen pause. Each is the owner's word
// recorded on the pairing (config.ts `ownerPausedAt`), kept through a swap, a reconnect and a session made again, and
// Mutagen is made to agree at once (holds.ts) rather than at the watcher's next pass. A resume lifts the owner's pause
// alone: a pairing something else still holds says why, and carries on by itself once that ends.
const fileSyncSwitch = (brief: string, verb: "pause" | "resume") =>
    pairingCommand<SandboxFlags>(
        brief,
        sandboxFlag,
        `No sandbox is paired on this device, so there is nothing to ${verb}. Desktop sync starts from a sandbox's Desktop sync card.`,
        async (selected, _flags, ui) => {
            // The projects host holds no folder of its own: its folders' sessions are theirs.
            const syncing = selected.filter((pairing) => pairing.mode === "sync" && pairing.projectsHost !== true);
            if (syncing.length === 0) {
                ui.quiet(
                    `${selected.length > 1 ? "These enrollments only mirror ports" : "This enrollment only mirrors ports"}, so there is no file sync to ${verb}.`,
                );
                return;
            }
            ui.act(`${verb === "pause" ? "Pausing" : "Resuming"} file sync`);
            const mutagen = await ensureMutagen();
            const live = readAllSessions(mutagen);
            if (live === undefined) {
                throw new Error(explain(`File sync was not ${verb}d.`, "Mutagen did not answer when asked which sessions it holds.", "run the same command again in a moment."));
            }
            const now = Date.now();
            await adoptOwnerPauses((await readState()).pairings, live, now);
            const keys = new Set(syncing.map(pairingKey));
            for (const key of keys) {
                // state is a single file; serial keeps the writes ordered
                await setOwnerPaused(key, verb === "pause" ? now : undefined);
            }
            const after = (await readState()).pairings;
            const behind = await holdSessions(mutagen, after, ui.note, now);
            if ([...keys].some((key) => behind.has(key))) {
                throw new Error(explain(`File sync was not ${verb}d.`, `Mutagen did not take the ${verb} of every session.`, "run the same command again in a moment."));
            }
            const stillHeld = after.filter((pairing) => keys.has(pairingKey(pairing)) && syncHeld(pairing, now));
            for (const pairing of verb === "resume" ? stillHeld : []) {
                ui.note(`${pairingKey(pairing)} stays held while ${syncHolds(pairing, now).map((hold) => HOLD_WORDS[hold]).join(" and ")}; it carries on by itself once that ends.`);
            }
            ui.done(`${verb === "pause" ? "Paused" : "Resumed"} file sync for ${named(syncing)}.`);
        },
    );

// Port mirroring on or off, durable and local (config.ts setMirrorOff), so it holds through a reboot and an unreachable sandbox.
const mirrorSwitch = (brief: string, off: boolean) =>
    pairingCommand<SandboxFlags>(brief, sandboxFlag, NONE_TO_MIRROR, async (selected, _flags, ui) => {
        ui.act(off ? "Turning port mirroring off" : "Turning port mirroring on");
        const mutagen = await ensureMutagen();
        // Every pairing of the sandbox carries the switch (a folder attached to it reports it), and the forwards are the
        // sandbox's, torn down once.
        for (const pairing of selected) {
            // state is a single file; serial keeps the writes ordered
            await setMirrorOff(pairingKey(pairing), off);
        }
        // OFF takes effect now, ON is the watcher's: creating a forward dials over the transport that agent holds.
        if (off) {
            for (const sandboxId of new Set(selected.map((pairing) => pairing.sandboxId))) {
                // one sandbox's teardown at a time, as everywhere else here
                await retirePairingMirror(mutagen, sandboxId);
            }
            ui.note("Those ports are off this device's localhost. File syncing is untouched.");
            ui.done(`Turned port mirroring off for ${named(selected)}.`);
            return;
        }
        ui.note("Their ports return to localhost within a few seconds.");
        ui.done(`Turned port mirroring on for ${named(selected)}.`);
        await noteIfStopped(ui);
    });

// The one numeric flag this CLI takes. Parsed strictly rather than through a bare Number(): a NaN reaching the
// session name below would terminate a forward nothing holds and then report that it worked.
const parsePort = (value: string): number => {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error(`${value} is not a port number (1-65535).`);
    }
    return port;
};

interface MirrorPortFlags extends SandboxFlags {
    readonly port: number;
}

// One port left off THIS device's localhost, where something of its own holds it; every other device keeps mirroring it.
const mirrorPortSwitch = (brief: string, ignored: boolean) =>
    pairingCommand<MirrorPortFlags>(
        brief,
        { ...sandboxFlag, port: { kind: "parsed", parse: parsePort, brief: "The port number, as the sandbox serves it" } },
        NONE_TO_MIRROR,
        async (selected, flags, ui) => {
            ui.act(ignored ? `Leaving port ${flags.port} off this device` : `Mirroring port ${flags.port} again`);
            const mutagen = await ensureMutagen();
            let taken = 0;
            // Only the pairing that mirrors its sandbox's ports (never a folder attached to it) holds the number.
            for (const pairing of selected.filter((held) => !isAttachedPairing(held))) {
                // state is a single file; serial keeps the writes ordered
                await setPortIgnored(pairingKey(pairing), flags.port, ignored);
                if (ignored) {
                    // one pairing's teardown at a time, as everywhere else here
                    taken += (await retireMirroredPort(mutagen, pairing.sandboxId, flags.port)) ? 1 : 0;
                }
            }
            if (ignored) {
                ui.note(`${taken === 0 ? "" : `Took localhost:${flags.port} off this device. `}Every other port is untouched.`);
                ui.done(`Port ${flags.port} is no longer mirrored for ${named(selected)}.`);
                return;
            }
            ui.note(`It returns to localhost within a few seconds, unless something else on this device is holding it.`);
            ui.done(`Port ${flags.port} is mirrored again for ${named(selected)}.`);
            await noteIfStopped(ui);
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
        const ui = machineUi(this.process);
        const syncing = selectPairings(await readState(), flags.sandbox).filter((pairing) => pairing.mode === "sync");
        if (syncing.length === 0) {
            ui.quiet("No file-syncing sandbox is paired on this device, so there is no folder here to clear anything from.");
            return;
        }
        ui.act("Clearing build output the sandbox's deletions are waiting on");
        const mutagen = await ensureMutagen();
        let removed = 0;
        let standing = 0;
        for (const pairing of syncing) {
            // one pairing at a time, so a log line names one sandbox
            const outcome = await healDerivedConflicts(mutagen, pairing, ui.note, true);
            removed += outcome.removed.length;
            standing += outcome.standing;
        }
        if (standing > 0) {
            // Said plainly rather than folded into the number: these are the ones this command must not touch. Not
            // called "real disagreements" — most are, but the count also holds anything that failed the check on disk,
            // and overstating what it knows is how a reader learns to distrust the rest.
            ui.warn(
                `${plural(standing, "conflict")} still standing, and not this command's to settle: two copies somebody wrote is a choice only a person makes.`,
            );
        }
        ui.done(
            removed === 0
                ? "Nothing to clear: no directory the sandbox deleted is held open by build output on this device."
                : `Cleared ${plural(removed, "directory", "directories")}. The deletions they held back land within a few seconds.`,
        );
        if (standing > 0) {
            ui.later([["see the paths", "intentic-machine status"]]);
        }
    },
});

// Whether the watcher clears build output by itself, durable and per pairing; `clean` is not gated by it.
const autoHealSwitch = (brief: string, off: boolean) =>
    pairingCommand<SandboxFlags>(
        brief,
        sandboxFlag,
        "No sandbox is paired on this device, so there is nothing to switch.",
        async (selected, _flags, ui) => {
            ui.act(off ? "Turning off clearing build output" : "Turning on clearing build output");
            for (const pairing of selected) {
                // state is a single file; serial keeps the writes ordered
                await setAutoHealOff(pairingKey(pairing), off);
            }
            if (!off) {
                ui.done(`This device clears build output that holds back a deletion for ${named(selected)}.`);
                return;
            }
            ui.note("A deletion the sandbox makes now stops syncing whenever this device has build output inside it.");
            ui.done(`This device no longer clears build output by itself for ${named(selected)}.`);
            ui.later([["clear it by hand", "intentic-machine sync clean"]]);
        },
    );

const autoheal = buildRouteMap({
    routes: {
        off: autoHealSwitch("Stop clearing build output that blocks the sandbox's deletions from landing here", true),
        on: autoHealSwitch("Clear build output that blocks the sandbox's deletions from landing here", false),
    },
    docs: { brief: "Whether this device clears its own build output when it blocks a deletion, for one sandbox or all" },
});

// The sync half's teardown, callable from the top-level `uninstall` too (uninstall.ts). With a selector it unpairs ONE
// sandbox and leaves every other pairing served; with `foldersOnly` (the app's uninstaller), every pairing that syncs a
// folder here, leaving port mirroring and the projects host; bare, it removes everything, self-revoking each dropped
// enrollment so a device walking away cleans up after itself.
export const syncUninstall = async (
    say: Narration,
    sandbox?: string,
    { forGood = false, foldersOnly = false }: { readonly forGood?: boolean; readonly foldersOnly?: boolean } = {},
): Promise<string> => {
    const state = await readState();
    const dropped = selectPairings(state, sandbox).filter((pairing) => !foldersOnly || syncsAFolder(pairing));
    return await uninstallPairings(say, state, dropped, { forGood });
};

interface UninstallFlags extends SandboxFlags {
    readonly folders: boolean;
}

const uninstall = buildCommand<UninstallFlags>({
    docs: { brief: "Unpair a sandbox (--sandbox), or stop syncing every sandbox on this device" },
    parameters: {
        flags: {
            ...sandboxFlag,
            folders: {
                kind: "boolean",
                default: false,
                brief: "Only the pairings that sync a folder here; port mirroring and the projects host stay (the app's uninstaller)",
            },
        },
    },
    async func(this: CommandContext, flags: UninstallFlags) {
        const ui = machineUi(this.process);
        ui.act(flags.folders ? "Stopping folder sync on this device" : flags.sandbox === undefined ? "Stopping sync on this device" : `Unpairing ${flags.sandbox}`);
        ui.done(await syncUninstall(ui, flags.sandbox, { foldersOnly: flags.folders }));
    },
});

const pause = fileSyncSwitch("Pause file syncing", "pause");
const resume = fileSyncSwitch("Resume file syncing", "resume");

export const syncCommands = { setup, pause, resume, mirror, clean, autoheal, uninstall, forget, ...attachCommands, ...projectCommands };
