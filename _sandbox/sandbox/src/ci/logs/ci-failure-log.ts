import { errorMessage, isFetchNetworkFailure, networkCodeOf } from "@intentic/base/errors";
import type { Logger } from "pino";
import { createRepeatGate } from "../../logs/repeat-gate.js";
import { CiRateLimited, CiRefused } from "../forge-refusals.js";

// The CI loops (the runs backfill, the poll, the webhook reconcile) call the forge for every mapped repo every few
// minutes, so one revoked token wrote the same `401 Bad credentials` warn, stack and all, about a thousand times in five
// days. Each loop logs through one of these: the first failure of a repo and every change of what it fails with, then
// one line an hour while it lasts, and one line when it works again.

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

export interface CiFailureLog {
    // The call for `repo` failed with `error`.
    readonly failed: (repo: string, error: unknown) => void;
    // The call for `repo` went through; writes the "works again" line only after a failure this log reported.
    readonly succeeded: (repo: string) => void;
}

export const createCiFailureLog = (logger: Logger, message: string, recovered: string, now?: () => number): CiFailureLog => {
    const gate = createRepeatGate(now === undefined ? {} : { now });
    return {
        failed: (repo, error) => {
            const verdict = gate.check(repo, failureState(error));
            if (verdict.log) {
                logger.warn({ repo, ...failureFields(error), ...(verdict.repeated > 0 ? { repeated: verdict.repeated } : {}) }, message);
            }
        },
        succeeded: (repo) => {
            const outage = gate.clear(repo);
            if (outage !== undefined) {
                logger.info({ repo, after: outage.state, repeated: outage.repeated }, recovered);
            }
        },
    };
};
