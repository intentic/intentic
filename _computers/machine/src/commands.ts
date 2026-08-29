import { setTimeout as sleep } from "node:timers/promises";
import { buildCommand, buildRouteMap, type CommandContext } from "@stricli/core";
import { computerCommands, computerUninstall } from "./computer/commands.js";
import { readResidentPid, reconcileResidency, runForeground, stopResident } from "./resident.js";
import { status } from "./status.js";
import { syncCommands, syncUninstall } from "./sync/commands.js";
import { assetUrl, realUpgradeExec, runUpgrade, upgradeMessage } from "./upgrade.js";
import { MACHINE_VERSION } from "./version.js";

/* `intentic-machine`, the one agent that lives on a user's own computer.
 *
 * Two route groups carry the two capabilities, in the cards' own vocabulary:
 *   computer   let a sandbox work on this machine (setup / uninstall) — the "Connect this computer" card.
 *   sync       mirror folders and ports with a sandbox (setup / pause / resume / uninstall) — the Desktop
 *              sync card.
 *
 * Everything resident is shared and lives at the top level: `run` is the ONE loop serving both halves,
 * `status` answers for both, `upgrade` replaces the one binary, and bare `uninstall` removes everything. */

interface RunFlags {
    readonly foreground: boolean;
    readonly stop: boolean;
}

const run = buildCommand<RunFlags>({
    docs: { brief: "Run this machine's agent: sandbox connections, file sync, port mirroring (setup starts this for you)" },
    parameters: {
        flags: {
            foreground: { kind: "boolean", brief: "Run the loop in this terminal instead of the background" },
            stop: { kind: "boolean", brief: "Stop the background loop" },
        },
    },
    async func(this: CommandContext, flags: RunFlags) {
        const out = (message: string): void => void this.process.stdout.write(`${message}\n`);
        if (flags.stop) {
            const pid = await stopResident();
            out(pid === undefined ? "not running." : `stopped (pid ${pid}).`);
            return;
        }
        if (!flags.foreground) {
            // Through the same reconcile every setup runs: covers this session AND repairs a missing or stale
            // login entry while it is at it, so `run` after a botched install is a fix, not just a start.
            await reconcileResidency(out);
            return;
        }
        // The log is long-lived, so bare lines in it are useless: every line is stamped.
        await runForeground((message) => void this.process.stdout.write(`[${new Date().toISOString()}] ${message}\n`));
    },
});

/* The build this agent is, on stdout, and nothing else on it. Deliberately bare rather than "intentic-machine
 * x.y.z": it is read by a person asking one question, by the release build proving the version stamp reached the
 * binary, and by `upgrade` vetting a freshly downloaded one before it installs it, and the last two want the
 * string, not a sentence around it. */
const version = buildCommand({
    docs: { brief: "Print this agent's version" },
    parameters: {},
    func(this: CommandContext) {
        this.process.stdout.write(`${MACHINE_VERSION}\n`);
        return Promise.resolve();
    },
});

// How long to give a just-started loop to claim its pidfile before calling the upgrade a failure and rolling
// back. It writes the file as its first act, so this is bounded by process startup, not by any work it does.
const RESIDENT_START_TIMEOUT_MS = 10_000;
const RESIDENT_START_POLL_MS = 200;

const residentCameUp = async (): Promise<boolean> => {
    for (let waited = 0; waited < RESIDENT_START_TIMEOUT_MS; waited += RESIDENT_START_POLL_MS) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- a bounded wait on one pidfile, by definition serial
        if ((await readResidentPid()) !== undefined) {
            return true;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- same
        await sleep(RESIDENT_START_POLL_MS);
    }
    return false;
};

/* Move this machine onto the current agent. WITHOUT a pairing token, which is the entire point. Updating and
 * enrolling had been the same command, so the cost of a version bump was a trip to the browser for a single-use
 * token that expires in ten minutes; the predictable result was machines running whatever was current the day
 * they were paired, indefinitely.
 *
 * Links, pairings, keys, ssh config, Mutagen sessions and mirrored ports are all untouched: this replaces one
 * file and restarts one background process. Everything that can fail is checked before the swap, and the one
 * thing that cannot be checked in advance, whether the new agent stays up on THIS machine, is rolled back
 * automatically (upgrade.ts). */
interface UpgradeFlags {
    readonly force: boolean;
}

const upgrade = buildCommand<UpgradeFlags>({
    docs: { brief: "Download and install the current agent, then restart the background loop" },
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
        const exec = realUpgradeExec(stopResident, async () => await reconcileResidency(() => undefined), residentCameUp);
        out(upgradeMessage(await runUpgrade(exec, assetUrl(), MACHINE_VERSION, flags.force, out)));
    },
});

// Everything, both halves, in one command: what "remove intentic from this machine" should cost. Sync goes
// first because its teardown talks to Mutagen and the sandboxes while credentials still exist; the computer
// half's reconcile then finds nothing on either side and retires the loop and the login entry.
const uninstall = buildCommand({
    docs: { brief: "Remove this machine's agent entirely: every sandbox link, every sync pairing, the login entry" },
    parameters: {},
    async func(this: CommandContext) {
        const out = (message: string): void => void this.process.stdout.write(`${message}\n`);
        await syncUninstall(out);
        await computerUninstall(out);
        out("Nothing intentic stays resident on this machine.");
    },
});

export const commands = {
    computer: buildRouteMap({
        routes: computerCommands,
        docs: { brief: "Let a sandbox work on this computer (the Connect-this-computer card)" },
    }),
    sync: buildRouteMap({
        routes: syncCommands,
        docs: { brief: "Mirror a sandbox's files and ports onto this machine (the Desktop sync card)" },
    }),
    run,
    status,
    version,
    upgrade,
    uninstall,
};
