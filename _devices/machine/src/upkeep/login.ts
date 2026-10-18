import { autostart, clearWindowsRunValue, type EntryInspection } from "@intentic/local-agent";
import { MACHINE_AUTOSTART } from "../autostart/autostart.js";
import { agentPath } from "../release.js";
import { machineLauncher } from "../resident/supervision.js";
import { MUTAGEN_RUN_VALUE } from "../sync/mutagen.js";
import { readRegistryValue } from "../windows-registry.js";
import type { Finding, UpkeepEntry } from "./entry.js";

/* THE LOGIN ENTRIES THIS AGENT WRITES, kept as this build writes them: its own (which the start's repair also checks,
   but only at a start, and a machine that never restarts never converged), and the Run value older builds wrote for
   Mutagen's daemon on Windows, taken away. */

// The supervisors a login entry stands for; the Windows side (a supervised distro) and "none" have no entry here.
const ENTRY_SUPERVISORS: ReadonlySet<string> = new Set(["task", "run-key", "systemd", "launchd", "xdg"]);

const entryName = (inspection: EntryInspection): string => {
    switch (inspection.kind) {
        case "task":
            return `the "${MACHINE_AUTOSTART.windowsRunValue}" logon task${inspection.drift === undefined ? "" : ` (differs in ${inspection.drift.join(", ")})`}`;
        case "run-key":
            return `the "${MACHINE_AUTOSTART.windowsRunValue}" Run value`;
        case "systemd":
            return `${MACHINE_AUTOSTART.id}.service`;
        case "launchd":
            return `the ${MACHINE_AUTOSTART.launchAgent?.label ?? MACHINE_AUTOSTART.id} LaunchAgent`;
        default:
            return `${MACHINE_AUTOSTART.id}.desktop`;
    }
};

// What the periodic pass does about one inspection: rewrite a stale or missing entry, say so of one it could not read,
// and leave the rest (a current one, or a file-based one launching another install's command, which is that install's).
// Pure.
export const loginEntryFinding = (inspection: EntryInspection, repair: () => Promise<void>): Finding | undefined => {
    if (inspection.state === "stale" || inspection.state === "missing") {
        return { what: entryName(inspection), act: repair };
    }
    if (inspection.state === "unknown") {
        return { what: entryName(inspection), why: "it could not be read, so it is left as it is" };
    }
    return undefined;
};

// Paths compared as the platform compares them.
const samePath = (a: string, b: string, platform: NodeJS.Platform): boolean =>
    platform === "win32" ? a.replaceAll("/", "\\").toLowerCase() === b.replaceAll("/", "\\").toLowerCase() : a === b;

const ownLoginEntry: UpkeepEntry = {
    id: "login-entry",
    kind: "login-entry",
    action: "repair",
    reason: "this agent's own login entry, written again where it differs from what this build writes (a logon task's action and settings included)",
    find: async (context) => {
        if (context.supervisor === undefined || !ENTRY_SUPERVISORS.has(context.supervisor)) {
            return [];
        }
        // An entry starts the installed agent: checked against another binary (a `doctor` run from a checkout), every
        // entry would read as stale, and a fix would point the entry at that checkout.
        const launcher = machineLauncher();
        if (!context.resident && !samePath(launcher[0], agentPath, context.platform)) {
            return [{ what: "this agent's login entry", why: `only the installed agent (${agentPath}) checks it, not ${launcher[0]}` }];
        }
        const entry = autostart(MACHINE_AUTOSTART, launcher, context.log);
        const found = loginEntryFinding(await entry.inspect(), async () => void (await entry.register({ repair: true })));
        return found === undefined ? [] : [found];
    },
};

/* IntenticMutagenDaemon, the Run value older builds' `sync setup` wrote so Mutagen's daemon started at sign-in. It
   started a daemon over Mutagen's shared data directory, which this agent no longer uses (sync/mutagen-env.ts), and the
   resident agent starts its own daemon now (sync/mutagen.ts MUTAGEN_RUN_VALUE). Windows only: elsewhere `sync setup`
   registered nothing of its own. */

// The key as PowerShell's registry drive names it.
const WINDOWS_RUN_KEY = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

const mutagenRetire: UpkeepEntry = {
    id: "mutagen-autostart-unused",
    kind: "login-entry",
    action: "retire",
    reason: "the Run value older builds wrote to start Mutagen's daemon at sign-in, which this agent now starts itself",
    find: async (context) => {
        if (context.platform !== "win32") {
            return [];
        }
        // allow(silent-catch): an unreadable Run value is taken for an absent one; the next pass reads it again
        const value = await readRegistryValue(WINDOWS_RUN_KEY, MUTAGEN_RUN_VALUE).catch(() => undefined);
        return value === undefined
            ? []
            : [{ what: `the "${MUTAGEN_RUN_VALUE}" Run value`, act: async () => await Promise.resolve(clearWindowsRunValue(MUTAGEN_RUN_VALUE)) }];
    },
};

export const LOGIN_ENTRIES: readonly UpkeepEntry[] = [ownLoginEntry, mutagenRetire];
