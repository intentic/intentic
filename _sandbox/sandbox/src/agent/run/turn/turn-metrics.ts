import type { AgentEvent, ToolCallLocation } from "@intentic/sandbox-contract";
import { isFileWorkCall, isRootListing, isSearchCall, searchPrecedesFileWork } from "../../tools/tool-calls.js";

// Computed as frames arrive since order matters and three of the four readings share state (has work started, which
// paths seen), kept in one ledger rather than four independent counters. Subagent calls count as the turn's own. Only
// `tool_call` is counted, never `tool_call_update` (a later state of one already counted).

export interface TurnMetricsReading {
    // Every call that went looking for code: dedicated search tools and CLI searches alike.
    readonly searchCalls: number;
    // Of those, the ones before the turn first opened or changed a file.
    readonly openingSearches: number;
    // Shallow directory listings among openingSearches, the part of orientation the project map addresses.
    readonly openingListings: number;
    // Calls before the first touch of an edited file; absent (not zero) when nothing was edited or the edit had no
    // located call.
    readonly callsBeforeTarget?: number;
}

export interface TurnMetrics {
    readonly note: (event: AgentEvent) => void;
    // Tool calls so far, for the silent-ending sentence ("stopped after 59 tool calls").
    readonly calls: () => number;
    // The turn's readings, given what it turned out to have edited (the proof ledger's `edited()`).
    readonly reading: (edited: readonly string[]) => TurnMetricsReading;
}

// `root` is the tree as the agent sees it (its own namespace root, not the daemon's worktree path); used only to decide
// which listings count as orientation.
export const createTurnMetrics = (root: string): TurnMetrics => {
    let calls = 0;
    let searchCalls = 0;
    let openingSearches = 0;
    let openingListings = 0;
    let reachedTheWork = false;
    // First touch per path, kept for all of them since the eventual target is known only once editing finishes; keyed
    // like the proof ledger's edit paths.
    const firstTouch = new Map<string, number>();
    // First touch wins; `calls` already counted this call, so calls before it are one fewer.
    const noteTouches = (locations: readonly ToolCallLocation[] | undefined): void => {
        for (const { path } of locations ?? []) {
            firstTouch.set(path, firstTouch.get(path) ?? calls - 1);
        }
    };
    return {
        note: (event) => {
            if (event.kind !== "tool_call") {
                return;
            }
            calls += 1;
            // A compound Bash call can both search and open a file, so these aren't exclusive: counting search state at
            // call entry then closing orientation catches real file reads (cat/sed/head/tail) that exclusive branches
            // missed.
            const searched = isSearchCall(event);
            if (searched) {
                searchCalls += 1;
            }
            if (searched && !reachedTheWork && searchPrecedesFileWork(event)) {
                openingSearches += 1;
            }
            // Counted only up to the first file, like openingSearches: a listing after work has started narrows to what
            // the turn already found, which no map could have preempted, and shape alone can't tell the two apart.
            if (!reachedTheWork && isRootListing(event, root)) {
                openingListings += 1;
            }
            noteTouches(event.locations);
            if (isFileWorkCall(event)) {
                reachedTheWork = true;
            }
        },
        calls: () => calls,
        reading: (edited) => {
            const reached = edited.map((path) => firstTouch.get(path)).filter((at) => at !== undefined);
            return {
                searchCalls,
                openingSearches,
                openingListings,
                ...(reached.length > 0 ? { callsBeforeTarget: Math.min(...reached) } : {}),
            };
        },
    };
};
