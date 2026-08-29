import { rm } from "node:fs/promises";
import {
    cliLauncher,
    createUi,
    livePid,
    type Log,
    type PlanStep,
    registerAutostart,
    spawnDetached,
    type Ui,
    unregisterAutostart,
    writeSecretFile,
} from "@intentic/local-agent";
import { buildCommand, type CommandContext } from "@stricli/core";
import { HOST_AUTOSTART } from "./autostart.js";
import { auditPath, baseDir, configPath, type HostLink, readLinks, removeLinks, runLogPath, runPidPath, upsertLink } from "./config.js";
import { connect } from "./connection.js";
import { HOST_VERSION } from "./version.js";

/* `intentic-host`, the agent that lets an intentic sandbox work on this computer.
 *
 *   setup      redeem the sandbox's one-time pairing, then connect and stay connected at every login.
 *   run        the connection loop: detached by default, --foreground to watch it, --stop to stop it.
 *   status     what this machine is connected to, whether it is up, and what it is allowed to do.
 *   uninstall  disconnect, deregister, forget the credential. Leaves the audit log behind, on purpose.
 *
 * There is no OAuth here and no browser: everything trusts the pairing token the owner minted in the sandbox's
 * UI, which is worth exactly one enrollment and expires in minutes. */

// Redeem the pairing for this machine's durable token. Retried through a tunnel that may still be warming (the
// sync agent's lesson: Cloudflare's edge answers before the origin registers), but never through a 401, an
// expired pairing is a definitive answer, and retrying it only delays the "click Connect again" the user needs.
const enroll = async (
    sandboxUrl: string,
    pairToken: string,
    { attempts = 10, delayMs = 3000 }: { attempts?: number; delayMs?: number } = {},
): Promise<{ id: string; hostToken: string }> => {
    const url = `${sandboxUrl.replace(/\/$/, "")}/system/hosts/enroll`;
    for (let attempt = 1; ; attempt++) {
        let response: Response;
        try {
            response = await fetch(url, { method: "POST", headers: { "x-intentic-pair": pairToken } });
        } catch (error) {
            if (attempt >= attempts) {
                throw error;
            }
            process.stderr.write(`connecting: the sandbox isn't reachable yet, retrying (${attempt}/${attempts})…\n`);
            await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
            continue;
        }
        if (response.status === 401) {
            throw new Error("that pairing has expired: click Connect again on the computer's card in your sandbox for a fresh command.");
        }
        if (response.status >= 500 && attempt < attempts) {
            process.stderr.write(`connecting: the sandbox is warming up (HTTP ${response.status}), retrying (${attempt}/${attempts})…\n`);
            await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
            continue;
        }
        if (!response.ok) {
            throw new Error(`connecting this computer failed (${response.status}): ${await response.text()}`);
        }
        return (await response.json()) as { id: string; hostToken: string };
    }
};

// Idempotent: a live connection already covers this machine, so a second start is a no-op.
const startDetached = async (log: Log): Promise<void> => {
    const existing = await livePid(runPidPath);
    if (existing !== undefined) {
        log(`already connected (pid ${existing}).`);
        return;
    }
    const pid = await spawnDetached(runLogPath, cliLauncher("intentic-host"), HOST_AUTOSTART.foregroundArgs);
    log(`connected in the background (pid ${pid}). Details: ${runLogPath}`);
};

const stopDetached = async (log: Log): Promise<void> => {
    const pid = await livePid(runPidPath);
    if (pid === undefined) {
        log("not running.");
        return;
    }
    process.kill(pid, "SIGTERM");
    await rm(runPidPath, { force: true });
    log(`stopped (pid ${pid}).`);
};

interface SetupFlags {
    readonly url: string;
    readonly pair: string;
}

const setup = buildCommand<SetupFlags>({
    docs: { brief: "Connect this computer to an intentic sandbox using a one-time pairing token" },
    parameters: {
        flags: {
            url: { kind: "parsed", parse: String, brief: "The sandbox's URL (e.g. https://sandbox-xxx.example.dev)" },
            pair: { kind: "parsed", parse: String, brief: "The one-time pairing token from the computer's capability card" },
        },
    },
    async func(this: CommandContext, flags: SetupFlags) {
        /* Rendered through the shared renderer (@intentic/local-agent), the same one `ic` and the sync agent
         * render through, so a person meeting two of them in one install meets one program. `ic` runs this
         * command inside its own checklist and sets INTENTIC_UI=nested, which turns everything below into
         * detail under ITS step rather than a second banner in the middle of somebody's setup. */
        const ui = createUi(this.process);
        const out: Log = ui.note;
        ui.begin("intentic · connect this computer", SETUP_PLAN);
        try {
            await runSetup(ui, out, flags);
        } finally {
            ui.close();
        }
    },
});

/* Two steps, and the second is the one that can be slow, registering an autostart entry touches systemd,
 * launchd or the Windows Task Scheduler, and starting the resident agent waits on a detached process. Phases
 * are this agent's own vocabulary and deliberately absent from the desktop app's plan (setupPlan.ts), where an
 * unknown phase reads as narration under whichever step is running. */
const SETUP_PLAN: readonly PlanStep[] = [
    { phase: "computer-enrolling", label: "Enrol this computer", weight: 10 },
    { phase: "computer-starting", label: "Start the agent", weight: 15 },
];

const runSetup = async (ui: Ui, out: Log, flags: SetupFlags): Promise<void> => {
    ui.step("computer-enrolling", "enrolling this computer with your sandbox…");
    const { id, hostToken } = await enroll(flags.url, flags.pair);
    /* The cached grant starts at NOTHING. The sandbox pushes the real scopes within a second of connecting,
     * so this only governs the window before that, and an agent that assumed "allowed" for that window
     * would be deciding on somebody's computer using a default nobody chose. Refusing until told is the only
     * defensible starting state. */
    const link: HostLink = {
        sandboxUrl: flags.url,
        id,
        token: hostToken,
        scopes: { shell: "off", write: "off", screen: "off", control: "off", sandboxes: "off", sandboxRemove: "off", destructive: "off" },
    };
    /* ADDED TO THE LIST, NOT WRITTEN OVER IT. This line used to be `writeHostConfig(link)` against a
     * single-link file, which made connecting a second sandbox a silent disconnection of the first — and the
     * caller that does it most is not a person typing a command, it is the last step of onboarding
     * (`connect.ps1` → `computer.ps1`). Setting up a new sandbox on a computer that already had one took the
     * computer off the old one, said nothing about it on any screen, and handed the new owner a machine with
     * every scope off. See config.ts. */
    const links = await upsertLink(link);
    ui.step("computer-starting", "starting the agent on this computer…");
    // Stop whatever is resident before the new config takes effect, otherwise a process started from an older
    // binary quietly keeps serving the old list and every fix since stays inert. The restart below picks up
    // every link, this one included, so the sandboxes that were already connected come straight back.
    await stopDetached(() => {});
    // registerAutostart answers true when the OS mechanism also started this session, a systemd user unit
    // does (`enable --now`). Where it doesn't, or where there is no mechanism at all, we cover the session.
    if (!(await registerAutostart(HOST_AUTOSTART, cliLauncher("intentic-host"), out))) {
        await startDetached(out);
    }
    // Naming the count is how the owner of a computer that was already connected can see that it still is:
    // silence here is what made the old behaviour invisible.
    const others = links.length - 1;
    ui.finished(
        "This computer is connected.",
        id,
        others === 0
            ? "Its permissions are set in the sandbox, on the same card you got this command from."
            : `Its permissions are set in the sandbox, on the same card you got this command from. Still connected to ${others} other sandbox${others === 1 ? "" : "es"}.`,
        [
            ["check it", "intentic-host status"],
            ["disconnect", "intentic-host uninstall"],
        ],
    );
};

interface RunFlags {
    readonly foreground: boolean;
    readonly stop: boolean;
}

const run = buildCommand<RunFlags>({
    docs: { brief: "Run the connection to the sandbox (setup starts this for you)" },
    parameters: {
        flags: {
            foreground: { kind: "boolean", brief: "Run the connection in this terminal instead of the background" },
            stop: { kind: "boolean", brief: "Stop the background connection" },
        },
    },
    async func(this: CommandContext, flags: RunFlags) {
        const out = (message: string): void => void this.process.stdout.write(`${message}\n`);
        if (flags.stop) {
            await stopDetached(out);
            return;
        }
        if (!flags.foreground) {
            await startDetached(out);
            return;
        }
        const links = await readLinks();
        await writeSecretFile(runPidPath, baseDir, String(process.pid));
        // host.log is long-lived, so bare lines in it are useless, every line is stamped.
        const log: Log = (message) => void this.process.stdout.write(`[${new Date().toISOString()}] ${message}\n`);
        /* ONE SOCKET PER SANDBOX, IN ONE PROCESS. Each connection is an ordinary outbound websocket with its own
         * token, its own grant and its own retry loop (connection.ts), so running several is running several —
         * there is nothing to multiplex and nothing shared but this log. The alternative, a process per link,
         * would need its own pid file, its own autostart entry and its own half of every "is it running?"
         * answer, to buy isolation between sandboxes that are all already talking to the same computer.
         *
         * A machine connected to nothing exits rather than idling: `run` is what autostart invokes at every
         * login, and a resident process holding no connections is a thing in the process list that does not do
         * anything, on the machine of somebody who has disconnected from everything. */
        if (links.length === 0) {
            log("connected to nothing: no sandbox is linked to this computer. Connect one from a computer card in your sandbox.");
            await rm(runPidPath, { force: true });
            return;
        }
        const connections = links.map((link) => connect(link, HOST_VERSION, log));
        const shutdown = (): void => {
            for (const connection of connections) {
                connection.stop();
            }
            void rm(runPidPath, { force: true }).finally(() => process.exit(0));
        };
        process.on("SIGTERM", shutdown);
        process.on("SIGINT", shutdown);
        await Promise.all(connections.map((connection) => connection.done));
        await rm(runPidPath, { force: true });
    },
});

const status = buildCommand<Record<string, never>>({
    docs: { brief: "Show what this computer is connected to and what it is allowed to do" },
    parameters: { flags: {} },
    async func(this: CommandContext) {
        const out = (message: string): void => void this.process.stdout.write(`${message}\n`);
        const links = await readLinks();
        if (links.length === 0) {
            out("This computer is not connected to a sandbox. Run the connect command from a computer card in your sandbox.");
            return;
        }
        const pid = await livePid(runPidPath);
        out(`Agent:        v${HOST_VERSION}, ${pid === undefined ? "NOT running (start it with `intentic-host run`)" : `running (pid ${pid})`}`);
        out(`Logs:         ${runLogPath}`);
        out(`Audit:        ${auditPath}`);
        // One block per sandbox, because the grants are per sandbox: a computer allowed to run commands for one
        // and only watched by another is the ordinary case now, and a single merged line could not say so.
        for (const link of links) {
            out("");
            out(`Sandbox:      ${link.sandboxUrl}`);
            out(`Connected as: ${link.id}`);
            // The cached grant, flagged as such: the sandbox's card is the source of truth, and saying so here is
            // what stops a stale line in this output from being read as the current permissions.
            out(`Permissions (last pushed by the sandbox): commands ${link.scopes.shell}, writes ${link.scopes.write}, screen ${link.scopes.screen}`);
            out(`Folders:      ${link.scopes.roots ?? "(your home folder)"}`);
        }
    },
});

interface UninstallFlags {
    readonly sandbox?: string;
}

const uninstall = buildCommand<UninstallFlags>({
    docs: { brief: "Disconnect this computer from one sandbox, or from all of them" },
    parameters: {
        flags: {
            // Named rather than positional because leaving it out is the destructive answer, and a bare word
            // that means "all of them" is the wrong thing to be able to type by accident.
            sandbox: { kind: "parsed", parse: String, brief: "Disconnect only this sandbox URL (default: every one)", optional: true },
        },
    },
    async func(this: CommandContext, flags: UninstallFlags) {
        const out = (message: string): void => void this.process.stdout.write(`${message}\n`);
        const only = flags.sandbox === undefined || flags.sandbox === "" ? undefined : flags.sandbox;
        // Stopped either way: the resident process is serving the list as it was, so it has to be restarted
        // against the list as it now is — and where nothing is left, not restarted at all.
        await stopDetached(out);
        const dropped = await removeLinks(only);
        const left = await readLinks();
        if (only !== undefined && dropped.length === 0) {
            out(`This computer is not connected to ${only}. Nothing changed.`);
            return;
        }
        if (left.length > 0) {
            // Still somebody's computer: the autostart entry, the credential file and the agent all stay, and
            // the agent comes back for the sandboxes that are left. Tearing those down because ONE sandbox was
            // disconnected is the same wholesale-overwrite mistake this whole change is about, in reverse.
            await startDetached(out);
            out(
                `Disconnected from ${dropped.map((link) => link.sandboxUrl).join(", ")}. Still connected to ${left.length} sandbox${left.length === 1 ? "" : "es"}.`,
            );
            return;
        }
        await unregisterAutostart(HOST_AUTOSTART, out);
        // The credential goes; the audit log stays. It is the user's record of what was done to their machine,
        // and deleting it as part of "uninstall" would erase the evidence at exactly the moment somebody might
        // be uninstalling BECAUSE they want to know what happened.
        await rm(runPidPath, { force: true });
        await rm(runLogPath, { force: true });
        await rm(configPath, { force: true });
        out(
            dropped.length === 0
                ? "Nothing was connected. Removed any leftovers."
                : `Disconnected from ${dropped.map((link) => link.sandboxUrl).join(", ")}. Each sandbox still lists this computer until it is removed there, its access is already gone.`,
        );
        out(`Your record of what this agent did stays at ${auditPath}.`);
    },
});

export const commands = { setup, run, status, uninstall };
