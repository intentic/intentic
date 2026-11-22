import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { readTextIfExists } from "@intentic/base/fs";
import { runBounded } from "@intentic/base/process";
import { type HostPower, type HostPowerFinding, POWER_FINDING } from "@intentic/sandbox-contract/schemas/host-power";
import { durationWords } from "./words.js";

/* WHAT A LINUX COMPUTER WOULD DO TO WORK LEFT RUNNING ON IT (2026-11-22). Where systemd's sleep targets are all masked
   the computer cannot suspend at all, whatever asks (the owner's z440): nothing to say. Otherwise three things may
   suspend it on mains power: logind closing the lid (HandleLidSwitchExternalPower, falling back to HandleLidSwitch
   where it is unset, and only on a computer with a lid), logind's own idle action (IdleAction after IdleActionUSec),
   and GNOME's idle suspend (sleep-inactive-ac-type after sleep-inactive-ac-timeout), where gsettings has its schema.
   Any of them is one `os-sleep` finding with the command that stops all of them; the agent never runs it, since it
   needs root. Read from a Linux host only, never from a WSL distro, whose computer is Windows'. */

const SLEEP_TARGETS = ["sleep.target", "suspend.target", "hibernate.target", "hybrid-sleep.target"] as const;
export const MASK_COMMAND = `sudo systemctl mask ${SLEEP_TARGETS.join(" ")}`;

// The logind and GNOME actions that suspend or hibernate the computer.
const SUSPENDS = new Set(["suspend", "hibernate", "hybrid-sleep", "suspend-then-hibernate", "sleep"]);

export interface LinuxPowerReading {
    readonly at: number;
    readonly utcOffsetMinutes: number;
    // `systemctl is-enabled` for each of SLEEP_TARGETS, in order.
    readonly sleepTargets: readonly string[];
    readonly lid: boolean;
    // logind's action when the lid closes on mains power; undefined where logind did not answer.
    readonly lidAction: string | undefined;
    readonly idleAction: string | undefined;
    readonly idleSeconds: number | undefined;
    // GNOME's idle action on mains power and after how long; undefined where gsettings has no such schema.
    readonly gnome: { readonly type: string; readonly seconds: number } | undefined;
    readonly battery: boolean | undefined;
}

// `systemctl is-enabled …` answers, one per line. Pure.
export const sleepTargetsFrom = (stdout: string): string[] =>
    stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== "");

// Every sleep target masked: nothing can suspend this computer. Pure.
export const cannotSuspend = (targets: readonly string[]): boolean =>
    targets.length === SLEEP_TARGETS.length && targets.every((state) => state === "masked" || state === "masked-runtime");

// What logind is asked, in this order, and how `busctl get-property` answers each: `s "suspend"`, `t 1800000000`.
const LOGIND_PROPERTIES = ["HandleLidSwitch", "HandleLidSwitchExternalPower", "IdleAction", "IdleActionUSec"] as const;

export interface LogindAnswer {
    readonly lidAction: string | undefined;
    readonly idleAction: string | undefined;
    readonly idleSeconds: number | undefined;
}

// busctl's answer for LOGIND_PROPERTIES. HandleLidSwitchExternalPower reads "" where it is unset, and logind then uses
// HandleLidSwitch on mains power too. Pure.
export const logindFrom = (stdout: string): LogindAnswer => {
    const values = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== "")
        .map((line) => /^s "(.*)"$/.exec(line)?.[1] ?? /^t (\d+)$/.exec(line)?.[1]);
    const [lid, lidExternal, idle, idleUsec] = values;
    const usec = idleUsec === undefined ? Number.NaN : Number(idleUsec);
    return {
        lidAction: lidExternal === undefined || lidExternal === "" ? lid : lidExternal,
        idleAction: idle,
        idleSeconds: Number.isFinite(usec) ? Math.round(usec / 1_000_000) : undefined,
    };
};

// `gsettings get` answers: `'suspend'` for a word, `1200` or `uint32 1200` for a number. Pure.
export const gsettingsWord = (stdout: string): string | undefined => /^'(.*)'$/.exec(stdout.trim())?.[1];
export const gsettingsNumber = (stdout: string): number | undefined => {
    const digits = /(?:^|\s)(\d+)$/.exec(stdout.trim())?.[1];
    return digits === undefined ? undefined : Number(digits);
};

// A lid: an ACPI lid button, or an input device named a lid switch. Pure.
export const lidFrom = (acpiLids: readonly string[], inputDevices: string | undefined): boolean =>
    acpiLids.length > 0 || /^N: Name="[^"]*Lid Switch[^"]*"/im.test(inputDevices ?? "");

const suspendFinding = (reading: LinuxPowerReading): HostPowerFinding | undefined => {
    const idle = [
        ...(reading.idleAction !== undefined && SUSPENDS.has(reading.idleAction) && (reading.idleSeconds ?? 0) > 0
            ? [{ seconds: reading.idleSeconds ?? 0, by: "logind's IdleAction" }]
            : []),
        ...(reading.gnome !== undefined && SUSPENDS.has(reading.gnome.type) && reading.gnome.seconds > 0 ? [{ seconds: reading.gnome.seconds, by: "GNOME's power settings" }] : []),
    ].toSorted((a, b) => a.seconds - b.seconds);
    const lid = reading.lid && reading.lidAction !== undefined && SUSPENDS.has(reading.lidAction);
    const phrases = [
        ...idle.map((cause) => `after ${durationWords(cause.seconds)} without input (${cause.by})`),
        ...(lid ? ["when the lid closes on mains power (logind)"] : []),
    ];
    if (phrases.length === 0) {
        return undefined;
    }
    const finding: HostPowerFinding = {
        id: POWER_FINDING.osSleep,
        power: "ac",
        fixable: false,
        command: MASK_COMMAND,
        text: `Suspends ${phrases.join(" and ")}. Masking the sleep targets stops it, and needs root.`,
    };
    const soonest = idle[0];
    if (soonest !== undefined) {
        finding.afterSeconds = soonest.seconds;
    }
    return finding;
};

/** What a Linux reading says, as the device's facts carry it. Pure. */
export const linuxFindings = (reading: LinuxPowerReading): HostPower => {
    const finding = cannotSuspend(reading.sleepTargets) ? undefined : suspendFinding(reading);
    const power: HostPower = { at: reading.at, utcOffsetMinutes: reading.utcOffsetMinutes, findings: finding === undefined ? [] : [finding] };
    if (reading.battery !== undefined) {
        power.battery = reading.battery;
    }
    return power;
};

// ---- The reads. Each answer is bounded, and one that fails is unknown rather than an error, except systemctl's.

const ASK_TIMEOUT_MS = 10_000;

const ask = async (command: string, args: readonly string[]): Promise<string | undefined> => {
    const result = await runBounded(command, args, { timeoutMs: ASK_TIMEOUT_MS });
    return result.exitCode === 0 ? result.stdout.text : undefined;
};

const gnomeIdle = async (): Promise<LinuxPowerReading["gnome"]> => {
    const schema = "org.gnome.settings-daemon.plugins.power";
    const [type, timeout] = await Promise.all([ask("gsettings", ["get", schema, "sleep-inactive-ac-type"]), ask("gsettings", ["get", schema, "sleep-inactive-ac-timeout"])]);
    const word = type === undefined ? undefined : gsettingsWord(type);
    const seconds = timeout === undefined ? undefined : gsettingsNumber(timeout);
    return word === undefined || seconds === undefined ? undefined : { type: word, seconds };
};

// allow(silent-catch): a folder that cannot be listed (no /sys/class/power_supply) holds nothing this reads
const entries = async (dir: string): Promise<string[]> => await readdir(dir).catch(() => []);

const hasBattery = async (): Promise<boolean | undefined> => {
    const supplies = await entries("/sys/class/power_supply");
    const types = await Promise.all(supplies.map(async (supply) => (await readTextIfExists(join("/sys/class/power_supply", supply, "type")))?.trim()));
    return types.includes("Battery");
};

// Throws only where systemctl itself cannot be run: without systemd this agent cannot tell what may suspend the computer.
export const readLinuxPower = async (now: () => number = Date.now): Promise<LinuxPowerReading> => {
    const targets = await runBounded("systemctl", ["is-enabled", ...SLEEP_TARGETS], { timeoutMs: ASK_TIMEOUT_MS });
    if (targets.spawnError !== undefined || targets.timedOut) {
        throw new Error(`systemctl did not answer (${targets.spawnError?.message ?? "it ran past its deadline"})`);
    }
    const sleepTargets = sleepTargetsFrom(targets.stdout.text);
    const [logind, gnome, acpiLids, inputDevices, battery] = await Promise.all([
        ask("busctl", ["get-property", "org.freedesktop.login1", "/org/freedesktop/login1", "org.freedesktop.login1.Manager", ...LOGIND_PROPERTIES]),
        gnomeIdle(),
        entries("/proc/acpi/button/lid"),
        readTextIfExists("/proc/bus/input/devices"),
        hasBattery(),
    ]);
    const answer = logind === undefined ? { lidAction: undefined, idleAction: undefined, idleSeconds: undefined } : logindFrom(logind);
    return {
        at: now(),
        utcOffsetMinutes: -new Date(now()).getTimezoneOffset(),
        sleepTargets,
        lid: lidFrom(acpiLids, inputDevices),
        ...answer,
        gnome,
        battery,
    };
};
