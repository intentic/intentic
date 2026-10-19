import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import { plural } from "@intentic/base/format";
import { keyringPaths } from "@intentic/keyring";
import {
    autostart,
    beforeSignIn,
    beforeSignInTaskName,
    clearWindowsRunValue,
    disableLinger,
    homeDir,
    lingerMarkerPath,
    lingerOn,
    type Log,
} from "@intentic/local-agent";
import { KEYRING_AUTOSTART, MACHINE_AUTOSTART } from "../autostart/autostart.js";
import { binDir, baseDir } from "../config.js";
import { stopAllApps } from "../device/tools/programs/stop-all.js";
import { readWindowsPath, removeFromWindowsPathValue, writeWindowsPath } from "../install.js";
import { uninstallAskpass } from "../keyring/askpass.js";
import { uninstallGitHelper } from "../keyring/git-helper.js";
import { uninstallNativeHost } from "../keyring/native-host-install.js";
import { keyringInstalled, keyringPid, serviceHere, uninstallKeyring } from "../keyring/service.js";
import { agentPath } from "../release.js";
import { machineLauncher, readResident, retireResident } from "../resident/supervision.js";
import { runProcess } from "../sync/exec.js";
import { MUTAGEN_CALL_TIMEOUT_MS, MUTAGEN_RUN_VALUE, ownMutagenPath } from "../sync/mutagen.js";
import { removeManagedSshConfig } from "../sync/ssh.js";
import { legacyAutostart, linkWatchPaths, retiredPaths } from "../upkeep/retired.js";
import { exists, isInside, linkTarget, processesFrom } from "../upkeep/trash.js";
import { lingerAction, linkIsOurs } from "./plan.js";
import type { Tally } from "./tally.js";

/* THE STEPS OF `uninstall --purge` BEYOND WHAT THE PLAIN UNINSTALL DOES: each removes one kind of thing the agent put
   on this device, says what it removed, and turns its own failure into a warning with the command that finishes it by
   hand. Only the agent itself still running is a failure (residentGone). Nothing here downloads anything. */

const WINDOWS = process.platform === "win32";

const killCommand = (pid: number): string => (WINDOWS ? `taskkill /PID ${pid} /T /F` : `kill ${pid}`);

/** Every program a sandbox started here with `app_start`: they outlive the agent on purpose, and not its purge. */
export const stopApps = async (say: Tally): Promise<void> => {
    try {
        const { stopped, left } = await stopAllApps();
        if (stopped.length > 0) {
            say.note(`Stopped ${plural(stopped.length, "program")} a sandbox had started on this device: ${stopped.join(", ")}.`);
        }
        for (const { run, why } of left) {
            say.warn(`${run.name} may still be running: ${why}.`, killCommand(run.pid));
        }
    } catch (error) {
        say.warn(`The programs sandboxes started on this device could not be listed (${errorMessage(error)}), so none was stopped.`);
    }
};

/** Windows' start before sign-in, removed with the permission Windows asks for on this PC's screen. */
export const retireStartBeforeSignIn = async (say: Tally): Promise<void> => {
    const entry = beforeSignIn(MACHINE_AUTOSTART, machineLauncher());
    if (entry === undefined || entry.state() === "off") {
        return;
    }
    say.note("Windows also starts this agent before sign-in; removing that asks Windows for permission on this device.");
    try {
        await entry.disable();
        say.note("Removed the start before sign-in.");
    } catch (error) {
        // What it would start is about to be gone, so it fails quietly at the next start; still, it is said.
        say.warn(
            `Windows still has the task that starts this agent before sign-in (${errorMessage(error)}).`,
            `schtasks /delete /tn ${beforeSignInTaskName(MACHINE_AUTOSTART)} /f, in a terminal run as administrator`,
        );
    }
};

/** The resident agent stopped and its login entry gone, whatever it still served; still running is the one failure. */
export const residentGone = async (say: Tally): Promise<void> => {
    await retireResident(say.note);
    const still = await readResident();
    if (still !== undefined) {
        say.fail(`the agent is still running (pid ${still.pid}) after being asked to stop.`, killCommand(still.pid));
    }
};

/** This agent's Mutagen daemon and the ssh include, again: the sync step ends them, unless it stopped before it could. */
export const stopOwnMutagen = async (say: Tally): Promise<void> => {
    if (WINDOWS) {
        clearWindowsRunValue(MUTAGEN_RUN_VALUE);
    }
    await removeManagedSshConfig().catch((error: Error) => say.warn(`The ssh-config include could not be removed (${errorMessage(error)}).`, "remove the Include of intentic's file from ~/.ssh/config"));
    if (existsSync(ownMutagenPath())) {
        // Its own data directory and no autostart (mutagen-env.ts): stopping an absent daemon is a no-op.
        await runProcess(ownMutagenPath(), ["daemon", "stop"], { timeoutMs: MUTAGEN_CALL_TIMEOUT_MS });
    }
};

/** The keyring, its login entry and askpass; answers whether its binaries must stay to finish what did not happen. */
export const removeKeyring = async (say: Tally): Promise<{ readonly holdBin: boolean }> => {
    try {
        await uninstallAskpass();
    } catch (error) {
        say.warn(
            `ssh, sudo and git may still ask intentic-askpass for passwords (${errorMessage(error)}).`,
            WINDOWS ? "unset SSH_ASKPASS, SSH_ASKPASS_REQUIRE, SUDO_ASKPASS and GIT_ASKPASS in your user environment" : "rm ~/.config/environment.d/intentic-askpass.conf",
        );
    }
    try {
        await uninstallGitHelper();
        await uninstallNativeHost();
    } catch (error) {
        say.warn(`git or a browser may still try Passwords' helper (${errorMessage(error)}).`, "git config --global --unset-all credential.helper intentic, and remove dev.intentic.keyring from the browsers' NativeMessagingHosts");
    }
    const service = await serviceHere();
    const installed = keyringInstalled();
    if (!service && !installed && !existsSync(keyringPaths().dir)) {
        return { holdBin: false };
    }
    try {
        // Run for a vault folder alone too: an entry the keyring registered may outlive its binary.
        const { service: was } = await uninstallKeyring(say.note);
        if (was || installed) {
            say.note(was ? "Removed Passwords, its protected service and its login entry." : "Removed Passwords and its login entry.");
        }
        return { holdBin: false };
    } catch (error) {
        if (service) {
            // Only the keyring's own program, run with an administrator's yes, takes its service away: it stays for that.
            say.warn(`Passwords' protected service stays (${errorMessage(error)}), so this agent's programs stay to finish it.`, "intentic-machine uninstall --purge");
            return { holdBin: true };
        }
        const pid = await keyringPid();
        say.warn(`The keyring was not removed entirely (${errorMessage(error)}).`, pid === undefined ? "intentic-machine uninstall --purge" : killCommand(pid));
        return { holdBin: false };
    }
};

const quiet: Log = () => undefined;

/** What the agents before this one left (upkeep/retired.ts): their login entries, folders, PATH links and the timer. */
export const removeLegacy = async (say: Tally): Promise<void> => {
    const removed: string[] = [];
    for (const spec of legacyAutostart(baseDir)) {
        const entry = autostart(spec, machineLauncher(), quiet);
        // two entries, each a few OS calls; in order keeps them apart
        if (await entry.present()) {
            await entry.unregister();
            removed.push(`the ${spec.id} login entry`);
        }
    }
    const home = homeDir();
    const { dirs, links } = retiredPaths(home, baseDir);
    for (const link of links) {
        // a handful of paths, each a stat
        const target = await linkTarget(link);
        if (target !== undefined && dirs.some((dir) => isInside(target, dir))) {
            await rm(link, { force: true });
            removed.push(link);
        }
    }
    for (const dir of dirs.filter((each) => existsSync(each))) {
        // ditto
        const running = (await processesFrom(dir)) ?? [];
        if (running.length > 0) {
            say.warn(`A program from ${dir} is still running (pid ${running.join(", ")}), an agent from before this one.`, running.map(killCommand).join("; "));
        }
        await rm(dir, { recursive: true, force: true }).then(
            () => removed.push(dir),
            (error: Error) => say.warn(`${dir} could not be removed (${errorMessage(error)}).`, WINDOWS ? `Remove-Item -Recurse -Force ${dir}` : `rm -rf ${dir}`),
        );
    }
    removed.push(...(await removeLinkWatch(home)));
    if (removed.length > 0) {
        say.note(`Removed what the agents before this one left: ${removed.join(", ")}.`);
    }
};

const userSystemctl = async (...args: string[]): Promise<void> => void (await runProcess("systemctl", ["--user", ...args], { timeoutMs: 30_000 }));

// The hand-made `intentic-link-watch` timer (upkeep/retired.ts): turned off before its files go, or systemd keeps a unit
// whose file is missing.
const removeLinkWatch = async (home: string): Promise<string[]> => {
    if (process.platform !== "linux") {
        return [];
    }
    const present: string[] = [];
    for (const path of linkWatchPaths(home)) {
        // four paths, each a stat
        if (await exists(path)) {
            present.push(path);
        }
    }
    if (present.length === 0) {
        return [];
    }
    await userSystemctl("disable", "--now", "intentic-link-watch.timer");
    await userSystemctl("stop", "intentic-link-watch.service");
    for (const path of present) {
        // ditto
        await rm(path, { force: true });
    }
    await userSystemctl("daemon-reload");
    return ["intentic-link-watch"];
};

/** The agent's place on PATH: its folder in the per-user PATH on Windows, its link in ~/.local/bin elsewhere. */
export const removeFromPath = async (say: Tally): Promise<void> => {
    if (WINDOWS) {
        try {
            const { kind, stored } = await readWindowsPath();
            const next = removeFromWindowsPathValue(stored, binDir);
            if (next !== undefined) {
                await writeWindowsPath(kind, next);
                say.note(`Took ${binDir} off your PATH.`);
            }
        } catch (error) {
            say.warn(`${binDir} could not be taken off your PATH (${errorMessage(error)}).`, `remove ${binDir} from your user PATH in Windows' environment variables`);
        }
        return;
    }
    const link = join(homeDir(), ".local", "bin", "intentic-machine");
    if (linkIsOurs(await linkTarget(link), agentPath, binDir)) {
        await rm(link, { force: true }).then(
            () => say.note(`Removed the intentic-machine link from ${join(homeDir(), ".local", "bin")}.`),
            (error: Error) => say.warn(`${link} could not be removed (${errorMessage(error)}).`, `rm ${link}`),
        );
    }
};

/** Lingering, turned off only where this agent was the one that turned it on (local-agent's linger.ts). */
export const restoreLinger = (say: Tally): void => {
    if (process.platform !== "linux") {
        return;
    }
    const marked = [lingerMarkerPath(MACHINE_AUTOSTART), lingerMarkerPath(KEYRING_AUTOSTART)].some((marker) => existsSync(marker));
    const action = lingerAction(marked, lingerOn());
    if (action === "theirs") {
        say.note("Lingering stays on for your user: it was on before this agent asked for it.");
        return;
    }
    if (action !== "disable") {
        return;
    }
    const refused = disableLinger();
    if (refused === undefined) {
        say.note("Turned lingering off for your user: this agent had turned it on.");
        return;
    }
    say.warn(`Lingering stays on for your user (${refused}), which this agent had turned on.`, "loginctl disable-linger");
};
