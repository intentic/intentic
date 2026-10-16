import { existsSync } from "node:fs";
import { join } from "node:path";

// Where hardened mode keeps things on Windows, under %ProgramData%\Intentic\Keyring:
// - bin\intentic-keyring.exe: the service's own copy of the keyring, which only an administrator can replace, so a
//   process of the user cannot swap the program that holds the vault;
// - <SID>\: the vault, its keys and its audit, readable by the service's account (LOCAL SERVICE), SYSTEM and an
//   elevated administrator, and by no process of the user;
// - <SID>.door.json: where the service listens and the token that lets this user's programs in, readable by that user;
// - <SID>.hardened: the marker that hardened mode is on for that user, which intentic-machine reads.

export const SID_RE = /^S-1-\d+(-\d+)+$/u;

// Well-known accounts by SID, so nothing depends on a localised name ("NT AUTHORITY" is "ZARZĄDZANIE NT" in Polish).
export const SYSTEM_SID = "S-1-5-18";
export const LOCAL_SERVICE_SID = "S-1-5-19";
export const ADMINISTRATORS_SID = "S-1-5-32-544";
export const USERS_SID = "S-1-5-32-545";

export interface HardenedPaths {
    readonly root: string;
    readonly bin: string;
    readonly exe: string;
    readonly vaultDir: string;
    readonly door: string;
    readonly marker: string;
    // The scheduled task's folder and name, as Task Scheduler takes them.
    readonly taskPath: string;
    readonly taskName: string;
}

export const hardenedRoot = (env: NodeJS.ProcessEnv = process.env): string => join(env["ProgramData"] ?? env["PROGRAMDATA"] ?? "C:\\ProgramData", "Intentic", "Keyring");

export const hardenedPaths = (sid: string, env: NodeJS.ProcessEnv = process.env): HardenedPaths => {
    if (!SID_RE.test(sid)) {
        throw new Error(`"${sid}" is not a Windows security identifier`);
    }
    const root = hardenedRoot(env);
    const bin = join(root, "bin");
    return {
        root,
        bin,
        exe: join(bin, "intentic-keyring.exe"),
        vaultDir: join(root, sid),
        door: join(root, `${sid}.door.json`),
        marker: join(root, `${sid}.hardened`),
        taskPath: "\\Intentic\\",
        taskName: `Keyring-${sid}`,
    };
};

export const isHardened = (sid: string, env: NodeJS.ProcessEnv = process.env): boolean => existsSync(hardenedPaths(sid, env).marker);
