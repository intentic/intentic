import { createHash } from "node:crypto";
import { errorMessage, isFetchNetworkFailure, networkCodeOf } from "@intentic/base/errors";
import type { Logger } from "pino";
import { createFailureTracker } from "../../retry/failure-backoff.js";
import { CiRateLimited, CiRefused } from "../forge-refusals.js";

// The CI loops (the runs backfill, the poll, the webhook reconcile) call the forge for every mapped repo every few
// minutes, so one revoked token wrote the same `401 Bad credentials` warn, stack and all, about a thousand times in five
// days, and a network that flapped wrote `fetch failed` for every repo on each flap (180 lines in a week). Each loop logs
// through one of these: the first failure of a repo and each new way it fails, quiet while it keeps failing in ways
// already said, and one line when it works again (retry/failure-backoff.ts). A loop that asks `due` first also backs off:
// each failure in a row doubles the wait up to an hour, and a refusal no retry can change (a 401 token, a 404 project) is
// not asked again until the token or the mapping does.

// The forge's HTTP status, off the refusal providers.ts throws for it.
export const vendorStatusOf = (error: unknown): number | undefined => (error instanceof CiRefused ? error.status : undefined);

// What a line says of the failure. A forge's answer or a network that did not carry the request is fully said by its
// status or message, and its stack points into fetch; only something else (a bug in the parsing) keeps the stack.
const failureFields = (error: unknown): Record<string, unknown> => {
    const status = vendorStatusOf(error);
    if (status !== undefined) {
        return { status, reason: errorMessage(error) };
    }
    if (error instanceof CiRateLimited || networkCodeOf(error) !== undefined || isFetchNetworkFailure(error)) {
        return { reason: errorMessage(error) };
    }
    return { err: error };
};

// What the gate compares: the status or errno rather than the message, so a refused connection to another of the
// forge's addresses is not news.
const failureState = (error: unknown): string =>
    String(vendorStatusOf(error) ?? (error instanceof CiRateLimited ? "rate-limited" : (networkCodeOf(error) ?? errorMessage(error))));

// What a 401 or 404 depends on: the account's API and token, and the project the repo maps to. Hashed, so the tracker
// holds no copy of a token.
export const ciInputOf = (project: { readonly account: { readonly apiBase: string; readonly token: string }; readonly project: string }): string =>
    createHash("sha256").update([project.account.apiBase, project.account.token, project.project].join("\n")).digest("hex").slice(0, 16);

// Refusals the next attempt with the same token and mapping will meet again.
const PERMANENT_STATUSES = new Set([401, 404]);

const BACKOFF = { floorMs: 60_000, capMs: 60 * 60_000 };

export interface CiFailureLog {
    // Whether the call for `repo` may run now, under `input` (ciInputOf): false while it backs off after failures, or
    // after a permanent refusal until `input` changes.
    readonly due: (repo: string, input: string) => boolean;
    // The call for `repo` failed with `error`, made under `input` (ciInputOf).
    readonly failed: (repo: string, error: unknown, input?: string) => void;
    // The call for `repo` went through; writes the "works again" line only after a failure this log reported.
    readonly succeeded: (repo: string) => void;
}

export const createCiFailureLog = (logger: Logger, message: string, recovered: string, now?: () => number): CiFailureLog => {
    const tracker = createFailureTracker(now === undefined ? { backoff: BACKOFF } : { backoff: BACKOFF, now });
    return {
        due: (repo, input) => tracker.due(repo, input),
        failed: (repo, error, input) => {
            const status = vendorStatusOf(error);
            const permanent = input !== undefined && status !== undefined && PERMANENT_STATUSES.has(status);
            const verdict = tracker.failed(repo, failureState(error), permanent ? { permanent, input } : {});
            if (!verdict.log) {
                return;
            }
            // A loop that asks `due` (it passes `input`) is told when its next attempt is.
            const retryAt = verdict.retryAt === undefined ? "when the token or the mapping changes" : new Date(verdict.retryAt).toISOString();
            logger.warn({ repo, ...failureFields(error), retryAt: input === undefined ? undefined : retryAt }, message);
        },
        succeeded: (repo) => {
            const outage = tracker.succeeded(repo);
            if (outage !== undefined) {
                logger.info({ repo, after: outage.state, repeated: outage.repeated }, recovered);
            }
        },
    };
};
