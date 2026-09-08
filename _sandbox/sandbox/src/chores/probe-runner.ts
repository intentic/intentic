import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { PROBES, type ProbeSpec, WORKSPACE_ROOT_EXCLUDE_ENV } from "@intentic/sandbox-contract/chores";
import type { ProbeId, ProbeResult, RunningProbe } from "@intentic/sandbox-contract";
import { REFERENCE_DIR } from "@intentic/workspace-ignore";
import type { Logger } from "pino";
import { discoverRepos } from "../workspace/layout/repo-discovery.js";
import { type ChoresStore, isStale, probeOf } from "./chores-store.js";

const execFileAsync = promisify(execFile);

// The only background sweep that spends real machine time: probes run one at a time across the whole sandbox, and the
// tick skips entirely while any agent turn is live. A failure is recorded as a probe state, never thrown, and holds its
// slot for an hour (RETRY_MS), not the probe's own TTL.

// How often the runner checks for expired measurements; frequent enough for a part-time sandbox to refresh.
const TICK_MS = 30 * 60_000;
// Delay before the first tick, long enough to be behind image pulls, installs and the first index build.
const WARMUP_MS = 5 * 60_000;
// Chars kept from the end of a dying tool's output, enough to name the cause without bloating the panel.
const REASON_TAIL = 400;
// Chars kept from the front of unrecognised output; the first line says which kind of failure this is.
const REASON_HEAD = 160;

const tail = (text: string): string => text.trim().slice(-REASON_TAIL);
const head = (text: string): string => {
    const trimmed = text.trim();
    return trimmed.length <= REASON_HEAD ? trimmed : `${trimmed.slice(0, REASON_HEAD)}…`;
};

// Runs one probe and returns what to record; never throws, so every outcome becomes a ProbeResult instead of a silent
// gap.
export const runProbe = async (spec: ProbeSpec, cwd: string, nowMs: number, workspaceRoot = false): Promise<ProbeResult> => {
    const started = Date.now();
    const finish = (rest: Omit<ProbeResult, "id" | "ranAt" | "tookMs">): ProbeResult => ({
        id: spec.id,
        ranAt: nowMs,
        tookMs: Date.now() - started,
        ...rest,
    });

    // Only the /work pseudo-repo gets this: root-anchored scanner exclusions a real repo's own refs/ must not have.
    const env = { ...process.env };
    if (workspaceRoot) {
        env[WORKSPACE_ROOT_EXCLUDE_ENV] = REFERENCE_DIR;
    } else {
        delete env[WORKSPACE_ROOT_EXCLUDE_ENV];
    }

    try {
        await execFileAsync("sh", ["-c", spec.available], { cwd, timeout: 30_000, env });
    } catch {
        // Missing tool, not a failure; the reason names what's missing rather than restating the probe.
        return finish({ state: "unavailable", reason: spec.unavailable });
    }

    let stdout: string;
    try {
        // maxBuffer raised since knip/jscpd can emit megabytes of JSON; the 1MB default truncates it unparsably.
        ({ stdout } = await execFileAsync("sh", ["-c", spec.command], {
            cwd,
            timeout: spec.timeoutMs,
            maxBuffer: 64 * 1024 * 1024,
            env,
        }));
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

// Only what the runner needs, not the whole Services object, so it's testable without a daemon; `agents` only exposes
// whether anything is running.
export interface ProbeRunnerDeps {
    readonly workspace: { readonly root: string };
    readonly chores: ChoresStore;
    readonly agents: { readonly liveSessionIds: () => readonly string[] };
    readonly logger: Logger;
}

// Every (repo, probe) pair whose cache has expired, tier 1 before tier 2, so a sandbox up only briefly still refreshes
// the cheap advisories first.
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
    // Refreshes one repo's probe now, ignoring its TTL; resolves once recorded, the route does not await it. Always
    // queues rather than declining, even when the lane is busy.
    readonly refresh: (repo: string, id: ProbeId) => Promise<void>;
    // What's running and what's waiting, since the probe cache still shows the stale measurement being replaced.
    readonly running: () => readonly RunningProbe[];
}

const laneKey = (entry: { repo: string; id: ProbeId }): string => `${entry.repo}|${entry.id}`;

export const createProbeRunner = (deps: ProbeRunnerDeps): ProbeRunner => {
    // Index 0 is running, the rest wait; replaced wholesale each change so `running()` hands out a stable snapshot.
    let lane: readonly RunningProbe[] = [];

    const record = async (repo: string, spec: ProbeSpec): Promise<void> => {
        const result = await runProbe(spec, join(deps.workspace.root, repo), Date.now(), repo === "");
        await deps.chores.recordProbe(repo, result);
        deps.logger.info({ repo, probe: spec.id, state: result.state, tookMs: result.tookMs }, "chores: probe finished");
    };

    const leave = (key: string): void => {
        lane = lane.filter((waiting) => laneKey(waiting) !== key);
    };

    // Runs the lane's head to completion; `finally` ensures a throw doesn't leave an entry parked as running forever.
    const claim = async (entry: RunningProbe, spec: ProbeSpec): Promise<void> => {
        const key = laneKey(entry);
        lane = lane.map((waiting) => (laneKey(waiting) === key ? { ...waiting, startedAt: Date.now() } : waiting));
        try {
            await record(entry.repo, spec);
        } finally {
            leave(key);
        }
    };

    // Drains the lane oldest-first until empty, re-reading it each pass so a request that arrives mid-run joins the
    // queue already draining.
    let draining: Promise<void> | undefined;
    const drainLane = async (): Promise<void> => {
        for (let next = lane[0]; next !== undefined; next = lane[0]) {
            const spec = PROBES.find((probe) => probe.id === next.id);
            if (spec === undefined) {
                leave(laneKey(next));
                continue;
            }
            await claim(next, spec);
        }
    };
    const pump = (): Promise<void> => {
        draining ??= drainLane().finally(() => (draining = undefined));
        return draining;
    };

    // Joins the lane, or the request already in it: two clicks on one row are one measurement, same as a sweep that
    // already queued it.
    const enqueue = (repo: string, id: ProbeId): Promise<void> => {
        if (!lane.some((entry) => laneKey(entry) === laneKey({ repo, id }))) {
            lane = [...lane, { repo, id, askedAt: Date.now() }];
        }
        return pump();
    };

    const sweep = async (): Promise<void> => {
        // The owner's own work always comes first; this sweep is background-only and defers to any live turn.
        if (draining !== undefined || deps.agents.liveSessionIds().length > 0) {
            return;
        }
        const due = await expired(deps, Date.now());
        await deps.chores.pruneProbes(["", ...(await discoverRepos(deps.workspace.root))]);
        for (const { repo, spec } of due) {
            // Re-checked between probes, not the top only: a long sweep can outlast the owner starting to work.
            if (deps.agents.liveSessionIds().length > 0) {
                return;
            }
            await enqueue(repo, spec.id);
        }
    };

    let timer: NodeJS.Timeout | undefined;
    return {
        start: () => {
            timer ??= setTimeout(() => {
                void sweep();
                timer = setInterval(() => void sweep(), TICK_MS);
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
            if (!PROBES.some((probe) => probe.id === id)) {
                return;
            }
            await enqueue(repo, id);
        },
        // Entries are replaced wholesale, never mutated, so handing them out shares no state.
        running: () => lane,
    };
};
