import { spawnSync } from "node:child_process";
import { chmod, readdir, rename, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import type { Log } from "@intentic/local-agent";
import { DEV_VERSION, isNewer } from "@intentic/sandbox-contract";
import { binDir } from "./sync/config.js";
import { archToken, download, exe, osToken } from "./sync/mutagen.js";

/* UPGRADING THE AGENT IN PLACE, the whole of `intentic-machine upgrade`.
 *
 * It exists because until now there was no such thing. The only way to move a machine onto a newer agent was to
 * re-run the pairing one-liner from the browser: mint a single-use token, watch it expire in ten minutes, paste a
 * command. That is the right ceremony for ENROLLING a computer and absurd for bumping a version, so nobody did
 * it, so machines sat on whatever was published the day they paired, which is how one of them ended up five days
 * behind a fix for the exact bug it was hitting, with the browser cheerfully reporting it as enrolled and fine.
 *
 * An update path is only worth having if it cannot leave the machine worse than it found it, so the order here is
 * chosen so that every step before the swap is reversible and the swap itself is the last thing that happens:
 *
 *   download beside the target → ask the NEW binary what it is → stop the resident loop → swap, keeping the old one →
 *   start it again → confirm it is alive → on any failure, put the old binary back and start it again.
 *
 * The binary being replaced is the one the resident watcher RUNS, which is why it is renamed rather than
 * overwritten: Windows refuses to unlink or overwrite a running executable but does allow renaming one, and the
 * install script has always relied on the same move. */

// Where the install one-liner puts the agent, and therefore what the watcher runs and what this replaces.
export const agentPath = join(binDir, `intentic-machine${exe}`);

/* The published asset for THIS machine, the same URL, built the same way, that computer.sh/sync.sh resolve.
 *
 * PINNED TO A TAG when the version is known, and that is what makes resuming safe: a part file can only ever be
 * continued against the exact release it started from, never spliced together out of two. `latest` is the
 * fallback for a run that could not establish a version, which is also the only run that does not resume. */
export const assetUrl = (version?: string): string => {
    const at = version === undefined ? `latest/download` : `download/v${version}`;
    return `https://github.com/intentic/intentic/releases/${at}/intentic-machine-${osToken()}-${archToken()}${exe}`;
};

/* WHAT THE RELEASE CHANNEL CURRENTLY POINTS AT, asked with a HEAD that transfers no body: `releases/latest`
 * redirects to `…/tag/vX.Y.Z`, and the tag is the answer. The GitHub API would answer the same question and is
 * rate limited to 60/hour per IP — one office behind one NAT is one shared budget — while a redirect is not.
 *
 * Undefined for every failure, which is the honest answer and not a fatal one: the caller then downloads and
 * decides on what it actually got, exactly as this command did before the question could be asked at all. */
export const publishedVersion = async (): Promise<string | undefined> => {
    try {
        const response = await fetch(`https://github.com/intentic/intentic/releases/latest`, { method: "HEAD", redirect: "follow" });
        return /\/tag\/v(\d+\.\d+\.\d+)$/.exec(response.url)?.[1];
    } catch {
        return undefined;
    }
};

/* Ask a binary what version it is, the smoke test, and the one question whose answer proves the download is a
 * working agent of a known build rather than 94MB of HTML from a captive portal, a truncated body, or a binary
 * for the wrong architecture. It is deliberately the LAST thing checked before the swap and the first thing that
 * can veto it: everything after the swap can only be repaired by rolling back.
 *
 * The three answers are three different situations, and collapsing them (as this first did) produces the one
 * outcome worse than a bad message: the very first real run of `upgrade` reported a perfectly good download as
 * "doesn't run as an agent", because the agent it downloaded was simply older than the `version` command itself.
 * Alarming, wrong, and it hid the correct reason, which was that installing it would have been a downgrade. */
export type Probe = { readonly kind: "version"; readonly version: string } | { readonly kind: "no-version-command" } | { readonly kind: "unusable" };

const probeVersion = (binary: string): Probe => {
    const result = spawnSync(binary, ["version"], { encoding: "utf8", timeout: 30_000, windowsHide: true });
    // `error` is this process failing to EXECUTE the file at all, not a binary, wrong architecture, not executable.
    if (result.error !== undefined) {
        return { kind: "unusable" };
    }
    const version = result.status === 0 ? /^\d+\.\d+\.\d+$/.exec(result.stdout.trim())?.[0] : undefined;
    if (version !== undefined) {
        return { kind: "version", version };
    }
    /* It ran and declined the command. That is an AGENT, every release before this command existed answers
     * exactly this way, and being unable to state a version is itself the useful fact: it places the download
     * strictly before every build that can, which is all the ordering the decision below needs. */
    return { kind: result.status === 0 ? "unusable" : "no-version-command" };
};

// What an upgrade did, as a value, so the command prints it and a test asserts it without reading prose.
export type UpgradeOutcome =
    | { readonly kind: "current"; readonly version: string; readonly note?: string }
    | { readonly kind: "upgraded"; readonly from: string; readonly to: string }
    | { readonly kind: "failed"; readonly reason: string };

// The effects the upgrade has, behind one seam, so the ORDER above, which is the part worth getting right, is
// testable without a network, a disk or a running watcher.
export interface UpgradeExec {
    readonly published: () => Promise<string | undefined>;
    readonly fetchTo: (url: string, dest: string) => Promise<void>;
    readonly probe: (binary: string) => Probe;
    readonly swap: (from: string, to: string) => Promise<void>;
    readonly stopWatcher: () => Promise<number | undefined>;
    readonly startWatcher: () => Promise<void>;
    readonly watcherAlive: () => Promise<boolean>;
    readonly discard: (path: string) => Promise<void>;
}

/* WHETHER WHAT LANDED MAY BE INSTALLED — every reason it may not, in one pure decision, so the ORDER in
 * runUpgrade stays readable and each rule can be read on its own. Every refusal here throws the download away:
 * it is bytes that this machine has now decided against, not progress toward anything. */
type Verdict = { readonly install: true; readonly version: string } | { readonly install: false; readonly outcome: UpgradeOutcome };

const verdictFor = (probed: Probe, installed: string, force: boolean): Verdict => {
    if (probed.kind === "unusable") {
        // The most valuable refusal in the whole command: whatever landed is not a working agent, and the machine
        // still has one that is.
        return { install: false, outcome: { kind: "failed", reason: `what downloaded doesn't run as an agent, keeping the one you have.` } };
    }
    /* An agent too old to state its version, which places it before every build that can, so installing it is a
     * downgrade by definition. Declined even with --force: that flag exists to override a judgement about a build
     * made from SOURCE, not to install bytes whose version nothing can establish. */
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
    /* UPGRADE NEVER MOVES A MACHINE BACKWARDS. Same version is the common case and the obvious one, nothing to
     * do, and saying so is the answer, because a command that bounces the watcher when there is nothing to do is
     * one people learn not to run. But OLDER is the case worth naming: `latest` is whatever the release channel
     * currently points at, and it can be behind a particular machine (a release pulled, or the machine's agent
     * built from source ahead of it). Installing it anyway would be an "upgrade" that removes features the user
     * is standing on, including, on the machine this was first run from, this very command. */
    if (installed !== DEV_VERSION && !isNewer(probed.version, installed)) {
        return { install: false, outcome: { kind: "current", version: installed } };
    }
    /* A build made from source, deliberately, by whoever is running this. It carries the dev sentinel, which every
     * published release outranks numerically, so the rule above cannot protect it, and without this the first
     * `upgrade` on a developer's own machine would quietly replace the agent they just built with the last one
     * that happened to be published. It is still a legitimate thing to want (going back to the released agent is
     * how you leave dogfooding), so it is asked for rather than refused. */
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

/* WHERE THE DOWNLOAD LANDS, and what it says while it happens. The part file carries the version it is
 * fetching, so a transfer interrupted today and continued tomorrow cannot splice two releases together — and a
 * run that could not resolve a version has no such name to give it, so that one never resumes: it starts
 * clean, and it throws away what it got (realUpgradeExec). */
const stagingFor = (published: string | undefined): { readonly path: string; readonly says: string } =>
    published === undefined
        ? { path: `${agentPath}.new`, says: `Downloading the current agent…` }
        : { path: `${agentPath}.new-${published}`, says: `Downloading the current agent (${published})…` };

/* Whether the watcher has to be running when this is over. It is running for almost everybody (it is registered
 * at login), but "not running" is a legitimate state, `--stop`, a mirror-only machine between reboots, and an
 * upgrade must not quietly start a background process the user had deliberately stopped. So the rule is: put it
 * back the way it was, which also makes the rollback check below meaningful rather than a coin toss. */
export const runUpgrade = async (
    exec: UpgradeExec,
    asset: (version?: string) => string,
    installed: string,
    force: boolean,
    log: Log,
): Promise<UpgradeOutcome> => {
    /* THE QUESTION ASKED BEFORE ~95 MB MOVES, and the reason `upgrade` on a machine that is already current now
     * costs one HEAD request instead of a two-minute download that ends in "nothing to do". It answers exactly
     * what the probe below would have answered after the download, by exactly the same rule — which is why the
     * probe stays: a version resolved from a tag says what SHOULD be at that URL, and only running what landed
     * says what is. This is an optimisation of the same decision, never a second, weaker version of it. */
    const published = await exec.published();
    if (published !== undefined && installed !== DEV_VERSION && !isNewer(published, installed)) {
        return { kind: "current", version: installed };
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
        return verdict.outcome;
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
    await exec.startWatcher();
    if (await exec.watcherAlive()) {
        await exec.discard(previous);
        return { kind: "upgraded", from: installed, to: candidate };
    }
    /* THE ROLLBACK. The new agent answered `version` and then could not stay up, a shape no smoke test catches,
     * because it is about this machine (a config it cannot read, a port it cannot bind) rather than about the
     * binary. Leaving it installed would trade a machine that was merely OUT OF DATE for one that has no working
     * sync at all, which is the one outcome that would make an update command not worth running. */
    log(`The new agent didn't stay running: putting the previous one back.`);
    await exec.swap(previous, agentPath);
    await exec.startWatcher();
    return { kind: "failed", reason: `the new agent (${candidate}) wouldn't start, so ${installed} was restored and is running again.` };
};

/* PART FILES FROM RELEASES THAT ARE NO LONGER BEING DOWNLOADED. Each one is ~95 MB, the name carries the
 * version precisely so two of them can exist, and nothing else would ever remove them: a machine that was
 * interrupted upgrading to 1.180.0 and later upgraded to 1.190.0 would keep the first one forever. Best-effort
 * throughout — a leftover that cannot be removed must never be the reason an upgrade does not happen. */
const sweepStaged = async (keep: string): Promise<void> => {
    const stale = await readdir(binDir).catch(() => []);
    const prefix = `${basename(agentPath)}.new`;
    await Promise.all(
        stale
            .filter((name) => name.startsWith(prefix) && join(binDir, name) !== keep)
            .map(async (name) => await rm(join(binDir, name), { force: true }).catch(() => undefined)),
    );
};

// One line per tenth of the transfer, which is what a 95 MB download owes somebody watching it. Not a
// repainting bar: this output is also what a support transcript is made of, and a carriage return in a log
// file is a line nobody can read.
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

// The real effects. `swap` is a rename throughout, see the header: it is what lets a RUNNING executable be
// displaced on Windows, and what makes every step here undoable by renaming back.
export const realUpgradeExec = (
    stopWatcher: () => Promise<number | undefined>,
    startWatcher: () => Promise<void>,
    alive: () => Promise<boolean>,
    log: Log,
): UpgradeExec => ({
    published: publishedVersion,
    fetchTo: async (url, dest) => {
        await sweepStaged(dest);
        /* ONLY A STAGED FILE WHOSE NAME CARRIES A VERSION MAY BE CONTINUED. With one, an interrupted upgrade is
         * picked up by the next rather than started again (mutagen.ts's download for the whole of why). Without
         * one — a run that could not resolve what is published — nothing says which release the bytes on disk
         * came from, so a leftover from a killed run is thrown away rather than resumed into a splice. */
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
    watcherAlive: alive,
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
    return `Upgrade didn't happen: ${outcome.reason}`;
};
