import type { AgentScriptRun } from "@intentic/sandbox-contract/schemas/agents";
import type { Services } from "../../../composition.js";
import { opt } from "../../../opt.js";
import type { LiveRun } from "./script-run-store.js";

// THE WORKFLOW RUNS GOING IN THIS PROCESS (script-runs.ts runs them), kept apart from the running so that what stops them
// needs nothing of it: the agent's own workflow_stop, a person's press on a card (agents.stopFamily), and a conversation
// leaving the board (children.ts cancelFamily). A run is a script, not a turn, so it goes on starting workers while its
// conversation rests, and a worker stopped by hand only fails one call: the script starts the next. So each parent's card
// lists the runs it has going (AgentSummary.scriptRuns), which is where a person finds what keeps starting them.

/** Who stopped a run from outside its script: its own agent, a person from the board, or its conversation leaving it. */
export type RunStop = "agent" | "owner" | "left";

const LIVE = new Map<string, LiveRun>();
// What each parent's card was last told, so a write that moved nothing it shows (a log line) says nothing.
const SHOWN = new Map<string, string>();

export const liveRun = (id: string): LiveRun | undefined => LIVE.get(id);
export const addLiveRun = (live: LiveRun): void => void LIVE.set(live.id, live);
export const dropLiveRun = (id: string): void => void LIVE.delete(id);

/** Stops a run once: its script ends and its workers still working stop (script-runs.ts execute). False if already stopping. */
export const stopLiveRun = (live: LiveRun, why: RunStop): boolean => {
    if (live.stop.signal.aborted) {
        return false;
    }
    live.stoppedBy = why;
    live.stop.abort();
    return true;
};

/** Stops every run these conversations have going; answers how many it stopped. */
export const stopRunsOf = (parents: Iterable<string>, why: RunStop): number => {
    const of = new Set(parents);
    return [...LIVE.values()].filter((live) => of.has(live.record.parent) && stopLiveRun(live, why)).length;
};

// One run as its parent's card lists it: the workers it started, not the calls still waiting for a place, and nothing
// handed back from an earlier run, which started nobody this time.
const cardOf = (live: LiveRun): AgentScriptRun => {
    const { record } = live;
    const started = record.calls.filter((call) => call.child !== undefined);
    return {
        id: live.id,
        name: record.name,
        calls: started.length,
        working: started.filter((call) => call.state === "running").length,
        failed: record.calls.filter((call) => call.state === "failed").length,
        ...opt("phase", record.phase),
        startedAt: record.startedAt,
    };
};

/**
 * Tells a parent's card the runs it has going now, said only when that moved. A run stopping is off the card at once,
 * before its workers have unwound. Nothing is said to a conversation no longer on the roster: a discarded parent's run
 * ends after it is gone, and the word would bring back an actor for nobody.
 */
export const showRunsOf = (services: Pick<Services, "conversations" | "agents">, parent: string): void => {
    const runs = [...LIVE.values()].filter((live) => live.record.parent === parent && !live.stop.signal.aborted).map(cardOf);
    const shown = JSON.stringify(runs);
    if ((SHOWN.get(parent) ?? "[]") === shown) {
        return;
    }
    if (runs.length === 0) {
        SHOWN.delete(parent);
    } else {
        SHOWN.set(parent, shown);
    }
    if (services.agents.entry(parent) !== undefined) {
        services.conversations.send(parent, { kind: "script-runs-shown", runs });
    }
};

/** For a suite: every run in this process stopped and forgotten. */
export const resetLiveRunsForTest = (): void => {
    for (const live of LIVE.values()) {
        live.stop.abort();
    }
    LIVE.clear();
    SHOWN.clear();
};
