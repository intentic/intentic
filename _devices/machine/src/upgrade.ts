import { chmod, readdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import type { Log } from "@intentic/local-agent";
import { DEV_VERSION, isNewer } from "@intentic/sandbox-contract";
import { binDir } from "./config.js";
import { agentAssetUrl, agentPath, download, launcherAssetUrl, launcherPath, renameIfPresent, versionOf } from "./release.js";

// One environment to one exact release: download → probe → swap → restart through the supervisor → verify → roll back.

// What an upgrade did, as a value the command prints and tests assert. `restarted` already had the right bytes
// but served the old build; `agent-behind` is a swap that landed but didn't take.
export type UpgradeOutcome =
    | { readonly kind: "current"; readonly version: string; readonly note?: string }
    | { readonly kind: "restarted"; readonly from: string; readonly to: string }
    | { readonly kind: "upgraded"; readonly from: string; readonly to: string }
    | { readonly kind: "agent-behind"; readonly installed: string; readonly running?: string }
    | { readonly kind: "failed"; readonly reason: string };

// The upgrade's effects behind one seam, so the step order is testable without a network, a disk or a running agent.
export interface UpgradeExec {
    readonly fetchTo: (url: string, dest: string) => Promise<void>;
    // The release the binary reports itself as; undefined where it does not run as an agent.
    readonly probe: (binary: string) => string | undefined;
    readonly swap: (from: string, to: string) => Promise<void>;
    // The build the agent holding the pidfile runs now; undefined when none runs, which an upgrade leaves that way.
    readonly runningBuild: () => Promise<string | undefined>;
    // Restarts the agent through its supervisor and answers the build that came up; undefined when none did.
    readonly restart: () => Promise<string | undefined>;
    readonly discard: (path: string) => Promise<void>;
    // The Windows launcher ships beside the agent there, so it moves with it: both or neither.
    readonly withLauncher: boolean;
}

// One file the upgrade replaces: where its release asset is, where it lands first, where the old one waits for rollback.
interface Piece {
    readonly url: string;
    readonly staged: string;
    readonly target: string;
    readonly previous: string;
}

// The agent is last, so every other piece is in place before the one whose restart proves the upgrade.
const piecesOf = (exec: UpgradeExec, version: string): readonly [...Piece[], Piece] => [
    ...(exec.withLauncher
        ? [{ url: launcherAssetUrl(version), staged: `${launcherPath}.new-${version}`, target: launcherPath, previous: `${launcherPath}.previous` }]
        : []),
    { url: agentAssetUrl(version), staged: `${agentPath}.new-${version}`, target: agentPath, previous: `${agentPath}.previous` },
];

// The download is an agent of exactly the release asked for, or the machine keeps the one it has.
const refusal = (probed: string | undefined, target: string): string | undefined => {
    if (probed === undefined) {
        return "what downloaded doesn't run as an agent, keeping the one you have.";
    }
    return probed === target ? undefined : `the ${target} download reports itself as ${probed}, keeping the one you have.`;
};

// The binary can be current while the agent isn't: replacing the file doesn't touch the process.
const reconcileAgent = async (exec: UpgradeExec, installed: string, log: Log): Promise<UpgradeOutcome> => {
    const running = await exec.runningBuild();
    if (running === undefined || running === installed) {
        return { kind: "current", version: installed };
    }
    log(`The background agent is still running ${running}: restarting it on ${installed}.`);
    const came = await exec.restart();
    if (came === installed) {
        return { kind: "restarted", from: running, to: installed };
    }
    return { kind: "agent-behind", installed, ...(came === undefined ? {} : { running: came }) };
};

const fetchAll = async (exec: UpgradeExec, pieces: readonly Piece[]): Promise<string | undefined> => {
    try {
        for (const piece of pieces) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- one download at a time, the launcher is kilobytes
            await exec.fetchTo(piece.url, piece.staged);
        }
        return undefined;
    } catch (error) {
        return `the download failed (${errorMessage(error)}), nothing was changed — what did arrive is kept, so running this again continues from it.`;
    }
};

const swapIn = async (exec: UpgradeExec, pieces: readonly Piece[]): Promise<void> => {
    for (const piece of pieces) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- renames in order, each undone in reverse by swapOut
        await exec.swap(piece.target, piece.previous);
        // oxlint-disable-next-line eslint/no-await-in-loop -- ditto
        await exec.swap(piece.staged, piece.target);
    }
};

const swapOut = async (exec: UpgradeExec, pieces: readonly Piece[]): Promise<void> => {
    for (const piece of pieces.toReversed()) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- the rollback undoes swapIn in reverse
        await exec.swap(piece.previous, piece.target);
    }
};

const discardAll = async (exec: UpgradeExec, paths: readonly string[]): Promise<void> => {
    await Promise.all(paths.map(async (path) => await exec.discard(path)));
};

// After the swap: the restart is the proof, and the only step whose failure puts the previous build back.
const restartOnto = async (exec: UpgradeExec, pieces: readonly Piece[], target: string, installed: string, log: Log): Promise<UpgradeOutcome> => {
    const came = await exec.restart();
    if (came === target) {
        await discardAll(
            exec,
            pieces.map((piece) => piece.previous),
        );
        return { kind: "upgraded", from: installed, to: target };
    }
    // The bytes are in place and something else is serving: a supervisor race or a survived process, not a bad build.
    if (came !== undefined) {
        await discardAll(
            exec,
            pieces.map((piece) => piece.previous),
        );
        return { kind: "agent-behind", installed: target, running: came };
    }
    log(`The new agent didn't stay running: putting the previous one back.`);
    await swapOut(exec, pieces);
    await exec.restart();
    return { kind: "failed", reason: `the new agent (${target}) wouldn't start, so ${installed} was restored and is running again.` };
};

// Never backwards: a machine already on `target` or past it keeps what it has, and a from-source build needs `force`.
export const runUpgrade = async (exec: UpgradeExec, target: string, installed: string, force: boolean, log: Log): Promise<UpgradeOutcome> => {
    if (installed === DEV_VERSION && !force) {
        return {
            kind: "current",
            version: installed,
            note: `this agent was built from source, not installed from a release. \`intentic-machine upgrade --force\` replaces it with the published ${target}.`,
        };
    }
    if (installed !== DEV_VERSION && !isNewer(target, installed)) {
        return await reconcileAgent(exec, installed, log);
    }
    const pieces = piecesOf(exec, target);
    log(`Downloading the agent ${target}…`);
    const failedDownload = await fetchAll(exec, pieces);
    if (failedDownload !== undefined) {
        return { kind: "failed", reason: failedDownload };
    }
    const refused = refusal(exec.probe(pieces.at(-1)?.staged ?? `${agentPath}.new-${target}`), target);
    if (refused !== undefined) {
        await discardAll(
            exec,
            pieces.map((piece) => piece.staged),
        );
        return { kind: "failed", reason: refused };
    }
    const wasRunning = (await exec.runningBuild()) !== undefined;
    await swapIn(exec, pieces);
    if (!wasRunning) {
        await discardAll(
            exec,
            pieces.map((piece) => piece.previous),
        );
        return { kind: "upgraded", from: installed, to: target };
    }
    return await restartOnto(exec, pieces, target, installed, log);
};

// Part files of any other release: nothing else would ever remove a stale one, and one of this release is resumed.
const stagedRelease = (name: string): string => name.slice(name.lastIndexOf(".new"));
const sweepStaged = async (keep: string): Promise<void> => {
    const prefixes = [`${basename(agentPath)}.new`, `${basename(launcherPath)}.new`];
    const stale = (await readdir(binDir).catch(() => [])).filter(
        (name) => prefixes.some((prefix) => name.startsWith(prefix)) && stagedRelease(name) !== stagedRelease(keep),
    );
    await Promise.all(stale.map(async (name) => await rm(join(binDir, name), { force: true }).catch(() => undefined)));
};

// One line per tenth of the transfer, not a repainting bar: this output also ends up in support transcripts.
const downloadProgress = (log: Log): ((received: number, total: number) => void) => {
    let shown = -1;
    return (received, total) => {
        if (total <= 0) {
            return;
        }
        const tenth = Math.floor((10 * received) / total);
        if (tenth > shown) {
            shown = tenth;
            log(`  ${tenth * 10}% of ${Math.round(total / 1_000_000)} MB`);
        }
    };
};

// `swap` is a rename throughout: what lets a running executable be displaced on Windows and every step be undone.
export const realUpgradeExec = (
    restart: () => Promise<string | undefined>,
    runningBuild: () => Promise<string | undefined>,
    log: Log,
): UpgradeExec => ({
    fetchTo: async (url, dest) => {
        await sweepStaged(dest);
        await download(url, dest, { resume: true, onProgress: downloadProgress(log) });
        await chmod(dest, 0o755);
    },
    probe: versionOf,
    swap: renameIfPresent,
    runningBuild,
    restart,
    discard: async (path) => await rm(path, { force: true }).catch(() => undefined),
    withLauncher: process.platform === "win32",
});

// What the command prints. One line per outcome, naming what is true now rather than what was attempted.
export const upgradeMessage = (outcome: UpgradeOutcome): string => {
    if (outcome.kind === "current") {
        return outcome.note === undefined ? `Already on the current agent (${outcome.version}). Nothing to do.` : `Left as it is: ${outcome.note}`;
    }
    if (outcome.kind === "upgraded") {
        return `Upgraded the agent: ${outcome.from} → ${outcome.to}.`;
    }
    if (outcome.kind === "restarted") {
        return `Already on the current agent (${outcome.to}), but the background agent was still running ${outcome.from}: restarted it, so ${outcome.to} is what's serving now.`;
    }
    if (outcome.kind === "agent-behind") {
        return outcome.running === undefined
            ? `The agent on this machine is ${outcome.installed}, but the background agent didn't come back up. Start it with \`intentic-machine run\` and check its log.`
            : `The agent on this machine is ${outcome.installed}, but the background agent is running ${outcome.running}. Stop it with \`intentic-machine run --stop\`, then start it with \`intentic-machine run\`.`;
    }
    return `Upgrade didn't happen: ${outcome.reason}`;
};

// Whether an outcome leaves this environment on the release it was asked for, running it.
export const upgradeLanded = (outcome: UpgradeOutcome): boolean =>
    outcome.kind === "current" || outcome.kind === "upgraded" || outcome.kind === "restarted";
