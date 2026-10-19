import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { runBoundedSync } from "@intentic/base/process";
import type { AutostartSpec } from "./autostart.js";

/* LINGERING, AND WHO TURNED IT ON (2026-10-18). Lingering keeps a Linux user's systemd manager (and the agent's unit)
   alive without a session, or a headless box never autostarts, so every systemd registration asks `loginctl
   enable-linger`. It is a setting of the user's, not a file of the agent's: a purge that turned it off whatever the
   user had would stop their own lingering services, and one that never turned it off left it on for good. So the agent
   writes a marker the one time it is the one turning lingering on, beside its own log, and a purge turns lingering off
   only where that marker is (machine's uninstall/plan.ts `lingerAction`). */

// Where logind keeps the setting: one empty file per lingering user, which is what `loginctl show-user -p Linger` reads.
export const lingerFile = (user: string): string => join("/var/lib/systemd/linger", user);

// The marker an agent writes when it turned lingering on: in its own folder under ~/.intentic, so it goes with the agent.
export const lingerMarkerPath = (spec: Pick<AutostartSpec, "logPath">): string => join(dirname(spec.logPath), "linger-enabled");

const userName = (): string | undefined => {
    try {
        return userInfo().username;
    } catch {
        // allow(silent-catch): a user the system cannot name has no linger file to find, which reads as unknown
        return undefined;
    }
};

/** Whether this user lingers now; undefined where that cannot be read (no name for the user). */
export const lingerOn = (user: string | undefined = userName()): boolean | undefined => (user === undefined ? undefined : existsSync(lingerFile(user)));

const LOGINCTL_TIMEOUT_MS = 30_000;

/** Turns lingering on, and records it as the agent's doing only when it was off until now. Best-effort, as before. */
export const enableLinger = async (spec: Pick<AutostartSpec, "logPath">): Promise<void> => {
    const before = lingerOn();
    runBoundedSync("loginctl", ["enable-linger"], { timeoutMs: LOGINCTL_TIMEOUT_MS, output: "ignore" });
    if (before === false && lingerOn() === true) {
        const marker = lingerMarkerPath(spec);
        await mkdir(dirname(marker), { recursive: true, mode: 0o700 });
        await writeFile(marker, `${new Date().toISOString()}\n`, { mode: 0o600 });
    }
};

/** Turns lingering off; answers what loginctl said when it did not. */
export const disableLinger = (): string | undefined => {
    const result = runBoundedSync("loginctl", ["disable-linger"], { timeoutMs: LOGINCTL_TIMEOUT_MS, output: "pipe" });
    if (result.spawnError !== undefined) {
        return result.spawnError.message;
    }
    if (result.timedOut) {
        return `loginctl did not answer within ${LOGINCTL_TIMEOUT_MS / 1000} s`;
    }
    const said = `${result.stdout.text}${result.stderr.text}`.trim();
    return result.exitCode === 0 ? undefined : said === "" ? `loginctl exited ${String(result.exitCode)}` : said;
};
