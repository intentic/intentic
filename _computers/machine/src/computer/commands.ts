import { rm } from "node:fs/promises";
import { createUi, type Log, type PlanStep, type Ui } from "@intentic/local-agent";
import { buildCommand, type CommandContext } from "@stricli/core";
import { prepareSetup } from "../install.js";
import { reconcileResidency } from "../resident.js";
import { auditPath, configPath, type HostLink, readLinks, readPrepareUpdates, removeLinks, upsertLink, writePrepareUpdates } from "./config.js";

/* `intentic-machine computer`, the half of the agent that lets an intentic sandbox work on this computer.
 *
 *   setup      redeem the sandbox's one-time pairing, then connect and stay connected at every login.
 *   uninstall  disconnect, forget the credential. Leaves the audit log behind, on purpose.
 *   updates    the background-download switch: whether this machine keeps its sandboxes' next update
 *              downloaded so applying one is a short restart (on by default; auto-prepare.ts).
 *
 * The connection loop itself is the shared resident loop (`intentic-machine run`, ../resident.ts), which also
 * serves the sync half. There is no OAuth here and no browser: everything trusts the pairing token the owner
 * minted in the sandbox's UI, which is worth exactly one enrollment and expires in minutes. */

// Redeem the pairing for this machine's durable token. Retried through a tunnel that may still be warming (the
// sync half's lesson: Cloudflare's edge answers before the origin registers), but never through a 401, an
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
        /* Self-update, PATH, the Windows launcher — everything the install scripts used to decide — runs
         * first (install.ts), in plain lines BEFORE the renderer opens: on an actual update this process
         * re-execs the new agent with the same argv, and a UI opened here would be a second banner there. */
        await prepareSetup((message) => void this.process.stdout.write(`${message}\n`), process.argv.slice(2));
        /* Rendered through the shared renderer (@intentic/local-agent), the same one `ic` and the sync half
         * render through, so a person meeting both in one install meets one program. `ic` runs this command
         * inside its own checklist and sets INTENTIC_UI=nested, which turns everything below into detail under
         * ITS step rather than a second banner in the middle of somebody's setup. */
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
 * launchd or the Windows registry, and starting the resident agent waits on a detached process. Phases are this
 * agent's own vocabulary and deliberately absent from the desktop app's plan (setupPlan.ts), where an unknown
 * phase reads as narration under whichever step is running. */
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
    /* Stop whatever is resident, register autostart, start against the config as it now is (resident.ts): a
     * process started from an older binary would otherwise quietly keep serving the old link list, and every
     * fix since would stay inert. The restart picks up every link AND every sync pairing this machine holds,
     * so the sandboxes that were already connected come straight back. */
    await reconcileResidency(out);
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
            ["check it", "intentic-machine status"],
            ["disconnect", "intentic-machine computer uninstall"],
        ],
    );
};

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
        await computerUninstall(out, flags.sandbox);
    },
});

/* The computer half's teardown, callable from the top-level `uninstall` too. Drops the named link (or all of
 * them) and reconciles the resident loop against what is left — which keeps it running for the remaining links
 * AND for any sync pairings, and retires it (with the login entry) only when this machine holds nothing at all.
 * Tearing residency down because ONE sandbox was disconnected is the same wholesale-overwrite mistake the link
 * list exists to prevent, in reverse. */
export const computerUninstall = async (out: Log, sandbox?: string): Promise<void> => {
    const only = sandbox === undefined || sandbox === "" ? undefined : sandbox;
    const dropped = await removeLinks(only);
    const left = await readLinks();
    if (only !== undefined && dropped.length === 0) {
        out(`This computer is not connected to ${only}. Nothing changed.`);
        return;
    }
    if (left.length === 0) {
        // The credential goes; the audit log stays. It is the user's record of what was done to their machine,
        // and deleting it as part of "uninstall" would erase the evidence at exactly the moment somebody might
        // be uninstalling BECAUSE they want to know what happened.
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
            : `Disconnected from ${dropped.map((link) => link.sandboxUrl).join(", ")}. Each sandbox still lists this computer until it is removed there, its access is already gone.`,
    );
    out(`Your record of what this agent did stays at ${auditPath}.`);
};

/* The background-download switch. Flags rather than a positional, the group's own precedent (`uninstall
 * --sandbox`): a bare word that flips a machine-wide behaviour is the wrong thing to be able to type by
 * accident, and `--off` states its direction. With neither flag it reports, which is also how the owner of a
 * machine they didn't configure finds out what it is doing. */
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
        /* Restart the loop rather than waiting for its next tick to notice: "off" typed on a metered
         * connection means NOW, and the fresh loop re-reads the switch before it touches anything. The same
         * reconcile every setup runs, so it also repairs a stale login entry while it is at it. */
        await reconcileResidency(out);
        out(flags.on ? "Background update downloads are on for this machine's sandboxes." : "Background update downloads are off. The update card in your sandbox still downloads and applies on demand.");
    },
});

export const computerCommands = { setup, uninstall, updates };
