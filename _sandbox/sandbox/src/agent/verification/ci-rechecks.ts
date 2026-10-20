import type { Logger } from "pino";
import { onRuntimeChange } from "../../seams/runtime-feed.js";

// CI-shaped checks: `gh run …`, `gh pr checks`, `gh pr view --json statusCheckRollup`, a GitHub Actions or check-runs API
// read, `glab ci …` or `glab pipeline …`, or a GitLab pipelines API read. Every webhook delivery publishes `ci`, so these
// recheck at once rather than sleeping out their interval; the interval stays as the fallback for a repo whose hook does
// not reach the daemon (2026-10-20).
const CI_WATCH_COMMAND = /\bgh\s+(run|pr\s+checks)\b|statusCheckRollup|\/actions\/|\/check-runs|\/check-suites|\bglab\s+(ci|pipeline)\b|\/pipelines\b/i;

/** Whether a watch's check reads CI state, so a CI webhook delivery is a reason to run it now. */
export const isCiWatchCommand = (command: string): boolean => CI_WATCH_COMMAND.test(command);

// The least time between two CI-triggered rounds of checks: a push sets off several workflows whose deliveries arrive
// together, and each round runs every CI-shaped check, so a burst folds into one round now and one at the gap's end.
export const CI_RECHECK_GAP_MS = 5_000;

/** Runs `round` on a `ci` runtime change: the first change at once, the rest of a burst once at the end of the gap.
 *  Answers its stop. */
export const onCiDeliveries = (round: () => void, logger: Pick<Logger, "warn">): (() => void) => {
    let lastRound = Number.NEGATIVE_INFINITY;
    let trailing: ReturnType<typeof setTimeout> | undefined;
    const run = (): void => {
        trailing = undefined;
        lastRound = Date.now();
        round();
    };
    const stopListening = onRuntimeChange((domains) => {
        if (!domains.includes("ci") || trailing !== undefined) {
            return;
        }
        const wait = lastRound + CI_RECHECK_GAP_MS - Date.now();
        if (wait <= 0) {
            run();
            return;
        }
        trailing = setTimeout(run, wait);
        trailing.unref();
    }, logger);
    return () => {
        stopListening();
        clearTimeout(trailing);
    };
};
