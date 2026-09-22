import { rm } from "node:fs/promises";
import { sleep } from "@intentic/base/async";
import { plural } from "@intentic/base/format";
import { createUi, type Log, type PlanStep, type Ui } from "@intentic/local-agent";
import { buildCommand, type CommandContext } from "@stricli/core";
import { resolveDaemonBase } from "../daemon-base.js";
import { completeSetup, prepareSetup } from "../install.js";
import { ensureResident } from "../resident.js";
import {
    auditPath,
    configPath,
    type HostLink,
    readLinks,
    readLinkStates,
    removeLinks,
    unreachableIn,
    upsertLink,
} from "./config.js";

// device: setup (redeem a pairing and stay connected) and uninstall (disconnect, keep the audit log); no OAuth, only the pairing token.

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
        scopes: { shell: "off", write: "off", screen: "off", control: "off", sandboxes: "off", destructive: "off" },
    };
    // Added to the link list, not written over it, or connecting a second sandbox silently disconnects the first.
    const links = await upsertLink(link);
    ui.step("device-starting", "starting the agent on this device…");
    // The running agent dials the new link on its next pass; one that is not running is started.
    await ensureResident(out);
    await completeSetup(out);
    const opened = await linkOpens(flags.url);
    // Naming the count shows an already-connected device that it's still connected.
    const others = links.length - 1;
    ui.finished(
        opened ? "This device is connected." : "This device is linked. Its connection comes up as soon as the sandbox answers.",
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

// Long enough for the running agent's next pass and a first dial through a tunnel that is warming up.
const LINK_OPEN_TIMEOUT_MS = 20_000;
const LINK_OPEN_POLL_MS = 500;

// Setup says "connected" only once the agent's own stamp shows this link's socket open.
const linkOpens = async (url: string): Promise<boolean> => {
    const deadline = Date.now() + LINK_OPEN_TIMEOUT_MS;
    while (Date.now() < deadline) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- a bounded poll of one stamp, serial by definition
        if ((await readLinkStates())?.[url]?.state === "open") {
            return true;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- ditto
        await sleep(LINK_OPEN_POLL_MS);
    }
    return false;
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

// Drops the named link (or all), then reconciles the resident agent so it keeps running for what's left and retires only
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
    await ensureResident(out);
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

// Drops the links this machine has been dialling into silence for long enough that "the sandbox is restarting" has
// stopped being a reading of it — a recreated or deleted sandbox, whose address nothing will ever answer again.
// Evidence only: the set comes from the resident agent's own live stamp, so a machine whose agent is not running drops
// NOTHING rather than guessing from a config it cannot check against a socket. The link carrying the request that
// triggered this is answering by definition, so it is never in the set.
const forgetUnreachable = buildCommand({
    docs: { brief: "Forget the sandboxes this device has stopped being able to reach (a deleted or recreated one)" },
    parameters: {},
    async func(this: CommandContext) {
        const out = (message: string): void => void this.process.stdout.write(`${message}\n`);
        await dropUnreachableLinks(out);
    },
});

export const dropUnreachableLinks = async (out: Log): Promise<void> => {
    const stamped = await readLinkStates();
    if (stamped === undefined) {
        out("This machine's agent isn't running, so nothing here knows which links are answering. Start it with `intentic-machine run` and try again.");
        return;
    }
    const gone = unreachableIn(stamped);
    if (gone.length === 0) {
        out(`Every link this device holds is answering (${plural(Object.keys(stamped).length, "link")}). Nothing dropped.`);
        return;
    }
    for (const { url } of gone) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- one read-modify-write per link: the config is rewritten whole
        await removeLinks(url);
    }
    const left = await readLinks();
    // The running agent closes the dropped links on its next pass, and retires if they were all it served.
    await ensureResident(out);
    out(`Dropped ${plural(gone.length, "unreachable link")}: ${gone.map(({ url }) => url).join(", ")}.`);
    out(
        left.length === 0
            ? "This device is no longer connected to any sandbox. Connecting one again is a fresh command from its capability card."
            : `Still connected to ${plural(left.length, "sandbox", "sandboxes")}.`,
    );
};

export const deviceCommands = { setup, uninstall, "forget-unreachable": forgetUnreachable };
