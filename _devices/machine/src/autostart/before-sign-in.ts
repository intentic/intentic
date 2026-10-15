import { beforeSignIn, BeforeSignInRefused, type BeforeSignInState, explain, type Footnote, type Item, type Log, type Ui } from "@intentic/local-agent";
import type { CommandContext } from "@stricli/core";
import { buildCommand, machineUi } from "../cli-ui.js";
import { machineLauncher } from "../resident/supervision.js";
import { MACHINE_AUTOSTART } from "./autostart.js";

/* THE SWITCH FOR STARTING BEFORE ANYONE SIGNS IN (2026-10-15): Windows' boot task (local-agent's beforeSignIn), which
   starts this agent with no session when the PC starts, so a PC Windows Update restarted at night answers before anyone
   comes to it (resident.ts, BEFORE ANYONE SIGNS IN). Off unless somebody turns it on here: Windows asks for permission
   both ways, on this PC's screen, so it cannot be switched from anywhere nobody is sitting. Elsewhere there is nothing
   to switch: a Linux agent's systemd unit already starts at boot (lingering keeps it without a session). */

type Word = "on" | "off" | "status";

const word = (value: string): Word => {
    if (value === "on" || value === "off" || value === "status") {
        return value;
    }
    throw new Error(`${value} is not on, off or status.`);
};

interface SwitchReading {
    readonly item: Item;
    readonly said: string;
    readonly later: readonly Footnote[];
}

export const beforeSignInStatus = (state: BeforeSignInState): SwitchReading => {
    if (state === "on") {
        return {
            item: { tone: "ok", name: "before sign-in", meta: "on" },
            said: "When this PC starts, Windows starts this agent before anyone signs in: sandboxes can run commands and read and write files here from then on. The screen tools wait for a sign-in, when the agent of the signed-in session takes over.",
            later: [["turn it off", "intentic-machine before-sign-in off"]],
        };
    }
    if (state === "stale") {
        return {
            item: { tone: "warn", name: "before sign-in", meta: "on, from an older install" },
            said: "Windows starts this agent before sign-in, but with what an older install or another folder wrote: it may start a copy of the agent that is no longer here.",
            later: [["write it again", "intentic-machine before-sign-in on"]],
        };
    }
    if (state === "unknown") {
        return {
            item: { tone: "warn", name: "before sign-in", meta: "unreadable" },
            said: "Windows holds a start for before sign-in that this agent could not read back.",
            later: [["write it again", "intentic-machine before-sign-in on"]],
        };
    }
    return {
        item: { tone: "skip", name: "before sign-in", meta: "off" },
        said: "This agent starts when somebody signs in on this PC. After a restart nobody came to (Windows Update restarts a PC at night by itself), sandboxes cannot reach it until somebody signs in.",
        later: [["turn it on (Windows asks for permission)", "intentic-machine before-sign-in on"]],
    };
};

const draw = (ui: Ui, reading: SwitchReading): void => {
    ui.items([reading.item]);
    ui.note(reading.said);
    ui.later(reading.later);
};

// The refusal as the protocol's stop: a no to Windows' prompt says how to ask again, a failure says what failed.
const stopFor = (refused: BeforeSignInRefused, turningOn: boolean): Error => {
    const headline = turningOn ? "This agent does not start before sign-in." : "This agent still starts before sign-in.";
    const fix = `intentic-machine before-sign-in ${turningOn ? "on" : "off"}, then answer Windows' prompt on this PC with Yes`;
    return new Error(explain(headline, refused.message, fix));
};

// Removes the task where there is one, for `uninstall`: asked on this PC's screen like turning it off, and said rather
// than thrown when it does not happen, since the rest of the uninstall already did.
export const retireBeforeSignIn = async (note: Log): Promise<void> => {
    const entry = beforeSignIn(MACHINE_AUTOSTART, machineLauncher());
    if (entry === undefined || entry.state() === "off") {
        return;
    }
    note("Windows also starts this agent before sign-in; removing that asks Windows for permission on this PC.");
    try {
        await entry.disable();
    } catch (error) {
        note(
            error instanceof BeforeSignInRefused
                ? `The start before sign-in stays (${error.message}): intentic-machine before-sign-in off removes it.`
                : `The start before sign-in stays: ${String(error)}`,
        );
    }
};

export const beforeSignInCommand = buildCommand<Record<never, never>, [Word | undefined]>({
    docs: {
        brief: "Whether Windows starts this agent when the PC starts, before anyone signs in (Windows asks for permission to change it): on, off, or status",
    },
    parameters: {
        positional: {
            kind: "tuple",
            parameters: [{ brief: "on, off or status (status unless given)", parse: word, optional: true, placeholder: "on|off|status" }],
        },
    },
    async func(this: CommandContext, _flags: Record<never, never>, given: Word | undefined) {
        const ui = machineUi(this.process);
        const entry = beforeSignIn(MACHINE_AUTOSTART, machineLauncher());
        if (entry === undefined) {
            ui.report("intentic · start before sign-in");
            ui.quiet(
                process.platform === "win32"
                    ? "This install has no intentic-launch.exe beside the agent, which the start before sign-in runs through. Re-run the install command from a sandbox's card."
                    : "Nothing to switch here: on Linux the agent's systemd unit starts at boot whether anyone is signed in or not.",
            );
            return;
        }
        if (given === "on" || given === "off") {
            const turningOn = given === "on";
            ui.act(turningOn ? "Asking Windows to start this agent before anyone signs in" : "Asking Windows to stop starting this agent before sign-in");
            ui.note("Windows asks for permission on this PC's screen: answer it there.");
            try {
                await (turningOn ? entry.enable() : entry.disable());
            } catch (error) {
                throw error instanceof BeforeSignInRefused ? stopFor(error, turningOn) : error;
            }
            const now = entry.state();
            ui.done(turningOn ? "This agent starts when the PC starts, before anyone signs in." : "This agent starts at the next sign-in, as before.");
            draw(ui, beforeSignInStatus(now));
            return;
        }
        ui.report("intentic · start before sign-in");
        draw(ui, beforeSignInStatus(entry.state()));
    },
});
