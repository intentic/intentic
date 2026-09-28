import { existsSync } from "node:fs";
import { readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import { writeFileAtomic } from "@intentic/base/fs";
import type { Log } from "@intentic/local-agent";
import { DEV_VERSION } from "@intentic/sandbox-contract";
import { z } from "zod";
import { baseDir } from "./config.js";
import { readMachineConfig, updateMachineConfig } from "./environments/machine.js";
import { installedBuild, runningAsInstalledAgent } from "./installed.js";
import { agentPath, launcherPath, renameIfPresent } from "./release.js";
import { MACHINE_VERSION } from "./version.js";

// A NEW AGENT IS ON TRIAL UNTIL IT HAS RUN FOR TEN MINUTES. An upgrade keeps the binary it replaced as `<bin>.previous`
// (upgrade.ts), and the agent it started writes a "healthy since" marker once it has stayed up that long, which is what
// drops the kept copy. An agent that instead keeps stopping (three starts in ten minutes without the marker, none of
// them ended by somebody asking) is put back to the one before it, by the next of its own starts or the next upgrade
// pass, whichever comes first, and its release is recorded so no upgrade moves this environment onto it again until a
// newer one is published. The rules are pure over two small files, so they are asserted without a process to crash.

// How long a new agent has to stay up to be the one kept.
export const HEALTHY_AFTER_MS = 10 * 60_000;
// How many starts inside that window, none of them cleanly ended, make a crash loop.
export const CRASH_LOOP_STARTS = 3;

const startsPath = join(baseDir, "agent-starts.json");
const healthyPath = join(baseDir, "agent-healthy.json");

const StartSchema = z.object({ at: z.number(), pid: z.number(), clean: z.boolean().optional() });
// The recent starts of one release, newest last.
const StartLedgerSchema = z.object({ version: z.string(), starts: z.array(StartSchema) });
export type StartLedger = z.infer<typeof StartLedgerSchema>;
// The release that has stayed up for HEALTHY_AFTER_MS, and since when.
const HealthySchema = z.object({ version: z.string(), since: z.number() });

// A start of `version`: the ledger of another release starts over, and starts older than the window are forgotten.
export const withStart = (ledger: StartLedger | undefined, version: string, pid: number, now: number): StartLedger => ({
    version,
    starts: [...(ledger?.version === version ? ledger.starts.filter((start) => now - start.at < HEALTHY_AFTER_MS) : []), { at: now, pid }],
});

// The start `pid` made ended because somebody or something asked it to (a stop, a restart, an upgrade, nothing left to
// serve), which is not a crash.
export const withCleanExit = (ledger: StartLedger, pid: number): StartLedger => ({
    ...ledger,
    starts: ledger.starts.map((start) => (start.pid === pid ? { ...start, clean: true } : start)),
});

// Whether the ledger's release is crash-looping: not the release that proved itself, and started CRASH_LOOP_STARTS
// times inside the window without one of them having ended cleanly (the start asking counts, since it has not).
export const crashLooping = (ledger: StartLedger, healthy: string | undefined, now: number): boolean =>
    ledger.version !== healthy && ledger.starts.filter((start) => start.clean !== true && now - start.at < HEALTHY_AFTER_MS).length >= CRASH_LOOP_STARTS;

const readJson = async <T>(path: string, schema: z.ZodType<T>): Promise<T | undefined> => {
    // allow(silent-catch): no file is no history, and a torn one is treated the same: it starts the count over
    const raw = await readFile(path, "utf8").catch(() => undefined);
    try {
        const parsed = raw === undefined ? undefined : schema.safeParse(JSON.parse(raw));
        return parsed?.success === true ? parsed.data : undefined;
    } catch {
        // allow(silent-catch): bytes that are not JSON are a torn write, the same as no file
        return undefined;
    }
};

const readLedger = async (): Promise<StartLedger | undefined> => await readJson(startsPath, StartLedgerSchema);
const readHealthyVersion = async (): Promise<string | undefined> => (await readJson(healthyPath, HealthySchema))?.version;
const writeLedger = async (ledger: StartLedger): Promise<void> => await writeFileAtomic(startsPath, JSON.stringify(ledger));

// The agent `pid` was stopped on purpose, recorded by whoever stopped it: on Windows a stop ends the process without
// running any of its handlers, so the agent could never say so itself, and every restart would read as a crash.
export const recordStopped = async (pid: number): Promise<void> => {
    const ledger = await readLedger();
    if (ledger !== undefined) {
        // allow(silent-catch): a stop left unrecorded counts as one crash of three, never as a reason to fail the stop
        await writeLedger(withCleanExit(ledger, pid)).catch(() => undefined);
    }
};

const previousOf = (target: string): string => `${target}.previous`;

// One piece back: the current one set aside as `.old` (swept at the next start, release.ts), the kept one in its place.
// A failure puts the current one back, so the path is never left empty for a supervisor to start nothing from.
const putBack = async (target: string): Promise<void> => {
    if (!existsSync(previousOf(target))) {
        return;
    }
    const aside = `${target}.old`;
    await renameIfPresent(target, aside);
    try {
        await rename(previousOf(target), target);
    } catch (error) {
        await renameIfPresent(aside, target);
        throw error;
    }
};

// The kept binaries back in place, the launcher before the agent as the upgrade itself orders them, and the release
// recorded as skipped. Answers whether the agent's binary is the previous one now.
const rollBack = async (version: string, log: Log): Promise<boolean> => {
    try {
        await putBack(launcherPath);
        await putBack(agentPath);
    } catch (error) {
        log(`the agent ${version} keeps stopping, but the one before it could not be put back (${errorMessage(error)}).`);
        return false;
    }
    try {
        await updateMachineConfig((config) => ({ ...config, skippedAgent: { version, at: Date.now() } }));
    } catch (error) {
        log(`could not record ${version} as skipped (${errorMessage(error)}); an upgrade may offer it again.`);
    }
    log(
        `the agent ${version} stopped ${CRASH_LOOP_STARTS} times within ${HEALTHY_AFTER_MS / 60_000} minutes of starting, so the one it replaced is back in its place. ${version} is skipped here until a newer release is published.`,
    );
    return true;
};

// Once this release has proved itself: remember it, drop the copies kept to undo its update, and lift a skip that named
// it (somebody installed it on purpose, and it held). Best-effort: a marker that did not land costs only the drop.
const markHealthy = async (version: string, since: number, log: Log): Promise<void> => {
    try {
        await proven(version, since, log);
    } catch (error) {
        log(`could not record the agent ${version} as healthy (${errorMessage(error)}).`);
    }
};

const proven = async (version: string, since: number, log: Log): Promise<void> => {
    await writeFileAtomic(healthyPath, JSON.stringify({ version, since }));
    const kept = [previousOf(agentPath), previousOf(launcherPath)].filter((path) => existsSync(path));
    await Promise.all(kept.map(async (path) => await rm(path, { force: true })));
    if (kept.length > 0) {
        log(`the agent ${version} has run for ${HEALTHY_AFTER_MS / 60_000} minutes, so the copy of the one before it, kept to undo this update, is dropped.`);
    }
    // allow(silent-catch): a config that does not read holds no skip this could lift
    if ((await readMachineConfig().catch(() => undefined))?.skippedAgent?.version === version) {
        await updateMachineConfig(({ skippedAgent: _lifted, ...rest }) => rest);
    }
};

// What a running agent does with its trial: end it cleanly on a deliberate exit, and prove itself after the window.
export interface Trial {
    readonly clean: () => Promise<void>;
    // Starts the window's clock; the answer stops it.
    readonly prove: (log: Log) => () => void;
}

const INERT: Trial = { clean: async () => await Promise.resolve(), prove: () => () => undefined };

// The start of the resident agent, before it claims anything: recorded, and when it is the third of a crash loop, the
// previous agent is put back instead ("restored", after which this process exits for its supervisor to start that one).
// Only the installed agent of a released build takes part: a build from source has no previous to go back to.
export const beginTrial = async (log: Log): Promise<Trial | "restored"> => {
    if (!runningAsInstalledAgent() || MACHINE_VERSION === DEV_VERSION) {
        return INERT;
    }
    const startedAt = Date.now();
    const ledger = withStart(await readLedger(), MACHINE_VERSION, process.pid, startedAt);
    try {
        await writeLedger(ledger);
    } catch (error) {
        log(`could not record this start (${errorMessage(error)}); a crash loop of this release goes unnoticed until it can.`);
    }
    if (crashLooping(ledger, await readHealthyVersion(), startedAt) && existsSync(previousOf(agentPath)) && (await rollBack(MACHINE_VERSION, log))) {
        return "restored";
    }
    return {
        clean: async () => await recordStopped(process.pid),
        prove: (say) => {
            const timer = setTimeout(() => void markHealthy(MACHINE_VERSION, startedAt, say), HEALTHY_AFTER_MS);
            timer.unref();
            return () => clearTimeout(timer);
        },
    };
};

// The upgrade pass's half: an installed agent crash-looping right now is put back before anything else is decided, so
// the pass works from the agent that held. Its supervisor, restarting it anyway, starts the restored one.
export const rollBackIfCrashLooping = async (log: Log): Promise<boolean> => {
    const ledger = await readLedger();
    if (ledger === undefined || !existsSync(previousOf(agentPath)) || installedBuild() !== ledger.version) {
        return false;
    }
    return crashLooping(ledger, await readHealthyVersion(), Date.now()) && (await rollBack(ledger.version, log));
};
