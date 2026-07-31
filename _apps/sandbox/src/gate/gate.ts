import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentEvent, AgentTurn, GateAgent, GateFix, GateVerdict, OriginAgent } from "@intentic/sandbox-contract";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import type { WakeFn } from "../automations/scheduler.js";
import type { Services } from "../composition.js";
import { openTurnTranscript, recordTurnTranscript } from "../sessions/turn-transcript.js";
import { discoverRepos } from "../workspace/repo-discovery.js";
import type { StoredVerdict } from "./gate-store.js";

/* THE LANDING GATE — the workspace's own answer to "would this push go red", asked of the composite of landed
 * work while it is still uncommitted, and answered before the user starts staging.
 *
 * WHY THIS IS NOT AN AUTOMATION GUARD, which is the shape it most resembles and the first thing anyone would
 * reach for. A `workspace`-trigger chore with `guard: "! pnpm test"` looks like the whole feature in one config
 * line, and it is broken in three ways that all read as SUCCESS:
 *
 *   1. GUARD_TIMEOUT_MS is 60s (automations/scheduler.ts). A suite that outruns it makes execFile throw, which
 *      the guard scores as non-zero, which means "skipped" — so a test run that never finished is recorded as a
 *      run that decided not to wake anyone. Silent green over an unknown tree, which is worse than no gate.
 *   2. Only GUARD_DETAIL_TAIL (500 bytes) of the output survives, into the run's UI detail — never into the
 *      wake prompt. The fixer would arrive knowing only that something failed. Compare /ci/fix, which seeds
 *      24 KB of the actual failing logs, because that is what makes the difference between fixing and hunting.
 *   3. Chore events coalesce per AGENT (automations/workspace-events.ts), so a five-agent landing burst is up
 *      to four serial full-suite runs answering about four trees nobody will ever push — and QUEUE_MAX drops
 *      the fifth. The gate needs the opposite: collapse everything to ONE run on the tree as it finally stands.
 *
 * So the gate owns its own debounce, its own long-running child, and its own verdict. What it borrows is the
 * part that was already right: /ci/fix's shape for turning a failure into a seeded turn.
 *
 * WHAT IT RUNS ON. The main working tree, always — because that is the only place the composite exists. An
 * isolated worktree branches from HEAD and cannot see the uncommitted deltas that land put in the tree, and its
 * node_modules resolves cross-package imports to /work's sources rather than its own (agents/worktrees.ts). A
 * check run anywhere but here is answering about a tree that will never be pushed.
 */

// The output kept from one run, tail-first. Matches /ci/fix's FIX_LOG_BYTES: enough to see the actual failure,
// bounded so the fix turn's context stays about fixing rather than scrolling. The TAIL, because a suite's
// verdict and its failure summary are at the end — a head-capped buffer of a chatty build is all progress bars.
const GATE_OUTPUT_BYTES = 24_000;

// How long a fingerprint read is reused. The panel polls the verdict, and each fingerprint costs two git reads
// per repo — the same coalescing /git/changes does (COALESCE_MS) and for the same reason.
const FINGERPRINT_COALESCE_MS = 2_000;

// SIGTERM first so a test runner can tear down its own children; SIGKILL for one that ignores it. The same
// two-step (and the same grace) as intentic/intentic-runner.ts.
const KILL_GRACE_MS = 5_000;

export interface LandingGate {
    /* Work reached the main tree — start (or restart) the quiet countdown. Cheap and idempotent: every land
     * calls it, and a burst of twenty collapses into one run. Fire-and-forget by design, like emitWorkspaceEvent
     * — a land must not fail because a gate could not be armed. */
    readonly arm: () => void;
    // Run now, the user's own "I'm about to commit — check this". Starts the suite and says nothing about it:
    // the verdict is what reports, and the panel is already polling that.
    readonly run: () => void;
    readonly cancel: () => void;
    // The verdict with `stale` computed against the tree as it stands right now.
    readonly verdict: () => Promise<GateVerdict>;
    // Open the seeded fix turn for the current red verdict. Idempotent while one is already running.
    readonly fix: () => Promise<void>;
    // Daemon shutdown: drop the timers and kill a live child, so a dying daemon doesn't leave a suite running.
    readonly stop: () => void;
}

/* WHICH AGENTS A FAILURE IMPLICATES — the output searched for paths we already know are attributed, never the
 * other way round.
 *
 * Parsing a test runner's output is a losing game (every framework prints differently, and the useful line is
 * sometimes a stack frame three files deep). This inverts it: the attributed paths are a known, small set, so
 * ask of each one whether the output NAMES it. That yields no false positives — a path in the output is a path
 * the run was talking about — at the cost of false negatives for a suite that prints no paths at all.
 *
 * A path is matched both bare and repo-prefixed, because a nested repo's runner prints paths relative to its
 * own root while the panel and the attribution speak in repo-relative terms.
 *
 * The empty case is meaningful and must not be dropped: when the output names none of the attributed paths, the
 * failure could not be pinpointed — an interaction between two deltas, or a suite that only prints test names.
 * Every agent with landed work is then returned with NO paths, which the prompt and the badge both read as
 * "these are the agents in the tree, not the accused". */
export const implicate = (
    output: string,
    // repo → (path → agent ids), exactly agentOrigins.forRepo's shape per repo.
    attributed: ReadonlyMap<string, Record<string, string[]>>,
    identify: (ids: Iterable<string>) => Record<string, OriginAgent>,
): GateAgent[] => {
    const named = new Map<string, Set<string>>();
    const everyone = new Set<string>();
    for (const [repo, paths] of attributed) {
        for (const [path, ids] of Object.entries(paths)) {
            for (const id of ids) {
                everyone.add(id);
            }
            if (!output.includes(path) && !output.includes(`${repo}/${path}`)) {
                continue;
            }
            for (const id of ids) {
                const own = named.get(id) ?? new Set<string>();
                named.set(id, own);
                own.add(repo === "root" ? path : `${repo}/${path}`);
            }
        }
    }
    const ids = named.size > 0 ? [...named.keys()] : [...everyone];
    const who = identify(ids);
    const roster: GateAgent[] = [];
    for (const agentId of ids) {
        const agent = who[agentId];
        roster.push({
            agentId,
            ...(agent?.title !== undefined ? { title: agent.title } : {}),
            ...(agent?.provider !== undefined ? { provider: agent.provider } : {}),
            paths: [...(named.get(agentId) ?? [])].toSorted(),
        });
    }
    return roster;
};

/* THE FIX TURN'S PROMPT. Everything the turn needs to not rediscover: what ran, how it ended, what it printed,
 * and whose work is in the tree — plus the two constraints that are not guessable from the situation.
 *
 * The first is WHERE. The composite is uncommitted content in the main working tree; a fix authored anywhere
 * else cannot even reproduce the failure.
 *
 * The second is NOT TO COMMIT. The user's own commit is the review boundary this whole flow is built around
 * (agents/land.ts), and a fix that commits itself has reviewed the fleet's work on the user's behalf — while
 * also expiring the per-path attribution the panel draws its chips from (agents/origins.ts). */
export const fixPrompt = (verdict: StoredVerdict, timeoutMs: number): string => {
    const ending =
        verdict.timedOut === true
            ? `did not finish — it was killed after ${Math.round(timeoutMs / 60_000)}m. Treat that as a failure: something hangs, and finding what is part of the fix.`
            : `failed (exit ${verdict.exitCode ?? "unknown"}).`;
    const pinpointed = verdict.implicated.some((agent) => agent.paths.length > 0);
    const roster = verdict.implicated.map((agent) => {
        const who = agent.title !== undefined ? `${agent.title} (${agent.agentId})` : agent.agentId;
        return agent.paths.length > 0 ? `- ${who}: ${agent.paths.join(", ")}` : `- ${who}`;
    });
    return [
        `The workspace's landing gate is red. Agents' finished work is sitting in the main working tree as UNCOMMITTED changes, and \`${verdict.command}\` ${ending}`,
        `This is the exact state that goes to CI on the next push, which is why it is worth fixing now rather than there.`,
        `Fix it IN PLACE in the main working tree. Do NOT commit, stage, stash or revert anything: the user reviews and commits this themselves, and your fix has to arrive in the same Changes panel as the work it repairs. Re-run \`${verdict.command}\` yourself to confirm before you finish.`,
        ...(roster.length === 0
            ? []
            : pinpointed
              ? [`The output names these agents' landed files:\n${roster.join("\n")}`]
              : [
                    `The output names none of the attributed files, so this may be an interaction BETWEEN deltas rather than one agent's bug — each of these passed on its own branch. Agents with landed work in the tree:\n${roster.join("\n")}`,
                ]),
        `--- \`${verdict.command}\` output (tail) ---\n${verdict.output}`,
    ].join("\n\n");
};

// A tail-capped accumulator: append forever, keep the last `cap` bytes. The slice is O(cap) per chunk, which at
// 24 KB against a suite's output rate is nothing, and it keeps the buffer from tracking a build's whole log.
const tailBuffer = (cap: number): { readonly append: (chunk: string) => void; readonly read: () => string } => {
    let held = "";
    return {
        append: (chunk) => {
            held = (held + chunk).slice(-cap);
        },
        read: () => held,
    };
};

/* Signal a check's whole process TREE, via the group `detached` gave it (see `execute`). A pid that has already
 * gone takes ESRCH, which is the normal race between the watchdog firing and the suite finishing on its own —
 * there is nothing to report and nothing to do. `undefined` pid means the spawn itself failed; the `error`
 * listener has that covered. */
const killGroup = (pid: number | undefined, signal: NodeJS.Signals): void => {
    if (pid === undefined) {
        return;
    }
    try {
        process.kill(-pid, signal);
    } catch {
        // Already gone.
    }
};

// An `armed` verdict keeps whatever the last run concluded, so the badge goes on showing a red result while the
// next check is queued rather than blanking to "no idea". Only the status and the command are this run's — the
// command because a verdict has to name what it will actually run, and `fix` is dropped because a fresh tree
// deserves a fresh attempt (see `execute`'s inheritedFix).
const armedFrom = (previous: StoredVerdict | undefined, command: string): StoredVerdict => {
    if (previous === undefined) {
        return { status: "armed", command, output: "", fingerprint: "", implicated: [] };
    }
    // `fix` is dropped by the rest-spread rather than overwritten: exactOptionalPropertyTypes means an explicit
    // `fix: undefined` is not the same as an absent one, and the stored shape must not carry a dead attempt.
    const { fix: _dropped, ...kept } = previous;
    return { ...kept, command, status: "armed" };
};

/* THE ONE GATE THIS PROCESS HAS. A module singleton for the same reason the chore queues and the scheduler's
 * inFlight set are: the emit sites (every land), the routes (the panel's clicks) and the shutdown hook all have
 * to reach the SAME debounce timer and the same live child, and there is only one main working tree for them to
 * be about. `wake` is injected at the call site rather than imported here — importing streamAgent would put this
 * module downstream of agent.routes, which is itself the biggest arm() caller: a cycle, and the same one
 * workspace-events.ts takes its WakeFn to avoid.
 *
 * Tests build their own with createLandingGate instead, which is why that stays exported. */
let instance: LandingGate | undefined;
export const landingGate = (services: Services, wake: WakeFn): LandingGate => (instance ??= createLandingGate(services, wake));

export const createLandingGate = (services: Services, wake: WakeFn, git: GitRunner = defaultGit): LandingGate => {
    const { logger, workspace } = services;
    let current: StoredVerdict | undefined;
    let loaded = false;
    // The live run: its child (for cancel/kill), its buffer (a running verdict reads output from here rather
    // than from disk), and the promise every concurrent caller shares instead of starting a second suite.
    let child: ReturnType<typeof spawn> | undefined;
    let liveOutput: (() => string) | undefined;
    let running: Promise<StoredVerdict> | undefined;
    let quietTimer: NodeJS.Timeout | undefined;
    // A land that arrived while a run was in flight: the tree it is about is not the tree under test, so the
    // run in progress cannot answer for it and another has to follow. One flag, not a queue — the next run
    // reads the tree as it then stands, which already accounts for every land that set this.
    let rearm = false;
    let fixing = false;
    // Cancel is a broadcast rather than a handle: the live `execute` registers here while it owns the child, so
    // cancel stays ignorant of which run it is stopping.
    const cancellers = new Set<() => void>();
    let fingerprintCache: { value: string; until: number } | undefined;

    const settings = async (): Promise<{ gateCommand: string; gateQuietMs: number; gateTimeoutMs: number; gateAutoFix: boolean }> => {
        const { gateCommand, gateQuietMs, gateTimeoutMs, gateAutoFix } = await services.sandboxSettings.get();
        return { gateCommand, gateQuietMs, gateTimeoutMs, gateAutoFix };
    };

    const repoDirs = async (): Promise<{ repo: string; dir: string }[]> => [
        { repo: "root", dir: workspace.root },
        ...(await discoverRepos(workspace.root)).map((repo) => ({ repo, dir: join(workspace.root, repo) })),
    ];

    /* THE CONTENT UNDER TEST, as one hash — each repo's worktree reduced to the tree sha it WOULD commit to,
     * composed across every repo.
     *
     * WHY NOT HEAD PLUS THE DIFF, which this was and which is the obvious thing to reach for. Two failures,
     * both measured, and both of which make the verdict lie in the direction of a false green:
     *
     *   1. `diff --raw` reports the destination blob as all-zeros for anything not staged, because a worktree
     *      file has no blob in the object store yet. Landed work IS unstaged, so two DIFFERENT edits to the same
     *      file hashed identically: the check went green, an agent rewrote a file, and the verdict went on
     *      claiming to be fresh — precisely the stale pass this gate exists to prevent.
     *   2. Staging and committing each move it while changing no content at all — `git add` fills in that
     *      destination blob, and a commit advances HEAD and empties the diff. The user's flow is land → check →
     *      stage → commit → push, so a green verdict was stale twice over by the time it mattered most, and the
     *      push guardrail would have objected to every push it ever saw.
     *
     * `git add -A` against an index of the gate's own, then `write-tree`, answers what a delta cannot: the
     * identity of the CONTENT, wherever git currently happens to be keeping it. Verified against a scratch repo:
     * on a clean tree it equals `HEAD^{tree}` exactly; it moves on an in-place edit, a new untracked file and a
     * deletion; it does not move on a stage or a commit; and it ignores what .gitignore ignores.
     *
     * The index is KEPT between calls rather than made fresh, and that is the entire cost argument: it carries
     * git's stat cache, so over this monorepo the first `add -A` took 279ms and every one after it 4ms. It lives
     * under .intentic (daemon state, never repo content), one per repo. Because GIT_INDEX_FILE moves the lock
     * to that file too, this cannot contend with the user staging in the real index — and where two of these do
     * race each other, defaultGit's own index.lock retry settles it (scaffold/exec.ts).
     *
     * A repo git cannot read contributes a constant instead of failing the verdict: an unreadable repo is not a
     * reason to refuse to say anything about the rest of the tree. It hashes as its own name, so the composite
     * still changes when a repo appears or disappears.
     *
     * THE WORKSPACE ROOT is a repo too — the shadow "root" repo whose git dir lives outside /work (git/root-repo.ts)
     * — and `add -A` there would otherwise do two harmful things: record each nested repo as a GITLINK, whose sha
     * is that repo's HEAD and so moves on every commit made inside it (the very sensitivity this rewrite removes,
     * re-entering by the back door), and add this index file to itself. Neither happens, and not by luck:
     * root-repo.ts writes `/intentic/`, `/.intentic/` and the rest into that repo's $GIT_DIR/info/exclude, so the
     * root's tree is only ever the loose files that belong to no repo. Verified: its tree carries no gitlink. */
    const contentSha = async (repo: string, dir: string): Promise<string> => {
        // "/" for a nested repo's path, which would otherwise read as a directory that nothing creates.
        const index = join(workspace.root, ".intentic", "gate-index", repo.replaceAll("/", "%"));
        await mkdir(dirname(index), { recursive: true });
        const env = { GIT_INDEX_FILE: index };
        /* `.intentic` is excluded HERE rather than trusted to the repo's own ignore rules, because that directory
         * holds this verdict and this index: fingerprint it and the gate reads its own writing, every persisted
         * verdict moves the tree it was describing, and the badge goes permanently stale. Measured on a scratch
         * repo — two writes of gate.json, two different trees. The workspace root's info/exclude does already
         * cover it (root-repo.ts), which is exactly why this must not depend on it: nothing about a gate's
         * correctness should rest on another module keeping an ignore list in a particular shape. */
        await git(dir, ["add", "-A", "--", ".", ":(exclude).intentic"], env);
        const { stdout } = await git(dir, ["write-tree"], env);
        return stdout.trim();
    };

    const fingerprint = async (): Promise<string> => {
        const hash = createHash("sha256");
        for (const { repo, dir } of await repoDirs()) {
            const tree = await contentSha(repo, dir).catch((error: unknown) => {
                logger.debug({ err: error, repo }, "gate: worktree content unreadable");
                return "unreadable";
            });
            hash.update(`${repo}\0${tree}\0`);
        }
        return hash.digest("hex").slice(0, 16);
    };

    const coalescedFingerprint = async (): Promise<string> => {
        if (fingerprintCache !== undefined && Date.now() < fingerprintCache.until) {
            return fingerprintCache.value;
        }
        const value = await fingerprint();
        fingerprintCache = { value, until: Date.now() + FINGERPRINT_COALESCE_MS };
        return value;
    };

    const persist = async (verdict: StoredVerdict): Promise<void> => {
        current = verdict;
        loaded = true;
        await services.gateStore.write(verdict).catch((error: unknown) => logger.warn({ err: error }, "gate: verdict not persisted"));
    };

    /* The boot read, ONCE, and never allowed to clobber a fresher write.
     *
     * The naive version — `if (!loaded) current = await read()` — loses the first verdict of every process. The
     * panel's poll and the first run race: the poll enters the read, awaits the disk (empty, so `undefined`),
     * and while it is in flight the run persists `running`; the read then resolves and assigns its stale
     * `undefined` over it. The badge sat on `idle` through a whole suite because of it. `loaded` is set
     * synchronously by `persist`, so checking it again on the far side of the await is what makes this safe. */
    let loading: Promise<void> | undefined;
    const load = async (): Promise<StoredVerdict | undefined> => {
        if (loaded) {
            return current;
        }
        loading ??= services.gateStore.read().then((stored) => {
            if (!loaded) {
                current = stored;
                loaded = true;
            }
        });
        await loading;
        return current;
    };

    // Which agents' landed work sits in the tree right now, per repo — the input to `implicate`. A repo whose
    // attribution read fails contributes nothing rather than failing the verdict: attribution decorates a
    // failure, it is not the failure, which is the same call /git/changes makes.
    const attribution = async (): Promise<Map<string, Record<string, string[]>>> => {
        const entries = await Promise.all(
            (await repoDirs()).map(
                async ({ repo, dir }) =>
                    [
                        repo,
                        await services.agentOrigins.forRepo(repo, dir).catch((error: unknown) => {
                            logger.debug({ err: error, repo }, "gate: origins unavailable");
                            return {};
                        }),
                    ] as const,
            ),
        );
        return new Map(entries);
    };

    /* ONE RUN, start to verdict. `inheritedFix` is the loop guard: a run the fix turn itself asked for carries
     * that fix record forward, so the auto-fix gate at the bottom (`fix === undefined`) is already closed and a
     * fix that did not work cannot ask for another one. A land- or user-triggered run inherits nothing, because
     * a tree that has since moved deserves a fresh attempt. */
    const execute = async (inheritedFix: GateFix | undefined): Promise<StoredVerdict> => {
        const { gateCommand, gateTimeoutMs, gateAutoFix } = await settings();
        const startedAt = Date.now();
        const at = await coalescedFingerprint();
        const buffer = tailBuffer(GATE_OUTPUT_BYTES);
        const base = {
            command: gateCommand,
            startedAt,
            fingerprint: at,
            implicated: [] as GateAgent[],
            ...(inheritedFix !== undefined ? { fix: inheritedFix } : {}),
        };
        /* `detached` MAKES THE CHILD A PROCESS-GROUP LEADER, and the whole timeout guarantee rests on it.
         *
         * `sh -c "<command>"` forks for anything it cannot exec directly, and a real check command is a process
         * TREE: pnpm spawns turbo, turbo spawns vitest, vitest spawns a worker per core. Signalling the pid
         * kills only `sh` — every descendant survives, holding the inherited stdout/stderr open, so `close` does
         * not fire until the suite finishes on its own. Measured: killing the pid of `sh -c "sleep 30"` at 150ms
         * still took the full 30s to close. That is the timeout silently not working, on exactly the runaway
         * suite it exists for.
         *
         * With a group of its own, one `process.kill(-pid)` reaches the entire tree. */
        const spawned = spawn("sh", ["-c", gateCommand], { cwd: workspace.root, env: process.env, detached: true });
        child = spawned;
        liveOutput = buffer.read;
        // Never spawned at all — no `sh`, an unreadable cwd, a fork failure. `error`, not `failed`: nothing was
        // learned about the code, so nobody should be woken to fix it. The child still emits `close` after
        // this, which is where the verdict is written; this only records WHY.
        let spawnError: string | undefined;
        spawned.on("error", (error: Error) => {
            spawnError = error.message;
        });
        /* EVERY LISTENER IS ATTACHED BEFORE THE NEXT AWAIT, and that ordering is load-bearing rather than
         * stylistic. `exit 1` from a typo'd command finishes in microseconds — well inside the file write that
         * records the `running` verdict below — and an EventEmitter does not replay: a `close` listener attached
         * on the far side of that await never fires at all, and the gate sits on `running` for the life of the
         * daemon. So the close promise, the stdio handlers, the watchdog and the cancel hook are all wired here,
         * and only then is anything awaited. */
        for (const stream of [spawned.stdout, spawned.stderr]) {
            stream.setEncoding("utf8");
            stream.on("data", (chunk: string) => buffer.append(chunk));
        }
        const closed = new Promise<[number | null, NodeJS.Signals | null]>((resolve) =>
            spawned.on("close", (exit, killedBy) => resolve([exit, killedBy])),
        );
        let timedOut = false;
        // Counted from the spawn, not from the write — a ceiling measured from anywhere else is not the ceiling
        // the setting promises.
        const watchdog = setTimeout(() => {
            timedOut = true;
            logger.warn({ command: gateCommand, pid: spawned.pid, timeoutMs: gateTimeoutMs }, "gate: check timed out — killing");
            killGroup(spawned.pid, "SIGTERM");
            setTimeout(() => killGroup(spawned.pid, "SIGKILL"), KILL_GRACE_MS).unref();
        }, gateTimeoutMs);
        watchdog.unref();
        let cancelled = false;
        const onCancel = (): void => {
            cancelled = true;
        };
        cancellers.add(onCancel);
        logger.info({ command: gateCommand, pid: spawned.pid, fingerprint: at }, "gate: check started");
        await persist({ ...base, status: "running", output: "" });
        const [code, signal] = await closed;
        clearTimeout(watchdog);
        cancellers.delete(onCancel);
        child = undefined;
        liveOutput = undefined;
        const output = buffer.read();
        // A run that died on a signal nobody asked for (the OOM killer, a crashed runner) is a failure of the
        // check, not a pass — its exit code is null, so this cannot be folded into `code !== 0`.
        const passed = code === 0 && !timedOut && signal === null;
        // A cancel that the watchdog caused is a TIMEOUT, not a cancellation — the user asked for neither, and
        // reporting it as cancelled would hide the one outcome this gate most needs to be loud about.
        const status: GateVerdict["status"] =
            spawnError !== undefined ? "error" : cancelled && !timedOut ? "cancelled" : passed ? "passed" : "failed";
        const verdict: StoredVerdict = {
            ...base,
            status,
            finishedAt: Date.now(),
            ...(code !== null ? { exitCode: code } : {}),
            ...(timedOut ? { timedOut: true } : {}),
            output: spawnError !== undefined ? `${gateCommand}: ${spawnError}` : output,
            implicated: status === "failed" ? implicate(output, await attribution(), services.agentOrigins.identify) : [],
        };
        await persist(verdict);
        logger.info(
            { command: gateCommand, status, exitCode: code, timedOut, durationMs: Date.now() - startedAt, implicated: verdict.implicated.length },
            "gate: check settled",
        );
        if (status === "failed" && gateAutoFix && verdict.fix === undefined) {
            void fix().catch((error: unknown) => logger.warn({ err: error }, "gate: auto-fix failed to start"));
        }
        return verdict;
    };

    // Start a run, or join the one already going. Never two suites at once — they would fight over the same
    // tree, the same ports and the same CPU, which is the constraint the chore chain exists for too.
    const start = (inheritedFix: GateFix | undefined): Promise<StoredVerdict> => {
        if (running !== undefined) {
            rearm = true;
            return running;
        }
        running = execute(inheritedFix).finally(() => {
            running = undefined;
            if (rearm) {
                rearm = false;
                fingerprintCache = undefined;
                void start(undefined).catch((error: unknown) => logger.warn({ err: error }, "gate: re-run after land failed"));
            }
        });
        return running;
    };

    const readVerdict = async (): Promise<GateVerdict> => {
        const { gateCommand } = await settings();
        const stored = await load();
        // No command ⇒ the gate is off, whatever is on disk. A verdict from before the setting was cleared
        // would otherwise keep a badge alive for a check nobody can run any more.
        if (stored === undefined || gateCommand === "") {
            return { status: "idle", command: gateCommand, output: "", fingerprint: "", stale: false, implicated: [] };
        }
        /* A verdict about the tree UNDER TEST is never stale, however long the suite runs: comparing a running
         * verdict against a moving tree would flip the badge to "stale" the moment a fix turn touched a file. So
         * the fingerprint is not merely unused here — it must not be READ, and reading it anyway is what made
         * clicking "Re-run" flicker the Changes panel. It is the expensive half of this route (a `git add -A`
         * per repo, into an index under .intentic that the file watcher can see), the panel polls every 2s for
         * exactly this state, and FINGERPRINT_COALESCE_MS is that same 2s — so every poll wrote a file in the
         * watched tree and got the browser to refetch the tree and the review set for it. */
        if (stored.status === "running") {
            return { ...stored, stale: false, ...(liveOutput !== undefined ? { output: liveOutput() } : {}) };
        }
        // Every terminal verdict is fair game, `armed` included — it displays the previous run's result, and a
        // land is exactly what moved the tree out from under it.
        return { ...stored, stale: stored.fingerprint !== (await coalescedFingerprint()) };
    };

    const fix = async (): Promise<void> => {
        // Acquire before the first await: two clicks (or auto-fix and a click) can enter in the same tick, and
        // checking after load() lets both pass the guard and mint two conversations for one red tree.
        if (fixing) {
            return;
        }
        fixing = true;
        try {
            const stored = await load();
            if (stored === undefined || stored.status !== "failed") {
                return;
            }
            const { gateTimeoutMs } = await settings();
            const conversationId = `gate-${randomUUID()}`;
            const record: GateFix = { startedAt: Date.now(), conversationId, outcome: "running" };
            await persist({ ...stored, fix: record });
            const prompt = fixPrompt(stored, gateTimeoutMs);
            /* A workspace conversation: it must work directly on the uncommitted composite in /work, but placement
             * no longer opts it out of the registry. The stable id above gives the fixer one fleet card and one
             * provider-neutral transcript while the provider's runtime session remains only a resume cursor. */
            const turn: AgentTurn & { conversationId: string } = { prompt, conversationId };
            const events: AgentEvent[] = [];
            let failure: string | undefined;
            // Opened before the provider runs, like every other conversation turn — a fresh gate id has nothing
            // to adopt, but the record must exist before settlement appends into it (sessions/transcript-record.ts).
            await openTurnTranscript(services, turn);
            try {
                for await (const event of wake(services, turn, undefined)) {
                    events.push(event);
                    if (event.kind === "error") {
                        failure = event.message;
                    }
                }
            } catch (error) {
                failure = error instanceof Error ? error.message : "gate fix turn failed";
                logger.warn({ err: error, conversationId }, "gate: fix turn failed");
            } finally {
                await recordTurnTranscript(services, turn, events);
            }
            const settled: GateFix = {
                ...record,
                ...(failure === undefined ? { outcome: "done" as const } : { outcome: "error" as const, detail: failure }),
            };
            logger.info({ conversationId, failed: failure !== undefined }, "gate: fix turn settled");
            // A fix turn that errored gets no re-check: nothing was changed, and the red verdict already says so —
            // re-running the suite would only spend the time to be told the same thing.
            if (failure !== undefined) {
                await persist({ ...stored, fix: settled });
                return;
            }
            // Re-verify on the tree the fix left behind, carrying the fix record so this run cannot ask for another.
            fingerprintCache = undefined;
            await start(settled);
        } finally {
            fixing = false;
        }
    };

    return {
        arm: () => {
            void (async () => {
                const { gateCommand, gateQuietMs } = await settings();
                if (gateCommand === "") {
                    return;
                }
                if (running !== undefined) {
                    rearm = true;
                    return;
                }
                // Every land pushes the countdown out, so a burst resolves to one run once the burst ends.
                clearTimeout(quietTimer);
                await persist(armedFrom(await load(), gateCommand));
                /* THE DEBOUNCE IS THE WHOLE COALESCER, and deliberately knows nothing about whether the fleet is
                 * still working. An earlier version deferred while any agent was running, on the theory that a
                 * turn about to land makes the current tree not worth testing. That reasoning does not survive
                 * this workspace: agents here run for HOURS, so "wait until nobody is busy" means a fleet of
                 * twenty with one long runner never reaches a quiet moment at all, and the gate silently
                 * degrades into something only a manual click ever fires — which is how a red composite reached
                 * CI with the gate switched on.
                 *
                 * The tree as it stands after a land is the tree the user is about to stage, commit and push,
                 * whatever else is still in flight. That makes it exactly the thing worth a verdict. A land that
                 * arrives later re-arms this (and `rearm` chains a second run when one is already going), so
                 * work that lands during a run is never left unchecked — it is checked by the next run rather
                 * than by refusing to start this one. */
                quietTimer = setTimeout(() => {
                    void start(undefined).catch((error: unknown) => logger.warn({ err: error }, "gate: check failed to start"));
                }, gateQuietMs);
                quietTimer.unref();
            })().catch((error: unknown) => logger.warn({ err: error }, "gate: arm failed"));
        },
        run: () => {
            void (async () => {
                const { gateCommand } = await settings();
                if (gateCommand === "") {
                    return;
                }
                // The click is explicit, so it pre-empts a countdown rather than waiting one out.
                clearTimeout(quietTimer);
                fingerprintCache = undefined;
                await start(undefined);
            })().catch((error: unknown) => logger.warn({ err: error }, "gate: manual run failed"));
        },
        cancel: () => {
            clearTimeout(quietTimer);
            rearm = false;
            for (const cancel of cancellers) {
                cancel();
            }
            const doomed = child?.pid;
            killGroup(doomed, "SIGTERM");
            setTimeout(() => killGroup(doomed, "SIGKILL"), KILL_GRACE_MS).unref();
        },
        verdict: readVerdict,
        fix,
        stop: () => {
            clearTimeout(quietTimer);
            // No grace on shutdown: the daemon is going, and there is nothing left to report a verdict to.
            killGroup(child?.pid, "SIGKILL");
        },
    };
};
