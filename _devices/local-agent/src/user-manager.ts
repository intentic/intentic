import { existsSync } from "node:fs";
import { pollUntil } from "@intentic/base/async";
import { runBoundedSync } from "@intentic/base/process";
import type { AutostartSpec } from "./autostart.js";
import { enableLinger, lingerOn } from "./linger.js";

/* THE USER MANAGER A HEADLESS LOGIN NEVER STARTED (2026-11-17). z440, a headless Debian server, was set up as root from
   `su -l` inside an ssh login. pam_systemd starts a user manager, and sets XDG_RUNTIME_DIR, only for the login itself, so
   root had neither, `systemctl --user` answered nothing, and the agent wrote an XDG autostart entry, which only a desktop
   session reads. The machine restarted at 14:12 and its agent stayed down until somebody ran the setup again at 15:15;
   every sandbox it was linked to read it as offline meanwhile. Now, on a machine systemd booted, a registration that
   finds no user manager turns lingering on, which makes logind start this user's manager at once and at every boot with
   nobody signed in, and points this process at the manager's runtime directory; the systemd user unit follows as on any
   machine that had a manager to begin with. */

// States meaning a user manager exists (degraded/starting count too); some Linux setups have none.
const SYSTEMD_LIVE_STATES = new Set(["running", "degraded", "starting", "maintenance", "stopping", "initializing"]);

// One local call that answers in well under a second; bounded so a manager that never replies cannot hold a setup.
const SYSTEMCTL_TIMEOUT_MS = 30_000;

// How long a manager that lingering just asked for may take to come up, and how often it is looked for meanwhile.
const MANAGER_START_MS = 10_000;
const MANAGER_POLL_MS = 250;

// Where systemd says it booted this machine: what sd_booted() checks. Absent in a container, or a WSL distro without it.
const SYSTEMD_BOOTED_MARKER = "/run/systemd/system";

// The runtime directory `systemctl --user` reaches this user's manager through, when this process has none: the
// `/run/user/<uid>` pam_systemd would have named, once logind has made it. Undefined when there is nothing to adopt. Pure.
export const runtimeDirToAdopt = (env: NodeJS.ProcessEnv, uid: number | undefined, exists: (path: string) => boolean): string | undefined => {
    if (env["XDG_RUNTIME_DIR"] !== undefined && env["XDG_RUNTIME_DIR"] !== "") {
        return undefined;
    }
    const dir = uid === undefined ? undefined : `/run/user/${uid}`;
    return dir !== undefined && exists(dir) ? dir : undefined;
};

// Points this process, and every tool it starts, at this user's runtime directory where nothing set it (a `su -l`, sudo,
// cron): the value pam_systemd gives every login, so nothing that reads it is told anything a login would not say.
const adoptUserRuntimeDir = (): void => {
    const dir = runtimeDirToAdopt(process.env, process.getuid?.(), existsSync);
    if (dir !== undefined) {
        process.env["XDG_RUNTIME_DIR"] = dir;
    }
};

/** Whether this user has a systemd manager `systemctl --user` can reach, its runtime directory adopted first. */
export const systemdUserAvailable = (): boolean => {
    adoptUserRuntimeDir();
    const result = runBoundedSync("systemctl", ["--user", "is-system-running"], { timeoutMs: SYSTEMCTL_TIMEOUT_MS, output: "pipe" });
    if (result.spawnError !== undefined) {
        return false; // no systemctl on PATH
    }
    // Non-zero exit is normal for "degraded"; the printed state decides, not the exit status. One that did not answer
    // printed nothing, which is no live state either.
    return SYSTEMD_LIVE_STATES.has(result.stdout.text.trim());
};

/**
 * A user manager for this user, started where none runs: on a machine systemd booted, lingering is turned on (and the
 * agent's marker written, linger.ts) and the manager it brings is waited for. False where systemd did not boot the
 * machine, lingering stayed off (a user polkit refuses it to), or no manager came within the wait; the caller then falls
 * back to the entry it wrote before.
 */
export const ensureUserManager = async (spec: Pick<AutostartSpec, "logPath">): Promise<boolean> => {
    if (systemdUserAvailable()) {
        return true;
    }
    if (!existsSync(SYSTEMD_BOOTED_MARKER)) {
        return false;
    }
    await enableLinger(spec);
    if (lingerOn() !== true) {
        return false;
    }
    return await pollUntil(systemdUserAvailable, { intervalMs: MANAGER_POLL_MS, timeoutMs: MANAGER_START_MS });
};
