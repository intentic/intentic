import { spawnSync } from "node:child_process";
import { chmod, readdir, rename, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import type { Log } from "@intentic/local-agent";
import { DEV_VERSION, isNewer } from "@intentic/sandbox-contract";
import { agentPath } from "./installed.js";
import { binDir } from "./sync/config.js";
import { archToken, download, exe, osToken } from "./sync/mutagen.js";

// Upgrades the agent in place. Every step before the swap is reversible and the swap is last: on any failure,
// the old binary is restored and restarted. Renamed rather than overwritten, since Windows refuses to unlink or
// overwrite a running executable.
// download beside target → probe the new binary → stop the loop → swap (keep the old one) → start it → confirm the loop
// that came up is the new build

// The published asset URL, resolved the same way device.sh/sync.sh do. Pinned to a tag when known, since a part
// file can only resume against the exact release it started from; `latest` is the fallback that never resumes.
export const assetUrl = (version?: string): string => {
    const at = version === undefined ? `latest/download` : `download/v${version}`;
    return `https://github.com/intentic/intentic/releases/${at}/intentic-machine-${osToken()}-${archToken()}${exe}`;
};

// What the release channel points at, via a bodyless HEAD to `releases/latest` (redirects to `…/tag/vX.Y.Z`); the
// GitHub API answers the same but is rate-limited per IP. Undefined on any failure, so the caller just downloads and
// decides.
export const publishedVersion = async (): Promise<string | undefined> => {
    try {
        const response = await fetch(`https://github.com/intentic/intentic/releases/latest`, { method: "HEAD", redirect: "follow" });
        return /\/tag\/v(\d+\.\d+\.\d+)$/.exec(response.url)?.[1];
    } catch {
        return undefined;
    }
};

// Asks a binary what version it is, the smoke test proving a download is a working agent rather than a
// captive-portal page or wrong-arch binary. Last check before the swap; the three answers are different
// situations, not one collapsed verdict.
export type Probe = { readonly kind: "version"; readonly version: string } | { readonly kind: "no-version-command" } | { readonly kind: "unusable" };

const probeVersion = (binary: string): Probe => {
    const result = spawnSync(binary, ["version"], { encoding: "utf8", timeout: 30_000, windowsHide: true });
    // `error` means this process failed to execute the file at all: not a binary, wrong arch, not executable.
    if (result.error !== undefined) {
        return { kind: "unusable" };
    }
    const version = result.status === 0 ? /^\d+\.\d+\.\d+$/.exec(result.stdout.trim())?.[0] : undefined;
    if (version !== undefined) {
        return { kind: "version", version };
    }
    // It ran and declined the command: still an agent, just one older than every build that can answer `version`,
    // which is all the ordering the decision below needs.
    return { kind: result.status === 0 ? "unusable" : "no-version-command" };
};

// What an upgrade did, as a value the command prints and tests assert. `restarted` already had the right bytes
// but served the old build; `loop-behind` is a swap that landed but didn't take.
export type UpgradeOutcome =
    | { readonly kind: "current"; readonly version: string; readonly note?: string }
    | { readonly kind: "restarted"; readonly from: string; readonly to: string }
    | { readonly kind: "upgraded"; readonly from: string; readonly to: string }
    | { readonly kind: "loop-behind"; readonly installed: string; readonly running?: string }
    | { readonly kind: "failed"; readonly reason: string };

// The upgrade's effects behind one seam, so step order (the part worth getting right) is testable without a
// network, disk, or running watcher.
export interface UpgradeExec {
    readonly published: () => Promise<string | undefined>;
    readonly fetchTo: (url: string, dest: string) => Promise<void>;
    readonly probe: (binary: string) => Probe;
    readonly swap: (from: string, to: string) => Promise<void>;
    readonly stopWatcher: () => Promise<number | undefined>;
    // Starts the loop and returns the build that came up, undefined if none. A plain "is it alive" check can't tell
    // a failed swap or a supervisor race from success.
    readonly startWatcher: () => Promise<string | undefined>;
    /** What the loop holding the pidfile right now is running, undefined when nothing holds it. */
    readonly runningBuild: () => Promise<string | undefined>;
    readonly discard: (path: string) => Promise<void>;
}

// Whether what landed may be installed, every refusal in one pure decision so runUpgrade's order stays readable.
// Every refusal here discards the download; it's bytes this machine decided against, not progress.
type Verdict = { readonly install: true; readonly version: string } | { readonly install: false; readonly outcome: UpgradeOutcome };

const verdictFor = (probed: Probe, installed: string, force: boolean): Verdict => {
    if (probed.kind === "unusable") {
        // The most valuable refusal here: whatever landed isn't working, and the machine still has an agent that is.
        return { install: false, outcome: { kind: "failed", reason: `what downloaded doesn't run as an agent, keeping the one you have.` } };
    }
    // Too old to state its version places it before every build that can, so installing it is a downgrade by
    // definition. Declined even with --force, which overrides a from-source judgement, not an unidentifiable download.
    if (probed.kind === "no-version-command") {
        return {
            install: false,
            outcome: {
                kind: "current",
                version: installed,
                note: `the published agent predates \`intentic-machine version\`, so it is older than the one on this machine, yours is kept.`,
            },
        };
    }
    // Never moves a machine backwards: same version means nothing to do. `latest` can sit behind this machine (a
    // pulled release, or a from-source build ahead of it), so installing it would remove features the user stands on.
    if (installed !== DEV_VERSION && !isNewer(probed.version, installed)) {
        return { install: false, outcome: { kind: "current", version: installed } };
    }
    // A from-source build carries the dev sentinel, which every release outranks numerically, so without this
    // exception the first upgrade would quietly replace it. Still legitimate to want, so it's asked for (--force), not
    // refused outright.
    if (installed === DEV_VERSION && !force) {
        return {
            install: false,
            outcome: {
                kind: "current",
                version: installed,
                note: `this agent was built from source, not installed from a release. \`intentic-machine upgrade --force\` replaces it with the published ${probed.version}.`,
            },
        };
    }
    return { install: true, version: probed.version };
};

// Where the download lands and what it says while doing it. The part file's name carries its version, so an
// interrupted transfer can't splice two releases together; a run with no resolved version can't name one, so it never
// resumes.
const stagingFor = (published: string | undefined): { readonly path: string; readonly says: string } =>
    published === undefined
        ? { path: `${agentPath}.new`, says: `Downloading the current agent…` }
        : { path: `${agentPath}.new-${published}`, says: `Downloading the current agent (${published})…` };

// The binary can be current while the loop isn't: replacing the file doesn't touch the process. Reconciles only
// the skew; an already-current loop, or none running at all, is left alone.
const reconcileLoop = async (exec: UpgradeExec, installed: string, log: Log): Promise<UpgradeOutcome> => {
    const running = await exec.runningBuild();
    if (running === undefined || running === installed) {
        return { kind: "current", version: installed };
    }
    log(`The background loop is still running ${running}: restarting it on ${installed}.`);
    // No stop of our own: starting already stops whatever holds the pidfile first (resident.ts); a second stop here
    // would just add a timeout.
    const came = await exec.startWatcher();
    if (came === installed) {
        return { kind: "restarted", from: running, to: installed };
    }
    return { kind: "loop-behind", installed, ...(came === undefined ? {} : { running: came }) };
};

// Whether the watcher must be running when this is over: put it back the way it was, since `--stop` and
// mirror-only machines are legitimate not-running states an upgrade must not quietly override.
export const runUpgrade = async (
    exec: UpgradeExec,
    asset: (version?: string) => string,
    installed: string,
    force: boolean,
    log: Log,
): Promise<UpgradeOutcome> => {
    // Asked before ~95 MB moves, so an already-current machine costs one HEAD request, not a download. Answers the
    // same question the probe below would after downloading, by the same rule; an optimisation of that decision, not a
    // second one.
    const published = await exec.published();
    if (published !== undefined && installed !== DEV_VERSION && !isNewer(published, installed)) {
        // Nothing to download isn't nothing to do: the loop may still serve an older build than this machine's file.
        return await reconcileLoop(exec, installed, log);
    }
    const { path: staged, says } = stagingFor(published);
    const previous = `${agentPath}.previous`;
    log(says);
    try {
        await exec.fetchTo(asset(published), staged);
    } catch (error) {
        const reason = errorMessage(error);
        if (published === undefined) {
            await exec.discard(staged);
            return { kind: "failed", reason: `the download failed (${reason}), nothing was changed.` };
        }
        return {
            kind: "failed",
            reason: `the download failed (${reason}), nothing was changed — what did arrive is kept, so running this again continues from it.`,
        };
    }
    const verdict = verdictFor(exec.probe(staged), installed, force);
    if (!verdict.install) {
        await exec.discard(staged);
        // Nothing installed, but "not newer than mine" is the case the short-circuit above already handles, reached
        // here
        // after a failed channel read. The two noted verdicts are left alone: bouncing that loop isn't this command's
        // business.
        return verdict.outcome.kind === "current" && verdict.outcome.note === undefined ? await reconcileLoop(exec, installed, log) : verdict.outcome;
    }
    const candidate = verdict.version;
    const wasRunning = (await exec.stopWatcher()) !== undefined;
    await exec.swap(agentPath, previous);
    await exec.swap(staged, agentPath);
    if (!wasRunning) {
        // It was not running before, so it is not started now, and there is nothing to verify by starting it.
        await exec.discard(previous);
        return { kind: "upgraded", from: installed, to: candidate };
    }
    const came = await exec.startWatcher();
    if (came === candidate) {
        await exec.discard(previous);
        return { kind: "upgraded", from: installed, to: candidate };
    }
    // A loop came up that isn't what was just installed. Not a failed upgrade (the bytes are in place, rolling back
    // would undo real work), but something else is still serving: a survived process, a supervisor restart, a second
    // install.
    if (came !== undefined) {
        await exec.discard(previous);
        return { kind: "loop-behind", installed: candidate, running: came };
    }
    // The rollback: the new agent answered `version` but couldn't stay up, a machine-specific failure (bad config, a
    // port it can't bind) no smoke test catches. Leaving it installed would trade merely-outdated for no working sync
    // at all.
    log(`The new agent didn't stay running: putting the previous one back.`);
    await exec.swap(previous, agentPath);
    await exec.startWatcher();
    return { kind: "failed", reason: `the new agent (${candidate}) wouldn't start, so ${installed} was restored and is running again.` };
};

// Part files from releases no longer being downloaded (~95 MB each); nothing else would ever remove a stale one.
// Best-effort: a leftover that can't be removed must never block an upgrade.
const sweepStaged = async (keep: string): Promise<void> => {
    const stale = await readdir(binDir).catch(() => []);
    const prefix = `${basename(agentPath)}.new`;
    await Promise.all(
        stale
            .filter((name) => name.startsWith(prefix) && join(binDir, name) !== keep)
            .map(async (name) => await rm(join(binDir, name), { force: true }).catch(() => undefined)),
    );
};

// One line per tenth of the transfer, not a repainting bar: this output also ends up in support transcripts,
// where a carriage return is a line nobody can read.
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

// The real effects. `swap` is a rename throughout, which is what lets a running executable be displaced on
// Windows and every step here be undone by renaming back.
export const realUpgradeExec = (
    stopWatcher: () => Promise<number | undefined>,
    startWatcher: () => Promise<string | undefined>,
    runningBuild: () => Promise<string | undefined>,
    log: Log,
): UpgradeExec => ({
    published: publishedVersion,
    fetchTo: async (url, dest) => {
        await sweepStaged(dest);
        // Only a staged file whose name carries a version may be continued, so an interrupted upgrade resumes rather
        // than
        // restarts. Without a version, a leftover can't be attributed to a release, so it's discarded rather than
        // risked into a splice.
        const resume = /\.new-\d/.test(dest);
        if (!resume) {
            await rm(dest, { force: true }).catch(() => undefined);
        }
        await download(url, dest, { resume, onProgress: downloadProgress(log) });
        await chmod(dest, 0o755);
    },
    probe: probeVersion,
    swap: async (from, to) => await rename(from, to),
    stopWatcher,
    startWatcher,
    runningBuild,
    discard: async (path) => await rm(path, { force: true }).catch(() => undefined),
});

// What the command prints. One line per outcome, naming what is true now rather than what was attempted.
export const upgradeMessage = (outcome: UpgradeOutcome): string => {
    if (outcome.kind === "current") {
        return outcome.note === undefined ? `Already on the current agent (${outcome.version}). Nothing to do.` : `Left as it is: ${outcome.note}`;
    }
    if (outcome.kind === "upgraded") {
        return `Upgraded the agent: ${outcome.from} → ${outcome.to}.`;
    }
    // Both loop outcomes name which build is serving: the number every surface shows and users came to change.
    if (outcome.kind === "restarted") {
        return `Already on the current agent (${outcome.to}), but the background loop was still running ${outcome.from}: restarted it, so ${outcome.to} is what's serving now.`;
    }
    if (outcome.kind === "loop-behind") {
        // Two different machines: one still serving an older build, one left serving nothing. The second only follows a
        // restart that was asked for, so it names the command to undo it.
        return outcome.running === undefined
            ? `The agent on this machine is ${outcome.installed}, but the background loop didn't come back up. Start it with \`intentic-machine run\` and check its log.`
            : `The agent on this machine is ${outcome.installed}, but the background loop is running ${outcome.running}. Stop it with \`intentic-machine run --stop\`, then start it with \`intentic-machine run\`.`;
    }
    return `Upgrade didn't happen: ${outcome.reason}`;
};
