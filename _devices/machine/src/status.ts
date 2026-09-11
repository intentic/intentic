import type { HostScopes, DeviceConflict, DeviceConflictChange, DevicePort, DeviceReport } from "@intentic/sandbox-contract";
import type { PeerLinkState } from "@intentic/sandbox-contract/peer-dial";
import { buildCommand, type CommandContext } from "@stricli/core";
import { agentBuildSkew, agentStalled } from "@intentic/sandbox-contract";
import { auditPath, readLinks, readLinkStates } from "./device/config.js";
import { runLogPath } from "./config.js";
import { readResidentPid } from "./resident.js";
import { ensureMutagen, existingSyncSessions, runMutagen, syncSessionNames } from "./sync/mutagen.js";
import { deviceReport } from "./sync/report.js";
import { MACHINE_VERSION } from "./version.js";

// What this machine's agent is doing, both halves in one answer: "is my machine connected" and "is my folder
// syncing" are one question to the person asking. `--json` emits what the desktop app's tray and its "This
// device" screen read, so the two cannot drift. Tokens never leave this shape: only identity and grant are
// reported, by construction.
export interface DeviceStatus {
    readonly version: string;
    // The resident loop's pid, absent when it is not running: one loop vouches for both halves.
    readonly running?: number;
    // The whole answer as one sentence, for surfaces with room for exactly one line (the desktop app's tray row
    // above all). Composed here so the tray cannot drift from the terminal.
    readonly summary: string;
    readonly device: { readonly links: readonly StatusLink[] };
    readonly sync: DeviceReport;
}

// One link, as every surface reads it. `state` is what the resident loop last stamped (device/config.ts) and is
// ABSENT when there is no answer rather than defaulted to one: an agent too old to stamp, or a stamp too old to
// be about now, is a thing this command does not know, not a link that is down.
export interface StatusLink {
    readonly sandboxUrl: string;
    readonly id: string;
    readonly scopes: HostScopes;
    readonly state?: PeerLinkState;
}

// The device half of the summary. A count of LINKS is all this could ever say; a count of connected links is
// what it can say once the loop stamps them, and the difference is a tray that read "2 sandboxes connected" on a
// machine that had reached neither. An unknown count keeps the old sentence rather than inventing a worse one.
const linksHalf = (links: number, connected: number | undefined): string | undefined => {
    if (links === 0) {
        return undefined;
    }
    const sandboxes = `sandbox${links === 1 ? "" : "es"}`;
    return connected === undefined || connected === links ? `${links} ${sandboxes} connected` : `${connected} of ${links} ${sandboxes} connected`;
};

// The one-line summary. Health first, since a stopped or stalled loop outranks any count, then the counts in
// the cards' vocabulary, only for the halves in use.
export const statusSummary = (running: number | undefined, links: number, sync: DeviceReport, now: number, connected?: number): string => {
    const working = links > 0 || sync.pairings.length > 0;
    if (!working) {
        return "nothing connected";
    }
    const halves = [
        linksHalf(links, connected),
        sync.pairings.length === 0 ? undefined : `syncing ${sync.pairings.length} sandbox${sync.pairings.length === 1 ? "" : "es"}`,
    ].filter((part) => part !== undefined);
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
        // A loop too old to stamp its own build names only what it is behind: the tray has one line, so "OLD BUILD
        // RUNNING" plus the version that should be serving is what fits and matters.
        const which = skew.running === undefined ? `${skew.installed} installed` : `${skew.running}, ${skew.installed} installed`;
        return `OLD BUILD RUNNING (${which}) · ${halves.join(" · ")}`;
    }
    return halves.join(" · ");
};

export const deviceStatus = async (mutagen: string | undefined): Promise<DeviceStatus> => {
    const [pid, links, sync, stamped] = await Promise.all([readResidentPid(), readLinks(), deviceReport(mutagen), readLinkStates()]);
    /* A loop that is not running holds no sockets, so every link is closed and that needs no stamp to know; a
     * loop that IS running is the only thing that knows, and its stamp is the whole answer. Neither leaves the
     * question open, which the shape carries as an absent `state` and every surface below reports as unknown. */
    const states: readonly (PeerLinkState | undefined)[] = links.map((link) => (pid === undefined ? "closed" : stamped?.[link.sandboxUrl]));
    const connected = states.every((state) => state !== undefined) ? states.filter((state) => state === "open").length : undefined;
    return {
        version: MACHINE_VERSION,
        ...(pid === undefined ? {} : { running: pid }),
        summary: statusSummary(pid, links.length, sync, Date.now(), connected),
        device: {
            links: links.map((link, at) => {
                const state = states[at];
                return { sandboxUrl: link.sandboxUrl, id: link.id, scopes: link.scopes, ...(state === undefined ? {} : { state }) };
            }),
        },
        sync,
    };
};

// One port row, in the form the two skip reasons are actually asked about: not "why is 6480 missing" but "who
// has it".
const portLine = (port: DevicePort): string => {
    const what = port.command ?? "unknown process";
    if (port.state === "mirrored") {
        return `  localhost:${port.port} ← ${port.sandboxId} (${what})`;
    }
    const reason = port.heldBy === undefined ? "something else on this machine has the port" : `${port.heldBy} has it`;
    return `  localhost:${port.port}, NOT mirrored from ${port.sandboxId}: ${reason} (${what})`;
};

// One pairing's line, pure and exported since every word of it has been wrong at least once. A count is
// printed only when it IS a count: `conflicts` is absent whenever Mutagen has none (protobuf JSON omits an
// empty list), never a number to interpolate. A missing session is shouted, not blanked.
// The two sessions a sync pairing runs, split out so the sentence below stays a list of things that can be
// wrong rather than a nest of conditionals.
const fileSyncState = (pairing: DeviceReport["pairings"][number]): (string | undefined)[] => [
    // Mutagen's own word, and the conflict count beside it: a two-way-safe session flags conflicts rather than
    // clobbering.
    pairing.paused === true ? "paused" : (pairing.mutagenStatus ?? "NO FILE-SYNC SESSION, this folder is not syncing"),
    pairing.conflicts === undefined || pairing.conflicts === 0 ? undefined : `${pairing.conflicts} conflict(s)`,
    // The backup's own word, shouted when missing for the same reason as the line above: the value of this session
    // is being there on the day the sandbox is not, and silent absence reads identically to healthy.
    pairing.paused === true ? undefined : `backup ${pairing.backupStatus ?? "NOT RUNNING, this sandbox's own state is not being copied here"}`,
];

// The stuck paths themselves, printed under the line that counts them: the count is a symptom, the paths are
// the only part anybody can act on. What happened on each side rides in the words the rest of this output
// uses ("here" is the machine you are typing on); an unknown side says nothing rather than guessing.
const CONFLICT_LINES_MAX = 8;

const HERE: Record<DeviceConflictChange, string> = { created: "created here", modified: "changed here", deleted: "deleted here" };
const IN_SANDBOX: Record<DeviceConflictChange, string> = {
    created: "created in the sandbox",
    modified: "changed in the sandbox",
    deleted: "deleted in the sandbox",
};

const conflictLine = (conflict: DeviceConflict): string => {
    // An empty path is the synced folder itself, which Mutagen reports for a root-level conflict.
    const what = conflict.path === "" ? "(the folder itself)" : conflict.path;
    const sides = [
        conflict.local === undefined ? undefined : HERE[conflict.local],
        conflict.sandbox === undefined ? undefined : IN_SANDBOX[conflict.sandbox],
    ].filter((side) => side !== undefined);
    return `    ${what}${sides.length === 0 ? "" : `  (${sides.join(", ")})`}`;
};

export const conflictLines = (pairing: DeviceReport["pairings"][number]): string[] => {
    const conflicts = pairing.conflictedPaths ?? [];
    if (conflicts.length === 0) {
        return [];
    }
    const shown = conflicts.slice(0, CONFLICT_LINES_MAX);
    // Counted against the pairing's OWN total, not against the list: the report caps what it carries and Mutagen
    // caps what it reports, so "and 30 more" is a fact the shown rows cannot state for themselves.
    const rest = (pairing.conflicts ?? conflicts.length) - shown.length;
    return [
        "    Both ends changed these since they last agreed, so neither copy was overwritten and they have stopped syncing:",
        ...shown.map(conflictLine),
        ...(rest > 0 ? [`    … and ${rest} more`] : []),
        "    Resolve one by making both copies the same (or both gone); the session picks it up on its next pass.",
    ];
};

export const pairingLine = (pairing: DeviceReport["pairings"][number]): string => {
    const where = pairing.mode === "sync" ? (pairing.localDir ?? "(no folder)") : "(ports only)";
    const state = [
        // Mirroring being off is stated on both modes and loudly, since it is a switch somebody threw and its only
        // other evidence (an empty port list) is identical to a sandbox serving nothing. Absent means on.
        pairing.mirroring === "off" ? "port mirroring OFF" : undefined,
        ...(pairing.mode === "sync" ? fileSyncState(pairing) : []),
    ].filter((part) => part !== undefined);
    return `  ${pairing.sandboxId}  ${where}${state.length === 0 ? "" : `  [${state.join(", ")}]`}`;
};

// The loop's line: running, stopped, or the third state that had no words, a live process whose sync loop is
// gone. The loop holds its tunnel listeners on the event loop, so anything that escapes it leaves a process
// that is alive with mirroring and the git bridge stopped underneath; a pid is not a pulse, the stamp the loop
// writes at the end of each pass is (sync/config.ts).
export const agentLine = (agent: DeviceReport["agent"], now: number): string => {
    if (!agent.running) {
        return "Agent: NOT running, file syncing and port mirroring are both stopped. Run `intentic-machine run` to restart it.";
    }
    const since = agent.lastTickAt === undefined ? undefined : now - agent.lastTickAt;
    if (agentStalled(agent, now) && since !== undefined) {
        return `Agent: sync STALLED (pid ${agent.pid}), the process is alive but its last full pass finished ${Math.round(since / 60_000)} minute(s) ago, so port mirroring, the git bridge and any file sync it has not created are stopped. Restart it with \`intentic-machine run --stop\` then \`intentic-machine run\`, and check ${runLogPath}.`;
    }
    // An agent too old to stamp reports no lastTickAt at all, and so does one whose first pass hasn't finished.
    // Neither is a stall and neither is a clean bill of health, so the line says which it is rather than picking one.
    return since === undefined
        ? `Agent: running (pid ${agent.pid}), no completed sync pass reported yet (a pass finishes within seconds of startup; an agent older than this one never reports them).`
        : `Agent: running (pid ${agent.pid}), last sync pass ${Math.round(since / 1000)}s ago`;
};

// The loop is fine and it is the wrong build, a sentence this output had no way to write before: the version
// on the first line is the file's, and a machine updated but never restarted printed a clean bill of health
// with the old agent's behaviour underneath.
export const buildSkewLine = (report: DeviceReport): string | undefined => {
    const skew = agentBuildSkew(report.agent);
    if (skew === undefined) {
        return undefined;
    }
    // A loop that predates the build stamp cannot name itself, and that is the furthest-behind case rather than an
    // unknown one.
    const which =
        skew.running === undefined
            ? `Agent: running a build older than the ${skew.installed} installed on this machine (too old to report its own version)`
            : `Agent: running ${skew.running}, but ${skew.installed} is installed on this machine`;
    return `${which} — the loop keeps the build it started with. Restart it with \`intentic-machine run --stop\` then \`intentic-machine run\`.`;
};

/* ONE LINK'S LINE, and the word in it that was not earned. "connected" is a claim about a socket, and this
 * printed it from the link list alone: a sandbox unreachable for hours read exactly like a healthy one, on the
 * command whose entire job is to say which of the two you have. The permissions line beneath it had been hedged
 * as "last pushed by the sandbox" for the same reason and this line had not. Unknown now says so in words rather
 * than picking the reassuring one. */
export const linkLine = (link: StatusLink): string => {
    switch (link.state) {
        case "open":
            return `  ${link.sandboxUrl}  connected as ${link.id}`;
        case "connecting":
            return `  ${link.sandboxUrl}  NOT connected (retrying) as ${link.id}`;
        case "closed":
            return `  ${link.sandboxUrl}  NOT connected as ${link.id}`;
        default:
            return `  ${link.sandboxUrl}  linked as ${link.id} (this machine's agent doesn't report whether the link is up)`;
    }
};

const printReport = (report: DeviceReport, out: (message: string) => void): void => {
    out(`Paired sandboxes (${report.pairings.length}):`);
    for (const pairing of report.pairings) {
        out(pairingLine(pairing));
        // Only a pairing holding conflicts prints anything more than its own line, so a healthy machine's output is
        // exactly what it always was.
        for (const line of conflictLines(pairing)) {
            out(line);
        }
    }
    // The loop's liveness is the whole of sync's liveness, not just mirroring's: it holds the SSH transport every
    // session rides (sync/tunnel.ts).
    out(agentLine(report.agent, Date.now()));
    const skew = buildSkewLine(report);
    if (skew !== undefined) {
        out(skew);
    }
    out(`Ports (${report.ports.length}):`);
    for (const port of report.ports) {
        out(portLine(port));
    }
    // A pairing whose mirroring is off has no rows above, which is exactly what a sandbox serving nothing looks
    // like; say which it is, and say the command that undoes it.
    for (const pairing of report.pairings.filter((held) => held.mirroring === "off")) {
        out(`  ${pairing.sandboxId}: port mirroring is OFF here. Put its ports back with \`intentic-machine sync mirror on --sandbox ${pairing.sandboxId}\`.`);
    }
};

interface StatusFlags {
    readonly json: boolean;
}

// Status leads with the device links then the pairing list, since those are the questions a user arrives with.
// The loop's liveness follows, since a healthy-looking list under a dead loop means every promise is quietly
// broken.
export const status = buildCommand<StatusFlags>({
    docs: { brief: "Show what this machine's agent is connected to, syncing, and mirroring, and whether it is alive" },
    parameters: {
        flags: {
            json: { kind: "boolean", brief: "Emit the machine status as JSON (what the desktop app's tray and screen read)" },
        },
    },
    async func(this: CommandContext, flags: StatusFlags) {
        const out = (message: string): void => void this.process.stdout.write(`${message}\n`);
        const mutagen = await ensureMutagen();
        const report = await deviceStatus(mutagen);
        if (flags.json) {
            out(JSON.stringify(report));
            return;
        }
        out(
            `Agent:        v${report.version}, ${report.running === undefined ? "NOT running (start it with `intentic-machine run`)" : `running (pid ${report.running})`}`,
        );
        out(`Logs:         ${runLogPath}`);
        out(`Audit:        ${auditPath}`);
        const links = report.device.links;
        out("");
        out(`Linked sandboxes (${links.length}):`);
        // One block per sandbox, since the grants are per sandbox: a device allowed to run commands for one and only
        // watched by another is the ordinary case.
        for (const link of links) {
            out(linkLine(link));
            // The cached grant, flagged as such: the sandbox's card is the source of truth, and saying so stops a stale
            // line here from being read as current.
            out(
                `    permissions (last pushed by the sandbox): commands ${link.scopes.shell}, writes ${link.scopes.write}, screen ${link.scopes.screen}; folders ${link.scopes.roots ?? "(your home folder)"}`,
            );
        }
        out("");
        printReport(report.sync, out);
        // Mutagen's own listing, for pairings whose session EXISTS, and only those: `mutagen sync list a b` is
        // all-or-nothing, so one pairing with a lost session used to take the whole command down. The missing ones are
        // named here instead.
        const syncing = report.sync.pairings.filter((pairing) => pairing.mode === "sync");
        if (syncing.length > 0) {
            out("File sync:");
            // Both of a pairing's sessions: the workspace and the state backup that rides beside it. Listing only the
            // first would report a healthy sync while the backup was not running at all.
            const wanted = syncing.flatMap((pairing) => syncSessionNames(pairing.sandboxId));
            const live = new Set(existingSyncSessions(mutagen, wanted));
            if (live.size > 0) {
                runMutagen(mutagen, ["sync", "list", ...wanted.filter((name) => live.has(name))]);
            }
            for (const pairing of syncing.filter((held) => !syncSessionNames(held.sandboxId).every((name) => live.has(name)))) {
                out(
                    `  ${pairing.sandboxId}: no file-sync session exists on this machine, ${pairing.localDir ?? "its folder"} is NOT syncing. The agent retries every few minutes; if it stays this way the sandbox is unreachable (check ${runLogPath}).`,
                );
            }
        }
        out("Port mirroring:");
        runMutagen(mutagen, ["forward", "list"]);
    },
});
