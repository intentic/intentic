import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { autostart, clearWindowsRunValue, type EntryInspection } from "@intentic/local-agent";
import { MACHINE_AUTOSTART } from "../autostart/autostart.js";
import { agentPath } from "../release.js";
import { machineLauncher } from "../supervision.js";
import { readState } from "../sync/config.js";
import { MUTAGEN_RUN_VALUE, ownMutagenPath, registerMutagenAutostart } from "../sync/mutagen.js";
import type { Finding, UpkeepContext, UpkeepEntry } from "./entry.js";

/* THE LOGIN ENTRIES THIS AGENT WRITES, kept as this build writes them: its own (which the start's repair also checks,
   but only at a start, and a machine that never restarts never converged), and Mutagen's daemon's Run value on Windows,
   which nothing ever took away once the last pairing went. */

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

/* IntenticMutagenDaemon, the Run value `sync setup` writes so Mutagen's daemon (holding every sync and forward session)
   starts at sign-in. Wanted while a pairing needs Mutagen and this agent's own copy is the Mutagen in use; while only a
   Mutagen of the user's own stands in, starting it is theirs. Nothing took it away once the last pairing went, so a PC that stopped syncing
   still started this agent's Mutagen daemon at every sign-in. Windows only: elsewhere `sync setup` registers nothing. */

const WINDOWS_RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

// The data of one Run value as `reg query` prints it, or undefined when the output names no such value. Pure.
export const runValueData = (output: string, name: string): string | undefined => {
    for (const line of output.split(/\r?\n/)) {
        const match = /^\s*(\S.*?)\s+REG_\w+\s+(.*)$/.exec(line);
        if (match?.[1] === name) {
            return match[2]?.trim();
        }
    }
    return undefined;
};

const readRunValue = (name: string): string | undefined => {
    const reg = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "reg.exe");
    const result = spawnSync(reg, ["query", WINDOWS_RUN_KEY, "/v", name], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
    return result.status === 0 ? runValueData(result.stdout, name) : undefined;
};

export interface MutagenRunReading {
    // How many pairings this environment holds, or why sync.json could not be read.
    readonly pairings: number | Error;
    // The Run value's data, undefined when there is none.
    readonly value: string | undefined;
    // This agent's own Mutagen copy, and whether it is the Mutagen in use.
    readonly own: string;
    readonly ownInUse: boolean;
}

// What to do about the Run value: take it away, write it again, or nothing; or why it is left. Pure.
export const mutagenRunDecision = (reading: MutagenRunReading): "retire" | "repair" | { readonly why: string } | undefined => {
    if (reading.pairings instanceof Error) {
        return reading.value === undefined
            ? undefined
            : { why: `sync.json does not read (${reading.pairings.message}), so whether a pairing needs it is not known` };
    }
    if (reading.pairings === 0) {
        return reading.value === undefined ? undefined : "retire";
    }
    if (!reading.ownInUse) {
        return undefined;
    }
    return reading.value?.toLowerCase().includes(reading.own.toLowerCase()) === true ? undefined : "repair";
};

const mutagenReading = async (): Promise<MutagenRunReading> => {
    const own = ownMutagenPath();
    return {
        // allow(silent-catch): an unreadable sync.json is carried as the reason, not swallowed (mutagenRunDecision)
        pairings: await readState().then(
            (state) => state.pairings.length,
            (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
        ),
        value: readRunValue(MUTAGEN_RUN_VALUE),
        own,
        // The pinned copy is the Mutagen this agent runs whenever it is there (sync/mutagen.ts, ensureMutagen); PATH's
        // stands in only while it cannot be fetched.
        ownInUse: existsSync(own),
    };
};

const mutagenFinding = async (context: UpkeepContext, wanted: "retire" | "repair"): Promise<Finding[]> => {
    if (context.platform !== "win32") {
        return [];
    }
    const reading = await mutagenReading();
    const decision = mutagenRunDecision(reading);
    const what = `the "${MUTAGEN_RUN_VALUE}" Run value`;
    if (decision === undefined || (typeof decision === "string" && decision !== wanted)) {
        return [];
    }
    if (typeof decision === "object") {
        // Said once, by the entry that would have taken it away.
        return wanted === "retire" ? [{ what, why: decision.why }] : [];
    }
    return [
        {
            what,
            act:
                decision === "retire"
                    ? async () => await Promise.resolve(clearWindowsRunValue(MUTAGEN_RUN_VALUE))
                    : async () => await Promise.resolve(registerMutagenAutostart(reading.own, machineLauncher(), context.log)),
        },
    ];
};

const mutagenRetire: UpkeepEntry = {
    id: "mutagen-autostart-unused",
    kind: "login-entry",
    action: "retire",
    reason: "the Run value that starts this agent's Mutagen daemon at sign-in, once no pairing here needs Mutagen",
    find: async (context) => await mutagenFinding(context, "retire"),
};

const mutagenRepair: UpkeepEntry = {
    id: "mutagen-autostart",
    kind: "login-entry",
    action: "repair",
    reason: "the Run value that starts this agent's Mutagen daemon at sign-in, while a pairing here needs it",
    find: async (context) => await mutagenFinding(context, "repair"),
};

export const LOGIN_ENTRIES: readonly UpkeepEntry[] = [ownLoginEntry, mutagenRetire, mutagenRepair];
