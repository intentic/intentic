import { openSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { buildCommand, type CommandContext } from "@stricli/core";
import { cliLauncher, registerAutostart, unregisterAutostart } from "./autostart.js";
import { auditPath, configPath, type HostConfigFile, type Log, readHostConfig, runLogPath, runPidPath, writeHostConfig } from "./config.js";
import { connect } from "./connection.js";
import { HOST_VERSION } from "./version.js";

/* `intentic-host` — the agent that lets an intentic sandbox work on this computer.
 *
 *   setup      redeem the sandbox's one-time pairing, then connect and stay connected at every login.
 *   run        the connection loop: detached by default, --foreground to watch it, --stop to stop it.
 *   status     what this machine is connected to, whether it is up, and what it is allowed to do.
 *   uninstall  disconnect, deregister, forget the credential. Leaves the audit log behind, on purpose.
 *
 * There is no OAuth here and no browser: everything trusts the pairing token the owner minted in the sandbox's
 * UI, which is worth exactly one enrollment and expires in minutes. */

// Redeem the pairing for this machine's durable token. Retried through a tunnel that may still be warming (the
// sync agent's lesson: Cloudflare's edge answers before the origin registers), but never through a 401 — an
// expired pairing is a definitive answer, and retrying it only delays the "click Connect again" the user needs.
export const enroll = async (
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
            process.stderr.write(`connecting — the sandbox isn't reachable yet, retrying (${attempt}/${attempts})…\n`);
            await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
            continue;
        }
        if (response.status === 401) {
            throw new Error("that pairing has expired — click Connect again on the computer's card in your sandbox for a fresh command.");
        }
        if (response.status >= 500 && attempt < attempts) {
            process.stderr.write(`connecting — the sandbox is warming up (HTTP ${response.status}), retrying (${attempt}/${attempts})…\n`);
            await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
            continue;
        }
        if (!response.ok) {
            throw new Error(`connecting this computer failed (${response.status}): ${await response.text()}`);
        }
        return (await response.json()) as { id: string; hostToken: string };
    }
};

const alive = (pid: number): boolean => {
    try {
        // Signal 0 tests for the process without touching it — EPERM means it exists and is somebody else's.
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
};

const livePid = async (): Promise<number | undefined> => {
    const pid = Number((await readFile(runPidPath, "utf8").catch(() => "")).trim());
    if (!Number.isInteger(pid) || pid <= 0) {
        return undefined;
    }
    return alive(pid) ? pid : undefined;
};

/* Windows gets `windowsHide`, NOT `detached`. DETACHED_PROCESS leaves the child with no console, and Windows
 * then gives every console grandchild one of its own — so each command the agent runs would flash a black
 * window on the user's desktop. Windows keeps a child alive after its parent exits anyway, so what is needed
 * here is a console with no window, which every descendant inherits. (The sync agent learned this the hard way,
 * with three windows popping up every five seconds.) */
const detachedOptions = (platform: NodeJS.Platform): { readonly detached: true } | { readonly windowsHide: true } =>
    platform === "win32" ? { windowsHide: true } : { detached: true };

const startDetached = async (log: Log): Promise<void> => {
    const existing = await livePid();
    if (existing !== undefined) {
        log(`already connected (pid ${existing}).`);
        return;
    }
    const logFd = openSync(runLogPath, "a");
    const [command, ...leading] = cliLauncher();
    const child = spawn(command, [...leading, "run", "--foreground"], {
        ...detachedOptions(process.platform),
        stdio: ["ignore", logFd, logFd],
    });
    child.unref();
    log(`connected in the background (pid ${child.pid}). Details: ${runLogPath}`);
};

const stopDetached = async (log: Log): Promise<void> => {
    const pid = await livePid();
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
        const out = (message: string): void => void this.process.stdout.write(`${message}\n`);
        const { id, hostToken } = await enroll(flags.url, flags.pair);
        /* The cached grant starts at NOTHING. The sandbox pushes the real scopes within a second of connecting,
         * so this only governs the window before that — and an agent that assumed "allowed" for that window
         * would be deciding on somebody's computer using a default nobody chose. Refusing until told is the only
         * defensible starting state. */
        const config: HostConfigFile = {
            sandboxUrl: flags.url,
            id,
            token: hostToken,
            scopes: { shell: "off", write: "off", screen: "off", control: "off" },
        };
        await writeHostConfig(config);
        // Stop whatever the previous pairing left resident before the new config replaces it — otherwise a
        // process started from an older binary quietly adopts this pairing and every fix since stays inert.
        await stopDetached(() => {});
        await registerAutostart(cliLauncher(), out);
        await startDetached(out);
        out(`This computer is connected as "${id}". Its permissions are set in the sandbox, on the same card you got this command from.`);
    },
});

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
        const config = await readHostConfig();
        await writeFile(runPidPath, String(process.pid), { mode: 0o600 });
        // host.log is long-lived, so bare lines in it are useless — every line is stamped.
        const log: Log = (message) => void this.process.stdout.write(`[${new Date().toISOString()}] ${message}\n`);
        const connection = connect(config, HOST_VERSION, log);
        const shutdown = (): void => {
            connection.stop();
            void rm(runPidPath, { force: true }).finally(() => process.exit(0));
        };
        process.on("SIGTERM", shutdown);
        process.on("SIGINT", shutdown);
        await connection.done;
        await rm(runPidPath, { force: true });
    },
});

const status = buildCommand<Record<string, never>>({
    docs: { brief: "Show what this computer is connected to and what it is allowed to do" },
    parameters: { flags: {} },
    async func(this: CommandContext) {
        const out = (message: string): void => void this.process.stdout.write(`${message}\n`);
        const config = await readHostConfig().catch(() => undefined);
        if (config === undefined) {
            out("This computer is not connected to a sandbox. Run the connect command from a computer card in your sandbox.");
            return;
        }
        const pid = await livePid();
        out(`Connected as: ${config.id}`);
        out(`Sandbox:      ${config.sandboxUrl}`);
        out(`Agent:        v${HOST_VERSION} — ${pid === undefined ? "NOT running (start it with `intentic-host run`)" : `running (pid ${pid})`}`);
        // The cached grant, flagged as such: the sandbox's card is the source of truth, and saying so here is
        // what stops a stale line in this output from being read as the current permissions.
        out(
            `Permissions (last pushed by the sandbox): commands ${config.scopes.shell}, writes ${config.scopes.write}, screen ${config.scopes.screen}`,
        );
        out(`Folders:      ${config.scopes.roots ?? "(your home folder)"}`);
        out(`Logs:         ${runLogPath}`);
        out(`Audit:        ${auditPath}`);
    },
});

const uninstall = buildCommand<Record<string, never>>({
    docs: { brief: "Disconnect this computer and remove the agent's credential" },
    parameters: { flags: {} },
    async func(this: CommandContext) {
        const out = (message: string): void => void this.process.stdout.write(`${message}\n`);
        await stopDetached(out);
        await unregisterAutostart(out);
        // The credential goes; the audit log stays. It is the user's record of what was done to their machine,
        // and deleting it as part of "uninstall" would erase the evidence at exactly the moment somebody might
        // be uninstalling BECAUSE they want to know what happened.
        const config = await readHostConfig().catch(() => undefined);
        await rm(runPidPath, { force: true });
        await rm(runLogPath, { force: true });
        await rm(configPath, { force: true });
        out(
            config === undefined
                ? "Nothing was connected. Removed any leftovers."
                : `Disconnected from ${config.sandboxUrl}. The sandbox still lists this computer until it is removed there — its access is already gone.`,
        );
        out(`Your record of what this agent did stays at ${auditPath}.`);
    },
});

export const commands = { setup, run, status, uninstall };
