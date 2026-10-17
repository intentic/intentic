import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runBounded } from "@intentic/base/process";
import { PS_UTF8_OUTPUT } from "@intentic/desktop-automation";
import { homeDir } from "@intentic/local-agent";
import { z } from "zod";
import { askpassPath } from "../release.js";
import { KeyringCliError } from "./flags.js";

// `intentic-machine keyring askpass install|uninstall|status`: pointing ssh, sudo and git at intentic-askpass for this
// user, so a password they ask for is answered by the keyring, at the person's yes, instead of typed. The variables
// carry a path and nothing secret, so on Windows they are set through PowerShell's own argv. On Linux and macOS a
// login session reads ~/.config/environment.d (systemd's user manager, and the desktop sessions it starts), and a shell
// profile needs the same lines, which are printed for the person to add: this file does not edit a profile.

export const ASKPASS_VARIABLES = ["SSH_ASKPASS", "SSH_ASKPASS_REQUIRE", "SUDO_ASKPASS", "GIT_ASKPASS"] as const;
export type AskpassVariable = (typeof ASKPASS_VARIABLES)[number];

// What each variable holds for this user, where it is set.
export interface AskpassVariables {
    SSH_ASKPASS?: string;
    SSH_ASKPASS_REQUIRE?: string;
    SUDO_ASKPASS?: string;
    GIT_ASKPASS?: string;
}

// SSH_ASKPASS_REQUIRE=prefer makes ssh use askpass even with a terminal; sudo uses SUDO_ASKPASS only with `sudo -A`.
export const askpassValue = (name: AskpassVariable, path: string): string => (name === "SSH_ASKPASS_REQUIRE" ? "prefer" : path);

export const askpassVariables = (path: string): AskpassVariables => {
    const variables: AskpassVariables = {};
    for (const name of ASKPASS_VARIABLES) {
        variables[name] = askpassValue(name, path);
    }
    return variables;
};

export const environmentFile = (home: string = homeDir()): string => join(home, ".config", "environment.d", "intentic-askpass.conf");

// environment.d expands `$NAME` and reads `\` as an escape; a path holding either is written escaped.
const environmentValue = (value: string): string => value.replaceAll("\\", "\\\\").replaceAll("$", "\\$");

/** The environment.d file: one KEY=VALUE line per variable, with what wrote it. */
export const environmentFileText = (path: string): string =>
    [
        "# Written by `intentic-machine keyring askpass install`: ssh, sudo -A and git ask intentic-keyring for passwords.",
        "# `intentic-machine keyring askpass uninstall` removes this file.",
        ...ASKPASS_VARIABLES.map((name) => `${name}=${environmentValue(askpassValue(name, path))}`),
        "",
    ].join("\n");

// A shell's single-quoted word: the one character it cannot hold is closed, escaped and reopened.
const shellQuoted = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

/** The lines a shell profile needs for a terminal to see the same variables. */
export const profileLines = (path: string): string[] => ASKPASS_VARIABLES.map((name) => `export ${name}=${shellQuoted(askpassValue(name, path))}`);

export interface AskpassState {
    readonly installed: boolean;
    // The askpass binary, while it is there.
    readonly path?: string;
    // What each variable holds for this user now; absent where it is unset.
    readonly variables: AskpassVariables;
}

export interface AskpassInstalled extends AskpassState {
    // Linux and macOS: the environment.d file written, and the lines for a shell profile.
    readonly file?: string;
    readonly profile?: readonly string[];
}

const installedFrom = (variables: AskpassVariables, path: string): boolean => ASKPASS_VARIABLES.every((name) => variables[name] === askpassValue(name, path));

// ---- Windows: the user's own environment, through .NET ----

// A PowerShell string literal: single quotes, each one inside doubled.
const psQuoted = (text: string): string => `'${text.replaceAll("'", "''")}'`;

const powershell = async (script: string): Promise<string> => {
    const result = await runBounded("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeoutMs: 60_000 });
    if (result.spawnError !== undefined) {
        throw result.spawnError;
    }
    if (result.exitCode !== 0) {
        throw new KeyringCliError("failed", `PowerShell could not change your environment (exit ${String(result.exitCode)}): ${result.stderr.text.trim()}`);
    }
    return result.stdout.text;
};

// SetEnvironmentVariable at User scope writes HKCU\Environment and tells every window it changed, so a new terminal
// sees it without a sign-out.
const setWindows = async (values: readonly (readonly [AskpassVariable, string | undefined])[]): Promise<void> => {
    await powershell(
        values
            .map(([name, value]) => `[Environment]::SetEnvironmentVariable(${psQuoted(name)}, ${value === undefined ? "$null" : psQuoted(value)}, 'User')`)
            .join("; "),
    );
};

// What the listing below prints: one JSON object, each variable's value or null where it is unset.
const WindowsVariablesSchema = z
    .string()
    .transform((text, context) => {
        try {
            return JSON.parse(text.trim() === "" ? "{}" : text);
        } catch {
            context.addIssue({ code: "custom", message: "PowerShell printed something that is not JSON" });
            return z.NEVER;
        }
    })
    .pipe(z.record(z.string(), z.string().nullable()));

// Asked in UTF-8 (PS_UTF8_OUTPUT): under a profile with a Polish letter in its name the values are paths that hold one,
// and read in the console's code page they never equalled what this file writes, so status and removal missed them.
const readWindows = async (): Promise<AskpassVariables> => {
    const listing = await powershell(
        `${PS_UTF8_OUTPUT}$v = [ordered]@{}; ${ASKPASS_VARIABLES.map((name) => `$v[${psQuoted(name)}] = [Environment]::GetEnvironmentVariable(${psQuoted(name)}, 'User')`).join("; ")}; $v | ConvertTo-Json -Compress`,
    );
    const parsed = WindowsVariablesSchema.safeParse(listing);
    const variables: AskpassVariables = {};
    for (const name of ASKPASS_VARIABLES) {
        const value = parsed.success ? parsed.data[name] : undefined;
        if (value !== undefined && value !== null) {
            variables[name] = value;
        }
    }
    return variables;
};

// ---- Linux and macOS: the environment.d file ----

const readEnvironmentFile = async (file: string): Promise<AskpassVariables> => {
    const text = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
            return "";
        }
        throw error;
    });
    const variables: AskpassVariables = {};
    for (const line of text.split("\n")) {
        const match = /^([A-Z_]+)=(.*)$/u.exec(line.trim());
        const name = ASKPASS_VARIABLES.find((known) => known === match?.[1]);
        if (name !== undefined && match?.[2] !== undefined) {
            variables[name] = match[2].replaceAll(/\\(.)/gu, "$1");
        }
    }
    return variables;
};

export interface AskpassPlace {
    readonly platform: NodeJS.Platform;
    readonly home: string;
    readonly path: string;
}

const herePlace = (): AskpassPlace => ({ platform: process.platform, home: homeDir(), path: askpassPath });

/** Whether this user's ssh, sudo and git are pointed at intentic-askpass. */
export const askpassStatus = async (place: AskpassPlace = herePlace()): Promise<AskpassState> => {
    const variables = place.platform === "win32" ? await readWindows() : await readEnvironmentFile(environmentFile(place.home));
    const state: AskpassState = { installed: existsSync(place.path) && installedFrom(variables, place.path), variables };
    return existsSync(place.path) ? { ...state, path: place.path } : state;
};

/** Points this user's ssh, sudo and git at intentic-askpass. */
export const installAskpass = async (place: AskpassPlace = herePlace()): Promise<AskpassInstalled> => {
    if (!existsSync(place.path)) {
        throw new KeyringCliError("no-keyring", `There is no intentic-askpass at ${place.path} yet: \`intentic-machine keyring setup\` puts it there.`);
    }
    if (place.platform === "win32") {
        await setWindows(ASKPASS_VARIABLES.map((name) => [name, askpassValue(name, place.path)] as const));
        return { installed: true, path: place.path, variables: askpassVariables(place.path) };
    }
    const file = environmentFile(place.home);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, environmentFileText(place.path), { mode: 0o644 });
    return { installed: true, path: place.path, variables: askpassVariables(place.path), file, profile: profileLines(place.path) };
};

/**
 * Clears what install set, and only that: a variable pointing somewhere else (another askpass of the person's own) is
 * left as it is.
 */
export const uninstallAskpass = async (place: AskpassPlace = herePlace()): Promise<AskpassInstalled> => {
    const left: AskpassInstalled = existsSync(place.path) ? { installed: false, path: place.path, variables: {} } : { installed: false, variables: {} };
    if (place.platform === "win32") {
        const now = await readWindows();
        const ours = ASKPASS_VARIABLES.filter((name) => now[name] === askpassValue(name, place.path)).map((name) => [name, undefined] as const);
        if (ours.length > 0) {
            await setWindows(ours);
        }
        return left;
    }
    const file = environmentFile(place.home);
    await rm(file, { force: true });
    return { ...left, file, profile: profileLines(place.path) };
};
