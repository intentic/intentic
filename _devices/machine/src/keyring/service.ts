import { existsSync } from "node:fs";
import { chmod, copyFile, link, readdir, rename, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { pollUntil } from "@intentic/base/async";
import { repoRoot } from "@intentic/constants/node";
import { errorMessage } from "@intentic/base/errors";
import { renameOver } from "@intentic/base/fs";
import { runBounded } from "@intentic/base/process";
import { askKeyring, keyringPaths, type KeyringResponse, KeyringUnavailable, realRunner, serviceInstalledHere } from "@intentic/keyring";
import { type AutostartKind, autostart, type CliLauncher, explain, livePid, type Log, spawnDetached, stopProcess } from "@intentic/local-agent";
import { DEV_VERSION } from "@intentic/sandbox-contract/state/versions";
import type { KeyringRefusalCode } from "@intentic/sandbox-contract/schemas/keyring";
import { KEYRING_AUTOSTART } from "../autostart/autostart.js";
import { binDir } from "../config.js";
import { askpassPath, downloadAsset, keyringAssetName, keyringPath, releaseAssetUrl, renameIfPresent } from "../release.js";
import { verifyReleaseFiles } from "../release/release-verify.js";
import { KeyringCliError } from "./flags.js";

// INTENTIC-KEYRING ON THIS COMPUTER, AS THIS AGENT KEEPS IT: put down beside the agent from the release the agent itself
// came from, checked against that release's signed SHA256SUMS like every binary this agent installs, started at login
// by an entry of its own, and moved to a new release only by `keyring upgrade`, after the running keyring asked the
// person. The agent's own upgrade never touches it (release.ts), so a sandbox maintainer's update reaches the agent and
// not the vault.

const KEYRING_LAUNCHER: CliLauncher = [keyringPath];

// How long a keyring may take to answer `state` when asked whether it runs: a live one answers at once.
const STATE_TIMEOUT_MS = 1_500;
// How long a start may take before the pipe answers: a cold binary on a busy laptop, a logon task winding down.
const START_TIMEOUT_MS = 20_000;
const START_POLL_MS = 300;
// A keyring exits within this on a stop; one that does not is waited out no longer.
const STOP_TIMEOUT_MS = 5_000;
// A person may take their time with a UAC prompt.
const ELEVATED_TIMEOUT_MS = 10 * 60_000;

export const keyringInstalled = (): boolean => existsSync(keyringPath);

export type KeyringStateAnswer = KeyringResponse<"state">;

/** The keyring's answer to `state`, or why there is none. Quick: a keyring that does not answer at once is not running. */
export const keyringState = async (timeoutMs: number = STATE_TIMEOUT_MS): Promise<KeyringStateAnswer | KeyringUnavailable> => {
    try {
        return await askKeyring({ address: keyringPaths().address, timeoutMs }, { op: "state" });
    } catch (error) {
        if (error instanceof KeyringUnavailable) {
            return error;
        }
        throw error;
    }
};

const waitForKeyring = async (): Promise<KeyringStateAnswer | undefined> => {
    let answer: KeyringStateAnswer | undefined;
    await pollUntil(
        async () => {
            const state = await keyringState();
            answer = state instanceof KeyringUnavailable ? undefined : state;
            return answer !== undefined;
        },
        { intervalMs: START_POLL_MS, timeoutMs: START_TIMEOUT_MS },
    );
    return answer;
};

// ---- the binary ----

// A from-source agent (0.0.0) has no release to download from; a keyring built in the same checkout stands in, where
// `build-agent-binaries.sh _devices/keyring intentic-keyring <target>` left one. Found in this file's own checkout, never
// on PATH.
export const localKeyringBuild = (from: string = import.meta.url): string | undefined => {
    let root: string;
    try {
        root = repoRoot(from);
    } catch {
        // allow(silent-catch): a compiled agent has no checkout around it, so there is no local build to find
        return undefined;
    }
    const candidate = join(root, "_devices", "keyring", "dist-bin", keyringAssetName());
    return existsSync(candidate) ? candidate : undefined;
};

// What a release asset arrives as before it is checked: a fixed name per release, so a download cut short is resumed
// rather than restarted, and one of another release is swept (stagedOthers).
const stagingOf = (version: string): string => `${keyringPath}.new-${version}`;

const sweepStaged = async (keep: string): Promise<void> => {
    const prefix = `${basename(keyringPath)}.new-`;
    // allow(silent-catch): no bin folder yet holds no part files
    // This release's .gz copy is kept too: it is the part a cut-short download resumes (release.ts downloadAsset).
    const stale = (await readdir(binDir).catch(() => [])).filter(
        (name) => name.startsWith(prefix) && join(binDir, name) !== keep && join(binDir, name) !== `${keep}.gz`,
    );
    // allow(silent-catch): a part file that will not go is swept by the next download
    await Promise.all(stale.map(async (name) => await rm(join(binDir, name), { force: true }).catch(() => undefined)));
};

/**
 * The keyring of release `version`, downloaded and checked, at a staging path the caller moves into place; in a
 * from-source agent, a copy of the checkout's own build. Throws, saying why, with nothing left behind but a resumable
 * part file.
 */
export const stageKeyring = async (version: string, log: Log): Promise<string> => {
    const staged = stagingOf(version);
    if (version === DEV_VERSION) {
        const local = localKeyringBuild();
        if (local === undefined) {
            throw new KeyringCliError(
                "failed",
                explain(
                    "There is no keyring to install.",
                    "this intentic-machine was built from source (0.0.0), which has no release to download the keyring from, and _devices/keyring/dist-bin holds no build for this computer.",
                    `build one with \`bash _tools/scripts/build/build-agent-binaries.sh _devices/keyring intentic-keyring <target>\` (the asset ${keyringAssetName()}), then run this again.`,
                ),
            );
        }
        log(`Using the keyring built in this checkout (${local}): a from-source agent has no release to take it from.`);
        await copyFile(local, staged);
        await chmod(staged, 0o755);
        return staged;
    }
    await sweepStaged(staged);
    log(`Downloading intentic-keyring ${version}…`);
    try {
        await downloadAsset(releaseAssetUrl(version, keyringAssetName()), staged, { resume: true });
    } catch (error) {
        throw new KeyringCliError(
            "failed",
            `the keyring of v${version} did not download (${errorMessage(error)}). A release from before the keyring shipped has none: \`intentic-machine upgrade\` first.`,
            { cause: error },
        );
    }
    try {
        await verifyReleaseFiles(version, [{ name: keyringAssetName(), path: staged }]);
    } catch (error) {
        // Deleted rather than kept for a resume: a complete file that is wrong would otherwise be resumed forever.
        // allow(silent-catch): the refusal below is what the person reads; a file left behind is swept next time
        await rm(staged, { force: true }).catch(() => undefined);
        throw new KeyringCliError("failed", `the downloaded keyring did not check out (${errorMessage(error)}), so it was deleted.`, { cause: error });
    }
    log("Checked against the release's signed SHA256SUMS.");
    await chmod(staged, 0o755);
    return staged;
};

/**
 * intentic-askpass: the keyring binary under a second name, which it reads to answer as askpass. A hard link, so it is
 * always the same bytes; a copy where the filesystem will not link. Made again after every swap, since a link made
 * before it still names the old file.
 */
export const linkAskpass = async (): Promise<"linked" | "copied"> => {
    // An askpass mid-prompt cannot be deleted on Windows, but can be renamed out of the way; the link below says if not.
    // allow(silent-catch): the delete's failure is answered by the rename, whose own failure throws
    await rm(askpassPath, { force: true }).catch(async () => await renameIfPresent(askpassPath, `${askpassPath}.old`));
    try {
        await link(keyringPath, askpassPath);
        return "linked";
    } catch {
        // allow(silent-catch): a filesystem without hard links gets a copy, which is the same program under that name
        await copyFile(keyringPath, askpassPath);
        await chmod(askpassPath, 0o755);
        return "copied";
    }
};

// ---- the protected service ----

/**
 * Whether Passwords' protected service is installed for this user: the keyring wrote its marker when it was installed
 * as an administrator (%ProgramData%\\Intentic\\Keyring on Windows, /var/lib/intentic-keyring on Linux).
 */
export const serviceHere = async (): Promise<boolean> => await serviceInstalledHere(realRunner);

// A PowerShell string literal: single quotes, each one inside doubled.
const psQuoted = (text: string): string => `'${text.replaceAll("'", "''")}'`;

/** What setup says when the administrator's yes is not given, or cannot be. */
export const NEEDS_ADMIN = "Passwords needs an administrator's approval once, to install its protected service. Nothing was changed.";

/** The command that runs the keyring binary as an administrator: UAC on Windows, pkexec on Linux. Pure. */
export const elevatedCommand = (args: readonly string[], platform: NodeJS.Platform = process.platform): { readonly command: string; readonly args: readonly string[] } =>
    platform === "win32"
        ? { command: "powershell.exe", args: ["-NoProfile", "-Command", `$p = Start-Process -FilePath ${psQuoted(keyringPath)} -ArgumentList ${args.map(psQuoted).join(",")} -Verb RunAs -Wait -PassThru; exit $p.ExitCode`] }
        : { command: "pkexec", args: [keyringPath, ...args] };

/**
 * Whether an elevated run's failure was the administrator's yes not given: UAC's "canceled by the user", pkexec's 126
 * (dialog dismissed) and 127 (not authorized). Pure.
 */
export const approvalRefused = (exitCode: number | null, said: string, platform: NodeJS.Platform = process.platform): boolean =>
    platform === "win32" ? /canceled by the user/iu.test(said) : exitCode === 126 || exitCode === 127;

/** The keyring binary run as an administrator, through the one prompt the system shows for it. */
const runElevated = async (args: readonly string[]): Promise<void> => {
    const elevated = elevatedCommand(args);
    const result = await runBounded(elevated.command, elevated.args, { timeoutMs: ELEVATED_TIMEOUT_MS });
    if (result.spawnError !== undefined) {
        throw new KeyringCliError("declined", `${NEEDS_ADMIN} (${elevated.command} could not be started: ${errorMessage(result.spawnError)})`);
    }
    if (result.exitCode !== 0) {
        const said = result.stderr.text.trim();
        if (approvalRefused(result.exitCode, said)) {
            throw new KeyringCliError("declined", NEEDS_ADMIN);
        }
        throw new KeyringCliError(
            "failed",
            `\`intentic-keyring ${args.join(" ")}\` did not finish (exit ${String(result.exitCode)})${said === "" ? "" : `: ${said}`}. Its log is ${keyringPaths().log}.`,
        );
    }
};

// ---- running it ----

const entry = (log: Log) => autostart(KEYRING_AUTOSTART, KEYRING_LAUNCHER, log);

/** The pid the keyring records for itself, while that process lives. */
export const keyringPid = async (): Promise<number | undefined> => await livePid(keyringPaths().pid);

/**
 * Registers the session helper's login entry and starts it through that entry, or directly where the entry cannot start
 * one, then waits for its pipe. Answers which entry keeps it running, and its first answer.
 */
export const startKeyring = async (log: Log): Promise<{ readonly autostart: AutostartKind; readonly state: KeyringStateAnswer }> => {
    const spec = KEYRING_AUTOSTART;
    const helper = entry(log);
    const kind = await helper.register();
    const running = await keyringState();
    if (!(running instanceof KeyringUnavailable)) {
        return { autostart: kind, state: running };
    }
    if (await helper.start()) {
        const came = await waitForKeyring();
        if (came !== undefined) {
            return { autostart: kind, state: came };
        }
        log(`Its ${kind} entry did not start the keyring within ${START_TIMEOUT_MS / 1000} s: starting it directly.`);
    }
    await spawnDetached(spec.logPath, KEYRING_LAUNCHER, spec.foregroundArgs);
    const came = await waitForKeyring();
    if (came === undefined) {
        throw new KeyringCliError("no-keyring", `The keyring started but its pipe did not answer within ${START_TIMEOUT_MS / 1000} s. Its log is ${spec.logPath}.`);
    }
    return { autostart: kind, state: came };
};

/** Stops the running keyring, if one runs; answers its pid. Its login entry stays, and starts it again at the next sign-in. */
export const stopKeyring = async (): Promise<number | undefined> => {
    const pid = await keyringPid();
    if (pid !== undefined) {
        await stopProcess(pid, STOP_TIMEOUT_MS);
    }
    return pid;
};

// ---- setup ----

export interface KeyringInstalled {
    readonly path: string;
    // Whether this run put the binary down, rather than finding it there.
    readonly fresh: boolean;
    readonly askpass: "linked" | "copied";
}

/**
 * The keyring binary in place and its askpass beside it. One already there is kept as it is: a new release comes only
 * through `keyring upgrade`, at the running keyring's word.
 */
export const installKeyring = async (version: string, log: Log): Promise<KeyringInstalled> => {
    if (keyringInstalled()) {
        return { path: keyringPath, fresh: false, askpass: await linkAskpass() };
    }
    const staged = await stageKeyring(version, log);
    await renameOver(staged, keyringPath);
    return { path: keyringPath, fresh: true, askpass: await linkAskpass() };
};

// ---- upgrade ----

export type KeyringUpgrade =
    | { readonly ok: true; readonly upgraded: boolean; readonly from: string; readonly to: string }
    | { readonly ok: false; readonly code: KeyringRefusalCode; readonly refusal: string };

const previousOf = (path: string): string => `${path}.previous`;

/**
 * The keyring moved to release `version`: downloaded and checked first, then put in place only once the running keyring
 * said the person agreed (`consent-upgrade`). The binary replaced stays as `.previous`, and comes back if the new one
 * does not answer.
 */
export const upgradeKeyring = async (version: string, log: Log): Promise<KeyringUpgrade> => {
    if (!keyringInstalled()) {
        throw new KeyringCliError("no-keyring", "No keyring is installed on this computer: `intentic-machine keyring setup` installs one.");
    }
    const before = await keyringState();
    if (before instanceof KeyringUnavailable) {
        throw new KeyringCliError("no-keyring", "The keyring is not running, and only a running keyring can ask you about an upgrade: `intentic-machine keyring setup` starts it.");
    }
    const from = before.ok ? before.state.version : "unknown";
    if (from === version && version !== DEV_VERSION) {
        return { ok: true, upgraded: false, from, to: version };
    }
    const staged = await stageKeyring(version, log);
    log("Asking the keyring, which asks you, before anything is replaced…");
    const consent = await askKeyring({ address: keyringPaths().address }, { op: "consent-upgrade", version });
    if (!consent.ok) {
        // allow(silent-catch): the person's no is the answer; a download left behind is swept by the next one
        await rm(staged, { force: true }).catch(() => undefined);
        return consent;
    }
    await stopKeyring();
    await rm(previousOf(keyringPath), { force: true });
    await renameIfPresent(keyringPath, previousOf(keyringPath));
    await renameOver(staged, keyringPath);
    await linkAskpass();
    // The service runs its own copy, which only an administrator replaces: the new program installs itself there. A
    // computer still on the per-user keyring from before moves to the service now, its vault with it.
    log((await serviceHere()) ? "Asking for an administrator's yes to put the new keyring in place for Passwords' service…" : "Asking for an administrator's yes, once, to move Passwords under its protected service…");
    await runElevated(["service", "install"]);
    try {
        const { state } = await startKeyring(log);
        const to = state.ok ? state.state.version : version;
        return { ok: true, upgraded: true, from, to };
    } catch (error) {
        log(`The new keyring did not answer (${errorMessage(error)}): putting the one before it back.`);
        await stopKeyring();
        await renameOver(previousOf(keyringPath), keyringPath);
        await linkAskpass();
        await startKeyring(log);
        throw new KeyringCliError("failed", `The keyring ${version} did not start, so ${from} was put back and is running again.`, { cause: error });
    }
};

// ---- the service, set up ----

/**
 * Passwords' protected service installed for this user (`intentic-keyring service install`, as an administrator), the
 * vault of a per-user keyring from before moved into it, and the session helper started. Already installed, only the
 * helper is started. Answers which entry starts the helper and its first answer.
 */
export const ensureService = async (log: Log): Promise<{ readonly autostart: AutostartKind; readonly state: KeyringStateAnswer; readonly installedNow: boolean }> => {
    if (!keyringInstalled()) {
        throw new KeyringCliError("no-keyring", "No keyring is installed on this computer: `intentic-machine keyring setup` installs one.");
    }
    if (await serviceHere()) {
        return { ...(await startKeyring(log)), installedNow: false };
    }
    // A per-user keyring from before holds the vault until now and writes it on every change: stopped first, so the copy
    // the service takes is the last one written.
    await stopKeyring();
    log("Asking for an administrator's yes, once, to install Passwords' protected service…");
    await runElevated(["service", "install"]);
    return { ...(await startKeyring(log)), installedNow: true };
};

// ---- uninstall ----

/**
 * The keyring off this computer: its service, its login entry, the process, its binaries. The vault goes back to
 * ~/.intentic/keyring and stays there, so Passwords set up again opens the same entries with the same recovery key.
 */
export const uninstallKeyring = async (log: Log): Promise<{ readonly removed: readonly string[]; readonly vault: string; readonly service: boolean }> => {
    const service = await serviceHere();
    if (service) {
        log("Asking for an administrator's yes, once, to remove Passwords' protected service…");
        await runElevated(["service", "uninstall"]);
    }
    // The entry first: a logon task's watchdog would otherwise start again what the stop below ends.
    await entry(log).unregister();
    await stopKeyring();
    // allow(silent-catch): no bin folder holds nothing of the keyring's
    const names = (await readdir(binDir).catch(() => [])).filter((name) => name.startsWith(basename(keyringPath)) || name.startsWith(basename(askpassPath)));
    const outcomes = await Promise.all(
        names.map(async (name) => {
            const path = join(binDir, name);
            try {
                await rm(path, { force: true });
                return path;
            } catch (error) {
                log(`Could not remove ${path} (${errorMessage(error)}): it goes once nothing runs it.`);
                // allow(silent-catch): a file Windows holds open is renamed aside, and the next uninstall removes it
                await rename(path, `${path}.old`).catch(() => undefined);
                return undefined;
            }
        }),
    );
    const removed = outcomes.filter((path) => path !== undefined);
    return { removed, vault: keyringPaths().dir, service };
};
