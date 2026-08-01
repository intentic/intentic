import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { PROBES, type ProbeSpec } from "@intentic/sandbox-contract/chores";
import type { ProbeId, ProbeResult } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import { discoverRepos } from "../workspace/repo-discovery.js";
import { type ChoresStore, isStale, probeOf } from "./chores-store.js";

const execFileAsync = promisify(execFile);

/* THE PROBE RUNNER — the only thing in this system that spends real machine time on maintenance, and therefore
 * the only thing that has to be careful about it.
 *
 * It refreshes expired measurements in the background so that the rail can tell you something you did not already
 * know. That is the whole reason it exists rather than probing on demand: a badge that only updates while you are
 * already looking at the Maintenance view could never tell you anything new, which is the same argument the
 * documentation extension's own attention poll makes.
 *
 * ONE AT A TIME, ACROSS THE WHOLE SANDBOX. Not one per repo, not one per probe. `pnpm audit` hits the network,
 * `knip` type-checks the tree and `jscpd` tokenizes every file — three of those at once on a box that is also
 * running the user's agents is a machine that feels broken. A serialized queue makes the worst case "the panel is
 * a few minutes behind", which nobody notices, instead of "my turn got slow", which everybody does.
 *
 * IT NEVER RUNS WHILE AGENTS ARE WORKING. The tick skips entirely if any turn is live. Maintenance is by
 * definition the least urgent thing this daemon does, and a background sweep that steals CPU from the work the
 * owner is watching would be the surface's first and worst impression.
 *
 * IT IS ALLOWED TO FAIL. Every failure mode here — a tool missing, a network-less audit, a jscpd that runs out of
 * memory — is recorded as a probe state and rendered honestly in the panel. None of it throws into the daemon,
 * and none of it retries in a loop: a failure holds its slot for an hour (chores-store's RETRY_MS) and the first
 * tick past that is the retry, which is a rate limit for free. NOT the probe's own TTL, which is a week for tier
 * 2 — a lease that long is for a measurement we trust, and a failure is the opposite of one. */

// How often the runner wakes to look for expired measurements. The shortest TTL is a day, so this only has to be
// small enough that a sandbox which is up for a few hours a day still refreshes; it is not a polling interval in
// any meaningful sense.
const TICK_MS = 30 * 60_000;
// How long after boot the first tick waits. Long enough to be behind image pulls, dependency installs and the
// first index build — a probe racing `pnpm install` measures a tree that does not exist yet.
const WARMUP_MS = 5 * 60_000;
// How much of a DYING tool's output is kept as the reason, taken from the end: the message that killed it is the
// last thing it printed, under whatever stack trace preceded it. Enough to name the cause, short enough that a
// thousand-line trace cannot bloat the file every reader of this surface polls.
const REASON_TAIL = 400;
/* How much of an UNRECOGNISED output is kept, taken from the front and much shorter. A tool that printed an error
 * instead of its report says so in the first line, whereas the last 400 characters of 20 KB of JSON are a fragment
 * from the middle of an array — unreadable, near-identical for every possible cause, and long enough to spill
 * across the panel's measurement strip. The front says which of the two happened, which is the whole question. */
const REASON_HEAD = 160;

const tail = (text: string): string => text.trim().slice(-REASON_TAIL);
const head = (text: string): string => {
    const trimmed = text.trim();
    return trimmed.length <= REASON_HEAD ? trimmed : `${trimmed.slice(0, REASON_HEAD)}…`;
};

/* Run one probe against one repo and return what to record. Never throws: every outcome is a ProbeResult, because
 * the panel showing "jscpd failed: out of memory" is strictly better than a probe that vanishes and leaves a chore
 * reading "not measured yet" forever with no explanation. */
export const runProbe = async (spec: ProbeSpec, cwd: string, nowMs: number): Promise<ProbeResult> => {
    const started = Date.now();
    const finish = (rest: Omit<ProbeResult, "id" | "ranAt" | "tookMs">): ProbeResult => ({
        id: spec.id,
        ranAt: nowMs,
        tookMs: Date.now() - started,
        ...rest,
    });

    try {
        await execFileAsync("sh", ["-c", spec.available], { cwd, timeout: 30_000 });
    } catch {
        // The tool is not part of this repository. Not a failure and not a clean result — see ProbeStateSchema.
        return finish({ state: "unavailable", reason: `this repository has no ${spec.title.toLowerCase()} to measure` });
    }

    let stdout: string;
    try {
        // maxBuffer because knip and jscpd on a large repo emit megabytes of JSON, and the default 1MB would
        // truncate it into something the parser correctly refuses — reported as a failure nobody could diagnose.
        ({ stdout } = await execFileAsync("sh", ["-c", spec.command], { cwd, timeout: spec.timeoutMs, maxBuffer: 64 * 1024 * 1024 }));
    } catch (error) {
        const { stdout: out, stderr, killed } = error as { stdout?: string; stderr?: string; killed?: boolean };
        const reason = killed === true ? `timed out after ${Math.round(spec.timeoutMs / 1000)}s` : tail(`${stderr ?? ""}${out ?? ""}`);
        return finish({ state: "failed", reason: reason === "" ? `the command exited without output` : reason });
    }

    const facts = spec.parse(stdout);
    if (facts === undefined) {
        return finish({ state: "failed", reason: `could not read the tool's output: ${head(stdout) || `it printed nothing`}` });
    }
    return finish({ state: "ok", facts });
};

/* What the runner needs, named rather than taken as the whole Services object: it is a background sweep over a
 * store and a clock, and a narrow dependency is what makes it testable without standing up a daemon. `agents` is
 * structural for the same reason — the only thing asked of the registry is whether anything is running. */
export interface ProbeRunnerDeps {
    readonly workspace: { readonly root: string };
    readonly chores: ChoresStore;
    readonly agents: { readonly liveSessionIds: () => readonly string[] };
    readonly logger: Logger;
}

// Every (repo, probe) pair whose cached result has expired, tier 1 before tier 2 — the cheap measurements are also
// the ones carrying advisories, so a sandbox that is only up for twenty minutes a day still gets those refreshed
// rather than spending its whole window on a jscpd sweep.
const expired = async (deps: ProbeRunnerDeps, nowMs: number): Promise<{ repo: string; spec: ProbeSpec }[]> => {
    const repos = ["", ...(await discoverRepos(deps.workspace.root))];
    const cache = await deps.chores.probes();
    return PROBES.toSorted((left, right) => left.tier - right.tier).flatMap((spec) =>
        repos.filter((repo) => isStale(probeOf(cache, repo, spec.id), spec.ttlMs, nowMs)).map((repo) => ({ repo, spec })),
    );
};

export interface ProbeRunner {
    readonly start: () => void;
    readonly stop: () => void;
    // Refresh one repo's probe now, ignoring its TTL — what POST /chores/probe drives. Resolves when the probe has
    // been recorded; the route does not await it, because a jscpd sweep outlives any sane request.
    readonly refresh: (repo: string, id: ProbeId) => Promise<void>;
}

export const createProbeRunner = (deps: ProbeRunnerDeps): ProbeRunner => {
    // Module-level rather than per-tick: the on-demand refresh and the background sweep share one lane, so a
    // panel's refresh button cannot land a second jscpd next to the one already running.
    let busy = false;

    const record = async (repo: string, spec: ProbeSpec): Promise<void> => {
        const result = await runProbe(spec, join(deps.workspace.root, repo), Date.now());
        await deps.chores.recordProbe(repo, result);
        deps.logger.info({ repo, probe: spec.id, state: result.state, tookMs: result.tookMs }, "chores: probe finished");
    };

    const drain = async (): Promise<void> => {
        if (busy) {
            return;
        }
        // The owner's own work comes first, always. A live turn means the machine is already spoken for.
        if (deps.agents.liveSessionIds().length > 0) {
            return;
        }
        busy = true;
        try {
            const due = await expired(deps, Date.now());
            await deps.chores.pruneProbes(["", ...(await discoverRepos(deps.workspace.root))]);
            for (const { repo, spec } of due) {
                // Re-checked between probes rather than only at the top: a sweep of six repos' jscpd takes long
                // enough that the owner may well have started working halfway through it.
                if (deps.agents.liveSessionIds().length > 0) {
                    return;
                }
                await record(repo, spec);
            }
        } finally {
            busy = false;
        }
    };

    let timer: NodeJS.Timeout | undefined;
    return {
        start: () => {
            timer ??= setTimeout(() => {
                void drain();
                timer = setInterval(() => void drain(), TICK_MS);
                timer.unref();
            }, WARMUP_MS);
            timer.unref();
        },
        stop: () => {
            if (timer !== undefined) {
                clearTimeout(timer);
                clearInterval(timer);
                timer = undefined;
            }
        },
        refresh: async (repo, id) => {
            const spec = PROBES.find((probe) => probe.id === id);
            if (spec === undefined || busy) {
                return;
            }
            busy = true;
            try {
                await record(repo, spec);
            } finally {
                busy = false;
            }
        },
    };
};
