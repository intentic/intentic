import { join } from "node:path";
import { homeDir } from "@intentic/local-agent";
import { binDir } from "../config.js";

/* WHEN SECURITY SOFTWARE STANDS BETWEEN THE AGENT AND ITS OWN FILES (2026-11-20, intentic#49). On a Windows PC with
   Bitdefender Endpoint Security Tools the agent ran, but Mutagen's agent bundle was gone from its bin folder from the
   first connect, and every file sync and port forward failed with Mutagen's own "unable to locate agent bundle" and an
   exit code. Nothing on the PC itself changes that: whoever manages the antivirus has to allow the folders. So a start
   or a write the PC refused says so in the words the installer uses (agent-fetch.ps1 Get-IntenticAllowNote), naming
   the file and the folders to allow. Nothing here adds an exclusion: that is the owner's call, not this agent's. */

// The errors Windows answers when security software refuses a start or a write ("Access denied").
const DENIED = new Set(["EACCES", "EPERM"]);

/** Whether an errno (a spawn's `spawnCode`, or `errnoCode` of a thrown error) is a refused start or write. */
export const deniedByThePc = (code: string | undefined): boolean => code !== undefined && DENIED.has(code);

// The ic CLI's own bin folder, beside this agent's: the other program the device script installs and runs.
const icBinDir = (): string => join(homeDir(), ".intentic", "ic", "bin");

/** The folders an antivirus has to allow for this agent and ic to start and update themselves. */
const foldersToAllow = (): readonly string[] => [binDir, icBinDir()];

// What the antivirus did to the file, in the installer's words.
export type Refusal = "start" | "write" | "removed";

const did = (how: Refusal, file: string): string => {
    if (how === "removed") {
        return `removes ${file} as soon as it is put in place.`;
    }
    return how === "start" ? `blocks ${file} from starting (Windows answers "Access denied").` : `blocks writing ${file} (Windows answers "Access denied").`;
};

/**
 * The note for whoever manages the antivirus: which file it refused, and the folders to allow. Windows only, where an
 * antivirus is the usual cause; elsewhere a refused start or write is the file's own permissions, said as such. Pure.
 */
export const allowNote = (how: Refusal, file: string, platform: NodeJS.Platform = process.platform, folders: readonly string[] = foldersToAllow()): string => {
    if (platform !== "win32") {
        return how === "removed" ? `${file} disappeared right after it was put in place.` : `this device refused to ${how === "start" ? "start" : "write"} ${file}; check its permissions.`;
    }
    return [
        `Please allow Intentic on this PC: security software ${did(how, file)}`,
        `Allow the folders ${folders.join(" and ")}. These programs update themselves, so allow them by folder, not by hash.`,
    ].join(" ");
};
