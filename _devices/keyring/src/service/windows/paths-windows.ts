import { existsSync } from "node:fs";
import { join } from "node:path";

// Where the protected service keeps things on Windows, under %ProgramData%\Intentic\Keyring:
// - bin\intentic-keyring.exe: the service's own copy of the keyring, which only an administrator can replace, so a
//   process of the user cannot swap the program that holds the vault;
// - <SID>\: the vault, its keys and its audit, readable by the service's account (LOCAL SERVICE), SYSTEM and an
//   elevated administrator, and by no process of the user;
// - <SID>.door.json: where the service listens and the token that lets this user's programs in, readable by that user;
// - <SID>.hardened: the marker that the service is on for that user, which intentic-machine reads. The name is from
//   when the service was an optional "hardened mode" (until 2026-10-19): kept, so a PC set up before still reads as set
//   up, and the uninstaller's inventory (_sandbox/ic) finds it.

export const SID_RE = /^S-1-\d+(-\d+)+$/u;

// Well-known accounts by SID, so nothing depends on a localised name ("NT AUTHORITY" is "ZARZĄDZANIE NT" in Polish).
export const SYSTEM_SID = "S-1-5-18";
export const LOCAL_SERVICE_SID = "S-1-5-19";
export const ADMINISTRATORS_SID = "S-1-5-32-544";
export const USERS_SID = "S-1-5-32-545";

export interface WindowsServicePaths {
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

const windowsServiceRoot = (env: NodeJS.ProcessEnv = process.env): string => join(env["ProgramData"] ?? env["PROGRAMDATA"] ?? "C:\\ProgramData", "Intentic", "Keyring");

export const windowsServicePaths = (sid: string, env: NodeJS.ProcessEnv = process.env): WindowsServicePaths => {
    if (!SID_RE.test(sid)) {
        throw new Error(`"${sid}" is not a Windows security identifier`);
    }
    const root = windowsServiceRoot(env);
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

export const windowsServiceInstalled = (sid: string, env: NodeJS.ProcessEnv = process.env): boolean => existsSync(windowsServicePaths(sid, env).marker);
