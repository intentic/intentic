import { isFileWorkCall, isRootListing, isSearchCall, searchPrecedesFileWork, type ToolKind } from "./tool-calls.js";

// What one turn did before its first edit, read off its tool calls in order. Order matters and three of the four readings
// share state (has work started, which paths seen), so they are kept in one ledger rather than four independent counters.
// Runtime-neutral: the sandbox daemon feeds it the frames of a live turn, the Claude Code plugin the tool_use blocks of a
// transcript, and both get the same numbers for the same calls. A subagent's calls count toward `calls()` and toward no
// reading: they interleave with the main agent's, so "before the first file" has no order across the two, and none of
// the treatments the readings judge (the map, the search teaching, the field notes) reaches a subagent. Counted as the
// turn's own, a first turn that sent three researchers out read 999 calls before its file where its own agent took 97.

// A tool call as the readings see it: what kind of act it was and what it aimed at. The daemon's `tool_call` frame and a
// transcript's rebuilt call both carry at least this much.
export interface ToolCallFacts {
    // The display name (`Bash`, `LS`), so the native listing tool is told apart from a shell `ls`.
    readonly name?: string | undefined;
    readonly category: ToolKind;
    // The command line, path or pattern the call was aimed at.
    readonly target?: string | undefined;
    // Files the call named, root-relative.
    readonly locations?: readonly { readonly path: string }[] | undefined;
    // The call's own id, so a failure reported against a subagent's call is told apart from the main agent's.
    readonly id?: string | undefined;
    // Made by a subagent the turn started rather than by the turn's own agent.
    readonly subagent?: boolean | undefined;
}

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
    // Calls that ended in error, counted once each: what a brief about this place's traps either prevents or does
    // not (field-notes.ts).
    readonly failedCalls: number;
}

export interface TurnMetrics {
    // One call, counted as it starts, which is the only moment its place in the order is known.
    readonly call: (call: ToolCallFacts) => void;
    // A call that ended in error. By id, not a counter: a runtime can report one failure more than once, and a call can
    // fail only once however many reports say so.
    readonly failed: (id: string) => void;
    // Tool calls so far, subagents' included, for the silent-ending sentence ("stopped after 59 tool calls").
    readonly calls: () => number;
    // The turn's readings, given what it turned out to have edited.
    readonly reading: (edited: readonly string[]) => TurnMetricsReading;
}

// `root` is the tree as the agent sees it (its own namespace root, not the daemon's worktree path); used only to decide
// which listings count as orientation.
export const createTurnMetrics = (root: string): TurnMetrics => {
    let calls = 0;
    // The turn's own agent's calls, the position every reading is taken at.
    let own = 0;
    let searchCalls = 0;
    let openingSearches = 0;
    let openingListings = 0;
    let reachedTheWork = false;
    const failed = new Set<string>();
    // Subagents' call ids, so a failure update (which names only the id) is not read as the main agent's.
    const delegated = new Set<string>();
    // First touch per path, kept for all of them since the eventual target is known only once editing finishes; keyed
    // like the proof ledger's edit paths.
    const firstTouch = new Map<string, number>();
    // First touch wins; `own` already counted this call, so calls before it are one fewer.
    const noteTouches = (locations: ToolCallFacts["locations"]): void => {
        for (const { path } of locations ?? []) {
            firstTouch.set(path, firstTouch.get(path) ?? own - 1);
        }
    };
    return {
        call: (call) => {
            calls += 1;
            if (call.subagent === true) {
                if (call.id !== undefined) {
                    delegated.add(call.id);
                }
                return;
            }
            own += 1;
            // A compound Bash call can both search and open a file, so these aren't exclusive: counting search state at
            // call entry then closing orientation catches real file reads (cat/sed/head/tail) that exclusive branches
            // missed.
            const searched = isSearchCall(call);
            if (searched) {
                searchCalls += 1;
            }
            if (searched && !reachedTheWork && searchPrecedesFileWork(call)) {
                openingSearches += 1;
            }
            // Counted only up to the first file, like openingSearches: a listing after work has started narrows to what
            // the turn already found, which no map could have preempted, and shape alone can't tell the two apart.
            if (!reachedTheWork && isRootListing(call, root)) {
                openingListings += 1;
            }
            noteTouches(call.locations);
            if (isFileWorkCall(call)) {
                reachedTheWork = true;
            }
        },
        failed: (id) => {
            if (!delegated.has(id)) {
                failed.add(id);
            }
        },
        calls: () => calls,
        reading: (edited) => {
            const reached = edited.map((path) => firstTouch.get(path)).filter((at) => at !== undefined);
            return {
                searchCalls,
                openingSearches,
                openingListings,
                failedCalls: failed.size,
                ...(reached.length > 0 ? { callsBeforeTarget: Math.min(...reached) } : {}),
            };
        },
    };
};
