import { rm } from "node:fs/promises";
import { sleep } from "@intentic/base/async";
import { createUi, type Log, type PlanStep, type Ui } from "@intentic/local-agent";
import { buildCommand, type CommandContext } from "@stricli/core";
import { resolveDaemonBase } from "../daemon-base.js";
import { prepareSetup } from "../install.js";
import { reconcileResidency } from "../resident.js";
import { auditPath, configPath, type HostLink, readLinks, readPrepareUpdates, removeLinks, upsertLink, writePrepareUpdates } from "./config.js";

// device: setup (redeem a pairing, connect and stay connected), uninstall (disconnect, keep the audit log), and updates
// (the background-download switch). The connection loop is the shared resident loop (../resident.ts); there's no OAuth,
// only the short-lived pairing token minted in the sandbox's UI.

// Retries through a tunnel that may still be warming, but never through a 401: an expired pairing is definitive, and
// retrying only delays the reconnect the user needs.
const enroll = async (
    sandboxUrl: string,
    pairToken: string,
    { attempts = 10, delayMs = 3000 }: { attempts?: number; delayMs?: number } = {},
): Promise<{ id: string; token: string }> => {
    for (let attempt = 1; ; attempt++) {
        // Resolved per attempt (daemon-base.ts), since loopback may only appear partway through the retries.
        const { base } = await resolveDaemonBase(sandboxUrl);
        const url = `${base}/system/hosts/enroll`;
        let response: Response;
        try {
            response = await fetch(url, { method: "POST", headers: { "x-intentic-pair": pairToken } });
        } catch (error) {
            if (attempt >= attempts) {
                throw error;
            }
            process.stderr.write(`connecting: the sandbox isn't reachable yet, retrying (${attempt}/${attempts})…\n`);
            await sleep(delayMs);
            continue;
        }
        if (response.status === 401) {
            throw new Error("that pairing has expired: click Connect again on the device's card in your sandbox for a fresh command.");
        }
        if (response.status >= 500 && attempt < attempts) {
            process.stderr.write(`connecting: the sandbox is warming up (HTTP ${response.status}), retrying (${attempt}/${attempts})…\n`);
            await sleep(delayMs);
            continue;
        }
        if (!response.ok) {
            throw new Error(`connecting this device failed (${response.status}): ${await response.text()}`);
        }
        return (await response.json()) as { id: string; token: string };
    }
};

interface SetupFlags {
    readonly url: string;
    readonly pair: string;
}

const setup = buildCommand<SetupFlags>({
    docs: { brief: "Connect this device to an intentic sandbox using a one-time pairing token" },
    parameters: {
        flags: {
            url: { kind: "parsed", parse: String, brief: "The sandbox's URL (e.g. https://sandbox-xxx.example.dev)" },
            pair: { kind: "parsed", parse: String, brief: "The one-time pairing token from the device's capability card" },
        },
    },
    async func(this: CommandContext, flags: SetupFlags) {
        // Self-update and PATH setup run first, in plain lines, since an update re-execs before any UI opens.
        await prepareSetup((message) => void this.process.stdout.write(`${message}\n`), process.argv.slice(2));
        // Shared renderer with ic and sync; ic sets INTENTIC_UI=nested so this becomes detail under its own step.
        const ui = createUi(this.process);
        const out: Log = ui.note;
        ui.begin("intentic · connect this device", SETUP_PLAN);
        try {
            await runSetup(ui, out, flags);
        } finally {
            ui.close();
        }
    },
});

// Phase ids are this agent's own vocabulary; unnamed elsewhere reads as narration under the running step.
const SETUP_PLAN: readonly PlanStep[] = [
    { phase: "device-enrolling", label: "Enrol this device", weight: 10 },
    { phase: "device-starting", label: "Start the agent", weight: 15 },
];

const runSetup = async (ui: Ui, out: Log, flags: SetupFlags): Promise<void> => {
    ui.step("device-enrolling", "enrolling this device with your sandbox…");
    const { id, token } = await enroll(flags.url, flags.pair);
    // The cached grant starts at nothing; the sandbox pushes real scopes within a second of connecting.
    const link: HostLink = {
        sandboxUrl: flags.url,
        id,
        token,
        scopes: { shell: "off", write: "off", screen: "off", control: "off", sandboxes: "off", sandboxRemove: "off", destructive: "off" },
    };
    // Added to the link list, not written over it, or connecting a second sandbox silently disconnects the first.
    const links = await upsertLink(link);
    ui.step("device-starting", "starting the agent on this device…");
    // Restarts against the config as it now is, so an older running binary doesn't keep serving a stale link list.
    await reconcileResidency(out);
    // Naming the count shows an already-connected device that it's still connected.
    const others = links.length - 1;
    ui.finished(
        "This device is connected.",
        id,
        others === 0
            ? "Its permissions are set in the sandbox, on the same card you got this command from."
            : `Its permissions are set in the sandbox, on the same card you got this command from. Still connected to ${others} other sandbox${others === 1 ? "" : "es"}.`,
        [
            ["check it", "intentic-machine status"],
            ["disconnect", "intentic-machine device uninstall"],
        ],
    );
};

interface UninstallFlags {
    readonly sandbox?: string;
}

const uninstall = buildCommand<UninstallFlags>({
    docs: { brief: "Disconnect this device from one sandbox, or from all of them" },
    parameters: {
        flags: {
            // Named, not positional: omitting it is the destructive default; a bare 'all' shouldn't be an accident.
            sandbox: { kind: "parsed", parse: String, brief: "Disconnect only this sandbox URL (default: every one)", optional: true },
        },
    },
    async func(this: CommandContext, flags: UninstallFlags) {
        const out = (message: string): void => void this.process.stdout.write(`${message}\n`);
        await deviceUninstall(out, flags.sandbox);
    },
});

// Drops the named link (or all), then reconciles the resident loop so it keeps running for what's left and retires only
// when nothing remains.
export const deviceUninstall = async (out: Log, sandbox?: string): Promise<void> => {
    const only = sandbox === undefined || sandbox === "" ? undefined : sandbox;
    const dropped = await removeLinks(only);
    const left = await readLinks();
    if (only !== undefined && dropped.length === 0) {
        out(`This device is not connected to ${only}. Nothing changed.`);
        return;
    }
    if (left.length === 0) {
        // Credential goes; the audit log stays, since it's the user's own record of what happened on their machine.
        await rm(configPath, { force: true });
    }
    await reconcileResidency(out);
    if (left.length > 0) {
        out(
            `Disconnected from ${dropped.map((link) => link.sandboxUrl).join(", ")}. Still connected to ${left.length} sandbox${left.length === 1 ? "" : "es"}.`,
        );
        return;
    }
    out(
        dropped.length === 0
            ? "Nothing was connected. Removed any leftovers."
            : `Disconnected from ${dropped.map((link) => link.sandboxUrl).join(", ")}. Each sandbox still lists this device until it is removed there, its access is already gone.`,
    );
    out(`Your record of what this agent did stays at ${auditPath}.`);
};

// Flags, not a positional: a bare word flipping machine-wide behavior shouldn't be an accident; with neither flag, it
// just reports the current state.
interface UpdatesFlags {
    readonly on: boolean;
    readonly off: boolean;
}

const updates = buildCommand<UpdatesFlags>({
    docs: { brief: "Keep each sandbox's next update downloaded in the background, so applying it is a short restart (on by default)" },
    parameters: {
        flags: {
            on: { kind: "boolean", brief: "Download updates in the background (the default)" },
            off: { kind: "boolean", brief: "Stop downloading updates in the background" },
        },
    },
    async func(this: CommandContext, flags: UpdatesFlags) {
        const out = (message: string): void => void this.process.stdout.write(`${message}\n`);
        if (flags.on && flags.off) {
            throw new Error("--on and --off contradict each other: pass one.");
        }
        if (!flags.on && !flags.off) {
            out(
                (await readPrepareUpdates())
                    ? "On: this machine downloads each sandbox's next update in the background, so applying one is a restart of about half a minute. Turn it off with --off."
                    : "Off: updates are downloaded only when you take one, which makes updating a wait of minutes. Turn background downloads back on with --on.",
            );
            return;
        }
        await writePrepareUpdates(flags.on);
        // Restarts the loop now, not at its next tick: 'off' on a metered connection must take effect immediately.
        await reconcileResidency(out);
        out(
            flags.on
                ? "Background update downloads are on for this machine's sandboxes."
                : "Background update downloads are off. The update card in your sandbox still downloads and applies on demand.",
        );
    },
});

export const deviceCommands = { setup, uninstall, updates };
