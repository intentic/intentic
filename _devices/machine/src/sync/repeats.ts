import type { Log } from "@intentic/local-agent";

// A log for a agent that runs every few seconds: a line it has already said is repeated a few more times and then only
// occasionally, carrying its run length, until it changes. Nothing else quiets these — a pairing that stays broken
// wrote the same two sentences every tick, which is how one dogfooding machine's machine.log reached 31 MB in two
// days and buried every line worth reading in it.

// How many times in a row a line is said in full before the quiet rule takes over.
const LOUD_RUNS = 3;

// How often a still-repeating line may say so, and how long a line that has stopped is remembered: past this it is
// news again, so a failure that returns an hour later is loud rather than swallowed by its own history.
const QUIET_MS = 10 * 60_000;

interface Run {
    // Times in a row this exact line has been seen.
    runs: number;
    // When it was last WRITTEN, which is what the quiet cadence is measured from.
    saidAt: number;
    // When it was last SEEN, which is what ages a line out of the table.
    seenAt: number;
}

export const quieted = (log: Log, now: () => number = Date.now): Log => {
    const runs = new Map<string, Run>();
    return (message: string): void => {
        const at = now();
        // Aged out rather than capped: the table then holds only what is actually repeating, which for this agent is a
        // handful of lines, and a line forgotten here is one that has already gone quiet on its own.
        for (const [line, run] of runs) {
            if (at - run.seenAt >= QUIET_MS) {
                runs.delete(line);
            }
        }
        const held = runs.get(message);
        if (held === undefined) {
            runs.set(message, { runs: 1, saidAt: at, seenAt: at });
            log(message);
            return;
        }
        held.runs += 1;
        held.seenAt = at;
        if (held.runs <= LOUD_RUNS) {
            held.saidAt = at;
            log(message);
            return;
        }
        // Said once, at the boundary: a reader who stops seeing a line needs to know the agent went quiet on purpose
        // rather than that the condition cleared.
        if (held.runs === LOUD_RUNS + 1) {
            held.saidAt = at;
            log(`${message} — still, and saying so at most every ${QUIET_MS / 60_000} minutes from here`);
            return;
        }
        if (at - held.saidAt < QUIET_MS) {
            return;
        }
        held.saidAt = at;
        log(`${message} (unchanged, ${held.runs} times)`);
    };
};
