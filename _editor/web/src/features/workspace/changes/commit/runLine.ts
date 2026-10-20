import type { IndexRun } from "@intentic/sandbox-contract/schemas/git/index-run";
import { formatCount } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { t } from "@intentic/ui/i18n";
import { computed, type ComputedRef } from "vue";
import { cancelIndexRun, followedRuns } from "../../../../models/changes/indexRuns";

// THE ONE LINE A STAGE OR COMMIT RUN GETS (models/changes/indexRuns.ts), in whichever Changes panel's press bar is open:
// the oldest run's phase, the rest counted, each on the hover, and once a run is slow, one Stop that kills git in every
// repo. Derived here and only here, so the panels draw it rather than each deciding when it shows (the bar used to read
// one source for "Committing…" and this one for its phase, and drew both).

// A stage run says nothing, and a commit's Stop does not show, until it has run this long. Most answer well inside it,
// and a line or a Stop appearing and going again in under a second moved the bar for nothing: the press's own spinner
// already says a run is under way. A commit's line is there from the press (the bar says "Committing…" in the same
// words before the run is read), so only its Stop waits.
const SLOW_RUN_MS = 1_000;

export interface RunLine {
    /** The oldest run's phase, in words. */
    readonly words: string;
    /** How many more repos have a run going. */
    readonly others: number;
    /** Each repo's phase, for the hover, once the line speaks for more than one. */
    readonly tip: string | undefined;
    /** The last read of a run failed: still following, said rather than a frozen phase. */
    readonly lostContact: boolean;
    /** The oldest run has outlasted a moment: the Stop is worth its room. */
    readonly slow: boolean;
    readonly stop: () => void;
}

/** What a run in `repo` is doing; a commit, or a run not read yet, is committing. */
export const phaseWords = (repo: string, run: IndexRun | undefined): string => {
    const total = run?.files?.total;
    switch (run?.phase) {
        case `waiting`:
            return t(`workspace.indexRunPrompt.waiting`, { repo });
        case `counting`:
            return t(`workspace.indexRunPrompt.counting`, { repo });
        case `staging`:
            return total === undefined
                ? t(`workspace.indexRunPrompt.staging`, { repo })
                : t(`workspace.indexRunPrompt.stagingFiles`, { repo, count: formatCount(total) }, total);
        default:
            return t(`workspace.indexRunPrompt.committing`, { repo });
    }
};

/** The runs this tab follows, as the one line a bar draws for them; undefined while none runs. */
export const useRunLine = (): ComputedRef<RunLine | undefined> => {
    const following = computed(() => [...followedRuns.value.entries()].filter(([, followed]) => followed.run.status === `running`));
    const now = useNow(() => following.value.length > 0, 250);
    return computed(() => {
        const runs = following.value;
        const [lead] = runs;
        const slow = runs.some(([, followed]) => now.value - followed.since >= SLOW_RUN_MS);
        if (lead === undefined || !(slow || runs.some(([, followed]) => followed.run.op === `commit`))) {
            return undefined;
        }
        return {
            words: phaseWords(lead[0], lead[1].run),
            others: runs.length - 1,
            tip: runs.length > 1 ? runs.map(([repo, followed]) => phaseWords(repo, followed.run)).join(`\n`) : undefined,
            lostContact: runs.some(([, followed]) => followed.lostContact),
            slow,
            stop: () => {
                for (const [repo] of runs) {
                    void cancelIndexRun(repo);
                }
            },
        };
    });
};
