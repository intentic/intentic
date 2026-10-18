import { plural } from "@intentic/base/format";
import type { Footnote, Item, Tone, Ui } from "@intentic/local-agent";
import { WORKSPACE_ROOT } from "@intentic/constants";
import type { DeviceScopes } from "@intentic/sandbox-contract/schemas/capabilities";
import type {
    DeviceBridgeHold,
    DeviceConflict,
    DeviceConflictChange,
    DeviceLowDisk,
    DevicePairing,
    DevicePort,
    DeviceReport,
} from "@intentic/sandbox-contract/schemas/devices";
import type { PeerLinkState } from "@intentic/sandbox-contract/peer-dial";
import type { CommandContext } from "@stricli/core";
import { buildCommand, machineUi } from "./cli-ui.js";
import { agentBuildSkew, agentStalled } from "@intentic/sandbox-contract/schemas/devices";
import { auditPath, readLinks, readLinkStates } from "./device/config.js";
import { PAUSE_HOTKEY, readPausedAt } from "./device/indicator.js";
import { runLogPath } from "./config.js";
import { heldDistros } from "./environments/machine.js";
import { readResidentPid } from "./resident/resident.js";
import { readResident } from "./resident/supervision.js";
import { registeredDistro } from "./environments/wsl.js";
import { pairingKey, readState } from "./sync/config.js";
import { existingSyncSessions, runMutagen, syncSessionNames } from "./sync/mutagen.js";
import { deviceReport, pairedMutagen } from "./sync/report.js";
import { MACHINE_VERSION } from "./version.js";
import { keyringLine, keyringStatusLine, type KeyringStatusLine, readKeyringSummary } from "./keyring/keyring-status.js";

// What this machine's agent is doing, both halves in one answer: "is my machine connected" and "is my folder
// syncing" are one question to the person asking. `--json` emits what the desktop app's tray and its "This
// device" screen read, so the two cannot drift. Tokens never leave this shape: only identity and grant are
// reported, by construction.
export interface DeviceStatus {
    readonly version: string;
    // The resident agent's pid, absent when it is not running: one agent vouches for both halves.
    readonly running?: number;
    // The whole answer as one sentence, for surfaces with room for exactly one line (the desktop app's tray row
    // above all). Composed here so the tray cannot drift from the terminal.
    readonly summary: string;
    readonly device: {
        readonly links: readonly StatusLink[];
        // When the person at this computer paused agents' mouse and keyboard (ISO 8601), absent while nothing is paused.
        readonly pausedAt?: string;
    };
    readonly sync: DeviceReport;
    // intentic-keyring beside this agent (keyring/keyring-status.ts): installed, running, set up, locked. Never its keys.
    readonly keyring: KeyringStatusLine;
}

// One link, as every surface reads it. `state` is what the resident agent last stamped (device/config.ts) and is
// ABSENT when there is no answer rather than defaulted to one: an agent too old to stamp, or a stamp too old to
// be about now, is a thing this command does not know, not a link that is down.
export interface StatusLink {
    readonly sandboxUrl: string;
    readonly id: string;
    readonly scopes: DeviceScopes;
    readonly state?: PeerLinkState;
}

// The device half of the summary. A count of LINKS is all this could ever say; a count of connected links is
// what it can say once the agent stamps them, and the difference is a tray that read "2 sandboxes connected" on a
// machine that had reached neither. An unknown count keeps the old sentence rather than inventing a worse one.
const linksHalf = (links: number, connected: number | undefined): string | undefined => {
    if (links === 0) {
        return undefined;
    }
    const sandboxes = `sandbox${links === 1 ? "" : "es"}`;
    return connected === undefined || connected === links ? `${links} ${sandboxes} connected` : `${connected} of ${links} ${sandboxes} connected`;
};

// The one-line summary. Health first, since a stopped or stalled agent outranks any count, then the counts in
// the cards' vocabulary, only for the halves in use.
export const statusSummary = (running: number | undefined, links: number, sync: DeviceReport, now: number, connected?: number): string => {
    const working = links > 0 || sync.pairings.length > 0;
    if (!working) {
        return "nothing connected";
    }
    // Sandboxes, not pairings: the folders attached to this computer's sandbox are several pairings of one.
    const sandboxes = new Set(sync.pairings.map((pairing) => pairing.sandboxId)).size;
    const halves = [linksHalf(links, connected), sync.pairings.length === 0 ? undefined : `syncing ${sandboxes} sandbox${sandboxes === 1 ? "" : "es"}`].filter(
        (part) => part !== undefined,
    );
    if (running === undefined) {
        return `NOT RUNNING · ${halves.join(" · ")}`;
    }
    if (sync.pairings.length > 0 && agentStalled(sync.agent, now)) {
        return `STALLED · ${halves.join(" · ")}`;
    }
    // Working, from an agent this machine has already replaced. Ranks below the two failures and above the quiet
    // line, and is named on the tray's one line too, since a user who updated and saw the same number for weeks
    // would otherwise conclude the update hadn't worked.
    const skew = agentBuildSkew(sync.agent);
    if (skew !== undefined) {
        // A agent too old to stamp its own build names only what it is behind: the tray has one line, so "OLD BUILD
        // RUNNING" plus the version that should be serving is what fits and matters.
        const which = skew.running === undefined ? `${skew.installed} installed` : `${skew.running}, ${skew.installed} installed`;
        return `OLD BUILD RUNNING (${which}) · ${halves.join(" · ")}`;
    }
    return halves.join(" · ");
};

export const deviceStatus = async (mutagen: string | undefined): Promise<DeviceStatus> => {
    const [pid, links, sync, stamped, pausedAt, keyring] = await Promise.all([
        readResidentPid(),
        readLinks(),
        deviceReport(mutagen),
        readLinkStates(),
        readPausedAt(),
        readKeyringSummary(),
    ]);
    /* A agent that is not running holds no sockets, so every link is closed and that needs no stamp to know;. */
    const states: readonly (PeerLinkState | undefined)[] = links.map((link) => (pid === undefined ? "closed" : stamped?.[link.sandboxUrl]?.state));
    const connected = states.every((state) => state !== undefined) ? states.filter((state) => state === "open").length : undefined;
    return {
        version: MACHINE_VERSION,
        ...(pid === undefined ? {} : { running: pid }),
        // On the tray's one line too: it is the only place a person at this machine reads without asking.
        summary: `${statusSummary(pid, links.length, sync, Date.now(), connected)}${pausedAt === undefined ? "" : " · mouse and keyboard paused"}`,
        device: {
            links: links.map((link, at) => {
                const state = states[at];
                return { sandboxUrl: link.sandboxUrl, id: link.id, scopes: link.scopes, ...(state === undefined ? {} : { state }) };
            }),
            ...(pausedAt === undefined ? {} : { pausedAt: pausedAt.toISOString() }),
        },
        sync,
        keyring: keyringStatusLine(keyring),
    };
};

// One port row, in the form the two skip reasons are actually asked about: not "why is 6480 missing" but "who
// has it".
export const portItem = (port: DevicePort): Item => {
    const what = port.command ?? "unknown process";
    if (port.state === "mirrored") {
        return { tone: "ok", name: `localhost:${port.port} ← ${port.sandboxId}`, meta: what };
    }
    const reason = port.heldBy === undefined ? "something else on this device has the port" : `${port.heldBy} has it`;
    return { tone: "warn", name: `localhost:${port.port}`, meta: `not mirrored from ${port.sandboxId}: ${reason} (${what})` };
};

// The report carries a pairing's remote dir rather than its kind; the two only ever come together (config.ts
// pairingProblem), so a folder under /work is a project pairing's, and it has no backup session to look for.
const reportedKind = (pairing: DevicePairing): { readonly sandboxId: string; readonly project?: true } =>
    pairing.remoteDir === undefined || pairing.remoteDir === WORKSPACE_ROOT ? { sandboxId: pairing.sandboxId } : { sandboxId: pairing.sandboxId, project: true };

// What a sync pairing's two sessions say, as a list of things that can be wrong, each with how bad it is. A count is
// printed only when it IS a count: `conflicts` is absent whenever Mutagen has none (protobuf JSON omits an empty
// list), never a number to interpolate. A missing session is said and marked as a failure, never blanked.
const fileSyncState = (pairing: DeviceReport["pairings"][number]): readonly (readonly [Tone, string] | undefined)[] => [
    // Mutagen's own word, and the conflict count beside it: a two-way-safe session flags conflicts rather than
    // clobbering.
    pairing.paused === true ? ["warn", "paused"] : pairing.mutagenStatus === undefined ? ["fail", "no file-sync session, this folder is not syncing"] : ["ok", pairing.mutagenStatus],
    pairing.conflicts === undefined || pairing.conflicts === 0 ? undefined : ["fail", plural(pairing.conflicts, "conflict")],
    // The backup's own word, a failure when missing for the same reason as the line above: the value of this session
    // is being there on the day the sandbox is not, and silent absence reads identically to healthy. A project folder
    // has none to miss.
    pairing.paused === true || reportedKind(pairing).project === true
        ? undefined
        : pairing.backupStatus === undefined
          ? ["fail", "backup not running, this sandbox's own state is not being copied here"]
          : ["ok", `backup ${pairing.backupStatus}`],
    // Why it is paused, when the drive is the reason: the one pause the owner can end, by freeing room.
    pairing.lowDisk === undefined ? undefined : ["fail", lowDiskSaid(pairing.lowDisk)],
    ...(pairing.bridgeHolds ?? []).map((hold): readonly [Tone, string] => ["warn", bridgeHoldSaid(hold, Date.now())]),
];

const GIB = 1024 ** 3;

const lowDiskSaid = (low: DeviceLowDisk): string =>
    `paused: its drive has ${(low.freeBytes / GIB).toFixed(1)} GB free of ${(low.totalBytes / GIB).toFixed(0)} GB; resumes by itself once there is room`;

const HOLD_WHY = {
    stalled: "the last fetch stopped moving",
    "too-long": "the last fetch ran out of time",
    shallow: "the sandbox's copy is a shallow clone",
    failed: "git refused the last fetch",
} as const satisfies Record<DeviceBridgeHold["reason"], string>;

// One held repo, said plainly: its files still sync, only its local git history lags.
const bridgeHoldSaid = (hold: DeviceBridgeHold, now: number): string => {
    const minutes = Math.max(1, Math.round((hold.retryAt - now) / 60_000));
    const next = hold.retryAt <= now ? "trying again now" : minutes < 120 ? `next try in ${minutes} min` : `next try in ${Math.round(minutes / 60)} h`;
    return `git history of ${hold.repo} not following the sandbox (${HOLD_WHY[hold.reason]}); ${next}`;
};

// The stuck paths themselves, listed under the pairing that counts them: the count is a symptom, the paths are
// the only part anybody can act on. What happened on each side rides in the words the rest of this output
// uses ("here" is the device you are typing on); an unknown side says nothing rather than guessing.
const CONFLICT_LINES_MAX = 8;

export const CONFLICTS_SAID = "Both ends changed these since they last agreed, so neither copy was overwritten and they have stopped syncing.";
export const CONFLICTS_SETTLED = "Resolve one by making both copies the same, or both gone; the session picks it up on its next pass.";

// `untracked` is not somebody's edit and is never described as one: it is build output under an ignore pattern, sitting
// where sync never looks, and the only reason the deletion on the other side cannot land.
const HERE: Record<DeviceConflictChange, string> = {
    created: "created here",
    modified: "changed here",
    deleted: "deleted here",
    untracked: "build output left here",
};
const IN_SANDBOX: Record<DeviceConflictChange, string> = {
    created: "created in the sandbox",
    modified: "changed in the sandbox",
    deleted: "deleted in the sandbox",
    untracked: "build output left in the sandbox",
};

const conflictItem = (conflict: DeviceConflict): Item => {
    const sides = [
        conflict.local === undefined ? undefined : HERE[conflict.local],
        conflict.sandbox === undefined ? undefined : IN_SANDBOX[conflict.sandbox],
    ].filter((side) => side !== undefined);
    // An empty path is the synced folder itself, which Mutagen reports for a root-level conflict.
    return { tone: "fail", name: conflict.path === "" ? "the folder itself" : conflict.path, meta: sides.join(", ") };
};

export const conflictItems = (pairing: DeviceReport["pairings"][number]): Item[] => {
    const conflicts = pairing.conflictedPaths ?? [];
    if (conflicts.length === 0) {
        return [];
    }
    const shown = conflicts.slice(0, CONFLICT_LINES_MAX);
    // Counted against the pairing's OWN total, not against the list: the report caps what it carries and Mutagen
    // caps what it reports, so "and 30 more" is a fact the shown rows cannot state for themselves.
    const rest = (pairing.conflicts ?? conflicts.length) - shown.length;
    return [...shown.map(conflictItem), ...(rest > 0 ? [{ tone: "skip", name: `… and ${rest} more` } satisfies Item] : [])];
};

const WORST: readonly Tone[] = ["fail", "warn", "ok"];

// One pairing's row, pure and exported since every word of it has been wrong at least once. The glyph is the worst
// thing the row says.
export const pairingItem = (pairing: DeviceReport["pairings"][number]): Item => {
    // This device's own sandbox holds no folder: the folders attached to it have rows of their own.
    if (pairing.projectsHost === true) {
        return {
            tone: pairing.mirroring === "off" ? "warn" : "ok",
            name: pairing.sandboxId,
            meta: `this device's sandbox: folders attach to it${pairing.mirroring === "off" ? " · port mirroring off" : ""}`,
        };
    }
    const folder = pairing.localDir ?? "no folder";
    const where = pairing.mode === "sync" ? (reportedKind(pairing).project === true ? `${folder} ↔ ${pairing.remoteDir}` : folder) : "ports only";
    const state = [
        // Mirroring being off is stated on both modes, since it is a switch somebody threw and its only other evidence
        // (an empty port list) is identical to a sandbox serving nothing. Absent means on.
        pairing.mirroring === "off" ? (["warn", "port mirroring off"] as const) : undefined,
        ...(pairing.mode === "sync" ? fileSyncState(pairing) : []),
        // A folder that takes landed work by itself says so, since nothing else on the row would.
        pairing.deliver === "auto" ? (["ok", "landed work delivered here"] as const) : undefined,
    ].filter((part) => part !== undefined);
    const tone = WORST.find((worst) => state.some(([said]) => said === worst)) ?? "ok";
    return { tone, name: pairing.sandboxId, meta: [where, ...state.map(([, text]) => text)].join(" · ") };
};

// The agent's row: running, stopped, or the third state that had no words, a live process whose sync agent is
// gone. The agent holds its tunnel listeners on the event loop, so anything that escapes it leaves a process
// that is alive with mirroring and the git bridge stopped underneath; a pid is not a pulse, the stamp the agent
// writes at the end of each pass is (sync/config.ts).
export const agentItem = (agent: DeviceReport["agent"], now: number): Item => {
    if (!agent.running) {
        return { tone: "fail", name: "agent", meta: "not running: file sync and port mirroring are stopped" };
    }
    const since = agent.lastTickAt === undefined ? undefined : now - agent.lastTickAt;
    if (agentStalled(agent, now) && since !== undefined) {
        return {
            tone: "fail",
            name: "agent",
            meta: `sync stalled (pid ${agent.pid}): its last full pass was ${plural(Math.round(since / 60_000), "minute")} ago`,
        };
    }
    // An agent too old to stamp reports no lastTickAt at all, and so does one whose first pass hasn't finished.
    // Neither is a stall and neither is a clean bill of health, so the row says which it is rather than picking one.
    return since === undefined
        ? { tone: "ok", name: "agent", meta: `running (pid ${agent.pid}), no sync pass reported yet` }
        : { tone: "ok", name: "agent", meta: `running (pid ${agent.pid}), last sync pass ${Math.round(since / 1000)}s ago` };
};

// What a row too short to say it leaves out about the agent: why a stall matters, and why no pass is not a fault.
export const agentNote = (agent: DeviceReport["agent"], now: number): string | undefined => {
    if (!agent.running) {
        return undefined;
    }
    if (agent.lastTickAt === undefined) {
        return "A pass finishes within seconds of startup; an agent older than this one never reports them.";
    }
    return agentStalled(agent, now)
        ? "The process is alive, but port mirroring, the git bridge and any file sync it has not created yet are stopped."
        : undefined;
};

// The agent is fine and it is the wrong build, a sentence this output had no way to write before: the version
// in the header is the file's, and a device updated but never restarted printed a clean bill of health
// with the old agent's behaviour underneath.
export const buildSkewItem = (report: DeviceReport): Item | undefined => {
    const skew = agentBuildSkew(report.agent);
    if (skew === undefined) {
        return undefined;
    }
    // A agent that predates the build stamp cannot name itself, and that is the furthest-behind case rather than an
    // unknown one.
    const which =
        skew.running === undefined
            ? `running a build older than the ${skew.installed} installed on this device, too old to report its own version`
            : `running ${skew.running}, but ${skew.installed} is installed on this device`;
    return { tone: "warn", name: "agent build", meta: which };
};

// Where this environment sits in its PC, said beside the agent it describes: who restarts it, and what it keeps running.
export const placeLine = (distro: string | undefined, supervisor: string | undefined, children: readonly string[]): string | undefined => {
    if (distro !== undefined) {
        return supervisor === "windows"
            ? `the WSL distro ${distro}, kept running and updated together with this device's Windows side`
            : `the WSL distro ${distro}, running on its own: no agent on this device's Windows side keeps it up`;
    }
    return children.length === 0 ? undefined : `this device's Windows side, keeping ${children.join(", ")} running and updated to the same release`;
};

/* ONE LINK'S ROW, and the word in it that was not earned. The grant beside it is the cached one, said as such: the
   sandbox's card is the source of truth, and saying so stops a stale row here from being read as current. */
export const linkItem = (link: StatusLink): Item => {
    switch (link.state) {
        case "open":
            return { tone: "ok", name: link.sandboxUrl, meta: `connected as ${link.id}` };
        case "connecting":
            return { tone: "warn", name: link.sandboxUrl, meta: `not connected (retrying) as ${link.id}` };
        case "closed":
            return { tone: "fail", name: link.sandboxUrl, meta: `not connected as ${link.id}` };
        default:
            return { tone: "skip", name: link.sandboxUrl, meta: `linked as ${link.id}, not known whether the link is up` };
    }
};

export const grantLine = (link: StatusLink): string =>
    `Last granted by the sandbox: commands ${link.scopes.shell}, writes ${link.scopes.write}, screen ${link.scopes.screen}; folders ${link.scopes.roots ?? "your home folder"}.`;

interface StatusFlags {
    readonly json: boolean;
    readonly verbose: boolean;
}

const RESTART: Footnote = ["restart the agent", "intentic-machine run"];

// The sync half, as rows: each pairing with the paths it is stuck on under it, then the ports. A section over nothing
// is a question the output raises and does not answer, so an empty one is simply absent.
const drawSync = (ui: Ui, report: DeviceReport): Footnote[] => {
    const later: Footnote[] = [];
    if (report.pairings.length > 0) {
        ui.section(`paired sandboxes (${report.pairings.length})`);
        ui.items(report.pairings.map(pairingItem));
        for (const pairing of report.pairings) {
            const stuck = conflictItems(pairing);
            if (stuck.length > 0) {
                ui.section(`${plural(pairing.conflicts ?? stuck.length, "conflict")} in ${pairing.localDir ?? pairing.sandboxId}`);
                ui.note(CONFLICTS_SAID);
                ui.items(stuck);
                ui.note(CONFLICTS_SETTLED);
            }
        }
    }
    if (report.ports.length > 0) {
        ui.section(`ports (${report.ports.length})`);
        ui.items(report.ports.map(portItem));
    }
    // A pairing whose mirroring is off has no port rows, which is exactly what a sandbox serving nothing looks like; the
    // row says which it is, and this is the command that undoes it.
    for (const sandboxId of new Set(report.pairings.filter((held) => held.mirroring === "off").map((held) => held.sandboxId))) {
        later.push([`mirror ${sandboxId} again`, `intentic-machine sync mirror on --sandbox ${sandboxId}`]);
    }
    return later;
};

// Mutagen's sessions, judged from the state rather than the report, which carries no key to name an attached folder's
// session by: a pairing whose session does not exist is named as a failure. `mutagen sync list a b` is
// all-or-nothing, so the raw listing (--verbose) asks only for the sessions that exist.
const drawSessions = async (ui: Ui, mutagen: string, verbose: boolean): Promise<void> => {
    const syncing = (await readState()).pairings.filter((pairing) => pairing.mode === "sync" && pairing.projectsHost !== true);
    // Both of a pairing's sessions: the workspace and the state backup that rides beside it. Listing only the first
    // would report a healthy sync while the backup was not running at all.
    const wanted = syncing.flatMap((pairing) => syncSessionNames(pairing));
    const answered = syncing.length === 0 ? [] : existingSyncSessions(mutagen, wanted);
    // A daemon that is not running is said as that, never started by asking (sync/mutagen-env.ts) and never read as
    // every session missing; Mutagen's own listings would only fail on it.
    if (answered === undefined) {
        ui.section("file sync");
        ui.warn("Mutagen's daemon is not running, or did not answer, so no session could be read. The agent starts it as it syncs.");
        return;
    }
    const live = new Set(answered);
    const missing = syncing.filter((held) => !syncSessionNames(held).every((name) => live.has(name)));
    if (missing.length > 0) {
        ui.section("file sync");
        ui.items(
            missing.map((pairing) => ({
                tone: "fail",
                name: pairingKey(pairing),
                meta: `${pairing.localDir ?? "its folder"} is not syncing: no file-sync session exists on this device`,
            })),
        );
        ui.note("The agent retries every few minutes. If it stays this way the sandbox is unreachable, and the agent's log says why.");
    }
    if (!verbose) {
        return;
    }
    // Mutagen's own listings, word for word, for whoever asked to see them.
    ui.section("mutagen");
    ui.suspend();
    try {
        if (live.size > 0) {
            runMutagen(mutagen, ["sync", "list", ...wanted.filter((name) => live.has(name))]);
        }
        runMutagen(mutagen, ["forward", "list"]);
    } finally {
        ui.resume();
    }
};

// Status leads with the one-line summary, the same sentence the desktop app's tray shows, so the question a person
// arrives with ("is my device connected, is my folder syncing") is answered before anything is enumerated. The
// agent's liveness comes first among the rows, since a healthy-looking list under a dead agent means every promise below
// it is quietly broken.
export const status = buildCommand<StatusFlags>({
    docs: { brief: "Show what this device's agent is connected to, syncing, and mirroring, and whether it is alive" },
    parameters: {
        flags: {
            json: { kind: "boolean", brief: "Emit the device status as JSON (what the desktop app's tray and screen read)" },
            verbose: { kind: "boolean", brief: "Also print Mutagen's own session and forward listings", default: false },
        },
    },
    async func(this: CommandContext, flags: StatusFlags) {
        const mutagen = await pairedMutagen();
        const report = await deviceStatus(mutagen);
        if (flags.json) {
            // allow(terminal-output): the --json document the desktop app's tray and screen read
            this.process.stdout.write(`${JSON.stringify(report)}\n`);
            return;
        }
        const ui = machineUi(this.process);
        ui.report("intentic · this device", report.summary === "nothing connected" ? undefined : report.summary.toLowerCase());
        if (report.device.links.length === 0 && report.sync.pairings.length === 0) {
            // Both halves arrive from a card in a sandbox's chat, which is the only thing to do next.
            ui.quiet("Nothing is connected. Connect this device from a card in a sandbox's chat.");
            // A keyring set up before anything was linked is still this device's to report.
            if (report.keyring.installed) {
                ui.items([keyringLine(report.keyring)]);
            }
            return;
        }
        // A log has no header, so the summary and the version lead it there.
        ui.plain(report.summary);
        ui.plain(`intentic-machine ${report.version}`);
        const later: Footnote[] = [];
        // The agent's liveness is the whole of sync's liveness, not just mirroring's: it holds the SSH transport every
        // session rides (sync/tunnel.ts).
        const agent = agentItem(report.sync.agent, Date.now());
        const skew = buildSkewItem(report.sync);
        ui.items(skew === undefined ? [agent] : [agent, skew]);
        // The keyring's one row, beside the agent's: a process of its own, alive or not on its own.
        ui.items([keyringLine(report.keyring)]);
        const why = agentNote(report.sync.agent, Date.now());
        if (why !== undefined) {
            ui.note(why);
        }
        if (skew !== undefined) {
            ui.note("The agent keeps the build it started with until it restarts.");
        }
        if (agent.tone === "fail" || skew !== undefined) {
            later.push(RESTART);
        }
        const [distro, held, children] = await Promise.all([registeredDistro(), readResident(), heldDistros().catch(() => [])]);
        const place = placeLine(distro, held?.supervisor, children);
        ui.fields([
            ...(place === undefined ? [] : [["device", place] as const]),
            ["logs", runLogPath],
            ["audit", auditPath],
            ...(report.device.pausedAt === undefined
                ? []
                : [["mouse and keyboard", `paused since ${report.device.pausedAt}, until ${PAUSE_HOTKEY} is pressed while an agent's notice is on screen`] as const]),
        ]);
        // The grants are per sandbox, so a device allowed to run commands for one and only watched by another is the
        // ordinary case and neither answers for the other.
        if (report.device.links.length > 0) {
            ui.section(`linked sandboxes (${report.device.links.length})`);
            for (const link of report.device.links) {
                ui.items([linkItem(link)]);
                ui.note(grantLine(link));
            }
        }
        later.push(...drawSync(ui, report.sync));
        if (mutagen !== undefined) {
            await drawSessions(ui, mutagen, flags.verbose);
        }
        ui.later(later);
    },
});
