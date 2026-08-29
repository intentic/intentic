import type { HostScopes, MachinePort, MachineReport } from "@intentic/sandbox-contract";
import { buildCommand, type CommandContext } from "@stricli/core";
import { watcherStalled } from "@intentic/sandbox-contract";
import { auditPath, readLinks } from "./computer/config.js";
import { runLogPath } from "./config.js";
import { readResidentPid } from "./resident.js";
import { ensureMutagen, existingSyncSessions, runMutagen, syncSessionNames } from "./sync/mutagen.js";
import { machineReport } from "./sync/report.js";
import { MACHINE_VERSION } from "./version.js";

/* WHAT THIS MACHINE'S AGENT IS DOING, both halves in one answer, because "is my machine connected" and "is my
 * folder syncing" are one question to the person asking it and used to be two commands with two liveness stories.
 *
 * `--json` emits the same facts as one shape, what the desktop app's tray row and its "This computer" screen
 * read, so the terminal answer and the on-screen one cannot drift apart, for the same reason the desktop app
 * spawns connect.sh rather than reimplementing it. The sync half rides along as the untouched MachineReport,
 * which is ALSO what the resident loop posts to each sandbox (scoped, report.ts), one producer for every reader.
 *
 * TOKENS NEVER LEAVE THIS SHAPE. The links carry enrollment credentials on disk; what status reports about a
 * link is its identity and its grant, and the omission is by construction (a pick of named fields), not by
 * remembering to delete. */
export interface MachineStatus {
    readonly version: string;
    // The resident loop's pid, absent when it is not running: one loop vouches for both halves.
    readonly running?: number;
    /* The whole answer as ONE SENTENCE, for the surfaces that have room for exactly one line — the desktop
     * app's tray row above all. Composed here, beside every other sentence this command prints, so the tray
     * cannot drift from the terminal: the Rust side reads this field and displays it, and re-deriving it there
     * from the fields below would be one more shape to keep in lockstep. */
    readonly summary: string;
    readonly computer: { readonly links: readonly { readonly sandboxUrl: string; readonly id: string; readonly scopes: HostScopes }[] };
    readonly sync: MachineReport;
}

/* The one-line summary. Health first, because the line exists for the day something is wrong: a stopped or
 * stalled loop outranks any count. Then the counts, in the cards' vocabulary — "connected" for the computer
 * half, "syncing" for the sync half — and only the halves that are in use, so a sync-only machine is not told
 * about a capability it never enabled. */
export const statusSummary = (running: number | undefined, links: number, sync: MachineReport, now: number): string => {
    const working = links > 0 || sync.pairings.length > 0;
    if (!working) {
        return "nothing connected";
    }
    const halves = [
        links === 0 ? undefined : `${links} sandbox${links === 1 ? "" : "es"} connected`,
        sync.pairings.length === 0 ? undefined : `syncing ${sync.pairings.length} sandbox${sync.pairings.length === 1 ? "" : "es"}`,
    ].filter((part) => part !== undefined);
    if (running === undefined) {
        return `NOT RUNNING · ${halves.join(" · ")}`;
    }
    if (sync.pairings.length > 0 && watcherStalled(sync.watcher, now)) {
        return `STALLED · ${halves.join(" · ")}`;
    }
    return halves.join(" · ");
};

export const machineStatus = async (mutagen: string | undefined): Promise<MachineStatus> => {
    const [pid, links, sync] = await Promise.all([readResidentPid(), readLinks(), machineReport(mutagen)]);
    return {
        version: MACHINE_VERSION,
        ...(pid === undefined ? {} : { running: pid }),
        summary: statusSummary(pid, links.length, sync, Date.now()),
        computer: { links: links.map((link) => ({ sandboxUrl: link.sandboxUrl, id: link.id, scopes: link.scopes })) },
        sync,
    };
};

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

/* THE LOOP'S LINE, running, stopped, or the third state that had no words: a live process whose sync loop is
 * gone. That third one is the failure the sync half keeps meeting from a different angle: the loop holds its
 * tunnel listeners on the event loop, so anything that escapes it leaves a process that is alive, a pidfile that
 * is claimed and a systemd unit that is "active", with mirroring and the git bridge stopped underneath. It has
 * now happened twice, and both times every surface said "running". A pid is not a pulse: the stamp the loop
 * writes at the end of each completed pass is (sync/config.ts), and this is where the two are read together.
 *
 * `now` is a parameter so the sentence can be tested without a clock. */
export const watcherLine = (watcher: MachineReport["watcher"], now: number): string => {
    if (!watcher.running) {
        return "Agent: NOT running, file syncing and port mirroring are both stopped. Run `intentic-machine run` to restart it.";
    }
    const since = watcher.lastTickAt === undefined ? undefined : now - watcher.lastTickAt;
    if (watcherStalled(watcher, now) && since !== undefined) {
        return `Agent: sync STALLED (pid ${watcher.pid}), the process is alive but its last full pass finished ${Math.round(since / 60_000)} minute(s) ago, so port mirroring, the git bridge and any file sync it has not created are stopped. Restart it with \`intentic-machine run --stop\` then \`intentic-machine run\`, and check ${runLogPath}.`;
    }
    /* An agent too old to stamp reports no lastTickAt at all, and so does one whose first pass has not finished.
     * Neither is a stall, and neither is a clean bill of health, so the line says which of the two it is rather
     * than picking one, the alternative is the same silent green this field was added to end. */
    return since === undefined
        ? `Agent: running (pid ${watcher.pid}), no completed sync pass reported yet (a pass finishes within seconds of startup; an agent older than this one never reports them).`
        : `Agent: running (pid ${watcher.pid}), last sync pass ${Math.round(since / 1000)}s ago`;
};

const printReport = (report: MachineReport, out: (message: string) => void): void => {
    out(`Paired sandboxes (${report.pairings.length}):`);
    for (const pairing of report.pairings) {
        out(pairingLine(pairing));
    }
    /* The loop's liveness is the whole of sync's liveness, not just mirroring's: it holds the SSH transport
     * every session rides (sync/tunnel.ts), so a dead loop is a stalled file sync and stalled port forwards, not
     * merely "new ports stop appearing". Said plainly, because a softer wording invited a reader to leave it
     * stopped. */
    out(watcherLine(report.watcher, Date.now()));
    out(`Ports (${report.ports.length}):`);
    for (const port of report.ports) {
        out(portLine(port));
    }
};

interface StatusFlags {
    readonly json: boolean;
}

/* Status leads with the COMPUTER LINKS then the PAIRING LIST — which sandboxes may work on this machine, and
 * which it syncs and into which folders — because those are the questions a user actually arrives with. The
 * loop's liveness follows, since a healthy-looking list under a dead loop means every one of those promises is
 * quietly broken. Mutagen's own listings close the human rendering: they carry live transfer progress, which is
 * detail the report deliberately does not model. */
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
        const report = await machineStatus(mutagen);
        if (flags.json) {
            out(JSON.stringify(report));
            return;
        }
        out(
            `Agent:        v${report.version}, ${report.running === undefined ? "NOT running (start it with `intentic-machine run`)" : `running (pid ${report.running})`}`,
        );
        out(`Logs:         ${runLogPath}`);
        out(`Audit:        ${auditPath}`);
        const links = report.computer.links;
        out("");
        out(`Linked sandboxes (${links.length}):`);
        // One block per sandbox, because the grants are per sandbox: a computer allowed to run commands for one
        // and only watched by another is the ordinary case, and a single merged line could not say so.
        for (const link of links) {
            out(`  ${link.sandboxUrl}  connected as ${link.id}`);
            // The cached grant, flagged as such: the sandbox's card is the source of truth, and saying so here is
            // what stops a stale line in this output from being read as the current permissions.
            out(
                `    permissions (last pushed by the sandbox): commands ${link.scopes.shell}, writes ${link.scopes.write}, screen ${link.scopes.screen}; folders ${link.scopes.roots ?? "(your home folder)"}`,
            );
        }
        out("");
        printReport(report.sync, out);
        /* Mutagen's own listing, for the pairings whose session EXISTS, and only those.
         *
         * `mutagen sync list a b` is all-or-nothing: a name it cannot resolve makes it print nothing at all and
         * exit 1, and runMutagen turns that into a throw. So one pairing that had lost its session took the whole
         * command down, no port mirroring section, no exit 0, and an error about a Mutagen "specification" as
         * the only answer to "is my sync working". That is a diagnostic command failing precisely when there is
         * something to diagnose. The missing ones are named here instead; the report above has already said the
         * folder is not syncing. */
        const syncing = report.sync.pairings.filter((pairing) => pairing.mode === "sync");
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
                    `  ${pairing.sandboxId}: no file-sync session exists on this machine, ${pairing.localDir ?? "its folder"} is NOT syncing. The agent retries every few minutes; if it stays this way the sandbox is unreachable (check ${runLogPath}).`,
                );
            }
        }
        out("Port mirroring:");
        runMutagen(mutagen, ["forward", "list"]);
    },
});
