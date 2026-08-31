import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { PROBES, type ProbeSpec, WORKSPACE_ROOT_EXCLUDE_ENV } from "@intentic/sandbox-contract/chores";
import type { ProbeId, ProbeResult, RunningProbe } from "@intentic/sandbox-contract";
import { REFERENCE_DIR } from "@intentic/workspace-ignore";
import type { Logger } from "pino";
import { discoverRepos } from "../workspace/repo-discovery.js";
import { type ChoresStore, isStale, probeOf } from "./chores-store.js";

const execFileAsync = promisify(execFile);

/* THE PROBE RUNNER, the only thing in this system that spends real machine time on maintenance, and therefore
 * the only thing that has to be careful about it.
 *
 * It refreshes expired measurements in the background so that the rail can tell you something you did not already
 * know. That is the whole reason it exists rather than probing on demand: a badge that only updates while you are
 * already looking at the Maintenance view could never tell you anything new, which is the same argument the
 * documentation extension's own attention poll makes.
 *
 * ONE AT A TIME, ACROSS THE WHOLE SANDBOX. Not one per repo, not one per probe. `pnpm audit` hits the network,
 * `knip` type-checks the tree and `jscpd` tokenizes every file, three of those at once on a box that is also
 * running the user's agents is a machine that feels broken. A serialized queue makes the worst case "the panel is
 * a few minutes behind", which nobody notices, instead of "my turn got slow", which everybody does.
 *
 * IT NEVER RUNS WHILE AGENTS ARE WORKING. The tick skips entirely if any turn is live. Maintenance is by
 * definition the least urgent thing this daemon does, and a background sweep that steals CPU from the work the
 * owner is watching would be the surface's first and worst impression.
 *
 * IT IS ALLOWED TO FAIL. Every failure mode here, a tool missing, a network-less audit, a jscpd that runs out of
 * memory, is recorded as a probe state and rendered honestly in the panel. None of it throws into the daemon,
 * and none of it retries in a loop: a failure holds its slot for an hour (chores-store's RETRY_MS) and the first
 * tick past that is the retry, which is a rate limit for free. NOT the probe's own TTL, which is a week for tier
 * 2, a lease that long is for a measurement we trust, and a failure is the opposite of one. */

// How often the runner wakes to look for expired measurements. The shortest TTL is a day, so this only has to be
// small enough that a sandbox which is up for a few hours a day still refreshes; it is not a polling interval in
// any meaningful sense.
const TICK_MS = 30 * 60_000;
// How long after boot the first tick waits. Long enough to be behind image pulls, dependency installs and the
// first index build, a probe racing `pnpm install` measures a tree that does not exist yet.
const WARMUP_MS = 5 * 60_000;
// How much of a DYING tool's output is kept as the reason, taken from the end: the message that killed it is the
// last thing it printed, under whatever stack trace preceded it. Enough to name the cause, short enough that a
// thousand-line trace cannot bloat the file every reader of this surface polls.
const REASON_TAIL = 400;
/* How much of an UNRECOGNISED output is kept, taken from the front and much shorter. A tool that printed an error
 * instead of its report says so in the first line, whereas the last 400 characters of 20 KB of JSON are a fragment
 * from the middle of an array, unreadable, near-identical for every possible cause, and long enough to spill
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
export const runProbe = async (spec: ProbeSpec, cwd: string, nowMs: number, workspaceRoot = false): Promise<ProbeResult> => {
    const started = Date.now();
    const finish = (rest: Omit<ProbeResult, "id" | "ranAt" | "tookMs">): ProbeResult => ({
        id: spec.id,
        ranAt: nowMs,
        tookMs: Date.now() - started,
        ...rest,
    });

    // Only the pseudo-repository at /work receives this. Commands use it for root-anchored scanner exclusions;
    // a real repository's own `refs/` directory must stay visible to its probes.
    const env = { ...process.env };
    if (workspaceRoot) {
        env[WORKSPACE_ROOT_EXCLUDE_ENV] = REFERENCE_DIR;
    } else {
        delete env[WORKSPACE_ROOT_EXCLUDE_ENV];
    }

    try {
        await execFileAsync("sh", ["-c", spec.available], { cwd, timeout: 30_000, env });
    } catch {
        // The tool is not part of this repository. Not a failure and not a clean result, see ProbeStateSchema.
        // The reason is the spec's own, naming what is missing: a sentence built from the probe's title reads as
        // "there are no security advisories", which is the claim an unmeasured probe is not allowed to make.
        return finish({ state: "unavailable", reason: spec.unavailable });
    }

    let stdout: string;
    try {
        // maxBuffer because knip and jscpd on a large repo emit megabytes of JSON, and the default 1MB would
        // truncate it into something the parser correctly refuses, reported as a failure nobody could diagnose.
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

/* What the runner needs, named rather than taken as the whole Services object: it is a background sweep over a
 * store and a clock, and a narrow dependency is what makes it testable without standing up a daemon. `agents` is
 * structural for the same reason, the only thing asked of the registry is whether anything is running. */
export interface ProbeRunnerDeps {
    readonly workspace: { readonly root: string };
    readonly chores: ChoresStore;
    readonly agents: { readonly liveSessionIds: () => readonly string[] };
    readonly logger: Logger;
}

// Every (repo, probe) pair whose cached result has expired, tier 1 before tier 2, the cheap measurements are also
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
    /* Refresh one repo's probe now, ignoring its TTL, what POST /chores/probe drives. Resolves when the probe has
     * been recorded; the route does not await it, because a jscpd sweep outlives any sane request.
     *
     * IT QUEUES, IT DOES NOT DECLINE. This used to return immediately when the lane was busy, which is the worst
     * shape a button can have: the route still answered `{ ok: true }`, the panel still said the measurement was
     * asked for, and nothing ever ran. A sweep the owner cannot see is exactly the thing their click collides
     * with, so "busy" was not a rare case, it was the case where the button most needed to work. */
    readonly refresh: (repo: string, id: ProbeId) => Promise<void>;
    // What is being measured and what is waiting behind it, the only honest source for a surface that wants to
    // say "measuring" while the probe cache still describes the measurement being replaced.
    readonly running: () => readonly RunningProbe[];
}

const laneKey = (entry: { repo: string; id: ProbeId }): string => `${entry.repo}|${entry.id}`;

export const createProbeRunner = (deps: ProbeRunnerDeps): ProbeRunner => {
    /* THE LANE. One at a time across the whole sandbox (see the block at the top), and now visible: index 0 is
     * what is running, the rest are waiting their turn. A list rather than a boolean because both of the things
     * this had to fix need to name the WORK, a request that arrives mid-sweep has to survive it, and a panel
     * that wants to say "measuring dead code, 40s" cannot be told only that something, somewhere, is busy.
     *
     * Replaced rather than mutated on every transition, so `running()` can hand its entries straight out: a
     * reader holding the answer while a probe starts sees the report it asked for, not a half-updated one. */
    let lane: readonly RunningProbe[] = [];

    const record = async (repo: string, spec: ProbeSpec): Promise<void> => {
        const result = await runProbe(spec, join(deps.workspace.root, repo), Date.now(), repo === "");
        await deps.chores.recordProbe(repo, result);
        deps.logger.info({ repo, probe: spec.id, state: result.state, tookMs: result.tookMs }, "chores: probe finished");
    };

    const leave = (key: string): void => {
        lane = lane.filter((waiting) => laneKey(waiting) !== key);
    };

    // Run the head of the lane to completion, stamped as started. `finally` rather than a happy path, because an
    // entry left in the lane after a throw would tell the panel a probe is running forever.
    const claim = async (entry: RunningProbe, spec: ProbeSpec): Promise<void> => {
        const key = laneKey(entry);
        lane = lane.map((waiting) => (laneKey(waiting) === key ? { ...waiting, startedAt: Date.now() } : waiting));
        try {
            await record(entry.repo, spec);
        } finally {
            leave(key);
        }
    };

    // Everything waiting, oldest first, until the lane is empty. Re-read each pass rather than snapshotted: a
    // request that arrives while a jscpd runs joins the queue it is already draining.
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

    // Join the lane, or join the request already in it: two clicks on one row are one measurement, and a sweep
    // that already queued this probe is the same work under a different name.
    const enqueue = (repo: string, id: ProbeId): Promise<void> => {
        if (!lane.some((entry) => laneKey(entry) === laneKey({ repo, id }))) {
            lane = [...lane, { repo, id, askedAt: Date.now() }];
        }
        return pump();
    };

    const sweep = async (): Promise<void> => {
        // The owner's own work comes first, always. A live turn means the machine is already spoken for, and
        // this is the BACKGROUND sweep only: a probe somebody pressed a button for is their work, not ours.
        if (draining !== undefined || deps.agents.liveSessionIds().length > 0) {
            return;
        }
        const due = await expired(deps, Date.now());
        await deps.chores.pruneProbes(["", ...(await discoverRepos(deps.workspace.root))]);
        for (const { repo, spec } of due) {
            // Re-checked between probes rather than only at the top: a sweep of six repos' jscpd takes long
            // enough that the owner may well have started working halfway through it.
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
        // The lane itself: its entries are replaced rather than edited, so handing them out shares no state.
        running: () => lane,
    };
};
