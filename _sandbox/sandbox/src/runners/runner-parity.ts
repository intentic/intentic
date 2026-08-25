import type { RunnerParity } from "@intentic/sandbox-contract";

/* IS THIS RUNNER RUNNING WHAT THE PARENT IS RUNNING? (docs/remote-runners-plan.md §7 at the workspace root.)
 *
 * A runner executes turns through the same daemon code the parent dispatches with, so the pair has to be
 * built from roughly the same image: a runner months behind can be missing the very procedure the parent is
 * calling, and the failure surfaces as a link error rather than as "that machine is old".
 *
 * REPORTED, NEVER ENFORCED, which is the design's stance and worth keeping in the comparison: an outdated
 * runner still runs turns. The answer here decides what a row SAYS and whether an update button appears, not
 * whether work is refused. Refusing would strand whatever that machine was for at the exact moment somebody
 * needed it.
 *
 * THREE ANSWERS, and `unknown` is a real one rather than a hedge: a runner that has never connected has told
 * us nothing to compare, and a parent that does not know its own image (a dev daemon started by hand, where
 * every one of these is empty) has nothing to compare AGAINST. Saying "outdated" in either case would put a
 * warning on a row nobody can act on. */

export interface ParityFacts {
    readonly image: string;
    readonly channel?: string | undefined;
    readonly overlayHash?: string | undefined;
}

/* A dev daemon reports its image as `dev` (runner-link.ts) because an empty string is not a name anyone can
 * read on a card. Normalising the PARENT's the same way is what stops two dev boxes, which are the same
 * build by construction, from reading as a mismatch on every row. */
const named = (image: string): string => (image === "" ? "dev" : image);

export const runnerParity = (parent: ParityFacts, reported: ParityFacts | undefined): RunnerParity => {
    if (reported === undefined || reported.image === "") {
        return "unknown";
    }
    if (named(parent.image) === "dev") {
        return "unknown";
    }
    /* EVERY AXIS THAT DECIDES WHAT CODE RUNS, and only those. The image is the code; the channel is which
     * updates it will follow next; the overlay hash is the owner-approved environment built on top. A runner
     * matching all three is running what this sandbox is running.
     *
     * Absent-vs-absent counts as agreement (neither has an overlay), and absent-vs-present does not: a parent
     * whose environment the owner extended and a runner still on the stock image differ in exactly the way a
     * turn will notice, when the tool the overlay installed is missing. */
    const same = named(parent.image) === named(reported.image) && (parent.channel ?? "") === (reported.channel ?? "") && (parent.overlayHash ?? "") === (reported.overlayHash ?? "");
    return same ? "current" : "outdated";
};
