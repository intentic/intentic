import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { isInside } from "@intentic/base/contained";
import { whenAborted } from "@intentic/base/async";
import { DisposableStore } from "@intentic/base/lifecycle";
import { errorMessage } from "@intentic/base/errors";
import type { Services } from "../../../composition.js";
import type { ConversationActors } from "../../../conversations/actor/conversation-actors.js";
import { WORDS_SAID, wordsSaid } from "../waiting/work-wait.js";
import { conversationProfile } from "../../../conversations/registry/agents-store.js";
import { deliverWake } from "../../../seams/wake-delivery.js";
import { opt } from "../../../opt.js";
import type { ResultValue } from "../child-result.js";
import { cancelChild, type ChildParent } from "../children.js";
import { agentCall, forgetWorker, placesFor, resetCallsForTest, type RunContext } from "./script-run-calls.js";
import { type Cache, cacheOf, keepRun, type LiveRun, runFiles, runOnFile, type ScriptCall, type ScriptDefaults, type ScriptRun } from "./script-run-store.js";
import { ScriptMetaSchema, splitScript } from "./script-source.js";
import { readLiteral, runScript } from "./script-vm.js";

/* WORKFLOW RUNS: A SCRIPT AN AGENT WRITES TO COORDINATE OTHER AGENTS, ON ANY PROVIDER, THAT OUTLIVES A RESTART.

   A parent fanning work out by hand spends its own turn and context on bookkeeping: spawn ten, wait on ten, read ten
   reports, spawn the verifiers. A workflow says that once, as a script (script-source.ts), and the daemon runs it in a
   sandbox of its own (script-vm.ts) while the parent carries on or ends its turn. Each agent() call is a spawned child
   like any other (children.ts): a conversation in its own worktree cut from the parent's work, on the provider and model
   the call names, landing its work into the parent's checkout, visible on the board under the parent. A call that asks
   for a schema gets the child's `result` tool (child-result.ts) and is sent back to fix a value that does not match, at
   most twice. Its ending goes to the run, never to the parent as a report of its own; the run's own ending wakes the
   parent once, with what the script returned.

   Every call is written down as it starts and ends. A call is known by what it asks (its prompt and every option that
   changes the work: provider, model, loop, effort, schema) and how many times this run asked the same: so a run the
   daemon restarted, or one the parent resumes after editing its script, hands back every finished call it asks again,
   whatever order its calls come back in, and pays only for what changed. A call whose child was mid-turn when the
   daemon went down is waited on again rather than started twice, since its child survives the restart.

   Claude Code's own Workflow tool is the model for the script, and bb's workflow plugin the model for the run; this one
   differs from bb's on purpose in three places: its workers work in worktrees of their own rather than all in the
   parent's, its cache is keyed by what a call asks rather than by a chain of the calls before it (so a pipeline whose
   stages finish out of order still replays), and a restart waits for its workers rather than stopping them. */

// How many of a run's workers may run at once unless it asks for fewer, and at most.
export const DEFAULT_CONCURRENCY = 8;
export const MAX_CONCURRENCY = 20;
// Log lines kept on a run, and how long each may be.
const LOG_KEPT = 200;
const LOG_LINE_CHARS = 500;
// How much of a run's result its parent's wake carries before pointing at the status tool.
const WAKE_RESULT_CHARS = 8_000;

export interface ScriptRunRequest {
    // The script itself, or a path to it in the parent's working tree.
    readonly script?: string;
    readonly scriptPath?: string;
    readonly args?: ResultValue;
    readonly defaults?: ScriptDefaults;
    readonly concurrency?: number;
    // A finished run of this parent's whose calls this one may hand back unchanged.
    readonly resume?: string;
}

export type ScriptRunStart = { readonly ok: true; readonly run: string; readonly note: string } | { readonly ok: false; readonly message: string };

const LIVE = new Map<string, LiveRun>();
// The wake a run's parent gets as it ends, said once, into its live turn or a turn of its own.
const endingWords = (run: string, record: ScriptRun): string => {
    const calls = record.calls.length;
    const cached = record.calls.filter((call) => call.cached === true).length;
    const failed = record.calls.filter((call) => call.state === "failed").length;
    const head =
        record.state === "done" ? "finished" : record.state === "stopped" ? "was stopped" : "failed";
    const counts = `${calls} agent call${calls === 1 ? "" : "s"}${cached > 0 ? `, ${cached} handed back from an earlier run` : ""}${failed > 0 ? `, ${failed} failed` : ""}`;
    const result = record.result === undefined ? "" : JSON.stringify(record.result, undefined, 2);
    const body =
        record.state === "done"
            ? result.length <= WAKE_RESULT_CHARS
                ? ["What it returned:", "```json", result, "```"]
                : [`What it returned is ${result.length} characters: read it whole with workflow_status (run: "${run}").`]
            : [record.error ?? ""];
    return [
        `Workflow \`${record.name}\` (run \`${run}\`) ${head}: ${counts}.`,
        "",
        ...body,
        "",
        "Its workers' changes reached your checkout the way any subagent's do. What it returned is its workers' own account: check what matters before you build on it.",
    ].join("\n");
};

const tellParent = async (services: Services, run: string, record: ScriptRun): Promise<void> => {
    const entry = services.agents.entry(record.parent);
    if (entry === undefined || entry.archivedAt !== undefined) {
        return;
    }
    try {
        await deliverWake(
            { turns: services.turns },
            { conversationId: record.parent, prompt: endingWords(run, record), voice: "sandbox", source: "workflows", profile: conversationProfile(entry) },
        );
    } catch (error) {
        services.logger.warn({ err: error, run }, "workflow run: its ending could not be said to its parent");
    }
};

// Stops a worker nobody will read; one that could not be stopped is said, and its run ends regardless.
const cancelWorker = async (services: Services, parent: ChildParent, child: string): Promise<void> => {
    try {
        await cancelChild(services, parent, child);
    } catch (error) {
        services.logger.warn({ err: error, child }, "workflow run: a worker the run no longer reads could not be stopped");
    }
};

// Runs a run's script to its end, then settles it: its calls still open stopped, its file written, its parent told.
const execute = async (services: Services, live: LiveRun, cache: Cache): Promise<void> => {
    const record = live.record;
    const context: RunContext = {
        services,
        live,
        parent: { conversationId: record.parent, cwd: record.cwd },
        cache,
        places: placesFor(record.concurrency),
        asked: new Map(),
    };
    const parts = splitScript(record.source);
    const ended =
        "fault" in parts
            ? { error: parts.fault }
            : await runScript(
                  parts.body,
                  record.args,
                  {
                      agent: (prompt, options) => agentCall(context, prompt, options),
                      phase: (title) => {
                          record.phase = title.slice(0, 120);
                          keepRun(services, live);
                      },
                      log: (line) => {
                          record.log = [...record.log, line.slice(0, LOG_LINE_CHARS)].slice(-LOG_KEPT);
                          keepRun(services, live);
                      },
                  },
                  live.stop.signal,
              );
    record.state = live.stop.signal.aborted ? "stopped" : "value" in ended ? "done" : "failed";
    if ("value" in ended) {
        record.result = ended.value;
    } else {
        record.error = ended.error;
    }
    record.endedAt = Date.now();
    // A call the script never waited for has nobody to read it: its worker stops, its work stays in its worktree. Not
    // waited for: a worker's turn unwinds in its own time, and the run has ended either way.
    for (const call of record.calls) {
        if (call.state === "running") {
            call.state = "failed";
            call.error = "The workflow ended before this call.";
            if (call.child !== undefined) {
                forgetWorker(call.child);
                void cancelWorker(services, context.parent, call.child);
            }
        }
    }
    keepRun(services, live);
    LIVE.delete(live.id);
    live.ended.resolve();
    await tellParent(services, live.id, record);
};

const launch = (services: Services, id: string, record: ScriptRun, cache: Cache): LiveRun => {
    const live: LiveRun = { id, record, stop: new AbortController(), ended: Promise.withResolvers<void>() };
    LIVE.set(id, live);
    keepRun(services, live);
    void (async (): Promise<void> => {
        try {
            await execute(services, live, cache);
        } catch (error) {
            services.logger.error({ err: error, run: id }, "workflow run: ended on a fault of the daemon's");
            LIVE.delete(id);
            live.ended.resolve();
        }
    })();
    return live;
};

// The script a request names: given inline, or read from the parent's working tree and nowhere else.
const scriptOf = async (request: ScriptRunRequest, cwd: string): Promise<{ readonly source: string } | { readonly fault: string }> => {
    if ((request.script === undefined) === (request.scriptPath === undefined)) {
        return { fault: "Give the workflow exactly one of `script` (the script itself) or `scriptPath` (a file in your working tree)." };
    }
    if (request.script !== undefined) {
        return { source: request.script };
    }
    const path = resolve(cwd, request.scriptPath ?? "");
    try {
        const [real, root] = await Promise.all([realpath(path), realpath(cwd)]);
        if (!isInside(root, real)) {
            return { fault: `${request.scriptPath ?? ""} is outside your working tree.` };
        }
        return { source: await readFile(real, "utf8") };
    } catch (error) {
        return { fault: `${request.scriptPath ?? ""} could not be read: ${errorMessage(error)}` };
    }
};

// What an earlier run of this parent's hands a resumed one: its finished calls.
const resumedCache = async (services: Services, parent: string, run: string | undefined): Promise<Cache | { readonly fault: string }> => {
    if (run === undefined) {
        return new Map();
    }
    if (LIVE.has(run)) {
        return { fault: `Run ${run} is still running: stop it first, or wait for it.` };
    }
    const earlier = await runOnFile(services, run);
    if (earlier === undefined || earlier.parent !== parent) {
        return { fault: `No run ${run} of this conversation's to resume.` };
    }
    return cacheOf(earlier.calls);
};

/** Starts a workflow run for a parent: its script read and checked, its first call made, its id answered at once. */
export const startScriptRun = async (services: Services, parent: ChildParent, request: ScriptRunRequest): Promise<ScriptRunStart> => {
    const script = await scriptOf(request, parent.cwd);
    if ("fault" in script) {
        return { ok: false, message: script.fault };
    }
    const parts = splitScript(script.source);
    if ("fault" in parts) {
        return { ok: false, message: parts.fault };
    }
    const literal = await readLiteral(parts.metaLiteral);
    const meta = "fault" in literal ? undefined : ScriptMetaSchema.safeParse(literal.value);
    if (meta === undefined || !meta.success) {
        return { ok: false, message: "fault" in literal ? literal.fault : "Its `meta` needs a `name` (and may have a `description` and `phases`)." };
    }
    const cache = await resumedCache(services, parent.conversationId, request.resume);
    if ("fault" in cache) {
        return { ok: false, message: cache.fault };
    }
    const id = `wfr-${randomUUID().slice(0, 13)}`;
    const now = Date.now();
    const record: ScriptRun = {
        parent: parent.conversationId,
        cwd: parent.cwd,
        name: meta.data.name,
        ...opt("description", meta.data.description),
        ...opt("phases", meta.data.phases),
        source: script.source,
        args: request.args ?? null,
        ...opt("defaults", request.defaults),
        concurrency: Math.min(MAX_CONCURRENCY, Math.max(1, request.concurrency ?? DEFAULT_CONCURRENCY)),
        ...opt("resumedFrom", request.resume),
        state: "running",
        log: [],
        calls: [],
        startedAt: now,
        at: now,
    };
    launch(services, id, record, cache);
    return {
        ok: true,
        run: id,
        note: `Running. Its workers show under you on the board; its ending wakes this conversation with what it returned, so you need not wait on it. workflow_status (run: "${id}") says where it is; workflow_stop stops it.`,
    };
};

/** One worker of a run, as its status lists it. */
export interface ScriptWorkerStatus {
    readonly label: string;
    readonly state: ScriptCall["state"];
    readonly child?: string;
    readonly phase?: string;
    readonly error?: string;
}

/** Where a run stands, as its parent reads it. */
export interface ScriptRunStatus {
    readonly run: string;
    readonly name: string;
    readonly state: ScriptRun["state"];
    readonly calls: { readonly total: number; readonly running: number; readonly done: number; readonly failed: number; readonly cached: number };
    readonly workers: readonly ScriptWorkerStatus[];
    readonly log: readonly string[];
    readonly phase?: string;
    readonly phases?: readonly string[];
    readonly result?: ResultValue;
    readonly error?: string;
    // Present when `waitSeconds` was asked: why the wait ended before the run did.
    readonly waitOutcome?: "message" | "timeout" | "ended" | "aborted";
    readonly note?: string;
}

/** A move on a run this conversation does not have, or not in a state to take it. */
export interface ScriptRunRefusal {
    readonly ok: false;
    readonly message: string;
}

/** What stopping a run answers. */
export interface ScriptRunStopped {
    readonly ok: boolean;
    readonly message: string;
}

/** Where a run stands, as its parent reads it. */
const scriptRunStatus = async (services: Services, parent: string, run: string): Promise<ScriptRunStatus | ScriptRunRefusal> => {
    const record = LIVE.get(run)?.record ?? (await runOnFile(services, run));
    if (record === undefined || record.parent !== parent) {
        return { ok: false, message: `No run ${run} of this conversation's.` };
    }
    const count = (state: ScriptCall["state"]): number => record.calls.filter((call) => call.state === state).length;
    return {
        run,
        name: record.name,
        state: record.state,
        calls: { total: record.calls.length, running: count("running"), done: count("done"), failed: count("failed"), cached: record.calls.filter((call) => call.cached === true).length },
        // Its own workers, the newest forty; one handed back from an earlier run did no work this time.
        workers: record.calls
            .filter((call) => call.cached !== true)
            .slice(-40)
            .map((call) => ({ label: call.label, state: call.state, ...opt("child", call.child), ...opt("phase", call.phase), ...opt("error", call.error) })),
        log: record.log.slice(-20),
        ...opt("phase", record.phase),
        ...opt("phases", record.phases?.map((phase) => phase.title)),
        ...opt("result", record.result),
        ...opt("error", record.error),
    };
};

type WaitOutcome = NonNullable<ScriptRunStatus["waitOutcome"]>;

// The park under `waitSeconds`: the run ending, the timeout, the turn's stop, or words said into the turn (as the wait
// tool does, so an owner's message or a watch's wake is not left unread for up to half an hour) (2026-10-20). Every
// listener goes with the park, the turn's abort listener included.
const parkOnRun = (ended: Promise<unknown>, ms: number, signal: AbortSignal, heard: { readonly actors: Pick<ConversationActors, "holdings">; readonly parent: string } | undefined): Promise<WaitOutcome> =>
    new Promise<WaitOutcome>((resolve) => {
        const held = new DisposableStore();
        const done = new AbortController();
        let settled = false;
        const finish = (outcome: WaitOutcome): void => {
            if (settled) {
                return;
            }
            settled = true;
            done.abort();
            held.dispose();
            resolve(outcome);
        };
        const timer = setTimeout(() => finish("timeout"), ms);
        timer.unref();
        held.push(() => clearTimeout(timer));
        held.push(whenAborted(signal, () => finish("aborted")));
        void ended.then(() => finish("ended"));
        if (heard !== undefined) {
            // Its own signal ends with the park, so the steer listener does not outlive it to the turn's end.
            void wordsSaid(heard.actors, heard.parent, done.signal).then((said) => {
                if (said.outcome === "message") {
                    finish("message");
                }
            });
        }
    });

/** Waits up to `ms` for a run of this parent's to end, then says where it stands, and why the wait ended. */
export const awaitScriptRun = async (
    services: Services,
    parent: string,
    run: string,
    ms: number,
    signal: AbortSignal,
    actors?: Pick<ConversationActors, "holdings">,
): Promise<ScriptRunStatus | ScriptRunRefusal> => {
    const live = LIVE.get(run);
    const waitOutcome =
        live !== undefined && live.record.parent === parent && ms > 0
            ? await parkOnRun(live.ended.promise, ms, signal, actors === undefined ? undefined : { actors, parent })
            : undefined;
    const status = await scriptRunStatus(services, parent, run);
    if ("ok" in status && status.ok === false) {
        return status;
    }
    return { ...status, ...opt("waitOutcome", waitOutcome), ...opt("note", waitOutcome === "message" ? WORDS_SAID : undefined) };
};

/** Stops a run of this parent's: its script ends, its workers still working are stopped; their work stays. */
export const stopScriptRun = (parent: string, run: string): ScriptRunStopped => {
    const live = LIVE.get(run);
    if (live === undefined || live.record.parent !== parent) {
        return { ok: false, message: `No running run ${run} of this conversation's.` };
    }
    live.stop.abort();
    return { ok: true, message: "Stopping: its workers still working are stopped, and what they wrote stays in their worktrees. Its ending wakes you as usual." };
};

/** What a turn reaches workflow runs through: its parent's own, from its tools (subagent-wait.ts). */
export interface ScriptRunDoor {
    readonly start: (request: ScriptRunRequest) => Promise<ScriptRunStart>;
    readonly status: (run: string, waitMs: number, signal: AbortSignal) => Promise<ScriptRunStatus | ScriptRunRefusal>;
    readonly stop: (run: string) => ScriptRunStopped;
}

export const scriptRunDoor = (services: Services, parent: ChildParent): ScriptRunDoor => ({
    start: (request) => startScriptRun(services, parent, request),
    status: (run, waitMs, signal) => awaitScriptRun(services, parent.conversationId, run, waitMs, signal, services.conversations),
    stop: (run) => stopScriptRun(parent.conversationId, run),
});

/**
 * At boot, once the spawned children are back: every run a restart cut goes on where it was, its finished calls handed
 * back and its workers still working waited on, or, where the owner's restart answer resumes nothing, ends saying so.
 * Never throws.
 */
export const resumeScriptRuns = async (services: Services, policy: { readonly resume: boolean }): Promise<void> => {
    try {
        const { entries } = await runFiles(services).list();
        for (const entry of entries.filter((run) => run.state === "running")) {
            const { id, ...record } = entry;
            const parent = services.agents.entry(record.parent);
            if (parent === undefined || parent.archivedAt !== undefined || !policy.resume) {
                record.state = "failed";
                record.error =
                    parent === undefined || parent.archivedAt !== undefined
                        ? "Its conversation left the board while the sandbox restarted."
                        : `The sandbox restarted, and this restart resumes nothing. Run it again with resume: "${id}" to keep its finished calls.`;
                record.endedAt = Date.now();
                const settled: LiveRun = { id, record, stop: new AbortController(), ended: Promise.withResolvers<void>() };
                keepRun(services, settled);
                await tellParent(services, id, record);
                continue;
            }
            services.logger.info({ run: id, calls: record.calls.length }, "workflow run: picked up where the restart cut it");
            launch(services, id, record, cacheOf(record.calls));
        }
    } catch (error) {
        services.logger.warn({ err: error }, "workflow runs: the ones a restart cut could not be read back, they stay as they were");
    }
};

/** For a suite: every run in this process forgotten. */
export const resetScriptRunsForTest = (): void => {
    for (const live of LIVE.values()) {
        live.stop.abort();
    }
    LIVE.clear();
    resetCallsForTest();
};
