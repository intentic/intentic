import type { AgentEvent, ToolCallLocation } from "@intentic/sandbox-contract";
import { isFileWorkCall, isRootListing, isSearchCall, searchPrecedesFileWork } from "../tools/tool-calls.js";

/* WHAT A TURN DID BEFORE IT DID THE WORK, counted as the frames arrive, because the frame stream is the only
 * place that still knows the ORDER things happened in. The four readings the mechanism experiments are judged
 * on (UsageTurn.searchCalls, openingSearches, openingListings, callsBeforeTarget), in one ledger rather than five
 * counters loose in the route's loop.
 *
 * ONE LEDGER, for the reason createFrameLedger next door is one: these are not four independent tallies, they
 * are four readings of a single walk through the turn, and three of them depend on state the others set (has
 * the work started, which call was this, which paths has it seen). Kept apart in the loop they were four
 * variables that had to be updated in the right order by whoever edited it next.
 *
 * SUBAGENTS' CALLS COUNT, the same rule the prose and the proof ledgers follow: a turn that sent a child to
 * look around still looked around, and a reading that ignored delegated work would report the most careful
 * turns as having done nothing.
 *
 * `tool_call` ONLY, never `tool_call_update`: an update is a later state of a call already counted. */

export interface TurnMetricsReading {
    // Every call that went looking for code, the dedicated tools and the CLI searches alike.
    readonly searchCalls: number;
    // …of them, the ones before the turn first opened or changed a file.
    readonly openingSearches: number;
    // …and how many of those searches were shallow directory listings, the act the project map claims to make
    // unnecessary. A subset of `openingSearches`, counted separately because it is the only part of the
    // orientation burst the map addresses.
    readonly openingListings: number;
    /* How many calls came before the turn first touched a file it went on to edit. Absent when it edited
     * nothing, or when nothing it edited was ever named by a call's locations: a turn with no target never
     * reached one, and counting that as zero would report the turns that did no work as the best targeted. */
    readonly callsBeforeTarget?: number;
}

export interface TurnMetrics {
    readonly note: (event: AgentEvent) => void;
    // Tool calls so far, which the silent-ending sentence reads ("stopped after 59 tool calls").
    readonly calls: () => number;
    // The turn's readings, given what it turned out to have edited (the proof ledger's `edited()`).
    readonly reading: (edited: readonly string[]) => TurnMetricsReading;
}

/* `root` is the tree as the AGENT sees it, since the paths in these frames are the agent's: an isolated turn's
 * namespace root rather than the worktree the daemon reaches it by. It decides which listings are orientation
 * (isRootListing) and nothing else. */
export const createTurnMetrics = (root: string): TurnMetrics => {
    let calls = 0;
    let searchCalls = 0;
    let openingSearches = 0;
    let openingListings = 0;
    let reachedTheWork = false;
    /* Where the turn first touched each path, as the number of calls that preceded it. Kept for EVERY path
     * because which one was the target is only known once the turn has finished editing.
     *
     * Keyed on `locations`, the same workspace-relative paths the proof ledger records its edits under, so the
     * two intersect without a second normalisation. A runtime that reports an edit as a diff carrying no
     * location leaves its path out of here and the reading absent, which is the honest degradation. */
    const firstTouch = new Map<string, number>();
    // First touch wins, and `calls` has already counted the call being noted, so the ones before it are one fewer.
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
            /* A compound Bash call may both search and open a file. Count its search against the state at call
             * entry, then close orientation after it; making these branches exclusive hid most real file reads
             * (`cat`/`sed`/`head`/`tail`) and inflated openingSearches. */
            const searched = isSearchCall(event);
            if (searched) {
                searchCalls += 1;
            }
            if (searched && !reachedTheWork && searchPrecedesFileWork(event)) {
                openingSearches += 1;
            }
            /* UP TO THE FIRST FILE, exactly like `openingSearches`, and the corpus is what settled it. Counted
             * over the whole turn instead, 66.4% of mapped sessions of this workspace ran a shallow listing
             * against 73.3% of unmapped ones, a 6.9pp gap; counted up to the first file the same corpus gives
             * 32.1% against 46.3%, a 14.2pp gap. The difference is not noise, it is that a turn already at
             * work lists a directory it has narrowed to, which is a thing no map could have answered. The
             * shallow-path rule cannot tell those apart on its own, because the shape of the listing is the
             * same; only when it happened separates them. */
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
