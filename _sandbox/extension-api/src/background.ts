import type { Ref } from "vue";
import type { Disposable, IntenticApi } from "./api.js";
import { sandboxRef, sandboxScopeGuard } from "./scope.js";

/* WHAT AN EXTENSION DOES WHILE NONE OF IT IS ON SCREEN, the two pieces every surface that badges a rail tile
 * turned out to need, and had been writing out by hand.
 *
 * A tile has to be able to say something before it is opened. That rules out the view's own query, which stops
 * when the component unmounts, and it rules out the file-change push, which only reaches a query something is
 * observing. So the state lives at module scope (scope.ts) and something refreshes it on a timer.
 *
 * Seven modules across six extensions arrived at the identical shape for that timer, and it carries five rules
 * that are each invisible until they are broken:
 *
 *   never reject      it runs detached, so a throw is an unhandled rejection with no caller to report to, and
 *                     that includes reading the host handle, which throws before activate() has bound one
 *   skip when down    an unreachable daemon is not news; asking it is a failed request per tick, forever
 *   guard the await   a read issued before a sandbox switch must not write its answer into the box after it
 *   keep the last     a transient failure is not evidence that nothing is waiting, so a failed read changes
 *                     nothing rather than blanking the tile
 *   stop the clock    the interval is disposed with the extension, or a switched-off extension keeps polling
 *
 * Six of the seven copies got the third one wrong, which is what this pair exists to make impossible. What is
 * NOT here is what each tile SAYS: the count, the tone and the wording are the whole point of each surface and
 * differ deliberately, so `badge()` stays with the extension that owns the judgement. */

export interface SandboxPoll<T> {
    /* The value, as sandbox-scoped module state (scope.ts). Read it from `badge()` or `detect()` and the host's
     * own computed repaints when it moves; write to it directly for the local fold a "mark as seen" does, which
     * is what clears a tile on the spot instead of at the next tick. */
    readonly state: Ref<T>;
    // Begin polling. Push the Disposable onto `context.subscriptions` and the clock stops with the extension.
    start(): Disposable;
    // Read now, off-cycle, for the moments that change the answer and should not wait out the interval: a
    // connection appearing, a draft published, a run discarded.
    refresh(): void;
}

export interface SandboxPollOptions<T> {
    // The extension's own host handle (hostSlot). A function, not the api itself, because this is constructed
    // at module load and nothing is bound until activate() runs.
    readonly host: () => IntenticApi;
    /* How often, in milliseconds. There is no default on purpose: the right interval is a claim about how fast
     * the answer actually changes, and a surface that has not thought about it will inherit whatever number
     * happened to be chosen here. A badge is glanced at, so the honest range is minutes, not seconds. */
    readonly everyMs: number;
    // The value before anything has been read, rebuilt on every sandbox switch (sandboxRef).
    readonly initial: () => T;
    /* The read. Gets the api and the value currently held, the second for a poll that ACCUMULATES rather than
     * replaces, where one failed source must leave its own last answer standing beside the others. Throwing is
     * fine and means "nothing changed": the value in hand is kept.
     */
    readonly read: (api: IntenticApi, previous: T) => Promise<T>;
    /* Whether `start()` reads immediately as well as on the interval. Default true, because a tile that only
     * badges a minute after login is a tile nobody trusts. Set false when the poll has nothing to ask until
     * something else tells it what to ask about, deployments learns its connections from `detect()`. */
    readonly immediate?: boolean;
    // For a value that owns something the garbage collector will not take back; see sandboxRef.
    readonly dispose?: (previous: T) => void;
}

export const sandboxPoll = <T>(options: SandboxPollOptions<T>): SandboxPoll<T> => {
    const state = sandboxRef(options.initial, options.dispose);

    const once = async (): Promise<void> => {
        try {
            const api = options.host();
            if (!api.sandbox.reachable()) {
                return;
            }
            const current = sandboxScopeGuard();
            const next = await options.read(api, state.value);
            if (!current()) {
                return;
            }
            state.value = next;
        } catch {
            // Whatever went wrong, an unbound host, a refused route, a daemon mid-boot, the answer is the
            // same: leave the last value standing. "We could not ask" is not "there is nothing there".
        }
    };

    return {
        state,
        refresh: () => void once(),
        start: () => {
            if (options.immediate !== false) {
                void once();
            }
            const timer = setInterval(() => void once(), options.everyMs);
            return { dispose: () => clearInterval(timer) };
        },
    };
};

/* WHAT THE OWNER HAS ALREADY SEEN, as a file in the workspace.
 *
 * The rail's bar is that a badge means "something happened here that you do not already know about". Meeting it
 * needs somewhere to record what they DO know, and three extensions independently chose the same home: a JSON
 * object under `.intentic`, keyed by whatever identifies the thing. That is the right home, it survives a
 * reload, it is shared across the owner's browsers, and it needs no setting nobody would ever type, but each
 * of them then hand-wrote the same tolerant reader and the same careful write.
 *
 * KEY → MARK, where the mark is what makes the entry STALE. That is the whole vocabulary, and it covers both
 * the ledgers that compare (a chore's evidence digest, a story's verdict, the same key with a different mark
 * is news again) and the ones that only ask whether a key is present at all (a document set reviewed once).
 * A presence-only ledger writes the acknowledgement time as its mark, which nothing reads and a human opening
 * the file is glad of.
 *
 * The file is written by agents and editable by hand, so a missing, truncated or hand-mangled one reads as
 * "nothing acknowledged". That direction is deliberate: bad bookkeeping may light a badge that should have been
 * quiet, and must never hide one that should have been lit.
 *
 * BOTH WRITES ANSWER "did this take effect", which is the question the caller's NEXT line depends on. Marking
 * something seen is almost always followed by folding it out of the badge locally, so the tile clears on the
 * spot rather than at the next poll, and that fold is a write into sandbox-scoped state, so it must not happen
 * when the acknowledgement itself was abandoned because the owner switched sandbox mid-operation. It would
 * silence the NEW box's badge for a fact about the old one. `false` means only that: the scope moved. A ledger
 * that already said what you asked it to say answers `true`, because it does. */
export interface SandboxLedger {
    // Everything acknowledged so far. Absent, unparseable or not-an-object all read as nothing.
    read(): Promise<Readonly<Record<string, string>>>;
    /* Record these, leaving every other entry alone, the ordinary acknowledgement. No write happens when
     * nothing moved: the file push would otherwise cost every connected browser a refetch for a file whose
     * content is identical. */
    mark(entries: Readonly<Record<string, string>>): Promise<boolean>;
    /* Make these the WHOLE ledger, dropping anything not named. For a ledger whose keys go out of scope, a
     * run that has scrolled past the scan window can never be seen again, and merging forever would grow the
     * file without bound. Same no-op-when-unchanged rule as `mark`.
     */
    replace(entries: Readonly<Record<string, string>>): Promise<boolean>;
}

const sameEntries = (left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean =>
    Object.keys(left).length === Object.keys(right).length && Object.entries(left).every(([key, mark]) => right[key] === mark);

export const sandboxLedger = (host: () => IntenticApi, path: string): SandboxLedger => {
    const read = async (): Promise<Readonly<Record<string, string>>> => {
        const parsed = await host().workspace.readJson<Record<string, unknown>>(path);
        // Non-string values are dropped rather than coerced: a mark is a string, and anything else is somebody
        // else's idea of what this file is for.
        return Object.fromEntries(Object.entries(parsed ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === `string`));
    };

    /* One writer for both verbs, and the scope guard lives HERE rather than at the call site, this is the
     * only thing in an extension's background work that damages state on DISK when a sandbox switch lands
     * mid-operation. Reading one workspace's acknowledgements and writing them into the tree of the workspace
     * the owner has just moved to is bookkeeping filed in the wrong place, which no later poll corrects. */
    const settle = async (next: (seen: Readonly<Record<string, string>>) => Readonly<Record<string, string>>): Promise<boolean> => {
        const current = sandboxScopeGuard();
        const seen = await read();
        const wanted = next(seen);
        // Already saying it. Nothing to write, and the caller's local fold is still right.
        if (sameEntries(seen, wanted)) {
            return true;
        }
        if (!current()) {
            return false;
        }
        await host().workspace.write(path, `${JSON.stringify(wanted, undefined, 2)}\n`);
        return true;
    };

    return {
        read,
        mark: async (entries) => settle((seen) => ({ ...seen, ...entries })),
        replace: async (entries) => settle(() => entries),
    };
};
