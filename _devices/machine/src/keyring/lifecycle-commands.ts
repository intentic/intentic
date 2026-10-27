import type { CommandContext } from "@stricli/core";
import { buildCommand } from "../cli-ui.js";
import { MACHINE_VERSION } from "../version.js";
import { keyringAnswer } from "./answer.js";
import { uninstallAskpass } from "./askpass.js";
import { uninstallGitHelper } from "./git-helper.js";
import { uninstallNativeHost } from "./native-host-install.js";
import { ensureService, resetKeyring, type StepReport, uninstallKeyring, upgradeKeyring } from "./service.js";

/* `intentic-machine keyring start | upgrade | reset | uninstall`: the keyring's own life on this computer, apart from
   what it keeps (commands.ts). Each answers one JSON line under --json, which the desktop app reads. */

export const json = { kind: "boolean", brief: "Print one JSON line, `ok` first (what the desktop app reads)", default: false } as const;

export interface JsonFlags {
    readonly json: boolean;
}

// ---- start ----

const start = buildCommand<JsonFlags>({
    docs: { brief: "Start Passwords' session helper where its protected service is installed, repairing the service if it is silent" },
    parameters: { flags: { json } },
    async func(this: CommandContext, flags: JsonFlags) {
        await keyringAnswer(
            this,
            flags.json,
            { doing: "Starting Passwords", failed: "Passwords was not started." },
            async (ui) => {
                const started = await ensureService(ui.note);
                return started.state.ok ? { ok: true as const, autostart: started.autostart, setUp: started.state.setUp, state: started.state.state } : started.state;
            },
            (result, ui) => ui.done(result.setUp ? "Passwords is running." : "Passwords is running, and not set up yet (`intentic-machine keyring setup`)."),
        );
    },
});

// ---- upgrade, uninstall ----

// Under --json, each stage of a long change as one line on stderr, `intentic-step {"step":…}`: the desktop app draws
// them as the steps the person watches (keyring.rs streams stderr), where stdout stays the one answer.
const stepLine =
    (cli: CommandContext): StepReport =>
    (step) => {
        // allow(terminal-output): the progress line the desktop app reads while the answer is still coming
        cli.process.stderr.write(`intentic-step ${JSON.stringify({ step })}\n`);
    };

const upgrade = buildCommand<JsonFlags>({
    docs: { brief: "Move the keyring to this agent's release, once the running keyring has asked you" },
    parameters: { flags: { json } },
    async func(this: CommandContext, flags: JsonFlags) {
        await keyringAnswer(
            this,
            flags.json,
            { doing: `Updating the keyring to ${MACHINE_VERSION}`, failed: "The keyring was not updated." },
            async (ui) => await upgradeKeyring(MACHINE_VERSION, ui.note, flags.json ? stepLine(this) : undefined),
            (result, ui) => ui.done(result.upgraded ? `Updated the keyring from ${result.from} to ${result.to}.` : `The keyring is already on ${result.to}. Nothing to do.`),
        );
    },
});

const reset = buildCommand<JsonFlags>({
    docs: { brief: "Start Passwords over when its recovery key is lost: the vault is set aside, never deleted, and a new one can be set up" },
    parameters: { flags: { json } },
    async func(this: CommandContext, flags: JsonFlags) {
        await keyringAnswer(
            this,
            flags.json,
            { doing: "Starting Passwords over", failed: "Passwords was not started over." },
            async (ui) => ({ ok: true as const, setAside: (await resetKeyring(ui.note)).setAside }),
            (result, ui) => {
                ui.note(`The old vault is in ${result.setAside}: its old recovery key still opens it, if it turns up.`);
                ui.done("Passwords is ready to be set up again (`intentic-machine keyring setup`).");
            },
        );
    },
});

const uninstall = buildCommand<JsonFlags>({
    docs: { brief: "Remove the keyring from this computer, keeping its vault" },
    parameters: { flags: { json } },
    async func(this: CommandContext, flags: JsonFlags) {
        await keyringAnswer(
            this,
            flags.json,
            { doing: "Removing the keyring", failed: "The keyring was not removed." },
            async (ui) => {
                // ssh, sudo and git must not be left asking a program that is gone, nor a browser starting one.
                await uninstallAskpass();
                await uninstallGitHelper();
                await uninstallNativeHost();
                return { ok: true as const, ...(await uninstallKeyring(ui.note)) };
            },
            (result, ui) => {
                ui.note(`The vault stays in ${result.vault}: set Passwords up again and the same recovery key opens it.`);
                ui.done("Removed the keyring from this computer.");
            },
        );
    },
});

export const lifecycleCommands = { start, upgrade, reset, uninstall };
