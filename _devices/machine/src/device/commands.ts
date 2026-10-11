import { rm } from "node:fs/promises";
import { pollUntil } from "@intentic/base/async";
import { plural } from "@intentic/base/format";
import { explain, type Log, type PlanStep, type Ui } from "@intentic/local-agent";
import { PeerEnrollmentAnswerSchema } from "@intentic/sandbox-contract";
import type { CommandContext } from "@stricli/core";
import { buildCommand, machineUi, type Narration, sandboxUrlOf } from "../cli-ui.js";
import { postWhileWarming } from "../daemon-base.js";
import { completeSetup, prepareSetup } from "../install.js";
import { ensureResident } from "../resident.js";
import { auditPath, configPath, type HostLink, readLinks, readLinkStates, removeLinks, unreachableIn, upsertLink } from "./config.js";

// device: setup (redeem a pairing and stay connected) and uninstall (disconnect, keep the audit log); no OAuth, only the pairing token.

const NOT_CONNECTED = "This device was not connected.";

export const enroll = async (sandboxUrl: string, pairToken: string, say?: Log): Promise<{ id: string; token: string }> => {
    const response = await postWhileWarming(
        sandboxUrl,
        "/system/hosts/enroll",
        { headers: { "x-intentic-pair": pairToken } },
        {
            doing: "connecting",
            expired: explain(NOT_CONNECTED, "that pairing has expired.", "click Connect again on the device's card in your sandbox for a fresh command."),
            say,
        },
    );
    if (!response.ok) {
        throw new Error(explain(NOT_CONNECTED, `the sandbox answered ${response.status}: ${await response.text()}`));
    }
    // allow(silent-catch): a body that is not JSON fails the schema below and is reported as not an enrollment
    const answer = PeerEnrollmentAnswerSchema.safeParse(await response.json().catch(() => undefined));
    if (!answer.success) {
        throw new Error(explain(NOT_CONNECTED, `the sandbox's answer is not an enrollment (${answer.error.issues[0]?.message ?? "unreadable"}).`));
    }
    return answer.data;
};

interface SetupFlags {
    readonly url: string;
    readonly pair: string;
}

// As given: --url, or --sandbox, the spelling every other command picks a sandbox with.
interface SetupGiven {
    readonly url?: string;
    readonly sandbox?: string;
    readonly pair: string;
}

const setup = buildCommand<SetupGiven>({
    docs: { brief: "Connect this device to an intentic sandbox using a one-time pairing token" },
    parameters: {
        flags: {
            url: { kind: "parsed", parse: String, optional: true, brief: "The sandbox's URL (e.g. https://sandbox-xxx.example.dev)" },
            sandbox: { kind: "parsed", parse: String, optional: true, brief: "The same as --url" },
            pair: { kind: "parsed", parse: String, brief: "The one-time pairing token from the device's capability card" },
        },
    },
    async func(this: CommandContext, given: SetupGiven) {
        const flags: SetupFlags = { url: sandboxUrlOf(given.url, given.sandbox, NOT_CONNECTED), pair: given.pair };
        // Shared renderer with ic and sync; ic sets INTENTIC_UI=nested so this becomes detail under its own step.
        const ui = machineUi(this.process);
        // Self-update and PATH setup run first, as narration before the header, since an update re-execs into a
        // newer agent that draws its own.
        await prepareSetup(ui.note, process.argv.slice(2));
        const out: Log = ui.note;
        ui.begin("intentic · connect this device", SETUP_PLAN);
        // A throw is left to the run's stop (cli-ui.ts), which settles the running step as failed; closing here first
        // would settle it as done.
        await runSetup(ui, out, flags);
        ui.close();
    },
});

// Phase ids are this agent's own vocabulary; unnamed elsewhere reads as narration under the running step.
const SETUP_PLAN: readonly PlanStep[] = [
    { phase: "device-enrolling", label: "Connect this device", weight: 10 },
    { phase: "device-starting", label: "Start the agent", weight: 15 },
];

const runSetup = async (ui: Ui, out: Log, flags: SetupFlags): Promise<void> => {
    ui.step("device-enrolling", "enrolling this device with your sandbox…");
    const { id, token } = await enroll(flags.url, flags.pair, out);
    // The cached grant starts at nothing; the sandbox pushes real scopes within a second of connecting.
    const link: HostLink = {
        sandboxUrl: flags.url,
        id,
        token,
        scopes: { shell: "off", write: "off", screen: "off", control: "off", sandboxes: "off", destructive: "off", programs: "off" },
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
const linkOpens = async (url: string): Promise<boolean> =>
    await pollUntil(async () => (await readLinkStates())?.[url]?.state === "open", {
        intervalMs: LINK_OPEN_POLL_MS,
        timeoutMs: LINK_OPEN_TIMEOUT_MS,
    });

interface UninstallFlags {
    readonly sandbox?: string;
}

const uninstall = buildCommand<UninstallFlags>({
    docs: { brief: "Disconnect this device from one sandbox, or from all of them" },
    parameters: {
        flags: {
            // Named, not positional: omitting it is the destructive default; a bare 'all' shouldn't be an accident.
            sandbox: {
                kind: "parsed",
                parse: String,
                brief: "Disconnect only this sandbox: its URL, or its id or any part of it naming exactly one (default: every one)",
                optional: true,
            },
        },
    },
    async func(this: CommandContext, flags: UninstallFlags) {
        const ui = machineUi(this.process);
        const only = flags.sandbox === undefined || flags.sandbox === "" ? undefined : flags.sandbox;
        ui.act(only === undefined ? "Disconnecting this device from every sandbox" : `Disconnecting this device from ${only}`);
        ui.done(await deviceUninstall(ui, flags.sandbox));
    },
});

// The link a --sandbox value names: its URL as written, or else the one URL that holds it (a sandbox id, or part of one),
// as sync's commands pick a sandbox. Several is a stop; none is answered as given, which the caller says is not connected.
export const linkNamed = (urls: readonly string[], value: string): string => {
    if (urls.includes(value)) {
        return value;
    }
    const holding = urls.filter((url) => url.includes(value));
    if (holding.length > 1) {
        throw new Error(explain(`${value} matches more than one connected sandbox.`, `it matches ${holding.join(", ")}.`, "name one of them in full with --sandbox."));
    }
    return holding[0] ?? value;
};

// Drops the named link (or all), then reconciles the resident agent so it keeps running for what's left and retires only
// when nothing remains. `forGood` is the top-level `uninstall`, which retires it whatever this device hosts. Narrates
// through `say` and answers the verdict, for the caller to settle its line with.
export const deviceUninstall = async (say: Narration, sandbox?: string, { forGood = false }: { readonly forGood?: boolean } = {}): Promise<string> => {
    const only = sandbox === undefined || sandbox === "" ? undefined : linkNamed((await readLinks()).map((link) => link.sandboxUrl), sandbox);
    const dropped = await removeLinks(only);
    const left = await readLinks();
    if (only !== undefined && dropped.length === 0) {
        return `This device is not connected to ${only}. Nothing changed.`;
    }
    if (left.length === 0) {
        // Credential goes; the audit log stays, since it's the user's own record of what happened on their device.
        await rm(configPath, { force: true });
    }
    await ensureResident(say.note, { forGood });
    const urls = dropped.map((link) => link.sandboxUrl).join(", ");
    if (left.length > 0) {
        say.note(`Still connected to ${plural(left.length, "sandbox", "sandboxes")}.`);
        return `Disconnected from ${urls}.`;
    }
    if (dropped.length > 0) {
        say.note("Each sandbox still lists this device until it is removed there; its access is already gone.");
    }
    say.note(`Your record of what this agent did stays at ${auditPath}.`);
    return dropped.length === 0 ? "Nothing was connected. Removed any leftovers." : `Disconnected from ${urls}.`;
};

// Drops the links this device has been dialling into silence for long enough that "the sandbox is restarting" has
// stopped being a reading of it — a recreated or deleted sandbox, whose address nothing will ever answer again.
// Evidence only: the set comes from the resident agent's own live stamp, so a device whose agent is not running drops
// NOTHING rather than guessing from a config it cannot check against a socket. The link carrying the request that
// triggered this is answering by definition, so it is never in the set.
const forgetUnreachable = buildCommand({
    docs: { brief: "Forget the sandboxes this device has stopped being able to reach (a deleted or recreated one)" },
    parameters: {},
    async func(this: CommandContext) {
        await dropUnreachableLinks(machineUi(this.process));
    },
});

export const dropUnreachableLinks = async (ui: Ui): Promise<void> => {
    const stamped = await readLinkStates();
    if (stamped === undefined) {
        // Not a failure: nothing was asked of a link that cannot be judged, and nothing was dropped.
        ui.quiet("Nothing was dropped: this device's agent isn't running, so nothing here knows which links are answering.");
        ui.later([["start the agent", "intentic-machine run"]]);
        return;
    }
    const gone = unreachableIn(stamped);
    if (gone.length === 0) {
        ui.quiet(`Every link this device holds is answering (${plural(Object.keys(stamped).length, "link")}). Nothing dropped.`);
        return;
    }
    ui.act(`Dropping ${plural(gone.length, "unreachable link")}`);
    for (const { url } of gone) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- one read-modify-write per link: the config is rewritten whole
        await removeLinks(url);
    }
    const left = await readLinks();
    // The running agent closes the dropped links on its next pass, and retires if they were all it served.
    await ensureResident(ui.note);
    ui.note(
        left.length === 0
            ? "This device is no longer connected to any sandbox. Connecting one again takes a fresh command from its card."
            : `Still connected to ${plural(left.length, "sandbox", "sandboxes")}.`,
    );
    ui.done(`Dropped ${plural(gone.length, "unreachable link")}: ${gone.map(({ url }) => url).join(", ")}.`);
};

export const deviceCommands = { setup, uninstall, "forget-unreachable": forgetUnreachable };
